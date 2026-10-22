import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { storageFromEnv, S3Storage } from './storage.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ConfigError extends Error {}

/** Minimal .env loader (no extra dependency). Real environment variables win. */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * Turns environment variables into createApp() options. Shared by the
 * standalone server (server/index.js) and the Vercel function (api/index.js).
 * Throws ConfigError with a readable message when something required is missing.
 */
export function configFromEnv(env = process.env) {
  const onVercel = Boolean(env.VERCEL);
  const isProd = env.NODE_ENV === 'production' || onVercel;
  const missing = [];

  let adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 12) {
    if (isProd) missing.push('ADMIN_PASSWORD (at least 12 characters)');
    else {
      adminPassword = 'change-me-local-only';
      console.warn(`[dev] ADMIN_PASSWORD not set — using the local development password "${adminPassword}". Set ADMIN_PASSWORD before deploying.`);
    }
  }

  if (!env.MONGODB_URI) missing.push('MONGODB_URI');
  const storage = storageFromEnv(env, env.UPLOAD_DIR ? path.resolve(env.UPLOAD_DIR) : path.join(ROOT, 'uploads'));
  if (isProd && !(storage instanceof S3Storage)) {
    for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) if (!env[k]) missing.push(k);
  }
  if (missing.length) throw new ConfigError(`Missing environment variable(s): ${missing.join(', ')}.`);

  return {
    mongoUri: env.MONGODB_URI,
    dbName: env.MONGODB_DB || 'sqa_hiring',
    storage,
    adminUser: env.ADMIN_USERNAME || 'admin',
    adminPassword,
    // Vercel always serves over HTTPS behind its proxy.
    secureCookies: env.SECURE_COOKIES === 'true' || isProd,
    trustProxy: env.TRUST_PROXY === 'true' || onVercel,
  };
}
