// Shapes of GET /vpxy/api/overview (internal/api/vpxy_dashboard.go).

export type QuotaWindow = {
  id: string;
  label: string;
  used_percent: number;
  resets_at?: string;
  status?: string;
};

export type BankedReset = {
  available: number;
  total?: number;
  ends_at?: string;
  usable_now: boolean;
};

export type CacheCounters = {
  requests: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

export type RebuildEvent = {
  at: string;
  model?: string;
  session_id?: string;
  cache_write: number;
  cache_read: number;
};

export type AffinityBreak = {
  session_id: string;
  from: string;
  to: string;
  at: string;
  gap_seconds: number;
};

export type AccountStatus = "ready" | "cooldown" | "limited" | "disabled";

export type Account = {
  auth_id: string;
  priority?: number;
  provider: string;
  plan?: string;
  windows: QuotaWindow[];
  banked?: BankedReset;
  source?: string;
  observed_at?: string;
  polled_at?: string;
  poll_error?: string;
  cache: CacheCounters;
  rebuilds?: RebuildEvent[];
  label: string;
  status: AccountStatus;
  status_until?: string;
  sessions: { count: number; recent: { id: string; expires_in_seconds: number }[] };
};

export type Overview = {
  generated_at: string;
  routing: {
    strategy: string;
    session_affinity: boolean;
    session_ttl_seconds: number;
    rebind_on: string;
    sessions: number;
  };
  monitor: {
    polling_enabled: boolean;
    interval_seconds: number;
    rebuild_alert_tokens: number;
    trusted_networks: boolean;
  };
  accounts: Account[];
  totals: CacheCounters;
  affinity_breaks: AffinityBreak[];
};
