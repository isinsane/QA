package scorecard

import "testing"

var card = Card{
	{ID: "greet", Label: "Greeting", Type: YesNo, Points: 10, AllowNA: true},
	{ID: "tone", Label: "Tone", Type: Scale, Points: 20, ScaleMax: 4},
	{ID: "res", Label: "Resolution", Type: Dropdown, Options: []Option{
		{Label: "Met", Points: 10}, {Label: "Partial", Points: 5}, {Label: "Not met", Points: 0},
	}},
	{ID: "verify", Label: "Verified customer", Type: YesNo, Points: 10, Critical: true},
	{ID: "notes", Label: "Coaching notes", Type: Text},
}

func TestValidate(t *testing.T) {
	if err := Validate(card); err != nil {
		t.Fatalf("valid card rejected: %v", err)
	}
	yes := func(id, label string) Metric { return Metric{ID: id, Label: label, Type: YesNo, Points: 10} }
	for name, bad := range map[string]Card{
		"critical text":       {yes("a", "A"), {ID: "x", Label: "Bad", Type: Text, Critical: true}},
		"same label":          {yes("a", "Greeting"), yes("b", " greeting ")},
		"too many points":     {{ID: "a", Label: "A", Type: YesNo, Points: 500}},
		"scale too long":      {{ID: "a", Label: "A", Type: Scale, Points: 10, ScaleMax: 50}},
		"receiver allows N/A": {yes("a", "A"), {ID: "b", Label: "B", Type: YesNo, Points: 10, AllowNA: true, NAReceiver: true}},
		"only text":           {{ID: "x", Label: "Notes", Type: Text}},
		"everything N/A":      {{ID: "a", Label: "A", Type: YesNo, Points: 10, AllowNA: true}},
		"duplicate option":    {{ID: "a", Label: "A", Type: Dropdown, Options: []Option{{Label: "Met", Points: 5}, {Label: "met", Points: 0}}}},
	} {
		if Validate(bad) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if Validate(Card{}) != nil {
		t.Error("an empty scorecard (new task type) is rejected")
	}
}

func TestScore(t *testing.T) {
	cases := []struct {
		name     string
		answers  Answers
		score    float64
		critical bool
		passed   bool
	}{
		// 10 + 15 + 5 + 10 = 40 of 50.
		{"mixed", Answers{{"greet", "yes", ""}, {"tone", "3", ""}, {"res", "Partial", ""}, {"verify", "yes", ""}}, 80, false, true},
		// Greeting N/A leaves 35 of 40.
		{"na excluded", Answers{{"greet", "na", ""}, {"tone", "3", ""}, {"res", "Met", ""}, {"verify", "yes", ""}}, 87.5, false, true},
		// Everything else perfect, but the critical metric failed.
		{"critical zeroes", Answers{{"greet", "yes", ""}, {"tone", "4", ""}, {"res", "Met", ""}, {"verify", "no", "did not verify"}}, 0, true, false},
		{"below threshold", Answers{{"greet", "no", ""}, {"tone", "2", ""}, {"res", "Not met", ""}, {"verify", "yes", ""}}, 40, false, false},
	}
	for _, c := range cases {
		r, err := Score(card, c.answers, Thresholds{Pass: 80, Borderline: 70})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if r.Score == nil || *r.Score != c.score || r.CriticalFailed != c.critical || r.Passed != c.passed {
			t.Errorf("%s: got score=%v critical=%v passed=%v", c.name, *r.Score, r.CriticalFailed, r.Passed)
		}
	}

	if _, err := Score(card, Answers{{"greet", "yes", ""}}, Thresholds{80, 70}); err == nil {
		t.Error("missing answers accepted")
	}
	if _, err := Score(card, Answers{{"greet", "yes", ""}, {"tone", "3", ""}, {"res", "Met", ""}, {"verify", "na", ""}}, Thresholds{80, 70}); err == nil {
		t.Error("N/A accepted on a metric that does not allow it")
	}
}

func TestNAWeightMovesToReceivers(t *testing.T) {
	// The IT lead's example: A (20%) is N/A, so its weight moves to B and C
	// (40% together), which become 60%.
	c := Card{
		{ID: "a", Label: "A", Type: YesNo, Points: 20, AllowNA: true},
		{ID: "b", Label: "B", Type: YesNo, Points: 20, NAReceiver: true},
		{ID: "c", Label: "C", Type: YesNo, Points: 20, NAReceiver: true},
		{ID: "d", Label: "D", Type: YesNo, Points: 20},
		{ID: "e", Label: "E", Type: YesNo, Points: 20},
	}
	ans := Answers{{"a", "na", ""}, {"b", "yes", ""}, {"c", "no", ""}, {"d", "yes", ""}, {"e", "yes", ""}}
	r, err := Score(c, ans, Thresholds{Pass: 80, Borderline: 70})
	if err != nil {
		t.Fatal(err)
	}
	// B earns 30 of 30, C 0 of 30, D and E 20 each: 70 of 100.
	if *r.Score != 70 || r.Band != "borderline" {
		t.Fatalf("got %v (%s), want 70 borderline", *r.Score, r.Band)
	}
	// With no receivers, N/A just drops out: 60 of 80 = 75.
	for i := range c {
		c[i].NAReceiver = false
	}
	if r, _ := Score(c, ans, Thresholds{80, 70}); *r.Score != 75 {
		t.Fatalf("without receivers got %v, want 75", *r.Score)
	}
	ans[0].Value = "no" // A answered: 60 of 100, below borderline
	if r, _ := Score(c, ans, Thresholds{80, 70}); r.Band != "fail" {
		t.Fatalf("got %s, want fail", r.Band)
	}
}
