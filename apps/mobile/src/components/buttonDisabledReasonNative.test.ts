// @vitest-environment jsdom
// #9481 gate round 1 (r1s1, r2s1): React Native's Pressable lets an explicit
// `disabled` prop replace accessibilityState.disabled, so a blocked button that
// passed disabled={false} was announced as enabled. This suite runs the shared
// Button through the real PressableScale and React Native 0.86's own
// Pressable.js (Flow stripped by the app's Babel), with only Pressable's native
// leaves stubbed: the host View records the props it would send to VoiceOver
// and TalkBack, and the press hook applies Pressability's own refusal rule,
// which a source check below pins.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as React from 'react';
import { act, createElement as h, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HostProps = { accessibilityState?: { disabled?: boolean }; accessibilityHint?: string; onClick?: () => void; children?: React.ReactNode };
type PressConfig = { disabled?: boolean | null; onPress?: (() => void) | null };
const native = vi.hoisted(() => ({ host: null as HostProps | null, config: null as PressConfig | null }));
const announced = vi.hoisted(() => vi.fn<(message: string) => () => void>());

const requireHere = createRequire(import.meta.url);
const pressableSource = join(dirname(requireHere.resolve('react-native/package.json')), 'Libraries/Components/Pressable/Pressable.js');
const pressabilitySource = join(dirname(requireHere.resolve('react-native/package.json')), 'Libraries/Pressability/Pressability.js');

// React Native's own Pressable component, compiled from its shipped source.
function realPressable(): React.ComponentType<Record<string, unknown>> {
  const babel = requireHere('@babel/core') as { transformSync: (code: string, options: object) => { code: string } | null };
  const compiled = babel.transformSync(readFileSync(pressableSource, 'utf8'), {
    babelrc: false, configFile: false, filename: pressableSource,
    plugins: [requireHere.resolve('babel-plugin-syntax-hermes-parser'), requireHere.resolve('@babel/plugin-transform-flow-strip-types'),
      [requireHere.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }], requireHere.resolve('@babel/plugin-transform-modules-commonjs')],
  })!.code;
  const View = (props: HostProps) => { native.host = props; return h('div', { role: 'button', onClick: props.onClick }, props.children); };
  const stubs: Record<string, unknown> = {
    react: React,
    '../View/View': { __esModule: true, default: View },
    '../../Pressability/usePressability': { __esModule: true, default: (config: PressConfig) => {
      native.config = config;
      // Pressability.js: `if (onPress != null && disabled !== true)`.
      return { onClick: () => { if (config.onPress != null && config.disabled !== true) config.onPress(); } };
    } },
    '../../Pressability/PressabilityDebug': { PressabilityDebugView: () => null },
    '../../Utilities/useMergeRefs': { __esModule: true, default: () => undefined },
    './useAndroidRippleForView': { __esModule: true, default: () => null },
  };
  const module = { exports: {} as { default?: React.ComponentType<Record<string, unknown>> } };
  const load = (name: string) => { if (!(name in stubs)) throw new Error(`Pressable imports ${name}`); return stubs[name]; };
  new Function('require', 'module', 'exports', '__DEV__', compiled)(load, module, module.exports, false);
  return module.exports.default!;
}

vi.mock('react-native', () => ({
  Pressable: realPressable(),
  Animated: {
    Value: class { setValue() {} interpolate() { return 0; } },
    spring: () => ({ start() {}, stop() {} }),
    View: ({ children }: PropsWithChildren) => h('span', null, children),
    ScrollView: 'div', event: vi.fn(),
  },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, flatten: (style: unknown) => style },
  View: ({ children }: PropsWithChildren) => h('div', null, children),
  ScrollView: ({ children }: PropsWithChildren) => h('div', null, children),
  RefreshControl: () => null,
  ActivityIndicator: () => null,
}));
vi.mock('./Text', () => ({ Text: ({ children }: PropsWithChildren) => h('span', null, children), TextInput: () => null }));
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
async function render(props: { disabled?: boolean; disabledReason?: string; busy?: boolean }) {
  await act(async () => root.render(h(Button, { label: 'Change password', onPress, ...props })));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.host = null; native.config = null;
  onPress.mockReset(); announced.mockReset().mockReturnValue(() => {});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('shared Button through React Native\'s own Pressable', () => {
  it('pins the two Pressable rules this suite depends on to the installed source', () => {
    expect(readFileSync(pressableSource, 'utf8')).toContain('disabled != null ? {..._accessibilityState, disabled} : _accessibilityState;');
    expect(readFileSync(pressabilitySource, 'utf8')).toContain('if (onPress != null && disabled !== true) {');
  });

  it('announces a blocked button with a reason as disabled, and a press explains instead of acting', async () => {
    await render({ disabled: true, disabledReason: reason });
    expect(native.host?.accessibilityState?.disabled).toBe(true);
    expect(native.host?.accessibilityHint).toBe(reason);
    expect(native.config?.disabled).not.toBe(true);
    await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
    expect(announced).toHaveBeenCalledWith(reason);
    expect(onPress).not.toHaveBeenCalled();
    expect(host.textContent).toBe(`Change password${reason}`);
  });

  it('keeps an available button enabled and a blocked one without a reason inert', async () => {
    await render({ disabled: false });
    expect(native.host?.accessibilityState?.disabled).toBe(false);
    await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
    expect(onPress).toHaveBeenCalledTimes(1);
    await render({ disabled: true });
    expect(native.host?.accessibilityState?.disabled).toBe(true);
    expect(native.config?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(announced).not.toHaveBeenCalled();
  });
});
