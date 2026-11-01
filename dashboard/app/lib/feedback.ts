import type { ReactNode } from "react";
import { createStore } from "./store";

export type ToastTone = "ok" | "danger" | "info";
export type Toast = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
};

export const toasts = createStore<Toast[]>([]);
let nextToast = 1;

export function dismissToast(id: number) {
  toasts.set((list) => list.filter((t) => t.id !== id));
}

/** Shows a toast for five seconds (eight for errors, which take longer to read). */
export function toast(
  title: string,
  options: { description?: string; tone?: ToastTone } = {},
) {
  const id = nextToast++;
  const tone = options.tone ?? "ok";
  toasts.set((list) => [
    ...list.slice(-3),
    { id, title, description: options.description, tone },
  ]);
  setTimeout(() => dismissToast(id), tone === "danger" ? 8_000 : 5_000);
}

export type ConfirmRequest = {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
  resolve: (ok: boolean) => void;
};

export const confirmRequest = createStore<ConfirmRequest | null>(null);

/** Asks before a destructive or hard-to-undo action. Resolves true when confirmed. */
export function confirmAction(
  options: Omit<ConfirmRequest, "resolve">,
): Promise<boolean> {
  return new Promise((resolve) => confirmRequest.set({ ...options, resolve }));
}

export type ThemePref = "dark" | "light" | "system";

const THEME_KEY = "vibeproxy-theme";
export const themePref = createStore<ThemePref>("dark");

export function applyTheme(pref: ThemePref) {
  const resolved =
    pref === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : pref;
  document.documentElement.dataset.theme = resolved;
}

export function loadTheme() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* Theme still works when browser storage is disabled. */
  }
  const pref: ThemePref =
    saved === "light" || saved === "system" ? saved : "dark";
  themePref.set(pref);
  applyTheme(pref);
}

export function setTheme(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* Keep the preference in memory for this tab. */
  }
  themePref.set(pref);
  applyTheme(pref);
}

/** Copies text and confirms with a toast. */
export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Copy failed", {
      description: "The browser blocked clipboard access.",
      tone: "danger",
    });
  }
}
