import { describe, expect, it } from 'vitest';

import {
  CHART_PALETTE_TOKENS,
  checkChartPalette,
  chartOtherColor,
  chartPalette,
  contrast,
  deltaE,
  oklch,
} from './chartPalette';
import { statusRamp } from './statusRamp';
import { darkPaletteKey, resolveTheme, themeAppearance, themePalette, type PaletteKey } from './tokens';

// BUG-UG-NATIVE-CHART-RAMP-DARK-SEPARATION-20261031: chart series
// come from the validated palette, never from the status ramp, on every
// theme's card and page in both modes.
// UX-UG-NATIVE-PALETTE-INKS-AND-SIX-CHART-COLOURS-20261117: the light
// form carries the theme's six series and its "other" colour (promo package
// tokens.json `series`, `seriesOther`); the dark form keeps the theme's three
// dark series (`seriesDark`), the only dark series the theme gives.
const TRIO = ['#137C54', '#1473E6', '#8A5A00'];
const LIGHT = [...TRIO, '#7D3FB5', '#C25B3A', '#0086A3'];
const LIGHT_OTHER = '#7D7A74';
const DARK = ['#199E70', '#3987E5', '#C98500'];

const paletteKeys = Object.keys(themePalette) as PaletteKey[];

describe('the chart palette', () => {
  it('is the theme\'s six series on Union Ground and its three dark series on the dark form', () => {
    expect(chartPalette(resolveTheme('union-ground'))).toEqual(LIGHT);
    expect(chartOtherColor(resolveTheme('union-ground'))).toBe(LIGHT_OTHER);
    expect(chartPalette(resolveTheme('union-ground', true))).toEqual(DARK);
    expect(chartOtherColor(resolveTheme('union-ground', true))).toBeUndefined();
    for (const key of paletteKeys) {
      const tokens: Partial<Record<string, string>> = themePalette[key];
      const expected = themeAppearance(key) === 'dark' ? [...DARK, undefined, undefined, undefined] : LIGHT;
      expect(CHART_PALETTE_TOKENS.map((token) => tokens[token]), key).toEqual(expected);
    }
  });

  it('passes the palette validator on every card and page surface, in both modes', () => {
    const surfaces = [
      ...paletteKeys.map((key) => ({ name: key, appearance: themeAppearance(key), tokens: themePalette[key] })),
    ];
    for (const { name, appearance, tokens } of surfaces) {
      const series = chartPalette({ ...tokens, appearance });
      for (const surface of [tokens.card, tokens.background, ...(appearance === 'light' ? ['#FBFAF6'] : [])]) {
        const check = checkChartPalette(series, appearance, surface);
        expect(check, `${name} on ${surface}`).toMatchObject({
          lightness: true,
          chroma: true,
          normalVision: { pass: true },
          cvd: { pass: true, target: true },
          contrast: { pass: true },
          pass: true,
        });
      }
    }
  });

  it('measures the trio as the write-up records it', () => {
    const light = checkChartPalette(TRIO, 'light', '#FFFFFF');
    const six = checkChartPalette(LIGHT, 'light', '#FFFFFF');
    expect(six.normalVision.worst).toBeCloseTo(23.7, 1);
    expect(six.cvd.worst).toBeCloseTo(15.2, 1);
    expect(six.contrast.worst).toBeCloseTo(4.25, 2);
    expect(contrast(LIGHT_OTHER, '#FFFFFF')).toBeGreaterThanOrEqual(3);
    expect(contrast(LIGHT_OTHER, themePalette['union-ground'].background)).toBeGreaterThanOrEqual(3);
    const dark = checkChartPalette(DARK, 'dark', themePalette[darkPaletteKey].card);
    expect(light.normalVision.worst).toBeCloseTo(23.7, 1);
    expect(light.cvd.worst).toBeCloseTo(22.8, 1);
    expect(dark.normalVision.worst).toBeCloseTo(20.9, 1);
    expect(dark.cvd.worst).toBeCloseTo(19.6, 1);
    expect(light.contrast.worst).toBeGreaterThanOrEqual(4.5);
    expect(dark.contrast.worst).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the status ramp out of series: it fails the same checks it was retired for', () => {
    const night = resolveTheme('union-ground', true);
    const ramp = statusRamp(night);
    // Done against queued, normal vision, dark: the record measured 13.8 on the
    // retired Night Shift ramp; Union Ground's dark form measures 10.7, still
    // under the floor of 15.
    expect(deltaE(ramp.done, ramp.queued)).toBeCloseTo(10.7, 1);
    expect(checkChartPalette([ramp.done, ramp.queued, ramp.active, ramp.attention], 'dark', night.card).normalVision.pass).toBe(false);
    const green = resolveTheme('union-ground');
    const lightRamp = statusRamp(green);
    const lightCheck = checkChartPalette([lightRamp.done, lightRamp.queued, lightRamp.active, lightRamp.attention], 'light', green.card);
    expect(lightCheck.lightness).toBe(false);
    expect(lightCheck.chroma).toBe(false);
    expect(lightCheck.pass).toBe(false);
  });

  it('computes its helpers from the hex value, with or without the hash', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(oklch('#FFFFFF').lightness).toBeCloseTo(1, 3);
    expect(oklch('#808080').chroma).toBeLessThan(0.001);
    expect(deltaE('#137C54', '#137C54')).toBe(0);
    expect(deltaE('#137C54', '#1473E6', 'protan')).toBeGreaterThan(0);
  });

  it('answers a single series with no pair to separate, and fails a surface it cannot clear', () => {
    const single = checkChartPalette(['#137C54'], 'light', '#FFFFFF');
    expect(single.normalVision.worst).toBe(Number.POSITIVE_INFINITY);
    expect(single.pass).toBe(true);
    const onInk = checkChartPalette(LIGHT, 'light', '#137C54');
    expect(onInk.contrast.pass).toBe(false);
    expect(onInk.pass).toBe(false);
    const sameHue = checkChartPalette(['#137C54', '#147D55'], 'light', '#FFFFFF');
    expect(sameHue.cvd).toMatchObject({ pass: false, target: false });
  });
});
