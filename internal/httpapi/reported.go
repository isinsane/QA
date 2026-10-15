package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
)

// Reported work: someone outside QA reports an order or call, the agent
// behind it and what went wrong. It waits for that agent's supervisor
// (state review), who confirms it as reported, sends it to a QA agent to audit
// with the task type's scorecard, or dismisses it. It is tracked on its own
// and doesn't change quality scores.
//
//   - Negatives: a negatives agent reports a negative review, about any agent.
//   - Team leader escalations: a team leader (floor support) escalates work
//     of an agent on their own team.
type reporter struct {
	kind     model.Kind
	role     model.Role
	path     string
	noun     string // in messages: "negative", "escalation"
	teamOnly bool   // the reporter picks from their own team's agents only
}

var reporters = []reporter{
	{model.KindNegative, model.RoleNegative, "/negatives", "negative", false},
	{model.KindTLEscalation, model.RoleTeamLeader, "/tl-escalations", "escalation", true},
}

func (s *Server) routesReported(r chi.Router, managers func(http.Handler) http.Handler) {
	for _, rp := range reporters {
		who := s.requireRoles(rp.role, model.RoleAdmin, model.RoleSupervisor)
		r.With(who).Get(rp.path+"/agents", s.reportAgents(rp))
		r.With(who).Post(rp.path, s.report(rp))
		r.With(s.requireRoles(rp.role)).Get(rp.path+"/mine", s.myReports(rp))
	}
	r.With(managers).Post("/tasks/{id}/confirm", s.handleConfirmReported)
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

// agentScope limits the agents a reporter can pick: their own team for a
// team-only kind (admins see everyone), everyone otherwise.
func agentScope(rp reporter, u *model.User) *uuid.UUID {
	if rp.teamOnly && u.Role != model.RoleAdmin {
		if u.DepartmentID == nil {
			return &uuid.Nil // nobody
		}
		return u.DepartmentID
	}
	return nil
}

func (s *Server) reportAgents(rp reporter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		db := s.db.WithContext(r.Context())
		q := db.Where("role = 'employee' AND active").Order("name")
		if d := agentScope(rp, me(r)); d != nil {
			q = q.Where("department_id = ?", *d)
		}
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
		q := db.Where("id = ? AND role = 'employee' AND active", in.EmployeeID)
		if d := agentScope(rp, u); d != nil {
			q = q.Where("department_id = ?", *d)
		}
		if q.First(&agent).Error != nil {
			writeError(w, http.StatusBadRequest, "pick an active agent"+map[bool]string{true: " of your team", false: ""}[rp.teamOnly])
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

// handleConfirmReported: the supervisor agrees with the report as it stands,
// with no QA audit.
func (s *Server) handleConfirmReported(w http.ResponseWriter, r *http.Request) {
	t, _, ok := s.loadTask(w, r)
	var in struct{ Note string }
	if !ok || !decode(w, r, &in) {
		return
	}
	if !t.Kind.Reviewed() || t.State != model.StateReview {
		writeError(w, http.StatusConflict, "only a report waiting for review can be confirmed")
		return
	}
	now := time.Now().UTC()
	none := scorecard.Answers{}
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&model.Task{}).Where("id = ? AND state = 'review'", t.ID).
			Updates(map[string]any{"state": model.StateCompleted, "answers": &none, "completed_at": now})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errConflict
		}
		return s.audit(tx, t.ID, me(r), string(t.Kind)+"_confirmed", model.JSONMap{"reason": strings.TrimSpace(in.Note)})
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
