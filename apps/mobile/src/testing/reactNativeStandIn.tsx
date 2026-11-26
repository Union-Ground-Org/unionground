// TEST-UG-PHONE-TESTS-EXECUTE-SCREENS-ON-ONE-SHARED-STAND-IN-20261111 (#8319):
// one React Native stand-in for phone screen tests that execute the screen in
// jsdom instead of reading its source. Use it with
//   vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// and a `// @vitest-environment jsdom` first line. It keeps three platform
// rules the per-file mocks dropped:
//   1. An `accessible` container is ONE element for VoiceOver and TalkBack:
//      its children are hidden from assistive technology.
//   2. A press reaches the handler of the element pressed, and only that one.
//   3. The platform (iOS or Android) can be switched per test (setPlatform).
import { act, createElement as h, Fragment, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Children = ReactNode | ((state: { pressed: boolean }) => ReactNode);
type A11yProps = {
  children?: Children;
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityHint?: string;
  accessibilityState?: { disabled?: boolean; selected?: boolean; checked?: boolean | 'mixed'; expanded?: boolean; busy?: boolean };
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: 'auto' | 'yes' | 'no' | 'no-hide-descendants';
  accessibilityViewIsModal?: boolean;
  onAccessibilityEscape?: () => void;
  testID?: string;
};

// Rule 3: the platform the screen reads, switchable per test.
export const Platform = {
  OS: 'ios' as 'ios' | 'android',
  Version: 18,
  // As React Native 0.86 does: a platform key that is present wins even when
  // its value is null or undefined; only an absent key falls through.
  select<T>(options: { ios?: T; android?: T; native?: T; default?: T }): T | undefined {
    if (Platform.OS in options) return options[Platform.OS];
    return 'native' in options ? options.native : options.default;
  },
};
export function setPlatform(os: 'ios' | 'android'): void {
  Platform.OS = os;
}

// Escape handlers registered by views on screen (VoiceOver's two-finger scrub).
const escapeHandlers = new Set<() => void>();
export function accessibilityEscape(): void {
  for (const handler of [...escapeHandlers]) handler();
}

const content = (children: Children | undefined) => (typeof children === 'function' ? children({ pressed: false }) : children);

function hostProps(props: A11yProps, role?: string) {
  const hidden = props.accessibilityElementsHidden || props.importantForAccessibility === 'no-hide-descendants';
  return {
    role: role ?? props.accessibilityRole,
    'aria-label': props.accessibilityLabel,
    'aria-description': props.accessibilityHint,
    'aria-disabled': props.accessibilityState?.disabled || undefined,
    'aria-selected': props.accessibilityState?.selected,
    'aria-checked': props.accessibilityState?.checked,
    'aria-expanded': props.accessibilityState?.expanded,
    'aria-busy': props.accessibilityState?.busy,
    'aria-hidden': hidden ? 'true' : undefined,
    'aria-modal': props.accessibilityViewIsModal ? 'true' : undefined,
    'data-testid': props.testID,
  };
}

// Rule 1: an accessible element's children are reachable by sight, not by
// assistive technology.
function grouped(props: A11yProps, children: Children | undefined) {
  return props.accessible ? h('div', { 'aria-hidden': 'true' }, content(children)) : content(children);
}

function Escape({ handler }: { handler?: () => void }) {
  useEffect(() => {
    if (!handler) return undefined;
    escapeHandlers.add(handler);
    return () => { escapeHandlers.delete(handler); };
  }, [handler]);
  return null;
}

export function View(props: A11yProps & { onLayout?: unknown; style?: unknown }) {
  const role = props.accessible ? props.accessibilityRole ?? 'group' : props.accessibilityRole;
  return h('div', hostProps(props, role), h(Escape, { handler: props.onAccessibilityEscape }), grouped(props, props.children));
}

export function Text(props: A11yProps & { onPress?: () => void; numberOfLines?: number; style?: unknown }) {
  const role = props.accessibilityRole === 'header' ? 'heading' : props.accessibilityRole;
  if (props.onPress) return Pressable({ ...props, accessibilityRole: props.accessibilityRole ?? 'link' });
  return h('span', hostProps(props, role), content(props.children));
}

type PressProps = A11yProps & { onPress?: (event: { nativeEvent: object }) => void; onLongPress?: () => void; disabled?: boolean; style?: unknown };

// Rule 1 and rule 2: a pressable is accessible by default (its children are
// one element with it), and a press stops at the pressed element.
export function Pressable(props: PressProps) {
  const disabled = props.disabled || props.accessibilityState?.disabled;
  // A div with a role, so a pressable inside a pressable stays valid DOM.
  return h('div', {
    ...hostProps(props, props.accessibilityRole ?? 'button'),
    'aria-disabled': disabled || undefined,
    onClick: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      if (!disabled) props.onPress?.({ nativeEvent: {} });
    },
  }, grouped({ ...props, accessible: props.accessible !== false }, props.children));
}
export const TouchableOpacity = Pressable;
export const TouchableHighlight = Pressable;
export const TouchableWithoutFeedback = Pressable;

export function TextInput(props: A11yProps & {
  value?: string; defaultValue?: string; placeholder?: string; multiline?: boolean; editable?: boolean;
  secureTextEntry?: boolean; maxLength?: number; onChangeText?: (value: string) => void; onSubmitEditing?: () => void;
  onFocus?: () => void; onBlur?: () => void;
}) {
  return h(props.multiline ? 'textarea' : 'input', {
    ...hostProps(props, props.accessibilityRole),
    value: props.value ?? props.defaultValue ?? '',
    placeholder: props.placeholder,
    maxLength: props.maxLength,
    disabled: props.editable === false || undefined,
    type: props.multiline ? undefined : props.secureTextEntry ? 'password' : 'text',
    onChange: (event: { target: { value: string } }) => props.onChangeText?.(event.target.value),
    onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') props.onSubmitEditing?.(); },
    onFocus: props.onFocus ? () => props.onFocus?.() : undefined,
    onBlur: props.onBlur ? () => props.onBlur?.() : undefined,
  });
}

export function Switch(props: A11yProps & { value?: boolean; disabled?: boolean; onValueChange?: (value: boolean) => void }) {
  return h('div', {
    ...hostProps(props, 'switch'), 'aria-checked': Boolean(props.value), 'aria-disabled': props.disabled || undefined,
    onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); if (!props.disabled) props.onValueChange?.(!props.value); },
  });
}

export function Modal(props: { visible?: boolean; children?: ReactNode; onRequestClose?: () => void }) {
  return props.visible === false ? null : h('div', { role: 'dialog' }, props.children);
}

export function ScrollView(props: A11yProps & { refreshControl?: ReactNode }) {
  return h('div', hostProps(props), props.refreshControl, content(props.children));
}
export const KeyboardAvoidingView = View;
export const SafeAreaView = View;
export function ActivityIndicator(props: A11yProps) {
  return h('span', hostProps(props, 'progressbar'));
}
export function Image(props: A11yProps) {
  return h('img', { ...hostProps(props, props.accessibilityLabel ? 'img' : undefined), alt: props.accessibilityLabel ?? '' });
}
export function RefreshControl() {
  return null;
}

type ListProps<T> = A11yProps & {
  data?: readonly T[] | null;
  renderItem: (info: { item: T; index: number }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  ListHeaderComponent?: ReactNode | (() => ReactNode);
  ListEmptyComponent?: ReactNode | (() => ReactNode);
  ListFooterComponent?: ReactNode | (() => ReactNode);
};
const slot = (value: ReactNode | (() => ReactNode)) => (typeof value === 'function' ? value() : value);
export function FlatList<T>(props: ListProps<T>) {
  const data = props.data ?? [];
  return h('div', hostProps(props), slot(props.ListHeaderComponent),
    data.length ? data.map((item, index) => h(Fragment, { key: props.keyExtractor?.(item, index) ?? String(index) }, props.renderItem({ item, index })))
      : slot(props.ListEmptyComponent),
    slot(props.ListFooterComponent));
}
export function SectionList<T>(props: Omit<ListProps<T>, 'data'> & { sections: readonly { data: readonly T[]; key?: string }[]; renderSectionHeader?: (info: { section: { data: readonly T[] } }) => ReactNode }) {
  return h('div', hostProps(props), props.sections.map((section, sectionIndex) => h(Fragment, { key: section.key ?? String(sectionIndex) },
    props.renderSectionHeader?.({ section }),
    section.data.map((item, index) => h(Fragment, { key: props.keyExtractor?.(item, index) ?? String(index) }, props.renderItem({ item, index }))))));
}

export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  flatten: (style: unknown) => (Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style ?? {}),
  compose: (a: unknown, b: unknown) => [a, b],
  hairlineWidth: 1,
  absoluteFill: {},
  absoluteFillObject: {},
};

class AnimatedValue {
  constructor(private value: number) {}
  setValue(value: number) { this.value = value; }
  interpolate() { return this; }
  addListener() { return 'listener'; }
  removeListener() {}
  removeAllListeners() {}
  stopAnimation(callback?: (value: number) => void) { callback?.(this.value); }
}
const animation = { start: (callback?: (result: { finished: boolean }) => void) => callback?.({ finished: true }), stop: () => {}, reset: () => {} };
export const Animated = {
  Value: AnimatedValue,
  View, Text, ScrollView, Image, FlatList,
  createAnimatedComponent: <T,>(component: T) => component,
  timing: () => animation, spring: () => animation, decay: () => animation,
  sequence: () => animation, parallel: () => animation, stagger: () => animation, loop: () => animation, delay: () => animation,
  event: () => () => {},
  add: (a: AnimatedValue) => a, multiply: (a: AnimatedValue) => a, diffClamp: (a: AnimatedValue) => a,
};

const subscription = { remove: () => {} };
export const Alert = { alert: () => {} };
export const Linking = { openURL: async () => true, canOpenURL: async () => true, getInitialURL: async () => null, addEventListener: () => subscription };
export const Keyboard = { dismiss: () => {}, addListener: () => subscription };
export const AccessibilityInfo = {
  announceForAccessibility: () => {}, announceForAccessibilityWithOptions: () => {}, setAccessibilityFocus: () => {},
  isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => subscription,
};
export const BackHandler = { addEventListener: () => subscription, exitApp: () => {} };
export const AppState = { currentState: 'active', addEventListener: () => subscription };
export const Dimensions = { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }), addEventListener: () => subscription };
export const PixelRatio = { get: () => 3, getFontScale: () => 1, roundToNearestPixel: (value: number) => value };
export const I18nManager = { isRTL: false };
export const LayoutAnimation = { configureNext: () => {}, Presets: { easeInEaseOut: {} }, create: () => ({}) };
export const Share = { share: async () => ({ action: 'sharedAction' }) };
export const Vibration = { vibrate: () => {} };
export const findNodeHandle = () => null;
export const useWindowDimensions = () => Dimensions.get();

// --- Rendering helpers --------------------------------------------------

export type Rendered = { container: HTMLElement; rerender: (element: ReactNode) => Promise<void>; unmount: () => Promise<void> };

export async function render(element: ReactNode): Promise<Rendered> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    rerender: async (next) => { await act(async () => root.render(next)); },
    unmount: async () => { await act(async () => root.unmount()); container.remove(); escapeHandlers.clear(); },
  };
}

// Whether assistive technology can reach this element: nothing above it (or
// it) is hidden.
export function reachable(element: Element): boolean {
  return !element.closest('[aria-hidden="true"]');
}

function nameOf(element: Element): string {
  return (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
}

// Elements a screen reader can land on: named controls, fields, headings and
// grouped elements, minus anything hidden.
export function exposedElements(container: Element): Element[] {
  return [...container.querySelectorAll('button, input, textarea, [role]')].filter(reachable);
}

export function exposedNames(container: Element): string[] {
  return exposedElements(container).map(nameOf).filter(Boolean);
}

// The control a screen reader announces with this name.
export function getExposed(container: Element, name: string | RegExp): HTMLElement {
  const match = exposedElements(container).find((element) => (typeof name === 'string' ? nameOf(element) === name : name.test(nameOf(element))));
  if (!match) throw new Error(`Nothing exposed as ${String(name)}; exposed: ${JSON.stringify(exposedNames(container))}`);
  return match as HTMLElement;
}

export async function press(element: Element): Promise<void> {
  await act(async () => { (element as HTMLElement).click(); });
}

export async function type(element: Element, value: string): Promise<void> {
  await act(async () => {
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
