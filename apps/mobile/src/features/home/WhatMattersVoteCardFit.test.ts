// @vitest-environment jsdom
// BUG-UG-NATIVE-VOTE-CARD-EMPTY-BAND-AT-LARGEST-TEXT-IOS-20261103: at
// the largest iPhone text size the Home vote card kept an empty band between
// its title and "Closes Nov 13". The title's word fit capped it through
// maxFontSizeMultiplier, which React Native's text measure cache leaves out of
// its key, so the capped title reused the height measured for the full-size
// title it replaced. The card is rendered here through the real Heading and
// Body, so the title must be drawn at the same explicit sizes it is measured
// at, and keep the default size's line spacing.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';

import { WORD_FIT_GLYPH_EM } from '../../lib/wordFit';
import { resolveTheme } from '../../theme/tokens';

type TextProps = { onLayout?: (event: LayoutChangeEvent) => void; allowFontScaling?: boolean; maxFontSizeMultiplier?: number; style?: unknown };

const runtime = vi.hoisted(() => ({ fontScale: 1, texts: new Map<string, TextProps>() }));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const words = (children: unknown): string => Array.isArray(children) ? children.map(words).join('') : typeof children === 'string' ? children : '';
  const box = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: box,
    Animated: { View: box },
    Text: ({ children, ...props }: TextProps & { children?: ReactNode }) => { runtime.texts.set(words(children), props); return h('span', null, children); },
    Pressable: ({ children }: { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode) }) => h('button', null, typeof children === 'function' ? children({ pressed: false }) : children),
    StyleSheet: { create: <T,>(value: T) => value },
    Platform: { OS: 'ios' },
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: runtime.fontScale }),
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('react-native-safe-area-context', () => ({}));
vi.mock('react-native-screens/experimental', () => ({}));
vi.mock('../../services/haptics', () => ({ haptics: { select: async () => {} } }));
vi.mock('../../services/memberHomeAttention', () => ({}));
vi.mock('../../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => resolveTheme('union-ground') }));
// The shared Button's disabled reason (#9458) takes the per-owner announcement queue.
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => () => () => {} }));
vi.mock('../../lib/chrome', () => ({}));
vi.mock('../../lib/reduceMotion', () => ({}));
vi.mock('../../components/FontScaleRelayout', () => ({}));
vi.mock('../../components/ScreenKeyboardReveal', () => ({}));
vi.mock('../../components/PinnedHeader', () => ({ useScreenNameAlreadySpoken: () => ({ duplicate: false, hiddenProps: {} }) }));
vi.mock('../../components/NumberFlow', () => ({}));
vi.mock('../../components/PressableScale', () => ({
    usePressSpring: () => ({}),
    PressableScale: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => createElement('button', { onClick: onPress }, children),
}));
vi.mock('../../components/RowHighlight', () => ({}));
vi.mock('../../components/keyboardDismissGesture', () => ({}));
vi.mock('../../components/TopChrome', () => ({}));

import { WhatMattersNowSection } from './WhatMattersNow';

// React Native's fontScale at the largest iPhone accessibility size.
const LARGEST = 3.571;
const TITLE = 'When should general membership meetings start?';
const vote = { kind: 'open_vote', urgency: 'info', ballot: { id: 'b1', title: TITLE, closesAt: '2026-11-13T17:00:00.000Z' }, action: { kind: 'vote', ballotId: 'b1' } } as const;

let root: Root, host: HTMLDivElement;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}
function text(match: (words: string) => boolean): TextProps {
  const found = [...runtime.texts].find(([words]) => match(words));
  if (!found) throw new Error('text not rendered');
  return found[1];
}
const layout = (width: number) => ({ nativeEvent: { layout: { width, height: 400, x: 0, y: 0 } } }) as LayoutChangeEvent;
async function renderCard() {
  await act(async () => { root.render(createElement(WhatMattersNowSection, { item: vote, status: 'ready', onRetry: () => {} })); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.fontScale = LARGEST;
  runtime.texts.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the Home vote card at the largest text size', () => {
  it('draws the capped vote title at the explicit sizes its height is measured at', async () => {
    await renderCard();
    await act(async () => { text((words) => words === TITLE).onLayout!(layout(252)); });
    const title = text((words) => words === TITLE);
    // The title is a Heading, fitted with Archivo's allowance (#8928).
    const cap = 252 / (10 * 17 * WORD_FIT_GLYPH_EM.heading);
    expect(title).not.toHaveProperty('maxFontSizeMultiplier');
    expect(title.allowFontScaling).toBe(false);
    expect(flatten(title.style).fontSize).toBeCloseTo(17 * cap, 5);
    expect(flatten(title.style).lineHeight).toBeCloseTo(23 * cap, 5);
  });

  it('keeps the default size\'s line spacing for the title and leaves "Closes" at the system size', async () => {
    await renderCard();
    await act(async () => { text((words) => words === TITLE).onLayout!(layout(252)); });
    const title = flatten(text((words) => words === TITLE).style);
    expect(Number(title.lineHeight) / Number(title.fontSize)).toBeCloseTo(23 / 17, 5);
    const closes = text((words) => words.startsWith('Closes '));
    expect(closes).not.toHaveProperty('maxFontSizeMultiplier');
    expect(closes.allowFontScaling).toBeUndefined();
    expect(flatten(closes.style)).toMatchObject({ fontSize: 16, lineHeight: 23 });
  });

  it('leaves the vote title at the system size at the default text size', async () => {
    runtime.fontScale = 1;
    await renderCard();
    await act(async () => { text((words) => words === TITLE).onLayout!(layout(252)); });
    const title = text((words) => words === TITLE);
    expect(title).not.toHaveProperty('maxFontSizeMultiplier');
    expect(title.allowFontScaling).toBeUndefined();
    expect(flatten(title.style)).toMatchObject({ fontSize: 17, lineHeight: 23 });
  });
});
