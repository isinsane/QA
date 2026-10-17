// Package settings holds what an admin edits on the Settings page: clocks,
// live-monitoring matching, the daily ticket pull and defaults. One JSON row
// in app_settings; a key missing there takes its default here.
//
// Secrets and integration endpoints (database, API keys, base URLs) stay in
// the environment.
package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Settings struct {
	// BusinessTimezone is the IANA zone of the business day: "yesterday" for
	// uploads, report ranges, the ticket pull and rotation run on it.
	BusinessTimezone string `json:"business_timezone"`
	// CallUTCOffset is the clock Vonage writes call start times in, "-05:00".
	CallUTCOffset string `json:"call_utc_offset"`
	// LiveWindowSeconds: a live audit takes the agent's call that started
	// within this many seconds of it.
	LiveWindowSeconds int `json:"live_window_seconds"`
	// LiveHiddenColumns are sheet columns a QA agent is not asked to type in
	// for a live audit (Vonage fills them in itself).
	LiveHiddenColumns []string `json:"live_hidden_columns"`
	// IgnoredLabels are tags and codes that say nothing about the work
	// (eDesk's language tags "9" and "10", say): dropped from every
	// interaction of every type, on top of a type's own ignore list, so they
	// neither spread the sample nor show on audits and in reports.
	IgnoredLabels []string `json:"ignored_labels"`
	// TicketsPullHour is the business-clock hour the daily ticket pull starts.
	TicketsPullHour int `json:"tickets_pull_hour"`
	// ReplyBucketsTop: ticket picks are spread over 1, 2, … and N+ replies.
	ReplyBucketsTop int `json:"reply_buckets_top"`
	// ChatRepliesPerGroup: chat picks are spread over chat lengths in groups
	// of this many replies (1–5, 6–10, 11–15, then 16+ with 5).
	ChatRepliesPerGroup int `json:"chat_replies_per_group"`
	// DefaultPassword lets anyone who hasn't chosen a password yet sign in
	// once, then makes them choose their own. Empty: off (an admin sets
	// passwords one by one).
	DefaultPassword string `json:"default_password"`
	// DefaultQueueLimit is the queue cap a new QA agent starts with.
	DefaultQueueLimit int `json:"default_queue_limit"`
	// WrongSheetPercent: an upload is refused when this share of its rows
	// belongs to agents the task type doesn't audit (a sales sheet uploaded
	// as calls, say).
	WrongSheetPercent int `json:"wrong_sheet_percent"`
	// RotationCasesPerWeek: rotation (QA over QA) cases each QA agent gets a
	// week, spread over it, in teams with rotation on. 0 turns rotation off.
	RotationCasesPerWeek int `json:"rotation_cases_per_week"`
	// NewTaskType is what a new task type starts with.
	NewTaskType TaskTypeDefaults `json:"new_task_type"`
	// RosterIgnoreIDs are HR employee IDs the HR upload leaves out: people
	// removed on Team (duplicates in the HR sheet), so they don't come back.
	RosterIgnoreIDs []string `json:"roster_ignore_ids"`
}

type TaskTypeDefaults struct {
	PassThreshold       int     `json:"pass_threshold"`
	BorderlineThreshold int     `json:"borderline_threshold"`
	SamplePercent       float64 `json:"sample_percent"`
	UntaggedPercent     float64 `json:"untagged_percent"`
	RotationDays        int     `json:"rotation_days"`
	MinPerAgentPerDay   int     `json:"min_per_agent_per_day"`
	MaxPerAgentPerDay   int     `json:"max_per_agent_per_day"`  // 0: no limit
	MaxPerAgentPerWeek  int     `json:"max_per_agent_per_week"` // 0: no limit
}

func Defaults() Settings {
	return Settings{
		BusinessTimezone:     "Asia/Amman",
		CallUTCOffset:        "-05:00",
		LiveWindowSeconds:    20,
		LiveHiddenColumns:    []string{"Conversation ID", "Media manager", "Media type", "Handle time", "Interaction outcome", "Connect from"},
		IgnoredLabels:        []string{"9", "10"},
		RosterIgnoreIDs:      []string{},
		TicketsPullHour:      6,
		ReplyBucketsTop:      3,
		ChatRepliesPerGroup:  5,
		DefaultQueueLimit:    12,
		DefaultPassword:      "Welcome1",
		RotationCasesPerWeek: 3,
		WrongSheetPercent:    30,
		NewTaskType: TaskTypeDefaults{
			PassThreshold: 80, BorderlineThreshold: 70, SamplePercent: 5, UntaggedPercent: 1, RotationDays: 3, MinPerAgentPerDay: 1,
		},
	}
}

// Load reads the settings. It never fails: on a database error it logs and
// returns the defaults, so a hiccup never stops an import.
// ponytail: one small query per call; cache it if it ever shows up in a profile.
func Load(ctx context.Context, db *gorm.DB) Settings {
	s := Defaults()
	var raw []byte
	if err := db.WithContext(ctx).Raw("SELECT data FROM app_settings WHERE id = 1").Row().Scan(&raw); err != nil {
		log.Printf("settings: %v (using defaults)", err)
		return s
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		log.Printf("settings: %v (using defaults)", err)
		return Defaults()
	}
	if s.Validate() != nil {
		return Defaults()
	}
	return s
}

func Save(ctx context.Context, db *gorm.DB, s Settings, by uuid.UUID) error {
	if err := s.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Exec(`INSERT INTO app_settings (id, data, updated_by, updated_at) VALUES (1, ?::jsonb, ?, now())
		ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`,
		string(raw), by).Error
}

func (s Settings) Validate() error {
	d := s.NewTaskType
	switch {
	case s.TZ() == nil:
		return fmt.Errorf("unknown time zone %q", s.BusinessTimezone)
	case s.CallClock() == nil:
		return fmt.Errorf("the Vonage clock must look like -05:00")
	case s.LiveWindowSeconds < 1 || s.LiveWindowSeconds > 600:
		return fmt.Errorf("the live match window must be 1 to 600 seconds")
	case s.TicketsPullHour < 0 || s.TicketsPullHour > 23:
		return fmt.Errorf("the ticket pull hour must be 0 to 23")
	case s.ReplyBucketsTop < 1 || s.ReplyBucketsTop > 20:
		return fmt.Errorf("reply buckets must top out between 1 and 20")
	case s.ChatRepliesPerGroup < 1 || s.ChatRepliesPerGroup > 50:
		return fmt.Errorf("chat length groups must be 1 to 50 replies")
	case s.DefaultPassword != "" && (len(s.DefaultPassword) < 8 || len(s.DefaultPassword) > 72):
		return fmt.Errorf("the default password must be 8 to 72 characters, or empty to turn it off")
	case s.DefaultQueueLimit < 0:
		return fmt.Errorf("the default queue cap can't be negative")
	case s.WrongSheetPercent < 1 || s.WrongSheetPercent > 100:
		return fmt.Errorf("the wrong-sheet threshold must be 1 to 100%%")
	case s.RotationCasesPerWeek < 0 || s.RotationCasesPerWeek > 50:
		return fmt.Errorf("rotation cases per week must be 0 to 50")
	case d.PassThreshold < 0 || d.PassThreshold > 100 || d.BorderlineThreshold < 0 || d.BorderlineThreshold > d.PassThreshold:
		return fmt.Errorf("new task types: pass is 0-100 and borderline between 0 and pass")
	case d.SamplePercent <= 0 || d.SamplePercent > 100 || d.UntaggedPercent < 0 || d.UntaggedPercent > 100:
		return fmt.Errorf("new task types: sample %% above 0 and at most 100, untagged %% 0-100")
	case d.RotationDays < 1 || d.MinPerAgentPerDay < 0 || d.MaxPerAgentPerDay < 0 || d.MaxPerAgentPerWeek < 0:
		return fmt.Errorf("new task types: rotation days at least 1, per-agent limits 0 or more")
	case d.MaxPerAgentPerDay > 0 && d.MinPerAgentPerDay > d.MaxPerAgentPerDay:
		return fmt.Errorf("new task types: the daily minimum is above the daily maximum")
	case d.MaxPerAgentPerDay > 0 && d.MaxPerAgentPerWeek > 0 && d.MaxPerAgentPerDay > d.MaxPerAgentPerWeek:
		return fmt.Errorf("new task types: the daily maximum is above the weekly maximum")
	}
	return nil
}

// TZ is the business clock; nil when the zone name is unknown.
func (s Settings) TZ() *time.Location {
	loc, err := time.LoadLocation(s.BusinessTimezone)
	if err != nil || s.BusinessTimezone == "" {
		return nil
	}
	return loc
}

// CallClock is the fixed zone Vonage writes start times in; nil when malformed.
func (s Settings) CallClock() *time.Location {
	t, err := time.Parse("-07:00", s.CallUTCOffset)
	if err != nil {
		return nil
	}
	_, secs := t.Zone()
	return time.FixedZone("Vonage "+s.CallUTCOffset, secs)
}

func (s Settings) LiveWindow() time.Duration { return time.Duration(s.LiveWindowSeconds) * time.Second }

// ReplyBucket names a ticket's reply count for sampling: "1 reply", "2
// replies", … up to the top bucket, "N+ replies".
// ChatBucket is a chat's length group: up to three groups of
// ChatRepliesPerGroup replies, then everything longer.
func (s Settings) ChatBucket(replies int) string {
	n := max(s.ChatRepliesPerGroup, 1)
	g := max(replies-1, 0) / n
	if g >= 3 {
		return fmt.Sprintf("%d+ replies", 3*n+1)
	}
	return fmt.Sprintf("%d–%d replies", g*n+1, (g+1)*n)
}

func (s Settings) ReplyBucket(replies int) string {
	switch {
	case replies >= s.ReplyBucketsTop:
		return fmt.Sprintf("%d+ replies", s.ReplyBucketsTop)
	case replies <= 1:
		return "1 reply"
	}
	return fmt.Sprintf("%d replies", replies)
}
