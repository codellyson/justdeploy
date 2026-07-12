import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { invalidate } from '../lib/store';
import { toast } from '../components/toast';
import { TypeIcon, Icon } from '../components/icons';
import { GithubSource } from '../components/GithubSource';
import { cx, typeLabel, slug, suggestName, nameFromRepo, releaseHint, persistHint } from '../lib/format';

const TYPES = ['react', 'vite', 'static', 'adonis', 'nextjs', 'postgres'];
const PROXY = ['adonis', 'nextjs'];
const needsRepoDomain = (t) => t && t !== 'postgres';

function StepDot({ n, active }) {
  return (
    <span className={cx('grid h-6 w-6 place-items-center rounded-full font-mono text-xs font-semibold', active ? 'bg-accent text-[rgb(var(--accent-text))]' : 'surface-2 text-secondary')}>{n}</span>
  );
}

export function NewProject() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const presetProject = params.get('project') || ''; // set when adding a service to a project
  const [type, setType] = useState(null);
  const [f, setF] = useState({});
  const [touched, setTouched] = useState({ name: false, domain: false, release: false });
  const [baseDomain, setBaseDomain] = useState('');
  const [typePresets, setTypePresets] = useState([]);
  const [detected, setDetected] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  // Auto-generate a project name on open, and learn the base domain + type presets.
  useEffect(() => {
    setF((s) => ({ ...s, name: s.name || suggestName() }));
    api.state().then((st) => { setBaseDomain(st.baseDomain || ''); setTypePresets(st.types || []); }).catch(() => {});
  }, []);

  // Keep the domain suggested as `{name}.{base}` until the user edits it themselves.
  useEffect(() => {
    if (!touched.domain && f.name && baseDomain) setF((s) => ({ ...s, domain: `${slug(f.name)}.${baseDomain}` }));
  }, [f.name, baseDomain, touched.domain]);

  // Pre-fill the release command from the type's preset (Adonis → migrations) until the user edits it.
  useEffect(() => {
    if (touched.release || !type) return;
    const preset = typePresets.find((t) => t.id === type);
    setF((s) => ({ ...s, release: preset?.release || '' }));
  }, [type, typePresets, touched.release]);

  const onName = (e) => { setTouched((t) => ({ ...t, name: true })); setF((s) => ({ ...s, name: e.target.value })); };
  const onDomain = (e) => { setTouched((t) => ({ ...t, domain: true })); setF((s) => ({ ...s, domain: e.target.value })); };
  const setRepo = (repo) => setF((s) => {
    const next = { ...s, repo };
    if (!touched.name) { const n = nameFromRepo(repo); if (n) next.name = n; }
    return next;
  });
  // On picking a repo, detect its framework and match the right type to it.
  const onPickRepo = async (repo) => {
    setDetected(null);
    try { const d = await api.githubDetect(repo.full_name); if (d.type) { setType(d.type); setDetected(d); } }
    catch { /* leave the current type */ }
  };

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      const proj = (f.project ?? presetProject).trim();
      const body = { type, name: (f.name || '').trim(), project: proj };
      if (needsRepoDomain(type)) { body.repo = (f.repo || '').trim(); body.domain = (f.domain || '').trim(); }
      if (PROXY.includes(type)) { body.release = (f.release || '').trim(); body.persist = (f.persist || '').trim(); }
      const back = proj && proj !== 'default' ? `/projects/${proj}` : '/';
      const r = await api.createApp(body);
      invalidate();
      if (r.conn) { navigator.clipboard?.writeText(r.conn); toast('database provisioned · connection copied', 'success'); navigate(back); return; }
      if (r.deploying) { toast(`deploying ${body.name}…`); navigate(`/projects/${proj || 'default'}/${body.name}`, { state: { kind: 'app' } }); return; }
      toast(`created ${body.name}`, 'success');
      navigate(back);
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const cta = needsRepoDomain(type) ? `Deploy ${type ? typeLabel(type) : ''}` : `Create ${type ? typeLabel(type) : ''}`;

  return (
    <div className="animate-rise mx-auto max-w-[760px]">
      <Link to={presetProject ? `/projects/${presetProject}` : '/'} className="mb-5 flex w-fit items-center gap-1.5 text-sm text-muted transition hover:text-primary"><Icon.ArrowLeft className="h-4 w-4" /> {presetProject || 'Overview'}</Link>

      <div className="mb-7 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{presetProject ? <>New service in <span className="text-accent">{presetProject}</span></> : 'Deploy a new service'}</h1>
        <p className="mt-1 text-sm text-muted">Tell me what it is — that's the whole configuration.</p>
      </div>

      {/* step 1 */}
      <div className="mb-3 flex items-center gap-2"><StepDot n={1} active /><span className="text-sm font-semibold">Pick the app type</span></div>
      <div className="mb-8 grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
        {TYPES.map((t) => (
          <button key={t} onClick={() => { setType(t); setDetected(null); setErr(''); }} className={cx('relative flex flex-col items-center gap-2 rounded-2xl border px-2 py-4 transition', type === t ? 'border-accent bg-accent/[0.1] text-primary' : 'border-border bg-bg-secondary text-secondary hover:border-accent/50')}>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-bg"><TypeIcon type={t} className="h-5 w-5" /></span>
            <span className="text-xs font-medium">{typeLabel(t)}</span>
            {type === t && <Icon.Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent" />}
          </button>
        ))}
      </div>
      {detected?.type && (
        <div className="-mt-6 mb-8 flex items-center gap-1.5 text-xs text-accent">
          <Icon.Check className="h-3.5 w-3.5" /> Auto-detected <b className="font-semibold">{typeLabel(detected.type)}</b> from your repo — {detected.reason}
        </div>
      )}

      {/* step 2 */}
      <div className={cx('transition-opacity duration-300', type ? 'opacity-100' : 'pointer-events-none opacity-40')}>
        <div className="mb-3.5 flex items-center gap-2"><StepDot n={2} active={!!type} /><span className="text-sm font-semibold">Name it &amp; point at your code</span></div>
        <div className="surface flex flex-col gap-4 p-5">
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-1 basis-52 flex-col gap-1.5">
              <label className="label-tiny">Service name</label>
              <input value={f.name || ''} onChange={onName} placeholder="my-new-app" className="field" />
            </div>
            <div className="flex flex-1 basis-52 flex-col gap-1.5">
              <label className="label-tiny">Project {presetProject ? '' : <span className="font-normal normal-case tracking-normal text-muted/70">— groups related services</span>}</label>
              <input value={f.project ?? presetProject} onChange={set('project')} placeholder="default" className="field" />
            </div>
          </div>

          {needsRepoDomain(type) && (
            <>
              <GithubSource value={f.repo || ''} onRepo={setRepo} onPick={onPickRepo} />
              <div className="flex flex-col gap-1.5">
                <label className="label-tiny">Domain <span className="font-normal normal-case tracking-normal text-muted/70">— auto-generated, edit if you like</span></label>
                <input value={f.domain || ''} onChange={onDomain} placeholder="app.example.com" className="field font-mono text-[0.8rem]" />
              </div>
              {f.domain && (
                <div className="flex items-center gap-2 rounded-xl border border-border bg-bg px-3 py-2.5">
                  <Icon.Globe className="h-4 w-4 shrink-0 text-muted" />
                  <span className="text-xs text-muted">Will be live at</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-accent">{f.domain}</span>
                </div>
              )}
            </>
          )}

          {PROXY.includes(type) && (
            <div className="flex flex-wrap gap-4">
              <div className="flex flex-1 basis-52 flex-col gap-1.5"><label className="label-tiny">Release command {f.release ? <span className="font-normal normal-case tracking-normal text-muted/70">— preset for this type, edit if you like</span> : <span className="font-normal normal-case tracking-normal text-muted/70">— optional</span>}</label><input value={f.release || ''} onChange={(e) => { setTouched((t) => ({ ...t, release: true })); setF((s) => ({ ...s, release: e.target.value })); }} placeholder={releaseHint(type)} className="field font-mono text-[0.8rem]" /></div>
              <div className="flex flex-1 basis-52 flex-col gap-1.5"><label className="label-tiny">Persist dirs (optional)</label><input value={f.persist || ''} onChange={set('persist')} placeholder={persistHint(type)} className="field font-mono text-[0.8rem]" /></div>
            </div>
          )}
          {type === 'postgres' && <p className="text-sm text-muted">Provisions a Postgres container and hands out a connection string.</p>}

          {err && <p className="text-sm text-danger">{err}</p>}

          <button onClick={submit} disabled={!type || busy} className="flex items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-semibold text-[rgb(var(--accent-text))] transition hover:brightness-[1.06] disabled:opacity-50">
            {busy ? <span className="spin h-4 w-4 rounded-full border-2 border-[rgb(var(--accent-text))]/40 border-t-[rgb(var(--accent-text))]" /> : <Icon.Zap className="h-4 w-4" />}
            {busy ? 'Working…' : cta.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
