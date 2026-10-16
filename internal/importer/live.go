package importer

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
)

// liveResult is what a sheet upload does to the day's live-monitoring
// audits: each one either takes the call that started within window of it
// (an admin setting), or is flagged.
type liveResult struct {
	matches map[uuid.UUID]Row // live task → its call
	flagged []uuid.UUID
	taken   map[int]bool // fresh row indexes now belonging to a live audit
}

func matchLive(ctx context.Context, db *gorm.DB, tt model.TaskType, day model.Date, fresh []Row, freshEmp []uuid.UUID, window time.Duration) (*liveResult, error) {
	res := &liveResult{matches: map[uuid.UUID]Row{}, taken: map[int]bool{}}
	var pending []model.Task
	err := db.WithContext(ctx).Where("task_type_id = ? AND work_date = ? AND kind = ? AND match_status IN ('pending', 'flagged')",
		tt.ID, day, model.KindLive).Find(&pending).Error
	if err != nil || len(pending) == 0 {
		return res, err
	}
	for _, t := range pending {
		best, bestGap := -1, window+1
		for i, r := range fresh {
			if res.taken[i] || freshEmp[i] != t.EmployeeID || r.StartedAt == nil || t.LiveStartedAt == nil {
				continue
			}
			if gap := r.StartedAt.Sub(*t.LiveStartedAt).Abs(); gap <= window && gap < bestGap {
				best, bestGap = i, gap
			}
		}
		if best < 0 {
			res.flagged = append(res.flagged, t.ID)
			continue
		}
		res.taken[best] = true
		res.matches[t.ID] = fresh[best]
	}
	return res, nil
}

func (l *liveResult) save(tx *gorm.DB, runID uuid.UUID) error {
	for id, r := range l.matches {
		raw, err := json.Marshal(r.Data)
		if err != nil {
			return err
		}
		// The sheet's row, plus what the QA agent typed while listening.
		data := gorm.Expr("?::jsonb || jsonb_strip_nulls(jsonb_build_object('live_entered', data->'live_entered'))", string(raw))
		if err := tx.Model(&model.Task{}).Where("id = ?", id).Updates(map[string]any{
			"external_id": r.ExternalID, "data": data, "labels": model.Strings(r.Labels),
			"import_run_id": runID, "match_status": "matched",
		}).Error; err != nil {
			return err
		}
	}
	if len(l.flagged) > 0 {
		return tx.Model(&model.Task{}).Where("id IN ?", l.flagged).Update("match_status", "flagged").Error
	}
	return nil
}

// ParseCallTime reads a sheet's Start time in the Vonage clock.
func ParseCallTime(s string, clock *time.Location) *time.Time {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02T15:04:05", "1/2/2006 15:04:05", "1/2/2006 15:04",
		"1/2/2006 3:04:05 PM", "1/2/2006 3:04 PM", "01-02-06 15:04", "1/2/06 15:04", "1/2/06 3:04 PM", time.RFC3339} {
		if t, err := time.ParseInLocation(layout, s, clock); err == nil {
			return &t
		}
	}
	return nil
}
