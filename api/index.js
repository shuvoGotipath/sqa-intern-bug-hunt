/**
 * Vercel serverless entry point. vercel.json rewrites /api/*, /demo-api/* and
 * /healthz here; static pages are served directly from public/.
 * The Express app (and its MongoDB connection) is created once per warm instance.
 */
import { createApp } from '../server/app.js';
import { configFromEnv, ConfigError } from '../server/config.js';

let appPromise = null;

function getApp() {
  appPromise ||= createApp(configFromEnv(process.env)).catch((err) => {
    appPromise = null; // retry on the next request instead of caching the failure
    throw err;
  });
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const { app } = await getApp();
    return app(req, res);
  } catch (err) {
    console.error('Startup failed:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const message = err instanceof ConfigError
      ? `Server is not configured: ${err.message} Add it in Vercel → Project → Settings → Environment Variables, then redeploy.`
      : 'The server could not connect to its database or file storage. Please try again shortly.';
    res.end(JSON.stringify({ error: message }));
  }
}
