import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './security.js';

export const CV_MAX_BYTES = 5 * 1024 * 1024;
export const EVIDENCE_MAX_BYTES = 3 * 1024 * 1024;

/** File types are verified by their leading bytes, not by the client-provided name or MIME type. */
const SIGNATURES = {
  pdf: { mime: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
    test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  },
  doc: { mime: 'application/msword', ext: '.doc', test: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  png: { mime: 'image/png', ext: '.png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { mime: 'image/gif', ext: '.gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  webp: { mime: 'image/webp', ext: '.webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

const CV_TYPES = { '.pdf': 'pdf', '.docx': 'docx', '.doc': 'doc' };
const IMAGE_TYPES = ['png', 'jpg', 'gif', 'webp'];

function sniff(buffer, allowed) {
  return allowed.map((k) => SIGNATURES[k]).find((s) => s.test(buffer)) || null;
}

export function makeUploader(maxBytes) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 20, fieldSize: 20_000 } });
}

/** Wraps a multer middleware so its errors become friendly HttpErrors. */
export function handleUpload(middleware, label, maxBytes) {
  return (req, res, next) =>
    middleware(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `${label} must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`, { [err.field || 'file']: `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.` }));
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(new HttpError(400, 'Unexpected file field.'));
      next(new HttpError(400, 'Upload failed. Please try again.'));
    });
}

export function checkCv(file) {
  if (!file) return 'Please upload your CV (PDF, DOC or DOCX, max 5 MB).';
  const ext = path.extname(file.originalname || '').toLowerCase();
  const expected = CV_TYPES[ext];
  const sig = sniff(file.buffer, ['pdf', 'docx', 'doc']);
  if (!expected || !sig || SIGNATURES[expected] !== sig) return 'CV must be a real PDF, DOC or DOCX file.';
  return null;
}

export function checkEvidence(file) {
  const sig = sniff(file.buffer, IMAGE_TYPES);
  if (!sig) return 'Evidence must be an image (PNG, JPG, GIF or WebP), max 3 MB.';
  return null;
}

/** Saves an uploaded file under a random key and returns its metadata. */
export async function storeFile(storage, prefix, file, allowed) {
  const sig = sniff(file.buffer, allowed);
  const key = `${prefix}/${crypto.randomBytes(16).toString('hex')}${sig.ext}`;
  await storage.put(key, file.buffer, sig.mime);
  const name = String(file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return { key, name, mime: sig.mime };
}

export async function removeStored(storage, key) {
  if (!key) return;
  try {
    await storage.delete(key);
  } catch {}
}

export const ALLOWED = { cv: ['pdf', 'docx', 'doc'], evidence: IMAGE_TYPES };
