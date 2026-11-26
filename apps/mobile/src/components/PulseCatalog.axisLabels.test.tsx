// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leadershipPulse } from '../lib/leadershipPulse';
import type { PulseCard } from '../lib/pulseCatalog';
import { resolveTheme } from '../theme/tokens';

// R-K10 (record #9341): drive the real chart renderer with an SVG host that
// preserves text, so removing the axis-label drawing fails here. The chart
// box's spoken name is read from the same host element a screen reader gets.
const runtime = vi.hoisted(() => ({ language: 'en' as 'en' | 'es' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: runtime.language, dashboard: null }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground', false) }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true, reduceMotionKnown: () => true }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native', async () => {
  const h = (await import('react')).createElement;
  const view = ({ children, accessibilityLabel, accessibilityRole }: { children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string }) =>
    h('div', { 'aria-label': accessibilityLabel, 'data-role': accessibilityRole }, children);
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: view, Text: text, TextInput: text, ScrollView: text,
    Modal: ({ children }: { children?: ReactNode }) => h('div', { role: 'dialog' }, children),
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress: () => void; accessibilityLabel?: string }) =>
      h('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
    StyleSheet: { create: <T,>(value: T) => value },
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  };
});
vi.mock('react-native-svg', async () => {
  const h = (await import('react')).createElement;
  return {
    default: ({ children }: { children?: ReactNode }) => h('svg', null, children),
    Line: () => null,
    Path: ({ d, fill }: { d?: string; fill?: string }) => h('path', { 'data-d': d, 'data-fill': fill }),
    Rect: () => null,
    Text: ({ children, x, y }: { children?: ReactNode; x?: number; y?: number }) => h('text', { 'data-x': String(x), 'data-y': String(y) }, children),
  };
});
vi.mock('./ui', async () => {
  const h = (await import('react')).createElement;
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Body: text, Heading: text, Card: text,
    Button: ({ label, onPress }: { label: string; onPress: () => void }) => h('button', { onClick: onPress }, label),
  };
});

import { PulseCatalogCard, PulseExpandSheet } from './PulseCatalog';

let root: Root, host: HTMLDivElement;
const date = new Date('2026-11-20T12:00:00-05:00');

function staffAccessCard(enrolled = 33): PulseCard {
  const pulse = leadershipPulse('admin', {
    floors: { privacy: 25, chapterHealth: 25 },
    mfa: { data: { staffTotal: 66, staffEnrolled: enrolled }, error: null },
  }, date);
  return pulse.cards.find((card) => card.id === 'access')!;
}

async function render(card: PulseCard) {
  await act(async () => { root.render(createElement(PulseCatalogCard, { card, onOpen: () => undefined })); });
}

/** Axis names under the bars, grouped by their drawn x, lines joined in y order. Grid ticks sit at x=318. */
function axisNames(): { x: number; name: string }[] {
  const groups = new Map<number, { y: number; line: string }[]>();
  for (const node of host.querySelectorAll('svg text')) {
    const x = Number(node.getAttribute('data-x'));
    if (x === 318) continue;
    groups.set(x, [...(groups.get(x) ?? []), { y: Number(node.getAttribute('data-y')), line: node.textContent ?? '' }]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([x, lines]) => ({ x, name: lines.sort((a, b) => a.y - b.y).map((entry) => entry.line).join(' ') }));
}

/** Bar centers parsed from the drawn column paths (M{x},… with the bar width in the top edge). */
function barCenters(): number[] {
  return [...host.querySelectorAll('svg path')].map((node) => {
    const d = node.getAttribute('data-d') ?? '';
    const start = Number(/^M([\d.]+),/.exec(d)?.[1]);
    return start + 11;
  });
}

function spokenChartName(): string {
  return host.querySelector('[data-role="image"]')?.getAttribute('aria-label') ?? '';
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  runtime.language = 'en';
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Pulse chart axis labels (real renderer)', () => {
  it.each(['card', 'sheet'])('renders the Staff access description in Spanish in the %s', async (surface) => {
    runtime.language = 'es';
    const card = staffAccessCard();
    if (surface === 'card') await render(card);
    else await act(async () => { root.render(createElement(PulseExpandSheet, { card, onClose: () => undefined })); });
    expect(host.textContent).toContain('Personal con acceso en esta organización ahora');
    expect(host.textContent).not.toContain('Staff with access in this organization now');
    expect(card.period).toBe('Staff with access in this organization now');
  });

  it('names every Staff access bar on the axis, at its bar, in English', async () => {
    await render(staffAccessCard());
    expect(axisNames().map((entry) => entry.name)).toEqual(['Staff accounts', 'Two-step enrolled', 'Two-step enrollment needed']);
    expect(axisNames().map((entry) => entry.x)).toEqual(barCenters());
    expect(spokenChartName()).toBe('Staff accounts: 66. Two-step enrolled: 33. Two-step enrollment needed: 33');
    expect(host.textContent).toContain('Two-step enrollment needed');
  });

  it('names every Staff access bar in Spanish when the app language is Spanish', async () => {
    runtime.language = 'es';
    await render(staffAccessCard());
    expect(axisNames().map((entry) => entry.name)).toEqual(['Cuentas del personal', 'Con verificación en dos pasos', 'Sin verificación en dos pasos']);
    expect(axisNames().map((entry) => entry.x)).toEqual(barCenters());
    expect(spokenChartName()).toBe('Cuentas del personal: 66. Con verificación en dos pasos: 33. Sin verificación en dos pasos: 33');
    expect(host.textContent).toContain('Sin verificación en dos pasos');
    expect(host.textContent).not.toContain('Staff accounts');
  });

  it('keeps member-authored names untranslated on the axis', async () => {
    runtime.language = 'es';
    const card: PulseCard = {
      id: 'meetings', number: '01', title: 'Can the campaign act?', category: 'meetings',
      period: 'Latest meetings', countedFrom: 'recorded check-ins.', notCounted: 'Future meetings excluded.',
      rows: [
        { label: 'Fiesta Anual · checked in', value: 30 },
        { label: 'Fiesta Anual · quorum target', value: 25 },
      ],
    };
    await render(card);
    expect(axisNames().map((entry) => entry.name)).toEqual(['Fiesta Anual · checked in', 'Fiesta Anual · quorum target']);
  });

  it('draws no chart labels for a privacy-hidden or empty card', async () => {
    await render(staffAccessCard(24));
    expect(axisNames()).toEqual([]);
    expect(host.querySelector('svg')).toBeNull();
    expect(host.textContent).toContain('Withheld');
    expect(host.textContent).not.toContain('Staff accounts');

    const empty: PulseCard = {
      id: 'empty', number: '02', title: 'Nothing recorded', category: 'chapter',
      period: 'Current', countedFrom: 'nothing.', notCounted: 'Everything else excluded.',
      rows: [], message: 'No recorded figures in this view.',
    };
    await render(empty);
    expect(host.querySelector('svg')).toBeNull();
    expect(host.textContent).toContain('No recorded figures in this view.');
  });

  it('keeps the labelled list, without axis names, when names cannot fit whole', async () => {
    const dense: PulseCard = {
      id: 'dense', number: '03', title: 'Dense breakdown', category: 'chapter',
      period: 'Current', countedFrom: 'recorded rows.', notCounted: 'Drafts excluded.',
      rows: Array.from({ length: 8 }, (_, index) => ({ label: `Category number ${index} with a long name`, value: index + 1 })),
    };
    await render(dense);
    const svgText = [...host.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ');
    expect(svgText).not.toContain('Category number');
    expect(barCenters()).toHaveLength(8);
    expect(host.textContent).toContain('Category number 7 with a long name');
    expect(spokenChartName()).toContain('Category number 0 with a long name: 1');
  });
});
