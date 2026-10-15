// Package importer is the one way work enters the system. Sheet uploads and
// the tickets API both hand it one day's rows; it matches each row to an
// employee, drops rows already imported, stores the rest as unsampled tasks,
// and samples each employee's share into the queue.
package importer

import (
	"context"
	"fmt"
	"math/rand/v2"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/sampling"
	"github.com/oaldesi/qa-portal/internal/settings"
)

// Row is one item of work.
type Row struct {
	ExternalID string
	// AgentKey is the Vonage Agent ID (sheets) or the eDesk email (tickets).
	AgentKey  string
	AgentName string
	Labels    []string
	// Bucket spreads picks a second way within a tag (ticket reply counts).
	Bucket string
	// StartedAt is when the call started, for matching live-monitoring audits.
	StartedAt *time.Time
	Data      map[string]any
}

type Options struct {
	Source   string // "upload" or "api"
	Filename string
	UserID   *uuid.UUID
	DryRun   bool
	// Columns is the sheet's header order, kept on the run so the task page
	// can show the row the way the sheet had it.
	Columns []string
}

// WrongSheetError: too many of a sheet's agents aren't audited under the task
// type it was uploaded for. It is the uploader's mistake, said in their words.
type WrongSheetError struct{ Msg string }

func (e *WrongSheetError) Error() string { return e.Msg }

type RejectedAgent struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Rows int    `json:"rows"`
	// Reason is set when the agent is known but not audited under this type.
	Reason string `json:"reason,omitempty"`
}

type EmployeeSample struct {
	EmployeeID uuid.UUID `json:"employee_id"`
	Name       string    `json:"name"`
	Rows       int       `json:"rows"`
	Skipped    int       `json:"skipped"`
	Sampled    int       `json:"sampled"`
	Labels     []string  `json:"labels"`   // labels of the sampled rows
	Untagged   int       `json:"untagged"` // sampled rows with no label
}

// LinkedAgent is a Vonage Agent ID seen for the first time and matched to an
// employee by name. The import remembers it on the employee.
type LinkedAgent struct {
	Key      string    `json:"key"` // Agent ID, or "" for a name-only sheet
	Name     string    `json:"name"`
	UserID   uuid.UUID `json:"user_id"`
	UserName string    `json:"user_name"`
	How      string    `json:"how"` // "name", "email" or "similar name"
}

type Result struct {
	NoAgent     int              `json:"no_agent"`
	LiveMatched int              `json:"live_matched"`
	LiveFlagged int              `json:"live_flagged"`
	Run         model.ImportRun  `json:"run"`
	Rejected    []RejectedAgent  `json:"rejected"`
	Linked      []LinkedAgent    `json:"linked"`
	Employees   []EmployeeSample `json:"employees"`
	DryRun      bool             `json:"dry_run"`
}

// Ingest imports one day of work for a task type.
func Ingest(ctx context.Context, db *gorm.DB, tt model.TaskType, day model.Date, rows []Row, o Options) (*Result, error) {
	run := model.ImportRun{
		TaskTypeID: tt.ID, Source: o.Source, WorkDate: day, Filename: o.Filename, UserID: o.UserID,
		RowsRead: len(rows), Status: "succeeded", StartedAt: time.Now().UTC(),
		Detail: model.JSONMap{},
	}
	if len(o.Columns) > 0 {
		run.Detail["columns"] = o.Columns
	}

	// Drop ignored labels ("Read", channel tags) before anything looks at them;
	// the full set stays in the row's data for the task page.
	if len(tt.IgnoreLabels) > 0 {
		ignore := map[string]bool{}
		for _, l := range tt.IgnoreLabels {
			ignore[strings.ToLower(strings.TrimSpace(l))] = true
		}
		for i := range rows {
			rows[i].Labels = slices.DeleteFunc(slices.Clone(rows[i].Labels), func(l string) bool {
				return ignore[strings.ToLower(strings.TrimSpace(l))]
			})
		}
	}

	employees, linked, err := matchEmployees(ctx, db, tt, rows)
	if err != nil {
		return nil, err
	}

	// Reject rows for unknown agents, and collapse in-file duplicates.
	type key struct {
		ext string
		emp uuid.UUID
	}
	rejected := map[string]*RejectedAgent{}
	seen := map[key]bool{}
	var known []Row
	var empOf []uuid.UUID
	noAgent, wrongLine := 0, 0
	wrongBy := map[string]int{} // HR department → rows
	for _, r := range rows {
		k := agentKey(tt, r)
		if k == "" {
			noAgent++ // abandoned calls: nobody to audit
			continue
		}
		u, ok := employees[k]
		if !ok {
			if rejected[k] == nil {
				rejected[k] = &RejectedAgent{Key: strings.TrimSpace(r.AgentKey), Name: r.AgentName}
			}
			rejected[k].Rows++
			run.Rejected++
			continue
		}
		if !tt.Audits(u) {
			// A sales agent in a calls sheet (or the other way round).
			if rejected[k] == nil {
				rejected[k] = &RejectedAgent{Key: strings.TrimSpace(r.AgentKey), Name: u.Name,
					Reason: fmt.Sprintf("%s is in %s, not audited under %s", u.Name, u.Department(), tt.Name)}
			}
			rejected[k].Rows++
			run.Rejected++
			wrongLine++
			wrongBy[u.Department()]++
			continue
		}
		if seen[key{r.ExternalID, u.ID}] {
			run.Duplicates++
			continue
		}
		seen[key{r.ExternalID, u.ID}] = true
		known = append(known, r)
		empOf = append(empOf, u.ID)
	}

	// Mostly other people's agents: the wrong sheet, or the wrong type picked.
	if limit := settings.Load(ctx, db).WrongSheetPercent; wrongLine > 0 && wrongLine*100 >= limit*(wrongLine+len(known)) {
		top, n := "", 0
		for d, c := range wrongBy {
			if c > n {
				top, n = d, c
			}
		}
		return nil, &WrongSheetError{fmt.Sprintf("This doesn't look like a %s sheet: %d of %d rows are for %s agents, who aren't audited under it. Check the sheet and the task type you picked.",
			tt.Name, wrongLine, wrongLine+len(known), top)}
	}

	// Drop rows imported before (same type, item and agent).
	existing, err := existingKeys(ctx, db, tt.ID, known)
	if err != nil {
		return nil, err
	}
	var fresh []Row
	var freshEmp []uuid.UUID
	for i, r := range known {
		if existing[r.ExternalID+"|"+empOf[i].String()] {
			run.Duplicates++
			continue
		}
		fresh = append(fresh, r)
		freshEmp = append(freshEmp, empOf[i])
	}

	// Live-monitoring audits from this day take their call from the sheet:
	// that row becomes the audit's interaction instead of a row of its own.
	live, err := matchLive(ctx, db, tt, day, fresh, freshEmp, settings.Load(ctx, db).LiveWindow())
	if err != nil {
		return nil, err
	}
	if len(live.taken) > 0 {
		var keep []Row
		var keepEmp []uuid.UUID
		for i, r := range fresh {
			if !live.taken[i] {
				keep, keepEmp = append(keep, r), append(keepEmp, freshEmp[i])
			}
		}
		fresh, freshEmp = keep, keepEmp
	}
	run.Created = len(fresh)

	// Sample: X% of each agent's tagged rows, Y% of all untagged rows.
	skip := map[string]bool{}
	for _, l := range tt.SkipLabels {
		skip[strings.ToLower(strings.TrimSpace(l))] = true
	}
	nameOf := map[uuid.UUID]string{}
	for _, u := range employees {
		nameOf[u.ID] = u.Name
	}
	stats := map[uuid.UUID]*EmployeeSample{}
	var items []sampling.Item
	var itemRow []int
	for i, r := range fresh {
		es := stats[freshEmp[i]]
		if es == nil {
			es = &EmployeeSample{EmployeeID: freshEmp[i], Name: nameOf[freshEmp[i]], Labels: []string{}}
			stats[freshEmp[i]] = es
		}
		es.Rows++
		if hasAny(r.Labels, skip) {
			es.Skipped++
			run.Skipped++
			continue
		}
		items = append(items, sampling.Item{Agent: freshEmp[i].String(), Labels: r.Labels, Bucket: r.Bucket})
		itemRow = append(itemRow, i)
	}
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), rand.Uint64()))
	sampled := make([]bool, len(fresh))
	today := map[uuid.UUID]int{}
	for _, e := range freshEmp {
		today[e]++
	}
	bounds, err := agentBounds(ctx, db, tt, day, today)
	if err != nil {
		return nil, err
	}
	for _, p := range sampling.Plan(items, tt.SamplePercent, tt.UntaggedPercent, bounds, rng) {
		i := itemRow[p]
		sampled[i] = true
		es := stats[freshEmp[i]]
		es.Sampled++
		if len(fresh[i].Labels) == 0 {
			es.Untagged++
		}
		es.Labels = append(es.Labels, fresh[i].Labels...)
		run.Sampled++
	}
	perEmp := make([]EmployeeSample, 0, len(stats))
	for _, es := range stats {
		perEmp = append(perEmp, *es)
	}
	sort.Slice(perEmp, func(i, j int) bool { return perEmp[i].Name < perEmp[j].Name })

	res := &Result{NoAgent: noAgent, LiveMatched: len(live.matches), LiveFlagged: len(live.flagged), Run: run, Rejected: sortedRejected(rejected), Linked: linked, Employees: perEmp, DryRun: o.DryRun}
	run.Detail["rejected"] = res.Rejected
	run.Detail["linked"] = linked
	run.Detail["no_agent"] = noAgent
	if o.DryRun {
		return res, nil
	}

	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		run.FinishedAt = &now
		if err := tx.Create(&run).Error; err != nil {
			return err
		}
		if err := learn(tx, linked); err != nil {
			return err
		}
		if err := live.save(tx, run.ID); err != nil {
			return err
		}
		tasks := make([]model.Task, len(fresh))
		for i, r := range fresh {
			state := model.StateUnsampled
			if sampled[i] {
				state = model.StateReady
			}
			tasks[i] = model.Task{
				TaskTypeID: tt.ID, ImportRunID: &run.ID, EmployeeID: freshEmp[i],
				ExternalID: r.ExternalID, WorkDate: day, Labels: model.Strings(r.Labels),
				Data: model.JSONMap(r.Data), State: state, Kind: model.KindSample,
			}
		}
		if len(tasks) == 0 {
			return nil
		}
		// DO NOTHING: a concurrent import of the same rows must not fail this one.
		return tx.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(tasks, 500).Error
	})
	if err != nil {
		return nil, fmt.Errorf("importer: save: %w", err)
	}
	res.Run = run
	return res, nil
}

// agentBounds turns the task type's per-agent limits into how many of this
// day's rows each agent may get, given what their week and month already
// have. A weekly or monthly minimum is spread over the days left in it.
func agentBounds(ctx context.Context, db *gorm.DB, tt model.TaskType, day model.Date, today map[uuid.UUID]int) (map[string]sampling.Bound, error) {
	l := tt.AgentLimits
	d := day.Time
	weekStart := d.AddDate(0, 0, -((int(d.Weekday()) + 6) % 7))
	weekEnd := weekStart.AddDate(0, 0, 6)
	monthStart := time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, time.UTC)
	monthEnd := monthStart.AddDate(0, 1, -1)

	type counts struct {
		EmployeeID                                   uuid.UUID
		WeekRows, WeekPicked, MonthRows, MonthPicked int
	}
	before := map[uuid.UUID]counts{}
	if l.Week.Min != nil || l.Week.Max != nil || l.Month.Min != nil || l.Month.Max != nil {
		ids := make([]uuid.UUID, 0, len(today))
		for id := range today {
			ids = append(ids, id)
		}
		var rows []counts
		err := db.WithContext(ctx).Raw(`SELECT employee_id,
			count(*) FILTER (WHERE work_date BETWEEN @ws AND @we) AS week_rows,
			count(*) FILTER (WHERE work_date BETWEEN @ws AND @we AND state <> 'unsampled') AS week_picked,
			count(*) FILTER (WHERE work_date BETWEEN @ms AND @me) AS month_rows,
			count(*) FILTER (WHERE work_date BETWEEN @ms AND @me AND state <> 'unsampled') AS month_picked
			FROM tasks WHERE task_type_id = @tt AND kind = 'sample' AND employee_id IN @ids
			GROUP BY employee_id`,
			map[string]any{"ws": weekStart, "we": weekEnd, "ms": monthStart, "me": monthEnd, "tt": tt.ID, "ids": ids}).Scan(&rows).Error
		if err != nil {
			return nil, err
		}
		for _, c := range rows {
			before[c.EmployeeID] = c
		}
	}

	daysLeft := func(end time.Time) int { return int(end.Sub(d).Hours()/24) + 1 }
	out := map[string]sampling.Bound{}
	for emp, n := range today {
		c := before[emp]
		b := sampling.Bound{Min: max(0, l.Day.Min.Of(n)), Max: l.Day.Max.Of(n)}
		for _, p := range []struct {
			b                    model.Bounds
			rows, picked, remain int
		}{
			{l.Week, c.WeekRows + n, c.WeekPicked, daysLeft(weekEnd)},
			{l.Month, c.MonthRows + n, c.MonthPicked, daysLeft(monthEnd)},
		} {
			if need := p.b.Min.Of(p.rows) - p.picked; need > 0 {
				b.Min = max(b.Min, (need+p.remain-1)/p.remain)
			}
			if most := p.b.Max.Of(p.rows); most >= 0 {
				left := max(0, most-p.picked)
				if b.Max < 0 || left < b.Max {
					b.Max = left
				}
			}
		}
		out[emp.String()] = b
	}
	return out, nil
}

func existingKeys(ctx context.Context, db *gorm.DB, typeID uuid.UUID, rows []Row) (map[string]bool, error) {
	out := map[string]bool{}
	ids := make([]string, len(rows))
	for i, r := range rows {
		ids[i] = r.ExternalID
	}
	for start := 0; start < len(ids); start += 5000 {
		var found []struct {
			ExternalID string
			EmployeeID uuid.UUID
		}
		err := db.WithContext(ctx).Model(&model.Task{}).Select("external_id, employee_id").
			Where("task_type_id = ? AND kind <> 'rotation' AND external_id IN ?", typeID, ids[start:min(start+5000, len(ids))]).
			Scan(&found).Error
		if err != nil {
			return nil, err
		}
		for _, f := range found {
			out[f.ExternalID+"|"+f.EmployeeID.String()] = true
		}
	}
	return out, nil
}

func hasAny(labels []string, set map[string]bool) bool {
	for _, l := range labels {
		if set[strings.ToLower(l)] {
			return true
		}
	}
	return false
}

func sortedRejected(m map[string]*RejectedAgent) []RejectedAgent {
	out := make([]RejectedAgent, 0, len(m))
	for _, r := range m {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
