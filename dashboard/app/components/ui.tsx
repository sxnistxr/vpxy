import { m } from "motion/react";
import { LoaderCircle } from "lucide-react";
import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export const EASE = [0.2, 0, 0, 1] as const;

function selectWithKeys(
  event: KeyboardEvent<HTMLDivElement>,
  role: "tab" | "radio",
) {
  const keys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
  ];
  if (!keys.includes(event.key)) return;
  const buttons = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      `button[role="${role}"]`,
    ),
  );
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current +
            (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
            buttons.length) %
          buttons.length;
  buttons[next]?.focus();
  buttons[next]?.click();
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonVariant: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-on-primary hover:opacity-90 border border-transparent",
  secondary:
    "bg-surface-2 text-fg border border-line-strong hover:bg-surface-3",
  ghost: "text-fg-2 border border-transparent hover:bg-surface-2 hover:text-fg",
  danger:
    "text-danger border border-danger/40 hover:bg-danger hover:text-white hover:border-danger focus-visible:bg-danger focus-visible:text-white",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy,
  className,
  children,
  type = "button",
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
        buttonVariant[variant],
        className,
      )}
      {...rest}
    >
      {busy ? (
        <LoaderCircle className="animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const control =
  "min-w-0 rounded-md border border-line-strong bg-surface-2 px-2.5 text-[13px] text-fg transition-colors duration-150 outline-none placeholder:text-fg-3 hover:border-fg-3/60 focus:border-accent focus-visible:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60 aria-invalid:border-danger";

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(control, "h-8 w-full", className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(control, "w-full min-h-20 py-2 leading-5", className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        control,
        "h-8 cursor-pointer pr-7",
        !/(^|\s)w-/.test(className ?? "") && "w-full",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  busy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
        busy && "animate-pulse",
      )}
    >
      <m.span
        aria-hidden="true"
        className="block size-3.5 rounded-full bg-white shadow-sm"
        initial={false}
        animate={{ x: checked ? 18 : 2 }}
        transition={{ type: "spring", bounce: 0, visualDuration: 0.18 }}
      />
    </button>
  );
}

export function Checkbox({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cx(
        "size-4 cursor-pointer rounded border-line-strong accent-[var(--accent)]",
        className,
      )}
      {...rest}
    />
  );
}

/** Label + control + hint/error, wired with ids for assistive tech. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className={cx("grid gap-1.5", className)}>
      <label htmlFor={id} className="text-[12px] font-medium text-fg-2">
        {label}
      </label>
      {children(id, hintId)}
      {(error || hint) && (
        <p
          id={hintId}
          className={cx("text-[12px]", error ? "text-danger" : "text-fg-3")}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cx(
        "min-w-0 rounded-lg border border-line bg-surface",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[14px] leading-5 font-semibold">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-[12px] text-fg-3">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export type Tone = "ok" | "warn" | "danger" | "neutral" | "info";

const pillTone: Record<Tone, string> = {
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn",
  danger: "bg-danger/12 text-danger",
  neutral: "bg-surface-3 text-fg-2",
  info: "bg-accent/12 text-accent",
};

const dotTone: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  neutral: "bg-fg-3",
  info: "bg-accent",
};

export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[12px] leading-none font-medium whitespace-nowrap",
        pillTone[tone],
        className,
      )}
    >
      <span
        className={cx("size-1.5 rounded-full", dotTone[tone])}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      className={cx(
        "inline-block size-2 shrink-0 rounded-full",
        dotTone[tone],
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function Badge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center rounded px-1.5 text-[12px] leading-none text-fg-2 bg-surface-3",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Remaining share -> tone, per the design system: ok > 25 %, warn 10-25 %, danger < 10 %. */
export function remainingTone(remaining: number): Tone {
  if (remaining > 25) return "ok";
  if (remaining >= 10) return "warn";
  return "danger";
}

const barTone: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  neutral: "bg-fg-3",
  info: "bg-accent",
};

/** A thin bar showing what is left; the fill animates to new readings. */
export function Bar({
  percent,
  tone,
  className,
  label,
}: {
  percent: number;
  tone: Tone;
  className?: string;
  label: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cx(
        "h-1.5 overflow-hidden rounded-full bg-surface-3",
        className,
      )}
    >
      <m.div
        className={cx("h-full origin-left rounded-full", barTone[tone])}
        initial={false}
        animate={{ scaleX: clamped / 100 }}
        transition={{ duration: 0.4, ease: EASE }}
      />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden="true" />;
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-8">
      <p className="text-[14px] font-semibold">{title}</p>
      {children && (
        <div className="max-w-[60ch] text-[13px] text-fg-2">{children}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({
  error,
  onRetry,
}: {
  error: Error | string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger/8 px-4 py-3 text-[13px]"
    >
      <span className="min-w-0 flex-1">
        {typeof error === "string" ? error : error.message}
      </span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-sans text-[11px] leading-4 text-fg-2">
      {children}
    </kbd>
  );
}

/** Pills for filters: one selected value out of a few. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; count?: number }[];
  onChange: (value: T) => void;
  label: string;
}) {
  const group = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => selectWithKeys(event, "radio")}
      className="inline-flex h-8 items-center rounded-md border border-line bg-surface p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cx(
              "relative inline-flex h-full items-center gap-1.5 rounded px-2.5 text-[12px] font-medium transition-colors duration-150",
              active ? "text-fg" : "text-fg-2 hover:text-fg",
            )}
          >
            {active && (
              <m.span
                layoutId={`${group}-seg`}
                className="absolute inset-0 rounded bg-surface-3"
                transition={{ type: "spring", bounce: 0, visualDuration: 0.2 }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {option.label}
              {option.count !== undefined && (
                <span className="text-fg-3">{option.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Underline tabs for page sections. */
export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  label,
}: {
  value: T;
  tabs: { value: T; label: ReactNode; count?: number }[];
  onChange: (value: T) => void;
  label: string;
}) {
  const group = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => selectWithKeys(event, "tab")}
      className="flex gap-4 overflow-x-auto border-b border-line scrollbar-thin"
    >
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cx(
              "relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 text-[13px] font-medium transition-colors duration-150",
              active ? "text-fg" : "text-fg-2 hover:text-fg",
            )}
          >
            {tab.label}
            {tab.count !== undefined && <Badge>{tab.count}</Badge>}
            {active && (
              <m.span
                layoutId={`${group}-tab`}
                className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-fg"
                transition={{ type: "spring", bounce: 0, visualDuration: 0.2 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Page title row: title and one-line description left, actions right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em]">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-[72ch] text-[13px] text-fg-2">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/** A stat readout: label, number, one line of context. */
export function Stat({
  label,
  value,
  detail,
  children,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-4">
      <span className="text-[12px] font-medium text-fg-2">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <span className="text-[28px] leading-8 font-semibold tracking-[-0.02em]">
          {value}
        </span>
        {children}
      </div>
      {detail && (
        <span className="truncate text-[12px] text-fg-3">{detail}</span>
      )}
    </div>
  );
}

/** Table header cell with the shared style. */
export function Th({
  children,
  className,
  align = "left",
}: {
  children?: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={cx(
        "h-9 px-3 text-[12px] font-medium whitespace-nowrap text-fg-2",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}
