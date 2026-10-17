package importer

import (
	"testing"

	"github.com/google/uuid"
)

func TestNameKey(t *testing.T) {
	same := [][2]string{
		{"Lena AlFarsi", "AlFarsi Lena"}, // the HR sheet swaps some first/last names
		{"Lena Al-Farsi", "lena  alfarsi"},
		{"Thomas Whitfield", "THOMAS WHITFIELD"},
	}
	for _, p := range same {
		if NameKey(p[0]) != NameKey(p[1]) {
			t.Errorf("%q and %q should match", p[0], p[1])
		}
	}
	if NameKey("Ina Al-Hakim") == NameKey("Lena AlFarsi") {
		t.Error("different people matched")
	}
}

func TestAliasEmail(t *testing.T) {
	for name, want := range map[string]string{"Mary Stone": "mstone", "Anna Maria Lopez": "alopez", "Victor Hale": "vhale", "Zed": ""} {
		if got := aliasEmail(name); got != want {
			t.Errorf("aliasEmail(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestMovesTeam(t *testing.T) {
	calls, tickets, chat := uuid.New(), uuid.New(), uuid.New()
	named := map[uuid.UUID]bool{calls: true, tickets: true} // the sheet never names live chat
	cases := []struct {
		cur  *uuid.UUID
		next uuid.UUID
		want bool
	}{
		{nil, calls, true},      // no team yet
		{&calls, tickets, true}, // HR moved them
		{&calls, calls, false},  // already there
		{&chat, tickets, false}, // set up by hand in a team HR doesn't feed
	}
	for i, c := range cases {
		if got := movesTeam(c.cur, c.next, named); got != c.want {
			t.Errorf("case %d: got %v, want %v", i, got, c.want)
		}
	}
}
