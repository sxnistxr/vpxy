import {
  Activity,
  ArrowUpRight,
  Blocks,
  BookOpen,
  ChartNoAxesCombined,
  CodeXml,
  FileCode2,
  KeyRound,
  LayoutDashboard,
  LogIn,
  Menu,
  Monitor,
  Moon,
  Network,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PageId } from "$lib/router";
import { href } from "$lib/router";
import { serverInfo } from "$lib/api";
import { setTheme, themePref } from "$lib/feedback";
import { useStore } from "$lib/store";
import { Button, cx, Kbd, StatusPill } from "./ui";

export const navigation: {
  group: string;
  items: { id: PageId; label: string; icon: LucideIcon; keywords: string }[];
}[] = [
  {
    group: "Monitor",
    items: [
      {
        id: "overview",
        label: "Overview",
        icon: LayoutDashboard,
        keywords: "home usage cache health",
      },
      {
        id: "quota",
        label: "Quota",
        icon: ChartNoAxesCombined,
        keywords: "limits reset usage tokens",
      },
      {
        id: "sessions",
        label: "Sessions",
        icon: Activity,
        keywords: "affinity binding cache rebuild",
      },
    ],
  },
  {
    group: "Manage",
    items: [
      {
        id: "credentials",
        label: "Credentials",
        icon: Users,
        keywords: "accounts auth files import refresh",
      },
      {
        id: "sign-in",
        label: "Sign in",
        icon: LogIn,
        keywords: "oauth connect account vertex",
      },
      {
        id: "providers",
        label: "Providers",
        icon: Blocks,
        keywords: "upstream api keys openai gemini vertex claude codex",
      },
      {
        id: "routing",
        label: "Routing",
        icon: Network,
        keywords: "strategy expiration first priority weight retry cooldown",
      },
      {
        id: "models",
        label: "Models",
        icon: CodeXml,
        keywords: "aliases exclusions mapping definitions discovery",
      },
      {
        id: "access-keys",
        label: "Access keys",
        icon: KeyRound,
        keywords: "client keys usage",
      },
    ],
  },
  {
    group: "System",
    items: [
      {
        id: "config",
        label: "Config",
        icon: FileCode2,
        keywords: "yaml configuration payload amp settings",
      },
      {
        id: "logs",
        label: "Logs",
        icon: BookOpen,
        keywords: "errors requests debug",
      },
      {
        id: "plugins",
        label: "Plugins",
        icon: ShieldCheck,
        keywords: "store install extension",
      },
      {
        id: "system",
        label: "System",
        icon: Settings2,
        keywords: "server version endpoint api call",
      },
    ],
  },
];

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href={href("overview")}
      aria-label="VibeProxy overview"
      className="block shrink-0"
    >
      <img
        src={`/assets/vibeproxy-${compact ? "mark" : "wordmark"}-white.svg`}
        alt="VibeProxy"
        className={cx(
          "brand-dark",
          compact ? "h-7 w-8" : "h-8 w-[170px] object-contain object-left",
        )}
      />
      <img
        src={`/assets/vibeproxy-${compact ? "mark" : "wordmark"}.svg`}
        alt="VibeProxy"
        className={cx(
          "brand-light",
          compact ? "h-7 w-8" : "h-8 w-[170px] object-contain object-left",
        )}
      />
    </a>
  );
}

export function Sidebar({
  page,
  open,
  onClose,
  onSearch,
  online,
}: {
  page: PageId;
  open: boolean;
  onClose: () => void;
  onSearch: () => void;
  online: boolean;
}) {
  const pref = useStore(themePref);
  const info = useStore(serverInfo);
  return (
    <>
      {open && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        aria-label="Main navigation"
        className={cx(
          "fixed inset-y-0 left-0 z-40 flex w-[232px] flex-col border-r border-line bg-rail transition-transform duration-200 lg:translate-x-0",
          !open && "-translate-x-full",
        )}
      >
        <div className="flex h-[76px] shrink-0 items-center justify-between px-5">
          <Brand />
          <button
            className="p-1 text-fg-2 lg:hidden"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="mx-4 mb-5 flex items-center justify-between rounded-md border border-line px-2.5 py-2">
          <span className="text-[12px] text-fg-2">Proxy server</span>
          <StatusPill tone={online ? "ok" : "neutral"}>
            {online ? "Connected" : "Connecting"}
          </StatusPill>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-5 scrollbar-thin">
          {navigation.map((group) => (
            <div key={group.group}>
              <p className="mb-1.5 px-2 text-[11px] font-medium text-fg-3">
                {group.group}
              </p>
              <ul className="space-y-0.5">
                {group.items.map(({ id, label, icon: Icon }) => (
                  <li key={id}>
                    <a
                      href={href(id)}
                      aria-current={page === id ? "page" : undefined}
                      onClick={onClose}
                      className={cx(
                        "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
                        page === id
                          ? "bg-surface-3 font-medium text-fg"
                          : "text-fg-2 hover:bg-surface-2 hover:text-fg",
                      )}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cx("size-4", page === id && "text-accent")}
                      />
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="space-y-3 border-t border-line p-4">
          <button
            onClick={onSearch}
            className="flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2 text-[12px] text-fg-2 hover:border-line-strong"
          >
            <Search className="size-3.5" />
            Quick navigation
            <span className="ml-auto">
              <Kbd>⌘ K</Kbd>
            </span>
          </button>
          <div className="flex items-center justify-between gap-2">
            <span
              className="truncate text-[11px] text-fg-3"
              title={info?.commit}
            >
              {info?.version || "VibeProxy"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon={pref === "light" ? <Moon /> : <Sun />}
              onClick={() => setTheme(pref === "light" ? "dark" : "light")}
            >
              {pref === "light" ? "Dark" : "Light"}
            </Button>
          </div>
          <a
            href="/management-center.html"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[11px] text-fg-3 hover:text-fg"
          >
            Original management center
            <ArrowUpRight className="size-3" />
          </a>
        </div>
      </aside>
    </>
  );
}
