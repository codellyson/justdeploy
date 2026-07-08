import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from './toast';
import { Icon } from './icons';
import { timeAgo } from '../lib/format';

// Repository source picker. When GitHub is connected (a stored PAT), shows a searchable list
// of the user's repos; otherwise a manual URL field + an inline connect flow. Private repos
// clone once connected. Calls onRepo(cloneUrl) on selection or manual entry.
export function GithubSource({ value, onRepo, onPick }) {
  const [gh, setGh] = useState(null);          // null=loading, {connected, login}
  const [repos, setRepos] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => { api.githubStatus().then(setGh).catch(() => setGh({ connected: false })); }, []);
  useEffect(() => { if (gh?.connected) api.githubRepos().then((d) => setRepos(d.repos)).catch(() => setRepos([])); }, [gh?.connected]);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const s = q.toLowerCase();
    return repos.filter((r) => r.full_name.toLowerCase().includes(s)).slice(0, 8);
  }, [repos, q]);

  const connect = async () => {
    setBusy(true);
    try { const st = await api.githubConnect(token.trim()); setGh(st); setShowConnect(false); setToken(''); toast(`connected as ${st.login}`, 'success'); }
    catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const disconnect = async () => { await api.githubDisconnect().catch(() => {}); setGh({ connected: false }); setRepos(null); onRepo(''); };

  const pick = (r) => { onRepo(r.clone_url); onPick?.(r); setQ(r.full_name); setOpen(false); };

  return (
    <div className="flex flex-col gap-1.5" ref={ref}>
      <div className="flex items-center justify-between">
        <label className="label-tiny">Repository</label>
        {gh?.connected ? (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Icon.Github className="h-3.5 w-3.5" />{gh.login}
            <button onClick={disconnect} className="ml-1 text-muted/70 transition hover:text-danger">disconnect</button>
          </span>
        ) : gh && (
          <button onClick={() => setShowConnect((s) => !s)} className="flex items-center gap-1.5 text-xs text-accent transition hover:brightness-110"><Icon.Github className="h-3.5 w-3.5" /> Connect GitHub</button>
        )}
      </div>

      {gh?.connected ? (
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><Icon.Search className="h-4 w-4" /></span>
          <input
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); onRepo(''); }}
            placeholder={repos ? 'Search your repositories…' : 'Loading repositories…'}
            className="field pl-9 font-mono text-[0.8rem]"
          />
          {open && filtered.length > 0 && (
            <div className="animate-rise surface-solid absolute z-30 mt-1.5 max-h-64 w-full overflow-auto p-1.5">
              {filtered.map((r) => (
                <button key={r.full_name} onClick={() => pick(r)} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:surface-2">
                  <Icon.Github className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[0.8rem] text-primary">{r.full_name}</span>
                    <span className="block text-[0.7rem] text-muted">updated {timeAgo(r.pushed_at)}</span>
                  </span>
                  {r.private && <span className="flex shrink-0 items-center gap-1 rounded-md bg-warning/[0.14] px-1.5 py-0.5 text-[0.65rem] font-medium text-warning"><Icon.Lock className="h-3 w-3" /> private</span>}
                  {value === r.clone_url && <Icon.Check className="h-4 w-4 shrink-0 text-accent" />}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"><Icon.GitBranch className="h-4 w-4" /></span>
            <input value={value} onChange={(e) => onRepo(e.target.value)} placeholder="github.com/you/repo" className="field pl-9 font-mono text-[0.8rem]" />
          </div>
          {showConnect && (
            <div className="animate-rise mt-1 flex flex-col gap-2 rounded-xl border border-border bg-bg p-3">
              <span className="text-xs text-muted">Paste a GitHub token (repo scope) to deploy private repos and pick from a list.{' '}
                <a href="https://github.com/settings/tokens/new?scopes=repo&description=JustDeploy" target="_blank" rel="noreferrer" className="text-accent hover:underline">Create one ↗</a>
              </span>
              <div className="flex gap-2">
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()} placeholder="ghp_…" className="field font-mono text-[0.8rem]" />
                <button onClick={connect} disabled={busy || !token.trim()} className="shrink-0 rounded-xl bg-accent px-3.5 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-50">{busy ? '…' : 'Connect'}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
