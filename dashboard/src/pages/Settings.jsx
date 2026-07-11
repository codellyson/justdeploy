import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { toast } from '../components/toast';
import { Icon } from '../components/icons';
import { Spinner } from '../components/ui';
import { cx, timeAgo } from '../lib/format';

function CopyField({ value, secret }) {
  const [show, setShow] = useState(!secret);
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={show ? (value || '') : '•'.repeat(Math.min((value || '').length, 32))} className="field flex-1 py-1.5 font-mono text-[0.8rem]" />
      {secret && <button onClick={() => setShow((s) => !s)} title="Reveal" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:text-primary">{show ? <Icon.EyeOff className="h-4 w-4" /> : <Icon.Eye className="h-4 w-4" />}</button>}
      <button onClick={() => { navigator.clipboard?.writeText(value || ''); toast('copied', 'success'); }} title="Copy" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:text-primary"><Icon.Copy className="h-4 w-4" /></button>
    </div>
  );
}

function HostRow({ ok, label, detail }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-danger')} />
      <span className={ok ? 'text-secondary' : 'text-primary'}>{label}</span>
      {detail && <span className="truncate font-mono text-xs text-muted">{detail}</span>}
    </div>
  );
}

function Card({ icon: Ico, title, subtitle, children }) {
  return (
    <section className="surface p-5">
      <div className="mb-4 flex items-start gap-3">
        {Ico && <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent/[0.12] text-accent"><Ico className="h-4 w-4" /></span>}
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Label({ children }) { return <label className="label-tiny">{children}</label>; }
function SaveBtn({ busy, onClick, children = 'Save' }) {
  return <button onClick={onClick} disabled={busy} className="rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-60">{busy ? 'Saving…' : children}</button>;
}

export function Settings() {
  const [d, setD] = useState(null);
  const load = () => Promise.all([api.state(), api.backupSettings(), api.webhookInfo(), api.backups(), api.host()])
    .then(([st, bk, wh, bl, host]) => setD({ st, bk, wh, backups: bl.backups, host }));
  useEffect(() => { load().catch(() => {}); }, []);
  if (!d) return <Spinner className="mx-auto my-16 h-6 w-6" />;
  return <SettingsBody {...d} reload={load} />;
}

function SettingsBody({ st, bk, wh, backups, host, reload }) {
  const [busy, setBusy] = useState('');
  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) toast(ok, 'success'); await reload(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  // General
  const [domain, setDomain] = useState(st.baseDomain || '');
  const [dbHost, setDbHost] = useState(st.publicHost || '');
  // Security
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  // GitHub
  const [token, setToken] = useState('');
  // Backups
  const [cfg, setCfg] = useState({ endpoint: bk.endpoint, bucket: bk.bucket, region: bk.region, accessKey: bk.accessKey, secretKey: '', prefix: bk.prefix });
  const [keep, setKeep] = useState(7);

  const savePassword = () => {
    if (pw.next.length < 8) return toast('new password must be at least 8 characters', 'error');
    if (pw.next !== pw.confirm) return toast('passwords do not match', 'error');
    run('pw', () => api.setPassword(pw.current, pw.next), 'password changed').then(() => setPw({ current: '', next: '', confirm: '' }));
  };
  const runBackup = () => run('bkrun', async () => {
    const r = await api.runBackup();
    toast(r.uploaded ? `backed up ${r.sizeMB} MB → your bucket` : `backed up ${r.sizeMB} MB locally${r.hasRemote ? '' : ' (no remote configured)'}`, 'success');
  });
  const restore = (name) => {
    if (!window.confirm(`Restore ${name}?\n\nThis OVERWRITES current state (db, app data, Postgres) and restarts the dashboard.`)) return;
    run('restore', async () => {
      await api.restoreBackup(name);
      toast('restore started — the dashboard will restart shortly', 'success');
      setTimeout(() => window.location.reload(), 9000);
    });
  };

  const SCHEDULES = ['off', 'hourly', 'daily', 'weekly'];

  return (
    <div className="animate-rise mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <Link to="/" className="mb-4 flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-primary"><Icon.ArrowLeft className="h-4 w-4" /> Overview</Link>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">Configure your instance — everything the CLI does, from the browser.</p>
      </div>

      {/* General */}
      <Card icon={Icon.Globe} title="General" subtitle="Where your apps live.">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Base domain <span className="font-normal normal-case tracking-normal text-muted/70">— new apps become {'<name>'}.{domain || 'yourdomain.com'}</span></Label>
            <div className="flex flex-wrap gap-2">
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="apps.yourdomain.com" className="field flex-1 basis-56 py-1.5 font-mono text-sm" />
              <SaveBtn busy={busy === 'domain'} onClick={() => run('domain', () => api.setBaseDomain(domain.trim()), 'base domain saved')} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Database public host <span className="font-normal normal-case tracking-normal text-muted/70">— hostname in public DB connection strings; blank = the domain</span></Label>
            <div className="flex flex-wrap gap-2">
              <input value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="db.yourdomain.com" className="field flex-1 basis-56 py-1.5 font-mono text-sm" />
              <SaveBtn busy={busy === 'dbhost'} onClick={() => run('dbhost', () => api.setDbHost(dbHost.trim()), 'database host saved')} />
            </div>
          </div>
        </div>
      </Card>

      {/* Security */}
      <Card icon={Icon.Lock} title="Password" subtitle="The admin password for this dashboard.">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5"><Label>Current</Label><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" className="field py-1.5 text-sm" /></div>
          <div className="flex flex-col gap-1.5"><Label>New</Label><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" className="field py-1.5 text-sm" /></div>
          <div className="flex flex-col gap-1.5"><Label>Confirm</Label><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" className="field py-1.5 text-sm" onKeyDown={(e) => e.key === 'Enter' && savePassword()} /></div>
        </div>
        <div className="mt-4 flex justify-end"><SaveBtn busy={busy === 'pw'} onClick={savePassword}>Change password</SaveBtn></div>
      </Card>

      {/* GitHub */}
      <Card icon={Icon.Github} title="GitHub" subtitle="Deploy private repos and auto-detect frameworks.">
        {st.github ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg px-4 py-3">
            <span className="flex items-center gap-2 text-sm"><Icon.Check className="h-4 w-4 text-success" /> Connected{st.githubLogin ? <> as <b className="font-semibold">{st.githubLogin}</b></> : ''}</span>
            <button onClick={() => run('ghdis', () => api.githubDisconnect(), 'GitHub disconnected')} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:text-danger">Disconnect</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="ghp_… (repo scope)" className="field flex-1 basis-56 py-1.5 font-mono text-sm" />
            <a href="https://github.com/settings/tokens/new?scopes=repo&description=JustDeploy" target="_blank" rel="noreferrer" className="text-xs text-accent transition hover:underline">create token ↗</a>
            <button onClick={() => token.trim() && run('ghcon', () => api.githubConnect(token.trim()), 'GitHub connected').then(() => setToken(''))} disabled={busy === 'ghcon'} className="rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-60">Connect</button>
          </div>
        )}
      </Card>

      {/* Auto-deploy (webhook) */}
      <Card icon={Icon.GitBranch} title="Git-push auto-deploy" subtitle="Push to a repo's default branch → the matching app redeploys.">
        {wh.enabled ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5"><Label>Payload URL</Label><CopyField value={wh.url} /></div>
            <div className="flex flex-col gap-1.5"><Label>Secret</Label><CopyField value={wh.secret} secret /></div>
            <div className="rounded-xl border border-border bg-bg px-4 py-3 text-xs text-secondary">
              <div className="mb-1.5 font-medium text-primary">GitHub → repo Settings → Webhooks → Add webhook</div>
              Payload URL <span className="text-muted">(above)</span> · Content type <code className="text-accent">application/json</code> · the Secret <span className="text-muted">(above)</span> · "Just the push event". Only default-branch pushes deploy.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => run('whoff', () => api.disableWebhook(), 'auto-deploy disabled')} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:text-danger">Disable</button>
              <button onClick={() => run('whrot', () => api.enableWebhook(), 'secret rotated — update it in GitHub')} className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-semibold transition hover:border-muted/50"><Icon.Rollback className="h-4 w-4" /> Rotate secret</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Not enabled. Turn it on to get a signed payload URL to paste into GitHub.</p>
            <SaveBtn busy={busy === 'whon'} onClick={() => run('whon', () => api.enableWebhook(), 'auto-deploy enabled')}>Enable</SaveBtn>
          </div>
        )}
      </Card>

      {/* Backups */}
      <Card icon={Icon.Database} title="Backups" subtitle="Snapshot state.db + app data + Postgres to your own S3 / R2 bucket.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-bg px-3.5 py-2.5 text-xs text-muted">
            <span>Get an endpoint + keys from your provider:</span>
            <a href="https://dash.cloudflare.com/?to=/:account/r2/api-tokens" target="_blank" rel="noreferrer" className="font-medium text-accent transition hover:underline">Cloudflare R2 ↗</a>
            <span className="text-muted/50">·</span>
            <a href="https://console.aws.amazon.com/iam/home#/security_credentials" target="_blank" rel="noreferrer" className="font-medium text-accent transition hover:underline">AWS S3 (IAM keys) ↗</a>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5"><Label>Endpoint</Label><input value={cfg.endpoint} onChange={(e) => setCfg({ ...cfg, endpoint: e.target.value })} placeholder="https://<acct>.r2.cloudflarestorage.com" className="field py-1.5 font-mono text-[0.8rem]" /></div>
            <div className="flex flex-col gap-1.5"><Label>Bucket</Label><input value={cfg.bucket} onChange={(e) => setCfg({ ...cfg, bucket: e.target.value })} placeholder="my-backups" className="field py-1.5 font-mono text-[0.8rem]" /></div>
            <div className="flex flex-col gap-1.5"><Label>Access key</Label><input value={cfg.accessKey} onChange={(e) => setCfg({ ...cfg, accessKey: e.target.value })} className="field py-1.5 font-mono text-[0.8rem]" /></div>
            <div className="flex flex-col gap-1.5"><Label>Secret key</Label><input type="password" value={cfg.secretKey} onChange={(e) => setCfg({ ...cfg, secretKey: e.target.value })} placeholder={bk.hasSecret ? '•••••••• (stored — leave blank to keep)' : ''} className="field py-1.5 font-mono text-[0.8rem]" /></div>
            <div className="flex flex-col gap-1.5"><Label>Region</Label><input value={cfg.region} onChange={(e) => setCfg({ ...cfg, region: e.target.value })} placeholder="auto" className="field py-1.5 font-mono text-[0.8rem]" /></div>
            <div className="flex flex-col gap-1.5"><Label>Prefix (optional)</Label><input value={cfg.prefix} onChange={(e) => setCfg({ ...cfg, prefix: e.target.value })} placeholder="justdeploy" className="field py-1.5 font-mono text-[0.8rem]" /></div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cx('flex items-center gap-1.5 text-xs', bk.configured ? 'text-success' : 'text-muted')}>
              <span className={cx('h-1.5 w-1.5 rounded-full', bk.configured ? 'bg-success' : 'bg-muted')} />
              {bk.configured ? 'Remote configured' : 'No remote yet — backups stay local until set'}
            </span>
            <div className="flex gap-2">
              <button onClick={runBackup} disabled={busy === 'bkrun'} className="rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-semibold transition hover:border-muted/50 disabled:opacity-60">{busy === 'bkrun' ? 'Backing up…' : 'Back up now'}</button>
              <SaveBtn busy={busy === 'bkcfg'} onClick={() => run('bkcfg', () => api.setBackupConfig(cfg), 'backup settings saved')}>Save config</SaveBtn>
            </div>
          </div>

          {/* schedule */}
          <div className="mt-1 border-t border-border pt-4">
            <Label>Automatic schedule</Label>
            <p className="mb-2.5 mt-0.5 text-xs text-muted">Installs a systemd timer that runs a backup at your interval, keeping the newest {keep}.</p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-xl border border-border bg-bg-secondary p-0.5">
                {SCHEDULES.map((s) => (
                  <button key={s} onClick={() => run('sched', () => api.setBackupSchedule(s, keep), s === 'off' ? 'schedule disabled' : `backing up ${s}`)} disabled={busy === 'sched'}
                    className={cx('rounded-[0.6rem] px-3 py-1.5 text-sm font-medium capitalize transition', bk.schedule === s ? 'bg-bg text-primary shadow-sm' : 'text-muted hover:text-primary')}>{s}</button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 text-sm text-muted">keep <input type="number" min="1" value={keep} onChange={(e) => setKeep(Math.max(1, Number(e.target.value) || 1))} className="field w-16 py-1 text-center text-sm" /></div>
            </div>
          </div>

          {backups.length > 0 && (
            <div className="mt-1 border-t border-border pt-4">
              <Label>Recent backups</Label>
              <div className="mt-2 overflow-hidden rounded-xl border border-border">
                {backups.slice(0, 6).map((b) => (
                  <div key={b.name} className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
                    <div className="min-w-0"><div className="truncate font-mono text-xs">{b.name}</div><div className="text-xs text-muted">{b.sizeMB} MB · {timeAgo(b.at)}</div></div>
                    <button onClick={() => restore(b.name)} disabled={busy === 'restore'} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition hover:text-primary disabled:opacity-60">Restore</button>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">Restore overwrites current state and restarts the dashboard.</p>
            </div>
          )}
        </div>
      </Card>

      {/* Host & maintenance */}
      <Card icon={Icon.Server} title="Host &amp; maintenance" subtitle="Server status and one-click upkeep.">
        <div className="flex flex-col gap-4">
          <div className="grid gap-1.5 rounded-xl border border-border bg-bg p-3.5 sm:grid-cols-2">
            <HostRow ok={host.caddyAdmin} label="Caddy" detail={host.versions?.caddy?.split(' ')[0]} />
            <HostRow ok={host.docker} label="Docker" detail={host.versions?.docker?.replace('Docker version ', '').split(',')[0]} />
            <HostRow ok={host.railpack} label="Railpack" detail={host.versions?.railpack?.replace('railpack version ', '')} />
            <HostRow ok={host.buildkit} label="BuildKit" detail={host.buildkit ? 'running' : 'on first deploy'} />
          </div>
          {host.disk && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs"><span className="text-muted">Disk</span><span className="font-mono text-secondary">{host.disk.usedGB} / {host.disk.totalGB} GB · {host.disk.freeGB} free</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-bg-secondary"><div className={cx('h-full rounded-full', host.disk.pct > 85 ? 'bg-warning' : 'bg-accent')} style={{ width: `${host.disk.pct}%` }} /></div>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button onClick={() => run('reconcile', () => api.reconcile(), 'proxy config rebuilt from state')} disabled={busy === 'reconcile'} className="rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-semibold transition hover:border-muted/50 disabled:opacity-60">{busy === 'reconcile' ? 'Rebuilding…' : 'Rebuild proxy config'}</button>
            <button onClick={() => run('gc', async () => { const r = await api.gc(); toast(r.apps.length ? `reclaimed — trimmed images for ${r.apps.length} app(s)` : 'nothing to reclaim', 'success'); })} disabled={busy === 'gc'} className="rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-semibold transition hover:border-muted/50 disabled:opacity-60">{busy === 'gc' ? 'Reclaiming…' : 'Reclaim disk'}</button>
          </div>
        </div>
      </Card>
    </div>
  );
}
