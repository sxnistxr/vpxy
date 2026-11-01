import { LazyMotion, domAnimation, MotionConfig } from "motion/react";
import { Eye, EyeOff, Menu, Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, keyRequired, managementKey, mgmt } from "$lib/api";
import { applyTheme, loadTheme, themePref } from "$lib/feedback";
import { useResource, revalidate } from "$lib/resource";
import { navigate, useRoute } from "$lib/router";
import { useStore } from "$lib/store";
import { dirtyForms, useTask } from "$lib/management";
import { parseHash } from "$lib/router";
import type { Overview } from "$lib/types";
import { Brand, navigation, Sidebar } from "./Sidebar";
import { Dialog, Feedback, SearchInput } from "./overlays";
import { Button, ErrorNote, Field, IconButton, Input, Kbd } from "./ui";
import { MonitorPage } from "./pages/MonitorPages";
import { CredentialsPage } from "./pages/CredentialsPage";
import { SignInPage } from "./pages/SignInPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import {
  RoutingPage,
  ModelsPage,
  AccessKeysPage,
  ConfigPage,
} from "./pages/SettingsPages";
import { LogsPage, PluginsPage, SystemPage } from "./pages/SystemPages";

export const hydrate = "load";

export default function Dashboard() {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        <Console />
      </MotionConfig>
    </LazyMotion>
  );
}

function Console() {
  const route = useRoute();
  const overview = useResource<Overview>(
    "overview",
    () => api("/vpxy/api/overview"),
    30_000,
  );
  const [mobile, setMobile] = useState(false);
  const [command, setCommand] = useState(false);
  const [query, setQuery] = useState("");
  const [showEmails, setShowEmails] = useState(false);
  const needsKey = useStore(keyRequired);
  const [key, setKey] = useState("");
  const auth = useTask();
  const current = navigation
    .flatMap((g) => g.items)
    .find((p) => p.id === route.page)!;
  useEffect(() => {
    loadTheme();
    const media = matchMedia("(prefers-color-scheme: light)");
    const update = () => {
      if (themePref.get() === "system") applyTheme("system");
    };
    media.addEventListener("change", update);
    const keyboard = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommand((v) => !v);
      }
    };
    window.addEventListener("keydown", keyboard);
    const followLink = (e: MouseEvent) => {
      if (
        !dirtyForms.size ||
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const anchor = (e.target as Element).closest<HTMLAnchorElement>(
        "a[href]",
      );
      const link = anchor?.getAttribute("href");
      if (!link?.startsWith("#/") || anchor?.target === "_blank") return;
      e.preventDefault();
      const route = parseHash(link);
      navigate(route.page, Object.fromEntries(route.params));
    };
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("keydown", keyboard);
      document.removeEventListener("click", followLink, true);
      media.removeEventListener("change", update);
    };
  }, []);
  useEffect(() => {
    document.title = `${current.label} · VibeProxy`;
    document.getElementById("main-content")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route.page]);
  async function unlock(e: FormEvent) {
    e.preventDefault();
    await auth.run(async () => {
      managementKey.set(key);
      try {
        await mgmt.get("/config");
      } catch (err) {
        managementKey.set("");
        throw err;
      }
      keyRequired.set(false);
      setKey("");
      await Promise.all([
        revalidate("overview"),
        revalidate("config"),
        revalidate("credentials"),
      ]);
    });
  }
  return (
    <>
      <a
        href="#main-content"
        className="sr-only fixed top-2 left-2 z-50 rounded bg-primary p-2 text-on-primary focus:not-sr-only"
      >
        Skip to content
      </a>
      <Sidebar
        page={route.page}
        open={mobile}
        onClose={() => setMobile(false)}
        onSearch={() => {
          setCommand(true);
          setQuery("");
        }}
        online={!!overview.data && !overview.error}
      />
      <div className="min-h-dvh lg:pl-[232px]">
        <div className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-line bg-canvas px-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <IconButton
              label="Open navigation"
              className="lg:hidden"
              onClick={() => setMobile(true)}
            >
              <Menu />
            </IconButton>
            <div className="lg:hidden">
              <Brand compact />
            </div>
            <span className="hidden text-[12px] text-fg-3 lg:block">
              VibeProxy
            </span>
            <span className="hidden text-fg-3 lg:block">/</span>
            <span className="truncate text-[12px]">{current.label}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              label={
                showEmails
                  ? "Hide account identities"
                  : "Show account identities"
              }
              onClick={() => setShowEmails((v) => !v)}
            >
              {showEmails ? <Eye /> : <EyeOff />}
            </IconButton>
            <button
              onClick={() => {
                setCommand(true);
                setQuery("");
              }}
              className="flex items-center gap-2 rounded p-2 text-fg-2 hover:bg-surface-2"
              aria-label="Quick navigation"
            >
              <Search className="size-4" />
              <span className="hidden sm:inline">
                <Kbd>⌘ K</Kbd>
              </span>
            </button>
          </div>
        </div>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto max-w-[1280px] space-y-6 px-4 py-6 outline-none sm:px-8 sm:py-8"
        >
          {["overview", "quota", "sessions"].includes(route.page) && (
            <MonitorPage
              page={route.page as "overview" | "quota" | "sessions"}
              resource={overview}
              showEmails={showEmails}
            />
          )}
          {route.page === "credentials" && (
            <CredentialsPage params={route.params} showEmails={showEmails} />
          )}
          {route.page === "sign-in" && (
            <SignInPage key={route.params.toString()} params={route.params} />
          )}
          {route.page === "providers" && <ProvidersPage />}
          {route.page === "routing" && <RoutingPage />}
          {route.page === "models" && <ModelsPage />}
          {route.page === "access-keys" && <AccessKeysPage />}
          {route.page === "config" && <ConfigPage />}
          {route.page === "logs" && <LogsPage />}
          {route.page === "plugins" && <PluginsPage />}
          {route.page === "system" && <SystemPage overview={overview.data} />}
        </main>
        <footer className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-2 px-4 pb-5 text-[11px] text-fg-3 sm:px-8">
          <span>One endpoint. Every account.</span>
          <span>VibeProxy console</span>
        </footer>
      </div>
      <Dialog
        open={command}
        onClose={() => setCommand(false)}
        title="Quick navigation"
        description="Find a page or setting."
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search pages, settings, actions…"
        />
        <ul className="mt-3 max-h-[55dvh] overflow-y-auto">
          {navigation
            .flatMap((g) => g.items)
            .filter((item) =>
              `${item.label} ${item.keywords}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  className="flex min-h-10 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-surface-2"
                  onClick={() => {
                    setCommand(false);
                    navigate(id);
                  }}
                >
                  <Icon className="size-4 text-fg-2" />
                  {label}
                </button>
              </li>
            ))}
        </ul>
      </Dialog>
      <Dialog
        open={needsKey}
        dismissible={false}
        onClose={() => {}}
        title="Connect to your proxy"
        description="This network requires the server’s management key. The key stays in memory for this tab."
      >
        <form className="space-y-4" onSubmit={unlock}>
          <Field label="Management key">
            {(id) => (
              <Input
                id={id}
                autoFocus
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>
          {auth.error && <ErrorNote error={auth.error} />}
          <Button
            type="submit"
            variant="primary"
            busy={auth.busy}
            disabled={!key.trim()}
          >
            Connect
          </Button>
        </form>
      </Dialog>
      <Feedback />
    </>
  );
}
