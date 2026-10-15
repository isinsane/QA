package model

import (
	"strings"
	"testing"
)

func TestTaskTypeAudits(t *testing.T) {
	agent := func(dept string) User { return User{Profile: JSONMap{"department": dept}} }
	calls := TaskType{AgentGroups: Strings{"Calls support"}}
	switch {
	case !calls.Audits(agent("Calls support")), !calls.Audits(agent(" calls SUPPORT ")):
		t.Error("a calls agent is refused for calls")
	case calls.Audits(agent("New Sales")):
		t.Error("a sales agent is accepted for calls")
	case !calls.Audits(User{}):
		t.Error("an agent with no HR department (added by hand) is refused")
	case !(TaskType{}).Audits(agent("New Sales")):
		t.Error("a type with no groups refuses someone")
	}
}

func TestLimitsAcrossPeriods(t *testing.T) {
	n := func(v float64) *Limit { return &Limit{Value: v, Unit: "count"} }
	if (AgentLimits{Day: Bounds{Max: n(5)}, Week: Bounds{Max: n(3)}}).Validate() == nil {
		t.Error("a daily max above the weekly max is accepted")
	}
	if err := (AgentLimits{Day: Bounds{Min: n(1), Max: n(2)}, Week: Bounds{Max: n(10)}}).Validate(); err != nil {
		t.Error(err)
	}
}

func TestReviewedKindsAgree(t *testing.T) {
	for _, k := range []Kind{KindSample, KindLive, KindEscalation, KindFocus, KindRotation, KindNegative, KindTLEscalation} {
		inSQL := strings.Contains(ReviewedKinds, "'"+string(k)+"'")
		if inSQL != k.Reviewed() {
			t.Errorf("%s: in ReviewedKinds %v, Reviewed() %v", k, inSQL, k.Reviewed())
		}
	}
}
