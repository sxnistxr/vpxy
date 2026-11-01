import { useCallback, useEffect, useSyncExternalStore } from "react";

/** One cached server read shared by every component that asks for the same key. */
type Entry<T> = {
  data?: T;
  error?: Error;
  loading: boolean;
  updatedAt?: number;
  inflight?: Promise<void>;
  fetcher?: () => Promise<T>;
};

const entries = new Map<string, Entry<unknown>>();
const listeners = new Map<string, Set<() => void>>();

function entry<T>(key: string): Entry<T> {
  let found = entries.get(key) as Entry<T> | undefined;
  if (!found) {
    found = { loading: false };
    entries.set(key, found as Entry<unknown>);
  }
  return found;
}

function emit(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

function update<T>(key: string, patch: Partial<Entry<T>>) {
  entries.set(key, { ...entry<T>(key), ...patch } as Entry<unknown>);
  emit(key);
}

/** Fetches key now (deduplicated); resolves when the read settles. */
export function revalidate(key: string): Promise<void> {
  const current = entry(key);
  if (current.inflight) return current.inflight;
  if (!current.fetcher) return Promise.resolve();
  const fetcher = current.fetcher;
  const inflight = fetcher().then(
    (data) => update(key, { data, error: undefined, loading: false, updatedAt: Date.now(), inflight: undefined }),
    (error: unknown) =>
      update(key, { error: error instanceof Error ? error : new Error(String(error)), loading: false, inflight: undefined }),
  );
  update(key, { loading: true, inflight });
  return inflight;
}

/** Replaces cached data without a request (after a write that returned the new state). */
export function setResource<T>(key: string, next: T | ((prev: T | undefined) => T)) {
  const prev = entry<T>(key).data;
  const data = typeof next === "function" ? (next as (p: T | undefined) => T)(prev) : next;
  update<T>(key, { data, error: undefined, updatedAt: Date.now() });
}

export type Resource<T> = {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  updatedAt: number | undefined;
  refresh: () => Promise<void>;
};

/**
 * Reads key with fetcher, refreshing every intervalMs while the tab is visible and again when
 * it becomes visible. Data stays cached across page switches.
 */
export function useResource<T>(key: string, fetcher: () => Promise<T>, intervalMs = 0, enabled = true): Resource<T> {
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, () => entry<T>(key), () => entry<T>(key));
  entry<T>(key).fetcher = fetcher;

  useEffect(() => {
    if (!enabled) return;
    const current = entry<T>(key);
    const stale = !current.updatedAt || (intervalMs > 0 && Date.now() - current.updatedAt > intervalMs);
    if (stale || current.error) void revalidate(key);
    if (intervalMs <= 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void revalidate(key);
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void revalidate(key);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs, enabled]);

  return {
    data: snapshot.data,
    error: snapshot.error,
    loading: snapshot.loading,
    updatedAt: snapshot.updatedAt,
    refresh: () => revalidate(key),
  };
}
