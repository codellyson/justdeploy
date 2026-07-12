import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { invalidate } from '../lib/store';
import { toast } from './toast';
import { ThemeMenu } from './ThemeMenu';
import { Icon } from './icons';

// Small modal to spin up a project (a group of services). Creating one lands you on its canvas,
// where you add the actual services.
function NewProjectModal({ onClose }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const create = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.createProject(name.trim());
      invalidate();
      toast(`project ${r.name} created`, 'success');
      onClose();
      navigate(`/projects/${r.name}`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="surface w-full max-w-sm p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent/[0.12] text-accent"><Icon.Canvas className="h-4 w-4" /></span>
          <h2 className="text-lg font-semibold tracking-tight">New project</h2>
        </div>
        <p className="mb-4 text-sm text-muted">A project groups related services (apps + databases) on one canvas. You’ll add services next.</p>
        <label className="label-tiny">Project name</label>
        <input
          ref={inputRef} value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) create(); }}
          placeholder="e.g. shop" className="field mt-1.5"
        />
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-medium transition hover:border-muted/50">Cancel</button>
          <button onClick={create} disabled={!name.trim() || busy} className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-50">
            {busy ? <span className="spin h-4 w-4 rounded-full border-2 border-[rgb(var(--accent-text))]/40 border-t-[rgb(var(--accent-text))]" /> : <Icon.Plus className="h-4 w-4" />}
            Create project
          </button>
        </div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="group flex items-center gap-2.5">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-[rgb(var(--accent-text))] shadow-sm shadow-accent/25 transition group-hover:scale-105">
        <Icon.Zap className="h-4 w-4" />
      </span>
      <span className="text-[0.95rem] font-semibold tracking-tight">JustDeploy</span>
    </Link>
  );
}

export function Shell({ onSignedOut }) {
  const navigate = useNavigate();
  const [newProj, setNewProj] = useState(false);

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut?.();
    navigate('/');
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Brand />
          <div className="ml-auto flex items-center gap-2">
            <a
              href="https://justdeploy.kreativekorna.com"
              target="_blank"
              rel="noreferrer"
              className="hidden items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted transition hover:text-primary sm:flex"
            >
              <Icon.FileCode className="h-4 w-4" />
              Docs
              <Icon.ExternalLink className="h-3 w-3 opacity-60" />
            </a>
            <button
              onClick={() => navigate('/canvas')}
              title="Canvas"
              className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-bg-secondary hover:text-primary"
            >
              <Icon.Canvas className="h-[1.05rem] w-[1.05rem]" />
            </button>
            <ThemeMenu />
            <button
              onClick={() => navigate('/settings')}
              title="Settings"
              className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-bg-secondary hover:text-primary"
            >
              <Icon.Settings className="h-[1.05rem] w-[1.05rem]" />
            </button>
            <button
              onClick={() => setNewProj(true)}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06]"
            >
              <Icon.Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Project</span>
              <span className="sm:hidden">New</span>
            </button>
            <button
              onClick={signOut}
              title="Sign out"
              className="group relative grid h-9 w-9 place-items-center rounded-full text-[rgb(var(--accent-text))] transition hover:brightness-105"
              style={{ background: 'linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-hover)))' }}
            >
              <Icon.LogOut className="h-[0.9rem] w-[0.9rem] opacity-0 transition group-hover:opacity-100" />
              <span className="absolute text-xs font-semibold transition group-hover:opacity-0">A</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet context={{ openNew: () => navigate('/new'), newProject: () => setNewProj(true) }} />
      </main>

      {newProj && <NewProjectModal onClose={() => setNewProj(false)} />}
    </div>
  );
}
