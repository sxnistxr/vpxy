# VibeProxy management console

The console is served by VPXY at `/management.html`. The original management center remains
at `/management-center.html`. The static optz export uses hash routes, `/vpxy/api`, and the
existing `/v8/management` API. No deprecated v0 endpoint is used by the console.

| Page | Controls |
| --- | --- |
| Overview | Next account per provider, priority-aware expiration order, quota headroom, sessions, cache share, reset schedule, attention, account filters, refresh |
| Quota | 5h, weekly, and model-scoped windows; banked-reset tracking; per-account refresh; on-demand Antigravity, Kimi, xAI, Devin, Meta, and plugin quota |
| Sessions | Binding samples, idle expiry, affinity policy, per-account input/output and cache counters, large rebuilds, account-change history |
| Credentials | Import/export JSON, search/filter/sort/paginate, selection and batch actions, enable/disable, token refresh, targeted recovery, inference verification, cooldown clearing, field edits, supported models, raw file edits, SIWC binding |
| Sign in | Built-in and plugin OAuth, device codes, status polling, pasted callbacks, targeted recovery, cancellation, SIWC binding, Vertex service-account import |
| Providers | All API-key families, grouped keys and weights, priorities, endpoints, prefixes, outbound proxy, exclusions, model aliases/discovery, shared defaults; complete JSON access to per-key/model options |
| Routing | Expiration-first/round-robin/weighted/fill-first, affinity, idle TTL, rebind policy, parent-session affinity, model prefixes, retries, cooling, credential priorities and weights |
| Models | Live registry, provider definitions, per-credential models, copy IDs, OAuth aliases/forks, exclusions, remote catalog sources |
| Access keys | Create/edit/delete/copy/reveal client keys, cryptographically random generation, server API-key usage counters |
| Config | Section-scoped JSON editing for all supported settings, including request payload rules; full YAML import/export, validation, replacement, and conflict detection |
| Logs | Cursor-based bounded live stream, pause/resume, text/level filters, export/clear, error downloads, request-ID lookup, logging settings |
| Plugins | Installed/store lists, version/source selection, install/update/delete, global and instance enablement, full configuration, OAuth, quota, resource-page links |
| System | Build/version/commit, release check, client setup snippets, authenticated upstream API calls, explicitly consumed usage-queue records |

Complex provider, plugin, and configuration options remain available through scoped JSON
editors. Scoped PUTs replace only that selected setting. Read/compare/write checks reject
changes detected since opening an editor; the server currently exposes no atomic revision
precondition, so simultaneous writes between the comparison and PUT remain possible.

Subscription quota and cache views are real server observations. Other-provider usage checks
run only on demand and retain a whitelist of quota fields. Unknown quota is never represented
as 100% available. Model eligibility and credential priority apply before expiration ordering;
established sessions can continue on another account. With other routing strategies the
Overview shows account activity rather than predicting selection.

## Build and verification

Bun is required by optz. If it is installed but absent from PATH, first run
`export PATH="$HOME/.bun/bin:$PATH"`.

```sh
cd dashboard
bun install
bun run check
bun test
bun run build
bunx playwright install chromium # one-time browser setup
bun run verify
```

`verify` loads the production export with intercepted API fixtures. It never mutates the
running proxy or contacts live provider authorization endpoints. It exercises all 13 routes,
WCAG AA rules with axe, desktop/mobile layout, saves, concurrency rejection, unsaved navigation,
credential confirmation, OAuth start/callback/polling, model policy, logs, other-provider quota,
and memory-only management authentication. Captures go in `.impeccable/review/` and contain
fixture data. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an already-installed Chromium binary.

Rebuild Go after exporting the frontend:

```sh
go build -o vpxy ./cmd/server
./vpxy --config config.yaml
```

Real OAuth completion, provider quota availability, and live inference require credentials.
The isolated browser fixtures verify request contracts and interface behavior, not live
provider authorization. The original focused Go suites cover quota polling, trusted access,
expiration routing, affinity, WebSocket defaults, management access, and config persistence.

## Validation recorded on 2026-11-01

- Frontend type check, 28 unit tests, production export, and isolated browser verification pass.
- Focused Go API, management, config, quota, access, and routing suites pass.
- Full `go test ./...` has one failure: `TestResponsesInterruptStopsHTTPUpstream`
  (`http upstream was not canceled`). The same test fails in the untouched upstream checkout
  independently, confirming it predates this console change.
