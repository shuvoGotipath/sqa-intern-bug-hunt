import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../server/app.js';
import { LocalStorage } from '../server/storage.js';

export const ADMIN = { username: 'admin', password: 'test-admin-password-123' };

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');

/** Starts the app on a random port with a throwaway in-memory MongoDB and a temp storage folder. */
export async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-test-'));
  const mongo = await MongoMemoryServer.create();
  const { app, col, client } = await createApp({
    mongoUri: mongo.getUri(),
    dbName: 'sqa_test',
    storage: new LocalStorage(path.join(dir, 'uploads')),
    adminUser: ADMIN.username,
    adminPassword: ADMIN.password,
    logErrors: false,
    rateLimits: { sessionStart: 1000, application: 1000 },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    col,
    dir,
    async close() {
      await new Promise((r) => server.close(r));
      await client.close();
      await mongo.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal HTTP client with a cookie jar, mimicking a browser tab. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = {};
  }
  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async request(method, url, { json, form, headers = {}, ajax = true } = {}) {
    const h = { ...headers };
    if (ajax) h['X-Requested-With'] = 'fetch';
    const cookie = this.cookieHeader();
    if (cookie) h.Cookie = cookie;
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) body = form;
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (/Max-Age=0/i.test(c)) delete this.cookies[name];
      else this.cookies[name] = value;
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(url, opts) { return this.request('GET', url, opts); }
  post(url, opts) { return this.request('POST', url, opts); }
  put(url, opts) { return this.request('PUT', url, opts); }
  patch(url, opts) { return this.request('PATCH', url, opts); }
  delete(url, opts) { return this.request('DELETE', url, opts); }
}

export function reportForm(fields = {}, evidence) {
  const fd = new FormData();
  const data = {
    title: 'Product search is case-sensitive',
    module: 'Product Listing & Search',
    steps: '1. Open the Shop page\n2. Type "lamp" in the search box\n3. Press Search',
    expected: 'The LED Desk Lamp is listed regardless of letter case.',
    actual: 'No products are shown; searching "Lamp" with a capital L works.',
    severity: 'Medium',
    priority: 'P2',
    ...fields,
  };
  for (const [k, v] of Object.entries(data)) fd.append(k, v);
  if (evidence) fd.append('evidence', new Blob([evidence.buffer]), evidence.name);
  return fd;
}

export function applicationForm(fields = {}, cv = { buffer: PDF, name: 'cv.pdf' }) {
  const fd = new FormData();
  const data = {
    fullName: 'Nusrat Jahan',
    email: 'nusrat@example.com',
    phone: '+880 1712 345678',
    institution: 'University of Dhaka',
    educationLevel: "Bachelor's (in progress)",
    experience: 'Completed an online software testing course.',
    profileUrl: 'https://www.linkedin.com/in/example',
    whySqa: 'I enjoy breaking things to make them better, and I want to help teams ship reliable software users can trust.',
    ...fields,
  };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) fd.append(k, v);
  if (cv) fd.append('cv', new Blob([cv.buffer]), cv.name);
  return fd;
}

export async function startedCandidate(base) {
  const c = new Client(base);
  const res = await c.post('/api/session/start', { json: { acceptedRules: true } });
  if (res.status !== 201) throw new Error('could not start session: ' + JSON.stringify(res.data));
  return c;
}
