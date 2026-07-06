import { useEffect, useRef, useState } from 'react';
import { useTheme } from '@codellyson/justui/react';
import { cx } from '../lib/format';

export function ThemeMenu() {
  const { themeId, mode, themes, setThemeId, toggleMode } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Theme"
        className="grid h-9 w-9 place-items-center rounded-lg border border-border text-secondary transition hover:border-accent hover:text-primary"
      >
        <span className="text-base leading-none">{mode === 'dark' ? '◐' : '◑'}</span>
      </button>
      {open && (
        <div className="animate-rise surface-solid absolute right-0 top-11 z-50 w-56 p-1.5 shadow-2xl">
          <button
            onClick={() => { toggleMode(); }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-secondary transition hover:bg-bg hover:text-primary"
          >
            <span>{mode === 'dark' ? '☀' : '☾'}</span> Switch to {mode === 'dark' ? 'light' : 'dark'}
          </button>
          <div className="my-1 h-px bg-border" />
          {themes.map((t) => (
            <button
              key={t.id}
              onClick={() => { setThemeId(t.id); }}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition',
                t.id === themeId ? 'bg-accent/15 text-primary' : 'text-secondary hover:bg-bg hover:text-primary',
              )}
            >
              <span
                className="h-4 w-4 rounded border border-border"
                style={{ background: t.swatch?.[mode] || t.swatch?.dark }}
              />
              {t.label}
              {t.id === themeId && <span className="ml-auto text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
