package importer

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

// PullFunc imports one day of work for a task type from an API.
type PullFunc func(ctx context.Context, tt model.TaskType, day model.Date) (*Result, error)

// Daily pulls, for every active task type of source, each day not pulled
// yet, from the settings' pull hour (business clock) onwards: yesterday, and
// any day of the last week still missing (the server or the API was down). A
// failed pull is retried every 15 minutes.
func Daily(ctx context.Context, db *gorm.DB, source string, pull PullFunc, after func()) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	lastTry := map[uuid.UUID]time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		cfg := settings.Load(ctx, db)
		now := time.Now().In(cfg.TZ())
		// By the pull hour (after 05:00) yesterday's reporting day is complete.
		if now.Hour() < cfg.TicketsPullHour {
			continue
		}
		var types []model.TaskType
		db.WithContext(ctx).Where("source = ? AND active", source).Find(&types)
		for _, tt := range types {
			days := pullDays(now, tt.CreatedAt.In(cfg.TZ()), func(d model.Date) bool {
				var n int64
				db.WithContext(ctx).Model(&model.ImportRun{}).
					Where("task_type_id = ? AND source = 'api' AND work_date = ? AND status = 'succeeded'", tt.ID, d).Count(&n)
				return n > 0
			})
			if len(days) == 0 || time.Since(lastTry[tt.ID]) < 15*time.Minute {
				continue
			}
			lastTry[tt.ID] = time.Now()
			for _, day := range days {
				res, err := pull(ctx, tt, day)
				if err != nil {
					log.Printf("%s pull %s: %v", tt.Name, day, err)
					break // the rest wait for the next try
				}
				log.Printf("%s pull %s: %d new, %d sampled, %d rejected", tt.Name, day, res.Run.Created, res.Run.Sampled, res.Run.Rejected)
				after()
			}
		}
	}
}

// pullDays are the reporting days still to pull, newest first: back to a
// week ago, or to the day before the task type was created, skipping days
// that already have a successful run.
func pullDays(now, created time.Time, done func(model.Date) bool) []model.Date {
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC) }
	earliest := day(now).AddDate(0, 0, -7)
	if first := day(created).AddDate(0, 0, -1); first.After(earliest) {
		earliest = first
	}
	var out []model.Date
	for d := day(now).AddDate(0, 0, -1); !d.Before(earliest); d = d.AddDate(0, 0, -1) {
		if md := (model.Date{Time: d}); !done(md) {
			out = append(out, md)
		}
	}
	return out
}
