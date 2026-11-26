// BUG-UG-NATIVE-LARGEST-TEXT-BREAKS-AND-CLIPS-WORDS-20261103: at the
// largest iPhone text size one word can be wider than its line, and iOS then
// breaks it between letters ("membershi / p", "reply to t / hem."), which
// also left a staff-guide bullet's last line undrawn. A text that opts in
// grows with the system size only as far as its longest word still fits the
// line it was laid out in.

import { longestWordLength } from './homeSummaryLayout';

// A generous average advance a letter, in ems, for each face a fitted text
// draws in (UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115).
// The single 0.65 was set for SF Pro Bold ("membership" about 5.9 em, under
// 10 x 0.65), above the semibold 0.6 in homeSummaryLayout.ts.
// - body: Public Sans, whose widest weight measures at most 0.603 em a letter
//   on the app's long words, so 0.65 keeps its margin.
// - heading: Archivo ExtraBold, where "membership" measures 6.28 em and
//   "messages" 0.645 em a letter, so 0.7 keeps the same margin.
// - caps: an all-capitals label in Public Sans Bold with its letter spacing,
//   where "ANNOUNCEMENT" measures 0.738 em a letter plus about 0.07 of
//   spacing, so 0.85.
// src/theme/typography.test.ts measures the embedded fonts against them.
export type WordFitFace = 'body' | 'heading' | 'caps';
export const WORD_FIT_GLYPH_EM: Readonly<Record<WordFitFace, number>> = { body: 0.65, heading: 0.7, caps: 0.85 };

// The largest font-size multiplier at which the longest word in `text` fits a
// line `lineWidth` points wide, never below the unscaled size. Undefined until
// the line has been measured, which leaves the system size alone.
export function wordFitMultiplier(text: string, fontSize: number, lineWidth: number, face: WordFitFace = 'body'): number | undefined {
  const longest = longestWordLength([text]);
  if (longest === 0 || !(lineWidth > 0) || !(fontSize > 0)) return undefined;
  return Math.max(1, lineWidth / (longest * fontSize * WORD_FIT_GLYPH_EM[face]));
}

// The words a Text child holds, for the fit: strings and numbers only.
export function textOfChildren(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOfChildren).join('');
  return '';
}
