package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
)

// Escalations: someone reports an order or call, the agent behind it and
// what went wrong. It waits (state review) until it is decided Valid (the
// agent's mistake: it shows on their profile) or Not valid, with a note.
// Never scored, never disputed.
//
//   - Negatives: a negatives agent reports a negative review.
//   - Team leader escalations: a team leader (floor support) or a special
//     process agent escalates work, named after their job title.
//   - QA escalations: a QA agent raises one.
//
// Each can be about any agent of any team; the agent's team checks it.
//
// Negatives and TL escalations are auto-assigned to a QA agent of the team to
// check (internal/assign); its QA agents and the supervisor may decide them.
// QA escalations are decided by the supervisor.
type reporter struct {
	kind  model.Kind
	roles []model.Role
	path  string
	noun  string // in messages: "negative", "escalation"
}

var reporters = []reporter{
	{model.KindNegative, []model.Role{model.RoleNegative}, "/negatives", "negative"},
	{model.KindTLEscalation, []model.Role{model.RoleTeamLeader, model.RoleSpecialProcess}, "/tl-escalations", "escalation"},
	{model.KindQAEscalation, []model.Role{model.RoleQA}, "/qa-escalations", "escalation"},
}

// escalationSource names a team leader's or special process agent's
// escalation after their job title: "A-Z Guarantee Team Leader escalation".
func escalationSource(u *model.User) string {
	title, _ := u.Profile["job_title"].(string)
	if title = strings.TrimSpace(title); title == "" {
		title = map[model.Role]string{model.RoleSpecialProcess: "Special process"}[u.Role]
		if title == "" {
			title = "Team leader"
		}
	}
	return title + " escalation"
}

func (s *Server) routesReported(r chi.Router, managers func(http.Handler) http.Handler) {
	for _, rp := range reporters {
		who := s.requireRoles(append(rp.roles, model.RoleAdmin, model.RoleSupervisor)...)
		r.With(who).Get(rp.path+"/agents", s.reportAgents(rp))
		r.With(who).Post(rp.path, s.report(rp))
		r.With(s.requireRoles(rp.roles...)).Get(rp.path+"/mine", s.myReports(rp))
	}
	checkers := s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)
	r.With(checkers).Post("/tasks/{id}/decide", s.handleDecide)
	r.With(checkers).Get("/escalations", s.handleEscalations)
	// Agents of every team for a supervisor's escalation (POST /escalations).
	r.With(managers).Get("/escalations/agents", s.reportAgents(reporter{}))
}

// canDecide: the supervisor (their team) decides any escalation; the QA
// agent it is assigned to decides a negative or TL escalation.
func canDecide(u *model.User, t *model.Task, tt *model.TaskType) bool {
	switch {
	case !t.Kind.Reviewed() || t.State != model.StateReview:
		return false
	case isManager(u):
		return inScope(u, tt.DepartmentID)
	}
	return u.Role == model.RoleQA && t.Kind != model.KindQAEscalation && t.AssignedQAID != nil && *t.AssignedQAID == u.ID
}

type reportAgent struct {
	ID         uuid.UUID       `json:"id"`
	Name       string          `json:"name"`
	AliasName  string          `json:"alias_name"`
	Team       string          `json:"team"`
	Department string          `json:"department"` // HR
	Types      []reportTypeRef `json:"types"`      // task types a report about them can go to
}

type reportTypeRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// reportTypes are the active task types of the agent's team that audit
// them, feed-backed ones (calls, sales, tickets) first.
func reportTypes(u model.User, types []model.TaskType) []model.TaskType {
	var out []model.TaskType
	for _, tt := range types {
		if tt.Active && u.DepartmentID != nil && tt.DepartmentID == *u.DepartmentID && tt.Audits(u) {
			out = append(out, tt)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Source != model.SourceManual && out[j].Source == model.SourceManual
	})
	return out
}

func (s *Server) reportAgents(rp reporter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db := s.db.WithContext(r.Context())
		q := db.Where("role = 'employee' AND active").Order("name")
		var users []model.User
		if err := q.Find(&users).Error; err != nil {
			dbError(w, err)
			return
		}
		var types []model.TaskType
		var depts []model.Department
		db.Where("active").Order("name").Find(&types)
		db.Find(&depts)
		team := map[uuid.UUID]string{}
		for _, d := range depts {
			team[d.ID] = d.Name
		}
		out := make([]reportAgent, 0, len(users))
		for _, u := range users {
			a := reportAgent{ID: u.ID, Name: u.Name, AliasName: u.AliasName, Department: u.Department(), Types: []reportTypeRef{}}
			if u.DepartmentID != nil {
				a.Team = team[*u.DepartmentID]
			}
			for _, tt := range reportTypes(u, types) {
				a.Types = append(a.Types, reportTypeRef{tt.ID, tt.Name})
			}
			out = append(out, a)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func (s *Server) report(rp reporter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ExternalID string     `json:"external_id"`
			EmployeeID uuid.UUID  `json:"employee_id"`
			Error      string     `json:"error"`
			TaskTypeID *uuid.UUID `json:"task_type_id"`
		}
		if !decode(w, r, &in) {
			return
		}
		in.ExternalID, in.Error = strings.TrimSpace(in.ExternalID), strings.TrimSpace(in.Error)
		switch {
		case in.ExternalID == "" || len(in.ExternalID) > 100:
			writeError(w, http.StatusBadRequest, "enter the order number or call ID (up to 100 characters)")
			return
		case in.Error == "" || len(in.Error) > 2000:
			writeError(w, http.StatusBadRequest, "describe what the agent did (up to 2000 characters)")
			return
		}
		u := me(r)
		db := s.db.WithContext(r.Context())
		var agent model.User
		if db.Where("id = ? AND role = 'employee' AND active", in.EmployeeID).First(&agent).Error != nil {
			writeError(w, http.StatusBadRequest, "pick an active agent")
			return
		}
		var types []model.TaskType
		db.Where("active").Order("name").Find(&types)
		fits := reportTypes(agent, types)
		var tt *model.TaskType
		for i := range fits {
			if in.TaskTypeID == nil || fits[i].ID == *in.TaskTypeID {
				tt = &fits[i]
				break
			}
		}
		if tt == nil {
			writeError(w, http.StatusBadRequest, "no task type audits "+agent.Name+"'s work yet; ask an admin to set one up")
			return
		}
		var dup int64
		db.Model(&model.Task{}).Where("kind = ? AND state <> 'cancelled' AND task_type_id = ? AND external_id = ? AND employee_id = ?",
			rp.kind, tt.ID, in.ExternalID, agent.ID).Count(&dup)
		if dup > 0 {
			writeError(w, http.StatusConflict, "this order / call is already reported for "+agent.Name)
			return
		}
		now := time.Now().In(s.cfg(r).TZ())
		t := model.Task{
			TaskTypeID: tt.ID, EmployeeID: agent.ID, ExternalID: in.ExternalID,
			WorkDate: model.Date{Time: time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)},
			Labels:   model.Strings{}, Data: model.JSONMap{}, State: model.StateReview, Kind: rp.kind,
			Priority: 10, CreatedBy: &u.ID, Note: in.Error,
		}
		if rp.kind == model.KindTLEscalation {
			t.Data["source"] = escalationSource(u)
		}
		err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Create(&t).Error; err != nil {
				return err
			}
			return s.audit(tx, t.ID, u, string(rp.kind)+"_reported", model.JSONMap{"reason": in.Error})
		})
		if err != nil {
			dbError(w, err)
			return
		}
		s.runAssign(r.Context()) // straight to a QA agent to check
		writeJSON(w, http.StatusCreated, map[string]any{"id": t.ID, "task_type": tt.Name})
	}
}

// myReports is what the reporter sent, newest first.
func (s *Server) myReports(rp reporter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var out []taskRow
		err := s.taskRows(r).Where("t.kind = ? AND t.created_by = ?", rp.kind, me(r).ID).
			Order("t.created_at DESC").Limit(300).Scan(&out).Error
		if err != nil {
			dbError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleDecide marks an escalation Valid (the agent's mistake: it goes on
// their profile) or Not valid, with what was found.
func (s *Server) handleDecide(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTask(w, r)
	var in struct {
		Valid bool   `json:"valid"`
		Note  string `json:"note"`
	}
	if !ok || !decode(w, r, &in) {
		return
	}
	u := me(r)
	if !canDecide(u, t, tt) {
		writeError(w, http.StatusConflict, "this escalation isn't waiting for your decision")
		return
	}
	note := strings.TrimSpace(in.Note)
	if note == "" {
		writeError(w, http.StatusBadRequest, "say what you found")
		return
	}
	now := time.Now().UTC()
	none := scorecard.Answers{}
	upd := map[string]any{"finding": note, "evaluated_by": u.ID, "queue_position": nil}
	action := string(t.Kind) + "_confirmed"
	if in.Valid {
		upd["state"], upd["answers"], upd["completed_at"] = model.StateCompleted, &none, now
	} else {
		upd["state"], upd["cancel_reason"] = model.StateCancelled, note
		action = string(t.Kind) + "_dismissed"
	}
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Task{}).Where("id = ? AND state = 'review'", t.ID).Updates(upd)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errConflict
		}
		return s.audit(tx, t.ID, u, action, model.JSONMap{"reason": note})
	})
	if errors.Is(err, errConflict) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleEscalations lists escalations: to check, valid or not valid. A QA
// agent sees only their own: assigned to them to check, decided by them, or
// raised by them; supervisors their team's. Negatives to check come first.
// source picks one kind; exclude leaves one out (the Escalations page leaves
// negatives to their own page).
func (s *Server) handleEscalations(w http.ResponseWriter, r *http.Request) {
	u, p := me(r), r.URL.Query()
	q, order := s.taskRows(r), "t.created_at"
	switch {
	case p.Get("raised") == "1": // what they raised, in any team; a supervisor's are scored audits
		q = q.Where("t.created_by = ? AND (t.kind IN "+model.ReviewedKinds+" OR t.kind = ?)", u.ID, model.KindEscalation)
		order = "t.created_at DESC"
	case u.Role == model.RoleQA:
		q = q.Where("t.kind IN "+model.ReviewedKinds+" AND (t.assigned_qa_id = ? OR t.evaluated_by = ? OR t.created_by = ?)", u.ID, u.ID, u.ID)
	case deptScope(u) != nil:
		q = q.Where("t.kind IN "+model.ReviewedKinds+" AND tt.department_id = ?", *deptScope(u))
	default:
		q = q.Where("t.kind IN " + model.ReviewedKinds)
	}
	switch p.Get("state") {
	case "", "review":
		q, order = q.Where("t.state = 'review'"), "t.kind = 'negative' DESC, t.created_at"
	case "valid":
		q, order = q.Where("t.state = 'completed'"), "t.completed_at DESC"
	case "not_valid":
		q, order = q.Where("t.state = 'cancelled'"), "t.updated_at DESC"
	}
	if v := p.Get("source"); v != "" {
		q = q.Where("t.kind = ?", v)
	}
	if v := p.Get("exclude"); v != "" {
		q = q.Where("t.kind <> ?", v)
	}
	if p.Get("mine") == "1" {
		q = q.Where("t.assigned_qa_id = ?", u.ID)
	}
	if v := p.Get("employee_id"); v != "" {
		q = q.Where("t.employee_id = ?", v)
	}
	var total int64
	if err := q.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		dbError(w, err)
		return
	}
	page, _ := strconv.Atoi(p.Get("page"))
	page = max(page, 1)
	rows := []taskRow{}
	if err := q.Order(order).Offset((page - 1) * 50).Limit(50).Scan(&rows).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": rows, "total": total, "page_size": 50})
}
