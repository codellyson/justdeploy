import { useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ThemeMenu } from './ThemeMenu';
import { NewProject } from './NewProject';
import { toast } from './toast';
import { Icon } from './icons';

function Brand() {
  return (
    <Link to="/" className="group flex items-center gap-2.5">
      <span className="grid h-7 w-7 place-items-center rounded-md bg-accent font-mono text-sm font-bold text-[rgb(var(--accent-text))] transition group-hover:scale-105">
        J
      </span>
      <span className="text-[0.95rem] font-semibold tracking-tight">
        Just<span className="text-muted">Deploy</span>
      </span>
    </Link>
  );
}

export function Shell({ onSignedOut }) {
  const [newOpen, setNewOpen] = useState(false);
  const navigate = useNavigate();

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
            <ThemeMenu />
            <button
              onClick={() => setNewOpen(true)}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-[rgb(var(--accent-text))] transition hover:bg-accent-hover"
            >
              <Icon.Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Project</span>
              <span className="sm:hidden">New</span>
            </button>
            <button
              onClick={signOut}
              title="Sign out"
              className="grid h-9 w-9 place-items-center rounded-lg border border-border text-secondary transition hover:border-danger hover:text-danger"
            >
              <Icon.LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet context={{ openNew: () => setNewOpen(true) }} />
      </main>

      <NewProject open={newOpen} onClose={() => setNewOpen(false)} onCreated={(name, deployed) => {
        setNewOpen(false);
        if (deployed) { toast(`deploying ${name}…`); navigate(`/apps/${name}`); }
      }} />
    </div>
  );
}
