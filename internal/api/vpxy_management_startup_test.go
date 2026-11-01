package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

func TestVPXYTrustedManagementAvailableWithoutStartupSecret(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "")
	server := newTestServerWithConfig(t, &config.Config{SDKConfig: sdkconfig.SDKConfig{
		TrustedNetworks: config.TrustedNetworksConfig{Enabled: true},
	}})
	if err := os.WriteFile(server.configFilePath, []byte("config-version: 8\ntrusted-networks:\n  enabled: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, path, peer, origin string
		want                     int
	}{
		{"local credentials", "/v8/management/credentials", "127.0.0.1:1234", "", http.StatusOK},
		{"tailnet config", "/v8/management/config", "100.64.0.2:1234", "", http.StatusOK},
		{"untrusted peer", "/v8/management/config", "203.0.113.2:1234", "", http.StatusNotFound},
		{"cross-site page", "/v8/management/config", "127.0.0.1:1234", "https://evil.example", http.StatusNotFound},
		{"legacy unchanged", "/v0/management/config", "127.0.0.1:1234", "", http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://localhost"+tc.path, nil)
			req.RemoteAddr = tc.peer
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			response := httptest.NewRecorder()
			server.engine.ServeHTTP(response, req)
			if response.Code != tc.want {
				t.Fatalf("status=%d, want %d; body=%s", response.Code, tc.want, response.Body.String())
			}
		})
	}
}

func TestVPXYTrustedManagementFollowsConfigReload(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "")
	server := newTestServerWithConfig(t, &config.Config{})
	request := func(want int) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "http://localhost/v8/management/credentials", nil)
		req.RemoteAddr = "127.0.0.1:1234"
		response := httptest.NewRecorder()
		server.engine.ServeHTTP(response, req)
		if response.Code != want {
			t.Fatalf("status=%d, want %d; body=%s", response.Code, want, response.Body.String())
		}
	}
	request(http.StatusNotFound)
	next := *server.cfg
	next.TrustedNetworks.Enabled = true
	server.UpdateClients(&next)
	request(http.StatusOK)
	next.Home.Enabled = true
	server.UpdateClients(&next)
	request(http.StatusNotFound)
	next.Home.Enabled = false
	next.TrustedNetworks.Enabled = false
	server.UpdateClients(&next)
	request(http.StatusNotFound)
}
