package assign

import (
	"testing"

	"github.com/google/uuid"
)

func TestPlanStaysInDepartmentAndRespectsCap(t *testing.T) {
	calls, tickets := uuid.New(), uuid.New()
	a1 := Agent{ID: uuid.New(), DepartmentID: calls, Limit: 2, NextPosition: 1}
	a2 := Agent{ID: uuid.New(), DepartmentID: calls, Open: 1, Limit: 2, NextPosition: 2}
	t1 := Agent{ID: uuid.New(), DepartmentID: tickets, Limit: 0, NextPosition: 1}

	var tasks []ReadyTask
	for range 5 {
		tasks = append(tasks, ReadyTask{ID: uuid.New(), DepartmentID: calls})
	}
	tasks = append(tasks, ReadyTask{ID: uuid.New(), DepartmentID: tickets})

	got := map[uuid.UUID]int{}
	for _, a := range Plan(tasks, []Agent{a1, a2, t1}) {
		got[a.AgentID]++
	}
	// Calls has room for 3 (2 + 1); the other 2 calls tasks stay ready, and
	// the tickets agent never receives calls work.
	if got[a1.ID] != 2 || got[a2.ID] != 1 || got[t1.ID] != 1 {
		t.Fatalf("unexpected plan: a1=%d a2=%d t1=%d", got[a1.ID], got[a2.ID], got[t1.ID])
	}
}

func TestEscalationIgnoresCap(t *testing.T) {
	dept := uuid.New()
	full := Agent{ID: uuid.New(), DepartmentID: dept, Open: 3, Limit: 3, NextPosition: 4}
	plan := Plan([]ReadyTask{{ID: uuid.New(), DepartmentID: dept, Priority: 10}, {ID: uuid.New(), DepartmentID: dept}}, []Agent{full})
	if len(plan) != 1 || plan[0].AgentID != full.ID {
		t.Fatalf("want only the escalation assigned past the cap, got %+v", plan)
	}
}
