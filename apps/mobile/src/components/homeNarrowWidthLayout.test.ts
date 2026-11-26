import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source contract for BUG-UG-MOBILE-HOME-GREETING-AND-STAT-LABELS-WRAP-AT-320PT-20261010.
// On the iPhone 16e with Display Zoom Larger Text (320 x 693 pt) the Home
// greeting read "Evening" / "," / "Darnell" on three lines, the date line took
// three, and the stat labels broke inside words ("Unrea / d", "Action / s /
// taken"). The repair is text-level only: one string for the greeting so the
// comma cannot be orphaned, and a line limit with shrink-to-fit on the three
// texts that share the narrow column or a 48 pt stat cell. The declared sizes
// (23/26 serif, 12.5 pt date, 10.5 pt label) are unchanged, so nothing moves at
// 390 pt or wider, where the text already fits.

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function openingTag(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = source.lastIndexOf('<Text', at);
  expect(open).toBeGreaterThan(-1);
  return source.slice(open, source.indexOf('>', at) + 1);
}

describe('Home narrow-width text (320 pt, October 10 2026)', () => {
  const home = read('../../app/(tabs)/home.tsx');

  it('composes the greeting as one string so the comma stays attached to the word before it', () => {
    // Three runs ({greetingWord()}, ", ", {firstName}) let iOS break before the
    // comma. One interpolated string leaves the space after the comma as the
    // only break opportunity.
    expect(home).toContain('{`${catalogLabel(greetingWord())}, ${dashboard.member.firstName}`}');
    expect(home).not.toContain('{greetingWord()}, {dashboard.member.firstName}');
  });

  it('caps the greeting at two lines and shrinks it rather than wrapping further', () => {
    const tag = openingTag(home, 'styles.greeting');
    expect(tag).toContain('numberOfLines={2}');
    expect(tag).toContain('adjustsFontSizeToFit');
    expect(tag).toContain('minimumFontScale={0.7}');
  });

  it('caps the date line at two lines', () => {
    const tag = openingTag(home, 'styles.hi');
    expect(tag).toContain('numberOfLines={2}');
    expect(tag).toContain('adjustsFontSizeToFit');
    expect(tag).toContain('minimumFontScale={0.85}');
  });

  it('keeps every stat label word whole by giving each word its own shrinking line', () => {
    const tag = openingTag(home, 'styles.statLabelWord]');
    // iOS shrinks only when text overflows its line limit. A shared limit
    // never stops a break inside a word: "Action" / "s taken" still fits two
    // lines. A one-line text per word overflows instead and shrinks alone.
    expect(tag).toContain('numberOfLines={1}');
    expect(tag).toContain('adjustsFontSizeToFit');
    expect(tag).toContain('minimumFontScale={0.7}');
    expect(tag).toContain('style={[styles.statLabel, styles.statLabelWord]}');
    expect(home).toContain('{statLabelWords(cell.label).map((word, wordIndex) => (');
    expect(home).toContain('return label.trim().split(/\\s+/);');
    // Words that fit still share a line, so the band at 390 pt reads as before.
    expect(home).toContain("statLabelWords: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, marginTop: 2 },");
    expect(home).toContain('statLabelWord: { marginTop: 0 },');
    const words = (label: string) => label.trim().split(/\s+/);
    expect(['Open issues', 'Due this week', 'Unread', 'Actions taken'].map(words)).toEqual([
      ['Open', 'issues'], ['Due', 'this', 'week'], ['Unread'], ['Actions', 'taken'],
    ]);
    // The four labels stay as written: shortening them would change the band at
    // 390 pt as well, which the record's acceptance forbids.
    expect(home).toContain("const STAT_LABELS = ['Open issues', 'Due this week', 'Unread', 'Actions taken'] as const;");
  });

  it('leaves the wide-width layout alone: the serif heading and the column keep their declared geometry', () => {
    expect(home).toContain('greeting: { fontFamily: Platform.select({ ios: \'Georgia\', default: \'serif\' }), fontWeight: \'600\', fontSize: 23, color: theme.foreground, lineHeight: 26 },');
    expect(home).toContain('hi: { fontSize: 12.5, color: theme.mutedForeground, ...typeface.control },');
    expect(home).toContain('statLabel: { fontSize: 10.5, color: theme.mutedForeground, ...typeface.control, lineHeight: 13, marginTop: 2 },');
    expect(home).toContain('title: { flex: 1 },');
    // The top chrome itself belongs to
    // REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010; this
    // repair does not add a width breakpoint or move the bell and the avatar.
    // (The worker summary reads the window width for its large-text columns.)
  });
});
