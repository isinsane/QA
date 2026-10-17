package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/oaldesi/qa-portal/internal/importer"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

func (s *Server) routesSettings(r chi.Router) {
	admin := s.requireRoles(model.RoleAdmin)
	r.With(admin).Get("/settings", s.handleGetSettings) // view-only accounts too (requireRoles lets them read)
	r.With(admin).Put("/settings", s.handlePutSettings)
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	var meta struct {
		UpdatedAt time.Time
		UpdatedBy *string
	}
	s.db.WithContext(r.Context()).Raw(`SELECT a.updated_at, u.name AS updated_by FROM app_settings a
		LEFT JOIN users u ON u.id = a.updated_by WHERE a.id = 1`).Scan(&meta)
	cfg, defaults := s.cfg(r), settings.Defaults()
	if viewOnly(me(r)) {
		// It signs anyone in who hasn't chosen a password: not for view-only accounts or team leaders.
		cfg.DefaultPassword, defaults.DefaultPassword = "(hidden)", "(hidden)"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settings": cfg, "defaults": defaults, "updated_at": meta.UpdatedAt, "updated_by": meta.UpdatedBy,
	})
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	in := settings.Defaults()
	if !decode(w, r, &in) {
		return
	}
	if err := settings.Save(r.Context(), s.db, in, me(r).ID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Tags and codes now ignored leave the work already imported too.
	if err := importer.StripLabels(r.Context(), s.db, in.IgnoredLabels); err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, in)
}
