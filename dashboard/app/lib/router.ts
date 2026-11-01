import { useSyncExternalStore } from "react";
import { confirmAction } from "./feedback";
import { dirtyForms } from "./management";

export const PAGES = [
  "overview",
  "quota",
  "sessions",
  "credentials",
  "sign-in",
  "providers",
  "routing",
  "models",
  "access-keys",
  "config",
  "logs",
  "plugins",
  "system",
] as const;

export type PageId = (typeof PAGES)[number];

export type Route = { page: PageId; params: URLSearchParams };

/** "#/credentials?name=a.json" -> { page: "credentials", params: name=a.json }. Unknown -> overview. */
export function parseHash(hash: string): Route {
  const body = hash.replace(/^#\/?/, "");
  const [path = "", search = ""] = body.split("?", 2);
  const page = (PAGES as readonly string[]).includes(path)
    ? (path as PageId)
    : "overview";
  return { page, params: new URLSearchParams(search) };
}

export function href(page: PageId, params?: Record<string, string>): string {
  const search = params ? new URLSearchParams(params).toString() : "";
  return `#/${page}${search ? `?${search}` : ""}`;
}

export function navigate(page: PageId, params?: Record<string, string>) {
  const target = href(page, params);
  if (location.hash === target) return;
  if (!dirtyForms.size) {
    location.hash = target;
    return;
  }
  void confirmAction({
    title: "Discard unsaved changes?",
    body: "Your edits on this page have not been saved.",
    confirmLabel: "Discard changes",
    danger: true,
  }).then((ok) => {
    if (ok) location.hash = target;
  });
}

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

let cachedHash = "";
let cachedRoute: Route = parseHash("");

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => location.hash,
    () => "",
  );
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash);
  }
  return cachedRoute;
}
