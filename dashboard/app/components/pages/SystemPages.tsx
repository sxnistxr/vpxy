import {
  Copy,
  Download,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  apiText,
  errorText,
  MGMT,
  mgmt,
  saveBlob,
  send,
  serverInfo,
} from "$lib/api";
import { confirmAction, copyText, toast } from "$lib/feedback";
import { configChanged, parseJSON, pretty, useTask } from "$lib/management";
import type {
  CredentialList,
  ErrorLogFile,
  LogsPage as LogResponse,
  PluginInfo,
  PluginList,
} from "$lib/mgmt-types";
import { useResource } from "$lib/resource";
import { href } from "$lib/router";
import { useStore } from "$lib/store";
import type { Overview } from "$lib/types";
import { ConfigEditor, JSONInput, TextField } from "../editors";
import { Dialog, SearchInput } from "../overlays";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  StatusPill,
  Switch,
  Tabs,
  Textarea,
} from "../ui";
import { safeLink } from "./SignInPage";

export function LogsPage() {
  const [tab, setTab] = useState("live");
  return (
    <>
      <PageHeader
        title="Logs"
        description="Follow application activity, inspect failures, and retrieve request logs."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        label="Log pages"
        tabs={[
          { value: "live", label: "Application logs" },
          { value: "errors", label: "Error files" },
          { value: "request", label: "Request lookup" },
          { value: "settings", label: "Logging settings" },
        ]}
      />
      {tab === "live" ? (
        <LiveLogs />
      ) : tab === "errors" ? (
        <ErrorFiles />
      ) : tab === "request" ? (
        <RequestLookup />
      ) : (
        <ConfigEditor
          path={["observability", "logs"]}
          title="Logging settings"
          description="Debug logging, request logging, file output, rotation size, and retained error files."
        />
      )}
    </>
  );
}

function LiveLogs() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState("all");
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const cursor = useRef<string | undefined>(undefined);
  const after = useRef<number | string | undefined>(undefined);
  const task = useTask();
  useEffect(() => {
    let disposed = false;
    let inflight = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (inflight || disposed) return;
      inflight = true;
      try {
        const result = await mgmt.get<LogResponse>(
          "/observability/logs",
          {
            limit: 500,
            ...(cursor.current !== undefined
              ? { cursor: cursor.current }
              : after.current !== undefined
                ? { after: after.current }
                : {}),
          },
          controller.signal,
        );
        if (disposed) return;
        setLines((prev) =>
          (result["cursor-reset"]
            ? (result.lines ?? [])
            : [...prev, ...(result.lines ?? [])]
          ).slice(-3000),
        );
        if (result["next-cursor"] !== undefined)
          cursor.current = result["next-cursor"];
        after.current = result["latest-timestamp"] ?? after.current;
        setError(undefined);
      } catch (err) {
        if (!disposed) setError(errorText(err));
      } finally {
        inflight = false;
        if (!disposed) {
          setLoading(false);
          if (live)
            timer = setTimeout(() => {
              if (document.visibilityState === "visible") void poll();
            }, 2_000);
        }
      }
    }
    void poll();
    const visible = () => {
      if (live && document.visibilityState === "visible") {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [live, tick]);
  const visible = lines.filter(
    (line) =>
      line.toLowerCase().includes(filter.toLowerCase()) &&
      (level === "all" || line.toLowerCase().includes(level)),
  );
  return (
    <Panel
      title="Application stream"
      actions={
        <>
          <StatusPill tone={live ? "ok" : "neutral"}>
            {live ? "Live" : "Paused"}
          </StatusPill>
          <Button
            size="sm"
            icon={live ? <Pause /> : <Play />}
            onClick={() => setLive((v) => !v)}
          >
            {live ? "Pause" : "Resume"}
          </Button>
          <IconButton
            label="Refresh logs"
            onClick={() => setTick((t) => t + 1)}
          >
            <RefreshCw />
          </IconButton>
        </>
      }
    >
      <div className="flex flex-wrap gap-3 border-b border-line p-3">
        <div className="min-w-44 flex-1">
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter log lines…"
          />
        </div>
        <Select
          aria-label="Log level"
          className="w-auto"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="all">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
        </Select>
        <Button
          icon={<Download />}
          onClick={() =>
            saveBlob(
              new Blob([visible.join("\n")], { type: "text/plain" }),
              "vpxy-logs.txt",
            )
          }
        >
          Export shown
        </Button>
        <Button
          variant="danger"
          icon={<Trash2 />}
          busy={task.busy}
          onClick={async () => {
            if (
              !(await confirmAction({
                title: "Clear application logs?",
                body: "Remove application logs on the server. Error and request logs are managed separately.",
                confirmLabel: "Clear logs",
                danger: true,
              }))
            )
              return;
            await task.run(async () => {
              await mgmt.del("/observability/logs");
              setLines([]);
              cursor.current = undefined;
              after.current = undefined;
              setTick((t) => t + 1);
            }, "Application logs cleared");
          }}
        >
          Clear
        </Button>
      </div>
      {error && (
        <div className="p-3">
          <ErrorNote error={error} onRetry={() => setTick((t) => t + 1)} />
        </div>
      )}
      {loading ? (
        <Skeleton className="m-4 h-64" />
      ) : !visible.length ? (
        <EmptyState title="No matching log lines">
          Enable file logging in Logging settings, or change your filters.
        </EmptyState>
      ) : (
        <div
          className="max-h-[65dvh] overflow-auto p-4 scrollbar-thin"
          tabIndex={0}
          aria-label="Application log lines"
        >
          <ol className="space-y-1 font-mono text-[11px] leading-5">
            {visible.map((line, i) => (
              <li
                key={i}
                className={
                  /\b(error|fatal)\b/i.test(line)
                    ? "text-danger"
                    : /\bwarn(ing)?\b/i.test(line)
                      ? "text-warn"
                      : "text-fg-2"
                }
              >
                <pre className="whitespace-pre-wrap break-all">{line}</pre>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="border-t border-line px-4 py-2 text-[11px] text-fg-3">
        {visible.length} shown · {lines.length} buffered · most recent 3,000
        lines retained in this tab
      </p>
    </Panel>
  );
}

function ErrorFiles() {
  const resource = useResource<{ files: ErrorLogFile[] }>("error-logs", () =>
    mgmt.get("/observability/logs/errors"),
  );
  const task = useTask();
  return (
    <Panel
      title="Error log files"
      actions={
        <Button
          size="sm"
          icon={<RefreshCw />}
          onClick={() => void resource.refresh()}
        >
          Refresh
        </Button>
      }
    >
      {resource.error && (
        <div className="p-3">
          <ErrorNote error={resource.error} />
        </div>
      )}
      {resource.data?.files.length ? (
        <ul className="divide-y divide-line">
          {resource.data.files.map((file) => (
            <li
              key={file.name}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-[12px]">{file.name}</p>
                <p className="mt-1 text-[11px] text-fg-3">
                  {file.size === undefined
                    ? ""
                    : `${(file.size / 1024).toFixed(1)} KB`}
                  {file.modified
                    ? ` · ${new Date(file.modified * 1000).toLocaleString()}`
                    : ""}
                </p>
              </div>
              <Button
                size="sm"
                icon={<Download />}
                busy={task.busy}
                onClick={() =>
                  void task.run(async () =>
                    saveBlob(
                      await (
                        await send(
                          `${MGMT}/observability/logs/errors/${encodeURIComponent(file.name)}`,
                        )
                      ).blob(),
                      file.name,
                    ),
                  )
                }
              >
                Download
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No error files">
          Saved upstream failures will appear here.
        </EmptyState>
      )}
    </Panel>
  );
}

function RequestLookup() {
  const [id, setId] = useState("");
  const [log, setLog] = useState<string>();
  const task = useTask();
  return (
    <Panel
      title="Find a request log"
      description="Use the request ID recorded in the application logs."
      bodyClassName="space-y-4 p-4"
    >
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void task.run(async () =>
            setLog(
              await apiText(
                `${MGMT}/observability/logs/requests/${encodeURIComponent(id.trim())}`,
              ),
            ),
          );
        }}
      >
        <div className="min-w-0 flex-1">
          <TextField label="Request ID" value={id} onChange={setId} required />
        </div>
        <Button type="submit" busy={task.busy} disabled={!id.trim()}>
          Find log
        </Button>
      </form>
      {task.error && <ErrorNote error={task.error} />}
      {log !== undefined && (
        <>
          <pre className="max-h-[60dvh] overflow-auto rounded-md border border-line bg-canvas p-3 font-mono text-[12px] whitespace-pre-wrap break-words">
            {log}
          </pre>
          <Button
            icon={<Download />}
            onClick={() =>
              saveBlob(
                new Blob([log], { type: "text/plain" }),
                `request-${id.replace(/[^\w.-]/g, "_")}.log`,
              )
            }
          >
            Download log
          </Button>
        </>
      )}
    </Panel>
  );
}

type Plugin = PluginInfo & {
  metadata?: { name?: string; description?: string; version?: string };
  source_id?: string;
  supports_oauth?: boolean;
  oauth_provider?: string;
  supports_quota?: boolean;
  menus?: { path: string; menu?: string; description?: string }[];
};
type StoreList = {
  plugins: Plugin[];
  source_errors?: { message?: string; source_name?: string }[];
};
const repositoryURL = (p: Plugin) =>
  safeLink(
    p.repository?.includes("://")
      ? p.repository
      : p.repository
        ? `https://github.com/${p.repository}`
        : p.homepage,
  );

export function PluginsPage() {
  const [tab, setTab] = useState("installed");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Plugin>();
  const [install, setInstall] = useState<Plugin>();
  const [version, setVersion] = useState("");
  const installed = useResource<PluginList>("plugins", () =>
    mgmt.get("/plugins"),
  );
  const store = useResource<StoreList>(
    "plugin-store",
    () => mgmt.get("/plugins/store"),
    0,
    tab === "store",
  );
  const task = useTask();
  const plugins: Plugin[] =
    (tab === "store" ? store.data?.plugins : installed.data?.plugins) ?? [];
  const source = tab === "store" ? store : installed;
  return (
    <>
      <PageHeader
        title="Plugins"
        description="Manage installed extensions and discover providers in your configured stores."
        actions={
          <Button
            icon={<RefreshCw />}
            busy={source.loading}
            onClick={() => void source.refresh()}
          >
            Refresh
          </Button>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        label="Plugin pages"
        tabs={[
          {
            value: "installed",
            label: "Installed",
            count: installed.data?.plugins.length,
          },
          { value: "store", label: "Plugin store" },
          { value: "settings", label: "Plugin settings" },
        ]}
      />
      {tab === "settings" ? (
        <ConfigEditor
          path={["plugins"]}
          title="Plugin settings"
          description="Global enablement, directories, store sources, and plugin configuration."
        />
      ) : (
        <>
          {source.error && (
            <ErrorNote
              error={source.error}
              onRetry={() => void source.refresh()}
            />
          )}
          {installed.data && !installed.data.plugins_enabled && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4">
              <p className="text-[12px] text-fg-2">
                Plugins are disabled globally. Installed plugins need global
                enablement and may require a server restart.
              </p>
              <Button
                size="sm"
                busy={task.busy}
                onClick={() =>
                  void task.run(async () => {
                    await mgmt.put("/config/plugins/enabled", true);
                    await installed.refresh();
                    await configChanged();
                  }, "Plugins enabled")
                }
              >
                Enable plugins
              </Button>
            </div>
          )}
          {tab === "store" &&
            store.data?.source_errors?.map((e, i) => (
              <ErrorNote
                key={i}
                error={`${e.source_name || "Store"}: ${e.message || "Could not load source"}`}
              />
            ))}
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search plugins…"
          />
          {!source.updatedAt && source.loading ? (
            <Skeleton className="h-48" />
          ) : !plugins.length ? (
            <Panel>
              <EmptyState
                title={
                  tab === "store" ? "No store entries" : "No installed plugins"
                }
                action={
                  <Button
                    onClick={() =>
                      setTab(tab === "store" ? "settings" : "store")
                    }
                  >
                    {tab === "store"
                      ? "Configure store sources"
                      : "Browse plugin store"}
                  </Button>
                }
              >
                Connect providers and other extensions from your configured
                plugin stores.
              </EmptyState>
            </Panel>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {plugins
                .filter((p) =>
                  `${p.id} ${p.name} ${p.metadata?.name ?? ""} ${p.description ?? ""}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((p) => (
                  <Panel
                    key={p.store_id || `${p.source_id || ""}:${p.id}`}
                    bodyClassName="space-y-4 p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h2 className="truncate text-[14px] font-semibold">
                          {p.name || p.metadata?.name || p.id}
                        </h2>
                        <p className="mt-1 text-[12px] text-fg-3">
                          {p.version ||
                            p.metadata?.version ||
                            "Version unknown"}
                          {p.source_name && ` · ${p.source_name}`}
                        </p>
                      </div>
                      {tab === "installed" ? (
                        <Switch
                          label={`Enable ${p.id}`}
                          checked={p.enabled !== false}
                          busy={task.busy}
                          onChange={(enabled) =>
                            void task.run(
                              async () => {
                                await mgmt.put(
                                  `/config/plugins/configs/${encodeURIComponent(p.id)}/enabled`,
                                  enabled,
                                );
                                await installed.refresh();
                                await configChanged();
                              },
                              enabled ? "Plugin enabled" : "Plugin disabled",
                            )
                          }
                        />
                      ) : p.installed ? (
                        <Badge>
                          {p.update_available
                            ? "Update available"
                            : "Installed"}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="max-w-[65ch] text-[12px] text-fg-2">
                      {p.description ||
                        p.metadata?.description ||
                        (tab === "installed"
                          ? `${p.registered ? "Registered" : "Restart may be required"} · ${p.effective_enabled ? "Active" : "Inactive"}`
                          : p.id)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {tab === "installed" ? (
                        <>
                          <Button size="sm" onClick={() => setSelected(p)}>
                            Configure
                          </Button>
                          {p.supports_oauth && (
                            <a
                              className="inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-[12px]"
                              href={href("sign-in", {
                                provider: p.oauth_provider || p.id,
                              })}
                            >
                              Sign in
                            </a>
                          )}
                          <Button
                            size="sm"
                            variant="danger"
                            busy={task.busy}
                            onClick={async () => {
                              if (
                                !(await confirmAction({
                                  title: "Delete plugin?",
                                  body: `${p.id} and its configuration will be removed. A server restart may be required.`,
                                  confirmLabel: "Delete plugin",
                                  danger: true,
                                }))
                              )
                                return;
                              await task.run(async () => {
                                const result = await mgmt.del<{
                                  restart_required?: boolean;
                                }>(`/plugins/${encodeURIComponent(p.id)}`);
                                if (result.restart_required)
                                  toast("Restart required", {
                                    description:
                                      "Restart VPXY to unload the plugin.",
                                    tone: "info",
                                  });
                                await installed.refresh();
                                await store.refresh();
                              }, "Plugin deleted");
                            }}
                          >
                            Delete
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => {
                            setInstall(p);
                            setVersion(p.version || "");
                          }}
                        >
                          {p.installed ? "Update / choose version" : "Install"}
                        </Button>
                      )}
                      {repositoryURL(p) && (
                        <a
                          href={repositoryURL(p)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 px-1 text-[12px] text-fg-2 hover:text-fg"
                        >
                          Repository
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  </Panel>
                ))}
            </div>
          )}
        </>
      )}
      <Dialog
        open={!!selected}
        onClose={() => setSelected(undefined)}
        title={selected?.metadata?.name || selected?.id || "Plugin"}
        sheet
      >
        {selected && (
          <div className="space-y-5">
            <ConfigEditor
              key={selected.id}
              path={["plugins", "configs", selected.id]}
              title="Plugin configuration"
              description="Use the plugin’s documented configuration fields."
            />
            {selected.supports_quota && <PluginQuota plugin={selected} />}
            {selected.menus?.length ? (
              <Panel title="Plugin pages" bodyClassName="space-y-3 p-4">
                {selected.menus.map((menu, i) => {
                  let link: string | undefined;
                  try {
                    link = safeLink(new URL(menu.path, location.origin).href);
                  } catch {}
                  return (
                    link && (
                      <a
                        key={i}
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 text-accent hover:underline"
                      >
                        {menu.menu || menu.description || `Page ${i + 1}`}
                        <ExternalLink className="size-3" />
                      </a>
                    )
                  );
                })}
              </Panel>
            ) : null}
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!install}
        onClose={() => setInstall(undefined)}
        title={`Install ${install?.name || install?.id || "plugin"}`}
      >
        <div className="space-y-4">
          <TextField
            label="Version"
            value={version}
            onChange={setVersion}
            hint="Leave blank to install the store’s current version."
          />
          {task.error && <ErrorNote error={task.error} />}
          <Button
            variant="primary"
            busy={task.busy}
            onClick={() =>
              void task.run(async () => {
                if (!install) return;
                const result = await mgmt.post<{ restart_required?: boolean }>(
                  `/plugins/store/${encodeURIComponent(install.id)}/install`,
                  version ? { version } : {},
                  { source: install.source_id, version: version || undefined },
                );
                if (result.restart_required)
                  toast("Restart required", {
                    description: "Restart VPXY to load the installed plugin.",
                    tone: "info",
                  });
                setInstall(undefined);
                await Promise.all([installed.refresh(), store.refresh()]);
              }, "Plugin installed")
            }
          >
            Install plugin
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function PluginQuota({ plugin }: { plugin: Plugin }) {
  const files = useResource<CredentialList>("credentials", () =>
    mgmt.get("/credentials"),
  );
  const [authIndex, setAuthIndex] = useState("");
  const [result, setResult] = useState<unknown>();
  const task = useTask();
  return (
    <Panel title="Plugin quota" bodyClassName="space-y-3 p-4">
      <Field label="Credential">
        {(id) => (
          <Select
            id={id}
            value={authIndex}
            onChange={(e) => setAuthIndex(e.target.value)}
          >
            <option value="">Choose credential</option>
            {files.data?.files
              .filter((f) => f.auth_index)
              .map((f) => (
                <option key={f.name} value={f.auth_index}>
                  {f.name}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!authIndex}
          busy={task.busy}
          onClick={() =>
            void task.run(async () =>
              setResult(
                await mgmt.post(
                  `/plugins/${encodeURIComponent(plugin.id)}/quota`,
                  { auth_index: authIndex },
                ),
              ),
            )
          }
        >
          Fetch quota
        </Button>
        <Button
          variant="danger"
          disabled={!authIndex || /claude|anthropic/i.test(plugin.id)}
          busy={task.busy}
          onClick={async () => {
            if (
              !(await confirmAction({
                title: "Reset plugin quota?",
                body: "The plugin may perform an upstream reset for this credential. This action cannot be undone.",
                confirmLabel: "Reset quota",
                danger: true,
              }))
            )
              return;
            await task.run(
              async () =>
                setResult(
                  await mgmt.del(
                    `/plugins/${encodeURIComponent(plugin.id)}/quota`,
                    { auth_index: authIndex },
                  ),
                ),
              "Plugin quota reset",
            );
          }}
        >
          Reset quota
        </Button>
      </div>
      {task.error && <ErrorNote error={task.error} />}
      {result !== undefined && (
        <pre className="max-h-80 overflow-auto font-mono text-[12px] whitespace-pre-wrap break-words">
          {pretty(result)}
        </pre>
      )}
    </Panel>
  );
}

export function SystemPage({ overview }: { overview?: Overview }) {
  const info = useStore(serverInfo);
  const [latest, setLatest] = useState<Record<string, unknown>>();
  const [tab, setTab] = useState("connection");
  const task = useTask();
  return (
    <>
      <PageHeader
        title="System"
        description="Server details, client setup, and authenticated upstream diagnostics."
        actions={
          <Button
            icon={<RefreshCw />}
            busy={task.busy}
            onClick={() =>
              void task.run(async () =>
                setLatest(await mgmt.get("/server/latest-version")),
              )
            }
          >
            Check for updates
          </Button>
        }
      />
      <Panel title="Server details" bodyClassName="p-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Version", info?.version || "Unknown"],
            ["Commit", info?.commit || "Unknown"],
            ["Build date", info?.buildDate || "Unknown"],
            ["Origin", typeof location === "undefined" ? "" : location.origin],
            ["Routing", overview?.routing.strategy || "Unknown"],
            [
              "Access",
              overview?.monitor.trusted_networks
                ? "Trusted networks enabled"
                : "Management key",
            ],
          ].map(([key, value]) => (
            <div key={key}>
              <dt className="text-[12px] text-fg-3">{key}</dt>
              <dd className="mt-1 break-all text-[12px]">{value}</dd>
            </div>
          ))}
        </dl>
        {latest && (
          <pre className="mt-4 overflow-auto border-t border-line pt-4 text-[12px] whitespace-pre-wrap">
            {pretty(latest)}
          </pre>
        )}
        {task.error && <ErrorNote error={task.error} />}
      </Panel>
      <Tabs
        value={tab}
        onChange={setTab}
        label="System tools"
        tabs={[
          { value: "connection", label: "Client setup" },
          { value: "api", label: "Upstream API call" },
          { value: "queue", label: "Usage queue" },
        ]}
      />
      {tab === "connection" ? (
        <ClientSetup />
      ) : tab === "api" ? (
        <APICall />
      ) : (
        <UsageQueue />
      )}
    </>
  );
}

function ClientSetup() {
  const base =
    typeof location === "undefined" ? "http://localhost:8317" : location.origin;
  return (
    <div className="space-y-5">
      {[
        {
          title: "Claude Code",
          text: `export ANTHROPIC_BASE_URL=${JSON.stringify(base)}\n# Outside trusted networks, set your client access key:\n# export ANTHROPIC_AUTH_TOKEN=\"<client-access-key>\"`,
        },
        {
          title: "Codex",
          text: `# ~/.codex/config.toml\nopenai_base_url = ${JSON.stringify(`${base}/backend-api/codex`)}\n\n# Built-in provider retains WebSocket support.\n# Custom provider alternative:\n# base_url = ${JSON.stringify(`${base}/v1`)}\n# wire_api = \"responses\"\n# supports_websockets = true`,
        },
        {
          title: "OpenAI-compatible clients",
          text: `Base URL: ${base}/v1\nAPI key: your configured client access key\nModels: ${base}/v1/models`,
        },
      ].map((item) => (
        <Panel
          key={item.title}
          title={item.title}
          actions={
            <Button
              size="sm"
              icon={<Copy />}
              onClick={() => void copyText(item.text, "Client setup copied")}
            >
              Copy
            </Button>
          }
          bodyClassName="p-4"
        >
          <pre className="overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap break-words">
            {item.text}
          </pre>
        </Panel>
      ))}
    </div>
  );
}

function APICall() {
  const [method, setMethod] = useState("GET");
  const [url, setURL] = useState("");
  const [authIndex, setAuthIndex] = useState("");
  const [proxy, setProxy] = useState("");
  const [header, setHeader] = useState(
    '{\n  "Authorization": "Bearer $TOKEN$"\n}',
  );
  const [body, setBody] = useState("");
  const [response, setResponse] = useState<unknown>();
  const files = useResource<CredentialList>("credentials", () =>
    mgmt.get("/credentials"),
  );
  const task = useTask();
  return (
    <Panel
      title="Upstream API call"
      description="Send a request from the proxy server. $TOKEN$ is replaced with the selected credential’s token."
      bodyClassName="space-y-4 p-4"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void task.run(async () => {
            const target = new URL(url);
            if (!["https:", "http:"].includes(target.protocol))
              throw new Error("Use an HTTP or HTTPS URL.");
            setResponse(
              await mgmt.post("/requests/api-call", {
                method,
                url,
                authIndex: authIndex || undefined,
                proxy_url: proxy || undefined,
                header: parseJSON(header, "object"),
                ...(body ? { data: body } : {}),
              }),
            );
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[100px_1fr]">
          <Field label="Method">
            {(id) => (
              <Select
                id={id}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            )}
          </Field>
          <TextField
            label="URL"
            type="url"
            value={url}
            onChange={setURL}
            required
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Credential">
            {(id) => (
              <Select
                id={id}
                value={authIndex}
                onChange={(e) => setAuthIndex(e.target.value)}
              >
                <option value="">No credential</option>
                {files.data?.files
                  .filter((f) => f.auth_index)
                  .map((f) => (
                    <option key={f.name} value={f.auth_index}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <TextField
            label="Proxy URL (optional)"
            value={proxy}
            onChange={setProxy}
          />
        </div>
        <JSONInput
          label="Headers"
          value={header}
          onChange={setHeader}
          rows={5}
        />
        <Field label="Request body (optional)">
          {(id) => (
            <Textarea
              id={id}
              className="font-mono text-[12px]"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
            />
          )}
        </Field>
        {task.error && <ErrorNote error={task.error} />}
        <Button
          variant="primary"
          type="submit"
          icon={<Send />}
          busy={task.busy}
          disabled={!url.trim()}
        >
          Send request
        </Button>
      </form>
      {response !== undefined && (
        <div className="space-y-2 border-t border-line pt-4">
          <h3 className="font-medium">Response</h3>
          <pre className="max-h-[60dvh] overflow-auto rounded-md bg-canvas p-3 font-mono text-[12px] whitespace-pre-wrap break-words">
            {pretty(response)}
          </pre>
        </div>
      )}
    </Panel>
  );
}

function UsageQueue() {
  const [count, setCount] = useState("20");
  const [events, setEvents] = useState<unknown>();
  const task = useTask();
  return (
    <Panel
      title="Usage queue"
      description="Reading this queue consumes its oldest records. Use this for diagnostics when no other consumer needs them."
      bodyClassName="space-y-4 p-4"
    >
      <TextField
        type="number"
        label="Records to consume"
        value={count}
        onChange={setCount}
      />
      <Button
        busy={task.busy}
        onClick={async () => {
          if (
            !(await confirmAction({
              title: "Consume queued usage records?",
              body: `Remove up to ${count} oldest usage events from the server queue and display them here.`,
              confirmLabel: "Consume records",
            }))
          )
            return;
          await task.run(async () => {
            const n = Number(count);
            if (!Number.isInteger(n) || n <= 0)
              throw new Error("Enter a positive whole number.");
            setEvents(
              await mgmt.get("/observability/usage/queue", { count: n }),
            );
          });
        }}
      >
        Consume records
      </Button>
      {task.error && <ErrorNote error={task.error} />}
      {events !== undefined && (
        <pre className="max-h-[60dvh] overflow-auto font-mono text-[12px] whitespace-pre-wrap break-words">
          {pretty(events)}
        </pre>
      )}
    </Panel>
  );
}
