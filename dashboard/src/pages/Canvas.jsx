import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { TypeIcon, Icon } from '../components/icons';
import { StatusDot, Spinner } from '../components/ui';
import { appHealth, typeLabel, cx } from '../lib/format';

const NW = 176, NH = 66; // node card size

// Lightweight force-directed layout — repulsion between all nodes, springs along edges, gentle
// gravity to center. Runs once; nodes are draggable afterward.
function layout(nodes, edges, w, h) {
  const p = {};
  nodes.forEach((n, i) => {
    const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    p[n.name] = { x: w / 2 + Math.cos(a) * 190, y: h / 2 + Math.sin(a) * 150 };
  });
  for (let it = 0; it < 320; it++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = p[nodes[i].name], b = p[nodes[j].name];
        let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
        const f = 26000 / d2; dx = (dx / d) * f; dy = (dy / d) * f;
        a.x += dx; a.y += dy; b.x -= dx; b.y -= dy;
      }
    }
    for (const e of edges) {
      const a = p[e.from], b = p[e.to]; if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d - 230) * 0.03; dx = (dx / d) * f; dy = (dy / d) * f;
      a.x += dx; a.y += dy; b.x -= dx; b.y -= dy;
    }
    for (const n of nodes) { const q = p[n.name]; q.x += (w / 2 - q.x) * 0.006; q.y += (h / 2 - q.y) * 0.006; }
  }
  return p;
}

// A cubic bezier between two node centers, biased horizontally for a clean routed look.
function edgePath(a, b) {
  const mx = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

export function Canvas() {
  const navigate = useNavigate();
  const [g, setG] = useState(null);
  const [pos, setPos] = useState({});
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  const drag = useRef(null);

  useEffect(() => {
    let live = true;
    const load = () => api.graph().then((d) => {
      if (!live) return;
      setG(d);
      setPos((prev) => (Object.keys(prev).length ? prev : layout(d.nodes, d.edges, 960, 560)));
    }).catch(() => {});
    load();
    const t = setInterval(load, 4000); // keep statuses live; positions preserved
    return () => { live = false; clearInterval(t); };
  }, []);

  const onDown = (e, name) => {
    e.stopPropagation();
    drag.current = { name, sx: e.clientX, sy: e.clientY, ox: pos[name].x, oy: pos[name].y, moved: false };
  };
  const onPanDown = (e) => { drag.current = { pan: true, sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y }; };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.pan) setPan({ x: d.ox + dx, y: d.oy + dy });
    else setPos((p) => ({ ...p, [d.name]: { x: d.ox + dx, y: d.oy + dy } }));
  };
  const onUp = (name) => {
    const d = drag.current; drag.current = null;
    if (name && d && !d.moved) navigate(g.nodes.find((n) => n.name === name)?.kind === 'postgres' ? `/db/${name}` : `/apps/${name}`);
  };

  if (!g) return <Spinner className="mx-auto my-20 h-6 w-6" />;
  const center = (name) => { const q = pos[name]; return q ? { x: q.x + NW / 2, y: q.y + NH / 2 } : null; };
  const connected = (name) => hover && (name === hover || g.edges.some((e) => (e.from === hover && e.to === name) || (e.to === hover && e.from === name)));

  return (
    <div className="animate-rise">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/" className="mb-1.5 flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-primary"><Icon.ArrowLeft className="h-4 w-4" /> Overview</Link>
          <h1 className="text-2xl font-semibold tracking-tight">Canvas</h1>
          <p className="mt-0.5 text-sm text-muted">Your apps and databases, wired by their <code className="rounded bg-bg-secondary px-1 font-mono text-[0.75rem] text-accent">{'${{ }}'}</code> references. Drag to arrange · click to open.</p>
        </div>
        <button onClick={() => setPos(layout(g.nodes, g.edges, 960, 560))} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium transition hover:border-muted/50"><Icon.Layers className="h-4 w-4" /> Re-arrange</button>
      </div>

      {g.nodes.length === 0 ? (
        <div className="surface grid place-items-center py-24 text-center text-muted">
          <div><Icon.Layers className="mx-auto mb-3 h-8 w-8 opacity-40" /><p className="text-sm">No apps yet — deploy one and it'll appear here.</p></div>
        </div>
      ) : (
        <div
          onMouseDown={onPanDown} onMouseMove={onMove} onMouseUp={() => onUp(null)} onMouseLeave={() => (drag.current = null)}
          className="relative h-[70vh] min-h-[460px] cursor-grab overflow-hidden rounded-2xl border border-border bg-bg active:cursor-grabbing"
          style={{ backgroundImage: 'radial-gradient(rgb(var(--border)) 1px, transparent 1px)', backgroundSize: '22px 22px', backgroundPosition: `${pan.x}px ${pan.y}px` }}
        >
          <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0 }}>
              <defs>
                <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="rgb(var(--accent))" /></marker>
              </defs>
              {g.edges.map((e, i) => {
                const a = center(e.from), b = center(e.to); if (!a || !b) return null;
                const lit = hover && (e.from === hover || e.to === hover);
                return <path key={i} d={edgePath(a, b)} fill="none" markerEnd="url(#arrow)"
                  stroke={lit ? 'rgb(var(--accent))' : 'rgb(var(--accent) / 0.35)'} strokeWidth={lit ? 2 : 1.5} />;
              })}
            </svg>
            {g.nodes.map((n) => {
              const q = pos[n.name]; if (!q) return null;
              const dim = hover && !connected(n.name);
              return (
                <div key={n.name} onMouseDown={(e) => onDown(e, n.name)} onMouseUp={(e) => { e.stopPropagation(); onUp(n.name); }}
                  onMouseEnter={() => setHover(n.name)} onMouseLeave={() => setHover(null)}
                  className={cx('group absolute flex cursor-pointer select-none items-center gap-2.5 rounded-xl border bg-bg-secondary px-3 py-2.5 shadow-lg transition-opacity',
                    n.kind === 'postgres' ? 'border-accent/30' : 'border-border', dim ? 'opacity-40' : 'opacity-100')}
                  style={{ left: q.x, top: q.y, width: NW }}
                >
                  <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-lg', n.kind === 'postgres' ? 'bg-accent/[0.12] text-accent' : 'bg-bg')}>
                    {n.kind === 'postgres' ? <Icon.Database className="h-4 w-4" /> : <TypeIcon type={n.type} className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{n.name}</div>
                    <div className="truncate font-mono text-[0.68rem] text-muted">{n.kind === 'postgres' ? 'postgres' : typeLabel(n.type)}</div>
                  </div>
                  {n.kind === 'app' && <StatusDot status={appHealth(n)} ring size="h-2 w-2" />}
                </div>
              );
            })}
          </div>
          <div className="pointer-events-none absolute bottom-3 left-4 font-mono text-[0.7rem] text-muted">{g.nodes.length} nodes · {g.edges.length} links</div>
        </div>
      )}
    </div>
  );
}
