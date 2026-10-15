package importer

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
	"github.com/oaldesi/qa-portal/internal/settings"
)

// The HR sheet's headers, compared without case. Only name and email (or an
// Employee ID) are required; the rest fills in when present.
var rosterColumns = map[string][]string{
	"hr_id":        {"employee id", "hr id"},
	"name":         {"full name", "name"},
	"first":        {"first name"},
	"last":         {"last name"},
	"email":        {"email", "work email"},
	"department":   {"department"},
	"alias_first":  {"alias first name"},
	"alias_last":   {"alias last name"},
	"agent_code":   {"agent id", "vonage id", "vonage agent id"},
	"edesk_id":     {"edesk id"},
	"organization": {"organization"},
	"job_title":    {"job title"},
	"supervisor":   {"supervisor"},
}

// RosterHeaders picks the HR tab out of a multi-tab workbook.
var RosterHeaders = []string{"Email"}

type RosterOptions struct {
	// Scope confines the import to one department (a supervisor's); nil = all.
	Scope             *uuid.UUID
	DryRun            bool
	DeactivateMissing bool
}

type RosterChange struct {
	Name       string   `json:"name"`
	Action     string   `json:"action"` // added, updated, deactivated
	Department string   `json:"department"`
	Fields     []string `json:"fields,omitempty"`
}

type RowError struct {
	Row     int    `json:"row"`
	Message string `json:"message"`
}

type RosterResult struct {
	Added       int            `json:"added"`
	Updated     int            `json:"updated"`
	Unchanged   int            `json:"unchanged"`
	Deactivated int            `json:"deactivated"`
	Skipped     map[string]int `json:"skipped"` // HR department not audited → rows
	Changes     []RosterChange `json:"changes"`
	Errors      []RowError     `json:"errors"`
	DryRun      bool           `json:"dry_run"`
}

// ImportRoster upserts employees from the HR sheet. It can be uploaded again
// whenever HR updates it: people are matched on Employee ID, then email, then
// (for someone added by hand before the first upload) on name. Rows whose HR
// department has no portal department of the same name are left out.
func ImportRoster(ctx context.Context, db *gorm.DB, s *Sheet, o RosterOptions) (*RosterResult, error) {
	res := &RosterResult{Skipped: map[string]int{}, Changes: []RosterChange{}, Errors: []RowError{}, DryRun: o.DryRun}
	col := func(row map[string]string, field string) string {
		for k, v := range row {
			if slices.Contains(rosterColumns[field], strings.ToLower(strings.TrimSpace(k))) {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}

	var depts []model.Department
	if err := db.WithContext(ctx).Find(&depts).Error; err != nil {
		return nil, err
	}
	deptByName := map[string]model.Department{}
	deptName := map[uuid.UUID]string{}
	for _, d := range depts {
		deptName[d.ID] = d.Name
		hr := d.HRNames
		if len(hr) == 0 {
			hr = model.Strings{d.Name}
		}
		for _, n := range hr {
			deptByName[strings.ToLower(strings.TrimSpace(n))] = d
		}
	}

	var users []model.User
	if err := db.WithContext(ctx).Find(&users).Error; err != nil {
		return nil, err
	}
	byHR, byEmail, byName := map[string]*model.User{}, map[string]*model.User{}, map[string][]*model.User{}
	for i := range users {
		u := &users[i]
		if u.HRID != nil {
			byHR[*u.HRID] = u
		}
		if u.Email != nil {
			byEmail[strings.ToLower(*u.Email)] = u
		}
		if u.HRID == nil {
			byName[NameKey(u.Name)] = append(byName[NameKey(u.Name)], u)
		}
	}

	seenHR := map[string]bool{}
	for i, row := range s.Rows {
		line := i + 2
		hrID, email := col(row, "hr_id"), strings.ToLower(col(row, "email"))
		name := col(row, "name")
		if name == "" {
			name = strings.TrimSpace(col(row, "first") + " " + col(row, "last"))
		}
		if name == "" || (email == "" && hrID == "") {
			res.Errors = append(res.Errors, RowError{line, "needs a name and an Employee ID or email"})
			continue
		}
		if hrID != "" {
			seenHR[hrID] = true
		}
		hrDept := col(row, "department")
		dept, audited := deptByName[strings.ToLower(hrDept)]
		if !audited || (o.Scope != nil && dept.ID != *o.Scope) {
			res.Skipped[hrDept]++
			continue
		}

		u := byHR[hrID]
		if u == nil && email != "" {
			u = byEmail[email]
		}
		if u == nil {
			if same := byName[NameKey(name)]; len(same) == 1 {
				u = same[0]
			}
		}
		isNew := u == nil
		if isNew {
			u = &model.User{Role: model.RoleEmployee, Active: true, IsAvailable: true, QueueLimit: settings.Load(ctx, db).DefaultQueueLimit, DepartmentID: &dept.ID, Profile: model.JSONMap{}}
		}
		if o.Scope != nil && !isNew && u.Role != model.RoleEmployee {
			continue // a supervisor does not edit QA agents or other supervisors from the sheet
		}

		var changed []string
		set := func(field string, cur *string, next string) {
			if next != "" && *cur != next {
				*cur = next
				changed = append(changed, field)
			}
		}
		setPtr := func(field string, cur **string, next string) {
			if next != "" && (*cur == nil || **cur != next) {
				*cur = &next
				changed = append(changed, field)
			}
		}
		set("name", &u.Name, name)
		setPtr("email", &u.Email, email)
		setPtr("employee ID", &u.HRID, hrID)
		set("alias", &u.AliasName, strings.TrimSpace(col(row, "alias_first")+" "+col(row, "alias_last")))
		if code := col(row, "agent_code"); code != "" {
			setPtr("Agent ID", &u.AgentCode, code)
		}
		if id := col(row, "edesk_id"); id != "" {
			setPtr("eDesk ID", &u.EDeskID, id)
		}
		// Department and active status are only the sheet's to decide for
		// employees; a QA agent keeps the department they audit.
		if u.Role == model.RoleEmployee {
			if u.DepartmentID == nil || *u.DepartmentID != dept.ID {
				u.DepartmentID = &dept.ID
				changed = append(changed, "department")
			}
			if !u.Active {
				u.Active = true
				changed = append(changed, "reactivated")
			}
		}
		profile := model.JSONMap{"department": hrDept}
		for _, f := range []string{"organization", "job_title", "supervisor"} {
			if v := col(row, f); v != "" {
				profile[f] = v
			}
		}
		if fmt.Sprint(u.Profile) != fmt.Sprint(profile) {
			u.Profile = profile
			if !isNew {
				changed = append(changed, "job details")
			}
		}

		switch {
		case isNew:
			res.Added++
			res.Changes = append(res.Changes, RosterChange{Name: name, Action: "added", Department: dept.Name})
		case len(changed) > 0:
			res.Updated++
			res.Changes = append(res.Changes, RosterChange{Name: name, Action: "updated", Department: dept.Name, Fields: changed})
		default:
			res.Unchanged++
			continue
		}
		if o.DryRun {
			continue
		}
		if err := db.WithContext(ctx).Select("*").Omit("created_at", "password_hash", "must_change_password").Save(u).Error; err != nil {
			res.Errors = append(res.Errors, RowError{line, name + ": " + friendlyUserError(err)})
			continue
		}
		// Later rows must see this one, e.g. a duplicate email further down.
		byHR[hrID] = u
		if u.Email != nil {
			byEmail[*u.Email] = u
		}
	}

	if o.DeactivateMissing {
		for i := range users {
			u := &users[i]
			if u.Role != model.RoleEmployee || !u.Active || u.HRID == nil || seenHR[*u.HRID] ||
				(o.Scope != nil && (u.DepartmentID == nil || *u.DepartmentID != *o.Scope)) {
				continue
			}
			res.Deactivated++
			name := ""
			if u.DepartmentID != nil {
				name = deptName[*u.DepartmentID]
			}
			res.Changes = append(res.Changes, RosterChange{Name: u.Name, Action: "deactivated", Department: name})
			if !o.DryRun {
				if err := db.WithContext(ctx).Model(u).Update("active", false).Error; err != nil {
					return nil, err
				}
			}
		}
	}
	sort.SliceStable(res.Changes, func(i, j int) bool { return res.Changes[i].Action < res.Changes[j].Action })
	return res, nil
}

func friendlyUserError(err error) string {
	switch msg := err.Error(); {
	case strings.Contains(msg, "idx_users_email"):
		return "email already used by another person in the portal"
	case strings.Contains(msg, "idx_users_hr_id"):
		return "Employee ID already used by another person in the portal"
	case strings.Contains(msg, "idx_users_agent_code"):
		return "Agent ID already used by another person in the portal"
	default:
		return msg
	}
}

var nonLetters = regexp.MustCompile(`[^\p{L}]`)

// NameKey compares names the way people write them inconsistently: case,
// hyphens and word order do not matter ("AlFarsi Lena" = "Lena Al-Farsi").
func NameKey(name string) string {
	var words []string
	for _, w := range strings.Fields(strings.ToLower(name)) {
		if w = nonLetters.ReplaceAllString(w, ""); w != "" {
			words = append(words, w)
		}
	}
	sort.Strings(words)
	return strings.Join(words, " ")
}
