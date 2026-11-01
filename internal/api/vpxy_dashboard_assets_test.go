package api

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/vpxydash"
)

func serveVPXYPath(server *Server, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rr := httptest.NewRecorder()
	server.engine.ServeHTTP(rr, req)
	return rr
}

// withUpstreamPanel points the upstream management center at a local file, so no test downloads it.
func withUpstreamPanel(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("MANAGEMENT_STATIC_PATH", dir)
	if err := os.WriteFile(filepath.Join(dir, "management.html"), []byte("<html>upstream center</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestVPXYDashboardServesTheEmbeddedApp(t *testing.T) {
	withUpstreamPanel(t)
	server := newTestServer(t)

	rr := serveVPXYPath(server, "/management.html")
	if rr.Code != http.StatusOK || !strings.HasPrefix(rr.Header().Get("Content-Type"), "text/html") || rr.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("status = %d type = %q cache = %q", rr.Code, rr.Header().Get("Content-Type"), rr.Header().Get("Cache-Control"))
	}
	if strings.Contains(rr.Body.String(), "upstream center") {
		t.Fatal("/management.html still serves the upstream management center")
	}

	// Every asset the page links to must be served from the binary.
	linked := regexp.MustCompile(`/assets/[A-Za-z0-9._-]+`).FindAllString(rr.Body.String(), -1)
	if len(linked) == 0 {
		t.Fatalf("the dashboard page links no assets: %s", rr.Body.String())
	}
	for _, path := range linked {
		asset := serveVPXYPath(server, path)
		if asset.Code != http.StatusOK || asset.Body.Len() == 0 || asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Fatalf("%s: status = %d len = %d cache = %q", path, asset.Code, asset.Body.Len(), asset.Header().Get("Cache-Control"))
		}
	}
}

func TestVPXYDashboardAssetsRefuseUnknownAndEscapingPaths(t *testing.T) {
	server := newTestServer(t)
	for _, path := range []string{"/assets/", "/assets/missing.js", "/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/nested/file.js"} {
		if rr := serveVPXYPath(server, path); rr.Code == http.StatusOK {
			t.Fatalf("%s: status 200, body %.80s", path, rr.Body.String())
		}
	}
}

func TestVPXYDashboardMovesTheUpstreamCenter(t *testing.T) {
	withUpstreamPanel(t)
	server := newTestServer(t)

	for _, path := range []string{"/management-center.html", "/management.html?safe-mode=configure"} {
		if rr := serveVPXYPath(server, path); rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "upstream center") {
			t.Fatalf("%s: status = %d body = %.80s, want the upstream management center", path, rr.Code, rr.Body.String())
		}
	}
}

func TestVPXYDashboardIsHiddenInHomeMode(t *testing.T) {
	server := newTestServer(t)
	server.cfg.Home.Enabled = true
	if rr := serveVPXYPath(server, "/management.html"); rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 while CLIProxyAPIHome manages this instance", rr.Code)
	}
}

func TestVPXYDashboardEmbedHasNoPrecompressedCopies(t *testing.T) {
	err := fs.WalkDir(vpxydash.FS(), ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasSuffix(path, ".gz") || strings.HasSuffix(path, ".br") {
			t.Errorf("%s is embedded; the build should skip precompressed copies", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
