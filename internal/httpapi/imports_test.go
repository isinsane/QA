package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oaldesi/qa-portal/internal/model"
)

func TestWrongDay(t *testing.T) {
	day, _ := model.ParseDate("2026-10-15")
	if msg := wrongDay(map[string]int{"2026-10-15": 900, "2026-10-14": 20}, day); msg != "" {
		t.Errorf("the day's sheet refused: %s", msg)
	}
	if msg := wrongDay(map[string]int{}, day); msg != "" {
		t.Errorf("a sheet without start times refused: %s", msg)
	}
	msg := wrongDay(map[string]int{"2026-10-14": 1500, "2026-10-15": 3}, day)
	if !strings.Contains(msg, "Wed, Oct 14, 2026 (1500 calls)") || !strings.Contains(msg, "Thu, Oct 15, 2026") {
		t.Errorf("yesterday's sheet: %q", msg)
	}
}

// Phone and order number are asked on every live audit but may stay empty;
// the sheet's other columns are required, the code is not.
func TestLiveDetails(t *testing.T) {
	tt := &model.TaskType{Columns: model.Columns{RowColumn: "Service name", RowValues: model.Strings{"Other Sales"}}}
	fields := []string{"Connect from", "Disposition code", "Phone number"}
	got := liveDetails(tt, fields, map[string]string{"Connect from": " 5551234 ", "Service name": "New Sales", "Agent": "x"})
	want := map[string]string{"Connect from": "5551234", "Disposition code": "", "Phone number": "", "Service name": "Other Sales"}
	if len(got) != len(want) {
		t.Errorf("got %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q (nothing required, the type's own service name)", k, got[k], v)
		}
	}
}

func TestOrderNumbers(t *testing.T) {
	w := httptest.NewRecorder()
	got, ok := orderNumbers(w, []string{" 113-1 ", "", "113-2", "113-1"})
	if !ok || len(got) != 2 || got[0] != "113-1" || got[1] != "113-2" {
		t.Errorf("got %v, %v; want trimmed, no blanks or repeats", got, ok)
	}
	if got, ok := orderNumbers(w, nil); !ok || got == nil || len(got) != 0 {
		t.Errorf("none entered: got %v, %v; want an empty list", got, ok)
	}
	if _, ok := orderNumbers(httptest.NewRecorder(), []string{strings.Repeat("9", 101)}); ok {
		t.Error("a 101-character order number was accepted")
	}
}
