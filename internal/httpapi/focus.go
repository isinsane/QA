package httpapi

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
)

// Focus plans: a QA agent (for themselves) or a supervisor (for a QA agent
// of the team) plans focus audits of one agent's work: some codes, or any
// code at random, in a date range, and why. The interactions are pulled at
// once; while a QA agent has focus audits open their normal queue waits
// (handleSubmit, nextTask, internal/assign). Agents never see any of it.
func (s *Server) routesFocus(r chi.Router) {
	who := s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)
	r.With(who).Get("/focus-plans", s.handleFocusPlans)
	r.With(who).Post("/focus-plans", s.handleCreateFocusPlan)
	r.With(who).Get("/focus-plans/options", s.handleFocusOptions)
	r.With(who).Get("/focus-plans/{id}", s.handleFocusPlan)
	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor)).Post("/focus-plans/{id}/cancel", s.handleCancelFocusPlan)
	r.With(who).Get("/focus/labels", s.handleFocusLabels)
}

var errNothingToPull = errors.New("nothing to pull")

func (s *Server) handleCreateFocusPlan(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskTypeID   uuid.UUID  `json:"task_type_id"`
		EmployeeID   uuid.UUID  `json:"employee_id"`
		AssignedQAID *uuid.UUID `json:"assigned_qa_id"` // a supervisor's pick; a QA agent plans for themselves
		Labels       []string   `json:"labels"`         // none: any code, at random
		Count        int        `json:"count"`
		From         string     `json:"from"`
		To           string     `json:"to"`
		Reason       string     `json:"reason"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	from, err1 := time.Parse(time.DateOnly, in.From)
	to, err2 := time.Parse(time.DateOnly, in.To)
	switch {
	case in.Count < 1 || in.Count > 50:
		writeError(w, http.StatusBadRequest, "pick between 1 and 50 interactions")
		return
	case in.Reason == "" || len(in.Reason) > 500:
		writeError(w, http.StatusBadRequest, "say why: what this plan is to check (up to 500 characters)")
		return
	case err1 != nil || err2 != nil || to.Before(from):
		writeError(w, http.StatusBadRequest, "pick the work dates")
		return
	}
	tt, ok := s.teamType(w, r, in.TaskTypeID)
	if !ok {
		return
	}
	agent, ok := s.agentOf(w, r, in.EmployeeID)
	if !ok || !agentFits(w, tt, agent) {
		return
	}
	if agent.DepartmentID == nil || *agent.DepartmentID != tt.DepartmentID {
		writeError(w, http.StatusBadRequest, agent.Name+" isn't on the team of "+tt.Name)
		return
	}
	u := me(r)
	qaID := u.ID
	if u.Role != model.RoleQA {
		var qa model.User
		if in.AssignedQAID == nil || s.db.WithContext(r.Context()).
			First(&qa, "id = ? AND role = 'qa_agent' AND active AND department_id = ?", *in.AssignedQAID, tt.DepartmentID).Error != nil {
			writeError(w, http.StatusBadRequest, "pick an active QA agent of "+agent.Name+"'s team to do it")
			return
		}
		qaID = qa.ID
	}
	labels := model.Strings{}
	for _, l := range in.Labels {
		if l = strings.TrimSpace(l); l != "" && !slices.Contains(labels, l) {
			labels = append(labels, l)
		}
	}
	plan := model.FocusPlan{
		DepartmentID: tt.DepartmentID, TaskTypeID: tt.ID, EmployeeID: agent.ID, AssignedQAID: qaID, CreatedBy: u.ID,
		Labels: labels, FromDate: model.Date{Time: from}, ToDate: model.Date{Time: to}, Asked: in.Count,
		Reason: in.Reason, Status: "open",
	}
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		q := tx.Table("tasks").Select("id").Where("task_type_id = ? AND employee_id = ? AND state = 'unsampled' AND kind = 'sample' AND work_date BETWEEN ? AND ?",
			tt.ID, agent.ID, in.From, in.To)
		if len(labels) > 0 {
			q = q.Where("EXISTS (SELECT 1 FROM jsonb_array_elements_text(tasks.labels) l WHERE l IN ?)", []string(labels))
		}
		var ids []uuid.UUID
		if err := q.Order("random()").Limit(in.Count).Scan(&ids).Error; err != nil {
			return err
		}
		if len(ids) == 0 {
			return errNothingToPull
		}
		if err := tx.Create(&plan).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		pos := nextPosition(tx, qaID)
		for i, id := range ids {
			res := tx.Model(&model.Task{}).Where("id = ? AND state = 'unsampled'", id).Updates(map[string]any{
				"kind": model.KindFocus, "state": model.StateAssigned, "assigned_qa_id": qaID, "assigned_at": now,
				"queue_position": pos + i, "created_by": u.ID, "note": "Focus plan: " + plan.Reason, "focus_plan_id": plan.ID,
			})
			if res.Error != nil {
				return res.Error
			}
			plan.Pulled += int(res.RowsAffected)
			if err := s.audit(tx, id, u, "focus_plan", model.JSONMap{"plan": plan.ID, "reason": plan.Reason}); err != nil {
				return err
			}
		}
		return tx.Model(&plan).Update("pulled", plan.Pulled).Error
	})
	if errors.Is(err, errNothingToPull) {
		writeError(w, http.StatusConflict, "none of "+agent.Name+"'s interactions in those dates match (or all were already audited)")
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, plan)
}

// focusPlanRow is a plan with the names a list needs and how far it got.
type focusPlanRow struct {
	model.FocusPlan
	AgentName     string   `json:"agent_name"`
	AgentAlias    string   `json:"agent_alias"`
	QAName        string   `json:"qa_name"`
	CreatedByName string   `json:"created_by_name"`
	TaskTypeName  string   `json:"task_type_name"`
	Team          string   `json:"team"`
	Done          int      `json:"done"` // audits submitted
	Left          int      `json:"left"` // still to do
	AvgScore      *float64 `json:"avg_score"`
}

func (s *Server) focusPlanRows(r *http.Request) *gorm.DB {
	q := s.db.WithContext(r.Context()).Table("focus_plans p").
		Select(`p.*, e.name AS agent_name, e.alias_name AS agent_alias, qa.name AS qa_name, cb.name AS created_by_name,
		        tt.name AS task_type_name, d.name AS team,
		        count(t.id) FILTER (WHERE t.state = 'completed') AS done,
		        count(t.id) FILTER (WHERE t.state = 'assigned') AS "left",
		        round(avg(t.score) FILTER (WHERE t.state = 'completed'), 1) AS avg_score`).
		Joins("JOIN users e ON e.id = p.employee_id").
		Joins("JOIN users qa ON qa.id = p.assigned_qa_id").
		Joins("JOIN users cb ON cb.id = p.created_by").
		Joins("JOIN task_types tt ON tt.id = p.task_type_id").
		Joins("JOIN departments d ON d.id = p.department_id").
		Joins("LEFT JOIN tasks t ON t.focus_plan_id = p.id").
		Group("p.id, e.name, e.alias_name, qa.name, cb.name, tt.name, d.name")
	// A QA agent sees their own plans; supervisors their team's.
	if u := me(r); u.Role == model.RoleQA {
		q = q.Where("p.assigned_qa_id = ?", u.ID)
	} else if d := deptScope(u); d != nil {
		q = q.Where("p.department_id = ?", *d)
	}
	return q
}

func (s *Server) handleFocusPlans(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query()
	status := p.Get("status")
	if status != "done" && status != "cancelled" {
		status = "open"
	}
	q := s.focusPlanRows(r).Where("p.status = ?", status)
	for _, f := range []string{"employee_id", "qa_id"} {
		if v := p.Get(f); v != "" {
			col := map[string]string{"employee_id": "p.employee_id", "qa_id": "p.assigned_qa_id"}[f]
			q = q.Where(col+" = ?", v)
		}
	}
	page, _ := strconv.Atoi(p.Get("page"))
	page = max(page, 1)
	rows := []focusPlanRow{}
	if err := q.Order("p.created_at DESC").Offset((page - 1) * 50).Limit(50).Scan(&rows).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// handleFocusPlan is one plan: its audits and what they found.
func (s *Server) handleFocusPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	if !ok {
		return
	}
	var plan focusPlanRow
	if err := s.focusPlanRows(r).Where("p.id = ?", id).Take(&plan).Error; err != nil {
		writeError(w, http.StatusNotFound, "focus plan not found")
		return
	}
	audits := []taskRow{}
	if err := s.taskRows(r).Where("t.focus_plan_id = ?", id).Order("t.completed_at NULLS LAST, t.queue_position").Scan(&audits).Error; err != nil {
		dbError(w, err)
		return
	}
	var cards []cardAnswers
	var done []model.Task
	s.db.WithContext(r.Context()).Select("scorecard, answers, result").Where("focus_plan_id = ? AND state = 'completed'", id).Find(&done)
	results := map[string]int{"pass": 0, "borderline": 0, "fail": 0}
	for _, t := range done {
		if t.Scorecard != nil && t.Answers != nil {
			cards = append(cards, cardAnswers{*t.Scorecard, *t.Answers})
		}
		if t.Result != nil {
			results[*t.Result]++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"plan": plan, "audits": audits, "results": results, "metrics": metricStats(cards)})
}

// handleCancelFocusPlan stops an open plan: the audits not done yet go back
// to not sampled, and the QA agent's queue opens again.
func (s *Server) handleCancelFocusPlan(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	var in struct {
		Reason string `json:"reason"`
	}
	if !ok || !decode(w, r, &in) {
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" {
		writeError(w, http.StatusBadRequest, "say why it is cancelled")
		return
	}
	u := me(r)
	var plan model.FocusPlan
	if s.db.WithContext(r.Context()).First(&plan, "id = ?", id).Error != nil || !inScope(u, plan.DepartmentID) {
		writeError(w, http.StatusNotFound, "focus plan not found")
		return
	}
	if plan.Status != "open" {
		writeError(w, http.StatusConflict, "this plan is already "+plan.Status)
		return
	}
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		var left []uuid.UUID
		tx.Model(&model.Task{}).Where("focus_plan_id = ? AND state = 'assigned'", id).Pluck("id", &left)
		for _, t := range left {
			if err := tx.Model(&model.Task{}).Where("id = ?", t).Updates(map[string]any{
				"kind": model.KindSample, "state": model.StateUnsampled, "assigned_qa_id": nil, "assigned_at": nil,
				"queue_position": nil, "created_by": nil, "note": "", "focus_plan_id": nil,
			}).Error; err != nil {
				return err
			}
			if err := s.audit(tx, t, u, "focus_cancelled", model.JSONMap{"plan": id, "reason": in.Reason}); err != nil {
				return err
			}
		}
		return tx.Model(&model.FocusPlan{}).Where("id = ?", id).Updates(map[string]any{
			"status": "cancelled", "closed_at": time.Now().UTC(), "closed_by": u.ID, "cancel_reason": in.Reason,
		}).Error
	})
	if err != nil {
		dbError(w, err)
		return
	}
	s.runAssign(r.Context()) // their queue fills again
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleFocusOptions is what the new-plan dialog picks from: the agents of
// the caller's team (every team for an admin) with the types their work comes
// in, and the QA agents who can do it.
func (s *Server) handleFocusOptions(w http.ResponseWriter, r *http.Request) {
	db := s.db.WithContext(r.Context())
	scope := deptScope(me(r))
	q := db.Where("role = 'employee' AND active").Order("name")
	if scope != nil {
		q = q.Where("department_id = ?", *scope)
	}
	var users []model.User
	var types []model.TaskType
	var depts []model.Department
	if err := q.Find(&users).Error; err != nil {
		dbError(w, err)
		return
	}
	db.Where("active AND source <> ?", model.SourceManual).Order("name").Find(&types) // focus pulls imported work
	db.Find(&depts)
	team := map[uuid.UUID]string{}
	for _, d := range depts {
		team[d.ID] = d.Name
	}
	agents := []reportAgent{}
	for _, u := range users {
		a := reportAgent{ID: u.ID, Name: u.Name, AliasName: u.AliasName, Department: u.Department(), Types: []reportTypeRef{}, TeamID: u.DepartmentID}
		if u.DepartmentID != nil {
			a.Team = team[*u.DepartmentID]
		}
		for _, tt := range reportTypes(u, types) {
			a.Types = append(a.Types, reportTypeRef{tt.ID, tt.Name})
		}
		if len(a.Types) > 0 {
			agents = append(agents, a)
		}
	}
	type qaRef struct {
		ID           uuid.UUID `json:"id"`
		Name         string    `json:"name"`
		DepartmentID uuid.UUID `json:"department_id"`
		Open         int       `json:"open"` // audits in their queue now
	}
	qas := []qaRef{}
	qq := db.Table("users u").Select(`u.id, u.name, u.department_id,
	        (SELECT count(*) FROM tasks t WHERE t.assigned_qa_id = u.id AND t.state = 'assigned') AS open`).
		Where("u.role = 'qa_agent' AND u.active").Order("u.name")
	if scope != nil {
		qq = qq.Where("u.department_id = ?", *scope)
	}
	if err := qq.Scan(&qas).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents, "qas": qas})
}

// closeFocusPlan marks a focus plan done once none of its audits is left to
// do (each submitted, or found impossible to audit).
func closeFocusPlan(tx *gorm.DB, planID *uuid.UUID) error {
	if planID == nil {
		return nil
	}
	return tx.Exec(`UPDATE focus_plans SET status = 'done', closed_at = now()
		WHERE id = ? AND status = 'open' AND NOT EXISTS (SELECT 1 FROM tasks WHERE focus_plan_id = ? AND state = 'assigned')`,
		*planID, *planID).Error
}

// focusFirst: a QA agent with focus audits open does those before their
// normal queue (sample audits and rotation cases).
func (s *Server) focusFirst(r *http.Request, u *model.User, t *model.Task) bool {
	if u.Role != model.RoleQA || (t.Kind != model.KindSample && t.Kind != model.KindRotation) {
		return false
	}
	var n int64
	s.db.WithContext(r.Context()).Model(&model.Task{}).
		Where("assigned_qa_id = ? AND state = 'assigned' AND kind = ?", u.ID, model.KindFocus).Count(&n)
	return n > 0
}
