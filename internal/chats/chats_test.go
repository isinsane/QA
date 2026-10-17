package chats

import (
	"testing"

	"github.com/oaldesi/qa-portal/internal/edesk"
	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

func TestRows(t *testing.T) {
	str := func(s string) *string { return &s }
	team := []model.User{
		{Name: "Abed", Email: str("ABSuleiman@detroitaxle.com")},                          // matched by email
		{Name: "Laith", Email: str("laith.real@detroitaxle.com"), EDeskID: str("227906")}, // by eDesk ID
	}
	users := []edesk.User{
		{ID: 223865, Name: "Anthony Sullivan", Email: "absuleiman@detroitaxle.com"},
		{ID: 227906, Name: "Steven Holmes", Email: "lalrajabi@detroitaxle.com"},
		{ID: 1, Name: "Ticket Agent", Email: "ticket@detroitaxle.com"},
	}
	chats := []map[string]any{
		{"id": 10.0, "owner_user_id": 223865.0, "tags_ids": []any{9.0, 42.0}, "replies": 6.0},
		{"id": 11.0, "owner_user_id": 227906.0, "replies": 1.0},
		{"id": 12.0, "owner_user_id": 1.0, "replies": 3.0}, // not on the team
	}
	rows, left := Rows(chats, users, team, map[int64]string{42: "WooCommerce"}, settings.Defaults())
	if left != 1 || len(rows) != 2 {
		t.Fatalf("rows %d, left out %d; want 2 and 1", len(rows), left)
	}
	if r := rows[0]; r.ExternalID != "10" || r.AgentKey != "absuleiman@detroitaxle.com" || len(r.Labels) != 2 || r.Labels[0] != "#9" || r.Labels[1] != "WooCommerce" || r.Bucket != "6–10 replies" {
		t.Errorf("first chat: %+v", r)
	}
	if r := rows[1]; r.AgentKey != "laith.real@detroitaxle.com" || r.AgentName != "Steven Holmes" || r.Bucket != "1–5 replies" {
		t.Errorf("second chat (by eDesk ID): %+v", r)
	}
}
