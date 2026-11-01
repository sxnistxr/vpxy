package configaccess

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

func newRequestFrom(remoteAddr string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.RemoteAddr = remoteAddr
	req.Host = "localhost:8317"
	return req
}

func trustedOnly(allowedHosts ...string) *sdkconfig.SDKConfig {
	return &sdkconfig.SDKConfig{TrustedNetworks: config.TrustedNetworksConfig{Enabled: true, AllowedHosts: allowedHosts}}
}

func admittedByNetwork(t *testing.T, manager *sdkaccess.Manager, req *http.Request) bool {
	t.Helper()
	res, authErr := manager.Authenticate(context.Background(), req)
	return authErr == nil && res != nil && res.Provider == AccessProviderTypeTrustedNetwork
}

func registeredManager(t *testing.T, cfg *sdkconfig.SDKConfig) *sdkaccess.Manager {
	t.Helper()
	t.Cleanup(func() { Register(nil) })
	Register(cfg)
	manager := sdkaccess.NewManager()
	manager.SetProviders(sdkaccess.RegisteredProviders())
	return manager
}

func TestRemoteAddr(t *testing.T) {
	cases := []struct {
		remote string
		want   string
		ok     bool
	}{
		{"127.0.0.1:5000", "127.0.0.1", true},
		{"[::1]:80", "::1", true},
		{"[::ffff:100.100.1.2]:443", "100.100.1.2", true},
		{"[fe80::1%eth0]:80", "fe80::1", true},
		{"100.64.0.7", "100.64.0.7", true},
		{"", "", false},
		{"not-an-ip:80", "", false},
	}
	for _, tc := range cases {
		addr, ok := RemoteAddr(newRequestFrom(tc.remote))
		if ok != tc.ok {
			t.Fatalf("RemoteAddr(%q) ok = %v, want %v", tc.remote, ok, tc.ok)
		}
		if ok && addr.String() != tc.want {
			t.Fatalf("RemoteAddr(%q) = %s, want %s", tc.remote, addr, tc.want)
		}
	}
}

func TestTrustedNetworkAllowsDefaultsWithoutKeys(t *testing.T) {
	manager := registeredManager(t, &sdkconfig.SDKConfig{
		TrustedNetworks: config.TrustedNetworksConfig{Enabled: true},
	})

	for _, remote := range []string{"127.0.0.1:1", "[::1]:1", "100.101.102.103:1", "[fd7a:115c:a1e0::5]:1"} {
		res, authErr := manager.Authenticate(context.Background(), newRequestFrom(remote))
		if authErr != nil {
			t.Fatalf("remote %s: unexpected error %v", remote, authErr)
		}
		if res == nil || res.Provider != AccessProviderTypeTrustedNetwork {
			t.Fatalf("remote %s: result = %+v, want trusted-network", remote, res)
		}
	}

	// Without api-keys an untrusted peer must be rejected, not let through.
	_, authErr := manager.Authenticate(context.Background(), newRequestFrom("203.0.113.9:1"))
	if !sdkaccess.IsAuthErrorCode(authErr, sdkaccess.AuthErrorCodeNoCredentials) {
		t.Fatalf("untrusted peer error = %v, want no_credentials", authErr)
	}
}

func TestTrustedNetworkIgnoresUnknownClientKey(t *testing.T) {
	manager := registeredManager(t, &sdkconfig.SDKConfig{
		APIKeys:         []string{"proxy-key"},
		TrustedNetworks: config.TrustedNetworksConfig{Enabled: true},
	})

	// A local client sending its own OAuth token must not fail on a key the proxy does not know.
	req := newRequestFrom("127.0.0.1:1")
	req.Header.Set("Authorization", "Bearer client-oauth-token")
	res, authErr := manager.Authenticate(context.Background(), req)
	if authErr != nil || res == nil || res.Provider != AccessProviderTypeTrustedNetwork {
		t.Fatalf("trusted peer with unknown key: res=%+v err=%v", res, authErr)
	}

	remote := newRequestFrom("203.0.113.9:1")
	remote.Header.Set("Authorization", "Bearer client-oauth-token")
	if _, authErr = manager.Authenticate(context.Background(), remote); !sdkaccess.IsAuthErrorCode(authErr, sdkaccess.AuthErrorCodeInvalidCredential) {
		t.Fatalf("untrusted peer with unknown key error = %v, want invalid_credential", authErr)
	}

	remote.Header.Set("Authorization", "Bearer proxy-key")
	if res, authErr = manager.Authenticate(context.Background(), remote); authErr != nil || res == nil || res.Provider == AccessProviderTypeTrustedNetwork {
		t.Fatalf("untrusted peer with proxy key: res=%+v err=%v", res, authErr)
	}
}

func TestTrustedNetworkIgnoresForwardingHeaders(t *testing.T) {
	manager := registeredManager(t, &sdkconfig.SDKConfig{
		APIKeys:         []string{"proxy-key"},
		TrustedNetworks: config.TrustedNetworksConfig{Enabled: true},
	})
	req := newRequestFrom("203.0.113.9:1")
	req.Header.Set("X-Forwarded-For", "127.0.0.1")
	req.Header.Set("X-Real-IP", "127.0.0.1")
	if res, authErr := manager.Authenticate(context.Background(), req); authErr == nil {
		t.Fatalf("spoofed forwarding headers admitted: %+v", res)
	}
}

// A page on evil.example can re-point its DNS name at 127.0.0.1 and call a local service with
// Host: evil.example from a loopback peer, so the peer address alone must not admit a browser.
func TestTrustedNetworkRejectsHostsThatAreNotThisMachine(t *testing.T) {
	manager := registeredManager(t, trustedOnly())
	for _, host := range []string{
		"localhost:8317", "LOCALHOST", "localhost.:8317", "127.0.0.1:8317", "[::1]:8317", "100.101.102.103:8317",
		"myhost:8317", "box.tail1234.ts.net:8317", "mac.local:8317", "app.localhost:8317",
	} {
		req := newRequestFrom("127.0.0.1:1")
		req.Host = host
		if !admittedByNetwork(t, manager, req) {
			t.Fatalf("Host %q was not admitted", host)
		}
	}
	for _, host := range []string{
		"evil.com:8317", "127.0.0.1.evil.com:8317", "localhost.evil.com", "ts.net.evil.com",
		"box.ts.net.attacker.io", "evil.local.example.com", "",
	} {
		req := newRequestFrom("127.0.0.1:1")
		req.Host = host
		if admittedByNetwork(t, manager, req) {
			t.Fatalf("Host %q was admitted; a rebinding page could reach the proxy", host)
		}
	}
}

func TestTrustedNetworkRejectsCrossSiteBrowserRequests(t *testing.T) {
	manager := registeredManager(t, trustedOnly())
	cases := map[string]bool{
		"":                      true, // CLIs and curl send no Origin
		"http://localhost:8317": true, // the dashboard calling its own server
		"https://evil.com":      false,
		"null":                  false, // sandboxed iframes and file:// pages
		"http://localhost:9999": false, // another local app
		"http://127.0.0.1:8317": false, // same port, different origin
	}
	for origin, want := range cases {
		req := newRequestFrom("127.0.0.1:1")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if got := admittedByNetwork(t, manager, req); got != want {
			t.Fatalf("Origin %q admitted = %v, want %v", origin, got, want)
		}
	}
}

// A no-cors GET (an <img>, <script> or link from another site) carries no Origin, but every
// current browser labels it with Sec-Fetch-Site.
func TestTrustedNetworkRejectsCrossSiteFetchMetadata(t *testing.T) {
	manager := registeredManager(t, trustedOnly())
	cases := map[string]bool{
		"":            true, // CLIs and older browsers send none
		"same-origin": true, // the dashboard calling its own server
		"none":        true, // a URL typed into the address bar
		"same-site":   false,
		"cross-site":  false,
		"Cross-Site":  false,
	}
	for site, want := range cases {
		req := newRequestFrom("127.0.0.1:1")
		if site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
		if got := admittedByNetwork(t, manager, req); got != want {
			t.Fatalf("Sec-Fetch-Site %q admitted = %v, want %v", site, got, want)
		}
	}
}

func TestTrustedNetworkCrossSiteRequestsStillAcceptAnAPIKey(t *testing.T) {
	manager := registeredManager(t, &sdkconfig.SDKConfig{
		APIKeys:         []string{"proxy-key"},
		TrustedNetworks: config.TrustedNetworksConfig{Enabled: true},
	})
	req := newRequestFrom("127.0.0.1:1")
	req.Header.Set("Origin", "https://evil.com")
	if _, authErr := manager.Authenticate(context.Background(), req); authErr == nil {
		t.Fatal("a cross-site request without a key was admitted")
	}
	req.Header.Set("Authorization", "Bearer proxy-key")
	res, authErr := manager.Authenticate(context.Background(), req)
	if authErr != nil || res == nil || res.Provider == AccessProviderTypeTrustedNetwork {
		t.Fatalf("a keyed cross-site request must authenticate by key: res=%+v err=%v", res, authErr)
	}
}

func TestTrustedNetworkAllowedHosts(t *testing.T) {
	manager := registeredManager(t, trustedOnly("vpxy.example.net", "*.corp.example"))
	for host, want := range map[string]bool{
		"vpxy.example.net:8317": true, "VPXY.Example.Net": true, "a.corp.example": true, "a.b.corp.example:1": true,
		"example.net": false, "corp.example": false, "evilcorp.example": false, "vpxy.example.net.evil.com": false,
	} {
		req := newRequestFrom("127.0.0.1:1")
		req.Host = host
		if got := admittedByNetwork(t, manager, req); got != want {
			t.Fatalf("Host %q admitted = %v, want %v", host, got, want)
		}
	}
}

func TestTrustedRequestAppliesTheSameHostAndOriginRules(t *testing.T) {
	cfg := trustedOnly()
	if !TrustedRequest(cfg, newRequestFrom("127.0.0.1:1")) {
		t.Fatal("a plain local request was not trusted")
	}
	rebound := newRequestFrom("127.0.0.1:1")
	rebound.Host = "evil.com:8317"
	crossSite := newRequestFrom("127.0.0.1:1")
	crossSite.Header.Set("Origin", "https://evil.com")
	if TrustedRequest(cfg, rebound) || TrustedRequest(cfg, crossSite) {
		t.Fatal("TrustedRequest trusted a rebound host or a cross-site origin")
	}
}

func TestTrustedNetworkProviderRemoval(t *testing.T) {
	cases := map[string]*sdkconfig.SDKConfig{
		"disabled": {TrustedNetworks: config.TrustedNetworksConfig{Enabled: false}},
		"invalid":  {TrustedNetworks: config.TrustedNetworksConfig{Enabled: true, CIDRs: []string{"127.0.0.0/8", "bogus"}}},
		"nil":      nil,
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			t.Cleanup(func() { Register(nil) })
			Register(&sdkconfig.SDKConfig{TrustedNetworks: config.TrustedNetworksConfig{Enabled: true}})
			Register(cfg)
			for _, provider := range sdkaccess.RegisteredProviders() {
				if provider.Identifier() == AccessProviderTypeTrustedNetwork {
					t.Fatalf("trusted-network provider still registered")
				}
			}
		})
	}
}

func TestTrustedRequestCustomCIDRs(t *testing.T) {
	cfg := &sdkconfig.SDKConfig{
		TrustedNetworks: config.TrustedNetworksConfig{Enabled: true, CIDRs: []string{"10.1.0.0/16", "192.0.2.4"}},
	}
	cases := map[string]bool{
		"10.1.200.3:1":      true,
		"192.0.2.4:1":       true,
		"192.0.2.5:1":       false,
		"127.0.0.1:1":       false,
		"100.100.100.100:1": false,
	}
	for remote, want := range cases {
		if got := TrustedRequest(cfg, newRequestFrom(remote)); got != want {
			t.Fatalf("TrustedRequest(%s) = %v, want %v", remote, got, want)
		}
	}
	cfg.TrustedNetworks.Enabled = false
	if TrustedRequest(cfg, newRequestFrom("10.1.0.1:1")) {
		t.Fatalf("TrustedRequest admitted a peer while disabled")
	}
}
