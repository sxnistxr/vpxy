# Codex image generation returns an empty 404

An error such as `image generation failed: http 404 Not Found: Some("")` does
not identify which server returned the response. Check the local route before
changing models, credentials, image dimensions, or transparency settings.

## Confirmed case: running release predates the Codex image aliases

Observed on 2026-11-05 with the recommended client configuration:

```toml
openai_base_url = "http://localhost:8317/backend-api/codex"
```

The running Windows executable reported version `v0.1.0` and commit
`edbf5cd42bf1a4c6a6c4812816629bc56da84a80` through its management response headers.
Health checks succeeded, but invalid, empty image requests produced:

| Request | Status | Response |
| --- | --- | --- |
| `GET /healthz` | 200 | `{"status":"ok"}` |
| `POST /v1/images/generations` with `{}` | 400 | JSON: `Invalid request: prompt is required` |
| `POST /backend-api/codex/images/generations` with `{}` | 404 | Empty body |
| `POST /backend-api/codex/images/edits` with `{}` | 404 | Empty body |
| `POST /images/generations` with `{}` | 404 | Empty body; this root route is not advertised |

The `/v1` validation error establishes that the image handler exists and image
generation is not globally disabled in that process. The missing Codex-prefixed
routes fall through to `pluginManagementNoRoute`, which returns an empty 404 for
non-management paths. This matches the reported tool error with the configured
Codex base URL. The tool did not expose its request URL, so the individual tool
calls cannot be independently correlated with a server access log.

The routing fix is already in
[`47cd48e`](https://github.com/sxnistxr/vpxy/commit/47cd48eb33792ea121aecd64cf9ae1210cd0084a):
both image POST aliases are registered under `/backend-api/codex`, using the same
authentication middleware and image handlers as `/v1`. The image handlers also
normalize their internal request path for the existing executor dispatch. The
running build above predates that commit; updating a checkout does not replace
an already-running executable.

## Probe without generating an image

Send an empty JSON object, **without a prompt or model**, to exercise route
registration, authentication and local validation only:

```powershell
curl.exe -sS -i -X POST http://localhost:8317/v1/images/generations -H "Content-Type: application/json" --data-binary "{}"
curl.exe -sS -i -X POST http://localhost:8317/backend-api/codex/images/generations -H "Content-Type: application/json" --data-binary "{}"
curl.exe -sS -i -X POST http://localhost:8317/backend-api/codex/images/edits -H "Content-Type: application/json" --data-binary "{}"
```

With image generation enabled and client access granted, all three requests on
a fixed build return 400 with a missing-prompt error. These probes do not need
provider credentials and do not invoke an image model. On a server requiring a
client key, unauthenticated requests return 401 instead; provide your existing
client authorization privately and repeat. Do not disable authentication.

The management API sends `X-CPA-VERSION`, `X-CPA-COMMIT`, and
`X-CPA-BUILD-DATE` headers. Inspect only those headers in an already-authorized
management request to identify the running build. Config responses can contain
secrets: do not attach their bodies or authorization headers to a bug report.

## Interpret the result

| Result | Next check |
| --- | --- |
| `/v1` returns 400; Codex image aliases return 404 | Stale executable or an intermediary that does not route the aliases. Check running build and forwarding rules. |
| Both prefixes return 400 with the missing-prompt message | Local image routes are present. A real request failing later needs separate provider/upstream diagnosis. |
| Both prefixes return 401 | Authenticate the probe; this does not establish whether image validation works. |
| Both prefixes return empty 404 | Check `disable-image-generation: true` as well as routing. The all-disabled mode deliberately returns empty 404. |
| Connection fails, times out, or health check fails | Check listener, port, process and network reachability first. |

`disable-image-generation: "chat"` strips the built-in image tool from chat
requests but leaves the dedicated image endpoints available. `false` enables
both; `true` disables both. Do not confuse input images with image generation.

## Resolve the stale-build case

Use a release or source build containing `47cd48e`, retain the existing config
and credential directory, then restart the intended executable during a suitable
pause. Re-check the **running process**, not just the checkout or downloaded
archive, and repeat the empty-body probes. The published `v0.1.0` build observed
above is not sufficient just because it has the latest-looking version label.

For an independently configurable OpenAI-compatible image client, `/v1` is the
working image base URL on the affected build. This is not a recommendation to
change the entire Codex provider configuration or its WebSocket settings.

## Validation and remaining limits

```sh
go test ./internal/api -run 'TestCodexDirectImagesAliases|TestImagesEndpointEmptyProbe' -count=1
go test ./sdk/api/handlers/openai -run 'TestImages(Generations|Edits).*DisableImageGeneration' -count=1
```

The routing suite covers generation and edits, streaming and non-streaming,
JSON and multipart edits, one application of payload overrides, image output
propagation and rejected unauthenticated requests. Empty-body regression tests
cover `/v1` and Codex aliases with image generation enabled, chat-only disabled
and globally disabled.

Live route probes and mocked upstream tests do not establish successful image
generation, account entitlement or model availability. No provider credentials,
real image payloads, management config bodies or session contents are needed for
this routing diagnosis. A real generation request after upgrading is a separate
end-to-end check.

For the public API distinction, see the
[official OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation):
direct Images API requests and the Responses API's `image_generation` tool are
different request paths. This case concerns missing local HTTP routes, not a
documented OpenAI outage.
