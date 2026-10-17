package httpapi

import (
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

// ---------- departments ----------

func (s *Server) handleListDepartments(w http.ResponseWriter, r *http.Request) {
	var out []model.Department
	if err := s.db.WithContext(r.Context()).Order("name").Find(&out).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type deptInput struct {
	Name    *string        `json:"name"`
	HRNames *model.Strings `json:"hr_names"`
}

// apply sets the present fields; HR names are trimmed and blanks dropped.
func (in deptInput) apply(d *model.Department) {
	if in.Name != nil {
		d.Name = strings.TrimSpace(*in.Name)
	}
	if in.HRNames != nil {
		d.HRNames = model.Strings{}
		for _, n := range *in.HRNames {
			if n = strings.TrimSpace(n); n != "" {
				d.HRNames = append(d.HRNames, n)
			}
		}
	}
}

func (s *Server) handleCreateDepartment(w http.ResponseWriter, r *http.Request) {
	var in deptInput
	if !decode(w, r, &in) {
		return
	}
	d := model.Department{HRNames: model.Strings{}}
	in.apply(&d)
	if d.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if err := s.db.WithContext(r.Context()).Create(&d).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

func (s *Server) handleUpdateDepartment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	var in deptInput
	if !ok || !decode(w, r, &in) {
		return
	}
	var d model.Department
	if err := s.db.WithContext(r.Context()).First(&d, "id = ?", id).Error; err != nil {
		dbError(w, err)
		return
	}
	in.apply(&d)
	if d.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if err := s.db.WithContext(r.Context()).Select("name", "hr_names").Save(&d).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// handleDeleteDepartment removes a department added by mistake: only an
// empty one, with nobody in it and no task types.
func (s *Server) handleDeleteDepartment(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	if !ok {
		return
	}
	db := s.db.WithContext(r.Context())
	var people, types int64
	db.Model(&model.User{}).Where("department_id = ?", id).Count(&people)
	db.Model(&model.TaskType{}).Where("department_id = ?", id).Count(&types)
	if people > 0 || types > 0 {
		writeError(w, http.StatusConflict, fmt.Sprintf(
			"it still has %d %s and %d task %s: move them to another department or remove them first",
			people, plural(people, "person", "people"), types, plural(types, "type", "types")))
		return
	}
	res := db.Delete(&model.Department{}, "id = ?", id)
	if res.Error != nil {
		dbError(w, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func plural(n int64, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// ---------- users ----------

// canManage: admins manage everyone; a supervisor manages the QA agents and
// employees of their own department.
func canManage(actor *model.User, target model.User) bool {
	if actor.Role == model.RoleAdmin {
		return true
	}
	return actor.Role == model.RoleSupervisor &&
		target.DepartmentID != nil && actor.DepartmentID != nil && *target.DepartmentID == *actor.DepartmentID &&
		(target.Role == model.RoleQA || target.Role == model.RoleEmployee || target.Role == model.RoleNegative || target.Role == model.RoleTeamLeader)
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	q := s.db.WithContext(r.Context()).Order("role, name")
	if d := deptScope(me(r)); d != nil {
		q = q.Where("department_id = ?", *d)
	}
	if role := r.URL.Query().Get("role"); role != "" {
		q = q.Where("role = ?", role)
	}
	var users []model.User
	if err := q.Find(&users).Error; err != nil {
		dbError(w, err)
		return
	}
	out := make([]userView, len(users))
	for i, u := range users {
		out[i] = view(u)
	}
	writeJSON(w, http.StatusOK, out)
}

type userInput struct {
	Name         *string    `json:"name"`
	Email        *string    `json:"email"`
	Role         *string    `json:"role"`
	DepartmentID *uuid.UUID `json:"department_id"`
	AgentCode    *string    `json:"agent_code"`
	Active       *bool      `json:"active"`
	IsAvailable  *bool      `json:"is_available"`
	QueueLimit   *int       `json:"queue_limit"`
	SheetNames   *[]string  `json:"sheet_names"`
	EDeskID      *string    `json:"edesk_id"`
	AliasName    *string    `json:"alias_name"`
	HRID         *string    `json:"hr_id"`
	// Profile: the HR sheet's job details (department, organization,
	// job_title, supervisor); a blank one is cleared.
	Profile *map[string]string `json:"profile"`
}

// apply copies the present fields onto u. Blank email/agent code clear them.
func (in userInput) apply(u *model.User) {
	if in.Name != nil {
		u.Name = strings.TrimSpace(*in.Name)
	}
	if in.Email != nil {
		u.Email = blankToNil(*in.Email)
	}
	if in.Role != nil {
		u.Role = model.Role(*in.Role)
	}
	if in.DepartmentID != nil {
		u.DepartmentID = in.DepartmentID
	}
	if in.AgentCode != nil {
		u.AgentCode = blankToNil(*in.AgentCode)
	}
	if in.Active != nil {
		u.Active = *in.Active
	}
	if in.IsAvailable != nil {
		u.IsAvailable = *in.IsAvailable
	}
	if in.QueueLimit != nil {
		u.QueueLimit = *in.QueueLimit
	}
	if in.EDeskID != nil {
		u.EDeskID = blankToNil(*in.EDeskID)
	}
	if in.SheetNames != nil {
		u.SheetNames = model.Strings{}
		for _, n := range *in.SheetNames {
			if n = strings.TrimSpace(n); n != "" {
				u.SheetNames = append(u.SheetNames, n)
			}
		}
	}
	if in.AliasName != nil {
		u.AliasName = strings.TrimSpace(*in.AliasName)
	}
	if in.HRID != nil {
		u.HRID = blankToNil(*in.HRID)
	}
	if in.Profile != nil {
		p := model.JSONMap{}
		for k, v := range u.Profile {
			p[k] = v
		}
		for _, k := range []string{"department", "organization", "job_title", "supervisor"} {
			if v, ok := (*in.Profile)[k]; ok {
				if v = strings.TrimSpace(v); v == "" {
					delete(p, k)
				} else {
					p[k] = v
				}
			}
		}
		u.Profile = p
	}
	if u.Role == model.RoleAdmin || u.Role == model.RoleViewer {
		u.DepartmentID = nil // every team
	}
}

func blankToNil(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func validUser(u model.User) string {
	switch {
	case u.Name == "":
		return "name is required"
	case !u.Role.Valid():
		return "pick a role"
	case u.Role != model.RoleAdmin && u.Role != model.RoleViewer && u.DepartmentID == nil:
		return "department is required"
	case u.Role != model.RoleEmployee && u.Email == nil:
		return "email is required to sign in"
	case u.QueueLimit < 0:
		return "queue limit cannot be negative"
	}
	return ""
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var in userInput
	if !decode(w, r, &in) {
		return
	}
	u := model.User{Role: model.RoleEmployee, Active: true, IsAvailable: true, QueueLimit: s.cfg(r).DefaultQueueLimit, SheetNames: model.Strings{}, Profile: model.JSONMap{}}
	in.apply(&u)
	actor := me(r)
	if actor.Role == model.RoleSupervisor {
		u.DepartmentID = actor.DepartmentID
	}
	if msg := validUser(u); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if !canManage(actor, u) {
		writeError(w, http.StatusForbidden, "supervisors can add QA agents and employees to their own department only")
		return
	}
	if err := s.db.WithContext(r.Context()).Create(&u).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, view(u))
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	var in userInput
	if !ok || !decode(w, r, &in) {
		return
	}
	actor := me(r)
	var u model.User
	if err := s.db.WithContext(r.Context()).First(&u, "id = ?", id).Error; err != nil {
		dbError(w, err)
		return
	}
	if !canManage(actor, u) {
		writeError(w, http.StatusForbidden, "you cannot edit this user")
		return
	}
	in.apply(&u)
	// The edit must leave the user inside what the actor may manage, so a
	// supervisor cannot promote someone or move them to another department.
	if msg := validUser(u); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if !canManage(actor, u) {
		writeError(w, http.StatusForbidden, "supervisors cannot make anyone a supervisor or admin, or move people to another department")
		return
	}
	if u.ID == actor.ID && !u.Active {
		writeError(w, http.StatusBadRequest, "you cannot deactivate yourself")
		return
	}
	if err := s.db.WithContext(r.Context()).Select("*").Omit("created_at", "password_hash", "must_change_password").Save(&u).Error; err != nil {
		dbError(w, err)
		return
	}
	// Deactivating or taking a QA agent offline changes who can take work.
	s.runAssign(r.Context())
	writeJSON(w, http.StatusOK, view(u))
}

// handleDeleteUser removes someone with no work on record: a duplicate the HR
// sheet created. Anyone with audits, escalations or coaching is deactivated
// instead. An HR employee ID is remembered (Settings), so the next HR upload
// doesn't bring them back.
func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	if !ok {
		return
	}
	actor, db := me(r), s.db.WithContext(r.Context())
	var u model.User
	if err := db.First(&u, "id = ?", id).Error; err != nil {
		dbError(w, err)
		return
	}
	switch {
	case !canManage(actor, u):
		writeError(w, http.StatusForbidden, "you cannot remove this user")
		return
	case u.ID == actor.ID:
		writeError(w, http.StatusBadRequest, "you cannot remove yourself")
		return
	}
	var work int64
	db.Raw(`SELECT (SELECT count(*) FROM tasks WHERE employee_id = @id OR assigned_qa_id = @id OR evaluated_by = @id OR created_by = @id)
	             + (SELECT count(*) FROM coachings WHERE employee_id = @id OR assigned_qa_id = @id OR created_by = @id)
	             + (SELECT count(*) FROM evaluation_changes WHERE requested_by = @id OR decided_by = @id)`,
		map[string]any{"id": u.ID}).Scan(&work)
	if work > 0 {
		writeError(w, http.StatusConflict, fmt.Sprintf("%s has %d audits, escalations or coaching sessions on record, so they can't be removed. Deactivate them instead.", u.Name, work))
		return
	}
	err := db.Transaction(func(tx *gorm.DB) error {
		if u.HRID != nil && *u.HRID != "" {
			cfg := settings.Load(r.Context(), tx)
			if !slices.Contains(cfg.RosterIgnoreIDs, *u.HRID) {
				cfg.RosterIgnoreIDs = append(cfg.RosterIgnoreIDs, *u.HRID)
				if err := settings.Save(r.Context(), tx, cfg, actor.ID); err != nil {
					return err
				}
			}
		}
		return tx.Delete(&model.User{}, "id = ?", u.ID).Error
	})
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSetUserPassword(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	var in struct{ Password string }
	if !ok || !decode(w, r, &in) {
		return
	}
	var u model.User
	if err := s.db.WithContext(r.Context()).First(&u, "id = ?", id).Error; err != nil {
		dbError(w, err)
		return
	}
	if !canManage(me(r), u) {
		writeError(w, http.StatusForbidden, "you cannot set this user's password")
		return
	}
	if u.Email == nil {
		writeError(w, http.StatusBadRequest, "add an email first; it is what they sign in with")
		return
	}
	if _, err := s.authn.SetPassword(r.Context(), u.ID, in.Password, true); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
