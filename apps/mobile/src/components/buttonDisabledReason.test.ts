// @vitest-environment jsdom
// BUG-UG-BLOCKED-BUTTON-GIVES-NO-REASON-SIGN-IN-AND-ACCOUNT-20261122
// (#9458): the shared phone Button can carry why it is unavailable. With a
// reason, a disabled button stays pressable, speaks as dimmed with the reason
// as its hint, and a press refuses the action, shows the reason under the
// button and announces it. Without one it behaves exactly as before.
import { act, createElement as h, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announced = vi.hoisted(() => vi.fn<(message: string) => () => void>());
vi.mock('react-native', () => ({
  Animated: { ScrollView: 'div', View: 'div', event: vi.fn() },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, flatten: (style: unknown) => style },
  View: ({ children }: PropsWithChildren) => h('div', null, children),
  ScrollView: ({ children }: PropsWithChildren) => h('div', null, children),
  RefreshControl: () => null,
  ActivityIndicator: () => h('span', { 'data-testid': 'spinner' }),
}));
vi.mock('./Text', () => ({
  Text: ({ children }: PropsWithChildren) => h('span', null, children),
  TextInput: () => null,
}));
vi.mock('./PressableScale', () => ({
  usePressSpring: () => ({}),
  PressableScale: ({ children, disabled, onPress, accessibilityHint, accessibilityState }: PropsWithChildren<{
    disabled?: boolean; onPress?: () => void; accessibilityHint?: string; accessibilityState?: { disabled?: boolean; busy?: boolean };
  }>) => h('button', { disabled, 'aria-disabled': accessibilityState?.disabled ? 'true' : undefined,
    'aria-busy': accessibilityState?.busy ? 'true' : undefined, 'aria-description': accessibilityHint, onClick: onPress }, children),
}));
vi.mock('./useWordFit', () => ({ useWordFit: () => ({ onLayout: undefined, allowFontScaling: true, style: null }) }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: vi.fn(), useAccessibilityAnnouncementQueue: () => announced }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-screens/experimental', () => ({ ScrollViewMarker: 'div' }));
vi.mock('../lib/chrome', () => ({}));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('./FontScaleRelayout', () => ({ FontScaleRelayout: 'div' }));
vi.mock('./ScreenKeyboardReveal', () => ({ ScreenKeyboardReveal: 'div', useRevealAboveKeyboard: () => undefined }));
vi.mock('./PinnedHeader', () => ({ usePinnedHeaderChrome: () => null, useScreenNameAlreadySpoken: () => false }));
vi.mock('./RowHighlight', () => ({ HighlightList: 'div', HighlightRow: 'div' }));
vi.mock('./keyboardDismissGesture', () => ({ keyboardDismissModeFor: () => 'none' }));
vi.mock('./TopChrome', () => ({ TopRamp: 'div' }));
vi.mock('./optionPicker', () => ({ OptionPicker: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({
  primary: '#111', primaryForeground: '#fff', muted: '#eee', mutedForeground: '#555', destructive: '#900', foreground: '#111', border: '#333',
}) }));

const { Button } = await import('./ui');

let root: Root;
let host: HTMLDivElement;
const onPress = vi.fn();
const reason = 'Too short: 20 of the 24 characters needed.';
const control = () => host.querySelector('button')!;
async function render(props: { disabled?: boolean; disabledReason?: string; busy?: boolean }) {
  await act(async () => root.render(h(Button, { label: 'Change password', onPress, ...props })));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onPress.mockReset(); announced.mockReset().mockReturnValue(() => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('shared phone Button with a reason it is unavailable', () => {
  it('stays pressable, speaks as dimmed with the reason, and a press explains instead of acting', async () => {
    await render({ disabled: true, disabledReason: reason });
    expect(control().disabled).toBe(false);
    expect(control().getAttribute('aria-disabled')).toBe('true');
    expect(control().getAttribute('aria-description')).toBe(reason);
    expect(host.textContent).toBe('Change password');
    await act(async () => control().click());
    expect(onPress).not.toHaveBeenCalled();
    expect(announced).toHaveBeenCalledWith(reason);
    expect(host.textContent).toBe(`Change password${reason}`);
    // The shown reason follows the current rule after the press.
    await render({ disabled: true, disabledReason: 'The two passwords do not match.' });
    expect(host.textContent).toBe('Change passwordThe two passwords do not match.');
  });

  it('forgets the press once the button is available, and acts on the next press', async () => {
    await render({ disabled: true, disabledReason: reason });
    await act(async () => control().click());
    expect(host.textContent).toBe(`Change password${reason}`);
    await render({ disabled: false, disabledReason: '' });
    expect(host.textContent).toBe('Change password');
    expect(control().hasAttribute('aria-description')).toBe(false);
    await act(async () => control().click());
    expect(onPress).toHaveBeenCalledTimes(1);
    await render({ disabled: true, disabledReason: reason });
    expect(host.textContent).toBe('Change password');
  });

  it.each([
    { name: 'disabled with no reason', props: { disabled: true } },
    { name: 'busy with a reason', props: { disabled: true, busy: true, disabledReason: reason } },
  ])('keeps the old inert button when $name', async ({ props }) => {
    await render(props);
    expect(control().disabled).toBe(true);
    expect(control().hasAttribute('aria-description')).toBe(false);
    await act(async () => control().click());
    expect(onPress).not.toHaveBeenCalled();
    expect(announced).not.toHaveBeenCalled();
    expect(host.textContent).toBe('Change password');
  });
});
