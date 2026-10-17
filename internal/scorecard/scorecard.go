// Package scorecard defines a task type's metrics and turns a QA agent's
// answers into a score. The score is always computed here, server-side, from
// the scorecard snapshot — never taken from the client.
package scorecard

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const (
	YesNo    = "yes_no"
	Scale    = "scale"
	Dropdown = "dropdown"
	Text     = "text"

	// NA is the answer value for "not applicable"; the metric then counts
	// toward neither earned nor possible points.
	NA = "na"
)

type Option struct {
	Label  string  `json:"label"`
	Points float64 `json:"points"`
}

type Metric struct {
	// ID stays stable across label edits so per-metric reports keep grouping.
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Type     string   `json:"type"`
	Points   float64  `json:"points,omitempty"`    // yes_no, scale
	ScaleMax int      `json:"scale_max,omitempty"` // scale: answers are 0..ScaleMax
	Options  []Option `json:"options,omitempty"`   // dropdown
	Critical bool     `json:"critical"`
	AllowNA  bool     `json:"allow_na"`
	// NAReceiver: when another metric is answered N/A, its weight moves to
	// the receivers, split by their own weights. With no receivers, N/A
	// simply drops out of the score.
	NAReceiver bool `json:"na_receiver"`
}

// Card is a task type's ordered metric list.
type Card []Metric

// Answer is one metric's value plus the QA agent's optional explanation.
// Value is "yes"/"no", a scale number, a dropdown label, free text, or "na".
type Answer struct {
	MetricID string `json:"metric_id"`
	Value    string `json:"value"`
	Notes    string `json:"notes,omitempty"`
	// CriticalFail: the QA agent failed the whole audit on this critical
	// metric. Only counts when the metric scored 0 (a No), not partial credit.
	CriticalFail bool `json:"critical_fail,omitempty"`
}

type Answers []Answer

type Result struct {
	Earned         float64  `json:"earned"`
	Possible       float64  `json:"possible"`
	Score          *float64 `json:"score"` // nil when nothing carries points
	CriticalFailed bool     `json:"critical_failed"`
	Passed         bool     `json:"passed"`
	Band           string   `json:"band"` // pass, borderline or fail
}

// Thresholds are a task type's bands: score ≥ Pass is a pass, ≥ Borderline
// is borderline, anything lower (or a critical fail) is a fail.
type Thresholds struct{ Pass, Borderline int }

// Limits that keep a scorecard sane; the editor enforces the same.
const (
	MaxMetrics  = 60
	MaxPoints   = 100 // per metric, or per dropdown option
	MaxScale    = 10
	MaxOptions  = 10
	MaxLabelLen = 200
)

// Validate checks a scorecard before it is saved, so a slip in the editor
// can't leave QA agents with a card that can't be scored.
func Validate(c Card) error {
	if len(c) > MaxMetrics {
		return fmt.Errorf("a scorecard can have at most %d metrics", MaxMetrics)
	}
	seen, labels := map[string]bool{}, map[string]bool{}
	scored, answerable := 0, 0
	for i, m := range c {
		at := fmt.Sprintf("metric %d (%q)", i+1, m.Label)
		if strings.TrimSpace(m.ID) == "" || seen[m.ID] {
			return fmt.Errorf("%s: missing or duplicate id", at)
		}
		seen[m.ID] = true
		label := strings.ToLower(strings.TrimSpace(m.Label))
		switch {
		case label == "":
			return fmt.Errorf("metric %d: label is required", i+1)
		case len(m.Label) > MaxLabelLen:
			return fmt.Errorf("%s: label is longer than %d characters", at, MaxLabelLen)
		case labels[label]:
			return fmt.Errorf("%s: another metric has the same label", at)
		}
		labels[label] = true
		switch m.Type {
		case YesNo:
			if m.Points <= 0 || m.Points > MaxPoints {
				return fmt.Errorf("%s: points must be above 0 and at most %d", at, MaxPoints)
			}
		case Scale:
			if m.Points <= 0 || m.Points > MaxPoints || m.ScaleMax < 1 || m.ScaleMax > MaxScale {
				return fmt.Errorf("%s: points must be 1-%d and the scale go up to 1-%d", at, MaxPoints, MaxScale)
			}
		case Dropdown:
			if len(m.Options) < 2 || len(m.Options) > MaxOptions {
				return fmt.Errorf("%s: a dropdown needs 2 to %d options", at, MaxOptions)
			}
			opts := map[string]bool{}
			for _, o := range m.Options {
				l := strings.TrimSpace(o.Label)
				if l == "" || opts[strings.ToLower(l)] || strings.EqualFold(l, NA) || o.Points < 0 || o.Points > MaxPoints {
					return fmt.Errorf("%s: options need unique non-empty labels and points from 0 to %d", at, MaxPoints)
				}
				opts[strings.ToLower(l)] = true
			}
			if maxOption(m) <= 0 {
				return fmt.Errorf("%s: at least one option must be worth points", at)
			}
		case Text:
			if m.Critical || m.NAReceiver || m.AllowNA {
				return fmt.Errorf("%s: a text metric carries no points, so it can't be critical, N/A or take N/A weight", at)
			}
			continue
		default:
			return fmt.Errorf("%s: unknown type %q", at, m.Type)
		}
		scored++
		// A metric may both allow N/A and take N/A weight: answered, it takes
		// a share; N/A itself, it gives its weight away and takes none.
		if !m.AllowNA {
			answerable++
		}
	}
	switch {
	case len(c) > 0 && scored == 0:
		return fmt.Errorf("the scorecard needs at least one metric worth points")
	case scored > 0 && answerable == 0:
		return fmt.Errorf("every metric allows N/A, so an audit could have no score; make at least one always answered")
	}
	return nil
}

// Score computes the result of answers against a scorecard. Every metric that
// carries points must be answered; text metrics are optional.
func Score(c Card, answers Answers, th Thresholds) (Result, error) {
	byID := map[string]Answer{}
	for _, a := range answers {
		byID[a.MetricID] = a
	}
	for id := range byID {
		if !c.has(id) {
			return Result{}, fmt.Errorf("answer for unknown metric %q", id)
		}
	}

	type line struct {
		m                Metric
		earned, possible float64
	}
	var lines []line
	var naWeight, receiverWeight float64
	critical := false
	for _, m := range c {
		if m.Type == Text {
			continue
		}
		v := strings.TrimSpace(byID[m.ID].Value)
		if v == "" {
			return Result{}, fmt.Errorf("%q is not answered", m.Label)
		}
		if strings.EqualFold(v, NA) {
			if !m.AllowNA {
				return Result{}, fmt.Errorf("%q cannot be N/A", m.Label)
			}
			naWeight += maxPoints(m)
			continue
		}
		earned, possible, err := points(m, v)
		if err != nil {
			return Result{}, err
		}
		if m.Critical && byID[m.ID].CriticalFail && earned == 0 {
			critical = true
		}
		if m.NAReceiver {
			receiverWeight += possible
		}
		lines = append(lines, line{m, earned, possible})
	}

	r := Result{CriticalFailed: critical}
	for _, l := range lines {
		e, p := l.earned, l.possible
		if l.m.NAReceiver && naWeight > 0 && receiverWeight > 0 {
			// This receiver's share of the N/A weight, scaling its result.
			grown := p + naWeight*p/receiverWeight
			e, p = e*grown/p, grown
		}
		r.Earned += e
		r.Possible += p
	}
	if r.Possible > 0 {
		s := math.Round(r.Earned/r.Possible*1000) / 10
		if critical {
			s = 0
		}
		r.Score = &s
	}
	switch {
	case critical:
		r.Band = "fail"
	case r.Score == nil || *r.Score >= float64(th.Pass):
		r.Band = "pass"
	case *r.Score >= float64(th.Borderline):
		r.Band = "borderline"
	default:
		r.Band = "fail"
	}
	r.Passed = r.Band == "pass"
	return r, nil
}

// maxPoints is what a metric is worth when fully met.
// SameScoring reports whether two sets of answers give every scored metric
// the same value (and the same critical fail): at most their notes and text
// comments differ, so the score can't.
func (c Card) SameScoring(a, b Answers) bool {
	val := func(as Answers) map[string]string {
		m := make(map[string]string, len(as))
		for _, x := range as {
			m[x.MetricID] = fmt.Sprint(strings.TrimSpace(x.Value), x.CriticalFail)
		}
		return m
	}
	va, vb := val(a), val(b)
	for _, m := range c {
		if m.Type != Text && va[m.ID] != vb[m.ID] {
			return false
		}
	}
	return true
}

func maxPoints(m Metric) float64 {
	if m.Type == Dropdown {
		return maxOption(m)
	}
	if m.Type == Text {
		return 0
	}
	return m.Points
}

// MetricPoints is one answered metric's earned and possible points, for
// per-metric reports. na is true for an N/A answer; text metrics carry none.
func MetricPoints(m Metric, value string) (earned, possible float64, na bool, err error) {
	v := strings.TrimSpace(value)
	switch {
	case m.Type == Text:
		return 0, 0, false, nil
	case strings.EqualFold(v, NA):
		return 0, 0, true, nil
	}
	earned, possible, err = points(m, v)
	return earned, possible, false, err
}

func points(m Metric, v string) (earned, possible float64, err error) {
	switch m.Type {
	case YesNo:
		switch strings.ToLower(v) {
		case "yes":
			return m.Points, m.Points, nil
		case "no":
			return 0, m.Points, nil
		}
	case Scale:
		n, convErr := strconv.Atoi(v)
		if convErr == nil && n >= 0 && n <= m.ScaleMax {
			return m.Points * float64(n) / float64(m.ScaleMax), m.Points, nil
		}
	case Dropdown:
		for _, o := range m.Options {
			if strings.EqualFold(o.Label, v) {
				return o.Points, maxOption(m), nil
			}
		}
	}
	return 0, 0, fmt.Errorf("%q: %q is not a valid answer", m.Label, v)
}

func maxOption(m Metric) float64 {
	best := 0.0
	for _, o := range m.Options {
		best = math.Max(best, o.Points)
	}
	return best
}

func (c Card) has(id string) bool {
	for _, m := range c {
		if m.ID == id {
			return true
		}
	}
	return false
}

// jsonb plumbing: both types are stored as JSON arrays.

func (c Card) Value() (driver.Value, error) {
	if c == nil {
		c = Card{}
	}
	return json.Marshal(c)
}

func (c *Card) Scan(src any) error { return scanJSON(src, c) }

func (a Answers) Value() (driver.Value, error) {
	if a == nil {
		a = Answers{}
	}
	return json.Marshal(a)
}

func (a *Answers) Scan(src any) error { return scanJSON(src, a) }

func scanJSON(src any, dst any) error {
	switch v := src.(type) {
	case nil:
		return nil
	case []byte:
		return json.Unmarshal(v, dst)
	case string:
		return json.Unmarshal([]byte(v), dst)
	}
	return errors.New("scorecard: unsupported scan source")
}
