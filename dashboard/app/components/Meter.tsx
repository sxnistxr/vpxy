import { remainingPercent, resetText, tone, type Tone } from "$lib/format";
import type { QuotaWindow } from "$lib/types";

export const toneBg: Record<Tone, string> = { full: "bg-full", mid: "bg-mid", low: "bg-low" };

/** One rate-limit window: what is left of it and when it resets. */
export function Meter({ window, now }: { window: QuotaWindow; now: Date }) {
  const left = remainingPercent(window);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="truncate text-muted">{window.label}</span>
        <span className="font-semibold">{left}%</span>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-label={`${window.label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
      >
        <div className={`h-full rounded-full ${toneBg[tone(left)]}`} style={{ width: `${left}%` }} />
      </div>
      <p className="mt-1.5 truncate text-xs text-faint">{resetText(window.resets_at, now)}</p>
    </div>
  );
}
