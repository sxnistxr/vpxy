import { ago, cacheHitRatio, maskLabel, parseTime, relative, tokens } from "$lib/format";
import type { Account } from "$lib/types";
import { RefreshIcon } from "./icons";
import { Meter } from "./Meter";

function statusLine(a: Account, now: Date): { text: string; className: string } | null {
  const until = parseTime(a.status_until);
  const back = until ? `, back ${relative(until, now)}` : "";
  switch (a.status) {
    case "cooldown":
      return { text: `Cooling down after an error${back}`, className: "text-mid" };
    case "limited":
      return { text: `Limit reached${back}`, className: "text-low" };
    case "disabled":
      return { text: "Disabled", className: "text-faint" };
    default:
      return null;
  }
}

export type RefreshState = { busy: boolean; message?: string };

export function AccountRow(props: {
  account: Account;
  now: Date;
  showEmails: boolean;
  isNext: boolean;
  refresh: RefreshState | undefined;
  onRefresh: (authID: string) => void;
}) {
  const { account: a, now, showEmails, isNext, refresh } = props;
  const status = statusLine(a, now);
  const ratio = cacheHitRatio(a.cache);
  const lastRebuild = a.rebuilds?.[0];
  const name = showEmails ? a.label : maskLabel(a.label);

  return (
    <li className="grid gap-x-8 gap-y-3 py-4 lg:grid-cols-[13rem_1fr_auto] lg:items-start">
      <div className="min-w-0">
        <p className="truncate font-mono text-[13px] font-medium" title={showEmails ? a.auth_id : undefined}>
          {name}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted">
          {a.plan && <span className="capitalize">{a.plan}</span>}
          {isNext && <span className="text-text">Next in line</span>}
          {a.banked && a.banked.available > 0 && (
            <span>
              {a.banked.available} banked {a.banked.available === 1 ? "reset" : "resets"}
            </span>
          )}
        </p>
        {status && <p className={`mt-1 text-xs ${status.className}`}>{status.text}</p>}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-6 gap-y-4">
        {a.windows.length > 0 ? (
          a.windows.map((w) => <Meter key={w.id} window={w} now={now} />)
        ) : (
          <p className="col-span-full text-xs text-faint">No usage reading yet. It arrives with the next poll or proxied request.</p>
        )}
      </div>

      <div className="flex items-center gap-3 lg:flex-col lg:items-end">
        <button
          type="button"
          onClick={() => props.onRefresh(a.auth_id)}
          disabled={refresh?.busy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap text-muted hover:bg-raised hover:text-text disabled:opacity-50"
        >
          <RefreshIcon className={`size-3.5 ${refresh?.busy ? "animate-spin" : ""}`} />
          {refresh?.busy ? "Refreshing" : "Refresh quota"}
        </button>
        {refresh?.message && <p className="text-xs text-mid">{refresh.message}</p>}
      </div>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint lg:col-span-3">
        <span>
          Cache {ratio === null ? "idle" : `${Math.round(ratio * 100)}% hit`} · {tokens(a.cache.cache_read)} read · {tokens(a.cache.cache_write)} written
        </span>
        <span>
          {a.sessions.count} live {a.sessions.count === 1 ? "session" : "sessions"}
        </span>
        {lastRebuild && (
          <span className="text-mid">
            Cache rebuilt {ago(parseTime(lastRebuild.at) ?? now, now)} ({tokens(lastRebuild.cache_write)} tokens)
          </span>
        )}
        {a.poll_error && <span className="text-low">Usage check failed: {a.poll_error}</span>}
      </p>
    </li>
  );
}
