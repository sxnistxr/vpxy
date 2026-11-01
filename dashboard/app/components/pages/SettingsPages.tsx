import {
  Copy,
  Download,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  apiText,
  MGMT,
  mgmt,
  mgmtOptional,
  saveBlob,
  send,
} from "$lib/api";
import { confirmAction, copyText } from "$lib/feedback";
import { tokens } from "$lib/format";
import {
  configChanged,
  parseJSON,
  pretty,
  record,
  replaceConfig,
  useConfig,
  useTask,
  useUnsaved,
  words,
} from "$lib/management";
import type {
  CredentialList,
  ModelAlias,
  ModelInfo,
  RoutingConfig,
} from "$lib/mgmt-types";
import { useResource } from "$lib/resource";
import { href } from "$lib/router";
import { ConfigEditor, JSONInput, TextField } from "../editors";
import { Dialog, SearchInput } from "../overlays";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Input,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  StatusPill,
  Switch,
  Tabs,
  Textarea,
  Th,
} from "../ui";
import { providerTitle } from "./MonitorPages";

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div>
        <p className="font-medium">{label}</p>
        <p className="mt-1 max-w-[65ch] text-[12px] text-fg-3">{hint}</p>
      </div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

export function RoutingPage() {
  const config = useConfig();
  const credentials = useResource<CredentialList>(
    "credentials",
    () => mgmt.get("/credentials"),
    30_000,
  );
  const [draft, setDraft] = useState<RoutingConfig>();
  const [baseline, setBaseline] = useState<RoutingConfig>();
  const [section, setSection] = useState("settings");
  const task = useTask();
  useEffect(() => {
    if (config.data && (!draft || !dirty)) {
      setDraft(structuredClone(config.data.routing ?? {}));
      setBaseline(config.data.routing);
    }
  }, [config.updatedAt]);
  const dirty = !!draft && pretty(draft) !== pretty(baseline ?? {});
  useUnsaved(dirty);
  const update = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <>
      <PageHeader
        title="Routing"
        description="Spend expiring quota first and keep sessions bound to their prompt cache."
        actions={
          <Button
            variant="primary"
            icon={<Save />}
            busy={task.busy}
            disabled={!dirty}
            onClick={() =>
              void task.run(async () => {
                if (draft?.["session-affinity"]) {
                  const ttl = draft["session-affinity-ttl"] || "1h";
                  const matches = [...ttl.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
                  const seconds = matches.reduce(
                    (sum, m) =>
                      sum +
                      Number(m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2]] ?? 0),
                    0,
                  );
                  if (
                    matches.map((m) => m[0]).join("") !== ttl ||
                    seconds < 600
                  )
                    throw new Error(
                      "Use an idle TTL of at least 10 minutes, for example 15m or 1h.",
                    );
                }
                await replaceConfig(["routing"], baseline, draft);
                setBaseline(structuredClone(draft));
              }, "Routing settings saved")
            }
          >
            Save routing
          </Button>
        }
      />
      {config.error && (
        <ErrorNote error={config.error} onRetry={() => void config.refresh()} />
      )}
      {task.error && <ErrorNote error={task.error} />}
      <Tabs
        value={section}
        onChange={setSection}
        label="Routing pages"
        tabs={[
          { value: "settings", label: "Strategy and affinity" },
          { value: "members", label: "Priorities and weights" },
          { value: "advanced", label: "All routing options" },
        ]}
      />
      {!draft ? (
        <Skeleton className="h-80" />
      ) : section === "settings" ? (
        <>
          <Panel
            title="Selection strategy"
            bodyClassName="space-y-4 p-4 sm:p-5"
          >
            <Field label="Strategy">
              {(id) => (
                <Select
                  id={id}
                  value={draft.strategy ?? "round-robin"}
                  onChange={(e) => update("strategy", e.target.value)}
                >
                  <option value="expiration-first">Expiration first</option>
                  <option value="round-robin">Round robin</option>
                  <option value="weighted-round-robin">
                    Weighted round robin
                  </option>
                  <option value="fill-first">Fill first</option>
                </Select>
              )}
            </Field>
            <p className="max-w-[72ch] text-[12px] text-fg-2">
              Expiration first chooses the eligible account whose weekly window
              resets soonest. A 429 fails over to the next eligible account.
              Credential priority and model eligibility still apply.
            </p>
          </Panel>
          <Panel
            title="Session affinity"
            bodyClassName="divide-y divide-line px-4 sm:px-5"
          >
            <ToggleRow
              label="Keep sessions on one account"
              hint="Sliding idle expiration preserves the account’s prompt cache between requests."
              checked={draft["session-affinity"] ?? false}
              onChange={(v) => update("session-affinity", v)}
            />
            <div className="grid gap-4 py-4 sm:grid-cols-2">
              <TextField
                label="Idle TTL"
                value={draft["session-affinity-ttl"] ?? "1h"}
                onChange={(v) => update("session-affinity-ttl", v)}
                hint="At least 10 minutes; recommended 15m."
              />
              <Field label="Rebind policy">
                {(id) => (
                  <Select
                    id={id}
                    value={draft["session-affinity-rebind-on"] ?? "any"}
                    onChange={(e) =>
                      update("session-affinity-rebind-on", e.target.value)
                    }
                  >
                    <option value="quota">
                      Quota and authentication failures
                    </option>
                    <option value="any">Any credential failure</option>
                  </Select>
                )}
              </Field>
            </div>
            <ToggleRow
              label="Keep child sessions with their parent"
              hint="Reuse the parent account for compatible child sessions."
              checked={draft["session-affinity-subagents"] !== false}
              onChange={(v) => update("session-affinity-subagents", v)}
            />
            <ToggleRow
              label="Require model prefixes"
              hint="Unprefixed requests use only credentials without a prefix, with the server’s model-name exception."
              checked={draft["force-model-prefix"] ?? false}
              onChange={(v) => update("force-model-prefix", v)}
            />
          </Panel>
          <Panel
            title="Retries and cooling"
            bodyClassName="space-y-4 p-4 sm:p-5"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              {(
                [
                  ["request-retry", "Additional retry rounds", 3],
                  ["max-retry-credentials", "Credentials per round", 0],
                  ["max-retry-interval", "Maximum wait (seconds)", 30],
                ] as const
              ).map(([key, label, fallback]) => (
                <TextField
                  key={key}
                  label={label}
                  type="number"
                  value={draft.retry?.[key] ?? fallback}
                  onChange={(v) =>
                    update("retry", { ...draft.retry, [key]: Number(v) })
                  }
                />
              ))}
            </div>
            <ToggleRow
              label="Disable cooldown scheduling"
              hint="Allow immediate retries instead of observing account and model cooldowns."
              checked={draft.cooldown?.["disable-cooling"] ?? false}
              onChange={(v) =>
                update("cooldown", { ...draft.cooldown, "disable-cooling": v })
              }
            />
            <ToggleRow
              label="Persist cooldowns"
              hint="Keep cooldown state across server restarts."
              checked={draft.cooldown?.["save-cooldown-status"] ?? false}
              onChange={(v) =>
                update("cooldown", {
                  ...draft.cooldown,
                  "save-cooldown-status": v,
                })
              }
            />
          </Panel>
        </>
      ) : section === "members" ? (
        <Panel
          title="Credential priorities and weights"
          description="Higher priorities are considered first. Weights apply to weighted round robin; existing session bindings keep their account."
        >
          {credentials.error && <ErrorNote error={credentials.error} />}
          <div className="divide-y divide-line">
            {credentials.data?.files.map((f) => (
              <RoutingMember
                key={f.name}
                file={f}
                onSaved={credentials.refresh}
              />
            ))}
          </div>
          {!credentials.data?.files.length && (
            <EmptyState title="No credentials">
              Connect an account to tune its priority.
            </EmptyState>
          )}
          <p className="border-t border-line p-4 text-[12px] text-fg-3">
            API-key group and key priorities, weights, prefixes, and model
            eligibility are editable in{" "}
            <a href={href("providers")} className="text-accent hover:underline">
              Providers
            </a>
            .
          </p>
        </Panel>
      ) : (
        <ConfigEditor
          path={["routing"]}
          title="All routing options"
          description="Edit the complete routing object, including provider-specific retry and cooldown options."
        />
      )}
      {dirty && (
        <p className="text-[12px] text-warn">
          You have unsaved routing changes.
        </p>
      )}
    </>
  );
}

function RoutingMember({
  file,
  onSaved,
}: {
  file: CredentialList["files"][number];
  onSaved: () => Promise<void>;
}) {
  const [priority, setPriority] = useState(file.priority ?? 0);
  const [weight, setWeight] = useState(
    String((file as unknown as { weight?: number }).weight ?? ""),
  );
  const task = useTask();
  return (
    <div className="flex flex-wrap items-end gap-3 p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{file.name}</p>
        <p className="text-[12px] text-fg-3">
          {providerTitle(file.provider || file.type || "unknown")}
        </p>
      </div>
      <div className="w-24">
        <TextField
          label="Priority"
          type="number"
          value={priority}
          onChange={(v) => setPriority(Number(v))}
        />
      </div>
      <div className="w-24">
        <TextField
          label="Weight"
          type="number"
          value={weight}
          onChange={setWeight}
          hint="Blank = default"
        />
      </div>
      <Button
        disabled={file.runtime_only}
        busy={task.busy}
        onClick={() =>
          void task.run(async () => {
            await mgmt.patch("/credentials/fields", {
              name: file.name,
              priority,
              weight: weight === "" ? null : Number(weight),
            });
            await onSaved();
          }, "Routing member saved")
        }
      >
        Save
      </Button>
    </div>
  );
}

export function ModelsPage() {
  const [tab, setTab] = useState("catalog");
  return (
    <>
      <PageHeader
        title="Models"
        description="Inspect callable models and define aliases and exclusions for OAuth accounts."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        label="Model pages"
        tabs={[
          { value: "catalog", label: "Model catalog" },
          { value: "aliases", label: "OAuth aliases" },
          { value: "excluded", label: "OAuth exclusions" },
          { value: "catalog-settings", label: "Catalog sources" },
        ]}
      />
      {tab === "catalog" ? (
        <ModelCatalog />
      ) : tab === "catalog-settings" ? (
        <ConfigEditor
          path={["models"]}
          title="Model catalog sources"
          description="Configure the general, Codex, and Devin model catalog sources."
        />
      ) : (
        <OAuthModels key={tab} aliases={tab === "aliases"} />
      )}
    </>
  );
}

function ModelCatalog() {
  const config = useConfig();
  const files = useResource<CredentialList>("credentials", () =>
    mgmt.get("/credentials"),
  );
  const [source, setSource] = useState("registry");
  const [search, setSearch] = useState("");
  const resource = useResource<ModelInfo[]>(
    `models:${source}`,
    async () => {
      if (source === "registry") {
        const clientKey = config.data?.access?.["api-keys"]?.[0];
        const result = await api<{ data: ModelInfo[] }>("/v1/models", {
          headers: clientKey ? { Authorization: `Bearer ${clientKey}` } : {},
        });
        return result.data ?? [];
      }
      const result = source.startsWith("file:")
        ? await mgmt.get<{ models: ModelInfo[] }>("/credentials/models", {
            name: source.slice(5),
          })
        : await mgmt.get<{ models: ModelInfo[] }>(
            `/routing/model-definitions/${encodeURIComponent(source)}`,
          );
      return result.models ?? [];
    },
    0,
    source !== "registry" || !!config.data,
  );
  const models = (resource.data ?? []).filter((m) =>
    `${m.id} ${m.display_name ?? ""} ${m.owned_by ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Panel
      title="Available models"
      actions={
        <Button
          icon={<RefreshCw />}
          size="sm"
          busy={resource.loading}
          onClick={() => void resource.refresh()}
        >
          Refresh
        </Button>
      }
    >
      <div className="flex flex-wrap gap-3 border-b border-line p-3">
        <div className="min-w-40 flex-1">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search models…"
          />
        </div>
        <Select
          aria-label="Model source"
          value={source}
          className="w-auto max-w-full"
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="registry">Live model registry</option>
          {[
            "claude",
            "codex",
            "gemini",
            "antigravity",
            "kimi",
            "xai",
            "meta",
            "vertex",
          ].map((p) => (
            <option key={p} value={p}>
              {providerTitle(p)} definitions
            </option>
          ))}
          {files.data?.files.map((f) => (
            <option key={f.name} value={`file:${f.name}`}>
              {f.name}
            </option>
          ))}
        </Select>
      </div>
      {resource.error && (
        <div className="p-3">
          <ErrorNote
            error={resource.error}
            onRetry={() => void resource.refresh()}
          />
        </div>
      )}
      {!resource.updatedAt && resource.loading ? (
        <Skeleton className="m-4 h-40" />
      ) : !models.length ? (
        <EmptyState title="No models found">
          Connect a credential, choose a definition channel, or change the
          search.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[460px] text-[12px]">
            <thead className="border-b border-line bg-rail">
              <tr>
                <Th>Model ID</Th>
                <Th>Display name</Th>
                <Th>Owner</Th>
                <Th>Copy</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {models.map((m, i) => (
                <tr key={`${m.id}-${i}`} className="hover:bg-surface-2">
                  <td className="px-3 py-3 font-mono">{m.id}</td>
                  <td className="px-3 py-3 text-fg-2">
                    {m.display_name || "—"}
                  </td>
                  <td className="px-3 py-3 text-fg-3">{m.owned_by || "—"}</td>
                  <td className="px-3 py-3">
                    <IconButton
                      label={`Copy ${m.id}`}
                      onClick={() => void copyText(m.id, "Model ID copied")}
                    >
                      <Copy />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function OAuthModels({ aliases }: { aliases: boolean }) {
  const path = aliases ? "model-alias" : "excluded-models";
  const resource = useResource<Record<string, any> | undefined>(
    `oauth:${path}`,
    () => mgmtOptional(`/config/oauth/${path}`, undefined),
  );
  const [provider, setProvider] = useState("claude");
  const [rows, setRows] = useState<ModelAlias[]>([]);
  const [excluded, setExcluded] = useState("");
  const [baseline, setBaseline] = useState<Record<string, any>>();
  const task = useTask();
  useEffect(() => {
    setBaseline(resource.data);
    setRows(structuredClone(resource.data?.[provider] ?? []));
    setExcluded(
      (resource.data?.[provider] ?? [])
        .filter((x: unknown) => typeof x === "string")
        .join("\n"),
    );
  }, [resource.updatedAt, provider]);
  return (
    <Panel
      title={aliases ? "OAuth model aliases" : "OAuth model exclusions"}
      description={
        aliases
          ? "Give an upstream model a client-facing alias. Fork keeps the original ID available."
          : "Exclude model IDs or wildcard patterns for a provider’s OAuth credentials."
      }
      bodyClassName="space-y-4 p-4"
    >
      {resource.error && (
        <ErrorNote
          error={resource.error}
          onRetry={() => void resource.refresh()}
        />
      )}
      <Field label="Provider channel">
        {(id) => (
          <Select
            id={id}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {[
              ...new Set([
                "claude",
                "codex",
                "gemini",
                "antigravity",
                "kimi",
                "xai",
                "meta",
                ...Object.keys(resource.data ?? {}),
              ]),
            ].map((p) => (
              <option key={p} value={p}>
                {providerTitle(p)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {aliases ? (
        <>
          <div className="space-y-3">
            {rows.map((r, i) => (
              <div
                key={i}
                className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
              >
                <TextField
                  label="Upstream model"
                  value={r.name}
                  onChange={(v) =>
                    setRows((prev) =>
                      prev.map((m, j) => (j === i ? { ...m, name: v } : m)),
                    )
                  }
                />
                <TextField
                  label="Alias"
                  value={r.alias}
                  onChange={(v) =>
                    setRows((prev) =>
                      prev.map((m, j) => (j === i ? { ...m, alias: v } : m)),
                    )
                  }
                />
                <label className="flex h-8 items-center gap-2 text-[12px]">
                  <Checkbox
                    checked={r.fork ?? false}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((m, j) =>
                          j === i ? { ...m, fork: e.target.checked } : m,
                        ),
                      )
                    }
                  />
                  Fork
                </label>
                <IconButton
                  label="Remove alias"
                  onClick={() =>
                    setRows((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
          <Button
            icon={<Plus />}
            onClick={() =>
              setRows((prev) => [...prev, { name: "", alias: "" }])
            }
          >
            Add alias
          </Button>
        </>
      ) : (
        <Field label="Excluded models (one per line)">
          {(id) => (
            <Textarea
              id={id}
              rows={8}
              value={excluded}
              onChange={(e) => setExcluded(e.target.value)}
              spellCheck={false}
              className="font-mono"
            />
          )}
        </Field>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          icon={<Save />}
          disabled={!resource.updatedAt}
          busy={task.busy}
          onClick={() =>
            void task.run(async () => {
              if (
                aliases &&
                rows.some((r) => !r.name.trim() || !r.alias.trim())
              )
                throw new Error(
                  "Every alias needs an upstream model and an alias.",
                );
              if (
                aliases &&
                new Set(rows.map((r) => r.alias.trim().toLowerCase())).size !==
                  rows.length
              )
                throw new Error(
                  "Alias names must be unique within this provider.",
                );
              const value = aliases ? rows : words(excluded);
              await replaceConfig(["oauth", path], baseline, {
                ...baseline,
                [provider]: value,
              });
              await resource.refresh();
            }, "Model policy saved")
          }
        >
          Save policy
        </Button>
      </div>
    </Panel>
  );
}

export function AccessKeysPage() {
  const resource = useResource<string[] | undefined>("access-keys", () =>
    mgmtOptional("/config/access/api-keys", undefined),
  );
  const usage = useResource<
    Record<string, Record<string, { success?: number; failed?: number }>>
  >("key-usage", () => mgmt.get("/observability/usage/api-keys"), 30_000);
  const [show, setShow] = useState(false);
  const [edit, setEdit] = useState<{
    index: number;
    value: string;
    baseline: string[] | undefined;
  }>();
  const task = useTask();
  const keys = resource.data ?? [];
  return (
    <>
      <PageHeader
        title="Access keys"
        description="Keys your clients use to authenticate with the proxy. Upstream provider keys are managed in Providers."
        actions={
          <>
            <Button
              icon={show ? <EyeOff /> : <Eye />}
              onClick={() => setShow((v) => !v)}
            >
              {show ? "Hide" : "Reveal"} keys
            </Button>
            <Button
              variant="primary"
              icon={<Plus />}
              disabled={!resource.updatedAt}
              onClick={() =>
                setEdit({ index: -1, value: "", baseline: resource.data })
              }
            >
              Add key
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
      <Panel
        title="Client keys"
        description="Trusted-network access can bypass client-key authentication when enabled."
      >
        {!resource.updatedAt ? (
          <Skeleton className="m-4 h-32" />
        ) : !keys.length ? (
          <EmptyState title="No client keys configured">
            Trusted networks can use the proxy without a key. Add a key for
            other clients.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {keys.map((key, index) => (
              <li
                key={index}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <code className="block max-w-full break-all text-[12px]">
                    {show
                      ? key
                      : `${key.slice(0, 4)}••••••••${key.length > 8 ? key.slice(-4) : ""}`}
                  </code>
                  <p className="mt-1 text-[11px] text-fg-3">
                    Client key {index + 1}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    label="Copy client key"
                    onClick={() => void copyText(key, "Client key copied")}
                  >
                    <Copy />
                  </IconButton>
                  <Button
                    size="sm"
                    onClick={() =>
                      setEdit({ index, value: key, baseline: resource.data })
                    }
                  >
                    Edit
                  </Button>
                  <IconButton
                    label={`Delete client key ${index + 1}`}
                    disabled={task.busy}
                    onClick={async () => {
                      if (
                        await confirmAction({
                          title: "Delete client key?",
                          body: `Clients using key ${index + 1} will lose access outside trusted networks.`,
                          confirmLabel: "Delete key",
                          danger: true,
                        })
                      )
                        await task.run(async () => {
                          await replaceConfig(
                            ["access", "api-keys"],
                            resource.data,
                            keys.filter((_, i) => i !== index),
                          );
                          await resource.refresh();
                        }, "Client key deleted");
                    }}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title="API-key request usage"
        description="Success and failure counters reported by the server’s usage collector."
      >
        {usage.error ? (
          <div className="p-4">
            <ErrorNote error={usage.error} />
          </div>
        ) : !Object.keys(usage.data ?? {}).length ? (
          <EmptyState title="No usage recorded">
            Enable usage statistics in Config and send requests through the
            proxy.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="border-b border-line">
                <tr>
                  <Th>Provider</Th>
                  <Th>Credential index</Th>
                  <Th align="right">Success</Th>
                  <Th align="right">Failure</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {Object.entries(usage.data ?? {}).flatMap(
                  ([provider, entries]) =>
                    Object.entries(entries).map(([id, stats]) => (
                      <tr key={`${provider}-${id}`}>
                        <td className="px-3 py-3">{providerTitle(provider)}</td>
                        <td className="px-3 py-3 font-mono">{id}</td>
                        <td className="px-3 py-3 text-right">
                          {tokens(Number(stats.success) || 0)}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {tokens(Number(stats.failed) || 0)}
                        </td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(undefined)}
        title={edit?.index === -1 ? "Add client key" : "Edit client key"}
      >
        {edit && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                const next = [...(edit.baseline ?? [])];
                const value = edit.value.trim();
                if (!value) throw new Error("Enter a nonempty key.");
                if (next.some((k, i) => k === value && i !== edit.index))
                  throw new Error("This key already exists.");
                if (edit.index < 0) next.push(value);
                else next[edit.index] = value;
                await replaceConfig(
                  ["access", "api-keys"],
                  edit.baseline,
                  next,
                );
                setEdit(undefined);
                await resource.refresh();
              }, "Client key saved");
            }}
          >
            <TextField
              label="Client key"
              type="password"
              value={edit.value}
              onChange={(v) => setEdit({ ...edit, value: v })}
              required
            />
            <Button
              onClick={() =>
                setEdit({
                  ...edit,
                  value: `vpxy_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("")}`,
                })
              }
            >
              Generate random key
            </Button>
            {task.error && <ErrorNote error={task.error} />}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEdit(undefined)}>Cancel</Button>
              <Button
                variant="primary"
                type="submit"
                busy={task.busy}
                disabled={!edit.value.trim()}
              >
                Save key
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

export function ConfigPage() {
  const config = useConfig();
  const [tab, setTab] = useState("sections");
  const [section, setSection] = useState("quota-monitor");
  return (
    <>
      <PageHeader
        title="Config"
        description="Edit scoped settings or the complete YAML file. Changes are validated by the server."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        label="Configuration editor"
        tabs={[
          { value: "sections", label: "By section" },
          { value: "yaml", label: "Config YAML" },
        ]}
      />
      {tab === "yaml" ? (
        <YAMLEditor />
      ) : (
        <>
          {config.error && (
            <ErrorNote
              error={config.error}
              onRetry={() => void config.refresh()}
            />
          )}
          <Field label="Configuration section">
            {(id) => (
              <Select
                id={id}
                value={section}
                onChange={(e) => setSection(e.target.value)}
              >
                {[
                  ...new Set([
                    "quota-monitor",
                    "trusted-networks",
                    "server",
                    "management",
                    "requests",
                    "client",
                    "upstream",
                    "oauth",
                    "routing",
                    "credentials",
                    "observability",
                    "requests/payload",
                    "plugins",
                    "models",
                    ...Object.keys(config.data ?? {}).filter(
                      (k) => k !== "config-version",
                    ),
                  ]),
                ].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ConfigEditor
            key={section}
            path={section.split("/")}
            title={section}
            description={
              {
                "quota-monitor":
                  "Polling interval, enabled state, and cache-rebuild alert threshold.",
                "trusted-networks":
                  "Passwordless access for localhost and tailnet CIDRs, with allowed-host checks.",
                "requests/payload":
                  "Payload defaults, overrides, raw rules, and filters. Rules run at the final payload barrier.",
                client:
                  "Client-specific Claude, Codex, and other compatibility behavior.",
                observability:
                  "Application and request logs, usage statistics, and profiling settings.",
              }[section] ||
              "Edit only this section while preserving the rest of the server configuration."
            }
          />
        </>
      )}
    </>
  );
}

function YAMLEditor() {
  const resource = useResource<string>("config-yaml", () =>
    apiText(MGMT + "/config.yaml"),
  );
  const [text, setText] = useState("");
  const [baseline, setBaseline] = useState<string>();
  const task = useTask();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (resource.data !== undefined && baseline === undefined) {
      setText(resource.data);
      setBaseline(resource.data);
    }
  }, [resource.updatedAt, baseline]);
  const dirty = baseline !== undefined && text !== baseline;
  useUnsaved(dirty);
  return (
    <Panel
      title="config.yaml"
      description="Contains secrets. Export and share it carefully."
      actions={
        <>
          <Button
            size="sm"
            icon={<Upload />}
            onClick={() => input.current?.click()}
          >
            Import
          </Button>
          <Button
            size="sm"
            icon={<Download />}
            disabled={baseline === undefined}
            onClick={() =>
              saveBlob(
                new Blob([text], { type: "application/yaml" }),
                "config.yaml",
              )
            }
          >
            Export
          </Button>
        </>
      }
      bodyClassName="space-y-4 p-4"
    >
      <input
        ref={input}
        type="file"
        hidden
        accept=".yaml,.yml,text/yaml,application/yaml"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void task.run(async () => setText(await file.text()));
          e.target.value = "";
        }}
      />
      {resource.error && (
        <ErrorNote
          error={resource.error}
          onRetry={() => void resource.refresh()}
        />
      )}
      {baseline === undefined ? (
        <Skeleton className="h-96" />
      ) : (
        <Field label="Configuration YAML">
          {(id) => (
            <Textarea
              id={id}
              rows={28}
              className="font-mono text-[12px] leading-5"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
            />
          )}
        </Field>
      )}
      {task.error && <ErrorNote error={task.error} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-fg-3">
          {dirty ? "Unsaved changes" : "Saved on the server"}
        </span>
        <div className="flex gap-2">
          <Button
            disabled={baseline === undefined}
            onClick={async () => {
              if (
                dirty &&
                !(await confirmAction({
                  title: "Discard YAML changes?",
                  confirmLabel: "Discard changes",
                  danger: true,
                }))
              )
                return;
              await task.run(async () => {
                const latest = await apiText(MGMT + "/config.yaml");
                setText(latest);
                setBaseline(latest);
              });
            }}
          >
            Reload
          </Button>
          <Button
            variant="primary"
            icon={<Save />}
            disabled={!dirty || !text.trim()}
            busy={task.busy}
            onClick={async () => {
              if (
                !(await confirmAction({
                  title: "Replace server configuration?",
                  body: "The complete configuration file will be replaced with this YAML after server validation.",
                  confirmLabel: "Save configuration",
                }))
              )
                return;
              await task.run(async () => {
                const latest = await apiText(MGMT + "/config.yaml");
                if (latest !== baseline)
                  throw new Error(
                    "Configuration changed on the server. Export your draft, then reload before saving.",
                  );
                await send(MGMT + "/config.yaml", {
                  method: "PUT",
                  text,
                  headers: { "Content-Type": "application/yaml" },
                });
                const saved = await apiText(MGMT + "/config.yaml");
                setText(saved);
                setBaseline(saved);
                await configChanged();
              }, "Configuration saved");
            }}
          >
            Save configuration
          </Button>
        </div>
      </div>
    </Panel>
  );
}
