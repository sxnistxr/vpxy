package quota

import (
	"context"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// Sink feeds a Store from finished requests: rate-limit headers, token counts and cache traffic.
// It implements usage.Plugin.
type Sink struct {
	store *Store
}

// NewSink returns a Sink that writes into store.
func NewSink(store *Store) *Sink { return &Sink{store: store} }

// HandleUsage records one finished upstream request. Records without an auth, or from
// providers the dashboard does not cover, are ignored.
func (k *Sink) HandleUsage(_ context.Context, record usage.Record) {
	provider := strings.ToLower(strings.TrimSpace(record.Provider))
	if k == nil || k.store == nil || record.AuthID == "" || !supportsQuota(provider) {
		return
	}
	at := record.RequestedAt.Add(record.Latency)
	if record.RequestedAt.IsZero() {
		at = time.Now()
	}
	// Rate-limit headers matter most on a 429, so they are read whether or not the request failed.
	if obs := ParseHeaders(provider, record.ResponseHeaders, at); len(obs.Windows) > 0 || obs.Plan != "" {
		k.store.Observe(record.AuthID, provider, obs, at, SourceHeaders)
	}
	input, output, cacheRead, cacheWrite := tokenCounts(record)
	k.store.AddUsage(UsageSample{
		AuthID: record.AuthID, Provider: provider, Model: record.Model, SessionID: record.SessionID,
		At: at, Failed: record.Failed,
		Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite,
	})
}

func supportsQuota(provider string) bool { return provider == "claude" || provider == "codex" }

// tokenCounts splits a record into uncached input, output, cache-read and cache-write tokens
// using the canonical accounting, which knows that Codex counts cached tokens inside input
// and Claude does not.
func tokenCounts(record usage.Record) (input, output, cacheRead, cacheWrite int64) {
	detail := usage.EnsureTokenBreakdownForProvider(record.Detail, record.Provider, record.ExecutorType)
	if b := detail.TokenBreakdown; b.Quality == usage.TokenAccountingQualityComplete {
		input, output = b.Input.UncachedTokens, b.Output.TotalTokens
		cacheRead, cacheWrite = b.Input.CacheReadTokens, b.Input.CacheWriteTokens
	} else {
		input, output = detail.InputTokens, detail.OutputTokens
		cacheRead, cacheWrite = detail.CacheReadTokens, detail.CacheCreationTokens
	}
	return input, output, cacheRead, cacheWrite
}
