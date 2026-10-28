import { HttpError } from './security.js';

export const DEFAULT_CLOSED_MESSAGE = 'Applications for the SQA Intern role are currently closed. Please check back later.';
export const MAX_CLOSED_MESSAGE = 300;

/** Hiring status. Applications are open unless an admin has closed them. */
export async function getHiring(col) {
  const doc = await col.settings.findOne({ _id: 'hiring' });
  const open = doc?.applicationsOpen !== false;
  return {
    open,
    message: open ? '' : doc?.closedMessage || DEFAULT_CLOSED_MESSAGE,
    customMessage: doc?.closedMessage || '',
    updatedAt: doc?.updatedAt || null,
  };
}

export async function setHiring(col, { applicationsOpen, closedMessage }) {
  const $set = { updatedAt: new Date().toISOString() };
  if (applicationsOpen !== undefined) {
    if (typeof applicationsOpen !== 'boolean') throw new HttpError(422, 'applicationsOpen must be true or false.');
    $set.applicationsOpen = applicationsOpen;
  }
  if (closedMessage !== undefined) {
    if (typeof closedMessage !== 'string' || closedMessage.trim().length > MAX_CLOSED_MESSAGE) {
      throw new HttpError(422, `The message for candidates must be at most ${MAX_CLOSED_MESSAGE} characters.`);
    }
    $set.closedMessage = closedMessage.trim();
  }
  await col.settings.updateOne({ _id: 'hiring' }, { $set }, { upsert: true });
  return getHiring(col);
}

/** Middleware: refuse the request while applications are closed. */
export function requireHiringOpen(col) {
  return async (req, res, next) => {
    try {
      const hiring = await getHiring(col);
      if (!hiring.open) return next(new HttpError(403, hiring.message, { hiring: 'closed' }));
      next();
    } catch (err) {
      next(err);
    }
  };
}
