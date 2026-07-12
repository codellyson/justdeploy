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

function ConnBlock({ label, value, hint, disabled = false, badge }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="label-tiny">{label}</span>
        {badge && <span className={cx('rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide', badge.tone === 'warning' ? 'bg-warning/[0.16] text-warning' : 'surface-2 text-muted')}>{badge.text}</span>}
      </div>
      <div className={cx('flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2', disabled && 'opacity-45')}>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{value}</span>
        <button onClick={() => { navigator.clipboard?.writeText(value); toast('connection string copied', 'success'); }} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:text-primary"><Icon.Copy className="h-3.5 w-3.5" /></button>
      </div>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function DatabaseDetail() {
  const { project, name } = useParams();
  const back = project ? `/projects/${project}` : '/'; // return to this database's project canvas
  const navigate = useNavigate();
  const v = useVersion();
  const [r, setR] = useState(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState('Overview');
  const [busy, setBusy] = useState('');
  const [exposing, setExposing] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => api.resource(name).then((d) => { if (live) (d && d.name ? setR(d) : setMissing(true)); }).catch(() => live && setMissing(true));
    load();
    const t = setInterval(load, 4000);
    return () => { live = false; clearInterval(t); };
  }, [name, v]);

  if (missing) return <div className="py-20 text-center text-muted">Database <span className="font-mono text-primary">{name}</span> not found. <Link to={back} className="inline-flex items-center gap-1 text-accent"><Icon.ArrowLeft className="h-3.5 w-3.5" /> back</Link></div>;
  if (!r) return <div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>;

  const st = r.running ? 'success' : r.status === 'exited' ? 'danger' : 'muted';
  const restart = async () => { setBusy('restart'); try { await api.restartResource(name); invalidate(); toast('database restarted', 'success'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); } };
  const reset = async () => {
    if (!confirm('Rotate the password? Apps using the old one must be updated with the new connection string.')) return;
    setBusy('reset');
    try { const { conn } = await api.resetResourcePassword(name); navigator.clipboard?.writeText(conn); invalidate(); toast('password rotated · new connection copied', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const remove = async () => { if (confirm(`Delete ${name} and its data volume? This cannot be undone.`)) { try { await api.removeResource(name); toast(`${name} removed`); navigate(back); } catch (e) { toast(e.message, 'error'); } } };
  const makePrivate = async () => {
    setBusy('expose');
    try { await api.exposeResource(name, false, []); invalidate(); toast('now private (localhost only)', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const applyExpose = async (allowIps) => {
    setBusy('expose');
    try { await api.exposeResource(name, true, allowIps); invalidate(); toast('now public · external URL ready', 'success'); setExposing(false); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  return (
    <div className="animate-rise flex flex-col gap-5">
      <Link to={back} className="flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-primary"><Icon.ArrowLeft className="h-4 w-4" /> {project || 'Overview'}</Link>

      <div className="flex flex-wrap items-center gap-3">
        <SoftIcon icon={Icon.Database} tone="accent" size="h-11 w-11" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', tone(st).soft, tone(st).text)}>
              <span className={cx('h-1.5 w-1.5 rounded-full', tone(st).dot)} />{r.running ? 'Running' : r.status}
            </span>
            {r.tls && <span className="inline-flex items-center gap-1 rounded-full bg-success/[0.14] px-2 py-0.5 text-[0.7rem] font-medium text-success"><Icon.Lock className="h-3 w-3" /> TLS</span>}
            {r.scoped && <span className="inline-flex items-center gap-1 rounded-full surface-2 px-2 py-0.5 text-[0.7rem] font-medium text-muted" title="Handed-out role is a non-superuser">scoped role</span>}
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
            <Row label="Port" value={String(r.port ?? '—')} copyable={false} />
            <Row label="Database" value={r.dbName} />
            <Row label="User" value={r.user} />
            <Row label="Password" value={r.password} secret />
            <Row label="Version" value={r.image} copyable={false} />
            <Row label="Created" value={r.created_at ? timeAgo(r.created_at) : '—'} mono={false} copyable={false} />
          </div>
          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <ConnBlock label="Internal connection URL" value={r.privateConn} hint="For apps running on this server." />
            <ConnBlock label="External connection URL" value={r.publicConn} disabled={!r.public}
              badge={r.public ? { text: 'public', tone: 'warning' } : { text: 'off', tone: 'muted' }}
              hint={r.public ? `Reachable at ${r.publicHost}:${r.port} — for DB explorers and external clients.` : 'Turn on Public access in Settings to use this URL.'} />
          </div>
          <p className="text-xs text-muted">Add the internal URL to an app: <Mono className="text-secondary">justdeploy env &lt;app&gt; DATABASE_URL=…</Mono>, then redeploy.</p>
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
          <div className={cx('flex flex-col gap-3 rounded-2xl border p-5', r.public ? 'border-warning/40 bg-warning/[0.07]' : 'surface')}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="max-w-md">
                <div className="flex items-center gap-2 text-base font-semibold">Public access {r.public && <span className="rounded bg-warning/[0.16] px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-warning">on</span>}</div>
                <div className="mt-0.5 text-sm text-muted">{r.public
                  ? <>Published on <Mono className="text-secondary">{r.publicHost}:{r.port}</Mono> for external clients.</>
                  : 'Publish on a public port so external clients (DB explorers) can connect. Off by default; apps on this server use the internal URL either way.'}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {r.public && <button onClick={() => setExposing(true)} disabled={!!busy} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm font-medium transition hover:border-muted/50 disabled:opacity-60"><Icon.Settings className="h-4 w-4" /> Edit IPs</button>}
                <button onClick={r.public ? makePrivate : () => setExposing(true)} disabled={!!busy} className={cx('flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition disabled:opacity-60', r.public ? 'border border-border bg-bg-secondary hover:border-muted/50' : 'bg-accent text-[rgb(var(--accent-text))] hover:brightness-[1.06]')}>
                  <Icon.Globe className="h-4 w-4" /> {busy === 'expose' ? 'Applying…' : r.public ? 'Make private' : 'Make public'}
                </button>
              </div>
            </div>
            {r.public && (
              <>
                <div className="flex items-center gap-2 border-t border-warning/20 pt-3 text-xs">
                  {r.allowIps?.length
                    ? <><Icon.Lock className="h-3.5 w-3.5 text-success" /><span className="text-secondary">Restricted to</span> <Mono className="text-primary">{r.allowIps.join(', ')}</Mono></>
                    : <><Icon.Alert className="h-3.5 w-3.5 text-danger" /><span className="text-danger">Open to the entire internet — no IP allowlist. Anyone can attempt to connect.</span></>}
                </div>
                <HostnameRow current={r.publicHost} />
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/[0.08] p-5">
            <div><div className="text-base font-semibold text-danger">Delete database</div><div className="mt-0.5 text-sm text-secondary">Permanently remove the container and its data volume. This cannot be undone.</div></div>
            <button onClick={remove} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-danger px-3.5 py-2 text-sm font-semibold text-white transition hover:brightness-110"><Icon.Trash className="h-4 w-4" /> Delete</button>
          </div>
        </div>
      )}

      {exposing && <ExposeModal name={name} current={r.allowIps} busy={busy === 'expose'} onCancel={() => setExposing(false)} onApply={applyExpose} />}
    </div>
  );
}

function HostnameRow({ current }) {
  const [host, setHost] = useState(current || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setHost(current || ''); }, [current]);
  const save = async () => {
    setSaving(true);
    try { await api.setDbHost(host.trim()); invalidate(); toast('public hostname updated', 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setSaving(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-warning/20 pt-3">
      <span className="label-tiny">Public hostname</span>
      <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.example.com" className="field flex-1 py-1.5 font-mono text-xs" />
      <button onClick={save} disabled={saving || host.trim() === (current || '')} className="rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-xs font-medium transition hover:border-muted/50 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
      <span className="w-full text-[0.7rem] text-muted">Used in the external URL. Must be a DNS-only A record pointing at this server (not proxied). Leave blank to use the IP.</span>
    </div>
  );
}

function ExposeModal({ name, current, busy, onCancel, onApply }) {
  const [ips, setIps] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (current?.length) { setIps(current.join(', ')); setLoaded(true); return; }
    api.myIp().then((d) => setIps(d.ip ? `${d.ip}/32` : '')).catch(() => {}).finally(() => setLoaded(true));
  }, []); // eslint-disable-line
  const list = ips.split(',').map((s) => s.trim()).filter(Boolean);
  const open = list.length === 0;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div className="surface w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="flex items-center gap-2 text-lg font-semibold"><Icon.Globe className="h-5 w-5 text-accent" /> Expose {name} publicly</h3>
        <p className="mt-1.5 text-sm text-muted">Only these source IPs are allowed through the firewall to the database port — everyone else is dropped. (Docker bypasses <Mono>ufw</Mono>, so this is enforced via a <Mono>DOCKER-USER</Mono> rule.)</p>
        <label className="label-tiny mt-4 block">Allowed IPs — comma-separated CIDR</label>
        <input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.4/32, 198.51.100.0/24" className="field mt-1 w-full font-mono text-sm" autoFocus />
        <div className="mt-2 text-xs">
          {open
            ? <span className="flex items-center gap-1.5 text-danger"><Icon.Alert className="h-3.5 w-3.5" /> Empty = open to the entire internet. Strongly discouraged.</span>
            : <span className="text-muted">{loaded ? 'Prefilled with your current IP. Add more if needed.' : 'Detecting your IP…'}</span>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-secondary transition hover:text-primary">Cancel</button>
          <button onClick={() => onApply(list)} disabled={busy || !loaded} className={cx('flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-60', open ? 'bg-danger text-white hover:brightness-110' : 'bg-accent text-[rgb(var(--accent-text))] hover:brightness-[1.06]')}>
            <Icon.Globe className="h-4 w-4" /> {busy ? 'Applying…' : open ? 'Expose to everyone' : 'Expose to these IPs'}
          </button>
        </div>
      </div>
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
