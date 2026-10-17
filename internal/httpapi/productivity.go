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
const qaEvents = `WITH ev AS (
	SELECT t.evaluated_by AS qa_id, coalesce(t.submitted_at, t.completed_at) AS at, 'audit' AS what,
	       t.kind, t.score, t.result, t.critical_failed, t.ack_status, tt.department_id
	FROM tasks t JOIN task_types tt ON tt.id = t.task_type_id
	WHERE t.evaluated_by IS NOT NULL AND t.kind NOT IN ` + model.ReviewedKinds + ` AND coalesce(t.submitted_at, t.completed_at) IS NOT NULL
	UNION ALL
	SELECT a.actor_id, a.created_at, CASE WHEN a.action = 'cant_audit' THEN 'cant' ELSE 'checked' END,
	       t.kind, NULL, NULL, false, '', tt.department_id
	FROM audit_logs a JOIN tasks t ON t.id = a.task_id JOIN task_types tt ON tt.id = t.task_type_id
	WHERE a.action = 'cant_audit' OR a.action LIKE '%\_confirmed' OR a.action LIKE '%\_dismissed'
	UNION ALL
	SELECT c.assigned_qa_id, c.completed_at, 'coaching', '', NULL, NULL, false, '', c.department_id
	FROM coachings c WHERE c.status = 'done' AND c.completed_at IS NOT NULL
), e AS (
	SELECT ev.*, ev.at AT TIME ZONE @tz AS local FROM ev JOIN users q ON q.id = ev.qa_id AND q.role = 'qa_agent'
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

type qaBucket struct {
	QAID   uuid.UUID `json:"qa_id"`
	Bucket string    `json:"bucket"` // local, YYYY-MM-DDTHH:MI
	Audits int       `json:"audits"`
	Other  int       `json:"other"` // can't audit, escalations checked, coaching
}

// handleQAProductivity answers the QA productivity page: per QA agent, what
// they did in the period (from/to, by when they did it), and the same counts
// by hour, day, week or month (by).
func (s *Server) handleQAProductivity(w http.ResponseWriter, r *http.Request) {
	from, to := s.periodOf(r)
	by := r.URL.Query().Get("by")
	if by != "hour" && by != "week" && by != "month" {
		by = "day"
	}
	tz := s.cfg(r).BusinessTimezone
	if tz == "" {
		tz = "UTC"
	}
	var dept any // NULL: every team
	if d := deptScope(me(r)); d != nil {
		dept = *d
	}
	args := map[string]any{"tz": tz, "from": from, "to": to, "dept": dept, "by": by}
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
	        count(*) FILTER (WHERE what = 'audit' AND kind = 'sample') AS sample,
	        count(*) FILTER (WHERE what = 'audit' AND kind = 'live') AS live,
	        count(*) FILTER (WHERE what = 'audit' AND kind = 'escalation') AS escalation,
	        count(*) FILTER (WHERE what = 'audit' AND kind = 'focus') AS focus,
	        count(*) FILTER (WHERE what = 'audit' AND kind = 'rotation') AS rotation,
	        round(avg(score) FILTER (WHERE what = 'audit'), 1) AS avg_score,
	        count(*) FILTER (WHERE result = 'pass') AS pass,
	        count(*) FILTER (WHERE result = 'borderline') AS borderline,
	        count(*) FILTER (WHERE result = 'fail') AS fail,
	        count(*) FILTER (WHERE what = 'audit' AND critical_failed) AS critical,
	        count(*) FILTER (WHERE what = 'cant') AS cant_audit,
	        count(*) FILTER (WHERE what = 'checked') AS checked,
	        count(*) FILTER (WHERE what = 'coaching') AS coaching,
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
	        count(*) FILTER (WHERE what = 'audit') AS audits, count(*) FILTER (WHERE what <> 'audit') AS other
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
	writeJSON(w, http.StatusOK, map[string]any{"from": from, "to": to, "by": by, "agents": out, "series": series})
}
