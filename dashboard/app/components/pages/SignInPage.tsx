import { Copy, ExternalLink, LogIn, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, MGMT, mgmt } from "$lib/api";
import { copyText, toast } from "$lib/feedback";
import { parseJSON, useTask } from "$lib/management";
import type { OAuthStart, OAuthStatus, PluginList } from "$lib/mgmt-types";
import { revalidate, useResource } from "$lib/resource";
import { href } from "$lib/router";
import { JSONInput, TextField } from "../editors";
import {
  Button,
  cx,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Panel,
  StatusPill,
} from "../ui";
import { ProviderLogo, providerTitle } from "./MonitorPages";

export function safeLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function SignInPage({ params }: { params: URLSearchParams }) {
  const [provider, setProvider] = useState(params.get("provider") || "claude");
  const [flow, setFlow] = useState<OAuthStart>();
  const [flowProvider, setFlowProvider] = useState("");
  const [phase, setPhase] = useState<"idle" | "waiting" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState<string>();
  const [redirect, setRedirect] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [options, setOptions] = useState("{}");
  const [location, setLocation] = useState("");
  const [vertex, setVertex] = useState<File>();
  const mounted = useRef(true);
  const current = useRef<OAuthStart | undefined>(undefined);
  const startController = useRef<AbortController | undefined>(undefined);
  const task = useTask();
  const plugins = useResource<PluginList>("plugins", () =>
    mgmt.get("/plugins"),
  );
  const pluginProviders = (plugins.data?.plugins ?? []).flatMap((p) => {
    const value = p as unknown as {
      supports_oauth?: boolean;
      oauth_provider?: string;
    };
    return value.supports_oauth && value.oauth_provider
      ? [value.oauth_provider]
      : [];
  });
  const providers = [
    ...new Set([
      "claude",
      "codex",
      "antigravity",
      "kimi",
      "kimi-ai",
      "xai",
      "devin",
      "meta",
      ...pluginProviders,
    ]),
  ];
  const target = params.get("name");
  const binding = params.get("bind") === "true";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      startController.current?.abort();
      if (current.current?.state)
        void mgmt
          .del("/oauth/session", { state: current.current.state })
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!flow?.state || phase !== "waiting") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await mgmt.get<OAuthStatus>(
          "/oauth/status",
          { state: flow!.state },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (response.status === "ok") {
          current.current = undefined;
          setPhase("done");
          toast("Account connected");
          await Promise.all([
            revalidate("credentials"),
            revalidate("overview"),
          ]);
          return;
        }
        if (response.status === "error") {
          setPhase("error");
          setError(
            response.error || "Sign-in failed. Start a new sign-in session.",
          );
          return;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3_000);
    }
    timer = setTimeout(poll, 1_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [flow?.state, phase]);
  async function start() {
    await task.run(async () => {
      if (current.current?.state)
        await mgmt.del("/oauth/session", { state: current.current.state });
      const controller = new AbortController();
      startController.current = controller;
      const extra = parseJSON(options, "object");
      const response =
        binding && target
          ? await api<OAuthStart>(MGMT + "/oauth/siwc/bind", {
              json: { name: target },
              signal: controller.signal,
            })
          : await api<OAuthStart>(MGMT + "/oauth/auth-url", {
              method: "POST",
              json: {
                ...extra,
                provider,
                is_webui: true,
                ...(target ? { name: target } : {}),
              },
              query: { provider, is_webui: true },
              signal: controller.signal,
            });
      if (!mounted.current) {
        if (response.state)
          await mgmt.del("/oauth/session", { state: response.state });
        return;
      }
      if (!response.state)
        throw new Error(
          "The server returned no sign-in session state. Start again.",
        );
      current.current = response;
      setFlow(response);
      setFlowProvider(provider);
      setPhase("waiting");
      setError(undefined);
      setRedirect("");
    });
  }
  async function cancel() {
    await task.run(async () => {
      if (current.current?.state)
        await mgmt.del("/oauth/session", { state: current.current.state });
      current.current = undefined;
      setFlow(undefined);
      setPhase("idle");
      setError(undefined);
    });
  }
  return (
    <>
      <PageHeader
        title="Sign in"
        description="Connect subscription accounts without copying tokens into your config."
      />
      <div className="grid items-start gap-5 xl:grid-cols-[1.2fr_1fr]">
        <Panel
          title={
            binding
              ? "Bind ChatGPT sign-in"
              : target
                ? "Recover an existing account"
                : "Connect an account"
          }
          bodyClassName="space-y-5 p-4 sm:p-5"
        >
          {target && (
            <p className="break-words rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px]">
              Target credential: {target}. Use the same account to recover it.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {providers.map((p) => (
              <button
                key={p}
                disabled={phase === "waiting" || binding || task.busy}
                onClick={() => setProvider(p)}
                aria-pressed={p === provider}
                className={cx(
                  "flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-60",
                  p === provider
                    ? "border-fg bg-surface-2"
                    : "border-line text-fg-2 hover:border-line-strong hover:bg-surface-2",
                )}
              >
                <ProviderLogo provider={p} />
                <span className="text-[12px]">{providerTitle(p)}</span>
              </button>
            ))}
          </div>
          <p className="max-w-[65ch] text-[12px] text-fg-2">
            Start sign-in, open the provider’s page, then complete
            authorization. If the callback page cannot open, paste its full URL
            below. Leaving this page cancels a pending session.
          </p>
          {phase !== "waiting" && (
            <>
              <button
                className="text-[12px] text-fg-2 underline hover:text-fg"
                onClick={() => setAdvanced((v) => !v)}
              >
                {advanced ? "Hide" : "Show"} provider options
              </button>
              {advanced && (
                <JSONInput
                  label="Additional sign-in options"
                  value={options}
                  onChange={setOptions}
                  rows={5}
                />
              )}
              <div>
                <Button
                  variant="primary"
                  icon={<LogIn />}
                  busy={task.busy}
                  onClick={() => void start()}
                >
                  {phase === "done"
                    ? "Connect another account"
                    : binding
                      ? "Start binding"
                      : `Sign in to ${providerTitle(provider)}`}
                </Button>
              </div>
            </>
          )}
          {task.error && <ErrorNote error={task.error} />}
          {phase === "done" && (
            <div className="space-y-3">
              <StatusPill tone="ok">Account connected</StatusPill>
              <p className="text-[12px] text-fg-2">
                Credentials were saved by the server.
              </p>
              <a
                href={href("credentials")}
                className="text-accent hover:underline"
              >
                Manage credentials
              </a>
            </div>
          )}
        </Panel>
        <Panel
          title="Import Vertex service account"
          description="Upload a Google Cloud service-account JSON file."
          bodyClassName="space-y-4 p-4 sm:p-5"
        >
          <Field label="Service account JSON">
            {(id) => (
              <Input
                id={id}
                type="file"
                accept=".json,application/json"
                onChange={(e) => setVertex(e.target.files?.[0])}
                className="h-auto py-2 file:mr-2 file:text-fg-2"
              />
            )}
          </Field>
          <TextField
            label="Location (optional)"
            value={location}
            onChange={setLocation}
            hint="For example, us-central1."
          />
          <Button
            icon={<Upload />}
            busy={task.busy}
            disabled={!vertex}
            onClick={() =>
              void task.run(async () => {
                if (!vertex) return;
                const form = new FormData();
                form.append("file", vertex);
                if (location.trim()) form.append("location", location.trim());
                await api(MGMT + "/oauth/import", {
                  form,
                  query: { provider: "vertex" },
                });
                setVertex(undefined);
                await revalidate("credentials");
              }, "Vertex credential imported")
            }
          >
            Import service account
          </Button>
        </Panel>
      </div>
      {phase === "waiting" && flow && (
        <Panel
          title={`Complete ${providerTitle(flowProvider)} sign-in`}
          actions={
            <StatusPill tone="info">Waiting for authorization</StatusPill>
          }
          bodyClassName="space-y-4 p-4 sm:p-5"
        >
          {error && <ErrorNote error={error} />}
          {flow.user_code && (
            <div>
              <p className="text-[12px] text-fg-3">Device code</p>
              <div className="mt-1 flex items-center gap-3">
                <code className="text-lg tracking-wider">{flow.user_code}</code>
                <Button
                  size="sm"
                  icon={<Copy />}
                  onClick={() =>
                    void copyText(flow.user_code!, "Device code copied")
                  }
                >
                  Copy code
                </Button>
              </div>
            </div>
          )}
          {safeLink(flow.url) ? (
            <div className="flex flex-wrap gap-2">
              <a
                href={safeLink(flow.url)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 font-medium text-on-primary"
              >
                Open sign-in page
                <ExternalLink className="size-3.5" />
              </a>
              <Button
                icon={<Copy />}
                onClick={() => void copyText(flow.url, "Sign-in URL copied")}
              >
                Copy URL
              </Button>
            </div>
          ) : (
            <p className="text-danger">
              The server did not return a valid sign-in URL.
            </p>
          )}
          <form
            className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void task.run(async () => {
                await mgmt.post("/oauth/callback", {
                  provider: flowProvider,
                  redirect_url: redirect.trim(),
                });
                setError(undefined);
              }, "Callback submitted; waiting for token exchange");
            }}
          >
            <TextField
              label="Full callback URL"
              value={redirect}
              onChange={setRedirect}
              type="url"
              required
              hint="Copy the entire address from the final browser page, including its query string."
            />
            <Button type="submit" busy={task.busy} disabled={!redirect.trim()}>
              Submit callback
            </Button>
          </form>
          <Button
            variant="ghost"
            icon={<X />}
            busy={task.busy}
            onClick={() => void cancel()}
          >
            Cancel sign-in
          </Button>
        </Panel>
      )}
    </>
  );
}
