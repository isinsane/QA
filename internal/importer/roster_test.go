package importer

import "testing"

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
