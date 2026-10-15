package importer

import (
	"testing"

	"github.com/google/uuid"

	"github.com/oaldesi/qa-portal/internal/model"
)

func TestNameIndexFind(t *testing.T) {
	email := func(s string) *string { return &s }
	team := []model.User{
		{ID: uuid.New(), Name: "Bartholomew Al-Nouri"},
		{ID: uuid.New(), Name: "Daniel Whitcombe", Email: email("dwhitcomb@example.com")},
		{ID: uuid.New(), Name: "peter Van-Houten"},
		{ID: uuid.New(), Name: "Sam Carter", Email: email("jdoyle@example.com")},
		{ID: uuid.New(), Name: "Sam Carter", Email: email("carters@example.com")},
		{ID: uuid.New(), Name: "Ina Al-Hakim"},
	}
	idx := newNameIndex(team)
	all := func(model.User) bool { return true }
	for _, c := range []struct{ name, want, how string }{
		{"Peter Vanhouten", "peter Van-Houten", "name"},
		{"Daniel Whitcomb", "Daniel Whitcombe", "email"},
		{"Bartholomew Alnoury", "Bartholomew Al-Nouri", "similar name"},
		{"James Doyle", "Sam Carter", "email"}, // two Sam Carters: the email decides
	} {
		u, how, ok := idx.find(c.name, all)
		if !ok || u.Name != c.want || how != c.how {
			t.Errorf("%q: got %q by %q (ok=%v), want %q by %q", c.name, u.Name, how, ok, c.want, c.how)
		}
	}
	for _, name := range []string{"Sam Carter", "Ina Hakim", "Jane Doe"} {
		if u, how, ok := idx.find(name, all); ok {
			t.Errorf("%q should not match, got %q by %q", name, u.Name, how)
		}
	}
}
