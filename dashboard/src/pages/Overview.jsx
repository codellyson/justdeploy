import { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useVersion } from '../lib/store';
import { toast } from '../components/toast';
import { StatusDot, StatusPill, SoftIcon, Avatar, Mono, Spinner } from '../components/ui';
import { Icon } from '../components/icons';
import { Onboarding } from '../components/Onboarding';
import { appHealth, shortSha, timeAgo, typeLabel, cx } from '../lib/format';

function Stat({ icon, label, value, tone: t, sub }) {
  return (
    <div className="surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-secondary">{label}</span>
        <SoftIcon icon={icon} tone={t} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[1.7rem] font-semibold leading-none tracking-tight">{value}</span>
        {sub && <span className="text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

function ProjectCard({ a }) {
  const h = appHealth(a);
  const d = a.lastDeploy;
  const failed = d?.status === 'failed';
  const visit = (e) => { e.preventDefault(); e.stopPropagation(); window.open(`https://${a.domain}`, '_blank', 'noopener'); };
  return (
    <Link to={`/apps/${a.name}`} className="group surface flex flex-col gap-3.5 p-4 transition hover:border-accent/40 hover:shadow-xl hover:shadow-black/20">
      <div className="flex items-start gap-3">
        <Avatar type={a.type} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{a.name}</span>
            <span className="shrink-0 rounded bg-[rgb(var(--text-primary)/0.06)] px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-muted">{typeLabel(a.type)}</span>
          </div>
          {a.domain
            ? <button onClick={visit} className="mt-0.5 flex max-w-full items-center gap-1 font-mono text-xs text-muted transition hover:text-accent">
                <span className="truncate">{a.domain}</span>
                <Icon.ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition group-hover:opacity-70" />
              </button>
            : <div className="mt-0.5 font-mono text-xs text-muted">{a.serve}</div>}
        </div>
        <StatusDot status={h} ring size="h-2.5 w-2.5" />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <StatusPill status={h} />
        <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs text-muted">
          {a.deploying ? <span className="text-accent">deploying…</span>
            : failed ? <span className="truncate text-danger">{d.reason || 'failed'}</span>
              : d?.sha ? <><Icon.GitCommit className="h-3 w-3 shrink-0" />{shortSha(d.sha)}</>
                : 'never deployed'}
          {d?.at && !a.deploying && <><span className="text-muted/50">·</span>{timeAgo(d.at)}</>}
        </span>
      </div>
    </Link>
  );
}

function ActivityRow({ a }) {
  const h = appHealth(a);
  const meta = h === 'failed'
    ? { icon: Icon.Alert, tone: 'danger', text: 'Deploy failed —' }
    : h === 'running'
      ? { icon: Icon.Rocket, tone: 'accent', text: 'Deploying' }
      : { icon: Icon.Check, tone: 'success', text: 'Deployed' };
  return (
    <Link to={`/apps/${a.name}`} className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition hover:surface-2">
      <SoftIcon icon={meta.icon} tone={meta.tone} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {meta.text} <span className="font-mono text-primary">{a.name}</span>
          {a.lastDeploy?.sha && <span className="ml-1.5 font-mono text-xs text-muted">{shortSha(a.lastDeploy.sha)}</span>}
        </div>
        <div className="text-xs text-muted">{timeAgo(a.lastDeploy?.at)}</div>
      </div>
    </Link>
  );
}

export function Overview() {
  const { openNew } = useOutletContext();
  const v = useVersion();
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => api.state()
      .then((s) => { if (live) { setState(s); setErr(''); } })
      .catch((e) => { if (live) setErr(e.message); });
    load();
    const t = setInterval(load, 3500);
    return () => { live = false; clearInterval(t); };
  }, [v]);

  const reload = () => api.state().then(setState).catch(() => {});

  const derived = useMemo(() => {
    if (!state) return null;
    const apps = state.apps.filter((a) => a.serve !== 'resource');
    const proxy = apps.filter((a) => a.serve === 'proxy');
    const up = proxy.filter((a) => a.live_pid && appHealth(a) !== 'failed').length;
    const anyFailed = apps.some((a) => appHealth(a) === 'failed');
    const recent = apps.filter((a) => a.lastDeploy).sort((a, b) => new Date(b.lastDeploy.at) - new Date(a.lastDeploy.at)).slice(0, 5);
    const filtered = apps.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || (a.domain || '').toLowerCase().includes(q.toLowerCase()));
    return { apps, proxy, up, anyFailed, recent, filtered };
  }, [state, q]);

  if (!state) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-center">
        <Spinner className="h-6 w-6" />
        {err && <span className="text-xs text-muted">can’t reach the server — retrying…</span>}
      </div>
    );
  }

  const { apps, proxy, up, anyFailed, recent, filtered } = derived;

  return (
    <div className="animate-rise flex flex-col gap-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-0.5 text-sm text-muted">Your fleet at a glance.</p>
        </div>
        <span className={cx('inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs', anyFailed ? 'text-warning' : 'text-secondary')}>
          <span className={cx('h-1.5 w-1.5 rounded-full pulse-dot', anyFailed ? 'bg-warning' : 'bg-success')} />
          {anyFailed ? 'Attention needed' : 'All systems operational'}
        </span>
      </div>

      {/* first-run setup wizard — until dismissed or fully set up */}
      {!state.onboardingDismissed && !(state.baseDomainSet && state.github && apps.length > 0) && (
        <Onboarding state={state} onChange={reload} onDeploy={openNew} />
      )}

      {/* stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat icon={Icon.Layers} tone="accent" label="Apps" value={apps.length} />
        <Stat icon={Icon.Server} tone={proxy.length && up === proxy.length ? 'success' : 'warning'} label="Services up" value={`${up}/${proxy.length || 0}`} />
        <Stat icon={Icon.Database} tone="accent" label="Databases" value={state.resources.length} />
      </div>

      {/* projects */}
      <section>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold">Projects</h2>
          <span className="rounded-md bg-[rgb(var(--text-primary)/0.05)] px-1.5 py-0.5 font-mono text-xs text-muted">{apps.length}</span>
          <div className="flex-1" />
          {apps.length > 0 && (
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><Icon.Search className="h-3.5 w-3.5" /></span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" className="field w-56 max-w-[48vw] py-2 pl-9 text-sm" />
            </div>
          )}
        </div>

        {apps.length === 0 ? (
          <div className="surface flex flex-col items-center gap-3 py-16 text-center">
            <SoftIcon icon={Icon.Rocket} tone="accent" size="h-11 w-11" />
            <p className="text-secondary">No projects yet.</p>
            <button onClick={openNew} className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]"><Icon.Plus className="h-4 w-4" /> New Project</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-14 text-center text-sm text-muted">
            No projects match “<span className="text-primary">{q}</span>”.
          </div>
        ) : (
          <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((a, i) => <div key={a.name} style={{ '--i': i }}><ProjectCard a={a} /></div>)}
          </div>
        )}
      </section>

      {/* activity */}
      {recent.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold">Recent activity</h2>
          <div className="surface grid grid-cols-1 gap-0.5 p-1.5 sm:grid-cols-2">
            {recent.map((a) => <ActivityRow key={a.name} a={a} />)}
          </div>
        </section>
      )}

      {/* databases */}
      {state.resources.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold">Databases</h2>
          <div className="surface divide-y divide-border overflow-hidden p-0">
            {state.resources.map((r) => <DbRow key={r.name} r={r} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function DbRow({ r }) {
  const copy = (e) => { e.preventDefault(); navigator.clipboard?.writeText(r.conn || ''); toast('connection string copied', 'success'); };
  return (
    <Link to={`/db/${r.name}`} className="flex flex-wrap items-center gap-3 px-4 py-3.5 transition hover:surface-2">
      <SoftIcon icon={Icon.Database} tone="accent" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{r.name}</div>
        <Mono className="block truncate text-muted">{(r.conn || '').replace(/:[^:@/]+@/, ':••••@')}</Mono>
      </div>
      <button onClick={copy} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-secondary transition hover:border-accent hover:text-primary"><Icon.Copy className="h-3.5 w-3.5" /> Copy URL</button>
      <Icon.ChevronRight className="h-4 w-4 text-muted" />
    </Link>
  );
}
