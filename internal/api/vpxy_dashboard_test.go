package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	proxyconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quota"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

var vpxyNow = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

func vpxyTestAuth(id, provider string) *auth.Auth {
	return &auth.Auth{ID: id, Provider: provider, Metadata: map[string]any{"email": id + "@example.com", "access_token": "secret-token"}}
}

func vpxyAccountByID(t *testing.T, overview vpxyOverview, id string) vpxyAccount {
	t.Helper()
	for _, account := range overview.Accounts {
		if account.AuthID == id {
			return account
		}
	}
	t.Fatalf("account %q missing from %+v", id, overview.Accounts)
	return vpxyAccount{}
}

func TestBuildVPXYOverviewMergesLiveAccountsWithQuotaData(t *testing.T) {
	disabled := vpxyTestAuth("claude-d", "claude")
	disabled.Disabled = true
	apiKey := vpxyTestAuth("claude-key", "claude")
	apiKey.Attributes = map[string]string{"api_key": "sk-ant-1"}

	overview := buildVPXYOverview(vpxyOverviewInput{
		Now:    vpxyNow,
		Config: &proxyconfig.Config{},
		Auths:  []*auth.Auth{vpxyTestAuth("codex-b", "codex"), vpxyTestAuth("claude-a", "Claude"), vpxyTestAuth("gemini-g", "gemini"), disabled, apiKey, nil},
		Accounts: []quota.Account{
			{AuthID: "claude-a", Provider: "claude", Plan: "max", Windows: []quota.Window{{ID: quota.WindowWeekly, UsedPercent: 40}}},
			{AuthID: "removed", Provider: "claude"},
		},
	})

	var ids []string
	for _, account := range overview.Accounts {
		ids = append(ids, account.AuthID)
	}
	if got := strings.Join(ids, ","); got != "claude-a,claude-d,codex-b" {
		t.Fatalf("accounts = %s, want claude-a,claude-d,codex-b (OAuth Claude/Codex only, provider then id)", got)
	}
	a := vpxyAccountByID(t, overview, "claude-a")
	if a.Label != "claude-a@example.com" || a.Plan != "max" || a.Provider != "claude" || len(a.Windows) != 1 {
		t.Fatalf("claude-a = %+v", a)
	}
	if b := vpxyAccountByID(t, overview, "codex-b"); b.Windows == nil || len(b.Windows) != 0 {
		t.Fatalf("an account without quota data must list an empty windows array, got %#v", b.Windows)
	}
}

func TestBuildVPXYOverviewAccountStatus(t *testing.T) {
	exhausted := func(resetsIn time.Duration) []quota.Window {
		return []quota.Window{{ID: quota.WindowFiveHour, UsedPercent: 100, ResetsAt: vpxyNow.Add(resetsIn)}}
	}
	cases := []struct {
		name      string
		mutate    func(*auth.Auth)
		windows   []quota.Window
		want      string
		wantUntil time.Time
	}{
		{"ready", func(*auth.Auth) {}, nil, "ready", time.Time{}},
		{"disabled flag", func(a *auth.Auth) { a.Disabled = true }, nil, "disabled", time.Time{}},
		{"disabled status", func(a *auth.Auth) { a.Status = auth.StatusDisabled }, nil, "disabled", time.Time{}},
		{"quota cooldown one tick ahead", func(a *auth.Auth) {
			a.Quota = auth.QuotaState{Exceeded: true, NextRecoverAt: vpxyNow.Add(time.Nanosecond)}
		}, nil, "cooldown", vpxyNow.Add(time.Nanosecond)},
		{"quota cooldown ends exactly now", func(a *auth.Auth) {
			a.Quota = auth.QuotaState{Exceeded: true, NextRecoverAt: vpxyNow}
		}, nil, "ready", time.Time{}},
		{"recover time without the exceeded flag", func(a *auth.Auth) {
			a.Quota = auth.QuotaState{NextRecoverAt: vpxyNow.Add(time.Hour)}
		}, nil, "ready", time.Time{}},
		{"retry-after one tick ahead", func(a *auth.Auth) {
			a.Unavailable, a.NextRetryAfter = true, vpxyNow.Add(time.Nanosecond)
		}, nil, "cooldown", vpxyNow.Add(time.Nanosecond)},
		{"retry-after exactly now", func(a *auth.Auth) {
			a.Unavailable, a.NextRetryAfter = true, vpxyNow
		}, nil, "ready", time.Time{}},
		{"window exhausted", func(*auth.Auth) {}, exhausted(2 * time.Hour), "limited", vpxyNow.Add(2 * time.Hour)},
		{"window resets exactly now", func(*auth.Auth) {}, exhausted(0), "ready", time.Time{}},
		{"cooldown beats limited", func(a *auth.Auth) {
			a.Quota = auth.QuotaState{Exceeded: true, NextRecoverAt: vpxyNow.Add(time.Minute)}
		}, exhausted(2 * time.Hour), "cooldown", vpxyNow.Add(time.Minute)},
		{"disabled beats cooldown", func(a *auth.Auth) {
			a.Disabled = true
			a.Quota = auth.QuotaState{Exceeded: true, NextRecoverAt: vpxyNow.Add(time.Minute)}
		}, nil, "disabled", time.Time{}},
	}
	for _, tc := range cases {
		a := vpxyTestAuth("claude-a", "claude")
		tc.mutate(a)
		overview := buildVPXYOverview(vpxyOverviewInput{
			Now: vpxyNow, Auths: []*auth.Auth{a},
			Accounts: []quota.Account{{AuthID: "claude-a", Provider: "claude", Windows: tc.windows}},
		})
		got := vpxyAccountByID(t, overview, "claude-a")
		if got.Status != tc.want || !got.StatusUntil.Equal(tc.wantUntil) {
			t.Fatalf("%s: status=%q until=%v, want %q until %v", tc.name, got.Status, got.StatusUntil, tc.want, tc.wantUntil)
		}
	}
}

func TestBuildVPXYOverviewReportsRoutingPriority(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  int
	}{{"", 0}, {" 12 ", 12}, {"-3", -3}, {"invalid", 0}} {
		t.Run(tc.value, func(t *testing.T) {
			credential := vpxyTestAuth("claude-priority", "claude")
			credential.Attributes = map[string]string{"priority": tc.value}
			overview := buildVPXYOverview(vpxyOverviewInput{Now: vpxyNow, Auths: []*auth.Auth{credential}})
			if got := vpxyAccountByID(t, overview, credential.ID).Priority; got != tc.want {
				t.Fatalf("priority = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestBuildVPXYOverviewSessions(t *testing.T) {
	var bindings []auth.SessionBinding
	for i := 0; i < 10; i++ {
		bindings = append(bindings, auth.SessionBinding{
			SessionID: fmt.Sprintf("%02d-abcdefghijkl", i), AuthID: "claude-a",
			ExpiresAt: vpxyNow.Add(time.Duration(10-i) * time.Minute),
		})
	}
	bindings = append(bindings,
		auth.SessionBinding{SessionID: "short", AuthID: "codex-b", ExpiresAt: vpxyNow.Add(90 * time.Second)},
		auth.SessionBinding{SessionID: "lapsed-now", AuthID: "codex-b", ExpiresAt: vpxyNow},
		auth.SessionBinding{SessionID: "lapsed-before", AuthID: "codex-b", ExpiresAt: vpxyNow.Add(-time.Second)},
	)

	overview := buildVPXYOverview(vpxyOverviewInput{
		Now: vpxyNow, Config: &proxyconfig.Config{}, Bindings: bindings,
		Auths: []*auth.Auth{vpxyTestAuth("claude-a", "claude"), vpxyTestAuth("codex-b", "codex")},
	})

	a := vpxyAccountByID(t, overview, "claude-a").Sessions
	if a.Count != 10 || len(a.Recent) != 8 || a.Recent[0].ID != "00-abcde…" || a.Recent[0].ExpiresInSeconds != 600 {
		t.Fatalf("claude-a sessions = %+v, want 10 live, 8 listed, ids shortened to 8 characters", a)
	}
	b := vpxyAccountByID(t, overview, "codex-b").Sessions
	if b.Count != 1 || len(b.Recent) != 1 || b.Recent[0].ID != "short" || b.Recent[0].ExpiresInSeconds != 90 {
		t.Fatalf("codex-b sessions = %+v, want only the live one (a session expiring exactly now is gone)", b)
	}
	if overview.Routing.Sessions != 11 {
		t.Fatalf("routing sessions = %d, want 11 live bindings", overview.Routing.Sessions)
	}
}

func TestBuildVPXYOverviewRoutingMonitorAndTotals(t *testing.T) {
	cfg := &proxyconfig.Config{}
	cfg.Routing.Strategy = " Expiration-First "
	cfg.Routing.SessionAffinity = true
	cfg.Routing.SessionAffinityTTL = "15m"
	cfg.Routing.SessionAffinityRebindOn = "QUOTA"
	cfg.QuotaMonitor = proxyconfig.QuotaMonitorConfig{Interval: "2m", RebuildAlertTokens: 250000}
	cfg.SDKConfig = sdkconfig.SDKConfig{TrustedNetworks: proxyconfig.TrustedNetworksConfig{Enabled: true}}

	overview := buildVPXYOverview(vpxyOverviewInput{
		Now: vpxyNow, Config: cfg,
		Auths: []*auth.Auth{vpxyTestAuth("claude-a", "claude"), vpxyTestAuth("codex-b", "codex")},
		Accounts: []quota.Account{
			{AuthID: "claude-a", Provider: "claude", Cache: quota.CacheCounters{Requests: 2, Input: 10, Output: 5, CacheRead: 100, CacheWrite: 50}},
			{AuthID: "codex-b", Provider: "codex", Cache: quota.CacheCounters{Requests: 1, Input: 1, Output: 2, CacheRead: 3, CacheWrite: 4}},
		},
	})

	if want := (vpxyRouting{Strategy: "expiration-first", SessionAffinity: true, SessionTTLSeconds: 900, RebindOn: "quota"}); overview.Routing != want {
		t.Fatalf("routing = %+v, want %+v", overview.Routing, want)
	}
	if want := (vpxyMonitor{PollingEnabled: true, IntervalSeconds: 120, RebuildAlertTokens: 250000, TrustedNetworks: true}); overview.Monitor != want {
		t.Fatalf("monitor = %+v, want %+v", overview.Monitor, want)
	}
	if want := (quota.CacheCounters{Requests: 3, Input: 11, Output: 7, CacheRead: 103, CacheWrite: 54}); overview.Totals != want {
		t.Fatalf("totals = %+v, want %+v", overview.Totals, want)
	}
}

func TestBuildVPXYOverviewDefaults(t *testing.T) {
	overview := buildVPXYOverview(vpxyOverviewInput{Now: vpxyNow})
	if want := (vpxyRouting{Strategy: "round-robin", SessionTTLSeconds: 3600, RebindOn: "any"}); overview.Routing != want {
		t.Fatalf("routing = %+v, want %+v", overview.Routing, want)
	}
	if want := (vpxyMonitor{PollingEnabled: true, IntervalSeconds: 300, RebuildAlertTokens: 100000}); overview.Monitor != want {
		t.Fatalf("monitor = %+v, want %+v", overview.Monitor, want)
	}
	disabled := &proxyconfig.Config{QuotaMonitor: proxyconfig.QuotaMonitorConfig{Disabled: true}}
	if buildVPXYOverview(vpxyOverviewInput{Now: vpxyNow, Config: disabled}).Monitor.PollingEnabled {
		t.Fatal("polling reported enabled although quota-monitor.disabled is true")
	}
}

func TestVPXYAffinityTTLBoundaries(t *testing.T) {
	cases := map[string]int64{"": 3600, "abc": 3600, "0s": 3600, "-5m": 3600, "500ms": 1, "1s": 1, "1500ms": 1, "90s": 90, "15m": 900}
	for raw, want := range cases {
		cfg := &proxyconfig.Config{}
		cfg.Routing.SessionAffinityTTL = raw
		if got := buildVPXYOverview(vpxyOverviewInput{Now: vpxyNow, Config: cfg}).Routing.SessionTTLSeconds; got != want {
			t.Fatalf("session-affinity-ttl %q -> %ds, want %ds", raw, got, want)
		}
	}
}

func TestVPXYOverviewJSONShape(t *testing.T) {
	overview := buildVPXYOverview(vpxyOverviewInput{Now: vpxyNow, Auths: []*auth.Auth{vpxyTestAuth("claude-a", "claude")}})

	raw, err := json.Marshal(overview)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	account := decoded["accounts"].([]any)[0].(map[string]any)
	if account["auth_id"] != "claude-a" || account["status"] != "ready" || account["label"] != "claude-a@example.com" {
		t.Fatalf("account = %v", account)
	}
	if windows, ok := account["windows"].([]any); !ok || len(windows) != 0 {
		t.Fatalf("windows = %#v, want an empty array", account["windows"])
	}
	if _, present := account["status_until"]; present {
		t.Fatal("status_until must be omitted while the account is ready")
	}
	if breaks, ok := decoded["affinity_breaks"].([]any); !ok || len(breaks) != 0 {
		t.Fatalf("affinity_breaks = %#v, want an empty array", decoded["affinity_breaks"])
	}
	if strings.Contains(string(raw), "secret-token") {
		t.Fatal("the overview leaked credential material")
	}
}

func TestVPXYRefreshGuardSpacing(t *testing.T) {
	now := vpxyNow
	guard := newVPXYRefreshGuard(func() time.Time { return now })

	if _, ok := guard.allow("all"); !ok {
		t.Fatal("first refresh was refused")
	}
	now = now.Add(vpxyMinRefreshSpacing - time.Nanosecond)
	if wait, ok := guard.allow("all"); ok || wait != time.Nanosecond {
		t.Fatalf("one tick early: ok=%v wait=%v, want refused with a 1ns wait", ok, wait)
	}
	now = now.Add(time.Nanosecond) // exactly the minimum spacing since the last allowed refresh
	if _, ok := guard.allow("all"); !ok {
		t.Fatal("refresh refused exactly at the minimum spacing")
	}
	if _, ok := guard.allow("claude-a"); !ok {
		t.Fatal("a different target must have its own spacing")
	}
}

// ---- HTTP: access control ----

func newVPXYTestServer(t *testing.T, opts ...ServerOption) *Server {
	t.Helper()
	t.Setenv("MANAGEMENT_PASSWORD", "test-management-key")
	cfg := &proxyconfig.Config{SDKConfig: sdkconfig.SDKConfig{TrustedNetworks: proxyconfig.TrustedNetworksConfig{Enabled: true}}}
	cfg.RemoteManagement.AllowRemote = true
	return newTestServerWithConfig(t, cfg, opts...)
}

func vpxyRequest(server *Server, method, path, remote, body string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = remote
	req.Host = "localhost:8317"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if mutate != nil {
		mutate(req)
	}
	rr := httptest.NewRecorder()
	server.engine.ServeHTTP(rr, req)
	return rr
}

func TestVPXYOverviewAccessControl(t *testing.T) {
	server := newVPXYTestServer(t)
	withKey := func(key string) func(*http.Request) {
		return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+key) }
	}
	crossSite := func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }
	rebound := func(r *http.Request) { r.Host = "evil.example:8317" }
	cases := []struct {
		name    string
		remote  string
		mutate  func(*http.Request)
		want    int
		wantNoc bool
	}{
		{"trusted peer needs no key", "127.0.0.1:5000", nil, http.StatusOK, true},
		{"tailnet peer needs no key", "100.101.102.103:5000", nil, http.StatusOK, true},
		{"untrusted peer without a key", "203.0.113.5:5000", nil, http.StatusUnauthorized, false},
		{"untrusted peer with the management key", "203.0.113.5:5000", withKey("test-management-key"), http.StatusOK, true},
		{"untrusted peer with a wrong key", "203.0.113.5:5000", withKey("nope"), http.StatusUnauthorized, false},
		{"cross-site page on a trusted peer", "127.0.0.1:5000", crossSite, http.StatusUnauthorized, false},
		{"rebound host on a trusted peer", "127.0.0.1:5000", rebound, http.StatusUnauthorized, false},
		{"cross-site page that has the key", "127.0.0.1:5000", func(r *http.Request) { crossSite(r); withKey("test-management-key")(r) }, http.StatusOK, true},
	}
	for _, tc := range cases {
		rr := vpxyRequest(server, http.MethodGet, "/vpxy/api/overview", tc.remote, "", tc.mutate)
		if rr.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d (body %s)", tc.name, rr.Code, tc.want, rr.Body.String())
		}
		if tc.wantNoc && rr.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: Cache-Control = %q, want no-store", tc.name, rr.Header().Get("Cache-Control"))
		}
		if !tc.wantNoc && strings.Contains(rr.Body.String(), `"accounts"`) {
			t.Fatalf("%s: a refused request still received the overview", tc.name)
		}
	}
}

func TestVPXYOverviewReflectsTheLiveAuthManager(t *testing.T) {
	store := quota.NewStore()
	store.Observe("claude-a", "claude", quota.Observation{Plan: "max", Windows: []quota.Window{{ID: quota.WindowWeekly, Label: "Weekly", UsedPercent: 61}}}, vpxyNow, quota.SourceHeaders)
	store.AddUsage(quota.UsageSample{AuthID: "claude-a", Provider: "claude", SessionID: "s1", At: vpxyNow, Input: 5, CacheRead: 700, CacheWrite: 300})
	server := newVPXYTestServer(t, WithQuotaMonitor(store, nil))
	if _, err := server.handlers.AuthManager.Register(t.Context(), vpxyTestAuth("claude-a", "claude")); err != nil {
		t.Fatal(err)
	}

	rr := vpxyRequest(server, http.MethodGet, "/vpxy/api/overview", "127.0.0.1:5000", "", nil)

	var overview vpxyOverview
	if err := json.Unmarshal(rr.Body.Bytes(), &overview); err != nil {
		t.Fatalf("decoding %s: %v", rr.Body.String(), err)
	}
	account := vpxyAccountByID(t, overview, "claude-a")
	if account.Plan != "max" || len(account.Windows) != 1 || account.Cache.CacheRead != 700 || overview.Totals.CacheWrite != 300 {
		t.Fatalf("account = %+v totals = %+v", account, overview.Totals)
	}
	if strings.Contains(rr.Body.String(), "secret-token") {
		t.Fatal("the HTTP overview leaked credential material")
	}
}

type vpxyBindingSelector struct {
	auth.RoundRobinSelector
	bindings []auth.SessionBinding
}

func (s *vpxyBindingSelector) Bindings() []auth.SessionBinding { return s.bindings }

func TestVPXYOverviewReadsSessionsFromTheLiveSelector(t *testing.T) {
	server := newVPXYTestServer(t)
	manager := server.handlers.AuthManager
	if _, err := manager.Register(t.Context(), vpxyTestAuth("claude-a", "claude")); err != nil {
		t.Fatal(err)
	}
	manager.SetSelector(&vpxyBindingSelector{bindings: []auth.SessionBinding{
		{SessionID: "live-session", AuthID: "claude-a", ExpiresAt: time.Now().Add(10 * time.Minute)},
	}})

	rr := vpxyRequest(server, http.MethodGet, "/vpxy/api/overview", "127.0.0.1:5000", "", nil)

	var overview vpxyOverview
	if err := json.Unmarshal(rr.Body.Bytes(), &overview); err != nil {
		t.Fatalf("decoding %s: %v", rr.Body.String(), err)
	}
	if sessions := vpxyAccountByID(t, overview, "claude-a").Sessions; sessions.Count != 1 || overview.Routing.Sessions != 1 {
		t.Fatalf("sessions = %+v routing = %+v, want the selector's one live binding", sessions, overview.Routing)
	}
}

// ---- HTTP: refresh ----

const vpxyUsageBody = `{"five_hour":{"utilization":37,"resets_at":"2026-11-02T00:00:00Z"},"seven_day":{"utilization":62.5,"resets_at":"2026-11-05T00:00:00Z"}}`

type vpxyCredentials []quota.Credential

func (c vpxyCredentials) Credentials() []quota.Credential { return c }

func newVPXYRefreshServer(t *testing.T) (*Server, *int) {
	t.Helper()
	hits := new(int)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		_, _ = io.WriteString(w, vpxyUsageBody)
	}))
	t.Cleanup(upstream.Close)
	store := quota.NewStore()
	poller := quota.NewPoller(quota.PollerConfig{
		Store: store, ClaudeBaseURL: upstream.URL,
		Source: vpxyCredentials{{AuthID: "claude-a", Provider: "claude", Token: "tok"}},
		Client: func(string) *http.Client { return upstream.Client() },
		Now:    func() time.Time { return vpxyNow },
	})
	server := newVPXYTestServer(t, WithQuotaMonitor(store, poller))
	if _, err := server.handlers.AuthManager.Register(t.Context(), vpxyTestAuth("claude-a", "claude")); err != nil {
		t.Fatal(err)
	}
	return server, hits
}

func TestVPXYRefreshPollsTheAccountAndReturnsTheOverview(t *testing.T) {
	server, hits := newVPXYRefreshServer(t)

	rr := vpxyRequest(server, http.MethodPost, "/vpxy/api/quota/refresh", "127.0.0.1:5000", `{"auth_id":"claude-a"}`, nil)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rr.Code, rr.Body.String())
	}
	var overview vpxyOverview
	if err := json.Unmarshal(rr.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	account := vpxyAccountByID(t, overview, "claude-a")
	if len(account.Windows) != 2 || account.Windows[0].ID != quota.WindowFiveHour || account.Windows[0].UsedPercent != 37 || account.Source != quota.SourcePoll {
		t.Fatalf("account = %+v, want the polled 5h and weekly windows", account)
	}
	if *hits == 0 {
		t.Fatal("the upstream usage endpoint was never read")
	}
}

func TestVPXYRefreshWithoutATargetRefreshesEveryAccount(t *testing.T) {
	server, hits := newVPXYRefreshServer(t)
	rr := vpxyRequest(server, http.MethodPost, "/vpxy/api/quota/refresh", "127.0.0.1:5000", "", nil)
	if rr.Code != http.StatusOK || *hits == 0 {
		t.Fatalf("status = %d hits = %d, want 200 and a poll (an empty body means all accounts)", rr.Code, *hits)
	}
}

func TestVPXYRefreshIsRateLimited(t *testing.T) {
	server, hits := newVPXYRefreshServer(t)
	now := vpxyNow
	server.vpxyRefresh = newVPXYRefreshGuard(func() time.Time { return now })
	body := `{"auth_id":"claude-a"}`

	if rr := vpxyRequest(server, http.MethodPost, "/vpxy/api/quota/refresh", "127.0.0.1:5000", body, nil); rr.Code != http.StatusOK {
		t.Fatalf("first refresh status = %d", rr.Code)
	}
	polled := *hits
	rr := vpxyRequest(server, http.MethodPost, "/vpxy/api/quota/refresh", "127.0.0.1:5000", body, nil)
	if rr.Code != http.StatusTooManyRequests || rr.Header().Get("Retry-After") != "5" {
		t.Fatalf("second refresh status = %d Retry-After = %q, want 429 and 5", rr.Code, rr.Header().Get("Retry-After"))
	}
	if *hits != polled {
		t.Fatal("a rate-limited refresh still hit the upstream")
	}
	now = now.Add(vpxyMinRefreshSpacing)
	if rr := vpxyRequest(server, http.MethodPost, "/vpxy/api/quota/refresh", "127.0.0.1:5000", body, nil); rr.Code != http.StatusOK {
		t.Fatalf("refresh after the spacing status = %d", rr.Code)
	}
}

func TestVPXYRefreshRejectsBadRequests(t *testing.T) {
	server, hits := newVPXYRefreshServer(t)
	cases := []struct {
		name, body string
		remote     string
		want       int
	}{
		{"unknown account", `{"auth_id":"nobody"}`, "127.0.0.1:5000", http.StatusNotFound},
		{"malformed body", `{`, "127.0.0.1:5000", http.StatusBadRequest},
		{"no access", `{"auth_id":"claude-a"}`, "203.0.113.5:5000", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		if rr := vpxyRequest(server, http.MethodPost, "/vpxy/api/quota/refresh", tc.remote, tc.body, nil); rr.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d (body %s)", tc.name, rr.Code, tc.want, rr.Body.String())
		}
	}
	if *hits != 0 {
		t.Fatalf("rejected requests still polled the upstream %d times", *hits)
	}
}

func TestVPXYRefreshWithoutAMonitorIsUnavailable(t *testing.T) {
	server := newVPXYTestServer(t)
	if rr := vpxyRequest(server, http.MethodPost, "/vpxy/api/quota/refresh", "127.0.0.1:5000", "", nil); rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
}
