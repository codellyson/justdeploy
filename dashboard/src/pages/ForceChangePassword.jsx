import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/icons';

// Shown right after login when an admin created the account with a temporary password
// (must_change). Blocks the app until the user picks their own password.
export function ForceChangePassword({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    if (next.length < 8) return setErr('New password must be at least 8 characters.');
    if (next !== confirm) return setErr('Passwords do not match.');
    setBusy(true);
    try { await api.setPassword(current, next); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="animate-rise w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-[rgb(var(--accent-text))]"><Icon.Lock className="h-[1.15rem] w-[1.15rem]" /></span>
          <span className="text-lg font-semibold tracking-tight">Set your password</span>
        </div>
        <div className="surface p-7">
          <p className="mb-6 text-center text-sm text-muted">Your account was created with a temporary password. Choose a new one to continue.</p>
          {[['Temporary password', current, setCurrent], ['New password', next, setNext], ['Confirm new password', confirm, setConfirm]].map(([label, val, set]) => (
            <div key={label} className="mb-4">
              <label className="mb-1.5 block text-xs font-medium text-secondary">{label}</label>
              <input type="password" value={val} onChange={(e) => set(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()} className="field" />
            </div>
          ))}
          {err && <p className="mb-3 text-sm text-danger">{err}</p>}
          <button onClick={submit} disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-70">
            {busy && <span className="spin h-4 w-4 rounded-full border-2 border-[rgb(var(--accent-text))]/40 border-t-[rgb(var(--accent-text))]" />}
            {busy ? 'Saving…' : 'Save password'}
          </button>
        </div>
      </div>
    </div>
  );
}
