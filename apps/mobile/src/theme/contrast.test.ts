import { describe, expect, it } from 'vitest';

import { contrastRatio } from './contrast';
import { themePalette } from './tokens';

const textPairs = [
  ['background', 'foreground'],
  ['card', 'cardForeground'],
  ['popover', 'popoverForeground'],
  ['primary', 'primaryForeground'],
  ['secondary', 'secondaryForeground'],
  ['muted', 'mutedForeground'],
  ['accent', 'accentForeground'],
  ['destructive', 'destructiveForeground'],
  ['input', 'foreground'],
  ['compass', 'compassForeground'],
  // Quiet ink (theme ink-3) is for placeholders and quiet captions on fields,
  // cards, the page and the tinted search pill; never on `muted`.
  ['input', 'quietForeground'],
  ['card', 'quietForeground'],
  ['background', 'quietForeground'],
  ['secondary', 'quietForeground'],
] as const;

const nonTextPairs = [
  ['border', 'background'],
  ['ring', 'background'],
] as const;

for (const [mode, tokens] of Object.entries(themePalette)) {
  describe(`${mode} semantic theme`, () => {
    for (const [background, foreground] of textPairs) {
      it(`${background}/${foreground} meets WCAG AA`, () => {
        expect(contrastRatio(tokens[background], tokens[foreground])).toBeGreaterThanOrEqual(4.5);
      });
    }

    for (const [foreground, background] of nonTextPairs) {
      it(`${foreground}/${background} remains distinguishable`, () => {
        expect(contrastRatio(tokens[foreground], tokens[background])).toBeGreaterThanOrEqual(3);
      });
    }
  });
}

// UX-UG-NATIVE-PALETTE-INKS-AND-SIX-CHART-COLOURS-20261117: the light
// form's two quieter inks are the theme's (promo package tokens.json color.ink-2
// and color.ink-3, README-AI.md rule 2): secondary text and labels take ink-2,
// placeholders and quiet captions take ink-3.
describe('the theme inks on Union Ground', () => {
  it('uses ink-2 for secondary text and ink-3 for placeholders', () => {
    expect(themePalette['union-ground'].mutedForeground).toBe('#46574F');
    expect(themePalette['union-ground'].quietForeground).toBe('#56665E');
  });

});
