# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One operator: the owner of several Claude and ChatGPT subscription accounts who runs Claude Code
and Codex through this proxy. They keep the console in a browser tab beside their terminals and
check it from a phone over their Tailscale tailnet. Nobody else uses it.

## Product Purpose

VibeProxy (binary and repo name: VPXY) is a personal fork of CLIProxyAPI. It pools the
operator's OAuth subscription accounts behind one local endpoint and spends quota in the order
that wastes the least: the account whose weekly window resets soonest goes first, and a coding
session stays on one account so its prompt cache survives. The console answers "which account is
serving me, how much is left, when does it come back, and is my cache holding", and it carries
every management function of the upstream CLIProxyAPI management center (credentials, sign-in,
providers, routing, config, logs, plugins, system).

## Positioning

Upstream rotates accounts round-robin and treats quota as an error to recover from. VibeProxy
plans quota: expiration-first routing, session affinity tuned for prompt caching, real 5-hour and
weekly windows polled from the Claude and Codex usage endpoints, banked-reset tracking, and
cache read versus cache write counters that expose a broken session binding.

## Operating Context

- Served by the Go binary at `http://localhost:8317/management.html`; the upstream panel stays at
  `/management-center.html`.
- Passwordless from localhost and the tailnet (trusted networks with Host/Origin guards); every
  other network needs the management key.
- Data: `GET /vpxy/api/overview`, `POST /vpxy/api/quota/refresh`, and the `/v8/management` API.
- Glanced at mid-task: the operator wants the answer in a second, then goes back to the terminal.

## Capabilities and Constraints

- Static export (optz, React islands, Tailwind v4) embedded in the Go binary; no server rendering.
- English only.
- Claude banked resets are tracked, never claimed: no control that spends one.
- Accounts are Claude and Codex OAuth credentials; other upstream providers (API keys, Gemini,
  Vertex, xAI, Kimi, plugins) must remain manageable.

## Brand Commitments

- Name in the UI: VibeProxy. VPXY remains the CLI/binary name.
- Logo: the "VP" monogram with a four-point sparkle and an orbit ring, and the italic
  VIBEPROXY wordmark; supplied as black-on-white and white-on-transparent artwork
  (`assets/logo/`).

## Evidence on Hand

- Real data comes from the operator's own accounts; there are no customers, testimonials or
  metrics to show, and none may be invented.

## Product Principles

1. Answer the routing question first: who is serving, what is left, when it resets.
2. Every number is real and timestamped; stale or missing data says so.
3. Destructive actions (delete credential, clear logs, replace config) confirm and name what they
   remove.
4. Parity with upstream management without upstream clutter: every function, fewer steps.
