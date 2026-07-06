import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useVersion, invalidate } from '../lib/store';
import { toast } from '../components/toast';
import { StatusDot, TypeBadge, Mono, Spinner } from '../components/ui';
import { Icon } from '../components/icons';
import { appHealth, shortSha, timeAgo, cx } from '../lib/format';

// Small status indicator for a deploy result.
function DeployGlyph({ status }) {
  if (status === 'ok') return <Icon.Check className="h-3.5 w-3.5 text-success" />;
  if (status === 'failed') return <Icon.X className="h-3.5 w-3.5 text-danger" />;
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning pulse-dot" />;
}

function Stat({ value, label, tone }) {
  return (
    <div className="surface flex flex-col gap-1 p-4">
      <span className={cx('font-mono text-2xl font-semibold tracking-tight', tone || 'text-primary')}>{value}</span>
      <span className="label-tiny">{label}</span>
    </div>
  );
}

export function Overview() {
  const { openNew } = useOutletContext();
  const v = useVersion();
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => api.state().then((s) => live && setState(s)).catch((e) => live && setErr(e.message));
    load();
    const t = setInterval(load, 3500);
    return () => { live = false; clearInterval(t); };
  }, [v]);

  if (err) return <p className="text-sm text-danger">{err}</p>;
  if (!state) return <div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>;

  const apps = state.apps.filter((a) => a.serve !== 'resource');
  const proxy = apps.filter((a) => a.serve === 'proxy');
  const up = proxy.filter((a) => a.live_pid && appHealth(a) !== 'failed').length;
  const recent = apps
    .filter((a) => a.lastDeploy)
    .sort((a, b) => new Date(b.lastDeploy.at) - new Date(a.lastDeploy.at))
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">Your fleet at a glance.</p>
        </div>
      </div>

      {/* stat row + recent deploys */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[1fr_1fr_1fr_1.4fr]">
        <Stat value={apps.length} label="Apps" />
        <Stat value={`${up}/${proxy.length || 0}`} label="Services up" tone={proxy.length && up === proxy.length ? 'text-success' : undefined} />
        <Stat value={state.resources.length} label="Databases" />
        <div className="surface col-span-2 p-4 lg:col-span-1">
          <span className="label-tiny">Recent deploys</span>
          <div className="mt-2 flex flex-col gap-1.5">
            {recent.length === 0 && <span className="text-sm text-muted">nothing yet</span>}
            {recent.map((a) => {
              const h = appHealth(a);
              return (
                <Link key={a.name} to={`/apps/${a.name}`} className="flex items-center gap-2 text-sm text-secondary transition hover:text-primary">
                  <span className="grid w-3 place-items-center"><DeployGlyph status={h} /></span>
                  <span className="truncate text-primary">{a.name}</span>
                  {a.lastDeploy.sha && <Mono className="text-muted">{shortSha(a.lastDeploy.sha)}</Mono>}
                  <span className="ml-auto shrink-0 text-xs text-muted">{timeAgo(a.lastDeploy.at)}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* apps */}
      <section>
        <h2 className="label-tiny mb-3">Apps</h2>
        {apps.length === 0 ? (
          <div className="surface flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-secondary">No projects yet.</p>
            <button onClick={openNew} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-[rgb(var(--accent-text))] transition hover:bg-accent-hover"><Icon.Plus className="h-4 w-4" /> New Project</button>
          </div>
        ) : (
          <div className="stagger surface-solid divide-y divide-border overflow-hidden">
            {apps.map((a, i) => {
              const h = appHealth(a);
              return (
                <Link key={a.name} to={`/apps/${a.name}`} style={{ '--i': i }} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-bg-secondary/60">
                  <StatusDot status={h} ring />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{a.name}</div>
                    <div className="truncate text-xs text-muted">{a.domain || a.serve}</div>
                  </div>
                  <div className="ml-auto flex items-center gap-3">
                    {a.serve === 'proxy' && <Mono className="hidden text-muted sm:inline">:{a.live_port ?? '—'}</Mono>}
                    <TypeBadge type={a.type} />
                    <Icon.ChevronRight className="h-4 w-4 text-muted" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* databases */}
      {state.resources.length > 0 && (
        <section>
          <h2 className="label-tiny mb-3">Databases</h2>
          <div className="surface-solid divide-y divide-border overflow-hidden">
            {state.resources.map((r) => <DbRow key={r.name} r={r} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function DbRow({ r }) {
  const copy = () => { navigator.clipboard?.writeText(r.conn || ''); toast('connection string copied', 'success'); };
  const del = async () => {
    if (!confirm(`Delete database ${r.name} and its data volume? This cannot be undone.`)) return;
    try { await api.removeResource(r.name); invalidate(); toast(`${r.name} removed`); }
    catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
      <Icon.Database className="h-5 w-5 shrink-0 text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{r.name}</div>
        <Mono className="block truncate text-muted">{(r.conn || '').replace(/:[^:@/]+@/, ':••••@')}</Mono>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={copy} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-secondary transition hover:border-accent hover:text-primary">
          <Icon.Copy className="h-3.5 w-3.5" /> Copy URL
        </button>
        <button onClick={del} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-danger transition hover:border-danger">
          <Icon.Trash className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
    </div>
  );
}
