package httpapi

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
)

// handleExport writes everything about one or more agents for a period as an
// Excel workbook: Summary, Audits, Audit answers, Metrics, Escalations and
// Coaching. ?ids=a,b picks agents; without it, every agent the directory
// filters (department_id, q) match. from/to are work dates.
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	from, to := s.periodOf(r)
	agents, err := s.agentRows(r, from, to)
	if err != nil {
		dbError(w, err)
		return
	}
	if len(agents) == 0 {
		writeError(w, http.StatusBadRequest, "no agents to export")
		return
	}
	ids := make([]uuid.UUID, len(agents))
	for i, a := range agents {
		ids[i] = a.ID
	}
	db, tz := s.db.WithContext(r.Context()), s.cfg(r).TZ()

	var audits []struct {
		EmployeeID     uuid.UUID
		EmployeeName   string
		ExternalID     string
		OrderNumbers   model.Strings
		WorkDate       model.Date
		TaskTypeName   string
		Kind           model.Kind
		Labels         model.Strings
		Score          *float64
		Result         *string
		CriticalFailed bool
		QAName         *string
		CompletedAt    *time.Time
		AckStatus      string
		AckComment     string
		Resolution     string
		Scorecard      scorecard.Card
		Answers        scorecard.Answers
	}
	if err := db.Table("tasks t").
		Select(`t.employee_id, e.name AS employee_name, t.external_id, t.order_numbers, t.work_date, tt.name AS task_type_name, t.kind, t.labels,
		        t.score, t.result, t.critical_failed, ev.name AS qa_name, t.completed_at, t.ack_status, t.ack_comment,
		        t.dispute_resolution AS resolution, t.scorecard, t.answers`).
		Joins("JOIN task_types tt ON tt.id = t.task_type_id").
		Joins("JOIN users e ON e.id = t.employee_id").
		Joins("LEFT JOIN users ev ON ev.id = t.evaluated_by").
		Where("t.state = 'completed' AND t.kind IN "+model.CountedKinds+" AND t.work_date BETWEEN ? AND ? AND t.employee_id IN ?", from, to, ids).
		Order("e.name, t.work_date, t.completed_at").Scan(&audits).Error; err != nil {
		dbError(w, err)
		return
	}
	var escalations []taskRow
	if err := s.taskRows(r).Where("t.kind IN "+model.ReviewedKinds+" AND t.work_date BETWEEN ? AND ? AND t.employee_id IN ?", from, to, ids).
		Order("e.name, t.created_at").Scan(&escalations).Error; err != nil {
		dbError(w, err)
		return
	}
	var coachings []coachingRow
	if err := db.Table("coachings c").
		Select("c.*, e.name AS employee_name, q.name AS qa_name, cb.name AS created_by_name").
		Joins("JOIN users e ON e.id = c.employee_id").
		Joins("JOIN users q ON q.id = c.assigned_qa_id").
		Joins("LEFT JOIN users cb ON cb.id = c.created_by").
		Where("c.employee_id IN ? AND (coalesce(c.completed_at, c.created_at) AT TIME ZONE ?)::date BETWEEN ? AND ?", ids, tz.String(), from, to).
		Order("e.name, coalesce(c.completed_at, c.created_at)").Scan(&coachings).Error; err != nil {
		dbError(w, err)
		return
	}

	// Per-agent tallies the summary needs beyond the directory's.
	type tally struct {
		borderline, fail, critical, disputed, unacked, negatives, tl, qa, coaching int
		cards                                                                      []cardAnswers
	}
	per := map[uuid.UUID]*tally{}
	get := func(id uuid.UUID) *tally {
		if per[id] == nil {
			per[id] = &tally{}
		}
		return per[id]
	}
	for _, a := range audits {
		t := get(a.EmployeeID)
		switch deref(a.Result) {
		case "borderline":
			t.borderline++
		case "fail":
			t.fail++
		}
		if a.CriticalFailed {
			t.critical++
		}
		switch a.AckStatus {
		case "disputed", "dispute_qa":
			t.disputed++
		case "":
			t.unacked++
		}
		t.cards = append(t.cards, cardAnswers{a.Scorecard, a.Answers})
	}
	for _, e := range escalations {
		if e.State != model.StateCompleted {
			continue
		}
		t := get(e.EmployeeID)
		switch e.Kind {
		case model.KindNegative:
			t.negatives++
		case model.KindTLEscalation:
			t.tl++
		case model.KindQAEscalation:
			t.qa++
		}
	}
	for _, c := range coachings {
		get(c.EmployeeID).coaching++
	}

	f := excelize.NewFile()
	defer f.Close()
	bold, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}, Fill: excelize.Fill{Type: "pattern", Color: []string{"EEF0F4"}, Pattern: 1}})
	period := fmt.Sprintf("%s to %s", from, to)

	sum := newSheet(f, "Summary", bold, []col{
		{"Agent", 26}, {"Alias", 18}, {"Team", 18}, {"HR department", 20}, {"Job title", 22}, {"Supervisor", 20},
		{"Audits", 9}, {"Average score %", 15}, {"Pass rate %", 12}, {"Borderline", 11}, {"Fail", 8}, {"Critical fails", 13},
		{"Disputed", 10}, {"Not acknowledged", 16}, {"Valid negatives", 15}, {"Valid TL escalations", 19},
		{"Valid QA escalations", 19}, {"Coaching sessions", 17}, {"Period", 24},
	})
	var profiles []struct {
		ID         uuid.UUID
		Supervisor string
	}
	db.Raw("SELECT id, coalesce(profile->>'supervisor', '') AS supervisor FROM users WHERE id IN ?", ids).Scan(&profiles)
	sup := map[uuid.UUID]string{}
	for _, p := range profiles {
		sup[p.ID] = p.Supervisor
	}
	for _, a := range agents {
		t := get(a.ID)
		sum.add(a.Name, a.AliasName, a.Team, a.HRDepartment, a.JobTitle, sup[a.ID],
			a.Evaluations, num(a.AvgScore), num(a.PassRate), t.borderline, t.fail, t.critical,
			t.disputed, t.unacked, t.negatives, t.tl, t.qa, t.coaching, period)
	}

	aud := newSheet(f, "Audits", bold, []col{
		{"Agent", 26}, {"Worked", 12}, {"Task type", 20}, {"Kind", 12}, {"Interaction / ticket ID", 38}, {"Order numbers", 24}, {"Code / tag", 24},
		{"Score %", 9}, {"Result", 11}, {"Critical fail", 12}, {"QA agent", 20}, {"Submitted", 18},
		{"Agent's answer", 16}, {"Agent's comment", 40}, {"Dispute answer", 40},
	})
	ans := newSheet(f, "Audit answers", bold, []col{
		{"Agent", 26}, {"Worked", 12}, {"Interaction / ticket ID", 38}, {"Metric", 44}, {"Answer", 16},
		{"Points earned", 13}, {"Points possible", 14}, {"Notes", 50},
	})
	for _, a := range audits {
		aud.add(a.EmployeeName, a.WorkDate.Format(time.DateOnly), a.TaskTypeName, string(a.Kind), a.ExternalID, strings.Join(a.OrderNumbers, ", "), strings.Join(a.Labels, ", "),
			num(a.Score), deref(a.Result), yes(a.CriticalFailed), deref(a.QAName), stamp(a.CompletedAt, tz),
			ackLabel(a.AckStatus), a.AckComment, a.Resolution)
		answers := map[string]scorecard.Answer{}
		for _, x := range a.Answers {
			answers[x.MetricID] = x
		}
		for _, m := range a.Scorecard {
			x := answers[m.ID]
			if m.Type == scorecard.Text {
				ans.add(a.EmployeeName, a.WorkDate.Format(time.DateOnly), a.ExternalID, m.Label, x.Value, "", "", x.Notes)
				continue
			}
			earned, possible, na, err := scorecard.MetricPoints(m, x.Value)
			switch {
			case err != nil:
				ans.add(a.EmployeeName, a.WorkDate.Format(time.DateOnly), a.ExternalID, m.Label, x.Value, "", "", x.Notes)
			case na:
				ans.add(a.EmployeeName, a.WorkDate.Format(time.DateOnly), a.ExternalID, m.Label, "N/A", "", "", x.Notes)
			default:
				ans.add(a.EmployeeName, a.WorkDate.Format(time.DateOnly), a.ExternalID, m.Label, x.Value, earned, possible, x.Notes)
			}
		}
	}

	met := newSheet(f, "Metrics", bold, []col{
		{"Agent", 26}, {"Metric", 44}, {"Points earned %", 15}, {"Answered", 10}, {"Earned nothing", 15}, {"N/A", 7},
	})
	for _, a := range agents {
		for _, m := range metricStats(get(a.ID).cards) {
			met.add(a.Name, m.Label, num(m.AvgPct), m.Answered, m.Zero, m.NA)
		}
	}

	esc := newSheet(f, "Escalations", bold, []col{
		{"Agent", 26}, {"Raised", 18}, {"Source", 16}, {"Order / call", 30}, {"What happened", 50}, {"Raised by", 20},
		{"Status", 12}, {"Checked by", 20}, {"Finding", 50},
	})
	source := map[model.Kind]string{model.KindNegative: "Negative", model.KindTLEscalation: "Team leader", model.KindQAEscalation: "QA"}
	status := map[model.TaskState]string{model.StateReview: "to check", model.StateCompleted: "valid", model.StateCancelled: "not valid"}
	for _, e := range escalations {
		st := status[e.State]
		if st == "" {
			st = string(e.State)
		}
		esc.add(e.EmployeeName, e.CreatedAt.In(tz).Format("2006-01-02 15:04"), source[e.Kind], e.ExternalID, e.Note, e.ReportedBy,
			st, deref(e.QAName), e.Finding)
	}

	coa := newSheet(f, "Coaching", bold, []col{
		{"Agent", 26}, {"Date", 18}, {"Type", 11}, {"Topic", 30}, {"QA agent", 20}, {"Status", 10}, {"Logged by QA", 13},
		{"Linked audits", 13}, {"What was covered", 50}, {"Outcome", 40}, {"Acknowledged", 18},
	})
	for _, c := range coachings {
		when := c.CompletedAt
		if when == nil {
			when = &c.CreatedAt
		}
		ack := stamp(c.AckAt, tz)
		if c.Logged {
			ack = "not needed"
		}
		coa.add(c.EmployeeName, stamp(when, tz), c.Kind, c.Topic, c.QAName, c.Status, yes(c.Logged), len(c.TaskIDs), c.Notes, c.Outcome, ack)
	}

	f.DeleteSheet("Sheet1")
	f.SetActiveSheet(0)
	name := fmt.Sprintf("QA report %s.xlsx", period)
	if len(agents) == 1 {
		name = fmt.Sprintf("%s %s.xlsx", agents[0].Name, period)
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	if err := f.Write(w); err != nil {
		log.Printf("export: %v", err) // the headers are sent; nothing else to tell the client
	}
}

type col struct {
	title string
	width float64
}

// xsheet appends rows to one sheet, under a bold, frozen header.
type xsheet struct {
	f    *excelize.File
	name string
	row  int
}

func newSheet(f *excelize.File, name string, header int, cols []col) *xsheet {
	f.NewSheet(name)
	titles := make([]any, len(cols))
	for i, c := range cols {
		titles[i] = c.title
		letter, _ := excelize.ColumnNumberToName(i + 1)
		f.SetColWidth(name, letter, letter, c.width)
	}
	f.SetSheetRow(name, "A1", &titles)
	last, _ := excelize.ColumnNumberToName(len(cols))
	f.SetCellStyle(name, "A1", last+"1", header)
	f.SetPanes(name, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})
	return &xsheet{f: f, name: name, row: 1}
}

func (s *xsheet) add(vals ...any) {
	s.row++
	s.f.SetSheetRow(s.name, fmt.Sprintf("A%d", s.row), &vals)
}

// num leaves a missing number as an empty cell.
func num(v *float64) any {
	if v == nil {
		return ""
	}
	return *v
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func yes(b bool) string {
	if b {
		return "yes"
	}
	return ""
}

func stamp(t *time.Time, tz *time.Location) string {
	if t == nil {
		return ""
	}
	return t.In(tz).Format("2006-01-02 15:04")
}

var ackLabels = map[string]string{
	"": "not acknowledged", "acknowledged": "acknowledged", "disputed": "disputed (supervisor)",
	"dispute_qa": "disputed (QA)", "upheld": "dispute: score kept", "changed": "dispute: score changed",
}

func ackLabel(s string) string { return ackLabels[s] }
