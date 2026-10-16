// Package httpapi is the JSON API behind the web app.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/authn"
	"github.com/oaldesi/qa-portal/internal/importer"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

type Server struct {
	db     *gorm.DB
	authn  *authn.Service
	webDir string

	// Wired in cmd/api. Each is nil-safe: a missing integration disables
	// its feature instead of failing the request.
	assignPass  func(ctx context.Context) error
	ticketsPull func(ctx context.Context, tt model.TaskType, day model.Date, userID *uuid.UUID) (*importer.Result, error)
	edeskTicket func(ctx context.Context, ticketID string) (map[string]any, error)
}

type Options struct {
	WebDir      string
	AssignPass  func(ctx context.Context) error
	TicketsPull func(ctx context.Context, tt model.TaskType, day model.Date, userID *uuid.UUID) (*importer.Result, error)
	EDeskTicket func(ctx context.Context, ticketID string) (map[string]any, error)
}

func NewServer(db *gorm.DB, o Options) *Server {
	return &Server{
		db: db, authn: authn.NewService(db), webDir: o.WebDir,
		assignPass: o.AssignPass, ticketsPull: o.TicketsPull, edeskTicket: o.EDeskTicket,
	}
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP, middleware.Recoverer)
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	if s.webDir != "" {
		r.NotFound(s.serveWeb())
	}

	managers := s.requireRoles(model.RoleAdmin, model.RoleSupervisor)

	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.Timeout(5 * time.Minute))
		r.Post("/login", s.handleLogin)

		r.Group(func(r chi.Router) {
			r.Use(s.requireUser)

			r.Get("/me", s.handleMe)
			r.Post("/me/logout", s.handleLogout)
			r.Patch("/me/password", s.handleChangePassword)

			// Departments are listed for every manager (pickers); only the
			// admin creates or renames them.
			r.With(managers).Get("/departments", s.handleListDepartments)
			r.With(s.requireRoles(model.RoleAdmin)).Post("/departments", s.handleCreateDepartment)
			r.With(s.requireRoles(model.RoleAdmin)).Patch("/departments/{id}", s.handleUpdateDepartment)

			r.With(managers).Get("/users", s.handleListUsers)
			r.With(managers).Post("/users", s.handleCreateUser)
			r.With(managers).Post("/users/import", s.handleImportRoster)
			r.With(managers).Patch("/users/{id}", s.handleUpdateUser)
			r.With(managers).Post("/users/{id}/password", s.handleSetUserPassword)

			s.routesTaskTypes(r, managers)
			s.routesImports(r, managers)
			s.routesTasks(r, managers)
			s.routesReports(r, managers)
			s.routesCoaching(r, managers)
			s.routesSettings(r)
			s.routesReported(r, managers)
		})
	})
	return r
}

// ---------- auth context ----------

type ctxKey struct{}

func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		u, err := s.authn.Authenticate(r.Context(), token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "please sign in again")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

func (s *Server) requireRoles(roles ...model.Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u := me(r)
			for _, role := range roles {
				if u.Role == role {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeError(w, http.StatusForbidden, "you do not have access to this")
		})
	}
}

func me(r *http.Request) *model.User {
	u, _ := r.Context().Value(ctxKey{}).(*model.User)
	return u
}

// deptScope is the department a non-admin is confined to; nil means "all".
// Every list and report query for managers goes through it.
func deptScope(u *model.User) *uuid.UUID {
	if u.Role == model.RoleAdmin {
		return nil
	}
	return u.DepartmentID
}

// inScope reports whether a department is visible to the user.
func inScope(u *model.User, dept uuid.UUID) bool {
	d := deptScope(u)
	return d == nil || *d == dept
}

// ---------- helpers ----------

// cfg is the admin settings, read fresh so an edit applies at once.
func (s *Server) cfg(r *http.Request) settings.Settings { return settings.Load(r.Context(), s.db) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return false
	}
	return true
}

func urlID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
	}
	return id, err == nil
}

// dbError maps a failed write to a readable answer. Unique-constraint names
// are the ones from migrations/00001_init.sql.
func dbError(w http.ResponseWriter, err error) {
	msg := err.Error()
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case strings.Contains(msg, "idx_users_email"):
		writeError(w, http.StatusConflict, "that email is already used by another user")
	case strings.Contains(msg, "idx_users_agent_code"):
		writeError(w, http.StatusConflict, "that Agent ID is already used by another user")
	case strings.Contains(msg, "idx_users_one_supervisor"):
		writeError(w, http.StatusConflict, "this department already has an active supervisor")
	case strings.Contains(msg, "departments_name_key"):
		writeError(w, http.StatusConflict, "a department with that name already exists")
	case strings.Contains(msg, "task_types_code_key"):
		writeError(w, http.StatusConflict, "a task type with that code already exists")
	case strings.Contains(msg, "idx_task_types_one_tickets_api"):
		writeError(w, http.StatusConflict, "another active task type is already fed by the tickets API; deactivate it first")
	case strings.Contains(msg, "task_types_department_id_fkey"):
		writeError(w, http.StatusBadRequest, "pick a department")
	default:
		writeError(w, http.StatusInternalServerError, msg)
	}
}

func (s *Server) audit(tx *gorm.DB, taskID uuid.UUID, actor *model.User, action string, detail model.JSONMap) error {
	log := model.AuditLog{TaskID: &taskID, Action: action, Detail: detail}
	if actor != nil {
		log.ActorID = &actor.ID
	}
	return tx.Create(&log).Error
}

// runAssign kicks the assignment pass after something made work ready.
// Failures are logged by the pass itself; the next tick retries.
func (s *Server) runAssign(ctx context.Context) {
	if s.assignPass != nil {
		_ = s.assignPass(context.WithoutCancel(ctx))
	}
}
