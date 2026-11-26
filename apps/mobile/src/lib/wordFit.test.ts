// BUG-UG-NATIVE-LARGEST-TEXT-BREAKS-AND-CLIPS-WORDS-20261103: at the
// largest text size and the narrowest width, What matters titles and guide
// bullets grow only as far as their longest word still fits its line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { textOfChildren, wordFitMultiplier } from './wordFit';

const LARGEST = 3.12;
// What matters card at 320 pt: the screen's 16 pt inset, the card's 16 pt
// padding and its 4 pt accent edge.
const VOTE_LINE = 320 - 16 * 2 - 16 * 2 - 4;
// A staff guide bullet at 320 pt: the Work drawer's 76% width, its 16 pt
// inset, the card's 16 pt padding, the guide's 1 pt border and 12 pt body inset.
const STAFF_BULLET_LINE = Math.floor(320 * 0.76) - 16 * 2 - 16 * 2 - 2 - 12 * 2;
const drawnScale = (cap: number | undefined) => Math.min(LARGEST, cap ?? LARGEST);

describe('word fit at the largest text size', () => {
  it('keeps "membership" whole in the open vote title at 320 pt', () => {
    const title = 'When should general membership meetings start?';
    const scale = drawnScale(wordFitMultiplier(title, 17, VOTE_LINE));
    expect(scale).toBeLessThan(LARGEST);
    // SF Pro Bold sets "membership" at about 5.9 em.
    expect(5.9 * 17 * scale).toBeLessThanOrEqual(VOTE_LINE);
    // Unfitted, the word was wider than its line: the reported break.
    expect(5.9 * 17 * LARGEST).toBeGreaterThan(VOTE_LINE);
  });

  it('keeps every word of a staff guide bullet whole at 320 pt', () => {
    const bullet = '• Take worker requests and reply to them.';
    const scale = drawnScale(wordFitMultiplier(bullet, 16, STAFF_BULLET_LINE));
    expect(scale).toBeGreaterThan(1);
    // "requests" is the longest word, about 4.6 em in SF Pro Regular.
    expect(4.6 * 16 * scale).toBeLessThanOrEqual(STAFF_BULLET_LINE);
    expect(4.6 * 16 * LARGEST).toBeGreaterThan(STAFF_BULLET_LINE);
  });

  it('leaves a size that already fits alone and never shrinks below the default', () => {
    expect(drawnScale(wordFitMultiplier('Vote now', 17, 1000))).toBe(LARGEST);
    expect(wordFitMultiplier('Supercalifragilisticexpialidocious', 17, 120)).toBe(1);
  });

  it('waits for a measured line and words to fit', () => {
    expect(wordFitMultiplier('membership', 17, 0)).toBeUndefined();
    expect(wordFitMultiplier('', 17, 252)).toBeUndefined();
    expect(wordFitMultiplier('membership', 0, 252)).toBeUndefined();
  });

  it('reads the words of a Text child', () => {
    expect(textOfChildren('• Take worker requests')).toBe('• Take worker requests');
    expect(textOfChildren(['Closes ', 3, ' days'])).toBe('Closes 3 days');
    expect(textOfChildren({ type: 'Icon' })).toBe('');
    expect(textOfChildren(null)).toBe('');
  });

  it('opts What matters titles and both guides\' bullets in, through Body and Heading', () => {
    const read = (path: string) => readFileSync(join(__dirname, path), 'utf8');
    const ui = read('../components/ui.tsx');
    // A heading fits with Archivo's allowance (#8928).
    expect(ui).toContain("const fit = useWordFit(fitWords, children, styles[`heading${level}`], 'heading');");
    expect(ui).toContain('const fit = useWordFit(fitWords, children, styles.body);');
    expect(ui.match(/onLayout=\{fit\.onLayout\}\n\s+allowFontScaling=\{fit\.allowFontScaling\}/g)).toHaveLength(2);
    // The fitted sizes come last, after any caller style.
    expect(ui).toContain("style={[styles[`heading${level}`], { color: theme.foreground }, fit.style]}");
    expect(ui).toContain('style={[styles.body, { color: muted ? theme.mutedForeground : theme.foreground }, style, fit.style]}');
    expect(read('../features/home/WhatMattersNow.tsx')).toContain('<Heading level={3} fitWords>{copy.line}</Heading>');
    for (const guide of ['../features/guideLayers/GuideLayers.tsx', '../features/guideLayers/StaffGuides.tsx']) {
      expect(read(guide)).toContain('{lines.map((line) => <Body key={line} fitWords>{`• ${line}`}</Body>)}');
    }
  });
});
