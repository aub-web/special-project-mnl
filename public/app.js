// Studio Project Manila — single-page frontend. Each route is a function that renders into #view.

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
let view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const php = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('en-CA');
const fmtDate = (iso, opts = { month: 'short', day: 'numeric' }) =>
  iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', opts) : '—';
const weekday = (iso) => fmtDate(iso, { weekday: 'short' });

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500 && !data.error) data.error = data.errorMessage || `Server error (${res.status})`;
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/signup')) {
    showLogin();
    throw new Error('Please sign in');
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- auth ----------
let me = null;
function showLogin() {
  me = null;
  document.body.classList.add('logged-out');
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  view = fresh;
  let mode = location.hash.includes('signup') ? 'signup' : 'signin';
  const draw = (msg = '', kind = 'err') => {
    const up = mode === 'signup';
    view.innerHTML = `
      <form class="card auth" id="auth-form">
        <div class="brand"><span class="name"><span class="dot"></span>Studio Project Manila</span>
          <button type="button" class="icon-btn theme-toggle" aria-label="Switch light/dark mode"></button></div>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" data-mode="signin" class="${up ? '' : 'on'}" aria-selected="${!up}">Sign in</button>
          <button type="button" role="tab" data-mode="signup" class="${up ? 'on' : ''}" aria-selected="${up}">Create account</button>
        </div>
        ${up ? '<label class="f">Full name<input name="name" autocomplete="name" required></label>' : ''}
        <label class="f">Email<input name="email" type="email" autocomplete="${up ? 'email' : 'username'}" required></label>
        <label class="f">Password<input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" ${up ? 'minlength="10"' : ''} required></label>
        ${up ? '<p class="hint">At least 10 characters. New accounts need an admin to approve them before they can sign in.</p>' : ''}
        ${msg ? `<p class="msg ${kind}">${esc(msg)}</p>` : ''}
        <button class="primary" style="justify-content:center">${up ? 'Create account' : 'Sign in'}</button>
      </form>`;
    view.querySelector('input').focus();
  };
  view.addEventListener('click', (e) => {
    const m = e.target.dataset.mode;
    if (m && m !== mode) { mode = m; draw(); }
  });
  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true;
    try {
      if (mode === 'signup') {
        const r = await api('/auth/signup', { method: 'POST', body });
        if (r.pending) { mode = 'signin'; return draw('Account created! An admin needs to approve it — you can sign in once they do.', 'ok'); }
      } else {
        await api('/auth/login', { method: 'POST', body });
      }
      await boot();
    } catch (err) {
      draw(err.message);
      const email = view.querySelector('input[name=email]');
      if (email) email.value = body.email || '';
    } finally { btn.disabled = false; }
  });
  draw();
}
// ---------- roles ----------
// Which pages each role can open (admin: all). The server enforces the same rules.
const ROLE_ROUTES = {
  sdr: ['', 'businesses', 'business', 'settings'],
  set_director: ['log', 'sessions', 'settings'],
  recorder: ['me', 'settings'],
};
const ROLE_HOME = { admin: '', sdr: '', set_director: 'log', recorder: 'me' };
const ROLE_LABEL = { admin: 'Admin', sdr: 'SDR', set_director: 'Set Director', recorder: 'Recorder' };
const canSee = (route) => me?.role === 'admin' ? route !== 'me' : (ROLE_ROUTES[me?.role] || []).includes(route);
const isAdmin = () => me?.role === 'admin';
const showMoney = () => me?.role !== 'set_director';

async function boot() {
  try {
    me = await api('/auth/me');
  } catch (e) {
    // 401 already showed the sign-in screen; anything else means the server itself is unhappy.
    if (!me && document.body.classList.contains('logged-out') && !view.querySelector('.auth')) {
      view.innerHTML = `<div class="card auth"><div class="brand"><span class="name"><span class="dot"></span>Studio Project Manila</span></div>
        <p class="msg err">The server isn't responding properly: ${esc(e.message)}</p>
        <p class="hint">If you just deployed, check the Netlify environment variables (DATABASE_URL, SESSION_SECRET) and redeploy.</p>
        <button class="primary" style="justify-content:center" onclick="location.reload()">Try again</button></div>`;
    }
    return;
  }
  document.body.classList.remove('logged-out');
  document.querySelectorAll('#nav a').forEach((a) => { a.hidden = !canSee(a.dataset.route); });
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = ROLE_LABEL[me.role] || me.role;
  cache.recorders = null;
  render();
}

// ---------- theme (light / dark) ----------
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme-toggle')) return;
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('spl-theme', next); } catch {}
});

// ---------- phone menu ----------
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  $('#scrim').hidden = !open;
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}
$('#menu-btn').onclick = () => setMenu(!document.body.classList.contains('menu-open'));
$('#scrim').onclick = () => setMenu(false);
$('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), 2600);
}

/** Open a modal form. fields: [{name,label,type,value,options,full,required}] → resolves with values or null. */
function modal({ title, fields, submit = 'Save', extra = '', onOpen }) {
  const dlg = $('#modal'), form = $('#modal-form');
  const input = (f) => {
    const common = `name="${f.name}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''} ${f.list ? `list="${f.list}"` : ''}`;
    if (f.type === 'select') return `<select ${common}>${f.options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('')}</select>`;
    if (f.type === 'textarea') return `<textarea ${common} rows="3">${esc(f.value)}</textarea>`;
    return `<input type="${f.type || 'text'}" ${common} value="${esc(f.value)}">`;
  };
  const rows = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i], g = fields[i + 1];
    const lab = (x) => `<label class="f">${esc(x.label)}${input(x)}</label>`;
    if (!f.full && g && !g.full) { rows.push(`<div class="row">${lab(f)}${lab(g)}</div>`); i++; }
    else rows.push(lab(f));
  }
  form.innerHTML = `<h2>${esc(title)}</h2>${extra}${rows.join('')}
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">${esc(submit)}</button></div>`;
  dlg.showModal();
  form.querySelector('input,select,textarea')?.focus();
  onOpen?.(form);
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(Object.fromEntries(new FormData(form)));
    };
  });
}

// Shared lookup data used by datalists and selects.
const cache = {};
async function lookups(force = false) {
  if (force || !cache.recorders) {
    // SDRs can't list recorders (they only work with businesses).
    [cache.recorders, cache.locations, cache.settings] = await Promise.all([
      me?.role === 'sdr' ? [] : api('/recorders'), api('/locations'), api('/settings')]);
  }
  let dl = $('#dl-recorders');
  if (!dl) { dl = document.createElement('div'); dl.id = 'dl-wrap'; document.body.append(dl); }
  $('#dl-wrap').innerHTML =
    `<datalist id="dl-recorders">${cache.recorders.map((r) => `<option value="${esc(r.name)}">`).join('')}</datalist>` +
    `<datalist id="dl-locations">${cache.locations.map((l) => `<option value="${esc(l.name)}">`).join('')}</datalist>`;
  return cache;
}
const CATEGORIES = ['Studio', 'Home Shift', 'OT'];

// ---------- routes ----------
const routes = { '': dashboard, log, sessions, periods, period, recorders, locations, followups, settings, users, businesses, business, me: myHours };

async function render() {
  if (!me) return;
  const [route, ...args] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  if (!routes[route] || !canSee(route)) {
    const home = ROLE_HOME[me.role] ?? '';
    if (route !== home) { location.hash = '#/' + home; return; }
  }
  const navRoute = { period: 'periods', business: 'businesses' }[route] ?? route;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === navRoute));
  // Fresh element per page so event listeners from the previous page don't pile up.
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  view = fresh;
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await (routes[route] || dashboard)(...args.map(decodeURIComponent));
  } catch (e) {
    view.innerHTML = `<div class="card empty">Something went wrong: ${esc(e.message)}</div>`;
  }
  refreshBadge();
}
async function refreshBadge() {
  if (!isAdmin()) return;
  const fu = await api('/followups').catch(() => []);
  const n = fu.filter((f) => f.status !== 'Resolved').length;
  const b = $('#fu-badge');
  b.hidden = !n; b.textContent = n;
  if (me?.role === 'admin') {
    const p = (await api('/users/pending-count').catch(() => ({ n: 0 }))).n;
    const ub = $('#users-badge');
    ub.hidden = !p; ub.textContent = p;
    const n = (await api('/registrations/pending-count').catch(() => ({ n: 0 }))).n;
    const rb = $('#rec-badge');
    rb.hidden = !n; rb.textContent = n;
  }
}
window.addEventListener('hashchange', render);

// ---------- Dashboard ----------
/** Show only the last 4 digits; the full number is one click away. */
const maskAcct = (n) => (n ? `<button class="ghost acct" data-acct="${esc(n)}" title="Click to show full number">•••• ${esc(String(n).slice(-4))}</button>` : '<span class="muted">—</span>');
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-acct]');
  if (b) { e.preventDefault(); e.stopPropagation(); b.textContent = b.dataset.acct; b.removeAttribute('data-acct'); }
  // Links inside a clickable card (e.g. Owner ID on a business card) open on their own, not the card.
  const o = e.target.closest('[data-open]');
  if (o && driveLink(o.dataset.open)) { e.preventDefault(); e.stopPropagation(); window.open(o.dataset.open, '_blank', 'noopener'); }
}, true);

function businessCard(b) {
  const lastActive = [b.last_date, b.last_session].filter(Boolean).sort().at(-1);
  return `<a class="card biz" href="#/business/${b.id}">
    <div class="biz-head"><b>${esc(b.name)}</b>${b.active ? '' : ' <span class="pill">inactive</span>'}${b.status ? ` <span class="pill ${/going/i.test(b.status) ? 'warn' : 'ok'}" style="font-size:11px">${esc(b.status)}</span>` : ''}</div>
    <div class="biz-owner">👤 ${esc(b.owner_name || 'No owner on file')}${b.address ? `<div style="font-size:12px">📍 ${esc(b.address)}</div>` : ''}</div>
    <div class="biz-bank"><span class="pill">${esc(b.bank_name || 'No bank')}</span> ${maskAcct(b.bank_account_no)}
      ${driveLink(b.owner_id_url) ? `<span class="btn ghost id-btn" data-open="${esc(b.owner_id_url)}" title="Owner's ID — opens in Google Drive">🪪 Owner ID</span>` : ''}</div>
    <div class="biz-stats">
      <div><span>Shifts hosted</span><b>${hrs(b.shifts)}</b></div>
      <div><span>Business payout</span><b>${php(b.payout)}</b></div>
      <div><span>Recorder hours</span><b>${hrs(b.recorder_hours)}</b></div>
      <div><span>Recorders</span><b>${b.recorders}</b></div>
    </div>
    <div class="biz-foot muted">${b.location ? `📍 ${esc(b.location)}` : '<span class="pill warn">No location linked</span>'} · last active ${fmtDate(lastActive)}</div>
  </a>`;
}

async function dashboard() {
  const [d, biz] = await Promise.all([api('/dashboard'), api('/businesses')]);
  const t = d.totals, bt = d.bizTotals;
  const weeks = d.byWeek.slice(-10);
  const maxW = Math.max(1, ...weeks.map((w) => w.hours));
  const maxL = Math.max(1, ...d.byLocation.map((l) => l.hours));
  view.innerHTML = `
    <div class="head"><div><h1>Dashboard</h1><p>${fmtDate(t.first_date, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDate(t.last_date, { month: 'short', day: 'numeric', year: 'numeric' })}</p></div>
      ${canSee('log') ? '<a class="btn primary" href="#/log">+ Log hours</a>' : ''}</div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Hours recorded</div><div class="value">${hrs(t.hours)}</div><div class="sub">${t.sessions} sessions</div></div>
      <div class="card kpi"><div class="label">Recorder payout</div><div class="value">${php(t.php)}</div></div>
      <div class="card kpi"><div class="label">Business payout</div><div class="value">${php(bt.payout)}</div><div class="sub">${hrs(bt.shifts)} shifts · ${bt.businesses} businesses</div></div>
      <div class="card kpi"><div class="label">Recorders</div><div class="value">${t.recorders}</div><div class="sub">across ${t.locations} locations</div></div>
      ${isAdmin() ? `<div class="card kpi"><div class="label">Needs attention</div><div class="value">${d.openFollowups}</div>
        <div class="sub"><a href="#/followups">follow-ups</a> · ${d.openPeriods} <a href="#/periods">open period(s)</a></div></div>` : ''}
    </div>
    <div class="section-head"><h2>Businesses ${canSee('businesses') ? '<button class="primary" id="db-add-biz" style="margin-left:8px;padding:4px 10px;font-size:13px">+ Add business</button>' : ''}</h2>
      <span class="muted">${biz.synced_at ? `Synced from Google Sheet ${new Date(biz.synced_at).toLocaleString()}` : 'Not synced yet'} · <a href="#/businesses">Manage</a></span></div>
    ${biz.businesses.length
      ? `<div class="grid biz-grid">${biz.businesses.filter((b) => b.active).map(businessCard).join('')}</div>`
      : `<div class="card empty">No businesses yet. ${me.role === 'admin' ? 'Open <a href="#/businesses">Businesses</a> and press <b>Sync from Google Sheet</b>.' : 'Ask an admin to sync them from the Google Sheet.'}</div>`}
    <div style="height:14px"></div>
    <div class="grid two">
      <div class="card"><h2>Hours per week</h2>
        <div class="chart">${weeks.map((w) => `<div class="col" title="${hrs(w.hours)} h · ${php(w.php)} · ${w.recorders} recorders">
          <span class="v">${hrs(Math.round(w.hours))}</span><div class="b" style="height:${(w.hours / maxW) * 100}%"></div><small>${fmtDate(w.week)}</small></div>`).join('')}</div>
        <div class="muted" style="margin-top:8px;font-size:12px">${d.byCategory.map((c) => `${esc(c.category)}: <b>${hrs(c.hours)} h</b>`).join(' · ')}</div>
      </div>
      <div class="card"><h2>By location</h2><div class="bars">
        ${d.byLocation.map((l) => `<div class="bar-row"><span class="name" title="${esc(l.name)}">${esc(l.name)}</span>
          <div class="bar"><span style="width:${(l.hours / maxL) * 100}%"></span></div><span class="num">${hrs(l.hours)} h</span></div>`).join('')}
      </div></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Top recorders</h2>
      <table><thead><tr><th>Name</th><th class="num">Days</th><th class="num">Hours</th><th class="num">Earned</th></tr></thead><tbody>
      ${d.topRecorders.map((r) => `<tr><td>${canSee('sessions') ? `<a href="#/sessions/${r.id}">${esc(r.name)}</a>` : esc(r.name)}</td><td class="num">${r.days}</td><td class="num">${hrs(r.hours)}</td><td class="num">${php(r.php)}</td></tr>`).join('')}
      </tbody></table></div>`;
  $('#db-add-biz')?.addEventListener('click', addBusiness);
}

// ---------- Log hours (replaces the per-day sheet) ----------
async function log() {
  const { settings: s } = await lookups();
  const state = { rows: Array.from({ length: 6 }, () => ({ recorder: '', hours: '', notes: '' })) };
  view.innerHTML = `
    <div class="head"><div><h1>Log hours</h1><p>One day at one location — like a daily sheet.${showMoney() ? ` Rate ${php(s.rate_php)} per hour.` : ''}</p></div></div>
    <div class="card">
      <div class="toolbar">
        <label class="f">Date<input type="date" id="lg-date" value="${today()}"></label>
        <label class="f" style="flex:1;min-width:220px">Location<input id="lg-loc" list="dl-locations" placeholder="e.g. Bam Bam Chicken"></label>
        <label class="f">Category<select id="lg-cat">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      </div>
      <div class="log-rows" id="lg-rows"></div>
      <div style="margin-top:8px"><button id="lg-add" class="ghost">+ Add row</button></div>
      <div class="sumbar"><span class="muted">Total</span><b id="lg-h">0 h</b>${showMoney() ? '<b id="lg-p">₱0.00</b>' : ''}<button class="primary" id="lg-save">Save day</button></div>
    </div>`;
  const rowsEl = $('#lg-rows');
  const draw = () => {
    rowsEl.innerHTML = `<div class="log-row head-row"><span>Recorder</span><span>Hours</span><span>Notes</span><span></span></div>` +
      state.rows.map((r, i) => `<div class="log-row" data-i="${i}">
        <input data-k="recorder" list="dl-recorders" value="${esc(r.recorder)}" placeholder="Full name">
        <input data-k="hours" type="number" step="0.01" min="0" max="24" value="${esc(r.hours)}">
        <input data-k="notes" value="${esc(r.notes)}">
        <button class="ghost" data-del title="Remove">✕</button></div>`).join('');
    totals();
  };
  const totals = () => {
    const h = state.rows.reduce((a, r) => a + (Number(r.hours) || 0), 0);
    $('#lg-h').textContent = hrs(h) + ' h';
    if (showMoney()) $('#lg-p').textContent = php(h * s.rate_php);
  };
  rowsEl.addEventListener('input', (e) => {
    const i = e.target.closest('.log-row')?.dataset.i;
    if (i == null || !e.target.dataset.k) return;
    state.rows[i][e.target.dataset.k] = e.target.value;
    totals();
  });
  rowsEl.addEventListener('click', (e) => {
    if (!e.target.matches('[data-del]')) return;
    state.rows.splice(e.target.closest('.log-row').dataset.i, 1);
    draw();
  });
  $('#lg-add').onclick = () => { state.rows.push({ recorder: '', hours: '', notes: '' }); draw(); };
  $('#lg-save').onclick = async () => {
    try {
      const r = await api('/sessions/bulk', { method: 'POST', body: {
        date: $('#lg-date').value, location: $('#lg-loc').value, category: $('#lg-cat').value, rows: state.rows,
      } });
      toast(`Saved ${r.inserted} session(s)`);
      await lookups(true);
      location.hash = `#/sessions?from=${$('#lg-date').value}`;
    } catch (e) { toast(e.message, true); }
  };
  draw();
}

/** After add/edit/approve: report whether the recorder sheet was updated (silent when write-back isn't set up). */
function sheetNote(sheet) {
  if (!sheet || sheet.skipped) return '';
  return sheet.ok ? ` · ${sheet.updated ? 'updated' : 'added to'} the recorder sheet (row ${sheet.row})` : '';
}
function sheetWarn(sheet) {
  if (sheet && !sheet.ok && !sheet.skipped) toast(`Saved in the app, but the recorder sheet wasn't updated: ${sheet.error}`, true);
}

// ---------- Hours sheet sync (admins) ----------
// The team still edits hours in the "Studio Payout Summary" sheet; this pulls those edits in.
// Sessions logged in the app are never touched by a sync.
async function hoursSyncBar() {
  if (!isAdmin()) return '';
  const s = cache.settings || (await api('/settings'));
  let auto = null;
  try { auto = JSON.parse(s.payout_auto_status || 'null'); } catch {}
  return `<div class="card sync-bar">
    <div><b>Hours sheet</b> <span class="muted">· Studio Payout Summary · ${s.payout_synced_at ? `last changes pulled ${new Date(s.payout_synced_at).toLocaleString()}` : 'not synced from the app yet'}</span>
      <div style="font-size:12px;margin-top:2px">${auto
        ? `<span class="pill ${auto.ok ? 'ok' : 'warn'}">Auto-sync every 10 min</span> <span class="${auto.ok ? 'muted' : ''}" style="${auto.ok ? '' : 'color:var(--warn)'}">${esc(auto.message)} · checked ${new Date(auto.at).toLocaleTimeString()}</span>`
        : '<span class="muted">Auto-sync every 10 min starts after the next deploy.</span>'}</div></div>
    <div class="head-actions">
      <button id="hs-sync">⟳ Sync from Google Sheet</button>
      <label class="btn" for="hs-file">⬆ Upload .xlsx</label><input type="file" id="hs-file" accept=".xlsx" hidden>
    </div></div>`;
}
function bindHoursSync() {
  const btn = $('#hs-sync'), file = $('#hs-file');
  if (!btn) return;
  const done = async (r) => {
    cache.settings = null;
    const list = (items, cls) => items.length
      ? `<ul class="change-list ${cls}">${items.slice(0, 40).map((x) => `<li>${esc(x)}</li>`).join('')}${items.length > 40 ? `<li class="muted">…and ${items.length - 40} more</li>` : ''}</ul>` : '';
    await modal({ title: 'Hours synced', submit: 'Done', fields: [],
      extra: `<p style="margin:0">${r.sessions} sessions · ${hrs(r.hours)} h from the sheet.</p>
        ${!r.added.length && !r.removed.length ? '<p class="muted" style="margin:0">No changes — the app already matched the sheet.</p>' : ''}
        ${r.added.length ? `<h2 style="margin:6px 0 0">Added or changed (${r.added.length})</h2>${list(r.added, 'add')}` : ''}
        ${r.removed.length ? `<h2 style="margin:6px 0 0">Removed or replaced (${r.removed.length})</h2>${list(r.removed, 'del')}` : ''}` });
    render();
  };
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Syncing…';
    try { await done(await api('/payout/sync', { method: 'POST' })); }
    catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = '⟳ Sync from Google Sheet'; }
  };
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    const b64 = await new Promise((ok, bad) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.onerror = bad; rd.readAsDataURL(f); });
    toast('Uploading…');
    try { await done(await api('/payout/upload', { method: 'POST', body: { file: b64 } })); }
    catch (e) { toast(e.message, true); }
    file.value = '';
  };
}

// ---------- Sessions ----------
async function sessions(recorderId = '') {
  const { recorders: recs, locations: locs } = await lookups();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = { from: params.get('from') || '', to: params.get('to') || '', recorder_id: recorderId, location_id: '', category: '', q: '' };
  view.innerHTML = `
    <div class="head"><div><h1>Sessions</h1><p id="ss-sum" class="muted"></p></div><a class="btn primary" href="#/log">+ Log hours</a></div>
    ${isAdmin() ? await hoursSyncBar() : '<p class="muted" style="margin:-8px 0 12px;font-size:13px">You can edit or delete the sessions you logged.</p>'}
    <div class="toolbar">
      <label class="f">From<input type="date" data-f="from" value="${f.from}"></label>
      <label class="f">To<input type="date" data-f="to" value="${f.to}"></label>
      <label class="f">Recorder<select data-f="recorder_id"><option value="">All</option>${recs.map((r) => `<option value="${r.id}" ${String(r.id) === f.recorder_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <label class="f">Location<select data-f="location_id"><option value="">All</option>${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
      <label class="f">Category<select data-f="category"><option value="">All</option>${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label class="f" style="flex:1;min-width:160px">Search<input data-f="q" placeholder="name, location, notes"></label>
    </div>
    <div class="table-wrap" id="ss-table"></div>`;
  let data = [];
  const load = async () => {
    data = await api('/sessions?' + qs(f));
    const money = showMoney();
    const H = data.reduce((a, s) => a + s.hours, 0);
    const P = money ? data.reduce((a, s) => a + s.php, 0) : 0;
    const editable = (s) => isAdmin() || s.created_by === me.id;
    $('#ss-sum').textContent = `${data.length} sessions · ${hrs(H)} h${money ? ` · ${php(P)}` : ''}`;
    $('#ss-table').innerHTML = data.length ? `<table><thead><tr><th>Date</th><th>Recorder</th><th>Location</th><th>Category</th><th class="num">Hours</th>${money ? '<th class="num">Rate</th><th class="num">PHP</th>' : ''}<th>Notes</th><th></th></tr></thead><tbody>
      ${data.map((s) => `<tr><td>${weekday(s.date)} ${fmtDate(s.date)}</td><td>${esc(s.recorder)}</td><td>${esc(s.location || '—')}</td>
        <td><span class="pill ${s.category === 'Studio' ? 'accent' : s.category === 'OT' ? 'warn' : ''}">${esc(s.category)}</span>${s.shift ? ` <span class="muted" style="font-size:12px">${esc(s.shift)}</span>` : ''}</td>
        <td class="num">${hrs(s.hours)}</td>${money ? `<td class="num">${php(s.rate_php)}/h</td><td class="num">${php(s.php)}</td>` : ''}
        <td class="muted">${esc(s.notes || '')}</td>
        <td class="num">${editable(s) ? `<button class="ghost" data-edit="${s.id}">Edit</button><button class="ghost danger" data-del="${s.id}">Delete</button>` : ''}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total · ${data.length} session${data.length === 1 ? '' : 's'}</td><td></td><td></td><td></td>
        <td class="num">${hrs(H)} h</td>${money ? `<td></td><td class="num">${php(P)}</td>` : ''}<td></td><td></td></tr></tfoot></table>`
      : '<div class="empty">No sessions match these filters.</div>';
  };
  bindHoursSync();
  view.querySelector('.toolbar').addEventListener('input', (e) => {
    const k = e.target.dataset.f; if (!k) return;
    f[k] = e.target.value;
    clearTimeout(load.t); load.t = setTimeout(load, k === 'q' ? 250 : 0);
  });
  $('#ss-table').addEventListener('click', async (e) => {
    const id = e.target.dataset.edit || e.target.dataset.del;
    if (!id) return;
    const s = data.find((x) => String(x.id) === id);
    if (e.target.dataset.del) {
      if (!confirm(`Delete ${s.recorder} · ${s.date} · ${s.hours} h?`)) return;
      await api('/sessions/' + id, { method: 'DELETE' });
      toast('Deleted'); return load();
    }
    const v = await modal({ title: 'Edit session', fields: [
      { name: 'recorder', label: 'Recorder', value: s.recorder, list: 'dl-recorders', required: true, full: true },
      { name: 'date', label: 'Date', type: 'date', value: s.date, required: true },
      { name: 'hours', label: 'Hours', type: 'number', step: '0.01', value: s.hours, required: true },
      { name: 'location', label: 'Location', value: s.location || '', list: 'dl-locations' },
      { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: s.category },
      ...(isAdmin() ? [
        { name: 'rate_php', label: 'Rate (₱ per hour)', type: 'number', step: '0.01', value: s.rate_php },
      ] : []),
      { name: 'shift', label: 'Shift', value: s.shift || '', full: true },
      { name: 'notes', label: 'Notes', type: 'textarea', value: s.notes || '', full: true },
    ] });
    if (!v) return;
    try {
      await api('/sessions/' + id, { method: 'PUT', body: { ...v, recorder_id: null, location_id: null } });
      toast('Saved'); load();
    } catch (err) { toast(err.message, true); }
  });
  load();
}

// ---------- Pay periods ----------
async function periods() {
  const [list, syncBar] = await Promise.all([api('/periods'), hoursSyncBar()]);
  view.innerHTML = `
    <div class="head"><div><h1>Pay periods</h1><p>Each period generates the summary sheet automatically from logged sessions.</p></div>
      <div style="display:flex;gap:8px"><button id="pp-custom">Custom range</button><button class="primary" id="pp-new">+ New period</button></div></div>
    ${syncBar}
    <div class="table-wrap"><table><thead><tr><th>Period</th><th>Dates</th><th>Status</th><th class="num">Recorders</th><th class="num">Hours</th><th class="num">Payout</th><th class="num">Marked paid</th><th>Notes</th></tr></thead><tbody>
    ${list.map((p) => `<tr><td><a href="#/period/${p.id}"><b>${esc(p.name)}</b></a></td><td>${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}</td>
      <td><span class="pill ${p.status === 'Open' ? 'warn' : 'ok'}">${esc(p.status)}</span></td>
      <td class="num">${p.recorders}</td><td class="num">${hrs(p.hours)}</td><td class="num">${php(p.php)}</td>
      <td class="num">${p.paid_php ? php(p.paid_php) : '<span class="muted">—</span>'}</td><td class="muted">${esc(p.notes || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
  bindHoursSync();
  $('#pp-new').onclick = async () => {
    const v = await modal({ title: 'New pay period', fields: [
      { name: 'start_date', label: 'Start', type: 'date', required: true },
      { name: 'end_date', label: 'End', type: 'date', required: true },
      { name: 'name', label: 'Name (optional)', full: true },
      { name: 'notes', label: 'Notes', full: true },
    ] });
    if (!v) return;
    try { const p = await api('/periods', { method: 'POST', body: v }); location.hash = '#/period/' + p.id; }
    catch (e) { toast(e.message, true); }
  };
  $('#pp-custom').onclick = async () => {
    const v = await modal({ title: 'Summary for any date range', submit: 'View', fields: [
      { name: 'from', label: 'From', type: 'date', required: true }, { name: 'to', label: 'To', type: 'date', required: true },
    ] });
    if (v) location.hash = `#/period/range?${qs(v)}`;
  };
}

async function period(id = '') {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let p = null;
  if (id !== 'range') {
    p = (await api('/periods')).find((x) => String(x.id) === id);
    if (!p) throw new Error('Period not found');
  }
  const filt = { from: p?.start_date || params.get('from'), to: p?.end_date || params.get('to'), category: '', location_id: '', period_id: p?.id || '' };
  const { locations: locs } = await lookups();
  view.innerHTML = `
    <div class="head"><div><a href="#/periods" class="muted">← Pay periods</a><h1>${esc(p?.name || 'Custom range')}</h1>
      <p>${fmtDate(filt.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDate(filt.to, { month: 'short', day: 'numeric', year: 'numeric' })}${p?.notes ? ' · ' + esc(p.notes) : ''}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${p ? `<button id="pd-status">${p.status === 'Open' ? 'Close period' : 'Reopen period'}</button><button id="pd-edit">Edit</button>` : ''}
        <a class="btn" id="pd-csv">Export CSV</a><button id="pd-print">Print</button></div></div>
    <div class="grid kpis" id="pd-kpis"></div>
    <div class="toolbar">
      <label class="f">Category<select data-f="category"><option value="">All</option>${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label class="f">Location<select data-f="location_id"><option value="">All</option>${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
    </div>
    <div class="table-wrap" id="pd-table"></div>`;
  let sum;
  const load = async () => {
    sum = await api('/summary?' + qs(filt));
    $('#pd-csv').href = '/api/summary.csv?' + qs(filt);
    const T = sum.totals;
    const paidCount = sum.rows.filter((r) => r.payment?.status === 'Paid').length;
    $('#pd-kpis').innerHTML = `
      <div class="card kpi"><div class="label">Recorders</div><div class="value">${sum.rows.length}</div></div>
      <div class="card kpi"><div class="label">Hours</div><div class="value">${hrs(T.hours)}</div></div>
      <div class="card kpi"><div class="label">Payout</div><div class="value">${php(T.php)}</div></div>
      ${p ? `<div class="card kpi"><div class="label">Paid</div><div class="value">${paidCount}/${sum.rows.length}</div><div class="sub">${php(T.paid_php)} sent</div></div>` : ''}`;
    if (!sum.rows.length) { $('#pd-table').innerHTML = '<div class="empty">No sessions in this range.</div>'; return; }
    $('#pd-table').innerHTML = `<table><thead><tr><th class="sticky-col">Name of recorder</th>
      ${sum.dates.map((d) => `<th class="num">${fmtDate(d)}<br><span style="font-weight:400">${weekday(d)}</span></th>`).join('')}
      <th class="num">Total h</th><th class="num">PH earned</th><th>ID</th>${p ? '<th>Payment</th>' : ''}</tr></thead><tbody>
      ${sum.rows.map((r) => `<tr><td class="sticky-col"><a href="#/sessions/${r.recorder_id}?${qs({ from: filt.from, to: filt.to })}">${esc(r.name)}</a>
          <div class="muted" style="font-size:11px">${esc(r.locations.join(' · '))}</div></td>
        ${sum.dates.map((d) => `<td class="num ${r.by_date[d] ? '' : 'zero'}">${r.by_date[d] ? hrs(r.by_date[d]) : '0'}</td>`).join('')}
        <td class="num"><b>${hrs(r.hours)}</b></td><td class="num"><b>${php(r.php)}</b></td>
        <td>${idLink(r, { compact: true })}</td>
        ${p ? `<td>${payCell(r)}</td>` : ''}</tr>`).join('')}
      </tbody><tfoot><tr><td class="sticky-col">Total</td>${sum.dates.map((d) => `<td class="num">${hrs(T.by_date[d])}</td>`).join('')}
        <td class="num">${hrs(T.hours)}</td><td class="num">${php(T.php)}</td><td></td>${p ? '<td></td>' : ''}</tr></tfoot></table>`;
  };
  const payCell = (r) => {
    const pm = r.payment;
    if (!pm) return `<button class="ghost" data-pay="${r.recorder_id}">Mark paid</button>`;
    const cls = pm.status === 'Paid' ? 'ok' : 'warn';
    const diff = Math.abs(pm.amount_php - r.php) > 0.009 ? ` <span class="pill warn" title="Logged ${php(r.php)}">≠ ${php(pm.amount_php)}</span>` : '';
    return `<button class="ghost" data-pay="${r.recorder_id}"><span class="pill ${cls}">${esc(pm.status)}</span></button>${diff}`;
  };
  view.querySelector('.toolbar').addEventListener('input', (e) => { filt[e.target.dataset.f] = e.target.value; load(); });
  $('#pd-print').onclick = () => window.print();
  $('#pd-table').addEventListener('click', async (e) => {
    const rid = e.target.closest('[data-pay]')?.dataset.pay;
    if (!rid) return;
    const r = sum.rows.find((x) => String(x.recorder_id) === rid);
    const pm = r.payment || {};
    const v = await modal({ title: `Payment · ${r.name}`, submit: 'Save payment',
      extra: `<p class="muted" style="margin:0">Logged: <b>${hrs(r.hours)} h</b> = <b>${php(r.php)}</b></p>`,
      fields: [
        { name: 'amount_php', label: 'Amount sent (PHP)', type: 'number', step: '0.01', value: pm.amount_php ?? r.php.toFixed(2), required: true },
        { name: 'status', label: 'Status', type: 'select', options: ['Paid', 'Pending', 'Issue', 'Not paid'], value: pm.status || 'Paid' },
        { name: 'paid_at', label: 'Date sent', type: 'date', value: pm.paid_at || today() },
        { name: 'account_no', label: 'Account no.', value: pm.account_no || r.payout_account_no || '' },
        { name: 'reference', label: 'Reference no.', value: pm.reference || '', full: true },
        { name: 'notes', label: 'Notes', type: 'textarea', value: pm.notes || '', full: true },
      ] });
    if (!v) return;
    if (v.status === 'Not paid') await api(`/periods/${p.id}/payments/${rid}`, { method: 'DELETE' });
    else await api(`/periods/${p.id}/payments/${rid}`, { method: 'PUT', body: v });
    toast('Payment saved'); load();
  });
  if (p) {
    $('#pd-status').onclick = async () => {
      await api('/periods/' + p.id, { method: 'PUT', body: { status: p.status === 'Open' ? 'Closed' : 'Open' } });
      render();
    };
    $('#pd-edit').onclick = async () => {
      const v = await modal({ title: 'Edit period', fields: [
        { name: 'name', label: 'Name', value: p.name, full: true },
        { name: 'start_date', label: 'Start', type: 'date', value: p.start_date },
        { name: 'end_date', label: 'End', type: 'date', value: p.end_date },
        { name: 'notes', label: 'Notes', value: p.notes || '', full: true },
      ] });
      if (v) { await api('/periods/' + p.id, { method: 'PUT', body: v }); render(); }
    };
  }
  load();
}

// ---------- Recorders ----------
/** Contract tag: Done / Pending. Admins click it to switch; the signed copy (if linked) opens next to it. */
function contractTag(r, admin) {
  const done = r.contract_status === 'Done';
  const url = driveLink(r.contract_url) || driveLink(r.contract);
  const tag = admin
    ? `<button class="pill ${done ? 'ok' : 'warn'}" data-contract="${r.id}" title="Click to mark ${done ? 'Pending' : 'Done'}">${done ? '✓ Done' : 'Pending'}</button>`
    : `<span class="pill ${done ? 'ok' : 'warn'}">${done ? 'Done' : 'Pending'}</span>`;
  const hard = (r.contract_hard_copy || '').toLowerCase();
  return `${tag}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}${hard ? ` <span class="pill ${hard === 'done' ? 'ok' : 'warn'}" style="font-size:11px">hard copy: ${esc(r.contract_hard_copy)}</span>` : ''}`;
}

/** Only Google Drive/Docs links are rendered as links. */
const driveLink = (u) => (/^https:\/\/(drive|docs)\.google\.com\//.test(u || '') ? u : null);

/** "View ID" button that opens the Drive file; Google Drive sharing decides who can actually see it. */
function idLink(r, { compact = false } = {}) {
  const url = driveLink(r.id_document_url);
  if (!url) return `<span class="pill warn">${compact ? 'No ID' : 'No ID on file'}</span>`;
  return `<a class="btn ghost id-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer"
    title="${esc(r.id_document || 'ID')} — opens in Google Drive">🪪 ${compact ? 'ID' : 'View ID'}</a>`;
}

function contractPill(r) {
  if (!r.contract && !r.contract_url) return '<span class="pill warn">No contract</span>';
  const hard = (r.contract_hard_copy || '').toLowerCase();
  const url = driveLink(r.contract_url) || driveLink(r.contract);
  const link = url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open</a>` : '';
  return `<span class="pill ok" title="${esc(r.contract || 'Signed contract')}">Signed</span>${link}${hard ? ` <span class="pill ${hard === 'done' ? 'ok' : 'warn'}">hard copy: ${esc(r.contract_hard_copy)}</span>` : ''}`;
}

/** Thumbnails for uploaded files (images inline; PDF/HEIC as a tile you can open). */
function fileTiles(files) {
  return `<div class="file-grid">${files.map((f) => {
    const url = '/api/files/' + f.id;
    const thumb = /^image\/(jpeg|png|webp)$/.test(f.mime || 'image/jpeg') && !/\.heic$/i.test(f.filename)
      ? `<img src="${url}" alt="" loading="lazy">` : `<span class="reg-file-icon">${/pdf/.test(f.mime || f.filename) ? 'PDF' : 'FILE'}</span>`;
    return `<a class="file-tile" href="${url}" target="_blank" rel="noopener">${thumb}<span>${esc(f.filename)}</span></a>`;
  }).join('')}</div>`;
}
function filesSection(files) {
  const ids = files.filter((f) => f.kind === 'id'), sig = files.filter((f) => f.kind === 'esign');
  return `<h2 style="margin:4px 0 0">Valid ID (${ids.length})</h2>${ids.length ? fileTiles(ids) : '<p class="muted" style="margin:0">None</p>'}
    <h2 style="margin:4px 0 0">E-signature (${sig.length})</h2>${sig.length ? fileTiles(sig) : '<p class="muted" style="margin:0">None</p>'}`;
}
const regLink = (key) => `${location.origin}/register?k=${key}`;

async function recorders() {
  const admin = me.role === 'admin';
  const [{ recorders: list }, s, regs] = await Promise.all([lookups(true), api('/settings'), admin ? api('/registrations') : []]);
  // Same email on two recorders almost always means one person entered twice (e.g. a name spelled differently in a new tab).
  const byEmail = {};
  for (const r of list) if (r.email) (byEmail[r.email.toLowerCase()] ||= []).push(r);
  const dupes = Object.values(byEmail).filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.id - b.id));
  const noContract = list.filter((r) => r.contract_status !== 'Done').length;
  const noId = list.filter((r) => !r.id_document_url && !r.id_files).length;
  view.innerHTML = `
    <div class="head"><div><h1>Recorders</h1><p>${list.length} people · ${s.recorder_synced_at ? `profiles synced from Google Sheet ${new Date(s.recorder_synced_at).toLocaleString()}` : 'profiles not synced yet'}</p></div>
      <div class="head-actions">${admin ? '<button id="rc-link">🔗 Registration link</button><button id="rc-sync">⟳ Sync from Google Sheet</button>' : ''}<button class="primary" id="rc-new">+ Add recorder</button></div></div>
    ${regs.length ? `<div class="card reg-queue"><div class="section-head" style="margin-top:0"><h2>New registrations <span class="badge">${regs.length}</span></h2>
      <span class="muted">Submitted through the registration link — review before they're added</span></div>
      <div style="overflow:auto"><table><thead><tr><th>Name</th><th>Contact</th><th>Payment</th><th>Files</th><th>Submitted</th><th></th></tr></thead><tbody>
      ${regs.map((g) => `<tr><td><b>${esc(g.name)}</b><div class="muted" style="font-size:12px">${esc(g.email)}</div>
          ${g.matches.length ? `<div style="font-size:12px;color:var(--warn)">matches existing: ${g.matches.map((m) => esc(m.name)).join(', ')}</div>` : '<div style="font-size:12px" class="muted">new recorder</div>'}</td>
        <td>${esc(g.contact)}</td><td><span class="pill">${esc(g.payment_method === 'Bank' ? 'Bank – ' + g.bank_name : g.payment_method)}</span> ${maskAcct(g.account_no)}</td>
        <td>🪪 ${g.files.filter((f) => f.kind === 'id').length} · ✍️ ${g.files.filter((f) => f.kind === 'esign').length}</td>
        <td>${new Date(g.created_at).toLocaleString()}</td>
        <td class="num"><button class="primary" data-review="${g.id}">Review</button> <button class="ghost danger" data-reject="${g.id}">Reject</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
    ${admin && dupes.length ? `<div class="card reg-queue"><div class="section-head" style="margin-top:0"><h2>Possible duplicates <span class="badge">${dupes.length}</span></h2>
      <span class="muted">Same email on more than one recorder. If it's one person, merge; if they're <b>different people</b>, fix the email in the recorder sheet instead.</span></div>
      ${dupes.map((g) => `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--line)">
        <span style="flex:1;min-width:200px">${g.map((r) => `<b>${esc(r.name)}</b> <span class="muted">(${hrs(r.hours)} h)</span>`).join(' &nbsp;·&nbsp; ')}
          <div class="muted" style="font-size:12px">${esc(g[0].email)}</div></span>
        ${g.slice(1).map((r) => `<button class="ghost" data-dupe="${r.id}|${g[0].id}">Merge “${esc(r.name)}” into “${esc(g[0].name)}”</button>`).join('')}
      </div>`).join('')}</div>` : ''}
    <div class="toolbar">
      <label class="f" style="flex:1;min-width:180px">Search<input id="rc-q" placeholder="Name, email, contact, account…"></label>
      <label class="f">Show<select id="rc-f"><option value="">All recorders</option><option value="noid">No ID on file (${noId})</option><option value="nocontract">Contract pending (${noContract})</option>
        <option value="nohard">Hard copy not yet</option><option value="inactive">Inactive</option></select></label>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Contact</th><th>Payment</th><th>ID</th><th>Contract</th><th class="num">Hours</th><th class="num">Earned</th><th>Last</th><th></th></tr></thead>
    <tbody id="rc-body"></tbody></table></div>`;
  const draw = () => {
    const ql = $('#rc-q').value.toLowerCase(), f = $('#rc-f').value;
    const rows = list.filter((r) => {
      if (f === 'nocontract' && r.contract_status === 'Done') return false;
      if (f === 'noid' && (r.id_document_url || r.id_files)) return false;
      if (f === 'nohard' && !/not/i.test(r.contract_hard_copy || '')) return false;
      if (f === 'inactive' && r.active) return false;
      return !ql || [r.name, r.aliases, r.email, r.contact, r.payout_account_no, r.address].join(' ').toLowerCase().includes(ql);
    });
    $('#rc-body').innerHTML = rows.map((r) => `<tr>
      <td><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="pill">inactive</span>'}
        ${r.email ? `<div class="muted" style="font-size:12px">${esc(r.email)}</div>` : ''}${r.aliases ? `<div class="muted" style="font-size:11px">aka ${esc(r.aliases)}</div>` : ''}</td>
      <td>${r.contact ? `<a href="tel:${esc(r.contact)}">${esc(r.contact)}</a>` : '<span class="muted">—</span>'}</td>
      <td>${r.payment_method ? `<span class="pill">${esc(r.payment_method)}</span> ` : ''}${maskAcct(r.payout_account_no)}</td>
      <td>${r.id_files || r.esign_files ? `<button class="btn ghost id-btn" data-files="${r.id}">🪪 ${r.id_files} · ✍️ ${r.esign_files}</button>` : ''}
        ${r.id_document_url || !(r.id_files || r.esign_files) ? idLink(r) : ''}</td>
      <td>${contractTag(r, admin)}</td>
      <td class="num">${hrs(r.hours)}</td><td class="num">${php(r.php)}</td><td>${fmtDate(r.last_date)}</td>
      <td class="num"><a class="btn ghost" href="#/sessions/${r.id}">Sessions</a><button class="ghost" data-edit="${r.id}">Edit</button><button class="ghost" data-merge="${r.id}">Merge…</button></td></tr>`).join('')
      || '<tr><td colspan="9" class="empty">No recorders match.</td></tr>';
  };
  $('#rc-q').oninput = draw;
  $('#rc-f').onchange = draw;
  $('#rc-new').onclick = async () => {
    const v = await modal({ title: 'Add recorder', fields: [{ name: 'name', label: 'Full name', required: true, full: true }] });
    if (!v) return;
    const res = await api('/recorders', { method: 'POST', body: v });
    toast(`Added ${res.name}${sheetNote(res.sheet)}`); sheetWarn(res.sheet); render();
  };
  if (admin) $('#rc-sync').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try {
      const r = await api('/recorders/sync', { method: 'POST' });
      toast(`Synced ${r.rows} recorder profiles${r.created.length ? ` · ${r.created.length} new` : ''}`);
      render();
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = '⟳ Sync from Google Sheet'; }
  };
  if (admin) $('#rc-link').onclick = async () => {
    const { key } = await api('/registrations/link');
    const v = await modal({ title: 'Recorder registration link', submit: 'Done', fields: [],
      extra: `<p class="muted" style="margin:0">Send this link to new recorders. They fill in their details, payment account, ID and e-signature;
        you review each one here before it's added.</p>
        <input id="rl-url" readonly value="${esc(regLink(key))}" style="width:100%">
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="primary" id="rl-copy">Copy link</button>
          <a class="btn" href="${esc(regLink(key))}" target="_blank" rel="noopener">Open form</a>
          <button type="button" class="ghost danger" id="rl-new">Make a new link (old one stops working)</button></div>` ,
      onOpen: () => {
        $('#rl-copy').onclick = async () => { await navigator.clipboard.writeText($('#rl-url').value).catch(() => {}); $('#rl-url').select(); toast('Link copied'); };
        $('#rl-new').onclick = async () => {
          if (!confirm('Make a new link? Anyone with the old link won\'t be able to register anymore.')) return;
          const r = await api('/registrations/link/regenerate', { method: 'POST' });
          $('#rl-url').value = regLink(r.key); toast('New link ready — share this one');
        };
      } });
    void v;
  };
  view.addEventListener('click', async (e) => {
    const pair = e.target.dataset.dupe;
    if (!pair) return;
    const [from, into] = pair.split('|');
    const a = list.find((x) => String(x.id) === from), b = list.find((x) => String(x.id) === into);
    if (!confirm(`Merge "${a.name}" into "${b.name}"?\n\nAll sessions, payments and files move to "${b.name}", and "${a.name}" is kept as another spelling so future syncs match.`)) return;
    try { await api(`/recorders/${from}/merge`, { method: 'POST', body: { into } }); toast('Merged'); render(); }
    catch (err) { toast(err.message, true); }
  });
  view.addEventListener('click', async (e) => {
    const reviewId = e.target.dataset.review, rejectId = e.target.dataset.reject;
    if (!reviewId && !rejectId) return;
    const g = regs.find((x) => String(x.id) === (reviewId || rejectId));
    try {
      if (rejectId) {
        if (!confirm(`Reject the registration from ${g.name}? Their uploaded ID and signature files will be deleted.`)) return;
        await api(`/registrations/${g.id}/reject`, { method: 'POST' });
        toast('Registration rejected'); return render();
      }
      const method = g.payment_method === 'Bank' ? `Bank – ${g.bank_name}` : g.payment_method;
      const v = await modal({ title: `Review · ${g.name}`, submit: 'Approve',
        extra: `<dl class="profile">
            <dt>Name</dt><dd>${esc(g.name)}</dd><dt>Email</dt><dd>${esc(g.email)}</dd><dt>Contact</dt><dd>${esc(g.contact)}</dd>
            <dt>Address</dt><dd>${esc(g.address)}</dd><dt>Payment</dt><dd>${esc(method)} · <b>${esc(g.account_no)}</b></dd>
            <dt>Submitted</dt><dd>${new Date(g.created_at).toLocaleString()}</dd></dl>
          ${filesSection(g.files)}
          ${g.matches.length ? `<p style="margin:0;color:var(--warn);font-size:13px">This looks like an existing recorder. Approving into them <b>replaces</b> their email, contact, address and payout account with the details above — check the account number carefully.</p>` : ''}
          <p class="muted" style="margin:0;font-size:12px">Contract starts as <b>Pending</b> — mark it Done on the Recorders list once signed.</p>`,
        fields: [{ name: 'recorder_id', label: 'Save as', type: 'select', full: true,
          options: [...g.matches.map((m) => [m.id, `Update existing: ${m.name}${m.email ? ` (${m.email})` : ''}`]), ['', 'New recorder']],
          value: g.matches[0]?.id ?? '' }] });
      if (!v) return;
      const res = await api(`/registrations/${g.id}/approve`, { method: 'POST', body: { recorder_id: v.recorder_id || null } });
      toast(`${g.name} approved${sheetNote(res.sheet)}`); sheetWarn(res.sheet); render();
    } catch (err) { toast(err.message, true); }
  });
  $('#rc-body').addEventListener('click', async (e) => {
    const cid = e.target.closest('[data-contract]')?.dataset.contract;
    if (cid) {
      const r = list.find((x) => String(x.id) === cid);
      const next = r.contract_status === 'Done' ? 'Pending' : 'Done';
      try { await api('/recorders/' + cid, { method: 'PUT', body: { contract_status: next } }); r.contract_status = next; draw(); toast(`${r.name}: contract ${next}`); }
      catch (err) { toast(err.message, true); }
      return;
    }
    const fid = e.target.closest('[data-files]')?.dataset.files;
    if (fid) {
      const r = list.find((x) => String(x.id) === fid);
      const files = await api(`/recorders/${fid}/files`);
      await modal({ title: `${r.name} · uploaded files`, submit: 'Close', fields: [], extra: filesSection(files) });
      return;
    }
    const id = e.target.dataset.edit || e.target.dataset.merge;
    if (!id) return;
    const r = list.find((x) => String(x.id) === id);
    if (e.target.dataset.merge) {
      const v = await modal({ title: `Merge "${r.name}" into…`, submit: 'Merge',
        extra: '<p class="muted" style="margin:0">All sessions and payments move to the selected person; this name is kept as an alias so future imports match.</p>',
        fields: [{ name: 'into', label: 'Keep this recorder', type: 'select', full: true,
          options: list.filter((x) => x.id !== r.id).map((x) => [x.id, x.name]) }] });
      if (!v) return;
      await api(`/recorders/${id}/merge`, { method: 'POST', body: v });
      toast('Merged'); return render();
    }
    const v = await modal({ title: 'Edit recorder',
      extra: s.recorder_synced_at ? '<p class="muted" style="margin:0;font-size:12px">Profile fields come from the recorder Google Sheet — the next sync overwrites them with what\'s in the sheet.</p>' : '',
      fields: [
      { name: 'name', label: 'Full name', value: r.name, required: true, full: true },
      { name: 'email', label: 'Email', type: 'email', value: r.email || '' },
      { name: 'contact', label: 'Contact no.', value: r.contact || '' },
      { name: 'address', label: 'Address', value: r.address || '', full: true },
      { name: 'payment_method', label: 'Payment method', value: r.payment_method || '' },
      { name: 'payout_account_no', label: 'Account no.', value: r.payout_account_no || '' },
      { name: 'payout_account_name', label: 'Account name (if different)', value: r.payout_account_name || '' },
      { name: 'app_account', label: 'App account no.', value: r.app_account || '' },
      { name: 'id_document', label: 'ID on file (name)', value: r.id_document || '' },
      { name: 'id_document_url', label: 'ID link (Google Drive)', type: 'url', value: r.id_document_url || '' },
      { name: 'contract', label: 'Signed contract (name)', value: r.contract || '' },
      { name: 'contract_url', label: 'Contract link (Google Drive/Docs)', type: 'url', value: r.contract_url || '' },
      { name: 'contract_hard_copy', label: 'Contract hard copy', type: 'select', options: [['', '—'], ['done', 'done'], ['not yet', 'not yet']], value: (r.contract_hard_copy || '').toLowerCase() },
      { name: 'active', label: 'Status', type: 'select', options: [['true', 'Active'], ['false', 'Inactive']], value: String(r.active) },
      { name: 'notes', label: 'Notes', type: 'textarea', value: r.notes || '', full: true },
    ] });
    if (!v) return;
    try { const res = await api('/recorders/' + id, { method: 'PUT', body: { ...v, active: v.active === 'true' } }); toast('Saved' + sheetNote(res.sheet)); sheetWarn(res.sheet); render(); }
    catch (err) { toast(err.message, true); }
  });
  draw();
}

// ---------- Locations ----------
async function locations() {
  const { locations: list } = await lookups(true);
  view.innerHTML = `
    <div class="head"><div><h1>Locations</h1><p>Businesses and sites where recording happens</p></div></div>
    <div class="table-wrap"><table><thead><tr><th>Location</th><th>Active</th><th class="num">Recorders</th><th class="num">Sessions</th><th class="num">Hours</th><th class="num">Payout</th><th>Notes</th><th></th></tr></thead><tbody>
    ${list.map((l) => `<tr><td><b>${esc(l.name)}</b></td><td>${l.first_date ? `${fmtDate(l.first_date)} – ${fmtDate(l.last_date)}` : '—'}</td>
      <td class="num">${l.recorders}</td><td class="num">${l.sessions}</td><td class="num">${hrs(l.hours)}</td><td class="num">${php(l.php)}</td>
      <td class="muted">${esc(l.notes || '')}</td><td class="num"><a class="btn ghost" href="#/sessions?${qs({ from: l.first_date, to: l.last_date })}">Sessions</a><button class="ghost" data-edit="${l.id}">Edit</button><button class="ghost" data-merge="${l.id}">Merge…</button></td></tr>`).join('')}
    </tbody></table></div>`;
  view.addEventListener('click', async (e) => {
    const id = e.target.dataset.edit || e.target.dataset.merge; if (!id) return;
    const l = list.find((x) => String(x.id) === id);
    if (e.target.dataset.merge) {
      const v = await modal({ title: `Merge "${l.name}" into…`, submit: 'Merge',
        extra: '<p class="muted" style="margin:0">All sessions at this location move to the selected one.</p>',
        fields: [{ name: 'into', label: 'Keep this location', type: 'select', full: true, options: list.filter((x) => x.id !== l.id).map((x) => [x.id, x.name]) }] });
      if (v) { await api(`/locations/${id}/merge`, { method: 'POST', body: v }); toast('Merged'); render(); }
      return;
    }
    const v = await modal({ title: 'Edit location', fields: [
      { name: 'name', label: 'Name', value: l.name, required: true, full: true },
      { name: 'notes', label: 'Notes / address', type: 'textarea', value: l.notes || '', full: true },
    ] });
    if (v) { await api('/locations/' + id, { method: 'PUT', body: v }); render(); }
  });
}

// ---------- Follow-ups ----------
async function followups() {
  const [list] = await Promise.all([api('/followups'), lookups()]);
  view.innerHTML = `
    <div class="head"><div><h1>Follow-ups</h1><p>Payment issues to chase — wrong accounts, short payments, missing paperwork</p></div>
      <button class="primary" id="fu-new">+ New follow-up</button></div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Recorder</th><th>Issue</th><th class="num">Expected</th><th class="num">Received</th><th class="num">Difference</th><th>Account before → new</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((f) => {
      const diff = f.expected_php != null && f.received_php != null ? f.received_php - f.expected_php : null;
      return `<tr><td><b>${esc(f.recorder || '—')}</b></td><td>${esc(f.description || '')}${f.notes ? `<div class="muted" style="font-size:12px;max-width:420px">${esc(f.notes)}</div>` : ''}</td>
      <td class="num">${f.expected_php != null ? php(f.expected_php) : '—'}</td><td class="num">${f.received_php != null ? php(f.received_php) : '—'}</td>
      <td class="num">${diff != null ? php(diff) : '—'}</td>
      <td style="font-size:12px">${esc(f.old_account_no || '')} ${esc(f.old_account_name || '')}${f.new_account_no ? ` → <b>${esc(f.new_account_no)}</b> ${esc(f.new_account_name || '')}` : ''}</td>
      <td><span class="pill ${f.status === 'Resolved' ? 'ok' : 'warn'}">${esc(f.status)}</span></td>
      <td class="num"><button class="ghost" data-edit="${f.id}">Edit</button></td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="card empty">Nothing to follow up 🎉</div>'}`;
  const form = (f = {}) => modal({ title: f.id ? 'Edit follow-up' : 'New follow-up', fields: [
    { name: 'recorder', label: 'Recorder', value: f.recorder || '', list: 'dl-recorders', required: true, full: true },
    { name: 'description', label: 'Issue', value: f.description || '', full: true },
    { name: 'expected_php', label: 'Expected (PHP)', type: 'number', step: '0.01', value: f.expected_php ?? '' },
    { name: 'received_php', label: 'Received (PHP)', type: 'number', step: '0.01', value: f.received_php ?? '' },
    { name: 'old_account_no', label: 'Account before — no.', value: f.old_account_no || '' },
    { name: 'old_account_name', label: 'Account before — name', value: f.old_account_name || '' },
    { name: 'new_account_no', label: 'New account — no.', value: f.new_account_no || '' },
    { name: 'new_account_name', label: 'New account — name', value: f.new_account_name || '' },
    { name: 'status', label: 'Status', type: 'select', options: ['Open', 'Resolved'], value: f.status || 'Open', full: true },
    { name: 'notes', label: 'Notes', type: 'textarea', value: f.notes || '', full: true },
  ] });
  const clean = (v) => {
    const rec = cache.recorders.find((r) => r.name.toLowerCase() === v.recorder.trim().toLowerCase());
    const out = { ...v, recorder_id: rec?.id ?? null };
    for (const k of ['expected_php', 'received_php']) out[k] = v[k] === '' ? null : Number(v[k]);
    if (!rec) { out.recorder = v.recorder; delete out.recorder_id; }
    else delete out.recorder;
    return out;
  };
  $('#fu-new').onclick = async () => {
    const v = await form(); if (!v) return;
    await api('/followups', { method: 'POST', body: clean(v) }); render();
  };
  view.addEventListener('click', async (e) => {
    const id = e.target.dataset.edit; if (!id) return;
    const v = await form(list.find((x) => String(x.id) === id)); if (!v) return;
    const body = clean(v);
    if (body.recorder) body.recorder_id = (await api('/recorders', { method: 'POST', body: { name: body.recorder } })).id;
    delete body.recorder;
    await api('/followups/' + id, { method: 'PUT', body }); render();
  });
}

// ---------- Businesses ----------
function businessFields(b = {}, locs = [], { short = false } = {}) {
  const main = [
    { name: 'name', label: 'Business name', value: b.name, required: true, full: true },
    { name: 'address', label: 'Address', type: 'textarea', value: b.address || '', full: true },
    { name: 'owner_name', label: 'Owner', value: b.owner_name || '', full: true },
    { name: 'bank_name', label: 'Bank (e.g. BDO, GCash, Maribank)', value: b.bank_name || '' },
    { name: 'bank_account_no', label: 'Bank account no.', value: b.bank_account_no || '' },
    { name: 'default_scenes', label: 'Scene (scenes per shift)', type: 'number', step: '1', value: b.default_scenes ?? 3 },
    { name: 'rate_php', label: 'Payout (₱ per shift × scene)', type: 'number', step: '0.01', value: b.rate_php ?? cache.settings?.business_rate_php ?? 850 },
  ];
  if (short) return [...main, { name: 'location_id', label: 'Recorder location (optional — links recorder hours)', type: 'select', full: true,
    options: [['', '— none —'], ...locs.map((l) => [l.id, l.name])], value: b.location_id ?? '' }];
  return [...main,
    { name: 'account_name', label: 'Account name', value: b.account_name || '', full: true },
    { name: 'gcash_owner', label: 'GCash owner', value: b.gcash_owner || '', full: true },
    { name: 'owner_id_url', label: "Owner's ID link (Google Drive)", type: 'url', value: b.owner_id_url || '' },
    { name: 'gcash_owner_id_url', label: "GCash owner's ID link", type: 'url', value: b.gcash_owner_id_url || '' },
    { name: 'location_id', label: 'Recorder location (for hours/recorders)', type: 'select', full: true,
      options: [['', '— none —'], ...locs.map((l) => [l.id, l.name])], value: b.location_id ?? '' },
    { name: 'active', label: 'Status', type: 'select', options: [['true', 'Active'], ['false', 'Inactive']], value: String(b.active ?? true) },
    { name: 'notes', label: 'Notes', type: 'textarea', value: b.notes || '', full: true },
  ];
}
const businessBody = (v) => ({ ...v, ...(v.active !== undefined ? { active: v.active === 'true' } : {}), location_id: v.location_id ? Number(v.location_id) : null });

/** "+ Add business" (dashboard and Businesses page). Opens the new business afterwards. */
async function addBusiness() {
  const { locations: locs } = await lookups();
  const v = await modal({ title: 'Add business', submit: 'Add business', fields: businessFields({}, locs, { short: true }),
    extra: '<p class="muted" style="margin:0;font-size:13px">Payout per shift = Scene × Payout (e.g. 3 scenes × ₱850 = ₱2,550 per shift).</p>' });
  if (!v) return;
  try { const b = await api('/businesses', { method: 'POST', body: businessBody(v) }); toast(`${b.name} added`); location.hash = '#/business/' + b.id; }
  catch (e) { toast(e.message, true); }
}

async function businesses() {
  const [{ businesses: list, synced_at }, { locations: locs }] = await Promise.all([api('/businesses'), lookups()]);
  const admin = me.role === 'admin';
  view.innerHTML = `
    <div class="head"><div><h1>Businesses</h1>
      <p>Host businesses and what they're owed (shifts × scenes × rate). ${synced_at ? `Last synced ${new Date(synced_at).toLocaleString()}.` : 'Not synced yet.'}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${admin ? '<button id="bz-sync">⟳ Sync from Google Sheet</button>' : ''}<button class="primary" id="bz-new">+ Add business</button></div></div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Business</th><th>Owner</th><th>Bank</th><th>Account</th><th>Location</th><th class="num">Shifts</th><th class="num">Payout</th><th class="num">Recorder h</th><th>Last</th></tr></thead><tbody>
    ${list.map((b) => `<tr><td><a href="#/business/${b.id}"><b>${esc(b.name)}</b></a>${b.active ? '' : ' <span class="pill">inactive</span>'}</td>
      <td>${esc(b.owner_name || '—')}</td><td>${esc(b.bank_name || '—')}</td><td>${maskAcct(b.bank_account_no)}</td>
      <td>${b.location ? esc(b.location) : '<span class="pill warn">none</span>'}</td>
      <td class="num">${hrs(b.shifts)}</td><td class="num">${php(b.payout)}</td><td class="num">${hrs(b.recorder_hours)}</td>
      <td>${fmtDate([b.last_date, b.last_session].filter(Boolean).sort().at(-1))}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="card empty">No businesses yet.</div>'}`;
  $('#bz-new').onclick = addBusiness;
  if (admin) $('#bz-sync').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try {
      const r = await api('/businesses/sync', { method: 'POST' });
      toast(`Synced ${r.profiles} profiles and ${r.shifts} shift days from ${r.tabs.length} summary tab(s)`);
      render();
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = '⟳ Sync from Google Sheet'; }
  };
}

async function business(id) {
  const [b, { locations: locs }] = await Promise.all([api('/businesses/' + id), lookups()]);
  const row = (k, v) => `<dt>${k}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`;
  view.innerHTML = `
    <div class="head"><div><a href="#/businesses" class="muted">← Businesses</a><h1>${esc(b.name)}</h1>
      <p>${b.location ? `Recorders log hours here as ${canSee('sessions') ? `<a href="#/sessions?${qs({ from: b.first_session, to: b.last_session })}">${esc(b.location)}</a>` : `<b>${esc(b.location)}</b>`}` : 'No recorder location linked'}</p></div>
      <div class="head-actions"><button id="bz-edit">Edit profile</button><button id="bz-add-rec">+ Add recorder</button><button class="primary" id="bz-shift">+ Add shift</button></div></div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Business payout</div><div class="value">${php(b.payout)}</div><div class="sub">${hrs(b.shifts)} shifts</div></div>
      <div class="card kpi"><div class="label">Recorder hours</div><div class="value">${hrs(b.recorder_hours)}</div><div class="sub">${php(b.recorder_php)} to recorders</div></div>
      <div class="card kpi"><div class="label">Recorders</div><div class="value">${b.recorders}</div></div>
      <div class="card kpi"><div class="label">Active</div><div class="value" style="font-size:16px">${fmtDate(b.first_date || b.first_session)} – ${fmtDate([b.last_date, b.last_session].filter(Boolean).sort().at(-1))}</div></div>
    </div>
    <div class="grid two">
      <div class="card"><h2>Profile</h2><dl class="profile">
        ${row('Address', esc(b.address))}${row('Owner', esc(b.owner_name))}${row('Bank', esc(b.bank_name))}${row('Bank account', b.bank_account_no ? maskAcct(b.bank_account_no) : '')}
        ${row('Scene', b.default_scenes != null ? hrs(b.default_scenes) + ' per shift' : '')}${row('Payout', b.rate_php != null ? php(b.rate_php) + ' per shift × scene' : '')}
        ${b.status ? row('Status', `<span class="pill ${/going/i.test(b.status) ? 'warn' : 'ok'}">${esc(b.status)}</span>`) : ''}
        ${row('Account name', esc(b.account_name))}${row('GCash owner', esc(b.gcash_owner))}
        ${row("Owner's ID", driveLink(b.owner_id_url) ? `<a class="btn ghost id-btn" href="${esc(b.owner_id_url)}" target="_blank" rel="noopener noreferrer">🪪 View ID</a>` : '<span class="pill warn">No ID on file</span>')}
        ${b.gcash_owner_id_url ? row("GCash owner's ID", `<a class="btn ghost id-btn" href="${esc(b.gcash_owner_id_url)}" target="_blank" rel="noopener noreferrer">🪪 View ID</a>`) : ''}${row('Notes', esc(b.notes))}
      </dl></div>
      <div class="card"><h2>Recorder activity</h2>
        ${b.recorder_log.length ? `<table><thead><tr><th>Date</th><th class="num">Recorders</th><th class="num">Hours</th><th class="num">Paid to recorders</th></tr></thead><tbody>
        ${b.recorder_log.map((r) => `<tr><td>${weekday(r.date)} ${fmtDate(r.date)}</td><td class="num">${r.recorders}</td><td class="num">${hrs(r.hours)}</td><td class="num">${php(r.php)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No recorder sessions at the linked location.</p>'}</div>
    </div>
    <div class="section-head" style="margin-top:14px"><h2>Recorders <span class="muted" style="font-weight:400">(${b.team.length})</span></h2>
      <span class="muted">Added to this business, plus anyone who logged hours at ${b.location ? esc(b.location) : 'its location'}</span></div>
    <div class="table-wrap" style="margin-bottom:14px">${b.team.length ? `<table><thead><tr><th>Name</th><th>Contact</th><th class="num">Hours here</th><th>Last here</th><th></th></tr></thead><tbody>
      ${b.team.map((r) => `<tr><td><b>${esc(r.name)}</b> ${r.assigned ? '<span class="pill accent" style="font-size:11px">added</span>' : '<span class="pill" style="font-size:11px">worked here</span>'}</td>
        <td>${r.contact ? `<a href="tel:${esc(r.contact)}">${esc(r.contact)}</a>` : '<span class="muted">—</span>'}</td>
        <td class="num">${hrs(r.hours)}</td><td>${fmtDate(r.last_date)}</td>
        <td class="num">${r.assigned ? `<button class="ghost danger" data-unassign="${r.id}">Remove</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No recorders yet. Use <b>+ Add recorder</b>.</div>'}</div>
    <div class="section-head" style="margin-top:14px"><h2>Shifts hosted</h2><span class="muted">Rows marked “sheet” come from the Google Sheet and update on sync</span></div>
    <div class="table-wrap">${b.shift_log.length ? `<table><thead><tr><th>Date</th><th class="num">Shifts</th><th class="num">Scenes</th><th class="num">Rate</th><th class="num">Payout</th><th>Source</th><th></th></tr></thead><tbody>
      ${b.shift_log.map((s) => `<tr><td>${weekday(s.date)} ${fmtDate(s.date)}</td><td class="num">${hrs(s.shifts)}</td><td class="num">${hrs(s.scenes)}</td>
        <td class="num">${php(s.rate_php)}</td><td class="num"><b>${php(s.payout)}</b></td>
        <td><span class="pill ${s.source === 'sheet' ? 'accent' : ''}">${esc(s.source)}</span> <span class="muted" style="font-size:12px">${esc(s.source === 'sheet' ? s.notes : s.notes || '')}</span></td>
        <td class="num">${s.source === 'sheet' ? '' : `<button class="ghost danger" data-del="${s.id}">Delete</button>`}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td><td class="num">${hrs(b.shifts)}</td><td></td><td></td><td class="num">${php(b.payout)}</td><td></td><td></td></tr></tfoot></table>`
      : '<div class="empty">No shifts recorded yet.</div>'}</div>`;
  $('#bz-edit').onclick = async () => {
    const v = await modal({ title: 'Edit business', fields: businessFields(b, locs) });
    if (!v) return;
    try { await api('/businesses/' + id, { method: 'PUT', body: businessBody(v) }); toast('Saved'); render(); }
    catch (e) { toast(e.message, true); }
  };
  $('#bz-shift').onclick = async () => {
    const last = b.shift_log[0];
    const v = await modal({ title: `Add shift · ${b.name}`, fields: [
      { name: 'date', label: 'Date', type: 'date', value: today(), required: true },
      { name: 'shifts', label: 'Shifts', type: 'number', step: '0.5', value: 1, required: true },
      { name: 'scenes', label: 'Scenes', type: 'number', step: '1', value: b.default_scenes ?? last?.scenes ?? 3, required: true },
      { name: 'rate_php', label: 'Payout (₱ per shift × scene)', type: 'number', step: '0.01', value: b.rate_php ?? last?.rate_php ?? cache.settings?.business_rate_php ?? 850, required: true },
      { name: 'notes', label: 'Notes', full: true },
    ] });
    if (!v) return;
    try { await api('/business-shifts', { method: 'POST', body: { ...v, business_id: b.id } }); toast('Shift added'); render(); }
    catch (e) { toast(e.message, true); }
  };
  $('#bz-add-rec').onclick = async () => {
    const options = await api('/businesses/recorder-options');
    const taken = new Set(b.team.filter((r) => r.assigned).map((r) => r.id));
    const v = await modal({ title: `Add recorder · ${b.name}`, submit: 'Add',
      extra: `<datalist id="dl-biz-rec">${options.filter((o) => !taken.has(o.id)).map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>
        <p class="muted" style="margin:0;font-size:13px">Pick an existing recorder, or type a new full name to create them.
        New recorders can then complete their details through the registration link.</p>`,
      fields: [{ name: 'name', label: 'Recorder', list: 'dl-biz-rec', required: true, full: true }] });
    if (!v) return;
    const match = options.find((o) => o.name.toLowerCase() === v.name.trim().toLowerCase());
    try {
      const r = await api(`/businesses/${b.id}/recorders`, { method: 'POST', body: match ? { recorder_id: match.id } : { name: v.name } });
      toast(r.created ? `New recorder "${v.name.trim()}" created and added${sheetNote(r.sheet)}` : 'Recorder added'); sheetWarn(r.sheet); render();
    } catch (err) { toast(err.message, true); }
  };
  view.addEventListener('click', async (e) => {
    const rid = e.target.dataset.unassign; if (!rid) return;
    const r = b.team.find((x) => String(x.id) === rid);
    if (!confirm(`Remove ${r.name} from ${b.name}? (Their logged hours stay.)`)) return;
    try { await api(`/businesses/${b.id}/recorders/${rid}`, { method: 'DELETE' }); render(); } catch (err) { toast(err.message, true); }
  });
  view.addEventListener('click', async (e) => {
    const sid = e.target.dataset.del; if (!sid) return;
    if (!confirm('Delete this shift?')) return;
    try { await api('/business-shifts/' + sid, { method: 'DELETE' }); render(); } catch (err) { toast(err.message, true); }
  });
}

// ---------- Settings ----------
async function settings() {
  const s = await api('/settings');
  const admin = isAdmin();
  view.innerHTML = `
    <div class="head"><div><h1>Settings</h1><p>${admin ? 'Defaults for new sessions. Existing sessions keep the rate they were logged with.' : `Signed in as ${esc(me.email)} · ${ROLE_LABEL[me.role]}`}</p></div></div>
    <div class="grid" style="max-width:520px">
      ${admin ? `<form id="st-form" class="card grid">
        <h2>Rates & sources</h2>
        <label class="f">Recording rate (₱ per hour)<input name="rate_php" type="number" step="0.01" value="${s.rate_php}"></label>
        <label class="f">Business rate (PHP per shift × scene)<input name="business_rate_php" type="number" step="0.01" value="${s.business_rate_php}"></label>
        <label class="f">Hours Google Sheet — Studio Payout Summary (ID or link)<input name="payout_sheet_id" value="${esc(s.payout_sheet_id)}"></label>
        <label class="f">Business Google Sheet (ID or link)<input name="business_sheet_id" value="${esc(s.business_sheet_id)}"></label>
        <label class="f">Recorder Google Sheet (ID or link)<input name="recorder_sheet_id" value="${esc(s.recorder_sheet_id)}"></label>
        <label class="f">Auto-admin emails (become admin when they sign up)<input name="admin_emails" value="${esc(s.admin_emails)}"></label>
        <div><button class="primary">Save</button></div>
      </form>` : ''}
      ${admin ? `<div class="card grid">
        <h2>Write new recorders into the recorder sheet</h2>
        <p class="muted" style="margin:0;font-size:13px">When you approve a registration, or add/edit a recorder here, the app updates their row in the recorder
          Google Sheet (or adds one). One-time setup, about 3 minutes:</p>
        <ol style="margin:0;padding-left:18px;font-size:13px;display:grid;gap:4px">
          <li><button type="button" class="btn" id="wb-copy">Copy script</button> (it already includes your secret code)</li>
          <li>Open the <a href="https://docs.google.com/spreadsheets/d/${esc(String(s.recorder_sheet_id || '').match(/[\w-]{20,}/)?.[0] || '')}/edit" target="_blank" rel="noopener">recorder sheet</a>
            → <b>Extensions → Apps Script</b> → replace everything in <b>Code.gs</b> with the copied script → <b>Save</b></li>
          <li><b>Deploy → New deployment</b> → type <b>Web app</b> → Execute as <b>Me</b>, Who has access <b>Anyone</b> → <b>Deploy</b> → allow access</li>
          <li>Paste the <b>Web app URL</b> below, <b>Save</b>, then <b>Test</b></li>
        </ol>
        <form id="wb-form" class="grid" style="gap:8px">
          <label class="f">Apps Script web app URL<input name="recorder_sheet_webhook" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(s.recorder_sheet_webhook || '')}"></label>
          <div style="display:flex;gap:8px"><button class="primary">Save</button><button type="button" id="wb-test">Test</button></div>
        </form>
      </div>` : ''}
      <form id="pw-form" class="card grid">
        <h2>Change my password</h2>
        <label class="f">Current password<input name="current" type="password" autocomplete="current-password" required></label>
        <label class="f">New password (10+ characters)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
        <div><button>Update password</button></div>
      </form>
    </div>`;
  const f = $('#st-form');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(f)) });
      cache.recorders = null; toast('Settings saved');
    } catch (err) { toast(err.message, true); }
  };
  if (admin) {
    $('#wb-copy').onclick = async () => {
      const code = (await (await fetch('/apps-script/recorder-sheet.gs')).text()).replace('PASTE_THE_SECRET_FROM_THE_APP_HERE', s.sheets_webhook_secret);
      try { await navigator.clipboard.writeText(code); toast('Script copied — paste it into Apps Script'); }
      catch { await modal({ title: 'Copy this script', submit: 'Done', fields: [], extra: `<textarea readonly rows="14" style="width:100%;font-family:monospace;font-size:12px">${esc(code)}</textarea>` }); }
    };
    $('#wb-form').onsubmit = async (e) => {
      e.preventDefault();
      const url = e.target.recorder_sheet_webhook.value.trim();
      if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) return toast('That should be the Web app URL ending in /exec', true);
      try { await api('/settings', { method: 'PUT', body: { recorder_sheet_webhook: url } }); toast('Saved'); } catch (err) { toast(err.message, true); }
    };
    $('#wb-test').onclick = async () => {
      const r = await api('/sheets/test', { method: 'POST' });
      toast(r.ok ? `Connected to "${r.sheet}" ✓` : (r.error || 'Not connected'), !r.ok);
    };
  }
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      e.target.reset(); toast('Password updated');
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- My hours (recorder role) ----------
async function myHours() {
  let d;
  try { d = await api('/me/recorder'); }
  catch (e) { view.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  const { profile: p, sessions: all, periods } = d;
  const payPill = (x) => !x.payment_status ? '<span class="pill">Not paid yet</span>'
    : `<span class="pill ${x.payment_status === 'Paid' ? 'ok' : 'warn'}">${esc(x.payment_status)}</span>${x.paid_at ? ` <span class="muted" style="font-size:12px">${fmtDate(x.paid_at)}</span>` : ''}`;

  // Date range: kept in the URL (#/me?from=…&to=…) so a refresh or bookmark keeps it.
  const iso = (dt) => dt.toLocaleDateString('en-CA');
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const presets = {
    week: [iso(monday), iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6))],
    month: [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))],
    lastmonth: [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))],
    all: ['', ''],
  };
  const qp = new URLSearchParams(location.hash.split('?')[1] || '');
  const range = { from: qp.get('from') || '', to: qp.get('to') || '' };

  view.innerHTML = `
    <div class="head"><div><h1>Hi, ${esc(p.name.split(' ')[0])}</h1><p>Your recording hours and pay</p></div></div>
    <div class="card" style="margin-bottom:14px">
      <div class="toolbar" style="margin:0">
        <label class="f">From<input type="date" id="me-from"></label>
        <label class="f">To<input type="date" id="me-to"></label>
        <label class="f" style="flex:1;min-width:180px">Pay period<select id="me-period"><option value="">—</option>
          ${periods.map((x) => `<option value="${x.start_date}|${x.end_date}">${esc(x.name)}</option>`).join('')}</select></label>
        <div class="range-btns">
          <button type="button" class="ghost" data-preset="week">This week</button>
          <button type="button" class="ghost" data-preset="month">This month</button>
          <button type="button" class="ghost" data-preset="lastmonth">Last month</button>
          <button type="button" class="ghost" data-preset="all">All time</button>
        </div>
      </div>
    </div>
    <div class="grid kpis" id="me-kpis"></div>
    <div class="grid two">
      <div class="card"><h2>Pay periods</h2>
        ${periods.length ? `<div style="overflow:auto"><table><thead><tr><th>Period</th><th class="num">Hours</th><th class="num">Earned</th><th>Payment</th></tr></thead><tbody>
        ${periods.map((x) => `<tr class="clickable" data-range="${x.start_date}|${x.end_date}" title="Show this period's sessions">
          <td><b>${esc(x.name)}</b><div class="muted" style="font-size:12px">${fmtDate(x.start_date)} – ${fmtDate(x.end_date)}</div></td>
          <td class="num">${hrs(x.hours)}</td><td class="num">${php(x.php)}</td><td>${payPill(x)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No pay periods yet.</p>'}</div>
      <div class="card"><h2>My details</h2><dl class="profile">
        <dt>Email</dt><dd>${esc(p.email || '—')}</dd>
        <dt>Contact</dt><dd>${esc(p.contact || '—')}</dd>
        <dt>Payment</dt><dd>${esc(p.payment_method || '—')} ${maskAcct(p.payout_account_no)}</dd>
        ${p.files?.length ? '' : `<dt>ID</dt><dd>${idLink(p)}</dd>`}
        <dt>Contract</dt><dd>${contractTag(p, false)}</dd>
      </dl>${p.files?.length ? `<div class="grid" style="margin-top:10px;gap:8px">${filesSection(p.files)}</div>` : ''}<p class="muted" style="font-size:12px;margin:12px 0 0">Something wrong? Tell the studio admin so they can update it.</p></div>
    </div>
    <div class="section-head" style="margin-top:14px"><h2>My sessions</h2><span class="muted" id="me-range-label"></span></div>
    <div class="table-wrap" id="me-sessions"></div>`;

  const long = { month: 'short', day: 'numeric', year: 'numeric' };
  const draw = () => {
    const list = all.filter((s) => (!range.from || s.date >= range.from) && (!range.to || s.date <= range.to));
    const H = list.reduce((a, s) => a + s.hours, 0), P = list.reduce((a, s) => a + s.php, 0);
    // "Marked paid" counts periods that overlap the chosen range.
    const inRange = periods.filter((x) => (!range.to || x.start_date <= range.to) && (!range.from || x.end_date >= range.from));
    const paid = inRange.reduce((a, x) => a + (x.payment_status === 'Paid' ? x.paid_php : 0), 0);
    $('#me-from').value = range.from; $('#me-to').value = range.to;
    $('#me-period').value = periods.some((x) => `${x.start_date}|${x.end_date}` === `${range.from}|${range.to}`) ? `${range.from}|${range.to}` : '';
    view.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', presets[b.dataset.preset].join('|') === `${range.from}|${range.to}`));
    view.querySelectorAll('tr[data-range]').forEach((tr) => tr.classList.toggle('selected', tr.dataset.range === `${range.from}|${range.to}`));
    $('#me-range-label').textContent = !range.from && !range.to ? 'All time'
      : `${range.from ? fmtDate(range.from, long) : 'Start'} – ${range.to ? fmtDate(range.to, long) : 'today'}`;
    $('#me-kpis').innerHTML = `
      <div class="card kpi"><div class="label">Hours recorded</div><div class="value">${hrs(H)}</div><div class="sub">${list.length} session${list.length === 1 ? '' : 's'}</div></div>
      <div class="card kpi"><div class="label">Earned</div><div class="value">${php(P)}</div></div>
      <div class="card kpi"><div class="label">Marked paid</div><div class="value">${php(paid)}</div></div>
      <div class="card kpi"><div class="label">Last session</div><div class="value" style="font-size:18px">${fmtDate(list[0]?.date, long)}</div></div>`;
    $('#me-sessions').innerHTML = list.length
      ? `<table><thead><tr><th>Date</th><th>Location</th><th>Category</th><th class="num">Hours</th><th class="num">Earned</th></tr></thead><tbody>
        ${list.map((s) => `<tr><td>${weekday(s.date)} ${fmtDate(s.date)}</td><td>${esc(s.location || '—')}</td>
          <td><span class="pill">${esc(s.category)}</span></td><td class="num">${hrs(s.hours)}</td><td class="num">${php(s.php)}</td></tr>`).join('')}
        </tbody><tfoot><tr><td>Total · ${list.length} session${list.length === 1 ? '' : 's'}</td><td></td><td></td><td class="num">${hrs(H)} h</td><td class="num">${php(P)}</td></tr></tfoot></table>`
      : `<div class="empty">${all.length ? 'No sessions in this date range.' : 'No sessions yet.'}</div>`;
    history.replaceState(null, '', '#/me' + (range.from || range.to ? '?' + qs(range) : ''));
  };
  const set = (from, to) => { range.from = from; range.to = to; draw(); };
  $('#me-from').onchange = (e) => set(e.target.value, range.to);
  $('#me-to').onchange = (e) => set(range.from, e.target.value);
  $('#me-period').onchange = (e) => (e.target.value ? set(...e.target.value.split('|')) : set('', ''));
  view.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]')?.dataset.preset;
    if (preset) return set(...presets[preset]);
    const row = e.target.closest('tr[data-range]');
    if (row) { set(...row.dataset.range.split('|')); $('#me-sessions').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  draw();
}

// ---------- Users (admin) ----------
const ROLE_OPTIONS = [
  ['admin', 'Admin — everything'],
  ['sdr', 'SDR — dashboard & businesses'],
  ['set_director', 'Set Director — log hours (no amounts)'],
  ['recorder', 'Recorder — only their own hours & pay'],
];

async function users() {
  if (!isAdmin()) { view.innerHTML = '<div class="card empty">Admins only.</div>'; return; }
  const all = await api('/users');
  const pending = all.filter((u) => !u.approved);
  const list = all.filter((u) => u.approved);
  // Recorder logins are linked automatically: the recorder whose sheet email equals the login email.
  const emailMatch = (u) => !u.email_recorder_count
    ? '<span style="color:var(--warn)">no recorder in the sheet has this email</span>'
    : u.email_recorder_count > 1
      ? `<span style="color:var(--warn)">email used by ${u.email_recorder_count} recorders (${esc(u.email_recorders)}) — fix the sheet</span>`
      : `→ ${esc(u.email_recorders)}`;
  const linkNote = (u) => `<p class="muted" style="margin:0;font-size:13px">As a <b>Recorder</b>, this login sees only the recorder whose
    sheet email is <b>${esc(u.email)}</b>: ${emailMatch(u)}.</p>`;
  const roleCell = (u) => `<span class="pill ${u.role === 'admin' ? 'accent' : ''}">${esc(ROLE_LABEL[u.role] || u.role)}</span>${
    u.role === 'recorder' ? `<div class="muted" style="font-size:12px">${emailMatch(u)}</div>` : ''}`;
  view.innerHTML = `
    <div class="head"><div><h1>Users</h1><p>People sign up on the sign-in page; approve them here and choose what they can see.</p></div>
      <button class="primary" id="us-new">+ Add user</button></div>
    ${pending.length ? `<div class="section-head"><h2>Waiting for approval <span class="badge">${pending.length}</span></h2></div>
    <div class="table-wrap" style="margin-bottom:18px"><table><thead><tr><th>Name</th><th>Email</th><th>Matches recorder</th><th>Signed up</th><th></th></tr></thead><tbody>
    ${pending.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td>
      <td>${u.email_recorder_count === 1 ? `<span class="pill ok">${esc(u.email_recorders)}</span>` : `<span style="font-size:12px">${emailMatch(u)}</span>`}</td>
      <td>${new Date(u.created_at).toLocaleString()}</td>
      <td class="num"><button class="primary" data-approve="${u.id}">Approve</button> <button class="ghost danger" data-reject="${u.id}">Reject</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${list.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="pill accent">you</span>' : ''}</td><td>${esc(u.email)}</td>
      <td>${roleCell(u)}</td>
      <td><span class="pill ${u.active ? 'ok' : ''}">${u.active ? 'Active' : 'Disabled'}</span></td>
      <td>${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}</td>
      <td class="num"><button class="ghost" data-edit="${u.id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`;

  const roleFields = (role) => [{ name: 'role', label: 'Role', type: 'select', full: true, options: ROLE_OPTIONS, value: role }];

  view.addEventListener('click', async (e) => {
    const approveId = e.target.dataset.approve, rejectId = e.target.dataset.reject;
    if (!approveId && !rejectId) return;
    const u = pending.find((x) => String(x.id) === (approveId || rejectId));
    try {
      if (approveId) {
        const v = await modal({ title: `Approve ${u.name}`, submit: 'Approve',
          extra: linkNote(u),
          fields: roleFields(u.email_recorder_count === 1 ? 'recorder' : 'set_director') });
        if (!v) return;
        await api('/users/' + u.id, { method: 'PUT', body: { approved: true, ...v } });
        toast(`${u.name} approved`);
      } else {
        if (!confirm(`Reject and delete the sign-up from ${u.name} (${u.email})?`)) return;
        await api('/users/' + u.id, { method: 'DELETE' });
        toast('Sign-up rejected');
      }
      render();
    } catch (err) { toast(err.message, true); }
  });
  const pwHint = '<p class="muted" style="margin:0">Share the password with them privately; they can change it in Settings.</p>';
  $('#us-new').onclick = async () => {
    const v = await modal({ title: 'Add user', submit: 'Create', extra: pwHint, fields: [
      { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Temporary password (10+ chars)', type: 'password', required: true, full: true },
      ...roleFields('set_director'),
    ] });
    if (!v) return;
    try { await api('/users', { method: 'POST', body: v }); toast('User added'); render(); } catch (e) { toast(e.message, true); }
  };
  view.addEventListener('click', async (e) => {
    const id = e.target.dataset.edit; if (!id) return;
    const u = list.find((x) => String(x.id) === id);
    const v = await modal({ title: 'Edit user', extra: linkNote(u), fields: [
      { name: 'name', label: 'Name', value: u.name, required: true }, { name: 'email', label: 'Email', type: 'email', value: u.email, required: true },
      ...roleFields(u.role),
      { name: 'active', label: 'Status', type: 'select', options: [['true', 'Active'], ['false', 'Disabled']], value: String(u.active) },
      { name: 'password', label: 'Reset password (leave blank to keep)', type: 'password' },
    ] });
    if (!v) return;
    const body = { ...v, active: v.active === 'true' };
    if (!body.password) delete body.password;
    try { await api('/users/' + id, { method: 'PUT', body }); toast('Saved'); render(); } catch (err) { toast(err.message, true); }
  });
}

$('#logout').onclick = async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
};
boot();
