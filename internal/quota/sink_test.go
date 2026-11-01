package quota

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func claudeResponseHeaders(status, utilization string) http.Header {
	h := http.Header{}
	h.Set("Anthropic-Ratelimit-Unified-5h-Status", status)
	h.Set("Anthropic-Ratelimit-Unified-5h-Utilization", utilization)
	h.Set("Anthropic-Ratelimit-Unified-5h-Reset", "1761916800")
	return h
}

func TestSinkRecordsHeadersAndCacheTokens(t *testing.T) {
	store := NewStore()
	sink := NewSink(store)

	sink.HandleUsage(context.Background(), usage.Record{
		Provider: "claude", AuthID: "auth-a", Model: "claude-opus", SessionID: "s1",
		RequestedAt: unix(1761900000), Latency: 2 * time.Second,
		Detail:          usage.Detail{InputTokens: 100, OutputTokens: 50, CacheReadTokens: 2000, CacheCreationTokens: 300},
		ResponseHeaders: claudeResponseHeaders("allowed", "0.42"),
	})

	got := account(t, store, "auth-a")
	if five := find(t, got.Windows, WindowFiveHour); !approx(five.UsedPercent, 42) || !five.ResetsAt.Equal(unix(1761916800)) {
		t.Fatalf("5h = %+v", five)
	}
	if got.Source != SourceHeaders || !got.ObservedAt.Equal(unix(1761900002)) {
		t.Fatalf("source=%q observedAt=%v, want headers at the response time", got.Source, got.ObservedAt)
	}
	want := CacheCounters{Requests: 1, Input: 100, Output: 50, CacheRead: 2000, CacheWrite: 300}
	if got.Cache != want {
		t.Fatalf("cache = %+v, want %+v", got.Cache, want)
	}
}

func TestSinkCountsCodexCachedInputAsRead(t *testing.T) {
	store := NewStore()
	NewSink(store).HandleUsage(context.Background(), usage.Record{
		Provider: "codex", AuthID: "auth-c", RequestedAt: unix(1761900000),
		Detail: usage.Detail{InputTokens: 1000, CachedTokens: 600, CacheReadTokens: 600, OutputTokens: 40},
	})

	got := account(t, store, "auth-c").Cache
	want := CacheCounters{Requests: 1, Input: 400, Output: 40, CacheRead: 600}
	if got != want {
		t.Fatalf("cache = %+v, want %+v (cached tokens are a subset of Codex input)", got, want)
	}
}

func TestSinkDoesNotMistakeCacheWritesForReads(t *testing.T) {
	// The usage parsers mirror cache-creation tokens into CachedTokens when nothing was cached.
	store := NewStore()
	NewSink(store).HandleUsage(context.Background(), usage.Record{
		Provider: "claude", AuthID: "auth-a", RequestedAt: unix(1761900000),
		Detail: usage.Detail{InputTokens: 10, OutputTokens: 5, CacheCreationTokens: 300, CachedTokens: 300},
	})

	got := account(t, store, "auth-a").Cache
	if got.CacheRead != 0 || got.CacheWrite != 300 {
		t.Fatalf("cache = %+v, want 0 read and 300 written", got)
	}
}

func TestSinkKeepsRateLimitHeadersFromFailedRequests(t *testing.T) {
	store := NewStore()
	NewSink(store).HandleUsage(context.Background(), usage.Record{
		Provider: "claude", AuthID: "auth-a", RequestedAt: unix(1761900000),
		Failed: true, Fail: usage.Failure{StatusCode: http.StatusTooManyRequests},
		ResponseHeaders: claudeResponseHeaders("rejected", "1.0"),
	})

	got := account(t, store, "auth-a")
	if five := find(t, got.Windows, WindowFiveHour); !approx(five.UsedPercent, 100) || five.Status != "rejected" {
		t.Fatalf("429 headers were dropped: %+v", five)
	}
	if got.Cache.Requests != 0 {
		t.Fatalf("a failed request was counted: %+v", got.Cache)
	}
}

func TestSinkIgnoresRecordsItCannotAttribute(t *testing.T) {
	store := NewStore()
	sink := NewSink(store)
	sink.HandleUsage(context.Background(), usage.Record{Provider: "claude", ResponseHeaders: claudeResponseHeaders("allowed", "0.1")})
	sink.HandleUsage(context.Background(), usage.Record{Provider: "gemini", AuthID: "auth-g", Detail: usage.Detail{InputTokens: 5}})
	if got := store.Snapshot(); len(got) != 0 {
		t.Fatalf("unattributable records created accounts: %+v", got)
	}
}
