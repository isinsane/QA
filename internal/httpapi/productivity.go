package httpapi

import (
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/model"
)

// qaEvents is everything a QA agent did, one row per action, in local time
// (tz): audits submitted (any kind but escalations), interactions they
// couldn't audit, escalations they checked, and coaching sessions they held.
// typ is the kind of work: sample, live, escalation, focus, rotation (audits),
// checked, cant or coaching.
const qaEvents = `WITH ev AS (
	SELECT t.evaluated_by AS qa_id, coalesce(t.submitted_at, t.completed_at) AS at, 'audit' AS what,
	       t.kind, t.score, t.result, t.critical_failed, t.ack_status, tt.department_id,
	       t.id AS task_id, NULL::uuid AS coaching_id, t.employee_id, tt.name AS type_name, '' AS note
	FROM tasks t JOIN task_types tt ON tt.id = t.task_type_id
	WHERE t.evaluated_by IS NOT NULL AND t.kind NOT IN ` + model.ReviewedKinds + ` AND coalesce(t.submitted_at, t.completed_at) IS NOT NULL
	UNION ALL
	SELECT a.actor_id, a.created_at, CASE WHEN a.action = 'cant_audit' THEN 'cant' ELSE 'checked' END,
	       t.kind, NULL, NULL, false, '', tt.department_id,
	       t.id, NULL, t.employee_id, tt.name,
	       CASE WHEN a.action = 'cant_audit' THEN coalesce(a.detail->>'reason', '')
	            WHEN a.action LIKE '%\_confirmed' THEN 'valid' ELSE 'not valid' END
	FROM audit_logs a JOIN tasks t ON t.id = a.task_id JOIN task_types tt ON tt.id = t.task_type_id
	WHERE a.action = 'cant_audit' OR a.action LIKE '%\_confirmed' OR a.action LIKE '%\_dismissed'
	UNION ALL
	SELECT c.assigned_qa_id, c.completed_at, 'coaching', '', NULL, NULL, false, '', c.department_id,
	       NULL, c.id, c.employee_id, '', c.topic
	FROM coachings c WHERE c.status = 'done' AND c.completed_at IS NOT NULL
), e AS (
	SELECT ev.*, CASE WHEN ev.what = 'audit' THEN ev.kind ELSE ev.what END AS typ, ev.at AT TIME ZONE @tz AS local
	FROM ev JOIN users q ON q.id = ev.qa_id AND q.role = 'qa_agent'
	WHERE (ev.at AT TIME ZONE @tz)::date BETWEEN @from AND @to AND (CAST(@dept AS uuid) IS NULL OR ev.department_id = CAST(@dept AS uuid))
)
`

type qaProd struct {
	QAID        uuid.UUID  `json:"qa_id"`
	Name        string     `json:"name"`
	Team        string     `json:"team"`
	Active      bool       `json:"active"`
	Online      bool       `json:"online"`
	InQueue     int        `json:"in_queue"` // assigned to them now
	Audits      int        `json:"audits"`
	Sample      int        `json:"sample"`
	Live        int        `json:"live"`
	Escalation  int        `json:"escalation"`
	Focus       int        `json:"focus"`
	Rotation    int        `json:"rotation"`
	AvgScore    *float64   `json:"avg_score"` // the scores they gave
	Pass        int        `json:"pass"`
	Borderline  int        `json:"borderline"`
	Fail        int        `json:"fail"`
	Critical    int        `json:"critical"`
	CantAudit   int        `json:"cant_audit"`
	Checked     int        `json:"checked"` // escalations decided
	Coaching    int        `json:"coaching"`
	Disputed    int        `json:"disputed"`      // their audits the agent disputed
	ScoreChange int        `json:"score_changed"` // of those, the score was changed
	ActiveHours int        `json:"active_hours"`  // hours with any action
	First       *time.Time `json:"first"`         // local time, as a wall clock
	Last        *time.Time `json:"last"`
}

// qaBucket is one QA agent's work in one hour / day / week / month, by kind.
type qaBucket struct {
	QAID       uuid.UUID `json:"qa_id"`
	Bucket     string    `json:"bucket"` // local, YYYY-MM-DDTHH:MI
	Sample     int       `json:"sample"`
	Live       int       `json:"live"`
	Escalation int       `json:"escalation"`
	Focus      int       `json:"focus"`
	Rotation   int       `json:"rotation"`
	Checked    int       `json:"checked"`
	Cant       int       `json:"cant"`
	Coaching   int       `json:"coaching"`
}

// prodArgs are the query's arguments: the period, its timezone and the
// caller's team (NULL: every team).
func (s *Server) prodArgs(r *http.Request, from, to string) map[string]any {
	tz := s.cfg(r).BusinessTimezone
	if tz == "" {
		tz = "UTC"
	}
	var dept any
	if d := deptScope(me(r)); d != nil {
		dept = *d
	}
	return map[string]any{"tz": tz, "from": from, "to": to, "dept": dept}
}

// handleQAProductivity answers the QA productivity page: per QA agent, what
// they did in the period (from/to, by when they did it), and the same by
// hour, day, week or month (by), by kind of work.
func (s *Server) handleQAProductivity(w http.ResponseWriter, r *http.Request) {
	from, to := s.periodOf(r)
	by := r.URL.Query().Get("by")
	if by != "hour" && by != "week" && by != "month" {
		by = "day"
	}
	args := s.prodArgs(r, from, to)
	args["by"] = by
	db := s.db.WithContext(r.Context())

	var qas []qaProd
	q := db.Table("users q").Select(`q.id AS qa_id, q.name, coalesce(d.name, '') AS team, q.active, q.is_available AS online,
	        (SELECT count(*) FROM tasks t WHERE t.assigned_qa_id = q.id AND t.state = 'assigned') AS in_queue`).
		Joins("LEFT JOIN departments d ON d.id = q.department_id").Where("q.role = 'qa_agent'").Order("q.name")
	if d := deptScope(me(r)); d != nil {
		q = q.Where("q.department_id = ?", *d)
	}
	if err := q.Scan(&qas).Error; err != nil {
		dbError(w, err)
		return
	}

	var sums []qaProd
	if err := db.Raw(qaEvents+`SELECT qa_id,
	        count(*) FILTER (WHERE what = 'audit') AS audits,
	        count(*) FILTER (WHERE typ = 'sample') AS sample,
	        count(*) FILTER (WHERE typ = 'live') AS live,
	        count(*) FILTER (WHERE typ = 'escalation') AS escalation,
	        count(*) FILTER (WHERE typ = 'focus') AS focus,
	        count(*) FILTER (WHERE typ = 'rotation') AS rotation,
	        round(avg(score) FILTER (WHERE what = 'audit'), 1) AS avg_score,
	        count(*) FILTER (WHERE result = 'pass') AS pass,
	        count(*) FILTER (WHERE result = 'borderline') AS borderline,
	        count(*) FILTER (WHERE result = 'fail') AS fail,
	        count(*) FILTER (WHERE what = 'audit' AND critical_failed) AS critical,
	        count(*) FILTER (WHERE typ = 'cant') AS cant_audit,
	        count(*) FILTER (WHERE typ = 'checked') AS checked,
	        count(*) FILTER (WHERE typ = 'coaching') AS coaching,
	        count(*) FILTER (WHERE ack_status IN ('disputed', 'dispute_qa', 'upheld', 'changed')) AS disputed,
	        count(*) FILTER (WHERE ack_status = 'changed') AS score_change,
	        count(DISTINCT date_trunc('hour', local)) AS active_hours,
	        min(local) AS first, max(local) AS last
	        FROM e GROUP BY qa_id`, args).Scan(&sums).Error; err != nil {
		dbError(w, err)
		return
	}

	series := []qaBucket{}
	if err := db.Raw(qaEvents+`SELECT qa_id, to_char(date_trunc(@by, local), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
	        count(*) FILTER (WHERE typ = 'sample') AS sample,
	        count(*) FILTER (WHERE typ = 'live') AS live,
	        count(*) FILTER (WHERE typ = 'escalation') AS escalation,
	        count(*) FILTER (WHERE typ = 'focus') AS focus,
	        count(*) FILTER (WHERE typ = 'rotation') AS rotation,
	        count(*) FILTER (WHERE typ = 'checked') AS checked,
	        count(*) FILTER (WHERE typ = 'cant') AS cant,
	        count(*) FILTER (WHERE typ = 'coaching') AS coaching
	        FROM e GROUP BY 1, 2 ORDER BY 2`, args).Scan(&series).Error; err != nil {
		dbError(w, err)
		return
	}

	// Every QA agent in scope, and anyone since deactivated who did something.
	byID := map[uuid.UUID]qaProd{}
	for _, s := range sums {
		byID[s.QAID] = s
	}
	out := []qaProd{}
	for _, a := range qas {
		s, did := byID[a.QAID]
		if !a.Active && !did {
			continue
		}
		s.QAID, s.Name, s.Team, s.Active, s.Online, s.InQueue = a.QAID, a.Name, a.Team, a.Active, a.Online, a.InQueue
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Audits > out[j].Audits })
	if me(r).Role == model.RoleQA {
		// The heat map only: who their teammates are and when they worked,
		// not their numbers; a rotation case reads as an ordinary audit.
		for i, a := range out {
			out[i] = qaProd{QAID: a.QAID, Name: a.Name, Team: a.Team, Active: a.Active, Online: a.Online}
		}
		for i := range series {
			series[i].Sample, series[i].Rotation = series[i].Sample+series[i].Rotation, 0
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"from": from, "to": to, "by": by, "agents": out, "series": series})
}

// handleQAWork lists what one QA agent did from start to end (local wall
// clock, end excluded): one heat map cell, item by item.
func (s *Server) handleQAWork(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query()
	qa, err := uuid.Parse(p.Get("qa_id"))
	start, err1 := time.Parse("2006-01-02T15:04", p.Get("start"))
	end, err2 := time.Parse("2006-01-02T15:04", p.Get("end"))
	if err != nil || err1 != nil || err2 != nil || !end.After(start) {
		writeError(w, http.StatusBadRequest, "qa_id, start and end (YYYY-MM-DDTHH:MI) are required")
		return
	}
	qaAgent := me(r).Role == model.RoleQA
	if qaAgent && qa != me(r).ID { // which audits a teammate did is the supervisor's to know
		writeError(w, http.StatusForbidden, "you can open only your own work")
		return
	}
	args := s.prodArgs(r, start.Format(time.DateOnly), end.Format(time.DateOnly))
	args["qa"], args["start"], args["end"] = qa, start.Format("2006-01-02 15:04"), end.Format("2006-01-02 15:04")
	out := []struct {
		At             string     `json:"at"` // local, YYYY-MM-DDTHH:MI
		Type           string     `json:"type"`
		TaskID         *uuid.UUID `json:"task_id"`
		CoachingID     *uuid.UUID `json:"coaching_id"`
		Agent          string     `json:"agent"`
		TypeName       string     `json:"type_name"`
		Score          *float64   `json:"score"`
		Result         *string    `json:"result"`
		CriticalFailed bool       `json:"critical_failed"`
		Note           string     `json:"note"`
	}{}
	if err := s.db.WithContext(r.Context()).Raw(qaEvents+`SELECT to_char(local, 'YYYY-MM-DD"T"HH24:MI') AS at, typ AS type,
	        task_id, coaching_id, coalesce(u.name, '') AS agent, type_name, score, result, critical_failed, note
	        FROM e LEFT JOIN users u ON u.id = e.employee_id
	        WHERE qa_id = @qa AND local >= CAST(@start AS timestamp) AND local < CAST(@end AS timestamp)
	        ORDER BY local LIMIT 500`, args).Scan(&out).Error; err != nil {
		dbError(w, err)
		return
	}
	for i := range out {
		if qaAgent && out[i].Type == string(model.KindRotation) {
			out[i].Type = string(model.KindSample)
		}
	}
	writeJSON(w, http.StatusOK, out)
}
