// Package assign fills QA agents' personal queues, like followup-portal's:
// each ready task goes to the agent in its department holding the fewest
// open tasks, oldest work first, up to each agent's queue limit. Overflow
// stays ready for the next pass.
package assign

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
)

type ReadyTask struct {
	ID           uuid.UUID
	DepartmentID uuid.UUID
	// Priority > 0 (supervisor escalations) goes first and ignores the cap.
	Priority int
}

type Agent struct {
	ID           uuid.UUID
	DepartmentID uuid.UUID
	Open         int
	Limit        int // 0 = no cap
	NextPosition int
}

type Assignment struct {
	TaskID   uuid.UUID
	AgentID  uuid.UUID
	Position int
}

// Plan is the pure policy: tasks arrive escalations first, then oldest
// first; each goes to the emptiest agent of its department with room.
// Escalations go to the emptiest agent even when everyone is full.
func Plan(tasks []ReadyTask, agents []Agent) []Assignment {
	byDept := map[uuid.UUID][]*Agent{}
	for i := range agents {
		a := &agents[i]
		byDept[a.DepartmentID] = append(byDept[a.DepartmentID], a)
	}
	var out []Assignment
	for _, t := range tasks {
		var best *Agent
		for _, a := range byDept[t.DepartmentID] {
			if t.Priority <= 0 && a.Limit > 0 && a.Open >= a.Limit {
				continue
			}
			if best == nil || a.Open < best.Open {
				best = a
			}
		}
		if best == nil {
			continue
		}
		out = append(out, Assignment{TaskID: t.ID, AgentID: best.ID, Position: best.NextPosition})
		best.Open++
		best.NextPosition++
	}
	return out
}

type Runner struct {
	db *gorm.DB
	mu sync.Mutex
}

func NewRunner(db *gorm.DB) *Runner { return &Runner{db: db} }

// Run reclaims work from agents who can no longer hold it, then fills queues.
// Overlapping calls (ticker + an import finishing) skip rather than queue up.
func (r *Runner) Run(ctx context.Context) error {
	if !r.mu.TryLock() {
		return nil
	}
	defer r.mu.Unlock()

	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Deactivated, no longer a QA agent, or moved to another department:
		// their tasks go back to ready. Offline agents keep theirs.
		if err := tx.Exec(`
			UPDATE tasks t SET state = 'ready', assigned_qa_id = NULL, assigned_at = NULL, queue_position = NULL
			FROM users u, task_types tt
			WHERE t.state = 'assigned' AND u.id = t.assigned_qa_id AND tt.id = t.task_type_id
			  AND (NOT u.active OR u.role <> 'qa_agent' OR u.department_id IS DISTINCT FROM tt.department_id)`).Error; err != nil {
			return err
		}

		var agents []Agent
		if err := tx.Raw(`
			SELECT u.id, u.department_id, u.queue_limit AS "limit",
			       count(t.id) AS open, coalesce(max(t.queue_position), 0) + 1 AS next_position
			FROM users u
			LEFT JOIN tasks t ON t.assigned_qa_id = u.id AND t.state = 'assigned'
			WHERE u.role = 'qa_agent' AND u.active AND u.is_available
			GROUP BY u.id`).Scan(&agents).Error; err != nil {
			return err
		}
		if len(agents) == 0 {
			return nil
		}
		// Stable order so equal queues fill the same way every pass.
		sort.Slice(agents, func(i, j int) bool { return agents[i].ID.String() < agents[j].ID.String() })

		var tasks []ReadyTask
		if err := tx.Raw(`
			SELECT t.id, tt.department_id, t.priority
			FROM tasks t JOIN task_types tt ON tt.id = t.task_type_id
			WHERE t.state = 'ready' AND tt.active
			ORDER BY t.priority DESC, t.work_date, t.created_at, t.id`).Scan(&tasks).Error; err != nil {
			return err
		}

		plan := Plan(tasks, agents)
		now := time.Now().UTC()
		for _, a := range plan {
			res := tx.Model(&model.Task{}).Where("id = ? AND state = 'ready'", a.TaskID).Updates(map[string]any{
				"state": model.StateAssigned, "assigned_qa_id": a.AgentID, "assigned_at": now, "queue_position": a.Position,
			})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 1 {
				agentID := a.AgentID
				if err := tx.Create(&model.AuditLog{TaskID: &a.TaskID, Action: "assigned",
					Detail: model.JSONMap{"qa_id": agentID, "by": "assignment pass"}}).Error; err != nil {
					return err
				}
			}
		}
		if len(plan) > 0 {
			log.Printf("assign: %d task(s) assigned", len(plan))
		}
		return nil
	})
}
