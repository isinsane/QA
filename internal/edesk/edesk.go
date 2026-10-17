// Package edesk reads a ticket's general info from the eDesk official API
// (https://api.edesk.com/v1, bearer token).
package edesk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Client struct {
	token string
	http  *http.Client
}

func New(token string) *Client {
	return &Client{token: token, http: &http.Client{Timeout: 30 * time.Second}}
}

// Tags maps every tag id to its name. The QA API sends tags by id with no
// name, so the ticket pull resolves them here.
// ponytail: one page (eDesk returns up to 1000); page through if the account outgrows it.
func (c *Client) Tags(ctx context.Context) (map[int64]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.edesk.com/v1/tags", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("edesk: %w", err)
	}
	defer resp.Body.Close()
	var body struct {
		Data []struct {
			ID   int64 `json:"id"`
			Name any   `json:"name"` // some tags are named with a bare number
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("edesk: tags: HTTP %d", resp.StatusCode)
	}
	out := make(map[int64]string, len(body.Data))
	for _, t := range body.Data {
		out[t.ID] = strings.TrimSpace(fmt.Sprint(t.Name))
	}
	return out, nil
}

// Ticket returns GET /tickets/{id}'s data object: subject, type, status,
// sales order (items, tracking), replies, timestamps and the ticket URL.
func (c *Client) Ticket(ctx context.Context, id string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.edesk.com/v1/tickets/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("edesk: %w", err)
	}
	defer resp.Body.Close()
	var body struct {
		Data  map[string]any `json:"data"`
		Error struct {
			Message string `json:"message"`
			Details string `json:"details"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != http.StatusOK || body.Data == nil {
		return nil, fmt.Errorf("edesk: ticket %s: HTTP %d %s %s", id, resp.StatusCode, body.Error.Message, body.Error.Details)
	}
	return body.Data, nil
}

// get calls one endpoint and decodes its JSON body into out.
func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	u := "https://api.edesk.com/v1" + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("edesk: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("edesk: %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type page[T any] struct {
	Paginator struct {
		Total int `json:"totalItemsCount"`
	} `json:"paginator"`
	Data []T `json:"data"`
}

// all reads every page of a list (eDesk returns 20 a page).
func all[T any](ctx context.Context, c *Client, path string, q url.Values) ([]T, error) {
	if q == nil {
		q = url.Values{}
	}
	var out []T
	for n := 1; n <= 1000; n++ {
		q.Set("page", strconv.Itoa(n))
		var p page[T]
		if err := c.get(ctx, path, q, &p); err != nil {
			return nil, err
		}
		out = append(out, p.Data...)
		if len(p.Data) == 0 || len(out) >= p.Paginator.Total {
			break
		}
	}
	return out, nil
}

type User struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Users is every eDesk user (agents), for matching chats to the team.
func (c *Client) Users(ctx context.Context) ([]User, error) { return all[User](ctx, c, "/users", nil) }

// ClosedChats is every live chat closed on day (YYYY-MM-DD): eDesk's tickets
// of type Chat, status Closed, last updated that day in the eDesk API user's
// clock. Each is the ticket as eDesk lists it (subject, owner, tags, order,
// replies, message ids).
func (c *Client) ClosedChats(ctx context.Context, day string) ([]map[string]any, error) {
	return all[map[string]any](ctx, c, "/tickets", url.Values{
		"filter_type_equals": {"Chat"}, "filter_status_equals": {"Closed"},
		"filter_last_updated_at_gte": {day}, "filter_last_updated_at_lte": {day},
		"order_by": {"id"}, "order_direction": {"asc"},
	})
}

// ChatLine is one message of a chat, as the audit page shows it.
type ChatLine struct {
	At   int64  `json:"at"`   // unix seconds
	Who  string `json:"who"`  // agent, customer or bot
	Name string `json:"name"` // the agent's name
	Kind string `json:"kind"` // Message, or ChatNavigate (the customer opened a page)
	Text string `json:"text"`
}

// Chat reads a chat's messages in order. eDesk has no call that lists a
// ticket's messages, so they are read one by one, a few at a time.
func (c *Client) Chat(ctx context.Context, messageIDs []int64) ([]ChatLine, error) {
	lines := make([]ChatLine, len(messageIDs))
	errs := make([]error, len(messageIDs))
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup
	for i, id := range messageIDs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var body struct {
				Data struct {
					Type           string `json:"type"`
					Body           string `json:"body"`
					CreatedAt      any    `json:"created_at"`
					FromConsumerID *int64 `json:"from_consumer_id"`
					FromUser       *struct {
						Name string `json:"name"`
					} `json:"from_user"`
				} `json:"data"`
			}
			if err := c.get(ctx, "/messages/"+strconv.FormatInt(id, 10), nil, &body); err != nil {
				errs[i] = err
				return
			}
			d := body.Data
			l := ChatLine{Kind: d.Type, Text: strings.TrimSpace(d.Body), Who: "bot"}
			switch {
			case d.FromUser != nil:
				l.Who, l.Name = "agent", d.FromUser.Name
			case d.FromConsumerID != nil:
				l.Who = "customer"
			}
			if f, ok := d.CreatedAt.(float64); ok {
				l.At = int64(f)
			}
			lines[i] = l
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].At < lines[j].At })
	return lines, nil
}
