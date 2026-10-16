package httpapi

import (
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
func TestCleanLive(t *testing.T) {
	fields := []string{"Direction", "Disposition code", "Phone number", "Order number"}
	got, missing := cleanLive(fields, "Disposition code", map[string]string{"Direction": " Inbound "})
	if missing != "" || got["Direction"] != "Inbound" || got["Phone number"] != "" || got["Order number"] != "" {
		t.Errorf("optional fields left empty: got %v, missing %q", got, missing)
	}
	if _, missing := cleanLive(fields, "Disposition code", map[string]string{"Phone number": "5551234"}); missing != "Direction" {
		t.Errorf("a required column left empty: missing = %q, want Direction", missing)
	}
}
