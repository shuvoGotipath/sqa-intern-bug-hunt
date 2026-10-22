const view = document.getElementById('view');
const CART_KEY = 'shopnest.cart';
const ICONS = { p1: '🎧', p2: '🎧', p3: '🔊', p4: '🗂️', p5: '💡', p6: '🖱️', p7: '🔌', p8: '💻', p9: '⌚', p10: '⌚', p11: '📱', p12: '⌨️' };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => '$' + Number(n).toFixed(2);

const app = { user: null, products: [], byId: {}, lastQuery: '' };

// ------------------------------------------------------------------ http
async function http(url, { method = 'GET', body } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch('/demo-api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw Object.assign(new Error('Network error. Please try again.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status, details: data.details || {} });
  return data;
}

// ------------------------------------------------------------------ ui helpers
let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('sn-toast');
  el.textContent = msg;
  el.className = 'sn-toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'sn-toast'), 2600);
}

function fieldErrors(form, details) {
  form.querySelectorAll('.sn-err').forEach((e) => e.remove());
  form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  let first = null;
  for (const [name, msg] of Object.entries(details || {})) {
    const input = form.elements[name];
    if (!input) continue;
    input.setAttribute('aria-invalid', 'true');
    const err = document.createElement('span');
    err.className = 'sn-err';
    err.textContent = msg;
    input.closest('.sn-field').appendChild(err);
    first ||= input;
  }
  first?.focus();
}

function alertBox(form, msg, ok = false) {
  let box = form.querySelector('.sn-alert');
  if (!box) {
    box = document.createElement('div');
    box.setAttribute('role', ok ? 'status' : 'alert');
    form.prepend(box);
  }
  box.className = 'sn-alert ' + (ok ? 'ok' : 'err');
  box.textContent = msg;
}

// ------------------------------------------------------------------ cart
function loadCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY));
    if (c && Array.isArray(c.items)) return c;
  } catch {}
  return { items: [], coupon: null };
}
function saveCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {}
}
function updateBadge() {
  const count = loadCart().items.reduce((n, it) => n + it.qty, 0);
  document.getElementById('cart-badge').textContent = count;
}

function totals(cart) {
  const subtotal = cart.items.reduce((sum, it) => sum + (app.byId[it.productId]?.price || 0) * it.qty, 0);
  let discount = 0;
  if (cart.coupon) discount = subtotal * (1 - Math.pow(1 - cart.coupon.percent / 100, cart.coupon.applied));
  const afterDiscount = subtotal - discount;
  const shipping = cart.items.length === 0 ? 0 : afterDiscount > 50 ? 0 : 4.99;
  const r = (n) => Math.round(n * 100) / 100;
  return { subtotal: r(subtotal), discount: r(discount), shipping, total: r(afterDiscount + shipping) };
}

function setQuantity(productId, value) {
  const cart = loadCart();
  const line = cart.items.find((it) => it.productId === productId);
  if (!line) return false;
  const qty = Number.parseInt(value, 10);
  if (Number.isNaN(qty)) return false;
  if (qty >= 10) {
    toast('Maximum quantity per item is 10.', true);
    return false;
  }
  line.qty = qty;
  saveCart(cart);
  updateBadge();
  return true;
}

function addToCart(productId) {
  const cart = loadCart();
  const line = cart.items.find((it) => it.productId === productId);
  if (line && line.qty + 1 >= 10) return toast('Maximum quantity per item is 10.', true);
  if (line) line.qty += 1;
  else cart.items.push({ productId, qty: 1 });
  saveCart(cart);
  updateBadge();
  toast(`${app.byId[productId].name} added to cart.`);
}

// ------------------------------------------------------------------ header
function renderAccount() {
  const area = document.getElementById('account-area');
  const mobile = document.getElementById('mobile-account');
  if (app.user) {
    const html = `<span>Hi, ${esc(app.user.name.trim())}</span> <button class="sn-btn-link" data-logout>Log out</button>`;
    area.innerHTML = html;
    mobile.innerHTML = `<button data-logout>Log out (${esc(app.user.email)})</button>`;
  } else {
    area.innerHTML = '<a href="#/login">Log in</a> <a class="sn-btn" style="text-decoration:none;padding:6px 12px;min-height:0" href="#/register">Register</a>';
    mobile.innerHTML = '<a href="#/login">Log in</a><a href="#/register">Register</a>';
  }
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-logout]')) {
    await http('/logout', { method: 'POST' }).catch(() => {});
    app.user = null;
    renderAccount();
    toast('You have been logged out.');
    location.hash = '#/';
  }
});

const burger = document.getElementById('burger');
const mobileMenu = document.getElementById('mobile-menu');
burger.addEventListener('click', () => {
  const open = mobileMenu.hidden;
  mobileMenu.hidden = !open;
  burger.setAttribute('aria-expanded', String(open));
  burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
});
mobileMenu.addEventListener('click', (e) => {
  if (e.target.closest('a')) {
    mobileMenu.hidden = true;
    burger.setAttribute('aria-expanded', 'false');
  }
});

// ------------------------------------------------------------------ pages
function stockLabel(p) {
  if (p.stock === 0) return '<span class="sn-stock out">Out of stock</span>';
  if (p.stock <= 8) return `<span class="sn-stock low">Only ${p.stock} left</span>`;
  return '<span class="sn-stock ok">In stock</span>';
}

async function pageShop(params) {
  const q = params.get('q') || '';
  const category = params.get('category') || 'All';
  const sort = params.get('sort') || 'featured';
  const categories = [...new Set(app.products.map((p) => p.category))];
  view.innerHTML = `
    <h1>Shop</h1>
    <form class="sn-toolbar" id="filter-form" role="search">
      <label for="q" class="sr">Search products</label>
      <input type="search" id="q" name="q" placeholder="Search products…" value="${esc(q)}" aria-label="Search products">
      <select name="category" aria-label="Category">
        <option>All</option>${categories.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <select name="sort" aria-label="Sort by">
        <option value="featured" ${sort === 'featured' ? 'selected' : ''}>Featured</option>
        <option value="price-asc" ${sort === 'price-asc' ? 'selected' : ''}>Price: Low to High</option>
        <option value="price-desc" ${sort === 'price-desc' ? 'selected' : ''}>Price: High to Low</option>
        <option value="name" ${sort === 'name' ? 'selected' : ''}>Name: A–Z</option>
      </select>
      <button class="sn-btn" type="submit">Search</button>
    </form>
    <div id="results"><div class="sn-loading">Loading products…</div></div>`;
  document.querySelector('label.sr').style.display = 'none';

  const form = document.getElementById('filter-form');
  const go = () => {
    const p = new URLSearchParams();
    const fd = new FormData(form);
    if (fd.get('q').trim()) p.set('q', fd.get('q').trim());
    if (fd.get('category') !== 'All') p.set('category', fd.get('category'));
    if (fd.get('sort') !== 'featured') p.set('sort', fd.get('sort'));
    location.hash = '#/' + (p.toString() ? '?' + p : '');
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
  form.category.addEventListener('change', go);
  form.sort.addEventListener('change', go);

  const results = document.getElementById('results');
  try {
    const qs = new URLSearchParams({ q, category, sort });
    const data = await http('/products?' + qs);
    const list = data.products;
    if (!list.length) {
      results.innerHTML = `<p class="sn-count">Showing ${data.total} products</p><div class="sn-empty">No products match “${esc(q)}”. Try a different search term.</div>`;
      return;
    }
    results.innerHTML = `<p class="sn-count">Showing ${data.total} products</p><div class="sn-grid">${list
      .map(
        (p) => `
      <article class="sn-card">
        <div class="sn-thumb" aria-hidden="true">${ICONS[p.id] || '📦'}</div>
        <div class="sn-card-body">
          <span class="sn-cat">${esc(p.category)}</span>
          <h3><a href="#/product/${esc(p.id)}">${esc(p.name)}</a></h3>
          <span class="sn-price">${money(p.price)}</span>
          ${stockLabel(p)}
          <button class="sn-btn" data-add="${esc(p.id)}" ${p.stock === 0 ? 'disabled' : ''}>${p.stock === 0 ? 'Out of stock' : 'Add to cart'}</button>
        </div>
      </article>`,
      )
      .join('')}</div>`;
  } catch (err) {
    results.innerHTML = `<div class="sn-alert err" role="alert">${esc(err.message)}</div>`;
  }
}

view.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add && !add.disabled) addToCart(add.dataset.add);
});

async function pageProduct(id) {
  view.innerHTML = '<div class="sn-loading">Loading…</div>';
  try {
    const p = await http('/products/' + encodeURIComponent(id));
    view.innerHTML = `
      <p><a href="#/">← Back to shop</a></p>
      <div class="sn-detail">
        <div class="sn-thumb" aria-hidden="true">${ICONS[p.id] || '📦'}</div>
        <div>
          <span class="sn-cat">${esc(p.category)}</span>
          <h1>${esc(p.name)}</h1>
          <p class="sn-price" style="font-size:24px">${money(p.price)}</p>
          <p>${stockLabel(p)}</p>
          <p>${esc(p.description)}</p>
          <button class="sn-btn" data-add="${esc(p.id)}">Add to cart</button>
        </div>
      </div>`;
  } catch (err) {
    view.innerHTML = `<div class="sn-empty">${esc(err.status === 404 ? 'This product could not be found.' : err.message)}</div>`;
  }
}

function pageLogin() {
  view.innerHTML = `
    <div class="sn-panel sn-narrow">
      <h1>Log in</h1>
      <form id="login-form" novalidate>
        <div class="sn-field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" autocomplete="username"></div>
        <div class="sn-field"><label for="l-password">Password</label><input id="l-password" name="password" type="password" autocomplete="current-password"></div>
        <button class="sn-btn sn-btn-block" type="submit">Log in</button>
      </form>
      <p style="margin-top:14px;font-size:14px">New to ShopNest? <a href="#/register">Create an account</a></p>
    </div>`;
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const data = await http('/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } });
      app.user = data.user;
      renderAccount();
      toast(data.message);
      location.hash = '#/';
    } catch (err) {
      alertBox(form, err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

function pageRegister() {
  view.innerHTML = `
    <div class="sn-panel sn-narrow">
      <h1>Create your account</h1>
      <form id="reg-form" novalidate>
        <div class="sn-field"><label for="g-name">Full name</label><input id="g-name" name="name" type="text" autocomplete="name"></div>
        <div class="sn-field"><label for="g-email">Email</label><input id="g-email" name="email" type="email" autocomplete="email"></div>
        <div class="sn-field"><label for="g-password">Password</label><input id="g-password" name="password" type="password" autocomplete="new-password" aria-describedby="g-pw-help"><span class="sn-help" id="g-pw-help">Use at least 8 characters.</span></div>
        <div class="sn-field"><label for="g-confirm">Confirm password</label><input id="g-confirm" name="confirmPassword" type="password" autocomplete="new-password"></div>
        <button class="sn-btn sn-btn-block" type="submit">Create account</button>
      </form>
      <p style="margin-top:14px;font-size:14px">Already have an account? <a href="#/login">Log in</a></p>
    </div>`;
  const form = document.getElementById('reg-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const body = { name: form.name.value, email: form.email.value, password: form.password.value, confirmPassword: form.confirmPassword.value };
      const data = await http('/register', { method: 'POST', body });
      app.user = data.user;
      renderAccount();
      toast(data.message);
      location.hash = '#/';
    } catch (err) {
      alertBox(form, err.message);
      fieldErrors(form, err.details);
    } finally {
      btn.disabled = false;
    }
  });
}

function needLogin(what) {
  view.innerHTML = `<div class="sn-empty"><p>Please log in to ${esc(what)}.</p><p><a class="sn-btn" style="text-decoration:none;display:inline-block" href="#/login">Log in</a></p></div>`;
}

function ageFrom(dob) {
  if (!dob) return '';
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age -= 1;
  return `Age: ${age}`;
}

async function pageProfile() {
  view.innerHTML = '<div class="sn-loading">Loading profile…</div>';
  let p;
  try {
    p = await http('/profile');
  } catch (err) {
    if (err.status === 401) return needLogin('view your profile');
    view.innerHTML = `<div class="sn-alert err">${esc(err.message)}</div>`;
    return;
  }
  view.innerHTML = `
    <div class="sn-panel sn-narrow" style="max-width:560px">
      <h1>My profile</h1>
      <form id="profile-form" novalidate>
        <div class="sn-field"><label for="p-name">Full name</label><input id="p-name" name="name" type="text" value="${esc(p.name)}"></div>
        <div class="sn-field"><label for="p-email">Email</label><input id="p-email" type="email" value="${esc(p.email)}" readonly aria-describedby="p-email-help"><span class="sn-help" id="p-email-help">Email cannot be changed.</span></div>
        <div class="sn-row">
          <div class="sn-field"><label for="p-phone">Phone</label><input id="p-phone" name="phone" type="tel" value="${esc(p.phone)}" placeholder="+1 555 0100"></div>
          <div class="sn-field"><label for="p-dob">Date of birth</label><input id="p-dob" name="dob" type="date" value="${esc(p.dob)}"><span class="sn-help" id="p-age">${esc(ageFrom(p.dob))}</span></div>
        </div>
        <div class="sn-field"><label for="p-bio">Bio</label><textarea id="p-bio" name="bio" rows="3" maxlength="160" aria-describedby="p-bio-count">${esc(p.bio)}</textarea><span class="sn-help" id="p-bio-count"></span></div>
        <button class="sn-btn" type="submit">Save changes</button>
      </form>
    </div>`;
  const form = document.getElementById('profile-form');
  const counter = () => (document.getElementById('p-bio-count').textContent = `${150 - form.bio.value.length} characters left`);
  counter();
  form.bio.addEventListener('input', counter);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const data = await http('/profile', { method: 'PUT', body: { name: form.name.value, phone: form.phone.value, dob: form.dob.value, bio: form.bio.value } });
      fieldErrors(form, {});
      alertBox(form, data.message, true);
      document.getElementById('p-age').textContent = ageFrom(form.dob.value);
      app.user = { ...app.user, name: form.name.value.trim() };
      renderAccount();
    } catch (err) {
      alertBox(form, err.message);
      fieldErrors(form, err.details);
    } finally {
      btn.disabled = false;
    }
  });
}

async function pageOrders() {
  view.innerHTML = '<div class="sn-loading">Loading orders…</div>';
  try {
    const { orders } = await http('/orders');
    if (!orders.length) {
      view.innerHTML = '<h1>My orders</h1><div class="sn-empty">You have not placed any orders yet. <a href="#/">Start shopping</a></div>';
      return;
    }
    view.innerHTML = `<h1>My orders</h1><div class="sn-orders">${orders
      .map(
        (o) => `
        <article class="sn-order">
          <div class="sn-order-head"><a href="#/order/${esc(o.id)}">${esc(o.id)}</a><span>${esc(new Date(o.createdAt).toLocaleString())}</span><span>${money(o.total)}</span></div>
          <ul>${o.lines.map((l) => `<li>${esc(l.name)} × ${esc(l.qty)}</li>`).join('') || '<li>No items</li>'}</ul>
        </article>`,
      )
      .join('')}</div>`;
  } catch (err) {
    if (err.status === 401) return needLogin('see your orders');
    view.innerHTML = `<div class="sn-alert err">${esc(err.message)}</div>`;
  }
}

function summaryHtml(t, cart) {
  return `
    <dl>
      <dt>Subtotal</dt><dd>${money(t.subtotal)}</dd>
      ${cart.coupon ? `<dt>Discount (${esc(cart.coupon.code)})</dt><dd>−${money(t.discount)}</dd>` : ''}
      <dt>Shipping</dt><dd>${t.shipping === 0 ? (cart.items.length ? 'Free' : money(0)) : money(t.shipping)}</dd>
      <dt class="total">Total</dt><dd class="total">${money(t.total)}</dd>
    </dl>`;
}

function pageCart() {
  const cart = loadCart();
  const t = totals(cart);
  const rows = cart.items
    .map((it) => {
      const p = app.byId[it.productId];
      if (!p) return '';
      return `
      <tr>
        <td><strong>${esc(p.name)}</strong><br><span class="sn-cat">${money(p.price)} each</span></td>
        <td>
          <div class="sn-qty">
            <button type="button" data-dec="${esc(p.id)}" aria-label="Decrease quantity of ${esc(p.name)}">−</button>
            <input type="number" min="1" max="10" value="${esc(it.qty)}" data-qty="${esc(p.id)}" aria-label="Quantity of ${esc(p.name)}">
            <button type="button" data-inc="${esc(p.id)}" aria-label="Increase quantity of ${esc(p.name)}">+</button>
          </div>
        </td>
        <td>${money(p.price * it.qty)}</td>
        <td><button class="sn-btn-link" data-remove="${esc(p.id)}">Remove</button></td>
      </tr>`;
    })
    .join('');
  view.innerHTML = `
    <h1>Your cart</h1>
    <div class="sn-cart-layout">
      <div>
        ${cart.items.length
          ? `<table class="sn-cart-table"><thead><tr><th>Product</th><th>Quantity</th><th>Total</th><th><span style="position:absolute;left:-9999px">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`
          : '<div class="sn-empty">Your cart is empty. <a href="#/">Continue shopping</a></div>'}
      </div>
      <aside class="sn-panel sn-summary">
        <h2>Order summary</h2>
        <form class="sn-coupon" id="coupon-form" novalidate>
          <input name="code" placeholder="Coupon code" aria-label="Coupon code" value="${esc(cart.coupon?.code || '')}">
          <button class="sn-btn sn-btn-outline" type="submit">Apply</button>
        </form>
        ${cart.coupon ? '<p style="margin:0 0 10px;font-size:13px"><button class="sn-btn-link" data-remove-coupon>Remove coupon</button></p>' : ''}
        ${summaryHtml(t, cart)}
        <a class="sn-btn sn-btn-block" style="display:block;text-align:center;text-decoration:none" href="#/checkout">Proceed to checkout</a>
      </aside>
    </div>`;

  document.getElementById('coupon-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = e.target.code.value;
    try {
      const c = await http('/coupons/validate', { method: 'POST', body: { code } });
      const fresh = loadCart();
      if (fresh.coupon && fresh.coupon.code === c.code) fresh.coupon.applied += 1;
      else fresh.coupon = { code: c.code, percent: c.percent, applied: 1 };
      saveCart(fresh);
      toast(`Coupon ${c.code} applied!`);
      pageCart();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

view.addEventListener('change', (e) => {
  const input = e.target.closest('[data-qty]');
  if (!input) return;
  setQuantity(input.dataset.qty, input.value);
  pageCart();
});
view.addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  const rm = e.target.closest('[data-remove]');
  if (inc || dec) {
    const id = (inc || dec).dataset.inc || (inc || dec).dataset.dec;
    const line = loadCart().items.find((it) => it.productId === id);
    if (!line) return;
    if (dec && line.qty <= 1) return;
    setQuantity(id, line.qty + (inc ? 1 : -1));
    pageCart();
  } else if (rm) {
    const cart = loadCart();
    cart.items = cart.items.filter((it) => it.productId !== rm.dataset.remove);
    saveCart(cart);
    pageCart();
    toast('Item removed from cart.');
  } else if (e.target.closest('[data-remove-coupon]')) {
    const cart = loadCart();
    cart.coupon = null;
    saveCart(cart);
    pageCart();
  }
});

function pageCheckout() {
  if (!app.user) return needLogin('check out');
  const cart = loadCart();
  const t = totals(cart);
  view.innerHTML = `
    <h1>Checkout</h1>
    <form id="checkout-form" class="sn-checkout" novalidate>
      <div class="sn-panel">
        <h2>Shipping address</h2>
        <div class="sn-field"><label for="c-fullName">Full name</label><input id="c-fullName" name="fullName" autocomplete="name" value="${esc(app.user.name.trim())}"></div>
        <div class="sn-field"><label for="c-address">Address</label><input id="c-address" name="address" autocomplete="street-address"></div>
        <div class="sn-row">
          <div class="sn-field"><label for="c-city">City</label><input id="c-city" name="city" autocomplete="address-level2"></div>
          <div class="sn-field"><label for="c-zip">Postal code</label><input id="c-zip" name="zip" inputmode="numeric" autocomplete="postal-code"></div>
        </div>
        <h2 style="margin-top:8px">Payment</h2>
        <p class="sn-test-note">Demo checkout — no real payment is taken. Use any 16-digit test card number, e.g. 4242 4242 4242 4242.</p>
        <div class="sn-field"><label for="c-cardName">Name on card</label><input id="c-cardName" name="cardName" autocomplete="off"></div>
        <div class="sn-field"><label for="c-cardNumber">Card number</label><input id="c-cardNumber" name="cardNumber" inputmode="numeric" autocomplete="off" placeholder="4242 4242 4242 4242"></div>
        <div class="sn-row">
          <div class="sn-field"><label for="c-expiry">Expiry (MM/YY)</label><input id="c-expiry" name="expiry" placeholder="MM/YY" autocomplete="off"></div>
          <div class="sn-field"><label for="c-cvv">CVV</label><input id="c-cvv" name="cvv" inputmode="numeric" autocomplete="off" maxlength="4"></div>
        </div>
      </div>
      <aside class="sn-panel sn-summary">
        <h2>Order summary</h2>
        <p class="sn-cat">${cart.items.reduce((n, it) => n + it.qty, 0)} item(s)</p>
        ${summaryHtml(t, cart)}
        <button class="sn-btn sn-btn-block" type="submit" id="place-order">Place order</button>
      </aside>
    </form>`;
  const form = document.getElementById('checkout-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = loadCart();
    const body = {
      items: current.items,
      summary: totals(current),
      shipping: { fullName: form.fullName.value, address: form.address.value, city: form.city.value, zip: form.zip.value },
      payment: { cardName: form.cardName.value, cardNumber: form.cardNumber.value, expiry: form.expiry.value, cvv: form.cvv.value },
    };
    const btn = document.getElementById('place-order');
    btn.textContent = 'Placing order…';
    try {
      const data = await http('/orders', { method: 'POST', body });
      saveCart({ items: [], coupon: null });
      updateBadge();
      location.hash = '#/order/' + data.order.id;
    } catch (err) {
      btn.textContent = 'Place order';
      if (err.status === 401) return needLogin('check out');
      fieldErrors(form, err.details);
      toast(err.message, true);
    }
  });
}

async function pageOrder(id) {
  view.innerHTML = '<div class="sn-loading">Loading order…</div>';
  try {
    const o = await http('/orders/' + encodeURIComponent(id));
    view.innerHTML = `
      <div class="sn-panel sn-narrow" style="max-width:560px;text-align:center">
        <div style="font-size:48px" aria-hidden="true">✅</div>
        <h1>Thank you for your order!</h1>
        <p>Order <strong>${esc(o.id)}</strong> has been placed and will be shipped to ${esc(o.shipTo.fullName)}, ${esc(o.shipTo.city)}.</p>
        <p>Total charged: <strong>${money(o.total)}</strong> to card ending ${esc(o.cardLast4)}</p>
        <p><a href="#/orders">View my orders</a> · <a href="#/">Continue shopping</a></p>
      </div>`;
  } catch (err) {
    if (err.status === 401) return needLogin('see this order');
    view.innerHTML = `<div class="sn-empty">${esc(err.message)}</div>`;
  }
}

// ------------------------------------------------------------------ router
async function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  document.querySelectorAll('.sn-nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + path));
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (!parts.length) await pageShop(params);
  else if (parts[0] === 'product' && parts[1]) await pageProduct(parts[1]);
  else if (parts[0] === 'login') pageLogin();
  else if (parts[0] === 'register') pageRegister();
  else if (parts[0] === 'profile') await pageProfile();
  else if (parts[0] === 'orders') await pageOrders();
  else if (parts[0] === 'order' && parts[1]) await pageOrder(parts[1]);
  else if (parts[0] === 'cart') pageCart();
  else if (parts[0] === 'checkout') pageCheckout();
  else view.innerHTML = '<div class="sn-empty">Page not found. <a href="#/">Go to the shop</a></div>';
  document.title = 'ShopNest';
}

async function init() {
  try {
    const [me, all] = await Promise.all([http('/me'), http('/products')]);
    app.user = me.user;
    app.products = all.products;
    app.byId = Object.fromEntries(all.products.map((p) => [p.id, p]));
  } catch (err) {
    view.innerHTML = `<div class="sn-empty"><p><strong>ShopNest is not available.</strong></p><p>${esc(err.status === 401 ? 'Start the challenge from the hiring page to use the demo store.' : err.message)}</p></div>`;
    return;
  }
  renderAccount();
  updateBadge();
  window.addEventListener('hashchange', route);
  route();
}

init();
