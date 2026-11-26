import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { fontScaleLayoutKey } from '../lib/fontScaleRelayout';

// BUG-UG-NATIVE-HOME-ACCESSIBILITY-TEXT-CLIPPED-20261103. Changing the
// iPhone text size while the app was open left Home's name, role, chapter
// card, summary labels, headings, caught-up card, password card heading and
// the vote card title drawn at the new size inside frames measured at the old
// size, so only the tops of the glyphs showed. Opening the same screen fresh
// at that size laid it out whole, and the summary numbers (NumberFlow swaps
// its text when the scale changes) were never cut: a text mounted after the
// change is measured right. The styles were not the cause; React Native
// scales a fixed lineHeight with the text size. The repair mounts the page
// content again when the scale changes.

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

// React Native's iOS multipliers for the twelve text sizes (RCTUtils.mm
// RCTFontSizeMultiplier), extra small through accessibility XXXL.
const IOS_TEXT_SIZE_SCALES = [0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143, 3.571];

describe('text size change while the app is open (#6863)', () => {
  it('gives every iOS text size its own key, so a change of size mounts the content again', () => {
    const keys = IOS_TEXT_SIZE_SCALES.map(fontScaleLayoutKey);
    expect(new Set(keys).size).toBe(IOS_TEXT_SIZE_SCALES.length);
    expect(fontScaleLayoutKey(3.571)).not.toBe(fontScaleLayoutKey(2.643));
    // Android font scale 2.0, the largest Display size and font setting.
    expect(fontScaleLayoutKey(2)).not.toBe(fontScaleLayoutKey(1));
  });

  it('keeps one key for one size, so float noise or a re-render never remounts a page', () => {
    expect(fontScaleLayoutKey(2.6430000001)).toBe(fontScaleLayoutKey(2.643));
    expect(fontScaleLayoutKey(1)).toBe('font-scale-1000');
    expect(fontScaleLayoutKey(Number.NaN)).toBe(fontScaleLayoutKey(1));
    expect(fontScaleLayoutKey(0)).toBe(fontScaleLayoutKey(1));
  });

  it('keys a Fragment, which adds no view, on the live text scale', () => {
    const relayout = read('./FontScaleRelayout.tsx');
    expect(relayout).toContain('const { fontScale } = useWindowDimensions();');
    expect(relayout).toContain('<Fragment key={fontScaleLayoutKey(fontScale)}>{children}</Fragment>');
  });

  it('wraps every Screen page, Home and its vote card included, in the relayout', () => {
    const ui = read('./ui.tsx');
    const scroll = between(ui, '<Animated.ScrollView', '</Animated.ScrollView>');
    const relayout = between(scroll, '<FontScaleRelayout>', '</FontScaleRelayout>');
    expect(relayout).toContain('{children}');
    // A pushed screen's title sits on the row beside Back, outside the scroll
    // view; the row measures it again at a new text size (its key carries the
    // font scale), so the content start line follows.
    expect(ui).not.toContain('PageTitle');
    const header = read('./PinnedHeader.tsx');
    expect(header).toContain("const titleKey = `${heading ?? ''}|${fontScale}`;");
    // and the title itself is mounted again at a new size, as the page is.
    expect(between(header, '<FontScaleRelayout>', '</FontScaleRelayout>')).toContain('{heading}');
    expect(scroll.replace(relayout, '')).not.toContain('{children}');

    const home = read('../../app/(tabs)/home.tsx');
    const page = between(home, '<Screen tabRoot bottomInset={bottomInset} refreshing={refreshing} onRefresh={() => { void refresh(\'user-refresh\'); }} scrollsTopChrome\n', '</Screen>');
    for (const part of ['<Heading>{dashboard.member.firstName}</Heading>', '<Body muted fitWords>{dashboard.member.roleLine}</Body>', 'chapterIdentity.title', "<Metric value={metrics.openCases} label={t(\"Open issues\")}", '<WhatMattersNowSection item={ranking.item} status={ranking.status} onRetry={whatMatters.retry} hasPersonalItems={hasPersonalItems} />', '<ChoosePasswordNudge>']) {
      expect(page).toContain(part);
    }
  });

  it('wraps the sign-in page inside its scroll view, where the typed fields are held above it', () => {
    const signIn = read('../../app/sign-in.tsx');
    const scroll = between(signIn, '<ScrollView', '</ScrollView>');
    const relayout = between(scroll, '<FontScaleRelayout>', '</FontScaleRelayout>');
    expect(relayout).toContain('<View style={styles.brand}>');
    expect(signIn).toContain("const [email, setEmail] = useState('');");
    expect(signIn).toContain("const [password, setPassword] = useState('');");
  });

  it('gives the clipped Home and vote card texts no fixed height, so their boxes grow with the text', () => {
    const ui = read('./ui.tsx');
    const home = read('../../app/(tabs)/home.tsx');
    const whatMatters = read('../features/home/WhatMattersNow.tsx');
    const styleLine = (source: string, name: string) => {
      const line = source.split('\n').find((candidate) => candidate.trimStart().startsWith(`${name}: {`));
      expect(line, name).toBeDefined();
      return line ?? '';
    };
    const styles = [
      ...['heading1', 'heading2', 'heading3', 'body'].map((name) => styleLine(ui, name)),
      ...['chapterIdentityTitle', 'metricLabel', 'metricValue', 'avatarText'].map((name) => styleLine(home, name)),
      styleLine(whatMatters, 'reason'),
    ];
    for (const style of styles) expect(style).not.toMatch(/\b(?:height|maxHeight)\s*:/);
  });

  it('keeps the Account initials inside their fixed 44 pt circle at every text size', () => {
    const home = read('../../app/(tabs)/home.tsx');
    expect(home).toContain('const AVATAR_INITIALS_MAX_SCALE = 1.4;');
    expect(home).toContain('<Text maxFontSizeMultiplier={AVATAR_INITIALS_MAX_SCALE} style={styles.avatarText}>{dashboard.member.initials}</Text>');
  });
});
