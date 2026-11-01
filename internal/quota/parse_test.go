package quota

import (
	"math"
	"net/http"
	"testing"
	"time"
)

func unix(sec int64) time.Time { return time.Unix(sec, 0).UTC() }

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func find(t *testing.T, windows []Window, id string) Window {
	t.Helper()
	for _, w := range windows {
		if w.ID == id {
			return w
		}
	}
	t.Fatalf("window %q missing in %+v", id, windows)
	return Window{}
}

func has(windows []Window, id string) bool {
	for _, w := range windows {
		if w.ID == id {
			return true
		}
	}
	return false
}

func TestParseHeadersClaude(t *testing.T) {
	h := http.Header{}
	h.Set("Anthropic-Ratelimit-Unified-5h-Status", "allowed")
	h.Set("Anthropic-Ratelimit-Unified-5h-Reset", "1761916800")
	h.Set("Anthropic-Ratelimit-Unified-5h-Utilization", "0.42")
	h.Set("Anthropic-Ratelimit-Unified-7d-Status", "allowed_warning")
	h.Set("Anthropic-Ratelimit-Unified-7d-Reset", "1762300800")
	h.Set("Anthropic-Ratelimit-Unified-7d-Utilization", "0.81")
	h.Set("Anthropic-Ratelimit-Unified-7d_oi-Status", "rejected")
	h.Set("Anthropic-Ratelimit-Unified-7d_oi-Reset", "2026-11-05T01:00:00Z")

	obs := ParseHeaders("claude", h, unix(1761900000))

	five := find(t, obs.Windows, WindowFiveHour)
	if !approx(five.UsedPercent, 42) || !five.ResetsAt.Equal(unix(1761916800)) || five.Status != "allowed" {
		t.Fatalf("5h = %+v", five)
	}
	week := find(t, obs.Windows, WindowWeekly)
	if !approx(week.UsedPercent, 81) || !week.ResetsAt.Equal(unix(1762300800)) || week.Status != "allowed_warning" {
		t.Fatalf("7d = %+v", week)
	}
	// A rejected window that carries no utilization counts as fully used.
	fable := find(t, obs.Windows, WindowWeeklyFable)
	if !approx(fable.UsedPercent, 100) || !fable.ResetsAt.Equal(time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC)) {
		t.Fatalf("7d fable = %+v", fable)
	}
}

func TestParseHeadersClaudeEdges(t *testing.T) {
	if obs := ParseHeaders("claude", http.Header{}, unix(1)); len(obs.Windows) != 0 {
		t.Fatalf("empty headers produced windows: %+v", obs.Windows)
	}
	if obs := ParseHeaders("gemini", http.Header{"X-Codex-Primary-Used-Percent": {"5"}}, unix(1)); len(obs.Windows) != 0 {
		t.Fatalf("unknown provider produced windows: %+v", obs.Windows)
	}
	h := http.Header{}
	h.Set("Anthropic-Ratelimit-Unified-5h-Utilization", "1.7")
	h.Set("Anthropic-Ratelimit-Unified-7d-Status", "allowed") // status without utilization: nothing to report
	obs := ParseHeaders("claude", h, unix(1))
	if got := find(t, obs.Windows, WindowFiveHour); !approx(got.UsedPercent, 100) || !got.ResetsAt.IsZero() {
		t.Fatalf("clamped 5h = %+v", got)
	}
	if has(obs.Windows, WindowWeekly) {
		t.Fatalf("status-only window reported: %+v", obs.Windows)
	}
}

func TestParseHeadersCodex(t *testing.T) {
	h := http.Header{}
	h.Set("X-Codex-Plan-Type", "Pro")
	h.Set("X-Codex-Primary-Used-Percent", "12.5")
	h.Set("X-Codex-Primary-Window-Minutes", "300")
	h.Set("X-Codex-Primary-Reset-At", "1761916800")
	h.Set("X-Codex-Secondary-Used-Percent", "64")
	h.Set("X-Codex-Secondary-Window-Minutes", "10080")
	h.Set("X-Codex-Secondary-Reset-After-Seconds", "3600")

	obs := ParseHeaders("codex", h, unix(1761900000))

	if obs.Plan != "pro" {
		t.Fatalf("plan = %q", obs.Plan)
	}
	five := find(t, obs.Windows, WindowFiveHour)
	if !approx(five.UsedPercent, 12.5) || !five.ResetsAt.Equal(unix(1761916800)) {
		t.Fatalf("5h = %+v", five)
	}
	week := find(t, obs.Windows, WindowWeekly)
	if !approx(week.UsedPercent, 64) || !week.ResetsAt.Equal(unix(1761903600)) {
		t.Fatalf("7d = %+v", week)
	}
}

func TestParseHeadersCodexWeeklyOnlyPrimary(t *testing.T) {
	h := http.Header{}
	h.Set("X-Codex-Primary-Used-Percent", "30")
	h.Set("X-Codex-Primary-Window-Minutes", "10080")
	h.Set("X-Codex-Primary-Reset-At", "1762300800")

	obs := ParseHeaders("codex", h, unix(1761900000))

	if len(obs.Windows) != 1 {
		t.Fatalf("windows = %+v, want only the weekly one", obs.Windows)
	}
	if got := find(t, obs.Windows, WindowWeekly); !approx(got.UsedPercent, 30) {
		t.Fatalf("7d = %+v", got)
	}
}

func TestParseHeadersCodexFallsBackToSlotOrder(t *testing.T) {
	h := http.Header{}
	h.Set("X-Codex-Primary-Used-Percent", "10")
	h.Set("X-Codex-Secondary-Used-Percent", "20")

	obs := ParseHeaders("codex", h, unix(1))

	if got := find(t, obs.Windows, WindowFiveHour); !approx(got.UsedPercent, 10) {
		t.Fatalf("primary without a window length = %+v, want the 5h window", got)
	}
	if got := find(t, obs.Windows, WindowWeekly); !approx(got.UsedPercent, 20) {
		t.Fatalf("secondary without a window length = %+v, want the weekly window", got)
	}
}

func TestParseUnixOrTime(t *testing.T) {
	want := unix(1761916800)
	for _, raw := range []string{"1761916800", "1761916800000", "1761916800.0", " 2025-10-31T13:20:00Z "} {
		if got := parseUnixOrTime(raw); !got.Equal(want) {
			t.Fatalf("parseUnixOrTime(%q) = %v, want %v", raw, got, want)
		}
	}
	for _, raw := range []string{"", "0", "-5", "garbage"} {
		if got := parseUnixOrTime(raw); !got.IsZero() {
			t.Fatalf("parseUnixOrTime(%q) = %v, want unknown", raw, got)
		}
	}
}

const claudeUsageFixture = `{
  "five_hour": {"utilization": 37.0, "resets_at": "2026-10-31T23:00:00.123456+00:00"},
  "seven_day": {"utilization": 62.5, "resets_at": "2026-11-04T10:00:00+00:00"},
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": {"utilization": 5, "resets_at": "2026-11-04T10:00:00+00:00"},
  "iguana_necktie": {"utilization": 1, "resets_at": "2026-11-09T00:00:00Z"},
  "limits": [
    {"kind": "weekly_scoped", "is_active": true, "scope": {"model": {"display_name": "Fable 5"}}, "percent": 88.0, "resets_at": "2026-11-05T01:00:00Z"},
    {"kind": "session", "percent": 10}
  ]
}`

func TestParseClaudeUsage(t *testing.T) {
	obs, err := ParseClaudeUsage([]byte(claudeUsageFixture), unix(0))
	if err != nil {
		t.Fatal(err)
	}
	five := find(t, obs.Windows, WindowFiveHour)
	if !approx(five.UsedPercent, 37) || five.ResetsAt.UTC().Format(time.RFC3339) != "2026-10-31T23:00:00Z" {
		t.Fatalf("5h = %+v", five)
	}
	if week := find(t, obs.Windows, WindowWeekly); !approx(week.UsedPercent, 62.5) {
		t.Fatalf("7d = %+v", week)
	}
	if sonnet := find(t, obs.Windows, "7d:sonnet"); !approx(sonnet.UsedPercent, 5) {
		t.Fatalf("7d sonnet = %+v", sonnet)
	}
	fable := find(t, obs.Windows, WindowWeeklyFable)
	if !approx(fable.UsedPercent, 88) || fable.ResetsAt.UTC().Format(time.RFC3339) != "2026-11-05T01:00:00Z" {
		t.Fatalf("7d fable = %+v", fable)
	}
	if has(obs.Windows, "7d:opus") || len(obs.Windows) != 4 {
		t.Fatalf("unexpected windows: %+v", obs.Windows)
	}
}

func TestParseClaudeUsageLegacyFableKey(t *testing.T) {
	obs, err := ParseClaudeUsage([]byte(`{"five_hour":{"utilization":1,"resets_at":null},"iguana_necktie":{"utilization":40,"resets_at":"2026-11-05T01:00:00Z"}}`), unix(0))
	if err != nil {
		t.Fatal(err)
	}
	if got := find(t, obs.Windows, WindowWeeklyFable); !approx(got.UsedPercent, 40) {
		t.Fatalf("legacy fable = %+v", got)
	}
	if got := find(t, obs.Windows, WindowFiveHour); !got.ResetsAt.IsZero() {
		t.Fatalf("null reset should stay unknown, got %v", got.ResetsAt)
	}

	// A dollar-denominated pool is a credit balance, not a rate-limit window.
	obs, err = ParseClaudeUsage([]byte(`{"five_hour":{"utilization":1},"iguana_necktie":{"utilization":40,"limit_dollars":100,"used_dollars":40}}`), unix(0))
	if err != nil {
		t.Fatal(err)
	}
	if has(obs.Windows, WindowWeeklyFable) {
		t.Fatalf("dollar pool reported as a window: %+v", obs.Windows)
	}
}

func TestParseClaudeUsageActiveScopedLimitWins(t *testing.T) {
	body := `{"five_hour":{"utilization":1},"limits":[
	  {"kind":"weekly_scoped","is_active":false,"scope":{"model":{"display_name":"Fable 5"}},"percent":10},
	  {"kind":"weekly_scoped","is_active":true,"scope":{"model":{"display_name":"Fable"}},"percent":70},
	  {"kind":"weekly_scoped","is_active":false,"scope":{"model":{"display_name":"Fable 5"}},"percent":99}]}`
	obs, err := ParseClaudeUsage([]byte(body), unix(0))
	if err != nil {
		t.Fatal(err)
	}
	if got := find(t, obs.Windows, WindowWeeklyFable); !approx(got.UsedPercent, 70) {
		t.Fatalf("fable = %+v, want the active limit", got)
	}
}

func TestParseClaudeUsageErrors(t *testing.T) {
	for name, body := range map[string]string{"not json": "nope", "no windows": `{}`, "all null": `{"five_hour":null}`} {
		if _, err := ParseClaudeUsage([]byte(body), unix(0)); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

func TestParseClaudeBanked(t *testing.T) {
	body := `{"cedar_ember":{"eligible":true,"at_limit":false,"weekly_resets_at":"2026-11-04T10:00:00Z","grants":[
	  {"id":"g1","resets_total":2,"resets_left":1,"ends_at":"2026-11-20T00:00:00Z","usable_now":true,"clears":["weekly"]},
	  {"id":"g2","resets_total":1,"resets_left":0,"ends_at":"2026-11-10T00:00:00Z","usable_now":false,"clears":[]},
	  {"id":"g3","resets_total":1,"resets_left":1,"ends_at":"2026-11-12T00:00:00Z","usable_now":false,"clears":[]}]}}`
	banked, err := ParseClaudeBanked([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if banked == nil || banked.Available != 2 || banked.Total != 4 || !banked.UsableNow ||
		banked.EndsAt.UTC().Format(time.RFC3339) != "2026-11-12T00:00:00Z" {
		t.Fatalf("banked = %+v", banked)
	}

	banked, err = ParseClaudeBanked([]byte(`{"five_hour":{"utilization":1}}`))
	if err != nil || banked != nil {
		t.Fatalf("missing cedar_ember: banked=%+v err=%v, want nil, nil", banked, err)
	}
}

const codexUsageFixture = `{
  "plan_type": "pro",
  "rate_limit": {
    "allowed": true, "limit_reached": false,
    "primary_window": {"used_percent": 21, "limit_window_seconds": 18000, "reset_after_seconds": 3600, "reset_at": 1761916800},
    "secondary_window": {"used_percent": 55.5, "limit_window_seconds": 604800, "reset_after_seconds": 90000, "reset_at": 1762300800}
  },
  "additional_rate_limits": [
    {"limit_name": "GPT-5.3-Codex-Spark", "rate_limit": {"allowed": true, "limit_reached": false,
      "primary_window": {"used_percent": 3, "limit_window_seconds": 18000, "reset_at": 1761916800},
      "secondary_window": {"used_percent": 9, "limit_window_seconds": 604800, "reset_at": 1762300800}}}
  ],
  "rate_limit_reset_credits": {"available_count": 2}
}`

func TestParseCodexUsage(t *testing.T) {
	obs, err := ParseCodexUsage([]byte(codexUsageFixture), unix(1761900000))
	if err != nil {
		t.Fatal(err)
	}
	if obs.Plan != "pro" {
		t.Fatalf("plan = %q", obs.Plan)
	}
	five := find(t, obs.Windows, WindowFiveHour)
	if !approx(five.UsedPercent, 21) || !five.ResetsAt.Equal(unix(1761916800)) {
		t.Fatalf("5h = %+v", five)
	}
	if week := find(t, obs.Windows, WindowWeekly); !approx(week.UsedPercent, 55.5) || !week.ResetsAt.Equal(unix(1762300800)) {
		t.Fatalf("7d = %+v", week)
	}
	if spark := find(t, obs.Windows, "gpt-5-3-codex-spark:7d"); !approx(spark.UsedPercent, 9) {
		t.Fatalf("spark 7d = %+v", spark)
	}
	if !has(obs.Windows, "gpt-5-3-codex-spark:5h") || len(obs.Windows) != 4 {
		t.Fatalf("windows = %+v", obs.Windows)
	}
	if obs.Banked == nil || obs.Banked.Available != 2 {
		t.Fatalf("banked = %+v", obs.Banked)
	}
}

func TestParseCodexUsageLimitReachedWithoutPercent(t *testing.T) {
	body := `{"rate_limit":{"limit_reached":true,"primary_window":{"limit_window_seconds":18000,"reset_after_seconds":600}}}`
	obs, err := ParseCodexUsage([]byte(body), unix(1761900000))
	if err != nil {
		t.Fatal(err)
	}
	got := find(t, obs.Windows, WindowFiveHour)
	if !approx(got.UsedPercent, 100) || !got.ResetsAt.Equal(unix(1761900600)) {
		t.Fatalf("5h = %+v", got)
	}
	if obs.Banked != nil {
		t.Fatalf("banked = %+v, want nil when the payload has no reset credits", obs.Banked)
	}
}

func TestParseCodexUsageErrors(t *testing.T) {
	for name, body := range map[string]string{"not json": "nope", "no windows": `{"plan_type":"pro"}`} {
		if _, err := ParseCodexUsage([]byte(body), unix(0)); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}
