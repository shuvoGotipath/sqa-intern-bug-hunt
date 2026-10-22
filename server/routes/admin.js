import express from 'express';
import { HttpError, newToken, hashToken, parseCookies, setCookie, clearCookie, safeEqual, rateLimit } from '../security.js';
import mammoth from 'mammoth';
import { sendStored, readStored } from '../storage.js';
import { escapeHtml } from '../security.js';
import { BUGS, BUG_BY_ID, SCORING, DIFFICULTY_POINTS, MODULES } from '../evaluation/answerKey.js';
import { HINTS } from '../evaluation/hints.js';
import { evaluate, maxScore, bugPoints } from '../evaluation/scoring.js';
import { forScoring } from './candidate.js';

export const ADMIN_COOKIE = 'sqa_admin';
const ADMIN_TTL_MS = 8 * 3600 * 1000;
const APP_STATUSES = ['under_review', 'shortlisted', 'rejected'];
const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PREVIEWABLE = new Set([PDF_MIME, DOCX_MIME]);

/** Standalone page for a converted DOCX. Shown in a sandboxed iframe; no scripts, no external loads. */
const docxPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1b1f2e;max-width:800px;margin:0 auto;padding:32px 24px;background:#fff}
h1,h2,h3{line-height:1.3}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #dde1ec;padding:4px 8px}a{color:#4338ca}</style>
</head><body>${body}</body></html>`;

export function adminRouter({ col, storage, adminUser, adminPassword, secureCookies, limits }) {
  const router = express.Router();

  async function isAdmin(req) {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    if (!token) return false;
    const row = await col.adminSessions.findOne({ _id: hashToken(token) });
    return Boolean(row && row.expiresAt > new Date());
  }

  router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: limits.adminLogin, message: 'Too many login attempts. Try again in 15 minutes.' }), async (req, res) => {
    const { username = '', password = '' } = req.body || {};
    const ok = safeEqual(username, adminUser) & safeEqual(password, adminPassword);
    if (!ok) throw new HttpError(401, 'Incorrect username or password.');
    const token = newToken();
    await col.adminSessions.insertOne({ _id: hashToken(token), expiresAt: new Date(Date.now() + ADMIN_TTL_MS) });
    setCookie(res, ADMIN_COOKIE, token, { maxAgeSeconds: ADMIN_TTL_MS / 1000, sameSite: 'Strict', secure: secureCookies });
    res.json({ ok: true });
  });

  router.post('/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    if (token) await col.adminSessions.deleteOne({ _id: hashToken(token) });
    clearCookie(res, ADMIN_COOKIE);
    res.json({ ok: true });
  });

  router.get('/me', async (req, res) => res.json({ authenticated: await isAdmin(req) }));

  router.use(async (req, res, next) => {
    try {
      if (!(await isAdmin(req))) return next(new HttpError(401, 'Administrator login required.'));
      res.set('Cache-Control', 'no-store');
      next();
    } catch (err) {
      next(err);
    }
  });

  const reportCounts = async () =>
    Object.fromEntries((await col.reports.aggregate([{ $group: { _id: '$sessionId', n: { $sum: 1 } } }]).toArray()).map((r) => [r._id, r.n]));

  function summarize(s, app, reportCount) {
    const ev = s.evaluation;
    const minutes = s.submittedAt ? Math.round((Date.parse(s.submittedAt) - Date.parse(s.startedAt)) / 60000) : null;
    return {
      reference: s._id,
      stage: s.status,
      startedAt: s.startedAt,
      submittedAt: s.submittedAt,
      minutesSpent: minutes,
      hintsUsed: s.hintsUsed,
      reportCount,
      score: s.score ?? null,
      bugsFound: ev?.bugsFound ?? null,
      totalBugs: BUGS.length,
      unmatched: ev?.unmatched ?? null,
      duplicates: ev?.duplicates ?? null,
      application: app
        ? { id: app._id, fullName: app.fullName, email: app.email, phone: app.phone, institution: app.institution, educationLevel: app.educationLevel, status: app.status, appliedAt: app.createdAt }
        : null,
    };
  }

  async function listCandidates(query) {
    const [sessions, apps, counts] = await Promise.all([
      col.sessions.find({}, { projection: { tokenHash: 0, 'evaluation.reports': 0 } }).toArray(),
      col.applications.find({}, { projection: { whySqa: 0, experience: 0 } }).toArray(),
      reportCounts(),
    ]);
    const appBySession = new Map(apps.map((a) => [a.sessionId, a]));
    let rows = sessions.map((s) => summarize(s, appBySession.get(s._id), counts[s._id] || 0));
    rows.sort((a, b) => String(b.application?.appliedAt || b.submittedAt || b.startedAt).localeCompare(String(a.application?.appliedAt || a.submittedAt || a.startedAt)));
    const { stage, status, minScore, maxScore: maxS, q } = query;
    if (stage && stage !== 'all') rows = rows.filter((r) => r.stage === stage);
    if (status && status !== 'all') rows = rows.filter((r) => r.application?.status === status);
    if (minScore !== undefined && minScore !== '') rows = rows.filter((r) => r.score !== null && r.score >= Number(minScore));
    if (maxS !== undefined && maxS !== '') rows = rows.filter((r) => r.score !== null && r.score <= Number(maxS));
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((r) => [r.reference, r.application?.fullName, r.application?.email, r.application?.institution].some((v) => v && v.toLowerCase().includes(needle)));
    }
    return rows;
  }

  router.get('/candidates', async (req, res) => {
    const [stages, apps] = await Promise.all([
      col.sessions.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      col.applications.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    res.json({
      candidates: await listCandidates(req.query),
      stats: { stages: Object.fromEntries(stages.map((r) => [r._id, r.n])), applications: Object.fromEntries(apps.map((r) => [r._id, r.n])) },
    });
  });

  async function candidateDetail(id) {
    const s = await col.sessions.findOne({ _id: String(id) }, { projection: { tokenHash: 0 } });
    if (!s) throw new HttpError(404, 'Candidate not found.');
    const [app, reports] = await Promise.all([
      col.applications.findOne({ sessionId: s._id }),
      col.reports.find({ sessionId: s._id }).sort({ createdAt: 1, _id: 1 }).toArray(),
    ]);
    const evaluation = s.evaluation;
    const byReport = new Map((evaluation?.reports || []).map((r) => [r.reportId, r]));
    return {
      ...summarize(s, app, reports.length),
      application: app
        ? {
            id: app._id, fullName: app.fullName, email: app.email, phone: app.phone, institution: app.institution,
            educationLevel: app.educationLevel, experience: app.experience, profileUrl: app.profileUrl, whySqa: app.whySqa,
            cv: { name: app.cv.name, mime: app.cv.mime, url: `/api/admin/files/cv/${app._id}`, previewUrl: PREVIEWABLE.has(app.cv.mime) ? `/api/admin/files/cv/${app._id}/preview` : null }, status: app.status, notes: app.adminNotes, appliedAt: app.createdAt,
          }
        : null,
      evaluation: evaluation ? { ...evaluation, reports: undefined } : null,
      reports: reports.map((r) => ({
        id: r._id, title: r.title, module: r.module, steps: r.steps, expected: r.expected, actual: r.actual,
        severity: r.severity, priority: r.priority, adminVerdict: r.adminVerdict, createdAt: r.createdAt, updatedAt: r.updatedAt,
        evidence: r.evidence?.key ? { name: r.evidence.name, url: `/api/admin/files/evidence/${r._id}` } : null,
        result: byReport.get(r._id) || null,
      })),
      coverage: BUGS.map((b) => ({
        id: b.id, title: b.title, module: b.module, severity: b.severity, priority: b.priority, difficulty: b.difficulty,
        found: Boolean(evaluation?.foundBugIds.includes(b.id)),
        reportIds: (evaluation?.reports || []).filter((r) => r.bugId === b.id).map((r) => r.reportId),
      })),
    };
  }

  router.get('/candidates/:id', async (req, res) => res.json(await candidateDetail(req.params.id)));

  async function reevaluate(sessionId) {
    const s = await col.sessions.findOne({ _id: sessionId });
    if (!s || s.status === 'in_progress') return null;
    const reports = await col.reports.find({ sessionId }).sort({ createdAt: 1, _id: 1 }).toArray();
    const ev = evaluate(reports.map(forScoring), s.hintsUsed);
    await col.sessions.updateOne({ _id: sessionId }, { $set: { score: ev.score, evaluation: ev } });
    return ev;
  }

  router.post('/candidates/:id/reevaluate', async (req, res) => {
    if (!(await reevaluate(String(req.params.id)))) throw new HttpError(409, 'This candidate has not submitted the challenge yet.');
    res.json(await candidateDetail(req.params.id));
  });

  router.patch('/candidates/:id/application', async (req, res) => {
    const { status, notes } = req.body || {};
    if (status !== undefined && !APP_STATUSES.includes(status)) throw new HttpError(422, 'Status must be under_review, shortlisted or rejected.');
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 5000)) throw new HttpError(422, 'Notes must be text of at most 5000 characters.');
    const $set = { updatedAt: new Date().toISOString() };
    if (status !== undefined) $set.status = status;
    if (notes !== undefined) $set.adminNotes = notes;
    const result = await col.applications.updateOne({ sessionId: String(req.params.id) }, { $set });
    if (result.matchedCount === 0) throw new HttpError(404, 'This candidate has not submitted an application.');
    res.json(await candidateDetail(req.params.id));
  });

  router.patch('/reports/:id/verdict', async (req, res) => {
    const verdict = String(req.body?.verdict || '');
    const valid = verdict === 'auto' || verdict === 'invalid' || verdict === 'extra' || (verdict.startsWith('bug:') && BUG_BY_ID[verdict.slice(4)]);
    if (!valid) throw new HttpError(422, 'Unknown verdict.');
    const report = await col.reports.findOneAndUpdate({ _id: String(req.params.id) }, { $set: { adminVerdict: verdict } }, { returnDocument: 'after' });
    if (!report) throw new HttpError(404, 'Report not found.');
    await reevaluate(report.sessionId);
    res.json(await candidateDetail(report.sessionId));
  });

  router.get('/answer-key', (req, res) => {
    res.json({
      modules: MODULES,
      bugs: BUGS.map((b) => ({ ...b, points: bugPoints(b), match: b.match.map((g) => g.map(String)), exclude: b.exclude?.map(String) })),
      scoring: SCORING,
      difficultyPoints: DIFFICULTY_POINTS,
      maxPoints: maxScore(),
      hints: HINTS,
    });
  });

  router.get('/files/cv/:applicationId', async (req, res) => {
    const app = await col.applications.findOne({ _id: String(req.params.applicationId) }, { projection: { cv: 1 } });
    if (!app) throw new HttpError(404, 'File not found.');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(app.cv.mime);
    res.attachment(app.cv.name);
    if (!(await sendStored(storage, app.cv.key, res))) throw new HttpError(404, 'File is missing from storage.');
  });

  // Inline preview: PDFs stream to the browser's PDF viewer; DOCX is converted to plain HTML.
  router.get('/files/cv/:applicationId/preview', async (req, res) => {
    const app = await col.applications.findOne({ _id: String(req.params.applicationId) }, { projection: { cv: 1 } });
    if (!app) throw new HttpError(404, 'File not found.');
    const { key, mime, name } = app.cv;
    if (mime === PDF_MIME) {
      res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.type(PDF_MIME);
      res.set('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
      if (!(await sendStored(storage, key, res))) throw new HttpError(404, 'File is missing from storage.');
      return;
    }
    if (mime === DOCX_MIME) {
      const buffer = await readStored(storage, key);
      if (!buffer) throw new HttpError(404, 'File is missing from storage.');
      let html;
      try {
        ({ value: html } = await mammoth.convertToHtml({ buffer }));
      } catch {
        throw new HttpError(422, 'This Word document could not be converted for preview. Please download it instead.');
      }
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox");
      res.type('html').send(docxPage(name, html || '<p><em>This document appears to be empty.</em></p>'));
      return;
    }
    throw new HttpError(415, 'Preview is available for PDF and DOCX files only. Please download this CV instead.');
  });

  router.get('/files/evidence/:reportId', async (req, res) => {
    const r = await col.reports.findOne({ _id: String(req.params.reportId) }, { projection: { evidence: 1 } });
    if (!r?.evidence?.key) throw new HttpError(404, 'File not found.');
    res.type(r.evidence.mime);
    if (!(await sendStored(storage, r.evidence.key, res))) throw new HttpError(404, 'File is missing from storage.');
  });

  router.get('/export.csv', async (req, res) => {
    const rows = await listCandidates(req.query);
    const header = ['Reference', 'Stage', 'Full name', 'Email', 'Phone', 'Institution', 'Education level', 'Application status', 'Score (%)', 'Bugs found', 'Total bugs', 'Reports', 'Unmatched', 'Duplicates', 'Hints used', 'Minutes spent', 'Challenge submitted', 'Applied at'];
    const esc = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      // Neutralise spreadsheet formulas, but leave plain phone numbers / negative numbers alone.
      if (/^[=+\-@\t\r]/.test(s) && !/^[+-][\d\s().-]*$/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      const a = r.application || {};
      lines.push([r.reference, r.stage, a.fullName, a.email, a.phone, a.institution, a.educationLevel, a.status, r.score, r.bugsFound, r.totalBugs, r.reportCount, r.unmatched, r.duplicates, r.hintsUsed, r.minutesSpent, r.submittedAt, a.appliedAt].map(esc).join(','));
    }
    res.type('text/csv; charset=utf-8');
    res.attachment(`sqa-candidates-${new Date().toISOString().slice(0, 10)}.csv`);
    res.send('﻿' + lines.join('\r\n'));
  });

  return router;
}
