// Shapes of the /v8/management API (internal/api/handlers/management). Only the fields the
// console reads are typed; the API sends more.

export type Cooldown = {
  scope: string;
  model_key?: string;
  reason: string;
  retry_at: string;
  remaining_seconds: number;
  backoff_level?: number;
  http_status?: number;
};

export type RecentBucket = { time: string; success: number; failed: number };

export type Credential = {
  id: string;
  name: string;
  provider?: string;
  type?: string;
  label?: string;
  email?: string;
  account?: string;
  account_type?: string;
  display_name?: string;
  project_id?: string;
  status?: string;
  status_message?: string;
  disabled?: boolean;
  unavailable?: boolean;
  runtime_only?: boolean;
  source?: string;
  size?: number;
  modtime?: string;
  updated_at?: string;
  last_refresh?: string;
  success?: number;
  failed?: number;
  recent_requests?: RecentBucket[];
  cooldowns?: Cooldown[] | null;
  quota_blocked?: boolean;
  requires_sign_in?: boolean;
  renewal_state?: string;
  recovery_stage?: string;
  recovery_hint?: string;
  next_action?: string;
  refresh_error?: { code?: string; message?: string; http_status?: number };
  access_token_expires_at?: string;
  next_refresh_after?: string;
  auth_index?: string;
  priority?: number;
  note?: string;
  websockets?: boolean;
  request_retry?: number;
  siwc_bind_supported?: boolean;
  siwc_status?: string;
  siwc_bound?: boolean;
  use_siwc?: boolean;
};

export type CredentialList = { files: Credential[]; observed_at?: string };

/** Editable fields of a credential file (PATCH /credentials/fields). */
export type CredentialFields = {
  prefix?: string;
  proxy_url?: string;
  priority?: number;
  weight?: number | null;
  note?: string;
  disable_cooling?: boolean;
  websockets?: boolean;
  use_siwc?: boolean;
  headers?: Record<string, string>;
  excluded_models?: string[];
  request_retry?: number | null;
};

export type ModelInfo = { id: string; display_name?: string; owned_by?: string; type?: string };

export type OAuthStart = { url: string; state?: string; user_code?: string; flow?: string; expires_in?: number; status?: string };
export type OAuthStatus = { status: "ok" | "wait" | "error"; error?: string };

export type PluginInfo = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  repository?: string;
  homepage?: string;
  logo?: string;
  enabled?: boolean;
  effective_enabled?: boolean;
  configured?: boolean;
  registered?: boolean;
  installed?: boolean;
  installed_version?: string;
  update_available?: boolean;
  auth_required?: boolean;
  tags?: string[];
  license?: string;
  path?: string;
  store_id?: string;
  source_name?: string;
};

export type PluginList = { plugins_enabled: boolean; plugins_dir: string; plugins: PluginInfo[] };

export type ErrorLogFile = { name: string; size?: number; modified?: number };

export type LogsPage = { lines?: string[]; "latest-timestamp"?: number | string; "next-cursor"?: string; "cursor-reset"?: boolean };

/** One provider API-key group in the v8 layout (api-keys.<family>[]). */
export type KeyGroup = {
  name?: string;
  "base-url"?: string;
  prefix?: string;
  priority?: number;
  "proxy-url"?: string;
  headers?: Record<string, string>;
  models?: { name: string; alias?: string; "display-name"?: string }[];
  "excluded-models"?: string[];
  "disable-cooling"?: boolean;
  "request-retry"?: number;
  keys?: { "api-key"?: string; weight?: number; [field: string]: unknown }[];
  [field: string]: unknown;
};

export type ModelAlias = { name: string; alias: string; fork?: boolean };

export type RoutingConfig = {
  strategy?: string;
  "session-affinity"?: boolean;
  "session-affinity-ttl"?: string;
  "session-affinity-rebind-on"?: string;
  "force-model-prefix"?: boolean;
  retry?: { "request-retry"?: number; "max-retry-credentials"?: number; "max-retry-interval"?: number };
  cooldown?: { "disable-cooling"?: boolean; "save-cooldown-status"?: boolean; "transient-error-cooldown-seconds"?: number };
  [field: string]: unknown;
};

/** GET /config: the persisted configuration in the v8 layout, without runtime defaults. */
export type ConfigV8 = {
  server?: { host?: string; port?: number; [field: string]: unknown };
  management?: { "allow-remote"?: boolean; [field: string]: unknown };
  access?: { "api-keys"?: string[] } | null;
  routing?: RoutingConfig;
  requests?: { "proxy-url"?: string; [field: string]: unknown };
  observability?: {
    logs?: { debug?: boolean; "logging-to-file"?: boolean; "request-log"?: boolean; "logs-max-total-size-mb"?: number; "error-logs-max-files"?: number };
    usage?: { "usage-statistics-enabled"?: boolean };
  };
  "trusted-networks"?: { enabled?: boolean; cidrs?: string[]; "allowed-hosts"?: string[] };
  "quota-monitor"?: { disabled?: boolean; interval?: string; "rebuild-alert-tokens"?: number };
  [section: string]: unknown;
};
