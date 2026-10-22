import express from 'express';
import crypto from 'node:crypto';
import { HttpError } from '../security.js';
import { requireCandidate } from './candidate.js';

/**
 * Backend for the ShopNest demo store (the system under test).
 * State is sandboxed per candidate session.
 */

export const PRODUCTS = [
  { id: 'p1', name: 'Wireless Earbuds', category: 'Audio', price: 49, stock: 25, description: 'Compact true-wireless earbuds with 24-hour battery life and a pocket-sized charging case.' },
  { id: 'p2', name: 'Studio Headphones Pro', category: 'Audio', price: 129, stock: 0, description: 'Over-ear studio headphones with active noise cancelling and memory-foam ear cushions.' },
  { id: 'p3', name: 'Bluetooth Speaker Mini', category: 'Audio', price: 15.75, stock: 40, description: 'Splash-resistant mini speaker that clips onto your bag.' },
  { id: 'p4', name: 'Desk Organizer', category: 'Home Office', price: 25, stock: 30, description: 'Bamboo desk organizer with five compartments and a phone slot.' },
  { id: 'p5', name: 'LED Desk Lamp', category: 'Home Office', price: 45, stock: 12, description: 'Dimmable LED lamp with three colour temperatures and a USB charging port.' },
  { id: 'p6', name: 'Ergonomic Mouse', category: 'Accessories', price: 12, stock: 50, description: 'Vertical ergonomic mouse that reduces wrist strain.' },
  { id: 'p7', name: 'USB-C Cable (2 m)', category: 'Accessories', price: 5, stock: 200, description: 'Braided USB-C to USB-C cable supporting 60 W fast charging.' },
  { id: 'p8', name: 'Laptop Stand', category: 'Home Office', price: 60, stock: 8, description: 'Adjustable aluminium laptop stand for better posture.' },
  { id: 'p9', name: 'Fitness Band', category: 'Wearables', price: 99.99, stock: 15, description: 'Tracks steps, heart rate and sleep. Water resistant to 50 m.' },
  { id: 'p10', name: 'Smart Watch S2', category: 'Wearables', price: 249, stock: 5, description: 'AMOLED smart watch with GPS, NFC payments and a 5-day battery.' },
  { id: 'p11', name: 'Phone Case', category: 'Accessories', price: 8.5, stock: 60, description: 'Slim shock-absorbing case with raised camera edges.' },
  { id: 'p12', name: 'Mechanical Keyboard', category: 'Accessories', price: 89, stock: 20, description: 'Hot-swappable mechanical keyboard with tactile switches.' },
];

const COUPONS = { SAVE10: 10 };

const hashPassword = (pw) => crypto.createHash('sha256').update('shopnest:' + pw).digest('hex');

function seedState() {
  return {
    users: [
      { id: 'u1', name: 'Alex Rivera', email: 'demo@shopnest.test', password: hashPassword('Shop@1234'), phone: '+1 555 0100', dob: '1999-04-12', bio: 'Coffee lover and weekend cyclist.' },
    ],
    currentUserId: null,
    orders: [],
    orderSeq: 1000,
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function demoRouter({ col }) {
  const router = express.Router();
  const states = col.demoState;

  router.use(requireCandidate);

  // Load (or lazily seed) this candidate's sandbox. Writes below use targeted atomic
  // updates so concurrent requests never overwrite each other.
  router.use(async (req, res, next) => {
    try {
      const id = req.candidate._id;
      req.demoId = id;
      try {
        req.demo = await states.findOneAndUpdate({ _id: id }, { $setOnInsert: seedState() }, { upsert: true, returnDocument: 'after' });
      } catch (err) {
        // Two first requests racing on the upsert: the loser just reads the winner's document.
        if (err?.code !== 11000) throw err;
        req.demo = await states.findOne({ _id: id });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  const currentUser = (req) => req.demo.users.find((u) => u.id === req.demo.currentUserId) || null;
  const requireLogin = (req, res, next) => {
    if (!currentUser(req)) return next(new HttpError(401, 'Please log in to continue.'));
    next();
  };
  const publicUser = (u) => ({ name: u.name, email: u.email, phone: u.phone, dob: u.dob, bio: u.bio });
  const setCurrentUser = (req, userId) => states.updateOne({ _id: req.demoId }, { $set: { currentUserId: userId } });

  router.post('/reset', async (req, res) => {
    await states.replaceOne({ _id: req.demoId }, seedState());
    res.json({ ok: true });
  });

  // ---------- Products ----------
  router.get('/products', (req, res) => {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '');
    const sort = String(req.query.sort || 'featured');
    let list = PRODUCTS.slice();
    if (q) list = list.filter((p) => p.name.includes(q) || p.category.includes(q));
    if (category && category !== 'All') list = list.filter((p) => p.category === category);
    if (sort === 'price-asc') list.sort((a, b) => String(a.price).localeCompare(String(b.price)));
    else if (sort === 'price-desc') list.sort((a, b) => String(b.price).localeCompare(String(a.price)));
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ products: list, total: PRODUCTS.length, categories: [...new Set(PRODUCTS.map((p) => p.category))] });
  });

  router.get('/products/:id', (req, res) => {
    const p = PRODUCTS.find((x) => x.id === req.params.id);
    if (!p) throw new HttpError(404, 'Product not found.');
    res.json(p);
  });

  // ---------- Auth ----------
  router.get('/me', (req, res) => {
    const u = currentUser(req);
    res.json({ user: u ? publicUser(u) : null });
  });

  router.post('/register', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name : '';
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');
    const errors = {};
    if (name === '') errors.name = 'Full name is required.';
    else if (name.length > 60) errors.name = 'Full name must be 60 characters or fewer.';
    if (!email) errors.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+$/.test(email)) errors.email = 'Please enter a valid email address.';
    else if (req.demo.users.some((u) => u.email === email)) errors.email = 'An account with this email already exists.';
    if (!password) errors.password = 'Password is required.';
    else if (password.length < 7) errors.password = 'Password must be at least 8 characters long.';
    if (!errors.password && password.toLowerCase() !== confirmPassword.toLowerCase()) errors.confirmPassword = 'Passwords do not match.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Please correct the errors below.', errors);

    const user = { id: 'u' + crypto.randomBytes(6).toString('hex'), name, email, password: hashPassword(password), phone: '', dob: '', bio: '' };
    await states.updateOne({ _id: req.demoId }, { $push: { users: user }, $set: { currentUserId: user.id } });
    res.status(201).json({ message: 'Account created. Welcome to ShopNest!', user: publicUser(user) });
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) throw new HttpError(422, 'Email and password are required.');
    const user = req.demo.users.find((u) => u.email === email);
    if (!user || user.password !== hashPassword(password)) throw new HttpError(401, 'No account found with this email.');
    await setCurrentUser(req, user.id);
    res.json({ message: `Welcome back, ${user.name.trim()}!`, user: publicUser(user) });
  });

  router.post('/logout', async (req, res) => {
    await setCurrentUser(req, null);
    res.json({ ok: true });
  });

  // ---------- Profile ----------
  router.get('/profile', requireLogin, (req, res) => res.json(publicUser(currentUser(req))));

  router.put('/profile', requireLogin, async (req, res) => {
    const user = currentUser(req);
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const dob = String(req.body.dob || '').trim();
    const bio = String(req.body.bio || '');
    const errors = {};
    if (!name) errors.name = 'Full name is required.';
    else if (name.length > 60) errors.name = 'Full name must be 60 characters or fewer.';
    if (phone && !/^\+?[0-9][0-9\s-]{5,18}[0-9]$/.test(phone)) errors.phone = 'Phone number can only contain digits, spaces, dashes and a leading +.';
    if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)))) errors.dob = 'Enter a valid date of birth.';
    if (bio.length > 160) errors.bio = 'Bio is too long.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Please correct the errors below.', errors);
    await states.updateOne(
      { _id: req.demoId },
      { $set: { 'users.$[u].name': name, 'users.$[u].dob': dob, 'users.$[u].bio': bio } },
      { arrayFilters: [{ 'u.id': user.id }] },
    );
    res.json({ message: 'Profile updated successfully.' });
  });

  // ---------- Coupons ----------
  router.post('/coupons/validate', (req, res) => {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) throw new HttpError(422, 'Enter a coupon code.');
    if (!COUPONS[code]) throw new HttpError(404, 'This coupon code is not valid.');
    res.json({ code, percent: COUPONS[code] });
  });

  // ---------- Orders ----------
  router.get('/orders', requireLogin, (req, res) => {
    const user = currentUser(req);
    res.json({ orders: req.demo.orders.filter((o) => o.userId === user.id).reverse() });
  });

  router.get('/orders/:id', requireLogin, (req, res) => {
    const user = currentUser(req);
    const order = req.demo.orders.find((o) => o.id === req.params.id && o.userId === user.id);
    if (!order) throw new HttpError(404, 'Order not found.');
    res.json(order);
  });

  router.post('/orders', requireLogin, async (req, res) => {
    const user = currentUser(req);
    const { items = [], summary = {}, shipping = {}, payment = {} } = req.body || {};
    const errors = {};
    const s = (v) => String(v ?? '').trim();
    if (!s(shipping.fullName)) errors.fullName = 'Full name is required.';
    if (!s(shipping.address)) errors.address = 'Address is required.';
    if (!s(shipping.city)) errors.city = 'City is required.';
    if (!/^\d{4,10}$/.test(s(shipping.zip))) errors.zip = 'Enter a valid postal code (4–10 digits).';
    if (!s(payment.cardName)) errors.cardName = 'Name on card is required.';
    if (!/^\d{16}$/.test(s(payment.cardNumber).replace(/\s/g, ''))) errors.cardNumber = 'Card number must be 16 digits.';
    const exp = /^(\d{2})\/(\d{2})$/.exec(s(payment.expiry));
    if (!exp || Number(exp[1]) < 1 || Number(exp[1]) > 12) errors.expiry = 'Enter expiry as MM/YY.';
    else if (2000 + Number(exp[2]) < new Date().getFullYear()) errors.expiry = 'This card has expired.';
    if (!/^\d{3}$/.test(s(payment.cvv))) errors.cvv = 'CVV must be 3 digits.';
    if (!Array.isArray(items)) errors.items = 'Invalid cart.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Please correct the errors below.', errors);

    await delay(700);

    const lines = items
      .map((it) => {
        const p = PRODUCTS.find((x) => x.id === it.productId);
        const qty = Number.parseInt(it.qty, 10);
        return p && Number.isFinite(qty) ? { productId: p.id, name: p.name, price: p.price, qty } : null;
      })
      .filter(Boolean);
    const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
    const { orderSeq } = await states.findOneAndUpdate({ _id: req.demoId }, { $inc: { orderSeq: 1 } }, { returnDocument: 'after', projection: { orderSeq: 1 } });
    const order = {
      id: 'SN-' + orderSeq,
      userId: user.id,
      createdAt: new Date().toISOString(),
      lines,
      subtotal: num(summary.subtotal),
      discount: num(summary.discount),
      shippingCost: num(summary.shipping),
      total: num(summary.total),
      shipTo: { fullName: s(shipping.fullName), city: s(shipping.city) },
      cardLast4: s(payment.cardNumber).replace(/\s/g, '').slice(-4),
    };
    await states.updateOne({ _id: req.demoId }, { $push: { orders: order } });
    res.status(201).json({ message: 'Order placed successfully.', order });
  });

  return router;
}
