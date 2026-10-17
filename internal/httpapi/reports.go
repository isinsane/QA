package httpapi

import (
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
)

func (s *Server) routesReports(r chi.Router, managers func(http.Handler) http.Handler) {
	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)).Get("/reports", s.handleReports)
	r.With(managers).Get("/disputes/agents", s.handleDisputeAgents)
	r.With(managers).Get("/qa-productivity", s.handleQAProductivity)
	r.With(s.requireRoles(model.RoleEmployee)).Get("/me/summary", s.handleMySummary)
}

type disputeAgent struct {
	EmployeeID uuid.UUID `json:"employee_id"`
	Name       string    `json:"name"`
	Team       string    `json:"team"`
	Audits     int       `json:"audits"`
	Raised     int       `json:"raised"`
	Accepted   int       `json:"accepted"` // the score was changed
	Rejected   int       `json:"rejected"` // the score was kept
	Waiting    int       `json:"waiting"`
}

// handleDisputeAgents counts each agent's disputes on audits of work done in
// the period (from/to), most rejected first: who disputes often and is
// rarely right.
func (s *Server) handleDisputeAgents(w http.ResponseWriter, r *http.Request) {
	from, to := s.periodOf(r)
	raised := "t.ack_status IN ('disputed', 'dispute_qa', 'upheld', 'changed')"
	q := s.db.WithContext(r.Context()).Table("tasks t").
		Select(`e.id AS employee_id, e.name, coalesce(d.name, '') AS team, count(*) AS audits,
		        count(*) FILTER (WHERE `+raised+`) AS raised,
		        count(*) FILTER (WHERE t.ack_status = 'changed') AS accepted,
		        count(*) FILTER (WHERE t.ack_status = 'upheld') AS rejected,
		        count(*) FILTER (WHERE t.ack_status IN ('disputed', 'dispute_qa')) AS waiting`).
		Joins("JOIN task_types tt ON tt.id = t.task_type_id").
		Joins("JOIN users e ON e.id = t.employee_id").
		Joins("LEFT JOIN departments d ON d.id = e.department_id").
		Where("t.state = 'completed' AND t.kind IN "+model.CountedKinds+" AND t.work_date BETWEEN ? AND ?", from, to).
		Group("e.id, e.name, d.name").Having("count(*) FILTER (WHERE " + raised + ") > 0").
		Order("rejected DESC, raised DESC, e.name")
	if d := deptScope(me(r)); d != nil {
		q = q.Where("tt.department_id = ?", *d)
	}
	rows := []disputeAgent{}
	if err := q.Scan(&rows).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"from": from, "to": to, "agents": rows})
}

type weekStat struct {
	Week        model.Date `json:"week"`
	Evaluations int        `json:"evaluations"`
	AvgScore    *float64   `json:"avg_score"`
}

func (s *Server) weeklyTrend(r *http.Request, done string, args []any) []weekStat {
	var out []weekStat
	s.db.WithContext(r.Context()).Raw(`SELECT date_trunc('week', t.work_date)::date AS week, count(*) AS evaluations,
	        round(avg(t.score), 1) AS avg_score`+done+` GROUP BY 1 ORDER BY 1`, args...).Scan(&out)
	return out
}

// handleMySummary is what the agent's profile needs beyond /me: their team.
func (s *Server) handleMySummary(w http.ResponseWriter, r *http.Request) {
	var team string
	if d := me(r).DepartmentID; d != nil {
		s.db.WithContext(r.Context()).Raw("SELECT name FROM departments WHERE id = ?", *d).Scan(&team)
	}
	writeJSON(w, http.StatusOK, map[string]any{"team": team})
}

// handleReports answers the whole dashboard in one round trip, filtered by
// work date range, task type and employee, and scoped to the caller's
// department. One agent's numbers (employee_id) are open across teams, to QA
// agents too: that is the agent's analysis page.
func (s *Server) handleReports(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query()
	scope := deptScope(me(r))
	if p.Get("employee_id") != "" && me(r).Role != model.RoleTeamLeader { // team leaders: their team only
		scope = nil
	} else if me(r).Role == model.RoleQA {
		writeError(w, http.StatusForbidden, "pick an agent")
		return
	}
	from, to := p.Get("from"), p.Get("to")
	tz := s.cfg(r).TZ()
	if from == "" {
		from = time.Now().In(tz).AddDate(0, 0, -30).Format(time.DateOnly)
	}
	if to == "" {
		to = time.Now().In(tz).Format(time.DateOnly)
	}

	conds := []string{"t.work_date BETWEEN ? AND ?"}
	args := []any{from, to}
	if scope != nil {
		conds, args = append(conds, "tt.department_id = ?"), append(args, *scope)
	}
	if v := p.Get("task_type_id"); v != "" {
		conds, args = append(conds, "t.task_type_id = ?"), append(args, v)
	}
	if v := p.Get("employee_id"); v != "" {
		conds, args = append(conds, "t.employee_id = ?"), append(args, v)
	}
	base := " FROM tasks t JOIN task_types tt ON tt.id = t.task_type_id WHERE " + strings.Join(conds, " AND ")
	// Scores come only from the kinds that count (sample, live, escalation);
	// QA activity counts every evaluation a QA agent did.
	allDone := base + " AND t.state = 'completed'"
	done := allDone + " AND t.kind IN " + model.CountedKinds
	db := s.db.WithContext(r.Context())
	out := map[string]any{"from": from, "to": to}

	var totals struct {
		Evaluations    int      `json:"evaluations"`
		AvgScore       *float64 `json:"avg_score"`
		PassRate       *float64 `json:"pass_rate"`
		BorderlineRate *float64 `json:"borderline_rate"`
		FailRate       *float64 `json:"fail_rate"`
		CriticalFails  int      `json:"critical_fails"`
		Unacknowledged int      `json:"unacknowledged"`
		Disputed       int      `json:"disputed"`
	}
	db.Raw(`SELECT count(*) AS evaluations, round(avg(t.score), 1) AS avg_score,
	        round(100.0 * avg(CASE WHEN t.result = 'pass' THEN 1 ELSE 0 END), 1) AS pass_rate,
	        round(100.0 * avg(CASE WHEN t.result = 'borderline' THEN 1 ELSE 0 END), 1) AS borderline_rate,
	        round(100.0 * avg(CASE WHEN t.result = 'fail' THEN 1 ELSE 0 END), 1) AS fail_rate,
	        count(*) FILTER (WHERE t.critical_failed) AS critical_fails,
	        count(*) FILTER (WHERE t.ack_status = '' AND t.revealed_at IS NOT NULL) AS unacknowledged,
	        count(*) FILTER (WHERE t.ack_status IN ('disputed', 'dispute_qa')) AS disputed`+done, args...).Scan(&totals)
	out["totals"] = totals

	var kinds []struct {
		Kind        model.Kind `json:"kind"`
		Evaluations int        `json:"evaluations"`
		Open        int        `json:"open"`
		Flagged     int        `json:"flagged"` // live audits with no matching call
	}
	db.Raw(`SELECT t.kind, count(*) FILTER (WHERE t.state = 'completed') AS evaluations,
	        count(*) FILTER (WHERE t.state IN ('review', 'ready', 'assigned')) AS open,
	        count(*) FILTER (WHERE t.match_status = 'flagged') AS flagged`+base+
		` AND t.kind <> 'sample' GROUP BY 1 ORDER BY 1`, args...).Scan(&kinds)
	out["kinds"] = kinds

	var queue []struct {
		TaskTypeID   uuid.UUID `json:"task_type_id"`
		TaskTypeName string    `json:"task_type_name"`
		Imported     int       `json:"imported"`
		Unsampled    int       `json:"unsampled"`
		Ready        int       `json:"ready"`
		Assigned     int       `json:"assigned"`
		Completed    int       `json:"completed"`
		Cancelled    int       `json:"cancelled"`
	}
	db.Raw(`SELECT tt.id AS task_type_id, tt.name AS task_type_name, count(*) AS imported,
	        count(*) FILTER (WHERE t.state = 'unsampled') AS unsampled,
	        count(*) FILTER (WHERE t.state = 'ready') AS ready,
	        count(*) FILTER (WHERE t.state = 'assigned') AS assigned,
	        count(*) FILTER (WHERE t.state = 'completed') AS completed,
	        count(*) FILTER (WHERE t.state = 'cancelled') AS cancelled`+base+
		` AND t.kind <> 'rotation' AND t.kind NOT IN `+model.ReviewedKinds+` GROUP BY tt.id, tt.name ORDER BY tt.name`, args...).Scan(&queue)
	out["queue"] = queue

	var employees []struct {
		EmployeeID     uuid.UUID `json:"employee_id"`
		Name           string    `json:"name"`
		Evaluations    int       `json:"evaluations"`
		AvgScore       *float64  `json:"avg_score"`
		PassRate       *float64  `json:"pass_rate"`
		BorderlineRate *float64  `json:"borderline_rate"`
		CriticalFails  int       `json:"critical_fails"`
	}
	db.Raw(`SELECT e.id AS employee_id, e.name, count(*) AS evaluations, round(avg(t.score), 1) AS avg_score,
	        round(100.0 * avg(CASE WHEN t.result = 'pass' THEN 1 ELSE 0 END), 1) AS pass_rate,
	        round(100.0 * avg(CASE WHEN t.result = 'borderline' THEN 1 ELSE 0 END), 1) AS borderline_rate,
	        count(*) FILTER (WHERE t.critical_failed) AS critical_fails`+
		strings.Replace(done, " WHERE ", " JOIN users e ON e.id = t.employee_id WHERE ", 1)+
		` GROUP BY e.id, e.name ORDER BY avg(t.score) NULLS LAST, e.name`, args...).Scan(&employees)
	out["employees"] = employees

	out["trend"] = s.weeklyTrend(r, done, args)

	var byLabel []struct {
		Label       string   `json:"label"`
		Evaluations int      `json:"evaluations"`
		AvgScore    *float64 `json:"avg_score"`
	}
	db.Raw(`SELECT l AS label, count(*) AS evaluations, round(avg(t.score), 1) AS avg_score`+
		strings.Replace(done, " WHERE ", ", jsonb_array_elements_text(t.labels) AS l WHERE ", 1)+
		` GROUP BY l ORDER BY count(*) DESC`, args...).Scan(&byLabel)
	out["by_label"] = byLabel

	var activity []struct {
		QAName      string     `json:"qa_name"`
		Day         model.Date `json:"day"`
		Evaluations int        `json:"evaluations"`
	}
	db.Raw(`SELECT q.name AS qa_name, (t.completed_at AT TIME ZONE ?)::date AS day, count(*) AS evaluations`+
		strings.Replace(allDone, " WHERE ", " JOIN users q ON q.id = t.evaluated_by WHERE ", 1)+
		` GROUP BY 1, 2 ORDER BY 2, 1`, append([]any{tz.String()}, args...)...).Scan(&activity)
	out["qa_activity"] = activity

	var failed []taskRow
	q := s.taskRows(r).Where("t.state = 'completed' AND t.result = 'fail' AND t.kind IN "+model.CountedKinds+
		" AND t.work_date BETWEEN ? AND ?", from, to)
	if scope != nil {
		q = q.Where("tt.department_id = ?", *scope)
	}
	if v := p.Get("task_type_id"); v != "" {
		q = q.Where("t.task_type_id = ?", v)
	}
	if v := p.Get("employee_id"); v != "" {
		q = q.Where("t.employee_id = ?", v)
	}
	q.Order("t.score, t.work_date DESC").Limit(100).Scan(&failed)
	out["failed"] = failed
	forQA(me(r), failed)

	out["metrics"] = s.metricBreakdown(r, done, args)
	out["calibration"] = s.calibration(r, base, args)
	if me(r).Role == model.RoleQA { // who audited and calibration are the supervisor's to know
		out["qa_activity"], out["calibration"] = []any{}, map[string]any{"pairs": []any{}, "qa": []any{}}
	}
	writeJSON(w, http.StatusOK, out)
}

type rotationPair struct {
	CaseID       uuid.UUID  `json:"case_id"`
	ExternalID   string     `json:"external_id"`
	TaskTypeName string     `json:"task_type_name"`
	EmployeeName string     `json:"employee_name"`
	WorkDate     model.Date `json:"work_date"`
	FirstQA      string     `json:"first_qa"`
	FirstScore   *float64   `json:"first_score"`
	SecondQA     string     `json:"second_qa"`
	SecondScore  *float64   `json:"second_score"`
	Gap          *float64   `json:"gap"`
}

type qaVariance struct {
	QAName  string  `json:"qa_name"`
	Reviews int     `json:"reviews"`
	AvgGap  float64 `json:"avg_gap"`  // average distance from the colleague's score
	AvgLean float64 `json:"avg_lean"` // + more lenient, - stricter than the colleague
}

// calibration is the QA-over-QA report: each rotation case scored by two QA
// agents, and how far each QA agent tends to land from their colleagues.
func (s *Server) calibration(r *http.Request, base string, args []any) map[string]any {
	joins := ` JOIN tasks b ON b.rotation_of = t.id AND b.state = 'completed'
		JOIN users e ON e.id = t.employee_id
		JOIN users q1 ON q1.id = t.evaluated_by
		JOIN users q2 ON q2.id = b.evaluated_by WHERE `
	var pairs []rotationPair
	s.db.WithContext(r.Context()).Raw(`
		SELECT t.id AS case_id, t.external_id, tt.name AS task_type_name, e.name AS employee_name, t.work_date,
		       q1.name AS first_qa, t.score AS first_score, q2.name AS second_qa, b.score AS second_score,
		       round(abs(t.score - b.score), 1) AS gap`+strings.Replace(base, " WHERE ", joins, 1)+
		` AND t.kind = 'rotation' AND t.state = 'completed' ORDER BY gap DESC NULLS LAST, t.work_date DESC LIMIT 200`, args...).Scan(&pairs)

	per := map[string]*qaVariance{}
	add := func(name string, mine, theirs *float64) {
		if mine == nil || theirs == nil {
			return
		}
		v := per[name]
		if v == nil {
			v = &qaVariance{QAName: name}
			per[name] = v
		}
		v.Reviews++
		v.AvgGap += math.Abs(*mine - *theirs)
		v.AvgLean += *mine - *theirs
	}
	for _, p := range pairs {
		add(p.FirstQA, p.FirstScore, p.SecondScore)
		add(p.SecondQA, p.SecondScore, p.FirstScore)
	}
	qas := make([]*qaVariance, 0, len(per))
	for _, v := range per {
		v.AvgGap = math.Round(v.AvgGap/float64(v.Reviews)*10) / 10
		v.AvgLean = math.Round(v.AvgLean/float64(v.Reviews)*10) / 10
		qas = append(qas, v)
	}
	sort.Slice(qas, func(i, j int) bool { return qas[i].AvgGap > qas[j].AvgGap })
	return map[string]any{"pairs": pairs, "qa": qas}
}

type metricStat struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Type     string   `json:"type"`
	Answered int      `json:"answered"`
	NA       int      `json:"na"`
	Zero     int      `json:"zero"` // answers that earned nothing (a "No")
	AvgPct   *float64 `json:"avg_pct"`
	earned   float64
	possible float64
}

// metricBreakdown scores each metric across evaluations from their own
// scorecard snapshots, so metrics renamed since still group by id.
func (s *Server) metricBreakdown(r *http.Request, done string, args []any) []*metricStat {
	var rows []cardAnswers
	s.db.WithContext(r.Context()).Raw(`SELECT t.scorecard, t.answers`+done, args...).Scan(&rows)
	return metricStats(rows)
}

type cardAnswers struct {
	Scorecard scorecard.Card
	Answers   scorecard.Answers
}

// metricStats adds up each metric over evaluations, weakest first.
func metricStats(rows []cardAnswers) []*metricStat {
	stats := map[string]*metricStat{}
	var order []string
	for _, row := range rows {
		values := map[string]string{}
		for _, a := range row.Answers {
			values[a.MetricID] = a.Value
		}
		for _, m := range row.Scorecard {
			if m.Type == scorecard.Text {
				continue
			}
			st := stats[m.ID]
			if st == nil {
				st = &metricStat{ID: m.ID, Type: m.Type}
				stats[m.ID] = st
				order = append(order, m.ID)
			}
			st.Label = m.Label
			earned, possible, na, err := scorecard.MetricPoints(m, values[m.ID])
			switch {
			case err != nil:
				continue
			case na:
				st.NA++
				continue
			}
			st.Answered++
			st.earned += earned
			st.possible += possible
			if earned == 0 {
				st.Zero++
			}
		}
	}
	out := make([]*metricStat, 0, len(order))
	for _, id := range order {
		st := stats[id]
		if st.possible > 0 {
			pct := float64(int(st.earned/st.possible*1000+0.5)) / 10
			st.AvgPct = &pct
		}
		out = append(out, st)
	}
	// Weakest first: that is what a supervisor coaches on.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].AvgPct, out[j].AvgPct
		return a != nil && (b == nil || *a < *b)
	})
	return out
}
