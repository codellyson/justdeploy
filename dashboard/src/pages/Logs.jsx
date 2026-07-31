import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { cx } from '../lib/format';

const MAX_LINES = 3000; // ring buffer — a chatty app must not grow the tab without bound

// A stable colour per app so you can tell streams apart at a glance without reading the tag.
const HUES = [200, 150, 40, 330, 265, 15, 95, 305];
const hueFor = (name) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
};

export function Logs() {
  const [lines, setLines] = useState([]);
  const [apps, setApps] = useState([]);
  const [hidden, setHidden] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [connected, setConnected] = useState(false);
  const boxRef = useRef(null);
  const pausedRef = useRef(false);
  const atBottom = useRef(true);
  const seq = useRef(0);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('apps', (e) => {
      try { setApps(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    es.onmessage = (e) => {
      if (pausedRef.current) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
        next.push({ id: seq.current++, app: msg.app, line: msg.line });
        return next;
      });
    };
    return () => es.close();
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines.filter((l) => !hidden.has(l.app) && (!needle || l.line.toLowerCase().includes(needle) || l.app.includes(needle)));
  }, [lines, hidden, q]);

  // Follow the tail only while the user is already at the bottom — scrolling up to read
  // something must not be yanked away by the next line arriving.
  useEffect(() => {
    const box = boxRef.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [shown.length]);

  const onScroll = () => {
    const box = boxRef.current;
    if (box) atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  };

  const toggle = (name) => setHidden((prev) => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  const counts = useMemo(() => {
    const c = {};
    for (const l of lines) c[l.app] = (c[l.app] || 0) + 1;
    return c;
  }, [lines]);

  return (
    <div className="animate-rise flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Logs</h1>
          <p className="mt-0.5 text-sm text-muted">Every service on this box, live, in one stream.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cx('flex items-center gap-1.5 text-xs', connected ? 'text-success' : 'text-muted')}>
            <span className={cx('h-1.5 w-1.5 rounded-full', connected ? 'bg-success' : 'bg-muted')} />
            {connected ? 'streaming' : 'reconnecting…'}
          </span>
          <button onClick={() => setPaused((p) => !p)} className="rounded-xl border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium transition hover:border-muted/50">
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => setWrap((w) => !w)} className="rounded-xl border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium transition hover:border-muted/50">
            <Icon.Wrap className="h-4 w-4" />
          </button>
          <button onClick={() => setLines([])} className="rounded-xl border border-border bg-bg-secondary px-3 py-1.5 text-sm font-medium transition hover:border-muted/50">
            Clear
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {apps.map((a) => {
          const off = hidden.has(a.name);
          return (
            <button key={a.name} onClick={() => toggle(a.name)}
              className={cx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition',
                off ? 'border-border bg-transparent text-muted opacity-60' : 'border-transparent text-primary')}
              style={off ? undefined : { background: `hsl(${hueFor(a.name)} 70% 50% / 0.14)` }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${hueFor(a.name)} 70% 55%)` }} />
              {a.name}
              {counts[a.name] ? <span className="text-muted">{counts[a.name]}</span> : null}
            </button>
          );
        })}
        <div className="relative ml-auto min-w-[200px] flex-1 basis-48">
          <Icon.Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter lines…" className="field w-full py-1.5 pl-8 text-sm" />
        </div>
      </div>

      <div ref={boxRef} onScroll={onScroll}
        className="surface h-[65vh] overflow-auto p-3 font-mono text-[0.78rem] leading-[1.5]">
        {shown.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-muted">
            {lines.length ? 'Nothing matches that filter.' : 'Waiting for output…'}
          </div>
        ) : shown.map((l) => (
          <div key={l.id} className={cx('flex gap-2', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
            <span className="shrink-0 select-none" style={{ color: `hsl(${hueFor(l.app)} 60% 60%)` }}>{l.app}</span>
            <span className="text-secondary">{l.line}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">
        Showing {shown.length} of {lines.length} buffered lines (newest {MAX_LINES} kept). Build output stays on each service's own Logs tab.
      </p>
    </div>
  );
}
