import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useVersion, invalidate } from '../lib/store';
import { toast } from '../components/toast';
import { StatusPill, StatusDot, Avatar, Mono, Spinner, tone, STATUS_META } from '../components/ui';
import { TypeIcon, Icon } from '../components/icons';
import { appHealth, shortSha, timeAgo, cx } from '../lib/format';

const TABS = [
  { id: 'Overview', icon: Icon.Layers },
  { id: 'Logs', icon: Icon.Terminal },
  { id: 'Environment', icon: Icon.Settings },
  { id: 'Deploys', icon: Icon.Rocket },
  { id: 'Config', icon: Icon.Settings },
];

function duration(d) {
  if (!d?.started_at || !d?.finished_at) return null;
  const s = Math.max(0, (new Date(d.finished_at) - new Date(d.started_at)) / 1000);
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function AppDetail() {
  const { name } = useParams();
  const navigate = useNavigate();
  const v = useVersion();
  const [app, setApp] = useState(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState('Overview');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => api.state()
      .then((s) => { if (!live) return; const a = s.apps.find((x) => x.name === name); a ? setApp(a) : setMissing(true); })
      .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, [name, v]);

  if (missing) return <div className="py-20 text-center text-muted">App <span className="font-mono text-primary">{name}</span> not found. <Link to="/" className="inline-flex items-center gap-1 text-accent"><Icon.ArrowLeft className="h-3.5 w-3.5" /> back</Link></div>;
  if (!app) return <div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>;

  const h = appHealth(app);
  const act = async (label, fn, go) => {
    setBusy(label);
    try { await fn(); invalidate(); if (go) setTab(go); }
    catch (e) { toast(e.message, 'error'); }
    finally { setBusy(''); }
  };
  const deploy = () => act('deploy', () => api.deploy(name), 'Logs').then(() => toast(`deploying ${name}`));
  const rollback = () => { if (confirm(`Roll back to ${shortSha(app.rollbackTo)}?`)) act('rollback', () => api.rollback(name), 'Logs'); };
  const rollbackSha = (sha) => { if (confirm(`Roll back to ${shortSha(sha)}?`)) act('rollback', () => api.rollback(name, sha), 'Logs'); };
  const remove = () => { if (confirm(`Delete ${name}? Removes files and stops it.`)) act('delete', async () => { await api.remove(name); navigate('/'); toast(`${name} removed`); }); };

  return (
    <div className="animate-rise flex flex-col gap-5">
      <Link to="/" className="flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-primary"><Icon.ArrowLeft className="h-4 w-4" /> Overview</Link>

      {/* header */}
      <div className="flex flex-wrap items-start gap-4">
        <Avatar type={app.type} size="h-12 w-12" icon="h-5 w-5" />
        <div className="min-w-[180px] flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            <StatusPill status={h} />
          </div>
          {app.domain && (
            <a href={`https://${app.domain}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 font-mono text-[0.8rem] text-secondary transition hover:text-accent">
              <Icon.Globe className="h-3.5 w-3.5" />{app.domain}<Icon.ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {app.rollbackTo && <button disabled={!!busy} onClick={rollback} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium transition hover:border-muted/50 disabled:opacity-60"><Icon.Rollback className="h-4 w-4" /> Rollback</button>}
          {app.serve !== 'file' && <button disabled={!!busy} onClick={deploy} className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-60"><Icon.Zap className="h-4 w-4" /> {busy === 'deploy' ? 'Deploying…' : 'Deploy'}</button>}
        </div>
      </div>

      {/* banners */}
      {app.deploying && (
        <div className="flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/[0.1] px-4 py-3">
          <span className="spin h-4 w-4 shrink-0 rounded-full border-2 border-accent border-r-transparent" />
          <span className="text-sm font-medium text-accent">Deploying {name}… <span className="font-normal text-secondary">watch it stream in the Logs tab.</span></span>
        </div>
      )}
      {h === 'failed' && app.lastDeploy?.reason && !app.deploying && (
        <div className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/[0.1] px-4 py-3">
          <Icon.Alert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-danger">{app.lastDeploy.reason}</div>
            {app.lastDeploy.hint && <div className="mt-0.5 text-sm text-secondary">{app.lastDeploy.hint.replace(/<app>/g, name)}</div>}
          </div>
          <button onClick={deploy} className="shrink-0 rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-110">Redeploy</button>
        </div>
      )}

      {/* tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx('relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm transition', tab === t.id ? 'text-primary' : 'text-muted hover:text-secondary')}>
            <t.icon className="h-4 w-4" />{t.id}
            {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      <div>
        {tab === 'Overview' && <OverviewTab app={app} onLogs={() => setTab('Logs')} onDeploys={() => setTab('Deploys')} />}
        {tab === 'Logs' && <LogsTab name={name} />}
        {tab === 'Environment' && <EnvTab name={name} />}
        {tab === 'Deploys' && <DeploysTab name={name} app={app} onRollback={rollbackSha} />}
        {tab === 'Config' && <ConfigTab app={app} onDelete={remove} />}
      </div>
    </div>
  );
}

// Live preview of the deployed site, inside a browser frame. Screenshot is fetched from a
// free, keyless service (WordPress mShots) using the public domain; falls back to the app's
// framework icon if there's no domain or the shot can't load.
function SitePreview({ domain, type }) {
  const [err, setErr] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = domain ? `https://s.wordpress.com/mshots/v1/${encodeURIComponent(`https://${domain}`)}?w=1400&h=900` : null;
  const showShot = src && !err;
  return (
    <div className="flex min-h-[240px] flex-col border-b border-border bg-bg md:border-b-0 md:border-r">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden" style={{ background: 'radial-gradient(120% 120% at 50% 0%, rgb(var(--accent) / 0.08), transparent 60%)' }}>
        {showShot ? (
          <>
            <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="group absolute inset-0 block">
              <img
                src={src}
                alt={`Live preview of ${domain}`}
                onLoad={() => setLoaded(true)}
                onError={() => setErr(true)}
                className={cx('h-full w-full object-cover object-top transition-opacity duration-500', loaded ? 'opacity-100' : 'opacity-0')}
              />
              <span className="pointer-events-none absolute inset-0 bg-bg/0 transition group-hover:bg-bg/10" />
            </a>
            {!loaded && <Spinner className="h-5 w-5" />}
          </>
        ) : (
          <>
            <div className="jd-grid pointer-events-none absolute inset-0 opacity-40" />
            <span className="relative text-accent opacity-90"><TypeIcon type={type} className="h-16 w-16" /></span>
          </>
        )}
      </div>
    </div>
  );
}

function OverviewTab({ app, onLogs, onDeploys }) {
  const h = appHealth(app);
  const d = app.lastDeploy;
  return (
    <div className="flex flex-col gap-5">
      <div className="surface grid grid-cols-1 overflow-hidden p-0 md:grid-cols-2">
        {/* live preview of the deployed site */}
        <SitePreview domain={app.domain} type={app.type} />
        {/* details */}
        <div className="flex min-w-0 flex-col gap-4 p-5">
          <div className="label-tiny">Production Deployment</div>
          {app.domain && (
            <div className="flex flex-col gap-1.5">
              <span className="label-tiny">Domain</span>
              <a href={`https://${app.domain}`} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 font-mono text-sm font-medium transition hover:text-accent"><span className="truncate">{app.domain}</span><Icon.ExternalLink className="h-3.5 w-3.5 shrink-0" /></a>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5"><span className="label-tiny">Status</span><span className={cx('flex items-center gap-2 text-sm font-medium', tone(STATUS_META[h].tone).text)}><StatusDot status={h} />{STATUS_META[h].label}</span></div>
            {d?.at && <div className="flex flex-col gap-1.5"><span className="label-tiny">Last deploy</span><span className="text-sm">{timeAgo(d.at)}</span></div>}
            {app.serve === 'proxy' && <div className="flex flex-col gap-1.5"><span className="label-tiny">Port</span><Mono className="text-sm">:{app.live_port ?? '—'}</Mono></div>}
            {app.serve === 'proxy' && <div className="flex flex-col gap-1.5"><span className="label-tiny">PID</span><Mono className="text-sm">{app.live_pid ?? '—'}</Mono></div>}
          </div>
          {(d?.sha || app.repo) && (
            <div className="flex flex-col gap-1.5">
              <span className="label-tiny">Source</span>
              {d?.sha && <div className="flex items-center gap-1.5 font-mono text-sm text-secondary"><Icon.GitCommit className="h-3.5 w-3.5 text-muted" />{shortSha(d.sha)}</div>}
              {app.repo && <a href={app.repo.replace(/\.git$/, '')} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm text-secondary transition hover:text-accent"><Icon.GitBranch className="h-3.5 w-3.5 text-muted" /><span className="truncate">{app.repo.replace(/^https?:\/\//, '')}</span></a>}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-2">
            {app.domain && <a href={`https://${app.domain}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]">Visit <Icon.ExternalLink className="h-3.5 w-3.5" /></a>}
            <button onClick={onLogs} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-medium transition hover:border-muted/50"><Icon.Terminal className="h-4 w-4" /> Logs</button>
            <button onClick={onDeploys} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-medium transition hover:border-muted/50">Deploys</button>
          </div>
        </div>
      </div>

      {(app.release_cmd || app.persist) && (
        <div className="surface flex flex-col gap-4 p-5">
          {app.release_cmd && <div className="flex flex-col gap-1.5"><span className="label-tiny">Release command</span><Mono className="break-all text-sm text-secondary">{app.release_cmd}</Mono></div>}
          {app.persist && <div className="flex flex-col gap-1.5"><span className="label-tiny">Persisted dirs</span><Mono className="text-sm text-secondary">{app.persist}</Mono></div>}
        </div>
      )}
    </div>
  );
}

function LogsTab({ name }) {
  const boxRef = useRef(null);
  const [live, setLive] = useState(true);
  const [lines, setLines] = useState(0);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.textContent = '';
    let count = 0;
    const es = api.stream(name);
    es.onmessage = (e) => {
      if (!box) return;
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.textContent += e.data;
      count += (e.data.match(/\n/g) || []).length;
      setLines(count);
      if (stick) box.scrollTop = box.scrollHeight;
    };
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [name]);
  return (
    <div className="surface overflow-hidden p-0">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-secondary"><Icon.Terminal className="h-4 w-4" /> Live logs</span>
        <span className={cx('flex items-center gap-1.5 font-mono text-[0.7rem]', live ? 'text-success' : 'text-warning')}>
          <span className={cx('h-1.5 w-1.5 rounded-full pulse-dot', live ? 'bg-success' : 'bg-warning')} />{live ? 'streaming' : 'reconnecting'}
        </span>
        <div className="flex-1" />
        <span className="font-mono text-[0.7rem] text-muted">{lines} lines</span>
      </div>
      <pre ref={boxRef} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words bg-bg p-4 font-mono text-xs leading-relaxed text-secondary" />
    </div>
  );
}

function EnvRow({ k, val, onKey, onVal, onDel }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 transition hover:surface-2">
      <input value={k} onChange={onKey} placeholder="KEY" className="field w-2/5 py-1.5 font-mono text-sm" />
      <input value={val} onChange={onVal} type={show ? 'text' : 'password'} placeholder="value" className="field flex-1 py-1.5 font-mono text-sm" />
      <button onClick={() => setShow((s) => !s)} title="Reveal" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:text-primary">{show ? <Icon.EyeOff className="h-4 w-4" /> : <Icon.Eye className="h-4 w-4" />}</button>
      <button onClick={() => { navigator.clipboard?.writeText(val); toast('copied', 'success'); }} title="Copy" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:text-primary"><Icon.Copy className="h-4 w-4" /></button>
      <button onClick={onDel} title="Remove" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:text-danger"><Icon.X className="h-4 w-4" /></button>
    </div>
  );
}

function EnvTab({ name }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getEnv(name).then(({ env }) => setRows(Object.entries(env).map(([k, v]) => ({ k, v })))); }, [name]);
  if (!rows) return <Spinner className="mx-auto my-10 h-5 w-5" />;
  const upd = (i, key) => (e) => setRows((r) => r.map((row, j) => (j === i ? { ...row, [key]: e.target.value } : row)));
  const save = async () => {
    setBusy(true);
    const env = {}; rows.forEach(({ k, v }) => { if (k.trim()) env[k.trim()] = v; });
    try { await api.setEnv(name, env); toast('env saved — redeploy to apply', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="max-w-3xl">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Environment variables</h3>
          <p className="mt-0.5 text-sm text-muted">Injected at deploy time. Redeploy to apply changes.</p>
        </div>
        <button onClick={() => setRows((r) => [...r, { k: '', v: '' }])} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium transition hover:border-muted/50"><Icon.Plus className="h-4 w-4" /> Add variable</button>
      </div>
      <div className="surface divide-y divide-border overflow-hidden p-0">
        {rows.length === 0 && <p className="px-4 py-6 text-sm text-muted">No variables yet.</p>}
        {rows.map((row, i) => <EnvRow key={i} k={row.k} val={row.v} onKey={upd(i, 'k')} onVal={upd(i, 'v')} onDel={() => setRows((r) => r.filter((_, j) => j !== i))} />)}
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-mono text-xs text-muted">{rows.filter((r) => r.k.trim()).length} variables</span>
          <button onClick={save} disabled={busy} className="rounded-xl bg-accent px-3.5 py-1.5 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function DeploysTab({ name, app, onRollback }) {
  const v = useVersion();
  const [items, setItems] = useState(null);
  useEffect(() => { fetch(`/api/apps/${name}/deploys`).then((r) => r.json()).then((d) => setItems(d.deploys || [])).catch(() => setItems([])); }, [name, v]);
  if (!items) return <Spinner className="mx-auto my-10 h-5 w-5" />;
  if (items.length === 0) return <p className="py-10 text-center text-sm text-muted">No deploys yet.</p>;

  const kept = new Set(app.releases || []);
  const currentId = (app.currentSha
    ? items.find((d) => d.status === 'success' && d.sha === app.currentSha)
    : items.find((d) => d.status === 'success'))?.id;

  return (
    <div className="max-w-4xl">
      <h3 className="mb-1 text-base font-semibold">Deployments</h3>
      <p className="mb-3.5 text-sm text-muted">Roll back to any kept build instantly — no rebuild.</p>
      <div className="surface divide-y divide-border overflow-hidden p-0">
        {items.map((d) => {
          const st = d.status === 'success' ? 'success' : d.status === 'failed' ? 'danger' : 'accent';
          const dur = duration(d);
          const isCurrent = d.id === currentId;
          const canRollback = d.status === 'success' && d.sha && !isCurrent;
          const instant = d.sha && kept.has(d.sha);
          return (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 transition hover:surface-2">
              <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', tone(st).dot)} />
              <div className="min-w-0 flex-1 basis-52">
                <div className="truncate text-sm font-medium">{d.reason || d.message || (d.status === 'success' ? 'Deployment' : d.status)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted"><Icon.GitCommit className="h-3 w-3" />{shortSha(d.sha) || '—'}</div>
              </div>
              {dur && <span className="hidden shrink-0 items-center gap-1 font-mono text-xs text-muted sm:flex"><Icon.Clock className="h-3 w-3" />{dur}</span>}
              <span className="shrink-0 text-xs text-muted">{timeAgo(d.finished_at || d.started_at)}</span>
              {isCurrent
                ? <span className="shrink-0 rounded-md bg-success/[0.14] px-2 py-0.5 text-[0.7rem] font-semibold text-success">Current</span>
                : canRollback && (
                  <button onClick={() => onRollback(d.sha)} title={instant ? 'Instant — this build is kept on disk' : 'The build was pruned; this will rebuild the commit'} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-bg-secondary px-2.5 py-1 text-xs font-medium transition hover:border-accent hover:text-accent">
                    <Icon.Rollback className="h-3.5 w-3.5" /> Rollback
                    <span className={cx('rounded px-1 py-0.5 text-[0.6rem] font-semibold', instant ? 'bg-accent/[0.14] text-accent' : 'surface-2 text-muted')}>{instant ? 'instant' : 'rebuild'}</span>
                  </button>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfigTab({ app, onDelete }) {
  const [release, setRelease] = useState(app.release_cmd || '');
  const [persist, setPersist] = useState(app.persist || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.setConfig(app.name, { release: release.trim(), persist: persist.trim() }); invalidate(); toast('config saved — redeploy to apply', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="surface flex flex-col gap-4 p-5">
        <div>
          <h3 className="text-base font-semibold">Build & release</h3>
          <p className="mt-0.5 text-sm text-muted">Detected from your app type — override only if you need to.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="label-tiny">Release command</label>
          <input value={release} onChange={(e) => setRelease(e.target.value)} placeholder="node ace migration:run --force" className="field font-mono" />
          <span className="text-xs text-muted">Runs after build, before the server starts.</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="label-tiny">Persisted dirs</label>
          <input value={persist} onChange={(e) => setPersist(e.target.value)} placeholder="tmp" className="field font-mono" />
          <span className="text-xs text-muted">Comma-separated; symlinked to data/ so they survive deploys.</span>
        </div>
        <div className="flex justify-end"><button onClick={save} disabled={busy} className="rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button></div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/[0.08] p-5">
        <div>
          <div className="text-base font-semibold text-danger">Delete application</div>
          <div className="mt-0.5 text-sm text-secondary">Permanently remove this app, its files, and its domain. This cannot be undone.</div>
        </div>
        <button onClick={onDelete} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-danger px-3.5 py-2 text-sm font-semibold text-white transition hover:brightness-110"><Icon.Trash className="h-4 w-4" /> Delete</button>
      </div>
    </div>
  );
}
