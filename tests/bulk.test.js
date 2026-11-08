import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, startedCandidate, reportForm, applicationForm, ADMIN } from './helpers.js';

let srv;
let admin;
const refs = [];
let testingRef;

before(async () => {
  srv = await startServer();
  admin = new Client(srv.base);
  await admin.post('/api/admin/login', { json: ADMIN });
  for (const email of ['bulk1@example.com', 'bulk2@example.com', 'bulk3@example.com']) {
    const c = await startedCandidate(srv.base);
    await c.post('/api/reports', { form: reportForm() });
    await c.post('/api/challenge/submit', { json: { confirm: true } });
    refs.push((await c.post('/api/application', { form: applicationForm({ email }) })).data.reference);
  }
  const testing = await startedCandidate(srv.base); // still testing, no application
  testingRef = (await testing.get('/api/session')).data.reference;
});
after(async () => {
  await srv.close();
});

const bulk = (body) => admin.post('/api/admin/candidates/bulk', { json: body });
const statusOf = async (ref) => (await admin.get(`/api/admin/candidates/${ref}`)).data.application?.status;

describe('bulk actions', () => {
  test('requires admin login', async () => {
    const res = await new Client(srv.base).post('/api/admin/candidates/bulk', { json: { ids: refs, action: 'trash' } });
    assert.equal(res.status, 401);
  });

  test('validates the request', async () => {
    assert.equal((await bulk({ ids: [], action: 'trash' })).status, 422);
    assert.equal((await bulk({ ids: refs, action: 'explode' })).status, 422);
    assert.equal((await bulk({ ids: refs, action: 'status', status: 'hired' })).status, 422);
    assert.equal((await bulk({ ids: Array.from({ length: 501 }, (_, i) => `x${i}`), action: 'trash' })).status, 422);
    assert.equal((await bulk({ ids: [{ $ne: null }], action: 'trash' })).status, 422);
  });

  test('changes the status of several applications at once, skipping candidates without one', async () => {
    const res = await bulk({ ids: [refs[0], refs[1], testingRef], action: 'status', status: 'shortlisted' });
    assert.equal(res.status, 200);
    assert.equal(res.data.updated, 2);
    assert.equal(res.data.skipped, 1);
    assert.equal(await statusOf(refs[0]), 'shortlisted');
    assert.equal(await statusOf(refs[1]), 'shortlisted');
    assert.equal(await statusOf(refs[2]), 'under_review');
  });

  test('exports only the selected candidates', async () => {
    const csv = (await admin.get(`/api/admin/export.csv?ids=${refs[0]},${refs[2]}`)).data;
    assert.match(csv, /bulk1@example.com/);
    assert.match(csv, /bulk3@example.com/);
    assert.doesNotMatch(csv, /bulk2@example.com/);
  });

  test('moves several candidates to the trash at once', async () => {
    const res = await bulk({ ids: [refs[1], refs[2], refs[2]], action: 'trash' });
    assert.equal(res.status, 200);
    assert.equal(res.data.updated, 2);
    const list = (await admin.get('/api/admin/candidates')).data.candidates.map((c) => c.reference);
    assert.equal(list.includes(refs[1]) || list.includes(refs[2]), false);
    const trash = (await admin.get('/api/admin/candidates?trash=1')).data.candidates.map((c) => c.reference);
    assert.ok(trash.includes(refs[1]) && trash.includes(refs[2]));

    // Already-trashed candidates are skipped, and status changes no longer touch them
    assert.equal((await bulk({ ids: [refs[1]], action: 'trash' })).data.skipped, 1);
    assert.equal((await bulk({ ids: [refs[1]], action: 'status', status: 'rejected' })).data.updated, 0);
  });
});
