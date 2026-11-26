import palette from './palette.json';

export const defaultThemeKey = 'union-ground';

// Union Ground ships one theme: its own cream, forest-green and gold
// palette (owner direction 2026-09-06: preserve the existing theme and exact
// palette). The registry shape is kept so the Account picker, preference
// storage and contrast tests work unchanged if a second palette is approved.
export const themeKeys = [defaultThemeKey] as const;

export type ThemeKey = (typeof themeKeys)[number];
export type PaletteKey = keyof typeof palette;
export const darkPaletteKey = 'union-ground-dark' satisfies PaletteKey;
export type ThemeAppearance = 'light' | 'dark';
// The theme (promo package tokens.json) gives the light form six chart series
// and an "other" colour but its dark form only three series (seriesDark), so
// the dormant dark entry keeps three and the extra series are optional here
// (UX-UG-NATIVE-PALETTE-INKS-AND-SIX-CHART-COLOURS-20261117).
type LightOnlySeries = 'chartSeries4' | 'chartSeries5' | 'chartSeries6' | 'chartSeriesOther';
type PaletteTokens = Omit<typeof palette[typeof defaultThemeKey], LightOnlySeries> & Partial<Pick<typeof palette[typeof defaultThemeKey], LightOnlySeries>>;
export type ThemeTokens = PaletteTokens & { appearance: ThemeAppearance };

export type ThemeOption = {
  key: ThemeKey;
  label: string;
  description: string;
};

export const themeOptions: readonly ThemeOption[] = [
  { key: defaultThemeKey, label: 'Union Ground', description: 'Cream, forest green, and gold.' },
] as const;

export function isThemeKey(value: unknown): value is ThemeKey {
  return typeof value === 'string' && (themeKeys as readonly string[]).includes(value);
}

// Retired selectable themes, each opening in Union Ground for a member who had
// saved it: Aubergine Ledger (removed Oct 30, 2026), then Cobalt Signal, Union
// Printroom, Night Shift and Collected (removed Nov 3, 2026). The
// aubergine-and-gold brand identity is not a selectable theme and is unaffected.
export const RETIRED_THEME_KEYS: Readonly<Record<string, ThemeKey>> = {
  'aubergine-ledger': defaultThemeKey,
  'cobalt-signal': defaultThemeKey,
  'union-printroom': defaultThemeKey,
  'night-shift': defaultThemeKey,
  collected: defaultThemeKey,
};

export function normalizeThemeKey(value: unknown): ThemeKey {
  if (isThemeKey(value)) return value;
  const replacement = typeof value === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_THEME_KEYS, value) ? RETIRED_THEME_KEYS[value] : undefined;
  return replacement ?? defaultThemeKey;
}

export function themeAppearance(key: PaletteKey): ThemeAppearance {
  return key === darkPaletteKey ? 'dark' : 'light';
}

// Every hat wears the same palette: Union Ground keeps one visual identity
// across organizing hats. The map stays so the coverage audit can pin each
// hat's default.
export const HAT_THEME_KEYS: Readonly<Record<string, ThemeKey>> = {
  member: defaultThemeKey,
  organizer: defaultThemeKey,
  steward: defaultThemeKey,
  coordinator: defaultThemeKey,
  advisor: defaultThemeKey,
  admin: defaultThemeKey,
  vp: defaultThemeKey,
};

// One palette for every hat: the worn hat never changes the theme.
export function effectiveThemeKey(selectedTheme: ThemeKey, _previewHat: string | null): ThemeKey {
  return normalizeThemeKey(selectedTheme);
}

export function resolveTheme(value?: ThemeKey | null, prefersDark = false): ThemeTokens {
  // Every saved value opens in Union Ground. Only the palette audits ask for the
  // dormant dark form; no screen, provider or boundary passes prefersDark.
  const key = normalizeThemeKey(value);
  const renderedKey: PaletteKey = prefersDark ? darkPaletteKey : key;
  return { ...palette[renderedKey], appearance: themeAppearance(renderedKey) };
}

export const themePalette = palette;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
  // Radius ladder tied to elevation (visual-language brief §A): radius alone
  // signals which layer a surface belongs to.
  rowRadius: 12,
  cardRadius: 16,
  controlRadius: 20,
  sheetRadius: 28,
} as const;

export const minimumTouchTarget = 48;

// Typefaces (UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115).
// The theme (promo package README-AI.md rule 8; kit/brand/theme/tokens.json
// font.display and font.body; ug-theme.css) sets Archivo 800 for headings and
// the name, and Public Sans for text (400), secondary lines and inputs (500),
// controls (600) and selected or counted controls (700).
//
// Each weight is a static file, embedded through the expo-font plugin in
// app.config.ts. iOS reads each file's family name ("Archivo", "Public Sans");
// Android groups the same files into XML font families under those names. A
// style therefore names the family and a weight, and the weight picks the real
// face on both platforms, nested Text included. Ask only for a weight that is
// embedded: iOS falls back to the nearest face, and Android draws a synthetic
// bolder one when the nearest is 200 or more lighter. Text keeps scaling with
// Dynamic Type and Android font scale. Spline Sans Mono (the theme's face for
// numbers) is not embedded.
//
// Android before API 28 (the app supports API 24) keeps only NORMAL and BOLD
// when it picks a face from a family: React Native's ReactFontManager turns
// any weight under 700 into NORMAL there, so Medium and SemiBold would draw as
// Regular. Android therefore also gets one single-face family per in-between
// weight, and resolveTypography names it on those versions.
export type Typeface = 'Archivo' | 'Public Sans';
export type FontFamilyName = Typeface | 'Public Sans Medium' | 'Public Sans SemiBold';
export type EmbeddedWeight = '400' | '500' | '600' | '700' | '800';
export type FontFile = {
  readonly typeface: Typeface;
  readonly weight: EmbeddedWeight;
  /** The file's PostScript name, which is also its file name. */
  readonly postScriptName: string;
  readonly path: string;
};

export const fontFiles: readonly FontFile[] = [
  { typeface: 'Archivo', weight: '800', postScriptName: 'Archivo-ExtraBold', path: './fonts/Archivo-ExtraBold.ttf' },
  { typeface: 'Public Sans', weight: '400', postScriptName: 'PublicSans-Regular', path: './fonts/PublicSans-Regular.ttf' },
  { typeface: 'Public Sans', weight: '500', postScriptName: 'PublicSans-Medium', path: './fonts/PublicSans-Medium.ttf' },
  { typeface: 'Public Sans', weight: '600', postScriptName: 'PublicSans-SemiBold', path: './fonts/PublicSans-SemiBold.ttf' },
  { typeface: 'Public Sans', weight: '700', postScriptName: 'PublicSans-Bold', path: './fonts/PublicSans-Bold.ttf' },
];

export type TypographyRole = 'heading' | 'name' | 'body' | 'bodyMedium' | 'control' | 'controlStrong';
export type TypographyStyle = { readonly fontFamily: FontFamilyName; readonly fontWeight: EmbeddedWeight };

export const typography: Readonly<Record<TypographyRole, TypographyStyle>> = {
  // Page titles, section headings and card titles.
  heading: { fontFamily: 'Archivo', fontWeight: '800' },
  // The app name, "Union Ground" (the Sign in wordmark keeps Georgia).
  name: { fontFamily: 'Archivo', fontWeight: '800' },
  // Running text.
  body: { fontFamily: 'Public Sans', fontWeight: '400' },
  // Subtitles, secondary lines and typed input.
  bodyMedium: { fontFamily: 'Public Sans', fontWeight: '500' },
  // Buttons, rows, tabs and chips.
  control: { fontFamily: 'Public Sans', fontWeight: '600' },
  // A selected control, a count, a strong label.
  controlStrong: { fontFamily: 'Public Sans', fontWeight: '700' },
};

/** Android's single-face families for the weights old Android cannot pick from a family. */
export const androidSingleFaceFamilies: Readonly<Partial<Record<EmbeddedWeight, FontFamilyName>>> = {
  '500': 'Public Sans Medium',
  '600': 'Public Sans SemiBold',
};

/** The roles as one platform draws them: `os` and `version` are Platform.OS and Platform.Version. */
export function resolveTypography(os: string, version: number | string): Readonly<Record<TypographyRole, TypographyStyle>> {
  if (os !== 'android' || !(Number(version) < 28)) return typography;
  const resolved: Record<TypographyRole, TypographyStyle> = { ...typography };
  for (const role of Object.keys(typography) as TypographyRole[]) {
    const style = typography[role];
    const single = style.fontFamily === 'Public Sans' ? androidSingleFaceFamilies[style.fontWeight] : undefined;
    if (single) resolved[role] = { fontFamily: single, fontWeight: style.fontWeight };
  }
  return resolved;
}
