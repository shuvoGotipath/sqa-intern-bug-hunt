import { MODULES, SEVERITIES, PRIORITIES } from './evaluation/answerKey.js';
import { HttpError } from './security.js';

export const EDUCATION_LEVELS = [
  'Higher Secondary (HSC / A-Level)',
  'Diploma',
  "Bachelor's (in progress)",
  "Bachelor's (completed)",
  "Master's (in progress)",
  "Master's (completed)",
  'Other',
];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function lengthRule(errors, field, label, value, min, max) {
  if (!value) errors[field] = `${label} is required.`;
  else if (value.length < min) errors[field] = `${label} must be at least ${min} characters.`;
  else if (value.length > max) errors[field] = `${label} must be at most ${max} characters.`;
}

export function validateReport(body) {
  const data = {
    title: str(body.title),
    module: str(body.module),
    steps: str(body.steps),
    expected: str(body.expected),
    actual: str(body.actual),
    severity: str(body.severity),
    priority: str(body.priority),
  };
  const errors = {};
  lengthRule(errors, 'title', 'Bug title', data.title, 5, 120);
  if (!MODULES.includes(data.module)) errors.module = 'Choose the affected module.';
  lengthRule(errors, 'steps', 'Steps to reproduce', data.steps, 10, 3000);
  lengthRule(errors, 'expected', 'Expected result', data.expected, 5, 1500);
  lengthRule(errors, 'actual', 'Actual result', data.actual, 5, 1500);
  if (!SEVERITIES.includes(data.severity)) errors.severity = 'Choose a severity: Critical, High, Medium or Low.';
  if (!PRIORITIES.includes(data.priority)) errors.priority = 'Choose a priority: P1, P2, P3 or P4.';
  if (Object.keys(errors).length) throw new HttpError(422, 'Please fix the highlighted fields.', errors);
  return data;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^\+?[0-9][0-9\s-]{6,18}[0-9]$/;
const NAME_RE = /^[\p{L}][\p{L}\s.'-]*$/u;

export function validateApplication(body) {
  const data = {
    fullName: str(body.fullName).replace(/\s+/g, ' '),
    email: str(body.email).toLowerCase(),
    phone: str(body.phone),
    institution: str(body.institution),
    educationLevel: str(body.educationLevel),
    experience: str(body.experience),
    profileUrl: str(body.profileUrl),
    whySqa: str(body.whySqa),
  };
  const errors = {};

  lengthRule(errors, 'fullName', 'Full name', data.fullName, 2, 100);
  if (!errors.fullName && !NAME_RE.test(data.fullName)) errors.fullName = 'Full name can only contain letters, spaces, dots, apostrophes and hyphens.';

  if (!data.email) errors.email = 'Email address is required.';
  else if (data.email.length > 254 || !EMAIL_RE.test(data.email)) errors.email = 'Enter a valid email address, e.g. name@example.com.';

  const digits = data.phone.replace(/\D/g, '');
  if (!data.phone) errors.phone = 'Phone number is required.';
  else if (!PHONE_RE.test(data.phone) || digits.length < 7 || digits.length > 15) errors.phone = 'Enter a valid phone number (7–15 digits, optional leading +).';

  lengthRule(errors, 'institution', 'University or institution', data.institution, 2, 150);
  if (!EDUCATION_LEVELS.includes(data.educationLevel)) errors.educationLevel = 'Select your current education level.';

  if (data.experience.length > 2000) errors.experience = 'Relevant experience must be at most 2000 characters.';

  if (data.profileUrl) {
    let ok = false;
    try {
      const u = new URL(data.profileUrl);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
    } catch {}
    if (!ok || data.profileUrl.length > 300) errors.profileUrl = 'Enter a full URL starting with https://, or leave it blank.';
  }

  lengthRule(errors, 'whySqa', 'This answer', data.whySqa, 50, 1500);

  return { data, errors };
}
