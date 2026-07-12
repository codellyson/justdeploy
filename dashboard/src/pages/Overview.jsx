import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useVersion } from '../lib/store';
import { StatusDot, Spinner } from '../components/ui';
import { TypeIcon, Icon } from '../components/icons';
import { Onboarding } from '../components/Onboarding';
import { appHealth, cx } from '../lib/format';

// A compact service row inside a project card (an app or a database).
function ServiceRow({ s }) {
  const isApp = s.kind === 'app';
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
      <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-md', isApp ? 'bg-bg' : 'bg-accent/[0.12] text-accent')}>
        {isApp ? <TypeIcon type={s.type} className="h-3.5 w-3.5" /> : <Icon.Database className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
      {isApp ? <StatusDot status={appHealth(s)} ring size="h-1.5 w-1.5" />
        : <span className="font-mono text-[0.65rem] text-muted">db</span>}
    </div>
  );
}

function ProjectCard({ p }) {
  const services = [...p.apps, ...p.resources];
  const n = services.length;
  const failed = p.apps.some((a) => appHealth(a) === 'failed');
  return (
    <Link to={`/projects/${p.name}`} className="group surface flex flex-col p-4 transition hover:border-accent/40 hover:shadow-xl hover:shadow-black/20">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent/[0.12] text-accent"><Icon.Canvas className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{p.name}</div>
          <div className="font-mono text-[0.68rem] text-muted">{n} service{n === 1 ? '' : 's'}</div>
        </div>
        <span className={cx('h-2 w-2 rounded-full', failed ? 'bg-danger' : n ? 'bg-success' : 'bg-muted')} />
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border pt-2">
        {services.slice(0, 5).map((s) => <ServiceRow key={s.kind + s.name} s={s} />)}
        {n === 0 && <div className="px-2 py-3 text-sm text-muted">No services yet.</div>}
        {n > 5 && <div className="px-2 py-1 text-xs text-muted">+{n - 5} more</div>}
      </div>
    </Link>
  );
}

export function Overview() {
  const { openNew, newProject } = useOutletContext();
  const v = useVersion();
  const [state, setState] = useState(null);
  const [projects, setProjects] = useState(null);
  const [err, setErr] = useState('');

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

  if (!state || !projects) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-center">
        <Spinner className="h-6 w-6" />
        {err && <span className="text-xs text-muted">can’t reach the server — retrying…</span>}
      </div>
    );
  }

  // Show every project you made; only hide the implicit 'default' bucket while it's empty.
  const shown = projects.filter((p) => p.apps.length + p.resources.length > 0 || p.name !== 'default');
  const apps = state.apps.filter((a) => a.serve !== 'resource');
  const anyFailed = apps.some((a) => appHealth(a) === 'failed');

  return (
    <div className="animate-rise flex flex-col gap-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-0.5 text-sm text-muted">Each project is a canvas of its services. Open one to see how they wire together.</p>
        </div>
        <span className={cx('inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs', anyFailed ? 'text-warning' : 'text-secondary')}>
          <span className={cx('h-1.5 w-1.5 rounded-full pulse-dot', anyFailed ? 'bg-warning' : 'bg-success')} />
          {anyFailed ? 'Attention needed' : 'All systems operational'}
        </span>
      </div>

      {!state.onboardingDismissed && !(state.baseDomainSet && state.github && apps.length > 0) && (
        <Onboarding state={state} onChange={reload} onDeploy={openNew} />
      )}

      {shown.length === 0 ? (
        <div className="surface flex flex-col items-center gap-3 py-16 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/[0.12] text-accent"><Icon.Rocket className="h-5 w-5" /></span>
          <p className="text-secondary">No projects yet.</p>
          <button onClick={newProject} className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]"><Icon.Plus className="h-4 w-4" /> New Project</button>
        </div>
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p, i) => <div key={p.name} style={{ '--i': i }}><ProjectCard p={p} /></div>)}
        </div>
      )}
    </div>
  );
}
