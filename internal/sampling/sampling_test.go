package sampling

import (
	"math/rand/v2"
	"testing"
)

func TestCount(t *testing.T) {
	for _, c := range []struct {
		n       int
		percent float64
		want    int
	}{{42, 10, 5}, {3, 10, 1}, {30, 10, 3}, {10, 10, 1}, {0, 10, 0}, {5, 100, 5}, {9, 0, 0}} {
		if got := Count(c.n, c.percent); got != c.want {
			t.Errorf("Count(%d, %v) = %d, want %d", c.n, c.percent, got, c.want)
		}
	}
}

func items(agent string, spec map[string]int, untagged int) []Item {
	var out []Item
	for label, n := range spec {
		for range n {
			out = append(out, Item{Agent: agent, Labels: []string{label}})
		}
	}
	for range untagged {
		out = append(out, Item{Agent: agent})
	}
	return out
}

func count(its []Item, picked []int, key func(Item) string) map[string]int {
	got := map[string]int{}
	for _, i := range picked {
		got[key(its[i])]++
	}
	return got
}

func label(it Item) string {
	if len(it.Labels) == 0 {
		return "(untagged)"
	}
	return it.Labels[0]
}

func TestTaggedSpreadsAcrossLabels(t *testing.T) {
	for seed := range uint64(50) {
		rng := rand.New(rand.NewPCG(seed, 1))
		its := items("a", map[string]int{"Fitment Check": 26, "Warranty": 2, "Pricing": 2}, 0)
		// 10% of 30 tagged rows = 3, one of each code.
		got := count(its, Plan(its, 10, 0, nil, rng), label)
		if got["Fitment Check"] != 1 || got["Warranty"] != 1 || got["Pricing"] != 1 {
			t.Fatalf("seed %d: want one of each code, got %v", seed, got)
		}
	}
}

func TestBucketsSpreadWithinALabel(t *testing.T) {
	rng := rand.New(rand.NewPCG(5, 1))
	var its []Item
	for i := range 30 {
		b := "1"
		if i%10 == 0 {
			b = "3+"
		} else if i%5 == 0 {
			b = "2"
		}
		its = append(its, Item{Agent: "a", Labels: []string{"Refund"}, Bucket: b})
	}
	got := count(its, Plan(its, 10, 0, nil, rng), func(it Item) string { return it.Bucket })
	if got["1"] != 1 || got["2"] != 1 || got["3+"] != 1 {
		t.Fatalf("want one per reply bucket, got %v", got)
	}
}

func TestUntaggedIsPooledAcrossAgents(t *testing.T) {
	rng := rand.New(rand.NewPCG(9, 1))
	its := append(items("a", map[string]int{"Refund": 5}, 30), items("b", nil, 30)...)
	its = append(its, items("c", nil, 40)...)
	// Tagged: 10% of a's 5 = 1. Untagged: 3% of 100 pooled = 3, going to the
	// least-picked agents first, so b and c before a.
	picked := Plan(its, 10, 3, nil, rng)
	byAgent := count(its, picked, func(it Item) string { return it.Agent })
	byLabel := count(its, picked, label)
	if len(picked) != 4 || byLabel["Refund"] != 1 || byAgent["b"] < 1 || byAgent["c"] < 1 {
		t.Fatalf("got %d picks, by agent %v, by label %v", len(picked), byAgent, byLabel)
	}
}

func TestBounds(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 1))
	its := items("a", map[string]int{"Refund": 20, "Warranty": 10}, 0) // 50% = 15, capped at 4
	its = append(its, items("b", nil, 10)...)                          // untagged only, at least 2
	its = append(its, items("c", map[string]int{"Pricing": 3}, 0)...)  // at least 5, but has 3
	its = append(its, items("d", map[string]int{"Pricing": 9}, 0)...)  // at least 6, at most 2: max wins
	bounds := map[string]Bound{"a": {Min: 1, Max: 4}, "b": {Min: 2, Max: -1}, "c": {Min: 5, Max: -1}, "d": {Min: 6, Max: 2}}
	got := count(its, Plan(its, 50, 0, bounds, rng), func(it Item) string { return it.Agent })
	if got["a"] != 4 || got["b"] != 2 || got["c"] != 3 || got["d"] != 2 {
		t.Fatalf("got %v", got)
	}
}
