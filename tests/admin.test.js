import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { startServer, Client, startedCandidate, reportForm, applicationForm, ADMIN, PNG } from './helpers.js';

let srv;
let admin;
let candidateRef;
let reportId;

before(async () => {
  srv = await startServer();
  const c = await startedCandidate(srv.base);
  const r = await c.post('/api/reports', { form: reportForm({}, { buffer: PNG, name: 'shot.png' }) });
  reportId = r.data.id;
  await c.post('/api/reports', { form: reportForm({ title: 'Footer is grey', module: 'Other', steps: '1. Scroll to the footer', expected: 'Footer text is black', actual: 'Footer text is grey' }) });
  await c.post('/api/challenge/submit', { json: { confirm: true } });
  const app = await c.post('/api/application', { form: applicationForm({ email: 'admin-test@example.com', institution: '=HYPERLINK("x")' }) });
  assert.equal(app.status, 201);
  candidateRef = app.data.reference;
  // A second candidate still testing
  await startedCandidate(srv.base);

  admin = new Client(srv.base);
});
after(async () => {
  await srv.close();
});

describe('admin authentication', () => {
  test('wrong credentials are rejected', async () => {
    const res = await new Client(srv.base).post('/api/admin/login', { json: { username: ADMIN.username, password: 'nope' } });
    assert.equal(res.status, 401);
  });

  test('correct credentials create an HttpOnly, SameSite=Strict session', async () => {
    const res = await admin.post('/api/admin/login', { json: ADMIN });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().join(';');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await admin.get('/api/admin/me')).data.authenticated, true);
  });

  test('login is rate limited', async () => {
    const c = new Client(srv.base);
    let last;
    for (let i = 0; i < 12; i++) last = await c.post('/api/admin/login', { json: { username: 'x', password: 'y' } });
    assert.equal(last.status, 429);
  });
});

describe('admin dashboard', () => {
  test('lists candidates with scores and supports filters', async () => {
    const all = await admin.get('/api/admin/candidates');
    assert.equal(all.status, 200);
    assert.equal(all.data.candidates.length, 2);
    const applied = await admin.get('/api/admin/candidates?stage=applied');
    assert.equal(applied.data.candidates.length, 1);
    assert.equal(applied.data.candidates[0].reference, candidateRef);
    assert.ok(applied.data.candidates[0].score > 0);
    const high = await admin.get('/api/admin/candidates?minScore=99');
    assert.equal(high.data.candidates.length, 0);
    const search = await admin.get('/api/admin/candidates?q=admin-test');
    assert.equal(search.data.candidates.length, 1);
  });

  test('candidate detail compares reports with the expected issue list', async () => {
    const res = await admin.get(`/api/admin/candidates/${candidateRef}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.reports.length, 2);
    const matched = res.data.reports.find((r) => r.id === reportId);
    assert.equal(matched.result.bugId, 'PRD-01');
    assert.equal(res.data.coverage.find((b) => b.id === 'PRD-01').found, true);
    assert.equal(res.data.evaluation.unmatched, 1);
    assert.ok(res.data.application.cv.url);
  });

  test('can download the CV and view evidence', async () => {
    const d = (await admin.get(`/api/admin/candidates/${candidateRef}`)).data;
    const cv = await admin.get(d.application.cv.url);
    assert.equal(cv.status, 200);
    assert.match(cv.headers.get('content-disposition'), /attachment/);
    const ev = await admin.get(d.reports.find((r) => r.evidence).evidence.url);
    assert.equal(ev.status, 200);
    assert.equal(ev.headers.get('content-type'), 'image/png');
    assert.equal((await new Client(srv.base).get(d.application.cv.url)).status, 401);
  });

  test('can change application status and notes', async () => {
    const res = await admin.patch(`/api/admin/candidates/${candidateRef}/application`, { json: { status: 'shortlisted', notes: 'Strong reports' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.application.status, 'shortlisted');
    assert.equal(res.data.application.notes, 'Strong reports');
    const bad = await admin.patch(`/api/admin/candidates/${candidateRef}/application`, { json: { status: 'hired!!' } });
    assert.equal(bad.status, 422);
    const filtered = await admin.get('/api/admin/candidates?status=shortlisted');
    assert.equal(filtered.data.candidates.length, 1);
  });

  test('verdict override re-scores the candidate', async () => {
    const before = (await admin.get(`/api/admin/candidates/${candidateRef}`)).data;
    const fp = before.reports.find((r) => r.id !== reportId);
    const res = await admin.patch(`/api/admin/reports/${fp.id}/verdict`, { json: { verdict: 'extra' } });
    assert.equal(res.status, 200);
    assert.ok(res.data.score > before.score);
    assert.equal(res.data.evaluation.unmatched, 0);
    const bad = await admin.patch(`/api/admin/reports/${fp.id}/verdict`, { json: { verdict: 'bug:NOPE' } });
    assert.equal(bad.status, 422);
  });

  test('answer key is available to admins', async () => {
    const res = await admin.get('/api/admin/answer-key');
    assert.equal(res.status, 200);
    assert.ok(res.data.bugs.length >= 20);
    assert.ok(res.data.maxPoints > 0);
  });

  test('CSV export contains candidates and neutralises formula injection', async () => {
    const res = await admin.get('/api/admin/export.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.data, /admin-test@example.com/);
    assert.match(res.data, /'=HYPERLINK/);
  });

  test('PDF CV preview is served inline and requires admin login', async () => {
    const d = (await admin.get(`/api/admin/candidates/${candidateRef}`)).data;
    assert.ok(d.application.cv.previewUrl);
    const res = await admin.get(d.application.cv.previewUrl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^inline/);
    assert.equal((await new Client(srv.base).get(d.application.cv.previewUrl)).status, 401);
  });

  test('DOCX CV preview is converted to sandboxed HTML without scripts', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jane Tester — QA portfolio &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>');
    const docx = await zip.generateAsync({ type: 'nodebuffer' });

    const c = await startedCandidate(srv.base);
    await c.post('/api/reports', { form: reportForm() });
    await c.post('/api/challenge/submit', { json: { confirm: true } });
    const app = await c.post('/api/application', { form: applicationForm({ email: 'docx@example.com' }, { buffer: docx, name: 'cv.docx' }) });
    assert.equal(app.status, 201);

    const d = (await admin.get(`/api/admin/candidates/${app.data.reference}`)).data;
    const res = await admin.get(d.application.cv.previewUrl);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.match(res.data, /Jane Tester/);
    assert.equal(res.data.includes('<script>'), false);
  });

  test('legacy .doc CVs offer download only', async () => {
    const doc = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    const c = await startedCandidate(srv.base);
    await c.post('/api/reports', { form: reportForm() });
    await c.post('/api/challenge/submit', { json: { confirm: true } });
    const app = await c.post('/api/application', { form: applicationForm({ email: 'doc@example.com' }, { buffer: doc, name: 'cv.doc' }) });
    assert.equal(app.status, 201);
    const d = (await admin.get(`/api/admin/candidates/${app.data.reference}`)).data;
    assert.equal(d.application.cv.previewUrl, null);
    const res = await admin.get(`/api/admin/files/cv/${d.application.id}/preview`);
    assert.equal(res.status, 415);
  });

  test('logout ends the admin session', async () => {
    await admin.post('/api/admin/logout');
    assert.equal((await admin.get('/api/admin/candidates')).status, 401);
  });
});
