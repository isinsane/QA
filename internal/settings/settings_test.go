package settings

import (
	"testing"
	"time"
)

func TestDefaultsAreValid(t *testing.T) {
	if err := Defaults().Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestClocks(t *testing.T) {
	s := Defaults()
	if _, off := time.Date(2026, 10, 14, 8, 0, 0, 0, s.CallClock()).Zone(); off != -5*3600 {
		t.Fatalf("offset %d", off)
	}
	s.CallUTCOffset = "five"
	if s.Validate() == nil {
		t.Fatal("bad offset accepted")
	}
	s = Defaults()
	s.BusinessTimezone = "Mars/Base"
	if s.Validate() == nil {
		t.Fatal("bad zone accepted")
	}
}

func TestReplyBucket(t *testing.T) {
	s := Defaults() // 1, 2, 3+
	for n, want := range map[int]string{0: "1 reply", 1: "1 reply", 2: "2 replies", 3: "3+ replies", 9: "3+ replies"} {
		if got := s.ReplyBucket(n); got != want {
			t.Errorf("%d replies: got %q, want %q", n, got, want)
		}
	}
	s.ReplyBucketsTop = 1
	if got := s.ReplyBucket(1); got != "1+ replies" {
		t.Errorf("top 1: got %q", got)
	}
}

func TestChatBucket(t *testing.T) {
	s := Defaults()
	for replies, want := range map[int]string{0: "1–5 replies", 1: "1–5 replies", 5: "1–5 replies", 6: "6–10 replies", 15: "11–15 replies", 16: "16+ replies", 40: "16+ replies"} {
		if got := s.ChatBucket(replies); got != want {
			t.Errorf("%d replies: %q, want %q", replies, got, want)
		}
	}
}
