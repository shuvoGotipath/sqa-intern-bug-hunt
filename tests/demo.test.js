/**
 * Regression guard for the ShopNest demo API: the planted defects must stay
 * reproducible, and behaviour that is meant to be correct must stay correct
 * (otherwise candidates would be penalised for reporting unintended bugs).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, startedCandidate } from './helpers.js';

let srv;
let c;
before(async () => {
  srv = await startServer();
  c = await startedCandidate(srv.base);
});
after(async () => {
  await srv.close();
});

const reg = (body) => c.post('/demo-api/register', { json: { name: 'Test User', email: `u${Math.random().toString(36).slice(2)}@example.com`, password: 'Password1', confirmPassword: 'Password1', ...body } });
const order = (overrides = {}) =>
  c.post('/demo-api/orders', {
    json: {
      items: [{ productId: 'p1', qty: 1 }],
      summary: { subtotal: 49, discount: 0, shipping: 4.99, total: 53.99 },
      shipping: { fullName: 'Test User', address: '1 Road', city: 'Dhaka', zip: '1207' },
      payment: { cardName: 'Test User', cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvv: '123' },
      ...overrides,
    },
  });

test('demo API requires a challenge session', async () => {
  assert.equal((await new Client(srv.base).get('/demo-api/products')).status, 401);
});

describe('planted defects are reproducible', () => {
  test('REG-01 email without TLD accepted', async () => assert.equal((await reg({ email: 'tester@mail' })).status, 201));
  test('REG-02 7-char password accepted', async () => assert.equal((await reg({ password: 'Abcdef1', confirmPassword: 'Abcdef1' })).status, 201));
  test('REG-03 confirm password case-insensitive', async () => assert.equal((await reg({ password: 'Secret123', confirmPassword: 'SECRET123' })).status, 201));
  test('REG-04 whitespace name accepted', async () => assert.equal((await reg({ name: '   ' })).status, 201));
  test('LOGIN-01 wrong password reports unknown account', async () => {
    const res = await c.post('/demo-api/login', { json: { email: 'demo@shopnest.test', password: 'wrong' } });
    assert.equal(res.status, 401);
    assert.match(res.data.error, /No account found/);
  });
  test('PRO-01 phone not persisted; PRO-02 future DOB accepted; PRO-03 bio up to 160', async () => {
    await c.post('/demo-api/login', { json: { email: 'demo@shopnest.test', password: 'Shop@1234' } });
    const res = await c.put('/demo-api/profile', { json: { name: 'Alex Rivera', phone: '+1 555 0199', dob: '2031-01-01', bio: 'x'.repeat(160) } });
    assert.equal(res.status, 200);
    const p = (await c.get('/demo-api/profile')).data;
    assert.equal(p.phone, '+1 555 0100');
    assert.equal(p.dob, '2031-01-01');
    assert.equal(p.bio.length, 160);
  });
  test('PRD-01 search is case-sensitive', async () => {
    assert.equal((await c.get('/demo-api/products?q=lamp')).data.products.length, 0);
    assert.equal((await c.get('/demo-api/products?q=Lamp')).data.products.length, 1);
  });
  test('PRD-02 price sort is lexicographic', async () => {
    const prices = (await c.get('/demo-api/products?sort=price-asc')).data.products.map((p) => p.price);
    assert.deepEqual(prices.slice(0, 3), [12, 129, 15.75]);
  });
  test('PRD-03 total does not reflect filters', async () => {
    const res = await c.get('/demo-api/products?category=Wearables');
    assert.equal(res.data.products.length, 2);
    assert.equal(res.data.total, 12);
  });
  test('CHK-01 empty cart order accepted', async () => {
    const res = await order({ items: [], summary: { subtotal: 0, discount: 0, shipping: 0, total: 0 } });
    assert.equal(res.status, 201);
  });
  test('CHK-02 earlier month in current year accepted as expiry', async () => {
    const yy = String(new Date().getFullYear()).slice(2);
    const res = await order({ payment: { cardName: 'T', cardNumber: '4242424242424242', expiry: `01/${yy}`, cvv: '123' } });
    assert.equal(res.status, 201);
  });
  test('CHK-03 concurrent submits create two orders', async () => {
    const [a, b] = await Promise.all([order(), order()]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.data.order.id, b.data.order.id);
  });
});

describe('intended behaviour stays correct', () => {
  test('registration rejects obviously invalid input', async () => {
    const res = await reg({ name: '', email: 'not-an-email', password: '' });
    assert.equal(res.status, 422);
    assert.ok(res.data.details.name && res.data.details.email && res.data.details.password);
    assert.equal((await reg({ password: 'Abc12', confirmPassword: 'Abc12' })).status, 422);
    assert.equal((await reg({ password: 'Password1', confirmPassword: 'Different9' })).status, 422);
    assert.equal((await reg({ email: 'demo@shopnest.test' })).status, 422);
  });
  test('login works for the demo account, with case-insensitive email', async () => {
    const res = await c.post('/demo-api/login', { json: { email: 'Demo@ShopNest.test', password: 'Shop@1234' } });
    assert.equal(res.status, 200);
  });
  test('profile rejects invalid phone and empty name', async () => {
    const res = await c.put('/demo-api/profile', { json: { name: ' ', phone: 'abc123', dob: '', bio: '' } });
    assert.equal(res.status, 422);
    assert.ok(res.data.details.name && res.data.details.phone);
  });
  test('checkout validates address, card number, past-year expiry and CVV', async () => {
    const res = await order({
      shipping: { fullName: '', address: '', city: '', zip: 'ab' },
      payment: { cardName: '', cardNumber: '1234', expiry: '01/20', cvv: '1' },
    });
    assert.equal(res.status, 422);
    for (const f of ['fullName', 'address', 'city', 'zip', 'cardName', 'cardNumber', 'expiry', 'cvv']) assert.ok(res.data.details[f], f);
  });
  test('coupons are validated and case-insensitive', async () => {
    assert.equal((await c.post('/demo-api/coupons/validate', { json: { code: 'save10' } })).data.percent, 10);
    assert.equal((await c.post('/demo-api/coupons/validate', { json: { code: 'FREE100' } })).status, 404);
  });
  test('reset restores the seeded state', async () => {
    await c.post('/demo-api/reset');
    assert.equal((await c.get('/demo-api/me')).data.user, null);
  });
});
