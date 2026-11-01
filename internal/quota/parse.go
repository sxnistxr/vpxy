package quota

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	secondsFiveHour = 5 * 3600
	secondsWeek     = 7 * 24 * 3600
	secondsMonthMin = 28 * 24 * 3600
	secondsMonthMax = 31 * 24 * 3600
	// Unix timestamps above this are milliseconds, not seconds.
	maxUnixSeconds = 100_000_000_000
)

// ParseHeaders reads the rate-limit windows an upstream response advertised in its headers.
// Unknown providers and responses without quota headers yield an empty Observation.
func ParseHeaders(provider string, h http.Header, now time.Time) Observation {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "claude":
		return Observation{Windows: claudeHeaderWindows(h)}
	case "codex":
		return codexHeaderObservation(h, now)
	}
	return Observation{}
}

func claudeHeaderWindows(h http.Header) []Window {
	specs := []struct{ suffix, id string }{
		{"5h", WindowFiveHour},
		{"7d", WindowWeekly},
		{"7d_oi", WindowWeeklyFable},
	}
	var windows []Window
	for _, spec := range specs {
		prefix := "Anthropic-Ratelimit-Unified-" + spec.suffix + "-"
		status := strings.ToLower(strings.TrimSpace(h.Get(prefix + "Status")))
		used, ok := parseNumber(h.Get(prefix + "Utilization"))
		switch {
		case ok:
			// Anthropic reports utilization as a 0-1 fraction.
			used *= 100
		case status == statusRejected:
			used = 100
		default:
			continue
		}
		windows = append(windows, Window{
			ID:          spec.id,
			Label:       windowLabel(spec.id),
			UsedPercent: clampPercent(used),
			ResetsAt:    parseUnixOrTime(h.Get(prefix + "Reset")),
			Status:      status,
		})
	}
	return windows
}

func codexHeaderObservation(h http.Header, now time.Time) Observation {
	obs := Observation{Plan: strings.ToLower(strings.TrimSpace(h.Get("X-Codex-Plan-Type")))}
	seen := make(map[string]bool, 2)
	for slot, name := range []string{"Primary", "Secondary"} {
		prefix := "X-Codex-" + name + "-"
		used, ok := parseNumber(h.Get(prefix + "Used-Percent"))
		if !ok {
			continue
		}
		minutes, _ := parseNumber(h.Get(prefix + "Window-Minutes"))
		id := codexWindowID(minutes*60, slot)
		if seen[id] {
			continue
		}
		seen[id] = true
		reset := parseUnixOrTime(h.Get(prefix + "Reset-At"))
		if after, okAfter := parseNumber(h.Get(prefix + "Reset-After-Seconds")); reset.IsZero() && okAfter && after >= 0 {
			reset = now.Add(time.Duration(after * float64(time.Second)))
		}
		obs.Windows = append(obs.Windows, Window{ID: id, Label: windowLabel(id), UsedPercent: clampPercent(used), ResetsAt: reset})
	}
	return obs
}

// codexWindowID classifies a Codex window by its length. Payloads without a usable length fall
// back to slot order: the primary slot is the short window, the secondary the long one.
func codexWindowID(seconds float64, slot int) string {
	switch {
	case seconds == secondsFiveHour:
		return WindowFiveHour
	case seconds == secondsWeek:
		return WindowWeekly
	case seconds >= secondsMonthMin && seconds <= secondsMonthMax:
		return WindowMonthly
	case slot == 0:
		return WindowFiveHour
	default:
		return WindowWeekly
	}
}

type claudeWindowJSON struct {
	Utilization      *float64 `json:"utilization"`
	ResetsAt         flexTime `json:"resets_at"`
	LimitDollars     *float64 `json:"limit_dollars"`
	UsedDollars      *float64 `json:"used_dollars"`
	RemainingDollars *float64 `json:"remaining_dollars"`
}

func (w *claudeWindowJSON) isDollarPool() bool {
	return w.LimitDollars != nil || w.UsedDollars != nil || w.RemainingDollars != nil
}

type claudeLimitJSON struct {
	Kind     string   `json:"kind"`
	IsActive bool     `json:"is_active"`
	Percent  *float64 `json:"percent"`
	ResetsAt flexTime `json:"resets_at"`
	Scope    struct {
		Model struct {
			DisplayName string `json:"display_name"`
		} `json:"model"`
	} `json:"scope"`
}

// ParseClaudeUsage decodes the body of GET /api/oauth/usage. Utilization there is already a percentage.
func ParseClaudeUsage(body []byte, _ time.Time) (Observation, error) {
	var payload struct {
		FiveHour       *claudeWindowJSON `json:"five_hour"`
		SevenDay       *claudeWindowJSON `json:"seven_day"`
		SevenDayOAuth  *claudeWindowJSON `json:"seven_day_oauth_apps"`
		SevenDayOpus   *claudeWindowJSON `json:"seven_day_opus"`
		SevenDaySonnet *claudeWindowJSON `json:"seven_day_sonnet"`
		SevenDayCowork *claudeWindowJSON `json:"seven_day_cowork"`
		Iguana         *claudeWindowJSON `json:"iguana_necktie"`
		Limits         []claudeLimitJSON `json:"limits"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return Observation{}, fmt.Errorf("decoding claude usage: %w", err)
	}

	var windows []Window
	add := func(id, label string, w *claudeWindowJSON) {
		if w == nil || w.Utilization == nil {
			return
		}
		windows = append(windows, Window{ID: id, Label: label, UsedPercent: clampPercent(*w.Utilization), ResetsAt: w.ResetsAt.Time})
	}
	add(WindowFiveHour, windowLabel(WindowFiveHour), payload.FiveHour)
	add(WindowWeekly, windowLabel(WindowWeekly), payload.SevenDay)
	add("7d:oauth-apps", "Weekly · OAuth apps", payload.SevenDayOAuth)
	add("7d:opus", "Weekly · Opus", payload.SevenDayOpus)
	add("7d:sonnet", "Weekly · Sonnet", payload.SevenDaySonnet)
	add("7d:cowork", "Weekly · Cowork", payload.SevenDayCowork)

	scoped := claudeScopedWindows(payload.Limits)
	windows = append(windows, scoped...)
	// The legacy iguana_necktie key carries the Fable weekly window unless limits[] already
	// does, or unless it is a dollar balance rather than a rate limit.
	if payload.Iguana != nil && !payload.Iguana.isDollarPool() && !hasWindow(scoped, WindowWeeklyFable) {
		add(WindowWeeklyFable, "Weekly · Fable", payload.Iguana)
	}

	if len(windows) == 0 {
		return Observation{}, errors.New("claude usage payload has no rate-limit windows")
	}
	return Observation{Windows: windows}, nil
}

// claudeScopedWindows turns limits[] entries of kind weekly_scoped into model-scoped weekly
// windows. When two entries map to the same window, the active one wins.
func claudeScopedWindows(limits []claudeLimitJSON) []Window {
	var windows []Window
	index := make(map[string]int)
	for _, limit := range limits {
		name := strings.TrimSpace(limit.Scope.Model.DisplayName)
		if !strings.EqualFold(limit.Kind, "weekly_scoped") || limit.Percent == nil || name == "" {
			continue
		}
		id, label := "7d:"+slug(name), "Weekly · "+name
		if strings.HasPrefix(slug(name), "fable") {
			id, label = WindowWeeklyFable, "Weekly · Fable"
		}
		window := Window{ID: id, Label: label, UsedPercent: clampPercent(*limit.Percent), ResetsAt: limit.ResetsAt.Time}
		if at, seen := index[id]; seen {
			if limit.IsActive {
				windows[at] = window
			}
			continue
		}
		index[id] = len(windows)
		windows = append(windows, window)
	}
	return windows
}

// ParseClaudeBanked decodes the cedar_ember block of GET /api/oauth/usage?cedar_ember=1.
// It returns nil, nil when the account has no such block.
func ParseClaudeBanked(body []byte) (*BankedReset, error) {
	var payload struct {
		CedarEmber *struct {
			Grants []struct {
				ResetsTotal int      `json:"resets_total"`
				ResetsLeft  int      `json:"resets_left"`
				EndsAt      flexTime `json:"ends_at"`
				UsableNow   bool     `json:"usable_now"`
			} `json:"grants"`
		} `json:"cedar_ember"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decoding claude reset grants: %w", err)
	}
	if payload.CedarEmber == nil {
		return nil, nil
	}
	banked := &BankedReset{}
	for _, grant := range payload.CedarEmber.Grants {
		banked.Total += grant.ResetsTotal
		if grant.ResetsLeft <= 0 {
			continue
		}
		banked.Available += grant.ResetsLeft
		banked.UsableNow = banked.UsableNow || grant.UsableNow
		if !grant.EndsAt.IsZero() && (banked.EndsAt.IsZero() || grant.EndsAt.Before(banked.EndsAt)) {
			banked.EndsAt = grant.EndsAt.Time
		}
	}
	return banked, nil
}

type codexWindowJSON struct {
	UsedPercent        *float64 `json:"used_percent"`
	LimitWindowSeconds float64  `json:"limit_window_seconds"`
	ResetAfterSeconds  *float64 `json:"reset_after_seconds"`
	ResetAt            flexTime `json:"reset_at"`
}

type codexRateLimitJSON struct {
	Allowed      *bool            `json:"allowed"`
	LimitReached bool             `json:"limit_reached"`
	Primary      *codexWindowJSON `json:"primary_window"`
	Secondary    *codexWindowJSON `json:"secondary_window"`
}

// ParseCodexUsage decodes the body of GET /backend-api/wham/usage.
func ParseCodexUsage(body []byte, now time.Time) (Observation, error) {
	var payload struct {
		PlanType   string              `json:"plan_type"`
		RateLimit  *codexRateLimitJSON `json:"rate_limit"`
		Additional []struct {
			LimitName      string              `json:"limit_name"`
			MeteredFeature string              `json:"metered_feature"`
			RateLimit      *codexRateLimitJSON `json:"rate_limit"`
		} `json:"additional_rate_limits"`
		ResetCredits *struct {
			AvailableCount *int `json:"available_count"`
		} `json:"rate_limit_reset_credits"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return Observation{}, fmt.Errorf("decoding codex usage: %w", err)
	}

	obs := Observation{
		Plan:    strings.ToLower(strings.TrimSpace(payload.PlanType)),
		Windows: codexWindows(payload.RateLimit, "", now),
	}
	for i, extra := range payload.Additional {
		name := strings.TrimSpace(extra.LimitName)
		if name == "" {
			name = strings.TrimSpace(extra.MeteredFeature)
		}
		if name == "" {
			name = fmt.Sprintf("additional-%d", i+1)
		}
		obs.Windows = append(obs.Windows, codexWindows(extra.RateLimit, name, now)...)
	}
	if len(obs.Windows) == 0 {
		return Observation{}, errors.New("codex usage payload has no rate-limit windows")
	}
	if credits := payload.ResetCredits; credits != nil && credits.AvailableCount != nil {
		obs.Banked = &BankedReset{Available: *credits.AvailableCount, UsableNow: *credits.AvailableCount > 0}
	}
	return obs, nil
}

// codexWindows reads one rate_limit block. scope is empty for the account's own limit and the
// limit's name for an additional one.
func codexWindows(rl *codexRateLimitJSON, scope string, now time.Time) []Window {
	if rl == nil {
		return nil
	}
	blocked := rl.LimitReached || (rl.Allowed != nil && !*rl.Allowed)
	var windows []Window
	seen := make(map[string]bool, 2)
	for slot, w := range []*codexWindowJSON{rl.Primary, rl.Secondary} {
		if w == nil {
			continue
		}
		reset := w.ResetAt.Time
		if reset.IsZero() && w.ResetAfterSeconds != nil && *w.ResetAfterSeconds >= 0 {
			reset = now.Add(time.Duration(*w.ResetAfterSeconds * float64(time.Second)))
		}
		var used float64
		switch {
		case w.UsedPercent != nil:
			used = clampPercent(*w.UsedPercent)
		case blocked && !reset.IsZero():
			used = 100
		default:
			continue
		}
		id := codexWindowID(w.LimitWindowSeconds, slot)
		if seen[id] {
			continue
		}
		seen[id] = true
		window := Window{ID: id, Label: windowLabel(id), UsedPercent: used, ResetsAt: reset}
		if scope != "" {
			window.ID, window.Label = slug(scope)+":"+id, scope+" · "+window.Label
		}
		windows = append(windows, window)
	}
	return windows
}

// flexTime decodes a JSON timestamp given as RFC 3339 text or as Unix seconds or milliseconds.
// Anything else decodes as unknown instead of failing the whole payload.
type flexTime struct{ time.Time }

func (t *flexTime) UnmarshalJSON(b []byte) error {
	raw := strings.TrimSpace(string(b))
	if raw != "null" {
		t.Time = parseUnixOrTime(strings.Trim(raw, `"`))
	}
	return nil
}

func parseUnixOrTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if n, ok := parseNumber(raw); ok {
		switch {
		case n <= 0:
			return time.Time{}
		case n > maxUnixSeconds:
			return time.UnixMilli(int64(n)).UTC()
		default:
			return time.Unix(int64(n), 0).UTC()
		}
	}
	if ts, err := time.Parse(time.RFC3339, raw); err == nil {
		return ts.UTC()
	}
	return time.Time{}
}

// parseNumber parses a finite number, reporting false for empty, malformed, NaN or infinite input.
func parseNumber(raw string) (float64, bool) {
	n, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return n, true
}

func clampPercent(v float64) float64 { return math.Min(math.Max(v, 0), 100) }

func windowLabel(id string) string {
	switch id {
	case WindowFiveHour:
		return "5 hours"
	case WindowWeekly:
		return "Weekly"
	case WindowMonthly:
		return "Monthly"
	case WindowWeeklyFable:
		return "Weekly · Fable"
	}
	return id
}

func hasWindow(windows []Window, id string) bool {
	for _, w := range windows {
		if w.ID == id {
			return true
		}
	}
	return false
}

// slug lowercases s and collapses every run of non-alphanumeric characters into one dash.
func slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
			continue
		}
		dash = true
	}
	return b.String()
}
