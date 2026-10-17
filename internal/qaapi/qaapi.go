// Package qaapi pulls answered tickets from the eDesk Insight QA API
// (https://<host>/api/qa/v1) and hands each agent's day to the importer.
package qaapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/importer"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

type Client struct {
	base, key string
	http      *http.Client

	// TagNames resolves tag ids to names (eDesk's own API); the QA API sends
	// tags without names. Optional: without it tags read "#<id>".
	TagNames func(ctx context.Context) (map[int64]string, error)
}

func New(base, key string) *Client {
	return &Client{base: base, key: key, http: &http.Client{Timeout: 60 * time.Second}}
}

// get calls one endpoint, waiting out a 429 (120 requests/min per key).
func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path+"?"+q.Encode(), nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.key)
		resp, err := c.http.Do(req)
		if err != nil {
			return fmt.Errorf("qa api: %w", err)
		}
		if resp.StatusCode == http.StatusTooManyRequests && attempt < 5 {
			resp.Body.Close()
			wait, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
			select {
			case <-time.After(time.Duration(max(wait, 1)) * time.Second):
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		var env struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		raw := json.NewDecoder(resp.Body)
		var body json.RawMessage
		err = raw.Decode(&body)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("qa api %s: HTTP %d, unreadable body", path, resp.StatusCode)
		}
		_ = json.Unmarshal(body, &env)
		if !env.OK {
			return fmt.Errorf("qa api %s: HTTP %d: %s", path, resp.StatusCode, env.Error)
		}
		return json.Unmarshal(body, out)
	}
}

type Agent struct {
	Email   string `json:"email"`
	Name    string `json:"name"`
	EDeskID int64  `json:"edesk_id"`
	IsTeam  bool   `json:"is_team"`
	Active  bool   `json:"active"`
}

func (c *Client) Agents(ctx context.Context) ([]Agent, error) {
	var out struct{ Agents []Agent }
	return out.Agents, c.get(ctx, "/agents", url.Values{}, &out)
}

// Tickets is every ticket the agent replied on during one reporting day, as
// raw objects (kept whole for the task page).
func (c *Client) Tickets(ctx context.Context, email, day string) ([]map[string]any, error) {
	var all []map[string]any
	for offset := 0; ; offset += 500 {
		var page struct {
			Total   int              `json:"total"`
			Tickets []map[string]any `json:"tickets"`
		}
		q := url.Values{"from": {day}, "to": {day}, "limit": {"500"}, "offset": {strconv.Itoa(offset)}}
		if err := c.get(ctx, "/agents/"+url.PathEscape(email)+"/tickets", q, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Tickets...)
		if len(page.Tickets) == 0 || len(all) >= page.Total {
			return all, nil
		}
	}
}

// Pull imports one reporting day of tickets for every active team agent.
func Pull(ctx context.Context, db *gorm.DB, c *Client, tt model.TaskType, day model.Date, userID *uuid.UUID) (*importer.Result, error) {
	agents, err := c.Agents(ctx)
	if err != nil {
		return nil, err
	}
	// Keep each agent's eDesk ID on their profile.
	for _, a := range agents {
		if a.EDeskID > 0 {
			id := strconv.FormatInt(a.EDeskID, 10)
			db.WithContext(ctx).Model(&model.User{}).
				Where("lower(email) = lower(?) AND edesk_id IS DISTINCT FROM ?", a.Email, id).Update("edesk_id", id)
		}
	}
	tagNames := map[int64]string{}
	if c.TagNames != nil {
		if tagNames, err = c.TagNames(ctx); err != nil {
			log.Printf("tickets pull: tag names unavailable, using ids: %v", err)
		}
	}
	cfg := settings.Load(ctx, db)
	var rows []importer.Row
	for _, a := range agents {
		if !a.IsTeam || !a.Active {
			continue
		}
		tickets, err := c.Tickets(ctx, a.Email, day.String())
		if err != nil {
			return nil, fmt.Errorf("tickets for %s: %w", a.Email, err)
		}
		for _, t := range tickets {
			rows = append(rows, ticketRow(a, t, tagNames, cfg))
		}
	}
	return importer.Ingest(ctx, db, tt, day, rows, importer.Options{
		Source: "api", Filename: "QA API " + day.String(), UserID: userID,
	})
}

func ticketRow(a Agent, t map[string]any, tagNames map[int64]string, cfg settings.Settings) importer.Row {
	id := fmt.Sprint(t["ticket_id"])
	if f, ok := t["ticket_id"].(float64); ok {
		id = strconv.FormatInt(int64(f), 10)
	}
	var labels []string
	// tags_known false: the ticket was never read since tags were kept, so an
	// empty list means nothing. It samples as untagged.
	if known, _ := t["tags_known"].(bool); known {
		tags, _ := t["tags"].([]any)
		for _, tag := range tags {
			m, ok := tag.(map[string]any)
			if !ok {
				continue
			}
			name, _ := m["name"].(string)
			if id, ok := m["id"].(float64); ok && name == "" {
				if name = tagNames[int64(id)]; name == "" {
					name = fmt.Sprintf("#%d", int64(id))
				}
				m["name"] = name // so the task page shows the name too
			}
			if name != "" {
				labels = append(labels, name)
			}
		}
	}
	// Picks are spread across how many replies the agent sent that day too.
	n, _ := t["replies_in_range"].(float64)
	bucket := cfg.ReplyBucket(int(n))
	return importer.Row{ExternalID: id, AgentKey: a.Email, AgentName: a.Name, Labels: labels, Bucket: bucket, Data: t}
}
