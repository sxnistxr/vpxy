package api

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/tidwall/gjson"
)

func TestCodexDirectImagesAliases(t *testing.T) {
	for _, endpoint := range []string{"generations", "edits"} {
		for _, stream := range []bool{false, true} {
			for _, form := range []bool{false, true} {
				if endpoint == "generations" && form {
					continue
				}
				t.Run(fmt.Sprintf("%s/stream=%t/multipart=%t", endpoint, stream, form), func(t *testing.T) {
					server := newTestServer(t)
					server.getConfig().Payload.Override = []config.PayloadRule{{
						Models: []config.PayloadModelRule{{Name: "gpt-image-2"}},
						Params: map[string]any{"audit.-1": "once", "prompt": "Configured prompt"},
					}}
					server.handlers.AuthManager.RegisterExecutor(executor.NewCodexAutoExecutor(server.getConfig()))
					var calls atomic.Int32
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
						calls.Add(1)
						if got, want := req.URL.Path, "/images/"+endpoint; got != want {
							t.Errorf("upstream path = %q, want %q", got, want)
						}
						body, err := io.ReadAll(req.Body)
						if err != nil {
							t.Error(err)
							return
						}
						if got := gjson.GetBytes(body, "prompt").String(); got != "Configured prompt" {
							t.Errorf("configured prompt = %q", got)
						}
						if got := gjson.GetBytes(body, "audit.#").Int(); got != 1 {
							t.Errorf("payload rules applied %d times, want 1", got)
						}
						if got := gjson.GetBytes(body, "model").String(); got != "gpt-image-2" {
							t.Errorf("model = %q", got)
						}
						if got := gjson.GetBytes(body, "stream").Bool(); got != stream {
							t.Errorf("stream = %t, want %t", got, stream)
						}
						if endpoint == "edits" && gjson.GetBytes(body, "images.0.image_url").String() == "" {
							t.Errorf("edit lost image: %s", body)
						}
						contentType, result := "application/json", `{"created":1,"data":[{"b64_json":"aW1hZ2U="}]}`
						if stream {
							contentType, result = "text/event-stream", "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"aW1hZ2U=\"}\n\n"
						}
						w.Header().Set("Content-Type", contentType)
						if _, err := io.WriteString(w, result); err != nil {
							t.Error(err)
						}
					}))
					t.Cleanup(upstream.Close)
					credential := &auth.Auth{ID: "codex-image-alias", Provider: "codex", Status: auth.StatusActive, Attributes: map[string]string{"api_key": "test-token", "base_url": upstream.URL}}
					registry.GetGlobalRegistry().RegisterClient(credential.ID, "codex", []*registry.ModelInfo{{ID: "gpt-image-2"}})
					t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(credential.ID) })
					if _, err := server.handlers.AuthManager.Register(t.Context(), credential); err != nil {
						t.Fatal(err)
					}
					body := []byte(fmt.Sprintf(`{"model":"gpt-image-2","prompt":"A blue circle","stream":%t,"images":[{"image_url":"data:image/png;base64,aW1hZ2U="}]}`, stream))
					contentType := "application/json"
					if form {
						var buf bytes.Buffer
						writer := multipart.NewWriter(&buf)
						for key, value := range map[string]string{"model": "gpt-image-2", "prompt": "A blue circle", "stream": fmt.Sprint(stream)} {
							if err := writer.WriteField(key, value); err != nil {
								t.Fatal(err)
							}
						}
						file, err := writer.CreateFormFile("image", "image.png")
						if err != nil {
							t.Fatal(err)
						}
						if _, err = file.Write([]byte("image")); err != nil {
							t.Fatal(err)
						}
						if err := writer.Close(); err != nil {
							t.Fatal(err)
						}
						body, contentType = buf.Bytes(), writer.FormDataContentType()
					}
					req := httptest.NewRequest(http.MethodPost, "/backend-api/codex/images/"+endpoint, bytes.NewReader(body))
					req.Header.Set("Content-Type", contentType)
					req.Header.Set("Authorization", "Bearer test-key")
					rr := httptest.NewRecorder()
					server.engine.ServeHTTP(rr, req)
					if rr.Code != http.StatusOK {
						t.Fatalf("status = %d; body=%s", rr.Code, rr.Body.String())
					}
					if calls.Load() != 1 {
						t.Errorf("upstream calls = %d, want 1", calls.Load())
					}
					if !strings.Contains(rr.Body.String(), "aW1hZ2U=") {
						t.Errorf("missing image output: %s", rr.Body.String())
					}
				})
			}
		}
	}
}

func TestCodexDirectImagesAliasesRequireAuth(t *testing.T) {
	server := newTestServer(t)
	for _, endpoint := range []string{"generations", "edits"} {
		req := httptest.NewRequest(http.MethodPost, "/backend-api/codex/images/"+endpoint, strings.NewReader(`{}`))
		rr := httptest.NewRecorder()
		server.engine.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("%s status = %d, want 401", endpoint, rr.Code)
		}
	}
}

// Empty probes must stop at local validation, before model/account selection.
// This distinguishes stale/missing aliases from intentional image disabling
// without sending a real image request to an upstream provider.
func TestImagesEndpointEmptyProbe(t *testing.T) {
	for _, prefix := range []string{"/v1", "/backend-api/codex"} {
		for _, endpoint := range []string{"generations", "edits"} {
			for _, mode := range []config.DisableImageGenerationMode{
				config.DisableImageGenerationOff,
				config.DisableImageGenerationChat,
				config.DisableImageGenerationAll,
			} {
				path := prefix + "/images/" + endpoint
				t.Run(fmt.Sprintf("%s/disabled=%s", path, mode), func(t *testing.T) {
					cfg := &config.Config{}
					cfg.APIKeys = []string{"test-key"}
					cfg.DisableImageGeneration = mode
					server := newTestServerWithConfig(t, cfg)
					req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Authorization", "Bearer test-key")
					rr := httptest.NewRecorder()
					server.engine.ServeHTTP(rr, req)
					if mode == config.DisableImageGenerationAll {
						if rr.Code != http.StatusNotFound || rr.Body.Len() != 0 {
							t.Fatalf("disabled endpoint = %d %q; want empty 404", rr.Code, rr.Body.String())
						}
						return
					}
					if rr.Code != http.StatusBadRequest {
						t.Fatalf("empty probe = %d %s; want local validation 400", rr.Code, rr.Body.String())
					}
					if got := gjson.GetBytes(rr.Body.Bytes(), "error.message").String(); got != "Invalid request: prompt is required" {
						t.Fatalf("empty probe error = %q; want missing-prompt validation", got)
					}
				})
			}
		}
	}
}
