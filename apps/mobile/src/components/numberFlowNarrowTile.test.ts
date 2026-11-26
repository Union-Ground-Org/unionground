import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { previewDashboardFor, previewDeskFor } from '../data/preview';
import { MEMBER_WORK_WIDGETS, STAFF_HAT_FUNCTIONS, type HatFunction } from '../lib/hatFunctions';
import { flowParts, shouldFlow } from '../lib/numberFlow';

// BUG-UG-MOBILE-NUMBERFLOW-UNIT-WRAPS-MID-WORD-IN-NARROW-TILES-20261010.
// In a rewards tile at 320 pt the value "1840 points" rendered as "point" on
// one right-aligned line and "1840s" on the next: the unit run is its own Text
// inside a bottom-aligned row, and with no line limit it wrapped inside itself.
// The wrapped run then measured as fitting the box, so the row's shrink-to-fit
// never engaged either. Two repairs, both pinned here: the run is one line
// always (so any rolling value with a unit shrinks instead of breaking), and
// the contribution tiles carry the bare count with the unit in the label.

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./FunctionDeck', () => ({ functionIcons: {} }));
vi.mock('./ui', () => ({ Body: () => null, Avatar: () => null }));

const { rowsFor } = await import('./WorkWidgets');

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function widgetFor(key: string): HatFunction {
  const item = [...MEMBER_WORK_WIDGETS, ...Object.values(STAFF_HAT_FUNCTIONS).flat()].find((entry) => entry.key === key);
  if (!item) throw new Error(`missing work widget ${key}`);
  return item;
}

describe('rolling value with a unit in a narrow tile', () => {
  const component = read('./NumberFlow.tsx');

  it('keeps every fixed run of the value on one line so it cannot break inside a word', () => {
    const glyphs = component.slice(component.indexOf('function Glyphs('));
    const open = glyphs.indexOf('<Text ');
    const tag = glyphs.slice(open, glyphs.indexOf('>', open) + 1);
    expect(tag).toContain('numberOfLines={1}');
  });

  it('still measures the run that reports the width the row wants, so the row scales instead', () => {
    // A run kept on one line overflows its box, and the last piece's right edge
    // is what onEnd reports; fitScale then takes the whole row down.
    expect(component).toContain('<Glyphs text={parts.suffix} style={textStyle} onEnd={onEnd} />');
    expect(component).toContain('const scale = fitScale(available, content);');
    expect(component).toContain("transform: [{ scale }], transformOrigin: 'left center'");
  });

  it('leaves the tiles the same height and top-aligned: no row-level alignment override was added', () => {
    const widgets = read('./WorkWidgets.tsx');
    const tileRow = widgets.slice(widgets.indexOf('tileRow: {'), widgets.indexOf('tile: { flex: 1'));
    expect(tileRow).not.toContain('alignItems');
  });
});

// Union Ground has no points economy, so the contributions tiles now carry
// the verified-contribution count with its unit in the label; the narrow-tile
// rule this file pins (value as one glyph run, unit beneath) is unchanged.
describe('contributions tiles', () => {
  const dashboard = previewDashboardFor('member');

  it('shows the count with the unit in the label and no points or tier', () => {
    const desk = previewDeskFor('member');
    const rows = rowsFor(widgetFor('numbers'), desk, dashboard).rows;
    const verified = rows.find((row) => row.id === 'verified');
    expect(verified).toBeDefined();
    expect(verified?.primary).toBe(String(desk.rewards?.totalVerified));
    expect(verified?.secondary).toBe('Verified contributions');
    // The value is one glyph run, so the tile's first line cannot wrap and the
    // neighbouring "27 / Actions this year" tile stays level with it.
    expect(verified?.primary).not.toContain(' ');
    expect(rows.find((row) => row.id === 'actions')?.primary).toBe('27');
    expect(rows.find((row) => row.id === 'points')).toBeUndefined();
    for (const row of rows) expect(`${row.primary} ${row.secondary}`).not.toMatch(/\bpoints?\b|\bTier\b/i);
  });

  it('writes both contribution tile blocks the same way', () => {
    // rowsFor builds the same pair for the "numbers" widget and for the
    // "rewards" source behind admin-rewards; only the member preview desk
    // carries contribution data, so the second block is pinned by source.
    const widgets = read('./WorkWidgets.tsx');
    const written = widgets.split("primary: formatFlowCount(desk.rewards.totalVerified), secondary: 'Verified contributions'").length - 1;
    expect(written).toBe(2);
    expect(widgets).not.toMatch(/totalPoints|tierNumber|tierName|points · Tier/);
  });

  it('keeps the rolling-digit path for a separated total', () => {
    // A grouped count such as "1,840" is still one number with no trailing
    // word, so the component rolls it at the standard text size; the comma
    // stays a column of its own.
    expect(shouldFlow('1,840')).toBe(true);
    expect(flowParts('1,840')).toEqual({ prefix: '', core: '1,840', suffix: '' });
  });
});
