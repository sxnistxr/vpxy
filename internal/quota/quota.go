// Package quota tracks per-account rate-limit windows, banked resets and prompt-cache
// counters. It feeds the VPXY dashboard and the expiration-first selector.
package quota

import "time"

// Window IDs. The first three are account-wide: once exhausted they block every request.
// Model-scoped windows use "7d:<scope>" and only limit that model.
const (
	WindowFiveHour    = "5h"
	WindowWeekly      = "7d"
	WindowMonthly     = "30d"
	WindowWeeklyFable = "7d:fable"
)

// Source names where an observation came from.
type Source string

const (
	// SourceHeaders marks rate-limit headers read off a proxied upstream response.
	SourceHeaders Source = "headers"
	// SourcePoll marks a response from the provider's OAuth usage endpoint.
	SourcePoll Source = "poll"
)

const statusRejected = "rejected"

// Window is one rate-limit window of an account.
type Window struct {
	ID          string    `json:"id"`
	Label       string    `json:"label"`
	UsedPercent float64   `json:"used_percent"`
	ResetsAt    time.Time `json:"resets_at,omitzero"`
	Status      string    `json:"status,omitempty"`
}

// Exhausted reports whether the window still blocks requests at now. A window whose reset
// time is unknown or already passed cannot be trusted to block.
func (w Window) Exhausted(now time.Time) bool {
	return w.ResetsAt.After(now) && (w.UsedPercent >= 100 || w.Status == statusRejected)
}

// BankedReset describes reset grants an account has banked. VPXY only tracks them.
type BankedReset struct {
	Available int       `json:"available"`
	Total     int       `json:"total,omitempty"`
	EndsAt    time.Time `json:"ends_at,omitzero"`
	UsableNow bool      `json:"usable_now"`
}

// Observation is what one source learned about an account at one moment.
type Observation struct {
	Plan    string
	Windows []Window
	Banked  *BankedReset
}

// CacheCounters sums prompt-cache token traffic for an account.
type CacheCounters struct {
	Requests   int64 `json:"requests"`
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

// RebuildEvent marks one request that wrote at least the configured number of cache tokens.
type RebuildEvent struct {
	At         time.Time `json:"at"`
	Model      string    `json:"model,omitempty"`
	SessionID  string    `json:"session_id,omitempty"`
	CacheWrite int64     `json:"cache_write"`
	CacheRead  int64     `json:"cache_read"`
}

// AffinityBreak records a session that moved to another account, which discards its prompt cache.
type AffinityBreak struct {
	SessionID  string    `json:"session_id"`
	From       string    `json:"from"`
	To         string    `json:"to"`
	At         time.Time `json:"at"`
	GapSeconds float64   `json:"gap_seconds"`
}

// UsageSample is one finished request as the store counts it. Input excludes cached tokens.
type UsageSample struct {
	AuthID     string
	Provider   string
	Model      string
	SessionID  string
	At         time.Time
	Failed     bool
	Input      int64
	Output     int64
	CacheRead  int64
	CacheWrite int64
}

// Account is the dashboard view of one credential.
type Account struct {
	AuthID     string         `json:"auth_id"`
	Provider   string         `json:"provider"`
	Plan       string         `json:"plan,omitempty"`
	Windows    []Window       `json:"windows"`
	Banked     *BankedReset   `json:"banked,omitempty"`
	Source     Source         `json:"source,omitempty"`
	ObservedAt time.Time      `json:"observed_at,omitzero"`
	PolledAt   time.Time      `json:"polled_at,omitzero"`
	PollError  string         `json:"poll_error,omitempty"`
	Cache      CacheCounters  `json:"cache"`
	Rebuilds   []RebuildEvent `json:"rebuilds,omitempty"`
}

// BlockedUntil reports when the account can serve again if an account-wide window is exhausted.
func (a Account) BlockedUntil(now time.Time) (time.Time, bool) {
	return blockedUntil(func(id string) (Window, bool) {
		for _, w := range a.Windows {
			if w.ID == id {
				return w, true
			}
		}
		return Window{}, false
	}, now)
}
