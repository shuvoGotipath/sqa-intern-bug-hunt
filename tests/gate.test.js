import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, startedCandidate, reportForm, applicationForm, PNG } from './helpers.js';

let srv;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

describe('challenge session', () => {
  test('a new visitor has no session', async () => {
    const res = await new Client(srv.base).get('/api/session');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'none');
  });

  test('starting requires accepting the rules', async () => {
    const res = await new Client(srv.base).post('/api/session/start', { json: {} });
    assert.equal(res.status, 422);
  });

  test('state-changing calls without the ajax header are rejected (CSRF guard)', async () => {
    const res = await new Client(srv.base).post('/api/session/start', { json: { acceptedRules: true }, ajax: false });
    assert.equal(res.status, 403);
  });

  test('progress survives a "refresh" (same cookie returns the same reports)', async () => {
    const c = await startedCandidate(srv.base);
    await c.post('/api/reports', { form: reportForm() });
    const again = await c.get('/api/session');
    assert.equal(again.data.status, 'in_progress');
    assert.equal(again.data.reports.length, 1);
    assert.ok(again.data.reference.startsWith('SQA-'));
  });

  test('session cookie is HttpOnly', async () => {
    const c = new Client(srv.base);
    const res = await c.post('/api/session/start', { json: { acceptedRules: true } });
    const cookie = res.headers.getSetCookie().join(';');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });
});

describe('bug reports', () => {
  test('validates required fields server-side', async () => {
    const c = await startedCandidate(srv.base);
    const res = await c.post('/api/reports', { form: reportForm({ title: 'x', severity: 'Urgent', steps: '' }) });
    assert.equal(res.status, 422);
    assert.ok(res.data.details.title);
    assert.ok(res.data.details.severity);
    assert.ok(res.data.details.steps);
  });

  test('can create, edit and delete reports before submission', async () => {
    const c = await startedCandidate(srv.base);
    const created = await c.post('/api/reports', { form: reportForm() });
    assert.equal(created.status, 201);
    const id = created.data.id;
    const edited = await c.put(`/api/reports/${id}`, { form: reportForm({ title: 'Search ignores lowercase queries' }) });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.title, 'Search ignores lowercase queries');
    const del = await c.delete(`/api/reports/${id}`);
    assert.equal(del.status, 204);
    const s = await c.get('/api/session');
    assert.equal(s.data.reports.length, 0);
  });

  test('accepts image evidence and rejects non-images', async () => {
    const c = await startedCandidate(srv.base);
    const ok = await c.post('/api/reports', { form: reportForm({}, { buffer: PNG, name: 'shot.png' }) });
    assert.equal(ok.status, 201);
    assert.ok(ok.data.evidence);
    const img = await c.get(ok.data.evidence.url);
    assert.equal(img.status, 200);
    const bad = await c.post('/api/reports', { form: reportForm({}, { buffer: Buffer.from('<script>alert(1)</script>'), name: 'shot.png' }) });
    assert.equal(bad.status, 422);
  });

  test("a candidate cannot see or modify another candidate's reports", async () => {
    const a = await startedCandidate(srv.base);
    const b = await startedCandidate(srv.base);
    const created = await a.post('/api/reports', { form: reportForm() });
    const res = await b.put(`/api/reports/${created.data.id}`, { form: reportForm({ title: 'Hijacked title' }) });
    assert.equal(res.status, 404);
    const del = await b.delete(`/api/reports/${created.data.id}`);
    assert.equal(del.status, 404);
  });
});

describe('challenge completion gate', () => {
  test('application is rejected without any session', async () => {
    const res = await new Client(srv.base).post('/api/application', { form: applicationForm() });
    assert.equal(res.status, 401);
  });

  test('application is rejected while the challenge is still in progress', async () => {
    const c = await startedCandidate(srv.base);
    await c.post('/api/reports', { form: reportForm() });
    const res = await c.post('/api/application', { form: applicationForm({ email: 'early@example.com' }) });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /submit the testing challenge/i);
  });

  test('client-supplied "completed" flags are ignored', async () => {
    const c = await startedCandidate(srv.base);
    const fd = applicationForm({ email: 'cheat@example.com' });
    fd.append('status', 'submitted');
    fd.append('challengeCompleted', 'true');
    const res = await c.post('/api/application', { form: fd, headers: { 'X-Challenge-Status': 'submitted' } });
    assert.equal(res.status, 403);
    c.cookies.sqa_session = 'forged-token-value';
    const forged = await c.post('/api/application', { form: applicationForm({ email: 'cheat2@example.com' }) });
    assert.equal(forged.status, 401);
  });

  test('challenge cannot be submitted without reports or without confirmation', async () => {
    const c = await startedCandidate(srv.base);
    const empty = await c.post('/api/challenge/submit', { json: { confirm: true } });
    assert.equal(empty.status, 422);
    await c.post('/api/reports', { form: reportForm() });
    const unconfirmed = await c.post('/api/challenge/submit', { json: {} });
    assert.equal(unconfirmed.status, 422);
  });

  test('submission locks reports and does not leak the score to the candidate', async () => {
    const c = await startedCandidate(srv.base);
    const r = await c.post('/api/reports', { form: reportForm() });
    const sub = await c.post('/api/challenge/submit', { json: { confirm: true } });
    assert.equal(sub.status, 200);
    assert.equal(sub.data.status, 'submitted');
    assert.equal(sub.data.score, undefined);
    const session = await c.get('/api/session');
    assert.equal(session.data.status, 'submitted');
    assert.equal(JSON.stringify(session.data).includes('evaluation'), false);
    assert.equal((await c.post('/api/reports', { form: reportForm() })).status, 409);
    assert.equal((await c.put(`/api/reports/${r.data.id}`, { form: reportForm() })).status, 409);
    assert.equal((await c.delete(`/api/reports/${r.data.id}`)).status, 409);
    assert.equal((await c.post('/api/challenge/submit', { json: { confirm: true } })).status, 409);
    assert.equal((await c.post('/api/hints')).status, 409);
  });

  test('submitting the challenge unlocks — but does not auto-submit — the application', async () => {
    const c = await startedCandidate(srv.base);
    await c.post('/api/reports', { form: reportForm() });
    await c.post('/api/challenge/submit', { json: { confirm: true } });
    const count = await srv.col.applications.countDocuments({ sessionId: (await c.get('/api/session')).data.reference });
    assert.equal(count, 0);
  });
});

describe('application submission', () => {
  async function unlocked() {
    const c = await startedCandidate(srv.base);
    await c.post('/api/reports', { form: reportForm() });
    await c.post('/api/challenge/submit', { json: { confirm: true } });
    return c;
  }

  test('validates required fields with clear messages', async () => {
    const c = await unlocked();
    const res = await c.post('/api/application', {
      form: applicationForm({ fullName: '', email: 'not-an-email', phone: 'abc', institution: '', educationLevel: 'PhD wizard', whySqa: 'Too short', profileUrl: 'javascript:alert(1)' }, null),
    });
    assert.equal(res.status, 422);
    for (const f of ['fullName', 'email', 'phone', 'institution', 'educationLevel', 'whySqa', 'profileUrl', 'cv']) assert.ok(res.data.details[f], `expected error for ${f}`);
  });

  test('rejects CVs that are not real PDF/DOC/DOCX files', async () => {
    const c = await unlocked();
    const res = await c.post('/api/application', { form: applicationForm({ email: 'fakecv@example.com' }, { buffer: Buffer.from('MZ fake exe'), name: 'cv.pdf' }) });
    assert.equal(res.status, 422);
    assert.ok(res.data.details.cv);
    const exe = await c.post('/api/application', { form: applicationForm({ email: 'fakecv@example.com' }, { buffer: Buffer.from('%PDF-1.4'), name: 'cv.exe' }) });
    assert.equal(exe.status, 422);
  });

  test('rejects CVs larger than 5 MB', async () => {
    const c = await unlocked();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    const res = await c.post('/api/application', { form: applicationForm({ email: 'big@example.com' }, { buffer: big, name: 'cv.pdf' }) });
    assert.equal(res.status, 413);
  });

  test('full journey: start → report → submit → apply → confirmation; second application refused', async () => {
    const c = await unlocked();
    const res = await c.post('/api/application', { form: applicationForm({ email: 'journey@example.com' }) });
    assert.equal(res.status, 201);
    assert.ok(res.data.reference.startsWith('SQA-'));
    const session = await c.get('/api/session');
    assert.equal(session.data.status, 'applied');
    assert.ok(session.data.application.submittedAt);
    const again = await c.post('/api/application', { form: applicationForm({ email: 'journey2@example.com' }) });
    assert.equal(again.status, 409);
  });

  test('duplicate email across candidates is refused', async () => {
    const a = await unlocked();
    assert.equal((await a.post('/api/application', { form: applicationForm({ email: 'dup@example.com' }) })).status, 201);
    const b = await unlocked();
    const res = await b.post('/api/application', { form: applicationForm({ email: 'DUP@example.com' }) });
    assert.equal(res.status, 409);
    assert.ok(res.data.details.email);
  });
});

describe('answer key protection', () => {
  test('answer key and admin data require admin login', async () => {
    const c = await startedCandidate(srv.base);
    for (const url of ['/api/admin/answer-key', '/api/admin/candidates', '/api/admin/export.csv']) {
      const res = await c.get(url);
      assert.equal(res.status, 401, url);
    }
  });

  test('server source files are not publicly served', async () => {
    const c = new Client(srv.base);
    for (const url of ['/server/evaluation/answerKey.js', '/evaluation/answerKey.js', '/../server/evaluation/answerKey.js', '/data/app.db', '/uploads/']) {
      const res = await c.get(url);
      assert.equal(res.status, 404, url);
    }
  });

  test('public client bundles do not contain the answer key', async () => {
    const c = new Client(srv.base);
    for (const url of ['/js/portal.js', '/js/api.js', '/demo/demo.js', '/admin/admin.js', '/']) {
      const res = await c.get(url);
      assert.equal(res.status, 200, url);
      assert.equal(/REG-01|PRD-02|CART-03|tester@mail|compounds the 10%/.test(res.data), false, url);
    }
  });
});
