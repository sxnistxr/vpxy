import { afterEach, describe, expect, test } from "bun:test";
import {
  api,
  ApiError,
  keyRequired,
  managementKey,
  MGMT,
  mgmt,
  send,
} from "./api";
import { configPath, replaceConfig } from "./management";
import { parseHash, href } from "./router";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  managementKey.set("");
  keyRequired.set(false);
});
function mockFetch(
  fn: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = ((url, init) =>
    fn(String(url), init ?? {})) as typeof fetch;
}

describe("management requests", () => {
  test("keeps keys in headers, encodes query values, and sends v8 scalar bodies directly", async () => {
    managementKey.set("fixture-management-secret");
    const calls: { url: string; init: RequestInit }[] = [];
    mockFetch((url, init) => {
      calls.push({ url, init });
      return Response.json({ status: "ok" });
    });
    await mgmt.get("/credentials/models", { name: "a+b?c.json" });
    await mgmt.put("/config/plugins/enabled", false);
    expect(calls[0]!.url).toBe(
      `${MGMT}/credentials/models?name=a%2Bb%3Fc.json`,
    );
    expect(new Headers(calls[0]!.init.headers).get("X-Management-Key")).toBe(
      "fixture-management-secret",
    );
    expect(calls[0]!.url.includes("secret")).toBe(false);
    expect(calls[1]!.init.body).toBe("false");
  });
  test("sends YAML without JSON stringification", async () => {
    const text = "# Keep this comment\nserver:\n  port: 8317\n";
    mockFetch((_url, init) => {
      expect(init.body).toBe(text);
      expect(new Headers(init.headers).get("Content-Type")).toBe(
        "application/yaml",
      );
      return new Response(null, { status: 204 });
    });
    await send(`${MGMT}/config.yaml`, {
      method: "PUT",
      text,
      headers: { "Content-Type": "application/yaml" },
    });
  });
  test("only management authentication errors request a management key", async () => {
    mockFetch(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
    await expect(api("/v1/models")).rejects.toBeInstanceOf(ApiError);
    expect(keyRequired.get()).toBe(false);
    await expect(mgmt.get("/config")).rejects.toBeInstanceOf(ApiError);
    expect(keyRequired.get()).toBe(true);
  });
  test("preserves actionable API error messages", async () => {
    mockFetch(() =>
      Response.json(
        { error: "invalid_config", message: "TTL must be positive" },
        { status: 422 },
      ),
    );
    await expect(
      mgmt.put("/config/routing/session-affinity-ttl", "-1m"),
    ).rejects.toThrow("invalid_config: TTL must be positive");
  });
});

describe("configuration concurrency", () => {
  test("never writes when the current list differs from the editor baseline", async () => {
    const methods: string[] = [];
    mockFetch((_url, init) => {
      methods.push(init.method || "GET");
      return Response.json(["original", "added elsewhere"]);
    });
    await expect(
      replaceConfig(["access", "api-keys"], ["original"], ["edited"]),
    ).rejects.toThrow("changed on the server");
    expect(methods).toEqual(["GET"]);
  });
  test("replaces only the selected field with its complete intended value", async () => {
    const calls: { url: string; method: string; body?: BodyInit | null }[] = [];
    mockFetch((url, init) => {
      calls.push({ url, method: init.method || "GET", body: init.body });
      return Response.json(
        init.method === "PUT"
          ? { status: "ok" }
          : { interval: "5m", keep: "value" },
      );
    });
    await replaceConfig(
      ["quota-monitor"],
      { interval: "5m", keep: "value" },
      { interval: "10m", keep: "value" },
    );
    expect(calls.map((c) => [c.url, c.method])).toEqual([
      [`${MGMT}/config/quota-monitor`, "GET"],
      [`${MGMT}/config/quota-monitor`, "PUT"],
    ]);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      interval: "10m",
      keep: "value",
    });
  });
  test("rejects paths that URL decoding could reinterpret", () => {
    for (const part of ["", ".", "..", "a/b", "a\\b", "a\u0000b"])
      expect(() => configPath(["plugins", part])).toThrow();
    expect(configPath(["plugins", "example plugin"])).toBe(
      "/config/plugins/example%20plugin",
    );
  });
});

test("hash routing preserves credential identities and rejects unknown pages", () => {
  const url = href("credentials", { name: "a+b?c.json" });
  expect(parseHash(url).params.get("name")).toBe("a+b?c.json");
  expect(parseHash("#/not-a-page").page).toBe("overview");
});
