package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/scorecard"
)

// A QA agent's change to the score of an audit they submitted waits here for
// a supervisor (handleEditEvaluation); notes-only edits never do.
func (s *Server) routesChanges(r chi.Router, managers func(http.Handler) http.Handler) {
	r.With(managers).Get("/evaluation-changes", s.handleListChanges)
	r.With(managers).Post("/evaluation-changes/{id}/approve", s.handleDecideChange(true))
	r.With(managers).Post("/evaluation-changes/{id}/reject", s.handleDecideChange(false))
}

type changeRow struct {
	ID              uuid.UUID          `json:"id"`
	TaskID          uuid.UUID          `json:"task_id"`
	Answers         *scorecard.Answers `json:"answers,omitempty"`
	Reason          string             `json:"reason"`
	ScoreBefore     *float64           `json:"score_before"`
	Score           *float64           `json:"score"`
	Status          string             `json:"status"`
	DecisionNote    string             `json:"decision_note"`
	CreatedAt       time.Time          `json:"created_at"`
	DecidedAt       *time.Time         `json:"decided_at"`
	RequestedByName string             `json:"requested_by_name"`
	DecidedByName   string             `json:"decided_by_name"`
	// For the list: which audit.
	ExternalID   string     `json:"external_id,omitempty"`
	WorkDate     model.Date `json:"work_date"`
	EmployeeName string     `json:"employee_name,omitempty"`
	TaskTypeName string     `json:"task_type_name,omitempty"`
	AckStatus    string     `json:"ack_status,omitempty"`
}

func (s *Server) changeRows(r *http.Request) *gorm.DB {
	return s.db.WithContext(r.Context()).Table("evaluation_changes c").
		Select(`c.id, c.task_id, c.reason, c.score_before, c.score, c.status, c.decision_note, c.created_at, c.decided_at,
		        rq.name AS requested_by_name, coalesce(dc.name, '') AS decided_by_name,
		        t.external_id, t.work_date, e.name AS employee_name, tt.name AS task_type_name, t.ack_status`).
		Joins("JOIN tasks t ON t.id = c.task_id").
		Joins("JOIN task_types tt ON tt.id = t.task_type_id").
		Joins("JOIN users e ON e.id = t.employee_id").
		Joins("JOIN users rq ON rq.id = c.requested_by").
		Joins("LEFT JOIN users dc ON dc.id = c.decided_by")
}

// handleListChanges: ?status=pending (default, oldest first), approved or rejected.
func (s *Server) handleListChanges(w http.ResponseWriter, r *http.Request) {
	q := s.changeRows(r)
	if d := deptScope(me(r)); d != nil {
		q = q.Where("tt.department_id = ?", *d)
	}
	status, order := r.URL.Query().Get("status"), "c.decided_at DESC"
	if status == "" || status == "pending" {
		status, order = "pending", "c.created_at"
	}
	q = q.Where("c.status = ?", status)
	var total int64
	if err := q.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		dbError(w, err)
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	page = max(page, 1)
	var rows []changeRow
	if err := q.Order(order).Offset((page - 1) * 50).Limit(50).Scan(&rows).Error; err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"changes": rows, "total": total, "page_size": 50})
}

func (s *Server) handleDecideChange(approve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := urlID(w, r)
		var in struct {
			Note string `json:"note"`
		}
		if !ok || !decode(w, r, &in) {
			return
		}
		u, db := me(r), s.db.WithContext(r.Context())
		var ch model.EvaluationChange
		var t model.Task
		var tt model.TaskType
		if db.First(&ch, "id = ?", id).Error != nil || db.First(&t, "id = ?", ch.TaskID).Error != nil ||
			db.First(&tt, "id = ?", t.TaskTypeID).Error != nil || !inScope(u, tt.DepartmentID) {
			writeError(w, http.StatusNotFound, "change not found")
			return
		}
		note := strings.TrimSpace(in.Note)
		if !approve && note == "" {
			writeError(w, http.StatusBadRequest, "say why, for the QA agent")
			return
		}
		var res scorecard.Result
		if approve {
			if t.State != model.StateCompleted || t.Scorecard == nil || ch.Answers == nil {
				writeError(w, http.StatusConflict, "this audit can't be changed any more")
				return
			}
			var err error
			if res, err = scorecard.Score(*t.Scorecard, *ch.Answers, thresholds(&tt)); err != nil {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
		}
		status := map[bool]string{true: "approved", false: "rejected"}[approve]
		err := db.Transaction(func(tx *gorm.DB) error {
			upd := tx.Model(&model.EvaluationChange{}).Where("id = ? AND status = 'pending'", ch.ID).
				Updates(map[string]any{"status": status, "decided_by": u.ID, "decided_at": time.Now().UTC(), "decision_note": note})
			if upd.Error != nil {
				return upd.Error
			}
			if upd.RowsAffected == 0 {
				return errConflict
			}
			if !approve {
				return s.audit(tx, t.ID, u, "change_rejected", model.JSONMap{"reason": note})
			}
			var by model.User
			tx.Select("name").First(&by, "id = ?", ch.RequestedBy)
			return s.saveEvaluation(tx, &t, res, *ch.Answers, ch.Reason, u, true, model.JSONMap{"requested_by": by.Name, "approval_note": note})
		})
		if errors.Is(err, errConflict) {
			writeError(w, http.StatusConflict, "this change was already decided")
			return
		}
		if err != nil {
			dbError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": res})
	}
}

// saveEvaluation stores rescored answers and logs the before and after.
// resolveDispute: editing a disputed evaluation is how the dispute is accepted.
func (s *Server) saveEvaluation(tx *gorm.DB, t *model.Task, res scorecard.Result, answers scorecard.Answers, reason string,
	u *model.User, resolveDispute bool, extra model.JSONMap) error {
	before := model.JSONMap{"answers": t.Answers, "score": t.Score, "result": t.Result}
	update := map[string]any{
		"answers": &answers, "score": res.Score, "critical_failed": res.CriticalFailed, "passed": res.Passed, "result": res.Band,
	}
	if resolveDispute && (t.AckStatus == "disputed" || t.AckStatus == "dispute_qa") {
		update["ack_status"] = "changed"
		update["dispute_resolution"] = reason
		update["dispute_resolved_by"] = u.ID
		update["dispute_resolved_at"] = time.Now().UTC()
	}
	if err := tx.Model(&model.Task{}).Where("id = ?", t.ID).Updates(update).Error; err != nil {
		return err
	}
	detail := model.JSONMap{"reason": reason, "before": before, "after": model.JSONMap{"answers": answers, "score": res.Score, "result": res.Band}}
	for k, v := range extra {
		detail[k] = v
	}
	return s.audit(tx, t.ID, u, "evaluation_edited", detail)
}
