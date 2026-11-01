package quota

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	claudeBankedBody = `{"cedar_ember":{"grants":[{"resets_total":2,"resets_left":2,"ends_at":"2026-11-20T00:00:00Z","usable_now":true}]}}`
	testPollTimeout  = 5 * time.Second
)

type seenRequest struct {
	path, query, auth, beta, accountID string
}

type recorder struct {
	mu   sync.Mutex
	reqs []seenRequest
	hit  chan struct{}
}

func newRecorder() *recorder { return &recorder{hit: make(chan struct{}, 64)} }

func (r *recorder) add(req *http.Request) {
	r.mu.Lock()
	r.reqs = append(r.reqs, seenRequest{
		path: req.URL.Path, query: req.URL.RawQuery, auth: req.Header.Get("Authorization"),
		beta: req.Header.Get("Anthropic-Beta"), accountID: req.Header.Get("Chatgpt-Account-Id"),
	})
	r.mu.Unlock()
	r.hit <- struct{}{}
}

func (r *recorder) all() []seenRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]seenRequest(nil), r.reqs...)
}

type fakeSource []Credential

func (f fakeSource) Credentials() []Credential { return f }

// newServer answers the Claude and Codex usage endpoints; fail maps a path to a forced status.
func newServer(t *testing.T, rec *recorder, fail map[string]int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.add(r)
		key := r.URL.Path
		if r.URL.Query().Get("cedar_ember") == "1" {
			key += "?cedar_ember"
		}
		if status := fail[key]; status != 0 {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, "upstream says: secret detail")
			return
		}
		switch {
		case key == "/api/oauth/usage":
			_, _ = io.WriteString(w, claudeUsageFixture)
		case key == "/api/oauth/usage?cedar_ember":
			_, _ = io.WriteString(w, claudeBankedBody)
		case key == "/backend-api/wham/usage":
			_, _ = io.WriteString(w, codexUsageFixture)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newTestPoller(srv *httptest.Server, creds ...Credential) (*Poller, *Store) {
	store := NewStore()
	return NewPoller(PollerConfig{
		Store: store, Source: fakeSource(creds),
		ClaudeBaseURL: srv.URL, CodexBaseURL: srv.URL,
		Client:  func(string) *http.Client { return srv.Client() },
		Timeout: testPollTimeout,
		Now:     func() time.Time { return unix(1761900000) },
	}), store
}

func TestPollerClaudeReadsWindowsAndBankedResets(t *testing.T) {
	rec := newRecorder()
	p, store := newTestPoller(newServer(t, rec, nil), Credential{AuthID: "a", Provider: "claude", Token: "tok"})

	if err := p.Refresh(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}

	got := account(t, store, "a")
	if five := find(t, got.Windows, WindowFiveHour); !approx(five.UsedPercent, 37) {
		t.Fatalf("5h = %+v", five)
	}
	if got.Banked == nil || got.Banked.Available != 2 || got.Source != SourcePoll || got.PollError != "" || !got.PolledAt.Equal(unix(1761900000)) {
		t.Fatalf("account = %+v", got)
	}
	for _, req := range rec.all() {
		if req.auth != "Bearer tok" || req.beta != "oauth-2025-04-20" {
			t.Fatalf("request headers = %+v", req)
		}
	}
	if reqs := rec.all(); len(reqs) != 2 || reqs[1].query != "cedar_ember=1&skip_spend=1" {
		t.Fatalf("requests = %+v, want usage then banked-reset reads", reqs)
	}
}

func TestPollerCodexSendsAccountID(t *testing.T) {
	rec := newRecorder()
	p, store := newTestPoller(newServer(t, rec, nil), Credential{AuthID: "c", Provider: "codex", Token: "tok", AccountID: "acct-9"})

	if err := p.Refresh(context.Background(), "c"); err != nil {
		t.Fatal(err)
	}

	if reqs := rec.all(); len(reqs) != 1 || reqs[0].path != "/backend-api/wham/usage" || reqs[0].auth != "Bearer tok" || reqs[0].accountID != "acct-9" {
		t.Fatalf("requests = %+v", reqs)
	}
	got := account(t, store, "c")
	if got.Plan != "pro" || got.Banked == nil || got.Banked.Available != 2 {
		t.Fatalf("account = %+v", got)
	}
}

func TestPollerRecordsFailureWithoutLeakingBody(t *testing.T) {
	rec := newRecorder()
	p, store := newTestPoller(newServer(t, rec, map[string]int{"/api/oauth/usage": http.StatusUnauthorized}),
		Credential{AuthID: "a", Provider: "claude", Token: "tok"})

	err := p.Refresh(context.Background(), "a")
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("err = %v, want a 401 error", err)
	}
	got := account(t, store, "a")
	if !strings.Contains(got.PollError, "401") || strings.Contains(got.PollError, "secret detail") {
		t.Fatalf("PollError = %q", got.PollError)
	}
	if len(got.Windows) != 0 || got.Source != "" || !got.ObservedAt.IsZero() {
		t.Fatalf("failed poll recorded an observation: %+v", got)
	}
}

func TestPollerBankedFailureDoesNotFailThePoll(t *testing.T) {
	rec := newRecorder()
	p, store := newTestPoller(newServer(t, rec, map[string]int{"/api/oauth/usage?cedar_ember": http.StatusInternalServerError}),
		Credential{AuthID: "a", Provider: "claude", Token: "tok"})

	if err := p.Refresh(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	got := account(t, store, "a")
	if got.Banked != nil || got.PollError != "" || !has(got.Windows, WindowWeekly) {
		t.Fatalf("account = %+v", got)
	}
}

func TestPollerRefreshUnknownAccount(t *testing.T) {
	p, _ := newTestPoller(newServer(t, newRecorder(), nil))
	if err := p.Refresh(context.Background(), "nobody"); err == nil {
		t.Fatal("expected an error for an unknown account")
	}
}

func TestPollerRefreshAllPollsSupportedAccountsOnly(t *testing.T) {
	rec := newRecorder()
	p, store := newTestPoller(newServer(t, rec, nil),
		Credential{AuthID: "a", Provider: "claude", Token: "t1"},
		Credential{AuthID: "b", Provider: "claude", Token: "t2"},
		Credential{AuthID: "c", Provider: "codex", Token: "t3"},
		Credential{AuthID: "g", Provider: "gemini", Token: "t4"},
		Credential{AuthID: "empty", Provider: "claude"},
	)

	p.RefreshAll(context.Background())

	tokens := map[string]bool{}
	for _, req := range rec.all() {
		tokens[req.auth] = true
	}
	if !tokens["Bearer t1"] || !tokens["Bearer t2"] || !tokens["Bearer t3"] || tokens["Bearer t4"] || len(tokens) != 3 {
		t.Fatalf("polled tokens = %v", tokens)
	}
	if got := len(store.Snapshot()); got != 3 {
		t.Fatalf("accounts = %d, want 3 (unsupported provider and empty token skipped)", got)
	}
}

func TestPollerRefreshAllStopsOnCancelledContext(t *testing.T) {
	rec := newRecorder()
	var creds []Credential
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		creds = append(creds, Credential{AuthID: id, Provider: "claude", Token: "t-" + id})
	}
	p, store := newTestPoller(newServer(t, rec, nil), creds...)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	p.RefreshAll(ctx)

	if reqs := rec.all(); len(reqs) != 0 {
		t.Fatalf("requests after cancel: %+v", reqs)
	}
	// Shutting down must not leave "context canceled" poll errors on the dashboard.
	if got := store.Snapshot(); len(got) != 0 {
		t.Fatalf("cancelled pass recorded state: %+v", got)
	}
}

func TestPollerDropsResultWhenCancelledMidRequest(t *testing.T) {
	rec := newRecorder()
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		rec.add(r)
		<-r.Context().Done() // hold the request open until the client gives up
	}))
	t.Cleanup(srv.Close)
	p, store := newTestPoller(srv, Credential{AuthID: "a", Provider: "claude", Token: "t"})

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- p.Refresh(ctx, "a") }()
	waitFor(t, rec.hit, "the usage request")
	cancel()

	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("a cancelled refresh must report an error")
		}
	case <-time.After(testPollTimeout):
		t.Fatal("Refresh did not return after cancel")
	}
	if got := store.Snapshot(); len(got) != 0 {
		t.Fatalf("cancelled poll recorded state: %+v", got)
	}
}

func TestPollerPassesProxyURLToClientFactory(t *testing.T) {
	srv := newServer(t, newRecorder(), nil)
	var gotProxy string
	store := NewStore()
	p := NewPoller(PollerConfig{
		Store: store, Source: fakeSource{{AuthID: "a", Provider: "claude", Token: "t", ProxyURL: "socks5://proxy.invalid:1080"}},
		ClaudeBaseURL: srv.URL,
		Client:        func(proxyURL string) *http.Client { gotProxy = proxyURL; return srv.Client() },
	})
	if err := p.Refresh(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	if gotProxy != "socks5://proxy.invalid:1080" {
		t.Fatalf("client factory got proxy %q", gotProxy)
	}
}

func TestPollerRunPollsImmediatelyThenOnEveryTickUntilCancelled(t *testing.T) {
	rec := newRecorder()
	p, _ := newTestPoller(newServer(t, rec, nil), Credential{AuthID: "c", Provider: "codex", Token: "t"})
	ticks := make(chan time.Time)
	p.newTicker = func(time.Duration) (<-chan time.Time, func()) { return ticks, func() {} }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	waitFor(t, rec.hit, "initial poll")
	ticks <- time.Time{}
	waitFor(t, rec.hit, "poll after tick")
	cancel()
	waitFor(t, done, "Run to stop after cancel")
}

func waitFor[T any](t *testing.T, ch <-chan T, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(testPollTimeout):
		t.Fatalf("timed out waiting for %s", what)
	}
}
