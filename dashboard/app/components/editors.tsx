import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw, Save } from "lucide-react";
import { mgmtOptional } from "$lib/api";
import {
  parseJSON,
  pretty,
  replaceConfig,
  useTask,
  useUnsaved,
} from "$lib/management";
import { useResource } from "$lib/resource";
import {
  Button,
  ErrorNote,
  Field,
  Input,
  Panel,
  Skeleton,
  Textarea,
} from "./ui";
import { confirmAction } from "$lib/feedback";

export function TextField({
  label,
  value,
  onChange,
  hint,
  type = "text",
  required = false,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  hint?: ReactNode;
  type?: string;
  required?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          autoComplete={type === "password" ? "new-password" : undefined}
        />
      )}
    </Field>
  );
}

export function JSONInput({
  value,
  onChange,
  label = "JSON",
  rows = 12,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  rows?: number;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className="font-mono text-[12px] leading-5"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
      )}
    </Field>
  );
}

/** Scoped editor exposes every supported provider/plugin option while preserving siblings. */
export function ConfigEditor({
  path,
  title,
  description,
  fallback = {},
  kind = "object",
}: {
  path: string[];
  title: string;
  description?: string;
  fallback?: unknown;
  kind?: "object" | "array";
}) {
  const url = `/config/${path.map(encodeURIComponent).join("/")}`;
  const resource = useResource<unknown>(`field:${url}`, () =>
    mgmtOptional(url, undefined),
  );
  const [baseline, setBaseline] = useState<unknown>();
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const task = useTask();
  const dirty = ready && text !== pretty(baseline ?? fallback);
  useUnsaved(dirty);
  useEffect(() => {
    if (!resource.updatedAt || dirty) return;
    setBaseline(resource.data);
    setText(pretty(resource.data ?? fallback));
    setReady(true);
  }, [resource.updatedAt]);
  async function reload() {
    if (
      dirty &&
      !(await confirmAction({
        title: "Discard unsaved changes?",
        body: title,
        confirmLabel: "Discard changes",
        danger: true,
      }))
    )
      return;
    setReady(false);
    setText("");
    await resource.refresh();
  }
  return (
    <Panel
      title={title}
      description={description}
      bodyClassName="space-y-4 p-4"
      actions={
        <Button size="sm" icon={<RefreshCw />} onClick={() => void reload()}>
          Reload
        </Button>
      }
    >
      {resource.error && (
        <ErrorNote
          error={resource.error}
          onRetry={() => void resource.refresh()}
        />
      )}
      {!ready ? (
        <Skeleton className="h-48" />
      ) : (
        <>
          <JSONInput value={text} onChange={setText} label={title} />
          <div className="flex items-center justify-between gap-4">
            <span className="text-[12px] text-fg-3">
              {dirty ? "Unsaved changes" : "Saved on the server"}
            </span>
            <Button
              variant="primary"
              icon={<Save />}
              busy={task.busy}
              disabled={!dirty}
              onClick={() =>
                void task.run(async () => {
                  await replaceConfig(path, baseline, parseJSON(text, kind));
                  setReady(false);
                  await resource.refresh();
                }, "Changes saved")
              }
            >
              Save changes
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
