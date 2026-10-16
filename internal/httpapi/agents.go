package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/model"
)

// Agents: every active agent in every team, for QA agents, supervisors and
// admins, with their numbers for a period. One agent's analysis page reads
// /reports?employee_id= (open across teams for that).
func (s *Server) routesAgents(r chi.Router) {
	who := s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)
	r.With(who).Get("/agents", s.handleAgents)
	r.With(who).Get("/agents/export", s.handleExport)
	r.With(who).Get("/agents/{id}", s.handleAgent)
}

type agentRow struct {
	ID           uuid.UUID   `json:"id"`
	Name         string      `json:"name"`
	AliasName    string      `json:"alias_name"`
	Team         string      `json:"team"`
	DepartmentID *uuid.UUID  `json:"department_id"`
	HRDepartment string      `json:"hr_department"`
	JobTitle     string      `json:"job_title"`
	Evaluations  int         `json:"evaluations"`
	AvgScore     *float64    `json:"avg_score"`
	PassRate     *float64    `json:"pass_rate"`
	Escalations  int         `json:"escalations"` // valid ones
	LastAudit    *model.Date `json:"last_audit"`
}

// periodOf reads from/to (work dates), defaulting to this month so far.
func (s *Server) periodOf(r *http.Request) (string, string) {
	p := r.URL.Query()
	now := time.Now().In(s.cfg(r).TZ())
	from, to := p.Get("from"), p.Get("to")
	if from == "" {
		from = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).Format(time.DateOnly)
	}
	if to == "" {
		to = now.Format(time.DateOnly)
	}
	return from, to
}

func (s *Server) agentRows(r *http.Request, from, to string) ([]agentRow, error) {
	q := s.db.WithContext(r.Context()).Table("users e").
		Select(`e.id, e.name, e.alias_name, coalesce(d.name, '') AS team, e.department_id,
		        coalesce(e.profile->>'department', '') AS hr_department, coalesce(e.profile->>'job_title', '') AS job_title,
		        count(t.id) FILTER (WHERE t.kind IN `+model.CountedKinds+`) AS evaluations,
		        round(avg(t.score) FILTER (WHERE t.kind IN `+model.CountedKinds+`), 1) AS avg_score,
		        round(100.0 * avg(CASE WHEN t.result = 'pass' THEN 1 ELSE 0 END) FILTER (WHERE t.kind IN `+model.CountedKinds+`), 1) AS pass_rate,
		        count(t.id) FILTER (WHERE t.kind IN `+model.ReviewedKinds+`) AS escalations,
		        max(t.work_date) FILTER (WHERE t.kind IN `+model.CountedKinds+`) AS last_audit`).
		Joins("LEFT JOIN departments d ON d.id = e.department_id").
		Joins("LEFT JOIN tasks t ON t.employee_id = e.id AND t.state = 'completed' AND t.work_date BETWEEN ? AND ?", from, to).
		Where("e.role = 'employee' AND e.active").
		Group("e.id, d.name").Order("e.name")
	p := r.URL.Query()
	if u := me(r); u.Role == model.RoleTeamLeader { // their own team's agents only
		q = q.Where("e.department_id = ?", deptScope(u))
	}
	if v := p.Get("department_id"); v != "" {
		q = q.Where("e.department_id = ?", v)
	}
	if v := strings.TrimSpace(p.Get("q")); v != "" {
		like := "%" + v + "%"
		q = q.Where("e.name ILIKE ? OR e.alias_name ILIKE ?", like, like)
	}
	if ids := p.Get("ids"); ids != "" {
		q = q.Where("e.id IN ?", strings.Split(ids, ","))
	}
	rows := []agentRow{}
	return rows, q.Scan(&rows).Error
}

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	from, to := s.periodOf(r)
	rows, err := s.agentRows(r, from, to)
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"from": from, "to": to, "agents": rows})
}

// handleAgent is the head of an agent's page: who they are.
func (s *Server) handleAgent(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	if !ok {
		return
	}
	var u model.User
	if s.db.WithContext(r.Context()).First(&u, "id = ? AND role = 'employee'", id).Error != nil ||
		(me(r).Role == model.RoleTeamLeader && (u.DepartmentID == nil || !inScope(me(r), *u.DepartmentID))) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	var team string
	if u.DepartmentID != nil {
		s.db.WithContext(r.Context()).Raw("SELECT name FROM departments WHERE id = ?", *u.DepartmentID).Scan(&team)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": u.ID, "name": u.Name, "alias_name": u.AliasName, "email": u.Email, "agent_code": u.AgentCode,
		"active": u.Active, "team": team, "profile": u.Profile,
	})
}
