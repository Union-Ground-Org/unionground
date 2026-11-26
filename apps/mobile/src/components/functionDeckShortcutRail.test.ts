// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { featureGroupsForRoles, withMyCampaignGroup, STAFF_HAT_FUNCTIONS, type HatFunctionGroup, type LiveStaffRole } from '../lib/hatFunctions';
import { nativeCatalogLabel } from '../lib/nativeUiCopy';
import { fontFiles, typography, spacing } from '../theme/tokens';
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: runtime.language }) }));

// A11Y-UG-NATIVE-ALL-FEATURES-SHORTCUT-LABELS-BREAK-AT-LARGE-TEXT-20261109:
// four long fictional Tamarack destinations in the All features shortcut
// rail. At the largest text the rail reflows instead of squeezing each label
// into a quarter of the row, and nothing about the shortcuts themselves
// changes: same destinations, order, names and 48 dp targets.

const runtime = vi.hoisted(() => ({
  window: { width: 411, height: 914, scale: 2.625, fontScale: 1 },
  push: vi.fn(),
  language: 'en' as 'en' | 'es',
  layouts: [] as ((event: { nativeEvent: { layout: { width: number; height: number } } }) => void)[],
}));

type Style = Record<string, unknown>;
function flatten(style: unknown): Style {
  if (!style) return {};
  if (Array.isArray(style)) return style.reduce<Style>((all, entry) => ({ ...all, ...flatten(entry) }), {});
  return typeof style === 'object' ? style as Style : {};
}

vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  return {
    View: ({ children, style, onLayout, accessibilityRole, accessibilityElementsHidden }: { children?: ReactNode; style?: unknown; onLayout?: (event: never) => void; accessibilityRole?: string; accessibilityElementsHidden?: boolean }) => {
      if (onLayout) runtime.layouts.push(onLayout as never);
      return h('div', { 'data-style': JSON.stringify(flatten(style)), 'aria-hidden': accessibilityElementsHidden, role: accessibilityRole === 'tablist' ? 'tablist' : undefined }, children);
    },
    ScrollView: ({ children, style, contentContainerStyle }: { children?: ReactNode; style?: unknown; contentContainerStyle?: unknown }) => h('div', { 'data-scroll': true, 'data-style': JSON.stringify(flatten(style)), 'data-content-style': JSON.stringify(flatten(contentContainerStyle)) }, children),
    Text: ({ children, numberOfLines, style, onTextLayout, maxFontSizeMultiplier }: { children?: ReactNode; numberOfLines?: number; style?: unknown; maxFontSizeMultiplier?: number; onTextLayout?: (event: { nativeEvent: { lines: { width: number }[] } }) => void }) => {
      const text = String(children);
      const textStyle = flatten(style);
      useEffect(() => {
        onTextLayout?.({ nativeEvent: { lines: text.split('\n').map(word => ({ width: measureWord(word, textStyle) })) } });
      }, [text, textStyle.fontSize, textStyle.fontFamily, textStyle.fontWeight]); // native layout fires when text or font changes
      return h('span', { 'data-max-scale': maxFontSizeMultiplier, 'data-lines': numberOfLines === undefined ? 'unlimited' : String(numberOfLines), 'data-style': JSON.stringify(textStyle) }, children);
    },
    Pressable: ({ children, onPress, accessibilityLabel, style }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; style?: unknown }) => (
      h('button', {
        type: 'button',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'data-style': JSON.stringify(flatten(typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style)),
      }, children)
    ),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    useWindowDimensions: () => runtime.window,
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: runtime.push }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => undefined }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#000000' }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: async () => undefined, impact: async () => undefined } }));
vi.mock('../lib/quickActions', () => ({ PINNED_DESTINATIONS_STORE_PREFIX: 'test.shortcuts' }));
vi.mock('./FontScaleRelayout', () => ({ FontScaleRelayout: ({ children }: { children?: ReactNode }) => children }));
vi.mock('./RowHighlight', async () => {
  const { createElement: h } = await import('react');
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return { HighlightList: box, HighlightRow: box };
});
vi.mock('./ui', async () => {
  const { createElement: h } = await import('react');
  return {
    Body: ({ children }: { children?: ReactNode }) => h('p', null, children),
    SearchField: ({ value, onChangeText }: { value: string; onChangeText: (value: string) => void }) => h('input', { value, onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) }),
  };
});

import { FunctionDeck } from './FunctionDeck';

// Read the shipped face, including cmap and advances. A guessed em allowance
// would let another typeface sweep pass while breaking the rendered words.
function measureWord(word: string, style: Style, maximumScale = Infinity): number {
  const face = fontFiles.find(file => file.typeface === style.fontFamily && file.weight === style.fontWeight);
  if (!face) throw new Error(`No embedded face for ${String(style.fontFamily)} ${String(style.fontWeight)}`);
  const bytes = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..', face.path));
  const tables = new Map<string, number>();
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    tables.set(bytes.toString('latin1', record, record + 4), bytes.readUInt32BE(record + 8));
  }
  const table = (name: string) => { const offset = tables.get(name); if (offset === undefined) throw new Error(`Missing ${name}`); return offset; };
  const cmap = table('cmap');
  let subtable = -1;
  for (let i = 0; i < bytes.readUInt16BE(cmap + 2); i++) {
    const record = cmap + 4 + i * 8;
    if (bytes.readUInt16BE(record) === 3 && bytes.readUInt16BE(record + 2) === 1) subtable = cmap + bytes.readUInt32BE(record + 4);
  }
  if (subtable < 0 || bytes.readUInt16BE(subtable) !== 4) throw new Error('Missing Unicode cmap');
  const count = bytes.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14, starts = ends + count * 2 + 2, deltas = starts + count * 2, ranges = deltas + count * 2;
  const advances = bytes.readUInt16BE(table('hhea') + 34);
  let total = 0;
  for (const character of word) {
    const code = character.codePointAt(0)!;
    let glyph = 0;
    for (let i = 0; i < count; i++) {
      if (code > bytes.readUInt16BE(ends + i * 2)) continue;
      if (code < bytes.readUInt16BE(starts + i * 2)) break;
      const delta = bytes.readInt16BE(deltas + i * 2), range = bytes.readUInt16BE(ranges + i * 2);
      const mapped = range ? bytes.readUInt16BE(ranges + i * 2 + range + (code - bytes.readUInt16BE(starts + i * 2)) * 2) : code;
      glyph = mapped === 0 ? 0 : (mapped + delta) & 0xffff;
      break;
    }
    if (!glyph) throw new Error(`Missing glyph ${character}`);
    total += bytes.readUInt16BE(table('hmtx') + Math.min(glyph, advances - 1) * 4);
  }
  return total / bytes.readUInt16BE(table('head') + 18) * Number(style.fontSize) * Math.min(runtime.window.fontScale, maximumScale);
}

const groups: HatFunctionGroup[] = [
  { key: 'bargaining', label: 'Bargaining', items: [{ key: 'collective-bargaining', label: 'Collective bargaining', href: '/feature/collective-bargaining', icon: 'hand' }] },
  { key: 'requests', label: 'Requests', items: [{ key: 'representation-requests', label: 'Representation requests', href: '/feature/representation-requests', icon: 'mail' }] },
  { key: 'rights', label: 'Rights', items: [{ key: 'know-your-rights', label: 'Organizing rights', href: '/feature/know-your-rights', icon: 'shield' }] },
  { key: 'casework', label: 'Issue work', items: [{ key: 'grievance-casework', label: 'Grievance issue work', href: '/feature/grievance-casework', icon: 'briefcase' }] },
];
const names = ['Collective bargaining', 'Representation requests', 'Organizing rights', 'Grievance issue work'];

let root: Root;
let host: HTMLDivElement;

async function render(fontScale: number, measuredRailWidth: number, catalog = groups, topPad = 0) {
  runtime.window = { ...runtime.window, fontScale };
  runtime.layouts = [];
  await act(async () => {
    root.render(createElement(FunctionDeck, { width: measuredRailWidth + 2 * spacing.lg, height: 800, topPad, bottomPad: 0, groups: catalog, onHome: () => undefined, shortcutScope: 'tamarack-steward' }));
  });
  await act(async () => {
    for (const layout of runtime.layouts) layout({ nativeEvent: { layout: { width: measuredRailWidth, height: 400 } } });
  });
}

function shortcutButtons(): HTMLButtonElement[] {
  const rail = host.querySelector('[role="tablist"]');
  return Array.from(rail?.querySelectorAll('button') ?? []);
}

function style(element: Element | null | undefined): Style {
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Style;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.push.mockReset();
  runtime.language = 'en';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe('All features shortcut rail at large text', () => {
  const roles: (LiveStaffRole | null)[] = [null, 'steward', 'coordinator', 'advisor', 'admin', 'vp'];
  const languages = ['en', 'es'] as const;
  function fits(railWidth: number) {
    const buttons = shortcutButtons();
    const widths = buttons.map(button => Number(style(button).width));
    const gap = Number(style(host.querySelector('[role="tablist"]')).gap);
    const columns = Math.round((railWidth + gap) / (widths[0]! + gap));
    expect([1, 2, 4]).toContain(columns);
    expect(widths[0]! * columns + gap * (columns - 1)).toBeLessThanOrEqual(railWidth);
    for (const button of buttons) {
      const cell = style(button);
      const label = button.querySelector('span')!;
      const labelStyle = style(label);
      const circle = style(button.querySelector('div'));
      const maximumScale = label.hasAttribute('data-max-scale') ? Number(label.getAttribute('data-max-scale')) : Infinity;
      expect(cell).toMatchObject({ flexShrink: 0, minHeight: 48 });
      expect(Number(cell.width)).toBeGreaterThanOrEqual(Number(circle.width));
      // Actual rendered style selects the font; a later role change is tested too.
      for (const word of label.textContent!.split(/\s+/u)) {
        expect(measureWord(word, labelStyle, maximumScale), word).toBeLessThanOrEqual(Number(cell.width));
      }
      if (Number.isFinite(maximumScale)) {
        expect(columns).toBe(1);
        expect(maximumScale).toBeGreaterThanOrEqual(1);
        // Scaling is limited only if a whole word cannot fit a full drawer.
        const originalWidth = Math.max(...shortcutButtons().flatMap(entry => entry.querySelector('span')!.textContent!.split(/\s+/u).map(word => measureWord(word, labelStyle))));
        expect(originalWidth + 2).toBeGreaterThan(railWidth);
      }
      expect(label.getAttribute('data-lines')).toBe('unlimited');
      expect(labelStyle.fontSize).toBe(11);
    }
  }

  for (const language of languages) for (const role of roles) {
    for (const phoneWidth of [390, 402]) for (const scale of [1, 3.12, 3.571]) {
      it(`${language} ${role ?? 'member'} fits ${phoneWidth}pt at text ${scale} with embedded font advances`, async () => {
        runtime.language = language;
        const catalog = withMyCampaignGroup(featureGroupsForRoles(role ? [role] : []));
        const railWidth = phoneWidth * 0.76 - 2 * spacing.lg;
        await render(scale, railWidth, catalog);
        expect(shortcutButtons()).toHaveLength(4);
        fits(railWidth);
        const destinations = [...host.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') !== 'Close and return to home' && button.getAttribute('aria-label') !== 'Customize shortcuts');
        const labels = destinations.map(button => button.getAttribute('aria-label'));
        for (const shortcut of shortcutButtons()) expect(labels.filter(label => label === shortcut.getAttribute('aria-label'))).toHaveLength(1);
        expect(host.textContent).not.toContain(`${nativeCatalogLabel(language, 'My campaign')}${nativeCatalogLabel(language, 'My campaign')}`);
      });
    }
  }

  it('measures Notifications and every staff shortcut in both bundled families', () => {
    const labels = ['Notifications', ...roles.flatMap(role => role ? [STAFF_HAT_FUNCTIONS[role][0]!.label] : [])];
    for (const language of languages) for (const label of labels) for (const role of [typography.controlStrong, typography.heading]) {
      expect(measureWord(nativeCatalogLabel(language, label), { ...role, fontSize: 11 })).toBeGreaterThan(0);
    }
  });

  it('keeps its scroll viewport below the safe top even after the header scrolls away', async () => {
    await render(1, 264, groups, 87);
    const scroll = host.querySelector('[data-scroll]')!;
    expect(style(scroll).marginTop).toBe(87);
    expect(JSON.parse(scroll.getAttribute('data-content-style')!).paddingTop ?? 0).toBe(0);
  });

  it('gives campaign administration an icon unused by the other admin drawer destinations', () => {
    const admin = STAFF_HAT_FUNCTIONS.admin[0]!;
    const items = withMyCampaignGroup(featureGroupsForRoles(['admin'])).flatMap(group => group.items);
    expect(items.filter(item => item.icon === admin.icon).map(item => item.key)).toEqual([admin.key]);
  });

  it('shows My campaign and Votes once, without an empty My campaign section', async () => {
    await render(1, 264, withMyCampaignGroup(featureGroupsForRoles([])));
    for (const label of ['My campaign', 'Votes']) {
      expect([...host.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === label)).toHaveLength(1);
      expect([...host.querySelectorAll('span')].filter(span => span.textContent === label)).toHaveLength(1);
    }
  });

  it('keeps customization reachable and restores an unpinned destination to the directory', async () => {
    await render(1, 280);
    expect(host.textContent).not.toContain('No features match that search.');
    const button = (label: string) => [...host.querySelectorAll('button')].find(entry => entry.getAttribute('aria-label') === label)!;
    await act(async () => { button('Customize shortcuts').click(); });
    await act(async () => { button('Remove Collective bargaining shortcut').click(); });
    expect(shortcutButtons()).toHaveLength(3);
    expect(button('Collective bargaining')).toBeDefined();
    await act(async () => { button('Add Collective bargaining shortcut').click(); });
    expect(shortcutButtons()).toHaveLength(4);
    await act(async () => { button('Done customizing shortcuts').click(); });
    expect(button('Collective bargaining')).toBeDefined();
    fits(280);
  });

  it('keeps every destination, its order and a 48 dp target after a text-size change', async () => {
    await render(1, 280);
    await render(2, 211);
    const buttons = shortcutButtons();
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(names);
    expect(buttons.every((button) => style(button).minHeight === 48)).toBe(true);
    fits(211);
    await act(async () => { buttons[3]?.click(); });
    expect(runtime.push).toHaveBeenCalledWith('/feature/grievance-casework');
  });

  it('keeps four columns when measured words fit, then reflows as the rail narrows', async () => {
    runtime.window.scale = 3;
    await render(1, 400);
    fits(400);
    expect(Number(style(shortcutButtons()[0]).width)).toBe((400 - 3 * spacing.sm) / 4);
    await render(1, 211);
    fits(211);
    expect(Number(style(shortcutButtons()[0]).width)).toBe(304 / 3);
  });

  it.each([2, 2.625, 3])('keeps all four cells on a pixel grid within a fractional rail at density %s', async density => {
    runtime.window.scale = density;
    // 264 1/3pt is a real 3x pixel boundary. These short labels permit four
    // columns; long default labels would reflow and miss the orphan-cell case.
    const shortGroups = groups.map((group, index) => ({ ...group, items: group.items.map(item => ({ ...item, label: ['One', 'Two', 'Three', 'Four'][index]! })) }));
    const railWidth = 793 / 3;
    await render(1, railWidth, shortGroups);
    const buttons = shortcutButtons();
    expect(buttons).toHaveLength(4);
    const cellWidth = Number(style(buttons[0]).width);
    expect(cellWidth).toBeLessThanOrEqual((railWidth - 3 * spacing.sm) / 4);
    expect(cellWidth * density).toBeCloseTo(Math.floor(cellWidth * density), 10);
    // Yoga accumulates in float32 and wraps on strict >, with no tolerance.
    const f32 = Math.fround;
    let used = 0;
    for (let index = 0; index < 4; index++) {
      if (index > 0) used = f32(used + spacing.sm);
      used = f32(used + f32(cellWidth));
    }
    expect(used).toBeLessThanOrEqual(f32(railWidth));
    fits(railWidth);
  });
});
