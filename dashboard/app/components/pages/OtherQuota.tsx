import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { mgmt } from "$lib/api";
import { ago, maskLabel, resetText } from "$lib/format";
import { useTask } from "$lib/management";
import type { Credential, CredentialList } from "$lib/mgmt-types";
import { fetchProviderQuota, type ProviderQuota } from "$lib/provider-quota";
import { useResource } from "$lib/resource";
import { Bar, Button, ErrorNote, Panel, remainingTone } from "../ui";
import { ProviderLogo, providerTitle } from "./MonitorPages";

export function OtherQuota({ show }: { show: boolean }) {
  const resource = useResource<CredentialList>("credentials", () =>
    mgmt.get("/credentials"),
  );
  const files = (resource.data?.files ?? []).filter(
    (f) => !["claude", "codex"].includes(f.provider || f.type || ""),
  );
  if (!files.length) return null;
  return (
    <div className="space-y-4">
      <h2 className="text-[14px] font-semibold">Other provider quotas</h2>
      <p className="text-[12px] text-fg-2">
        Fetch usage on demand for Antigravity, Kimi, xAI, Devin, Meta, and
        plugin credentials.
      </p>
      {files.map((f) => (
        <OtherQuotaRow key={`${f.name}:${f.auth_index}`} file={f} show={show} />
      ))}
    </div>
  );
}
function OtherQuotaRow({ file, show }: { file: Credential; show: boolean }) {
  const [result, setResult] = useState<ProviderQuota>();
  const task = useTask();
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <ProviderLogo provider={file.provider || file.type || "unknown"} />
          <span className="truncate">
            {show
              ? file.email || file.name
              : maskLabel(file.email || file.name)}
          </span>
        </span>
      }
      description={`${providerTitle(file.provider || file.type || "unknown")}${result?.plan ? ` · ${result.plan}` : ""}`}
      actions={
        <Button
          size="sm"
          icon={<RefreshCw />}
          busy={task.busy}
          disabled={file.disabled || !file.auth_index}
          onClick={() =>
            void task.run(async () => setResult(await fetchProviderQuota(file)))
          }
        >
          Fetch quota
        </Button>
      }
      bodyClassName="space-y-4 p-4"
    >
      {task.error && <ErrorNote error={task.error} />}
      {result ? (
        <>
          {!result.readings.length ? (
            <p className="text-[12px] text-fg-3">
              The endpoint returned no recognized quota windows.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {result.readings.map((r, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="text-fg-2">{r.label}</span>
                    <span>
                      {r.remaining === undefined
                        ? "Not reported"
                        : `${Math.round(r.remaining)}% left`}
                    </span>
                  </div>
                  {r.remaining !== undefined && (
                    <Bar
                      percent={r.remaining}
                      tone={remainingTone(r.remaining)}
                      label={`${r.label} remaining`}
                    />
                  )}
                  {r.detail && (
                    <p className="text-[11px] text-fg-3">{r.detail}</p>
                  )}
                  {r.resetsAt && (
                    <p className="text-[11px] text-fg-3">
                      {resetText(r.resetsAt, new Date())}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-fg-3">
            Observed {ago(new Date(result.observedAt), new Date())}
          </p>
        </>
      ) : (
        <p className="text-[12px] text-fg-3">No usage check in this tab yet.</p>
      )}
    </Panel>
  );
}
