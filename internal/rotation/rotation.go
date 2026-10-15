// Package rotation runs "cases rotation" (QA over QA). Each QA agent in a
// team with rotation on gets a set number of rotation cases a week (an admin
// setting), spread evenly over the week: a copy of a fresh interaction from
// the latest imported day. It never counts in agent scores.
// After the type's rotation days, the same case goes, blind, to one other QA
// agent of the team; comparing the two scores is the calibration report.
package rotation

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

type Runner struct {
	db *gorm.DB
	mu sync.Mutex
}

func NewRunner(db *gorm.DB) *Runner { return &Runner{db: db} }

// Run is safe to call often: it only creates what is missing.
func (r *Runner) Run(ctx context.Context) error {
	if !r.mu.TryLock() {
		return nil
	}
	defer r.mu.Unlock()
	cfg := settings.Load(ctx, r.db)
	now := time.Now().In(cfg.TZ())
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		created, err := weeklyCases(tx, now, cfg.RotationCasesPerWeek)
		if err != nil {
			return err
		}
		moved, err := secondReviews(tx)
		if err != nil {
			return err
		}
		if created+moved > 0 {
			log.Printf("rotation: %d new case(s), %d sent for second review", created, moved)
		}
		return nil
	})
}

// dueBy is how many of a week's cases should exist by the end of a weekday,
// spread evenly from Monday: 3 a week comes Monday, Wednesday and Friday.
func dueBy(perWeek int, day time.Weekday) int {
	nth := (int(day)+6)%7 + 1 // Monday 1 … Sunday 7
	return (perWeek*nth + 6) / 7
}

func weeklyCases(tx *gorm.DB, now time.Time, perWeek int) (int, error) {
	if perWeek <= 0 {
		return 0, nil
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	monday := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	var qas []struct {
		ID           uuid.UUID
		DepartmentID uuid.UUID
		Cases        int
	}
	err := tx.Raw(`
		SELECT u.id, u.department_id,
		       (SELECT count(*) FROM tasks t WHERE t.kind = 'rotation' AND t.rotation_of IS NULL
		          AND (t.assigned_qa_id = u.id OR t.evaluated_by = u.id) AND t.created_at >= ?) AS cases
		FROM users u
		WHERE u.role = 'qa_agent' AND u.active
		  AND EXISTS (SELECT 1 FROM task_types tt WHERE tt.department_id = u.department_id AND tt.active AND tt.rotation_enabled)`,
		monday).Scan(&qas).Error
	if err != nil {
		return 0, err
	}
	n := 0
	for _, qa := range qas {
		for range dueBy(perWeek, today.Weekday()) - qa.Cases {
			ok, err := oneCase(tx, qa.ID, qa.DepartmentID)
			if err != nil {
				return n, err
			}
			if !ok {
				break // nothing imported yet for this team
			}
			n++
		}
	}
	return n, nil
}

// oneCase copies a fresh interaction of the team's latest day into a QA
// agent's queue as a rotation case; false when there is none.
func oneCase(tx *gorm.DB, qaID, dept uuid.UUID) (bool, error) {
	var src model.Task
	err := tx.Raw(`
		SELECT t.* FROM tasks t JOIN task_types tt ON tt.id = t.task_type_id
		WHERE tt.department_id = ? AND tt.active AND tt.rotation_enabled
		  AND t.kind = 'sample' AND t.state = 'unsampled'
		  AND t.work_date = (SELECT max(work_date) FROM tasks l WHERE l.task_type_id = t.task_type_id)
		  AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.kind = 'rotation' AND r.task_type_id = t.task_type_id
		                  AND r.external_id = t.external_id AND r.employee_id = t.employee_id)
		ORDER BY random() LIMIT 1`, dept).Scan(&src).Error
	if err != nil || src.ID == uuid.Nil {
		return false, err
	}
	return true, assignCopy(tx, src, qaID, nil)
}

func secondReviews(tx *gorm.DB) (int, error) {
	var due []model.Task
	err := tx.Raw(`
		SELECT t.* FROM tasks t JOIN task_types tt ON tt.id = t.task_type_id
		WHERE t.kind = 'rotation' AND t.rotation_of IS NULL AND t.state <> 'cancelled'
		  AND t.created_at <= now() - make_interval(days => tt.rotation_days)
		  AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.rotation_of = t.id)`).Scan(&due).Error
	if err != nil {
		return 0, err
	}
	n := 0
	for _, first := range due {
		firstQA := first.EvaluatedBy
		if firstQA == nil {
			firstQA = first.AssignedQAID
		}
		// Another QA agent of the same team, the one holding the least work.
		var next struct{ ID uuid.UUID }
		err := tx.Raw(`
			SELECT u.id FROM users u
			JOIN task_types tt ON tt.department_id = u.department_id AND tt.id = ?
			LEFT JOIN tasks o ON o.assigned_qa_id = u.id AND o.state = 'assigned'
			WHERE u.role = 'qa_agent' AND u.active AND u.id IS DISTINCT FROM ?
			GROUP BY u.id ORDER BY count(o.id), u.id LIMIT 1`, first.TaskTypeID, firstQA).Scan(&next).Error
		if err != nil {
			return n, err
		}
		if next.ID == uuid.Nil {
			continue // a team of one has nobody to compare with
		}
		if err := assignCopy(tx, first, next.ID, &first.ID); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// assignCopy puts a rotation copy of src straight into a QA agent's queue.
func assignCopy(tx *gorm.DB, src model.Task, qaID uuid.UUID, of *uuid.UUID) error {
	var pos int
	tx.Raw("SELECT coalesce(max(queue_position), 0) + 1 FROM tasks WHERE assigned_qa_id = ? AND state = 'assigned'", qaID).Scan(&pos)
	now := time.Now().UTC()
	c := model.Task{
		TaskTypeID: src.TaskTypeID, ImportRunID: src.ImportRunID, EmployeeID: src.EmployeeID,
		ExternalID: src.ExternalID, WorkDate: src.WorkDate, Labels: src.Labels, Data: src.Data,
		State: model.StateAssigned, AssignedQAID: &qaID, AssignedAt: &now, QueuePosition: &pos,
		Kind: model.KindRotation, RotationOf: of,
	}
	if c.Labels == nil {
		c.Labels = model.Strings{}
	}
	if err := tx.Create(&c).Error; err != nil {
		return err
	}
	action := "rotation_case"
	if of != nil {
		action = "rotation_second_review"
	}
	return tx.Create(&model.AuditLog{TaskID: &c.ID, Action: action, Detail: model.JSONMap{"qa_id": qaID}}).Error
}
