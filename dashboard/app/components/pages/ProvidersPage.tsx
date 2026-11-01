import { Download, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { mgmt, mgmtOptional } from "$lib/api";
import { confirmAction } from "$lib/feedback";
import {
  parseJSON,
  parseKeyGroup,
  pretty,
  record,
  replaceConfig,
  useTask,
  words,
} from "$lib/management";
import type { KeyGroup } from "$lib/mgmt-types";
import { useResource } from "$lib/resource";
import { ConfigEditor, JSONInput, TextField } from "../editors";
import { Dialog, SearchInput } from "../overlays";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Input,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  Tabs,
  Th,
} from "../ui";
import { ProviderLogo, providerTitle } from "./MonitorPages";

const families = [
  "claude",
  "codex",
  "gemini",
  "interactions",
  "openai-compatibility",
  "vertex",
  "xai",
  "meta",
];

export function ProvidersPage() {
  const [family, setFamily] = useState("claude");
  const [section, setSection] = useState("keys");
  return (
    <>
      <PageHeader
        title="Providers"
        description="Upstream API keys, compatible endpoints, and provider-wide behavior."
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select
          aria-label="Provider family"
          className="w-auto min-w-52"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
        >
          {families.map((f) => (
            <option key={f} value={f}>
              {providerTitle(f)}
            </option>
          ))}
        </Select>
        <Tabs
          value={section}
          onChange={setSection}
          label="Provider configuration"
          tabs={[
            { value: "keys", label: "API-key groups" },
            { value: "shared", label: "Shared settings" },
          ]}
        />
      </div>
      {section === "keys" ? (
        <ProviderGroups key={family} family={family} />
      ) : (
        <ConfigEditor
          key={family}
          path={["upstream", family]}
          title={`${providerTitle(family)} shared settings`}
          description="Provider defaults, headers, cloaking, WebSocket behavior, and other supported upstream options."
        />
      )}
    </>
  );
}

function ProviderGroups({ family }: { family: string }) {
  const resource = useResource<KeyGroup[] | undefined>(
    `provider:${family}`,
    () => mgmtOptional(`/config/api-keys/${family}`, undefined),
  );
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<{
    index: number;
    baseline: KeyGroup[] | undefined;
    group: KeyGroup;
  }>();
  const task = useTask();
  const groups = resource.data ?? [];
  async function remove(index: number) {
    const group = groups[index];
    if (
      !(await confirmAction({
        title: "Delete provider group?",
        body: `${group.name || providerTitle(family)} and its ${group.keys?.length ?? 0} keys will be removed.`,
        confirmLabel: "Delete group",
        danger: true,
      }))
    )
      return;
    await task.run(async () => {
      await replaceConfig(
        ["api-keys", family],
        resource.data,
        groups.filter((_, i) => i !== index),
      );
      await resource.refresh();
    }, "Provider group deleted");
  }
  return (
    <>
      {resource.error && (
        <ErrorNote
          error={resource.error}
          onRetry={() => void resource.refresh()}
        />
      )}
      <Panel
        title={`${providerTitle(family)} groups`}
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={<Plus />}
            disabled={!resource.updatedAt}
            onClick={() =>
              setEdit({
                index: -1,
                baseline: resource.data,
                group: { name: "", keys: [{ "api-key": "" }] },
              })
            }
          >
            Add group
          </Button>
        }
      >
        <div className="border-b border-line p-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search groups…"
          />
        </div>
        {!resource.updatedAt ? (
          <div className="p-4">
            <Skeleton className="h-36" />
          </div>
        ) : groups.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[570px] text-[12px]">
              <thead className="border-b border-line bg-rail">
                <tr>
                  <Th>Group</Th>
                  <Th>Endpoint</Th>
                  <Th align="right">Keys</Th>
                  <Th align="right">Priority</Th>
                  <Th>Prefix</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {groups
                  .map((group, index) => ({ group, index }))
                  .filter(({ group }) =>
                    `${group.name ?? ""} ${group["base-url"] ?? ""} ${group.prefix ?? ""}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map(({ group, index }) => (
                    <tr key={index} className="hover:bg-surface-2">
                      <td className="max-w-60 px-3 py-4">
                        <div className="flex items-center gap-2">
                          <ProviderLogo provider={family} />
                          <span className="truncate font-medium">
                            {group.name ||
                              `${providerTitle(family)} group ${index + 1}`}
                          </span>
                        </div>
                      </td>
                      <td className="max-w-52 truncate px-3 py-4 text-fg-2">
                        {group["base-url"] || "Provider default"}
                      </td>
                      <td className="px-3 py-4 text-right">
                        {group.keys?.length ?? 0}
                      </td>
                      <td className="px-3 py-4 text-right">
                        {group.priority ?? 0}
                      </td>
                      <td className="px-3 py-4 text-fg-2">
                        {group.prefix || "—"}
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            onClick={() =>
                              setEdit({
                                index,
                                baseline: resource.data,
                                group: structuredClone(group),
                              })
                            }
                          >
                            Edit
                          </Button>
                          <IconButton
                            label="Delete provider group"
                            disabled={task.busy}
                            onClick={() => void remove(index)}
                          >
                            <Trash2 />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={`No ${providerTitle(family)} API-key groups`}
            action={
              <Button
                icon={<Plus />}
                onClick={() =>
                  setEdit({
                    index: -1,
                    baseline: resource.data,
                    group: { name: "", keys: [{ "api-key": "" }] },
                  })
                }
              >
                Add group
              </Button>
            }
          >
            OAuth subscription accounts are managed in Credentials. Add API keys
            here for direct upstream access.
          </EmptyState>
        )}
      </Panel>
      {edit && (
        <GroupEditor
          family={family}
          source={edit}
          onClose={() => setEdit(undefined)}
          onSaved={async () => {
            setEdit(undefined);
            await resource.refresh();
          }}
        />
      )}
    </>
  );
}

function GroupEditor({
  family,
  source,
  onClose,
  onSaved,
}: {
  family: string;
  source: { index: number; baseline: KeyGroup[] | undefined; group: KeyGroup };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [group, setGroup] = useState<KeyGroup>(source.group);
  const [mode, setMode] = useState("form");
  const [raw, setRaw] = useState(pretty(group));
  const [discovered, setDiscovered] = useState<string[]>();
  const task = useTask();
  const update = (key: string, value: unknown) =>
    setGroup((g) => ({ ...g, [key]: value }));
  async function close() {
    if (
      pretty(group) !== pretty(source.group) ||
      (mode === "json" && raw !== pretty(group))
    ) {
      if (
        !(await confirmAction({
          title: "Discard provider changes?",
          confirmLabel: "Discard changes",
          danger: true,
        }))
      )
        return;
    }
    onClose();
  }
  async function discover() {
    await task.run(async () => {
      const key = group.keys?.[0];
      const base =
        group["base-url"] ||
        {
          claude: "https://api.anthropic.com",
          gemini: "https://generativelanguage.googleapis.com",
          interactions: "https://generativelanguage.googleapis.com",
        }[family];
      if (!base) throw new Error("Enter the upstream base URL first.");
      const url = new URL(base);
      const header: Record<string, string> = { ...group.headers };
      const token = String(key?.["api-key"] || "$TOKEN$");
      if (family === "claude") {
        url.pathname = "/v1/models";
        header["x-api-key"] = token;
        header["anthropic-version"] = "2023-06-01";
      } else if (family === "gemini" || family === "interactions") {
        url.pathname = "/v1beta/models";
        header["x-goog-api-key"] = token;
      } else {
        url.pathname =
          url.pathname.replace(/\/$/, "").replace(/\/models$/, "") +
          (url.pathname.replace(/\/$/, "").endsWith("/v1")
            ? "/models"
            : "/v1/models");
        header.Authorization = `Bearer ${token}`;
      }
      const result = await mgmt.post<{ status_code: number; body: unknown }>(
        "/requests/api-call",
        {
          method: "GET",
          url: url.href,
          header,
          authIndex: key?.["auth-index"] || key?.auth_index,
          proxy_url: group["proxy-url"],
        },
      );
      if (result.status_code < 200 || result.status_code >= 300)
        throw new Error(
          `Model discovery returned HTTP ${result.status_code}. Check the endpoint and key.`,
        );
      const payload =
        typeof result.body === "string" ? JSON.parse(result.body) : result.body;
      const list = Array.isArray(payload)
        ? payload
        : record(payload)
          ? payload.data || payload.models
          : [];
      const ids = Array.isArray(list)
        ? list.flatMap((m) =>
            typeof m === "string"
              ? [m]
              : record(m) && typeof (m.id || m.name) === "string"
                ? [String(m.id || m.name).replace(/^models\//, "")]
                : [],
          )
        : [];
      setDiscovered([...new Set(ids)]);
    });
  }
  return (
    <Dialog
      open
      onClose={() => void close()}
      title={`${source.index < 0 ? "Add" : "Edit"} ${providerTitle(family)} group`}
      sheet
    >
      <Tabs
        value={mode}
        onChange={(value) => {
          if (value === "json") {
            setRaw(pretty(group));
            setMode(value);
          } else
            void task.run(async () => {
              setGroup(parseKeyGroup(raw));
              setMode(value);
            });
        }}
        label="Group editor"
        tabs={[
          { value: "form", label: "Settings" },
          { value: "json", label: "All options (JSON)" },
        ]}
      />
      <div className="mt-5 space-y-4">
        {task.error && <ErrorNote error={task.error} />}
        {mode === "json" ? (
          <JSONInput
            value={raw}
            onChange={setRaw}
            rows={24}
            label="Provider group including all key and model options"
          />
        ) : (
          <>
            <TextField
              label="Group name"
              value={group.name ?? ""}
              onChange={(v) => update("name", v)}
            />
            <TextField
              label="Base URL"
              value={group["base-url"] ?? ""}
              onChange={(v) => update("base-url", v)}
              type="url"
              hint="Leave empty to use the built-in provider endpoint."
            />
            <div className="grid grid-cols-2 gap-4">
              <TextField
                label="Prefix"
                value={group.prefix ?? ""}
                onChange={(v) => update("prefix", v)}
              />
              <TextField
                label="Priority"
                value={group.priority ?? 0}
                onChange={(v) => update("priority", Number(v))}
                type="number"
              />
            </div>
            <TextField
              label="Proxy URL"
              value={group["proxy-url"] ?? ""}
              onChange={(v) => update("proxy-url", v)}
              hint="Per-group outbound proxy (optional)."
            />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">API keys</h3>
                <Button
                  size="sm"
                  icon={<Plus />}
                  onClick={() =>
                    update("keys", [...(group.keys ?? []), { "api-key": "" }])
                  }
                >
                  Add key
                </Button>
              </div>
              {(group.keys ?? []).map((key, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="flex-1">
                    <TextField
                      type="password"
                      label={`Key ${i + 1}`}
                      value={String(key["api-key"] ?? "")}
                      onChange={(v) =>
                        update(
                          "keys",
                          group.keys!.map((k, j) =>
                            j === i ? { ...k, "api-key": v } : k,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="w-20">
                    <TextField
                      type="number"
                      label="Weight"
                      value={key.weight ?? 1}
                      onChange={(v) =>
                        update(
                          "keys",
                          group.keys!.map((k, j) =>
                            j === i ? { ...k, weight: Number(v) } : k,
                          ),
                        )
                      }
                    />
                  </div>
                  <IconButton
                    label={`Remove key ${i + 1}`}
                    onClick={() =>
                      update(
                        "keys",
                        group.keys!.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              ))}
            </div>
            <TextField
              label="Excluded models"
              value={(group["excluded-models"] ?? []).join(", ")}
              onChange={(v) => update("excluded-models", words(v))}
              hint="Comma-separated model IDs or wildcard patterns."
            />
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">Models and aliases</h3>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    busy={task.busy}
                    icon={<Download />}
                    onClick={() => void discover()}
                  >
                    Discover
                  </Button>
                  <Button
                    size="sm"
                    icon={<Plus />}
                    onClick={() =>
                      update("models", [...(group.models ?? []), { name: "" }])
                    }
                  >
                    Add model
                  </Button>
                </div>
              </div>
              {group.models?.map((model, i) => (
                <div className="flex items-end gap-2" key={i}>
                  <div className="min-w-0 flex-1">
                    <TextField
                      label="Upstream model"
                      value={model.name}
                      onChange={(v) =>
                        update(
                          "models",
                          group.models!.map((m, j) =>
                            j === i ? { ...m, name: v } : m,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <TextField
                      label="Client alias"
                      value={model.alias ?? ""}
                      onChange={(v) =>
                        update(
                          "models",
                          group.models!.map((m, j) =>
                            j === i ? { ...m, alias: v } : m,
                          ),
                        )
                      }
                    />
                  </div>
                  <IconButton
                    label="Remove model"
                    onClick={() =>
                      update(
                        "models",
                        group.models!.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              ))}
              {!group.models?.length && (
                <p className="text-[12px] text-fg-3">
                  No model overrides. Built-in provider models apply.
                </p>
              )}
              {discovered && (
                <div className="rounded-md border border-line p-3">
                  <p className="mb-2 text-[12px] text-fg-2">
                    {discovered.length} discovered models. Select one to add.
                  </p>
                  <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
                    {discovered.map((id) => (
                      <Button
                        size="sm"
                        key={id}
                        disabled={group.models?.some((m) => m.name === id)}
                        onClick={() =>
                          update("models", [
                            ...(group.models ?? []),
                            { name: id },
                          ])
                        }
                      >
                        {id}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <p className="text-[12px] text-fg-3">
              Use All options for custom headers, per-key overrides, model
              capabilities, thinking support, cooling policy, and other
              provider-specific fields.
            </p>
          </>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={() => void close()}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Save />}
            busy={task.busy}
            onClick={() =>
              void task.run(async () => {
                const value: KeyGroup =
                  mode === "json" ? parseKeyGroup(raw) : group;
                if (value["base-url"]) {
                  const parsed = new URL(value["base-url"]);
                  if (!["http:", "https:"].includes(parsed.protocol))
                    throw new Error("Use an HTTP or HTTPS base URL.");
                }
                if (
                  value.keys?.some((k) => !String(k["api-key"] ?? "").trim()) &&
                  family !== "openai-compatibility"
                )
                  throw new Error("Each API key must be nonempty.");
                const next = [...(source.baseline ?? [])];
                if (source.index < 0) next.push(value);
                else next[source.index] = value;
                await replaceConfig(
                  ["api-keys", family],
                  source.baseline,
                  next,
                );
                await onSaved();
              }, "Provider group saved")
            }
          >
            Save group
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
