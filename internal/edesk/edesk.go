// Package edesk reads a ticket's general info from the eDesk official API
// (https://api.edesk.com/v1, bearer token).
package edesk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
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
