// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { caseworkCard } from '../lib/pulseCasework';
import type { PulseCard } from '../lib/pulseCatalog';
import { resolveTheme } from '../theme/tokens';

// #8927 slice 3: the Casework charts in the real Pulse card frame. A withheld
// or unavailable chart draws its note and no columns; a released run of weeks
// draws one column per released week, named by its date.
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
const starts = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'];

async function render(card: PulseCard, sheet = false) {
  await act(async () => { root.render(sheet ? createElement(PulseExpandSheet, { card, onClose: () => undefined }) : createElement(PulseCatalogCard, { card, onOpen: () => undefined })); });
}
const columns = () => host.querySelectorAll('svg path').length;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  runtime.language = 'en';
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Issue work charts in the Pulse frame (real renderer)', () => {
  it.each([false, true])('draws a withheld chart as its note with no columns or figures (sheet: %s)', async (sheet) => {
    await render(caseworkCard('ready:open-overdue', { state: 'withheld', open: null, overdue: null, resolvedThisMonth: null }), sheet);
    expect(host.textContent).toContain('Withheld: a group of people behind these figures is too small to share safely.');
    expect(columns()).toBe(0);
    expect(host.textContent).not.toMatch(/Open\s*\d|Overdue\s*\d/);
  });

  it('draws an unavailable chart as unavailable, never as zero', async () => {
    await render(caseworkCard('ready:casework', { state: 'unavailable', reason: 'no_grievance_procedure' }));
    expect(host.textContent).toContain('No issue process is set up for this campaign');
    expect(columns()).toBe(0);
    expect(host.textContent).not.toContain('0');
  });

  it('draws one column per released week and leaves a withheld week out, with its note', async () => {
    const weeks = starts.map((weekStart, index) => index >= 6 ? { weekStart, state: 'ready', resolved: 25, meanDays: index === 7 ? 10.4 : 12 } : { weekStart, state: 'withheld' });
    await render(caseworkCard('ready:days-to-resolve', { state: 'ready', weeks, comparison: null }));
    expect(columns()).toBe(2);
    expect(host.querySelector('[data-role="image"]')?.getAttribute('aria-label')).toBe('Week of November 9: 12. Week of November 16: 10.4');
    expect(host.textContent).toContain('6 weeks are withheld');
    expect(host.textContent).toContain('week of Nov 16');
  });

  it('draws a Spanish workspace’s withheld note and spoken week names in Spanish', async () => {
    runtime.language = 'es';
    const weeks = starts.map((weekStart, index) => index === 7 ? { weekStart, state: 'ready', cohort: 30, resolved: 15, percentage: 50 } : { weekStart, state: 'withheld' });
    await render(caseworkCard('ready:resolution-rate', { state: 'ready', weeks }, 'es'));
    expect(host.querySelector('[data-role="image"]')?.getAttribute('aria-label')).toBe('Semana del 16 de noviembre: 50');
    expect(host.textContent).toContain('Tasa de resolución');
    expect(host.textContent).toContain('7 semanas están ocultas');
    expect(host.textContent).not.toMatch(/Week of|withheld|Resolution rate/);
  });
});

