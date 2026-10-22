import { BUGS, BUG_BY_ID, DIFFICULTY_POINTS, SCORING, SEVERITIES, PRIORITIES } from './answerKey.js';

const VAGUE = /^(it\s+)?(should\s+)?(be\s+)?(work(s|ing)?|not\s+work(ing)?|doesn'?t\s+work|does\s+not\s+work|broken|bug|error|fail(s|ed)?|wrong|ok(ay)?|fine|correct|n\/?a|none|nothing|-+|\.+|idk|same)\.?$/i;

const round = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export const bugPoints = (bug) => DIFFICULTY_POINTS[bug.difficulty];

export function maxScore() {
  return BUGS.reduce((sum, b) => sum + bugPoints(b) + (b.edgeCase ? SCORING.edgeCaseBonus : 0), 0);
}

function reportText(r) {
  return norm([r.title, r.steps, r.expected, r.actual].join(' \n '));
}

/** Returns the best matching bug for a report, or null. */
export function matchBug(report) {
  const text = reportText(report);
  const candidates = [];
  for (const bug of BUGS) {
    if (bug.exclude?.some((re) => re.test(text))) continue;
    if (!bug.match.every((group) => group.some((re) => re.test(text)))) continue;
    const hits = bug.match.flat().filter((re) => re.test(text)).length;
    candidates.push({ bug, sameModule: bug.module === report.module ? 1 : 0, groups: bug.match.length, hits });
  }
  candidates.sort((a, b) => b.sameModule - a.sameModule || b.groups - a.groups || b.hits - a.hits);
  return candidates[0]?.bug ?? null;
}

function countSteps(steps) {
  return String(steps || '')
    .split(/\r?\n|(?=\b\d+[.)]\s)|;|→|->/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3).length;
}

/** Clarity of reproduction steps, 0..1 */
export function reproducibilityScore(steps) {
  const text = String(steps || '').trim();
  const n = countSteps(text);
  if (text.length < 10 || VAGUE.test(text)) return 0;
  if (n >= 2 && text.length >= 40) return 1;
  if (text.length >= 25) return 0.6;
  return 0.3;
}

function fieldQuality(value) {
  const t = String(value || '').trim();
  if (!t || VAGUE.test(t)) return 0;
  if (t.length >= 20) return 0.5;
  if (t.length >= 8) return 0.25;
  return 0;
}

/** Quality of expected vs actual result, 0..1 */
export function expectedActualScore(expected, actual) {
  if (norm(expected) === norm(actual)) return 0;
  return fieldQuality(expected) + fieldQuality(actual);
}

function rankAccuracy(list, given, expected) {
  const d = Math.abs(list.indexOf(given) - list.indexOf(expected));
  if (list.indexOf(given) < 0) return 0;
  return d === 0 ? 1 : d === 1 ? 0.5 : 0;
}

function scoreAgainstBug(report, bug, basePoints) {
  const w = SCORING.weights;
  const moduleOk = bug ? bug.module === report.module : true;
  const c = {
    identification: moduleOk ? 1 : SCORING.wrongModuleFactor,
    reproducibility: reproducibilityScore(report.steps),
    expectedVsActual: expectedActualScore(report.expected, report.actual),
    severity: bug ? rankAccuracy(SEVERITIES, report.severity, bug.severity) : 1,
    priority: bug ? rankAccuracy(PRIORITIES, report.priority, bug.priority) : 1,
  };
  const parts = {};
  for (const key of Object.keys(w)) parts[key] = basePoints * w[key] * c[key];
  let edge = 0;
  if (bug?.edgeCase) edge = SCORING.edgeCaseBonus * (c.reproducibility >= 0.6 ? 1 : 0.5);
  const notes = [];
  if (!moduleOk) notes.push(`Module reported as "${report.module}", expected "${bug.module}".`);
  if (c.reproducibility < 1) notes.push('Reproduction steps are thin or not broken into clear steps.');
  if (c.expectedVsActual < 1) notes.push('Expected/actual results are short, vague or identical.');
  if (bug && c.severity < 1) notes.push(`Severity "${report.severity}" (key: ${bug.severity}).`);
  if (bug && c.priority < 1) notes.push(`Priority "${report.priority}" (key: ${bug.priority}).`);
  return { components: c, parts, edge, notes, points: Object.values(parts).reduce((a, b) => a + b, 0) + edge };
}

/**
 * Evaluates a candidate's reports.
 * @param {Array} reports rows with title, module, steps, expected, actual, severity, priority, admin_verdict, id
 * @param {number} hintsUsed
 */
export function evaluate(reports, hintsUsed = 0) {
  const results = reports.map((r) => {
    const verdict = r.admin_verdict || 'auto';
    if (verdict === 'invalid') {
      return { reportId: r.id, title: r.title, bugId: null, status: 'invalid', matchedBy: 'admin', points: 0, notes: ['Marked invalid by reviewer.'] };
    }
    if (verdict === 'extra') {
      const s = scoreAgainstBug(r, null, DIFFICULTY_POINTS.easy);
      return { reportId: r.id, title: r.title, bugId: null, status: 'extra', matchedBy: 'admin', ...s, notes: ['Valid issue outside the answer key (bonus).', ...s.notes] };
    }
    let bug = null;
    let matchedBy = 'auto';
    if (verdict.startsWith('bug:') && BUG_BY_ID[verdict.slice(4)]) {
      bug = BUG_BY_ID[verdict.slice(4)];
      matchedBy = 'admin';
    } else {
      bug = matchBug(r);
    }
    if (!bug) {
      return { reportId: r.id, title: r.title, bugId: null, status: 'unmatched', matchedBy, points: 0, notes: ['No known issue matched automatically — please review manually.'] };
    }
    return { reportId: r.id, title: r.title, bugId: bug.id, status: 'matched', matchedBy, ...scoreAgainstBug(r, bug, bugPoints(bug)) };
  });

  // Duplicates: keep the best-quality report per bug; the rest earn nothing.
  const bestByBug = new Map();
  for (const res of results) {
    if (res.status !== 'matched') continue;
    const prev = bestByBug.get(res.bugId);
    if (!prev || res.points > prev.points) bestByBug.set(res.bugId, res);
  }
  for (const res of results) {
    if (res.status === 'matched' && bestByBug.get(res.bugId) !== res) {
      res.status = 'duplicate';
      res.points = SCORING.duplicatePenalty;
      res.notes = [`Duplicate of another report for ${res.bugId}.`];
      delete res.parts;
      res.edge = 0;
    }
  }

  const breakdown = { identification: 0, reproducibility: 0, expectedVsActual: 0, severity: 0, priority: 0, edgeCases: 0, extraFindings: 0 };
  for (const res of results) {
    if (res.status === 'matched') {
      for (const k of Object.keys(res.parts)) breakdown[k] += res.parts[k];
      breakdown.edgeCases += res.edge;
    } else if (res.status === 'extra') {
      breakdown.extraFindings += res.points;
    }
  }

  const unmatched = results.filter((r) => r.status === 'unmatched' || r.status === 'invalid').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const falsePositivePenalty = Math.min(unmatched * SCORING.falsePositivePenalty, SCORING.falsePositivePenaltyCap);
  const hintPenalty = hintsUsed * SCORING.hintPenalty;

  const earned = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const raw = Math.max(0, earned - falsePositivePenalty - hintPenalty);
  const max = maxScore();
  const score = Math.min(100, (raw / max) * 100);

  for (const k of Object.keys(breakdown)) breakdown[k] = round(breakdown[k]);
  for (const res of results) {
    res.points = round(res.points);
    if (res.parts) for (const k of Object.keys(res.parts)) res.parts[k] = round(res.parts[k]);
  }

  return {
    score: round(score),
    rawPoints: round(raw),
    maxPoints: max,
    breakdown: { ...breakdown, falsePositivePenalty: -falsePositivePenalty, hintPenalty: -hintPenalty },
    foundBugIds: [...bestByBug.keys()],
    bugsFound: bestByBug.size,
    totalBugs: BUGS.length,
    edgeCasesFound: [...bestByBug.keys()].filter((id) => BUG_BY_ID[id].edgeCase).length,
    unmatched,
    duplicates,
    hintsUsed,
    reports: results,
    evaluatedAt: new Date().toISOString(),
  };
}
