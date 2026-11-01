// Verify the production export against an isolated API fixture; never mutates a running proxy.
// Run: bun run build && bun run verify
import { chromium, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "dist", "static");
const shots = join(import.meta.dir, "..", "..", ".impeccable", "review");
mkdirSync(shots, { recursive: true });
const now = Date.now();
const at = (hours: number) => new Date(now + hours * 3600_000).toISOString();
const cache = (requests: number) => ({
  requests,
  input: requests * 1000,
  output: requests * 500,
  cache_read: requests * 90000,
  cache_write: requests * 3000,
});
const accounts = [
  {
    auth_id: "claude-alpha.json",
    provider: "claude",
    label: "alpha@example.test",
    plan: "Max",
    status: "ready",
    windows: [
      { id: "5h", label: "5 hours", used_percent: 24, resets_at: at(3) },
      { id: "7d", label: "Weekly", used_percent: 62, resets_at: at(22) },
      {
        id: "7d:fable",
        label: "Weekly · Fable",
        used_percent: 41,
        resets_at: at(22),
      },
    ],
    observed_at: at(-0.01),
    banked: { available: 1, total: 2, usable_now: true },
    cache: cache(412),
    sessions: {
      count: 2,
      recent: [{ id: "a1b2c3d4", expires_in_seconds: 810 }],
    },
    rebuilds: [
      {
        at: at(-0.5),
        cache_write: 812000,
        cache_read: 0,
        model: "claude-fable-5",
      },
    ],
  },
  {
    auth_id: "claude-beta.json",
    provider: "claude",
    label: "beta@example.test",
    plan: "Pro",
    status: "limited",
    status_until: at(2),
    windows: [
      { id: "5h", label: "5 hours", used_percent: 100, resets_at: at(2) },
      { id: "7d", label: "Weekly", used_percent: 85, resets_at: at(74) },
    ],
    observed_at: at(-0.01),
    cache: cache(180),
    sessions: { count: 0, recent: [] },
  },
  {
    auth_id: "codex-gamma.json",
    provider: "codex",
    label: "gamma@example.test",
    plan: "Plus",
    status: "ready",
    windows: [
      { id: "5h", label: "5 hours", used_percent: 16, resets_at: at(4) },
      { id: "7d", label: "Weekly", used_percent: 48, resets_at: at(42) },
    ],
    observed_at: at(-0.01),
    cache: cache(230),
    sessions: {
      count: 1,
      recent: [{ id: "f1e2d3c4", expires_in_seconds: 660 }],
    },
  },
];
const overview = {
  generated_at: new Date(now).toISOString(),
  accounts,
  totals: accounts.reduce(
    (sum, a) =>
      Object.fromEntries(Object.keys(sum).map((k) => [k, sum[k] + a.cache[k]])),
    cache(0),
  ),
  routing: {
    strategy: "expiration-first",
    session_affinity: true,
    session_ttl_seconds: 900,
    rebind_on: "quota",
    sessions: 3,
  },
  monitor: {
    polling_enabled: true,
    interval_seconds: 300,
    rebuild_alert_tokens: 100000,
    trusted_networks: true,
  },
  affinity_breaks: [],
};
const config: Record<string, any> = {
  "config-version": 8,
  server: { port: 8317 },
  access: { "api-keys": ["test-client-secret"] },
  routing: {
    strategy: "expiration-first",
    "session-affinity": true,
    "session-affinity-ttl": "15m",
    "session-affinity-rebind-on": "quota",
    retry: { "request-retry": 2 },
  },
  "quota-monitor": { interval: "5m", "rebuild-alert-tokens": 100000 },
  "trusted-networks": { enabled: true },
  "api-keys": {
    claude: [
      {
        name: "Primary Anthropic",
        "base-url": "https://api.anthropic.com",
        keys: [{ "api-key": "test-provider-secret", weight: 1 }],
        headers: { "x-preserved": "keep" },
      },
    ],
  },
  upstream: { claude: { "model-level-cooling": true } },
  oauth: { "model-alias": {}, "excluded-models": {} },
  observability: { logs: { "logging-to-file": true } },
  plugins: {
    enabled: true,
    configs: { example: { enabled: true, custom: "preserve" } },
  },
};
const files = accounts.map((a, i) => ({
  id: a.auth_id,
  name: a.auth_id,
  type: a.provider,
  provider: a.provider,
  email: a.label,
  auth_index: `index-${i}`,
  disabled: false,
  priority: i,
  note: "",
  success: 42,
  failed: 1,
  last_refresh: at(-1),
  ...(i === 1
    ? {
        requires_sign_in: true,
        cooldowns: [
          {
            scope: "model",
            model_key: "claude-fable-5",
            reason: "quota",
            retry_at: at(2),
            remaining_seconds: 7200,
          },
        ],
      }
    : {}),
}));
const calls: {
  path: string;
  method: string;
  body: any;
  query: URLSearchParams;
}[] = [];
files.push({
  id: "meta-fixture.json",
  name: "meta-fixture.json",
  provider: "meta",
  type: "meta",
  email: "meta@example.test",
  auth_index: "index-meta",
  disabled: false,
  priority: 0,
  note: "",
  success: 0,
  failed: 0,
  last_refresh: at(-1),
});
const failures: string[] = [];
let oauthPolls = 0;
let conflict = false;
let requireKey = false;
let yaml = "config-version: 8\nserver:\n  port: 8317\n";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  let body: any;
  try {
    body = request.postDataJSON();
  } catch {
    body = request.postData();
  }
  const reply = (data: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: {
        "X-CPA-VERSION": "test-build",
        "X-CPA-COMMIT": "fixture",
        "X-CPA-SUPPORT-PLUGIN": "1",
      },
      body: JSON.stringify(data),
    });
  if (
    path.startsWith("/vpxy/api") ||
    path.startsWith("/v8/management") ||
    path === "/v1/models"
  ) {
    calls.push({ path, method, body, query: url.searchParams });
    if (
      requireKey &&
      path !== "/v1/models" &&
      request.headers()["x-management-key"] !== "fixture-management-key"
    )
      return reply({ error: "invalid management key" }, 401);
    if (path === "/vpxy/api/overview") return reply(overview);
    if (path === "/vpxy/api/quota/refresh") {
      assert.deepEqual(body, {});
      return reply(overview);
    }
    if (path === "/v1/models")
      return reply({
        data: [
          { id: "claude-fable-5", owned_by: "anthropic" },
          { id: "gpt-5.4", owned_by: "openai" },
        ],
      });
    const p = path.replace("/v8/management", "");
    if (p === "/config.yaml") {
      if (method === "PUT") yaml = request.postData()!;
      return method === "GET"
        ? route.fulfill({ body: yaml, contentType: "application/yaml" })
        : reply({ status: "ok" });
    }
    if (p.startsWith("/config")) {
      const parts = p.split("/").slice(2).map(decodeURIComponent);
      if (conflict && method === "GET" && p === "/config/quota-monitor") {
        config["quota-monitor"].interval = "9m";
        conflict = false;
      }
      if (!parts.length) return reply(config);
      let parent: any = config;
      for (const key of parts.slice(0, -1)) {
        if (parent[key] === undefined) {
          if (method === "GET") return reply({ error: "not_found" }, 404);
          parent[key] = {};
        }
        parent = parent[key];
      }
      const key = parts.at(-1)!;
      if (method === "GET")
        return parent[key] === undefined
          ? reply({ error: "not_found" }, 404)
          : reply(parent[key]);
      if (method === "PUT") {
        parent[key] = body;
        return reply({ status: "ok" });
      }
    }
    if (p === "/credentials") return reply({ files });
    if (p === "/credentials/fields" || p === "/credentials/status") {
      Object.assign(
        files.find((f) => f.name === body.name)!,
        body,
      );
      return reply({ status: "ok" });
    }
    if (
      p === "/credentials/refresh" ||
      p === "/credentials/verify" ||
      p === "/routing/cooldown/reset"
    )
      return reply({ status: "ok" });
    if (
      p === "/credentials/models" ||
      p.startsWith("/routing/model-definitions/")
    )
      return reply({ models: [{ id: "fixture-model", owned_by: "fixture" }] });
    if (p === "/credentials/download")
      return reply(
        url.searchParams.get("name") === "meta-fixture.json"
          ? { type: "meta", dca_token: "dca:fixture-only-secret" }
          : { type: "claude", access_token: "fixture-secret" },
      );
    if (p === "/oauth/auth-url" || p === "/oauth/siwc/bind") {
      oauthPolls = 0;
      return reply({
        url: "https://auth.example.test/authorize",
        state: "fixture-oauth-state",
        user_code: "TEST-1234",
      });
    }
    if (p === "/oauth/status") {
      oauthPolls++;
      return reply({ status: oauthPolls > 1 ? "ok" : "wait" });
    }
    if (p === "/oauth/callback" || p === "/oauth/session")
      return reply({ status: "ok" });
    if (p === "/observability/logs")
      return reply({
        lines: url.searchParams.has("cursor")
          ? []
          : [
              "2026-11-01 [info] proxy connected",
              "2026-11-01 [error] fixture upstream failure",
            ],
        "next-cursor": "cursor-2",
      });
    if (p === "/observability/logs/errors")
      return reply({
        files: [
          {
            name: "fixture-error.log",
            size: 1024,
            modified: Math.floor(now / 1000),
          },
        ],
      });
    if (p.startsWith("/observability/logs/requests/"))
      return route.fulfill({
        body: "fixture request trace",
        contentType: "text/plain",
      });
    if (p === "/observability/usage/api-keys")
      return reply({ claude: { "index-0": { success: 41, failed: 2 } } });
    if (p === "/observability/usage/queue")
      return reply([{ model: "fixture-model", tokens: 20 }]);
    if (p === "/plugins")
      return reply({
        plugins_enabled: true,
        plugins_dir: "plugins",
        plugins: [
          {
            id: "example",
            metadata: { name: "Example provider", version: "1.0" },
            enabled: true,
            registered: true,
            effective_enabled: true,
            supports_quota: true,
          },
        ],
      });
    if (p === "/plugins/store")
      return reply({
        plugins: [
          {
            id: "example",
            name: "Example provider",
            version: "1.1",
            source_id: "fixture-source",
            installed: true,
            update_available: true,
          },
        ],
      });
    if (p.startsWith("/plugins/example/quota")) return reply({ available: 80 });
    if (p === "/server/latest-version")
      return reply({ "latest-version": "fixture-latest" });
    if (p === "/requests/api-call")
      return reply({
        status_code: 200,
        body:
          body.url === "https://api.meta.ai/muse-code/key"
            ? {
                api_key: "must-never-render",
                subs_tier_name: "Pro",
                subs_usage: { window: { used_percent: 25 } },
              }
            : { data: [{ id: "discovered-fixture-model" }] },
      });
    failures.push(`${method} ${path}`);
    return reply({ error: "Unexpected fixture request" }, 500);
  }
  const relative =
    path === "/management.html" || path === "/" ? "index.html" : path.slice(1);
  const file = join(root, relative);
  if (!relative.includes("..") && existsSync(file))
    return route.fulfill({ path: file });
  if (path === "/favicon.ico") return route.fulfill({ status: 204 });
  failures.push(`unexpected asset: ${path}`);
  return route.abort();
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const go = async (id: string, title: string) => {
  await page.goto(`http://vibeproxy.test/management.html#/${id}`);
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
};
const screenshot = async (name: string) => {
  await page
    .getByRole("button", { name: "Dismiss notification", exact: true })
    .evaluateAll((nodes) =>
      nodes.forEach((node) => (node as HTMLButtonElement).click()),
    );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= innerWidth + 1,
  );
  const png = await page.screenshot({
    path: join(shots, name),
    fullPage: true,
  });
  assert.equal(
    png.readUInt32BE(16),
    page.viewportSize()!.width,
    `Invalid screenshot width: ${name}`,
  );
};
const clickTab = async (name: string) =>
  page.getByRole("tab", { name, exact: true }).click();
try {
  await go("overview", "Overview");
  await page
    .getByText("alpha@example.test", { exact: true })
    .waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Refresh usage", exact: true })
    .click();
  await page.getByText("Usage refreshed", { exact: true }).waitFor();
  await screenshot("desktop.png");
  assert(
    !(await page.getByText("test-client-secret", { exact: true }).count()),
  );
  for (const [id, title] of [
    ["quota", "Quota"],
    ["sessions", "Sessions"],
    ["credentials", "Credentials"],
    ["sign-in", "Sign in"],
    ["providers", "Providers"],
    ["routing", "Routing"],
    ["models", "Models"],
    ["access-keys", "Access keys"],
    ["config", "Config"],
    ["logs", "Logs"],
    ["plugins", "Plugins"],
    ["system", "System"],
  ]) {
    await go(id!, title!);
    await page.locator("main section").first().waitFor();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert(!overflow, `Desktop overflow: ${id}`);
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      audit.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
      `Accessibility: ${id}`,
    );
    if (
      [
        "credentials",
        "sign-in",
        "providers",
        "routing",
        "config",
        "logs",
        "plugins",
        "system",
      ].includes(id!)
    )
      await screenshot(`${id}-desktop.png`);
  }
  console.log(
    "PASS: all 13 routes render without overflow and pass axe WCAG AA checks",
  );
  await go("quota", "Quota");
  await page.getByRole("button", { name: "Fetch quota", exact: true }).click();
  await page.getByText("75% left", { exact: true }).waitFor();
  assert(!(await page.getByText("must-never-render", { exact: true }).count()));
  console.log("PASS: other-provider quota fetch discards response secrets");
  await go("providers", "Providers");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByLabel("Group name", { exact: true }).fill("Edited provider");
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  await page.getByText("Provider group saved", { exact: true }).waitFor();
  assert.equal(config["api-keys"].claude[0].name, "Edited provider");
  assert.equal(config["api-keys"].claude[0].headers["x-preserved"], "keep");
  console.log("PASS: provider save preserves unknown and secret fields");
  await go("config", "Config");
  const field = page.getByRole("textbox", {
    name: "quota-monitor",
    exact: true,
  });
  await field.fill('{"interval":"6m","rebuild-alert-tokens":100000}');
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("Changes saved", { exact: true }).waitFor();
  await field.waitFor();
  assert.equal(config["quota-monitor"].interval, "6m");
  await field.fill('{"interval":"7m","rebuild-alert-tokens":100000}');
  conflict = true;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByText("This setting changed on the server. Reload it before saving.", {
      exact: true,
    })
    .first()
    .waitFor();
  assert.equal(config["quota-monitor"].interval, "9m");
  console.log("PASS: configuration rejects a concurrent edit");
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Discard unsaved changes?", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: "Config", exact: true }).waitFor();
  console.log("PASS: in-app navigation protects unsaved configuration");
  await go("routing", "Routing");
  await page.getByLabel("Idle TTL", { exact: true }).fill("20m");
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await page.getByText("Routing settings saved", { exact: true }).waitFor();
  assert.equal(config.routing["session-affinity-ttl"], "20m");
  await page.getByLabel("Idle TTL", { exact: true }).fill("1m");
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await page
    .getByText(
      "Use an idle TTL of at least 10 minutes, for example 15m or 1h.",
      { exact: true },
    )
    .first()
    .waitFor();
  assert.equal(config.routing["session-affinity-ttl"], "20m");
  console.log("PASS: affinity TTL enforces at least 10 minutes");
  await go("access-keys", "Access keys");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await page.getByLabel("Client key", { exact: true }).fill("new-fixture-key");
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  await page.getByText("Client key saved", { exact: true }).waitFor();
  assert.deepEqual(config.access["api-keys"], [
    "test-client-secret",
    "new-fixture-key",
  ]);
  console.log("PASS: access-key addition preserves existing keys");
  await go("credentials", "Credentials");
  await page
    .getByRole("button", { name: "Manage", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Delete credential", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete credential?", exact: true })
    .waitFor();
  assert(
    !calls.some(
      (c) => c.path.endsWith("/credentials") && c.method === "DELETE",
    ),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  console.log("PASS: credential deletion requires confirmation");
  await go("sign-in", "Sign in");
  await page
    .getByRole("button", { name: "Sign in to Claude", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Open sign-in page", exact: true })
    .waitFor();
  await page
    .getByLabel("Full callback URL", { exact: true })
    .fill(
      "http://localhost:54545/callback?code=test&state=fixture-oauth-state",
    );
  await page
    .getByRole("button", { name: "Submit callback", exact: true })
    .click();
  await page.getByText("Account connected", { exact: true }).first().waitFor();
  assert(
    calls.some(
      (c) => c.path.endsWith("/oauth/callback") && c.body.provider === "claude",
    ),
  );
  console.log("PASS: OAuth start, callback, polling, and completion");
  await go("models", "Models");
  await clickTab("OAuth aliases");
  await page.getByRole("button", { name: "Add alias", exact: true }).click();
  await page
    .getByLabel("Upstream model", { exact: true })
    .fill("claude-fable-5");
  await page.getByLabel("Alias", { exact: true }).fill("my-model");
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByText("Model policy saved", { exact: true }).waitFor();
  assert.equal(config.oauth["model-alias"].claude[0].alias, "my-model");
  console.log("PASS: OAuth model-alias save");
  await go("logs", "Logs");
  await page
    .getByText("2026-11-01 [info] proxy connected", { exact: true })
    .waitFor();
  await page.getByLabel("Search", { exact: true }).fill("failure");
  assert.equal(await page.locator("main ol li").count(), 1);
  await clickTab("Request lookup");
  await page.getByLabel("Request ID", { exact: true }).fill("test-request");
  await page.getByRole("button", { name: "Find log", exact: true }).click();
  await page.getByText("fixture request trace", { exact: true }).waitFor();
  console.log("PASS: application filtering and request-log retrieval");
  await go("system", "System");
  await clickTab("Usage queue");
  assert(!calls.some((c) => c.path.endsWith("/observability/usage/queue")));
  console.log("PASS: opening usage tools does not consume queue records");
  await go("overview", "Overview");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await screenshot("desktop-light.png");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("mobile.png");
  for (const [id, title] of [
    ["overview", "Overview"],
    ["credentials", "Credentials"],
    ["providers", "Providers"],
    ["sign-in", "Sign in"],
    ["routing", "Routing"],
    ["config", "Config"],
    ["plugins", "Plugins"],
    ["logs", "Logs"],
  ]) {
    await go(id!, title!);
    assert(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      )),
      `Mobile overflow: ${id}`,
    );
  }
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("link", { name: "Quota", exact: true }).click();
  await page.getByRole("heading", { name: "Quota", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Quick navigation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Search", { exact: true })
    .fill("config");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Config", exact: true })
    .click();
  await page.getByRole("heading", { name: "Config", exact: true }).waitFor();
  console.log("PASS: mobile layout, drawer, and command search");
  await page
    .getByLabel("Configuration section", { exact: true })
    .selectOption("requests/payload");
  await page
    .getByRole("textbox", { name: "requests/payload", exact: true })
    .waitFor();
  assert(
    calls.some((c) => c.path === "/v8/management/config/requests/payload"),
  );
  await page.setViewportSize({ width: 320, height: 720 });
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    )),
    "320px layout overflow",
  );
  console.log(
    "PASS: payload editor uses the canonical v8 path; compact phone layout fits",
  );
  requireKey = true;
  await page.reload();
  const connection = page.getByRole("dialog", {
    name: "Connect to your proxy",
    exact: true,
  });
  await connection.waitFor();
  await connection
    .getByLabel("Management key", { exact: true })
    .fill("wrong-key");
  await connection
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await connection
    .getByText("invalid management key", { exact: true })
    .waitFor();
  await connection
    .getByLabel("Management key", { exact: true })
    .fill("fixture-management-key");
  await connection
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await connection.waitFor({ state: "hidden" });
  assert(
    !(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      )
    ).includes("fixture-management-key"),
  );
  console.log(
    "PASS: management-key rejection, retry, and memory-only authentication",
  );
  assert.deepEqual(errors, [], "Browser runtime errors");
  assert.deepEqual(failures, [], "Unexpected API/asset requests");
  assert(!calls.some((c) => c.path.startsWith("/v0/")));
  console.log(
    `PASS: ${calls.length} fixture API requests; no runtime errors, unexpected requests, or deprecated endpoints`,
  );
} finally {
  await browser.close();
}
