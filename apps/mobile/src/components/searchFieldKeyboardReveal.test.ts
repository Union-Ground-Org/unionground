// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-MESSAGES-SEARCH-HIDDEN-BY-KEYBOARD-ANDROID-20261103:
// Messages' Search messages field (the shared SearchField) stayed behind the
// Android keyboard. A focused SearchField now asks the page to lift its whole
// row, and lets go on blur; the scroll itself is executed in
// ScreenKeyboardReveal.test.ts.

type InputProps = { accessibilityLabel?: string; onFocus?: () => void; onBlur?: () => void; value?: string };
const mocks = vi.hoisted(() => ({
  row: { measureInWindow: () => undefined },
  inputs: [] as InputProps[],
  reveal: vi.fn<(target: unknown) => void>(),
  release: vi.fn<(target: unknown) => void>(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: { default?: unknown }) => options.default },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Animated: { View: 'div', ScrollView: 'div', Value: class {}, event: () => () => undefined },
  ActivityIndicator: () => null,
  RefreshControl: () => null,
  ScrollView: () => null,
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  // The search row's host view: its ref resolves to the row the reveal measures.
  View: ({ children, ref }: { children?: ReactNode; ref?: { current: unknown } }) => {
    if (ref) ref.current = mocks.row;
    return createElement('div', null, children);
  },
  TextInput: (props: InputProps) => {
    mocks.inputs.push(props);
    return createElement('input', { 'aria-label': props.accessibilityLabel, readOnly: true, value: props.value });
  },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: () => null, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: () => null }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: () => undefined }));
vi.mock('../lib/chrome', () => ({}));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => false }));
vi.mock('./FontScaleRelayout', () => ({ FontScaleRelayout: () => null }));
vi.mock('./PinnedHeader', () => ({ usePinnedHeaderChrome: () => null, useScreenNameAlreadySpoken: () => ({ duplicate: false, hiddenProps: {} }) }));
vi.mock('./NumberFlow', () => ({ NumberFlow: () => null }));
vi.mock('./PressableScale', () => ({ PressableScale: () => null, usePressSpring: () => ({}) }));
vi.mock('./RowHighlight', () => ({ HighlightList: () => null, HighlightRow: () => null }));
vi.mock('../theme/elevation', () => ({ elevation: { level1: {}, level1HeroLift: {}, level2: {}, level3: {} } }));
vi.mock('../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('./TopChrome', () => ({ TopRamp: () => null }));
vi.mock('./ScreenKeyboardReveal', () => ({
  ScreenKeyboardReveal: ({ children }: { children?: ReactNode }) => children,
  useRevealAboveKeyboard: () => ({ reveal: mocks.reveal, release: mocks.release }),
}));

import { SearchField } from './ui';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.inputs.length = 0;
  mocks.reveal.mockClear();
  mocks.release.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SearchField keyboard reveal', () => {
  it('lifts its whole row above the keyboard when focused, and releases it on blur', async () => {
    const onChangeText = vi.fn();
    await act(async () => {
      root.render(createElement(SearchField, { value: 'grievance', onChangeText, placeholder: 'Search messages', accessibilityLabel: 'Search messages' }));
    });
    const input = mocks.inputs.at(-1);
    expect(input?.accessibilityLabel).toBe('Search messages');
    input?.onFocus?.();
    expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith(mocks.row);
    expect(mocks.release).not.toHaveBeenCalled();
    input?.onBlur?.();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(mocks.row);
    // Focusing scrolls only; the query is untouched.
    expect(onChangeText).not.toHaveBeenCalled();
    expect(input?.value).toBe('grievance');
  });
});
