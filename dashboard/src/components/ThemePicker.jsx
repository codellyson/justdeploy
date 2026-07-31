import { useTheme } from '@codellyson/justui/react';
import { cx } from '../lib/format';
import { Icon } from './icons';

// Inline appearance controls for the Settings page. This replaced a floating dropdown pinned to the
// sidebar, which had nowhere to open: anchored to a button in the bottom-left corner it rendered
// off the left edge and below the fold.
export function ThemePicker() {
  const { themeId, mode, themes, setThemeId, toggleMode } = useTheme();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Mode</div>
          <div className="text-sm text-muted">Currently {mode}.</div>
        </div>
        <button
          onClick={toggleMode}
          className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-medium transition hover:border-muted/50"
        >
          {mode === 'dark' ? <Icon.Sun className="h-4 w-4" /> : <Icon.Moon className="h-4 w-4" />}
          Switch to {mode === 'dark' ? 'light' : 'dark'}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-sm font-medium">Theme</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {themes.map((t) => (
            <button
              key={t.id}
              onClick={() => setThemeId(t.id)}
              className={cx(
                'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition',
                t.id === themeId
                  ? 'border-accent bg-accent/[0.1] text-primary'
                  : 'border-border bg-bg-secondary text-secondary hover:border-accent/50',
              )}
            >
              <span className="h-4 w-4 shrink-0 rounded border border-border" style={{ background: t.swatch?.[mode] || t.swatch?.dark }} />
              <span className="truncate">{t.label}</span>
              {t.id === themeId && <Icon.Check className="ml-auto h-4 w-4 shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
