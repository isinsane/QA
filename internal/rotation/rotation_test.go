package rotation

import (
	"testing"
	"time"
)

func TestDueBySpreadsOverTheWeek(t *testing.T) {
	days := []time.Weekday{time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday, time.Saturday, time.Sunday}
	for perWeek, want := range map[int][]int{
		3:  {1, 1, 2, 2, 3, 3, 3}, // Monday, Wednesday, Friday
		1:  {1, 1, 1, 1, 1, 1, 1},
		7:  {1, 2, 3, 4, 5, 6, 7},
		10: {2, 3, 5, 6, 8, 9, 10},
		0:  {0, 0, 0, 0, 0, 0, 0},
	} {
		for i, d := range days {
			if got := dueBy(perWeek, d); got != want[i] {
				t.Errorf("%d a week, by %s: got %d, want %d", perWeek, d, got, want[i])
			}
		}
	}
}
