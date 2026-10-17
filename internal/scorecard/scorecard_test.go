package scorecard

import "testing"

var card = Card{
	{ID: "greet", Label: "Greeting", Type: YesNo, Points: 10, AllowNA: true},
	{ID: "tone", Label: "Tone", Type: Scale, Points: 20, ScaleMax: 4},
	{ID: "res", Label: "Resolution", Type: Dropdown, Options: []Option{
		{Label: "Met", Points: 10}, {Label: "Partial", Points: 5}, {Label: "Not met", Points: 0},
	}},
	{ID: "verify", Label: "Verified customer", Type: YesNo, Points: 10, Critical: true},
	{ID: "notes", Label: "Coaching notes", Type: Text},
}

func TestValidate(t *testing.T) {
	if err := Validate(card); err != nil {
		t.Fatalf("valid card rejected: %v", err)
	}
	yes := func(id, label string) Metric { return Metric{ID: id, Label: label, Type: YesNo, Points: 10} }
	for name, bad := range map[string]Card{
		"critical text":    {yes("a", "A"), {ID: "x", Label: "Bad", Type: Text, Critical: true}},
		"same label":       {yes("a", "Greeting"), yes("b", " greeting ")},
		"too many points":  {{ID: "a", Label: "A", Type: YesNo, Points: 500}},
		"scale too long":   {{ID: "a", Label: "A", Type: Scale, Points: 10, ScaleMax: 50}},
		"only text":        {{ID: "x", Label: "Notes", Type: Text}},
		"everything N/A":   {{ID: "a", Label: "A", Type: YesNo, Points: 10, AllowNA: true}},
		"duplicate option": {{ID: "a", Label: "A", Type: Dropdown, Options: []Option{{Label: "Met", Points: 5}, {Label: "met", Points: 0}}}},
	} {
		if Validate(bad) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if Validate(Card{}) != nil {
		t.Error("an empty scorecard (new task type) is rejected")
	}
}

func TestScore(t *testing.T) {
	cases := []struct {
		name     string
		answers  Answers
		score    float64
		critical bool
		passed   bool
	}{
		// 10 + 15 + 5 + 10 = 40 of 50.
		{"mixed", Answers{{"greet", "yes", "", false}, {"tone", "3", "", false}, {"res", "Partial", "", false}, {"verify", "yes", "", false}}, 80, false, true},
		// Greeting N/A leaves 35 of 40.
		{"na excluded", Answers{{"greet", "na", "", false}, {"tone", "3", "", false}, {"res", "Met", "", false}, {"verify", "yes", "", false}}, 87.5, false, true},
		// Everything else perfect, but the critical metric failed.
		{"critical zeroes", Answers{{"greet", "yes", "", false}, {"tone", "4", "", false}, {"res", "Met", "", false}, {"verify", "no", "did not verify", true}}, 0, true, false},
		// The same miss without the QA agent failing the audit on it: just its points.
		{"critical missed, not failed", Answers{{"greet", "yes", "", false}, {"tone", "4", "", false}, {"res", "Met", "", false}, {"verify", "no", "", false}}, 80, false, true},
		// A fail ticked on a metric that earned full points doesn't count.
		{"stale fail", Answers{{"greet", "yes", "", false}, {"tone", "4", "", false}, {"res", "Met", "", false}, {"verify", "yes", "", true}}, 100, false, true},
		{"below threshold", Answers{{"greet", "no", "", false}, {"tone", "2", "", false}, {"res", "Not met", "", false}, {"verify", "yes", "", false}}, 40, false, false},
	}
	for _, c := range cases {
		r, err := Score(card, c.answers, Thresholds{Pass: 80, Borderline: 70})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if r.Score == nil || *r.Score != c.score || r.CriticalFailed != c.critical || r.Passed != c.passed {
			t.Errorf("%s: got score=%v critical=%v passed=%v", c.name, *r.Score, r.CriticalFailed, r.Passed)
		}
	}

	if _, err := Score(card, Answers{{"greet", "yes", "", false}}, Thresholds{80, 70}); err == nil {
		t.Error("missing answers accepted")
	}
	if _, err := Score(card, Answers{{"greet", "yes", "", false}, {"tone", "3", "", false}, {"res", "Met", "", false}, {"verify", "na", "", false}}, Thresholds{80, 70}); err == nil {
		t.Error("N/A accepted on a metric that does not allow it")
	}
}

func TestNAWeightMovesToReceivers(t *testing.T) {
	// The IT lead's example: A (20%) is N/A, so its weight moves to B and C
	// (40% together), which become 60%.
	c := Card{
		{ID: "a", Label: "A", Type: YesNo, Points: 20, AllowNA: true},
		{ID: "b", Label: "B", Type: YesNo, Points: 20, NAReceiver: true},
		{ID: "c", Label: "C", Type: YesNo, Points: 20, NAReceiver: true},
		{ID: "d", Label: "D", Type: YesNo, Points: 20},
		{ID: "e", Label: "E", Type: YesNo, Points: 20},
	}
	ans := Answers{{"a", "na", "", false}, {"b", "yes", "", false}, {"c", "no", "", false}, {"d", "yes", "", false}, {"e", "yes", "", false}}
	r, err := Score(c, ans, Thresholds{Pass: 80, Borderline: 70})
	if err != nil {
		t.Fatal(err)
	}
	// B earns 30 of 30, C 0 of 30, D and E 20 each: 70 of 100.
	if *r.Score != 70 || r.Band != "borderline" {
		t.Fatalf("got %v (%s), want 70 borderline", *r.Score, r.Band)
	}
	// With no receivers, N/A just drops out: 60 of 80 = 75.
	for i := range c {
		c[i].NAReceiver = false
	}
	if r, _ := Score(c, ans, Thresholds{80, 70}); *r.Score != 75 {
		t.Fatalf("without receivers got %v, want 75", *r.Score)
	}
	ans[0].Value = "no" // A answered: 60 of 100, below borderline
	if r, _ := Score(c, ans, Thresholds{80, 70}); r.Band != "fail" {
		t.Fatalf("got %s, want fail", r.Band)
	}
}

func TestNAWeightSplitsByOwnPoints(t *testing.T) {
	// A (20) is N/A; B (10) and C (30) take its weight in proportion to their
	// own points: B 15, C 45, still 1 to 3. D (40) takes none.
	c := Card{
		{ID: "a", Label: "A", Type: YesNo, Points: 20, AllowNA: true},
		{ID: "b", Label: "B", Type: YesNo, Points: 10, AllowNA: true, NAReceiver: true},
		{ID: "c", Label: "C", Type: YesNo, Points: 30, NAReceiver: true},
		{ID: "d", Label: "D", Type: YesNo, Points: 40},
	}
	if err := Validate(c); err != nil {
		t.Fatalf("a metric that allows N/A and takes N/A weight is rejected: %v", err)
	}
	th := Thresholds{Pass: 80, Borderline: 70}
	// B missed: earned 45 + 40 of 15 + 45 + 40 = 85%.
	r, err := Score(c, Answers{{"a", "na", "", false}, {"b", "no", "", false}, {"c", "yes", "", false}, {"d", "yes", "", false}}, th)
	if err != nil || r.Score == nil || *r.Score != 85 {
		t.Fatalf("B missed: got %v %v, want 85", r.Score, err)
	}
	// B is N/A too: it gives its 10 away and takes nothing, so C takes all 30 (60) of 100.
	r, err = Score(c, Answers{{"a", "na", "", false}, {"b", "na", "", false}, {"c", "no", "", false}, {"d", "yes", "", false}}, th)
	if err != nil || r.Score == nil || *r.Score != 40 {
		t.Fatalf("B N/A too: got %v %v, want 40", r.Score, err)
	}
}

func TestSameScoring(t *testing.T) {
	c := Card{
		{ID: "a", Type: YesNo, Points: 10},
		{ID: "b", Type: Text},
	}
	base := Answers{{MetricID: "a", Value: "yes", Notes: "ok"}, {MetricID: "b", Value: "fine"}}
	if !c.SameScoring(base, Answers{{MetricID: "a", Value: "yes", Notes: "changed"}, {MetricID: "b", Value: "other comment"}}) {
		t.Error("notes and text comments don't change the score")
	}
	if c.SameScoring(base, Answers{{MetricID: "a", Value: "no"}, {MetricID: "b", Value: "fine"}}) {
		t.Error("a scored value changed")
	}
	if c.SameScoring(base, Answers{{MetricID: "b", Value: "fine"}}) {
		t.Error("a scored answer went missing")
	}
	if c.SameScoring(base, Answers{{MetricID: "a", Value: "yes", CriticalFail: true}, {MetricID: "b", Value: "fine"}}) {
		t.Error("failing the audit on a metric changes the score")
	}
}

// The fail-the-audit box counts only when the critical metric scored 0, not
// on partial credit.
func TestCriticalFailOnlyOnZero(t *testing.T) {
	c := Card{
		{ID: "hold", Label: "Hold etiquette", Type: Scale, Points: 10, ScaleMax: 4, Critical: true},
		{ID: "close", Label: "Closing", Type: YesNo, Points: 10},
	}
	th := Thresholds{Pass: 80, Borderline: 60}
	partial, _ := Score(c, Answers{{"hold", "2", "", true}, {"close", "yes", "", false}}, th)
	if partial.CriticalFailed || partial.Score == nil || *partial.Score != 75 {
		t.Errorf("partial credit with the box ticked: critical=%v score=%v, want not failed and 75", partial.CriticalFailed, *partial.Score)
	}
	zero, _ := Score(c, Answers{{"hold", "0", "", true}, {"close", "yes", "", false}}, th)
	if !zero.CriticalFailed || *zero.Score != 0 || zero.Band != "fail" {
		t.Errorf("0 with the box ticked: critical=%v score=%v band=%v, want a fail at 0", zero.CriticalFailed, *zero.Score, zero.Band)
	}
}
