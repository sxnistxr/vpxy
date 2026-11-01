package auth

import (
	"context"
	"testing"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
)

func codexOAuthAuth(id string) *Auth {
	return &Auth{ID: id, Provider: "codex", Metadata: map[string]any{"access_token": "tok"}}
}

func websocketsDisabledConfig() *internalconfig.Config {
	disabled := false
	return &internalconfig.Config{Codex: internalconfig.CodexConfig{OAuthWebsockets: &disabled}}
}

func registeredCodexAuth(t *testing.T, m *Manager, auth *Auth) *Auth {
	t.Helper()
	if _, err := m.Register(context.Background(), auth); err != nil {
		t.Fatalf("Register(%s) error = %v", auth.ID, err)
	}
	stored, ok := m.GetByID(auth.ID)
	if !ok {
		t.Fatalf("auth %s missing after Register", auth.ID)
	}
	return stored
}

func TestRegisterEnablesWebsocketsForCodexOAuthByDefault(t *testing.T) {
	stored := registeredCodexAuth(t, NewManager(nil, nil, nil), codexOAuthAuth("codex-a"))
	if !authWebsocketsEnabled(stored) {
		t.Fatalf("websockets not enabled by default, attributes = %v", stored.Attributes)
	}
	if _, onDisk := stored.Metadata["websockets"]; onDisk {
		t.Fatalf("the default must not be written into the credential metadata: %v", stored.Metadata)
	}
}

func TestRegisterLeavesCodexAloneWhenTheConfigDisablesTheDefault(t *testing.T) {
	m := NewManager(nil, nil, nil)
	m.SetConfig(websocketsDisabledConfig())
	stored := registeredCodexAuth(t, m, codexOAuthAuth("codex-a"))
	if authWebsocketsEnabled(stored) || stored.Attributes["websockets"] != "" {
		t.Fatalf("default applied although codex.oauth-websockets is false: %v", stored.Attributes)
	}
}

func TestRegisterKeepsExplicitCodexWebsocketOptOuts(t *testing.T) {
	cases := map[string]*Auth{
		"attribute false":       {ID: "c1", Provider: "codex", Attributes: map[string]string{"websockets": "false"}, Metadata: map[string]any{"access_token": "t"}},
		"metadata false":        {ID: "c2", Provider: "codex", Metadata: map[string]any{"access_token": "t", "websockets": false}},
		"metadata string false": {ID: "c3", Provider: "codex", Metadata: map[string]any{"access_token": "t", "websockets": "false"}},
	}
	for name, auth := range cases {
		stored := registeredCodexAuth(t, NewManager(nil, nil, nil), auth)
		if authWebsocketsEnabled(stored) {
			t.Fatalf("%s: explicit opt-out overridden, attributes = %v metadata = %v", name, stored.Attributes, stored.Metadata)
		}
	}
}

func TestRegisterSkipsAPIKeyAndNonCodexCredentials(t *testing.T) {
	apiKey := &Auth{ID: "codex-key", Provider: "codex", Attributes: map[string]string{"api_key": "sk-test"}}
	claude := &Auth{ID: "claude-a", Provider: "claude", Metadata: map[string]any{"access_token": "t"}}
	for _, auth := range []*Auth{apiKey, claude} {
		stored := registeredCodexAuth(t, NewManager(nil, nil, nil), auth)
		if stored.Attributes["websockets"] != "" {
			t.Fatalf("%s got websockets = %q, want none", auth.ID, stored.Attributes["websockets"])
		}
	}
}

func TestRegisterOnlyDefaultsCodexCredentialsThatCarryOAuthTokens(t *testing.T) {
	cases := []struct {
		name string
		auth *Auth
		want bool
	}{
		{"no metadata at all", &Auth{ID: "c1", Provider: "codex", Status: StatusActive}, false},
		{"unrelated metadata", &Auth{ID: "c2", Provider: "codex", Metadata: map[string]any{"email": "a@example.com"}}, false},
		{"blank access token", &Auth{ID: "c3", Provider: "codex", Metadata: map[string]any{"access_token": "  "}}, false},
		{"access token", &Auth{ID: "c4", Provider: "codex", Metadata: map[string]any{"access_token": "tok"}}, true},
		{"refresh token only", &Auth{ID: "c5", Provider: "codex", Metadata: map[string]any{"refresh_token": "rt"}}, true},
	}
	for _, tc := range cases {
		stored := registeredCodexAuth(t, NewManager(nil, nil, nil), tc.auth)
		if got := authWebsocketsEnabled(stored); got != tc.want {
			t.Fatalf("%s: websockets enabled = %v, want %v (attributes %v)", tc.name, got, tc.want, stored.Attributes)
		}
	}
}

func TestUpdateReappliesTheCodexWebsocketDefault(t *testing.T) {
	m := NewManager(nil, nil, nil)
	m.SetConfig(websocketsDisabledConfig())
	registeredCodexAuth(t, m, codexOAuthAuth("codex-a"))

	m.SetConfig(&internalconfig.Config{})
	// A file reload or token refresh hands the manager a fresh object without the runtime attribute.
	if _, err := m.Update(context.Background(), codexOAuthAuth("codex-a")); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	stored, _ := m.GetByID("codex-a")
	if !authWebsocketsEnabled(stored) {
		t.Fatalf("Update() dropped the default, attributes = %v", stored.Attributes)
	}
}

func TestLoadAppliesTheCodexWebsocketDefault(t *testing.T) {
	store := newMemoryAuthTestStore()
	store.auths["codex-load"] = codexOAuthAuth("codex-load")
	m := NewManager(store, nil, nil)

	if err := m.Load(context.Background()); err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	stored, ok := m.GetByID("codex-load")
	if !ok || !authWebsocketsEnabled(stored) {
		t.Fatalf("loaded auth = %+v, want websockets enabled", stored)
	}
}

func TestAuthWebsocketsSettingDistinguishesUnsetFromExplicit(t *testing.T) {
	cases := []struct {
		name         string
		auth         *Auth
		wantEnabled  bool
		wantExplicit bool
	}{
		{"nil auth", nil, false, false},
		{"nothing set", &Auth{}, false, false},
		{"attribute true", &Auth{Attributes: map[string]string{"websockets": "true"}}, true, true},
		{"attribute garbage falls through", &Auth{Attributes: map[string]string{"websockets": "maybe"}}, false, false},
		{"metadata bool false", &Auth{Metadata: map[string]any{"websockets": false}}, false, true},
		{"metadata string true", &Auth{Metadata: map[string]any{"websockets": " true "}}, true, true},
		{"attribute wins over metadata", &Auth{Attributes: map[string]string{"websockets": "false"}, Metadata: map[string]any{"websockets": true}}, false, true},
	}
	for _, tc := range cases {
		enabled, explicit := authWebsocketsSetting(tc.auth)
		if enabled != tc.wantEnabled || explicit != tc.wantExplicit {
			t.Fatalf("%s: got enabled=%v explicit=%v, want enabled=%v explicit=%v", tc.name, enabled, explicit, tc.wantEnabled, tc.wantExplicit)
		}
	}
}
