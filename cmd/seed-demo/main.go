// Command seed-demo fills a development database with weeks of demo work and
// evaluations, so the portal can be shown with data in it:
//
//   - Calls audit: a Vonage-style sheet per work day for the team's call
//     agents, imported through the real importer (sampling and per-agent
//     limits included). Gets a full 21-item scorecard if it has a short one.
//   - Sales calls audit: rows of a real Vonage sales export, cloned onto
//     each work day with new interaction IDs (-sales).
//   - Tickets audit: the real tickets already pulled are scored, nothing made up.
//
// Then the picks are scored (each agent has a steady skill level that improves
// a little over the weeks; each QA agent leans a little), most are
// acknowledged, a few are disputed at every stage, and there are live audits,
// escalations, a focus plan, rotation pairs and coaching. The last two days
// stay unscored so the QA queues have work.
//
// Days that already have an import of a type are left alone. Extras are
// added once. Back the database up first (pg_dump) to undo it.
//
//	go run ./cmd/seed-demo -yes -sales "path/to/sales export.xlsx"
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand/v2"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/joho/godotenv"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/config"
	"github.com/oaldesi/qa-portal/internal/db"
	"github.com/oaldesi/qa-portal/internal/importer"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
	"github.com/oaldesi/qa-portal/internal/settings"
)

func main() {
	_ = godotenv.Load()
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "seed-demo: %v\n", err)
		os.Exit(1)
	}
}

var rng = rand.New(rand.NewPCG(20261015, 7))

type seeder struct {
	ctx   context.Context
	db    *gorm.DB
	cfg   settings.Settings
	now   time.Time
	skill map[uuid.UUID]float64 // per agent, 0..1
	lean  map[uuid.UUID]float64 // per QA agent: + lenient, − strict
	done  []uuid.UUID           // evaluations this run wrote
}

func run() error {
	yes := flag.Bool("yes", false, "really write demo data into DATABASE_URL")
	fromS := flag.String("from", "2026-09-01", "first work day")
	toS := flag.String("to", "", "last work day (default: yesterday)")
	sales := flag.String("sales", "", "a Vonage sales export (.xlsx) whose rows are cloned onto each day")
	again := flag.Bool("rescore", false, "grade the demo evaluations again (after changing the generator)")
	flag.Parse()
	if !*yes {
		return errors.New("this writes demo data; run with -yes against a development database")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.Env != "dev" {
		return errors.New("APP_ENV is not dev; refusing to seed demo data")
	}
	ctx := context.Background()
	if err := db.Migrate(ctx, cfg.DatabaseURL, false); err != nil {
		return err
	}
	gdb, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	s := &seeder{ctx: ctx, db: gdb, cfg: settings.Load(ctx, gdb), now: time.Now(), skill: map[uuid.UUID]float64{}, lean: map[uuid.UUID]float64{}}

	from, err := time.Parse(time.DateOnly, *fromS)
	if err != nil {
		return err
	}
	to := time.Now().In(s.cfg.TZ()).AddDate(0, 0, -1)
	if *toS != "" {
		if to, err = time.Parse(time.DateOnly, *toS); err != nil {
			return err
		}
	}
	to = time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, time.UTC)
	var days []time.Time
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		if d.Weekday() != time.Sunday {
			days = append(days, d)
		}
	}
	// The last two work days stay in the queues.
	scoreUntil := to.AddDate(0, 0, -2)

	calls, err := s.taskType("calls_audit")
	if err != nil {
		return err
	}
	salesTT, err := s.taskType("sales_calls_audit")
	if err != nil {
		return err
	}
	var sup model.User
	if err := gdb.Where("role = 'supervisor' AND active AND department_id = ?", calls.DepartmentID).Order("name").First(&sup).Error; err != nil {
		return fmt.Errorf("no active supervisor for the calls team: %w", err)
	}
	if err := s.prepareCalls(calls); err != nil {
		return err
	}
	if err := s.setLimits(salesTT, `{"day": {"min": {"value": 1, "unit": "count"}, "max": {"value": 2, "unit": "count"}}}`); err != nil {
		return err
	}

	// 1. Work, day by day, through the importer.
	agents, err := s.callAgents(calls.DepartmentID)
	if err != nil {
		return err
	}
	var salesRows []importer.Row
	if *sales != "" {
		f, err := os.Open(*sales)
		if err != nil {
			return err
		}
		sheet, err := importer.ParseSheet(*sales, f)
		f.Close()
		if err != nil {
			return err
		}
		if salesRows, err = importer.SheetRows(sheet, salesTT.Columns, s.cfg.CallClock()); err != nil {
			return err
		}
	}
	for _, d := range days {
		if err := s.importDay(*calls, d, callRows(agents, d, s.cfg.CallClock()), sup.ID); err != nil {
			return err
		}
		if len(salesRows) > 0 {
			if err := s.importDay(*salesTT, d, cloneRows(salesRows, d, 55+rng.IntN(30), s.cfg.CallClock()), sup.ID); err != nil {
				return err
			}
		}
	}

	// 2. Score what was picked.
	if err := s.setLean(calls.DepartmentID); err != nil {
		return err
	}
	if *again {
		for _, tt := range []*model.TaskType{calls, salesTT} {
			if err := s.rescore(*tt); err != nil {
				return err
			}
		}
	}
	for _, tt := range []*model.TaskType{calls, salesTT} {
		n, err := s.scorePicked(*tt, scoreUntil, true)
		if err != nil {
			return err
		}
		log.Printf("%s: %d evaluations", tt.Name, n)
	}
	var tickets model.TaskType
	if gdb.Where("source = ? AND active", model.SourceTicketsAPI).First(&tickets).Error == nil && len(tickets.Scorecard) > 0 {
		if err := s.setLean(tickets.DepartmentID); err != nil {
			return err
		}
		n, err := s.scorePicked(tickets, to.AddDate(0, 0, -1), false)
		if err != nil {
			return err
		}
		log.Printf("%s: %d evaluations", tickets.Name, n)
	}

	// 3. Answers, extras and coaching, once.
	var seeded int64
	gdb.Model(&model.AuditLog{}).Where("action = 'demo_seed'").Count(&seeded)
	if seeded == 0 {
		if err := s.extras(*calls, sup, scoreUntil); err != nil {
			return err
		}
		if err := s.answers(sup); err != nil {
			return err
		}
		if err := s.coaching(calls.DepartmentID, sup); err != nil {
			return err
		}
		gdb.Create(&model.AuditLog{Action: "demo_seed", Detail: model.JSONMap{"from": *fromS, "to": to.Format(time.DateOnly)}})
	}
	log.Print("done")
	return nil
}

func (s *seeder) taskType(code string) (*model.TaskType, error) {
	var tt model.TaskType
	if err := s.db.Where("code = ?", code).First(&tt).Error; err != nil {
		return nil, fmt.Errorf("task type %s: %w", code, err)
	}
	return &tt, nil
}

func (s *seeder) setLimits(tt *model.TaskType, limits string) error {
	if err := s.db.Exec("UPDATE task_types SET agent_limits = ?::jsonb WHERE id = ?", limits, tt.ID).Error; err != nil {
		return err
	}
	return s.db.First(tt, "id = ?", tt.ID).Error
}

// prepareCalls gives the calls type a full scorecard (if it has a short test
// one), rotation, and limits of 1-2 audits a day and 10 a week per agent.
func (s *seeder) prepareCalls(tt *model.TaskType) error {
	if len(tt.Scorecard) < 10 {
		if err := scorecard.Validate(callsCard); err != nil {
			return err
		}
		if err := s.db.Model(tt).Updates(map[string]any{"scorecard": callsCard, "rotation_enabled": true}).Error; err != nil {
			return err
		}
	}
	return s.setLimits(tt, `{"day": {"min": {"value": 1, "unit": "count"}, "max": {"value": 2, "unit": "count"}},
		"week": {"max": {"value": 10, "unit": "count"}}}`)
}

func yn(id, label string, pts float64, critical, na bool) scorecard.Metric {
	return scorecard.Metric{ID: id, Label: label, Type: scorecard.YesNo, Points: pts, Critical: critical, AllowNA: na}
}

func scale(id, label string, pts float64, receiver bool) scorecard.Metric {
	return scorecard.Metric{ID: id, Label: label, Type: scorecard.Scale, Points: pts, ScaleMax: 4, NAReceiver: receiver}
}

var callsCard = scorecard.Card{
	yn("greeting", "Used the standard greeting and gave their name", 3, false, false),
	yn("verify", "Verified the customer (name plus order number or phone)", 6, true, false),
	scale("listen", "Listened without interrupting", 5, true),
	yn("reason", "Identified the reason for the call correctly", 5, false, false),
	yn("vehicle", "Confirmed vehicle year, make and model", 5, false, true),
	yn("order_check", "Checked the order in the system before answering", 5, false, true),
	{ID: "accuracy", Label: "Gave accurate information (policy, part, ETA)", Type: scorecard.Dropdown, Critical: true,
		Options: []scorecard.Option{{Label: "Accurate", Points: 10}, {Label: "Minor error", Points: 5}, {Label: "Wrong", Points: 0}}},
	yn("process", "Followed the return / exchange / warranty process", 5, false, true),
	yn("alternatives", "Offered alternatives when the first answer was no", 4, false, true),
	yn("hold_ask", "Asked before placing on hold and thanked the customer", 3, false, true),
	yn("hold_time", "Kept each hold under 2 minutes", 3, false, true),
	scale("tone", "Tone and courtesy", 5, true),
	scale("empathy", "Showed empathy for the customer's situation", 5, true),
	yn("language", "Clear, simple language without jargon", 3, false, false),
	yn("ownership", "Took ownership instead of passing the customer on", 4, false, false),
	yn("expectations", "Set the right expectation for next steps and timing", 5, false, false),
	yn("dead_air", "No dead air longer than 10 seconds", 3, false, false),
	yn("disposition", "Chose the correct disposition code", 4, false, false),
	yn("account_notes", "Left accurate notes on the order / account", 4, false, false),
	yn("further_help", "Offered further help before closing", 2, false, false),
	yn("closing", "Used the standard closing", 2, false, false),
	{ID: "notes", Label: "Coaching notes", Type: scorecard.Text},
}

type agent struct {
	ID         uuid.UUID
	Name, Code string
}

// callAgents: the team's active call agents whose names are unique (rows
// match by Vonage ID when they have one, by exact name otherwise, so nothing
// is learned onto anyone).
func (s *seeder) callAgents(dept uuid.UUID) ([]agent, error) {
	var us []model.User
	err := s.db.Where("role = 'employee' AND active AND department_id = ? AND profile->>'job_title' ILIKE '%call%'", dept).Order("name").Find(&us).Error
	if err != nil {
		return nil, err
	}
	count := map[string]int{}
	for _, u := range us {
		count[importer.NameKey(u.Name)]++
	}
	var out []agent
	for _, u := range us {
		if count[importer.NameKey(u.Name)] > 1 {
			continue
		}
		a := agent{ID: u.ID, Name: u.Name}
		if u.AgentCode != nil {
			a.Code = *u.AgentCode
		}
		out = append(out, a)
	}
	if len(out) == 0 {
		return nil, errors.New("no call agents on the calls team")
	}
	return out, nil
}

var codes = []struct {
	code   string
	weight int
}{
	{"", 20}, {"Fitment Check", 14}, {"Tracking- ETA", 14}, {"Call Transferred", 10}, {"Pricing", 8}, {"Warranty", 8},
	{"Refund-Ordered wrong", 6}, {"Exchange-Ordered wrong", 6}, {"Shipping inquiry", 5}, {"Store Credit- new order", 3},
	{"Delay- DT", 3}, {"Exchange-Received wrong/DT", 3},
}

func pickCode() string {
	total := 0
	for _, c := range codes {
		total += c.weight
	}
	n := rng.IntN(total)
	for _, c := range codes {
		if n -= c.weight; n < 0 {
			return c.code
		}
	}
	return ""
}

func phone() string { return fmt.Sprintf("%d%09d", 2+rng.IntN(8), rng.IntN(1_000_000_000)) }

// callRows is one day of a Vonage calls export for the team.
func callRows(agents []agent, day time.Time, clock *time.Location) []importer.Row {
	var rows []importer.Row
	for _, a := range agents {
		for range 10 + rng.IntN(16) {
			start := time.Date(day.Year(), day.Month(), day.Day(), 8+rng.IntN(10), rng.IntN(60), rng.IntN(60), 0, clock)
			id := uuid.NewString()
			code := pickCode()
			dir := "Inbound"
			if rng.IntN(7) == 0 {
				dir = "Outbound"
			}
			data := map[string]any{
				"Interaction ID": id, "Start time": start.Format("2006-01-02 15:04:05"), "Initial direction": dir,
				"Connect from": phone(), "Connect to": "12489658551", "Agent": a.Name, "Agent ID": a.Code, "Disposition code": code,
			}
			var labels []string
			if code != "" {
				labels = []string{code}
			}
			rows = append(rows, importer.Row{ExternalID: id, AgentKey: a.Code, AgentName: a.Name, Labels: labels, StartedAt: &start, Data: data})
		}
	}
	return rows
}

// cloneRows copies n random rows of a real export onto another day.
func cloneRows(src []importer.Row, day time.Time, n int, clock *time.Location) []importer.Row {
	out := make([]importer.Row, 0, n)
	for _, i := range rng.Perm(len(src))[:min(n, len(src))] {
		r := src[i]
		data := map[string]any{}
		for k, v := range r.Data {
			data[k] = v
		}
		id := uuid.NewString()
		data["Interaction ID"], data["Conversation ID"] = id, uuid.NewString()
		var start time.Time
		if r.StartedAt != nil {
			t := r.StartedAt.In(clock)
			start = time.Date(day.Year(), day.Month(), day.Day(), t.Hour(), t.Minute(), t.Second(), 0, clock)
		} else {
			start = time.Date(day.Year(), day.Month(), day.Day(), 10, 0, 0, 0, clock)
		}
		data["Start time"] = start.Format("2006-01-02 15:04:05")
		out = append(out, importer.Row{ExternalID: id, AgentKey: r.AgentKey, AgentName: r.AgentName, Labels: r.Labels, StartedAt: &start, Data: data})
	}
	return out
}

func (s *seeder) importDay(tt model.TaskType, day time.Time, rows []importer.Row, by uuid.UUID) error {
	var n int64
	s.db.Model(&model.ImportRun{}).Where("task_type_id = ? AND work_date = ?", tt.ID, day.Format(time.DateOnly)).Count(&n)
	if n > 0 || len(rows) == 0 {
		return nil
	}
	cols := []string{"Interaction ID", "Start time", "Initial direction", "Connect from", "Connect to", "Agent", "Agent ID", "Disposition code"}
	if tt.Columns.AgentCode == "" {
		cols = []string{"Interaction ID", "Conversation ID", "Start time", "Media manager", "Media type", "Direction", "Service name",
			"Connect from", "Connect to", "Disposition code", "Interaction outcome", "Handle time", "First agent name"}
	}
	res, err := importer.Ingest(s.ctx, s.db, tt, model.Date{Time: day}, rows, importer.Options{
		Source: "upload", Filename: "demo seed " + day.Format(time.DateOnly) + ".xlsx", UserID: &by, Columns: cols,
	})
	if err != nil {
		return fmt.Errorf("%s %s: %w", tt.Name, day.Format(time.DateOnly), err)
	}
	log.Printf("%s %s: %d rows, %d sampled, %d rejected", tt.Name, day.Format(time.DateOnly), res.Run.Created, res.Run.Sampled, res.Run.Rejected)
	return nil
}

// setLean gives each QA agent of the team a small, steady lean.
func (s *seeder) setLean(dept uuid.UUID) error {
	var qas []model.User
	if err := s.db.Where("role = 'qa_agent' AND active AND department_id = ?", dept).Order("name").Find(&qas).Error; err != nil {
		return err
	}
	leans := []float64{0, 0.06, -0.07, 0.03}
	for i, q := range qas {
		s.lean[q.ID] = leans[i%len(leans)]
	}
	return nil
}

func (s *seeder) qas(dept uuid.UUID) []uuid.UUID {
	var ids []uuid.UUID
	s.db.Model(&model.User{}).Where("role = 'qa_agent' AND active AND department_id = ?", dept).Order("name").Pluck("id", &ids)
	return ids
}

// skillOf is an agent's steady level, improving a little over the weeks.
func (s *seeder) skillOf(emp uuid.UUID, day time.Time) float64 {
	k, ok := s.skill[emp]
	if !ok {
		k = 0.8 + rng.Float64()*0.18
		s.skill[emp] = k
	}
	weeks := s.now.Sub(day).Hours() / 24 / 7
	return math.Min(0.99, k-0.012*weeks)
}

// scorePicked scores the picked rows of a type up to a day. demoOnly keeps
// it to the rows this command imported.
func (s *seeder) scorePicked(tt model.TaskType, until time.Time, demoOnly bool) (int, error) {
	q := s.db.Model(&model.Task{}).Where("task_type_id = ? AND kind = 'sample' AND work_date <= ?", tt.ID, until.Format(time.DateOnly))
	if demoOnly {
		q = q.Where("state IN ('ready', 'assigned') AND import_run_id IN (SELECT id FROM import_runs WHERE filename LIKE 'demo seed %')")
	} else {
		q = q.Where("state = 'ready'") // real work: leave what is already in someone's queue
	}
	var tasks []model.Task
	if err := q.Find(&tasks).Error; err != nil {
		return 0, err
	}
	qas := s.qas(tt.DepartmentID)
	if len(qas) == 0 {
		return 0, nil
	}
	for i, t := range tasks {
		qa := qas[i%len(qas)]
		if t.AssignedQAID != nil {
			qa = *t.AssignedQAID
		}
		if err := s.evaluate(tt, t, qa, workTime(t.WorkDate.Time, 1, s.cfg.TZ(), s.now)); err != nil {
			return i, err
		}
	}
	return len(tasks), nil
}

// workTime is a time during working hours some days after a work day, never
// in the future.
func workTime(day time.Time, after int, tz *time.Location, now time.Time) time.Time {
	d := day.AddDate(0, 0, after)
	t := time.Date(d.Year(), d.Month(), d.Day(), 9+rng.IntN(8), rng.IntN(60), 0, 0, tz)
	if t.After(now) {
		t = now.Add(-time.Duration(30+rng.IntN(120)) * time.Minute)
	}
	return t.UTC()
}

// grade answers the scorecard the way this QA agent would for this agent.
func (s *seeder) grade(tt model.TaskType, t model.Task, qa uuid.UUID) (scorecard.Answers, scorecard.Result, error) {
	skill := s.skillOf(t.EmployeeID, t.WorkDate.Time) + s.lean[qa]
	answers := make(scorecard.Answers, 0, len(tt.Scorecard))
	for _, m := range tt.Scorecard {
		answers = append(answers, answer(m, skill))
	}
	res, err := scorecard.Score(tt.Scorecard, answers, scorecard.Thresholds{Pass: tt.PassThreshold, Borderline: tt.BorderlineThreshold})
	// The text box comments on the call as a whole.
	for i, m := range tt.Scorecard {
		if m.Type == scorecard.Text {
			answers[i].Value = overall(res)
		}
	}
	return answers, res, err
}

// rescore grades the demo evaluations of a type again, in place (same QA
// agent, same times), after the generator changed.
func (s *seeder) rescore(tt model.TaskType) error {
	var tasks []model.Task
	err := s.db.Where("task_type_id = ? AND state = 'completed' AND evaluated_by IS NOT NULL AND import_run_id IN (SELECT id FROM import_runs WHERE filename LIKE 'demo seed %')", tt.ID).
		Order("work_date, id").Find(&tasks).Error
	if err != nil {
		return err
	}
	card := tt.Scorecard
	for _, t := range tasks {
		answers, res, err := s.grade(tt, t, *t.EvaluatedBy)
		if err != nil {
			return err
		}
		upd := map[string]any{"scorecard": &card, "answers": &answers, "score": res.Score, "critical_failed": res.CriticalFailed, "passed": res.Passed, "result": res.Band}
		if err := s.db.Model(&model.Task{}).Where("id = ?", t.ID).Updates(upd).Error; err != nil {
			return err
		}
	}
	log.Printf("%s: %d evaluations graded again", tt.Name, len(tasks))
	return nil
}

func (s *seeder) evaluate(tt model.TaskType, t model.Task, qa uuid.UUID, at time.Time) error {
	answers, res, err := s.grade(tt, t, qa)
	if err != nil {
		return err
	}
	card := tt.Scorecard
	assigned := at.Add(-time.Duration(20+rng.IntN(200)) * time.Minute)
	s.done = append(s.done, t.ID)
	return s.db.Transaction(func(tx *gorm.DB) error {
		err := tx.Model(&model.Task{}).Where("id = ?", t.ID).Updates(map[string]any{
			"state": model.StateCompleted, "scorecard": &card, "answers": &answers,
			"score": res.Score, "critical_failed": res.CriticalFailed, "passed": res.Passed, "result": res.Band,
			"assigned_qa_id": qa, "assigned_at": assigned, "evaluated_by": qa, "submitted_at": at, "completed_at": at, "queue_position": nil,
		}).Error
		if err != nil {
			return err
		}
		return tx.Create([]model.AuditLog{
			{TaskID: &t.ID, ActorID: nil, Action: "assigned", Detail: model.JSONMap{}, CreatedAt: assigned},
			{TaskID: &t.ID, ActorID: &qa, Action: "submitted", Detail: model.JSONMap{"score": res.Score, "result": res.Band}, CreatedAt: at},
		}).Error
	})
}

func clamp(x float64) float64 { return math.Max(0, math.Min(1, x)) }

func answer(m scorecard.Metric, skill float64) scorecard.Answer {
	a := scorecard.Answer{MetricID: m.ID}
	if m.AllowNA && rng.Float64() < 0.12 {
		a.Value = "na"
		return a
	}
	p := clamp(skill + rng.NormFloat64()*0.05)
	if m.Critical {
		p = 1 - (1-p)*0.25 // critical misses are rare
	}
	switch m.Type {
	case scorecard.YesNo:
		a.Value = "yes"
		if rng.Float64() > p {
			a.Value, a.Notes = "no", noteFor(m.ID)
		}
	case scorecard.Scale:
		v := int(math.Round(float64(m.ScaleMax) * clamp(p+rng.NormFloat64()*0.12)))
		a.Value = strconv.Itoa(v)
		if v < m.ScaleMax-1 {
			a.Notes = noteFor(m.ID)
		}
	case scorecard.Dropdown:
		opts := slices.Clone(m.Options)
		slices.SortFunc(opts, func(x, y scorecard.Option) int { return int(y.Points - x.Points) })
		switch r := rng.Float64(); {
		case r < p:
			a.Value = opts[0].Label
		case r < p+(1-p)*0.7:
			a.Value, a.Notes = opts[len(opts)/2].Label, noteFor(m.ID)
		default:
			a.Value, a.Notes = opts[len(opts)-1].Label, noteFor(m.ID)
		}
	}
	return a
}

var notes = map[string][]string{
	"greeting":      {"Opened with \"Hello?\" instead of the standard greeting and didn't give a name."},
	"verify":        {"Discussed the order before confirming the customer's name and order number.", "Only asked for the name; the order number or phone is needed too."},
	"listen":        {"Talked over the customer twice in the first minute.", "Jumped to a solution before the customer finished explaining."},
	"reason":        {"Treated it as a tracking question; the customer was asking about a refund."},
	"vehicle":       {"Didn't confirm the year and model before checking fitment."},
	"order_check":   {"Answered from memory; the order showed a different ship date."},
	"accuracy":      {"Quoted 3-5 days; the order page showed backordered.", "Told the customer refunds take 24 hours; policy is 3-5 business days."},
	"process":       {"Promised an exchange without opening the return request."},
	"alternatives":  {"Said the part was out of stock and stopped there; the compatible alternative was in stock."},
	"hold_ask":      {"Put the customer on hold without asking."},
	"hold_time":     {"One hold ran past 3 minutes with no check-in."},
	"tone":          {"Sounded rushed toward the end of the call.", "Short with the customer after the second question."},
	"empathy":       {"The customer mentioned the car was off the road; no acknowledgement."},
	"language":      {"Used internal terms (\"DT\", \"RMA\") without explaining them."},
	"ownership":     {"Transferred the call when this could have been solved directly."},
	"expectations":  {"Didn't tell the customer when to expect the refund."},
	"dead_air":      {"About 25 seconds of silence while searching the order."},
	"disposition":   {"Coded as Pricing; the call was a warranty claim."},
	"account_notes": {"No note left on the order about the promised callback."},
	"further_help":  {"Ended the call without asking if there was anything else."},
	"closing":       {"Skipped the standard closing."},
	// sales and tickets
	"needs":   {"Didn't ask for the vehicle before recommending the part."},
	"product": {"Couldn't explain the difference between the two brands."},
	"offer":   {"Mentioned the price but not shipping time or warranty."},
	"close":   {"Didn't ask for the sale after the customer said it sounded good."},
}

func noteFor(id string) string {
	if ns := notes[id]; len(ns) > 0 {
		return ns[rng.IntN(len(ns))]
	}
	generic := []string{"Missed on this one; see the QA notes above.", "Partly done. Let's go over it in your next coaching."}
	return generic[rng.IntN(len(generic))]
}

func overall(res scorecard.Result) string {
	switch {
	case res.CriticalFailed:
		return "Critical miss on this one, so the audit fails regardless of the rest. We'll go over it together."
	case res.Band == "pass":
		return []string{"Solid call. Keep it up.", "Very good handling overall.", "Clear and friendly call, well done."}[rng.IntN(3)]
	case res.Band == "borderline":
		return "Good call overall; focus on the points marked above."
	}
	return "Several misses on this call. Please listen back to it before our next coaching."
}

// answers: most agents acknowledge within a day or two; a few dispute, at
// every stage of a dispute.
func (s *seeder) answers(sup model.User) error {
	var tasks []model.Task
	err := s.db.Where(`(id IN ? OR import_run_id IN (SELECT id FROM import_runs WHERE filename LIKE 'demo seed %'))
		AND state = 'completed' AND ack_status = '' AND kind IN ('sample', 'live', 'escalation') AND completed_at < ?`,
		append(s.done, uuid.Nil), s.now.Add(-48*time.Hour)).Order("completed_at").Find(&tasks).Error
	if err != nil {
		return err
	}
	comments := []string{
		"I did verify the customer at the start of the call, around 0:40.",
		"The customer hung up before I could offer more help.",
		"The hold was long because the system was down that morning.",
		"I gave the ETA shown on the tracking page at the time.",
	}
	stages := []string{"disputed", "disputed", "dispute_qa", "dispute_qa", "dispute_qa", "upheld", "upheld", "upheld", "changed", "changed"}
	disputes := 0
	for _, t := range tasks {
		ackAt := t.CompletedAt.Add(time.Duration(2+rng.IntN(40)) * time.Hour)
		if ackAt.After(s.now) {
			ackAt = s.now.Add(-time.Hour)
		}
		switch r := rng.Float64(); {
		case r < 0.07:
			continue // never answered
		case r < 0.10 && disputes < len(stages) && t.CompletedAt.After(s.now.AddDate(0, 0, -16)): // recent, so they show this month
			stage := stages[disputes]
			disputes++
			if err := s.dispute(t, stage, comments[rng.IntN(len(comments))], ackAt, sup); err != nil {
				return err
			}
		default:
			if err := s.db.Model(&model.Task{}).Where("id = ?", t.ID).Updates(map[string]any{"ack_status": "acknowledged", "ack_at": ackAt}).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *seeder) dispute(t model.Task, stage, comment string, at time.Time, sup model.User) error {
	upd := map[string]any{"ack_status": stage, "ack_comment": comment, "ack_at": at}
	logs := []model.AuditLog{{TaskID: &t.ID, ActorID: &t.EmployeeID, Action: "disputed", Detail: model.JSONMap{"comment": comment}, CreatedAt: at}}
	if stage != "disputed" {
		logs = append(logs, model.AuditLog{TaskID: &t.ID, ActorID: &sup.ID, Action: "dispute_forwarded",
			Detail: model.JSONMap{"reason": "Please listen to the call again and check this."}, CreatedAt: at.Add(3 * time.Hour)})
	}
	resolved := at.Add(26 * time.Hour)
	switch stage {
	case "upheld":
		upd["dispute_resolution"] = "Listened again: the score stands, the step happened after the order details were discussed."
		upd["dispute_resolved_by"], upd["dispute_resolved_at"] = t.EvaluatedBy, resolved
		logs = append(logs, model.AuditLog{TaskID: &t.ID, ActorID: t.EvaluatedBy, Action: "dispute_upheld", Detail: model.JSONMap{"reason": upd["dispute_resolution"]}, CreatedAt: resolved})
	case "changed":
		upd["dispute_resolution"] = "You're right, it was there. Score updated."
		upd["dispute_resolved_by"], upd["dispute_resolved_at"] = t.EvaluatedBy, resolved
		if t.Score != nil && !t.CriticalFailed {
			var tt model.TaskType
			s.db.First(&tt, "id = ?", t.TaskTypeID)
			score := math.Min(100, *t.Score+8)
			upd["score"], upd["result"], upd["passed"] = score, "fail", false
			if score >= float64(tt.PassThreshold) {
				upd["result"], upd["passed"] = "pass", true
			} else if score >= float64(tt.BorderlineThreshold) {
				upd["result"] = "borderline"
			}
		}
		logs = append(logs, model.AuditLog{TaskID: &t.ID, ActorID: t.EvaluatedBy, Action: "evaluation_edited",
			Detail: model.JSONMap{"reason": upd["dispute_resolution"], "before": model.JSONMap{"score": t.Score}, "after": model.JSONMap{"score": upd["score"]}}, CreatedAt: resolved})
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Task{}).Where("id = ?", t.ID).Updates(upd).Error; err != nil {
			return err
		}
		return tx.Create(&logs).Error
	})
}

// extras turns some not-sampled calls into live audits, escalations and a
// focus plan, and adds rotation (QA over QA) pairs.
func (s *seeder) extras(tt model.TaskType, sup model.User, until time.Time) error {
	qas := s.qas(tt.DepartmentID)
	if len(qas) < 2 {
		return nil
	}
	var spare []model.Task
	err := s.db.Where("task_type_id = ? AND kind = 'sample' AND state = 'unsampled' AND work_date <= ? AND work_date >= ?",
		tt.ID, until.Format(time.DateOnly), until.AddDate(0, 0, -25).Format(time.DateOnly)).Order("random()").Limit(40).Find(&spare).Error
	if err != nil || len(spare) < 30 {
		return err
	}
	clock := s.cfg.CallClock()
	var already int64
	s.db.Model(&model.Task{}).Where("task_type_id = ? AND kind IN ('live', 'escalation', 'focus') AND import_run_id IN (SELECT id FROM import_runs WHERE filename LIKE 'demo seed %')", tt.ID).Count(&already)
	for i, t := range spare[:18] {
		if already > 0 {
			break // a run that stopped half-way already made these
		}
		qa := qas[i%len(qas)]
		upd := map[string]any{"created_by": qa}
		switch {
		case i < 12: // live: the QA agent typed in the call while listening
			start := importer.ParseCallTime(fmt.Sprint(t.Data["Start time"]), clock)
			if start == nil {
				continue
			}
			live := start.Add(time.Duration(2+rng.IntN(12)) * time.Second)
			entered := map[string]any{}
			for _, k := range []string{"Initial direction", "Connect from", "Connect to", "Disposition code"} {
				entered[k] = t.Data[k]
			}
			if i == 3 {
				entered["Connect from"] = phone() // one typo, to show the mismatch warning
			}
			data := model.JSONMap(t.Data)
			data["live_entered"] = entered
			upd["kind"], upd["match_status"], upd["live_started_at"], upd["data"], upd["priority"] = model.KindLive, "matched", live, data, 5
		case i < 15:
			upd["kind"], upd["priority"], upd["created_by"] = model.KindEscalation, 10, sup.ID
			upd["note"] = []string{"Customer complained about this call by email.", "Long call, please check how the refund was explained.", "Customer says they were promised a callback."}[i-12]
		default:
			upd["kind"], upd["note"] = model.KindFocus, "Focus plan: "+strings.Join(t.Labels, ", ")
		}
		if err := s.db.Model(&model.Task{}).Where("id = ?", t.ID).Updates(upd).Error; err != nil {
			return err
		}
		if err := s.db.First(&t, "id = ?", t.ID).Error; err != nil {
			return err
		}
		if err := s.evaluate(tt, t, qa, workTime(t.WorkDate.Time, 1, s.cfg.TZ(), s.now)); err != nil {
			return err
		}
	}
	// Rotation: the same call scored blind by two QA agents.
	for i, t := range spare[18:30] {
		a, b := qas[i%len(qas)], qas[(i+1)%len(qas)]
		first := model.Task{TaskTypeID: t.TaskTypeID, ImportRunID: t.ImportRunID, EmployeeID: t.EmployeeID, ExternalID: t.ExternalID,
			WorkDate: t.WorkDate, Labels: t.Labels, Data: t.Data, State: model.StateAssigned, AssignedQAID: &a, AssignedAt: &s.now, Kind: model.KindRotation}
		if err := s.db.Create(&first).Error; err != nil {
			return err
		}
		if err := s.evaluate(tt, first, a, workTime(t.WorkDate.Time, 1, s.cfg.TZ(), s.now)); err != nil {
			return err
		}
		second := first
		second.ID, second.RotationOf, second.AssignedQAID = uuid.Nil, &first.ID, &b
		if err := s.db.Create(&second).Error; err != nil {
			return err
		}
		if err := s.evaluate(tt, second, b, workTime(t.WorkDate.Time, 1+tt.RotationDays, s.cfg.TZ(), s.now)); err != nil {
			return err
		}
	}
	return nil
}

// coaching for the agents with the lowest averages: one done and
// acknowledged, one done and waiting for the agent, one coming up.
func (s *seeder) coaching(dept uuid.UUID, sup model.User) error {
	var low []struct {
		EmployeeID uuid.UUID
		Avg        float64
	}
	err := s.db.Raw(`SELECT t.employee_id, avg(t.score) AS avg FROM tasks t JOIN users u ON u.id = t.employee_id
		WHERE u.department_id = ? AND t.state = 'completed' AND t.kind = 'sample' GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 LIMIT 6`, dept).Scan(&low).Error
	if err != nil {
		return err
	}
	qas := s.qas(dept)
	if len(qas) == 0 {
		return nil
	}
	topics := []string{"Customer verification", "Hold etiquette", "Setting expectations", "Disposition codes", "Warranty process", "Empathy on long calls"}
	for i, l := range low {
		var ids []string
		s.db.Model(&model.Task{}).Where("employee_id = ? AND state = 'completed' AND kind = 'sample'", l.EmployeeID).
			Order("score").Limit(2).Pluck("id::text", &ids)
		c := model.Coaching{DepartmentID: dept, EmployeeID: l.EmployeeID, Topic: topics[i%len(topics)], TaskIDs: model.Strings(ids),
			AssignedQAID: qas[i%len(qas)], CreatedBy: &sup.ID, Status: "open"}
		switch i % 3 {
		case 0:
			done := s.now.AddDate(0, 0, -12)
			ack := done.Add(20 * time.Hour)
			c.Status, c.CompletedAt, c.AckAt, c.AckComment = "done", &done, &ack, "Thanks, understood."
			c.Notes = "Went through the two calls together. Walked through the steps and why the order matters."
			c.Outcome = "Will follow the checklist on every call; re-check in two weeks."
		case 1:
			done := s.now.AddDate(0, 0, -2)
			c.Status, c.CompletedAt = "done", &done
			c.Notes = "Listened to the linked calls and practised the standard wording."
			c.Outcome = "Use the hold script; keep holds under two minutes."
		default:
			due := model.Date{Time: time.Date(s.now.Year(), s.now.Month(), s.now.Day()+4, 0, 0, 0, 0, time.UTC)}
			c.DueDate = &due
		}
		if err := s.db.Create(&c).Error; err != nil {
			return err
		}
	}
	return nil
}
