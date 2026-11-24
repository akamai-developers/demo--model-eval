// The small set of parts every screen is built from. Names and props follow
// the Akamai design system (Button, Badge, Card, Callout, StatTile, Tabs), and
// all styling reads the --ak-* tokens.

import { Check, Copy, Star, X } from "lucide-react";
import { useEffectEvent, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../lib/format";

type Tone = "neutral" | "navy" | "blue" | "green" | "orange" | "red";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={cx("btn", `btn-${variant}`, `btn-${size}`, !children && "btn-icon", className)}
    >
      {icon}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={cx("badge", `badge-${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function Card({
  className,
  children,
  as: Tag = "section",
  ...rest
}: { className?: string; children: ReactNode; as?: "section" | "div" | "article" } & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag {...rest} className={cx("card", className)}>
      {children}
    </Tag>
  );
}

export function Callout({ tone = "blue", title, children }: { tone?: "blue" | "orange" | "red"; title?: string; children: ReactNode }) {
  return (
    <div className={cx("callout", `callout-${tone}`)} role={tone === "red" ? "alert" : "note"}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function StatTile({ label, value, detail, accent }: { label: string; value: ReactNode; detail?: ReactNode; accent?: boolean }) {
  return (
    <div className={cx("stat", accent && "stat-accent")}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {detail && <div className="stat-detail">{detail}</div>}
    </div>
  );
}

/** A row of choices where exactly one is on. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cx("segmented", `segmented-${size}`)} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          className={cx("segment", option.value === value && "is-on")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** A meter: one hue, length carries the value, and the number sits beside it. */
export function Meter({ value, label, strong }: { value: number | null; label?: string; strong?: boolean }) {
  return (
    <span className={cx("meter", strong && "meter-strong")} role="img" aria-label={label}>
      <span className="meter-fill" style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }} />
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Working" />;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={copied ? <Check size={14} /> : <Copy size={14} />}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function Stars({ value, onChange, label }: { value: number; onChange?: (value: number) => void; label: string }) {
  return (
    <span className="stars" role={onChange ? "radiogroup" : "img"} aria-label={`${label}: ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            className={cx("star", n <= value && "is-on")}
            onClick={() => onChange(value === n ? 0 : n)}
          >
            <Star size={16} />
          </button>
        ) : (
          <span key={n} className={cx("star", n <= value && "is-on")}>
            <Star size={13} />
          </span>
        ),
      )}
    </span>
  );
}

/** A native modal keeps keyboard focus inside the panel, including embedded previews. */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const dismiss = useEffectEvent(onClose);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const onNavigation = () => dismiss();
    window.addEventListener("popstate", onNavigation);
    return () => {
      window.removeEventListener("popstate", onNavigation);
      dialog.close();
      opener?.focus?.();
    };
  }, [open]);
  return ref;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  full,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  full?: boolean;
}) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <dialog ref={ref} className="overlay" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("modal", wide && "modal-wide", full && "modal-full")}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<X size={18} />} onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <dialog ref={ref} className="overlay overlay-right" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer">
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="drawer-sub">{subtitle}</div>}
          </div>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<X size={18} />} onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
      </aside>
    </dialog>
  );
}
