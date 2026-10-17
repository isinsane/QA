// Package model holds the GORM models. The schema itself lives in
// migrations/; GORM is used for querying only.
package model

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/scorecard"
)

type Role string

const (
	RoleAdmin      Role = "admin"
	RoleSupervisor Role = "supervisor"
	RoleQA         Role = "qa_agent"
	RoleEmployee   Role = "employee"
	// RoleNegative reports negative reviews (order or call, agent, error).
	RoleNegative Role = "negative_agent"
	// RoleTeamLeader (floor support) escalates work of agents on their team.
	RoleTeamLeader Role = "team_leader"
	// RoleViewer sees what an admin sees, every team, and changes nothing
	// (HR and other people who follow quality).
	RoleViewer Role = "viewer"
	// RoleSpecialProcess (A-Z guarantee, chargebacks, ...) escalates the work
	// of agents of any team, like a team leader, and sees nothing else. No team.
	RoleSpecialProcess Role = "special_process"
)

func (r Role) Valid() bool {
	switch r {
	case RoleAdmin, RoleSupervisor, RoleQA, RoleEmployee, RoleNegative, RoleTeamLeader, RoleViewer, RoleSpecialProcess:
		return true
	}
	return false
}

type Department struct {
	ID   uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	Name string    `json:"name"`
	// HRNames are the HR sheet departments whose people belong to this QA
	// team (e.g. Calls support + New Sales). Empty means the name itself.
	HRNames   Strings   `gorm:"column:hr_names;type:jsonb" json:"hr_names"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type User struct {
	ID                 uuid.UUID  `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	Name               string     `json:"name"`
	Email              *string    `json:"email"`
	Role               Role       `json:"role"`
	DepartmentID       *uuid.UUID `gorm:"type:uuid" json:"department_id"`
	AgentCode          *string    `json:"agent_code"`
	HRID               *string    `gorm:"column:hr_id" json:"hr_id"`
	EDeskID            *string    `gorm:"column:edesk_id" json:"edesk_id"`
	AliasName          string     `json:"alias_name"`
	SheetNames         Strings    `gorm:"type:jsonb" json:"sheet_names"` // other spellings Vonage sheets use
	Profile            JSONMap    `gorm:"type:jsonb" json:"profile"`
	Active             bool       `json:"active"`
	IsAvailable        bool       `json:"is_available"`
	QueueLimit         int        `json:"queue_limit"`
	PasswordHash       string     `json:"-"`
	MustChangePassword bool       `json:"must_change_password"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
}

// HasPassword reports whether the user can sign in yet.
func (u User) HasPassword() bool { return u.PasswordHash != "" }

type Session struct {
	ID         uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	UserID     uuid.UUID `gorm:"type:uuid"`
	TokenHash  string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastSeenAt time.Time
	RevokedAt  *time.Time
}

const (
	SourceSheet      = "sheet"
	SourceTicketsAPI = "tickets_api"
	// SourceManual has no feed yet: audits arrive as escalations.
	SourceManual = "manual"
	// SourceEDeskChats: live chats closed each day, from the eDesk official API.
	SourceEDeskChats = "edesk_chats"
)

type TaskType struct {
	ID            uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	DepartmentID  uuid.UUID      `gorm:"type:uuid" json:"department_id"`
	Code          string         `json:"code"`
	Name          string         `json:"name"`
	Source        string         `json:"source"`
	Active        bool           `json:"active"`
	Scorecard     scorecard.Card `gorm:"type:jsonb" json:"scorecard"`
	PassThreshold int            `json:"pass_threshold"`
	// BorderlineThreshold: scores from here up to the pass threshold are
	// Borderline; below it, Fail.
	BorderlineThreshold int         `json:"borderline_threshold"`
	SamplePercent       float64     `json:"sample_percent"`   // of each agent's tagged/coded rows
	UntaggedPercent     float64     `json:"untagged_percent"` // of all untagged rows, pooled across agents
	SkipLabels          Strings     `gorm:"type:jsonb" json:"skip_labels"`
	IgnoreLabels        Strings     `gorm:"type:jsonb" json:"ignore_labels"`
	Columns             Columns     `gorm:"type:jsonb" json:"columns"`
	RotationEnabled     bool        `json:"rotation_enabled"`
	RotationDays        int         `json:"rotation_days"`
	AgentLimits         AgentLimits `gorm:"type:jsonb" json:"agent_limits"`
	// AgentGroups are the HR departments or job titles whose agents this type
	// audits (calls agents under calls, sales under sales, Live Chat
	// Associates under live chats); empty = the whole team.
	AgentGroups Strings   `gorm:"type:jsonb" json:"agent_groups"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Columns names the sheet headers the importer needs. Every other column is
// kept as-is in tasks.data.
type Columns struct {
	ExternalID string `json:"external_id"`
	AgentCode  string `json:"agent_code"`
	AgentName  string `json:"agent_name"`
	Label      string `json:"label"`
	StartTime  string `json:"start_time"` // matches live-monitoring audits to calls
	// RowColumn and RowValues share one sheet between task types (calls and
	// sales come in one Vonage export, told apart by Service name): this type
	// takes only the rows whose RowColumn is one of RowValues. Empty: every row.
	RowColumn string   `json:"row_column,omitempty"`
	RowValues []string `json:"row_values,omitempty"`
}

// Takes reports whether a sheet row belongs to this type (see RowColumn).
func (c Columns) Takes(row map[string]string) bool {
	if c.RowColumn == "" {
		return true
	}
	v := strings.TrimSpace(row[c.RowColumn])
	for _, x := range c.RowValues {
		if strings.EqualFold(strings.TrimSpace(x), v) {
			return true
		}
	}
	return false
}

// VonageColumns is the "Disposition codes by interaction" export, one sheet
// for calls and sales (told apart by Service name; see RowColumn). It names
// agents only, so they are matched by name.
var VonageColumns = Columns{ExternalID: "Interaction ID", AgentName: "First agent name", Label: "Disposition code", StartTime: "Start time"}

// ByEmail: the source names agents by their eDesk email (tickets, chats),
// not by a Vonage ID or name.
func (tt TaskType) ByEmail() bool {
	return tt.Source == SourceTicketsAPI || tt.Source == SourceEDeskChats
}

// Audits reports whether an agent's work belongs under this type. With
// agent groups set, the agent's HR department or job title must be one of
// them; someone with neither on file (added by hand) is let through.
func (tt TaskType) Audits(u User) bool {
	if len(tt.AgentGroups) == 0 || strings.TrimSpace(u.Department()) == "" && strings.TrimSpace(u.JobTitle()) == "" {
		return true
	}
	return tt.Names(u)
}

// Names: this type's agent groups name the agent (HR department or job
// title), not just let them through. Where several types audit an agent, the
// one that names them is their work: no need to ask.
func (tt TaskType) Names(u User) bool {
	d, title := strings.TrimSpace(u.Department()), strings.TrimSpace(u.JobTitle())
	for _, g := range tt.AgentGroups {
		if g = strings.TrimSpace(g); g != "" && (strings.EqualFold(g, d) || strings.EqualFold(g, title)) {
			return true
		}
	}
	return false
}

// JobTitle is the agent's job title, from the HR sheet or Team.
func (u User) JobTitle() string {
	t, _ := u.Profile["job_title"].(string)
	return t
}

// Department is the agent's HR department, from the HR sheet.
func (u User) Department() string {
	d, _ := u.Profile["department"].(string)
	return d
}

// AgentLimits bound how many audits one agent gets from daily sampling, per
// day, week (Monday to Sunday) and month.
type AgentLimits struct {
	Day   Bounds `json:"day"`
	Week  Bounds `json:"week"`
	Month Bounds `json:"month"`
}

type Bounds struct {
	Min *Limit `json:"min,omitempty"`
	Max *Limit `json:"max,omitempty"`
}

// Limit is a number of audits, or a percent of the agent's rows in the period.
type Limit struct {
	Value float64 `json:"value"`
	Unit  string  `json:"unit"` // "count" or "percent"
}

// Of resolves the limit against an agent's rows in the period: -1 when unset;
// percents round up, like the sample percent.
func (l *Limit) Of(rows int) int {
	switch {
	case l == nil:
		return -1
	case l.Unit == "percent":
		return int(math.Ceil(l.Value/100*float64(rows) - 1e-9))
	}
	return int(math.Round(l.Value))
}

func (l AgentLimits) Validate() error {
	for _, p := range []struct {
		name string
		b    Bounds
	}{{"day", l.Day}, {"week", l.Week}, {"month", l.Month}} {
		for _, x := range []*Limit{p.b.Min, p.b.Max} {
			switch {
			case x == nil:
			case x.Unit != "count" && x.Unit != "percent":
				return fmt.Errorf("per %s: unit must be count or percent", p.name)
			case x.Value < 0 || (x.Unit == "percent" && x.Value > 100):
				return fmt.Errorf("per %s: limits are 0 or more, and percents at most 100", p.name)
			}
		}
		if p.b.Min != nil && p.b.Max != nil && p.b.Min.Unit == p.b.Max.Unit && p.b.Min.Value > p.b.Max.Value {
			return fmt.Errorf("per %s: the minimum is above the maximum", p.name)
		}
	}
	// A shorter period can't allow more than a longer one (when both are counts).
	counts := func(l *Limit) bool { return l != nil && l.Unit == "count" }
	switch {
	case counts(l.Day.Max) && counts(l.Week.Max) && l.Day.Max.Value > l.Week.Max.Value:
		return fmt.Errorf("the daily maximum is above the weekly maximum")
	case counts(l.Week.Max) && counts(l.Month.Max) && l.Week.Max.Value > l.Month.Max.Value:
		return fmt.Errorf("the weekly maximum is above the monthly maximum")
	case counts(l.Day.Min) && counts(l.Week.Max) && l.Day.Min.Value > l.Week.Max.Value:
		return fmt.Errorf("the daily minimum is above the weekly maximum")
	}
	return nil
}

func (l AgentLimits) Value() (driver.Value, error) { return json.Marshal(l) }
func (l *AgentLimits) Scan(src any) error          { return scanJSON(src, l) }

func (c Columns) Value() (driver.Value, error) { return json.Marshal(c) }
func (c *Columns) Scan(src any) error          { return scanJSON(src, c) }

type ImportRun struct {
	ID         uuid.UUID  `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	TaskTypeID uuid.UUID  `gorm:"type:uuid" json:"task_type_id"`
	Source     string     `json:"source"`
	WorkDate   Date       `json:"work_date"`
	Filename   string     `json:"filename"`
	UserID     *uuid.UUID `gorm:"type:uuid" json:"user_id"`
	RowsRead   int        `json:"rows_read"`
	Created    int        `json:"created"`
	Duplicates int        `json:"duplicates"`
	Rejected   int        `json:"rejected"`
	Skipped    int        `json:"skipped"`
	Sampled    int        `json:"sampled"`
	Status     string     `json:"status"`
	Error      string     `json:"error"`
	Detail     JSONMap    `gorm:"type:jsonb" json:"detail"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
}

type TaskState string

const (
	StateUnsampled TaskState = "unsampled"
	StateReview    TaskState = "review" // a reported task (negative, TL escalation) waiting for the supervisor
	StateReady     TaskState = "ready"
	StateAssigned  TaskState = "assigned"
	StateCompleted TaskState = "completed"
	StateCancelled TaskState = "cancelled"
)

// Kind is how an audit came about. Only the counted kinds feed agent scores.
type Kind string

const (
	KindSample     Kind = "sample"
	KindLive       Kind = "live"
	KindEscalation Kind = "escalation"
	KindFocus      Kind = "focus"
	KindRotation   Kind = "rotation"
	KindNegative   Kind = "negative" // a reported negative review; tracked apart from scores
	// KindTLEscalation is a team leader's or special process agent's
	// escalation, named after their job title (data.source, "A-Z Guarantee
	// Team Leader escalation"); reviewed like a negative.
	KindTLEscalation Kind = "tl_escalation"
	// KindQAEscalation is raised by a QA agent and decided by the supervisor.
	KindQAEscalation Kind = "qa_escalation"
)

// ReviewedKinds are escalations: reported, then decided Valid or Not valid,
// never scored and never disputed. They are tracked apart from quality
// scores.
const ReviewedKinds = "('negative','tl_escalation','qa_escalation')"

func (k Kind) Reviewed() bool {
	return k == KindNegative || k == KindTLEscalation || k == KindQAEscalation
}

// CountedKinds is the SQL list of kinds that count toward agent scores.
const CountedKinds = "('sample','live','escalation')"

func (k Kind) Counts() bool { return k == KindSample || k == KindLive || k == KindEscalation }

const (
	ResultPass       = "pass"
	ResultBorderline = "borderline"
	ResultFail       = "fail"
)

type Task struct {
	ID             uuid.UUID          `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	TaskTypeID     uuid.UUID          `gorm:"type:uuid" json:"task_type_id"`
	ImportRunID    *uuid.UUID         `gorm:"type:uuid" json:"import_run_id"`
	EmployeeID     uuid.UUID          `gorm:"type:uuid" json:"employee_id"`
	ExternalID     string             `json:"external_id"`
	WorkDate       Date               `json:"work_date"`
	Labels         Strings            `gorm:"type:jsonb" json:"labels"`
	Data           JSONMap            `gorm:"type:jsonb" json:"data"`
	State          TaskState          `json:"state"`
	AssignedQAID   *uuid.UUID         `gorm:"column:assigned_qa_id;type:uuid" json:"assigned_qa_id"`
	AssignedAt     *time.Time         `json:"assigned_at"`
	QueuePosition  *int               `json:"queue_position"`
	CancelReason   string             `json:"cancel_reason"`
	Scorecard      *scorecard.Card    `gorm:"type:jsonb" json:"scorecard"`
	Answers        *scorecard.Answers `gorm:"type:jsonb" json:"answers"`
	Score          *float64           `json:"score"`
	CriticalFailed bool               `json:"critical_failed"`
	Passed         *bool              `json:"passed"`
	Result         *string            `json:"result"`
	EvaluatedBy    *uuid.UUID         `gorm:"type:uuid" json:"evaluated_by"`
	SubmittedAt    *time.Time         `json:"submitted_at"`
	CompletedAt    *time.Time         `json:"completed_at"`

	Kind          Kind       `json:"kind"`
	Priority      int        `json:"priority"`
	CreatedBy     *uuid.UUID `gorm:"type:uuid" json:"created_by"`
	Note          string     `json:"note"`
	LiveStartedAt *time.Time `json:"live_started_at"`
	MatchStatus   string     `json:"match_status"`
	RotationOf    *uuid.UUID `gorm:"type:uuid" json:"rotation_of"`

	AckStatus         string     `json:"ack_status"`
	AckComment        string     `json:"ack_comment"`
	AckAt             *time.Time `json:"ack_at"`
	DisputeResolution string     `json:"dispute_resolution"`
	DisputeResolvedBy *uuid.UUID `gorm:"type:uuid" json:"dispute_resolved_by"`
	DisputeResolvedAt *time.Time `json:"dispute_resolved_at"`

	// Finding is what whoever decided an escalation found.
	Finding string `json:"finding"`

	// OrderNumbers are the orders the work was about, as the QA agent entered them.
	OrderNumbers Strings `gorm:"type:jsonb" json:"order_numbers"`

	// RevealedAt is when the agent got to see it: finished audits stay hidden
	// from them until their team's scores are revealed (handleReveal).
	RevealedAt *time.Time `json:"revealed_at"`

	// FocusPlanID is the focus plan a focus audit belongs to.
	FocusPlanID *uuid.UUID `gorm:"type:uuid" json:"focus_plan_id"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// FocusPlan is a planned set of focus audits of one agent's work for one QA
// agent: some codes (none: any, at random) in a date range, and why.
type FocusPlan struct {
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	DepartmentID uuid.UUID  `gorm:"type:uuid" json:"department_id"`
	TaskTypeID   uuid.UUID  `gorm:"type:uuid" json:"task_type_id"`
	EmployeeID   uuid.UUID  `gorm:"type:uuid" json:"employee_id"`
	AssignedQAID uuid.UUID  `gorm:"column:assigned_qa_id;type:uuid" json:"assigned_qa_id"`
	CreatedBy    uuid.UUID  `gorm:"type:uuid" json:"created_by"`
	Labels       Strings    `gorm:"type:jsonb" json:"labels"`
	FromDate     Date       `json:"from_date"`
	ToDate       Date       `json:"to_date"`
	Asked        int        `json:"asked"`
	Pulled       int        `json:"pulled"`
	Reason       string     `json:"reason"`
	Status       string     `json:"status"` // open, done, cancelled
	CreatedAt    time.Time  `json:"created_at"`
	ClosedAt     *time.Time `json:"closed_at"`
	ClosedBy     *uuid.UUID `gorm:"type:uuid" json:"closed_by"`
	CancelReason string     `json:"cancel_reason"`
}

type Coaching struct {
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	DepartmentID uuid.UUID  `gorm:"type:uuid" json:"department_id"`
	EmployeeID   uuid.UUID  `gorm:"type:uuid" json:"employee_id"`
	Topic        string     `json:"topic"`
	Kind         string     `json:"kind"`   // coaching or refresher
	Logged       bool       `json:"logged"` // logged by a QA agent after the fact; no acknowledgement
	TaskIDs      Strings    `gorm:"column:task_ids;type:jsonb" json:"task_ids"`
	AssignedQAID uuid.UUID  `gorm:"column:assigned_qa_id;type:uuid" json:"assigned_qa_id"`
	CreatedBy    *uuid.UUID `gorm:"type:uuid" json:"created_by"`
	DueDate      *Date      `json:"due_date"`
	Status       string     `json:"status"`
	Notes        string     `json:"notes"`
	Outcome      string     `json:"outcome"`
	CompletedAt  *time.Time `json:"completed_at"`
	AckAt        *time.Time `json:"ack_at"`
	AckComment   string     `json:"ack_comment"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// EvaluationChange is a QA agent's change to the answers of a submitted
// audit, waiting for a supervisor. Until it is approved the audit keeps its
// score.
type EvaluationChange struct {
	ID           uuid.UUID          `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	TaskID       uuid.UUID          `gorm:"type:uuid" json:"task_id"`
	RequestedBy  uuid.UUID          `gorm:"type:uuid" json:"requested_by"`
	Answers      *scorecard.Answers `gorm:"type:jsonb" json:"answers"`
	Reason       string             `json:"reason"`
	ScoreBefore  *float64           `json:"score_before"`
	Score        *float64           `json:"score"`  // with these answers
	Status       string             `json:"status"` // pending, approved, rejected
	DecidedBy    *uuid.UUID         `gorm:"type:uuid" json:"decided_by"`
	DecidedAt    *time.Time         `json:"decided_at"`
	DecisionNote string             `json:"decision_note"`
	CreatedAt    time.Time          `json:"created_at"`
}

type AuditLog struct {
	ID        int64      `gorm:"primaryKey" json:"id"`
	TaskID    *uuid.UUID `gorm:"type:uuid" json:"task_id"`
	ActorID   *uuid.UUID `gorm:"type:uuid" json:"actor_id"`
	Action    string     `json:"action"`
	Detail    JSONMap    `gorm:"type:jsonb" json:"detail"`
	CreatedAt time.Time  `json:"created_at"`
}

// JSONMap is a free-form jsonb object.
type JSONMap map[string]any

func (m JSONMap) Value() (driver.Value, error) {
	if m == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(m)
}
func (m *JSONMap) Scan(src any) error { return scanJSON(src, m) }

// Strings is a jsonb array of strings (labels, skip lists).
type Strings []string

func (s Strings) Value() (driver.Value, error) {
	if s == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(s)
}
func (s *Strings) Scan(src any) error { return scanJSON(src, s) }

// Date is a calendar day (Postgres date), serialised as YYYY-MM-DD.
type Date struct{ time.Time }

func ParseDate(s string) (Date, error) {
	t, err := time.Parse(time.DateOnly, s)
	return Date{t}, err
}

func (d Date) String() string { return d.Format(time.DateOnly) }

func (d Date) Value() (driver.Value, error) { return d.String(), nil }

func (d *Date) Scan(src any) error {
	t, ok := src.(time.Time)
	if !ok {
		return errors.New("model: Date scan expects time.Time")
	}
	d.Time = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	return nil
}

func (d Date) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

func (d *Date) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	parsed, err := ParseDate(s)
	*d = parsed
	return err
}

func scanJSON(src any, dst any) error {
	switch v := src.(type) {
	case nil:
		return nil
	case []byte:
		return json.Unmarshal(v, dst)
	case string:
		return json.Unmarshal([]byte(v), dst)
	}
	return errors.New("model: unsupported jsonb scan source")
}
