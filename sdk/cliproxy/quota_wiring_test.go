package cliproxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/api"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/quota"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func registerQuotaTestAuth(t *testing.T, m *coreauth.Manager, a *coreauth.Auth) {
	t.Helper()
	if _, err := m.Register(context.Background(), a); err != nil {
		t.Fatalf("register %s: %v", a.ID, err)
	}
}

func TestQuotaCredentialsListsOnlyUsableOAuthAccounts(t *testing.T) {
	m := coreauth.NewManager(nil, nil, nil)
	registerQuotaTestAuth(t, m, &coreauth.Auth{ID: "claude-a", Provider: "claude", ProxyURL: "socks5://auth-proxy:1080", Metadata: map[string]any{"access_token": " tok-a "}})
	registerQuotaTestAuth(t, m, &coreauth.Auth{ID: "claude-nested", Provider: "Claude", Metadata: map[string]any{"token": map[string]any{"accessToken": "tok-n"}}})
	registerQuotaTestAuth(t, m, &coreauth.Auth{ID: "codex-a", Provider: "codex", Metadata: map[string]any{"access_token": "tok-c", "account_id": " acct-1 "}})
	registerQuotaTestAuth(t, m, &coreauth.Auth{ID: "disabled", Provider: "claude", Disabled: true, Metadata: map[string]any{"access_token": "x"}})
	registerQuotaTestAuth(t, m, &coreauth.Auth{ID: "api-key", Provider: "claude", Attributes: map[string]string{"api_key": "sk-ant-1"}, Metadata: map[string]any{"access_token": "x"}})
	registerQuotaTestAuth(t, m, &coreauth.Auth{ID: "id-token-only", Provider: "codex", Metadata: map[string]any{"id_token": "only-an-id-token"}})
	registerQuotaTestAuth(t, m, &coreauth.Auth{ID: "gemini-a", Provider: "gemini", Metadata: map[string]any{"access_token": "x"}})

	source := quotaCredentials{manager: m, config: func() *config.Config {
		return &config.Config{SDKConfig: config.SDKConfig{ProxyURL: "http://global:3128"}}
	}}
	got := map[string]quota.Credential{}
	for _, cred := range source.Credentials() {
		got[cred.AuthID] = cred
	}

	want := map[string]quota.Credential{
		"claude-a":      {AuthID: "claude-a", Provider: "claude", Token: "tok-a", ProxyURL: "socks5://auth-proxy:1080"},
		"claude-nested": {AuthID: "claude-nested", Provider: "claude", Token: "tok-n", ProxyURL: "http://global:3128"},
		"codex-a":       {AuthID: "codex-a", Provider: "codex", Token: "tok-c", AccountID: "acct-1", ProxyURL: "http://global:3128"},
	}
	if len(got) != len(want) {
		t.Fatalf("credentials = %+v, want exactly %v", got, []string{"claude-a", "claude-nested", "codex-a"})
	}
	for id, cred := range want {
		if got[id] != cred {
			t.Fatalf("%s = %+v, want %+v", id, got[id], cred)
		}
	}
}

func TestQuotaCredentialsWithoutManager(t *testing.T) {
	if got := (quotaCredentials{}).Credentials(); len(got) != 0 {
		t.Fatalf("credentials = %+v, want none", got)
	}
}

func TestQuotaClientsReuseOneClientPerProxy(t *testing.T) {
	clients := newQuotaClients()
	proxied := clients.forProxy("http://proxy.example:3128")
	if clients.forProxy("http://proxy.example:3128") != proxied {
		t.Fatal("expected a cached client per proxy URL")
	}
	if clients.forProxy("") == proxied {
		t.Fatal("different proxy settings must not share a client")
	}
}

func TestQuotaClientsFailClosedOnInvalidProxy(t *testing.T) {
	client := newQuotaClients().forProxy("ftp://proxy.invalid")
	req, errReq := http.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	if errReq != nil {
		t.Fatal(errReq)
	}
	resp, err := client.Do(req)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("an invalid proxy must fail the request instead of going direct")
	}
	if !strings.Contains(err.Error(), "proxy") {
		t.Fatalf("err = %v, want it to name the proxy problem", err)
	}
}

func TestNewQuotaStoreRegistersSinkAndAppliesRebuildThreshold(t *testing.T) {
	var gotName string
	var gotPlugin usage.Plugin
	cfg := &config.Config{QuotaMonitor: config.QuotaMonitorConfig{RebuildAlertTokens: 50}}

	store := newQuotaStoreWith(cfg, func(name string, plugin usage.Plugin) { gotName, gotPlugin = name, plugin })

	if gotName != quotaUsagePluginName || gotPlugin == nil {
		t.Fatalf("registered %q / %v, want the %q sink", gotName, gotPlugin, quotaUsagePluginName)
	}
	gotPlugin.HandleUsage(context.Background(), usage.Record{
		Provider: "claude", AuthID: "a",
		Detail: usage.Detail{InputTokens: 1, CacheCreationTokens: 60},
	})
	snapshot := store.Snapshot()
	if len(snapshot) != 1 || snapshot[0].Cache.CacheWrite != 60 || len(snapshot[0].Rebuilds) != 1 {
		t.Fatalf("snapshot = %+v, want the record counted and flagged as a rebuild at the configured threshold", snapshot)
	}
}

func TestBuildWiresQuotaStoreAndPoller(t *testing.T) {
	cfg := &config.Config{}
	cfg.Routing.Strategy = "expiration-first"
	service, err := NewBuilder().
		WithConfig(cfg).
		WithConfigPath(t.TempDir() + "/config.yaml").
		Build()
	if err != nil {
		t.Fatal(err)
	}
	if service.quotaStore == nil || service.quotaPoller == nil {
		t.Fatalf("quotaStore=%v quotaPoller=%v, want both wired", service.quotaStore, service.quotaPoller)
	}
	// The selector Build() created must read the very store the service exposes.
	observeWeeklyResets(service.quotaStore)
	if got := pickFromAB(t, service.coreManager.Selector()); got != "b" {
		t.Fatalf("Pick() = %q, want b: the built selector is not reading the service's quota store", got)
	}
}

func TestBuildPassesQuotaMonitorToTheAPIServer(t *testing.T) {
	cfg := &config.Config{SDKConfig: config.SDKConfig{TrustedNetworks: config.TrustedNetworksConfig{Enabled: true}}}
	service, err := NewBuilder().WithConfig(cfg).WithConfigPath(t.TempDir() + "/config.yaml").Build()
	if err != nil {
		t.Fatal(err)
	}
	registerQuotaTestAuth(t, service.coreManager, &coreauth.Auth{ID: "claude-a", Provider: "claude", Metadata: map[string]any{"access_token": "tok"}})
	service.quotaStore.Observe("claude-a", "claude", quota.Observation{Plan: "max"}, time.Now(), quota.SourceHeaders)
	server := api.NewServer(cfg, service.coreManager, service.accessManager, service.configPath, service.serverOptions...)
	serve := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr, req.Host = "127.0.0.1:5000", "localhost:8317"
		rr := httptest.NewRecorder()
		server.Handler().ServeHTTP(rr, req)
		return rr
	}

	if rr := serve(http.MethodGet, "/vpxy/api/overview", ""); !strings.Contains(rr.Body.String(), `"plan":"max"`) {
		t.Fatalf("overview = %d %s, want the service's quota store behind the dashboard API", rr.Code, rr.Body.String())
	}
	// An unknown account is refused before any poll, so 404 (not 503) proves the poller is wired.
	if rr := serve(http.MethodPost, "/vpxy/api/quota/refresh", `{"auth_id":"nobody"}`); rr.Code != http.StatusNotFound {
		t.Fatalf("refresh = %d %s, want 404 from a server that has the poller", rr.Code, rr.Body.String())
	}
}

type signalSource chan struct{}

func (s signalSource) Credentials() []quota.Credential {
	select {
	case s <- struct{}{}:
	default:
	}
	return nil
}

func newPollerService(disabled bool, source quota.CredentialSource) *Service {
	return &Service{
		cfg:         &config.Config{QuotaMonitor: config.QuotaMonitorConfig{Disabled: disabled}},
		quotaPoller: quota.NewPoller(quota.PollerConfig{Store: quota.NewStore(), Source: source}),
	}
}

func TestStartQuotaPollerRunsUntilContextEnds(t *testing.T) {
	polled := make(signalSource, 1)
	svc := newPollerService(false, polled)
	ctx, cancel := context.WithCancel(context.Background())

	svc.startQuotaPoller(ctx)
	select {
	case <-polled:
	case <-time.After(5 * time.Second):
		t.Fatal("poller never polled")
	}
	cancel()
	svc.quotaWG.Wait() // returns only once the poller goroutine has exited
}

func TestStartQuotaPollerHonoursDisabledSetting(t *testing.T) {
	polled := make(signalSource, 1)
	svc := newPollerService(true, polled)
	ctx, cancel := context.WithCancel(context.Background())

	svc.startQuotaPoller(ctx)
	cancel() // a poller that wrongly started still polls once before it sees this
	svc.quotaWG.Wait()

	select {
	case <-polled:
		t.Fatal("a disabled poller polled")
	default:
	}
}
