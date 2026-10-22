/**
 * Hints are revealed one at a time and each one reduces the final score
 * (see SCORING.hintPenalty). They nudge testing technique without naming
 * specific bugs or their locations.
 */
export const HINTS = [
  'Limits deserve attention. Whenever the app states a rule (a minimum, a maximum, a threshold), test the value exactly on the limit, one below it and one above it.',
  "Don't trust success messages. After saving or changing something, navigate away or reload and confirm the change really stuck.",
  'Vary how you interact: repeat the same action, do it quickly twice, do it with nothing selected, or try it on a narrow (mobile) screen. Compare similar features in different places of the app.',
];
