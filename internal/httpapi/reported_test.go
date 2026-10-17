package httpapi

import (
	"testing"

	"github.com/oaldesi/qa-portal/internal/model"
)

func TestEscalationSource(t *testing.T) {
	cases := []struct {
		u    model.User
		want string
	}{
		{model.User{Role: model.RoleSpecialProcess, Profile: model.JSONMap{"job_title": " A-Z Guarantee Team Leader "}}, "A-Z Guarantee Team Leader escalation"},
		{model.User{Role: model.RoleSpecialProcess}, "Special process escalation"},
		{model.User{Role: model.RoleTeamLeader, Profile: model.JSONMap{}}, "Team leader escalation"},
		{model.User{Role: model.RoleTeamLeader, Profile: model.JSONMap{"job_title": "Tickets Floor Support"}}, "Tickets Floor Support escalation"},
	}
	for _, c := range cases {
		if got := escalationSource(&c.u); got != c.want {
			t.Errorf("escalationSource(%v) = %q, want %q", c.u.Profile, got, c.want)
		}
	}
}
