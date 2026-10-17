package importer

import (
	"testing"
	"time"

	"github.com/oaldesi/qa-portal/internal/model"
)

func TestPullDays(t *testing.T) {
	now := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	created := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	done := map[string]bool{"2026-10-18": true, "2026-10-17": true}
	got := pullDays(now, created, func(d model.Date) bool { return done[d.String()] })
	want := []string{"2026-10-19", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"}
	if len(got) != len(want) {
		t.Fatalf("days = %v, want %v", got, want)
	}
	for i, d := range got {
		if d.String() != want[i] {
			t.Errorf("day %d = %s, want %s", i, d, want[i])
		}
	}
	// A type created this morning: only yesterday, nothing older.
	got = pullDays(now, now.Add(-2*time.Hour), func(model.Date) bool { return false })
	if len(got) != 1 || got[0].String() != "2026-10-19" {
		t.Errorf("new type: %v, want just yesterday", got)
	}
}
