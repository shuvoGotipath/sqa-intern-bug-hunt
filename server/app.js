import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { HttpError, securityHeaders, requireAjaxHeader } from './security.js';
import { candidateRouter, loadCandidate } from './routes/candidate.js';
import { adminRouter } from './routes/admin.js';
import { demoRouter } from './routes/demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Builds the Express application. Everything configurable is injected so tests
 * can run against a throwaway MongoDB and a temporary storage folder.
 */
export async function createApp({
  mongoUri,
  dbName = 'sqa_hiring',
  storage,
  adminUser,
  adminPassword,
  secureCookies = false,
  trustProxy = false,
  logErrors = true,
  rateLimits = {},
} = {}) {
  if (!adminUser || !adminPassword) throw new Error('adminUser and adminPassword are required');
  if (!mongoUri) throw new Error('mongoUri is required');
  if (!storage) throw new Error('storage is required');
  const limits = { sessionStart: 30, application: 20, adminLogin: 10, ...rateLimits };
  const { client, db, col } = await openDatabase(mongoUri, dbName);
  await storage.check();
  const app = express();

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(requireAjaxHeader);
  api.use(loadCandidate(col));
  api.use('/admin', adminRouter({ col, storage, adminUser, adminPassword, secureCookies, limits }));
  api.use('/', candidateRouter({ col, storage, secureCookies, limits }));
  api.use((req, res, next) => next(new HttpError(404, 'Not found.')));

  const demoApi = express.Router();
  demoApi.use(requireAjaxHeader);
  demoApi.use(loadCandidate(col));
  demoApi.use('/', demoRouter({ col }));
  demoApi.use((req, res, next) => next(new HttpError(404, 'Not found.')));

  app.use('/api', api);
  app.use('/demo-api', demoApi);

  const publicDir = path.join(ROOT, 'public');
  app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));
  app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON body.');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Request body is too large.');
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500 && logErrors) console.error(err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status === 500 ? 'Something went wrong on our side. Please try again.' : err.message, details: err.details });
  });

  return { app, db, col, client };
}
