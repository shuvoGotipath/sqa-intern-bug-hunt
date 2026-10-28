import { api, escapeHtml as esc, toast, setBusy } from '/js/api.js';

const main = document.getElementById('ad-main');
const nav = document.getElementById('ad-nav');
const STAGES = { in_progress: 'Testing in progress', submitted: 'Challenge submitted', applied: 'Applied' };
const STATUSES = { under_review: 'Under review', shortlisted: 'Shortlisted', rejected: 'Rejected' };
const STATUS_BADGE = { under_review: 'badge-warning', shortlisted: 'badge-success', rejected: 'badge-danger' };
let answerKey = null;
let filters = { q: '', stage: 'all', status: 'all', minScore: '', maxScore: '' };

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const scoreCell = (s) => (s === null || s === undefined ? '<span class="muted">—</span>' : `<span class="score">${s.toFixed(1)}%</span><span class="score-bar" aria-hidden="true"><i style="width:${Math.min(100, s)}%"></i></span>`);

function loading() {
  main.innerHTML = '<div class="loading"><span class="spinner" aria-hidden="true"></span> Loading…</div>';
}
function errorView(err) {
  main.innerHTML = `<div class="alert alert-error" role="alert">${esc(err.message)} <button class="btn btn-sm btn-secondary" id="retry">Retry</button></div>`;
  document.getElementById('retry').onclick = route;
}

// ------------------------------------------------------------- auth
function loginView(message) {
  nav.hidden = true;
  main.innerHTML = `
    <div class="card ad-login">
      <h1>Admin sign in</h1>
      <p class="muted">Restricted to the hiring team.</p>
      ${message ? `<div class="alert alert-info">${esc(message)}</div>` : ''}
      <div class="alert alert-error" id="login-error" role="alert" hidden></div>
      <form id="login-form" novalidate>
        <div class="field"><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" required></div>
        <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary" type="submit" style="width:100%">Sign in</button>
      </form>
    </div>`;
  const form = document.getElementById('login-form');
  form.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    if (!form.username.value || !form.password.value) {
      err.textContent = 'Enter your username and password.';
      err.hidden = false;
      return;
    }
    const btn = form.querySelector('button');
    setBusy(btn, true, 'Signing in…');
    try {
      await api('/api/admin/login', { method: 'POST', body: { username: form.username.value, password: form.password.value } });
      if (!location.hash || location.hash === '#/login') location.hash = '#/candidates';
      route();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      setBusy(btn, false);
    }
  });
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  loginView('You have been signed out.');
});

async function guarded(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) return loginView('Please sign in to continue.');
    errorView(err);
  }
}

// ------------------------------------------------------------- candidates list
function queryString() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== '' && v !== 'all') p.set(k, v);
  return p.toString();
}

// ------------------------------------------------------------- hiring switch
function renderHiringCard(h) {
  const box = document.getElementById('hiring-card');
  if (!box) return;
  box.className = `card hiring-card ${h.open ? 'is-open' : 'is-closed'}`;
  box.innerHTML = `
    <div class="hiring-row">
      <div>
        <h2>Applications</h2>
        <p class="hiring-status">${h.open
          ? '<span class="badge badge-success">● Open</span> Candidates can start the challenge and apply.'
          : '<span class="badge badge-danger">● Closed</span> New candidates can’t start, and nobody can submit the challenge or apply. Saved progress is kept.'}</p>
        ${h.updatedAt ? `<p class="muted hiring-updated">Last changed ${esc(fmtDate(h.updatedAt))}</p>` : ''}
      </div>
      <button class="btn ${h.open ? 'btn-danger' : 'btn-primary'}" id="hiring-toggle">${h.open ? 'Close applications' : 'Reopen applications'}</button>
    </div>
    <form id="hiring-msg-form" class="hiring-msg">
      <div class="field">
        <label for="hiring-msg">Message shown to candidates while closed <span class="muted">(optional)</span></label>
        <textarea id="hiring-msg" name="closedMessage" rows="2" maxlength="300" placeholder="Applications for the SQA Intern role are currently closed. Please check back later.">${esc(h.customMessage)}</textarea>
      </div>
      <button class="btn btn-secondary btn-sm" type="submit">Save message</button>
    </form>`;

  document.getElementById('hiring-toggle').addEventListener('click', async (e) => {
    const closing = h.open;
    const question = closing
      ? 'Close applications? New candidates won’t be able to start the challenge, and nobody will be able to submit the challenge or an application until you reopen.'
      : 'Reopen applications? Candidates will be able to start the challenge and apply again.';
    if (!window.confirm(question)) return;
    setBusy(e.currentTarget, true, closing ? 'Closing…' : 'Reopening…');
    try {
      const msg = document.getElementById('hiring-msg').value;
      const { hiring } = await api('/api/admin/settings', { method: 'PUT', body: { applicationsOpen: !closing, closedMessage: msg } });
      renderHiringCard(hiring);
      toast(closing ? 'Applications are now closed.' : 'Applications are open again.', 'success');
    } catch (err) {
      toast(err.message, 'error');
      setBusy(e.currentTarget, false);
    }
  });
  document.getElementById('hiring-msg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { hiring } = await api('/api/admin/settings', { method: 'PUT', body: { closedMessage: e.target.closedMessage.value } });
      renderHiringCard(hiring);
      toast('Message saved.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function candidatesView() {
  loading();
  const [data, settings] = await Promise.all([api('/api/admin/candidates?' + queryString()), api('/api/admin/settings')]);
  const st = data.stats;
  const started = Object.values(st.stages).reduce((a, b) => a + b, 0);
  main.innerHTML = `
    <h1>Candidates</h1>
    <section id="hiring-card" aria-label="Application intake"></section>
    <div class="stats">
      <div class="card"><strong>${started}</strong><span>Challenges started</span></div>
      <div class="card"><strong>${(st.stages.submitted || 0) + (st.stages.applied || 0)}</strong><span>Challenges submitted</span></div>
      <div class="card"><strong>${st.stages.applied || 0}</strong><span>Applications</span></div>
      <div class="card"><strong>${st.applications.shortlisted || 0}</strong><span>Shortlisted</span></div>
      <div class="card"><strong>${st.applications.rejected || 0}</strong><span>Rejected</span></div>
    </div>
    <form class="filters card" id="filters" role="search" style="padding:14px 16px">
      <div class="field grow"><label for="f-q">Search</label><input id="f-q" name="q" type="search" placeholder="Name, email, institution or reference" value="${esc(filters.q)}"></div>
      <div class="field"><label for="f-stage">Stage</label><select id="f-stage" name="stage">
        <option value="all">All stages</option>${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${filters.stage === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label for="f-status">Application status</label><select id="f-status" name="status">
        <option value="all">Any status</option>${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${filters.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label for="f-min">Min score %</label><input id="f-min" name="minScore" type="number" min="0" max="100" value="${esc(filters.minScore)}"></div>
      <div class="field"><label for="f-max">Max score %</label><input id="f-max" name="maxScore" type="number" min="0" max="100" value="${esc(filters.maxScore)}"></div>
      <button class="btn btn-primary" type="submit">Apply</button>
      <button class="btn btn-secondary" type="button" id="f-reset">Reset</button>
      <a class="btn btn-secondary" href="/api/admin/export.csv?${esc(queryString())}" download>⬇ Export CSV</a>
    </form>
    ${data.candidates.length
      ? `<div class="table-wrap"><table>
      <thead><tr><th>Candidate</th><th>Stage</th><th>Status</th><th>Score</th><th>Bugs found</th><th>Reports</th><th>Hints</th><th>Time</th><th>Submitted</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${data.candidates
        .map(
          (c) => `<tr class="clickable" data-id="${esc(c.reference)}">
          <td><a href="#/candidate/${encodeURIComponent(c.reference)}"><strong>${esc(c.application?.fullName || 'No application yet')}</strong></a><br><span class="muted">${esc(c.application?.email || c.reference)}</span></td>
          <td>${esc(STAGES[c.stage])}</td>
          <td>${c.application ? `<span class="badge ${STATUS_BADGE[c.application.status]}">${esc(STATUSES[c.application.status])}</span>` : '<span class="muted">—</span>'}</td>
          <td>${scoreCell(c.score)}</td>
          <td>${c.bugsFound ?? '—'} / ${c.totalBugs}</td>
          <td>${c.reportCount}</td>
          <td>${c.hintsUsed}</td>
          <td>${c.minutesSpent !== null ? c.minutesSpent + ' min' : '—'}</td>
          <td>${esc(fmtDate(c.submittedAt))}</td>
          <td><button class="btn btn-danger btn-sm" data-trash="${esc(c.reference)}" data-name="${esc(c.application?.fullName || c.reference)}" aria-label="Move ${esc(c.application?.fullName || c.reference)} to trash">Delete</button></td>
        </tr>`,
        )
        .join('')}</tbody></table></div>`
      : '<div class="empty">No candidates match these filters yet.</div>'}`;

  renderHiringCard(settings.hiring);
  const form = document.getElementById('filters');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    filters = Object.fromEntries(new FormData(form));
    guarded(candidatesView);
  });
  document.getElementById('f-reset').onclick = () => {
    filters = { q: '', stage: 'all', status: 'all', minScore: '', maxScore: '' };
    guarded(candidatesView);
  };
  setTrashCount(data.stats.trashed);
  main.querySelectorAll('tr.clickable').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (!e.target.closest('a, button')) location.hash = '#/candidate/' + encodeURIComponent(tr.dataset.id);
    }),
  );
  main.querySelectorAll('[data-trash]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (await trashCandidate(btn.dataset.trash, btn.dataset.name)) guarded(candidatesView);
    }),
  );
}

// ------------------------------------------------------------- trash actions
function setTrashCount(n) {
  const el = document.getElementById('trash-count');
  el.textContent = n || '';
  el.hidden = !n;
}

async function trashCandidate(ref, name) {
  if (!window.confirm(`Move ${name} to the trash?\n\nThey'll be hidden from the candidate list, stats and CSV export. You can restore them from the Trash page.`)) return false;
  try {
    await api(`/api/admin/candidates/${encodeURIComponent(ref)}/trash`, { method: 'POST' });
    toast(`${name} moved to the trash.`, 'success');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

async function restoreCandidate(ref, name) {
  try {
    await api(`/api/admin/candidates/${encodeURIComponent(ref)}/restore`, { method: 'POST' });
    toast(`${name} restored.`, 'success');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

async function deleteForever(ref, name) {
  if (!window.confirm(`Permanently delete ${name}?\n\nThis removes their application, CV, bug reports and score for good. This cannot be undone.`)) return false;
  try {
    const r = await api(`/api/admin/candidates/${encodeURIComponent(ref)}`, { method: 'DELETE' });
    toast(r.filesFailed ? `${name} deleted, but ${r.filesFailed} file(s) could not be removed from storage.` : `${name} permanently deleted.`, r.filesFailed ? 'error' : 'success');
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

async function trashView() {
  loading();
  const data = await api('/api/admin/candidates?trash=1');
  setTrashCount(data.candidates.length);
  main.innerHTML = `
    <h1 tabindex="-1">Trash</h1>
    <p class="muted">Deleted candidates stay here until you delete them permanently. Permanent deletion also removes their CV and screenshots from storage and cannot be undone.</p>
    ${data.candidates.length
      ? `<div class="table-wrap"><table>
      <thead><tr><th>Candidate</th><th>Stage</th><th>Score</th><th>Moved to trash</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${data.candidates
        .map((c) => {
          const name = c.application?.fullName || c.reference;
          return `<tr>
          <td><a href="#/candidate/${encodeURIComponent(c.reference)}"><strong>${esc(c.application?.fullName || 'No application')}</strong></a><br><span class="muted">${esc(c.application?.email || c.reference)}</span></td>
          <td>${esc(STAGES[c.stage])}</td>
          <td>${scoreCell(c.score)}</td>
          <td>${esc(fmtDate(c.deletedAt))}</td>
          <td><div class="row-actions">
            <button class="btn btn-secondary btn-sm" data-restore="${esc(c.reference)}" data-name="${esc(name)}">↩ Restore</button>
            <button class="btn btn-danger btn-sm" data-destroy="${esc(c.reference)}" data-name="${esc(name)}">Delete permanently</button>
          </div></td>
        </tr>`;
        })
        .join('')}</tbody></table></div>`
      : '<div class="empty">The trash is empty.</div>'}`;
  main.querySelector('h1').focus();
  main.querySelectorAll('[data-restore]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (await restoreCandidate(btn.dataset.restore, btn.dataset.name)) guarded(trashView);
    }),
  );
  main.querySelectorAll('[data-destroy]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (await deleteForever(btn.dataset.destroy, btn.dataset.name)) guarded(trashView);
    }),
  );
}

// ------------------------------------------------------------- candidate detail
function verdictOptions(current) {
  const opts = [
    ['auto', 'Automatic match'],
    ['invalid', 'Invalid / false positive'],
    ['extra', 'Valid — not in answer key (bonus)'],
    ...answerKey.bugs.map((b) => [`bug:${b.id}`, `Match ${b.id}: ${b.title}`]),
  ];
  return opts.map(([v, l]) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

const RESULT_BADGE = { matched: 'badge-success', duplicate: 'badge-warning', unmatched: 'badge-danger', invalid: 'badge-danger', extra: 'badge-primary' };

function renderDetail(d) {
  const a = d.application;
  const ev = d.evaluation;
  const reportNo = Object.fromEntries(d.reports.map((r, i) => [r.id, i + 1]));
  const BREAKDOWN_LABELS = {
    identification: 'Correctly identified bugs',
    reproducibility: 'Reproducibility / step clarity',
    expectedVsActual: 'Expected vs. actual quality',
    severity: 'Severity accuracy',
    priority: 'Priority accuracy',
    edgeCases: 'Edge-case detection bonus',
    extraFindings: 'Valid extra findings',
    falsePositivePenalty: 'False positives penalty',
    hintPenalty: 'Hint penalty',
  };
  const displayName = a?.fullName || d.reference;
  main.innerHTML = `
    <p>${d.deletedAt ? '<a href="#/trash">← Trash</a>' : '<a href="#/candidates">← All candidates</a>'}</p>
    ${d.deletedAt ? `<div class="alert alert-warning trash-banner" role="status">
      <span><strong>This candidate is in the trash</strong> (moved ${esc(fmtDate(d.deletedAt))}). They're hidden from the candidate list, stats and export.</span>
      <span class="row-actions">
        <button class="btn btn-secondary btn-sm" id="detail-restore">↩ Restore</button>
        <button class="btn btn-danger btn-sm" id="detail-destroy">Delete permanently</button>
      </span>
    </div>` : ''}
    <div class="detail-head">
      <div>
        <h1 tabindex="-1">${esc(a?.fullName || 'Candidate without application')}</h1>
        <div class="muted">Reference <strong>${esc(d.reference)}</strong> · ${esc(STAGES[d.stage])}</div>
      </div>
      <div class="status-actions">
        ${a && !d.deletedAt ? `<span class="status-actions" role="group" aria-label="Application status">
          ${Object.entries(STATUSES).map(([k, v]) => `<button class="btn btn-secondary btn-sm" data-status="${k}" aria-pressed="${a.status === k}">${v}</button>`).join('')}
        </span>` : ''}
        ${d.deletedAt ? '' : '<button class="btn btn-danger btn-sm" id="detail-trash">Delete</button>'}
      </div>
    </div>

    <div class="detail-grid">
      <section class="card">
        <h2>Application</h2>
        ${a ? `<dl class="kv">
          <dt>Email</dt><dd><a href="mailto:${esc(a.email)}">${esc(a.email)}</a></dd>
          <dt>Phone</dt><dd>${esc(a.phone)}</dd>
          <dt>Institution</dt><dd>${esc(a.institution)}</dd>
          <dt>Education level</dt><dd>${esc(a.educationLevel)}</dd>
          <dt>Experience</dt><dd>${a.experience ? esc(a.experience) : '<span class="muted">—</span>'}</dd>
          <dt>LinkedIn / portfolio</dt><dd>${/^https?:\/\//i.test(a.profileUrl) ? `<a href="${esc(a.profileUrl)}" target="_blank" rel="noopener noreferrer">${esc(a.profileUrl)}</a>` : '<span class="muted">—</span>'}</dd>
          <dt>Why SQA?</dt><dd>${esc(a.whySqa)}</dd>
          <dt>CV</dt><dd><span class="cv-actions">
            ${a.cv.previewUrl ? `<button class="btn btn-primary btn-sm" id="cv-preview">👁 Preview</button>` : ''}
            <a class="btn btn-secondary btn-sm" href="${esc(a.cv.url)}">⬇ Download</a>
            <span class="muted">${esc(a.cv.name)}</span>
          </span>${a.cv.previewUrl ? '' : '<br><span class="muted" style="font-size:13px">Preview isn’t available for .doc files — download to view.</span>'}</dd>
          <dt>Applied</dt><dd>${esc(fmtDate(a.appliedAt))}</dd>
        </dl>
        <form id="notes-form" style="margin-top:16px">
          <div class="field"><label for="notes">Internal notes</label><textarea id="notes" name="notes" rows="3" maxlength="5000">${esc(a.notes)}</textarea></div>
          <button class="btn btn-secondary btn-sm" type="submit">Save notes</button>
        </form>` : '<div class="empty">This candidate has not submitted the application form yet.</div>'}
      </section>
      <section class="card">
        <h2>Evaluation</h2>
        ${ev ? `
          <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
            <div><div class="big-score">${ev.score.toFixed(1)}%</div><div class="muted">${ev.rawPoints} / ${ev.maxPoints} points</div></div>
            <div><strong>${ev.bugsFound}</strong> / ${ev.totalBugs} bugs found<br><strong>${ev.edgeCasesFound}</strong> edge cases · <strong>${ev.duplicates}</strong> duplicates · <strong>${ev.unmatched}</strong> unmatched/invalid</div>
          </div>
          <table class="breakdown"><tbody>
            ${Object.entries(BREAKDOWN_LABELS).map(([k, l]) => `<tr><td>${l}</td><td>${(ev.breakdown[k] ?? 0).toFixed(2)}</td></tr>`).join('')}
          </tbody></table>
          <p class="muted" style="margin-top:10px;font-size:13px">Time spent: ${d.minutesSpent ?? '—'} min (context only, not scored) · Hints used: ${d.hintsUsed} · Evaluated ${esc(fmtDate(ev.evaluatedAt))}</p>
          <button class="btn btn-secondary btn-sm" id="reevaluate">Re-run evaluation</button>`
          : '<div class="empty">The candidate is still testing — no evaluation yet.</div>'}
      </section>
    </div>

    <h2 class="section-title">Expected issues vs. reported</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Expected issue</th><th>Module</th><th>Sev / Pri</th><th>Found</th><th>Reports</th></tr></thead>
      <tbody>${d.coverage
        .map(
          (b) => `<tr><td><code>${esc(b.id)}</code></td><td style="white-space:normal;min-width:260px">${esc(b.title)}</td><td>${esc(b.module)}</td><td>${esc(b.severity)} / ${esc(b.priority)}</td>
          <td>${b.found ? '<span class="found-yes">✓ Found</span>' : '<span class="found-no">Not found</span>'}</td>
          <td>${b.reportIds.map((id) => `#${reportNo[id]}`).join(', ') || '—'}</td></tr>`,
        )
        .join('')}</tbody></table></div>

    <h2 class="section-title">Bug reports (${d.reports.length})</h2>
    ${d.reports.length ? d.reports
      .map((r, i) => {
        const res = r.result;
        return `<article class="card report-card">
        <h3>#${i + 1} ${esc(r.title)}</h3>
        <div class="report-meta" style="display:flex;gap:4px;flex-wrap:wrap">
          <span class="badge">${esc(r.module)}</span><span class="badge badge-${esc(r.severity.toLowerCase())}">${esc(r.severity)}</span><span class="badge">${esc(r.priority)}</span>
        </div>
        <div class="cols">
          <div><h4>Steps to reproduce</h4><p>${esc(r.steps)}</p></div>
          <div><h4>Expected</h4><p>${esc(r.expected)}</p></div>
          <div><h4>Actual</h4><p>${esc(r.actual)}</p></div>
        </div>
        ${r.evidence ? `<a href="${esc(r.evidence.url)}" target="_blank" rel="noopener"><img class="evidence-thumb" src="${esc(r.evidence.url)}" alt="Evidence for report ${i + 1}"></a>` : ''}
        <div class="eval-box">
          ${res ? `<span class="badge ${RESULT_BADGE[res.status]}">${esc(res.status)}</span>
            ${res.bugId ? `<span>→ <code>${esc(res.bugId)}</code></span>` : ''}
            <span><strong>${res.points}</strong> pts</span>
            <span class="muted">(${esc(res.matchedBy)})</span>` : '<span class="muted">Not evaluated yet</span>'}
          <label style="margin-left:auto;display:flex;gap:6px;align-items:center">Verdict
            <select data-verdict="${esc(r.id)}" ${ev ? '' : 'disabled'}>${verdictOptions(r.adminVerdict)}</select></label>
          ${res?.notes?.length ? `<ul>${res.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        </div>
      </article>`;
      })
      .join('') : '<div class="empty">No reports yet.</div>'}`;

  main.querySelector('h1').focus();
  document.getElementById('detail-trash')?.addEventListener('click', async () => {
    if (await trashCandidate(d.reference, displayName)) location.hash = '#/candidates';
  });
  document.getElementById('detail-restore')?.addEventListener('click', async () => {
    if (await restoreCandidate(d.reference, displayName)) guarded(() => detailView(d.reference));
  });
  document.getElementById('detail-destroy')?.addEventListener('click', async () => {
    if (await deleteForever(d.reference, displayName)) location.hash = '#/trash';
  });
  document.getElementById('cv-preview')?.addEventListener('click', () => openCvPreview(a.cv));
  main.querySelectorAll('[data-status]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        const next = await api(`/api/admin/candidates/${encodeURIComponent(d.reference)}/application`, { method: 'PATCH', body: { status: btn.dataset.status } });
        toast(`Marked as ${STATUSES[btn.dataset.status]}.`, 'success');
        renderDetail(next);
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );
  document.getElementById('notes-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/candidates/${encodeURIComponent(d.reference)}/application`, { method: 'PATCH', body: { notes: e.target.notes.value } });
      toast('Notes saved.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  document.getElementById('reevaluate')?.addEventListener('click', async () => {
    try {
      renderDetail(await api(`/api/admin/candidates/${encodeURIComponent(d.reference)}/reevaluate`, { method: 'POST' }));
      toast('Evaluation updated.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  main.querySelectorAll('[data-verdict]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      try {
        renderDetail(await api(`/api/admin/reports/${encodeURIComponent(sel.dataset.verdict)}/verdict`, { method: 'PATCH', body: { verdict: sel.value } }));
        toast('Verdict saved and score recalculated.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    }),
  );
}

// ------------------------------------------------------------- CV preview
const cvDialog = document.getElementById('cv-dialog');
const cvFrame = document.getElementById('cv-frame');
let cvOpener = null;

function openCvPreview(cv) {
  cvOpener = document.activeElement;
  document.getElementById('cv-dialog-title').textContent = cv.name;
  document.getElementById('cv-open-tab').href = cv.previewUrl;
  document.getElementById('cv-download').href = cv.url;
  // Converted Word documents are plain HTML: sandbox them with no scripts. The browser's
  // PDF viewer does not run inside a sandboxed frame, so PDFs load without it.
  if (cv.mime === 'application/pdf') cvFrame.removeAttribute('sandbox');
  else cvFrame.setAttribute('sandbox', '');
  document.getElementById('cv-loading').hidden = false;
  cvFrame.onload = () => (document.getElementById('cv-loading').hidden = true);
  cvFrame.src = cv.previewUrl;
  cvDialog.showModal();
  document.getElementById('cv-close').focus();
}

function closeCvPreview() {
  if (cvDialog.open) cvDialog.close();
}
cvDialog.addEventListener('close', () => {
  cvFrame.src = 'about:blank';
  cvOpener?.focus?.();
});
document.getElementById('cv-close').addEventListener('click', closeCvPreview);
cvDialog.addEventListener('click', (e) => {
  if (e.target === cvDialog) closeCvPreview();
});

async function detailView(id) {
  loading();
  answerKey ||= await api('/api/admin/answer-key');
  renderDetail(await api('/api/admin/candidates/' + encodeURIComponent(id)));
}

// ------------------------------------------------------------- answer key
async function answerKeyView() {
  loading();
  answerKey = await api('/api/admin/answer-key');
  const k = answerKey;
  main.innerHTML = `
    <h1>Answer key &amp; scoring</h1>
    <div class="alert alert-warning">Confidential — never share this list with candidates. Matching patterns are applied automatically; you can override any report's verdict on the candidate page.</div>
    <div class="card" style="margin-bottom:16px">
      <h2>Scoring rules</h2>
      <ul>
        <li>Base points by difficulty: easy ${k.difficultyPoints.easy}, medium ${k.difficultyPoints.medium}, hard ${k.difficultyPoints.hard}. Maximum: <strong>${k.maxPoints}</strong> points (= 100%).</li>
        <li>Per matched bug: identification ${k.scoring.weights.identification * 100}% · reproducibility ${k.scoring.weights.reproducibility * 100}% · expected vs actual ${k.scoring.weights.expectedVsActual * 100}% · severity ${k.scoring.weights.severity * 100}% · priority ${k.scoring.weights.priority * 100}% of base points.</li>
        <li>Wrong module: identification × ${k.scoring.wrongModuleFactor}. Severity/priority one level off earns half.</li>
        <li>Edge-case bugs: +${k.scoring.edgeCaseBonus} bonus (half if steps are thin).</li>
        <li>Duplicates earn ${k.scoring.duplicatePenalty} points (best report per bug counts). Unmatched / invalid reports: −${k.scoring.falsePositivePenalty} each (max −${k.scoring.falsePositivePenaltyCap}).</li>
        <li>Each hint: −${k.scoring.hintPenalty} points. Time spent is shown but never scored.</li>
      </ul>
      <h3>Hints shown to candidates</h3>
      <ol>${k.hints.map((h) => `<li>${esc(h)}</li>`).join('')}</ol>
    </div>
    <div class="table-wrap"><table class="key-table">
      <thead><tr><th>ID</th><th>Issue</th><th>How to reproduce</th><th>Category</th><th>Sev / Pri</th><th>Difficulty</th><th>Points</th></tr></thead>
      <tbody>${k.bugs
        .map(
          (b) => `<tr><td>${esc(b.id)}</td><td><strong>${esc(b.title)}</strong><br><span class="muted">${esc(b.module)}</span><br>${esc(b.description)}</td>
          <td>${esc(b.howToReproduce)}</td><td>${esc(b.category)}${b.edgeCase ? '<br><span class="badge badge-primary">edge case</span>' : ''}</td>
          <td>${esc(b.severity)} / ${esc(b.priority)}</td><td>${esc(b.difficulty)}</td><td>${b.points}${b.edgeCase ? ` +${k.scoring.edgeCaseBonus}` : ''}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
}

// ------------------------------------------------------------- router
async function route() {
  const me = await api('/api/admin/me').catch(() => ({ authenticated: false }));
  if (!me.authenticated) return loginView();
  nav.hidden = false;
  const hash = location.hash.slice(2) || 'candidates';
  const [page, id] = hash.split('/');
  nav.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page === 'candidate' ? 'candidates' : page)));
  if (page === 'trash') return guarded(trashView);
  if (page === 'candidate' && id) return guarded(() => detailView(decodeURIComponent(id)));
  if (page === 'answer-key') return guarded(answerKeyView);
  return guarded(candidatesView);
}

window.addEventListener('hashchange', route);
route();
