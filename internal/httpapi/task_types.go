package httpapi

import (
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
)

func (s *Server) routesTaskTypes(r chi.Router, managers func(http.Handler) http.Handler) {
	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)).Get("/task-types", s.handleListTaskTypes)
	r.With(managers).Post("/task-types", s.handleCreateTaskType)
	r.With(managers).Patch("/task-types/{id}", s.handleUpdateTaskType)
	r.With(s.requireRoles(model.RoleAdmin, model.RoleSupervisor, model.RoleQA)).Get("/task-types/{id}/labels", s.handleTaskTypeLabels)
}

func (s *Server) handleListTaskTypes(w http.ResponseWriter, r *http.Request) {
	q := s.db.WithContext(r.Context()).Order("name")
	if d := deptScope(me(r)); d != nil {
		q = q.Where("department_id = ?", *d)
	}
	var out []model.TaskType
	if err := q.Find(&out).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

var codePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,40}$`)

func (s *Server) handleCreateTaskType(w http.ResponseWriter, r *http.Request) {
	var in struct {
		// A string, not a uuid.UUID: a supervisor's form has no team picker
		// and sends "", which a UUID field would reject as a bad body.
		DepartmentID string `json:"department_id"`
		Code, Name   string
		Source       string
	}
	if !decode(w, r, &in) {
		return
	}
	// A supervisor creates types for their own department only; an admin
	// picks one.
	var dept uuid.UUID
	if d := deptScope(me(r)); d != nil {
		dept = *d
	} else if id, err := uuid.Parse(in.DepartmentID); err == nil &&
		s.db.WithContext(r.Context()).First(&model.Department{}, "id = ?", id).Error == nil {
		dept = id
	} else {
		writeError(w, http.StatusBadRequest, "pick the team this task type belongs to")
		return
	}
	d := s.cfg(r).NewTaskType
	tt := model.TaskType{
		DepartmentID: dept, Code: strings.TrimSpace(in.Code), Name: strings.TrimSpace(in.Name),
		Source: in.Source, Active: true, Scorecard: scorecard.Card{},
		PassThreshold: d.PassThreshold, BorderlineThreshold: d.BorderlineThreshold, SamplePercent: d.SamplePercent,
		UntaggedPercent: d.UntaggedPercent, RotationDays: d.RotationDays,
		SkipLabels: model.Strings{}, IgnoreLabels: model.Strings{}, AgentGroups: model.Strings{},
	}
	count := func(n int) *model.Limit {
		if n <= 0 {
			return nil
		}
		return &model.Limit{Value: float64(n), Unit: "count"}
	}
	tt.AgentLimits.Day.Min, tt.AgentLimits.Day.Max, tt.AgentLimits.Week.Max = count(d.MinPerAgentPerDay), count(d.MaxPerAgentPerDay), count(d.MaxPerAgentPerWeek)
	switch {
	case tt.Name == "":
		writeError(w, http.StatusBadRequest, "name is required")
		return
	case !codePattern.MatchString(tt.Code):
		writeError(w, http.StatusBadRequest, "code must be lowercase letters, digits and underscores, e.g. calls_audit")
		return
	case tt.Source != model.SourceSheet && tt.Source != model.SourceTicketsAPI && tt.Source != model.SourceManual:
		writeError(w, http.StatusBadRequest, "source must be sheet, tickets_api or manual")
		return
	}
	if tt.Source == model.SourceSheet {
		tt.Columns = model.VonageColumns
	}
	if err := s.db.WithContext(r.Context()).Create(&tt).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, tt)
}

func (s *Server) handleUpdateTaskType(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	var in struct {
		Name                *string            `json:"name"`
		Active              *bool              `json:"active"`
		Scorecard           *scorecard.Card    `json:"scorecard"`
		PassThreshold       *int               `json:"pass_threshold"`
		SamplePercent       *float64           `json:"sample_percent"`
		SkipLabels          *model.Strings     `json:"skip_labels"`
		IgnoreLabels        *model.Strings     `json:"ignore_labels"`
		UntaggedPercent     *float64           `json:"untagged_percent"`
		BorderlineThreshold *int               `json:"borderline_threshold"`
		RotationEnabled     *bool              `json:"rotation_enabled"`
		RotationDays        *int               `json:"rotation_days"`
		Columns             *model.Columns     `json:"columns"`
		AgentLimits         *model.AgentLimits `json:"agent_limits"`
		AgentGroups         *model.Strings     `json:"agent_groups"`
	}
	if !ok || !decode(w, r, &in) {
		return
	}
	var tt model.TaskType
	if err := s.db.WithContext(r.Context()).First(&tt, "id = ?", id).Error; err != nil {
		dbError(w, err)
		return
	}
	u := me(r)
	if !inScope(u, tt.DepartmentID) {
		writeError(w, http.StatusForbidden, "this task type belongs to another department")
		return
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) != "" {
		tt.Name = strings.TrimSpace(*in.Name)
	}
	if in.Active != nil {
		tt.Active = *in.Active
	}
	if in.Scorecard != nil {
		if err := scorecard.Validate(*in.Scorecard); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		tt.Scorecard = *in.Scorecard
	}
	if in.PassThreshold != nil {
		tt.PassThreshold = *in.PassThreshold
	}
	if in.SamplePercent != nil {
		tt.SamplePercent = *in.SamplePercent
	}
	if in.SkipLabels != nil {
		tt.SkipLabels = *in.SkipLabels
	}
	if in.IgnoreLabels != nil {
		tt.IgnoreLabels = *in.IgnoreLabels
	}
	if in.UntaggedPercent != nil {
		tt.UntaggedPercent = *in.UntaggedPercent
	}
	if in.BorderlineThreshold != nil {
		tt.BorderlineThreshold = *in.BorderlineThreshold
	}
	if in.RotationEnabled != nil {
		tt.RotationEnabled = *in.RotationEnabled
	}
	if in.RotationDays != nil {
		tt.RotationDays = *in.RotationDays
	}
	if in.Columns != nil {
		c := *in.Columns
		c.RowColumn = strings.TrimSpace(c.RowColumn)
		values := []string{}
		for _, v := range c.RowValues {
			if v = strings.TrimSpace(v); v != "" && !slices.ContainsFunc(values, func(x string) bool { return strings.EqualFold(x, v) }) {
				values = append(values, v)
			}
		}
		c.RowValues = values
		if c.RowColumn != "" && len(values) == 0 {
			writeError(w, http.StatusBadRequest, "list the "+c.RowColumn+" values this task type takes, or clear the column")
			return
		}
		if c.RowColumn == "" {
			c.RowValues = nil
		}
		tt.Columns = c
	}
	if in.AgentGroups != nil {
		groups := model.Strings{}
		for _, g := range *in.AgentGroups {
			if g = strings.TrimSpace(g); g != "" && !slices.ContainsFunc(groups, func(x string) bool { return strings.EqualFold(x, g) }) {
				groups = append(groups, g)
			}
		}
		tt.AgentGroups = groups
	}
	if in.AgentLimits != nil {
		if err := in.AgentLimits.Validate(); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		tt.AgentLimits = *in.AgentLimits
	}
	switch {
	case tt.PassThreshold < 0 || tt.PassThreshold > 100:
		writeError(w, http.StatusBadRequest, "pass threshold must be 0-100")
		return
	case tt.SamplePercent <= 0 || tt.SamplePercent > 100:
		writeError(w, http.StatusBadRequest, "sample % must be above 0 and at most 100")
		return
	case tt.BorderlineThreshold < 0 || tt.BorderlineThreshold > tt.PassThreshold:
		writeError(w, http.StatusBadRequest, "borderline % must be between 0 and the pass %")
		return
	case tt.UntaggedPercent < 0 || tt.UntaggedPercent > 100:
		writeError(w, http.StatusBadRequest, "untagged % must be 0-100")
		return
	case tt.RotationDays < 1:
		writeError(w, http.StatusBadRequest, "rotation days must be at least 1")
		return
	}
	if err := s.db.WithContext(r.Context()).Select("*").Omit("created_at").Save(&tt).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tt)
}

// handleTaskTypeLabels lists the codes/tags seen recently, for the skip-list
// picker.
func (s *Server) handleTaskTypeLabels(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	if !ok {
		return
	}
	var tt model.TaskType
	if err := s.db.WithContext(r.Context()).First(&tt, "id = ?", id).Error; err != nil || !inScope(me(r), tt.DepartmentID) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var out []struct {
		Label string `json:"label"`
		Rows  int    `json:"rows"`
	}
	err := s.db.WithContext(r.Context()).Raw(`
		SELECT l AS label, count(*) AS rows
		FROM tasks, jsonb_array_elements_text(labels) AS l
		WHERE task_type_id = ? AND work_date > current_date - 60
		GROUP BY l ORDER BY count(*) DESC`, id).Scan(&out).Error
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
