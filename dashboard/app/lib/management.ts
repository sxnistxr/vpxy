import { useEffect, useId, useRef, useState } from "react";
import { errorText, mgmt, mgmtOptional } from "./api";
import { toast } from "./feedback";
import type { ConfigV8, KeyGroup } from "./mgmt-types";
import { revalidate, useResource } from "./resource";

export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const words = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

export function parseJSON(text: string, kind?: "object" | "array"): any {
  const value: unknown = JSON.parse(text);
  if (kind === "object" && !record(value))
    throw new Error("Enter a JSON object, enclosed in braces.");
  if (kind === "array" && !Array.isArray(value))
    throw new Error("Enter a JSON array, enclosed in brackets.");
  return value;
}

export function parseKeyGroup(text: string): KeyGroup {
  const value = parseJSON(text, "object");
  for (const field of ["name", "base-url", "prefix", "proxy-url"])
    if (value[field] !== undefined && typeof value[field] !== "string")
      throw new Error(`${field} must be a string.`);
  for (const field of ["keys", "models"])
    if (
      value[field] !== undefined &&
      (!Array.isArray(value[field]) ||
        value[field].some((item: unknown) => !record(item)))
    )
      throw new Error(`${field} must be an array of objects.`);
  if (
    value.keys?.some(
      (key: Record<string, unknown>) =>
        key["api-key"] !== undefined && typeof key["api-key"] !== "string",
    )
  )
    throw new Error("Each api-key must be a string.");
  if (
    value.models?.some(
      (model: Record<string, unknown>) =>
        typeof model.name !== "string" ||
        (model.alias !== undefined && typeof model.alias !== "string"),
    )
  )
    throw new Error("Each model needs a name and an optional string alias.");
  if (
    value["excluded-models"] !== undefined &&
    (!Array.isArray(value["excluded-models"]) ||
      value["excluded-models"].some(
        (item: unknown) => typeof item !== "string",
      ))
  )
    throw new Error("excluded-models must be an array of strings.");
  if (
    value.headers !== undefined &&
    (!record(value.headers) ||
      Object.values(value.headers).some((item) => typeof item !== "string"))
  )
    throw new Error("headers must contain string values.");
  return value;
}

export function configPath(path: readonly string[]): string {
  if (
    !path.length ||
    path.some(
      (s) => !s || s === "." || s === ".." || /[/\\\x00-\x1f\x7f]/.test(s),
    )
  )
    throw new Error("Invalid configuration path.");
  return `/config/${path.map(encodeURIComponent).join("/")}`;
}

export function useConfig() {
  return useResource<ConfigV8>("config", () => mgmt.get("/config"), 60_000);
}

export async function configChanged() {
  await Promise.all([revalidate("config"), revalidate("overview")]);
}

/** Replace only the edited value, refusing to overwrite a concurrent change. */
export async function replaceConfig(
  path: string[],
  baseline: unknown,
  next: unknown,
) {
  const url = configPath(path);
  const latest = await mgmtOptional(url, undefined);
  if (pretty(latest) !== pretty(baseline))
    throw new Error(
      "This setting changed on the server. Reload it before saving.",
    );
  await mgmt.put(url, next);
  await configChanged();
}

export function useTask() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string>();
  async function run(task: () => Promise<unknown>, success?: string) {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await task();
      if (success) toast(success);
      return true;
    } catch (err) {
      const message = errorText(err);
      setError(message);
      toast("Action failed", { description: message, tone: "danger" });
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run, clearError: () => setError(undefined) };
}

export const dirtyForms = new Set<string>();

export function useUnsaved(dirty: boolean) {
  const id = useId();
  useEffect(() => {
    if (!dirty) return;
    dirtyForms.add(id);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      dirtyForms.delete(id);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, id]);
}
