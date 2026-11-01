package quota

import (
	"errors"
	"testing"
	"time"
)

func win(id string, used float64, resetSec int64) Window {
	w := Window{ID: id, UsedPercent: used}
	if resetSec != 0 {
		w.ResetsAt = unix(resetSec)
	}
	return w
}

func account(t *testing.T, s *Store, id string) Account {
	t.Helper()
	for _, a := range s.Snapshot() {
		if a.AuthID == id {
			return a
		}
	}
	t.Fatalf("account %q missing from snapshot", id)
	return Account{}
}

func TestStoreWeeklyResetOnlyReportsFutureResets(t *testing.T) {
	s := NewStore()
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowFiveHour, 30, 2000), win(WindowWeekly, 50, 9000)}}, unix(1000), SourceHeaders)

	if reset, ok := s.WeeklyReset("a", unix(1000)); !ok || !reset.Equal(unix(9000)) {
		t.Fatalf("WeeklyReset = %v, %v", reset, ok)
	}
	if _, ok := s.WeeklyReset("a", unix(9000)); ok {
		t.Fatalf("a reset that is not in the future must read as unknown")
	}
	if _, ok := s.WeeklyReset("nobody", unix(1000)); ok {
		t.Fatalf("unknown account must read as unknown")
	}
}

func TestStoreBlockedUntilNeedsEveryExhaustedWindowToClear(t *testing.T) {
	s := NewStore()
	now := unix(1000)
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowFiveHour, 30, 2000), win(WindowWeekly, 50, 9000)}}, now, SourceHeaders)
	if _, blocked := s.BlockedUntil("a", now); blocked {
		t.Fatalf("healthy account reported as blocked")
	}

	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowFiveHour, 100, 3000)}}, unix(1001), SourceHeaders)
	if until, blocked := s.BlockedUntil("a", now); !blocked || !until.Equal(unix(3000)) {
		t.Fatalf("5h exhausted: until=%v blocked=%v", until, blocked)
	}

	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowWeekly, 100, 9000)}}, unix(1002), SourceHeaders)
	if until, blocked := s.BlockedUntil("a", now); !blocked || !until.Equal(unix(9000)) {
		t.Fatalf("both exhausted: until=%v blocked=%v", until, blocked)
	}
	if _, blocked := s.BlockedUntil("a", unix(9000)); blocked {
		t.Fatalf("account stayed blocked after every window reset")
	}
}

func TestAccountBlockedUntilMatchesTheStore(t *testing.T) {
	now := unix(1000)
	account := Account{Windows: []Window{
		win(WindowFiveHour, 100, 2000),
		win(WindowWeekly, 100, 9000),
		win(WindowWeeklyFable, 100, 99000), // model-scoped: never blocks the account
	}}

	if until, blocked := account.BlockedUntil(now); !blocked || !until.Equal(unix(9000)) {
		t.Fatalf("until=%v blocked=%v, want blocked until 9000 (the latest account-wide reset)", until, blocked)
	}
	if _, blocked := account.BlockedUntil(unix(9000)); blocked {
		t.Fatal("still blocked exactly at the last reset")
	}
	if until, blocked := account.BlockedUntil(unix(2000)); !blocked || !until.Equal(unix(9000)) {
		t.Fatalf("after the 5h reset: until=%v blocked=%v, want still blocked by the weekly window", until, blocked)
	}
	if _, blocked := (Account{}).BlockedUntil(now); blocked {
		t.Fatal("an account without windows reported as blocked")
	}
}

func TestStoreBlockedUntilIgnoresModelScopedWindows(t *testing.T) {
	s := NewStore()
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowFiveHour, 10, 2000), win(WindowWeeklyFable, 100, 9000)}}, unix(1000), SourceHeaders)
	if _, blocked := s.BlockedUntil("a", unix(1000)); blocked {
		t.Fatalf("an exhausted Fable window must not block the whole account")
	}
}

func TestStoreObserveKeepsNewestPerWindow(t *testing.T) {
	s := NewStore()
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowWeekly, 10, 9000)}}, unix(100), SourceHeaders)
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowWeekly, 5, 8000)}}, unix(50), SourceHeaders)
	if got := find(t, account(t, s, "a").Windows, WindowWeekly); !approx(got.UsedPercent, 10) {
		t.Fatalf("older observation overwrote a newer one: %+v", got)
	}
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowWeekly, 20, 9500)}}, unix(200), SourcePoll)
	if got := find(t, account(t, s, "a").Windows, WindowWeekly); !approx(got.UsedPercent, 20) || !got.ResetsAt.Equal(unix(9500)) {
		t.Fatalf("newer observation ignored: %+v", got)
	}
}

func TestStoreObserveKeepsPlanAndBankedWhenSourceHasNone(t *testing.T) {
	s := NewStore()
	s.Observe("a", "codex", Observation{Plan: "pro", Banked: &BankedReset{Available: 2}, Windows: []Window{win(WindowFiveHour, 1, 500)}}, unix(100), SourcePoll)
	s.Observe("a", "codex", Observation{Windows: []Window{win(WindowFiveHour, 2, 500)}}, unix(200), SourceHeaders)

	got := account(t, s, "a")
	if got.Plan != "pro" || got.Banked == nil || got.Banked.Available != 2 {
		t.Fatalf("headers-only observation cleared plan/banked: %+v", got)
	}
	if got.Provider != "codex" || got.Source != SourceHeaders || !got.ObservedAt.Equal(unix(200)) {
		t.Fatalf("account metadata = %+v", got)
	}
}

func TestStoreNotePollRecordsErrorAndClearsItOnSuccess(t *testing.T) {
	s := NewStore()
	s.NotePoll("a", "claude", unix(100), errors.New("status 401"))
	if got := account(t, s, "a"); got.PollError != "status 401" || !got.PolledAt.Equal(unix(100)) {
		t.Fatalf("after failed poll: %+v", got)
	}
	s.NotePoll("a", "claude", unix(200), nil)
	if got := account(t, s, "a"); got.PollError != "" || !got.PolledAt.Equal(unix(200)) {
		t.Fatalf("after good poll: %+v", got)
	}
}

func TestStoreAddUsageCountsCacheAndFlagsRebuilds(t *testing.T) {
	s := NewStore(WithRebuildThreshold(100_000))
	s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", Model: "m", SessionID: "s1", At: unix(10), Input: 1000, Output: 200, CacheRead: 50_000})
	s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", Model: "m", SessionID: "s1", At: unix(20), Input: 10, Output: 5, CacheWrite: 800_000})
	s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", Model: "m", SessionID: "s1", At: unix(30), CacheWrite: 99_999})
	s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", Model: "m", SessionID: "s1", At: unix(40), CacheWrite: 100_000})

	got := account(t, s, "a")
	want := CacheCounters{Requests: 4, Input: 1010, Output: 205, CacheRead: 50_000, CacheWrite: 999_999}
	if got.Cache != want {
		t.Fatalf("cache = %+v, want %+v", got.Cache, want)
	}
	// Exactly at the threshold counts; one token below does not. Newest first.
	if len(got.Rebuilds) != 2 || got.Rebuilds[0].CacheWrite != 100_000 || !got.Rebuilds[0].At.Equal(unix(40)) ||
		got.Rebuilds[1].CacheWrite != 800_000 || got.Rebuilds[1].SessionID != "s1" || got.Rebuilds[1].Model != "m" {
		t.Fatalf("rebuilds = %+v", got.Rebuilds)
	}
}

func TestStoreAddUsageIgnoresFailedRequests(t *testing.T) {
	s := NewStore()
	s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", At: unix(10), Failed: true, Input: 5})
	if got := s.Snapshot(); len(got) != 0 {
		t.Fatalf("failed request created an account entry: %+v", got)
	}
}

func TestStoreRebuildsAreBoundedNewestFirst(t *testing.T) {
	s := NewStore(WithRebuildThreshold(1))
	for i := int64(1); i <= maxRebuildEvents+5; i++ {
		s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", At: unix(i), CacheWrite: i})
	}
	got := account(t, s, "a").Rebuilds
	if len(got) != maxRebuildEvents || got[0].CacheWrite != maxRebuildEvents+5 {
		t.Fatalf("rebuilds len=%d first=%+v", len(got), got[0])
	}
}

func TestStoreDetectsAffinityBreaks(t *testing.T) {
	s := NewStore()
	s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", SessionID: "s1", At: unix(10)})
	s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", SessionID: "s1", At: unix(20)})
	if len(s.AffinityBreaks()) != 0 {
		t.Fatalf("staying on one account is not a break: %+v", s.AffinityBreaks())
	}
	s.AddUsage(UsageSample{AuthID: "b", Provider: "claude", SessionID: "s1", At: unix(95)})
	s.AddUsage(UsageSample{AuthID: "c", Provider: "claude", At: unix(96)}) // no session id: untracked

	breaks := s.AffinityBreaks()
	if len(breaks) != 1 || breaks[0].SessionID != "s1" || breaks[0].From != "a" || breaks[0].To != "b" ||
		!breaks[0].At.Equal(unix(95)) || !approx(breaks[0].GapSeconds, 75) {
		t.Fatalf("breaks = %+v", breaks)
	}
}

func TestStoreSessionTrackingIsBounded(t *testing.T) {
	s := NewStore()
	for i := int64(1); i <= maxTrackedSessions*2; i++ {
		s.AddUsage(UsageSample{AuthID: "a", Provider: "claude", SessionID: "s" + time.Unix(i, 0).UTC().Format(time.RFC3339), At: unix(i)})
	}
	if got := len(s.sessions); got > maxTrackedSessions {
		t.Fatalf("tracked %d sessions, want at most %d", got, maxTrackedSessions)
	}
	// The newest sessions must survive pruning so a fresh break is still caught.
	s.AddUsage(UsageSample{AuthID: "b", Provider: "claude", SessionID: "s" + time.Unix(maxTrackedSessions*2, 0).UTC().Format(time.RFC3339), At: unix(maxTrackedSessions*2 + 1)})
	if len(s.AffinityBreaks()) != 1 {
		t.Fatalf("recent session was pruned: %+v", s.AffinityBreaks())
	}
}

func TestStoreSnapshotIsSortedAndDetached(t *testing.T) {
	s := NewStore()
	s.Observe("z", "claude", Observation{Windows: []Window{win(WindowWeekly, 1, 500), win(WindowFiveHour, 2, 400)}}, unix(1), SourceHeaders)
	s.Observe("b", "codex", Observation{Windows: []Window{win(WindowFiveHour, 3, 400)}}, unix(1), SourceHeaders)
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowFiveHour, 4, 400)}}, unix(1), SourceHeaders)

	snap := s.Snapshot()
	order := []string{snap[0].AuthID, snap[1].AuthID, snap[2].AuthID}
	if order[0] != "a" || order[1] != "z" || order[2] != "b" {
		t.Fatalf("order = %v, want provider then id", order)
	}
	if snap[1].Windows[0].ID != WindowFiveHour || snap[1].Windows[1].ID != WindowWeekly {
		t.Fatalf("windows not in display order: %+v", snap[1].Windows)
	}

	s.Observe("z", "claude", Observation{Banked: &BankedReset{Available: 3}}, unix(2), SourcePoll)
	s.AddUsage(UsageSample{AuthID: "z", Provider: "claude", At: unix(3), CacheWrite: 200_000})
	snap = s.Snapshot()
	snap[1].Windows[0].UsedPercent = 99
	snap[1].Banked.Available = 99
	snap[1].Rebuilds[0].CacheWrite = 1

	got := account(t, s, "z")
	if approx(find(t, got.Windows, WindowFiveHour).UsedPercent, 99) || got.Banked.Available != 3 || got.Rebuilds[0].CacheWrite != 200_000 {
		t.Fatalf("mutating a snapshot changed the store: %+v", got)
	}
}

func TestStoreForgetDropsAccount(t *testing.T) {
	s := NewStore()
	s.Observe("a", "claude", Observation{Windows: []Window{win(WindowWeekly, 1, 500)}}, unix(1), SourceHeaders)
	s.Forget("a")
	if len(s.Snapshot()) != 0 {
		t.Fatalf("account survived Forget")
	}
}
