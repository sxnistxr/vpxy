## VibeProxy v0.1.1

Patch release fixing empty 404 responses from image requests made through the Codex base URL.

### Fixed

- Added `/backend-api/codex/images/generations` and `/backend-api/codex/images/edits`.
  These routes share authentication, image handlers, executor dispatch, and payload rules
  with the existing `/v1` image endpoints.
- Covered generation and edits, streaming and non-streaming responses, JSON and multipart
  edits, authentication, and empty-body probes with regression tests.

### Documentation

- Added [image routing troubleshooting](https://github.com/sxnistxr/vpxy/blob/v0.1.1/docs/IMAGE_GENERATION_TROUBLESHOOTING.md)
  with safe probes, running-build checks, upgrade guidance, and image-disable behavior.
- Added console screenshots and the VibeProxy banner to the README and release archives.

### Upgrading from v0.1.0

Replace the executable, retain your existing config and credential directory, and restart
VPXY. The v0.1.0 release predates the Codex image aliases; updating a checkout or downloading
an archive does not update an already-running process. With image generation enabled and
client access granted, an empty `{}` POST to either Codex image route now returns a local
400 missing-prompt error without calling an upstream provider.

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

Dashboard checks and tests, focused backend suites, and the embedded server build passed CI
on the source changes included in this release. Native release archives are built,
smoke-tested, and verified on each target platform before publication. The full Go suite
still has the documented upstream-reproducible `TestResponsesInterruptStopsHTTPUpstream`
failure. Provider authorization and live inference require your own credentials.

**Full changelog:** https://github.com/sxnistxr/vpxy/compare/v0.1.0...v0.1.1
