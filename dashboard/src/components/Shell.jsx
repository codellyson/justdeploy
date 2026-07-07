import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ThemeMenu } from './ThemeMenu';
import { Icon } from './icons';

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
              onClick={() => navigate('/new')}
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
        <Outlet context={{ openNew: () => navigate('/new') }} />
      </main>
    </div>
  );
}
