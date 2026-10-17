package edesk

import "testing"

func TestPlainText(t *testing.T) {
	cases := []struct {
		body any
		want string
	}{
		{false, ""}, // status events
		{nil, ""},
		{"  Hi, how can I help?  ", "Hi, how can I help?"},
		{" <div>Yes an exchange for the</div><div>right part &amp; size<br>thanks</div>", "Yes an exchange for the\nright part & size\nthanks"},
		{"a < b", "a < b"},
	}
	for _, c := range cases {
		if got := plainText(c.body); got != c.want {
			t.Errorf("plainText(%#v) = %q, want %q", c.body, got, c.want)
		}
	}
}
