import { useState } from 'react';
import { Button, Field } from '@codellyson/justui/react';
import { api } from '../api';

export function Login({ needsSetup, onAuthed }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(''); setBusy(true);
    try { await api.login(pw); onAuthed(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="animate-rise w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-accent font-mono text-xl font-bold text-[rgb(var(--accent-text))] shadow-lg shadow-accent/20">
            J
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Just<span className="text-muted">Deploy</span></h1>
            <p className="text-sm text-muted">single-server control panel</p>
          </div>
        </div>

        <div className="surface p-6">
          {needsSetup ? (
            <p className="text-sm text-secondary">
              No admin password set yet. Run{' '}
              <span className="font-mono text-primary">justdeploy dashboard install</span>{' '}
              on the server to set one.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <Field
                label="Password"
                type="password"
                value={pw}
                autoFocus
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                error={err || undefined}
              />
              <Button variant="primary" className="w-full" disabled={busy} onClick={submit}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
