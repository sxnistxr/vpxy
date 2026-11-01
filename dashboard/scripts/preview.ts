// Serves the exported dashboard with fixture data, for design work without real accounts:
//   bun run build && bun scripts/preview.ts   ->  http://127.0.0.1:3002/management.html
import { join } from "node:path";
import type { Account, Overview, QuotaWindow } from "../app/lib/types";

const root = join(import.meta.dir, "..", "dist", "static");
const port = Number(process.env.PORT ?? 3002);
const H = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const win = (id: string, label: string, used: number, resetIn?: number): QuotaWindow => ({
  id,
  label,
  used_percent: used,
  resets_at: resetIn === undefined ? undefined : at(resetIn),
});
const sessions = (n: number) => ({
  count: n,
  recent: Array.from({ length: Math.min(n, 4) }, (_, i) => ({ id: `${(0x3fa2 + i * 977).toString(16)}e1b9…`, expires_in_seconds: 900 - i * 170 })),
});
const cache = (requests: number, read: number, write: number) => ({ requests, input: requests * 900, output: requests * 1400, cache_read: read, cache_write: write });

const accounts: Account[] = [
  {
    auth_id: "claude-alice", provider: "claude", plan: "max", label: "alice@studio.dev", status: "ready",
    windows: [win("5h", "5 hours", 12, 3 * H), win("7d", "Weekly", 64, 26 * H), win("7d:fable", "Weekly · Fable", 41, 26 * H)],
    banked: { available: 1, total: 2, usable_now: true }, cache: cache(412, 61_200_000, 3_900_000), sessions: sessions(3),
    rebuilds: [{ at: at(-0.4 * H), model: "claude-fable-5", cache_write: 812_000, cache_read: 0 }],
  },
  {
    auth_id: "claude-bob", provider: "claude", plan: "max", label: "bob@studio.dev", status: "ready",
    windows: [win("5h", "5 hours", 0), win("7d", "Weekly", 22, 98 * H), win("7d:fable", "Weekly · Fable", 9, 98 * H)],
    cache: cache(96, 14_100_000, 820_000), sessions: sessions(1),
  },
  {
    auth_id: "claude-carol", provider: "claude", plan: "max", label: "carol@outlook.com", status: "limited", status_until: at(2.5 * H),
    windows: [win("5h", "5 hours", 100, 2.5 * H), win("7d", "Weekly", 81, 61 * H), win("7d:fable", "Weekly · Fable", 77, 61 * H)],
    cache: cache(230, 30_500_000, 2_100_000), sessions: sessions(0),
  },
  {
    auth_id: "claude-dan", provider: "claude", plan: "pro", label: "dan@proton.me", status: "ready",
    windows: [], cache: cache(0, 0, 0), sessions: sessions(0), poll_error: "usage endpoint returned status 401",
  },
  {
    auth_id: "codex-erin", provider: "codex", plan: "pro", label: "erin@studio.dev", status: "ready",
    windows: [win("5h", "5 hours", 31, 4 * H), win("7d", "Weekly", 47, 41 * H)],
    cache: cache(188, 22_000_000, 0), sessions: sessions(2),
  },
  {
    auth_id: "codex-finn", provider: "codex", plan: "plus", label: "finn@gmail.com", status: "cooldown", status_until: at(0.1 * H),
    windows: [win("5h", "5 hours", 58, 1.5 * H), win("7d", "Weekly", 90, 150 * H)],
    cache: cache(57, 5_400_000, 0), sessions: sessions(0),
  },
];

const overview = (): Overview => ({
  generated_at: new Date().toISOString(),
  routing: { strategy: "expiration-first", session_affinity: true, session_ttl_seconds: 900, rebind_on: "quota", sessions: 6 },
  monitor: { polling_enabled: true, interval_seconds: 300, rebuild_alert_tokens: 100_000, trusted_networks: true },
  accounts,
  totals: accounts.reduce((t, a) => ({ requests: t.requests + a.cache.requests, input: t.input + a.cache.input, output: t.output + a.cache.output, cache_read: t.cache_read + a.cache.cache_read, cache_write: t.cache_write + a.cache.cache_write }), { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 }),
  affinity_breaks: [{ session_id: "7c1d0e44aa", from: "claude-carol", to: "claude-alice", at: at(-0.4 * H), gap_seconds: 3 }],
});

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/vpxy/api/overview" || pathname === "/vpxy/api/quota/refresh") return Response.json(overview());
    const file = pathname === "/management.html" || pathname === "/" ? "index.html" : pathname.slice(1);
    if (file.includes("..")) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(root, file)));
  },
});
console.log(`preview: http://127.0.0.1:${port}/management.html`);
