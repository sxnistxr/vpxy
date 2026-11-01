package cliproxy

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/quota"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/proxyutil"
)

const quotaUsagePluginName = "vpxy-quota"

// newQuotaStore builds the quota store and registers the usage sink that feeds it.
func newQuotaStore(cfg *config.Config) *quota.Store {
	return newQuotaStoreWith(cfg, usage.RegisterNamedPlugin)
}

func newQuotaStoreWith(cfg *config.Config, register func(name string, plugin usage.Plugin)) *quota.Store {
	var opts []quota.Option
	if cfg != nil {
		opts = append(opts, quota.WithRebuildThreshold(cfg.QuotaMonitor.RebuildThreshold()))
	}
	store := quota.NewStore(opts...)
	register(quotaUsagePluginName, quota.NewSink(store))
	return store
}

// newQuotaPoller builds the poller that reads each OAuth account's usage endpoint.
func newQuotaPoller(store *quota.Store, manager *coreauth.Manager, currentConfig func() *config.Config) *quota.Poller {
	pollerCfg := quota.PollerConfig{
		Store:  store,
		Source: quotaCredentials{manager: manager, config: currentConfig},
		Client: newQuotaClients().forProxy,
	}
	if cfg := currentConfig(); cfg != nil {
		pollerCfg.Interval = cfg.QuotaMonitor.PollInterval()
	}
	return quota.NewPoller(pollerCfg)
}

// resetSource returns the quota store as the selector's reset source. It returns an untyped nil
// without a store, because a nil *quota.Store inside the interface would panic on first use.
func (s *Service) resetSource() coreauth.ResetSource {
	if s == nil || s.quotaStore == nil {
		return nil
	}
	return s.quotaStore
}

// startQuotaPoller runs the poller until ctx ends. Call Shutdown's quotaWG.Wait to join it.
func (s *Service) startQuotaPoller(ctx context.Context) {
	if s == nil || s.quotaPoller == nil {
		return
	}
	if cfg := s.currentConfig(); cfg != nil && cfg.QuotaMonitor.Disabled {
		return
	}
	s.quotaWG.Go(func() { s.quotaPoller.Run(ctx) })
}

// quotaCredentials lists the OAuth accounts whose usage endpoints the poller should read.
type quotaCredentials struct {
	manager *coreauth.Manager
	config  func() *config.Config
}

// Credentials implements quota.CredentialSource. API-key and disabled accounts are skipped, and
// only an OAuth access token is ever sent to a usage endpoint.
func (q quotaCredentials) Credentials() []quota.Credential {
	if q.manager == nil {
		return nil
	}
	var globalProxy string
	if q.config != nil {
		if cfg := q.config(); cfg != nil {
			globalProxy = strings.TrimSpace(cfg.ProxyURL)
		}
	}
	auths := q.manager.List()
	creds := make([]quota.Credential, 0, len(auths))
	for _, auth := range auths {
		provider := strings.ToLower(strings.TrimSpace(auth.Provider))
		if auth.Disabled || (provider != "claude" && provider != "codex") || strings.TrimSpace(auth.Attributes["api_key"]) != "" {
			continue
		}
		token := accessTokenFromMetadata(auth.Metadata)
		if token == "" {
			continue
		}
		proxyURL := strings.TrimSpace(auth.ProxyURL)
		if proxyURL == "" {
			proxyURL = globalProxy
		}
		accountID, _ := auth.Metadata["account_id"].(string)
		creds = append(creds, quota.Credential{
			AuthID: auth.ID, Provider: provider, Token: token,
			AccountID: strings.TrimSpace(accountID), ProxyURL: proxyURL,
		})
	}
	return creds
}

// accessTokenFromMetadata returns the OAuth access token of an auth file. Unlike the management
// helper it never falls back to an id_token or API key: those do not belong on a usage endpoint.
func accessTokenFromMetadata(metadata map[string]any) string {
	read := func(m map[string]any) string {
		for _, key := range []string{"access_token", "accessToken"} {
			if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}
	if token := read(metadata); token != "" {
		return token
	}
	if nested, ok := metadata["token"].(map[string]any); ok {
		return read(nested)
	}
	return ""
}

// quotaClients caches one HTTP client per proxy setting, so repeated polls reuse connections
// instead of leaking a fresh transport each time.
type quotaClients struct {
	mu      sync.Mutex
	clients map[string]*http.Client
}

func newQuotaClients() *quotaClients {
	return &quotaClients{clients: make(map[string]*http.Client)}
}

func (c *quotaClients) forProxy(proxyURL string) *http.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	if client, ok := c.clients[proxyURL]; ok {
		return client
	}
	client := buildQuotaClient(proxyURL)
	c.clients[proxyURL] = client
	return client
}

// buildQuotaClient fails closed: an unusable proxy setting makes every request fail instead of
// silently going out directly.
func buildQuotaClient(proxyURL string) *http.Client {
	transport, _, err := proxyutil.BuildHTTPTransport(proxyURL)
	switch {
	case err != nil:
		return &http.Client{Transport: failingTransport{err: fmt.Errorf("invalid proxy for quota poll: %w", err)}}
	case transport != nil:
		return &http.Client{Transport: transport}
	default:
		return &http.Client{}
	}
}

type failingTransport struct{ err error }

func (t failingTransport) RoundTrip(*http.Request) (*http.Response, error) { return nil, t.err }
