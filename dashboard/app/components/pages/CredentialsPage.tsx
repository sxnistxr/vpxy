import {
  Download,
  FileJson,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, apiText, MGMT, mgmt, saveBlob, send } from "$lib/api";
import { confirmAction } from "$lib/feedback";
import { ago, maskLabel, parseTime, tokens } from "$lib/format";
import { parseJSON, pretty, useTask } from "$lib/management";
import type { Credential, CredentialList, ModelInfo } from "$lib/mgmt-types";
import { revalidate, useResource } from "$lib/resource";
import { href, navigate } from "$lib/router";
import { JSONInput } from "../editors";
import { Dialog, SearchInput } from "../overlays";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  IconButton,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  StatusPill,
  Tabs,
  Th,
} from "../ui";
import { ProviderLogo, providerTitle } from "./MonitorPages";

const status = (f: Credential) =>
  f.disabled
    ? "Disabled"
    : f.requires_sign_in
      ? "Sign in needed"
      : f.quota_blocked
        ? "Limited"
        : f.unavailable
          ? "Unavailable"
          : f.cooldowns?.length
            ? "Cooling down"
            : "Ready";
const tone = (f: Credential) =>
  f.disabled
    ? ("neutral" as const)
    : f.requires_sign_in || f.unavailable
      ? ("danger" as const)
      : f.quota_blocked || f.cooldowns?.length
        ? ("warn" as const)
        : ("ok" as const);
const identity = (f: Credential, show: boolean) =>
  show
    ? f.email || f.display_name || f.name
    : maskLabel(f.email || f.display_name || f.name);
const filename = (f: Credential) => f.name || f.id;
const download = async (f: Credential) =>
  saveBlob(
    await (
      await send(MGMT + "/credentials/download", {
        query: { name: filename(f) },
      })
    ).blob(),
    filename(f),
  );

export function CredentialsPage({
  params,
  showEmails,
}: {
  params: URLSearchParams;
  showEmails: boolean;
}) {
  const resource = useResource<CredentialList>(
    "credentials",
    () => mgmt.get("/credentials"),
    30_000,
  );
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [state, setState] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(0);
  const [inspect, setInspect] = useState<string>();
  const upload = useRef<HTMLInputElement>(null);
  const task = useTask();
  const files = resource.data?.files ?? [];
  const current = files.find(
    (f) => filename(f) === inspect || f.id === inspect,
  );
  useEffect(() => {
    if (params.get("name")) setInspect(params.get("name")!);
  }, [params.toString()]);
  useEffect(() => setPage(0), [search, provider, state, sort]);
  useEffect(() => {
    setSelected(
      (prev) =>
        new Set(
          [...prev].filter((name) => files.some((f) => filename(f) === name)),
        ),
    );
  }, [resource.updatedAt]);
  async function changed() {
    await Promise.all([resource.refresh(), revalidate("overview")]);
  }
  const filtered = files
    .filter(
      (f) =>
        (provider === "all" || (f.provider || f.type) === provider) &&
        (state === "all" || status(f) === state) &&
        `${f.email ?? ""} ${f.name} ${f.type} ${f.note ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "status"
        ? status(a).localeCompare(status(b))
        : sort === "priority"
          ? (b.priority ?? 0) - (a.priority ?? 0)
          : filename(a).localeCompare(filename(b)),
    );
  const visible = filtered.slice(page * 25, page * 25 + 25);
  const selectedFiles = files.filter((f) => selected.has(filename(f)));
  const writable = selectedFiles.filter((f) => !f.runtime_only);
  async function batch(
    action: "enable" | "disable" | "refresh" | "delete" | "download",
  ) {
    if (!selectedFiles.length) return;
    if (
      action === "delete" &&
      !(await confirmAction({
        title: `Delete ${writable.length} credentials?`,
        body: writable.map(filename).join(", "),
        confirmLabel: "Delete credentials",
        danger: true,
      }))
    )
      return;
    await task.run(async () => {
      const failures: string[] = [];
      for (const f of action === "download" ? selectedFiles : writable) {
        try {
          if (action === "delete")
            await mgmt.del("/credentials", undefined, { names: [filename(f)] });
          else if (action === "download") await download(f);
          else if (action === "refresh")
            await mgmt.post("/credentials/refresh", {
              name: filename(f),
              auth_index: f.auth_index,
            });
          else
            await mgmt.patch("/credentials/status", {
              name: filename(f),
              auth_index: f.auth_index,
              disabled: action === "disable",
            });
        } catch (err) {
          failures.push(
            `${filename(f)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await changed();
      setSelected(new Set());
      if (failures.length) throw new Error(failures.join("; "));
    }, "Credential action completed");
  }
  return (
    <>
      <PageHeader
        title="Credentials"
        description="Manage accounts, recover sign-ins, and inspect their live routing state."
        actions={
          <>
            <Button
              icon={<Upload />}
              busy={task.busy}
              onClick={() => upload.current?.click()}
            >
              Import JSON
            </Button>
            <a
              href={href("sign-in")}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-on-primary"
            >
              <Plus className="size-4" />
              Connect account
            </a>
          </>
        }
      />
      <input
        ref={upload}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(e) => {
          const input = e.currentTarget;
          const chosen = Array.from(input.files ?? []);
          if (!chosen.length) return;
          void task.run(async () => {
            const form = new FormData();
            chosen.forEach((f) => form.append("file", f, f.name));
            const result = await api<{
              failed?: { name: string; error: string }[];
            }>(MGMT + "/credentials", { form });
            await changed();
            if (result.failed?.length)
              throw new Error(
                result.failed.map((f) => `${f.name}: ${f.error}`).join("; "),
              );
          }, "Credentials imported");
          input.value = "";
        }}
      />
      {resource.error && (
        <ErrorNote
          error={resource.error}
          onRetry={() => void resource.refresh()}
        />
      )}
      <Panel
        title="All credentials"
        actions={
          <Button
            size="sm"
            icon={<RefreshCw />}
            busy={resource.loading}
            onClick={() => void resource.refresh()}
          >
            Refresh list
          </Button>
        }
      >
        <div className="flex flex-wrap gap-3 border-b border-line p-3">
          <div className="min-w-[160px] flex-1">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search credentials…"
            />
          </div>
          <Select
            aria-label="Provider"
            className="w-auto"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="all">All providers</option>
            {[...new Set(files.map((f) => f.provider || f.type || "unknown"))]
              .sort()
              .map((p) => (
                <option key={p} value={p}>
                  {providerTitle(p)}
                </option>
              ))}
          </Select>
          <Select
            aria-label="Status"
            className="w-auto"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="all">All statuses</option>
            {[...new Set(files.map(status))].sort().map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Select
            aria-label="Sort credentials"
            className="w-auto"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="name">Name</option>
            <option value="status">Status</option>
            <option value="priority">Priority</option>
          </Select>
        </div>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span className="mr-2 text-[12px]">{selected.size} selected</span>
            {(
              ["enable", "disable", "refresh", "download", "delete"] as const
            ).map((action) => (
              <Button
                key={action}
                variant={action === "delete" ? "danger" : "ghost"}
                size="sm"
                busy={task.busy}
                onClick={() => void batch(action)}
              >
                {action.charAt(0).toUpperCase() + action.slice(1)}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </Button>
          </div>
        )}
        {!resource.updatedAt && resource.loading ? (
          <div className="space-y-3 p-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : filtered.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[12px]">
                <thead className="border-b border-line bg-rail">
                  <tr>
                    <Th>
                      <Checkbox
                        aria-label="Select visible credentials"
                        checked={
                          visible.length > 0 &&
                          visible.every((f) => selected.has(filename(f)))
                        }
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            visible.forEach((f) =>
                              e.target.checked
                                ? next.add(filename(f))
                                : next.delete(filename(f)),
                            );
                            return next;
                          })
                        }
                      />
                    </Th>
                    <Th>Account</Th>
                    <Th>Provider</Th>
                    <Th>Status</Th>
                    <Th align="right">Priority</Th>
                    <Th align="right">Success / failure</Th>
                    <Th>Last refresh</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {visible.map((f) => (
                    <tr
                      key={`${f.id}-${f.name}`}
                      className="hover:bg-surface-2"
                    >
                      <td className="px-3 py-3">
                        <Checkbox
                          aria-label={`Select ${identity(f, showEmails)}`}
                          checked={selected.has(filename(f))}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              e.target.checked
                                ? next.add(filename(f))
                                : next.delete(filename(f));
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="max-w-[220px] px-3 py-3">
                        <button
                          className="block w-full truncate text-left font-medium hover:text-accent"
                          onClick={() => setInspect(filename(f))}
                        >
                          {identity(f, showEmails)}
                        </button>
                        <p className="mt-0.5 truncate text-[11px] text-fg-3">
                          {showEmails ? filename(f) : maskLabel(filename(f))}
                          {f.runtime_only && " · runtime"}
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <ProviderLogo
                            provider={f.provider || f.type || "unknown"}
                          />
                          {providerTitle(f.provider || f.type || "unknown")}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <StatusPill tone={tone(f)}>{status(f)}</StatusPill>
                      </td>
                      <td className="px-3 py-3 text-right">
                        {f.priority ?? 0}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="text-ok">
                          {tokens(f.success ?? 0)}
                        </span>{" "}
                        /{" "}
                        <span className="text-fg-3">
                          {tokens(f.failed ?? 0)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-fg-3">
                        {parseTime(f.last_refresh)
                          ? ago(new Date(f.last_refresh!), new Date())
                          : "—"}
                      </td>
                      <td className="px-3 py-3">
                        <Button
                          size="sm"
                          onClick={() => setInspect(filename(f))}
                        >
                          Manage
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line p-3 text-[12px] text-fg-2">
              <span>
                {page * 25 + 1}–{Math.min((page + 1) * 25, filtered.length)} of{" "}
                {filtered.length}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  disabled={(page + 1) * 25 >= filtered.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            title={
              files.length ? "No matching credentials" : "No credentials yet"
            }
            action={
              <a className="text-accent hover:underline" href={href("sign-in")}>
                Connect an account
              </a>
            }
          >
            {files.length
              ? "Change your search or filters."
              : "Sign in with OAuth or import credential JSON files."}
          </EmptyState>
        )}
      </Panel>
      <CredentialSheet
        key={current?.id || current?.name || "closed"}
        file={current}
        onClose={() => setInspect(undefined)}
        changed={changed}
        show={showEmails}
      />
    </>
  );
}

function CredentialSheet({
  file,
  onClose,
  changed,
  show,
}: {
  file?: Credential;
  onClose: () => void;
  changed: () => Promise<void>;
  show: boolean;
}) {
  const [tab, setTab] = useState("status");
  const [fields, setFields] = useState(() =>
    pretty({
      priority: file?.priority ?? 0,
      note: file?.note ?? "",
      ...(file?.websockets === undefined
        ? {}
        : { websockets: file.websockets }),
    }),
  );
  const [raw, setRaw] = useState<string>();
  const [rawBaseline, setRawBaseline] = useState<string>();
  const [models, setModels] = useState<ModelInfo[]>();
  const task = useTask();
  if (!file) return null;
  const f = file;
  const name = filename(f);
  async function action(taskFn: () => Promise<unknown>, success: string) {
    await task.run(async () => {
      await taskFn();
      await changed();
    }, success);
  }
  return (
    <Dialog
      open
      title={identity(f, show)}
      description={show ? name : "Credential details and recovery"}
      onClose={onClose}
      sheet
    >
      <Tabs
        value={tab}
        onChange={setTab}
        label="Credential details"
        tabs={[
          { value: "status", label: "Status" },
          { value: "fields", label: "Settings" },
          { value: "models", label: "Models" },
          { value: "json", label: "File JSON" },
        ]}
      />
      <div className="mt-5 space-y-5">
        {task.error && <ErrorNote error={task.error} />}
        {tab === "status" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={tone(f)}>{status(f)}</StatusPill>
              <Badge>{providerTitle(f.provider || f.type || "unknown")}</Badge>
              {f.account_type && <Badge>{f.account_type}</Badge>}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-[12px]">
              {Object.entries({
                Recovery: f.recovery_hint || f.status_message,
                "Renewal state": f.renewal_state,
                "Next action": f.next_action,
                "Token expiry": f.access_token_expires_at,
                "Last refresh": f.last_refresh,
                "Refresh error": f.refresh_error?.message,
                Note: f.note,
              })
                .filter(([, value]) => !!value)
                .map(([key, value]) => (
                  <div className="contents" key={key}>
                    <dt className="text-fg-3">{key}</dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                busy={task.busy}
                onClick={() =>
                  void action(
                    () =>
                      mgmt.patch("/credentials/status", {
                        name,
                        auth_index: f.auth_index,
                        disabled: !f.disabled,
                      }),
                    f.disabled ? "Credential enabled" : "Credential disabled",
                  )
                }
              >
                {f.disabled ? "Enable" : "Disable"}
              </Button>
              <Button
                busy={task.busy}
                icon={<RefreshCw />}
                onClick={() =>
                  void action(
                    () =>
                      mgmt.post("/credentials/refresh", {
                        name,
                        auth_index: f.auth_index,
                      }),
                    "Token refreshed",
                  )
                }
              >
                Refresh token
              </Button>
              <Button
                onClick={() =>
                  navigate("sign-in", {
                    provider: f.provider || f.type || "codex",
                    name,
                  })
                }
              >
                Sign in again
              </Button>
              <Button
                busy={task.busy}
                onClick={async () => {
                  if (
                    await confirmAction({
                      title: "Verify this account?",
                      body: "Send an isolated, account-pinned inference request with a minimal prompt and one output token.",
                      confirmLabel: "Run verification",
                    })
                  )
                    await action(
                      () => mgmt.post("/credentials/verify", { name }),
                      "Verification completed",
                    );
                }}
              >
                Verify inference
              </Button>
            </div>
            {f.cooldowns?.length ? (
              <Panel title="Cooldowns">
                <ul className="divide-y divide-line">
                  {f.cooldowns.map((c, i) => (
                    <li key={i} className="space-y-1 p-3 text-[12px]">
                      <p>
                        {c.model_key || "Whole credential"}{" "}
                        <span className="text-warn">{c.reason}</span>
                      </p>
                      <p className="text-fg-3">
                        Retry {new Date(c.retry_at).toLocaleString()}
                        {c.http_status && ` · HTTP ${c.http_status}`}
                      </p>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-line p-3">
                  <Button
                    disabled={!f.auth_index}
                    busy={task.busy}
                    onClick={() =>
                      void action(
                        () =>
                          mgmt.post("/routing/cooldown/reset", {
                            auth_index: f.auth_index,
                          }),
                        "Cooldown cleared",
                      )
                    }
                  >
                    Clear cooldown
                  </Button>
                </div>
              </Panel>
            ) : null}
            {f.siwc_bind_supported && (
              <Panel title="Sign in with ChatGPT" bodyClassName="space-y-3 p-3">
                <p className="text-[12px] text-fg-2">
                  {f.siwc_bound
                    ? "A ChatGPT sign-in is bound to this credential."
                    : "Bind a ChatGPT sign-in to this Codex credential."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() =>
                      navigate("sign-in", {
                        provider: "codex",
                        name,
                        bind: "true",
                      })
                    }
                  >
                    {f.siwc_bound ? "Bind again" : "Bind sign-in"}
                  </Button>
                  <Button
                    busy={task.busy}
                    onClick={() =>
                      void action(
                        () =>
                          mgmt.patch("/credentials/fields", {
                            name,
                            use_siwc: !f.use_siwc,
                          }),
                        f.use_siwc
                          ? "ChatGPT sign-in disabled"
                          : "ChatGPT sign-in enabled",
                      )
                    }
                  >
                    {f.use_siwc ? "Use Codex tokens" : "Use ChatGPT sign-in"}
                  </Button>
                </div>
              </Panel>
            )}
            {!f.runtime_only && (
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <Button
                  icon={<Download />}
                  busy={task.busy}
                  onClick={() =>
                    void task.run(() => download(f), "Credential downloaded")
                  }
                >
                  Download JSON
                </Button>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  busy={task.busy}
                  onClick={async () => {
                    if (
                      !(await confirmAction({
                        title: "Delete credential?",
                        body: name,
                        confirmLabel: "Delete credential",
                        danger: true,
                      }))
                    )
                      return;
                    if (
                      await task.run(async () => {
                        await mgmt.del("/credentials", undefined, {
                          names: [name],
                        });
                        await changed();
                      }, "Credential deleted")
                    )
                      onClose();
                  }}
                >
                  Delete credential
                </Button>
              </div>
            )}
          </>
        )}
        {tab === "fields" && (
          <>
            <p className="text-[12px] text-fg-2">
              Change priority, weight, note, prefix, proxy_url, headers,
              excluded_models, request_retry, websockets, disable_cooling, or
              use_siwc. Only the fields entered are patched.
            </p>
            <JSONInput
              value={fields}
              onChange={setFields}
              label="Credential fields"
            />
            <Button
              variant="primary"
              disabled={f.runtime_only}
              busy={task.busy}
              onClick={() =>
                void action(() => {
                  const parsed = parseJSON(fields, "object");
                  delete parsed.name;
                  return mgmt.patch("/credentials/fields", { ...parsed, name });
                }, "Credential settings saved")
              }
            >
              Save settings
            </Button>
            {f.runtime_only && (
              <p className="text-fg-3">
                Runtime credentials are managed by the storage backend.
              </p>
            )}
          </>
        )}
        {tab === "models" && (
          <>
            <Button
              busy={task.busy}
              onClick={() =>
                void task.run(async () => {
                  const response = await mgmt.get<{ models: ModelInfo[] }>(
                    "/credentials/models",
                    { name },
                  );
                  setModels(response.models ?? []);
                })
              }
            >
              Load supported models
            </Button>
            {models && (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {models.map((m) => (
                  <li key={m.id} className="break-words px-3 py-2 text-[12px]">
                    <p className="font-mono">{m.id}</p>
                    {m.display_name && (
                      <p className="text-fg-3">{m.display_name}</p>
                    )}
                  </li>
                ))}
                {!models.length && (
                  <li className="p-3 text-fg-3">
                    No models are registered for this credential.
                  </li>
                )}
              </ul>
            )}
          </>
        )}
        {tab === "json" && (
          <>
            <p className="text-[12px] text-fg-2">
              Credential files contain secrets. Open only when you need to
              inspect or repair the file.
            </p>
            {raw === undefined ? (
              <Button
                icon={<FileJson />}
                disabled={f.runtime_only}
                busy={task.busy}
                onClick={() =>
                  void task.run(async () => {
                    const text = await apiText(MGMT + "/credentials/download", {
                      query: { name },
                    });
                    setRaw(text);
                    setRawBaseline(text);
                  })
                }
              >
                Open credential JSON
              </Button>
            ) : (
              <>
                <JSONInput
                  value={raw}
                  onChange={setRaw}
                  label="Credential file (contains secrets)"
                  rows={20}
                />
                <Button
                  variant="primary"
                  busy={task.busy}
                  disabled={raw === rawBaseline}
                  onClick={async () => {
                    if (
                      !(await confirmAction({
                        title: "Replace credential file?",
                        body: name,
                        confirmLabel: "Replace file",
                        danger: true,
                      }))
                    )
                      return;
                    await task.run(async () => {
                      parseJSON(raw, "object");
                      const latest = await apiText(
                        MGMT + "/credentials/download",
                        { query: { name } },
                      );
                      if (latest !== rawBaseline)
                        throw new Error(
                          "The credential changed on the server. Close and reopen the file before saving.",
                        );
                      const form = new FormData();
                      form.append(
                        "file",
                        new File([raw], name, { type: "application/json" }),
                      );
                      await api(MGMT + "/credentials", { form });
                      setRawBaseline(raw);
                      await changed();
                    }, "Credential file replaced");
                  }}
                >
                  Replace file
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
