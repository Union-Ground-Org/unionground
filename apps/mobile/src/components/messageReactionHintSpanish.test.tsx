// @vitest-environment jsdom
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';

// Ledger 119 follow-up to UX-UG-NATIVE-MESSAGE-ACTIONS-POLISH-BATCH-20261111
// (#8304): the reaction chips' hints and the iOS announcement of a failed
// conversation send stayed English for a member who saved Spanish.
const state = vi.hoisted(() => ({ language: 'es' as 'en' | 'es' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-svg', () => {
  const Shape = () => null;
  return { default: Shape, Circle: Shape, Line: Shape, Path: Shape, Polygon: Shape, Rect: Shape };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: state.language, dashboard: null }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('./NumberFlow', () => ({ NumberFlow: () => null }));

import { MessageReactionButton } from './MessageReactions';
import { nativeCatalogLabel } from '../lib/nativeUiCopy';

let screen: Rendered | null = null;
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

const hints = () => [...screen!.container.querySelectorAll('[aria-description]')].map((node) => node.getAttribute('aria-description'));

describe.each(['ios', 'android'] as const)('reaction hints in the saved language on %s', (os) => {
  it.each([
    ['es', ['Quita tu reacción.', 'Agrega tu reacción.']],
    ['en', ['Removes your reaction.', 'Adds your reaction.']],
  ] as const)('reads the %s hints', async (language, expected) => {
    setPlatform(os); state.language = language;
    screen = await render(h('div', null,
      h(MessageReactionButton, { entry: { kind: 'thumbs_up', mine: true, count: 2 }, onPress: () => undefined, showCount: true, chip: true }),
      h(MessageReactionButton, { entry: { kind: 'heart', mine: false, count: 1 }, onPress: () => undefined, showCount: true, chip: true })));
    expect(hints()).toEqual(expected);
  });
});

describe('the iOS announcement of a failed conversation send', () => {
  const source = readFileSync(fileURLToPath(new NodeURL('../../app/conversation/[id].tsx', import.meta.url)), 'utf8');
  it('announces the saved-language text the alert shows', () => {
    // voiceoverQ19.test.ts pins the announcement line itself.
    expect(source).toContain("Platform.OS === 'ios') announceFor");
    expect(source).toContain('(nativeCatalogLabel(language, sendError));');
    const errors = [...source.matchAll(/setSendError\('([^']+)'\)/g)].map((match) => match[1]!);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    for (const error of errors) {
      expect(nativeCatalogLabel('es', error), error).not.toBe(error);
      expect(nativeCatalogLabel('en', error)).toBe(error);
    }
  });
});
