import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { featureGroupsForRoles, staffAuthorizedForScopes } from '../lib/hatFunctions';

const drawer = readFileSync(fileURLToPath(new URL('./QuickActionsDrawer.tsx', import.meta.url)), 'utf8');
const staffCapture = readFileSync(fileURLToPath(new URL('./StaffQuickCapture.tsx', import.meta.url)), 'utf8');
const layout = readFileSync(fileURLToPath(new URL('../../app/_layout.tsx', import.meta.url)), 'utf8');
const config = readFileSync(fileURLToPath(new URL('../../app.config.ts', import.meta.url)), 'utf8');
const capture = readFileSync(fileURLToPath(new URL('../services/quickCapture.ts', import.meta.url)), 'utf8');
const optionalFs = readFileSync(fileURLToPath(new URL('../services/optionalFileSystem.ts', import.meta.url)), 'utf8');
const optionalAudio = readFileSync(fileURLToPath(new URL('../services/optionalAudio.ts', import.meta.url)), 'utf8');

describe('right-edge quick-actions drawer contract', () => {
  it('wraps every routed screen from the root layout', () => {
    expect(layout).toContain('<QuickActionsDrawer>');
    expect(layout.indexOf('<QuickActionsDrawer>')).toBeLessThan(layout.indexOf('<Stack screenOptions'));
    expect(layout.indexOf('</Stack>')).toBeLessThan(layout.indexOf('</QuickActionsDrawer>'));
  });

  it('opens with a right-edge pan wide enough to clear the Android back band', () => {
    // Android gesture navigation consumes drags starting in its ~28px system
    // strip (Pixel 10a), so the Android band arms past it; iOS stays tight.
    expect(drawer).toContain("EDGE_PAN_WIDTH = Platform.select({ android: 64, default: 28 })");
    expect(drawer).toContain('startX >= widthRef.current - EDGE_PAN_WIDTH && gesture.dx < 0');
    expect(drawer).toContain('quickActionsPathEligible(pathname)');
    expect(drawer).toContain('Keyboard.dismiss()');
  });

  it('yields the bottom edge band to the platform-native tab bar', () => {
    expect(drawer).toContain('quickActionsGestureBandTop(height, insets.bottom, platform, nativeTabPath(pathname))');
    expect(drawer).not.toContain('TAB_BAR_HEIGHT');
    expect(drawer).toContain('if (startY >= tabBandTopRef.current) return false;');
  });

  it('stays disarmed while the session is locked or privacy-covered', () => {
    expect(drawer).toContain('&& !locked');
    expect(drawer).toContain('&& !privacyCovered');
  });

  it('hides background content from assistive tech as soon as the drawer engages', () => {
    expect(drawer).toContain('accessibilityElementsHidden={engaged}');
    expect(drawer).toContain("importantForAccessibility={engaged ? 'no-hide-descendants' : 'auto'}");
  });

  it('surfaces and rolls back failed task persistence', () => {
    expect(staffCapture).toContain('persistTasks');
    expect(staffCapture).toContain('setTaskError');
    expect(staffCapture).toContain('setTasks(rollback);');
  });

  it('scopes captured content to the stable account and selected campaign', () => {
    expect(drawer).toContain('quickCaptureScope(');
    expect(drawer).toContain('session?.user.id ?? null');
    expect(drawer).toContain("chapterMemberships.find((entry) => entry.selected)?.chapterID ?? null");
  });

  it('gives assistive tech and Android back hardware paths into and out of the drawer', () => {
    expect(drawer).toContain("{ name: 'magicTap', label: 'Open the Guide' }");
    expect(drawer).toContain("BackHandler.addEventListener('hardwareBackPress'");
  });

  it('opens the Guide for every hat per the product policy', () => {
    expect(drawer).toContain('<CompassPanel');
    expect(drawer).not.toContain('<QuickActionsPanel');
    expect(drawer).not.toContain('Open shortcuts');
    expect(drawer).not.toContain('Close shortcuts');
  });

  it('gives an organization-scope grant with no campaign role the same staff answer as the deck', () => {
    // BUG-UG-ORG-WIDE-STAFF-ORG-ROLE-GRANT-CHAPTER-ROLE-RENDERED-STAFF-20260921:
    // get_my_mobile_staff_scope can return roles=['admin'] with chapterRoles=[]
    // (organization role grant, no member_role_chapters row). The deck renders
    // that person's Organization group and the Work tab its staff desks, so the
    // drawer must not answer 'member' and drop them to Compass.
    const STAFF_GROUP_KEYS = ['staff', 'chapter-work', 'organization'];
    const deckShowsStaff = (
      chapterRoles: Parameters<typeof featureGroupsForRoles>[0],
      organizationRoles: Parameters<typeof featureGroupsForRoles>[1],
    ) => featureGroupsForRoles(chapterRoles, organizationRoles).some((group) => STAFF_GROUP_KEYS.includes(group.key));

    expect(deckShowsStaff([], ['admin'])).toBe(true);
    expect(staffAuthorizedForScopes([], ['admin'])).toBe(true);

    // One projection for both surfaces across every scope shape the RPC returns.
    const cases: Parameters<typeof featureGroupsForRoles>[] = [
      [[], []],
      [[], ['admin']],
      [[], ['vp']],
      [[], ['steward']],
      [['steward'], []],
      [['admin'], []],
      [['admin'], ['admin']],
      [['steward'], ['admin']],
    ];
    for (const [chapterRoles, organizationRoles] of cases) {
      expect(staffAuthorizedForScopes(chapterRoles, organizationRoles)).toBe(deckShowsStaff(chapterRoles, organizationRoles));
    }

    // Members and ambiguous multi-hat sessions stay on Compass.
    expect(staffAuthorizedForScopes([], [])).toBe(false);
    expect(staffAuthorizedForScopes(['steward'], ['admin'])).toBe(false);
    // Chapter grants keep the answer they already had.
    expect(staffAuthorizedForScopes(['steward'], [])).toBe(true);
  });

  it('keeps notes and tasks inline in Work quick capture', () => {
    // Section labels follow the saved member language .
    expect(staffCapture).toContain("{t('Quick note').toLocaleUpperCase(locale)}");
    expect(staffCapture).toContain("{t('Quick task').toLocaleUpperCase(locale)}");
    expect(staffCapture).toContain('addQuickNote');
    expect(staffCapture).toContain('saveQuickTasks');
  });

  it('offers a staff role no member-voice message composer', () => {
    // UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108:
    // quick capture renders only for staff, and its composer posted into the
    // member's own steward thread ("Message your steward"). Staff reach members
    // from Messages; capture keeps notes, tasks and pinned destinations.
    for (const memberVoice of ['Message the committee', 'Message your campaign committee members', 'MESSAGE', 'sendMemberMessage', 'startMemberConversation', 'sendPreviewMessage', 'startPreviewConversation']) {
      expect(staffCapture).not.toContain(memberVoice);
    }
    expect(staffCapture).not.toContain(".from('");
  });

  it('loads expo-audio lazily so older dev clients keep text capture', () => {
    expect(optionalAudio).toContain("require('expo-audio')");
    expect(staffCapture).not.toMatch(/^import \{[^}]*\} from 'expo-audio';$/m);
    expect(staffCapture).toContain("import type { AudioPlayer, AudioRecorder } from 'expo-audio';");
    expect(staffCapture).toContain('requestRecordingPermissionsAsync');
    expect(optionalFs).toContain("require('expo-file-system/legacy')");
  });

  it('records at the flattened HIGH_QUALITY preset and cleans up recording files', () => {
    expect(staffCapture).toContain('prepareToRecordAsync(audio.RecordingPresets.HIGH_QUALITY)');
    expect(staffCapture).toContain('deleteVoiceRecording');
    expect(staffCapture).toContain('void deleteVoiceRecording(voiceMemoRef.current?.uri ?? null);');
    //: a removed note takes its voice file with it; a full list deletes
    // nothing to make room (no saved list is trimmed to its cap).
    expect(capture).toContain('await deleteVoiceRecording(removed?.voiceUri ?? null);');
    expect(capture).not.toMatch(/\.slice\(0, MAX_QUICK_(NOTES|TASKS)\)/);
    expect(staffCapture).not.toMatch(/\.slice\(0, MAX_QUICK_(NOTES|TASKS)\)/);
    expect(capture).toContain("deleteAsync(uri, { idempotent: true })");
    expect(capture).toContain('serializedPerScope');
  });

  it('declares the microphone permissions the voice shortcut needs', () => {
    expect(config).toContain('NSMicrophoneUsageDescription');
    expect(config).toContain("'RECORD_AUDIO'");
    expect(config).toContain("'expo-audio',");
  });

  it('meets touch-target and keyboard chrome conventions', () => {
    const inputs = staffCapture.match(/<TextInput/g)?.length ?? 0;
    const themedKeyboards = staffCapture.match(/keyboardAppearance=\{theme\.appearance\}/g)?.length ?? 0;
    expect(inputs).toBeGreaterThan(0);
    expect(themedKeyboards).toBe(inputs);
    expect(staffCapture).toContain('minimumTouchTarget');
  });
});

// ---------------------------------------------------------------------------
// Reduce Motion (A11Y-UG-QUICK-ACTIONS-DRAWER-IGNORES-REDUCE-MOTION-20260920)
//
// The contract block above reads the drawer as text. This block runs it: the
// mobile package tests in plain node with no React renderer and no DOM
// (vitest.config.mts), so the smallest honest harness is a synchronous hook
// host plus stubs for the native and service boundaries the drawer imports.
// Everything under test — snapTo, the pan responder, the Android back
// handler, the magic-tap opener and the scrim's close button — is the shipped
// code, reached through the same entry points a device uses.
// ---------------------------------------------------------------------------

const harness = vi.hoisted(() => {
  type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | void };
  const state = {
    reduceMotion: false,
    pathname: '/messages',
    app: { mode: 'authenticated', chapterRoles: [] as string[], organizationRoles: [] as string[], previewHat: null as string | null, locked: false, privacyCovered: false, session: { user: { id: 'member-1' } }, chapterMemberships: [] },
    slots: [] as unknown[],
    effects: [] as EffectSlot[],
    queue: [] as Array<() => void>,
    index: 0,
    effectIndex: 0,
    tree: null as React.ReactNode,
    body: (() => null) as () => React.ReactNode,
    rendering: false,
  };
  const renderAgain = Symbol('render-again');

  function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) {
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => Object.is(value, right[index]));
  }

  function render() {
    // React restarts a render-phase state update before rendering children.
    // The held-scope hook uses that pattern; recursing into this fake render
    // instead would let the abandoned call allocate a second set of slots.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      state.index = 0;
      state.effectIndex = 0;
      state.rendering = true;
      try { state.tree = state.body(); break; }
      catch (error: unknown) { if (error !== renderAgain) throw error; }
      finally { state.rendering = false; }
      if (attempt === 24) throw new Error('Too many render-phase updates');
    }
    // Effects commit after the render, as React runs them.
    for (const run of state.queue.splice(0)) run();
    return state.tree;
  }

  const hooks = {
    useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void] {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = initial;
      const set = (next: T | ((previous: T) => T)) => {
        const previous = state.slots[index] as T;
        const value = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
        if (Object.is(value, previous)) return;
        state.slots[index] = value;
        if (state.rendering) throw renderAgain;
        render();
      };
      return [state.slots[index] as T, set];
    },
    useRef<T>(initial: T) {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = { current: initial };
      return state.slots[index] as { current: T };
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const index = state.index++;
      const previous = state.slots[index] as { value: T; deps: readonly unknown[] } | undefined;
      if (previous && sameDeps(previous.deps, deps)) return previous.value;
      const value = factory();
      state.slots[index] = { value, deps };
      return value;
    },
    useEffect(fn: () => (() => void) | void, deps?: readonly unknown[]) {
      const index = state.effectIndex++;
      const previous = state.effects[index];
      if (previous && sameDeps(previous.deps, deps)) return;
      state.effects[index] = { deps, cleanup: previous?.cleanup };
      state.queue.push(() => {
        if (previous?.cleanup) previous.cleanup();
        state.effects[index] = { deps, cleanup: fn() };
      });
    },
  };

  function reset() {
    state.reduceMotion = false;
    state.slots = [];
    state.effects = [];
    state.queue = [];
    state.index = 0;
    state.effectIndex = 0;
    state.tree = null;
    state.rendering = false;
  }

  return { state, hooks, render, reset };
});

const native = vi.hoisted(() => {
  type Listener = (event: { value: number }) => void;
  class Value {
    private listeners = new Map<string, Listener>();
    private nextId = 1;
    constructor(public value: number) {}
    setValue(next: number) {
      native.setValues.push(next);
      this.value = next;
      for (const listener of this.listeners.values()) listener({ value: next });
    }
    addListener(listener: Listener) {
      const id = `${this.nextId++}`;
      this.listeners.set(id, listener);
      return id;
    }
    removeListener(id: string) { this.listeners.delete(id); }
    interpolate({ inputRange, outputRange }: { inputRange: number[]; outputRange: number[] }) {
      const source = this;
      return {
        // Read live, so a test sees exactly what the panel would paint.
        get current() {
          const [inLow = 0, inHigh = 1] = inputRange;
          const [outLow = 0, outHigh = 1] = outputRange;
          const ratio = (source.value - inLow) / (inHigh - inLow);
          return outLow + (outHigh - outLow) * ratio;
        },
      };
    }
  }
  type Timing = {
    value: Value;
    config: { toValue: number; duration: number; useNativeDriver: boolean };
    callback: ((result: { finished: boolean }) => void) | null;
    stopped: boolean;
  };
  const native = {
    Value,
    os: 'ios' as string,
    timings: [] as Timing[],
    setValues: [] as number[],
    backHandlers: [] as Array<() => boolean>,
    panConfigs: [] as Array<Record<string, (...args: never[]) => unknown>>,
  };
  return native;
});

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  ...harness.hooks,
}));
vi.mock('react-native', () => ({
  Animated: {
    Value: native.Value,
    timing: (value: InstanceType<typeof native.Value>, config: { toValue: number; duration: number; useNativeDriver: boolean }) => {
      const entry = { value, config, callback: null as ((result: { finished: boolean }) => void) | null, stopped: false };
      native.timings.push(entry);
      return {
        start: (callback?: (result: { finished: boolean }) => void) => { entry.callback = callback ?? null; },
        stop: () => { entry.stopped = true; },
      };
    },
    View: 'Animated.View',
  },
  BackHandler: {
    addEventListener: (_name: string, handler: () => boolean) => {
      native.backHandlers.push(handler);
      return { remove: () => { native.backHandlers = native.backHandlers.filter((entry) => entry !== handler); } };
    },
  },
  Easing: { bezier: () => 'bezier' },
  Keyboard: { dismiss: () => undefined },
  PanResponder: {
    create: (config: Record<string, (...args: never[]) => unknown>) => {
      native.panConfigs.push(config);
      return { panHandlers: {} };
    },
  },
  Platform: {
    get OS() { return native.os; },
    select: (map: Record<string, unknown>) => map[native.os] ?? map.default,
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (sheet: unknown) => sheet, absoluteFill: {}, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: 'View',
}));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => harness.state.reduceMotion }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, contentStartInset: (safeAreaTop: number) => safeAreaTop + 28, quickActionsGestureBandTop: () => 800 }));
vi.mock('expo-router', () => ({ usePathname: () => harness.state.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('./CompassPanel', () => ({ CompassPanel: () => null }));
// expo-blur, expo-linear-gradient and masked-view are native modules that ship
// untranspiled JSX; the ramp's own contract is asserted in chromeContract.test.ts.
vi.mock('./TopChrome', () => ({ TopRamp: () => null }));
vi.mock('./ui', () => ({ Body: () => null, Button: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ appearance: 'light' }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn(), impact: vi.fn() } }));
vi.mock('../services/supabase', () => ({ sendMemberMessage: vi.fn(), startMemberConversation: vi.fn() }));
vi.mock('../services/quickCapture', () => ({
  addQuickNote: vi.fn(),
  createQuickTask: vi.fn(),
  deleteVoiceRecording: vi.fn(),
  loadQuickNotes: vi.fn(async () => []),
  loadQuickTasks: vi.fn(async () => []),
  removeQuickNote: vi.fn(),
  saveQuickTasks: vi.fn(),
  MAX_QUICK_TASKS: 5,
  QUICK_NOTE_BODY_LIMIT: 500,
  QUICK_TASK_TITLE_LIMIT: 80,
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => harness.state.app }));

const { QuickActionsDrawer } = await import('./QuickActionsDrawer');

type Element = React.ReactElement<{
  children?: React.ReactNode;
  style?: unknown;
  accessibilityLabel?: string;
  accessibilityElementsHidden?: boolean;
  onPress?: () => void;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
}>;

function elements(node: React.ReactNode, visibleOnly = false): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: React.ReactNode) => elements(child, visibleOnly));
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  // A privacy/session check can retain a concealed owner. Its controls and
  // interpolated positions are not visible or reachable while it is hidden.
  if (visibleOnly && (element.props.accessibilityElementsHidden || styleObjects(element.props.style).some((entry) => entry.display === 'none'))) return [element];
  return [element, ...elements(element.props.children, visibleOnly)];
}

function styleObjects(style: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(style)) return style.flatMap(styleObjects);
  return style && typeof style === 'object' ? [style as Record<string, unknown>] : [];
}

/** The live interpolated number the named animated style would paint, if any. */
function animatedStyle(pick: (entry: Record<string, unknown>) => unknown): number | null {
  for (const element of elements(harness.state.tree, true)) {
    if (element.type !== 'Animated.View') continue;
    for (const entry of styleObjects(element.props.style)) {
      const candidate = pick(entry) as { current?: number } | undefined;
      if (candidate && typeof candidate.current === 'number') return candidate.current;
    }
  }
  return null;
}

const DRAWER_WIDTH = Math.min(390 * 0.86, 400);

/** Everything the record's acceptance names, read back off the live tree. */
function resting() {
  const tree = elements(harness.state.tree, true);
  const pan = native.panConfigs.at(-1)!;
  const shouldSet = pan.onMoveShouldSetPanResponder as (
    event: { nativeEvent: { pageX: number; pageY: number } },
    gesture: { dx: number; dy: number },
  ) => boolean;
  return {
    // `engaged`: the overlay only mounts while the drawer is engaged, and it is
    // what hides the background from assistive tech.
    engaged: tree.some((element) => element.props.accessibilityElementsHidden === true)
      && tree.some((element) => element.props.accessibilityLabel === 'Close the Guide'),
    // `open`: the only observable of that flag is openRef, which lets the pan
    // responder claim a drag that starts anywhere once the drawer is open.
    open: shouldSet({ nativeEvent: { pageX: 10, pageY: 10 } }, { dx: 50, dy: 0 }),
    panelOffset: animatedStyle((entry) => (entry.transform as Array<{ translateX?: unknown }> | undefined)?.[0]?.translateX),
    scrimOpacity: animatedStyle((entry) => entry.opacity),
  };
}

function mountDrawer() {
  harness.state.body = () => QuickActionsDrawer({ children: null });
  harness.render();
}

function magicTap() {
  const opener = elements(harness.state.tree).find((element) => element.props.onAccessibilityAction);
  opener!.props.onAccessibilityAction!({ nativeEvent: { actionName: 'magicTap' } });
}

function pressScrimClose() {
  const close = elements(harness.state.tree).find((element) => element.props.accessibilityLabel === 'Close the Guide');
  close!.props.onPress!();
}

function hardwareBack() {
  return native.backHandlers.at(-1)!();
}

/** Run the pending eased transition to its end, as the driver would. */
function finishAnimation() {
  const entry = native.timings.at(-1)!;
  entry.value.setValue(entry.config.toValue);
  entry.callback!({ finished: true });
}

beforeEach(() => {
  harness.reset();
  harness.state.pathname = '/messages';
  harness.state.app = { mode: 'authenticated', chapterRoles: [], organizationRoles: [], previewHat: null, locked: false, privacyCovered: false, session: { user: { id: 'member-1' } }, chapterMemberships: [] };
  native.timings = [];
  native.setValues = [];
  native.backHandlers = [];
  native.panConfigs = [];
  vi.stubGlobal('React', React);
  mountDrawer();
});

describe('quick-actions drawer honours Reduce Motion', () => {
  it('reads the shared Reduce Motion helper rather than its own probe', () => {
    expect(drawer).toContain("import { useReduceMotion } from '../lib/reduceMotion'");
    expect(drawer).toContain('const reduceMotion = useReduceMotion()');
    // Read through a ref: the back handler and the pan responder both capture
    // a snapTo from an earlier render.
    expect(drawer).toContain('reduceMotionRef.current = reduceMotion;');
    expect(drawer).toContain('if (reduceMotionRef.current) {');
    expect(drawer).not.toContain('AccessibilityInfo');
  });

  it('keeps the 360ms eased transition when the setting is off', () => {
    magicTap();
    expect(native.timings).toHaveLength(1);
    expect(native.timings[0]!.config).toMatchObject({ toValue: 1, duration: 360, useNativeDriver: true });
  });

  it('opens and closes without a timed transition when the setting is on', () => {
    harness.state.reduceMotion = true;
    harness.render();

    magicTap();
    expect(native.timings).toHaveLength(0);
    expect(native.setValues).toContain(1);
    expect(resting()).toMatchObject({ engaged: true, open: true, panelOffset: 0, scrimOpacity: 1 });

    pressScrimClose();
    expect(native.timings).toHaveLength(0);
    expect(native.setValues.at(-1)).toBe(0);
    expect(resting()).toMatchObject({ engaged: false, open: false });
  });

  it('takes the Android hardware-back path immediately too', () => {
    harness.state.reduceMotion = true;
    harness.render();

    magicTap();
    expect(hardwareBack()).toBe(true);
    expect(native.timings).toHaveLength(0);
    expect(native.setValues.at(-1)).toBe(0);
    expect(resting()).toMatchObject({ engaged: false, open: false });
  });

  it('completes a release gesture immediately in both directions', () => {
    harness.state.reduceMotion = true;
    harness.render();
    const pan = native.panConfigs.at(-1)!;
    const grant = pan.onPanResponderGrant as () => void;
    const move = pan.onPanResponderMove as (event: unknown, gesture: { dx: number }) => void;
    const release = pan.onPanResponderRelease as (event: unknown, gesture: { vx: number }) => void;

    // Drag most of the way open, then fling open.
    grant();
    move(null, { dx: -300 });
    release(null, { vx: -1 });
    expect(native.timings).toHaveLength(0);
    expect(resting()).toMatchObject({ engaged: true, open: true, panelOffset: 0, scrimOpacity: 1 });

    // Drag most of the way closed, then let go.
    grant();
    move(null, { dx: 250 });
    release(null, { vx: 0.5 });
    expect(native.timings).toHaveLength(0);
    expect(native.setValues.at(-1)).toBe(0);
    expect(resting()).toMatchObject({ engaged: false, open: false });
  });

  it('settles the panel, scrim and drawer state exactly where the animated path leaves them', () => {
    magicTap();
    finishAnimation();
    const animatedOpen = resting();
    pressScrimClose();
    finishAnimation();
    const animatedClosed = resting();

    harness.reset();
    native.timings = [];
    native.setValues = [];
    native.backHandlers = [];
    native.panConfigs = [];
    mountDrawer();
    harness.state.reduceMotion = true;
    harness.render();

    magicTap();
    expect(resting()).toEqual(animatedOpen);
    pressScrimClose();
    expect(resting()).toEqual(animatedClosed);
  });

  it('applies a mid-session setting change to the next transition with no remount', () => {
    magicTap();
    expect(native.timings).toHaveLength(1);
    finishAnimation();

    // The device setting flips; useReduceMotion republishes and the drawer
    // re-renders. The back handler still holds the snapTo it captured when the
    // drawer engaged, so only the ref can carry the new value into it.
    harness.state.reduceMotion = true;
    harness.render();

    expect(hardwareBack()).toBe(true);
    expect(native.timings).toHaveLength(1);
    expect(native.setValues.at(-1)).toBe(0);
    expect(resting()).toMatchObject({ engaged: false, open: false });
  });
});

describe('every-hat Guide panel and session/route dismissal', () => {
  const hats = ['member', 'steward', 'coordinator', 'advisor', 'admin', 'vp'];
  it.each(hats)('PREVIEW %s opens the Guide from the edge gesture', (hat) => {
    harness.state.app.mode = 'preview';
    harness.state.app.previewHat = hat;
    openFromEdge();
    expectPanel();
  });
  it.each(hats)('SAMPLE/authenticated %s opens the Guide from the edge gesture', (hat) => {
    harness.state.app.chapterRoles = hat === 'member' ? [] : [hat];
    openFromEdge();
    expectPanel();
  });
  it.each(['steward', 'coordinator', 'advisor', 'admin', 'vp'])('organization-only %s opens the Guide', (hat) => {
    harness.state.app.organizationRoles = [hat];
    openFromEdge();
    expectPanel();
  });
  it.each(['/home', '/sign-in', '/mfa-challenge', '/auth/callback', '/compass'])('disarms and dismisses on %s for staff too', (path) => {
    harness.state.app.chapterRoles = ['steward'];
    openFromEdge();
    harness.state.pathname = path;
    harness.render();
    expect(resting().engaged).toBe(false);
    expect(elements(harness.state.tree).filter((e) => e.type === CompassPanel)).toHaveLength(0);
  });
  it.each(['locked', 'privacyCovered'] as Array<'locked' | 'privacyCovered'>)('dismisses immediately on %s', (cover) => {
    openFromEdge();
    harness.state.app[cover] = true;
    harness.render();
    expect(resting().engaged).toBe(false);
    expect(native.backHandlers).toHaveLength(0);
  });
});

const { CompassPanel } = await import('./CompassPanel');
function openFromEdge() {
  harness.state.reduceMotion = true;
  harness.render();
  const pan = native.panConfigs.at(-1)!;
  const claim = pan.onMoveShouldSetPanResponder as (event: unknown, gesture: unknown) => boolean;
  expect(claim({ nativeEvent: { pageX: 350, pageY: 250 } }, { dx: -30, dy: 0 })).toBe(true);
  (pan.onPanResponderGrant as () => void)();
  (pan.onPanResponderMove as (event: unknown, gesture: unknown) => void)(null, { dx: -300 });
  (pan.onPanResponderRelease as (event: unknown, gesture: unknown) => void)(null, { vx: -1 });
}
function expectPanel() {
  expect(elements(harness.state.tree).filter((e) => e.type === CompassPanel)).toHaveLength(1);
  expect(resting().engaged).toBe(true);
  expect(elements(harness.state.tree).some((e) => /shortcuts/i.test(e.props.accessibilityLabel ?? ''))).toBe(false);
}
