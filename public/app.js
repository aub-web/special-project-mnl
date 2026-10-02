// Studio Project Manila — single-page frontend. Each route is a function that renders into #view.

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
let view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const php = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  $('#nav-users').hidden = me.role !== 'admin';
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = me.role;
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
function modal({ title, fields, submit = 'Save', extra = '' }) {
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
    [cache.recorders, cache.locations, cache.settings] = await Promise.all([api('/recorders'), api('/locations'), api('/settings')]);
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
const routes = { '': dashboard, log, sessions, periods, period, recorders, locations, followups, settings, users, businesses, business };

async function render() {
  if (!me) return;
  const [route, ...args] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
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
  const fu = await api('/followups').catch(() => []);
  const n = fu.filter((f) => f.status !== 'Resolved').length;
  const b = $('#fu-badge');
  b.hidden = !n; b.textContent = n;
  if (me?.role === 'admin') {
    const p = (await api('/users/pending-count').catch(() => ({ n: 0 }))).n;
    const ub = $('#users-badge');
    ub.hidden = !p; ub.textContent = p;
  }
}
window.addEventListener('hashchange', render);

// ---------- Dashboard ----------
/** Show only the last 4 digits; the full number is one click away. */
const maskAcct = (n) => (n ? `<button class="ghost acct" data-acct="${esc(n)}" title="Click to show full number">•••• ${esc(String(n).slice(-4))}</button>` : '<span class="muted">—</span>');
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-acct]');
  if (b) { e.preventDefault(); e.stopPropagation(); b.textContent = b.dataset.acct; b.removeAttribute('data-acct'); }
}, true);

function businessCard(b) {
  const lastActive = [b.last_date, b.last_session].filter(Boolean).sort().at(-1);
  return `<a class="card biz" href="#/business/${b.id}">
    <div class="biz-head"><b>${esc(b.name)}</b>${b.active ? '' : ' <span class="pill">inactive</span>'}</div>
    <div class="biz-owner">${esc(b.owner_name || 'No owner on file')}</div>
    <div class="biz-bank"><span class="pill">${esc(b.bank_name || 'No bank')}</span> ${maskAcct(b.bank_account_no)}</div>
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
      <a class="btn primary" href="#/log">+ Log hours</a></div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Hours recorded</div><div class="value">${hrs(t.hours)}</div><div class="sub">${t.sessions} sessions</div></div>
      <div class="card kpi"><div class="label">Recorder payout</div><div class="value">${php(t.php)}</div><div class="sub">${usd(t.usd)}</div></div>
      <div class="card kpi"><div class="label">Business payout</div><div class="value">${php(bt.payout)}</div><div class="sub">${hrs(bt.shifts)} shifts · ${bt.businesses} businesses</div></div>
      <div class="card kpi"><div class="label">Recorders</div><div class="value">${t.recorders}</div><div class="sub">across ${t.locations} locations</div></div>
      <div class="card kpi"><div class="label">Needs attention</div><div class="value">${d.openFollowups}</div>
        <div class="sub"><a href="#/followups">follow-ups</a> · ${d.openPeriods} <a href="#/periods">open period(s)</a></div></div>
    </div>
    <div class="section-head"><h2>Businesses</h2>
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
      ${d.topRecorders.map((r) => `<tr><td><a href="#/sessions/${r.id}">${esc(r.name)}</a></td><td class="num">${r.days}</td><td class="num">${hrs(r.hours)}</td><td class="num">${php(r.php)}</td></tr>`).join('')}
      </tbody></table></div>`;
}

// ---------- Log hours (replaces the per-day sheet) ----------
async function log() {
  const { settings: s } = await lookups();
  const state = { rows: Array.from({ length: 6 }, () => ({ recorder: '', hours: '', notes: '' })) };
  view.innerHTML = `
    <div class="head"><div><h1>Log hours</h1><p>One day at one location — like a daily sheet. Rate ${usd(s.rate_usd)}/h · ₱${s.fx_rate}/$</p></div></div>
    <div class="card">
      <div class="toolbar">
        <label class="f">Date<input type="date" id="lg-date" value="${today()}"></label>
        <label class="f" style="flex:1;min-width:220px">Location<input id="lg-loc" list="dl-locations" placeholder="e.g. Bam Bam Chicken"></label>
        <label class="f">Category<select id="lg-cat">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      </div>
      <div class="log-rows" id="lg-rows"></div>
      <div style="margin-top:8px"><button id="lg-add" class="ghost">+ Add row</button></div>
      <div class="sumbar"><span class="muted">Total</span><b id="lg-h">0 h</b><b id="lg-p">₱0.00</b><button class="primary" id="lg-save">Save day</button></div>
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
    $('#lg-p').textContent = php(h * s.rate_usd * s.fx_rate);
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

// ---------- Sessions ----------
async function sessions(recorderId = '') {
  const { recorders: recs, locations: locs } = await lookups();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = { from: params.get('from') || '', to: params.get('to') || '', recorder_id: recorderId, location_id: '', category: '', q: '' };
  view.innerHTML = `
    <div class="head"><div><h1>Sessions</h1><p id="ss-sum" class="muted"></p></div><a class="btn primary" href="#/log">+ Log hours</a></div>
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
    const H = data.reduce((a, s) => a + s.hours, 0), P = data.reduce((a, s) => a + s.php, 0);
    $('#ss-sum').textContent = `${data.length} sessions · ${hrs(H)} h · ${php(P)}`;
    $('#ss-table').innerHTML = data.length ? `<table><thead><tr><th>Date</th><th>Recorder</th><th>Location</th><th>Category</th><th class="num">Hours</th><th class="num">USD</th><th class="num">PHP</th><th>Notes</th><th></th></tr></thead><tbody>
      ${data.map((s) => `<tr><td>${weekday(s.date)} ${fmtDate(s.date)}</td><td>${esc(s.recorder)}</td><td>${esc(s.location || '—')}</td>
        <td><span class="pill ${s.category === 'Studio' ? 'accent' : s.category === 'OT' ? 'warn' : ''}">${esc(s.category)}</span>${s.shift ? ` <span class="muted" style="font-size:12px">${esc(s.shift)}</span>` : ''}</td>
        <td class="num">${hrs(s.hours)}</td><td class="num">${usd(s.usd)}</td><td class="num">${php(s.php)}</td>
        <td class="muted">${esc(s.notes || '')}</td>
        <td class="num"><button class="ghost" data-edit="${s.id}">Edit</button><button class="ghost danger" data-del="${s.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No sessions match these filters.</div>';
  };
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
      { name: 'rate_usd', label: 'Rate (USD/h)', type: 'number', step: '0.01', value: s.rate_usd },
      { name: 'fx_rate', label: 'PHP per USD', type: 'number', step: '0.01', value: s.fx_rate },
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
  const list = await api('/periods');
  view.innerHTML = `
    <div class="head"><div><h1>Pay periods</h1><p>Each period generates the summary sheet automatically from logged sessions.</p></div>
      <div style="display:flex;gap:8px"><button id="pp-custom">Custom range</button><button class="primary" id="pp-new">+ New period</button></div></div>
    <div class="table-wrap"><table><thead><tr><th>Period</th><th>Dates</th><th>Status</th><th class="num">Recorders</th><th class="num">Hours</th><th class="num">Payout</th><th class="num">Marked paid</th><th>Notes</th></tr></thead><tbody>
    ${list.map((p) => `<tr><td><a href="#/period/${p.id}"><b>${esc(p.name)}</b></a></td><td>${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}</td>
      <td><span class="pill ${p.status === 'Open' ? 'warn' : 'ok'}">${esc(p.status)}</span></td>
      <td class="num">${p.recorders}</td><td class="num">${hrs(p.hours)}</td><td class="num">${php(p.php)}</td>
      <td class="num">${p.paid_php ? php(p.paid_php) : '<span class="muted">—</span>'}</td><td class="muted">${esc(p.notes || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
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
      <div class="card kpi"><div class="label">Payout</div><div class="value">${php(T.php)}</div><div class="sub">${usd(T.usd)}</div></div>
      ${p ? `<div class="card kpi"><div class="label">Paid</div><div class="value">${paidCount}/${sum.rows.length}</div><div class="sub">${php(T.paid_php)} sent</div></div>` : ''}`;
    if (!sum.rows.length) { $('#pd-table').innerHTML = '<div class="empty">No sessions in this range.</div>'; return; }
    $('#pd-table').innerHTML = `<table><thead><tr><th class="sticky-col">Name of recorder</th>
      ${sum.dates.map((d) => `<th class="num">${fmtDate(d)}<br><span style="font-weight:400">${weekday(d)}</span></th>`).join('')}
      <th class="num">Total h</th><th class="num">USD</th><th class="num">PH earned</th>${p ? '<th>Payment</th>' : ''}</tr></thead><tbody>
      ${sum.rows.map((r) => `<tr><td class="sticky-col"><a href="#/sessions/${r.recorder_id}?${qs({ from: filt.from, to: filt.to })}">${esc(r.name)}</a>
          <div class="muted" style="font-size:11px">${esc(r.locations.join(' · '))}</div></td>
        ${sum.dates.map((d) => `<td class="num ${r.by_date[d] ? '' : 'zero'}">${r.by_date[d] ? hrs(r.by_date[d]) : '0'}</td>`).join('')}
        <td class="num"><b>${hrs(r.hours)}</b></td><td class="num">${usd(r.usd)}</td><td class="num"><b>${php(r.php)}</b></td>
        ${p ? `<td>${payCell(r)}</td>` : ''}</tr>`).join('')}
      </tbody><tfoot><tr><td class="sticky-col">Total</td>${sum.dates.map((d) => `<td class="num">${hrs(T.by_date[d])}</td>`).join('')}
        <td class="num">${hrs(T.hours)}</td><td class="num">${usd(T.usd)}</td><td class="num">${php(T.php)}</td>${p ? '<td></td>' : ''}</tr></tfoot></table>`;
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
function contractPill(r) {
  if (!r.contract) return '<span class="pill warn">No contract</span>';
  const hard = (r.contract_hard_copy || '').toLowerCase();
  const link = /^https?:\/\//.test(r.contract) ? ` <a href="${esc(r.contract)}" target="_blank" rel="noopener">open</a>` : '';
  return `<span class="pill ok" title="${esc(r.contract)}">Signed</span>${link}${hard ? ` <span class="pill ${hard === 'done' ? 'ok' : 'warn'}">hard copy: ${esc(r.contract_hard_copy)}</span>` : ''}`;
}

async function recorders() {
  const [{ recorders: list }, s] = await Promise.all([lookups(true), api('/settings')]);
  const admin = me.role === 'admin';
  const noContract = list.filter((r) => !r.contract).length;
  view.innerHTML = `
    <div class="head"><div><h1>Recorders</h1><p>${list.length} people · ${s.recorder_synced_at ? `profiles synced from Google Sheet ${new Date(s.recorder_synced_at).toLocaleString()}` : 'profiles not synced yet'}</p></div>
      <div class="head-actions">${admin ? '<button id="rc-sync">⟳ Sync from Google Sheet</button>' : ''}<button class="primary" id="rc-new">+ Add recorder</button></div></div>
    <div class="toolbar">
      <label class="f" style="flex:1;min-width:180px">Search<input id="rc-q" placeholder="Name, email, contact, account…"></label>
      <label class="f">Show<select id="rc-f"><option value="">All recorders</option><option value="nocontract">No signed contract (${noContract})</option>
        <option value="nohard">Hard copy not yet</option><option value="inactive">Inactive</option></select></label>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Contact</th><th>Payment</th><th>Contract</th><th class="num">Hours</th><th class="num">Earned</th><th>Last</th><th></th></tr></thead>
    <tbody id="rc-body"></tbody></table></div>`;
  const draw = () => {
    const ql = $('#rc-q').value.toLowerCase(), f = $('#rc-f').value;
    const rows = list.filter((r) => {
      if (f === 'nocontract' && r.contract) return false;
      if (f === 'nohard' && !/not/i.test(r.contract_hard_copy || '')) return false;
      if (f === 'inactive' && r.active) return false;
      return !ql || [r.name, r.aliases, r.email, r.contact, r.payout_account_no, r.address].join(' ').toLowerCase().includes(ql);
    });
    $('#rc-body').innerHTML = rows.map((r) => `<tr>
      <td><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="pill">inactive</span>'}
        ${r.email ? `<div class="muted" style="font-size:12px">${esc(r.email)}</div>` : ''}${r.aliases ? `<div class="muted" style="font-size:11px">aka ${esc(r.aliases)}</div>` : ''}</td>
      <td>${r.contact ? `<a href="tel:${esc(r.contact)}">${esc(r.contact)}</a>` : '<span class="muted">—</span>'}</td>
      <td>${r.payment_method ? `<span class="pill">${esc(r.payment_method)}</span> ` : ''}${maskAcct(r.payout_account_no)}</td>
      <td>${contractPill(r)}</td>
      <td class="num">${hrs(r.hours)}</td><td class="num">${php(r.php)}</td><td>${fmtDate(r.last_date)}</td>
      <td class="num"><a class="btn ghost" href="#/sessions/${r.id}">Sessions</a><button class="ghost" data-edit="${r.id}">Edit</button><button class="ghost" data-merge="${r.id}">Merge…</button></td></tr>`).join('')
      || '<tr><td colspan="8" class="empty">No recorders match.</td></tr>';
  };
  $('#rc-q').oninput = draw;
  $('#rc-f').onchange = draw;
  $('#rc-new').onclick = async () => {
    const v = await modal({ title: 'Add recorder', fields: [{ name: 'name', label: 'Full name', required: true, full: true }] });
    if (v) { await api('/recorders', { method: 'POST', body: v }); render(); }
  };
  if (admin) $('#rc-sync').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Syncing…';
    try {
      const r = await api('/recorders/sync', { method: 'POST' });
      toast(`Synced ${r.rows} recorder profiles${r.created.length ? ` · ${r.created.length} new` : ''}`);
      render();
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = '⟳ Sync from Google Sheet'; }
  };
  $('#rc-body').addEventListener('click', async (e) => {
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
      { name: 'id_document', label: 'ID on file', value: r.id_document || '' },
      { name: 'contract', label: 'Signed contract', value: r.contract || '' },
      { name: 'contract_hard_copy', label: 'Contract hard copy', type: 'select', options: [['', '—'], ['done', 'done'], ['not yet', 'not yet']], value: (r.contract_hard_copy || '').toLowerCase() },
      { name: 'active', label: 'Status', type: 'select', options: [['true', 'Active'], ['false', 'Inactive']], value: String(r.active) },
      { name: 'notes', label: 'Notes', type: 'textarea', value: r.notes || '', full: true },
    ] });
    if (!v) return;
    try { await api('/recorders/' + id, { method: 'PUT', body: { ...v, active: v.active === 'true' } }); toast('Saved'); render(); }
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
function businessFields(b = {}, locs = []) {
  return [
    { name: 'name', label: 'Business name', value: b.name, required: true, full: true },
    { name: 'owner_name', label: "Owner's name", value: b.owner_name || '', full: true },
    { name: 'bank_name', label: 'Bank / wallet', value: b.bank_name || '' },
    { name: 'bank_account_no', label: 'Account no.', value: b.bank_account_no || '' },
    { name: 'account_name', label: 'Account name', value: b.account_name || '', full: true },
    { name: 'gcash_owner', label: 'GCash owner', value: b.gcash_owner || '', full: true },
    { name: 'location_id', label: 'Recorder location (for hours/recorders)', type: 'select', full: true,
      options: [['', '— none —'], ...locs.map((l) => [l.id, l.name])], value: b.location_id ?? '' },
    { name: 'active', label: 'Status', type: 'select', options: [['true', 'Active'], ['false', 'Inactive']], value: String(b.active ?? true) },
    { name: 'notes', label: 'Notes', type: 'textarea', value: b.notes || '', full: true },
  ];
}
const businessBody = (v) => ({ ...v, active: v.active === 'true', location_id: v.location_id ? Number(v.location_id) : null });

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
  $('#bz-new').onclick = async () => {
    const v = await modal({ title: 'Add business', fields: businessFields({}, locs) });
    if (!v) return;
    try { const b = await api('/businesses', { method: 'POST', body: businessBody(v) }); location.hash = '#/business/' + b.id; }
    catch (e) { toast(e.message, true); }
  };
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
      <p>${b.location ? `Recorders log hours here as <a href="#/sessions?${qs({ from: b.first_session, to: b.last_session })}">${esc(b.location)}</a>` : 'No recorder location linked'}</p></div>
      <div style="display:flex;gap:8px"><button id="bz-edit">Edit profile</button><button class="primary" id="bz-shift">+ Add shift</button></div></div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Business payout</div><div class="value">${php(b.payout)}</div><div class="sub">${hrs(b.shifts)} shifts</div></div>
      <div class="card kpi"><div class="label">Recorder hours</div><div class="value">${hrs(b.recorder_hours)}</div><div class="sub">${php(b.recorder_php)} to recorders</div></div>
      <div class="card kpi"><div class="label">Recorders</div><div class="value">${b.recorders}</div></div>
      <div class="card kpi"><div class="label">Active</div><div class="value" style="font-size:16px">${fmtDate(b.first_date || b.first_session)} – ${fmtDate([b.last_date, b.last_session].filter(Boolean).sort().at(-1))}</div></div>
    </div>
    <div class="grid two">
      <div class="card"><h2>Profile</h2><dl class="profile">
        ${row('Owner', esc(b.owner_name))}${row('Bank / wallet', esc(b.bank_name))}${row('Account no.', b.bank_account_no ? maskAcct(b.bank_account_no) : '')}
        ${row('Account name', esc(b.account_name))}${row('GCash owner', esc(b.gcash_owner))}${row('Notes', esc(b.notes))}
      </dl></div>
      <div class="card"><h2>Recorder activity</h2>
        ${b.recorder_log.length ? `<table><thead><tr><th>Date</th><th class="num">Recorders</th><th class="num">Hours</th><th class="num">Paid to recorders</th></tr></thead><tbody>
        ${b.recorder_log.map((r) => `<tr><td>${weekday(r.date)} ${fmtDate(r.date)}</td><td class="num">${r.recorders}</td><td class="num">${hrs(r.hours)}</td><td class="num">${php(r.php)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">No recorder sessions at the linked location.</p>'}</div>
    </div>
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
      { name: 'scenes', label: 'Scenes', type: 'number', step: '1', value: last?.scenes ?? 3, required: true },
      { name: 'rate_php', label: 'Rate (PHP)', type: 'number', step: '0.01', value: last?.rate_php ?? cache.settings?.business_rate_php ?? 850, required: true },
      { name: 'notes', label: 'Notes', full: true },
    ] });
    if (!v) return;
    try { await api('/business-shifts', { method: 'POST', body: { ...v, business_id: b.id } }); toast('Shift added'); render(); }
    catch (e) { toast(e.message, true); }
  };
  view.addEventListener('click', async (e) => {
    const sid = e.target.dataset.del; if (!sid) return;
    if (!confirm('Delete this shift?')) return;
    try { await api('/business-shifts/' + sid, { method: 'DELETE' }); render(); } catch (err) { toast(err.message, true); }
  });
}

// ---------- Settings ----------
async function settings() {
  const s = await api('/settings');
  const admin = me.role === 'admin';
  view.innerHTML = `
    <div class="head"><div><h1>Settings</h1><p>Defaults for new sessions. Existing sessions keep the rate they were logged with.</p></div></div>
    <div class="grid" style="max-width:520px">
      <form id="st-form" class="card grid">
        <h2>Rates${admin ? '' : ' <span class="muted" style="font-weight:400">(admins can change)</span>'}</h2>
        <label class="f">Recording rate (USD per hour)<input name="rate_usd" type="number" step="0.01" value="${s.rate_usd}" ${admin ? '' : 'disabled'}></label>
        <label class="f">Exchange rate (PHP per USD)<input name="fx_rate" type="number" step="0.01" value="${s.fx_rate}" ${admin ? '' : 'disabled'}></label>
        <p class="muted" style="margin:0">= <b id="st-php">${php(s.rate_usd * s.fx_rate)}</b> per hour</p>
        <label class="f">Business rate (PHP per shift × scene)<input name="business_rate_php" type="number" step="0.01" value="${s.business_rate_php}" ${admin ? '' : 'disabled'}></label>
        <label class="f">Business Google Sheet (ID or link)<input name="business_sheet_id" value="${esc(s.business_sheet_id)}" ${admin ? '' : 'disabled'}></label>
        <label class="f">Recorder Google Sheet (ID or link)<input name="recorder_sheet_id" value="${esc(s.recorder_sheet_id)}" ${admin ? '' : 'disabled'}></label>
        <label class="f">Auto-admin emails (become admin when they sign up)<input name="admin_emails" value="${esc(s.admin_emails)}" ${admin ? '' : 'disabled'}></label>
        ${admin ? '<div><button class="primary">Save rates</button></div>' : ''}
      </form>
      <form id="pw-form" class="card grid">
        <h2>Change my password</h2>
        <label class="f">Current password<input name="current" type="password" autocomplete="current-password" required></label>
        <label class="f">New password (10+ characters)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
        <div><button>Update password</button></div>
      </form>
    </div>`;
  const f = $('#st-form');
  f.oninput = () => ($('#st-php').textContent = php(f.rate_usd.value * f.fx_rate.value));
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(f)) });
      cache.recorders = null; toast('Settings saved');
    } catch (err) { toast(err.message, true); }
  };
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      e.target.reset(); toast('Password updated');
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- Users (admin) ----------
async function users() {
  if (me.role !== 'admin') { view.innerHTML = '<div class="card empty">Admins only.</div>'; return; }
  const all = await api('/users');
  const pending = all.filter((u) => !u.approved);
  const list = all.filter((u) => u.approved);
  view.innerHTML = `
    <div class="head"><div><h1>Users</h1><p>People sign up on the sign-in page; approve them here. Admins can also manage users and rates.</p></div>
      <button class="primary" id="us-new">+ Add user</button></div>
    ${pending.length ? `<div class="section-head"><h2>Waiting for approval <span class="badge">${pending.length}</span></h2></div>
    <div class="table-wrap" style="margin-bottom:18px"><table><thead><tr><th>Name</th><th>Email</th><th>Signed up</th><th></th></tr></thead><tbody>
    ${pending.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${new Date(u.created_at).toLocaleString()}</td>
      <td class="num"><button class="primary" data-approve="${u.id}">Approve</button> <button class="ghost danger" data-reject="${u.id}">Reject</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${list.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="pill accent">you</span>' : ''}</td><td>${esc(u.email)}</td>
      <td><span class="pill ${u.role === 'admin' ? 'accent' : ''}">${esc(u.role)}</span></td>
      <td><span class="pill ${u.active ? 'ok' : ''}">${u.active ? 'Active' : 'Disabled'}</span></td>
      <td>${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}</td>
      <td class="num"><button class="ghost" data-edit="${u.id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`;
  view.addEventListener('click', async (e) => {
    const approveId = e.target.dataset.approve, rejectId = e.target.dataset.reject;
    if (!approveId && !rejectId) return;
    const u = pending.find((x) => String(x.id) === (approveId || rejectId));
    try {
      if (approveId) {
        const v = await modal({ title: `Approve ${u.name}`, submit: 'Approve',
          extra: `<p class="muted" style="margin:0">${esc(u.email)} will be able to sign in and see all payout data.</p>`,
          fields: [{ name: 'role', label: 'Role', type: 'select', full: true, options: [['staff', 'Staff — log hours, sessions, payments'], ['admin', 'Admin — also users and rates']] }] });
        if (!v) return;
        await api('/users/' + u.id, { method: 'PUT', body: { approved: true, role: v.role } });
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
      { name: 'password', label: 'Temporary password (10+ chars)', type: 'password', required: true },
      { name: 'role', label: 'Role', type: 'select', options: [['staff', 'Staff'], ['admin', 'Admin']] },
    ] });
    if (!v) return;
    try { await api('/users', { method: 'POST', body: v }); toast('User added'); render(); } catch (e) { toast(e.message, true); }
  };
  view.addEventListener('click', async (e) => {
    const id = e.target.dataset.edit; if (!id) return;
    const u = list.find((x) => String(x.id) === id);
    const v = await modal({ title: 'Edit user', fields: [
      { name: 'name', label: 'Name', value: u.name, required: true }, { name: 'email', label: 'Email', type: 'email', value: u.email, required: true },
      { name: 'role', label: 'Role', type: 'select', options: [['staff', 'Staff'], ['admin', 'Admin']], value: u.role },
      { name: 'active', label: 'Status', type: 'select', options: [['true', 'Active'], ['false', 'Disabled']], value: String(u.active) },
      { name: 'password', label: 'Reset password (leave blank to keep)', type: 'password', full: true },
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
