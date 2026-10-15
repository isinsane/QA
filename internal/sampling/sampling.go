// Package sampling picks which of one day's rows get audited.
//
// Two pools, each with its own percentage:
//
//   - Tagged rows (a disposition code or a ticket tag), per agent:
//     ceil(X% × the agent's tagged rows), so anyone with tagged work gets at
//     least one. Picks are spread across tags — the least-picked tag goes
//     next, chosen uniformly among ties, so 30 "Fitment Check" calls and 2
//     "Warranty" calls yield Warranty before a second Fitment Check — and,
//     within a tag, across buckets (ticket reply counts: 1 / 2 / 3+).
//   - Untagged rows, pooled across all agents: ceil(Y% × all of them), each
//     pick going to the agent with the fewest picks so far, then spread
//     across buckets.
//
// Per-agent bounds come on top: nobody gets more than their Max, and anyone
// under their Min is topped up from their remaining rows, spread across
// labels the same way.
package sampling

import (
	"math"
	"math/rand/v2"
	"sort"
)

// Item is one row.
type Item struct {
	Agent  string
	Labels []string
	Bucket string // a second spread within a label; "" when unused
}

// Count is how many of n rows to audit at percent (0-100): rounded up, so a
// pool with any rows gets at least one.
func Count(n int, percent float64) int {
	if n <= 0 || percent <= 0 {
		return 0
	}
	// The epsilon keeps 30 × 10% from becoming 4 through float error.
	return min(int(math.Ceil(float64(n)*percent/100-1e-9)), n)
}

// Bound is how many of one agent's rows Plan may pick: at least Min, at most
// Max (-1: no limit). Max wins when they clash.
type Bound struct{ Min, Max int }

// Plan returns the indexes of the picked items, sorted. Agents missing from
// bounds have no bounds.
func Plan(items []Item, taggedPercent, untaggedPercent float64, bounds map[string]Bound, rng *rand.Rand) []int {
	bound := func(agent string) Bound {
		if b, ok := bounds[agent]; ok {
			return b
		}
		return Bound{Max: -1}
	}
	tagged := map[string][]int{}
	var untagged []int
	for i, it := range items {
		if len(it.Labels) > 0 {
			tagged[it.Agent] = append(tagged[it.Agent], i)
		} else {
			untagged = append(untagged, i)
		}
	}

	used := map[int]bool{}
	perAgent := map[string]int{}
	for _, agent := range sortedKeys(tagged) {
		rows := tagged[agent]
		k := Count(len(rows), taggedPercent)
		if b := bound(agent); b.Max >= 0 {
			k = min(k, b.Max)
		}
		labelCount, bucketCount := map[string]int{}, map[string]int{}
		for range k {
			// The least-picked label that still has an unpicked row.
			byLabel := map[string][]int{}
			for _, i := range rows {
				if !used[i] {
					for _, l := range items[i].Labels {
						byLabel[l] = append(byLabel[l], i)
					}
				}
			}
			label := pickLeast(sortedKeys(byLabel), func(l string) int { return labelCount[l] }, rng)
			i := pickLeastRow(byLabel[label], items, bucketCount, rng)
			used[i] = true
			for _, l := range items[i].Labels {
				labelCount[l]++ // a ticket with several tags covers all of them
			}
			bucketCount[items[i].Bucket]++
			perAgent[agent]++
		}
	}

	// Everyone up to their minimum, before the pool, so the pool goes to
	// whoever is still lowest.
	all := map[string][]int{}
	for i, it := range items {
		all[it.Agent] = append(all[it.Agent], i)
	}
	for _, agent := range sortedKeys(all) {
		b := bound(agent)
		need := b.Min
		if b.Max >= 0 {
			need = min(need, b.Max)
		}
		labelCount, bucketCount := map[string]int{}, map[string]int{}
		for _, i := range all[agent] {
			if used[i] {
				labelCount[firstLabel(items[i])]++
				bucketCount[items[i].Bucket]++
			}
		}
		for perAgent[agent] < need {
			byLabel := map[string][]int{}
			for _, i := range all[agent] {
				if !used[i] {
					byLabel[firstLabel(items[i])] = append(byLabel[firstLabel(items[i])], i)
				}
			}
			if len(byLabel) == 0 {
				break
			}
			label := pickLeast(sortedKeys(byLabel), func(l string) int { return labelCount[l] }, rng)
			i := pickLeastRow(byLabel[label], items, bucketCount, rng)
			used[i] = true
			labelCount[label]++
			bucketCount[items[i].Bucket]++
			perAgent[agent]++
		}
	}

	bucketCount := map[string]int{}
	for range Count(len(untagged), untaggedPercent) {
		byAgent := map[string][]int{}
		for _, i := range untagged {
			if b := bound(items[i].Agent); !used[i] && (b.Max < 0 || perAgent[items[i].Agent] < b.Max) {
				byAgent[items[i].Agent] = append(byAgent[items[i].Agent], i)
			}
		}
		if len(byAgent) == 0 {
			break
		}
		agent := pickLeast(sortedKeys(byAgent), func(a string) int { return perAgent[a] }, rng)
		i := pickLeastRow(byAgent[agent], items, bucketCount, rng)
		used[i] = true
		perAgent[agent]++
		bucketCount[items[i].Bucket]++
	}

	picked := make([]int, 0, len(used))
	for i := range used {
		picked = append(picked, i)
	}
	sort.Ints(picked)
	return picked
}

func firstLabel(it Item) string {
	if len(it.Labels) == 0 {
		return ""
	}
	return it.Labels[0]
}

// pickLeast returns, uniformly among ties, a key with the lowest count.
// Keys come sorted so the rng is the only source of randomness.
func pickLeast(keys []string, count func(string) int, rng *rand.Rand) string {
	var best []string
	lowest := math.MaxInt
	for _, k := range keys {
		switch c := count(k); {
		case c < lowest:
			lowest, best = c, []string{k}
		case c == lowest:
			best = append(best, k)
		}
	}
	return best[rng.IntN(len(best))]
}

// pickLeastRow returns one of rows whose bucket has been picked least.
func pickLeastRow(rows []int, items []Item, bucketCount map[string]int, rng *rand.Rand) int {
	var best []int
	lowest := math.MaxInt
	for _, i := range rows {
		switch c := bucketCount[items[i].Bucket]; {
		case c < lowest:
			lowest, best = c, []int{i}
		case c == lowest:
			best = append(best, i)
		}
	}
	return best[rng.IntN(len(best))]
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
