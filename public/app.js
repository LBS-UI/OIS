/* NextGen Smart Classroom online portal. Configure /api on the same origin via Cloudflare Worker. */
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const state = {
  records: [],
  editingId: null,
  currentQR: null,
  apiReady: false,
  recordPage: 1,
  hasLoadedOnce: false,
  recordsLastFetched: 0
};

const categoryNames = {student:'Student', employee:'Employee / Client', visitor:'Visitor'};
const PAGE_SIZE = 10;
const RECORDS_STALE_MS = 60000;
const API_TIMEOUT_MS = 20000;
const SOUND_PREF_KEY = 'ng-sound-enabled';
const loginView = $('#loginView'), appView = $('#appView');

/* ============================================================
   NOTIFICATION SYSTEM — CONFIG + STATE
   ============================================================ */
const notifications = {
  config: {
    listUrl: '/notifications',
    readUrl: (id) => `/notifications/${encodeURIComponent(id)}/read`,
    readAllUrl: '/notifications/read-all',
    pollIntervalMs: 45000
  },
  state: {
    initialized: false,
    authenticated: false,
    available: true,
    items: [],
    unreadCount: 0,
    loading: false,
    inFlight: false,
    pollTimer: null,
    panelOpen: false,
    lastError: null,
    markAllSupported: true,
    seenIds: new Set(),
    firstFetchDone: false
  },
  els: {}
};

/* ============================================================
   NOTIFICATION SOUND — existing public/sounds/Notification Sound.mp3
   ============================================================ */
const NOTIFICATION_SOUND_PATH = '/sounds/Notification%20Sound.mp3';
const SOUND_COOLDOWN_MS = 1800;

const notificationSound = new Audio();
notificationSound.volume = 0.6;
notificationSound.preload = 'auto';
notificationSound.src = NOTIFICATION_SOUND_PATH;
let lastSoundAt = 0;
let soundLoadFailed = false;
notificationSound.addEventListener('error', () => {
  soundLoadFailed = true;
  console.warn('[NextGen] Notification sound failed to load at', NOTIFICATION_SOUND_PATH);
});

function isSoundEnabled() {
  try {
    const v = localStorage.getItem(SOUND_PREF_KEY);
    // Default on unless explicitly disabled
    return v !== '0';
  } catch {
    return true;
  }
}

function setSoundEnabled(on) {
  try { localStorage.setItem(SOUND_PREF_KEY, on ? '1' : '0'); } catch {}
  const btn = document.getElementById('enableSoundBtn');
  if (btn) btn.textContent = on ? '🔔 Notification Sounds Enabled' : '🔕 Enable sound';
}

async function playNotificationSound() {
  if (!isSoundEnabled()) return;
  if (soundLoadFailed) return;
  const now = Date.now();
  if (now - lastSoundAt < SOUND_COOLDOWN_MS) return; // debounce duplicates
  lastSoundAt = now;
  try {
    notificationSound.currentTime = 0;
    await notificationSound.play();
  } catch (error) {
    // Common when tab is backgrounded or autoplay policy blocks audio
    console.warn('Notification sound could not play:', error && error.message ? error.message : error);
  }
}

// Restore sound preference UI
try {
  setSoundEnabled(isSoundEnabled());
} catch {}

document.getElementById('enableSoundBtn')?.addEventListener('click', async () => {
  try {
    notificationSound.currentTime = 0;
    await notificationSound.play();
    notificationSound.pause();
    notificationSound.currentTime = 0;
    setSoundEnabled(true);
    toast('Notification sound enabled');
  } catch (error) {
    console.error('Could not enable sound:', error);
    toast('Could not unlock sound — interact with the page and try again');
  }
});

/* ============================================================
   HELPERS
   ============================================================ */
function esc(value='') {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function toast(message) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeout) > 0 ? Number(options.timeout) : API_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        ...(options.body ? {'Content-Type':'application/json'} : {}),
        ...(options.headers || {})
      }
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error(data.error || `Request failed (${res.status})`);
      e.status = res.status;
      e.code = data.code || null;
      e.operationId = data.operationId || data.requestId || null;
      e.stage = data.stage || null;
      e.deletedOk = data.deletedOk;
      e.success = data.success;
      throw e;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('Request timed out. Check your connection.');
      e.status = 0;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function setConnection(ok, text) {
  const isOffline = !navigator.onLine;
  const dot = $('#connectionDot'), ct = $('#connectionText');
  if (dot) dot.classList.toggle('online', ok && !isOffline);
  if (ct) ct.textContent = isOffline ? 'Offline' : text;
  const as = $('#apiStatus'), at = $('#apiTag'), ab = $('#apiBullet');
  if (as) as.textContent = ok ? 'Connected to Cloudflare Worker API' : 'Worker API not connected';
  if (at) { at.textContent = ok ? 'Connected' : 'Setup needed'; at.classList.toggle('ok', ok); }
  if (ab) ab.style.background = ok ? '#2db98e' : '#e1a342';
}

function updateOnlineStatus() {
  const dot = $('#connectionDot'), ct = $('#connectionText');
  if (!dot || !ct) return;
  if (!navigator.onLine) {
    dot.classList.remove('online');
    ct.textContent = 'Offline';
  } else if (state.apiReady) {
    dot.classList.add('online');
    ct.textContent = 'Cloud connected';
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

function showLogin() {
  loginView?.classList.remove('hidden');
  appView?.classList.add('hidden');
  $('#logoutBtn')?.classList.add('hidden');
  try { onLoggedOut(); } catch (e) { console.warn('[NextGen] onLoggedOut:', e); }
}

function showApp() {
  loginView?.classList.add('hidden');
  appView?.classList.remove('hidden');
  $('#logoutBtn')?.classList.remove('hidden');
  try { onAuthenticated(); } catch (e) { console.warn('[NextGen] onAuthenticated:', e); }
}

async function checkSession() {
  // Clear the HTML placeholder immediately so status never sticks on "Checking connection"
  if (!navigator.onLine) {
    setConnection(false, 'Offline');
  } else {
    setConnection(false, 'Connecting…');
  }

  // Always show the app directly (no homepage / login wall)
  showApp();
  try { navigate('home'); } catch (e) { console.warn('[NextGen] navigate:', e); }

  try {
    await api('/me');
    state.apiReady = true;
    setConnection(true, 'Cloud connected');
  } catch (e) {
    if (!navigator.onLine) {
      state.apiReady = false;
      setConnection(false, 'Offline');
    } else if (e && (e.status === 401 || e.status === 403)) {
      // Worker is up; user is simply not signed in
      state.apiReady = true;
      setConnection(true, 'Open registration');
      const logout = $('#logoutBtn');
      if (logout) logout.classList.add('hidden');
    } else {
      state.apiReady = false;
      setConnection(false, 'API unavailable');
    }
  }

  try {
    await loadRecords();
  } catch (e) {
    console.warn('[NextGen] loadRecords:', e);
  }
}

function navigate(page) {
  const recModal = $('#recordModal'); if (recModal?.open) recModal.close();
  const qrModal = $('#qrModal'); if (qrModal?.open) qrModal.close();

  const pages = ['home','register','records','scores','scan'];
  if (!pages.includes(page)) page = 'home';

  $$('.page').forEach(el => el.classList.toggle('hidden', el.id !== `page-${page}`));
  $$('.nav-link[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));

  const pt = $('#pageTitle');
  if (pt) pt.textContent = ({
    home: 'Overview',
    register: state.editingId ? 'Edit registration' : 'Registration',
    records: 'Records & reports',
    scores: 'Edit scores',
    scan: 'QR lookup'
  })[page];

  $('#sidebar')?.classList.remove('open');

  if (page === 'records') renderRecords();
  if (page === 'home') renderHome();
  if (page === 'register' && !state.editingId) {
    const fh = $('#formHeading');
    if (fh) fh.textContent = 'Create a registration';
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('[data-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page)));
$$('[data-goto]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.goto === 'register') resetForm();
  navigate(b.dataset.goto);
}));
$('#menuBtn')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));

/* ============================================================
   LOGIN / LOGOUT
   ============================================================ */
$('#loginForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  const msg = $('#loginMessage');
  if (msg) msg.textContent = 'Signing in…';
  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password')
      })
    });
    if (msg) msg.textContent = '';
    state.apiReady = true;
    setConnection(true, 'Cloud connected');
    showApp();
    await loadRecords();
    toast('Signed in successfully');
  } catch (err) {
    if (msg) msg.textContent = err.message === 'Failed to fetch'
      ? 'Cannot reach the Worker API. Check deployment setup.'
      : err.message;
  }
});

$('#logoutBtn')?.addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch {}
  state.records = [];
  state.hasLoadedOnce = false;
  state.recordsLastFetched = 0;
  resetRecordsView();
  showLogin();
  toast('Signed out');
});

/* ============================================================
   REGISTRATION FORM
   ============================================================ */
function resetForm() {
  state.editingId = null;
  $('#recordForm')?.reset();
  if ($('#formHeading')) $('#formHeading').textContent = 'Create a registration';
  if ($('#saveBtn')) $('#saveBtn').innerHTML = 'Save registration <span>→</span>';
  const fm = $('#formMessage'); if (fm) { fm.textContent = ''; fm.className = 'form-message'; }
  if ($('#qrPreview')) $('#qrPreview').innerHTML = '<div class="qr-placeholder">▦</div>';
  if ($('#qrTitle')) $('#qrTitle').textContent = 'QR code appears after saving';
  if ($('#qrDescription')) $('#qrDescription').textContent = "A random identifier will be assigned to the saved record. The QR will not contain the participant's personal details.";
  if ($('#downloadQr')) $('#downloadQr').disabled = true;
  if ($('#printQr')) $('#printQr').disabled = true;
  state.currentQR = null;
  updateCategoryFields();
}
$('#clearForm')?.addEventListener('click', resetForm);

function updateCategoryFields() {
  const catEl = $('#category');
  if (!catEl) return;
  const cat = catEl.value;
  $('#gradeField')?.classList.toggle('hidden', cat !== 'student');
  $('#sectionField')?.classList.toggle('hidden', cat !== 'student');
  $('#schoolField')?.classList.toggle('hidden', cat !== 'student');
  $('#officeField')?.classList.toggle('hidden', cat === 'student');
  $('#positionField')?.classList.toggle('hidden', cat === 'student');
  const pcSpan = $('#pcField')?.querySelector('span');
  if (pcSpan) pcSpan.classList.toggle('hidden', cat !== 'student');
  const pcInput = $('#pcField')?.querySelector('input');
  if (pcInput) pcInput.required = cat === 'student';
}
$('#category')?.addEventListener('change', updateCategoryFields);

function readRecordForm() {
  const f = new FormData($('#recordForm'));
  const category = f.get('category');
  const n = v => v === '' ? null : Number(v);
  return {
    category,
    pcNumber: String(f.get('pcNumber')).trim(),
    fullName: String(f.get('fullName')).trim(),
    grade: category === 'student' ? String(f.get('grade') || '').trim() : null,
    section: category === 'student' ? String(f.get('section') || '').trim() : null,
    school: category === 'student' ? String(f.get('school') || '').trim() : null,
    office: category !== 'student' ? String(f.get('office') || '').trim() : null,
    position: category !== 'student' ? String(f.get('position') || '').trim() : null,
    preTest: n(f.get('preTest')),
    postTest: n(f.get('postTest')),
    feedback: String(f.get('feedback') || '').trim()
  };
}

$('#recordForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#formMessage');
  const data = readRecordForm();

  if ((data.category === 'student' && !data.pcNumber) || !data.fullName) {
    if (msg) msg.textContent = data.category === 'student'
      ? 'PC Number and full name are required.'
      : 'Full name is required.';
    return;
  }
  if ((data.preTest !== null && (!Number.isFinite(data.preTest) || data.preTest < 0)) ||
      (data.postTest !== null && (!Number.isFinite(data.postTest) || data.postTest < 0))) {
    if (msg) msg.textContent = 'Scores must be valid non-negative numbers.';
    return;
  }

  const btn = $('#saveBtn');
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = 'Saving to cloud…';

  try {
    const result = state.editingId
      ? await api(`/records/${encodeURIComponent(state.editingId)}`, { method: 'PATCH', body: JSON.stringify(data) })
      : await api('/records', { method: 'POST', body: JSON.stringify(data) });
    const record = result.record;
    if (msg) { msg.textContent = 'Record saved successfully.'; msg.className = 'form-message success'; }
    if (record?.qrToken) await displayQR(record.qrToken);
    state.editingId = record?.id || state.editingId;
    if ($('#formHeading')) $('#formHeading').textContent = 'Registration saved';
    if (btn) btn.innerHTML = 'Save changes <span>→</span>';
    await loadRecords();
    toast('Registration saved to cloud');
    refreshNotifications();
  } catch (err) {
    if (msg) msg.textContent = err.message === 'Failed to fetch'
      ? 'Could not reach the database API. Check the Cloudflare Worker setup.'
      : err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
});

/* ============================================================
   QR GENERATION — shared helper
   ============================================================ */
async function renderQRInto(container, token, size = 180) {
  if (!container) return null;
  container.replaceChildren();
  if (!token) {
    const placeholder = document.createElement('div');
    placeholder.className = 'qr-placeholder';
    placeholder.textContent = '▦';
    container.appendChild(placeholder);
    return null;
  }
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  try {
    if (window.QRCode?.toCanvas) {
      await QRCode.toCanvas(canvas, token, { width: size, margin: 1, errorCorrectionLevel: 'M' });
      return canvas;
    }
    if (window.QRCode) {
      container.replaceChildren();
      new QRCode(container, { text: token, width: size, height: size });
      return container.querySelector('canvas');
    }
    throw new Error('QR library unavailable');
  } catch {
    container.replaceChildren();
    container.textContent = token;
    return null;
  }
}

async function displayQR(token) {
  state.currentQR = token || null;
  const preview = $('#qrPreview');
  if (!preview) return;
  await renderQRInto(preview, token, 160);
  if ($('#qrTitle')) $('#qrTitle').textContent = token ? 'Participant QR is ready' : 'QR code appears after saving';
  if ($('#qrDescription')) $('#qrDescription').textContent = token
    ? 'Token: ' + token
    : "A random identifier will be assigned to the saved record. The QR will not contain the participant's personal details.";
  if ($('#downloadQr')) $('#downloadQr').disabled = !token;
  if ($('#printQr')) $('#printQr').disabled = !token;
}

$('#downloadQr')?.addEventListener('click', () => {
  const canvas = $('#qrPreview canvas');
  if (!canvas) { toast('QR image is not available'); return; }
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `nextgen-qr-${(state.currentQR || 'participant').slice(0, 8)}.png`;
  a.click();
});

$('#printQr')?.addEventListener('click', () => {
  if (!state.currentQR) { toast('QR is not ready yet'); return; }
  const fd = new FormData($('#recordForm'));
  printQR({
    fullName: String(fd.get('fullName') || '').trim() || 'Participant',
    pcNumber: String(fd.get('pcNumber') || '').trim(),
    category: String(fd.get('category') || ''),
    qrToken: state.currentQR
  });
});

function printQR(record) {
  if (!record || !record.qrToken) { toast('QR is not available'); return; }
  const sourceCanvas = $('#qrModalBody canvas') || $('#qrPreview canvas');
  if (!sourceCanvas) { toast('QR image is not ready'); return; }

  const dataUrl = sourceCanvas.toDataURL('image/png');
  const cat = categoryNames[record.category] || record.category || '';
  const metaParts = [cat];
  if (record.pcNumber) metaParts.push('PC ' + record.pcNumber);

  const w = window.open('', '_blank', 'width=640,height=820');
  if (!w) { toast('Allow pop-ups to print the QR code'); return; }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>QR — ${esc(record.fullName || 'Participant')}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;text-align:center;padding:40px 24px;color:#0a1f33;margin:0}
  h1{font-size:20px;margin:0 0 6px;font-weight:800}
  .meta{color:#5b7084;font-size:13px;margin:0 0 26px}
  img{display:block;margin:0 auto 20px;max-width:300px;width:100%;height:auto;border-radius:6px}
  .token{font-family:'Courier New',monospace;font-size:10px;color:#7c8c9c;word-break:break-all;max-width:320px;margin:0 auto}
  @media print{body{padding:24px}h1{font-size:18px}img{max-width:280px}}
</style></head>
<body>
  <h1>${esc(record.fullName || 'Participant')}</h1>
  <p class="meta">${esc(metaParts.filter(Boolean).join(' · '))}</p>
  <img src="${dataUrl}" alt="QR code">
  <p class="token">${esc(record.qrToken)}</p>
  <script>window.onload=function(){setTimeout(function(){try{window.focus();window.print()}catch(e){}},300)}<\/script>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* ============================================================
   RECORDS DASHBOARD — load, filter, sort, paginate, view
   ============================================================ */
async function loadRecords(opts = {}) {
  const tableEl = $('#recordsTable');
  if (tableEl && !state.hasLoadedOnce) {
    tableEl.innerHTML = '<div class="table-loading">Loading records…</div>';
  }
  try {
    const archView = $('#filterArchived')?.value || 'active';
    let qs = '';
    if (archView === 'archived') qs = '?archived=only';
    else if (archView === 'all') qs = '?include_archived=1';
    // default: active only (server excludes archived)
    const result = await api('/records' + qs);
    state.records = Array.isArray(result.records) ? result.records : [];
    if (result.dataGeneration != null && window.OfflineDB) {
      try {
        const localGen = await OfflineDB.getDataGeneration();
        const serverGen = parseInt(String(result.dataGeneration), 10);
        if (Number.isFinite(serverGen) && serverGen > localGen) {
          await OfflineDB.clearQueue();
          await OfflineDB.clearCachedRecords();
          await OfflineDB.setDataGeneration(serverGen);
        } else if (Number.isFinite(serverGen)) {
          await OfflineDB.setDataGeneration(serverGen);
        }
      } catch (_) {}
    }
    state.apiReady = true;
    state.hasLoadedOnce = true;
    state.recordsLastFetched = Date.now();
    // Keep prior auth-based label if already set to Open registration; otherwise show connected
    const ct = $('#connectionText')?.textContent || '';
    if (ct !== 'Open registration') setConnection(true, 'Cloud connected');
    populateSectionFilter();
    renderRecords();
    renderHome(); // updates total / category counts (shows 0 when empty)
    updateRecordsUpdatedIndicator();
  } catch (e) {
    if (e.status === 401) {
      // Session required for this filter view; still clear loading state and show zeros
      state.records = state.records || [];
      renderHome();
      return;
    }
    state.apiReady = false;
    if (!navigator.onLine) setConnection(false, 'Offline');
    else setConnection(false, 'API unavailable');
    renderHome(); // keep counts consistent (previous data or empty)
    if (tableEl) {
      tableEl.innerHTML = `<div class="empty-state">
        <span class="empty-symbol">!</span>
        <b>Could not load records</b>
        <p>${esc(e.message || 'Request failed')}</p>
        <button type="button" class="btn secondary small" id="retryLoadRecords" style="margin-top:10px">Try again</button>
      </div>`;
      $('#retryLoadRecords')?.addEventListener('click', () => loadRecords({ force: true }));
    }
  }
}

function updateRecordsUpdatedIndicator() {
  const el = $('#recordsUpdated');
  if (!el) return;
  const t = state.recordsLastFetched;
  if (!t) { el.textContent = ''; return; }
  const diff = Date.now() - t;
  let label;
  if (diff < 10000) label = 'just now';
  else if (diff < 60000) label = Math.floor(diff / 1000) + 's ago';
  else if (diff < 3600000) label = Math.floor(diff / 60000) + 'm ago';
  else label = new Date(t).toLocaleTimeString();
  el.textContent = 'Updated ' + label;
}
setInterval(updateRecordsUpdatedIndicator, 15000);

// Cross-device sync — refresh when the tab returns and data is stale
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!state.apiReady) return;
  if (Date.now() - state.recordsLastFetched < RECORDS_STALE_MS) return;
  loadRecords();
});

// Manual refresh button
$('#refreshRecordsBtn')?.addEventListener('click', () => {
  const btn = $('#refreshRecordsBtn');
  if (btn) btn.disabled = true;
  loadRecords().finally(() => { if (btn) btn.disabled = false; });
});

function populateSectionFilter() {
  const select = $('#filterSection');
  if (!select) return;
  const current = select.value || 'all';
  const sections = [...new Set(state.records.map(r => r.section).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = 'All sections';
  select.appendChild(all);
  for (const sec of sections) {
    const o = document.createElement('option');
    o.value = sec;
    o.textContent = sec;
    select.appendChild(o);
  }
  select.value = (current === 'all' || sections.includes(current)) ? current : 'all';
}

function getFilteredRecords() {
  const query = ($('#searchInput')?.value || '').trim().toLowerCase();
  const catFilter = $('#filterCategory')?.value || 'all';
  const secFilter = $('#filterSection')?.value || 'all';
  const sortBy = $('#sortBy')?.value || 'newest';

  const list = state.records.filter(r => {
    if (catFilter !== 'all' && r.category !== catFilter) return false;
    if (secFilter !== 'all' && (r.section || '') !== secFilter) return false;
    if (query) {
      const hay = [r.pcNumber, r.fullName, r.grade, r.section, r.school, r.office, r.position]
        .map(v => String(v || '').toLowerCase());
      if (!hay.some(v => v.includes(query))) return false;
    }
    return true;
  });

  list.sort((a, b) => {
    switch (sortBy) {
      case 'oldest':    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      case 'name-asc':  return String(a.fullName || '').localeCompare(String(b.fullName || ''));
      case 'name-desc': return String(b.fullName || '').localeCompare(String(a.fullName || ''));
      case 'pc-asc':    return String(a.pcNumber || '').localeCompare(String(b.pcNumber || ''));
      default:          return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    }
  });

  return list;
}

function renderRecords() {
  const list = getFilteredRecords();
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.recordPage > totalPages) state.recordPage = totalPages;
  if (state.recordPage < 1) state.recordPage = 1;

  const start = (state.recordPage - 1) * PAGE_SIZE;
  const pageRecords = list.slice(start, start + PAGE_SIZE);

  if ($('#recordCount')) $('#recordCount').textContent = `${total} record${total === 1 ? '' : 's'}`;

  const tableEl = $('#recordsTable');
  if (!tableEl) return;

  if (pageRecords.length === 0) {
    const title = state.records.length ? 'No matching records' : 'No records yet';
    const sub = state.records.length
      ? 'Try another search or clear the filters.'
      : 'Register a participant to start building your records.';
    tableEl.innerHTML = `<div class="empty-state"><span class="empty-symbol">▤</span><b>${title}</b><p>${sub}</p></div>`;
    $('#pagination')?.replaceChildren();
    return;
  }

  // Fixed: use PAGE_SIZE not an undefined state.pageSize
  const startIdx = (state.recordPage - 1) * PAGE_SIZE + 1;
  const rows = pageRecords.map((r, i) => recordRow(r, startIdx + i)).join('');
  tableEl.innerHTML = `<div class="sheet-wrap"><table class="sheet"><thead><tr>
    <th class="row-num">#</th><th>PC Number</th><th>Full Name</th><th>Section</th>
    <th>Pre-test</th><th>Post-test</th><th>Category</th><th>Date</th><th>Actions</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
  bindSheetEditing();

  $$('[data-view]').forEach(b => b.addEventListener('click', () => viewRecord(b.dataset.view)));
  $$('[data-edit]').forEach(b => b.addEventListener('click', () => editRecord(b.dataset.edit)));
  $$('[data-qr]').forEach(b => b.addEventListener('click', () => viewRecordQR(b.dataset.qr)));
  $$('[data-delete]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this record permanently? This cannot be undone.')) return;
    try {
      await api('/records/' + encodeURIComponent(b.dataset.delete), { method: 'DELETE' });
      toast('Record deleted');
      await loadRecords();
      refreshNotifications();
    } catch (err) { toast(err.message); }
  }));

  renderPagination(totalPages);
}

function recordRow(r, idx) {
  return `<tr data-id="${esc(r.id)}">
    <td class="row-num">${idx}</td>
    <td>${esc(r.pcNumber || '—')}</td>
    <td title="${esc(r.fullName)}">${esc(r.fullName)}</td>
    <td>${esc(r.section || r.office || '—')}</td>
    <td class="cell-edit" data-field="preTest" data-id="${esc(r.id)}" tabindex="0">${r.preTest ?? ''}</td>
    <td class="cell-edit" data-field="postTest" data-id="${esc(r.id)}" tabindex="0">${r.postTest ?? ''}</td>
    <td>${categoryChip(r.category)}</td>
    <td>${esc(r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—')}</td>
    <td class="actions">
      <button data-view="${esc(r.id)}">View</button>
      <button data-qr="${esc(r.id)}">QR</button>
      <button data-delete="${esc(r.id)}" class="danger">Delete</button>
    </td>
  </tr>`;
}

function bindSheetEditing() {
  $$('.cell-edit').forEach(cell => {
    cell.addEventListener('click', () => startCellEdit(cell));
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); startCellEdit(cell); }
    });
  });
  $$('.sheet tbody tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      $$('.sheet tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
    });
  });
}

function startCellEdit(cell) {
  if (cell.querySelector('input')) return;
  const original = cell.textContent.trim();
  const field = cell.dataset.field;
  const id = cell.dataset.id;
  const input = document.createElement('input');
  input.className = 'cell-input';
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.value = original;
  cell.textContent = '';
  cell.appendChild(input);
  input.focus();
  input.select();

  const cancel = () => { cell.textContent = original; };
  const save = async () => {
    const val = input.value.trim();
    const num = val === '' ? null : Number(val);
    if (val !== '' && (!Number.isFinite(num) || num < 0)) {
      toast('Score must be a non-negative number');
      input.focus();
      return;
    }
    cell.textContent = '…';
    try {
      const rec = state.records.find(r => r.id === id);
      const payload = {
        preTest: field === 'preTest' ? num : (rec?.preTest ?? null),
        postTest: field === 'postTest' ? num : (rec?.postTest ?? null)
      };
      const result = await api('/records/' + encodeURIComponent(id) + '/scores', {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      const updated = result.record;
      const idx = state.records.findIndex(r => r.id === id);
      if (idx >= 0) state.records[idx] = updated;
      cell.textContent = (field === 'preTest' ? updated.preTest : updated.postTest) ?? '';
      toast('Score saved');
    } catch (err) {
      cell.textContent = original;
      toast(err.status === 401 ? 'Sign in required to edit scores' : err.message);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => {
    if (cell.contains(input)) save();
  });
}

function renderPagination(totalPages) {
  const el = $('#pagination');
  if (!el) return;
  el.replaceChildren();
  if (totalPages <= 1) return;

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.textContent = '‹';
  prev.setAttribute('aria-label', 'Previous page');
  prev.disabled = state.recordPage <= 1;
  prev.addEventListener('click', () => { state.recordPage--; renderRecords(); });
  el.appendChild(prev);

  const current = state.recordPage;
  let startPage = Math.max(1, current - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

  if (startPage > 1) {
    addPageBtn(el, 1);
    if (startPage > 2) {
      const d = document.createElement('span');
      d.className = 'page-info';
      d.textContent = '…';
      el.appendChild(d);
    }
  }
  for (let p = startPage; p <= endPage; p++) addPageBtn(el, p);
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      const d = document.createElement('span');
      d.className = 'page-info';
      d.textContent = '…';
      el.appendChild(d);
    }
    addPageBtn(el, totalPages);
  }

  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = '›';
  next.setAttribute('aria-label', 'Next page');
  next.disabled = state.recordPage >= totalPages;
  next.addEventListener('click', () => { state.recordPage++; renderRecords(); });
  el.appendChild(next);

  function addPageBtn(parent, page) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = String(page);
    btn.setAttribute('aria-label', `Page ${page}`);
    if (page === current) { btn.classList.add('current'); btn.setAttribute('aria-current', 'page'); }
    btn.addEventListener('click', () => { state.recordPage = page; renderRecords(); });
    parent.appendChild(btn);
  }
}

function viewRecord(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  const modal = $('#recordModal'), body = $('#recordModalBody'), titleEl = $('#recordModalTitle');
  if (!modal || !body) return;

  if (titleEl) titleEl.textContent = r.fullName || 'Participant record';
  body.replaceChildren();

  const grid = document.createElement('div');
  grid.className = 'detail-grid';

  const fields = [
    ['Category', categoryNames[r.category] || r.category || '—'],
    ['PC Number', r.pcNumber || '—'],
    ['Full Name', r.fullName || '—']
  ];
  if (r.category === 'student') {
    fields.push(['Grade / Year level', r.grade || '—']);
    fields.push(['Section', r.section || '—']);
    fields.push(['School', r.school || '—']);
  } else {
    fields.push(['Office / Department', r.office || '—']);
    fields.push(['Position', r.position || '—']);
  }
  fields.push(['Pre-test score', r.preTest ?? '—']);
  fields.push(['Post-test score', r.postTest ?? '—']);
  fields.push(['Feedback', r.feedback || '—']);
  fields.push(['Registered', r.createdAt ? new Date(r.createdAt).toLocaleString() : '—']);
  fields.push(['QR token', r.qrToken || '—']);

  for (const [label, value] of fields) {
    const item = document.createElement('div');
    item.className = 'detail-item';
    const small = document.createElement('small');
    small.textContent = label;
    const b = document.createElement('b');
    b.textContent = String(value);
    item.appendChild(small);
    item.appendChild(b);
    grid.appendChild(item);
  }
  body.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'record-modal-actions';

  if (r.qrToken) {
    const qrBtn = document.createElement('button');
    qrBtn.type = 'button';
    qrBtn.className = 'btn secondary';
    qrBtn.textContent = 'Show QR';
    qrBtn.addEventListener('click', () => { modal.close(); viewRecordQR(id); });
    actions.appendChild(qrBtn);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn primary';
  editBtn.textContent = 'Edit record';
  editBtn.addEventListener('click', () => { modal.close(); editRecord(id); });
  actions.appendChild(editBtn);
  body.appendChild(actions);

  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
}

async function viewRecordQR(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  const modal = $('#qrModal');
  if (!modal) { toast('QR viewer not available'); return; }

  const titleEl = $('#qrModalTitle'), subEl = $('#qrModalSub'), bodyEl = $('#qrModalBody');
  const tokenEl = $('#qrModalToken'), printBtn = $('#qrModalPrint'), dlBtn = $('#qrModalDownload');

  state.currentQR = r.qrToken || null;

  if (titleEl) titleEl.textContent = r.fullName || 'Participant';
  if (subEl) {
    const parts = [categoryNames[r.category] || r.category];
    if (r.pcNumber) parts.push('PC ' + r.pcNumber);
    subEl.textContent = parts.filter(Boolean).join(' · ');
  }
  if (tokenEl) tokenEl.textContent = r.qrToken ? 'Token: ' + r.qrToken : '';

  if (bodyEl) {
    if (r.qrToken) {
      await renderQRInto(bodyEl, r.qrToken, 220);
    } else {
      bodyEl.replaceChildren();
      const ph = document.createElement('div');
      ph.className = 'empty-state';
      ph.innerHTML = '<span class="empty-symbol">▦</span><b>QR not available</b><p>This record has no QR token. Open the record and save it to generate one.</p>';
      bodyEl.appendChild(ph);
    }
  }

  const hasQR = !!r.qrToken;
  if (printBtn) printBtn.disabled = !hasQR;
  if (dlBtn) dlBtn.disabled = !hasQR;

  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
}

$('#qrModalClose')?.addEventListener('click', () => $('#qrModal')?.close());
$('#qrModal')?.addEventListener('click', (e) => { if (e.target === $('#qrModal')) $('#qrModal').close(); });
$('#qrModalPrint')?.addEventListener('click', () => {
  if (!state.currentQR) { toast('QR is not ready'); return; }
  const r = state.records.find(x => x.qrToken === state.currentQR);
  printQR(r || { qrToken: state.currentQR, fullName: 'Participant' });
});
$('#qrModalDownload')?.addEventListener('click', () => {
  const canvas = $('#qrModalBody canvas');
  if (!canvas) { toast('QR image is not ready'); return; }
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `nextgen-qr-${String(state.currentQR || 'participant').slice(0, 8)}.png`;
  a.click();
});

function resetRecordsView() {
  if ($('#searchInput')) $('#searchInput').value = '';
  if ($('#filterCategory')) $('#filterCategory').value = 'all';
  if ($('#filterSection')) $('#filterSection').value = 'all';
  if ($('#sortBy')) $('#sortBy').value = 'newest';
  if ($('#filterArchived')) $('#filterArchived').value = 'active';
  state.recordPage = 1;
}

$('#searchInput')?.addEventListener('input', () => { state.recordPage = 1; renderRecords(); });
$('#filterCategory')?.addEventListener('change', () => { state.recordPage = 1; renderRecords(); });
$('#filterSection')?.addEventListener('change', () => { state.recordPage = 1; renderRecords(); });
$('#sortBy')?.addEventListener('change', () => { state.recordPage = 1; renderRecords(); });
$('#filterArchived')?.addEventListener('change', () => {
  state.recordPage = 1;
  state.recordsLastFetched = 0;
  loadRecords({ force: true });
});
$('#clearFilters')?.addEventListener('click', () => {
  const wasArchived = ($('#filterArchived')?.value || 'active') !== 'active';
  resetRecordsView();
  if (wasArchived) loadRecords({ force: true });
  else renderRecords();
});

$('#recordModalClose')?.addEventListener('click', () => $('#recordModal')?.close());
$('#recordModal')?.addEventListener('click', (e) => { if (e.target === $('#recordModal')) $('#recordModal').close(); });

function fillForm(r) {
  state.editingId = r.id;
  const f = $('#recordForm');
  for (const [key, val] of Object.entries({
    category: r.category, pcNumber: r.pcNumber, fullName: r.fullName,
    grade: r.grade, section: r.section, school: r.school, office: r.office,
    position: r.position, preTest: r.preTest, postTest: r.postTest, feedback: r.feedback
  })) {
    const el = f.elements.namedItem(key);
    if (el) el.value = val ?? '';
  }
  updateCategoryFields();
  if ($('#formHeading')) $('#formHeading').textContent = 'Edit registration';
  if ($('#saveBtn')) $('#saveBtn').innerHTML = 'Save changes <span>→</span>';
  if (r.qrToken) displayQR(r.qrToken);
  else displayQR(null);
}

function editRecord(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  resetForm();
  fillForm(r);
  navigate('register');
}

function renderHome() {
  const rs = state.records;
  if ($('#statTotal')) $('#statTotal').textContent = rs.length;
  if ($('#statStudents')) $('#statStudents').textContent = rs.filter(r => r.category === 'student').length;
  if ($('#statEmployees')) $('#statEmployees').textContent = rs.filter(r => r.category === 'employee').length;
  if ($('#statVisitors')) $('#statVisitors').textContent = rs.filter(r => r.category === 'visitor').length;

  const latest = [...rs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 5);
  const rt = $('#recentTable');
  if (!rt) return;
  rt.innerHTML = latest.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>PC number</th><th>Name</th><th>Category</th><th>Scores</th><th>Registered</th></tr></thead><tbody>${latest.map(r => `<tr><td><b>${esc(r.pcNumber)}</b></td><td><b>${esc(r.fullName)}</b></td><td>${categoryChip(r.category)}</td><td>${r.preTest ?? '—'} / ${r.postTest ?? '—'}</td><td>${esc(r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—')}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty-state"><span class="empty-symbol">▤</span><b>No records loaded yet</b><p>Connect the database and register your first participant.</p></div>`;
}

function categoryChip(cat) {
  return `<span class="category-chip ${esc(cat)}">${esc(categoryNames[cat] || cat)}</span>`;
}

/* ============================================================
   EXPORTS — multi-format CSV / Excel / PDF + safe archive
   ============================================================ */
function getExportSourceRecords() {
  // Always respect current search / filters / archived view
  return getFilteredRecords();
}

function exportRowsFrom(records) {
  return records.map(r => ({
    'PC Number': r.pcNumber != null ? String(r.pcNumber) : '',
    'Category': categoryNames[r.category] || r.category,
    'Full Name': r.fullName,
    'Grade': r.grade || '',
    'Section': r.section || '',
    'School': r.school || '',
    'Office / Department': r.office || '',
    'Position': r.position || '',
    'Pre-test Score': r.preTest ?? '',
    'Post-test Score': r.postTest ?? '',
    'Feedback': r.feedback || '',
    'QR Token': r.qrToken || '',
    'Created At': r.createdAt || '',
    'Archived': r.archived ? 'Yes' : 'No'
  }));
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function selectedExportFormats() {
  const formats = [];
  if ($('#fmtCsv')?.checked) formats.push('csv');
  if ($('#fmtXlsx')?.checked) formats.push('xlsx');
  if ($('#fmtPdf')?.checked) formats.push('pdf');
  return formats;
}

function currentFilterSummary() {
  const parts = [];
  const q = ($('#searchInput')?.value || '').trim();
  const cat = $('#filterCategory')?.value || 'all';
  const sec = $('#filterSection')?.value || 'all';
  const arch = $('#filterArchived')?.value || 'active';
  if (q) parts.push(`Search: “${q}”`);
  if (cat !== 'all') parts.push(`Category: ${categoryNames[cat] || cat}`);
  if (sec !== 'all') parts.push(`Section: ${sec}`);
  if (arch === 'archived') parts.push('View: archived only');
  else if (arch === 'all') parts.push('View: active + archived');
  else parts.push('View: active records');
  return parts.length ? parts.join(' · ') : 'No extra filters (all matching records)';
}

function stampFilename(base, ext) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `nextgen-${base}-${stamp}.${ext}`;
}

function buildCsvBlob(rows) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const safe = v => {
    let s = String(v ?? '');
    // Preserve leading zeros and prevent formula injection
    if (/^[=+\-@\t\r]/.test(s) || /^\d+$/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [keys, ...rows.map(r => keys.map(k => r[k]))]
    .map(row => row.map(safe).join(','))
    .join('\r\n');
  return new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
}

/* ============================================================
   EXPORT LIBRARIES — lazy loading with clear failures
   Self-host by pointing these at /vendor/*.js to remove the CDN dependency.
   ============================================================ */
const EXPORT_LIB_URLS = {
  xlsx:      'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  jspdf:     'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  autoTable: 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js',
  jszip:     'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
};
const _exportLibPromises = {};

function loadScriptOnce(src) {
  if (_exportLibPromises[src]) return _exportLibPromises[src];
  _exportLibPromises[src] = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve(true);
      existing.addEventListener('load', () => resolve(true), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load ' + src)), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => { s.dataset.loaded = '1'; resolve(true); };
    s.onerror = () => {
      delete _exportLibPromises[src];
      s.remove();
      reject(new Error('Failed to load ' + src + ' (check CSP or network)'));
    };
    document.head.appendChild(s);
  });
  return _exportLibPromises[src];
}

async function ensureXLSX() {
  if (window.XLSX) return window.XLSX;
  await loadScriptOnce(EXPORT_LIB_URLS.xlsx);
  if (!window.XLSX) throw new Error('Excel library loaded but window.XLSX is missing');
  return window.XLSX;
}

async function ensureJsPDF() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  await loadScriptOnce(EXPORT_LIB_URLS.jspdf);
  if (!window.jspdf?.jsPDF) throw new Error('PDF library loaded but window.jspdf.jsPDF is missing');
  return window.jspdf.jsPDF;
}

async function ensureAutoTable() {
  const jsPDF = await ensureJsPDF();
  if (jsPDF.API && jsPDF.API.autoTable) return;
  await loadScriptOnce(EXPORT_LIB_URLS.autoTable);
  if (!(jsPDF.API && jsPDF.API.autoTable)) {
    throw new Error('PDF table plugin failed to initialise');
  }
}

async function ensureJSZip() {
  if (window.JSZip) return window.JSZip;
  await loadScriptOnce(EXPORT_LIB_URLS.jszip);
  return window.JSZip || null;
}

async function preloadExportLibs() {
  try { await ensureXLSX(); }      catch (e) { console.warn('[NextGen] XLSX preload:', e.message); }
  try { await ensureJsPDF(); }     catch (e) { console.warn('[NextGen] jsPDF preload:', e.message); }
  try { await ensureAutoTable(); } catch (e) { console.warn('[NextGen] autoTable preload:', e.message); }
  try { await ensureJSZip(); }     catch (e) { console.warn('[NextGen] JSZip preload:', e.message); }
}

async function buildXlsxBlob(rows) {
  const XLSX = await ensureXLSX();
  // Force PC Number and similar fields to text to keep leading zeros
  const sheetRows = rows.map(r => {
    const out = { ...r };
    if (out['PC Number'] != null) out['PC Number'] = String(out['PC Number']);
    return out;
  });
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  // Mark PC Number column as text where possible
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let R = range.s.r + 1; R <= range.e.r; ++R) {
    const addr = XLSX.utils.encode_cell({ r: R, c: 0 });
    if (ws[addr] && ws[addr].t !== 's') {
      ws[addr].t = 's';
      ws[addr].v = String(ws[addr].v ?? '');
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Participants');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

async function buildPdfBlob(records) {
  const JsPDF = await ensureJsPDF();
  // Best-effort: attach autoTable plugin, fall back to plain text if it fails
  try { await ensureAutoTable(); } catch (e) { console.warn('[NextGen] autoTable:', e.message); }

  const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const generated = new Date().toLocaleString();
  doc.setFontSize(14);
  doc.text('NextGen Smart Classroom — Participant Records', 14, 14);
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text(`Generated: ${generated}  ·  ${records.length} record${records.length === 1 ? '' : 's'}`, 14, 20);
  doc.setTextColor(0);
  const columns = ['PC Number', 'Category', 'Full Name', 'Grade / Section', 'Pre-test', 'Post-test'];
  const body = records.map(r => [
    r.pcNumber != null ? String(r.pcNumber) : '',
    categoryNames[r.category] || r.category || '',
    r.fullName || '',
    [r.grade, r.section].filter(Boolean).join(' / ') || r.office || '',
    r.preTest ?? '—',
    r.postTest ?? '—'
  ]);
  if (typeof doc.autoTable === 'function') {
    doc.autoTable({
      head: [columns],
      body,
      startY: 24,
      styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
      headStyles: { fillColor: [16, 44, 72], textColor: 255 },
      margin: { left: 10, right: 10 },
      didDrawPage: () => {
        const page = doc.internal.getNumberOfPages();
        doc.setFontSize(7);
        doc.setTextColor(120);
        doc.text(`Page ${page}`, doc.internal.pageSize.getWidth() - 20, doc.internal.pageSize.getHeight() - 8);
      }
    });
  } else {
    let y = 26;
    doc.text(columns.join(' | '), 14, y);
    body.forEach(row => {
      y += 6;
      if (y > 190) { doc.addPage(); y = 15; }
      doc.text(row.map(x => String(x).slice(0, 28)).join(' | '), 14, y);
    });
  }
  return doc.output('blob');
}

const exportSession = {
  records: [],
  formats: [],
  files: [], // { name, blob, format }
  mode: null, // 'keep' | 'archive'
  archiving: false
};

function openExportDialog() {
  const records = getExportSourceRecords();
  const formats = selectedExportFormats();
  if (!formats.length) { toast('Select at least one format (CSV, Excel, or PDF)'); return; }
  if (!records.length) { toast('There are no records to export for the current filters'); return; }

  // Kick off loading of any missing libraries in the background so the build phase is fast.
  if (formats.includes('xlsx')) ensureXLSX().catch(() => {});
  if (formats.includes('pdf'))  { ensureJsPDF().catch(() => {}); ensureAutoTable().catch(() => {}); }
  if (formats.length > 1)       { ensureJSZip().catch(() => {}); }

  exportSession.records = records;
  exportSession.formats = formats;
  exportSession.files = [];
  exportSession.mode = null;
  exportSession.archiving = false;

  const dlg = $('#exportDialog');
  if (!dlg) return;

  $('#exportDialogSummary').textContent =
    `You are about to export ${records.length} record${records.length === 1 ? '' : 's'} as: ${formats.map(f => f.toUpperCase()).join(', ')}.`;
  $('#exportDialogFilters').textContent = currentFilterSummary();

  $('#exportProgress')?.classList.add('hidden');
  $('#exportDownloadLinks')?.classList.add('hidden');
  $('#exportDownloadLinks').innerHTML = '';
  $('#exportError')?.classList.add('hidden');
  $('#exportError').textContent = '';
  $('#exportDialogActions')?.classList.remove('hidden');
  $('#exportArchiveConfirmActions')?.classList.add('hidden');
  $('#exportDoneActions')?.classList.add('hidden');
  $('#exportArchiveBtn').disabled = false;
  $('#exportArchiveBtn').title = 'Export then permanently delete these records from the database';

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeExportDialog() {
  const dlg = $('#exportDialog');
  if (!dlg) return;
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

function setExportProgress(pct, text) {
  const bar = $('#exportProgress');
  const fill = $('#exportProgressFill');
  const label = $('#exportProgressText');
  if (bar) bar.classList.remove('hidden');
  if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (label) label.textContent = text || 'Preparing files…';
}

async function generateExportFiles() {
  const records = exportSession.records;
  const formats = exportSession.formats;
  const rows = exportRowsFrom(records);
  const files = [];
  const errors = [];
  const total = formats.length;
  let step = 0;

  setExportProgress(5, 'Preparing export…');

  for (const fmt of formats) {
    step += 1;
    setExportProgress(Math.round((step - 0.4) / total * 90) + 5, `Building ${fmt.toUpperCase()}…`);
    try {
      if (fmt === 'csv') {
        const blob = buildCsvBlob(rows);
        if (!blob) throw new Error('No data to export');
        files.push({ format: 'csv', name: stampFilename('records', 'csv'), blob });
      } else if (fmt === 'xlsx') {
        const blob = await buildXlsxBlob(rows);
        files.push({ format: 'xlsx', name: stampFilename('records', 'xlsx'), blob });
      } else if (fmt === 'pdf') {
        const blob = await buildPdfBlob(records);
        files.push({ format: 'pdf', name: stampFilename('records', 'pdf'), blob });
      }
    } catch (err) {
      errors.push({ format: fmt, message: err && err.message ? err.message : String(err) });
    }
  }

  setExportProgress(95, 'Finalizing…');
  exportSession.files = files;
  return { files, errors };
}

function presentDownloadLinks(files) {
  const box = $('#exportDownloadLinks');
  if (!box) return;
  box.innerHTML = '';
  box.classList.remove('hidden');
  files.forEach(f => {
    const url = URL.createObjectURL(f.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.textContent = `Download ${f.name}`;
    a.rel = 'noopener';
    box.appendChild(a);
    // Auto-trigger first file; remaining via links (browser multi-download limits)
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  });
}

async function packageOrDownload(files) {
  // Lazily load JSZip if we might need it for the ZIP path
  let JSZipLib = window.JSZip;
  if (files.length > 1 && !JSZipLib) {
    try { JSZipLib = await ensureJSZip(); } catch (_) { JSZipLib = null; }
  }
  if (files.length > 1 && JSZipLib) {
    setExportProgress(98, 'Packaging ZIP…');
    const zip = new JSZipLib();
    for (const f of files) zip.file(f.name, f.blob);
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipName = stampFilename('reports', 'zip');
    downloadBlob(zipBlob, zipName);
    presentDownloadLinks([{ name: zipName, blob: zipBlob, format: 'zip' }, ...files]);
    return;
  }
  // Single file or no JSZip: trigger downloads and show links
  for (const f of files) {
    try { downloadBlob(f.blob, f.name); } catch (_) {}
  }
  presentDownloadLinks(files);
}

async function runExportKeep() {
  const errEl = $('#exportError');
  errEl?.classList.add('hidden');
  $('#exportDialogActions')?.classList.add('hidden');
  try {
    const { files, errors } = await generateExportFiles();

    if (!files.length) {
      // Total failure — restore actions so the user can retry or deselect failing formats
      if (errEl) {
        const detail = errors.map(e => `${e.format.toUpperCase()}: ${e.message}`).join('; ');
        errEl.textContent = `Export failed — ${detail || 'no files could be generated'}`;
        errEl.classList.remove('hidden');
      }
      $('#exportDialogActions')?.classList.remove('hidden');
      $('#exportProgress')?.classList.add('hidden');
      toast('Export failed — retry, or try CSV only');
      return;
    }

    // Partial success — surface which formats failed but still deliver the rest
    if (errors.length) {
      const detail = errors.map(e => `${e.format.toUpperCase()}: ${e.message}`).join('; ');
      if (errEl) {
        errEl.textContent = `Some formats failed — ${detail}. The other files are ready below.`;
        errEl.classList.remove('hidden');
      }
    }

    await packageOrDownload(files);
    setExportProgress(100, 'Export ready. Use the links below if a download was blocked.');
    $('#exportDoneActions')?.classList.remove('hidden');
    toast(errors.length ? 'Partial export ready' : 'Export prepared — check your downloads');
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove('hidden');
    }
    $('#exportDialogActions')?.classList.remove('hidden');
    $('#exportProgress')?.classList.add('hidden');
    toast('Export failed — you can retry');
  }
}

async function checkPendingConflicts(recordIds) {
  try {
    if (!window.OfflineDB) return [];
    const pending = await OfflineDB.exportPending();
    const idSet = new Set(recordIds);
    return pending.filter(p => {
      const rid = p.recordId || p.payload?.id || p.id;
      return rid && idSet.has(rid);
    });
  } catch {
    return [];
  }
}

async function runExportArchive() {
  const toDelete = exportSession.records.filter(r => r && r.id);
  if (!toDelete.length) {
    toast('No records in this selection to delete');
    return;
  }

  // Offline safeguard — never wipe rows that still have pending local changes
  const conflicts = await checkPendingConflicts(toDelete.map(r => r.id));
  if (conflicts.length) {
    const errEl = $('#exportError');
    if (errEl) {
      errEl.textContent = `${conflicts.length} selected record(s) still have pending offline changes. Synchronize first, or use “Download and Keep Records” instead.`;
      errEl.classList.remove('hidden');
    }
    toast('Pending offline changes detected — permanent delete blocked');
    return;
  }

  // Show explicit final confirmation (permanent wipe)
  $('#exportDialogActions')?.classList.add('hidden');
  const conf = $('#exportArchiveConfirmActions');
  conf?.classList.remove('hidden');
  const msg = $('#exportArchiveConfirmText');
  if (msg) {
    msg.textContent = `This will PERMANENTLY DELETE ${toDelete.length} record${toDelete.length === 1 ? '' : 's'} from the database after the export files are generated. This cannot be undone.`;
  }
  const confirmBtn = $('#exportArchiveConfirmBtn');
  if (confirmBtn) confirmBtn.textContent = 'Confirm permanent delete';
}

async function confirmArchiveAfterExport() {
  const errEl = $('#exportError');
  errEl?.classList.add('hidden');
  const toDelete = exportSession.records.filter(r => r && r.id);
  if (!toDelete.length) return;

  $('#exportArchiveConfirmActions')?.classList.add('hidden');
  exportSession.archiving = true;

  let phase = 'export';
  try {
    // ── Phase 1: Export — must fully succeed before we delete anything ──
    const { files, errors } = await generateExportFiles();
    if (errors.length || files.length !== exportSession.formats.length) {
      const detail = errors.map(e => `${e.format.toUpperCase()}: ${e.message}`).join('; ')
        || 'one or more formats could not be generated';
      throw new Error(`Export incomplete — ${detail}. Records were NOT deleted.`);
    }
    if (!files.length) {
      throw new Error('Export produced no files. Records were NOT deleted.');
    }
    await packageOrDownload(files);
    setExportProgress(100, 'Files ready. Sending delete request to server…');

    // ── Phase 2: Permanent delete — longer timeout for bulk operations ──
    phase = 'delete';
    const ids = toDelete.map(r => r.id);
    let result;
    try {
      result = await api('/records/archive', {
        method: 'POST',
        timeout: 60000,
        body: JSON.stringify({ ids, permanent: true })
      });
    } catch (authErr) {
      if (authErr && authErr.status === 401) {
        throw new Error('Sign in as staff is required before permanently deleting records.');
      }
      if (authErr && authErr.status === 404) {
        throw new Error('Server does not expose /records/archive — the Worker route is missing.');
      }
      throw authErr;
    }

    const count = result.deletedCount ?? result.archivedCount ?? 0;
    const warned = result && result.warning ? ' ' + result.warning : '';
    setExportProgress(100, `Permanently deleted ${count} record${count === 1 ? '' : 's'}.`);
    toast(`Exported and permanently deleted ${count} record${count === 1 ? '' : 's'}${warned}`);

    // Drop deleted ids from local state and refresh
    const gone = new Set(ids);
    state.records = state.records.filter(r => !gone.has(r.id));
    state.recordsLastFetched = 0;
    await loadRecords({ force: true });
    renderRecords();
    renderHome();

    $('#exportDoneActions')?.classList.remove('hidden');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (errEl) {
      errEl.textContent = (phase === 'export' ? 'Export failed: ' : 'Delete failed: ') + message;
      errEl.classList.remove('hidden');
    }
    $('#exportDialogActions')?.classList.remove('hidden');
    $('#exportProgress')?.classList.add('hidden');
    toast(phase === 'export'
      ? 'Export failed — nothing was deleted'
      : 'Delete failed — refresh records to verify');
  } finally {
    exportSession.archiving = false;
  }
}

$('#exportReportBtn')?.addEventListener('click', openExportDialog);
$('#exportDialogClose')?.addEventListener('click', closeExportDialog);
$('#exportCancelBtn')?.addEventListener('click', closeExportDialog);
$('#exportKeepBtn')?.addEventListener('click', () => {
  exportSession.mode = 'keep';
  runExportKeep();
});
$('#exportArchiveBtn')?.addEventListener('click', () => {
  exportSession.mode = 'archive';
  runExportArchive();
});
$('#exportArchiveBackBtn')?.addEventListener('click', () => {
  $('#exportArchiveConfirmActions')?.classList.add('hidden');
  $('#exportDialogActions')?.classList.remove('hidden');
});
$('#exportArchiveConfirmBtn')?.addEventListener('click', confirmArchiveAfterExport);
$('#exportDoneBtn')?.addEventListener('click', closeExportDialog);
$('#exportRetryBtn')?.addEventListener('click', () => {
  $('#exportDoneActions')?.classList.add('hidden');
  $('#exportDownloadLinks')?.classList.add('hidden');
  if (exportSession.mode === 'archive') confirmArchiveAfterExport();
  else runExportKeep();
});

/* ============================================================
   QR SCANNER
   ============================================================ */
function normalizeScannedToken(raw) {
  let token = String(raw || '').trim();
  if (!token) return '';
  try {
    const u = new URL(token);
    token = u.searchParams.get('token') || u.hash.replace(/^#/, '') || token;
  } catch {}
  token = token.replace(/^(NGSC|NEXTGEN):/i, '').trim();
  if (token.includes('/') && !token.startsWith('http')) {
    const parts = token.split('/').filter(Boolean);
    token = parts[parts.length - 1] || token;
  }
  return token;
}

function buildScanResultHTML(r) {
  const line1 = r.category === 'student'
    ? [r.grade, r.section].filter(Boolean).join(' · ')
    : [r.office].filter(Boolean).join(' · ');
  const line2 = r.category === 'student' ? (r.school || '—') : (r.position || '—');
  return `<div class="record-detail">
    <div class="section-kicker">MATCHED RECORD</div>
    <h3>${esc(r.fullName || '—')}</h3>
    <p class="muted">${categoryChip(r.category)} · ${r.pcNumber ? 'PC ' + esc(r.pcNumber) : 'No PC number'}</p>
    <div class="detail-grid">
      <div class="detail-item"><small>Grade / Section / Office</small><b>${esc(line1 || '—')}</b></div>
      <div class="detail-item"><small>School / Position</small><b>${esc(line2)}</b></div>
      <div class="detail-item"><small>Pre-test</small><b>${r.preTest ?? '—'}</b></div>
      <div class="detail-item"><small>Post-test</small><b>${r.postTest ?? '—'}</b></div>
    </div>
    <div class="scan-result-actions">
      <button class="btn secondary" id="recordScan" type="button">Record scan event</button>
      <button class="btn secondary" id="scanViewFull" type="button">Open full record</button>
    </div>
    <p id="scanEventMessage" class="form-message" role="status"></p>
  </div>`;
}

async function recordScanEvent(recordId) {
  if (!recordId) return;
  const msgEl = $('#scanEventMessage'), btn = $('#recordScan');
  if (btn) btn.disabled = true;
  if (msgEl) { msgEl.textContent = 'Recording scan event…'; msgEl.className = 'form-message'; }
  try {
    const result = await api(`/records/${encodeURIComponent(recordId)}/scan`, {
      method: 'POST',
      body: JSON.stringify({ purpose: 'staff_lookup' })
    });
    if (msgEl) {
      const already = result && (result.alreadyRecorded || result.duplicate);
      msgEl.textContent = already
        ? 'Already recorded — this participant was scanned recently.'
        : 'Scan event recorded successfully.';
      msgEl.className = 'form-message' + (already ? '' : ' success');
    }
    refreshNotifications();
  } catch (err) {
    if (msgEl) {
      msgEl.textContent = err.message === 'Failed to fetch'
        ? 'Could not reach the server. Try again.'
        : (err.message || 'Could not record scan event.');
      msgEl.className = 'form-message';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('#scanForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const raw = new FormData(e.currentTarget).get('token');
  const token = normalizeScannedToken(raw);
  const msg = $('#scanMessage');
  const resultEl = $('#scanResult');

  if (!token) {
    if (msg) { msg.textContent = 'Enter a QR token or paste the URL from the QR code.'; msg.className = 'form-message'; }
    return;
  }
  if (msg) { msg.textContent = 'Looking up record…'; msg.className = 'form-message'; }

  try {
    const result = await api(`/lookup?token=${encodeURIComponent(token)}`);
    const r = result.record;
    if (!r || !r.id) throw new Error('No record matched that token.');

    if (msg) { msg.textContent = 'Record found.'; msg.className = 'form-message success'; }
    if (resultEl) resultEl.innerHTML = buildScanResultHTML(r);

    $('#recordScan')?.addEventListener('click', () => recordScanEvent(r.id));
    $('#scanViewFull')?.addEventListener('click', () => {
      const existing = state.records.find(x => x.id === r.id);
      if (!existing) state.records = [r, ...state.records];
      viewRecord(r.id);
    });
  } catch (err) {
    if (msg) {
      msg.textContent = err.status === 404
        ? 'No record matches that QR token. Verify the participant is registered.'
        : (err.message === 'Failed to fetch'
            ? 'Could not reach the server. Check the Cloudflare Worker setup.'
            : (err.message || 'Lookup failed. Try again.'));
      msg.className = 'form-message';
    }
    if (resultEl) {
      resultEl.innerHTML = `<div class="empty-state">
        <span class="empty-symbol">?</span>
        <b>${err.status === 404 ? 'No matching record' : 'Lookup failed'}</b>
        <p>${err.status === 404
          ? 'The QR code may belong to another system, or the participant may not be registered.'
          : esc(err.message || 'Please try again in a moment.')}</p>
      </div>`;
    }
  }
});

updateCategoryFields();
// NOTE: checkSession() is invoked at the end of this file.

/* ============================================================
   CAMERA SCANNER — with specific error guidance
   ============================================================ */
let html5Scanner = null;

function setCameraHelp(text, isError = false) {
  const el = $('#cameraHelp');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'camera-help' + (isError ? ' error' : '');
  el.classList.toggle('hidden', !text);
}

$('#startCamera')?.addEventListener('click', async () => {
  const box = $('#cameraReader'), startBtn = $('#startCamera');

  if (html5Scanner) {
    try { await html5Scanner.stop(); await html5Scanner.clear(); } catch {}
    html5Scanner = null;
    box?.classList.add('hidden');
    if (startBtn) startBtn.textContent = '▦ Scan using camera';
    setCameraHelp('');
    return;
  }

  if (!window.Html5Qrcode) {
    setCameraHelp('Camera scanner library did not load. Paste the QR token instead.', true);
    toast('Camera scanner library did not load.');
    return;
  }

  box?.classList.remove('hidden');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Starting camera…'; }
  setCameraHelp('Requesting camera access…');

  try {
    html5Scanner = new Html5Qrcode('cameraReader');
    await html5Scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        const input = $('#scanForm')?.elements.namedItem('token');
        if (input) input.value = decodedText;
        try { await html5Scanner.stop(); await html5Scanner.clear(); } catch {}
        html5Scanner = null;
        box?.classList.add('hidden');
        if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▦ Scan using camera'; }
        setCameraHelp('');
        $('#scanForm')?.requestSubmit();
      },
      () => {}
    );
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Stop camera scanner'; }
    setCameraHelp("Point the camera at the participant's QR code.");
  } catch (err) {
    html5Scanner = null;
    box?.classList.add('hidden');
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▦ Scan using camera'; }
    const name = err && err.name ? String(err.name) : '';
    let message = 'Camera could not start. Paste the QR token instead.';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      message = 'Camera permission was denied. Allow camera access in your browser, or paste the QR token instead.';
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      message = 'No camera was found on this device. Paste the QR token instead.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      message = 'The camera is in use by another app. Close other apps and try again, or paste the QR token.';
    } else if (name === 'OverconstrainedError') {
      message = 'The camera does not support the required settings. Paste the QR token instead.';
    }
    setCameraHelp(message, true);
    toast('Camera access failed.');
  }
});

/* ============================================================
   NOTIFICATION SYSTEM — IMPLEMENTATION
   ============================================================ */
const notificationTypeLabels = {
  'record.created': 'New record',
  'record.updated': 'Updated record',
  'record.deleted': 'Deleted record',
  'attendance.recorded': 'Attendance'
};

function bindNotificationElements() {
  const n = notifications;
  if (n.state.initialized) return;
  n.state.initialized = true;

  n.els.btn   = document.getElementById('notificationBtn');
  n.els.badge = document.getElementById('notificationBadge');
  n.els.panel = document.getElementById('notificationPanel');
  n.els.list  = document.getElementById('notificationList');
  n.els.markAll = document.getElementById('notificationMarkAllBtn');
  n.els.close = document.getElementById('notificationCloseBtn');

  if (n.els.btn) {
    n.els.btn.setAttribute('aria-expanded', 'false');
    n.els.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNotificationPanel();
    });
  }
  if (n.els.close) n.els.close.addEventListener('click', closeNotificationPanel);
  if (n.els.markAll) n.els.markAll.addEventListener('click', markAllNotificationsRead);

  document.addEventListener('click', (e) => {
    if (!n.state.panelOpen) return;
    if (n.els.panel?.contains(e.target)) return;
    if (n.els.btn?.contains(e.target)) return;
    closeNotificationPanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && n.state.panelOpen) closeNotificationPanel();
  });

  document.addEventListener('visibilitychange', handleNotificationVisibility);
}

function handleNotificationVisibility() {
  const n = notifications;
  if (!n.state.authenticated) return;
  if (document.hidden) {
    stopNotificationPolling();
  } else if (n.state.available) {
    startNotificationPolling();
    refreshNotifications();
  }
}

function onAuthenticated() {
  const n = notifications;
  n.state.authenticated = true;
  n.state.available = true;
  n.state.markAllSupported = true;
  n.state.lastError = null;
  n.state.seenIds = new Set();
  n.state.firstFetchDone = false;
  if (n.els.markAll) n.els.markAll.hidden = false;
  try { refreshNotifications(); } catch (e) { console.warn('[NextGen] refreshNotifications:', e); }
}

function onLoggedOut() {
  const n = notifications;
  n.state.authenticated = false;
  n.state.available = true;
  n.state.items = [];
  n.state.unreadCount = 0;
  n.state.loading = false;
  n.state.inFlight = false;
  n.state.panelOpen = false;
  n.state.lastError = null;
  n.state.markAllSupported = true;
  n.state.seenIds = new Set();
  n.state.firstFetchDone = false;
  stopNotificationPolling();
  n.els.panel?.classList.add('hidden');
  n.els.btn?.setAttribute('aria-expanded', 'false');
  if (n.els.markAll) n.els.markAll.hidden = false;
  try { renderNotifications(); } catch (e) { console.warn('[NextGen] renderNotifications:', e); }
  try { renderNotificationBadge(); } catch (e) { console.warn('[NextGen] renderNotificationBadge:', e); }
}

function isEndpointUnavailable(err) {
  return err && (err.status === 404 || err.status === 405 || err.status === 501);
}

async function refreshNotifications() {
  const n = notifications;
  if (!n.state.authenticated) return;
  if (n.state.inFlight) return;
  if (!n.state.available) return;

  n.state.inFlight = true;
  n.state.loading = true;
  renderNotifications();

  try {
    const result = await api(n.config.listUrl);
    if (!result || !Array.isArray(result.notifications)) {
      n.state.available = false;
      n.state.items = [];
      n.state.unreadCount = 0;
      stopNotificationPolling();
      console.info('[NextGen] Notification endpoint returned an unexpected response. Polling disabled for this session.');
      return;
    }
    n.state.items = result.notifications.map((item) => ({
      id: item && item.id != null ? String(item.id) : '',
      type: item && item.type ? String(item.type) : '',
      message: item && item.message ? String(item.message) : 'Notification',
      createdAt: item && item.createdAt ? String(item.createdAt) : '',
      read: !!(item && item.read)
    }));
    n.state.unreadCount = typeof result.unreadCount === 'number'
      ? Math.max(0, result.unreadCount)
      : n.state.items.filter((x) => !x.read).length;
    n.state.available = true;
    n.state.lastError = null;

    // Play sound only for new unread notifications
    const previousIds = n.state.seenIds || new Set();
    const currentIds = new Set();
    let hasNewUnread = false;
    for (const item of n.state.items) {
      if (item.id) currentIds.add(item.id);
      if (item.id && !item.read && !previousIds.has(item.id)) {
        hasNewUnread = true;
      }
    }
    n.state.seenIds = currentIds;

    if (n.state.firstFetchDone && hasNewUnread && n.state.authenticated) {
      playNotificationSound();
    }
    n.state.firstFetchDone = true;
  } catch (err) {
    if (err && err.status === 401) {
      n.state.authenticated = false;
      stopNotificationPolling();
      return;
    }
    if (isEndpointUnavailable(err)) {
      n.state.available = false;
      n.state.items = [];
      n.state.unreadCount = 0;
      stopNotificationPolling();
      console.info('[NextGen] Notification endpoints are not configured yet. Polling disabled for this session.');
      return;
    }
    n.state.lastError = err && err.message ? err.message : 'Could not load notifications.';
  } finally {
    n.state.inFlight = false;
    n.state.loading = false;
    renderNotifications();
    renderNotificationBadge();
    if (n.state.available && n.state.authenticated && !n.state.pollTimer) {
      startNotificationPolling();
    }
  }
}

function startNotificationPolling() {
  const n = notifications;
  if (n.state.pollTimer) return;
  if (!n.state.authenticated) return;
  if (!n.state.available) return;
  n.state.pollTimer = window.setInterval(() => {
    if (document.hidden) return;
    refreshNotifications();
  }, n.config.pollIntervalMs);
}

function stopNotificationPolling() {
  const n = notifications;
  if (n.state.pollTimer) {
    window.clearInterval(n.state.pollTimer);
    n.state.pollTimer = null;
  }
}

function openNotificationPanel() {
  const n = notifications;
  if (!n.els.panel) return;
  if (!n.state.authenticated) return;
  n.state.panelOpen = true;
  n.els.panel.classList.remove('hidden');
  n.els.btn?.setAttribute('aria-expanded', 'true');
  if (n.state.available) refreshNotifications();
}

function closeNotificationPanel() {
  const n = notifications;
  if (!n.els.panel) return;
  n.state.panelOpen = false;
  n.els.panel.classList.add('hidden');
  n.els.btn?.setAttribute('aria-expanded', 'false');
}

function toggleNotificationPanel() {
  if (notifications.state.panelOpen) closeNotificationPanel();
  else openNotificationPanel();
}

async function markNotificationRead(id) {
  const n = notifications;
  if (!id) return;
  const item = n.state.items.find((x) => x.id === id);
  if (!item || item.read) return;

  try {
    await api(n.config.readUrl(id), { method: 'POST' });
    n.state.items = n.state.items.map((x) => x.id === id ? { ...x, read: true } : x);
    n.state.unreadCount = Math.max(0, n.state.unreadCount - 1);
    renderNotifications();
    renderNotificationBadge();
  } catch (err) {
    if (err && err.status === 401) {
      n.state.authenticated = false;
      stopNotificationPolling();
      return;
    }
    if (isEndpointUnavailable(err)) {
      n.state.available = false;
      stopNotificationPolling();
      renderNotifications();
      return;
    }
    toast('Could not mark notification as read.');
  }
}

async function markAllNotificationsRead() {
  const n = notifications;
  if (!n.state.authenticated) return;
  if (!n.state.items.some((x) => !x.read)) return;

  try {
    await api(n.config.readAllUrl, { method: 'POST' });
    n.state.items = n.state.items.map((x) => ({ ...x, read: true }));
    n.state.unreadCount = 0;
    renderNotifications();
    renderNotificationBadge();
  } catch (err) {
    if (err && err.status === 401) {
      n.state.authenticated = false;
      stopNotificationPolling();
      return;
    }
    if (isEndpointUnavailable(err)) {
      n.state.markAllSupported = false;
      if (n.els.markAll) n.els.markAll.hidden = true;
      return;
    }
    toast('Could not mark all notifications as read.');
  }
}

function renderNotificationBadge() {
  const n = notifications;
  const count = n.state.unreadCount;
  if (n.els.btn) {
    n.els.btn.setAttribute(
      'aria-label',
      count > 0
        ? `${count} unread notification${count === 1 ? '' : 's'}`
        : 'Notifications'
    );
  }
  if (!n.els.badge) return;
  if (count > 0 && n.state.available) {
    n.els.badge.textContent = count > 99 ? '99+' : String(count);
    n.els.badge.classList.remove('hidden');
  } else {
    n.els.badge.textContent = '';
    n.els.badge.classList.add('hidden');
  }
}

function renderNotifications() {
  const n = notifications;
  const list = n.els.list;
  if (!list) return;

  list.replaceChildren();

  if (!n.state.available) {
    const msg = document.createElement('div');
    msg.className = 'notification-empty';
    msg.textContent = 'Notifications are not yet available.';
    list.appendChild(msg);
    return;
  }
  if (n.state.loading && n.state.items.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'notification-loading';
    msg.textContent = 'Loading notifications…';
    list.appendChild(msg);
    return;
  }
  if (n.state.lastError && n.state.items.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'notification-error';
    msg.textContent = n.state.lastError;
    list.appendChild(msg);
    return;
  }
  if (n.state.items.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'notification-empty';
    msg.textContent = 'You have no notifications.';
    list.appendChild(msg);
    return;
  }
  for (const item of n.state.items) {
    list.appendChild(renderNotificationItem(item));
  }
}

function renderNotificationItem(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'notification-item' + (item.read ? '' : ' unread');
  if (item.id) btn.dataset.notifId = item.id;
  if (!item.read) btn.setAttribute('aria-label', 'Unread: ' + (item.message || 'Notification'));

  const msg = document.createElement('span');
  msg.className = 'notification-message';
  msg.textContent = item.message || 'Notification';
  btn.appendChild(msg);

  const meta = document.createElement('span');
  meta.className = 'notification-meta';
  const typeLabel = notificationTypeLabels[item.type] || '';
  const when = formatNotificationTime(item.createdAt);
  meta.textContent = [typeLabel, when].filter(Boolean).join(' · ');
  btn.appendChild(meta);

  btn.addEventListener('click', () => markNotificationRead(item.id));
  return btn;
}

function formatNotificationTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return d.toLocaleDateString();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

bindNotificationElements();

/* ============================================================
   PC NUMBER LOOKUP & SCORE EDITING
   ============================================================ */
let scoreEditRecord = null;
let scoreSaveInFlight = false;

function renderScoreEditor(record) {
  const box = $('#scoreEditor');
  if (!box) return;
  if (!record) {
    box.innerHTML = `<div class="empty-state"><span class="empty-symbol">◎</span><b>Waiting for a PC Number</b><p>The matching student and scores will appear here.</p></div>`;
    return;
  }
  scoreEditRecord = record;
  box.innerHTML = `
    <div class="record-detail">
      <div class="section-kicker">STUDENT FOUND</div>
      <h3>${esc(record.fullName)}</h3>
      <p class="muted">${categoryChip(record.category)} · PC ${esc(record.pcNumber)}</p>
      <div class="detail-grid" style="margin-bottom:16px">
        <div class="detail-item"><small>Section</small><b>${esc(record.section || '—')}</b></div>
        <div class="detail-item"><small>Grade</small><b>${esc(record.grade || '—')}</b></div>
        <div class="detail-item"><small>School</small><b>${esc(record.school || '—')}</b></div>
      </div>
      <form id="scoreForm">
        <div class="form-grid">
          <label>Pre-test score
            <input name="preTest" type="number" min="0" step="any" value="${record.preTest ?? ''}" placeholder="Current: ${record.preTest ?? 'none'}">
          </label>
          <label>Post-test score
            <input name="postTest" type="number" min="0" step="any" value="${record.postTest ?? ''}" placeholder="Current: ${record.postTest ?? 'none'}">
          </label>
        </div>
        <div class="form-actions" style="margin-top:14px;display:flex;gap:8px">
          <button class="btn primary" type="submit" id="saveScoresBtn">Save changes</button>
          <button class="btn secondary" type="button" id="cancelScoresBtn">Cancel</button>
        </div>
        <p id="scoreMessage" class="form-message" role="status"></p>
      </form>
    </div>`;

  $('#cancelScoresBtn')?.addEventListener('click', () => {
    renderScoreEditor(record); // reset to original values
    const m = $('#scoreMessage');
    if (m) { m.textContent = 'Changes discarded.'; m.className = 'form-message'; }
  });

  $('#scoreForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (scoreSaveInFlight) return;
    const msg = $('#scoreMessage');
    const pre = e.target.elements.preTest.value.trim();
    const post = e.target.elements.postTest.value.trim();
    const preN = pre === '' ? null : Number(pre);
    const postN = post === '' ? null : Number(post);
    if ((pre !== '' && (!Number.isFinite(preN) || preN < 0)) ||
        (post !== '' && (!Number.isFinite(postN) || postN < 0))) {
      if (msg) { msg.textContent = 'Scores must be non-negative numbers.'; msg.className = 'form-message'; }
      return;
    }
    scoreSaveInFlight = true;
    const btn = $('#saveScoresBtn');
    if (btn) btn.disabled = true;
    if (msg) { msg.textContent = 'Saving…'; msg.className = 'form-message'; }
    try {
      const result = await api(`/records/${encodeURIComponent(record.id)}/scores`, {
        method: 'PATCH',
        body: JSON.stringify({ preTest: preN, postTest: postN })
      });
      scoreEditRecord = result.record;
      renderScoreEditor(result.record);
      const m2 = $('#scoreMessage');
      if (m2) { m2.textContent = 'Scores updated successfully.'; m2.className = 'form-message success'; }
      toast('Scores saved');
      await loadRecords();
    } catch (err) {
      if (msg) {
        msg.textContent = err.status === 401
          ? 'You must be signed in as staff to change scores.'
          : err.message;
        msg.className = 'form-message';
      }
      if (err.status === 401) {
        toast('Sign in required to edit scores');
      }
    } finally {
      scoreSaveInFlight = false;
      if (btn) btn.disabled = false;
    }
  });
}

$('#pcLookupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pc = new FormData(e.currentTarget).get('pc').trim();
  const msg = $('#pcLookupMessage');
  if (!pc) { if (msg) msg.textContent = 'Enter a PC Number.'; return; }
  if (msg) { msg.textContent = 'Searching…'; msg.className = 'form-message'; }
  try {
    const result = await api(`/lookup-pc?pc=${encodeURIComponent(pc)}`);
    const rec = (result.records || [])[0];
    if (!rec) throw new Error('No record found.');
    if (msg) { msg.textContent = 'Student found.'; msg.className = 'form-message success'; }
    renderScoreEditor(rec);
  } catch (err) {
    if (msg) {
      msg.textContent = err.status === 404
        ? 'No record matches that PC Number.'
        : err.message;
      msg.className = 'form-message';
    }
    renderScoreEditor(null);
  }
});


/* ============================================================
   OFFLINE WORKSPACE — queue, cache, sync
   ============================================================ */
let offlineSyncing = false;

function uuidLocal() {
  return crypto.randomUUID ? crypto.randomUUID() : 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

async function enqueue(type, data) {
  if (!window.OfflineDB) return null;
  const deviceId = await OfflineDB.getDeviceId();
  const item = {
    id: uuidLocal(),
    type,
    deviceId,
    recordId: data.recordId || null,
    payload: data.payload || null,
    purpose: data.purpose || null,
    preTest: data.preTest,
    postTest: data.postTest,
    baseUpdatedAt: data.baseUpdatedAt || null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    lastError: null
  };
  await OfflineDB.addQueueItem(item);
  await refreshQueueUI();
  toast('Queued offline — not yet saved to the central database');
  return item;
}

async function refreshQueueUI() {
  if (!window.OfflineDB) return;
  const items = await OfflineDB.getQueue();
  const counts = { pending: 0, syncing: 0, synced: 0, failed: 0, conflict: 0 };
  items.forEach(i => { if (counts[i.status] !== undefined) counts[i.status]++; });
  const active = counts.pending + counts.failed + counts.conflict;
  const badge = $('#queueBadge');
  if (badge) {
    badge.textContent = active + ' pending';
    badge.classList.toggle('hidden', active === 0);
  }
  const countsEl = $('#offlineCounts');
  if (countsEl) {
    countsEl.innerHTML = `Pending: <b>${counts.pending}</b> · Syncing: <b>${counts.syncing}</b> · Synced: <b>${counts.synced}</b> · Failed: <b>${counts.failed + counts.conflict}</b>`;
  }
  const list = $('#offlineQueueList');
  if (list) {
    list.innerHTML = items.length
      ? items.map(i => `<li><span>${esc(i.type)} · ${esc((i.recordId || 'new').slice(0, 8))}</span><span class="offline-status ${esc(i.status)}" title="${esc(i.lastError || '')}">${esc(i.status)}</span></li>`).join('')
      : '<li><span>No queued changes</span></li>';
  }
  const note = $('#offlinePanelNote');
  if (note) {
    note.textContent = active
      ? active + ' change(s) are still local and have not been confirmed by the server.'
      : 'No pending offline changes.';
  }
  const title = $('#offlinePanelTitle');
  if (title) title.textContent = navigator.onLine ? 'Online Workspace' : 'Offline Workspace';
}

async function syncQueue() {
  if (offlineSyncing || !navigator.onLine || !window.OfflineDB) return;
  const items = await OfflineDB.getQueue();
  const toSend = items.filter(i => i.status === 'pending' || i.status === 'failed');
  if (!toSend.length) { await refreshQueueUI(); return; }

  offlineSyncing = true;
  for (const item of toSend) {
    item.status = 'syncing';
    item.attempts = (item.attempts || 0) + 1;
    await OfflineDB.updateQueueItem(item);
  }
  await refreshQueueUI();

  let syncedCount = 0;
  let failedCount = 0;
  try {
    let clientGen = 1;
    try { clientGen = await OfflineDB.getDataGeneration(); } catch (_) {}
    const result = await api('/sync', {
      method: 'POST',
      body: JSON.stringify({ items: toSend, dataGeneration: clientGen })
    });
    if (result.stale) {
      toast('Server data was reset — clearing stale offline queue on this device');
      try {
        await OfflineDB.clearQueue();
        await OfflineDB.clearCachedRecords();
        if (result.dataGeneration) await OfflineDB.setDataGeneration(result.dataGeneration);
      } catch (_) {}
      state.records = [];
      await loadRecords({ force: true });
      return;
    }
    if (result.dataGeneration) {
      try { await OfflineDB.setDataGeneration(result.dataGeneration); } catch (_) {}
    }
    const byId = {};
    (result.results || []).forEach(r => { byId[r.id] = r; });
    for (const item of toSend) {
      const res = byId[item.id];
      if (res && res.status === 'synced') {
        item.status = 'synced';
        item.lastError = null;
        syncedCount++;
      } else if (res && res.status === 'conflict') {
        item.status = 'conflict';
        item.lastError = res.error || 'Conflict';
        failedCount++;
      } else if (res && res.status === 'rejected') {
        item.status = 'failed';
        item.lastError = res.error || 'Rejected after data reset';
        failedCount++;
      } else {
        item.status = 'failed';
        item.lastError = (res && res.error) || 'Sync failed';
        failedCount++;
      }
      await OfflineDB.updateQueueItem(item);
    }
    toast(syncedCount
      ? `Offline changes synchronized (${syncedCount})`
      : 'Sync finished with no confirmed saves');
    await loadRecords();
  } catch (err) {
    for (const item of toSend) {
      item.status = 'failed';
      item.lastError = err.message || 'Network error';
      await OfflineDB.updateQueueItem(item);
    }
    failedCount = toSend.length;
    toast('Sync failed — will retry when online');
  } finally {
    offlineSyncing = false;
    await refreshQueueUI();
  }
}

// Cache records after successful load
const _origLoadRecords = loadRecords;
loadRecords = async function () {
  await _origLoadRecords();
  if (window.OfflineDB && state.records && state.records.length) {
    try { await OfflineDB.cacheRecords(state.records); } catch {}
  }
};

// Queue scan events when offline
const _origRecordScan = recordScanEvent;
recordScanEvent = async function (recordId) {
  if (!navigator.onLine) {
    await enqueue('scan', { recordId, purpose: 'staff_lookup' });
    const msgEl = $('#scanEventMessage');
    if (msgEl) { msgEl.textContent = 'Queued offline — will sync when connected.'; msgEl.className = 'form-message'; }
    return;
  }
  return _origRecordScan(recordId);
};

// Service worker registration — pick up new deploys without requiring a manual hard refresh
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Check for updates when the tab becomes visible again
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      setInterval(() => { reg.update().catch(() => {}); }, 60 * 60 * 1000);
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(() => {});
  });
}

// Online/offline events
window.addEventListener('online', () => {
  updateOnlineStatus();
  syncQueue();
});
window.addEventListener('offline', () => {
  updateOnlineStatus();
  toast('You are offline. Changes will be queued.');
});

/* ============================================================
   PERMANENT WIPE ALL DATA — multi-step confirmed admin operation
   ============================================================ */
let wipeInFlight = false;
let wipeActor = '';

function wipeSetStep(step) {
  ['wipeStep1', 'wipeStep2', 'wipeStep3'].forEach((id, i) => {
    const el = $('#' + id);
    if (el) el.classList.toggle('hidden', i + 1 !== step);
  });
  ['wipeActions1', 'wipeActions2', 'wipeActions3', 'wipeActionsDone'].forEach((id) => {
    $('#' + id)?.classList.add('hidden');
  });
  if (step === 1) $('#wipeActions1')?.classList.remove('hidden');
  if (step === 2) $('#wipeActions2')?.classList.remove('hidden');
  if (step === 3) $('#wipeActions3')?.classList.remove('hidden');
  if (step === 'done') $('#wipeActionsDone')?.classList.remove('hidden');
}

function openWipeDialog() {
  const dlg = $('#wipeDialog');
  if (!dlg) return;
  wipeInFlight = false;
  $('#wipeError')?.classList.add('hidden');
  $('#wipeSuccess')?.classList.add('hidden');
  $('#wipeProgress')?.classList.add('hidden');
  if ($('#wipeConfirmInput')) $('#wipeConfirmInput').value = '';
  if ($('#wipeClearLocalCheck')) $('#wipeClearLocalCheck').checked = true;
  const exec = $('#wipeExecuteBtn');
  if (exec) exec.disabled = false;
  wipeSetStep(1);
  // Resolve actor from /api/me when possible
  api('/me').then((r) => {
    wipeActor = (r && r.user && r.user.username) || 'staff';
    if ($('#wipeActorName')) $('#wipeActorName').textContent = wipeActor;
  }).catch(() => {
    wipeActor = 'staff';
    if ($('#wipeActorName')) $('#wipeActorName').textContent = '(not verified — sign in required)';
  });
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeWipeDialog() {
  const dlg = $('#wipeDialog');
  if (!dlg) return;
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

async function executeWipe() {
  // Guard: prevent duplicate concurrent submissions
  if (wipeInFlight) return;

  const errEl = $('#wipeError');
  const okEl = $('#wipeSuccess');
  errEl?.classList.add('hidden');
  okEl?.classList.add('hidden');
  if (okEl) okEl.textContent = '';

  wipeInFlight = true;
  const exec = $('#wipeExecuteBtn');
  if (exec) exec.disabled = true;
  $('#wipeProgress')?.classList.remove('hidden');
  $('#wipeActions3')?.classList.add('hidden');

  const clearLocal = !!$('#wipeClearLocalCheck')?.checked;
  let result = null;
  let category = 'UNKNOWN_ERROR';

  try {
    // --- Sequential client checks ---
    if (!navigator.onLine) {
      category = 'NETWORK_ERROR';
      throw new Error('You are offline. Permanent delete requires a live connection to the server.');
    }

    // Call server (auth is enforced server-side)
    try {
      result = await api('/admin/wipe-data', {
        method: 'POST',
        body: JSON.stringify({
          confirmationPhrase: 'DELETE ALL DATA',
          permanent: true,
          scopes: ['records', 'scan_events'],
        }),
      });
    } catch (apiErr) {
      const status = apiErr && apiErr.status;
      if (status === 401) category = 'AUTH_REQUIRED';
      else if (status === 403) category = 'FORBIDDEN';
      else if (status === 400 || status === 405) category = 'INVALID_REQUEST';
      else if (status === 0 || apiErr.name === 'TypeError') category = 'NETWORK_ERROR';
      else if (apiErr && apiErr.code) category = apiErr.code;
      else category = 'PERMANENT_DELETE_FAILED';

      const parts = [
        apiErr && apiErr.message ? apiErr.message : 'Server request failed',
      ];
      if (status) parts.push('(HTTP ' + status + ')');
      parts.push('[' + category + ']');
      if (apiErr && apiErr.operationId) parts.push('op ' + apiErr.operationId);
      if (apiErr && apiErr.stage) parts.push('stage=' + apiErr.stage);
      throw new Error(parts.join(' '));
    }

    // --- Server response shape ---
    // Accept success: true OR ok: true (never trust HTTP alone without body check)
    const succeeded = !!(result && (result.success === true || result.ok === true));
    if (!succeeded) {
      category = (result && result.code) || 'PERMANENT_DELETE_FAILED';
      const msg = (result && result.error) || 'Server did not confirm deletion success.';
      const op = result && result.operationId ? ' op ' + result.operationId : '';
      throw new Error(msg + ' [' + category + ']' + op);
    }

    // --- Only after confirmed success: local cleanup + UI refresh ---
    if (clearLocal && window.OfflineDB) {
      try {
        await OfflineDB.clearQueue();
        await OfflineDB.clearCachedRecords();
        if (result.dataGeneration != null) await OfflineDB.setDataGeneration(result.dataGeneration);
      } catch (e) {
        console.warn('[NextGen] Local cleanup after confirmed wipe:', e);
      }
    } else if (result.dataGeneration != null && window.OfflineDB) {
      try { await OfflineDB.setDataGeneration(result.dataGeneration); } catch (_) {}
    }

    state.records = [];
    state.recordsLastFetched = 0;
    try {
      await loadRecords({ force: true });
    } catch (e) {
      console.warn('[NextGen] reload after wipe:', e);
    }
    renderHome();
    renderRecords();

    const deleted = result.deleted || {};
    const msg =
      'Permanent wipe confirmed. ' +
      'Removed ~' + (deleted.records ?? 0) + ' registration record(s) and ~' +
      (deleted.scan_events ?? 0) + ' scan event(s). ' +
      'Staff accounts and audit logs were preserved. ' +
      (result.dataGeneration != null ? 'Dataset generation: ' + result.dataGeneration + '. ' : '') +
      (result.operationId ? 'Operation ID: ' + result.operationId + '. ' : '') +
      (result.warning ? 'Note: ' + result.warning : '');

    if (okEl) {
      okEl.textContent = msg;
      okEl.classList.remove('hidden');
    }
    toast('Permanent data wipe completed');
    wipeSetStep('done');
  } catch (err) {
    const text = (err && err.message) ? err.message : String(err);
    if (errEl) {
      errEl.textContent = text;
      errEl.classList.remove('hidden');
    }
    // Do NOT clear local queues on failure
    toast('Deletion did not complete — ' + (category || 'see dialog'));
    $('#wipeActions3')?.classList.remove('hidden');
    if (exec) exec.disabled = false;
  } finally {
    wipeInFlight = false;
    $('#wipeProgress')?.classList.add('hidden');
  }
}

$('#wipeAllDataBtn')?.addEventListener('click', openWipeDialog);
$('#wipeDialogClose')?.addEventListener('click', closeWipeDialog);
$('#wipeCancel1')?.addEventListener('click', closeWipeDialog);
$('#wipeContinue1')?.addEventListener('click', () => wipeSetStep(2));
$('#wipeBack2')?.addEventListener('click', () => wipeSetStep(1));
$('#wipeContinue2')?.addEventListener('click', () => {
  const typed = ($('#wipeConfirmInput')?.value || '').trim();
  if (typed !== 'DELETE ALL DATA') {
    toast('Type DELETE ALL DATA exactly to continue');
    return;
  }
  const summary = $('#wipeFinalSummary');
  if (summary) {
    summary.textContent =
      `Administrator: ${wipeActor || 'staff'}. Scope: registration records + scan events. ` +
      `Preserved: users, audit logs, credentials. ` +
      ($('#wipeClearLocalCheck')?.checked
        ? 'This device offline queue will be cleared after success.'
        : 'This device offline queue will NOT be cleared automatically.');
  }
  wipeSetStep(3);
});
$('#wipeBack3')?.addEventListener('click', () => wipeSetStep(2));
$('#wipeExecuteBtn')?.addEventListener('click', () => {
  // Re-check phrase on final click in case user went back
  const typed = ($('#wipeConfirmInput')?.value || '').trim();
  if (typed !== 'DELETE ALL DATA') {
    toast('Confirmation phrase no longer matches — go back and re-enter DELETE ALL DATA');
    wipeSetStep(2);
    return;
  }
  executeWipe();
});
$('#wipeDoneBtn')?.addEventListener('click', closeWipeDialog);

// UI bindings
document.addEventListener('DOMContentLoaded', () => {
  $('#queueBadge')?.addEventListener('click', () => {
    $('#offlinePanel')?.classList.remove('hidden');
    refreshQueueUI();
  });
  $('#closeOfflinePanel')?.addEventListener('click', () => $('#offlinePanel')?.classList.add('hidden'));
  $('#syncNowBtn')?.addEventListener('click', () => syncQueue());
  $('#exportQueueBtn')?.addEventListener('click', async () => {
    if (!window.OfflineDB) return;
    const pending = await OfflineDB.exportPending();
    if (!pending.length) { toast('No pending records to export'); return; }
    const blob = new Blob([JSON.stringify(pending, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ngsc-pending-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    toast('Pending records exported');
  });
  refreshQueueUI();
});

// Start session + dashboard load after script initialization
checkSession();

// Defer library preloading so it doesn't compete with first paint / auth.
setTimeout(() => { preloadExportLibs().catch(() => {}); }, 2000);
