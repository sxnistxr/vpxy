import { AnimatePresence, m } from "motion/react";
import { Check, CircleAlert, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { confirmRequest, dismissToast, toasts } from "$lib/feedback";
import { useStore } from "$lib/store";
import { Button, cx, Input } from "./ui";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
  sheet = false,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  sheet?: boolean;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (dismissible && event.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
      className={cx(
        "fixed max-h-[calc(100dvh-32px)] overflow-y-auto border border-line-strong bg-surface p-0 text-fg shadow-[var(--shadow-pop)] backdrop:bg-[var(--overlay)]",
        sheet
          ? "inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-[min(620px,100vw)] rounded-l-xl"
          : "inset-0 m-auto w-[calc(100%-32px)] rounded-xl",
        !sheet && (wide ? "max-w-3xl" : "max-w-lg"),
      )}
    >
      {open && (
        <div className="p-5 sm:p-6">
          <header className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && <p className="mt-1 text-fg-2">{description}</p>}
            </div>
            {dismissible && (
              <button
                type="button"
                className="rounded p-1 text-fg-2 hover:bg-surface-2"
                aria-label="Close dialog"
                onClick={onClose}
              >
                <X className="size-4" />
              </button>
            )}
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Feedback() {
  const request = useStore(confirmRequest);
  const items = useStore(toasts);
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [request]);
  function resolve(ok: boolean) {
    request?.resolve(ok);
    confirmRequest.set(null);
  }
  return (
    <>
      <Dialog
        open={!!request}
        title={request?.title ?? "Confirm action"}
        onClose={() => resolve(false)}
      >
        <div className="space-y-4">
          {request?.body && (
            <div className="break-words text-fg-2">{request.body}</div>
          )}
          {request?.typeToConfirm && (
            <label className="grid gap-2">
              Type “{request.typeToConfirm}” to continue
              <Input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => resolve(false)}>Cancel</Button>
            <Button
              variant={request?.danger ? "danger" : "primary"}
              disabled={
                !!request?.typeToConfirm && typed !== request.typeToConfirm
              }
              onClick={() => resolve(true)}
            >
              {request?.confirmLabel}
            </Button>
          </div>
        </div>
      </Dialog>
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed right-4 bottom-4 z-50 grid w-[min(360px,calc(100vw-32px))] gap-2"
      >
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <m.div
              key={item.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="pointer-events-none flex items-start gap-3 rounded-lg border border-line-strong bg-surface-2 p-3 shadow-[var(--shadow-pop)]"
            >
              {item.tone === "danger" ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              ) : (
                <Check className="mt-0.5 size-4 shrink-0 text-ok" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{item.title}</p>
                {item.description && (
                  <p className="mt-1 break-words text-[12px] text-fg-2">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                aria-label="Dismiss notification"
                onClick={() => dismissToast(item.id)}
                className="pointer-events-auto p-0.5 text-fg-2"
              >
                <X className="size-4" />
              </button>
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label = "Search",
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className="relative min-w-0">
      <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-fg-3" />
      <Input
        aria-label={label}
        className="pl-8"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
