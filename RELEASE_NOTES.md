## Unreleased

- Codex-base image routes are available after `47cd48e`. The observed v0.1.0 build
  (`edbf5cd`) lacks `/backend-api/codex/images/generations` and
  `/backend-api/codex/images/edits` and returns empty 404s, although its `/v1`
  image handler is present.
  See [image routing troubleshooting](docs/IMAGE_GENERATION_TROUBLESHOOTING.md)
  for safe probes, running-build checks and the distinction from disabled image generation.

## VibeProxy v0.1.0

First release of VPXY, a personal CLIProxyAPI fork for pooled Claude and Codex subscriptions.

### Included

- Expiration-first routing, priority-aware account selection, rate-limit failover, and sticky sessions.
- Real Claude/Codex quota windows, banked-reset tracking, and per-account prompt-cache diagnostics.
- Codex OAuth WebSocket support and trusted localhost/Tailscale access.
- The embedded, responsive VibeProxy console with 13 management pages, dark/light themes,
  credentials, OAuth, providers, routing, models, access keys, config, logs, plugins, and system tools.

### Downloads

Choose `amd64` for Intel/AMD x64 or `arm64` for ARM devices and Apple Silicon.
Windows archives contain `vpxy.exe`; Linux and macOS archives contain `vpxy`.
The six native builds retain dynamic-library plugin support. Linux builds use Ubuntu 24.04;
macOS executables are not notarized. SHA-256 hashes are in `checksums.txt`.

Each archive includes a localhost starter config, full reference config, README, documentation,
license, and build metadata. Copy `config.example.yaml` to `config.yaml`, start the executable,
and open http://localhost:8317/management.html to add accounts. Go, Bun, and Node are not needed
to run the downloaded binaries. Existing users should retain their config and credential directory.

### Validation and known issue

The dashboard has 28 passing unit tests, browser interaction checks, WCAG AA checks, and
responsive verification. Focused backend suites pass. The full Go suite still has the
upstream-reproducible `TestResponsesInterruptStopsHTTPUpstream` failure. Provider authorization
and live inference require your own credentials.
