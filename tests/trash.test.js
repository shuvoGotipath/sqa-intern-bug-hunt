import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, Client, startedCandidate, reportForm, applicationForm, ADMIN, PNG } from './helpers.js';

let srv;
let admin;

before(async () => {
  srv = await startServer();
  admin = new Client(srv.base);
  await admin.post('/api/admin/login', { json: ADMIN });
});
after(async () => {
  await srv.close();
});

/** A candidate who has submitted the challenge (with a screenshot) and applied (with a CV). */
async function appliedCandidate(email) {
  const c = await startedCandidate(srv.base);
  await c.post('/api/reports', { form: reportForm({}, { buffer: PNG, name: 'shot.png' }) });
  await c.post('/api/challenge/submit', { json: { confirm: true } });
  const res = await c.post('/api/application', { form: applicationForm({ email }) });
  assert.equal(res.status, 201);
  return { client: c, ref: res.data.reference };
}

const uploadedFiles = () => {
  const dir = path.join(srv.dir, 'uploads');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
};
const listRefs = async (query = '') => (await admin.get('/api/admin/candidates' + query)).data.candidates.map((c) => c.reference);

describe('candidate trash', () => {
  test('only admins can trash, restore or delete', async () => {
    const { ref } = await appliedCandidate('perm@example.com');
    const anon = new Client(srv.base);
    assert.equal((await anon.post(`/api/admin/candidates/${ref}/trash`)).status, 401);
    assert.equal((await anon.post(`/api/admin/candidates/${ref}/restore`)).status, 401);
    assert.equal((await anon.delete(`/api/admin/candidates/${ref}`)).status, 401);
  });

  test('moving to trash hides the candidate from the list, stats and CSV export', async () => {
    const { ref } = await appliedCandidate('trash-me@example.com');
    const before = (await admin.get('/api/admin/candidates')).data.stats;

    const res = await admin.post(`/api/admin/candidates/${ref}/trash`);
    assert.equal(res.status, 200);
    assert.ok(res.data.deletedAt);

    assert.equal((await listRefs()).includes(ref), false);
    assert.equal((await listRefs('?trash=1')).includes(ref), true);
    const after = (await admin.get('/api/admin/candidates')).data.stats;
    assert.equal(after.stages.applied, before.stages.applied - 1);
    assert.equal(after.trashed, (before.trashed || 0) + 1);
    assert.equal((await admin.get('/api/admin/export.csv')).data.includes('trash-me@example.com'), false);

    // Data is still there: detail view works and is marked as trashed
    const detail = await admin.get(`/api/admin/candidates/${ref}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.data.deletedAt);
    assert.equal(detail.data.application.email, 'trash-me@example.com');

    assert.equal((await admin.post(`/api/admin/candidates/${ref}/trash`)).status, 409);
  });

  test("a trashed candidate's own session stops working until restored", async () => {
    const { client, ref } = await appliedCandidate('restore-me@example.com');
    await admin.post(`/api/admin/candidates/${ref}/trash`);
    assert.equal((await client.get('/api/session')).data.status, 'none');

    const restored = await admin.post(`/api/admin/candidates/${ref}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.deletedAt, null);
    assert.equal((await listRefs()).includes(ref), true);
    assert.equal((await client.get('/api/session')).data.status, 'applied');
    assert.equal((await admin.post(`/api/admin/candidates/${ref}/restore`)).status, 404);
  });

  test('permanent delete requires the trash first, then removes all records and files', async () => {
    const { ref } = await appliedCandidate('forever@example.com');
    const filesBefore = uploadedFiles().length;

    assert.equal((await admin.delete(`/api/admin/candidates/${ref}`)).status, 409);

    await admin.post(`/api/admin/candidates/${ref}/trash`);
    const res = await admin.delete(`/api/admin/candidates/${ref}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.filesDeleted, 2);
    assert.equal(res.data.filesFailed, 0);

    assert.equal(uploadedFiles().length, filesBefore - 2);
    assert.equal(await srv.col.sessions.countDocuments({ _id: ref }), 0);
    assert.equal(await srv.col.applications.countDocuments({ sessionId: ref }), 0);
    assert.equal(await srv.col.reports.countDocuments({ sessionId: ref }), 0);
    assert.equal((await listRefs('?trash=1')).includes(ref), false);
    assert.equal((await admin.get(`/api/admin/candidates/${ref}`)).status, 404);
    assert.equal((await admin.delete(`/api/admin/candidates/${ref}`)).status, 404);

    // The email is free again after permanent deletion
    const again = await appliedCandidate('forever@example.com');
    assert.ok(again.ref);
  });
});
