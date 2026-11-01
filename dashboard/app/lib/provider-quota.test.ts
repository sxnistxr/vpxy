import { expect, test } from "bun:test";
import { readProviderQuota } from "./provider-quota";
import { parseKeyGroup } from "./management";

test("Meta quota never retains credentials or turns unknown usage into full quota", () => {
  const value = readProviderQuota("meta", {
    api_key: "must-not-retain",
    email: "private@example.test",
    subs_tier_name: "Pro",
    subs_usage: {
      window: { used_percent: 25, resets_at: 1800000000 },
      weekly: {},
    },
  });
  expect(value.readings[0]?.remaining).toBe(75);
  expect(value.readings[1]?.remaining).toBeUndefined();
  expect(JSON.stringify(value)).not.toContain("must-not-retain");
  expect(JSON.stringify(value)).not.toContain("private@example.test");
});

test("Kimi detail windows preserve zero remaining and numeric string limits", () => {
  const value = readProviderQuota("kimi", {
    limits: [
      {
        name: "5 hours",
        detail: { used: "100", limit: "100", remaining: "0" },
      },
    ],
    usage: { used: 25, limit: 100 },
  });
  expect(value.readings.map((w) => w.remaining)).toEqual([0, 75]);
});

test("Devin percentages are remaining quota, with Unix reset seconds", () => {
  const value = readProviderQuota("devin", {
    userStatus: {
      planStatus: {
        dailyQuotaRemainingPercent: 40,
        dailyQuotaResetAtUnix: "1800000000",
        weeklyQuotaRemainingPercent: "15",
      },
    },
  });
  expect(value.readings.map((w) => w.remaining)).toEqual([40, 15]);
  expect(value.readings[0]?.resetsAt).toBe(
    new Date(1800000000000).toISOString(),
  );
});

test("Antigravity grouped quota fractions are clamped and missing data stays unknown", () => {
  const value = readProviderQuota("antigravity", {
    groups: [
      {
        displayName: "Claude",
        buckets: [
          { window: "5h", remainingFraction: 0.7 },
          { window: "weekly" },
        ],
      },
    ],
  });
  expect(value.readings[0]?.remaining).toBe(70);
  expect(value.readings[1]?.remaining).toBeUndefined();
});

test("xAI cent objects are converted without confusing dollars and percentages", () => {
  const value = readProviderQuota("xai", {
    config: { monthlyLimit: { val: "10000" }, used: { val: "2500" } },
  });
  expect(value.readings[0]?.remaining).toBe(75);
  expect(value.readings[0]?.detail).toBe("$25.00 of $100.00 used");
});

test("malformed advanced provider JSON cannot crash the structured editor", () => {
  for (const value of [
    { keys: "bad" },
    { models: [null] },
    { models: [{ name: 1 }] },
    { headers: { bad: null } },
    { "excluded-models": "*" },
  ])
    expect(() => parseKeyGroup(JSON.stringify(value))).toThrow();
  const value = {
    keys: [{ "api-key": "secret", custom: true }],
    headers: { "x-test": "keep" },
    models: [{ name: "model", custom: { enabled: true } }],
  };
  expect(parseKeyGroup(JSON.stringify(value))).toEqual(value);
});
