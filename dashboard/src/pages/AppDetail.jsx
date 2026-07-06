import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Field } from '@codellyson/justui/react';
import { api } from '../api';
import { useVersion, invalidate } from '../lib/store';
import { toast } from '../components/toast';
import { StatusDot, TypeBadge, Mono, Meta, Spinner } from '../components/ui';
import { Icon } from '../components/icons';
import { appHealth, shortSha, timeAgo, cx } from '../lib/format';

const TABS = ['Overview', 'Logs', 'Environment', 'Deploys', 'Config'];

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
  const action = async (label, fn, go) => {
    setBusy(label);
    try { await fn(); invalidate(); if (go) setTab(go); }
    catch (e) { toast(e.message, 'error'); }
    finally { setBusy(''); }
  };
  const deploy = () => action('deploy', () => api.deploy(name), 'Logs').then(() => toast(`deploying ${name}`));
  const rollback = () => { if (confirm(`Roll back to ${shortSha(app.rollbackTo)}?`)) action('rollback', () => api.rollback(name), 'Logs'); };
  const remove = () => { if (confirm(`Delete ${name}? Removes files and stops it.`)) action('delete', async () => { await api.remove(name); navigate('/'); toast(`${name} removed`); }); };

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="flex flex-col gap-4">
        <Link to="/" className="flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-primary"><Icon.ArrowLeft className="h-4 w-4" /> Overview</Link>
        <div className="flex flex-wrap items-center gap-3">
          <StatusDot status={h} ring size="h-2.5 w-2.5" />
          <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
          <TypeBadge type={app.type} />
          {app.domain && (
            <a href={`https://${app.domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              {app.domain} <Icon.ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <div className="ml-auto flex items-center gap-2">
            {app.serve !== 'file' && <Button size="sm" variant="secondary" disabled={!!busy} onClick={deploy}>{busy === 'deploy' ? 'Deploying…' : 'Deploy'}</Button>}
            {app.rollbackTo && <Button size="sm" variant="ghost" disabled={!!busy} onClick={rollback} title={`redeploy ${shortSha(app.rollbackTo)}`}>Rollback</Button>}
            <Button size="sm" variant="danger" disabled={!!busy} onClick={remove}>Delete</Button>
          </div>
        </div>
        {h === 'failed' && app.lastDeploy?.reason && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            <div className="font-medium">{app.lastDeploy.reason}</div>
            {app.lastDeploy.hint && <div className="mt-1 text-secondary">{app.lastDeploy.hint.replace(/<app>/g, name)}</div>}
          </div>
        )}
      </div>

      {/* tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              'relative shrink-0 px-3 py-2.5 text-sm transition',
              tab === t ? 'text-primary' : 'text-muted hover:text-secondary',
            )}
          >
            {t}
            {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      <div>
        {tab === 'Overview' && <OverviewTab app={app} />}
        {tab === 'Logs' && <LogsTab name={name} />}
        {tab === 'Environment' && <EnvTab name={name} />}
        {tab === 'Deploys' && <DeploysTab name={name} rollbackTo={app.rollbackTo} onRollback={rollback} />}
        {tab === 'Config' && <ConfigTab app={app} />}
      </div>
    </div>
  );
}

function OverviewTab({ app }) {
  const d = app.lastDeploy;
  return (
    <div className="surface grid grid-cols-2 gap-6 p-5 sm:grid-cols-3">
      <Meta label="Status">{app.deploying ? 'deploying…' : appHealth(app)}</Meta>
      {app.serve === 'proxy' && <Meta label="Port"><Mono>:{app.live_port ?? '—'}</Mono></Meta>}
      {app.serve === 'proxy' && <Meta label="PID"><Mono>{app.live_pid ?? '—'}</Mono></Meta>}
      <Meta label="Last deploy">{d ? <span className={d.status === 'failed' ? 'text-danger' : ''}>{d.status}{d.sha ? ` · ${shortSha(d.sha)}` : ''}</span> : '—'}</Meta>
      {d?.at && <Meta label="When">{timeAgo(d.at)}</Meta>}
      {app.repo && <Meta label="Repo"><a href={app.repo.replace(/\.git$/, '')} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">{app.repo.replace(/^https?:\/\//, '')}</a></Meta>}
      {app.release_cmd && <Meta label="Release"><Mono className="break-all">{app.release_cmd}</Mono></Meta>}
      {app.persist && <Meta label="Persist"><Mono>{app.persist}</Mono></Meta>}
    </div>
  );
}

function LogsTab({ name }) {
  const boxRef = useRef(null);
  const [live, setLive] = useState(true);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.textContent = '';
    const es = api.stream(name);
    es.onmessage = (e) => {
      if (!box) return;
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.textContent += e.data;
      if (stick) box.scrollTop = box.scrollHeight;
    };
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [name]);
  return (
    <div className="surface-solid overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <StatusDot status={live ? 'running' : 'failed'} size="h-1.5 w-1.5" />
        <span className="text-xs text-muted">{live ? 'live' : 'reconnecting…'}</span>
      </div>
      <pre ref={boxRef} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-secondary" />
    </div>
  );
}

function EnvTab({ name }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getEnv(name).then(({ env }) => setRows(Object.entries(env).map(([k, v]) => ({ k, v })))); }, [name]);
  if (!rows) return <Spinner className="mx-auto my-10 h-5 w-5" />;
  const upd = (i, key) => (e) => setRows((r) => r.map((row, j) => (j === i ? { ...row, [key]: e.target.value } : row)));
  const add = () => setRows((r) => [...r, { k: '', v: '' }]);
  const del = (i) => setRows((r) => r.filter((_, j) => j !== i));
  const save = async () => {
    setBusy(true);
    const env = {};
    rows.forEach(({ k, v }) => { if (k.trim()) env[k.trim()] = v; });
    try { await api.setEnv(name, env); toast('env saved — redeploy to apply', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="surface flex flex-col gap-3 p-5">
      {rows.length === 0 && <p className="text-sm text-muted">No variables.</p>}
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <input value={row.k} onChange={upd(i, 'k')} placeholder="KEY" className="w-2/5 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-sm outline-none focus:border-accent" />
          <input value={row.v} onChange={upd(i, 'v')} placeholder="value" className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-sm outline-none focus:border-accent" />
          <button onClick={() => del(i)} title="remove" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:text-danger"><Icon.X className="h-4 w-4" /></button>
        </div>
      ))}
      <div className="flex items-center justify-between pt-1">
        <button onClick={add} className="text-sm text-secondary transition hover:text-primary">+ Add variable</button>
        <Button size="sm" variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}

function DeploysTab({ name, rollbackTo, onRollback }) {
  const v = useVersion();
  const [items, setItems] = useState(null);
  useEffect(() => { fetch(`/api/apps/${name}/deploys`).then((r) => r.json()).then((d) => setItems(d.deploys || [])).catch(() => setItems([])); }, [name, v]);
  if (!items) return <Spinner className="mx-auto my-10 h-5 w-5" />;
  if (items.length === 0) return <p className="py-8 text-center text-sm text-muted">No deploys yet.</p>;
  return (
    <div className="surface-solid divide-y divide-border overflow-hidden">
      {items.map((d) => (
        <div key={d.id} className="flex items-center gap-3 px-4 py-3">
          <span className="grid w-4 place-items-center">
            {d.status === 'success' ? <Icon.Check className="h-4 w-4 text-success" /> : d.status === 'failed' ? <Icon.X className="h-4 w-4 text-danger" /> : <span className="h-1.5 w-1.5 rounded-full bg-warning pulse-dot" />}
          </span>
          <Mono className="text-primary">{shortSha(d.sha) || '—'}</Mono>
          <span className="truncate text-sm text-muted">{d.reason || d.message || d.status}</span>
          <span className="ml-auto shrink-0 text-xs text-muted">{timeAgo(d.finished_at || d.started_at)}</span>
        </div>
      ))}
      {rollbackTo && (
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm text-muted">Roll back to previous good commit <Mono className="text-primary">{shortSha(rollbackTo)}</Mono></span>
          <Button size="sm" variant="ghost" onClick={onRollback}>Rollback</Button>
        </div>
      )}
    </div>
  );
}

function ConfigTab({ app }) {
  const [release, setRelease] = useState(app.release_cmd || '');
  const [persist, setPersist] = useState(app.persist || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.setConfig(app.name, { release: release.trim(), persist: persist.trim() }); invalidate(); toast('config saved — redeploy to apply', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="surface flex flex-col gap-4 p-5">
      <Field label="Release command" hint="runs after build, before the server starts" placeholder="node ace migration:run --force" value={release} onChange={(e) => setRelease(e.target.value)} />
      <Field label="Persist dirs" hint="comma-separated, symlinked to data/ so they survive deploys" placeholder="tmp" value={persist} onChange={(e) => setPersist(e.target.value)} />
      <div className="flex justify-end"><Button size="sm" variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button></div>
    </div>
  );
}
