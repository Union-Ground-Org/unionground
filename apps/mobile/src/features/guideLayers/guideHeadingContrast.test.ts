// BUG-UG-NATIVE-PULSE-GUIDE-SUBHEADINGS-LOW-CONTRAST-DARK-20261103:
// the guide cards' "You can" and "Never" subheadings once had no theme colour,
// so they fell back to the platform's black on the dark card. Every guide
// heading now takes the card's foreground token, which reads at 4.5:1 or more
// on the card in light and dark.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { contrastRatio } from '../../theme/contrast';
import { resolveTheme, themeKeys, type ThemeKey } from '../../theme/tokens';

const sources = ['GuideLayers.tsx', 'StaffGuides.tsx'].map((name) => [name, readFileSync(join(__dirname, name), 'utf8')] as const);

describe('guide subheadings on the guide card', () => {
  it.each(sources)('%s gives every guide heading the card foreground token', (_name, source) => {
    const headings = source.match(/<Text accessibilityRole="header" style=\{[^}]*\}\]?\}/g) ?? [];
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) expect(heading).toContain('{ color: theme.cardForeground }');
    expect(source).not.toContain('style={styles.groupHeading}');
  });

  it.each(sources)('%s reads the theme before a group can return early', (_name, source) => {
    const groups = source.match(/function (?:Guide)?Group\([^)]*\) \{\n[^\n]*\n[^\n]*/g) ?? [];
    expect(groups).toHaveLength(1);
    for (const group of groups) {
      expect(group).toMatch(/\{\n {2}const theme = useTheme\(\);\n {2}if \(!lines\.length\) return null;/);
    }
  });

  it.each<[ThemeKey, boolean]>(
    themeKeys.flatMap((key): [ThemeKey, boolean][] => [[key, false], [key, true]]),
  )('reads at 4.5:1 or more on the card for %s (dark %s)', (key, dark) => {
    const theme = resolveTheme(key, dark);
    expect(contrastRatio(theme.cardForeground, theme.card)).toBeGreaterThanOrEqual(4.5);
  });

  it('covers both schemes, the dark one included', () => {
    expect(themeKeys).toEqual(['union-ground']);
    expect(resolveTheme('union-ground', false).appearance).toBe('light');
    expect(resolveTheme('union-ground', true).appearance).toBe('dark');
  });
});
