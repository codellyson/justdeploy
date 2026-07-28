import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactFlow, { Background, Controls, MiniMap, useNodesState, useEdgesState, MarkerType, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';
import { api } from '../api';
import { TypeIcon, Icon } from '../components/icons';
import { Spinner } from '../components/ui';
import { appHealth, typeLabel, cx } from '../lib/format';
import { AppDetail } from './AppDetail';
import { DatabaseDetail } from './DatabaseDetail';

// Railway-style status line for a service node.
function svcStatus(n) {
  if (n.kind !== 'app') return { text: 'Database', tone: 'text-muted', dot: 'bg-accent' };
  if (n.deploying) return { text: 'Deploying…', tone: 'text-secondary', dot: 'bg-warning' };
  const h = appHealth(n);
  if (h === 'ok' || h === 'running') return { text: 'Service is online', tone: 'text-secondary', dot: 'bg-success' };
  if (h === 'failed') return { text: 'Service is offline', tone: 'text-muted', dot: 'bg-danger' };
  return { text: 'Not deployed', tone: 'text-muted', dot: 'bg-muted' };
}

// Simple circular seed layout — React Flow owns positions after that (drag/pan/zoom).
function seedPositions(nodes) {
  const p = {};
  const R = Math.max(180, nodes.length * 34);
  nodes.forEach((n, i) => {
    const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    p[n.name] = { x: 400 + Math.cos(a) * R, y: 300 + Math.sin(a) * R * 0.7 };
  });
  return p;
}

// A service card rendered as a React Flow node.
function ServiceNode({ data }) {
  const n = data.node;
  const st = svcStatus(n);
  return (
    <div className="w-[220px] rounded-2xl border border-border bg-bg-secondary p-3.5 shadow-lg transition hover:border-accent/60">
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-accent/60" />
      <div className="flex items-center gap-2.5">
        <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-lg', n.kind === 'postgres' ? 'bg-accent/[0.12] text-accent' : 'bg-bg')}>
          {n.kind === 'postgres' ? <Icon.Database className="h-4 w-4" /> : <TypeIcon type={n.type} className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{n.name}</div>
          <div className="truncate font-mono text-[0.62rem] text-muted">{n.kind === 'postgres' ? 'postgres' : typeLabel(n.type)}</div>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        <span className={cx('h-1.5 w-1.5 rounded-full', st.dot)} />
        <span className={cx('text-xs', st.tone)}>{st.text}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-accent/60" />
    </div>
  );
}

const nodeTypes = { service: ServiceNode };

export function Canvas() {
  const navigate = useNavigate();
  const { name: project } = useParams(); // set on /projects/:name, undefined on /canvas
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const ready = useRef(false);
  const posRef = useRef({}); // remember positions across polls / drags
  const [sel, setSel] = useState(null); // { name, kind, project } — open in the side drawer

  useEffect(() => {
    let live = true;
    ready.current = false; posRef.current = {};
    setNodes([]); setEdges([]);
    const load = () => api.graph(project).then((g) => {
      if (!live) return;
      const seed = seedPositions(g.nodes);
      setNodes((prev) => {
        const prevPos = Object.fromEntries(prev.map((nd) => [nd.id, nd.position]));
        return g.nodes.map((n) => ({
          id: n.name,
          type: 'service',
          position: prevPos[n.name] || posRef.current[n.name] || seed[n.name],
          data: { node: n },
          draggable: true,
        }));
      });
      setEdges(g.edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'rgb(148 130 90)' },
        style: { stroke: 'rgb(148 130 90 / 0.55)', strokeWidth: 1.5 },
      })));
      ready.current = true;
    }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [project, setNodes, setEdges]);

  // Persist positions as the user drags so a poll refresh doesn't reset them.
  const onNodeDragStop = useCallback((_e, node) => { posRef.current[node.id] = node.position; }, []);

  // Esc closes the service drawer.
  useEffect(() => {
    if (!sel) return;
    const onKey = (e) => e.key === 'Escape' && setSel(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel]);

  const onNodeClick = useCallback((_e, node) => {
    const n = node.data.node;
    setSel({ name: n.name, kind: n.kind === 'postgres' ? 'db' : 'app', project: project || n.project || 'default' });
  }, [project]);

  const empty = ready.current && nodes.length === 0;
  const bg = useMemo(() => 'rgb(var(--border))', []);

  return (
    // Full-bleed canvas: fill the viewport to the right of the sidebar (w-56 = 14rem).
    <div className="fixed inset-y-0 right-0 z-0" style={{ left: '14rem' }}>
      {/* floating breadcrumb (top-left) */}
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-2">
        <Link to="/" className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-border bg-bg-secondary/90 px-2.5 py-1.5 text-sm text-muted backdrop-blur transition hover:text-primary">
          <Icon.ArrowLeft className="h-4 w-4" /> {project ? 'Projects' : 'Overview'}
        </Link>
        <span className="rounded-lg border border-border bg-bg-secondary/90 px-2.5 py-1.5 text-sm font-semibold backdrop-blur">{project || 'Canvas'}</span>
      </div>
      {/* floating add button (top-right) */}
      {project && (
        <button onClick={() => navigate(`/new?project=${project}`)} className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] shadow-lg transition hover:brightness-[1.06]">
          <Icon.Plus className="h-4 w-4" /> Add service
        </button>
      )}

      {!ready.current ? (
        <div className="grid h-full place-items-center"><Spinner className="h-6 w-6" /></div>
      ) : empty ? (
        <div className="grid h-full place-items-center text-center text-muted">
          <div className="flex flex-col items-center gap-3">
            <Icon.Layers className="h-8 w-8 opacity-40" />
            <p className="text-sm">{project ? 'This project has no services yet.' : 'No apps yet — deploy one and it’ll appear here.'}</p>
            {project && <button onClick={() => navigate(`/new?project=${project}`)} className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]"><Icon.Plus className="h-4 w-4" /> New service</button>}
          </div>
        </div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.8}
          className="bg-bg"
        >
          <Background variant="dots" gap={22} size={1} color={bg} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor="rgb(var(--accent) / 0.5)" maskColor="rgb(0 0 0 / 0.55)" />
        </ReactFlow>
      )}

      {/* Service drawer — slides in over the canvas, Railway-style. */}
      {sel && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setSel(null)} />
          <div className="animate-rise absolute inset-y-0 right-0 z-20 flex w-[62%] min-w-[420px] max-w-[920px] flex-col border-l border-border bg-bg shadow-2xl">
            <button onClick={() => setSel(null)} title="Close (Esc)" className="absolute right-4 top-4 z-10 grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-bg-secondary hover:text-primary">
              <Icon.X className="h-4 w-4" />
            </button>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {sel.kind === 'db'
                ? <DatabaseDetail key={sel.name} name={sel.name} project={sel.project} onClose={() => setSel(null)} />
                : <AppDetail key={sel.name} name={sel.name} project={sel.project} onClose={() => setSel(null)} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
