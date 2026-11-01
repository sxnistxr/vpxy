import { m } from "motion/react";
import { ArrowRight, ArrowUpDown, Eye, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "$lib/api";
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
  weeklyWindow,
} from "$lib/format";
import { useTask } from "$lib/management";
import { href } from "$lib/router";
import type { Resource } from "$lib/resource";
import type { Account, Overview, QuotaWindow } from "$lib/types";
import { OtherQuota } from "./OtherQuota";
import { SearchInput } from "../overlays";
import {
  Bar,
  Button,
  cx,
  EmptyState,
  ErrorNote,
  IconButton,
  PageHeader,
  Panel,
  remainingTone,
  Segmented,
  Skeleton,
  Stat,
  StatusPill,
  Th,
} from "../ui";

export const providerTitle = (provider: string) =>
  ({
    claude: "Claude",
    codex: "Codex",
    "kimi-ai": "Kimi AI",
    "openai-compatibility": "OpenAI compatible",
  })[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
export function ProviderLogo({ provider }: { provider: string }) {
  const asset = provider === "codex" ? "openai" : provider;
  return ["claude", "openai", "antigravity", "kimi", "xai", "meta"].includes(
    asset,
  ) ? (
    <img
      src={`/assets/${asset}.svg`}
      alt=""
      className="provider-logo size-5 shrink-0"
    />
  ) : (
    <span
      className="flex size-5 items-center justify-center rounded bg-surface-3 text-[11px]"
      aria-hidden="true"
    >
      {provider.slice(0, 1).toUpperCase()}
    </span>
  );
}
const accountName = (account: Account, show: boolean) =>
  show ? account.label : maskLabel(account.label);

export function QuotaMeter({
  window,
  now,
  compact = false,
}: {
  window?: QuotaWindow;
  now: Date;
  compact?: boolean;
}) {
  if (!window)
    return <span className="text-[12px] text-fg-3">Not reported</span>;
  const left = remainingPercent(window);
  return (
    <div className="min-w-[130px] space-y-1.5">
      <div className="flex justify-between gap-3 text-[12px]">
        <span className="truncate text-fg-2">{window.label}</span>
        <span className="whitespace-nowrap font-medium">{left}% left</span>
      </div>
      <Bar
        percent={left}
        tone={remainingTone(left)}
        label={`${window.label} remaining`}
      />
      {!compact && (
        <p className="truncate text-[11px] text-fg-3" title={window.resets_at}>
          {resetText(window.resets_at, now)}
        </p>
      )}
    </div>
  );
}

function AccountState({ account, now }: { account: Account; now: Date }) {
  const until = parseTime(account.status_until);
  const label =
    account.status === "cooldown"
      ? "Cooling down"
      : account.status === "limited"
        ? "Limited"
        : account.status === "disabled"
          ? "Disabled"
          : "Ready";
  return (
    <div className="space-y-1">
      <StatusPill
        tone={
          account.status === "ready"
            ? "ok"
            : account.status === "limited"
              ? "danger"
              : account.status === "cooldown"
                ? "warn"
                : "neutral"
        }
      >
        {label}
      </StatusPill>
      {until && until > now && (
        <p className="text-[11px] text-fg-3">Back {relative(until, now)}</p>
      )}
    </div>
  );
}

function Serving({
  provider,
  accounts,
  now,
  show,
  strategy,
}: {
  provider: string;
  accounts: Account[];
  now: Date;
  show: boolean;
  strategy: string;
}) {
  const lane = accounts.filter((a) => a.provider === provider);
  const ordered = routingOrder(lane, now).filter((a) => a.status === "ready");
  const next = strategy === "expiration-first" ? ordered[0] : undefined;
  const active =
    next ??
    lane.find((a) => a.sessions.count > 0) ??
    lane.find((a) => a.status === "ready");
  return (
    <Panel bodyClassName="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ProviderLogo provider={provider} />
          <h2 className="text-[14px] font-semibold">
            {providerTitle(provider)}
          </h2>
        </div>
        <span className="text-[12px] text-fg-3">
          {lane.filter((a) => a.status === "ready").length} of {lane.length}{" "}
          ready
        </span>
      </div>
      {active ? (
        <>
          <div className="mt-5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] text-fg-3">
                {next ? "Next new session" : "Account activity"}
              </p>
              <p className="mt-1 truncate text-[16px] font-medium">
                {accountName(active, show)}
              </p>
              <p className="mt-1 text-[12px] text-fg-2">
                {[active.plan, `${active.sessions.count} bound sessions`]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <AccountState account={active} now={now} />
          </div>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <QuotaMeter
              window={active.windows.find((w) => w.id === "5h")}
              now={now}
            />
            <QuotaMeter window={weeklyWindow(active)} now={now} />
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3 text-[12px] text-fg-3">
            <span className="truncate">
              {strategy !== "expiration-first"
                ? `${ordered.length} ready accounts`
                : ordered[1]
                  ? `Then ${accountName(ordered[1], show)}`
                  : "No other ready account"}
            </span>
            <a
              href={href("quota")}
              className="flex items-center gap-1 whitespace-nowrap text-fg-2 hover:text-fg"
            >
              View quota
              <ArrowRight className="size-3" />
            </a>
          </div>
          <p className="mt-2 text-[11px] text-fg-3">
            Model eligibility applies. Bound sessions keep their account.
          </p>
        </>
      ) : (
        <EmptyState
          title={`Connect ${providerTitle(provider)}`}
          action={
            <a
              className="text-accent hover:underline"
              href={href("sign-in", { provider })}
            >
              Add an account
            </a>
          }
        >
          No ready account can serve requests.
        </EmptyState>
      )}
    </Panel>
  );
}

function ResetTimeline({
  accounts,
  now,
  show,
}: {
  accounts: Account[];
  now: Date;
  show: boolean;
}) {
  const week = 7 * 86400_000;
  const items = accounts
    .flatMap((account) => {
      const window = weeklyWindow(account);
      const at = parseTime(window?.resets_at);
      return window && at && at > now
        ? [{ account, at, left: remainingPercent(window) }]
        : [];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return (
    <Panel
      title="Weekly resets"
      description="Spend the earliest expiring quota first."
      bodyClassName="p-4"
    >
      {!items.length ? (
        <p className="py-6 text-fg-3">
          Reset times appear after the first usage check.
        </p>
      ) : (
        <>
          <div className="mb-3 flex justify-between text-[11px] text-fg-3">
            <span>Now</span>
            <span>Next 7 days</span>
          </div>
          <div className="space-y-3">
            {items.map(({ account, at, left }) => (
              <div
                key={account.auth_id}
                className="grid grid-cols-[minmax(80px,110px)_1fr_auto] items-center gap-3"
              >
                <span className="truncate text-[12px] text-fg-2">
                  {accountName(account, show)}
                </span>
                <div className="relative h-5 overflow-hidden rounded bg-surface-2">
                  <m.div
                    className="absolute top-0 h-full w-1 rounded bg-accent"
                    initial={false}
                    animate={{
                      left: `${Math.min(98, Math.max(1, ((at.getTime() - now.getTime()) / week) * 100))}%`,
                    }}
                    transition={{ duration: 0.2 }}
                  />
                </div>
                <span
                  className="w-[70px] text-right text-[11px] text-fg-2"
                  title={`${left}% left; ${stamp(at)}`}
                >
                  {relative(at, now)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function Attention({ accounts, show }: { accounts: Account[]; show: boolean }) {
  const items = accounts.filter((a) => a.status !== "ready" || a.poll_error);
  return (
    <Panel
      title="Needs attention"
      actions={<span className="text-[12px] text-fg-3">{items.length}</span>}
    >
      {!items.length ? (
        <EmptyState title="All clear">
          No account needs your attention.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((a) => (
            <li
              key={a.auth_id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-[12px] font-medium">
                  {accountName(a, show)}
                </p>
                <p className="mt-1 text-[12px] text-fg-3">
                  {a.poll_error
                    ? "Usage check failed"
                    : a.status === "limited"
                      ? "Waiting for quota reset"
                      : a.status === "disabled"
                        ? "Account disabled"
                        : "Cooling down"}
                </p>
              </div>
              <a
                href={href("credentials", { name: a.auth_id })}
                className="shrink-0 text-[12px] text-accent hover:underline"
              >
                Inspect
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AccountsTable({
  accounts,
  now,
  show,
  refresh,
  busy,
}: {
  accounts: Account[];
  now: Date;
  show: boolean;
  refresh: (id: string) => void;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [sort, setSort] = useState<"routing" | "name">("routing");
  const filtered = accounts.filter(
    (a) =>
      (provider === "all" || a.provider === provider) &&
      `${a.label} ${a.provider} ${a.plan} ${a.status}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const ordered =
    sort === "name"
      ? [...filtered].sort((a, b) => a.label.localeCompare(b.label))
      : [
          ...routingOrder(filtered, now),
          ...filtered.filter(
            (a) => a.status === "disabled" || a.status === "cooldown",
          ),
        ];
  return (
    <Panel
      title="Accounts"
      description="Live quota and routing eligibility."
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowUpDown />}
          onClick={() => setSort((s) => (s === "routing" ? "name" : "routing"))}
        >
          {sort === "routing" ? "Routing order" : "Account name"}
        </Button>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-3">
        <Segmented
          value={provider}
          label="Filter provider"
          onChange={setProvider}
          options={[
            { value: "all", label: "All", count: accounts.length },
            ...[...new Set(accounts.map((a) => a.provider))].map((p) => ({
              value: p,
              label: providerTitle(p),
              count: accounts.filter((a) => a.provider === p).length,
            })),
          ]}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search accounts…"
        />
      </div>
      {ordered.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12px]">
            <thead className="border-b border-line bg-rail">
              <tr>
                <Th>Account</Th>
                <Th>Status</Th>
                <Th>5-hour window</Th>
                <Th>Weekly window</Th>
                <Th align="right">Banked</Th>
                <Th align="right">Sessions</Th>
                <Th>Usage check</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ordered.map((a) => (
                <m.tr
                  layout="position"
                  key={a.auth_id}
                  transition={{ duration: 0.18 }}
                  className="hover:bg-surface-2/60"
                >
                  <td className="max-w-[210px] px-3 py-4">
                    <div className="flex items-center gap-2">
                      <ProviderLogo provider={a.provider} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {accountName(a, show)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-fg-3">
                          {providerTitle(a.provider)}
                          {a.plan && ` · ${a.plan}`}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-4">
                    <AccountState account={a} now={now} />
                  </td>
                  <td className="px-3 py-4">
                    <QuotaMeter
                      window={a.windows.find((w) => w.id === "5h")}
                      now={now}
                    />
                  </td>
                  <td className="px-3 py-4">
                    <QuotaMeter window={weeklyWindow(a)} now={now} />
                  </td>
                  <td
                    className="px-3 py-4 text-right"
                    title="Tracked only; resets are never claimed"
                  >
                    {a.banked?.available ?? "—"}
                  </td>
                  <td className="px-3 py-4 text-right">{a.sessions.count}</td>
                  <td className="px-3 py-4">
                    <div className="flex items-center gap-1">
                      <span
                        className={cx(
                          "text-[11px]",
                          a.poll_error ? "text-danger" : "text-fg-3",
                        )}
                        title={a.poll_error || a.observed_at}
                      >
                        {a.poll_error
                          ? "Failed"
                          : parseTime(a.observed_at)
                            ? ago(parseTime(a.observed_at)!, now)
                            : "Pending"}
                      </span>
                      <IconButton
                        label={`Refresh usage for ${accountName(a, show)}`}
                        disabled={busy}
                        onClick={() => refresh(a.auth_id)}
                      >
                        <RefreshCw />
                      </IconButton>
                    </div>
                  </td>
                </m.tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No matching accounts">
          Try a different search or provider filter.
        </EmptyState>
      )}
    </Panel>
  );
}

function CacheHealth({
  overview,
  show,
  now,
}: {
  overview: Overview;
  show: boolean;
  now: Date;
}) {
  const rebuilds = overview.accounts
    .flatMap((a) => (a.rebuilds ?? []).map((r) => ({ ...r, account: a })))
    .sort((a, b) => b.at.localeCompare(a.at));
  return (
    <>
      <Panel
        title="Prompt cache"
        description="Counters since the proxy started. Read share includes uncached input and cache writes."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[660px] text-[12px]">
            <thead className="border-b border-line bg-rail">
              <tr>
                <Th>Account</Th>
                {[
                  "Requests",
                  "Input",
                  "Output",
                  "Cache read",
                  "Cache write",
                  "Read share",
                ].map((s) => (
                  <Th key={s} align="right">
                    {s}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {overview.accounts.map((a) => {
                const ratio = cacheHitRatio(a.cache);
                return (
                  <tr key={a.auth_id} className="hover:bg-surface-2">
                    <td className="max-w-48 truncate px-3 py-3">
                      {accountName(a, show)}
                    </td>
                    {[
                      a.cache.requests,
                      a.cache.input,
                      a.cache.output,
                      a.cache.cache_read,
                      a.cache.cache_write,
                    ].map((n, i) => (
                      <td key={i} className="px-3 py-3 text-right">
                        {tokens(n)}
                      </td>
                    ))}
                    <td className="px-3 py-3 text-right">
                      {ratio === null ? "—" : `${Math.round(ratio * 100)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!overview.accounts.length && (
          <EmptyState title="No cache activity yet">
            Send requests through the proxy to see cache counters.
          </EmptyState>
        )}
      </Panel>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel
          title="Cache rebuilds"
          description={`Writes of at least ${tokens(overview.monitor.rebuild_alert_tokens)} tokens.`}
        >
          {!rebuilds.length ? (
            <EmptyState title="No large rebuilds">
              No request has crossed the rebuild threshold.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {rebuilds.slice(0, 20).map((r, i) => (
                <li key={`${r.at}-${i}`} className="space-y-1 px-4 py-3">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium text-warn">
                      {tokens(r.cache_write)} written
                    </span>
                    <span className="text-[11px] text-fg-3">
                      {ago(new Date(r.at), now)}
                    </span>
                  </div>
                  <p className="truncate text-[12px] text-fg-2">
                    {accountName(r.account, show)}
                    {r.model && ` · ${r.model}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="Account changes"
          description="A new account may need to rebuild the session’s cache."
        >
          {!overview.affinity_breaks.length ? (
            <EmptyState title="No session has moved">
              Bindings have stayed on their original accounts.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {overview.affinity_breaks.slice(0, 20).map((b, i) => {
                const name = (id: string) => {
                  const a = overview.accounts.find((a) => a.auth_id === id);
                  return a ? accountName(a, show) : maskLabel(id);
                };
                return (
                  <li key={`${b.at}-${i}`} className="space-y-1 px-4 py-3">
                    <p className="font-mono text-[12px]">
                      {b.session_id.slice(0, 8)}
                    </p>
                    <p className="break-words text-[12px] text-fg-2">
                      {name(b.from)} → {name(b.to)}
                    </p>
                    <p className="text-[11px] text-fg-3">
                      {ago(new Date(b.at), now)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

export function MonitorPage({
  page,
  resource,
  showEmails,
}: {
  page: "overview" | "quota" | "sessions";
  resource: Resource<Overview>;
  showEmails: boolean;
}) {
  const [now, setNow] = useState(() => new Date());
  const refreshTask = useTask();
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);
  async function refresh(id = "") {
    await refreshTask.run(async () => {
      await api("/vpxy/api/quota/refresh", {
        method: "POST",
        json: id ? { auth_id: id } : {},
      });
      await resource.refresh();
    }, "Usage refreshed");
  }
  const data = resource.data;
  const descriptions = {
    overview: "Your accounts, quota, and cache health at a glance.",
    quota: "Real usage windows, reset times, and the next account in line.",
    sessions:
      "Keep each coding session on one account so its prompt cache survives.",
  };
  return (
    <>
      <PageHeader
        title={page.charAt(0).toUpperCase() + page.slice(1)}
        description={descriptions[page]}
        actions={
          <>
            <span className="mr-1 text-[12px] text-fg-3">
              {resource.updatedAt
                ? `Updated ${ago(new Date(resource.updatedAt), now)}`
                : "Connecting…"}
            </span>
            <Button
              icon={<RefreshCw />}
              busy={refreshTask.busy}
              onClick={() => void refresh()}
            >
              Refresh usage
            </Button>
          </>
        }
      />
      {resource.error && (
        <ErrorNote
          error={resource.error}
          onRetry={() => void resource.refresh()}
        />
      )}
      {!data ? (
        <div
          className="grid gap-5 sm:grid-cols-2"
          aria-label="Loading overview"
        >
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : (
        <>
          {!data.accounts.length ? (
            <Panel>
              <EmptyState
                title="Your proxy is ready for its first account"
                action={
                  <a
                    href={href("sign-in")}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 font-medium text-on-primary"
                  >
                    <Plus className="size-4" />
                    Connect an account
                  </a>
                }
              >
                Sign in to Claude or Codex to see live quota, route sessions by
                reset time, and track prompt-cache health.
              </EmptyState>
            </Panel>
          ) : (
            <>
              {page !== "sessions" && (
                <div className="grid gap-5 md:grid-cols-2">
                  {[
                    ...new Set([
                      "claude",
                      "codex",
                      ...data.accounts.map((a) => a.provider),
                    ]),
                  ].map((provider) => (
                    <Serving
                      key={provider}
                      provider={provider}
                      accounts={data.accounts}
                      now={now}
                      show={showEmails}
                      strategy={data.routing.strategy}
                    />
                  ))}
                </div>
              )}
              {page === "overview" && (
                <>
                  <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    <Stat
                      label="Live sessions"
                      value={data.routing.sessions}
                      detail={`${Math.round(data.routing.session_ttl_seconds / 60)} min idle TTL`}
                    />
                    <Stat
                      label="Cache read share"
                      value={
                        cacheHitRatio(data.totals) === null
                          ? "—"
                          : `${Math.round(cacheHitRatio(data.totals)! * 100)}%`
                      }
                      detail={`${tokens(data.totals.cache_read)} tokens from cache`}
                    />
                    <Stat
                      label="Requests"
                      value={tokens(data.totals.requests)}
                      detail="Since proxy started"
                    />
                    <Stat
                      label="Accounts ready"
                      value={`${data.accounts.filter((a) => a.status === "ready").length}/${data.accounts.length}`}
                      detail={data.routing.strategy}
                    />
                  </div>
                  <div className="grid items-start gap-5 xl:grid-cols-[1.45fr_1fr]">
                    <ResetTimeline
                      accounts={data.accounts}
                      now={now}
                      show={showEmails}
                    />
                    <Attention accounts={data.accounts} show={showEmails} />
                  </div>
                </>
              )}
              {page !== "sessions" && (
                <AccountsTable
                  accounts={data.accounts}
                  now={now}
                  show={showEmails}
                  refresh={(id) => void refresh(id)}
                  busy={refreshTask.busy}
                />
              )}
              {page === "quota" && (
                <>
                  <ResetTimeline
                    accounts={data.accounts}
                    now={now}
                    show={showEmails}
                  />
                  <Panel
                    title="Additional windows"
                    description="Provider-specific model limits and banked resets are tracked here."
                  >
                    <ul className="divide-y divide-line">
                      {data.accounts.map((a) => (
                        <li
                          key={a.auth_id}
                          className="grid gap-4 p-4 md:grid-cols-[180px_1fr]"
                        >
                          <div>
                            <p className="truncate font-medium">
                              {accountName(a, showEmails)}
                            </p>
                            <p className="mt-1 text-[12px] text-fg-3">
                              {a.banked
                                ? `${a.banked.available} banked resets${a.banked.total ? ` of ${a.banked.total}` : ""}${a.banked.ends_at ? ` · expire ${stamp(new Date(a.banked.ends_at))}` : ""}`
                                : "No banked-reset data"}
                            </p>
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2">
                            {a.windows
                              .filter((w) => !["5h", "7d"].includes(w.id))
                              .map((w) => (
                                <QuotaMeter key={w.id} window={w} now={now} />
                              ))}
                            {!a.windows.some(
                              (w) => !["5h", "7d"].includes(w.id),
                            ) && (
                              <p className="text-[12px] text-fg-3">
                                No additional windows reported.
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <p className="border-t border-line px-4 py-3 text-[12px] text-fg-3">
                      Banked resets are read only. This console never claims or
                      spends them.
                    </p>
                  </Panel>
                </>
              )}
            </>
          )}
          {page === "sessions" && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Live bindings" value={data.routing.sessions} />
                <Stat
                  label="Idle TTL"
                  value={`${Math.round(data.routing.session_ttl_seconds / 60)}m`}
                />
                <Stat
                  label="Session affinity"
                  value={data.routing.session_affinity ? "On" : "Off"}
                />
                <Stat label="Rebind on" value={data.routing.rebind_on} />
              </div>
              <Panel
                title="Live sessions"
                description="Session IDs are shortened by the server; this list is a recent sample per account."
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-[12px]">
                    <thead className="border-b border-line bg-rail">
                      <tr>
                        <Th>Session</Th>
                        <Th>Bound account</Th>
                        <Th>Provider</Th>
                        <Th align="right">Idle expiry</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.accounts.flatMap((a) =>
                        a.sessions.recent.map((s) => (
                          <tr key={`${a.auth_id}-${s.id}`}>
                            <td className="px-3 py-3 font-mono">{s.id}</td>
                            <td className="px-3 py-3">
                              {accountName(a, showEmails)}
                            </td>
                            <td className="px-3 py-3">
                              {providerTitle(a.provider)}
                            </td>
                            <td className="px-3 py-3 text-right">
                              {Math.max(
                                0,
                                Math.ceil(
                                  (s.expires_in_seconds -
                                    (now.getTime() -
                                      new Date(data.generated_at).getTime()) /
                                      1000) /
                                    60,
                                ),
                              )}{" "}
                              min
                            </td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
                {!data.routing.sessions && (
                  <EmptyState title="No live sessions">
                    Sessions appear when a client sends requests with a session
                    identifier.
                  </EmptyState>
                )}
              </Panel>
              <CacheHealth overview={data} now={now} show={showEmails} />
            </>
          )}
          {page === "quota" && <OtherQuota show={showEmails} />}
          <p className="text-[11px] text-fg-3">
            {data.monitor.polling_enabled
              ? `Quota polling every ${Math.round(data.monitor.interval_seconds / 60)} min.`
              : "Automatic quota polling is disabled."}{" "}
            Activity counters reset when the proxy restarts.{" "}
            <a href={href("routing")} className="text-accent hover:underline">
              Routing settings
            </a>
          </p>
        </>
      )}
    </>
  );
}
