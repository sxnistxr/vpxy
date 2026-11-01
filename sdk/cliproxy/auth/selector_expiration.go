package auth

import (
	"context"
	"time"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// ResetSource tells ExpirationFirstSelector when a credential's quota windows reset.
type ResetSource interface {
	// WeeklyReset returns when the credential's weekly window resets, if known.
	WeeklyReset(authID string, now time.Time) (time.Time, bool)
	// BlockedUntil returns when a credential with an exhausted account-wide window can serve again.
	BlockedUntil(authID string, now time.Time) (time.Time, bool)
}

// ExpirationFirstSelector spends the quota that expires soonest. Among credentials that are not
// rate limited it picks the one whose weekly window resets first, so capacity that would lapse
// is used before capacity that renews later. Credentials with no pending reset come next, by ID,
// and rate-limited ones last, soonest to recover first. A 429 puts a credential into cooldown,
// which removes it from the candidates, so a retry naturally moves to the next soonest.
type ExpirationFirstSelector struct {
	resets ResetSource
	now    func() time.Time
}

// NewExpirationFirstSelector returns a selector that orders credentials by resets. A nil source
// leaves every reset unknown, which degrades to picking the lowest ID like FillFirstSelector.
func NewExpirationFirstSelector(resets ResetSource) *ExpirationFirstSelector {
	return &ExpirationFirstSelector{resets: resets, now: time.Now}
}

const (
	expirationRankWeeklyKnown = iota
	expirationRankWeeklyUnknown
	expirationRankBlocked
)

type expirationRank struct {
	group int
	at    time.Time
	id    string
}

func (r expirationRank) before(other expirationRank) bool {
	if r.group != other.group {
		return r.group < other.group
	}
	if !r.at.Equal(other.at) {
		return r.at.Before(other.at)
	}
	return r.id < other.id
}

// Pick implements Selector.
func (s *ExpirationFirstSelector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*Auth) (*Auth, error) {
	_ = opts
	now := time.Now()
	if s != nil && s.now != nil {
		now = s.now()
	}
	available, err := getSelectorAvailableAuths(ctx, auths, provider, model, now)
	if err != nil {
		return nil, err
	}
	available = preferCodexWebsocketAuths(ctx, provider, available)

	var best *Auth
	var bestRank expirationRank
	for _, auth := range available {
		rank := s.rank(auth, now)
		if best == nil || rank.before(bestRank) {
			best, bestRank = auth, rank
		}
	}
	return best, nil
}

func (s *ExpirationFirstSelector) rank(auth *Auth, now time.Time) expirationRank {
	rank := expirationRank{group: expirationRankWeeklyUnknown, id: auth.ID}
	if s == nil || s.resets == nil {
		return rank
	}
	if until, ok := s.resets.BlockedUntil(auth.ID, now); ok && until.After(now) {
		rank.group, rank.at = expirationRankBlocked, until
		return rank
	}
	if reset, ok := s.resets.WeeklyReset(auth.ID, now); ok && reset.After(now) {
		rank.group, rank.at = expirationRankWeeklyKnown, reset
	}
	return rank
}
