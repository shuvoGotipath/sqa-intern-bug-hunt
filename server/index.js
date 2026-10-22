import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { storageFromEnv, S3Storage } from './storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no extra dependency). Real environment variables win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const isProd = process.env.NODE_ENV === 'production';
let adminPassword = process.env.ADMIN_PASSWORD;
const adminUser = process.env.ADMIN_USERNAME || 'admin';

if (!adminPassword || adminPassword.length < 12) {
  if (isProd) {
    console.error('ADMIN_PASSWORD must be set (min 12 characters) when NODE_ENV=production.');
    process.exit(1);
  }
  adminPassword = 'change-me-local-only';
  console.warn(`[dev] ADMIN_PASSWORD not set — using the local development password "${adminPassword}". Set ADMIN_PASSWORD in .env before deploying.`);
}

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set. Add your MongoDB connection string to .env (see .env.example).');
  process.exit(1);
}

const storage = storageFromEnv(process.env, process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, 'uploads'));
if (isProd && !(storage instanceof S3Storage)) {
  console.error('S3 storage is required in production. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
  process.exit(1);
}

let created;
try {
  created = await createApp({
    mongoUri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB || 'sqa_hiring',
    storage,
    adminUser,
    adminPassword,
    secureCookies: process.env.SECURE_COOKIES === 'true' || isProd,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
} catch (err) {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
const server = created.app.listen(port, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other process or set PORT in .env.` : err);
    process.exit(1);
  }
  console.log(`SQA Intern Bug Hunt running at http://localhost:${port}`);
  console.log(`Admin dashboard:        http://localhost:${port}/admin`);
  console.log(`Data: MongoDB "${process.env.MONGODB_DB || 'sqa_hiring'}" · Files: ${storage instanceof S3Storage ? `S3 bucket "${storage.bucket}"` : 'local uploads/ folder'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => created.client.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
