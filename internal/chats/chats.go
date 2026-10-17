// Package chats pulls live chats from the eDesk official API: each reporting
// day's closed chats of the agents on a live chat task type's team, into the
// importer like any other day of work.
package chats

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/edesk"
	"github.com/oaldesi/qa-portal/internal/importer"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

// Pull imports the chats closed on day by the team's agents (as entered on
// the Team page, matched by eDesk ID or email). Chats of anyone else, such as
// a ticket agent who took one, are left out.
func Pull(ctx context.Context, db *gorm.DB, c *edesk.Client, tt model.TaskType, day model.Date, userID *uuid.UUID) (*importer.Result, error) {
	var team []model.User
	if err := db.WithContext(ctx).Where("role = 'employee' AND active AND department_id = ? AND email IS NOT NULL", tt.DepartmentID).
		Find(&team).Error; err != nil {
		return nil, err
	}
	users, err := c.Users(ctx)
	if err != nil {
		return nil, err
	}
	chats, err := c.ClosedChats(ctx, day.String())
	if err != nil {
		return nil, err
	}
	tagNames, err := c.Tags(ctx)
	if err != nil {
		log.Printf("chats pull: tag names unavailable, using ids: %v", err)
	}
	rows, left := Rows(chats, users, team, tagNames, settings.Load(ctx, db))
	if left > 0 {
		log.Printf("%s pull %s: %d chats by people not on the team left out", tt.Name, day, left)
	}
	return importer.Ingest(ctx, db, tt, day, rows, importer.Options{
		Source: "api", Filename: "eDesk chats " + day.String(), UserID: userID,
	})
}

// Rows turns the day's chats into importer rows keyed by the team member's
// email, and counts the chats of people not on the team.
func Rows(chats []map[string]any, users []edesk.User, team []model.User, tagNames map[int64]string, cfg settings.Settings) ([]importer.Row, int) {
	// An eDesk user is a team member by eDesk ID, else by email.
	byEDesk, byEmail := map[string]string{}, map[string]bool{}
	for _, u := range team {
		email := strings.ToLower(strings.TrimSpace(*u.Email))
		byEmail[email] = true
		if u.EDeskID != nil && *u.EDeskID != "" {
			byEDesk[*u.EDeskID] = email
		}
	}
	member := map[int64]edesk.User{}
	for _, u := range users {
		member[u.ID] = u
	}
	var rows []importer.Row
	left := 0
	for _, t := range chats {
		owner := int64(num(t["owner_user_id"]))
		id := strconv.FormatInt(owner, 10)
		key := byEDesk[id]
		if key == "" && byEmail[strings.ToLower(member[owner].Email)] {
			key = strings.ToLower(member[owner].Email)
		}
		if key == "" {
			left++
			continue
		}
		var labels []string
		tags, _ := t["tags_ids"].([]any)
		for _, tag := range tags {
			tid := int64(num(tag))
			name := tagNames[tid]
			if name == "" {
				name = fmt.Sprintf("#%d", tid)
			}
			labels = append(labels, name)
		}
		rows = append(rows, importer.Row{
			ExternalID: strconv.FormatInt(int64(num(t["id"])), 10),
			AgentKey:   key,
			AgentName:  member[owner].Name,
			Labels:     labels,
			// Picks are spread across short and long chats too.
			Bucket: cfg.ChatBucket(int(num(t["replies"]))),
			Data:   t,
		})
	}
	return rows, left
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}
