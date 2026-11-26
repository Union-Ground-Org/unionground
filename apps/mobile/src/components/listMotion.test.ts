import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ROW_GLOW_SURFACE } from '../lib/rowHighlight';
import { contrastRatio } from '../theme/contrast';
import { themePalette } from '../theme/tokens';

// Adoption contract for the two 2026-09-13 owner requests carried over from the
// web build: long lists track the finger with one gliding bar (21st.dev
// hyperiux/interactive-list-preview), and stat values roll their digits
// (21st.dev barvian/activity-with-number-flow). The behavior itself is asserted
// numerically in ../lib/rowHighlight.test.ts and ../lib/numberFlow.test.ts.
// Here the palette maths the bar depends on runs for real, and thin source pins
// tie each screen to the primitives so a later wave cannot quietly reintroduce a
// per-screen press fill, a flickering count, or a heading made of numbers.

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('gliding row highlight palette', () => {
  // The bar paints ROW_GLOW_SURFACE behind row copy that was drawn on card or
  // canvas before. Every ink a highlighted row uses has to stay readable on it
  // in both palettes, light and dark. (muted fails: primary is 4.48:1 on it
  // in Union Ground's dark form, which is why the bar does not use it.)
  const inks = ['foreground', 'cardForeground', 'mutedForeground', 'primary'] as const;

  it('paints a semantic theme token', () => {
    expect(Object.keys(themePalette['union-ground'])).toContain(ROW_GLOW_SURFACE);
  });

  for (const [mode, tokens] of Object.entries(themePalette)) {
    for (const ink of inks) {
      it(`${ink} stays readable on the bar in the ${mode} palette`, () => {
        expect(contrastRatio(tokens[ROW_GLOW_SURFACE], tokens[ink])).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`the bar's hairline edge is distinguishable from the card in the ${mode} palette`, () => {
      // The fill alone is near-invisible on pale palettes; the border carries
      // the edge, so it has to read against the card the bar slides over.
      expect(contrastRatio(tokens.card, tokens.border)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('gliding row highlight adoption', () => {
  const primitive = read('./RowHighlight.tsx');
  const ui = read('./ui.tsx');
  const messages = read('../../app/messages.tsx');
  const widgets = read('./WorkWidgets.tsx');
  const deck = read('./FunctionDeck.tsx');

  it('never claims the touch responder or intercepts a press', () => {
    // Passive touch callbacks only: a row's own press, the scroll gesture and
    // swipe-back all keep working. The bar itself is not a touch target.
    expect(primitive).toContain('pointerEvents="none"');
    expect(primitive).not.toMatch(/onStartShouldSetResponder|onMoveShouldSetResponder|onResponderTerminationRequest|PanResponder/);
    expect(primitive).toContain('onTouchStart={onTouchStart}');
    expect(primitive).toContain('onTouchEnd={release}');
    expect(primitive).toContain('onTouchCancel={release}');
  });

  it('paints the audited surface token, not a literal colour', () => {
    expect(primitive).toContain('backgroundColor: theme[ROW_GLOW_SURFACE]');
  });

  it('keeps the bar out of the accessibility tree', () => {
    expect(primitive).toContain('accessibilityElementsHidden');
    expect(primitive).toContain('importantForAccessibility="no-hide-descendants"');
  });

  it('reads touch and bar in one coordinate space, and drops a late measurement', () => {
    // pageY of a touch is root-relative; so is measure()'s pageY, unlike the
    // window-relative measureInWindow.
    expect(primitive).toContain('listRef.current?.measure(');
    expect(primitive).not.toContain('measureInWindow');
    expect(primitive).toContain('gate.isLive(token)');
  });

  it('lands rather than glides under Reduce Motion', () => {
    expect(primitive).toContain("if (step.action === 'land' || reduceMotion) {");
    expect(primitive).toContain("import { useReduceMotion } from '../lib/reduceMotion';");
  });

  it('ships through the shared list primitives and lets a read-only row opt out', () => {
    expect(ui).toContain('<HighlightList style={[styles.group, { backgroundColor: theme.card, borderColor: theme.border }]}>');
    expect(ui).toContain('<HighlightRow style={rowStyle}>');
    expect(ui).toContain('highlight = true');
  });

  it('carries the message inbox and the work widgets without a second fill', () => {
    expect(messages).toContain('<HighlightList key={group.key}>');
    expect(messages).toContain('<HighlightRow key={item.key}>');
    expect(messages).not.toContain('pressed ? { backgroundColor: theme.muted } : null,');
    expect(widgets).toContain('<HighlightList style={[styles.body, { borderTopColor: theme.muted }]}>');
    expect(widgets).toContain('<HighlightRow>');
    expect(widgets).not.toContain('pressed ? { backgroundColor: theme.secondary } : null]}');
  });

  it('carries the features deck, where a hat browses everything it can open', () => {
    expect(deck).toContain('<HighlightList style={[styles.groupCard, { backgroundColor: theme.card, borderColor: theme.border }]}>');
    expect(deck).toContain('<HighlightRow key={item.key}>');
    expect(deck).not.toContain('pressed ? { backgroundColor: theme.secondary } : null]}');
  });

  it('holds the shortcut chips to the 48pt floor', () => {
    // iOS review 2026-09-13 D2: the add-shortcut chips were 34pt.
    expect(deck).toMatch(/railChoice: \{\s*minHeight: minimumTouchTarget,/);
    expect(deck).not.toContain('minHeight: 34');
  });
});

describe('rolling stat values adoption', () => {
  const flow = read('./NumberFlow.tsx');
  const ui = read('./ui.tsx');
  const home = read('../../app/(tabs)/home.tsx');
  const pulse = read('../features/PulseScreen.tsx');
  const feature = read('../features/FeatureScreen.tsx');
  const widgets = read('./WorkWidgets.tsx');

  it('goes static under Reduce Motion and at accessibility text sizes', () => {
    expect(flow).toContain('if (!parts || reduceMotion || !canFlowAtFontScale(fontScale)) {');
    expect(flow).toContain("import { useReduceMotion } from '../lib/reduceMotion';");
  });

  it('measures its digit cell instead of trusting a hard-coded row height', () => {
    expect(flow).toContain('const { height } = event.nativeEvent.layout;');
    expect(flow).not.toContain('fontSize * ');
  });

  it('speaks the whole formatted value once, or nothing when a parent already does', () => {
    expect(flow).toContain('accessibilityLabel={decorative ? undefined : accessibilityLabel ?? value}');
    expect(flow).toContain("importantForAccessibility={decorative ? 'no-hide-descendants' : 'yes'}");
  });

  it('ships a shared stat primitive rather than a heading made of numbers', () => {
    expect(ui).toContain('export function StatValue({ value, level = 3 }: { value: string; level?: 2 | 3 }) {');
    expect(feature).toContain('<StatValue value={String(item.value)} /><Body muted>{item.label}</Body>');
    expect(feature).not.toContain('<Heading level={3}>{item.value}</Heading>');
  });

  it('covers the KPI surfaces a worker and a committee member actually read', () => {
    expect(home).toContain('<NumberFlow decorative adjustsFontSizeToFit numberOfLines={1} value={cell.value} style={styles.statValue} />');
    expect(home).toContain('<NumberFlow decorative value={String(value)} style={[styles.metricValue, { color: theme.foreground }]} />');
    expect(pulse).toContain('<NumberFlow value={String(kpi.value)} style={styles.kpiValue} />');
    expect(pulse).toContain('<NumberFlow decorative value={String(row.value)} style={styles.legendValue} />');
    expect(feature).toContain('<NumberFlow value={String(tile.value)} style={[styles.workTileValue, { color: theme.foreground }]} />');
    expect(widgets).toContain('<NumberFlow decorative value={row.primary} style={[styles.tileValue, { color: theme.secondaryForeground }]} />');
  });

  it('leaves the shrink-to-fit desk hero as plain text', () => {
    // iab F10: the hero shrinks a "213/300" to one line. Digit columns cannot
    // shrink font size with it, so that one value stays a Text.
    expect(feature).toContain('<Text adjustsFontSizeToFit numberOfLines={1} style={[styles.deskHeroValue, { color: theme.cardForeground }]}>{hero.value}</Text>');
  });
});
