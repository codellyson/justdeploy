import { cx, typeLabel } from '../lib/format';
import { TypeIcon } from './icons';

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

// Small labelled value used on detail pages.
export function Meta({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label-tiny">{label}</span>
      <span className="text-sm text-primary">{children}</span>
    </div>
  );
}
