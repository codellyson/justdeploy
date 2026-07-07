import { cx, typeLabel } from '../lib/format';
import { TypeIcon } from './icons';

// --- status → tone system (theme-agnostic; tones resolve to justui token classes) ---
export const STATUS_META = {
  ok: { label: 'Running', tone: 'success' },
  running: { label: 'Deploying', tone: 'accent' },
  failed: { label: 'Failed', tone: 'danger' },
  idle: { label: 'Idle', tone: 'muted' },
};
const TONE = {
  success: { text: 'text-success', soft: 'bg-success/[0.14]', dot: 'bg-success' },
  danger: { text: 'text-danger', soft: 'bg-danger/[0.13]', dot: 'bg-danger' },
  warning: { text: 'text-warning', soft: 'bg-warning/[0.14]', dot: 'bg-warning' },
  accent: { text: 'text-accent', soft: 'bg-accent/[0.14]', dot: 'bg-accent' },
  muted: { text: 'text-muted', soft: 'surface-2', dot: 'bg-muted' },
};
export const tone = (t) => TONE[t] || TONE.muted;

const DOT = { ok: 'bg-success', running: 'bg-warning', failed: 'bg-danger', idle: 'bg-muted' };

export function StatusDot({ status = 'idle', size = 'h-2 w-2', ring = false, className }) {
  return (
    <span className={cx('relative inline-flex', className)}>
      {ring && status !== 'idle' && (
        <span className={cx('absolute inline-flex h-full w-full rounded-full opacity-60', DOT[status], status === 'running' && 'pulse-dot')} />
      )}
      <span className={cx('relative inline-block rounded-full', size, DOT[status] || 'bg-muted', status === 'running' && 'pulse-dot')} />
    </span>
  );
}

// A soft-filled status pill: colored dot + label on a tinted background.
export function StatusPill({ status = 'idle', className }) {
  const m = STATUS_META[status] || STATUS_META.idle;
  const c = tone(m.tone);
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', c.soft, c.text, className)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', c.dot, status === 'running' && 'pulse-dot')} />
      {m.label}
    </span>
  );
}

// An icon in a soft-tinted rounded square (stat cards, activity, buttons).
export function SoftIcon({ icon: I, tone: t = 'accent', size = 'h-8 w-8', className }) {
  const c = tone(t);
  return (
    <span className={cx('grid shrink-0 place-items-center rounded-lg', c.soft, c.text, size, className)}>
      <I className="h-4 w-4" />
    </span>
  );
}

// Circular framework-icon avatar for an app.
export function Avatar({ type, size = 'h-9 w-9', icon = 'h-[1.05rem] w-[1.05rem]', className }) {
  return (
    <span className={cx('grid shrink-0 place-items-center rounded-full border border-border bg-bg text-secondary', size, className)}>
      <TypeIcon type={type} className={icon} />
    </span>
  );
}

export function TypeBadge({ type }) {
  return (
    <span className="chip">
      <TypeIcon type={type} className="h-3.5 w-3.5" />
      {typeLabel(type)}
    </span>
  );
}

export function Spinner({ className }) {
  return (
    <span className={cx('spin inline-block rounded-full border-2 border-border border-t-accent', className || 'h-4 w-4')} />
  );
}

export function Mono({ children, className }) {
  return <span className={cx('font-mono text-[0.82em]', className)}>{children}</span>;
}

// Labelled value used on detail pages.
export function Meta({ label, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-tiny">{label}</span>
      <span className="text-sm text-primary">{children}</span>
    </div>
  );
}
