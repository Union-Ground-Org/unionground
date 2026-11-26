import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115 (#8928), the
// sweep: every word draws through the theme's typefaces, set by the roles in
// src/theme/tokens.ts and the app's Text, never by a screen naming a font.
const mobileRoot = new URL('../../', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'testing' ? [] : sources(path);
    return /\.(?:ts|tsx)$/u.test(entry) && !/\.test\.tsx?$/u.test(entry) ? [path] : [];
  });
}

const files = [...sources(join(mobileRoot, 'app')), ...sources(join(mobileRoot, 'src'))]
  .map((path) => ({ path: relative(mobileRoot, path), text: readFileSync(path, 'utf8') }));

// Georgia stays where a design already set it (theme decision 6).
const GEORGIA = "fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' })";

describe('the typeface sweep', () => {
  it("imports Text and TextInput from the app's Text, never straight from react-native", () => {
    const offenders = files
      .filter(({ path }) => path !== 'src/components/Text.tsx')
      .filter(({ text }) => [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-native';/gu)]
        .some((match) => (match[1] ?? '').split(',').map((name) => name.trim()).some((name) => name === 'Text' || name === 'TextInput')))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('sets no weight as a literal outside the roles, except beside Georgia', () => {
    const offenders = files
      .filter(({ path }) => path !== 'src/theme/tokens.ts')
      .flatMap(({ path, text }) => text.split('\n')
        .map((line, index) => ({ line, at: `${path}:${index + 1}` }))
        .filter(({ line }) => /fontWeight:\s*'/u.test(line) && !line.includes(GEORGIA)))
      .map(({ at }) => at);
    expect(offenders).toEqual([]);
  });

  it('names no font family on a screen', () => {
    const allowed = new Set(['src/theme/tokens.ts', 'src/lib/textFace.ts']);
    const offenders = files
      .filter(({ path }) => !allowed.has(path))
      .flatMap(({ path, text }) => text.split('\n')
        .map((line, index) => ({ line, at: `${path}:${index + 1}` }))
        // The welcome eyebrow's system monospace stands in for the theme's data
        // face, Spline Sans Mono, which is not embedded.
        .filter(({ line }) => /fontFamily:/u.test(line) && !line.includes(GEORGIA) && !/fontFamily: (serifFamily|MONO)\b/u.test(line)))
      .map(({ at }) => at);
    expect(offenders).toEqual([]);
  });
});

// Ledger 381, taken where the sweep already touches the file: two words that
// split between letters at the largest iPhone text size, and the passkey pill
// that grew without limit.
describe('largest-text repairs in the swept files (ledger 381)', () => {
  const source = (path: string) => files.find((file) => file.path === path)?.text ?? '';

  it('grows the issue number and the announcement label only while their longest word fits', () => {
    expect(source('app/issue/[id].tsx')).toContain('const fit = useWordFit(true, children, style);');
    expect(source('app/issue/[id].tsx')).toContain('<FittedText style={styles.reference} color={theme.primary}>{item.reference}</FittedText>');
    expect(source('app/issue/[id].tsx')).toContain('<FittedText style={styles.value} color={theme.foreground}>{value}</FittedText>');
    // An all-capitals label is wider a letter than running text.
    expect(source('src/features/home/HomeTakeoverCards.tsx')).toContain("const fit = useWordFit(true, children, styles.eyebrow, 'caps');");
    expect(source('src/features/home/HomeTakeoverCards.tsx')).toContain('<Eyebrow color={theme.mutedForeground}>');
  });

  // This edition has no passkey sign-in; the shared Button still takes the cap.
  it('lets a form cap its button labels as it caps the controls beside them', () => {
    expect(source('src/components/ui.tsx'))
      .toContain('<Text {...(maxFontSizeMultiplier === undefined ? {} : { maxFontSizeMultiplier })} style={[styles.buttonText,');
  });
});
