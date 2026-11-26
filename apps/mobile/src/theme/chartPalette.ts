import type { ThemeAppearance, ThemeTokens } from './tokens';

// The chart series palette (BUG-UG-NATIVE-CHART-RAMP-DARK-SEPARATION-20261031,
// the Pulse design write-up's "One trio everywhere"). A bar, line, ring or
// area series takes its hue from this trio, in this fixed order; the status
// ramp (statusRamp.ts) colors states only: a state chip, a row dot, a badge.
// The ramp failed as a series: in dark mode done against queued measured
// ΔE 13.8 under normal vision (floor 15), and in light mode its steps fall
// outside the lightness band and under the chroma floor.
//
// Six series, the theme's (promo package tokens.json `series`, README-AI.md
// rule 7; UX-UG-NATIVE-PALETTE-INKS-AND-SIX-CHART-COLOURS-20261117):
// Union Ground uses #137C54 #1473E6 #8A5A00 #7D3FB5 #C25B3A #0086A3, in that
// fixed order, and #7D7A74 (`seriesOther`) for a remainder bucket. Union
// green's dark form keeps the theme's three dark series, #199E70 #3987E5
// #C98500 (`seriesDark`): the theme gives no dark series 4 to 6, and the app
// never renders its dark form. The values live in palette.json as
// chartSeries1-6 and chartSeriesOther, and the checks below are the palette
// validator's six-check rules, run on every theme's card and page in
// chartPalette.test.ts.
export const CHART_PALETTE_TOKENS = ['chartSeries1', 'chartSeries2', 'chartSeries3', 'chartSeries4', 'chartSeries5', 'chartSeries6'] as const satisfies readonly (keyof ThemeTokens)[];

export type ChartPalette = readonly [string, string, string, ...string[]];

/** The series hues for the active theme, in their fixed order: six in light, three in the dormant dark form. */
export function chartPalette(theme: ThemeTokens): ChartPalette {
  const series: [string, string, string, ...string[]] = [theme.chartSeries1, theme.chartSeries2, theme.chartSeries3];
  for (const hue of [theme.chartSeries4, theme.chartSeries5, theme.chartSeries6]) if (hue) series.push(hue);
  return series;
}

/** The theme's colour for an "other" bucket after the named series, when the theme has one. */
export function chartOtherColor(theme: ThemeTokens): string | undefined {
  return theme.chartSeriesOther;
}

// The validator's thresholds: OKLCH lightness band per mode, chroma floor,
// OKLab ΔE×100 floors for adjacent pairs (normal vision is a hard floor,
// colour-vision deficiency has a 6-8 band legal only with a second channel),
// and the 3:1 non-text contrast floor against the surface.
export const CHART_LIGHTNESS_BAND: Record<ThemeAppearance, readonly [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };
export const CHART_CHROMA_FLOOR = 0.1;
export const CHART_NORMAL_VISION_FLOOR = 15;
export const CHART_CVD_FLOOR = 6;
export const CHART_CVD_TARGET = 8;
export const CHART_SURFACE_CONTRAST = 3;

type Vector = readonly [number, number, number];

// Machado, Oliveira and Fernandes (2009) dichromat transforms, severity 1, linear RGB.
const CVD: Record<'protan' | 'deutan', readonly Vector[]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};

function linear(hex: string): Vector {
  const clean = hex.replace(/^#/, '');
  const channel = (offset: number) => {
    const value = Number.parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return [channel(0), channel(2), channel(4)];
}

function oklab([r, g, b]: Vector): Vector {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function simulate(hex: string, kind: keyof typeof CVD): Vector {
  const [r, g, b] = linear(hex);
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const matrix = CVD[kind];
  const row = (index: number) => clamp(matrix[index]![0] * r + matrix[index]![1] * g + matrix[index]![2] * b);
  return [row(0), row(1), row(2)];
}

/** OKLab lightness and chroma of a hex color. */
export function oklch(hex: string): { lightness: number; chroma: number } {
  const [lightness, a, b] = oklab(linear(hex));
  return { lightness, chroma: Math.hypot(a, b) };
}

/** OKLab distance ×100 between two colors, under normal vision or a simulated dichromacy. */
export function deltaE(first: string, second: string, kind?: keyof typeof CVD): number {
  const a = oklab(kind ? simulate(first, kind) : linear(first));
  const b = oklab(kind ? simulate(second, kind) : linear(second));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colors. */
export function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

export type ChartPaletteCheck = {
  lightness: boolean;
  chroma: boolean;
  normalVision: { worst: number; pass: boolean };
  cvd: { worst: number; pass: boolean; target: boolean };
  contrast: { worst: number; pass: boolean };
  pass: boolean;
};

/** The validator's checks for an ordered series on one surface, adjacent pairs. */
export function checkChartPalette(series: readonly string[], appearance: ThemeAppearance, surface: string): ChartPaletteCheck {
  const [low, high] = CHART_LIGHTNESS_BAND[appearance];
  const pairs = series.slice(1).map((color, index) => [series[index]!, color] as const);
  const worst = (values: number[]) => (values.length ? Math.min(...values) : Number.POSITIVE_INFINITY);
  const lightness = series.every((color) => {
    const value = oklch(color).lightness;
    return value >= low && value <= high;
  });
  const chroma = series.every((color) => oklch(color).chroma >= CHART_CHROMA_FLOOR);
  const normal = worst(pairs.map(([a, b]) => deltaE(a, b)));
  const cvd = worst(pairs.flatMap(([a, b]) => [deltaE(a, b, 'protan'), deltaE(a, b, 'deutan')]));
  const surfaceContrast = worst(series.map((color) => contrast(color, surface)));
  const result = {
    lightness,
    chroma,
    normalVision: { worst: normal, pass: normal >= CHART_NORMAL_VISION_FLOOR },
    cvd: { worst: cvd, pass: cvd >= CHART_CVD_FLOOR, target: cvd >= CHART_CVD_TARGET },
    contrast: { worst: surfaceContrast, pass: surfaceContrast >= CHART_SURFACE_CONTRAST },
  };
  return { ...result, pass: lightness && chroma && result.normalVision.pass && result.cvd.pass && result.contrast.pass };
}
