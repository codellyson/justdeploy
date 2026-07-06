import { useState } from 'react';
import { Modal, Button, Field } from '@codellyson/justui/react';
import { api } from '../api';
import { invalidate } from '../lib/store';
import { toast } from './toast';
import { TypeIcon } from './icons';
import { cx, typeLabel } from '../lib/format';

const TYPES = ['react', 'vite', 'static', 'adonis', 'nextjs', 'postgres', 'sqlite'];
const PROXY = ['adonis', 'nextjs'];
const needsRepoDomain = (t) => t && !['postgres', 'sqlite'].includes(t);

export function NewProject({ open, onClose, onCreated }) {
  const [type, setType] = useState(null);
  const [f, setF] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setType(null); setF({}); setErr(''); setBusy(false); };
  const close = () => { reset(); onClose(); };
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      const body = { type, name: (f.name || '').trim() };
      if (needsRepoDomain(type)) { body.repo = (f.repo || '').trim(); body.domain = (f.domain || '').trim(); }
      if (PROXY.includes(type)) { body.release = (f.release || '').trim(); body.persist = (f.persist || '').trim(); }
      const r = await api.createApp(body);
      invalidate();
      if (r.conn) { navigator.clipboard?.writeText(r.conn); toast('database provisioned · connection copied', 'success'); close(); return; }
      onCreated?.(body.name, !!r.deploying);
      if (!r.deploying) toast(`created ${body.name}`, 'success');
      reset();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} title="New project" description="Pick a type — that decides how it builds and runs." className="w-full max-w-lg">
      <div className="mt-1 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {TYPES.map((t) => (
          <button
            key={t}
            onClick={() => { setType(t); setErr(''); }}
            className={cx(
              'flex flex-col items-center gap-2 rounded-lg border px-2 py-3 transition',
              type === t ? 'border-accent bg-accent/10 text-primary' : 'border-border bg-bg-secondary/50 text-secondary hover:border-accent/60',
            )}
          >
            <TypeIcon type={t} className="h-5 w-5" />
            <span className="text-xs">{typeLabel(t)}</span>
          </button>
        ))}
      </div>

      {type && (
        <div className="mt-5 flex flex-col gap-4">
          <Field label="Name" placeholder="my-app" value={f.name || ''} onChange={set('name')} autoFocus />
          {needsRepoDomain(type) && (
            <>
              <Field label="Git repository" placeholder="https://github.com/you/app.git" value={f.repo || ''} onChange={set('repo')} />
              <Field label="Domain" placeholder="app.example.com" value={f.domain || ''} onChange={set('domain')} />
            </>
          )}
          {PROXY.includes(type) && (
            <>
              <Field label="Release command" hint="runs after build, before start — e.g. migrations" placeholder="node ace migration:run --force" value={f.release || ''} onChange={set('release')} />
              <Field label="Persist dirs" hint="comma-separated, kept across deploys" placeholder="tmp" value={f.persist || ''} onChange={set('persist')} />
            </>
          )}
          {type === 'postgres' && <p className="text-sm text-muted">Provisions a Postgres container on the private network and copies a connection string.</p>}
          {type === 'sqlite' && <p className="text-sm text-muted">Reserves a persistent <span className="font-mono">data/</span> path for a SQLite file.</p>}
        </div>
      )}

      {err && <p className="mt-3 text-sm text-danger">{err}</p>}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!type || busy} onClick={submit}>{busy ? 'Working…' : 'Create'}</Button>
      </div>
    </Modal>
  );
}
