import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/icons';

export function Login({ needsSetup, onAuthed }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(''); setBusy(true);
    try { await api.login(pw); onAuthed(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div
      className="relative grid min-h-dvh place-items-center overflow-hidden px-6"
      style={{ background: 'radial-gradient(1100px 600px at 50% -12%, rgb(var(--accent) / 0.10), transparent 60%), rgb(var(--bg))' }}
    >
      <div className="jd-grid pointer-events-none absolute inset-0 opacity-50" />

      <div className="animate-rise relative w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-[rgb(var(--accent-text))] shadow-lg shadow-accent/25">
            <Icon.Zap className="h-[1.15rem] w-[1.15rem]" />
          </span>
          <span className="text-lg font-semibold tracking-tight">JustDeploy</span>
        </div>

        <div className="surface p-7">
          {needsSetup ? (
            <p className="text-sm leading-relaxed text-secondary">
              No admin password set yet. Run{' '}
              <span className="font-mono text-primary">justdeploy dashboard install</span>{' '}
              on the server to set one.
            </p>
          ) : (
            <>
              <h1 className="text-center text-lg font-semibold tracking-tight">Welcome back</h1>
              <p className="mb-6 mt-1 text-center text-sm text-muted">Enter your password to open the control panel.</p>

              <label className="mb-1.5 block text-xs font-medium text-secondary">Password</label>
              <div className="relative mb-4">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><Icon.Lock className="h-4 w-4" /></span>
                <input
                  type={show ? 'text' : 'password'}
                  value={pw}
                  autoFocus
                  onChange={(e) => setPw(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="••••••••••••"
                  className="field pl-10 pr-10"
                />
                <button onClick={() => setShow((s) => !s)} title="Show / hide" className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-muted transition hover:text-primary">
                  {show ? <Icon.EyeOff className="h-4 w-4" /> : <Icon.Eye className="h-4 w-4" />}
                </button>
              </div>

              {err && <p className="mb-3 text-sm text-danger">{err}</p>}

              <button
                onClick={submit}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-70"
              >
                {busy && <span className="spin h-4 w-4 rounded-full border-2 border-[rgb(var(--accent-text))]/40 border-t-[rgb(var(--accent-text))]" />}
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </>
          )}
        </div>

        <p className="mt-5 text-center text-xs text-muted">
          One server. All your apps. <span className="text-secondary">Deployed in one action.</span>
        </p>
      </div>
    </div>
  );
}
