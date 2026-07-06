// JustDeploy dashboard SPA — vanilla JS. Themed with @codellyson/justui tokens.
import { BUILT_IN_THEMES, VAR_MAP } from '/justui/theme-plugins.js';

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const KEY = 'justdeploy';
const esc = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const PROXY_TYPES = ['adonis', 'nextjs'];

const TYPE_META = {
  react:   { glyph: '⚛',  label: 'React' },
  vite:    { glyph: '⚡', label: 'Vite' },
  static:  { glyph: '📄', label: 'Static' },
  adonis:  { glyph: '🔺', label: 'AdonisJS' },
  nextjs:  { glyph: '▲',  label: 'Next.js' },
  postgres:{ glyph: '🐘', label: 'Postgres' },
  sqlite:  { glyph: '🗃', label: 'SQLite' },
};

// --- api --------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// --- theme (justui) ---------------------------------------------------------
function applyTheme(id, mode) {
  const theme = BUILT_IN_THEMES.find((t) => t.id === id);
  if (!theme) return;
  const variant = theme[mode] || theme.dark;
  const root = document.documentElement;
  for (const k of Object.keys(VAR_MAP)) if (variant[k]) root.style.setProperty(VAR_MAP[k], variant[k]);
  root.classList.toggle('dark', mode === 'dark');
  localStorage.setItem(`${KEY}.theme.id`, id);
  localStorage.setItem(`${KEY}.theme.mode`, mode);
}
const curTheme = () => localStorage.getItem(`${KEY}.theme.id`) || 'espresso';
// Reflect what bootTheme actually applied (it may derive mode from system preference and
// not persist it), so the picker's toggle label + swatches match on first open.
const curMode = () => localStorage.getItem(`${KEY}.theme.mode`)
  || (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

function themeMenu() {
  const wrap = document.createElement('div');
  wrap.className = 'menu';
  wrap.innerHTML = `<button class="ghost" id="themeBtn" title="Theme">🎨</button>`;
  const btn = $('#themeBtn', wrap);
  let panel = null;
  btn.onclick = () => {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement('div');
    panel.className = 'menu-panel';
    const mode = curMode();
    panel.innerHTML =
      `<div class="theme-row" data-mode><span>${mode === 'dark' ? '🌙' : '☀️'}</span> Toggle ${mode === 'dark' ? 'light' : 'dark'}</div>` +
      `<hr style="border:none;border-top:1px solid rgb(var(--border));margin:.4rem 0">` +
      BUILT_IN_THEMES.map((t) =>
        `<div class="theme-row ${t.id === curTheme() ? 'active' : ''}" data-theme="${t.id}">
           <span class="swatch" style="background:${t.swatch[curMode()]}"></span>${t.label}</div>`).join('');
    panel.querySelector('[data-mode]').onclick = () => { applyTheme(curTheme(), curMode() === 'dark' ? 'light' : 'dark'); panel.remove(); panel = null; };
    panel.querySelectorAll('[data-theme]').forEach((el) => {
      el.onclick = () => { applyTheme(el.dataset.theme, curMode()); panel.remove(); panel = null; };
    });
    wrap.appendChild(panel);
  };
  return wrap;
}

// --- views ------------------------------------------------------------------
async function boot() {
  const s = await api('/session');
  if (!s.authed) return renderLogin(s.needsSetup);
  renderDashboard();
}

function renderLogin(needsSetup) {
  app.dataset.view = 'login';
  app.innerHTML = `
    <div class="center">
      <div class="modal" style="max-width:360px">
        <h2><span class="brand"><span>Just</span>Deploy</span></h2>
        ${needsSetup
          ? `<p class="muted">No admin password set yet. Run <code>justdeploy dashboard install</code> on the server to set one.</p>`
          : `<div class="field"><label>Password</label><input type="password" id="pw" autofocus></div>
             <button class="primary" id="login" style="width:100%">Sign in</button>
             <div class="err" id="loginErr" hidden></div>`}
      </div>
    </div>`;
  if (needsSetup) return;
  const submit = async () => {
    try { await api('/login', { method: 'POST', body: { password: $('#pw').value } }); renderDashboard(); }
    catch (e) { const el = $('#loginErr'); el.textContent = e.message; el.hidden = false; }
  };
  $('#login').onclick = submit;
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

let pollTimer = null;
async function renderDashboard() {
  app.dataset.view = 'dashboard';
  app.innerHTML = `
    <div class="topbar">
      <div class="brand"><span>Just</span>Deploy</div>
      <div class="spacer"></div>
      <div id="themeSlot"></div>
      <button class="primary" id="newBtn">+ New Project</button>
      <button class="ghost" id="logout" title="Sign out">⎋</button>
    </div>
    <div class="wrap" id="content"><div class="muted">loading…</div></div>`;
  $('#themeSlot').appendChild(themeMenu());
  $('#newBtn').onclick = newProjectModal;
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); boot(); };
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 3000);
}

async function refresh() {
  if (app.dataset.view !== 'dashboard') return clearInterval(pollTimer);
  let state;
  try { state = await api('/state'); } catch { return boot(); }
  const c = $('#content');
  const apps = state.apps.filter((a) => a.serve !== 'resource');
  c.innerHTML =
    (apps.length ? `<div class="grid">${apps.map(appCard).join('')}</div>`
                 : `<div class="muted center" style="min-height:40vh">No projects yet. Hit <b>+ New Project</b>.</div>`) +
    (state.resources.length
      ? `<div class="section-title">Databases</div><div class="grid">${state.resources.map(resCard).join('')}</div>` : '');
  wireCards(state);
}

function statusDot(a) {
  if (a.deploying) return '<span class="dot busy"></span>';
  if (!a.lastDeploy) return '<span class="dot idle"></span>';
  if (a.lastDeploy.status === 'failed') return '<span class="dot fail"></span>';
  if (a.lastDeploy.status === 'running') return '<span class="dot busy"></span>';
  return '<span class="dot ok"></span>';
}

function appCard(a) {
  const m = TYPE_META[a.type] || { glyph: '📦', label: a.type };
  const dep = a.lastDeploy;
  return `<div class="card" data-app="${a.name}">
    <div class="card-head">${statusDot(a)}<span class="card-name">${a.name}</span>
      <span class="spacer"></span><span class="badge">${m.glyph} ${m.label}</span></div>
    <div class="card-meta">
      ${a.domain ? `<div><a href="https://${a.domain}" target="_blank">${a.domain} ↗</a></div>` : ''}
      ${a.serve === 'proxy' ? `<div class="mono muted">:${a.live_port ?? '—'} · pid ${a.live_pid ?? '—'}</div>` : ''}
      <div class="muted">${a.deploying ? 'deploying…' : dep ? `${dep.status}${dep.sha ? ' · ' + dep.sha.slice(0, 7) : ''}` : 'never deployed'}</div>
      ${dep && dep.status === 'failed' && dep.reason ? `
        <div class="why"><b>${esc(dep.reason)}</b>${dep.hint ? `<div class="hint">${esc(dep.hint).replace(/&lt;app&gt;/g, a.name).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>` : ''}</div>` : ''}
    </div>
    <div class="card-actions">
      ${a.serve === 'file' ? '' : `<button class="sm" data-act="deploy">Deploy</button>`}
      <button class="sm" data-act="logs">Logs</button>
      <button class="sm" data-act="env">Env</button>
      ${a.serve === 'proxy' ? `<button class="sm" data-act="config">Config</button>` : ''}
      ${a.rollbackTo ? `<button class="sm" data-act="rollback" title="Redeploy ${a.rollbackTo.slice(0, 7)}">Rollback</button>` : ''}
      <button class="sm danger" data-act="rm">Delete</button>
    </div></div>`;
}

function resCard(r) {
  return `<div class="card" data-res="${r.name}">
    <div class="card-head"><span class="dot ok"></span><span class="card-name">${r.name}</span>
      <span class="spacer"></span><span class="badge">🐘 Postgres</span></div>
    <div class="card-meta"><div class="mono muted" style="word-break:break-all">${(r.conn || '').replace(/:[^:@/]+@/, ':••••@')}</div></div>
    <div class="card-actions">
      <button class="sm" data-act="copy">Copy URL</button>
      <button class="sm danger" data-act="rm">Delete</button>
    </div></div>`;
}

function wireCards(state) {
  document.querySelectorAll('[data-app]').forEach((card) => {
    const appObj = state.apps.find((a) => a.name === card.dataset.app);
    card.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => cardAction(appObj, b.dataset.act));
  });
  document.querySelectorAll('[data-res]').forEach((card) => {
    const name = card.dataset.res;
    const res = state.resources.find((r) => r.name === name);
    card.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
      if (b.dataset.act === 'copy') { navigator.clipboard.writeText(res.conn); toast('connection string copied'); }
      else if (b.dataset.act === 'rm' && confirm(`Delete database ${name} and its data?`)) {
        await api(`/resources/${name}`, { method: 'DELETE' }); toast('database removed'); refresh();
      }
    });
  });
}

async function cardAction(a, act) {
  const name = a.name;
  if (act === 'deploy') { await api(`/apps/${name}/deploy`, { method: 'POST' }); toast(`deploying ${name}`); logsModal(name); refresh(); }
  else if (act === 'rm') { if (confirm(`Delete ${name}? This removes its files and stops it.`)) { await api(`/apps/${name}`, { method: 'DELETE' }); toast(`${name} removed`); refresh(); } }
  else if (act === 'logs') logsModal(name);
  else if (act === 'env') envModal(name);
  else if (act === 'config') configModal(a);
  else if (act === 'rollback') {
    if (confirm(`Roll back ${name} to ${a.rollbackTo.slice(0, 7)}? This redeploys that commit.`)) {
      const r = await api(`/apps/${name}/rollback`, { method: 'POST' });
      toast(`rolling back to ${r.sha.slice(0, 7)}`); logsModal(name); refresh();
    }
  }
}

function configModal(a) {
  const o = modal(`<h2>Config · ${a.name}</h2>
    <div class="field"><label>Release command — runs after build, before the server starts</label>
      <input id="cfgRelease" value="${esc(a.release_cmd)}" placeholder="node ace migration:run"></div>
    <div class="field"><label>Persist dirs — comma-separated, symlinked to data/ so they survive deploys</label>
      <input id="cfgPersist" value="${esc(a.persist)}" placeholder="tmp"></div>
    <div class="err" id="cfgErr" hidden></div>
    <div class="modal-actions"><button class="ghost" id="cfgCancel">Cancel</button><button class="primary" id="cfgSave">Save</button></div>`);
  $('#cfgCancel', o).onclick = () => o.remove();
  $('#cfgSave', o).onclick = async () => {
    try {
      await api(`/apps/${a.name}/config`, { method: 'PUT', body: {
        release: $('#cfgRelease', o).value.trim(), persist: $('#cfgPersist', o).value.trim(),
      } });
      o.remove(); toast('config saved — redeploy to apply'); refresh();
    } catch (e) { const el = $('#cfgErr', o); el.textContent = e.message; el.hidden = false; }
  };
}

// --- modals -----------------------------------------------------------------
function modal(inner) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal">${inner}</div>`;
  o.onclick = (e) => { if (e.target === o) o.remove(); };
  document.body.appendChild(o);
  return o;
}

function newProjectModal() {
  let sel = null;
  const o = modal(`
    <h2>New Project</h2>
    <div class="types">${Object.entries(TYPE_META).map(([id, m]) =>
      `<div class="type" data-type="${id}"><div class="glyph">${m.glyph}</div><div class="lbl">${m.label}</div></div>`).join('')}</div>
    <div id="npFields"></div>
    <div class="err" id="npErr" hidden></div>
    <div class="modal-actions"><button class="ghost" id="npCancel">Cancel</button><button class="primary" id="npGo" disabled>Create</button></div>`);
  const fields = $('#npFields', o), go = $('#npGo', o);
  o.querySelectorAll('.type').forEach((t) => t.onclick = () => {
    o.querySelectorAll('.type').forEach((x) => x.classList.remove('sel'));
    t.classList.add('sel'); sel = t.dataset.type; go.disabled = false;
    const needsRepoDomain = !['postgres', 'sqlite'].includes(sel);
    fields.innerHTML =
      `<div class="field"><label>Name</label><input id="npName" placeholder="my-app"></div>` +
      (needsRepoDomain
        ? `<div class="field"><label>Git repository</label><input id="npRepo" placeholder="https://github.com/you/app.git"></div>
           <div class="field"><label>Domain</label><input id="npDomain" placeholder="app.example.com"></div>`
          + (PROXY_TYPES.includes(sel)
            ? `<div class="field"><label>Release command (optional — runs after build)</label><input id="npRelease" placeholder="node ace migration:run"></div>
               <div class="field"><label>Persist dirs (optional, comma-sep — kept across deploys)</label><input id="npPersist" placeholder="tmp"></div>` : '')
        : sel === 'postgres' ? `<p class="muted">Provisions a Postgres container on the private network and returns a connection string.</p>` : `<p class="muted">Reserves a persistent data/ path for a SQLite file.</p>`);
  });
  $('#npCancel', o).onclick = () => o.remove();
  go.onclick = async () => {
    const body = { type: sel, name: $('#npName', o)?.value?.trim() };
    if ($('#npRepo', o)) body.repo = $('#npRepo', o).value.trim();
    if ($('#npDomain', o)) body.domain = $('#npDomain', o).value.trim();
    if ($('#npRelease', o)) body.release = $('#npRelease', o).value.trim();
    if ($('#npPersist', o)) body.persist = $('#npPersist', o).value.trim();
    try {
      const r = await api('/apps', { method: 'POST', body });
      o.remove();
      toast(r.conn ? 'database provisioned' : r.deploying ? `deploying ${body.name}…` : `created ${body.name}`);
      if (r.conn) { navigator.clipboard?.writeText(r.conn); toast('connection string copied'); }
      if (r.deploying) logsModal(body.name); // watch the first build stream in
      refresh();
    } catch (e) { const el = $('#npErr', o); el.textContent = e.message; el.hidden = false; }
  };
}

function logsModal(name) {
  const o = modal(`<h2>Logs · ${name} <span class="live" id="liveDot">● live</span></h2>
    <pre class="log" id="logBox"></pre>
    <div class="modal-actions"><button class="ghost" id="logClose">Close</button></div>`);
  const box = $('#logBox', o);
  const es = new EventSource(`/api/apps/${name}/stream`);
  es.onmessage = (e) => {
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.textContent += e.data;                 // chunk already carries its own newlines
    if (atBottom) box.scrollTop = box.scrollHeight;
  };
  const dot = $('#liveDot', o);
  es.onopen = () => { dot.textContent = '● live'; dot.classList.remove('off'); };
  es.onerror = () => { dot.textContent = '● reconnecting'; dot.classList.add('off'); };
  $('#logClose', o).onclick = () => { es.close(); o.remove(); };
}

async function envModal(name) {
  const { env } = await api(`/apps/${name}/env`);
  const rows = Object.entries(env);
  const rowHtml = (k = '', v = '') => `<div class="env-row"><input placeholder="KEY" value="${k}"><input placeholder="value" value="${v}"></div>`;
  const o = modal(`<h2>Environment · ${name}</h2>
    <div id="envRows">${rows.map(([k, v]) => rowHtml(k, v)).join('') || rowHtml()}</div>
    <button class="sm ghost" id="envAdd">+ Add variable</button>
    <div class="err" id="envErr" hidden></div>
    <div class="modal-actions"><button class="ghost" id="envCancel">Cancel</button><button class="primary" id="envSave">Save</button></div>`);
  $('#envAdd', o).onclick = () => $('#envRows', o).insertAdjacentHTML('beforeend', rowHtml());
  $('#envCancel', o).onclick = () => o.remove();
  $('#envSave', o).onclick = async () => {
    const out = {};
    $('#envRows', o).querySelectorAll('.env-row').forEach((r) => {
      const [k, v] = r.querySelectorAll('input'); if (k.value.trim()) out[k.value.trim()] = v.value;
    });
    try { await api(`/apps/${name}/env`, { method: 'PUT', body: { env: out } }); o.remove(); toast('env saved — redeploy to apply'); }
    catch (e) { const el = $('#envErr', o); el.textContent = e.message; el.hidden = false; }
  };
}

boot();
