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
