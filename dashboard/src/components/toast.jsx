import { useEffect, useState } from 'react';
import { cx } from '../lib/format';

const listeners = new Set();
let seq = 0;

export function toast(message, kind = 'info') {
  const t = { id: ++seq, message, kind };
  listeners.forEach((l) => l(t));
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const add = (t) => {
      setItems((cur) => [...cur, t]);
      setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== t.id)), 3200);
    };
    listeners.add(add);
    return () => listeners.delete(add);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[200] flex flex-col items-center gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            'animate-rise pointer-events-auto surface-solid px-4 py-2.5 text-sm shadow-2xl',
            t.kind === 'error' && 'border-danger/50 text-danger',
            t.kind === 'success' && 'border-success/40',
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
