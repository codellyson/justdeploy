import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useVersion, invalidate } from '../lib/store';
import { toast } from '../components/toast';
import { SoftIcon, Spinner, Mono, tone } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, timeAgo } from '../lib/format';

const TABS = [
  { id: 'Overview', icon: Icon.Database },
  { id: 'Logs', icon: Icon.Terminal },
  { id: 'Settings', icon: Icon.Settings },
];

function Row({ label, value, mono = true, secret = false, copyable = true }) {
  const [show, setShow] = useState(false);
  const display = secret && !show ? '••••••••••••••••' : (value ?? '—');
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-tiny">{label}</span>
      <div className="flex items-center gap-2">
        <span className={cx('min-w-0 flex-1 truncate text-sm', mono && 'font-mono')}>{display}</span>
        {secret && <button onClick={() => setShow((s) => !s)} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:text-primary">{show ? <Icon.EyeOff className="h-3.5 w-3.5" /> : <Icon.Eye className="h-3.5 w-3.5" />}</button>}
        {copyable && value && <button onClick={() => { navigator.clipboard?.writeText(value); toast('copied', 'success'); }} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:text-primary"><Icon.Copy className="h-3.5 w-3.5" /></button>}
      </div>
    </div>
  );
}

export function DatabaseDetail() {
  const { name } = useParams();
  const navigate = useNavigate();
  const v = useVersion();
  const [r, setR] = useState(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState('Overview');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => api.resource(name).then((d) => { if (live) (d && d.name ? setR(d) : setMissing(true)); }).catch(() => live && setMissing(true));
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [name, v]);

  if (missing) return <div className="py-20 text-center text-muted">Database <span className="font-mono text-primary">{name}</span> not found. <Link to="/" className="inline-flex items-center gap-1 text-accent"><Icon.ArrowLeft className="h-3.5 w-3.5" /> back</Link></div>;
  if (!r) return <div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>;

  const st = r.running ? 'success' : r.status === 'exited' ? 'danger' : 'muted';
  const restart = async () => { setBusy('restart'); try { await api.restartResource(name); invalidate(); toast('database restarted', 'success'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); } };
  const reset = async () => {
    if (!confirm('Rotate the password? Apps using the old one must be updated with the new connection string.')) return;
    setBusy('reset');
    try { const { conn } = await api.resetResourcePassword(name); navigator.clipboard?.writeText(conn); invalidate(); toast('password rotated · new connection copied', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const remove = async () => { if (confirm(`Delete ${name} and its data volume? This cannot be undone.`)) { try { await api.removeResource(name); toast(`${name} removed`); navigate('/'); } catch (e) { toast(e.message, 'error'); } } };

  return (
    <div className="animate-rise flex flex-col gap-5">
      <Link to="/" className="flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-primary"><Icon.ArrowLeft className="h-4 w-4" /> Overview</Link>

      <div className="flex flex-wrap items-center gap-3">
        <SoftIcon icon={Icon.Database} tone="accent" size="h-11 w-11" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', tone(st).soft, tone(st).text)}>
              <span className={cx('h-1.5 w-1.5 rounded-full', tone(st).dot)} />{r.running ? 'Running' : r.status}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted">🐘 {r.image || 'postgres'}</div>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx('relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm transition', tab === t.id ? 'text-primary' : 'text-muted hover:text-secondary')}>
            <t.icon className="h-4 w-4" />{t.id}
            {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="surface flex flex-col gap-5 p-5">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
            <Row label="Host" value={r.host} copyable={false} />
            <Row label="Port" value={String(r.port ?? '—')} copyable={false} />
            <Row label="Database" value={r.dbName} />
            <Row label="User" value={r.user} />
            <Row label="Password" value={r.password} secret />
            <Row label="Created" value={r.created_at ? timeAgo(r.created_at) : '—'} mono={false} copyable={false} />
          </div>
          <div className="border-t border-border pt-4">
            <Row label="Connection string" value={r.conn} />
          </div>
          <p className="text-xs text-muted">Add it to an app: <Mono className="text-secondary">justdeploy env &lt;app&gt; DATABASE_URL=…</Mono>, then redeploy.</p>
        </div>
      )}

      {tab === 'Logs' && <LogsTab name={name} />}

      {tab === 'Settings' && (
        <div className="flex max-w-2xl flex-col gap-4">
          <div className="surface flex flex-wrap items-center justify-between gap-3 p-5">
            <div><div className="text-base font-semibold">Restart</div><div className="mt-0.5 text-sm text-muted">Restart the Postgres container. Data is preserved.</div></div>
            <button onClick={restart} disabled={!!busy} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-medium transition hover:border-muted/50 disabled:opacity-60"><Icon.Rollback className="h-4 w-4" /> {busy === 'restart' ? 'Restarting…' : 'Restart'}</button>
          </div>
          <div className="surface flex flex-wrap items-center justify-between gap-3 p-5">
            <div><div className="text-base font-semibold">Rotate password</div><div className="mt-0.5 text-sm text-muted">Generate a new password and copy the updated connection string.</div></div>
            <button onClick={reset} disabled={!!busy} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-medium transition hover:border-muted/50 disabled:opacity-60"><Icon.Lock className="h-4 w-4" /> {busy === 'reset' ? 'Rotating…' : 'Rotate'}</button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/[0.08] p-5">
            <div><div className="text-base font-semibold text-danger">Delete database</div><div className="mt-0.5 text-sm text-secondary">Permanently remove the container and its data volume. This cannot be undone.</div></div>
            <button onClick={remove} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-danger px-3.5 py-2 text-sm font-semibold text-white transition hover:brightness-110"><Icon.Trash className="h-4 w-4" /> Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LogsTab({ name }) {
  const boxRef = useRef(null);
  const [live, setLive] = useState(true);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.textContent = '';
    const es = api.resourceLogStream(name);
    es.onmessage = (e) => {
      if (!box) return;
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      box.textContent += e.data + '\n';
      if (stick) box.scrollTop = box.scrollHeight;
    };
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [name]);
  return (
    <div className="surface overflow-hidden p-0">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-secondary"><Icon.Terminal className="h-4 w-4" /> Container logs</span>
        <span className={cx('flex items-center gap-1.5 font-mono text-[0.7rem]', live ? 'text-success' : 'text-warning')}><span className={cx('h-1.5 w-1.5 rounded-full pulse-dot', live ? 'bg-success' : 'bg-warning')} />{live ? 'streaming' : 'reconnecting'}</span>
      </div>
      <pre ref={boxRef} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words bg-bg p-4 font-mono text-xs leading-relaxed text-secondary" />
    </div>
  );
}
