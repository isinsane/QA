package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
)

// The audits that don't come from daily sampling — live monitoring, focus
// plans, supervisor escalations — and the agent's acknowledgement or
// dispute of an evaluation.

// handleTeamAgents lists the agents of the QA agent's team, for pickers.
func (s *Server) handleTeamAgents(w http.ResponseWriter, r *http.Request) {
	var out []struct {
		ID         uuid.UUID `json:"id"`
		Name       string    `json:"name"`
		AliasName  string    `json:"alias_name"`
		Department string    `json:"department"`
	}
	err := s.db.WithContext(r.Context()).Model(&model.User{}).Select("id, name, alias_name, coalesce(profile->>'department', '') AS department").
		Where("role = 'employee' AND active AND department_id = ?", me(r).DepartmentID).Order("name").Scan(&out).Error
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// teamType loads a task type of the caller's team; agentOf checks the agent.
func (s *Server) teamType(w http.ResponseWriter, r *http.Request, id uuid.UUID) (*model.TaskType, bool) {
	var tt model.TaskType
	if s.db.WithContext(r.Context()).First(&tt, "id = ? AND active", id).Error != nil || !inScope(me(r), tt.DepartmentID) ||
		(me(r).Role == model.RoleQA && (me(r).DepartmentID == nil || *me(r).DepartmentID != tt.DepartmentID)) {
		writeError(w, http.StatusNotFound, "task type not found")
		return nil, false
	}
	return &tt, true
}

func (s *Server) agentOf(w http.ResponseWriter, r *http.Request, id uuid.UUID) (*model.User, bool) {
	var u model.User
	if s.db.WithContext(r.Context()).First(&u, "id = ? AND active", id).Error != nil {
		writeError(w, http.StatusBadRequest, "pick an active agent")
		return nil, false
	}
	return &u, true
}

// agentFits refuses an agent the task type doesn't audit (a sales agent for
// a calls type, say).
func agentFits(w http.ResponseWriter, tt *model.TaskType, agent *model.User) bool {
	if tt.Audits(*agent) {
		return true
	}
	writeError(w, http.StatusBadRequest, fmt.Sprintf("%s is in %s, which isn't audited under %s", agent.Name, agent.Department(), tt.Name))
	return false
}

func nextPosition(tx *gorm.DB, qaID uuid.UUID) int {
	var pos int
	tx.Raw("SELECT coalesce(max(queue_position), 0) + 1 FROM tasks WHERE assigned_qa_id = ? AND state = 'assigned'", qaID).Scan(&pos)
	return pos
}

// handleStartLive stamps the start of a live-monitoring audit. The call is
// matched when that day's Vonage sheet is uploaded.
func (s *Server) handleStartLive(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskTypeID uuid.UUID         `json:"task_type_id"`
		EmployeeID uuid.UUID         `json:"employee_id"`
		Details    map[string]string `json:"details"`
	}
	if !decode(w, r, &in) {
		return
	}
	tt, ok := s.teamType(w, r, in.TaskTypeID)
	if !ok {
		return
	}
	if tt.Source != model.SourceSheet || tt.Columns.StartTime == "" {
		writeError(w, http.StatusBadRequest, "live monitoring is for call types (a Vonage sheet with a start time)")
		return
	}
	details := liveDetails(tt, s.liveFields(r, tt), in.Details)
	agent, ok := s.agentOf(w, r, in.EmployeeID)
	if !ok || !agentFits(w, tt, agent) {
		return
	}
	u := me(r)
	now := time.Now().UTC()
	day := now.In(s.cfg(r).CallClock())
	t := model.Task{
		TaskTypeID: tt.ID, EmployeeID: agent.ID, ExternalID: "live-" + uuid.NewString()[:8],
		WorkDate: model.Date{Time: time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)},
		Labels:   liveLabels(details, tt.Columns.Label), Data: model.JSONMap{"live_entered": details}, State: model.StateAssigned,
		AssignedQAID: &u.ID, AssignedAt: &now, Kind: model.KindLive, Priority: 5, CreatedBy: &u.ID,
		LiveStartedAt: &now, MatchStatus: "pending",
	}
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		pos := nextPosition(tx, u.ID)
		t.QueuePosition = &pos
		if err := tx.Create(&t).Error; err != nil {
			return err
		}
		return s.audit(tx, t.ID, u, "live_started", model.JSONMap{"agent": agent.Name})
	})
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": t.ID, "live_started_at": now})
}

// liveFields are the sheet columns a QA agent types in for a live audit: the
// latest upload's columns, minus the call ID, agent and start time (the
// portal has those) and the ones the settings hide (Vonage fills them in).
// liveExtras are asked on every live audit after the sheet's own columns.
// (Order numbers have their own box on every audit.)
var liveExtras = []string{"Phone number"}

func (s *Server) liveFields(r *http.Request, tt *model.TaskType) []string {
	var cols model.Strings
	_ = s.db.WithContext(r.Context()).Raw(`SELECT detail->'columns' FROM import_runs
		WHERE task_type_id = ? AND jsonb_typeof(detail->'columns') = 'array' ORDER BY started_at DESC LIMIT 1`, tt.ID).Row().Scan(&cols)
	own := map[string]bool{tt.Columns.ExternalID: true, tt.Columns.AgentCode: true, tt.Columns.AgentName: true, tt.Columns.StartTime: true,
		tt.Columns.RowColumn: true} // the service name: always the type's own (liveDetails)
	for _, c := range s.cfg(r).LiveHiddenColumns {
		own[c] = true
	}
	out := []string{}
	for _, c := range cols {
		if !own[c] {
			out = append(out, c)
		}
	}
	if len(out) == 0 && tt.Columns.Label != "" {
		out = []string{tt.Columns.Label}
	}
	for _, x := range liveExtras {
		if !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

// liveDetails keeps the entered details of the live fields, trimmed. None is
// required: the QA agent fills them in as the call goes, the code often only
// at its end. A type that takes one service from a shared sheet (calls:
// "Other Sales") gets that service name without asking.
func liveDetails(tt *model.TaskType, fields []string, in map[string]string) model.JSONMap {
	out := model.JSONMap{}
	for _, f := range fields {
		out[f] = strings.TrimSpace(in[f])
	}
	if c := tt.Columns.RowColumn; c != "" && len(tt.Columns.RowValues) > 0 {
		out[c] = tt.Columns.RowValues[0]
	}
	return out
}

func liveLabels(details model.JSONMap, label string) model.Strings {
	if v, _ := details[label].(string); v != "" {
		return model.Strings{v}
	}
	return model.Strings{}
}

func (s *Server) handleLiveFields(w http.ResponseWriter, r *http.Request) {
	id, ok := urlID(w, r)
	if !ok {
		return
	}
	tt, ok := s.teamType(w, r, id)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fields": s.liveFields(r, tt), "label": tt.Columns.Label})
}

// handleLiveDetails corrects the call details of a live audit still in the
// QA agent's queue (the code is often only known when the call ends).
func (s *Server) handleLiveDetails(w http.ResponseWriter, r *http.Request) {
	t, tt, ok := s.loadTask(w, r)
	if !ok {
		return
	}
	if t.Kind != model.KindLive || t.State != model.StateAssigned || t.AssignedQAID == nil || *t.AssignedQAID != me(r).ID {
		writeError(w, http.StatusConflict, "only the QA agent running this live audit can change its call details")
		return
	}
	var in struct {
		Details map[string]string `json:"details"`
	}
	if !decode(w, r, &in) {
		return
	}
	details := liveDetails(tt, s.liveFields(r, tt), in.Details)
	raw, _ := json.Marshal(details)
	updates := map[string]any{"data": gorm.Expr("data || jsonb_build_object('live_entered', ?::jsonb)", string(raw))}
	if t.MatchStatus != "matched" {
		updates["labels"] = liveLabels(details, tt.Columns.Label)
	}
	if err := s.db.WithContext(r.Context()).Model(&model.Task{}).Where("id = ?", t.ID).Updates(updates).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleFocusLabels lists the tags/codes an agent's not-yet-audited work has
// in a date range, for the focus-plan picker.
func (s *Server) handleFocusLabels(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query()
	typeID, err1 := uuid.Parse(p.Get("task_type_id"))
	agentID, err2 := uuid.Parse(p.Get("employee_id"))
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusBadRequest, "task_type_id and employee_id are required")
		return
	}
	if _, ok := s.teamType(w, r, typeID); !ok {
		return
	}
	var out []struct {
		Label string `json:"label"`
		Rows  int    `json:"rows"`
	}
	err := s.db.WithContext(r.Context()).Raw(`
		SELECT l AS label, count(*) AS rows FROM tasks, jsonb_array_elements_text(labels) AS l
		WHERE task_type_id = ? AND employee_id = ? AND state = 'unsampled' AND kind = 'sample'
		  AND work_date BETWEEN ? AND ?
		GROUP BY l ORDER BY count(*) DESC, l`, typeID, agentID, p.Get("from"), p.Get("to")).Scan(&out).Error
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleFocusPlan pulls X not-yet-audited interactions of one agent, all
// with the same tag/code, into the QA agent's own queue. They don't count in
// the agent's scores.
func (s *Server) handleFocusPlan(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskTypeID uuid.UUID `json:"task_type_id"`
		EmployeeID uuid.UUID `json:"employee_id"`
		Label      string    `json:"label"`
		Count      int       `json:"count"`
		From, To   string
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Count < 1 || in.Count > 50 || strings.TrimSpace(in.Label) == "" {
		writeError(w, http.StatusBadRequest, "pick a tag/code and between 1 and 50 interactions")
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
	u := me(r)
	note := "Focus plan: " + in.Label
	var pulled int64
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		var ids []uuid.UUID
		if err := tx.Raw(`
			SELECT id FROM tasks
			WHERE task_type_id = ? AND employee_id = ? AND state = 'unsampled' AND kind = 'sample'
			  AND work_date BETWEEN ? AND ? AND labels @> jsonb_build_array(?::text)
			ORDER BY random() LIMIT ?`, tt.ID, agent.ID, in.From, in.To, in.Label, in.Count).Scan(&ids).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		pos := nextPosition(tx, u.ID)
		for i, id := range ids {
			res := tx.Model(&model.Task{}).Where("id = ? AND state = 'unsampled'", id).Updates(map[string]any{
				"kind": model.KindFocus, "state": model.StateAssigned, "assigned_qa_id": u.ID, "assigned_at": now,
				"queue_position": pos + i, "created_by": u.ID, "note": note,
			})
			if res.Error != nil {
				return res.Error
			}
			pulled += res.RowsAffected
			if err := s.audit(tx, id, u, "focus_plan", model.JSONMap{"label": in.Label}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pulled": pulled, "asked": in.Count})
}

// handleEscalate is a supervisor sending one interaction to the quality
// team. It goes to the top of a QA agent's queue, past the queue cap.
func (s *Server) handleEscalate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TaskTypeID uuid.UUID `json:"task_type_id"`
		ExternalID string    `json:"external_id"`
		EmployeeID uuid.UUID `json:"employee_id"`
		Reason     string    `json:"reason"`
		Error      string    `json:"error"` // the escalation form's name for it
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Reason == "" {
		in.Reason = in.Error
	}
	in.ExternalID, in.Reason = strings.TrimSpace(in.ExternalID), strings.TrimSpace(in.Reason)
	if in.ExternalID == "" || in.Reason == "" {
		writeError(w, http.StatusBadRequest, "the call/ticket ID and a reason are required")
		return
	}
	// Any agent of any team: it goes to a QA agent of the agent's team.
	tt := &model.TaskType{}
	if s.db.WithContext(r.Context()).First(tt, "id = ? AND active", in.TaskTypeID).Error != nil {
		writeError(w, http.StatusNotFound, "task type not found")
		return
	}
	agent, ok := s.agentOf(w, r, in.EmployeeID)
	if !ok || !agentFits(w, tt, agent) {
		return
	}
	if agent.DepartmentID == nil || *agent.DepartmentID != tt.DepartmentID { // their team's QA agents and supervisor only
		writeError(w, http.StatusBadRequest, fmt.Sprintf("%s isn't on the team that audits %s: pick one of their own team's task types", agent.Name, tt.Name))
		return
	}
	u := me(r)
	escalated := map[string]any{
		"kind": model.KindEscalation, "priority": 10, "note": in.Reason, "created_by": u.ID,
	}
	var task model.Task
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		err := tx.Where("task_type_id = ? AND external_id = ? AND employee_id = ? AND kind <> 'rotation'",
			tt.ID, in.ExternalID, agent.ID).First(&task).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			now := time.Now().In(s.cfg(r).TZ())
			task = model.Task{
				TaskTypeID: tt.ID, EmployeeID: agent.ID, ExternalID: in.ExternalID,
				WorkDate: model.Date{Time: time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)},
				Labels:   model.Strings{}, Data: model.JSONMap{}, State: model.StateReady,
				Kind: model.KindEscalation, Priority: 10, Note: in.Reason, CreatedBy: &u.ID,
			}
			if err := tx.Create(&task).Error; err != nil {
				return err
			}
		case err != nil:
			return err
		case task.State == model.StateCompleted:
			return errAlreadyAudited
		default:
			if task.State == model.StateUnsampled || task.State == model.StateCancelled {
				escalated["state"] = model.StateReady
				escalated["cancel_reason"] = ""
			}
			if err := tx.Model(&task).Updates(escalated).Error; err != nil {
				return err
			}
		}
		return s.audit(tx, task.ID, u, "escalated", model.JSONMap{"reason": in.Reason})
	})
	if errors.Is(err, errAlreadyAudited) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "this interaction was already audited", "task_id": task.ID})
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	s.runAssign(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"task_id": task.ID, "task_type": tt.Name})
}

var errAlreadyAudited = errors.New("already audited")

// ---------- the agent's answer to an evaluation ----------

func (s *Server) handleAcknowledge(w http.ResponseWriter, r *http.Request) {
	s.agentAnswer(w, r, "acknowledged", false)
}

func (s *Server) handleDispute(w http.ResponseWriter, r *http.Request) {
	s.agentAnswer(w, r, "disputed", true)
}

func (s *Server) agentAnswer(w http.ResponseWriter, r *http.Request, status string, needText bool) {
	t, _, ok := s.loadTask(w, r)
	var in struct{ Comment string }
	if !ok || !decode(w, r, &in) {
		return
	}
	in.Comment = strings.TrimSpace(in.Comment)
	if needText && in.Comment == "" {
		writeError(w, http.StatusBadRequest, "say why you disagree")
		return
	}
	if t.Kind.Reviewed() {
		writeError(w, http.StatusConflict, "escalations are for your information; there is nothing to answer")
		return
	}
	if t.AckStatus != "" {
		writeError(w, http.StatusConflict, "you already answered this evaluation")
		return
	}
	u := me(r)
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(t).Updates(map[string]any{
			"ack_status": status, "ack_comment": in.Comment, "ack_at": time.Now().UTC(),
		}).Error; err != nil {
			return err
		}
		return s.audit(tx, t.ID, u, status, model.JSONMap{"comment": in.Comment})
	})
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ack_status": status})
}

// canAnswerDispute: the supervisor at any stage of a dispute; the QA agent
// who scored it once the supervisor has sent it to them.
func canAnswerDispute(u *model.User, t *model.Task) bool {
	switch t.AckStatus {
	case "disputed":
		return isManager(u)
	case "dispute_qa":
		return isManager(u) || (u.Role == model.RoleQA && t.EvaluatedBy != nil && *t.EvaluatedBy == u.ID)
	}
	return false
}

// handleForwardDispute sends a dispute the supervisor has looked at on to the
// QA agent who scored it.
func (s *Server) handleForwardDispute(w http.ResponseWriter, r *http.Request) {
	t, _, ok := s.loadTask(w, r)
	var in struct{ Note string }
	if !ok || !decode(w, r, &in) {
		return
	}
	if t.AckStatus != "disputed" || t.EvaluatedBy == nil {
		writeError(w, http.StatusConflict, "only a dispute still with the supervisor can be sent to QA")
		return
	}
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(t).Update("ack_status", "dispute_qa").Error; err != nil {
			return err
		}
		return s.audit(tx, t.ID, me(r), "dispute_forwarded", model.JSONMap{"reason": strings.TrimSpace(in.Note)})
	})
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ack_status": "dispute_qa"})
}

// handleUphold keeps a disputed score as it is. (Accepting a dispute is
// editing the evaluation; see handleEditEvaluation.)
func (s *Server) handleUphold(w http.ResponseWriter, r *http.Request) {
	t, _, ok := s.loadTask(w, r)
	var in struct{ Comment string }
	if !ok || !decode(w, r, &in) {
		return
	}
	if !canAnswerDispute(me(r), t) {
		writeError(w, http.StatusConflict, "this dispute isn't yours to answer")
		return
	}
	if strings.TrimSpace(in.Comment) == "" {
		writeError(w, http.StatusBadRequest, "explain to the agent why the score stands")
		return
	}
	u := me(r)
	err := s.db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(t).Updates(map[string]any{
			"ack_status": "upheld", "dispute_resolution": strings.TrimSpace(in.Comment),
			"dispute_resolved_by": u.ID, "dispute_resolved_at": time.Now().UTC(),
		}).Error; err != nil {
			return err
		}
		return s.audit(tx, t.ID, u, "dispute_upheld", model.JSONMap{"reason": in.Comment})
	})
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ack_status": "upheld"})
}
