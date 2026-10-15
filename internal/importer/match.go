package importer

import (
	"context"
	"maps"
	"slices"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/oaldesi/qa-portal/internal/model"
)

// How rows find their employee:
//
//   - tickets: the agent's eDesk email.
//   - Vonage calls export: the Agent ID. A new ID is linked to an employee
//     the first time it appears (by name, then alias email) and remembered.
//   - Vonage sales "Search results" export: names only. Matched by name,
//     alias email, or a near-identical spelling; anything but an exact name
//     match is remembered as one of the employee's sheet names.

const namePrefix = "name:"

// agentKey tells one agent's rows apart: Agent ID, email, or name.
func agentKey(tt model.TaskType, r Row) string {
	if k := strings.TrimSpace(r.AgentKey); k != "" {
		if tt.Source == model.SourceTicketsAPI {
			return strings.ToLower(k)
		}
		return k
	}
	if n := NameKey(r.AgentName); n != "" {
		return namePrefix + n
	}
	return ""
}

func matchEmployees(ctx context.Context, db *gorm.DB, tt model.TaskType, rows []Row) (map[string]model.User, []LinkedAgent, error) {
	names := map[string]string{} // key → name as written on the row
	var ids []string
	for _, r := range rows {
		k := agentKey(tt, r)
		if k == "" {
			continue
		}
		if _, seen := names[k]; !seen && !strings.HasPrefix(k, namePrefix) {
			ids = append(ids, k)
		}
		names[k] = r.AgentName
	}

	// Direct matches on Agent ID / email. Deactivated people (left the
	// company) are not on the team, and their ID is never handed to anyone
	// else.
	out := map[string]model.User{}
	held := map[string]bool{}
	if len(ids) > 0 {
		var users []model.User
		q := db.WithContext(ctx).Where("agent_code IN ?", ids)
		if tt.Source == model.SourceTicketsAPI {
			q = db.WithContext(ctx).Where("lower(email) IN ?", ids)
		}
		if err := q.Find(&users).Error; err != nil {
			return nil, nil, err
		}
		for _, u := range users {
			k := ""
			if tt.Source == model.SourceTicketsAPI && u.Email != nil {
				k = strings.ToLower(*u.Email)
			} else if u.AgentCode != nil {
				k = *u.AgentCode
			}
			held[k] = true
			if u.Active {
				out[k] = u
			}
		}
	}
	if tt.Source == model.SourceTicketsAPI {
		return out, nil, nil
	}

	var team []model.User
	if err := db.WithContext(ctx).Where("active").Find(&team).Error; err != nil {
		return nil, nil, err
	}
	idx := newNameIndex(team)
	var linked []LinkedAgent
	taken := map[uuid.UUID]bool{}
	for _, k := range slices.Sorted(maps.Keys(names)) {
		if _, ok := out[k]; ok || held[k] {
			continue
		}
		byName := strings.HasPrefix(k, namePrefix)
		// An Agent ID only goes to someone who has none yet, once per import.
		eligible := func(u model.User) bool { return byName || (u.AgentCode == nil && !taken[u.ID]) }
		u, how, ok := idx.find(names[k], eligible)
		if !ok {
			continue
		}
		out[k] = u
		if !byName {
			taken[u.ID] = true
			linked = append(linked, LinkedAgent{Key: k, Name: names[k], UserID: u.ID, UserName: u.Name, How: how})
		} else if how != "name" {
			linked = append(linked, LinkedAgent{Name: names[k], UserID: u.ID, UserName: u.Name, How: how})
		}
	}
	return out, linked, nil
}

// learn remembers new links: an Agent ID on the employee, or the spelling a
// name-only sheet used, so the next import matches exactly.
func learn(tx *gorm.DB, linked []LinkedAgent) error {
	for _, l := range linked {
		var err error
		if l.Key != "" {
			err = tx.Model(&model.User{}).Where("id = ? AND agent_code IS NULL", l.UserID).Update("agent_code", l.Key).Error
		} else {
			err = tx.Exec(`UPDATE users SET sheet_names = sheet_names || jsonb_build_array(?::text)
				WHERE id = ? AND NOT sheet_names @> jsonb_build_array(?::text)`, l.Name, l.UserID, l.Name).Error
		}
		if err != nil {
			return err
		}
	}
	return nil
}

type nameIndex struct {
	exact map[string][]model.User // NameKey of name, alias, sheet names
	email map[string][]model.User // mailbox before the @
	keys  []string                // every exact key, for near matches
}

func newNameIndex(users []model.User) *nameIndex {
	idx := &nameIndex{exact: map[string][]model.User{}, email: map[string][]model.User{}}
	for _, u := range users {
		seen := map[string]bool{}
		for _, n := range append([]string{u.Name, u.AliasName}, u.SheetNames...) {
			if k := NameKey(n); k != "" && !seen[k] {
				seen[k] = true
				idx.exact[k] = append(idx.exact[k], u)
			}
		}
		if u.Email != nil {
			local, _, _ := strings.Cut(strings.ToLower(*u.Email), "@")
			idx.email[local] = append(idx.email[local], u)
		}
	}
	idx.keys = slices.Sorted(maps.Keys(idx.exact))
	return idx
}

// find returns the one employee a sheet name refers to, and how it was found.
func (idx *nameIndex) find(name string, eligible func(model.User) bool) (model.User, string, bool) {
	one := func(us []model.User) (model.User, bool) {
		us = slices.DeleteFunc(slices.Clone(us), func(u model.User) bool { return !eligible(u) })
		if len(us) == 1 {
			return us[0], true
		}
		return model.User{}, false
	}
	key := NameKey(name)
	if u, ok := one(idx.exact[key]); ok {
		return u, "name", true
	}
	if u, ok := one(idx.email[aliasEmail(name)]); ok {
		return u, "email", true
	}
	// A near-identical spelling ("Bartholomew Alnoury" for "Bartholomew
	// Al-Nouri"): at most 2 letters apart, on a name long enough that this
	// cannot be a different short name, and no other employee as close.
	if len(key) < 10 {
		return model.User{}, "", false
	}
	best, bestKeys := 3, []string{}
	for _, k := range idx.keys {
		switch d := levenshtein(key, k); {
		case d < best:
			best, bestKeys = d, []string{k}
		case d == best:
			bestKeys = append(bestKeys, k)
		}
	}
	var close []model.User
	for _, k := range bestKeys {
		close = append(close, idx.exact[k]...)
	}
	if u, ok := one(close); ok && best <= 2 {
		return u, "similar name", true
	}
	return model.User{}, "", false
}

// aliasEmail is the mailbox an alias name maps to: first initial plus last
// name, "John Paul Jones" → "jjones".
func aliasEmail(name string) string {
	var words []string
	for _, w := range strings.Fields(strings.ToLower(name)) {
		if w = nonLetters.ReplaceAllString(w, ""); w != "" {
			words = append(words, w)
		}
	}
	if len(words) < 2 {
		return ""
	}
	return string([]rune(words[0])[:1]) + words[len(words)-1]
}

func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}
