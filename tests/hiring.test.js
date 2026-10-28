import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, startedCandidate, reportForm, applicationForm, ADMIN } from './helpers.js';

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

const setHiring = (body) => admin.put('/api/admin/settings', { json: body });

describe('applications open/closed switch', () => {
  test('applications are open by default', async () => {
    const res = await new Client(srv.base).get('/api/session');
    assert.deepEqual(res.data.hiring, { open: true, message: '' });
    assert.equal((await admin.get('/api/admin/settings')).data.hiring.open, true);
  });

  test('only admins can read or change the setting', async () => {
    const c = new Client(srv.base);
    assert.equal((await c.get('/api/admin/settings')).status, 401);
    assert.equal((await c.put('/api/admin/settings', { json: { applicationsOpen: false } })).status, 401);
  });

  test('rejects invalid values', async () => {
    assert.equal((await setHiring({ applicationsOpen: 'no' })).status, 422);
    assert.equal((await setHiring({ closedMessage: 'x'.repeat(301) })).status, 422);
  });

  test('closing blocks starting, submitting the challenge and applying — and reopening restores them', async () => {
    // Candidates at each stage before closing
    const testing = await startedCandidate(srv.base);
    await testing.post('/api/reports', { form: reportForm() });
    const submitted = await startedCandidate(srv.base);
    await submitted.post('/api/reports', { form: reportForm() });
    await submitted.post('/api/challenge/submit', { json: { confirm: true } });

    const closed = await setHiring({ applicationsOpen: false, closedMessage: 'We will reopen in January.' });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.hiring.open, false);

    // New visitor sees the message and cannot start
    const visitor = new Client(srv.base);
    assert.deepEqual((await visitor.get('/api/session')).data.hiring, { open: false, message: 'We will reopen in January.' });
    const start = await visitor.post('/api/session/start', { json: { acceptedRules: true } });
    assert.equal(start.status, 403);
    assert.equal(start.data.details.hiring, 'closed');
    assert.equal(start.data.error, 'We will reopen in January.');

    // In-progress candidate keeps working but cannot submit the challenge
    assert.equal((await testing.post('/api/reports', { form: reportForm({ title: 'Another finding here' }) })).status, 201);
    assert.equal((await testing.post('/api/challenge/submit', { json: { confirm: true } })).status, 403);

    // Candidate with an unlocked form cannot apply
    const app = await submitted.post('/api/application', { form: applicationForm({ email: 'closed@example.com' }) });
    assert.equal(app.status, 403);
    assert.equal(await srv.col.applications.countDocuments({}), 0);

    // Reopen: everything works again, progress was kept
    assert.equal((await setHiring({ applicationsOpen: true })).data.hiring.open, true);
    assert.equal((await visitor.post('/api/session/start', { json: { acceptedRules: true } })).status, 201);
    assert.equal((await testing.post('/api/challenge/submit', { json: { confirm: true } })).status, 200);
    assert.equal((await submitted.post('/api/application', { form: applicationForm({ email: 'reopened@example.com' }) })).status, 201);
  });

  test('without a custom message, a default message is shown', async () => {
    await setHiring({ applicationsOpen: false, closedMessage: '' });
    const res = await new Client(srv.base).get('/api/session');
    assert.equal(res.data.hiring.open, false);
    assert.match(res.data.hiring.message, /currently closed/);
    await setHiring({ applicationsOpen: true });
  });
});
