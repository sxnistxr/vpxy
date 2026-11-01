package quota

import (
	"sort"
	"sync"
	"time"
)

const (
	defaultRebuildThreshold = 100_000
	maxRebuildEvents        = 20
	maxAffinityBreaks       = 50
	maxTrackedSessions      = 4096
)

// blockingWindows are the account-wide windows that decide whether an account can serve at all.
var blockingWindows = []string{WindowFiveHour, WindowWeekly, WindowMonthly}

// Option configures a Store.
type Option func(*Store)

// WithRebuildThreshold sets how many cache-write tokens in one request count as a cache rebuild.
func WithRebuildThreshold(tokens int64) Option {
	return func(s *Store) {
		if tokens > 0 {
			s.rebuildThreshold = tokens
		}
	}
}

type stampedWindow struct {
	Window
	observedAt time.Time
}

type accountState struct {
	provider   string
	plan       string
	windows    map[string]stampedWindow
	banked     *BankedReset
	source     Source
	observedAt time.Time
	polledAt   time.Time
	pollError  string
	cache      CacheCounters
	rebuilds   []RebuildEvent // newest first
}

type sessionSeen struct {
	authID string
	at     time.Time
}

// Store is the in-memory record of every account's quota state. It is safe for concurrent use.
type Store struct {
	mu               sync.RWMutex
	rebuildThreshold int64
	accounts         map[string]*accountState
	sessions         map[string]sessionSeen
	breaks           []AffinityBreak // newest first
}

// NewStore returns an empty Store.
func NewStore(opts ...Option) *Store {
	s := &Store{
		rebuildThreshold: defaultRebuildThreshold,
		accounts:         make(map[string]*accountState),
		sessions:         make(map[string]sessionSeen),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// account returns the state for authID, creating it. The caller holds the write lock.
func (s *Store) account(authID, provider string) *accountState {
	acc := s.accounts[authID]
	if acc == nil {
		acc = &accountState{windows: make(map[string]stampedWindow)}
		s.accounts[authID] = acc
	}
	if provider != "" {
		acc.provider = provider
	}
	return acc
}

// Observe merges what a source learned at time at. Each window keeps its newest observation;
// an observation without a plan or banked resets leaves the known ones in place.
func (s *Store) Observe(authID, provider string, obs Observation, at time.Time, src Source) {
	if authID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	acc := s.account(authID, provider)
	for _, w := range obs.Windows {
		if w.ID == "" {
			continue
		}
		if cur, ok := acc.windows[w.ID]; ok && at.Before(cur.observedAt) {
			continue
		}
		acc.windows[w.ID] = stampedWindow{Window: w, observedAt: at}
	}
	if obs.Plan != "" {
		acc.plan = obs.Plan
	}
	if obs.Banked != nil {
		banked := *obs.Banked
		acc.banked = &banked
	}
	if !at.Before(acc.observedAt) {
		acc.observedAt, acc.source = at, src
	}
}

// NotePoll records the outcome of a usage-endpoint poll; a nil err clears the previous error.
func (s *Store) NotePoll(authID, provider string, at time.Time, err error) {
	if authID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	acc := s.account(authID, provider)
	acc.polledAt, acc.pollError = at, ""
	if err != nil {
		acc.pollError = err.Error()
	}
}

// AddUsage counts one finished request. Failed requests carry no tokens and are ignored.
func (s *Store) AddUsage(u UsageSample) {
	if u.AuthID == "" || u.Failed {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	acc := s.account(u.AuthID, u.Provider)
	acc.cache.Requests++
	acc.cache.Input += u.Input
	acc.cache.Output += u.Output
	acc.cache.CacheRead += u.CacheRead
	acc.cache.CacheWrite += u.CacheWrite
	if u.CacheWrite >= s.rebuildThreshold {
		event := RebuildEvent{At: u.At, Model: u.Model, SessionID: u.SessionID, CacheWrite: u.CacheWrite, CacheRead: u.CacheRead}
		acc.rebuilds = append([]RebuildEvent{event}, acc.rebuilds...)
		if len(acc.rebuilds) > maxRebuildEvents {
			acc.rebuilds = acc.rebuilds[:maxRebuildEvents]
		}
	}
	s.trackSession(u)
}

// trackSession notes which account served a session and records a break when it changes.
// The caller holds the write lock.
func (s *Store) trackSession(u UsageSample) {
	if u.SessionID == "" {
		return
	}
	if prev, ok := s.sessions[u.SessionID]; ok && prev.authID != u.AuthID {
		gap := u.At.Sub(prev.at).Seconds()
		event := AffinityBreak{SessionID: u.SessionID, From: prev.authID, To: u.AuthID, At: u.At, GapSeconds: max(gap, 0)}
		s.breaks = append([]AffinityBreak{event}, s.breaks...)
		if len(s.breaks) > maxAffinityBreaks {
			s.breaks = s.breaks[:maxAffinityBreaks]
		}
	}
	s.sessions[u.SessionID] = sessionSeen{authID: u.AuthID, at: u.At}
	if len(s.sessions) > maxTrackedSessions {
		s.pruneSessions()
	}
}

// pruneSessions drops the oldest quarter of the tracked sessions, so the map stays bounded
// without a scan on every request. The caller holds the write lock.
func (s *Store) pruneSessions() {
	type entry struct {
		id string
		at time.Time
	}
	entries := make([]entry, 0, len(s.sessions))
	for id, seen := range s.sessions {
		entries = append(entries, entry{id, seen.at})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].at.Before(entries[j].at) })
	for _, e := range entries[:len(entries)/4] {
		delete(s.sessions, e.id)
	}
}

// Forget drops everything known about an account.
func (s *Store) Forget(authID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.accounts, authID)
}

// AffinityBreaks returns the most recent session moves, newest first.
func (s *Store) AffinityBreaks() []AffinityBreak {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]AffinityBreak(nil), s.breaks...)
}

// WeeklyReset reports when the account's weekly window resets, if that is known and still ahead.
func (s *Store) WeeklyReset(authID string, now time.Time) (time.Time, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	acc := s.accounts[authID]
	if acc == nil {
		return time.Time{}, false
	}
	w, ok := acc.windows[WindowWeekly]
	if !ok || !w.ResetsAt.After(now) {
		return time.Time{}, false
	}
	return w.ResetsAt, true
}

// BlockedUntil reports when an account whose account-wide windows are exhausted can serve again.
// Every exhausted window has to reset, so the latest reset wins.
func (s *Store) BlockedUntil(authID string, now time.Time) (time.Time, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	acc := s.accounts[authID]
	if acc == nil {
		return time.Time{}, false
	}
	return blockedUntil(func(id string) (Window, bool) {
		w, ok := acc.windows[id]
		return w.Window, ok
	}, now)
}

// blockedUntil returns the latest reset among the exhausted account-wide windows, which is when
// the account can serve again. windowFor looks a window up by ID.
func blockedUntil(windowFor func(id string) (Window, bool), now time.Time) (time.Time, bool) {
	var until time.Time
	for _, id := range blockingWindows {
		if w, ok := windowFor(id); ok && w.Exhausted(now) && w.ResetsAt.After(until) {
			until = w.ResetsAt
		}
	}
	return until, !until.IsZero()
}

// Snapshot returns a detached copy of every account, ordered by provider then ID.
func (s *Store) Snapshot() []Account {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Account, 0, len(s.accounts))
	for id, acc := range s.accounts {
		out = append(out, acc.view(id))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].AuthID < out[j].AuthID
	})
	return out
}

func (a *accountState) view(id string) Account {
	windows := make([]Window, 0, len(a.windows))
	for _, w := range a.windows {
		windows = append(windows, w.Window)
	}
	sort.Slice(windows, func(i, j int) bool {
		if ri, rj := windowRank(windows[i].ID), windowRank(windows[j].ID); ri != rj {
			return ri < rj
		}
		return windows[i].ID < windows[j].ID
	})
	view := Account{
		AuthID:     id,
		Provider:   a.provider,
		Plan:       a.plan,
		Windows:    windows,
		Source:     a.source,
		ObservedAt: a.observedAt,
		PolledAt:   a.polledAt,
		PollError:  a.pollError,
		Cache:      a.cache,
		Rebuilds:   append([]RebuildEvent(nil), a.rebuilds...),
	}
	if a.banked != nil {
		banked := *a.banked
		view.Banked = &banked
	}
	return view
}

// windowRank orders the account-wide windows first, in shortest-to-longest order.
func windowRank(id string) int {
	for rank, blocking := range blockingWindows {
		if id == blocking {
			return rank
		}
	}
	return len(blockingWindows)
}
