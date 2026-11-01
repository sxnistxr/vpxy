import { apiText, MGMT, mgmt } from "./api";
import { record } from "./management";
import type { Credential } from "./mgmt-types";

export type QuotaReading = {
  label: string;
  remaining?: number;
  resetsAt?: string;
  detail?: string;
};
export type ProviderQuota = {
  observedAt: string;
  readings: QuotaReading[];
  plan?: string;
};
const obj = (value: unknown): Record<string, any> =>
  record(value) ? value : {};
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" &&
        value.trim() &&
        Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
const percent = (value: unknown) => {
  const n = num(value);
  return n === undefined ? undefined : Math.max(0, Math.min(100, n));
};
const instant = (value: unknown) => {
  const ms =
    typeof value === "number"
      ? value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
};

/** Store only quota fields; provider responses can contain keys and account profiles. */
export function readProviderQuota(
  provider: string,
  payload: unknown,
): ProviderQuota {
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new Error("The usage endpoint returned invalid JSON.");
    }
  }
  if (!record(payload))
    throw new Error("The usage endpoint returned no quota object.");
  const root = obj(payload);
  const readings: QuotaReading[] = [];
  let plan: string | undefined;
  if (provider === "meta") {
    const usage = obj(root.subs_usage);
    plan =
      typeof root.subs_tier_name === "string"
        ? root.subs_tier_name
        : typeof usage.tier === "string"
          ? usage.tier
          : undefined;
    for (const [id, label] of [
      ["window", "Current window"],
      ["weekly", "Weekly"],
    ]) {
      const w = obj(usage[id!]);
      const used = percent(w.used_percent);
      readings.push({
        label: label!,
        remaining: used === undefined ? undefined : 100 - used,
        resetsAt: instant(w.resets_at),
      });
    }
  } else if (provider === "devin") {
    const status = obj(obj(root.userStatus).planStatus);
    plan =
      typeof obj(status.planInfo).planName === "string"
        ? status.planInfo.planName
        : undefined;
    for (const id of ["daily", "weekly"])
      readings.push({
        label: id === "daily" ? "Daily" : "Weekly",
        remaining: percent(status[`${id}QuotaRemainingPercent`]),
        resetsAt: instant(num(status[`${id}QuotaResetAtUnix`])),
      });
  } else if (provider === "kimi" || provider === "kimi-ai") {
    const limits = Array.isArray(root.limits) ? root.limits : [];
    const entries = [
      ...limits,
      ...(record(root.usage) ? [{ ...root.usage, name: "Weekly" }] : []),
    ];
    for (const [i, item] of entries.entries()) {
      const raw = obj(item);
      const w = record(raw.detail) ? raw.detail : raw;
      const limit = num(w.limit);
      const used = num(w.used);
      const remaining =
        num(w.remaining) ??
        (limit !== undefined && used !== undefined ? limit - used : undefined);
      readings.push({
        label: String(raw.name || raw.title || w.name || `Window ${i + 1}`),
        remaining:
          limit && remaining !== undefined
            ? percent((remaining / limit) * 100)
            : undefined,
        resetsAt: instant(
          w.resetAt || w.reset_at || w.resetTime || w.reset_time,
        ),
        detail:
          limit !== undefined && remaining !== undefined
            ? `${remaining} of ${limit} remaining`
            : undefined,
      });
    }
    const monthly = obj(obj(root.usages).limit_month_total);
    const ratio = num(monthly.used_ratio);
    if (ratio !== undefined)
      readings.push({
        label: "Monthly",
        remaining: percent((1 - ratio) * 100),
        resetsAt: instant(monthly.reset_time),
      });
  } else if (provider === "xai") {
    const config = obj(root.config);
    const credit = num(
      config.creditUsagePercent ?? config.credit_usage_percent,
    );
    if (credit !== undefined)
      readings.push({
        label: "Weekly credits",
        remaining: percent(100 - credit),
        resetsAt: instant(
          obj(config.currentPeriod || config.current_period).end,
        ),
      });
    const cents = (value: unknown) => num(record(value) ? value.val : value);
    const limit = cents(config.monthlyLimit ?? config.monthly_limit);
    const used = cents(config.used);
    if (limit !== undefined && used !== undefined)
      readings.push({
        label: "Monthly allowance",
        remaining: limit > 0 ? percent(100 - (used / limit) * 100) : undefined,
        detail: `$${(used / 100).toFixed(2)} of $${(limit / 100).toFixed(2)} used`,
        resetsAt: instant(config.billingPeriodEnd || config.billing_period_end),
      });
    const cap = cents(config.onDemandCap ?? config.on_demand_cap);
    const extraUsed =
      cents(config.onDemandUsed ?? config.on_demand_used) ??
      (used !== undefined && limit !== undefined
        ? Math.max(0, used - limit)
        : undefined);
    if (cap !== undefined && extraUsed !== undefined)
      readings.push({
        label: "On-demand allowance",
        remaining: cap > 0 ? percent(100 - (extraUsed / cap) * 100) : undefined,
        detail: `$${(extraUsed / 100).toFixed(2)} of $${(cap / 100).toFixed(2)} used`,
      });
    const balance = cents(config.prepaidBalance ?? config.prepaid_balance);
    if (balance !== undefined)
      readings.push({
        label: "Prepaid balance",
        detail: `$${(balance / 100).toFixed(2)}`,
      });
  } else {
    for (const group of Array.isArray(root.groups) ? root.groups : [])
      for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
        const fraction = num(
          bucket.remainingFraction ?? bucket.remaining_fraction,
        );
        readings.push({
          label:
            [
              group.displayName || group.display_name,
              bucket.displayName || bucket.display_name || bucket.window,
            ]
              .filter(Boolean)
              .join(" · ") || "Quota window",
          remaining:
            fraction === undefined ? undefined : percent(fraction * 100),
          resetsAt: instant(bucket.resetTime || bucket.reset_time),
        });
      }
  }
  return {
    readings,
    ...(plan ? { plan } : {}),
    observedAt: new Date().toISOString(),
  };
}

export async function fetchProviderQuota(
  file: Credential,
): Promise<ProviderQuota> {
  const provider = file.provider || file.type || "";
  if (!file.auth_index)
    throw new Error("This credential has no runtime auth index.");
  const pluginID = (file as Credential & { quota_plugin_id?: string })
    .quota_plugin_id;
  if (pluginID)
    return readProviderQuota(
      "plugin",
      await mgmt.post(`/plugins/${encodeURIComponent(pluginID)}/quota`, {
        auth_index: file.auth_index,
      }),
    );
  let url = "";
  let method = "GET";
  let data: string | undefined;
  let header: Record<string, string> = {
    Authorization: "Bearer $TOKEN$",
    Accept: "application/json",
  };
  const credential = async () => {
    if (file.runtime_only)
      throw new Error("This quota request requires a file-backed credential.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await apiText(MGMT + "/credentials/download", {
          query: { name: file.name },
        }),
      );
    } catch {
      throw new Error(
        "Could not read the credential needed for the usage request.",
      );
    }
    return obj(parsed);
  };
  if (provider === "kimi" || provider === "kimi-ai") {
    const raw = await credential();
    const domain =
      typeof raw.domain === "string" && raw.domain.trim()
        ? raw.domain.trim().toLowerCase()
        : "";
    let host = "";
    try {
      host = new URL(raw.base_url ?? raw["base-url"]).hostname;
    } catch {}
    const ai = domain
      ? ["ai", "kimi-ai", "kimi.ai"].includes(domain) ||
        domain.endsWith(".kimi.ai")
      : host
        ? host === "kimi.ai" || host.endsWith(".kimi.ai")
        : /kimi-ai|kimi\.ai/.test(`${raw.type || ""} ${provider} ${file.name}`);
    url = `https://api.kimi.${ai ? "ai" : "com"}/coding/v1/usages`;
  } else if (provider === "meta") {
    const raw = await credential();
    const token = typeof raw.dca_token === "string" ? raw.dca_token.trim() : "";
    if (!/^dca:[^\s]+$/.test(token))
      throw new Error(
        "This Meta credential has no valid DCA token. Sign in again.",
      );
    url = "https://api.meta.ai/muse-code/key";
    method = "POST";
    data = "{}";
    header = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-version": "1.0.0",
    };
  } else if (provider === "devin") {
    url =
      "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
    method = "POST";
    header = {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    };
    data = JSON.stringify({
      metadata: {
        ideName: "chisel",
        ideVersion: "3000.10.21",
        apiKey: "$TOKEN$",
        locale: "en",
        os: "darwin",
        extensionVersion: "3000.10.21",
        clientName: "chisel",
      },
    });
  } else if (provider === "antigravity") {
    const project = file.project_id || (await credential()).project_id;
    if (!project)
      throw new Error("The Antigravity credential has no project ID.");
    method = "POST";
    data = JSON.stringify({ project });
    header["Content-Type"] = "application/json";
    header["User-Agent"] = "antigravity/hub/2.23.0 darwin/arm64";
    const urls = [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ];
    for (const endpoint of urls) {
      const result = await mgmt.post<{ status_code: number; body: unknown }>(
        "/requests/api-call",
        { authIndex: file.auth_index, method, url: endpoint, header, data },
      );
      if (result.status_code >= 200 && result.status_code < 300) {
        const quota = readProviderQuota(provider, result.body);
        try {
          const subscription = await mgmt.post<{
            status_code: number;
            body: unknown;
          }>("/requests/api-call", {
            authIndex: file.auth_index,
            method,
            url: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
            header,
            data: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
          });
          if (
            subscription.status_code >= 200 &&
            subscription.status_code < 300
          ) {
            const payload = obj(
              typeof subscription.body === "string"
                ? JSON.parse(subscription.body)
                : subscription.body,
            );
            const tier = obj(
              payload.paidTier ||
                payload.paid_tier ||
                payload.currentTier ||
                payload.current_tier,
            );
            if (typeof tier.name === "string") quota.plan = tier.name;
          }
        } catch {
          /* Plan enrichment is optional; keep usable quota observations. */
        }
        return quota;
      }
    }
    throw new Error(
      "Antigravity usage endpoints rejected this credential. Check its sign-in and project.",
    );
  } else if (provider === "xai") {
    url = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
    header["x-xai-token-auth"] = "xai-grok-cli";
    header["x-grok-client-version"] = "1.0.46";
    header["User-Agent"] =
      "grok-pager/1.0.46 grok-shell/1.0.46 (macos; aarch64)";
    const raw = file as Credential & {
      sub?: string;
      subject?: string;
      user_id?: string;
    };
    const userID = raw.sub || raw.subject || raw.user_id;
    if (userID) header["x-userid"] = userID;
    const observations = await Promise.allSettled(
      [url, "https://cli-chat-proxy.grok.com/v1/billing"].map(
        async (endpoint) => {
          const response = await mgmt.post<{
            status_code: number;
            body: unknown;
          }>("/requests/api-call", {
            authIndex: file.auth_index,
            method,
            url: endpoint,
            header,
          });
          if (response.status_code < 200 || response.status_code >= 300)
            throw new Error(
              `The xAI billing endpoint returned HTTP ${response.status_code}.`,
            );
          return readProviderQuota(provider, response.body);
        },
      ),
    );
    const succeeded = observations.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (!succeeded.length)
      throw new Error(
        "xAI billing endpoints rejected this credential. Check its sign-in.",
      );
    const byLabel = new Map<string, QuotaReading>();
    for (const value of succeeded)
      for (const reading of value.readings)
        if (!byLabel.has(reading.label)) byLabel.set(reading.label, reading);
    return {
      observedAt: new Date().toISOString(),
      readings: [...byLabel.values()],
    };
  } else
    throw new Error(
      "This provider does not expose a supported quota endpoint. Use the upstream API-call tool for provider-specific diagnostics.",
    );
  const result = await mgmt.post<{ status_code: number; body: unknown }>(
    "/requests/api-call",
    {
      authIndex: file.auth_index,
      method,
      url,
      header,
      ...(data ? { data } : {}),
    },
  );
  if (result.status_code < 200 || result.status_code >= 300)
    throw new Error(
      `The usage endpoint returned HTTP ${result.status_code}. Refresh the credential or sign in again.`,
    );
  const quota = readProviderQuota(provider, result.body);
  if (provider === "kimi" || provider === "kimi-ai") {
    try {
      const response = await mgmt.post<{ status_code: number; body: unknown }>(
        "/requests/api-call",
        {
          authIndex: file.auth_index,
          method: "GET",
          url: url.replace(/\/usages$/, "/me"),
          header,
        },
      );
      if (response.status_code >= 200 && response.status_code < 300) {
        const profile = obj(
          typeof response.body === "string"
            ? JSON.parse(response.body)
            : response.body,
        );
        if (
          typeof profile.user_id === "string" &&
          typeof profile.user_level_name === "string"
        )
          quota.plan = profile.user_level_name;
      }
    } catch {
      /* Profile errors do not hide usable quota observations. */
    }
  }
  return quota;
}
