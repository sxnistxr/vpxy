package auth

import (
	"context"
	"testing"
	"time"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// fakeResets returns the configured times verbatim, so the selector's own validation of them is tested.
type fakeResets struct {
	weekly  map[string]time.Time
	blocked map[string]time.Time
}

func (f fakeResets) WeeklyReset(authID string, _ time.Time) (time.Time, bool) {
	t, ok := f.weekly[authID]
	return t, ok
}

func (f fakeResets) BlockedUntil(authID string, _ time.Time) (time.Time, bool) {
	t, ok := f.blocked[authID]
	return t, ok
}

var expirationNow = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

func newExpirationSelector(resets ResetSource) *ExpirationFirstSelector {
	selector := NewExpirationFirstSelector(resets)
	selector.now = func() time.Time { return expirationNow }
	return selector
}

func pickExpirationFirst(t *testing.T, selector Selector, ids ...string) string {
	t.Helper()
	auths := make([]*Auth, 0, len(ids))
	for _, id := range ids {
		auths = append(auths, &Auth{ID: id})
	}
	got, err := selector.Pick(context.Background(), "claude", "", cliproxyexecutor.Options{}, auths)
	if err != nil {
		t.Fatalf("Pick() error = %v", err)
	}
	return got.ID
}

func inDays(days float64) time.Time {
	return expirationNow.Add(time.Duration(days * 24 * float64(time.Hour)))
}

func TestExpirationFirstPrefersSoonestWeeklyReset(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{weekly: map[string]time.Time{"a": inDays(5), "b": inDays(2), "c": inDays(9)}})
	if got := pickExpirationFirst(t, selector, "a", "b", "c"); got != "b" {
		t.Fatalf("Pick() = %q, want b (weekly window resets first)", got)
	}
}

func TestExpirationFirstKnownResetBeatsUnknown(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{weekly: map[string]time.Time{"z": inDays(6)}})
	if got := pickExpirationFirst(t, selector, "a", "z"); got != "z" {
		t.Fatalf("Pick() = %q, want z: an account with a pending reset is spent before an unstarted one", got)
	}
}

func TestExpirationFirstUnknownResetsFallBackToID(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{})
	if got := pickExpirationFirst(t, selector, "c", "a", "b"); got != "a" {
		t.Fatalf("Pick() = %q, want a", got)
	}
}

func TestExpirationFirstTreatsAPastResetAsUnknown(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{weekly: map[string]time.Time{"a": inDays(-1), "b": inDays(3)}})
	if got := pickExpirationFirst(t, selector, "a", "b"); got != "b" {
		t.Fatalf("Pick() = %q, want b: a reset that already passed carries no information", got)
	}
}

func TestExpirationFirstTieBreaksByID(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{weekly: map[string]time.Time{"b": inDays(2), "a": inDays(2)}})
	if got := pickExpirationFirst(t, selector, "b", "a"); got != "a" {
		t.Fatalf("Pick() = %q, want a", got)
	}
}

func TestExpirationFirstDeprioritizesBlockedAccounts(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{
		weekly:  map[string]time.Time{"a": inDays(1), "b": inDays(8)},
		blocked: map[string]time.Time{"a": expirationNow.Add(3 * time.Hour)},
	})
	if got := pickExpirationFirst(t, selector, "a", "b"); got != "b" {
		t.Fatalf("Pick() = %q, want b: a is rate limited even though its week resets first", got)
	}
}

func TestExpirationFirstWhenEveryoneIsBlockedPicksTheSoonestToRecover(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{
		blocked: map[string]time.Time{"a": expirationNow.Add(3 * time.Hour), "b": expirationNow.Add(time.Hour)},
	})
	if got := pickExpirationFirst(t, selector, "a", "b"); got != "b" {
		t.Fatalf("Pick() = %q, want b", got)
	}
}

func TestExpirationFirstIgnoresABlockThatAlreadyEnded(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{
		weekly:  map[string]time.Time{"a": inDays(1), "b": inDays(8)},
		blocked: map[string]time.Time{"a": expirationNow.Add(-time.Minute)},
	})
	if got := pickExpirationFirst(t, selector, "a", "b"); got != "a" {
		t.Fatalf("Pick() = %q, want a: its block is over", got)
	}
}

func TestExpirationFirstWithoutResetSourceBehavesLikeFillFirst(t *testing.T) {
	t.Parallel()
	if got := pickExpirationFirst(t, newExpirationSelector(nil), "c", "a", "b"); got != "a" {
		t.Fatalf("Pick() = %q, want a", got)
	}
}

func TestExpirationFirstStillHonoursCredentialCooldowns(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{weekly: map[string]time.Time{"a": inDays(1), "b": inDays(8)}})
	auths := []*Auth{
		{ID: "a", Quota: QuotaState{Exceeded: true, Reason: "credential_quota", NextRecoverAt: expirationNow.Add(time.Hour)}},
		{ID: "b"},
	}
	got, err := selector.Pick(context.Background(), "claude", "", cliproxyexecutor.Options{}, auths)
	if err != nil {
		t.Fatalf("Pick() error = %v", err)
	}
	if got.ID != "b" {
		t.Fatalf("Pick() = %q, want b: a is cooling down after a 429", got.ID)
	}
}

func TestExpirationFirstKeepsCodexWebsocketRequestsOnWebsocketAccounts(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(fakeResets{weekly: map[string]time.Time{"a": inDays(1), "b": inDays(8)}})
	auths := []*Auth{
		{ID: "a"},
		{ID: "b", Attributes: map[string]string{"websockets": "true"}},
	}
	ctx := cliproxyexecutor.WithDownstreamWebsocket(context.Background())

	got, err := selector.Pick(ctx, "codex", "", cliproxyexecutor.Options{}, auths)
	if err != nil {
		t.Fatalf("Pick() error = %v", err)
	}
	if got.ID != "b" {
		t.Fatalf("Pick() = %q, want b: a websocket client needs a websocket-capable account first", got.ID)
	}
}

func TestExpirationFirstRejectsEmptyCandidates(t *testing.T) {
	t.Parallel()
	if _, err := newExpirationSelector(nil).Pick(context.Background(), "claude", "", cliproxyexecutor.Options{}, nil); err == nil {
		t.Fatal("Pick() without candidates returned no error")
	}
}

func TestExpirationFirstIsAFallbackForSessionAffinity(t *testing.T) {
	t.Parallel()
	fallback := newExpirationSelector(fakeResets{weekly: map[string]time.Time{"a": inDays(6), "b": inDays(2)}})
	affinity := NewSessionAffinitySelectorWithConfig(SessionAffinityConfig{Fallback: fallback, TTL: time.Minute})
	t.Cleanup(affinity.Stop)
	if got := pickExpirationFirst(t, affinity, "a", "b"); got != "b" {
		t.Fatalf("Pick() = %q, want b from the expiration-first fallback", got)
	}
}

func TestExpirationFirstUsesThePrevalidatedCandidateContextAndStaysOffTheSchedulerFastPath(t *testing.T) {
	t.Parallel()
	selector := newExpirationSelector(nil)
	ctx := selectorContextForAvailableAuths(context.Background(), selector, "claude-opus")
	if validated, _ := ctx.Value(prevalidatedAuthCandidatesKey{}).(bool); !validated {
		t.Fatal("candidates were not marked as prevalidated; the manager's cooldown filtering would run twice")
	}
	if isBuiltInSelector(selector) {
		t.Fatal("the scheduler fast path would bypass this selector entirely")
	}
}
