import type { Account, QuotaWindow } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Share of a window that is still unused, as a whole percent. */
export function remainingPercent(w: QuotaWindow): number {
  return Math.round(Math.min(100, Math.max(0, 100 - w.used_percent)));
}

export type Tone = "full" | "mid" | "low";

/** Bar colour for a remaining share: plenty, getting low, nearly gone. */
export function tone(remaining: number): Tone {
  if (remaining >= 60) return "full";
  if (remaining >= 25) return "mid";
  return "low";
}

/** "in 3 hours", "in 2 days"; whole units, rounded down, never less than a minute. */
export function relative(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "now";
  if (ms < HOUR) {
    const minutes = Math.max(1, Math.floor(ms / MINUTE));
    return `in ${minutes} min`;
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.floor(ms / DAY);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

/** "just now", "5 min ago", "2 hours ago", "3 days ago". */
export function ago(past: Date, now: Date): string {
  const ms = now.getTime() - past.getTime();
  if (ms < MINUTE) return "just now";
  return `${relative(new Date(now.getTime() + ms), now).slice(3)} ago`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "11/05, 00:00". */
export function stamp(d: Date): string {
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reset line under a meter: "in 1 day · 11/05, 00:00", or "No reset pending". */
export function resetText(resetsAt: string | undefined, now: Date): string {
  const at = parseTime(resetsAt);
  if (!at || at <= now) return "No reset pending";
  return `${relative(at, now)} · ${stamp(at)}`;
}

/** Parses an API timestamp; Go's zero time and blanks mean "unknown". */
export function parseTime(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) || d.getFullYear() <= 1 ? null : d;
}

/** 950 -> "950", 12_400 -> "12.4K", 1_250_000 -> "1.25M". */
export function tokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return String(n);
  if (abs < 1_000_000) return `${trim(n / 1_000, abs < 10_000 ? 2 : 1)}K`;
  if (abs < 1_000_000_000)
    return `${trim(n / 1_000_000, abs < 10_000_000 ? 2 : 1)}M`;
  return `${trim(n / 1_000_000_000, 2)}B`;
}

function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

/** Share of prompt tokens served from cache: reads over everything sent. */
export function cacheHitRatio(c: {
  input: number;
  cache_read: number;
  cache_write: number;
}): number | null {
  const prompt = c.input + c.cache_read + c.cache_write;
  return prompt > 0 ? c.cache_read / prompt : null;
}

/** "alice@example.com" -> "a•••@e•••.com"; anything else keeps its first 4 characters. */
export function maskLabel(label: string): string {
  const at = label.indexOf("@");
  if (at > 0) {
    const domain = label.slice(at + 1);
    const dot = domain.lastIndexOf(".");
    const host = dot > 0 ? domain.slice(0, dot) : domain;
    const tld = dot > 0 ? domain.slice(dot) : "";
    return `${label[0]}•••@${host[0] ?? ""}•••${tld}`;
  }
  return label.length <= 4 ? label : `${label.slice(0, 4)}•••`;
}

/** The weekly window of an account, when the provider reported one. */
export function weeklyWindow(a: Account): QuotaWindow | undefined {
  return a.windows.find((w) => w.id === "7d");
}

/**
 * The order the expiration-first router tries a provider's accounts in, mirroring
 * sdk/cliproxy/auth/selector_expiration.go: highest available priority, then soonest weekly reset,
 * then ready accounts with no known reset (by ID), then limited ones, soonest to recover first.
 * Accounts in cooldown or disabled are not candidates.
 */
export function routingOrder(accounts: Account[], now: Date): Account[] {
  type Ranked = { account: Account; group: number; at: number };
  const ranked: Ranked[] = [];
  for (const account of accounts) {
    if (account.status === "limited") {
      ranked.push({
        account,
        group: 2,
        at: parseTime(account.status_until)?.getTime() ?? Infinity,
      });
    } else if (account.status === "ready") {
      const reset = parseTime(weeklyWindow(account)?.resets_at);
      if (reset && reset > now)
        ranked.push({ account, group: 0, at: reset.getTime() });
      else ranked.push({ account, group: 1, at: 0 });
    }
  }
  ranked.sort((a, b) =>
    a.group < 2 &&
    b.group < 2 &&
    (a.account.priority ?? 0) !== (b.account.priority ?? 0)
      ? (b.account.priority ?? 0) - (a.account.priority ?? 0)
      : a.group !== b.group
        ? a.group - b.group
        : a.at !== b.at
          ? a.at - b.at
          : a.account.auth_id < b.account.auth_id
            ? -1
            : a.account.auth_id > b.account.auth_id
              ? 1
              : 0,
  );
  return ranked.map((r) => r.account);
}

export const providerName: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
};
