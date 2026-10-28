import { api, ApiError, escapeHtml, toast, showFieldErrors, clearFieldErrors, setBusy, storage } from './api.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  session: null,
  hiring: { open: true, message: '' },
  options: null,
  clockOffset: 0,
  timer: null,
  editingId: null,
};

const SCREENS = ['welcome', 'rules', 'workspace', 'review', 'apply', 'done'];
const STEP_OF = { welcome: 'intro', rules: 'intro', workspace: 'challenge', review: 'review', apply: 'apply', done: 'apply' };
const STEP_ORDER = ['intro', 'challenge', 'review', 'apply'];
const uiKey = () => `sqa_ui_${state.session?.reference || 'anon'}`;

// ---------------------------------------------------------------- screens
function show(name, { focus = true } = {}) {
  $('#boot').hidden = true;
  for (const s of SCREENS) $(`#screen-${s}`).hidden = s !== name;
  const current = STEP_OF[name];
  const idx = STEP_ORDER.indexOf(current);
  $$('.stepper li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('current', i === idx);
    li.classList.toggle('done', i < idx || (name === 'done' && i === idx));
    if (i === idx) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  if (state.session?.status === 'in_progress' && (name === 'workspace' || name === 'review')) storage.set(uiKey(), name);
  if (name === 'workspace') enterWorkspace();
  if (name === 'review') renderReview();
  if (name === 'apply') enterApply();
  if (name === 'done' && state.session && !$('#done-ref').textContent) $('#done-ref').textContent = state.session.reference;
  applyHiringState(name);
  if (focus) {
    window.scrollTo(0, 0);
    const heading = $(`#screen-${name} h1`);
    heading?.focus({ preventScroll: true });
  }
}

function routeFromSession() {
  const s = state.session;
  if (!s || s.status === 'none') return show(storage.get('sqa_ui_anon') === 'rules' ? 'rules' : 'welcome', { focus: false });
  if (s.status === 'in_progress') return show(storage.get(uiKey()) === 'review' ? 'review' : 'workspace', { focus: false });
  if (s.status === 'submitted') return show('apply', { focus: false });
  return show('done', { focus: false });
}

// ---------------------------------------------------------------- hiring open/closed
let currentScreen = null;

/** Reflects the admin's "applications open" switch. The server enforces it too. */
function applyHiringState(name = currentScreen) {
  currentScreen = name;
  const closed = !state.hiring.open;
  const status = state.session?.status;
  const banner = $('#closed-banner');
  banner.hidden = !closed || name === 'done' || !name;
  $('[data-msg]', banner).textContent = state.hiring.message;
  $('[data-progress]', banner).hidden = !(status === 'in_progress' || status === 'submitted');
  $('#welcome-start').hidden = closed;
  $('#welcome-closed').hidden = !closed;
  $('#welcome-eyebrow').textContent = closed ? 'Applications closed · SQA Intern' : "We're hiring · SQA Intern";
  for (const id of ['#start-challenge', '#submit-challenge', '#apply-submit']) {
    const btn = $(id);
    if (btn.querySelector('.spinner')) continue; // a request is in flight
    btn.disabled = closed || (id === '#submit-challenge' && !(state.session?.reports.length > 0));
    btn.title = closed ? 'Applications are currently closed' : '';
  }
}

function handleHiringClosed(err) {
  if (err?.details?.hiring !== 'closed') return false;
  state.hiring = { open: false, message: err.message };
  applyHiringState();
  return true;
}

async function loadSession() {
  const data = await api('/api/session');
  state.options = data.options;
  state.hiring = data.hiring || { open: true, message: '' };
  state.session = data.status === 'none' ? null : data;
  if (data.serverTime) state.clockOffset = Date.parse(data.serverTime) - Date.now();
  return data;
}

async function boot() {
  $('#boot').hidden = false;
  $('#boot-error').hidden = true;
  try {
    await loadSession();
    populateSelects();
    routeFromSession();
  } catch (err) {
    $('#boot').hidden = true;
    $('#boot-error').hidden = false;
    $('#boot-error [data-msg]').textContent = err.message;
  }
}

function populateSelects() {
  const fill = (sel, values) => {
    const el = $(sel);
    if (el.options.length > 1) return;
    for (const v of values) el.add(new Option(v, v));
  };
  fill('#r-module', state.options.modules);
  fill('#r-severity', state.options.severities);
  fill('#r-priority', state.options.priorities);
  fill('#a-educationLevel', state.options.educationLevels);
}

// ---------------------------------------------------------------- dialogs
function confirmDialog(message, { okLabel = 'Confirm', danger = false } = {}) {
  const dlg = $('#confirm-dialog');
  $('#confirm-msg').textContent = message;
  const ok = $('#confirm-ok');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (answer) => {
      dlg.close();
      dlg.removeEventListener('cancel', onCancel);
      $$('[data-answer]', dlg).forEach((b) => (b.onclick = null));
      resolve(answer);
    };
    const onCancel = () => resolve(false);
    dlg.addEventListener('cancel', onCancel, { once: true });
    $$('[data-answer]', dlg).forEach((b) => (b.onclick = () => done(b.dataset.answer === 'yes')));
    $('[data-answer="no"]', dlg).focus();
  });
}

$$('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

// ---------------------------------------------------------------- welcome & rules
$$('[data-go]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const target = btn.dataset.go;
    if (target === 'rules' || target === 'welcome') storage.set('sqa_ui_anon', target);
    show(target);
  }),
);
$('[data-retry]').addEventListener('click', boot);

$('#start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#start-error');
  const box = form.elements.acceptedRules;
  if (!box.checked) {
    err.textContent = 'Please confirm that you have read the rules before starting.';
    err.hidden = false;
    box.setAttribute('aria-invalid', 'true');
    box.focus();
    return;
  }
  err.hidden = true;
  box.removeAttribute('aria-invalid');
  const btn = form.querySelector('[type=submit]');
  setBusy(btn, true, 'Starting…');
  try {
    const data = await api('/api/session/start', { method: 'POST', body: { acceptedRules: true } });
    state.session = data;
    state.hiring = data.hiring || state.hiring;
    state.clockOffset = Date.parse(data.serverTime) - Date.now();
    storage.remove('sqa_ui_anon');
    show('workspace');
    toast('Challenge started — good luck! Your progress is saved automatically.', 'success');
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    handleHiringClosed(ex);
  } finally {
    setBusy(btn, false);
    applyHiringState();
  }
});

// ---------------------------------------------------------------- workspace
function enterWorkspace() {
  const frame = $('#demo-frame');
  if (frame.getAttribute('src') === 'about:blank') frame.setAttribute('src', '/demo/');
  renderReports();
  updateStats();
  startTimer();
}

function startTimer() {
  if (state.timer) return;
  const tick = () => {
    const s = state.session;
    if (!s) return;
    const end = s.submittedAt ? Date.parse(s.submittedAt) : Date.now() + state.clockOffset;
    const secs = Math.max(0, Math.floor((end - Date.parse(s.startedAt)) / 1000));
    const h = Math.floor(secs / 3600);
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const sec = String(secs % 60).padStart(2, '0');
    $('#timer').textContent = h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function updateStats() {
  const s = state.session;
  const n = s.reports.length;
  $('#report-count').textContent = n;
  $('#tab-report-count').textContent = n;
  $('#hint-count').textContent = `${s.hintsUsed} / ${s.hintsAvailable}`;
}

const sevClass = (s) => `badge badge-${String(s).toLowerCase()}`;

function renderReports() {
  const list = $('#report-list');
  const reports = state.session.reports;
  if (!reports.length) {
    list.innerHTML = `<div class="empty"><p><strong>No reports yet.</strong></p><p>Found something odd in ShopNest? Click <em>New</em> to write your first bug report.</p></div>`;
    return;
  }
  list.innerHTML = reports
    .map(
      (r, i) => `
      <article class="report-item" data-id="${escapeHtml(r.id)}">
        <h3>#${i + 1} ${escapeHtml(r.title)}</h3>
        <div class="report-meta">
          <span class="badge">${escapeHtml(r.module)}</span>
          <span class="${sevClass(r.severity)}">${escapeHtml(r.severity)}</span>
          <span class="badge">${escapeHtml(r.priority)}</span>
          ${r.evidence ? '<span class="badge badge-primary">📎 evidence</span>' : ''}
        </div>
        <div class="report-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${escapeHtml(r.id)}" aria-label="Edit report ${i + 1}: ${escapeHtml(r.title)}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete="${escapeHtml(r.id)}" aria-label="Delete report ${i + 1}: ${escapeHtml(r.title)}">Delete</button>
        </div>
      </article>`,
    )
    .join('');
}

async function deleteReport(id) {
  const r = state.session.reports.find((x) => x.id === id);
  if (!r) return;
  const ok = await confirmDialog(`Delete the report “${r.title}”? This cannot be undone.`, { okLabel: 'Delete report', danger: true });
  if (!ok) return;
  try {
    await api(`/api/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.session.reports = state.session.reports.filter((x) => x.id !== id);
    storage.remove(draftKey(id));
    renderReports();
    updateStats();
    if (!$('#screen-review').hidden) renderReview();
    toast('Report deleted.');
  } catch (err) {
    handleLockedOrToast(err);
  }
}

function handleLockedOrToast(err) {
  if (err instanceof ApiError && err.status === 409) {
    toast(err.message, 'error');
    boot();
  } else toast(err.message, 'error');
}

document.addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openReportDialog(edit.dataset.edit);
  const del = e.target.closest('[data-delete]');
  if (del) return deleteReport(del.dataset.delete);
});

$('#new-report').addEventListener('click', () => openReportDialog(null));
$('#new-report-2').addEventListener('click', () => openReportDialog(null));
$('#go-review').addEventListener('click', () => show('review'));

$$('.viewport-toggle button').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.viewport-toggle button').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    $('#demo-frame').style.width = btn.dataset.width;
    $('.frame-wrap').classList.toggle('constrained', btn.dataset.width !== '100%');
  }),
);
$('.viewport-toggle').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const buttons = $$('.viewport-toggle button');
  const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
  next.click();
  next.focus();
});

$('#reload-demo').addEventListener('click', () => $('#demo-frame').contentWindow?.location.reload());
$('#reset-demo').addEventListener('click', async () => {
  const ok = await confirmDialog('Reset the ShopNest demo? Registered demo accounts, profile changes, the cart and orders will be cleared. Your bug reports are NOT affected.', { okLabel: 'Reset demo' });
  if (!ok) return;
  try {
    await api('/demo-api/reset', { method: 'POST' });
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('shopnest')).forEach((k) => localStorage.removeItem(k));
    } catch {}
    $('#demo-frame').contentWindow?.location.replace('/demo/');
    toast('Demo data reset.');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Mobile tabs
$$('.ws-tabs [role=tab]').forEach((tab) =>
  tab.addEventListener('click', () => selectTab(tab)),
);
$('.ws-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = $$('.ws-tabs [role=tab]');
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + 1) % tabs.length];
  selectTab(next);
  next.focus();
});
function selectTab(tab) {
  $$('.ws-tabs [role=tab]').forEach((t) => {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).dataset.hidden = String(!selected);
  });
}
$('#panel-reports').dataset.hidden = 'true';

// ---------------------------------------------------------------- report dialog
const draftKey = (id) => `sqa_draft_${state.session?.reference}_${id || 'new'}`;
const REPORT_FIELDS = ['title', 'module', 'severity', 'priority', 'steps', 'expected', 'actual'];

function openReportDialog(id) {
  if (state.session.status !== 'in_progress') return;
  const form = $('#report-form');
  form.reset();
  clearFieldErrors(form);
  $('#report-error').hidden = true;
  state.editingId = id;
  const existing = id ? state.session.reports.find((r) => r.id === id) : null;
  $('#report-dialog-title').textContent = existing ? 'Edit bug report' : 'New bug report';
  const draft = storage.get(draftKey(id));
  const source = draft || existing || {};
  for (const f of REPORT_FIELDS) form.elements[f].value = source[f] ?? '';
  $('#draft-note').hidden = !draft;

  const cur = $('#r-evidence-current');
  if (existing?.evidence) {
    cur.hidden = false;
    cur.innerHTML = `<img src="${escapeHtml(existing.evidence.url)}" alt="Current evidence"><span>${escapeHtml(existing.evidence.name)}</span>
      <label class="check" style="margin:0 0 0 auto"><input type="checkbox" name="removeEvidence" value="1"> Remove</label>`;
  } else {
    cur.hidden = true;
    cur.innerHTML = '';
  }
  $('#report-dialog').showModal();
  form.elements.title.focus();
}

$('#report-form').addEventListener('input', (e) => {
  if (!REPORT_FIELDS.includes(e.target.name)) return;
  const form = e.currentTarget;
  const draft = Object.fromEntries(REPORT_FIELDS.map((f) => [f, form.elements[f].value]));
  storage.set(draftKey(state.editingId), draft);
});

function validateReportClient(form) {
  const v = (n) => form.elements[n].value.trim();
  const errors = {};
  if (v('title').length < 5) errors.title = 'Bug title must be at least 5 characters.';
  if (!v('module')) errors.module = 'Choose the affected module.';
  if (!v('severity')) errors.severity = 'Choose a severity.';
  if (!v('priority')) errors.priority = 'Choose a priority.';
  if (v('steps').length < 10) errors.steps = 'Describe the steps to reproduce (at least 10 characters).';
  if (v('expected').length < 5) errors.expected = 'Describe the expected result (at least 5 characters).';
  if (v('actual').length < 5) errors.actual = 'Describe the actual result (at least 5 characters).';
  const file = form.elements.evidence.files[0];
  if (file) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) errors.evidence = 'Evidence must be a PNG, JPG, GIF or WebP image.';
    else if (file.size > 3 * 1024 * 1024) errors.evidence = 'Evidence image must be 3 MB or smaller.';
  }
  return errors;
}

$('#report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = $('#report-error');
  errBox.hidden = true;
  const errors = validateReportClient(form);
  if (Object.keys(errors).length) {
    showFieldErrors(form, errors)?.focus();
    return;
  }
  clearFieldErrors(form);
  const fd = new FormData();
  for (const f of REPORT_FIELDS) fd.append(f, form.elements[f].value);
  const file = form.elements.evidence.files[0];
  if (file) fd.append('evidence', file);
  if (form.elements.removeEvidence?.checked) fd.append('removeEvidence', '1');
  const btn = $('#report-save');
  setBusy(btn, true, 'Saving…');
  try {
    const id = state.editingId;
    const saved = id
      ? await api(`/api/reports/${encodeURIComponent(id)}`, { method: 'PUT', form: fd })
      : await api('/api/reports', { method: 'POST', form: fd });
    if (id) state.session.reports = state.session.reports.map((r) => (r.id === id ? saved : r));
    else state.session.reports.push(saved);
    storage.remove(draftKey(id));
    $('#report-dialog').close();
    renderReports();
    updateStats();
    if (!$('#screen-review').hidden) renderReview();
    toast(id ? 'Report updated.' : 'Report saved.', 'success');
  } catch (err) {
    if (err.status === 422 && err.details && Object.keys(err.details).length) showFieldErrors(form, err.details)?.focus();
    errBox.textContent = err.message;
    errBox.hidden = false;
    if (err.status === 409) {
      $('#report-dialog').close();
      handleLockedOrToast(err);
    }
  } finally {
    setBusy(btn, false);
  }
});

// ---------------------------------------------------------------- hints
function renderHints() {
  const s = state.session;
  $('#hint-list').innerHTML = s.hints.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  $('#hints-none').hidden = s.hints.length > 0;
  const btn = $('#reveal-hint');
  const left = s.hintsAvailable - s.hintsUsed;
  btn.disabled = left <= 0;
  btn.textContent = left > 0 ? `Reveal next hint (${left} left · score penalty)` : 'No more hints';
}
$('#open-hints').addEventListener('click', () => {
  renderHints();
  $('#hints-dialog').showModal();
});
$('#reveal-hint').addEventListener('click', async () => {
  const btn = $('#reveal-hint');
  setBusy(btn, true, 'Revealing…');
  try {
    const data = await api('/api/hints', { method: 'POST' });
    Object.assign(state.session, { hints: data.hints, hintsUsed: data.hintsUsed });
    updateStats();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
    renderHints();
  }
});

// ---------------------------------------------------------------- review
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
function similar(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size >= 0.6;
}

function renderReview() {
  const reports = state.session.reports;
  const warnings = [];
  if (!reports.length) warnings.push(['warning', 'You have not reported any issues yet. Go back to testing and add at least one report.']);
  const pairs = [];
  for (let i = 0; i < reports.length; i++)
    for (let j = i + 1; j < reports.length; j++) if (similar(reports[i].title, reports[j].title)) pairs.push(`#${i + 1} and #${j + 1}`);
  if (pairs.length) warnings.push(['warning', `Reports ${pairs.join(', ')} have very similar titles. Duplicates don't earn extra points — consider merging them.`]);
  const thin = reports.map((r, i) => (r.steps.split(/\n/).filter((l) => l.trim()).length < 2 ? `#${i + 1}` : null)).filter(Boolean);
  if (thin.length) warnings.push(['info', `Reports ${thin.join(', ')} have single-line reproduction steps. Numbered steps make bugs much easier to reproduce.`]);
  $('#review-warnings').innerHTML = warnings.map(([t, m]) => `<div class="alert alert-${t}">${escapeHtml(m)}</div>`).join('');

  $('#review-list').innerHTML = reports.length
    ? reports
        .map(
          (r, i) => `
      <article class="card review-card">
        <h3>#${i + 1} ${escapeHtml(r.title)}</h3>
        <div class="report-meta">
          <span class="badge">${escapeHtml(r.module)}</span>
          <span class="${sevClass(r.severity)}">Severity: ${escapeHtml(r.severity)}</span>
          <span class="badge">Priority: ${escapeHtml(r.priority)}</span>
        </div>
        <dl>
          <dt>Steps</dt><dd>${escapeHtml(r.steps)}</dd>
          <dt>Expected</dt><dd>${escapeHtml(r.expected)}</dd>
          <dt>Actual</dt><dd>${escapeHtml(r.actual)}</dd>
          <dt>Evidence</dt><dd>${r.evidence ? `<a href="${escapeHtml(r.evidence.url)}" target="_blank" rel="noopener">${escapeHtml(r.evidence.name)}</a>` : '<span class="muted">None</span>'}</dd>
        </dl>
        <div class="report-actions">
          <button class="btn btn-secondary btn-sm" data-edit="${escapeHtml(r.id)}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete="${escapeHtml(r.id)}">Delete</button>
        </div>
      </article>`,
        )
        .join('')
    : '<div class="empty">No reports to review.</div>';
  applyHiringState();
}

$('#submit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#submit-error');
  const box = form.elements.confirm;
  if (!box.checked) {
    err.textContent = 'Please tick the confirmation box to submit your challenge.';
    err.hidden = false;
    box.setAttribute('aria-invalid', 'true');
    box.focus();
    return;
  }
  box.removeAttribute('aria-invalid');
  err.hidden = true;
  const ok = await confirmDialog(`Submit ${state.session.reports.length} report(s) now? You won't be able to change them afterwards.`, { okLabel: 'Submit challenge' });
  if (!ok) return;
  const btn = $('#submit-challenge');
  setBusy(btn, true, 'Submitting…');
  try {
    await api('/api/challenge/submit', { method: 'POST', body: { confirm: true } });
    await loadSession();
    clearInterval(state.timer);
    state.timer = null;
    show('apply');
    toast('Challenge submitted. The application form is now unlocked.', 'success');
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    handleHiringClosed(ex);
    if (ex.status === 409) boot();
  } finally {
    setBusy(btn, false);
    applyHiringState();
  }
});

// ---------------------------------------------------------------- application
function enterApply() {
  $('#submitted-count').textContent = state.session.reports.length;
  const saved = storage.get(`sqa_app_${state.session.reference}`);
  const form = $('#apply-form');
  if (saved && !form.dataset.restored) {
    for (const [k, v] of Object.entries(saved)) if (form.elements[k] && form.elements[k].type !== 'file') form.elements[k].value = v;
    form.dataset.restored = '1';
  }
  updateWhyCount();
}

function updateWhyCount() {
  const n = $('#a-whySqa').value.trim().length;
  $('#a-whySqa-count').textContent = `${n} / 1500 characters (minimum 50)`;
}
$('#a-whySqa').addEventListener('input', updateWhyCount);

const APP_FIELDS = ['fullName', 'email', 'phone', 'educationLevel', 'institution', 'experience', 'profileUrl', 'whySqa'];
$('#apply-form').addEventListener('input', (e) => {
  if (!APP_FIELDS.includes(e.target.name)) return;
  const form = e.currentTarget;
  storage.set(`sqa_app_${state.session.reference}`, Object.fromEntries(APP_FIELDS.map((f) => [f, form.elements[f].value])));
});

function validateApplicationClient(form) {
  const v = (n) => form.elements[n].value.trim();
  const errors = {};
  if (v('fullName').length < 2) errors.fullName = 'Full name is required.';
  else if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(v('fullName'))) errors.fullName = 'Full name can only contain letters, spaces, dots, apostrophes and hyphens.';
  if (!v('email')) errors.email = 'Email address is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v('email'))) errors.email = 'Enter a valid email address, e.g. name@example.com.';
  const digits = v('phone').replace(/\D/g, '');
  if (!v('phone')) errors.phone = 'Phone number is required.';
  else if (!/^\+?[0-9][0-9\s-]{6,18}[0-9]$/.test(v('phone')) || digits.length < 7 || digits.length > 15) errors.phone = 'Enter a valid phone number (7–15 digits, optional leading +).';
  if (!v('educationLevel')) errors.educationLevel = 'Select your current education level.';
  if (v('institution').length < 2) errors.institution = 'University or institution is required.';
  if (v('profileUrl') && !/^https?:\/\/[^\s/]+\.[^\s]+/i.test(v('profileUrl'))) errors.profileUrl = 'Enter a full URL starting with https://, or leave it blank.';
  if (v('whySqa').length < 50) errors.whySqa = `Please write at least 50 characters (currently ${v('whySqa').length}).`;
  const file = form.elements.cv.files[0];
  if (!file) errors.cv = 'Please upload your CV (PDF, DOC or DOCX, max 4 MB).';
  else if (!/\.(pdf|docx?)$/i.test(file.name)) errors.cv = 'CV must be a PDF, DOC or DOCX file.';
  else if (file.size > 4 * 1024 * 1024) errors.cv = 'CV must be 4 MB or smaller.';
  return errors;
}

$('#apply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = $('#apply-error');
  errBox.hidden = true;
  const errors = validateApplicationClient(form);
  if (Object.keys(errors).length) {
    errBox.textContent = `Please fix ${Object.keys(errors).length} field(s) highlighted below.`;
    errBox.hidden = false;
    showFieldErrors(form, errors)?.focus();
    return;
  }
  clearFieldErrors(form);
  const btn = $('#apply-submit');
  setBusy(btn, true, 'Submitting application…');
  try {
    const result = await api('/api/application', { method: 'POST', form: new FormData(form) });
    storage.remove(`sqa_app_${state.session.reference}`);
    state.session.status = 'applied';
    $('#done-ref').textContent = result.reference;
    $('#done-msg').textContent = `Thank you, ${result.name}! Your application for the SQA Intern position has been received. We'll contact you at ${result.email}.`;
    show('done');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
    if (handleHiringClosed(err)) errBox.scrollIntoView({ block: 'center' });
    else {
      if (err.details && Object.keys(err.details).length) showFieldErrors(form, err.details)?.focus();
      else errBox.scrollIntoView({ block: 'center' });
      if (err.status === 403 || (err.status === 409 && !err.details?.email)) boot();
    }
  } finally {
    setBusy(btn, false);
    applyHiringState();
  }
});

boot();
