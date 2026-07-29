import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { toast } from '../components/toast';
import { useVersion } from '../lib/store';
import { StatusDot, Spinner } from '../components/ui';
import { TypeIcon, Icon } from '../components/icons';
import { Onboarding } from '../components/Onboarding';
import { appHealth, cx } from '../lib/format';

// A service tile floating on the project's mini-canvas (app icon or database icon).
function ServiceTile({ s }) {
  const isApp = s.kind === 'app';
  return (
    <span
      className={cx('grid h-10 w-10 place-items-center rounded-xl border border-border bg-bg shadow-sm', isApp ? 'text-secondary' : 'text-accent')}
      title={s.name}
    >
      {isApp ? <TypeIcon type={s.type} className="h-[1.15rem] w-[1.15rem]" /> : <Icon.Database className="h-[1.15rem] w-[1.15rem]" />}
    </span>
  );
}

function ProjectCard({ p, showOwner, onDelete }) {
  const services = [...p.apps, ...p.resources];
  const n = services.length;
  const failed = p.apps.some((a) => appHealth(a) === 'failed');
  const online = p.apps.filter((a) => appHealth(a) === 'ok' || appHealth(a) === 'running').length + p.resources.length;
  return (
    <Link to={`/projects/${p.name}`} className="group surface flex flex-col overflow-hidden p-0 transition hover:border-accent/40 hover:shadow-xl hover:shadow-black/20">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="min-w-0 truncate font-semibold">{p.name}</span>
        {showOwner && p.owner && (
          <span className="shrink-0 rounded-full bg-bg-secondary px-1.5 py-0.5 font-mono text-[0.6rem] text-muted" title={`owned by ${p.owner}`}>@{p.owner}</span>
        )}
        {p.name !== 'default' && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(p); }}
            title="Delete project"
            className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted opacity-0 transition hover:bg-bg hover:text-danger group-hover:opacity-100"
          >
            <Icon.Trash className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {/* mini-canvas preview */}
      <div className="relative h-32 border-y border-border bg-bg-secondary/30">
        <div className="jd-grid absolute inset-0 opacity-70" />
        <div className="absolute inset-0 flex flex-wrap items-center justify-center gap-2.5 p-4">
          {services.slice(0, 6).map((s) => <ServiceTile key={s.kind + s.name} s={s} />)}
          {n === 0 && <span className="text-xs text-muted">No services yet</span>}
          {n > 6 && <span className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-bg text-xs font-medium text-muted">+{n - 6}</span>}
        </div>
      </div>
      {/* footer */}
      <div className="flex items-center gap-2 px-4 py-2.5 text-xs">
        <span className={cx('h-1.5 w-1.5 rounded-full', failed ? 'bg-danger' : online ? 'bg-success' : 'bg-muted')} />
        <span className="text-muted">{online}/{n} service{n === 1 ? '' : 's'} online</span>
      </div>
    </Link>
  );
}

export function Overview() {
  const { user, openNew, newProject } = useOutletContext();
  const isAdmin = user?.role === 'admin';
  const v = useVersion();
  const [state, setState] = useState(null);
  const [projects, setProjects] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => Promise.all([api.state(), api.projects()])
      .then(([s, p]) => { if (live) { setState(s); setProjects(p.projects); setErr(''); } })
      .catch((e) => { if (live) setErr(e.message); });
    load();
    const t = setInterval(load, 3500);
    return () => { live = false; clearInterval(t); };
  }, [v]);
  const reload = () => Promise.all([api.state(), api.projects()]).then(([s, p]) => { setState(s); setProjects(p.projects); }).catch(() => {});

  const delProject = async (p) => {
    const n = p.apps.length + p.resources.length;
    const msg = n
      ? `Delete project “${p.name}”? Its ${n} service${n === 1 ? '' : 's'} move to your default project — nothing is deleted.`
      : `Delete project “${p.name}”?`;
    if (!window.confirm(msg)) return;
    try { await api.removeProject(p.name); toast(`deleted ${p.name}`, 'success'); reload(); }
    catch (e) { toast(e.message, 'error'); }
  };

  if (!state || !projects) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-center">
        <Spinner className="h-6 w-6" />
        {err && <span className="text-xs text-muted">can’t reach the server — retrying…</span>}
      </div>
    );
  }

  // Show every project you made; only hide the implicit 'default' bucket while it's empty.
  const all = projects.filter((p) => p.apps.length + p.resources.length > 0 || p.name !== 'default');
  const shown = q.trim() ? all.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())) : all;
  const apps = state.apps.filter((a) => a.serve !== 'resource');
  const anyFailed = apps.some((a) => appHealth(a) === 'failed');

  return (
    <div className="animate-rise flex flex-col gap-6">
      {/* top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Icon.Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search projects…"
              className="field w-48 py-1.5 pl-8 text-sm sm:w-60"
            />
          </div>
          <button onClick={newProject} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]">
            <Icon.Plus className="h-4 w-4" /> New
          </button>
        </div>
      </div>

      {isAdmin && !state.onboardingDismissed && !(state.baseDomainSet && state.github && apps.length > 0) && (
        <Onboarding state={state} onChange={reload} onDeploy={openNew} />
      )}

      {/* sub-header */}
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="font-medium text-secondary">{all.length} Project{all.length === 1 ? '' : 's'}</span>
        <span className={cx('inline-flex items-center gap-1.5', anyFailed ? 'text-warning' : 'text-muted')}>
          <span className={cx('h-1.5 w-1.5 rounded-full pulse-dot', anyFailed ? 'bg-warning' : 'bg-success')} />
          {anyFailed ? 'Attention needed' : 'All systems operational'}
        </span>
      </div>

      {all.length === 0 ? (
        <div className="surface flex flex-col items-center gap-3 py-16 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/[0.12] text-accent"><Icon.Rocket className="h-5 w-5" /></span>
          <p className="text-secondary">No projects yet.</p>
          <button onClick={newProject} className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]"><Icon.Plus className="h-4 w-4" /> New Project</button>
        </div>
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p, i) => <div key={p.name} style={{ '--i': i }}><ProjectCard p={p} showOwner={isAdmin} onDelete={delProject} /></div>)}
          {shown.length === 0 && <p className="col-span-full py-8 text-center text-sm text-muted">No projects match “{q}”.</p>}
        </div>
      )}
    </div>
  );
}
