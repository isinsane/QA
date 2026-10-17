package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/edesk"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
)

func (s *Server) routesTasks(r chi.Router, managers func(http.Handler) http.Handler) {
	qa := s.requireRoles(model.RoleQA)
	r.With(qa).Get("/me/queue", s.handleMyQueue)
	r.With(qa).Patch("/me/availability", s.handleAvailability)
	r.With(s.requireRoles(model.RoleEmployee)).Get("/me/scores", s.handleMyScores)

	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)).Get("/tasks", s.handleListTasks)
	r.Get("/tasks/{id}", s.handleGetTask)
	r.Get("/tasks/{id}/edesk", s.handleTaskEDesk)
	r.Get("/tasks/{id}/chat", s.handleTaskChat)
	r.With(qa).Post("/tasks/{id}/submit", s.handleSubmit)
	r.With(qa).Post("/tasks/{id}/cant-audit", s.handleCantAudit)
	// QA agents too: the one who scored a dispute the supervisor sent them.
	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)).Put("/tasks/{id}/evaluation", s.handleEditEvaluation)
	r.With(managers).Post("/tasks/{id}/reassign", s.handleReassign)
	r.With(managers).Post("/tasks/bulk-reassign", s.handleBulkReassign)
	r.With(managers).Post("/tasks/{id}/cancel", s.handleCancel)

	// QA2: other ways an audit comes about, and the agent's answer to one.
	r.With(qa).Get("/team/agents", s.handleTeamAgents)
	r.With(qa).Post("/live", s.handleStartLive)
	r.With(qa).Get("/task-types/{id}/live-fields", s.handleLiveFields)
	r.With(qa).Patch("/tasks/{id}/live", s.handleLiveDetails)
	r.With(qa).Get("/focus/labels", s.handleFocusLabels)
	r.With(qa).Post("/focus", s.handleFocusPlan)
	r.With(managers).Post("/escalations", s.handleEscalate)
	employee := s.requireRoles(model.RoleEmployee)
	r.With(employee).Post("/tasks/{id}/acknowledge", s.handleAcknowledge)
	r.With(employee).Post("/tasks/{id}/dispute", s.handleDispute)
	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)).Post("/tasks/{id}/uphold", s.handleUphold)
	r.With(managers).Post("/tasks/{id}/dispute/forward", s.handleForwardDispute)
	r.With(qa).Get("/me/disputes", s.handleMyDisputes)
	r.With(managers).Get("/reveal", s.handleHidden)
	r.With(managers).Post("/reveal", s.handleReveal)
}

// agentKinds are the finished audits an agent sees, once revealed.
var agentKinds = "(t.kind IN " + model.CountedKinds + " OR t.kind IN " + model.ReviewedKinds + ")"

// handleHidden lists, per team in the caller's scope, the finished audits its
// agents don't see yet and when its scores were last revealed.
func (s *Server) handleHidden(w http.ResponseWriter, r *http.Request) {
	q := s.db.WithContext(r.Context()).Table("tasks t").
		Select(`d.id AS department_id, d.name AS team,
		        count(*) FILTER (WHERE t.revealed_at IS NULL) AS hidden, max(t.revealed_at) AS last_revealed`).
		Joins("JOIN task_types tt ON tt.id = t.task_type_id").
		Joins("JOIN departments d ON d.id = tt.department_id").
		Where("t.state = 'completed' AND " + agentKinds).
		Group("d.id, d.name").Order("d.name")
	if d := deptScope(me(r)); d != nil {
		q = q.Where("d.id = ?", *d)
	}
	type row struct {
		DepartmentID uuid.UUID  `json:"department_id"`
		Team         string     `json:"team"`
		Hidden       int        `json:"hidden"`
		LastRevealed *time.Time `json:"last_revealed"`
	}
	out := []row{}
	if err := q.Scan(&out).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleReveal shows a team's agents every finished audit they don't see yet.
func (s *Server) handleReveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DepartmentID uuid.UUID `json:"department_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if d := deptScope(me(r)); d != nil { // a supervisor: their own team
		in.DepartmentID = *d
	}
	if in.DepartmentID == uuid.Nil {
		writeError(w, http.StatusBadRequest, "pick a team")
		return
	}
	res := s.db.WithContext(r.Context()).Exec(`UPDATE tasks t SET revealed_at = now() FROM task_types tt
		WHERE tt.id = t.task_type_id AND tt.department_id = ? AND t.state = 'completed' AND t.revealed_at IS NULL AND `+agentKinds,
		in.DepartmentID)
	if res.Error != nil {
		dbError(w, res.Error)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revealed": res.RowsAffected})
}

// taskRow is a task with the names a list needs.
type taskRow struct {
	ID             uuid.UUID       `json:"id"`
	ExternalID     string          `json:"external_id"`
	WorkDate       model.Date      `json:"work_date"`
	State          model.TaskState `json:"state"`
	Labels         model.Strings   `json:"labels"`
	Score          *float64        `json:"score"`
	Passed         *bool           `json:"passed"`
	CriticalFailed bool            `json:"critical_failed"`
	CompletedAt    *time.Time      `json:"completed_at"`
	TaskTypeID     uuid.UUID       `json:"task_type_id"`
	TaskTypeName   string          `json:"task_type_name"`
	EmployeeID     uuid.UUID       `json:"employee_id"`
	EmployeeName   string          `json:"employee_name"`
	AssignedQAID   *uuid.UUID      `json:"assigned_qa_id"`
	QAName         *string         `json:"qa_name,omitempty"`
	Kind           model.Kind      `json:"kind"`
	Result         *string         `json:"result"`
	AckStatus      string          `json:"ack_status"`
	AckComment     string          `json:"ack_comment"`
	AckAt          *time.Time      `json:"ack_at"`
	Resolution     string          `json:"dispute_resolution"`
	Finding        string          `json:"finding"`
	OrderNumbers   model.Strings   `json:"order_numbers"`
	RevealedAt     *time.Time      `json:"revealed_at"`
	EvaluatedBy    *uuid.UUID      `json:"-"` // to tell a QA agent's own audits apart (forQA)
	MatchStatus    string          `json:"match_status"`
	Priority       int             `json:"priority"`
	Note           string          `json:"note"`
	ReportedBy     string          `json:"reported_by"`
	Source         string          `json:"source"`         // a TL / special process escalation's name, after the sender's job title
	ChangePending  bool            `json:"change_pending"` // a QA agent's score change waits for a supervisor
	CreatedAt      time.Time       `json:"created_at"`
}

func (s *Server) taskRows(r *http.Request) *gorm.DB {
	return s.db.WithContext(r.Context()).Table("tasks t").
		Select(`t.id, t.external_id, t.work_date, t.state, t.labels, t.score, t.passed, t.critical_failed,
		        t.completed_at, t.task_type_id, tt.name AS task_type_name, t.employee_id, e.name AS employee_name,
		        t.assigned_qa_id, coalesce(q.name, ev.name) AS qa_name,
		        t.kind, t.result, t.ack_status, t.ack_comment, t.ack_at, t.dispute_resolution AS resolution, t.finding, t.order_numbers, t.evaluated_by, t.revealed_at,
		        t.match_status, t.priority, t.note, coalesce(cb.name, '') AS reported_by, coalesce(t.data->>'source', '') AS source, t.created_at,
		        EXISTS (SELECT 1 FROM evaluation_changes ec WHERE ec.task_id = t.id AND ec.status = 'pending') AS change_pending`).
		Joins("JOIN task_types tt ON tt.id = t.task_type_id").
		Joins("JOIN users e ON e.id = t.employee_id").
		Joins("LEFT JOIN users q ON q.id = t.assigned_qa_id").
		Joins("LEFT JOIN users ev ON ev.id = t.evaluated_by").
		Joins("LEFT JOIN users cb ON cb.id = t.created_by")
}

// forQA keeps from a QA agent what only supervisors know: who audited (on
// anyone's audit but their own) and that an audit is a rotation case (QA
// over QA), which reads to them as an ordinary audit.
func forQA(u *model.User, rows []taskRow) {
	if u.Role != model.RoleQA {
		return
	}
	for i := range rows {
		if rows[i].Kind == model.KindRotation {
			rows[i].Kind = model.KindSample
		}
		own := rows[i].AssignedQAID != nil && *rows[i].AssignedQAID == u.ID || rows[i].EvaluatedBy != nil && *rows[i].EvaluatedBy == u.ID
		if !own {
			rows[i].QAName, rows[i].AssignedQAID = nil, nil
		}
	}
}

func (s *Server) handleMyQueue(w http.ResponseWriter, r *http.Request) {
	var out []taskRow
	err := s.taskRows(r).Where("t.state = 'assigned' AND t.assigned_qa_id = ?", me(r).ID).
		Order("t.priority DESC, t.queue_position").Scan(&out).Error
	if err != nil {
		dbError(w, err)
		return
	}
	forQA(me(r), out)
	writeJSON(w, http.StatusOK, out)
}

// handleMyDisputes lists the disputes the supervisor sent to this QA agent.
func (s *Server) handleMyDisputes(w http.ResponseWriter, r *http.Request) {
	var out []taskRow
	err := s.taskRows(r).Where("t.ack_status = 'dispute_qa' AND t.evaluated_by = ?", me(r).ID).
		Order("t.ack_at").Scan(&out).Error
	if err != nil {
		dbError(w, err)
		return
	}
	forQA(me(r), out)
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleAvailability(w http.ResponseWriter, r *http.Request) {
	var in struct{ Online bool }
	if !decode(w, r, &in) {
		return
	}
	u := me(r)
	if err := s.db.WithContext(r.Context()).Model(u).Update("is_available", in.Online).Error; err != nil {
		dbError(w, err)
		return
	}
	u.IsAvailable = in.Online
	s.runAssign(r.Context())
	writeJSON(w, http.StatusOK, view(*u))
}

func (s *Server) handleMyScores(w http.ResponseWriter, r *http.Request) {
	var rows []taskRow
	err := s.taskRows(r).Where("t.state = 'completed' AND t.revealed_at IS NOT NULL AND "+agentKinds+" AND t.employee_id = ?", me(r).ID).
		Order("t.work_date DESC, t.completed_at DESC").Limit(500).Scan(&rows).Error
	if err != nil {
		dbError(w, err)
		return
	}
	for i := range rows {
		// Employees do not see who audited them, ran a live audit or reported them.
		rows[i].QAName, rows[i].ReportedBy, rows[i].Source = nil, "", ""
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	q, u, p := s.taskRows(r), me(r), r.URL.Query()
	switch {
	case u.Role == model.RoleQA && p.Get("mine") == "1": // the audits they submitted (escalations they decided aren't audits)
		q = q.Where("t.evaluated_by = ? AND t.kind NOT IN "+model.ReviewedKinds, u.ID)
	case u.Role == model.RoleQA && p.Get("team") == "1": // every audit of their team (not rotation: QA over QA)
		q = q.Where("tt.department_id = ? AND t.kind NOT IN "+model.ReviewedKinds+" AND t.kind <> ?", u.DepartmentID, model.KindRotation)
	case u.Role == model.RoleTeamLeader: // their own team's, even on an agent's page
		q = q.Where("tt.department_id = ?", deptScope(u))
	case p.Get("employee_id") != "":
		// One agent's work: QA agents and supervisors see any agent's.
	case u.Role == model.RoleQA:
		writeError(w, http.StatusForbidden, "pick an agent")
		return
	case deptScope(u) != nil:
		q = q.Where("tt.department_id = ?", *deptScope(u))
	}
	switch st := p.Get("state"); st {
	case "":
		q = q.Where("t.state <> 'unsampled'")
	case "all":
	case "pass", "borderline", "fail":
		q = q.Where("t.state = 'completed' AND t.result = ?", st)
	case "disputed":
		q = q.Where("t.ack_status IN ('disputed', 'dispute_qa')")
	case "dispute_supervisor": // waiting for the supervisor
		q = q.Where("t.ack_status = 'disputed'")
	case "dispute_qa": // sent on to the QA agent who scored it
		q = q.Where("t.ack_status = 'dispute_qa'")
	case "open": // with QA: waiting or in a queue
		q = q.Where("t.state IN ('ready', 'assigned')")
	case "dispute_resolved":
		q = q.Where("t.ack_status IN ('upheld', 'changed')")
	case "unacknowledged":
		q = q.Where("t.state = 'completed' AND t.ack_status = '' AND t.revealed_at IS NOT NULL AND t.kind IN " + model.CountedKinds)
	case "live_flagged":
		q = q.Where("t.kind = 'live' AND t.match_status = 'flagged'")
	case "change_pending":
		q = q.Where("EXISTS (SELECT 1 FROM evaluation_changes ec WHERE ec.task_id = t.id AND ec.status = 'pending')")
	default:
		q = q.Where("t.state = ?", st)
	}
	for param, col := range map[string]string{
		"task_type_id": "t.task_type_id", "employee_id": "t.employee_id", "qa_id": "coalesce(t.assigned_qa_id, t.evaluated_by)",
	} {
		if v := p.Get(param); v != "" {
			q = q.Where(col+" = ?", v)
		}
	}
	switch v := p.Get("kind"); v {
	case "":
	case "escalations": // negatives, TL and QA escalations
		q = q.Where("t.kind IN " + model.ReviewedKinds)
	case "audits": // what counts in scores
		q = q.Where("t.kind IN " + model.CountedKinds)
	default:
		q = q.Where("t.kind = ?", v)
	}
	if v := p.Get("from"); v != "" {
		q = q.Where("t.work_date >= ?", v)
	}
	if v := p.Get("to"); v != "" {
		q = q.Where("t.work_date <= ?", v)
	}
	if v := strings.TrimSpace(p.Get("q")); v != "" {
		like := "%" + v + "%"
		q = q.Where("t.external_id ILIKE ? OR e.name ILIKE ? OR t.order_numbers::text ILIKE ?", like, like, like)
	}
	if v := p.Get("label"); v != "" {
		one, _ := json.Marshal([]string{v})
		q = q.Where("t.labels @> ?::jsonb", string(one))
	}

	if p.Get("ids") == "1" {
		// Every id that matches, for "select all"; capped so a careless
		// filter can't pull the whole table.
		ids := []string{}
		if err := q.Select("t.id::text").Limit(5000).Scan(&ids).Error; err != nil {
			dbError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ids": ids})
		return
	}
	var total int64
	if err := q.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		dbError(w, err)
		return
	}
	page, _ := strconv.Atoi(p.Get("page"))
	page = max(page, 1)
	var rows []taskRow
	order := "t.work_date DESC, t.created_at DESC"
	switch p.Get("state") {
	case "disputed", "dispute_supervisor", "dispute_qa":
		order = "t.ack_at" // longest waiting first
	case "dispute_resolved":
		order = "t.dispute_resolved_at DESC"
	}
	if err := q.Order(order).Offset((page - 1) * 50).Limit(50).Scan(&rows).Error; err != nil {
		dbError(w, err)
		return
	}
	forQA(u, rows)
	writeJSON(w, http.StatusOK, map[string]any{"tasks": rows, "total": total, "page": page, "page_size": 50})
}

// loadTask fetches a task the caller may see. Admins see all; supervisors their
// department; QA agents what is (or was) theirs; employees their own
// completed evaluations.
// loadTask loads a task the caller may act on (their team's, their queue's).
func (s *Server) loadTask(w http.ResponseWriter, r *http.Request) (*model.Task, *model.TaskType, bool) {
	return s.loadTaskAs(w, r, false)
}

// loadTaskAs with read=true is for viewing: QA agents and supervisors open
// any agent's audits (the agent pages cover every team); what they may do on
// it is still decided by the can_* flags and the strict load.
func (s *Server) loadTaskAs(w http.ResponseWriter, r *http.Request, read bool) (*model.Task, *model.TaskType, bool) {
	id, ok := urlID(w, r)
	if !ok {
		return nil, nil, false
	}
	var t model.Task
	var tt model.TaskType
	if err := s.db.WithContext(r.Context()).First(&t, "id = ?", id).Error; err != nil ||
		s.db.WithContext(r.Context()).First(&tt, "id = ?", t.TaskTypeID).Error != nil {
		writeError(w, http.StatusNotFound, "task not found")
		return nil, nil, false
	}
	u := me(r)
	visible := false
	switch u.Role {
	case model.RoleAdmin, model.RoleSupervisor, model.RoleViewer:
		visible = read || inScope(u, tt.DepartmentID)
	case model.RoleTeamLeader: // their own team's only
		visible = inScope(u, tt.DepartmentID)
	case model.RoleQA:
		visible = read || (t.AssignedQAID != nil && *t.AssignedQAID == u.ID) || (t.EvaluatedBy != nil && *t.EvaluatedBy == u.ID) ||
			// Escalations of their team: any of its QA agents may decide them.
			(t.Kind.Reviewed() && t.Kind != model.KindQAEscalation && u.DepartmentID != nil && *u.DepartmentID == tt.DepartmentID)
		if !visible {
			// The audits linked to a coaching they run.
			var n int64
			s.db.WithContext(r.Context()).Model(&model.Coaching{}).
				Where("assigned_qa_id = ? AND task_ids @> jsonb_build_array(?::text)", u.ID, t.ID.String()).Count(&n)
			visible = n > 0
		}
	case model.RoleEmployee:
		visible = t.EmployeeID == u.ID && t.State == model.StateCompleted && t.RevealedAt != nil && (t.Kind.Counts() || t.Kind.Reviewed())
	}
	if !visible {
		writeError(w, http.StatusNotFound, "task not found")
		return nil, nil, false
	}
	return &t, &tt, true
}

func isManager(u *model.User) bool {
	return u.Role == model.RoleAdmin || u.Role == model.RoleSupervisor
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTaskAs(w, r, true)
	if !ok {
		return
	}
	u := me(r)
	// Viewing reaches every team; acting stays with the task's own team.
	manages := isManager(u) && inScope(u, tt.DepartmentID)
	answers := canAnswerDispute(u, t) && (u.Role == model.RoleQA || manages)
	own := u.Role == model.RoleQA && t.EvaluatedBy != nil && *t.EvaluatedBy == u.ID
	// A QA agent learns who audited only on their own audits (queue or scored).
	ownQA := own || u.Role == model.RoleQA && t.AssignedQAID != nil && *t.AssignedQAID == u.ID
	seesWho := u.Role != model.RoleEmployee && (u.Role != model.RoleQA || ownQA)
	var employee model.User
	s.db.WithContext(r.Context()).First(&employee, "id = ?", t.EmployeeID)

	out := map[string]any{
		"task": t,
		"task_type": map[string]any{
			"id": tt.ID, "name": tt.Name, "source": tt.Source, "department_id": tt.DepartmentID, "pass_threshold": tt.PassThreshold,
			"borderline_threshold": tt.BorderlineThreshold,
			"scorecard":            tt.Scorecard, "columns": tt.Columns,
		},
		"employee":     map[string]any{"id": employee.ID, "name": employee.Name, "agent_code": employee.AgentCode, "email": employee.Email},
		"can_evaluate": u.Role == model.RoleQA && t.State == model.StateAssigned && t.AssignedQAID != nil && *t.AssignedQAID == u.ID,
		"can_edit":     t.State == model.StateCompleted && !t.Kind.Reviewed() && (manages || answers || own),
		"can_approve":  manages, // a QA agent's pending score change
		"can_manage":   manages && (t.State == model.StateReady || t.State == model.StateAssigned || t.State == model.StateUnsampled || t.State == model.StateReview),
		"can_decide":   canDecide(u, t, tt),
		"can_ack":      u.Role == model.RoleEmployee && t.AckStatus == "" && !t.Kind.Reviewed(),
		"can_uphold":   answers,
		"can_forward":  manages && t.AckStatus == "disputed" && t.EvaluatedBy != nil,
	}

	// Column order as the sheet had it.
	if t.ImportRunID != nil {
		var run model.ImportRun
		if s.db.WithContext(r.Context()).Select("detail").First(&run, "id = ?", *t.ImportRunID).Error == nil {
			out["columns"] = run.Detail["columns"]
		}
	}

	if u.Role == model.RoleEmployee {
		delete(t.Data, "source") // nor the job title of who escalated them
	}
	if u.Role != model.RoleEmployee && t.CreatedBy != nil && t.Kind.Reviewed() {
		var by model.User
		if s.db.WithContext(r.Context()).Select("name").First(&by, "id = ?", *t.CreatedBy).Error == nil {
			out["reported_by"] = by.Name
		}
	}
	if seesWho {
		qaID := t.EvaluatedBy
		if qaID == nil {
			qaID = t.AssignedQAID
		}
		if qaID != nil {
			var qa model.User
			if s.db.WithContext(r.Context()).Select("name").First(&qa, "id = ?", *qaID).Error == nil {
				out["qa_name"] = qa.Name
			}
		}
	}
	if seesWho {
		// Score changes QA agents asked for, newest first; the pending one is on top.
		changes := []changeRow{}
		s.db.WithContext(r.Context()).Table("evaluation_changes c").
			Select(`c.id, c.task_id, c.answers, c.reason, c.score_before, c.score, c.status, c.decision_note, c.created_at, c.decided_at,
			        rq.name AS requested_by_name, coalesce(dc.name, '') AS decided_by_name`).
			Joins("JOIN users rq ON rq.id = c.requested_by").Joins("LEFT JOIN users dc ON dc.id = c.decided_by").
			Where("c.task_id = ?", t.ID).Order("c.created_at DESC").Scan(&changes)
		out["changes"] = changes

		var logs []struct {
			model.AuditLog
			ActorName *string `json:"actor_name"`
		}
		s.db.WithContext(r.Context()).Table("audit_logs a").Select("a.*, u.name AS actor_name").
			Joins("LEFT JOIN users u ON u.id = a.actor_id").Where("a.task_id = ? AND (? OR a.action NOT IN ('rotation_case', 'rotation_second_review'))", t.ID, u.Role != model.RoleQA).
			Order("a.created_at DESC").Scan(&logs)
		out["audit"] = logs
	}
	if !seesWho { // nor anyone's ID on it (QA agent, who started it, who answered)
		t.AssignedQAID, t.EvaluatedBy, t.DisputeResolvedBy = nil, nil, nil
		if u.Role == model.RoleEmployee || !t.Kind.Reviewed() {
			t.CreatedBy = nil // a live audit's is the QA agent who listened
		}
	}
	if u.Role == model.RoleQA && t.Kind == model.KindRotation { // reads as an ordinary audit
		t.Kind, t.RotationOf = model.KindSample, nil
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTask(w, r)
	var in struct {
		Answers      scorecard.Answers `json:"answers"`
		OrderNumbers []string          `json:"order_numbers"`
	}
	if !ok || !decode(w, r, &in) {
		return
	}
	orders, ok := orderNumbers(w, in.OrderNumbers)
	if !ok {
		return
	}
	u := me(r)
	if t.State != model.StateAssigned || t.AssignedQAID == nil || *t.AssignedQAID != u.ID {
		writeError(w, http.StatusConflict, "this task is no longer in your queue")
		return
	}
	if len(tt.Scorecard) == 0 {
		writeError(w, http.StatusConflict, "this task type has no scorecard yet; ask your supervisor to add metrics")
		return
	}
	res, err := scorecard.Score(tt.Scorecard, in.Answers, thresholds(tt))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC()
	card := tt.Scorecard
	err = s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		upd := tx.Model(&model.Task{}).Where("id = ? AND state = 'assigned' AND assigned_qa_id = ?", t.ID, u.ID).
			Updates(map[string]any{
				"state": model.StateCompleted, "scorecard": &card, "answers": &in.Answers,
				"score": res.Score, "critical_failed": res.CriticalFailed, "passed": res.Passed, "result": res.Band,
				"evaluated_by": u.ID, "submitted_at": now, "completed_at": now, "queue_position": nil,
				"order_numbers": orders,
			})
		if upd.Error != nil {
			return upd.Error
		}
		if upd.RowsAffected == 0 {
			return errConflict
		}
		return s.audit(tx, t.ID, u, "submitted", model.JSONMap{"score": res.Score, "result": res.Band})
	})
	if err != nil {
		taskWriteError(w, err)
		return
	}
	s.runAssign(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"result": res, "next_task_id": s.nextTask(r, u.ID)})
}

var errConflict = errors.New("this task changed while you were working on it; reload")

// orderNumbers tidies the order numbers a QA agent entered: trimmed, no
// blanks or repeats. There may be none.
func orderNumbers(w http.ResponseWriter, in []string) (model.Strings, bool) {
	out := model.Strings{}
	for _, v := range in {
		if v = strings.TrimSpace(v); v != "" && !slices.Contains(out, v) {
			if len(v) > 100 {
				writeError(w, http.StatusBadRequest, "an order number is too long (up to 100 characters)")
				return nil, false
			}
			out = append(out, v)
		}
	}
	if len(out) > 20 {
		writeError(w, http.StatusBadRequest, "at most 20 order numbers")
		return nil, false
	}
	return out, true
}

func taskWriteError(w http.ResponseWriter, err error) {
	if errors.Is(err, errConflict) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	dbError(w, err)
}

func (s *Server) nextTask(r *http.Request, qaID uuid.UUID) *uuid.UUID {
	var t model.Task
	if s.db.WithContext(r.Context()).Select("id").Where("state = 'assigned' AND assigned_qa_id = ?", qaID).
		Order("queue_position").First(&t).Error != nil {
		return nil
	}
	return &t.ID
}

func (s *Server) handleCantAudit(w http.ResponseWriter, r *http.Request) {
	t, _, ok := s.loadTask(w, r)
	var in struct{ Reason string }
	if !ok || !decode(w, r, &in) {
		return
	}
	u := me(r)
	if strings.TrimSpace(in.Reason) == "" {
		writeError(w, http.StatusBadRequest, "say why it can't be audited")
		return
	}
	if t.State != model.StateAssigned || t.AssignedQAID == nil || *t.AssignedQAID != u.ID {
		writeError(w, http.StatusConflict, "this task is no longer in your queue")
		return
	}
	if err := s.cancelTask(r, t, u, strings.TrimSpace(in.Reason), "cant_audit"); err != nil {
		taskWriteError(w, err)
		return
	}
	s.runAssign(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"next_task_id": s.nextTask(r, u.ID)})
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	t, _, ok := s.loadTask(w, r)
	var in struct{ Reason string }
	if !ok || !decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Reason) == "" {
		writeError(w, http.StatusBadRequest, "a reason is required")
		return
	}
	if t.State == model.StateCompleted || t.State == model.StateCancelled {
		writeError(w, http.StatusConflict, "only open tasks can be cancelled")
		return
	}
	if err := s.cancelTask(r, t, me(r), strings.TrimSpace(in.Reason), "cancelled"); err != nil {
		taskWriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) cancelTask(r *http.Request, t *model.Task, u *model.User, reason, action string) error {
	return s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		upd := tx.Model(&model.Task{}).Where("id = ? AND state = ?", t.ID, t.State).Updates(map[string]any{
			"state": model.StateCancelled, "cancel_reason": reason, "queue_position": nil,
		})
		if upd.Error != nil {
			return upd.Error
		}
		if upd.RowsAffected == 0 {
			return errConflict
		}
		return s.audit(tx, t.ID, u, action, model.JSONMap{"reason": reason, "from_state": t.State})
	})
}

func (s *Server) handleReassign(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTask(w, r)
	var in struct {
		QAID uuid.UUID `json:"qa_id"`
	}
	if !ok || !decode(w, r, &in) {
		return
	}
	if t.State != model.StateReady && t.State != model.StateAssigned && t.State != model.StateUnsampled && t.State != model.StateReview {
		writeError(w, http.StatusConflict, "only open tasks can be reassigned")
		return
	}
	var qa model.User
	if err := s.db.WithContext(r.Context()).First(&qa, "id = ? AND role = 'qa_agent' AND active", in.QAID).Error; err != nil ||
		qa.DepartmentID == nil || *qa.DepartmentID != tt.DepartmentID {
		writeError(w, http.StatusBadRequest, "pick an active QA agent from this task's department")
		return
	}
	u := me(r)
	if t.State == model.StateReview {
		if t.Kind == model.KindQAEscalation {
			writeError(w, http.StatusConflict, "a QA escalation is decided by the supervisor, not a QA agent")
			return
		}
		err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&model.Task{}).Where("id = ? AND state = 'review'", t.ID).
				Updates(map[string]any{"assigned_qa_id": qa.ID, "assigned_at": time.Now().UTC()}).Error; err != nil {
				return err
			}
			return s.audit(tx, t.ID, u, "reassigned", model.JSONMap{"qa_id": qa.ID, "qa_name": qa.Name, "to": "check"})
		})
		if err != nil {
			dbError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		var pos int
		tx.Raw("SELECT coalesce(max(queue_position), 0) + 1 FROM tasks WHERE assigned_qa_id = ? AND state = 'assigned'", qa.ID).Scan(&pos)
		upd := tx.Model(&model.Task{}).Where("id = ? AND state = ?", t.ID, t.State).Updates(map[string]any{
			"state": model.StateAssigned, "assigned_qa_id": qa.ID, "assigned_at": time.Now().UTC(), "queue_position": pos,
		})
		if upd.Error != nil {
			return upd.Error
		}
		if upd.RowsAffected == 0 {
			return errConflict
		}
		return s.audit(tx, t.ID, u, "reassigned", model.JSONMap{"qa_id": qa.ID, "qa_name": qa.Name, "from_state": t.State})
	})
	if err != nil {
		taskWriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleBulkReassign moves open audits to one QA agent, or back to the queue
// (qa_id empty) so the assignment pass shares them among QA agents who are
// online. Rotation cases stay put: who scores those is part of the blind
// comparison. Tasks of other teams, or no longer open, are skipped.
func (s *Server) handleBulkReassign(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskIDs []uuid.UUID `json:"task_ids"`
		QAID    *uuid.UUID  `json:"qa_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.TaskIDs) == 0 || len(in.TaskIDs) > 5000 {
		writeError(w, http.StatusBadRequest, "pick between 1 and 5000 tasks")
		return
	}
	u := me(r)
	var qa *model.User
	if in.QAID != nil {
		qa = &model.User{}
		if err := s.db.WithContext(r.Context()).First(qa, "id = ? AND role = 'qa_agent' AND active", *in.QAID).Error; err != nil ||
			qa.DepartmentID == nil || !inScope(u, *qa.DepartmentID) {
			writeError(w, http.StatusBadRequest, "pick an active QA agent of your team")
			return
		}
	}
	var tasks []model.Task
	q := s.db.WithContext(r.Context()).Table("tasks t").Select("t.*").Joins("JOIN task_types tt ON tt.id = t.task_type_id").
		Where("t.id IN ? AND t.state IN ('ready', 'assigned') AND t.kind <> 'rotation'", in.TaskIDs)
	if d := deptScope(u); d != nil {
		q = q.Where("tt.department_id = ?", *d)
	}
	if qa != nil {
		q = q.Where("tt.department_id = ?", *qa.DepartmentID)
	}
	if err := q.Order("t.priority DESC, t.work_date").Scan(&tasks).Error; err != nil {
		dbError(w, err)
		return
	}
	moved := 0
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		var pos int
		if qa != nil {
			tx.Raw("SELECT coalesce(max(queue_position), 0) FROM tasks WHERE assigned_qa_id = ? AND state = 'assigned'", qa.ID).Scan(&pos)
		}
		now := time.Now().UTC()
		for _, t := range tasks {
			if qa != nil && t.AssignedQAID != nil && *t.AssignedQAID == qa.ID {
				continue // already theirs
			}
			upd := map[string]any{"state": model.StateReady, "assigned_qa_id": nil, "assigned_at": nil, "queue_position": nil}
			detail := model.JSONMap{"bulk": true, "to": "queue"}
			if qa != nil {
				pos++
				upd = map[string]any{"state": model.StateAssigned, "assigned_qa_id": qa.ID, "assigned_at": now, "queue_position": pos}
				detail = model.JSONMap{"bulk": true, "qa_id": qa.ID, "qa_name": qa.Name}
			}
			if t.AssignedQAID != nil {
				detail["from_qa_id"] = *t.AssignedQAID
			}
			res := tx.Model(&model.Task{}).Where("id = ? AND state = ?", t.ID, t.State).Updates(upd)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				continue // changed meanwhile (submitted, say)
			}
			if err := s.audit(tx, t.ID, u, "reassigned", detail); err != nil {
				return err
			}
			moved++
		}
		return nil
	})
	if err != nil {
		dbError(w, err)
		return
	}
	if qa == nil {
		s.runAssign(r.Context())
	}
	writeJSON(w, http.StatusOK, map[string]int{"moved": moved, "skipped": len(in.TaskIDs) - moved})
}

// handleEditEvaluation corrects a submitted evaluation, rescored against the
// scorecard it was submitted with; the before/after is logged. A supervisor's
// edit applies at once. So does the QA agent's own when only notes or comments
// change; a change to the score waits for a supervisor (changes.go).
func (s *Server) handleEditEvaluation(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTask(w, r)
	var in struct {
		Answers      scorecard.Answers `json:"answers"`
		Reason       string            `json:"reason"`
		OrderNumbers *[]string         `json:"order_numbers"`
	}
	if !ok || !decode(w, r, &in) {
		return
	}
	if t.State != model.StateCompleted || t.Scorecard == nil || t.Kind.Reviewed() {
		writeError(w, http.StatusConflict, "only submitted evaluations can be edited")
		return
	}
	u := me(r)
	manager := isManager(u)
	if !manager && (t.EvaluatedBy == nil || *t.EvaluatedBy != u.ID) {
		writeError(w, http.StatusForbidden, "only the QA agent who scored it, or a supervisor, can edit this evaluation")
		return
	}
	// Order numbers don't change the score: they apply at once, approval or not.
	if in.OrderNumbers != nil {
		orders, ok := orderNumbers(w, *in.OrderNumbers)
		if !ok {
			return
		}
		if !slices.Equal(orders, t.OrderNumbers) {
			err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
				if err := tx.Model(&model.Task{}).Where("id = ?", t.ID).Update("order_numbers", orders).Error; err != nil {
					return err
				}
				return s.audit(tx, t.ID, u, "order_number_changed", model.JSONMap{"before": t.OrderNumbers, "after": orders})
			})
			if err != nil {
				dbError(w, err)
				return
			}
		}
	}
	res, err := scorecard.Score(*t.Scorecard, in.Answers, thresholds(tt))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	reason := strings.TrimSpace(in.Reason)
	var current scorecard.Answers
	if t.Answers != nil {
		current = *t.Answers
	}
	now := time.Now().UTC()
	if !manager && !t.Scorecard.SameScoring(current, in.Answers) {
		if reason == "" {
			writeError(w, http.StatusBadRequest, "say why the score should change; the supervisor sees it")
			return
		}
		ch := model.EvaluationChange{TaskID: t.ID, RequestedBy: u.ID, Answers: &in.Answers, Reason: reason,
			ScoreBefore: t.Score, Score: res.Score, Status: "pending"}
		err = s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
			// A newer request replaces the one still waiting.
			if err := tx.Model(&model.EvaluationChange{}).Where("task_id = ? AND status = 'pending'", t.ID).
				Updates(map[string]any{"status": "rejected", "decided_by": u.ID, "decided_at": now, "decision_note": "replaced by a newer request"}).Error; err != nil {
				return err
			}
			if err := tx.Create(&ch).Error; err != nil {
				return err
			}
			return s.audit(tx, t.ID, u, "change_requested", model.JSONMap{
				"reason": reason, "before": model.JSONMap{"score": t.Score}, "after": model.JSONMap{"score": res.Score},
			})
		})
		if err != nil {
			dbError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": res, "pending": true})
		return
	}
	err = s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		if manager { // their edit settles any change still waiting
			if err := tx.Model(&model.EvaluationChange{}).Where("task_id = ? AND status = 'pending'", t.ID).
				Updates(map[string]any{"status": "rejected", "decided_by": u.ID, "decided_at": now, "decision_note": "replaced by " + u.Name + "'s edit"}).Error; err != nil {
				return err
			}
		}
		return s.saveEvaluation(tx, t, res, in.Answers, reason, u, manager, nil)
	})
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res, "pending": false})
}

// handleTaskChat returns a live chat's messages from eDesk, read once and
// kept on the task (they don't change once the chat is closed). ?refresh=1
// reads them again.
func (s *Server) handleTaskChat(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTaskAs(w, r, true)
	if !ok {
		return
	}
	if tt.Source != model.SourceEDeskChats {
		writeError(w, http.StatusBadRequest, "not a live chat")
		return
	}
	if kept, ok := t.Data["chat"].([]any); ok && r.URL.Query().Get("refresh") != "1" {
		writeJSON(w, http.StatusOK, kept)
		return
	}
	if s.edeskChat == nil {
		writeError(w, http.StatusServiceUnavailable, "eDesk is not configured (EDESK_API_TOKEN)")
		return
	}
	var ids []int64
	raw, _ := t.Data["messages_ids"].([]any)
	for _, v := range raw {
		if f, ok := v.(float64); ok {
			ids = append(ids, int64(f))
		}
	}
	lines, err := s.edeskChat(r.Context(), ids)
	if err != nil {
		upstreamError(w, err)
		return
	}
	if lines == nil {
		lines = []edesk.ChatLine{}
	}
	js, _ := json.Marshal(lines)
	s.db.WithContext(r.Context()).Model(&model.Task{}).Where("id = ?", t.ID).
		Update("data", gorm.Expr("jsonb_set(data, '{chat}', ?::jsonb)", string(js)))
	writeJSON(w, http.StatusOK, lines)
}

// handleTaskEDesk returns the eDesk ticket's general info, fetched once and
// cached on the task. ?refresh=1 fetches again.
func (s *Server) handleTaskEDesk(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTask(w, r)
	if !ok {
		return
	}
	if tt.Source != model.SourceTicketsAPI {
		writeError(w, http.StatusBadRequest, "not a ticket")
		return
	}
	if cached, ok := t.Data["edesk"].(map[string]any); ok && r.URL.Query().Get("refresh") != "1" {
		writeJSON(w, http.StatusOK, cached)
		return
	}
	if s.edeskTicket == nil {
		writeError(w, http.StatusServiceUnavailable, "eDesk is not configured (EDESK_API_TOKEN)")
		return
	}
	info, err := s.edeskTicket(r.Context(), t.ExternalID)
	if err != nil {
		upstreamError(w, err)
		return
	}
	info["fetched_at"] = time.Now().UTC()
	raw, _ := json.Marshal(info)
	s.db.WithContext(r.Context()).Model(&model.Task{}).Where("id = ?", t.ID).
		Update("data", gorm.Expr("jsonb_set(data, '{edesk}', ?::jsonb)", string(raw)))
	writeJSON(w, http.StatusOK, info)
}

func thresholds(tt *model.TaskType) scorecard.Thresholds {
	return scorecard.Thresholds{Pass: tt.PassThreshold, Borderline: tt.BorderlineThreshold}
}
