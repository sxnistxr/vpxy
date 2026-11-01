import { parseTime, providerName, remainingPercent, resetText, tone } from "$lib/format";
import type { Account } from "$lib/types";
import { ProviderMark } from "./icons";
import { toneBg } from "./Meter";

/** Sum of what is left in one window across a provider's accounts, one bar segment each. */
function pooled(accounts: Account[], windowId: string, now: Date) {
  let left = 0;
  let soonest: string | undefined;
  const segments = accounts.map((a) => {
    const w = a.windows.find((x) => x.id === windowId);
    if (!w) return null;
    const share = remainingPercent(w);
    left += share;
    const at = parseTime(w.resets_at);
    if (at && at > now && (!soonest || at < (parseTime(soonest) ?? at))) soonest = w.resets_at;
    return share;
  });
  return { left, known: segments.filter((s) => s !== null).length, segments, soonest };
}

export function ProviderSummary({ provider, accounts, now }: { provider: string; accounts: Account[]; now: Date }) {
  const weekly = pooled(accounts, "7d", now);
  const fiveHour = pooled(accounts, "5h", now);
  const count = accounts.length;

  return (
    <article className="flex min-w-0 flex-col p-5">
      <header className="flex items-center gap-2 text-[13px]">
        <ProviderMark provider={provider} />
        <h3 className="font-semibold">{providerName[provider] ?? provider}</h3>
        <span className="ml-auto text-xs text-faint">
          {count} {count === 1 ? "account" : "accounts"}
        </span>
      </header>

      <p className="mt-4 text-xs text-muted">Weekly limit, unused</p>
      <p className="mt-1 text-[28px] leading-none font-semibold tracking-tight">
        {weekly.known ? `${weekly.left}%` : "--"}
        <span className="ml-1.5 text-[13px] font-normal tracking-normal text-muted">of {weekly.known * 100 || 100}%</span>
      </p>

      <div className="mt-4 flex gap-1" aria-hidden="true">
        {weekly.segments.map((share, i) => (
          <div key={accounts[i]!.auth_id} className="h-1 flex-1 overflow-hidden rounded-full bg-raised">
            {share !== null && <div className={`h-full ${toneBg[tone(share)]}`} style={{ width: `${share}%` }} />}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">{weekly.soonest ? `First reset ${resetText(weekly.soonest, now)}` : "No reset pending"}</p>

      <div className="min-h-4 flex-1" />
      <p className="flex items-baseline gap-2 border-t border-line pt-3 text-xs text-muted">
        5-hour limit
        <span className="font-semibold text-text">{fiveHour.known ? `${fiveHour.left}%` : "--"}</span>
        <span className="text-faint">of {fiveHour.known * 100 || 100}%</span>
      </p>
    </article>
  );
}
