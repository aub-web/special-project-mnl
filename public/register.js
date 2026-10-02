// Public recorder registration form. Needs the key from the link the studio shares (/register?k=…).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const root = $('#reg');
const key = new URLSearchParams(location.search).get('k') || '';

const MIN = { id: 1, esign: 1 }, MAX_PER_KIND = 2;
const files = { id: [], esign: [] };   // { name, type, size, data (dataURL), preview }

// Theme toggle (same as the app)
document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme-toggle')) return;
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('spl-theme', next); } catch {}
});

function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 3500);
}

/** Shrink big photos in the browser so uploads stay small (phone photos are often 3–8 MB). */
async function prepare(file) {
  const read = () => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });
  const isPhoto = /^image\/(jpeg|png|webp)$/.test(file.type);
  if (!isPhoto) {
    if (file.size > 4 * 1024 * 1024) throw new Error(`"${file.name}" is larger than 4 MB.`);
    return { name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: await read(), preview: null };
  }
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL('image/jpeg', 0.82);
  const size = Math.round((data.length - data.indexOf(',') - 1) * 0.75);
  return { name: file.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg', type: 'image/jpeg', size, data, preview: data };
}

const kb = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

function drawFiles(kind) {
  const list = files[kind], box = $(`#files-${kind}`), need = MIN[kind];
  box.innerHTML = list.map((f, i) => `<div class="reg-file">
      ${f.preview ? `<img src="${f.preview}" alt="">` : `<span class="reg-file-icon">${f.type === 'application/pdf' ? 'PDF' : 'FILE'}</span>`}
      <span class="reg-file-name">${esc(f.name)}<small>${kb(f.size)}</small></span>
      <button type="button" class="ghost" data-remove="${kind}:${i}" aria-label="Remove">✕</button></div>`).join('');
  const c = $(`#count-${kind}`);
  c.textContent = `${list.length} of ${MAX_PER_KIND} attached`;
  c.className = 'reg-count ' + (list.length >= need ? 'ok' : 'warn');
  // Hide the add button once the limit is reached.
  $(`input[data-kind=${kind}]`).closest('label').hidden = list.length >= MAX_PER_KIND;
}

function form() {
  root.innerHTML = `
    <form class="card reg-card" id="reg-form" novalidate>
      <h1>Recorder registration</h1>
      <p class="muted">Fill this in once so we can pay you. Your details are only visible to the studio admins.</p>

      <fieldset><legend>Your details</legend>
        <label class="f">Full name<input name="name" autocomplete="name" required placeholder="First name, middle initial, last name"></label>
        <label class="f">Email address<input name="email" type="email" autocomplete="email" required placeholder="you@gmail.com">
          <span class="hint">Use the same email if you sign in to the app later — that's how we match you to your hours.</span></label>
        <label class="f">Contact number<input name="contact" type="tel" inputmode="tel" autocomplete="tel" required placeholder="09XX XXX XXXX"></label>
        <label class="f">Home address<textarea name="address" rows="2" autocomplete="street-address" required placeholder="House no., street, barangay, city, province"></textarea></label>
      </fieldset>

      <fieldset><legend>How we pay you</legend>
        <div class="reg-methods" role="radiogroup" aria-label="Payment method">
          ${['GCash', 'PayMaya', 'Bank'].map((m) => `<label class="reg-method"><input type="radio" name="payment_method" value="${m}" required><span>${m}</span></label>`).join('')}
        </div>
        <label class="f" id="bank-name" hidden>Bank name<input name="bank_name" placeholder="e.g. BDO, BPI, UnionBank"></label>
        <label class="f">Account number<input name="account_no" inputmode="numeric" autocomplete="off" required placeholder="GCash/PayMaya number or bank account no."></label>
      </fieldset>

      <fieldset><legend>Valid ID <span class="reg-count" id="count-id"></span></legend>
        <p class="hint">Attach 1 or 2 photos/scans (e.g. front and back of your ID). JPG, PNG, HEIC or PDF.</p>
        <div class="reg-files" id="files-id"></div>
        <label class="btn reg-add">+ Add ID file<input type="file" data-kind="id" accept="image/*,application/pdf" multiple hidden></label>
      </fieldset>

      <fieldset><legend>E-signature <span class="reg-count" id="count-esign"></span></legend>
        <p class="hint">Attach 1 or 2 images of your signature (sign on white paper and take a photo).</p>
        <div class="reg-files" id="files-esign"></div>
        <label class="btn reg-add">+ Add signature file<input type="file" data-kind="esign" accept="image/*,application/pdf" multiple hidden></label>
      </fieldset>

      <input name="website" tabindex="-1" autocomplete="off" class="reg-hp" aria-hidden="true">
      <label class="reg-consent"><input type="checkbox" name="consent" required>
        <span>I confirm these details are correct, and I agree to Atlas Capture keeping them (including my ID) to process my payouts.</span></label>
      <p class="msg err" id="reg-err" hidden></p>
      <button class="primary reg-submit">Submit registration</button>
    </form>`;

  drawFiles('id'); drawFiles('esign');
  const f = $('#reg-form');
  f.addEventListener('change', async (e) => {
    if (e.target.name === 'payment_method') {
      $('#bank-name').hidden = e.target.value !== 'Bank';
      f.account_no.placeholder = e.target.value === 'Bank' ? 'Bank account number' : `${e.target.value} number (09…)`;
    }
    const kind = e.target.dataset?.kind;
    if (!kind) return;
    for (const file of [...e.target.files]) {
      if (files[kind].length >= MAX_PER_KIND) { toast(`You can attach up to ${MAX_PER_KIND} files here.`, true); break; }
      try { files[kind].push(await prepare(file)); } catch (err) { toast(err.message || `Couldn't read "${file.name}".`, true); }
    }
    e.target.value = '';
    drawFiles(kind);
  });
  f.addEventListener('click', (e) => {
    const r = e.target.closest('[data-remove]')?.dataset.remove;
    if (!r) return;
    const [kind, i] = r.split(':'); files[kind].splice(Number(i), 1); drawFiles(kind);
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#reg-err'), btn = f.querySelector('.reg-submit');
    const fail = (m) => { err.textContent = m; err.hidden = false; err.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    err.hidden = true;
    const v = Object.fromEntries(new FormData(f));
    if (!v.payment_method) return fail('Please choose how we should pay you.');
    for (const [kind, label] of [['id', 'valid ID'], ['esign', 'e-signature']]) {
      if (files[kind].length < MIN[kind]) return fail(`Please attach your ${label} (1 or 2 files).`);
    }
    if (!f.consent.checked) return fail('Please tick the confirmation box.');
    const total = [...files.id, ...files.esign].reduce((a, x) => a + x.size, 0);
    if (total > 5 * 1024 * 1024) return fail('The attachments are too large together (max 5 MB). Remove a file or use smaller photos.');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/public/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...v, consent: true, k: key,
          files: [...files.id.map((x) => ({ kind: 'id', ...x })), ...files.esign.map((x) => ({ kind: 'esign', ...x }))]
            .map(({ kind, name, data }) => ({ kind, name, data })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      done(v.name);
    } catch (ex) {
      fail(ex.message);
      btn.disabled = false; btn.textContent = 'Submit registration';
    }
  });
}

function done(name) {
  root.innerHTML = `<div class="card reg-card reg-done">
    <div class="reg-check">✓</div>
    <h1>Thank you, ${esc(String(name).split(' ')[0])}!</h1>
    <p>Your registration was sent. The studio will review it and get in touch if anything is missing.</p>
    <p class="muted">You can close this page now.</p></div>`;
  window.scrollTo(0, 0);
}

function invalid() {
  root.innerHTML = `<div class="card reg-card"><h1>Link not valid</h1>
    <p class="muted">This registration link has expired or is incomplete. Please ask the studio for the current link.</p></div>`;
}

(async () => {
  if (!key) return invalid();
  const r = await fetch('/api/public/register/check?k=' + encodeURIComponent(key)).then((x) => x.json()).catch(() => ({ valid: false }));
  r.valid ? form() : invalid();
})();
