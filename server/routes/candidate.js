import express from 'express';
import { HttpError, newToken, hashToken, newId, newReference, parseCookies, setCookie, rateLimit } from '../security.js';
import { isDuplicateKey } from '../db.js';
import { validateReport, validateApplication, EDUCATION_LEVELS } from '../validation.js';
import { makeUploader, handleUpload, checkEvidence, checkCv, storeFile, removeStored, ALLOWED, CV_MAX_BYTES, EVIDENCE_MAX_BYTES } from '../uploads.js';
import { sendStored } from '../storage.js';
import { getHiring, requireHiringOpen } from '../settings.js';
import { MODULES, SEVERITIES, PRIORITIES } from '../evaluation/answerKey.js';
import { HINTS } from '../evaluation/hints.js';
import { evaluate } from '../evaluation/scoring.js';

export const SESSION_COOKIE = 'sqa_session';
const SESSION_MAX_AGE = 14 * 24 * 3600;
const MAX_REPORTS = 40;
const NO_EVIDENCE = { key: null, name: null, mime: null };

/** Attaches req.candidate (session document) if the cookie maps to a session. */
export function loadCandidate(col) {
  return async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      // Trashed candidates are treated as signed out; they reappear if an admin restores them.
      req.candidate = token ? await col.sessions.findOne({ tokenHash: hashToken(token), deletedAt: null }) : null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireCandidate(req, res, next) {
  if (!req.candidate) return next(new HttpError(401, 'Your challenge session was not found. Start the challenge from the hiring page.'));
  next();
}

function requireInProgress(req, res, next) {
  if (req.candidate.status !== 'in_progress') return next(new HttpError(409, 'The challenge has already been submitted. Reports can no longer be changed.'));
  next();
}

/** Shape expected by the scoring engine. */
export const forScoring = (r) => ({ ...r, id: r._id, admin_verdict: r.adminVerdict });

const publicReport = (r) => ({
  id: r._id,
  title: r.title,
  module: r.module,
  steps: r.steps,
  expected: r.expected,
  actual: r.actual,
  severity: r.severity,
  priority: r.priority,
  evidence: r.evidence?.key ? { name: r.evidence.name, url: `/api/reports/${r._id}/evidence` } : null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const OPTIONS = { modules: MODULES, severities: [...SEVERITIES].reverse(), priorities: [...PRIORITIES].reverse(), educationLevels: EDUCATION_LEVELS };

export function candidateRouter({ col, storage, secureCookies, limits }) {
  const router = express.Router();
  const evidenceUpload = handleUpload(makeUploader(EVIDENCE_MAX_BYTES).single('evidence'), 'Evidence image', EVIDENCE_MAX_BYTES);
  const cvUpload = handleUpload(makeUploader(CV_MAX_BYTES).single('cv'), 'CV', CV_MAX_BYTES);

  const hiringOpen = requireHiringOpen(col);
  const publicHiring = async () => {
    const h = await getHiring(col);
    return { open: h.open, message: h.message };
  };

  const listReports = (sessionId) => col.reports.find({ sessionId }).sort({ createdAt: 1, _id: 1 }).toArray();
  const findReport = (id, sessionId) => col.reports.findOne({ _id: String(id), sessionId });

  async function sessionPayload(s) {
    const app = await col.applications.findOne({ sessionId: s._id }, { projection: { createdAt: 1 } });
    return {
      reference: s._id,
      status: s.status,
      startedAt: s.startedAt,
      submittedAt: s.submittedAt,
      serverTime: new Date().toISOString(),
      hintsUsed: s.hintsUsed,
      hintsAvailable: HINTS.length,
      hints: HINTS.slice(0, s.hintsUsed),
      reports: (await listReports(s._id)).map(publicReport),
      application: app ? { submittedAt: app.createdAt } : null,
      hiring: await publicHiring(),
      options: OPTIONS,
    };
  }

  router.get('/session', async (req, res) => {
    if (!req.candidate) return res.json({ status: 'none', hiring: await publicHiring(), options: OPTIONS });
    res.json(await sessionPayload(req.candidate));
  });

  router.post('/session/start', rateLimit({ windowMs: 60 * 60 * 1000, max: limits.sessionStart }), async (req, res) => {
    if (req.candidate) return res.json(await sessionPayload(req.candidate));
    const hiring = await getHiring(col);
    if (!hiring.open) throw new HttpError(403, hiring.message, { hiring: 'closed' });
    if (req.body?.acceptedRules !== true) throw new HttpError(422, 'Please confirm that you have read the challenge rules.');
    const token = newToken();
    const session = {
      _id: newReference(),
      tokenHash: hashToken(token),
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      submittedAt: null,
      hintsUsed: 0,
      score: null,
      evaluation: null,
      createdIp: req.ip,
    };
    await col.sessions.insertOne(session);
    setCookie(res, SESSION_COOKIE, token, { maxAgeSeconds: SESSION_MAX_AGE, secure: secureCookies });
    res.status(201).json(await sessionPayload(session));
  });

  router.post('/hints', requireCandidate, requireInProgress, async (req, res) => {
    const updated = await col.sessions.findOneAndUpdate(
      { _id: req.candidate._id, status: 'in_progress', hintsUsed: { $lt: HINTS.length } },
      { $inc: { hintsUsed: 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new HttpError(409, 'All hints have already been used.');
    res.json({ hintsUsed: updated.hintsUsed, hints: HINTS.slice(0, updated.hintsUsed), hintsAvailable: HINTS.length });
  });

  router.post('/reports', requireCandidate, requireInProgress, evidenceUpload, async (req, res) => {
    const data = validateReport(req.body);
    if ((await col.reports.countDocuments({ sessionId: req.candidate._id })) >= MAX_REPORTS) {
      throw new HttpError(409, `You can submit at most ${MAX_REPORTS} reports. Merge or remove some reports first.`);
    }
    let evidence = NO_EVIDENCE;
    if (req.file) {
      const err = checkEvidence(req.file);
      if (err) throw new HttpError(422, err, { evidence: err });
      evidence = await storeFile(storage, `evidence/${req.candidate._id}`, req.file, ALLOWED.evidence);
    }
    const now = new Date().toISOString();
    const report = { _id: newId(), sessionId: req.candidate._id, ...data, evidence, adminVerdict: 'auto', createdAt: now, updatedAt: now };
    await col.reports.insertOne(report);
    res.status(201).json(publicReport(report));
  });

  router.put('/reports/:id', requireCandidate, requireInProgress, evidenceUpload, async (req, res) => {
    const existing = await findReport(req.params.id, req.candidate._id);
    if (!existing) throw new HttpError(404, 'Report not found.');
    const data = validateReport(req.body);
    let evidence = existing.evidence || NO_EVIDENCE;
    if (req.file) {
      const err = checkEvidence(req.file);
      if (err) throw new HttpError(422, err, { evidence: err });
      await removeStored(storage, evidence.key);
      evidence = await storeFile(storage, `evidence/${req.candidate._id}`, req.file, ALLOWED.evidence);
    } else if (req.body.removeEvidence === '1' || req.body.removeEvidence === true) {
      await removeStored(storage, evidence.key);
      evidence = NO_EVIDENCE;
    }
    const updated = await col.reports.findOneAndUpdate(
      { _id: existing._id, sessionId: req.candidate._id },
      { $set: { ...data, evidence, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    );
    res.json(publicReport(updated));
  });

  router.delete('/reports/:id', requireCandidate, requireInProgress, async (req, res) => {
    const existing = await findReport(req.params.id, req.candidate._id);
    if (!existing) throw new HttpError(404, 'Report not found.');
    await col.reports.deleteOne({ _id: existing._id });
    await removeStored(storage, existing.evidence?.key);
    res.status(204).end();
  });

  router.get('/reports/:id/evidence', requireCandidate, async (req, res) => {
    const r = await findReport(req.params.id, req.candidate._id);
    if (!r?.evidence?.key) throw new HttpError(404, 'No evidence attached.');
    res.type(r.evidence.mime);
    if (!(await sendStored(storage, r.evidence.key, res))) throw new HttpError(404, 'Evidence file is missing.');
  });

  router.post('/challenge/submit', requireCandidate, requireInProgress, hiringOpen, async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(422, 'Please confirm that you want to submit your findings.');
    const s = req.candidate;
    const reports = await listReports(s._id);
    if (reports.length === 0) throw new HttpError(422, 'Report at least one issue before submitting the challenge.');
    const evaluation = evaluate(reports.map(forScoring), s.hintsUsed);
    const submittedAt = new Date().toISOString();
    // Conditional update: only the first submit of an in-progress session wins.
    const result = await col.sessions.updateOne(
      { _id: s._id, status: 'in_progress' },
      { $set: { status: 'submitted', submittedAt, score: evaluation.score, evaluation } },
    );
    if (result.modifiedCount !== 1) throw new HttpError(409, 'The challenge has already been submitted.');
    res.json({ status: 'submitted', submittedAt, reportsSubmitted: reports.length });
  });

  router.post('/application', requireCandidate, rateLimit({ windowMs: 15 * 60 * 1000, max: limits.application }), hiringOpen, cvUpload, async (req, res) => {
    const s = req.candidate;
    if (s.status === 'in_progress') throw new HttpError(403, 'Complete and submit the testing challenge before applying.');
    if (s.status === 'applied') throw new HttpError(409, 'You have already submitted your application.');

    const { data, errors } = validateApplication(req.body);
    const cvError = checkCv(req.file);
    if (cvError) errors.cv = cvError;
    if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields.', errors);

    const emailTaken = { email: 'An application with this email address already exists.' };
    if (await col.applications.findOne({ email: data.email }, { projection: { _id: 1 } })) {
      throw new HttpError(409, emailTaken.email, emailTaken);
    }

    const cv = await storeFile(storage, `cv/${s._id}`, req.file, ALLOWED.cv);
    const now = new Date().toISOString();
    try {
      // Unique indexes on sessionId and email make this insert the single source of truth.
      await col.applications.insertOne({
        _id: newId(),
        sessionId: s._id,
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        institution: data.institution,
        educationLevel: data.educationLevel,
        experience: data.experience,
        profileUrl: data.profileUrl,
        whySqa: data.whySqa,
        cv,
        status: 'under_review',
        adminNotes: '',
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      await removeStored(storage, cv.key);
      if (isDuplicateKey(err)) {
        if (err.keyPattern?.email) throw new HttpError(409, emailTaken.email, emailTaken);
        throw new HttpError(409, 'You have already submitted your application.');
      }
      throw err;
    }
    await col.sessions.updateOne({ _id: s._id, status: 'submitted' }, { $set: { status: 'applied' } });
    res.status(201).json({ reference: s._id, submittedAt: now, name: data.fullName, email: data.email });
  });

  return router;
}
