package api

import (
	"net/http"
	"os"
	"strings"
	"testing"

	proxyconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

// newVPXYLocalOnlyServer mirrors config.yaml: trusted networks on, allow-remote off, and the key
// in MANAGEMENT_PASSWORD (which upstream lets remote peers present).
func newVPXYLocalOnlyServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("MANAGEMENT_PASSWORD", "test-management-key")
	cfg := &proxyconfig.Config{SDKConfig: sdkconfig.SDKConfig{TrustedNetworks: proxyconfig.TrustedNetworksConfig{Enabled: true}}}
	server := newTestServerWithConfig(t, cfg)
	if err := os.WriteFile(server.configFilePath, []byte("config-version: 8\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return server
}

func TestVPXYManagementV8AccessControl(t *testing.T) {
	server := newVPXYLocalOnlyServer(t)
	withKey := func(r *http.Request) { r.Header.Set("Authorization", "Bearer test-management-key") }
	header := func(name, value string) func(*http.Request) {
		return func(r *http.Request) { r.Header.Set(name, value) }
	}
	cases := []struct {
		name   string
		remote string
		mutate func(*http.Request)
		want   int
	}{
		{"local peer needs no key", "127.0.0.1:5000", nil, http.StatusOK},
		{"tailnet peer needs no key", "100.101.102.103:5000", nil, http.StatusOK},
		{"the dashboard calling its own server", "127.0.0.1:5000", func(r *http.Request) {
			r.Header.Set("Origin", "http://localhost:8317")
			r.Header.Set("Sec-Fetch-Site", "same-origin")
		}, http.StatusOK},
		{"untrusted peer without a key", "203.0.113.5:5000", nil, http.StatusUnauthorized},
		{"untrusted peer with the key", "203.0.113.5:5000", withKey, http.StatusOK},
		{"cross-site page on a local peer", "127.0.0.1:5000", header("Origin", "https://evil.example"), http.StatusUnauthorized},
		{"cross-site no-cors request on a local peer", "127.0.0.1:5000", header("Sec-Fetch-Site", "cross-site"), http.StatusUnauthorized},
		{"another local site on a local peer", "127.0.0.1:5000", header("Sec-Fetch-Site", "same-site"), http.StatusUnauthorized},
		{"rebound host on a local peer", "127.0.0.1:5000", func(r *http.Request) { r.Host = "evil.example:8317" }, http.StatusUnauthorized},
		{"cross-site page that has the key", "127.0.0.1:5000", func(r *http.Request) {
			r.Header.Set("Origin", "https://evil.example")
			withKey(r)
		}, http.StatusOK},
	}
	for _, tc := range cases {
		rr := vpxyRequest(server, http.MethodGet, "/v8/management/config", tc.remote, "", tc.mutate)
		if rr.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d (body %s)", tc.name, rr.Code, tc.want, rr.Body.String())
		}
		if rr.Code != http.StatusOK && strings.Contains(rr.Body.String(), "routing") {
			t.Fatalf("%s: a refused request still received the config", tc.name)
		}
	}
}

func TestVPXYManagementV8TrustedResponsesCarryVersionHeaders(t *testing.T) {
	server := newVPXYLocalOnlyServer(t)
	rr := vpxyRequest(server, http.MethodGet, "/v8/management/config", "127.0.0.1:5000", "", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rr.Code, rr.Body.String())
	}
	for _, name := range []string{"X-CPA-VERSION", "X-CPA-SUPPORT-PLUGIN"} {
		if _, ok := rr.Header()[http.CanonicalHeaderKey(name)]; !ok {
			t.Fatalf("trusted response is missing %s; headers %v", name, rr.Header())
		}
	}
}

func TestVPXYManagementV8TrustedAccessFollowsTheConfig(t *testing.T) {
	server := newVPXYLocalOnlyServer(t)
	cfg := *server.getConfig()
	cfg.TrustedNetworks.Enabled = false
	server.UpdateClients(&cfg)
	rr := vpxyRequest(server, http.MethodGet, "/v8/management/config", "127.0.0.1:5000", "", nil)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("with trusted networks off a keyless local request got %d, want 401", rr.Code)
	}
}

// The deprecated v0 API keeps upstream behaviour: a key is always required.
func TestVPXYManagementV0StillRequiresTheKey(t *testing.T) {
	server := newVPXYLocalOnlyServer(t)
	rr := vpxyRequest(server, http.MethodGet, "/v0/management/config", "127.0.0.1:5000", "", nil)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("v0 keyless local request got %d, want 401", rr.Code)
	}
}
