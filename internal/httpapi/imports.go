package httpapi

import (
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
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
	r.With(managers).Post("/imports/chats", s.handlePullChats)
}

// yesterday is the default work date: today's upload holds yesterday's work.
func (s *Server) yesterday(r *http.Request) string {
	return time.Now().In(s.cfg(r).TZ()).AddDate(0, 0, -1).Format(time.DateOnly)
}

// handleUpload brings in one day's Vonage sheet. Calls and sales come in one
// sheet, so nobody picks a task type: every active sheet task type the
// uploader runs takes its rows (by its Shared-sheet column, or every row its
// columns fit). The sheet must be from the day picked.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "upload too large or malformed")
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

	var types []model.TaskType
	q := s.db.WithContext(r.Context()).Where("source = ? AND active", model.SourceSheet).Order("name")
	if d := deptScope(me(r)); d != nil {
		q = q.Where("department_id = ?", *d)
	} else if v := r.FormValue("department_id"); v != "" {
		q = q.Where("department_id = ?", v)
	}
	if err := q.Find(&types).Error; err != nil {
		dbError(w, err)
		return
	}
	if len(types) == 0 {
		writeError(w, http.StatusBadRequest, "no active task type takes Vonage sheets yet; add one on Task types")
		return
	}
	type fit struct {
		tt   model.TaskType
		rows []importer.Row
	}
	clock := s.cfg(r).CallClock()
	var fits []fit
	var misfits []string
	for _, tt := range types {
		rows, err := importer.SheetRows(sheet, tt.Columns, clock)
		if err != nil {
			misfits = append(misfits, tt.Name+": "+err.Error())
			continue
		}
		fits = append(fits, fit{tt, rows})
	}
	if len(fits) == 0 {
		writeError(w, http.StatusBadRequest, "This sheet doesn't fit any task type. "+strings.Join(misfits, ". ")+".")
		return
	}
	// Never across teams: an admin says which team's sheet it is.
	var deptIDs []uuid.UUID
	for _, f := range fits {
		if !slices.Contains(deptIDs, f.tt.DepartmentID) {
			deptIDs = append(deptIDs, f.tt.DepartmentID)
		}
	}
	if len(deptIDs) > 1 {
		var names []string
		s.db.WithContext(r.Context()).Model(&model.Department{}).Where("id IN ?", deptIDs).Order("name").Pluck("name", &names)
		writeError(w, http.StatusBadRequest, "This sheet fits task types of several teams ("+strings.Join(names, ", ")+"). Pick the team it is for.")
		return
	}
	if msg := wrongDay(importer.SheetDays(sheet, fits[0].tt.Columns.StartTime, clock), day); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	uid := me(r).ID
	opts := importer.Options{
		Source: "upload", Filename: header.Filename, UserID: &uid,
		DryRun: r.FormValue("dry_run") == "1", Columns: sheet.Headers,
	}
	parts := []sharedPart{}
	for _, f := range fits {
		p := sharedPart{TaskType: f.tt.Name}
		if p.Result, err = importer.Ingest(r.Context(), s.db, f.tt, day, f.rows, opts); err != nil {
			p.Problem = err.Error() // e.g. most rows belong to agents this type doesn't audit
		}
		parts = append(parts, p)
	}
	// Rows no task type takes: a Service name nobody has set up yet.
	unclaimed := map[string]int{}
	for _, row := range sheet.Rows {
		if slices.ContainsFunc(fits, func(f fit) bool { return f.tt.Columns.Takes(row) }) {
			continue
		}
		for _, f := range fits {
			if col := f.tt.Columns.RowColumn; col != "" {
				unclaimed[row[col]]++
				break
			}
		}
	}
	if !opts.DryRun {
		s.runAssign(r.Context())
	}
	writeJSON(w, http.StatusOK, map[string]any{"parts": parts, "unclaimed": unclaimed, "dry_run": opts.DryRun})
}

// wrongDay refuses a sheet from another day than the one picked (yesterday's
// file again, or the wrong date): most of its calls must be on that day.
func wrongDay(days map[string]int, day model.Date) string {
	total := 0
	for _, n := range days {
		total += n
	}
	picked := day.Format(time.DateOnly)
	if total == 0 || days[picked]*2 >= total {
		return ""
	}
	keys := make([]string, 0, len(days))
	for k := range days {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return days[keys[i]] > days[keys[j]] })
	var seen []string
	for _, k := range keys[:min(3, len(keys))] {
		seen = append(seen, fmt.Sprintf("%s (%d calls)", pretty(k), days[k]))
	}
	return fmt.Sprintf("This sheet's calls are from %s, but you picked %s. Pick the day the calls were made, or check you have the right file.",
		strings.Join(seen, ", "), pretty(picked))
}

func pretty(date string) string {
	if t, err := time.Parse(time.DateOnly, date); err == nil {
		return t.Format("Mon, Jan 2, 2006")
	}
	return date
}

// sharedPart is what one upload did for one task type.
type sharedPart struct {
	TaskType string           `json:"task_type"`
	Result   *importer.Result `json:"result,omitempty"`
	Problem  string           `json:"problem,omitempty"`
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

// handlePullChats pulls one reporting day of a live chat task type's closed
// chats from eDesk now (the daily pull does it on its own each morning).
func (s *Server) handlePullChats(w http.ResponseWriter, r *http.Request) {
	if s.chatsPull == nil {
		writeError(w, http.StatusServiceUnavailable, "eDesk is not configured (EDESK_API_TOKEN)")
		return
	}
	var in struct {
		Date       string    `json:"date"`
		TaskTypeID uuid.UUID `json:"task_type_id"`
	}
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
	if s.db.WithContext(r.Context()).First(&tt, "id = ? AND source = ? AND active", in.TaskTypeID, model.SourceEDeskChats).Error != nil ||
		!inScope(me(r), tt.DepartmentID) {
		writeError(w, http.StatusNotFound, "live chat task type not found")
		return
	}
	uid := me(r).ID
	res, err := s.chatsPull(r.Context(), tt, day, &uid)
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
