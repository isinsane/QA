package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/model"
)

// Coaching: a supervisor assigns it (a topic and/or linked audits) to a QA
// agent, who runs it and records the outcome; the agent acknowledges it.
// A QA agent can also log a session they already held (logged): it is done at
// once, linked audits are optional (refresher sessions have none), and the
// agent isn't asked to acknowledge it.

func (s *Server) routesCoaching(r chi.Router, managers func(http.Handler) http.Handler) {
	r.Get("/coachings", s.handleListCoachings)
	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)).Post("/coachings", s.handleCreateCoaching)
	r.With(s.requireRoles(model.RoleQA)).Post("/coachings/{id}/complete", s.handleCompleteCoaching)
	r.With(s.requireRoles(model.RoleEmployee)).Post("/coachings/{id}/acknowledge", s.handleAckCoaching)
}

type coachingRow struct {
	model.Coaching
	EmployeeName  string  `json:"employee_name"`
	QAName        string  `json:"qa_name"`
	CreatedByName *string `json:"created_by_name"`
}

func (s *Server) handleListCoachings(w http.ResponseWriter, r *http.Request) {
	q := s.db.WithContext(r.Context()).Table("coachings c").
		Select("c.*, e.name AS employee_name, q.name AS qa_name, cb.name AS created_by_name").
		Joins("JOIN users e ON e.id = c.employee_id").
		Joins("JOIN users q ON q.id = c.assigned_qa_id").
		Joins("LEFT JOIN users cb ON cb.id = c.created_by").
		Order("c.status = 'open' DESC, c.due_date NULLS LAST, coalesce(c.completed_at, c.created_at) DESC")
	u := me(r)
	switch {
	case u.Role == model.RoleEmployee:
		q = q.Where("c.employee_id = ?", u.ID)
	case u.Role != model.RoleQA && !isManager(u) && !readsAll(u): // negatives agents
		q = q.Where("false")
	case r.URL.Query().Get("employee_id") != "":
		// One agent's sessions (their page): QA agents and supervisors see any agent's.
		q = q.Where("c.employee_id = ?", r.URL.Query().Get("employee_id"))
	case u.Role == model.RoleQA:
		q = q.Where("c.assigned_qa_id = ?", u.ID)
	default:
		if d := deptScope(u); d != nil {
			q = q.Where("c.department_id = ?", *d)
		}
	}
	var out []coachingRow
	if err := q.Scan(&out).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateCoaching(w http.ResponseWriter, r *http.Request) {
	if me(r).Role == model.RoleQA {
		s.logCoaching(w, r)
		return
	}
	var in struct {
		EmployeeID   uuid.UUID     `json:"employee_id"`
		Topic        string        `json:"topic"`
		TaskIDs      model.Strings `json:"task_ids"`
		AssignedQAID uuid.UUID     `json:"assigned_qa_id"`
		DueDate      string        `json:"due_date"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Topic = strings.TrimSpace(in.Topic)
	if in.Topic == "" && len(in.TaskIDs) == 0 {
		writeError(w, http.StatusBadRequest, "give a topic or link at least one audit")
		return
	}
	var agent, qa model.User
	if s.db.WithContext(r.Context()).First(&agent, "id = ? AND role = 'employee' AND active", in.EmployeeID).Error != nil ||
		agent.DepartmentID == nil || !inScope(me(r), *agent.DepartmentID) {
		writeError(w, http.StatusBadRequest, "pick an agent of your team")
		return
	}
	if s.db.WithContext(r.Context()).First(&qa, "id = ? AND role = 'qa_agent' AND active", in.AssignedQAID).Error != nil ||
		qa.DepartmentID == nil || *qa.DepartmentID != *agent.DepartmentID {
		writeError(w, http.StatusBadRequest, "pick a QA agent of the same team")
		return
	}
	if len(in.TaskIDs) > 0 {
		var n int64
		s.db.WithContext(r.Context()).Model(&model.Task{}).Where("id IN ? AND employee_id = ?", []string(in.TaskIDs), agent.ID).Count(&n)
		if int(n) != len(in.TaskIDs) {
			writeError(w, http.StatusBadRequest, "linked audits must be this agent's")
			return
		}
	}
	u := me(r)
	c := model.Coaching{
		DepartmentID: *agent.DepartmentID, EmployeeID: agent.ID, Topic: in.Topic, Kind: "coaching", TaskIDs: in.TaskIDs,
		AssignedQAID: qa.ID, CreatedBy: &u.ID, Status: "open",
	}
	if c.TaskIDs == nil {
		c.TaskIDs = model.Strings{}
	}
	if in.DueDate != "" {
		d, err := model.ParseDate(in.DueDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "due date must be YYYY-MM-DD")
			return
		}
		c.DueDate = &d
	}
	if err := s.db.WithContext(r.Context()).Create(&c).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

// logCoaching records a session a QA agent already held, with any agent.
func (s *Server) logCoaching(w http.ResponseWriter, r *http.Request) {
	var in struct {
		EmployeeID uuid.UUID     `json:"employee_id"`
		Kind       string        `json:"kind"`
		Topic      string        `json:"topic"`
		TaskIDs    model.Strings `json:"task_ids"`
		Notes      string        `json:"notes"`
		Outcome    string        `json:"outcome"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Topic, in.Notes, in.Outcome = strings.TrimSpace(in.Topic), strings.TrimSpace(in.Notes), strings.TrimSpace(in.Outcome)
	if in.Kind == "" {
		in.Kind = "coaching"
	}
	switch {
	case in.Kind != "coaching" && in.Kind != "refresher":
		writeError(w, http.StatusBadRequest, "the type is coaching or refresher")
		return
	case in.Notes == "" || len(in.Notes) > 5000:
		writeError(w, http.StatusBadRequest, "write what you did in the session (up to 5000 characters)")
		return
	case in.Topic == "" && len(in.TaskIDs) == 0:
		writeError(w, http.StatusBadRequest, "give a topic or link at least one audit")
		return
	case len(in.Topic) > 200 || len(in.Outcome) > 2000:
		writeError(w, http.StatusBadRequest, "the topic or outcome is too long")
		return
	}
	db := s.db.WithContext(r.Context())
	var agent model.User
	if db.First(&agent, "id = ? AND role = 'employee' AND active", in.EmployeeID).Error != nil || agent.DepartmentID == nil {
		writeError(w, http.StatusBadRequest, "pick an active agent")
		return
	}
	if in.TaskIDs == nil {
		in.TaskIDs = model.Strings{}
	}
	if len(in.TaskIDs) > 0 {
		var n int64
		db.Model(&model.Task{}).Where("id IN ? AND employee_id = ? AND state = 'completed'", []string(in.TaskIDs), agent.ID).Count(&n)
		if int(n) != len(in.TaskIDs) {
			writeError(w, http.StatusBadRequest, "linked audits must be this agent's submitted audits or valid escalations")
			return
		}
	}
	u, now := me(r), time.Now().UTC()
	c := model.Coaching{
		DepartmentID: *agent.DepartmentID, EmployeeID: agent.ID, Topic: in.Topic, Kind: in.Kind, Logged: true, TaskIDs: in.TaskIDs,
		AssignedQAID: u.ID, CreatedBy: &u.ID, Status: "done", Notes: in.Notes, Outcome: in.Outcome, CompletedAt: &now,
	}
	if err := db.Create(&c).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) loadCoaching(w http.ResponseWriter, r *http.Request) (*model.Coaching, bool) {
	id, ok := urlID(w, r)
	if !ok {
		return nil, false
	}
	var c model.Coaching
	if err := s.db.WithContext(r.Context()).First(&c, "id = ?", id).Error; err != nil {
		writeError(w, http.StatusNotFound, "coaching not found")
		return nil, false
	}
	return &c, true
}

func (s *Server) handleCompleteCoaching(w http.ResponseWriter, r *http.Request) {
	c, ok := s.loadCoaching(w, r)
	var in struct{ Notes, Outcome string }
	if !ok || !decode(w, r, &in) {
		return
	}
	if c.AssignedQAID != me(r).ID || c.Status != "open" {
		writeError(w, http.StatusConflict, "this coaching is not open on your list")
		return
	}
	if strings.TrimSpace(in.Notes) == "" {
		writeError(w, http.StatusBadRequest, "write what was covered")
		return
	}
	err := s.db.WithContext(r.Context()).Model(c).Updates(map[string]any{
		"status": "done", "notes": strings.TrimSpace(in.Notes), "outcome": strings.TrimSpace(in.Outcome),
		"completed_at": time.Now().UTC(),
	}).Error
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "done"})
}

func (s *Server) handleAckCoaching(w http.ResponseWriter, r *http.Request) {
	c, ok := s.loadCoaching(w, r)
	var in struct{ Comment string }
	if !ok || !decode(w, r, &in) {
		return
	}
	if c.EmployeeID != me(r).ID || c.Status != "done" || c.AckAt != nil || c.Logged {
		writeError(w, http.StatusConflict, "nothing to acknowledge here")
		return
	}
	err := s.db.WithContext(r.Context()).Model(c).Updates(map[string]any{
		"ack_at": time.Now().UTC(), "ack_comment": strings.TrimSpace(in.Comment),
	}).Error
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
