import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { toast } from './toast';
import { Icon } from './icons';
import { cx } from '../lib/format';

// First-run setup wizard: a checklist that walks a fresh instance from "just installed" to
// "first app deployed" — host readiness, base domain, GitHub, deploy. Shown on the Overview
// until dismissed or complete. Reads onboarding flags off /api/state; host status off /api/doctor.
function StepShell({ n, done, title, subtitle, children }) {
  return (
    <div className={cx('flex gap-3.5 px-4 py-3.5', done && 'opacity-70')}>
      <span className={cx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold',
        done ? 'bg-accent text-[rgb(var(--accent-text))]' : 'surface-2 text-secondary')}>
        {done ? <Icon.Check className="h-3.5 w-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {done && <span className="text-xs text-accent">done</span>}
        </div>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        {!done && children && <div className="mt-3">{children}</div>}
      </div>
    </div>
  );
}

function Dot({ ok, label, hint }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-danger')} />
      <span className={ok ? 'text-secondary' : 'text-primary'}>{label}</span>
      {!ok && hint && <span className="text-xs text-muted">— {hint}</span>}
    </div>
  );
}

export function Onboarding({ state, onChange, onDeploy }) {
  const [doctor, setDoctor] = useState(null);
  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => { api.doctor().then(setDoctor).catch(() => setDoctor({})); }, []);
  useEffect(() => { if (!domain && state.baseDomain) setDomain(state.baseDomain); }, [state.baseDomain]);

  const apps = state.apps.filter((a) => a.serve !== 'resource');
  const hostReady = !!(doctor && doctor.caddyAdmin && doctor.docker && doctor.railpack);
  const steps = {
    host: hostReady,
    domain: state.baseDomainSet,
    github: state.github,
    deploy: apps.length > 0,
  };
  const doneCount = Object.values(steps).filter(Boolean).length;
  const allDone = doneCount === 4;

  const saveDomain = async () => {
    const d = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!d) return toast('enter a domain', 'error');
    setBusy('domain');
    try { await api.setBaseDomain(d); toast('base domain saved', 'success'); onChange?.(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const connectGithub = async () => {
    if (!token.trim()) return toast('paste a token', 'error');
    setBusy('github');
    try { const st = await api.githubConnect(token.trim()); toast(`connected as ${st.login}`, 'success'); setToken(''); onChange?.(); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const dismiss = async () => { try { await api.dismissOnboarding(); onChange?.(); } catch (e) { toast(e.message, 'error'); } };

  return (
    <section className="surface animate-rise overflow-hidden p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent/[0.12] text-accent"><Icon.Rocket className="h-4 w-4" /></span>
          <div>
            <h2 className="text-sm font-semibold">{allDone ? "You're all set" : 'Finish setting up JustDeploy'}</h2>
            <p className="text-xs text-muted">{allDone ? 'Everything is configured — deploy away.' : `${doneCount} of 4 done`}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden h-1.5 w-28 overflow-hidden rounded-full surface-2 sm:block">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / 4) * 100}%` }} />
          </div>
          <Link to="/settings" className="text-xs text-accent transition hover:underline">All settings →</Link>
          <button onClick={dismiss} className="text-xs text-muted transition hover:text-primary">{allDone ? 'Dismiss' : 'Skip'}</button>
        </div>
      </div>

      <div className="divide-y divide-border">
        {/* 1. host readiness — read-only (system installs happen on the box via `justdeploy setup`) */}
        <StepShell n={1} done={steps.host} title="Host is ready"
          subtitle={steps.host ? 'Caddy, Docker and Railpack are installed and reachable.' : 'JustDeploy needs Caddy, Docker and Railpack on the server.'}>
          <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-bg p-3">
            {!doctor ? <span className="text-xs text-muted">checking…</span> : <>
              <Dot ok={doctor.caddyAdmin} label="Caddy (admin API)" hint="systemctl status caddy" />
              <Dot ok={doctor.docker} label="Docker" hint="run: justdeploy setup" />
              <Dot ok={doctor.railpack} label="Railpack (container builds)" hint="run: justdeploy setup" />
              <Dot ok={doctor.buildkit} label="BuildKit daemon" hint="starts on first container deploy" />
              {!hostReady && <p className="mt-1.5 text-xs text-muted">On the server, run <code className="rounded bg-bg-secondary px-1 font-mono text-accent">justdeploy setup</code> to install what's missing, then refresh.</p>}
            </>}
          </div>
        </StepShell>

        {/* 2. base domain */}
        <StepShell n={2} done={steps.domain} title="Set your base domain"
          subtitle={steps.domain ? `Apps get <name>.${state.baseDomain} automatically.` : "New apps become subdomains of this — e.g. app.yourdomain.com. Point a wildcard DNS record (*.domain) at this server."}>
          <div className="flex flex-wrap items-center gap-2">
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="apps.yourdomain.com"
              className="field w-full flex-1 basis-56 py-1.5 font-mono text-sm" onKeyDown={(e) => e.key === 'Enter' && saveDomain()} />
            <button onClick={saveDomain} disabled={busy === 'domain'} className="rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-60">{busy === 'domain' ? 'Saving…' : 'Save'}</button>
          </div>
        </StepShell>

        {/* 3. connect GitHub */}
        <StepShell n={3} done={steps.github} title="Connect GitHub"
          subtitle={steps.github ? 'Connected — private repos and framework detection work.' : 'Deploy private repos and auto-detect the framework. Paste a Personal Access Token (repo scope).'}>
          <div className="flex flex-wrap items-center gap-2">
            <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="ghp_… (repo scope)"
              className="field w-full flex-1 basis-56 py-1.5 font-mono text-sm" onKeyDown={(e) => e.key === 'Enter' && connectGithub()} />
            <a href="https://github.com/settings/tokens/new?scopes=repo&description=JustDeploy" target="_blank" rel="noreferrer" className="text-xs text-accent transition hover:underline">create token ↗</a>
            <button onClick={connectGithub} disabled={busy === 'github'} className="rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-semibold transition hover:border-muted/50 disabled:opacity-60">{busy === 'github' ? 'Connecting…' : 'Connect'}</button>
          </div>
        </StepShell>

        {/* 4. deploy first app */}
        <StepShell n={4} done={steps.deploy} title="Deploy your first app"
          subtitle={steps.deploy ? `${apps.length} app${apps.length === 1 ? '' : 's'} deployed.` : 'Pick a type, point it at a repo, done.'}>
          <button onClick={onDeploy} className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]"><Icon.Zap className="h-4 w-4" /> New project</button>
        </StepShell>
      </div>
    </section>
  );
}
