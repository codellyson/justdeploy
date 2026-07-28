import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { invalidate } from '../lib/store';
import { toast } from './toast';
import { ThemeMenu } from './ThemeMenu';
import { Icon } from './icons';
import { cx } from '../lib/format';

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

function NavItem({ to, end, icon: Ico, children }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cx(
        'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
        isActive ? 'bg-bg-secondary text-primary' : 'text-muted hover:bg-bg-secondary/60 hover:text-primary',
      )}
    >
      <Ico className="h-[1.05rem] w-[1.05rem]" />
      {children}
    </NavLink>
  );
}

export function Shell({ user, onSignedOut }) {
  const navigate = useNavigate();
  const [newProj, setNewProj] = useState(false);
  const initial = (user?.username || 'A').charAt(0).toUpperCase();

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut?.();
    navigate('/');
  };

  return (
    <div className="min-h-dvh">
      {/* Left sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-border bg-bg/80 backdrop-blur-xl">
        <div className="flex h-14 items-center px-4"><Brand /></div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2">
          <NavItem to="/" end icon={Icon.Layers}>Projects</NavItem>
          <NavItem to="/canvas" icon={Icon.Canvas}>Canvas</NavItem>
          <NavItem to="/settings" icon={Icon.Settings}>Settings</NavItem>
          <div className="my-2 border-t border-border" />
          <a
            href="https://justdeploy.kreativekorna.com"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted transition hover:text-primary"
          >
            <Icon.FileCode className="h-[1.05rem] w-[1.05rem]" /> Docs <Icon.ExternalLink className="ml-auto h-3 w-3 opacity-60" />
          </a>
          <div className="mt-auto px-1 pt-2"><ThemeMenu /></div>
        </nav>
        {/* User footer */}
        <div className="flex items-center gap-2.5 border-t border-border p-3">
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-[rgb(var(--accent-text))]"
            style={{ background: 'linear-gradient(135deg, rgb(var(--accent)), rgb(var(--accent-hover)))' }}
          >
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user?.username || 'admin'}</div>
            {user?.role && <div className="text-[0.6rem] font-medium uppercase tracking-wide text-muted">{user.role}</div>}
          </div>
          <button onClick={signOut} title="Sign out" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-bg-secondary hover:text-danger">
            <Icon.LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="pl-56">
        <main className="mx-auto max-w-6xl px-6 py-8">
          <Outlet context={{ user, openNew: () => navigate('/new'), newProject: () => setNewProj(true) }} />
        </main>
      </div>

      {newProj && <NewProjectModal onClose={() => setNewProj(false)} />}
    </div>
  );
}
