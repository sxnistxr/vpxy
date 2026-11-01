import { createStore } from "./store";

/** Base path of the upstream management API (docs/management-api-v8.md). */
export const MGMT = "/v8/management";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export type ServerInfo = {
  version: string;
  commit: string;
  buildDate: string;
  plugins: boolean;
};

/** Build headers the management API sends on every response. */
export const serverInfo = createStore<ServerInfo | null>(null);

/**
 * The management key, kept in memory only. Browsers on this machine or the tailnet never need
 * it; anywhere else the shell asks for it once per page load.
 */
export const managementKey = createStore("");

/** True after a request was refused for want of the management key. */
export const keyRequired = createStore(false);

type Query = Record<string, string | number | boolean | undefined | null>;

export type RequestOptions = {
  method?: string;
  query?: Query;
  json?: unknown;
  form?: FormData;
  text?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}${path.includes("?") ? "&" : "?"}${text}` : path;
}

function errorMessage(status: number, body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = typeof record.error === "string" ? record.error : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (error && message && !message.includes(error))
      return `${error}: ${message}`;
    if (message || error) return message || error;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return fallback || `Request failed (${status})`;
}

function captureServerInfo(res: Response) {
  const version = res.headers.get("X-CPA-VERSION");
  if (!version) return;
  const current = serverInfo.get();
  const next: ServerInfo = {
    version,
    commit: res.headers.get("X-CPA-COMMIT") ?? "",
    buildDate: res.headers.get("X-CPA-BUILD-DATE") ?? "",
    plugins: res.headers.get("X-CPA-SUPPORT-PLUGIN") === "1",
  };
  if (
    !current ||
    current.version !== next.version ||
    current.plugins !== next.plugins
  )
    serverInfo.set(next);
}

/** Sends a request and returns the raw response, throwing ApiError on a non-2xx status. */
export async function send(
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  const key = managementKey.get();
  if (key) headers.set("X-Management-Key", key);
  let body: BodyInit | undefined;
  if (options.text !== undefined) {
    body = options.text;
  } else if (options.form) {
    body = options.form;
  } else if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  }
  const res = await fetch(withQuery(path, options.query), {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    cache: "no-store",
    signal: options.signal,
  });
  captureServerInfo(res);
  if (res.ok) return res;
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Plain-text error body.
  }
  const message = errorMessage(res.status, parsed, res.statusText);
  if (
    (path.startsWith(MGMT) || path.startsWith("/vpxy/api")) &&
    (res.status === 401 ||
      (res.status === 403 && /management|remote/i.test(message)))
  )
    keyRequired.set(true);
  throw new ApiError(res.status, message, parsed);
}

/** JSON request; an empty body resolves to undefined. */
export async function api<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const res = await send(path, options);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiText(
  path: string,
  options: RequestOptions = {},
): Promise<string> {
  return (await send(path, options)).text();
}

/** Shorthands for the v8 management API. */
export const mgmt = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    api<T>(MGMT + path, { query, signal }),
  put: <T>(path: string, json: unknown) =>
    api<T>(MGMT + path, { method: "PUT", json }),
  patch: <T>(path: string, json: unknown) =>
    api<T>(MGMT + path, { method: "PATCH", json }),
  post: <T>(path: string, json?: unknown, query?: Query) =>
    api<T>(MGMT + path, { method: "POST", json: json ?? {}, query }),
  del: <T>(path: string, query?: Query, json?: unknown) =>
    api<T>(MGMT + path, { method: "DELETE", query, json }),
};

/** Reads a management value that may not exist yet: 404 resolves to the fallback. */
export async function mgmtOptional<T>(path: string, fallback: T): Promise<T> {
  try {
    return (await mgmt.get<T>(path)) ?? fallback;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return fallback;
    throw err;
  }
}

/** Saves a Blob through a temporary link. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
