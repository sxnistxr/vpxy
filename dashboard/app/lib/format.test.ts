import { describe, expect, test } from "bun:test";
import {
  ago,
  cacheHitRatio,
  maskLabel,
  parseTime,
  relative,
  remainingPercent,
  resetText,
  routingOrder,
  stamp,
  tokens,
  tone,
} from "./format";
import type { Account } from "./types";

const now = new Date(2026, 10, 1, 12, 0, 0);
const after = (ms: number) => new Date(now.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("remainingPercent", () => {
  test("is the unused share, rounded and clamped", () => {
    expect(remainingPercent({ id: "5h", label: "", used_percent: 37.4 })).toBe(
      63,
    );
    expect(remainingPercent({ id: "5h", label: "", used_percent: 0 })).toBe(
      100,
    );
    expect(remainingPercent({ id: "5h", label: "", used_percent: 100 })).toBe(
      0,
    );
    expect(remainingPercent({ id: "5h", label: "", used_percent: 130 })).toBe(
      0,
    );
  });
});

describe("tone", () => {
  test("switches exactly at 60 and 25", () => {
    expect(tone(100)).toBe("full");
    expect(tone(60)).toBe("full");
    expect(tone(59)).toBe("mid");
    expect(tone(25)).toBe("mid");
    expect(tone(24)).toBe("low");
    expect(tone(0)).toBe("low");
  });
});

describe("relative", () => {
  test("rounds down to whole units at each boundary", () => {
    expect(relative(now, now)).toBe("now");
    expect(relative(after(1), now)).toBe("in 1 min");
    expect(relative(after(HOUR - 1), now)).toBe("in 59 min");
    expect(relative(after(HOUR), now)).toBe("in 1 hour");
    expect(relative(after(2 * HOUR), now)).toBe("in 2 hours");
    expect(relative(after(DAY - 1), now)).toBe("in 23 hours");
    expect(relative(after(DAY), now)).toBe("in 1 day");
    expect(relative(after(2 * DAY + 5 * HOUR), now)).toBe("in 2 days");
  });
});

test("ago reads a past moment at each boundary", () => {
  const before = (ms: number) => new Date(now.getTime() - ms);
  expect(ago(now, now)).toBe("just now");
  expect(ago(before(MIN - 1), now)).toBe("just now");
  expect(ago(before(MIN), now)).toBe("1 min ago");
  expect(ago(before(HOUR), now)).toBe("1 hour ago");
  expect(ago(before(3 * DAY), now)).toBe("3 days ago");
});

describe("resetText", () => {
  test("names the relative and local time of a future reset", () => {
    expect(resetText(after(DAY).toISOString(), now)).toBe(
      "in 1 day · 11/02, 12:00",
    );
  });
  test("treats unknown, zero and past resets as no reset pending", () => {
    expect(resetText(undefined, now)).toBe("No reset pending");
    expect(resetText("0001-01-01T00:00:00Z", now)).toBe("No reset pending");
    expect(resetText(now.toISOString(), now)).toBe("No reset pending");
  });
});

test("stamp pads month, day, hour and minute", () => {
  expect(stamp(new Date(2026, 0, 5, 7, 3))).toBe("01/05, 07:03");
});

test("parseTime rejects garbage and Go's zero time", () => {
  expect(parseTime("nope")).toBeNull();
  expect(parseTime("0001-01-01T00:00:00Z")).toBeNull();
  expect(parseTime("2026-11-05T00:00:00Z")?.toISOString()).toBe(
    "2026-11-05T00:00:00.000Z",
  );
});

describe("tokens", () => {
  test("abbreviates at each thousand step", () => {
    expect(tokens(999)).toBe("999");
    expect(tokens(1_000)).toBe("1K");
    expect(tokens(1_234)).toBe("1.23K");
    expect(tokens(12_400)).toBe("12.4K");
    expect(tokens(999_999)).toBe("1000K");
    expect(tokens(1_000_000)).toBe("1M");
    expect(tokens(1_250_000)).toBe("1.25M");
    expect(tokens(812_000_000)).toBe("812M");
    expect(tokens(2_500_000_000)).toBe("2.5B");
  });
});

test("cacheHitRatio is reads over all prompt tokens, and null without traffic", () => {
  expect(cacheHitRatio({ input: 0, cache_read: 0, cache_write: 0 })).toBeNull();
  expect(cacheHitRatio({ input: 10, cache_read: 80, cache_write: 10 })).toBe(
    0.8,
  );
});

test("maskLabel hides the middle of an email and of other labels", () => {
  expect(maskLabel("alice@example.com")).toBe("a•••@e•••.com");
  expect(maskLabel("bob@localhost")).toBe("b•••@l•••");
  expect(maskLabel("claude-team.json")).toBe("clau•••");
  expect(maskLabel("abcd")).toBe("abcd");
});

describe("routingOrder", () => {
  const account = (
    id: string,
    status: Account["status"],
    weeklyResetMs?: number,
    untilMs?: number,
  ): Account => ({
    auth_id: id,
    provider: "claude",
    label: id,
    status,
    status_until:
      untilMs === undefined ? undefined : after(untilMs).toISOString(),
    windows:
      weeklyResetMs === undefined
        ? []
        : [
            {
              id: "7d",
              label: "Weekly",
              used_percent: 10,
              resets_at: after(weeklyResetMs).toISOString(),
            },
          ],
    cache: { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 },
    sessions: { count: 0, recent: [] },
  });

  test("ranks soonest weekly reset, then unknown by id, then limited by recovery; skips the rest", () => {
    const order = routingOrder(
      [
        account("late", "ready", 5 * DAY),
        account("limited-late", "limited", 2 * DAY, 3 * HOUR),
        account("unknown-b", "ready"),
        account("soon", "ready", DAY),
        account("cooling", "cooldown", HOUR),
        account("unknown-a", "ready"),
        account("limited-soon", "limited", 2 * DAY, HOUR),
        account("off", "disabled", HOUR),
        account("lapsed", "ready", 0),
      ],
      now,
    );
    expect(order.map((a) => a.auth_id)).toEqual([
      "soon",
      "late",
      "lapsed",
      "unknown-a",
      "unknown-b",
      "limited-soon",
      "limited-late",
    ]);
  });

  test("breaks a tie on the same reset time by id", () => {
    expect(
      routingOrder(
        [account("b", "ready", DAY), account("a", "ready", DAY)],
        now,
      ).map((a) => a.auth_id),
    ).toEqual(["a", "b"]);
  });

  test("honors priority before expiry, including high-priority accounts without a known reset", () => {
    const low = { ...account("soon-low", "ready", HOUR), priority: -1 };
    const high = { ...account("late-high", "ready", 5 * DAY), priority: 2 };
    const unknown = { ...account("unknown-high", "ready"), priority: 3 };
    const limited = {
      ...account("limited", "limited", DAY, HOUR),
      priority: 100,
    };
    expect(
      routingOrder([low, limited, high, unknown], now).map((a) => a.auth_id),
    ).toEqual(["unknown-high", "late-high", "soon-low", "limited"]);
  });
});
