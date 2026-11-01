package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCodexDirectModelsAliasServesTheUnifiedCatalog(t *testing.T) {
	server := newTestServer(t)
	get := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer test-key")
		rr := httptest.NewRecorder()
		server.engine.ServeHTTP(rr, req)
		return rr
	}

	want := get("/v1/models?client_version=0.166.0")
	got := get("/backend-api/codex/models?client_version=0.166.0")

	if want.Code != http.StatusOK {
		t.Fatalf("/v1/models status = %d, want 200", want.Code)
	}
	if got.Code != http.StatusOK {
		t.Fatalf("/backend-api/codex/models status = %d, want 200 (a Codex client pointed at this base URL refreshes its catalog here)", got.Code)
	}
	if got.Body.String() != want.Body.String() {
		t.Fatalf("alias body differs from /v1/models:\n alias: %.200s\n v1:    %.200s", got.Body.String(), want.Body.String())
	}
}
