package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/importer"
	"github.com/oaldesi/qa-portal/internal/model"
)

const maxUploadBytes = 20 << 20

func (s *Server) routesImports(r chi.Router, managers func(http.Handler) http.Handler) {
	r.With(managers).Get("/imports", s.handleListImports)
	r.With(managers).Post("/imports", s.handleUpload)
	r.With(managers).Post("/imports/tickets", s.handlePullTickets)
}

// scopedType loads a task type the caller may work with.
func (s *Server) scopedType(w http.ResponseWriter, r *http.Request, id string) (*model.TaskType, bool) {
	var tt model.TaskType
	if _, err := uuid.Parse(id); err != nil || s.db.WithContext(r.Context()).First(&tt, "id = ?", id).Error != nil ||
		!inScope(me(r), tt.DepartmentID) {
		writeError(w, http.StatusNotFound, "task type not found")
		return nil, false
	}
	return &tt, true
}

// yesterday is the default work date: today's upload holds yesterday's work.
func (s *Server) yesterday(r *http.Request) string {
	return time.Now().In(s.cfg(r).TZ()).AddDate(0, 0, -1).Format(time.DateOnly)
}

// fitsOther names another sheet type of the team the sheet does fit, when
// there is one: the usual slip is picking calls for a sales sheet.
func (s *Server) fitsOther(r *http.Request, tt *model.TaskType, sheet *importer.Sheet) string {
	var others []model.TaskType
	s.db.WithContext(r.Context()).Where("department_id = ? AND source = ? AND active AND id <> ?", tt.DepartmentID, model.SourceSheet, tt.ID).Find(&others)
	for _, o := range others {
		if _, err := importer.SheetRows(sheet, o.Columns, s.cfg(r).CallClock()); err == nil {
			return fmt.Sprintf(" It looks like a %s sheet: pick that task type instead.", o.Name)
		}
	}
	return ""
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "upload too large or malformed")
		return
	}
	tt, ok := s.scopedType(w, r, r.FormValue("task_type_id"))
	if !ok {
		return
	}
	if tt.Source != model.SourceSheet {
		writeError(w, http.StatusBadRequest, "this task type has no sheet to upload")
		return
	}
	day, err := model.ParseDate(r.FormValue("work_date"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "work_date must be YYYY-MM-DD")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "attach the sheet as 'file'")
		return
	}
	defer file.Close()

	sheet, err := importer.ParseSheet(header.Filename, file)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rows, err := importer.SheetRows(sheet, tt.Columns, s.cfg(r).CallClock())
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("This sheet doesn't fit %s: %v.%s", tt.Name, err, s.fitsOther(r, tt, sheet)))
		return
	}
	uid := me(r).ID
	res, err := importer.Ingest(r.Context(), s.db, *tt, day, rows, importer.Options{
		Source: "upload", Filename: header.Filename, UserID: &uid,
		DryRun: r.FormValue("dry_run") == "1", Columns: sheet.Headers,
	})
	if ws := (*importer.WrongSheetError)(nil); errors.As(err, &ws) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !res.DryRun {
		s.runAssign(r.Context())
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handlePullTickets(w http.ResponseWriter, r *http.Request) {
	if s.ticketsPull == nil {
		writeError(w, http.StatusServiceUnavailable, "the tickets API is not configured (QA_API_KEY)")
		return
	}
	var in struct{ Date string }
	if !decode(w, r, &in) {
		return
	}
	if in.Date == "" {
		in.Date = s.yesterday(r)
	}
	day, err := model.ParseDate(in.Date)
	if err != nil {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD")
		return
	}
	var tt model.TaskType
	if err := s.db.WithContext(r.Context()).Where("source = ? AND active", model.SourceTicketsAPI).First(&tt).Error; err != nil {
		writeError(w, http.StatusBadRequest, "create an active task type with source tickets_api first")
		return
	}
	if !inScope(me(r), tt.DepartmentID) {
		writeError(w, http.StatusForbidden, "tickets belong to another department")
		return
	}
	uid := me(r).ID
	res, err := s.ticketsPull(r.Context(), tt, day, &uid)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	s.runAssign(r.Context())
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleListImports(w http.ResponseWriter, r *http.Request) {
	q := s.db.WithContext(r.Context()).Table("import_runs ir").
		Select("ir.*, tt.name AS task_type_name, u.name AS user_name").
		Joins("JOIN task_types tt ON tt.id = ir.task_type_id").
		Joins("LEFT JOIN users u ON u.id = ir.user_id").
		Order("ir.started_at DESC").Limit(100)
	if d := deptScope(me(r)); d != nil {
		q = q.Where("tt.department_id = ?", *d)
	}
	var out []struct {
		model.ImportRun
		TaskTypeName string  `json:"task_type_name"`
		UserName     *string `json:"user_name"`
	}
	if err := q.Scan(&out).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------- roster ----------

// handleImportRoster upserts employees from the HR sheet; see
// importer.ImportRoster. Upload it again whenever HR updates it.
func (s *Server) handleImportRoster(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "upload too large or malformed")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "attach the HR sheet as 'file'")
		return
	}
	defer file.Close()
	sheet, err := importer.ParseSheet(header.Filename, file, importer.RosterHeaders...)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := importer.ImportRoster(r.Context(), s.db, sheet, importer.RosterOptions{
		Scope:             deptScope(me(r)),
		DryRun:            r.FormValue("dry_run") == "1",
		DeactivateMissing: r.FormValue("deactivate_missing") == "1",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !res.DryRun && res.Deactivated > 0 {
		s.runAssign(r.Context())
	}
	writeJSON(w, http.StatusOK, res)
}
