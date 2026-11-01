import { maskLabel, parseTime, providerName, relative, remainingPercent, routingOrder, stamp, tone, weeklyWindow } from "$lib/format";
import type { Account } from "$lib/types";
import { ProviderMark } from "./icons";
import { toneBg } from "./Meter";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

type Placed = { account: Account; x: number; left: number; resetsAt: Date };

/** Local midnights inside the coming week, as fractions of it. */
function dayTicks(now: Date): { x: number; label: string }[] {
  const ticks: { x: number; label: string }[] = [];
  const day = new Date(now);
  day.setHours(24, 0, 0, 0);
  while (day.getTime() - now.getTime() < WEEK) {
    ticks.push({ x: (day.getTime() - now.getTime()) / WEEK, label: `${weekday.format(day)} ${day.getDate()}` });
    day.setDate(day.getDate() + 1);
  }
  return ticks;
}

/**
 * Each provider's unused weekly quota, drawn at the moment it expires. Expiration-first routing
 * spends the leftmost bar first, so quota that would lapse unused is not wasted.
 */
export function ResetTimeline({ accounts, now, showEmails }: { accounts: Account[]; now: Date; showEmails: boolean }) {
  const providers = [...new Set(accounts.map((a) => a.provider))];
  const ticks = dayTicks(now);
  const name = (a: Account) => (showEmails ? a.label : maskLabel(a.label));

  return (
    <section aria-labelledby="timeline-title" className="rounded-xl border border-line bg-panel">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 pt-4">
        <h2 id="timeline-title" className="text-[15px] font-semibold">
          Weekly resets
        </h2>
        <p className="text-xs text-muted">Bar height is the weekly quota still unused when it resets. New sessions go to the earliest reset first.</p>
      </header>

      <div className="relative mx-5 mt-4 mb-1 h-5 text-[11px] text-faint" aria-hidden="true">
        <span className="absolute left-0">Now</span>
        {ticks.map((t) => (
          <span key={t.label} className="absolute -translate-x-1/2 whitespace-nowrap max-sm:[&:nth-child(even)]:hidden" style={{ left: `${t.x * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>

      <div className="divide-y divide-line">
        {providers.map((provider) => {
          const lane = accounts.filter((a) => a.provider === provider);
          const next = routingOrder(lane, now)[0];
          const placed: Placed[] = [];
          const unknown: Account[] = [];
          for (const account of lane) {
            if (account.status === "disabled") continue;
            const weekly = weeklyWindow(account);
            const resetsAt = parseTime(weekly?.resets_at);
            if (!weekly || !resetsAt || resetsAt <= now) {
              unknown.push(account);
              continue;
            }
            const x = Math.min(1, (resetsAt.getTime() - now.getTime()) / WEEK);
            placed.push({ account, x, left: remainingPercent(weekly), resetsAt });
          }
          const nextPlaced = placed.find((p) => p.account === next);

          return (
            <div key={provider} className="px-5 py-4">
              <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <ProviderMark provider={provider} />
                <span className="font-medium">{providerName[provider] ?? provider}</span>
                <span className="text-muted">
                  {next ? (
                    <>
                      next request goes to <span className="font-mono text-text">{name(next)}</span>
                    </>
                  ) : (
                    "no account can take requests right now"
                  )}
                </span>
              </div>

              <div className="relative mt-6 h-24 border-b border-line" aria-hidden="true">
                {ticks.map((t) => (
                  <div key={t.label} className="absolute inset-y-0 w-px bg-line/70" style={{ left: `${t.x * 100}%` }} />
                ))}
                {placed.map((p) => {
                  const isNext = p === nextPlaced;
                  const height = Math.max(4, p.left);
                  return (
                    <div key={p.account.auth_id} title={`${name(p.account)}: ${p.left}% unused, resets ${relative(p.resetsAt, now)} (${stamp(p.resetsAt)})`}>
                      <div
                        className={`absolute bottom-0 w-3 -translate-x-1/2 rounded-t-sm ${toneBg[tone(p.left)]} ${
                          p.account.status === "ready" ? "" : "opacity-35"
                        } ${isNext ? "ring-2 ring-text ring-offset-2 ring-offset-panel" : ""}`}
                        style={{ left: `${p.x * 100}%`, height: `${height}%` }}
                      />
                      <span
                        className={`absolute -translate-x-1/2 text-[11px] whitespace-nowrap ${isNext ? "font-medium text-text" : "text-faint"}`}
                        style={{ left: `${p.x * 100}%`, bottom: `calc(${height}% + ${isNext ? 8 : 4}px)` }}
                      >
                        {isNext ? `Next · ${p.left}%` : `${p.left}%`}
                      </span>
                    </div>
                  );
                })}
              </div>

              {unknown.length > 0 && (
                <p className="mt-2 text-xs text-faint">
                  No weekly reset known yet for <span className="font-mono">{unknown.map(name).join(", ")}</span>
                </p>
              )}

              <ul className="sr-only">
                {placed.map((p) => (
                  <li key={p.account.auth_id}>
                    {name(p.account)}: {p.left}% of the weekly quota unused, resets {relative(p.resetsAt, now)}
                    {p === nextPlaced ? ", next to receive requests" : ""}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
