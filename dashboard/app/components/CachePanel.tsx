import { ago, cacheHitRatio, maskLabel, parseTime, tokens } from "$lib/format";
import type { Account, AffinityBreak, CacheCounters, RebuildEvent } from "$lib/types";

const cell = "px-3 py-2.5 text-right tabular-nums";

function HitBar({ counters }: { counters: CacheCounters }) {
  const ratio = cacheHitRatio(counters);
  if (ratio === null) return <span className="text-faint">--</span>;
  const percent = Math.round(ratio * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1 w-16 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <span className={`block h-full ${percent >= 60 ? "bg-full" : percent >= 25 ? "bg-mid" : "bg-low"}`} style={{ width: `${percent}%` }} />
      </span>
      {percent}%
    </span>
  );
}

export function CachePanel(props: {
  accounts: Account[];
  breaks: AffinityBreak[];
  rebuildAlert: number;
  now: Date;
  showEmails: boolean;
}) {
  const { accounts, breaks, now, showEmails } = props;
  const totals = accounts.reduce<CacheCounters>(
    (sum, a) => ({
      requests: sum.requests + a.cache.requests,
      input: sum.input + a.cache.input,
      output: sum.output + a.cache.output,
      cache_read: sum.cache_read + a.cache.cache_read,
      cache_write: sum.cache_write + a.cache.cache_write,
    }),
    { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 },
  );
  const labels = new Map(accounts.map((a) => [a.auth_id, showEmails ? a.label : maskLabel(a.label)]));
  const nameOf = (id: string) => labels.get(id) ?? id;
  const rebuilds: (RebuildEvent & { authID: string })[] = accounts
    .flatMap((a) => (a.rebuilds ?? []).map((r) => ({ ...r, authID: a.auth_id })))
    .sort((x, y) => (parseTime(y.at)?.getTime() ?? 0) - (parseTime(x.at)?.getTime() ?? 0))
    .slice(0, 12);

  return (
    <section id="cache" aria-labelledby="cache-title" className="scroll-mt-6">
      <h2 id="cache-title" className="text-xl font-semibold tracking-tight">
        Prompt cache
      </h2>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted">
        Reads are tokens served from an account's cache; writes are tokens it had to cache again. A session that keeps its account
        should read far more than it writes.
      </p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full min-w-[44rem] text-[13px]">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th scope="col" className="px-3 py-2.5 text-left font-medium">
                Account
              </th>
              <th scope="col" className={`${cell} font-medium`}>
                Requests
              </th>
              <th scope="col" className={`${cell} font-medium`}>
                Input
              </th>
              <th scope="col" className={`${cell} font-medium`}>
                Output
              </th>
              <th scope="col" className={`${cell} font-medium`}>
                Cache read
              </th>
              <th scope="col" className={`${cell} font-medium`}>
                Cache written
              </th>
              <th scope="col" className="px-3 py-2.5 text-left font-medium">
                Hit rate
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {accounts.map((a) => (
              <tr key={a.auth_id}>
                <th scope="row" className="max-w-56 truncate px-3 py-2.5 text-left font-mono font-normal">
                  {nameOf(a.auth_id)}
                </th>
                <td className={cell}>{a.cache.requests}</td>
                <td className={cell}>{tokens(a.cache.input)}</td>
                <td className={cell}>{tokens(a.cache.output)}</td>
                <td className={cell}>{tokens(a.cache.cache_read)}</td>
                <td className={cell}>{tokens(a.cache.cache_write)}</td>
                <td className="px-3 py-2.5">
                  <HitBar counters={a.cache} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-line font-medium">
            <tr>
              <th scope="row" className="px-3 py-2.5 text-left font-medium">
                All accounts
              </th>
              <td className={cell}>{totals.requests}</td>
              <td className={cell}>{tokens(totals.input)}</td>
              <td className={cell}>{tokens(totals.output)}</td>
              <td className={cell}>{tokens(totals.cache_read)}</td>
              <td className={cell}>{tokens(totals.cache_write)}</td>
              <td className="px-3 py-2.5">
                <HitBar counters={totals} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="text-[15px] font-semibold">Cache rebuilds</h3>
          <p className="mt-1 text-xs text-muted">Requests that wrote at least {tokens(props.rebuildAlert)} cache tokens.</p>
          {rebuilds.length === 0 ? (
            <p className="mt-3 text-[13px] text-faint">None since VPXY started.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-panel text-[13px]">
              {rebuilds.map((r) => (
                <li key={`${r.authID}-${r.at}`} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5">
                  <span className="font-semibold">{tokens(r.cache_write)}</span>
                  <span className="font-mono text-muted">{nameOf(r.authID)}</span>
                  {r.model && <span className="text-muted">{r.model}</span>}
                  <span className="ml-auto text-xs text-faint">{ago(parseTime(r.at) ?? now, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-[15px] font-semibold">Sessions that changed account</h3>
          <p className="mt-1 text-xs text-muted">Each move starts the session's cache from scratch on the new account.</p>
          {breaks.length === 0 ? (
            <p className="mt-3 text-[13px] text-faint">No session has moved since VPXY started.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-panel text-[13px]">
              {breaks.slice(0, 12).map((b) => (
                <li key={`${b.session_id}-${b.at}`} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5">
                  <span className="font-mono">{b.session_id.slice(0, 8)}</span>
                  <span className="font-mono text-muted">
                    {nameOf(b.from)} to {nameOf(b.to)}
                  </span>
                  <span className="ml-auto text-xs text-faint">{ago(parseTime(b.at) ?? now, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
