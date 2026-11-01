package auth

import (
	"strings"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
)

// applyCodexOAuthWebsocketDefault marks a Codex OAuth credential as websocket-capable when
// codex.oauth-websockets allows it and the credential does not say either way, so downstream
// websocket clients reach the upstream websocket instead of silently falling back to HTTP.
// A credential counts as OAuth when its metadata carries an access or refresh token, which every
// Codex auth file does. API-key credentials, credentials without tokens and other providers are
// left alone. Only the runtime attribute is set; the auth file is never rewritten. A change of
// the config applies to credentials registered or updated afterwards.
func (m *Manager) applyCodexOAuthWebsocketDefault(auth *Auth) {
	if m == nil || auth == nil || !strings.EqualFold(strings.TrimSpace(auth.Provider), "codex") {
		return
	}
	if strings.TrimSpace(auth.Attributes["api_key"]) != "" || !hasOAuthTokens(auth.Metadata) {
		return
	}
	if cfg, _ := m.runtimeConfig.Load().(*internalconfig.Config); cfg != nil && !cfg.Codex.OAuthWebsocketsEnabled() {
		return
	}
	if _, explicit := authWebsocketsSetting(auth); explicit {
		return
	}
	if auth.Attributes == nil {
		auth.Attributes = make(map[string]string)
	}
	auth.Attributes["websockets"] = "true"
}

// hasOAuthTokens reports whether the metadata holds a non-blank access or refresh token.
func hasOAuthTokens(metadata map[string]any) bool {
	for _, key := range []string{"access_token", "refresh_token"} {
		if token, ok := metadata[key].(string); ok && strings.TrimSpace(token) != "" {
			return true
		}
	}
	return false
}
