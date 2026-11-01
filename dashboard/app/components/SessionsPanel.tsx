import { maskLabel, relative } from "$lib/format";
import type { Account } from "$lib/types";

/** Live session bindings per account; each keeps its account until it has been idle for the TTL. */
export function SessionsPanel(props: { accounts: Account[]; generatedAt: Date; now: Date; ttlSeconds: number; affinity: boolean; showEmails: boolean }) {
  const { accounts, generatedAt, now, showEmails } = props;
  const bound = accounts.filter((a) => a.sessions.count > 0);
  const ttlMinutes = Math.max(1, Math.round(props.ttlSeconds / 60));

  return (
    <section id="sessions" aria-labelledby="sessions-title" className="scroll-mt-6">
      <h2 id="sessions-title" className="text-xl font-semibold tracking-tight">
        Sessions
      </h2>
      <p className="mt-1 max-w-[68ch] text-[13px] text-muted">
        {props.affinity
          ? `A session stays on its account until it is idle for ${ttlMinutes} min, so its prompt cache keeps working.`
          : "Session affinity is off, so requests from one session can land on different accounts."}
      </p>
      {bound.length === 0 ? (
        <p className="mt-4 text-[13px] text-faint">No live sessions. They appear once a client sends a request.</p>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bound.map((a) => (
            <div key={a.auth_id} className="rounded-xl border border-line bg-panel p-4">
              <p className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="truncate font-mono">{showEmails ? a.label : maskLabel(a.label)}</span>
                <span className="text-xs text-muted">{a.sessions.count} live</span>
              </p>
              <ul className="mt-3 space-y-1.5 text-xs">
                {a.sessions.recent.map((s) => (
                  <li key={s.id} className="flex justify-between gap-3">
                    <span className="font-mono text-muted">{s.id}</span>
                    <span className="text-faint">expires {relative(new Date(generatedAt.getTime() + s.expires_in_seconds * 1000), now)}</span>
                  </li>
                ))}
              </ul>
              {a.sessions.count > a.sessions.recent.length && (
                <p className="mt-2 text-xs text-faint">and {a.sessions.count - a.sessions.recent.length} more</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
