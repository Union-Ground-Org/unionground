import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountSessionIdentity } from '../lib/accountSessionIdentity';

const harness = vi.hoisted(() => {
  type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | void };
  const state = {
    reduceMotion: false,
    pathname: '/messages',
    app: { mode: 'authenticated', chapterRoles: [] as string[], organizationRoles: [] as string[], previewHat: null as string | null, locked: false, privacyCovered: false, session: { user: { id: 'member-1' } }, chapterMemberships: [] },
    slots: [] as unknown[],
    effects: [] as EffectSlot[],
    stores: [] as Array<() => void>,
    queue: [] as Array<() => void>,
    index: 0,
    effectIndex: 0,
    generation: 0,
    tree: null as React.ReactNode,
    body: (() => null) as () => React.ReactNode,
  };

  function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) {
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => Object.is(value, right[index]));
  }

  function render() {
    state.index = 0;
    state.effectIndex = 0;
    state.tree = state.body();
    // Effects commit after the render, as React runs them.
    for (const run of state.queue.splice(0)) run();
    return state.tree;
  }

  const hooks = {
    useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
      const index = state.index++;
      const generation = state.generation;
      if (index >= state.slots.length) state.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      const set = (next: T | ((previous: T) => T)) => {
        if (generation !== state.generation) return;
        const previous = state.slots[index] as T;
        const value = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
        if (Object.is(value, previous)) return;
        state.slots[index] = value;
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
    useCallback<T>(fn: T, deps: readonly unknown[]) {
      return hooks.useMemo(() => fn, deps);
    },
    // The memory-only resume holder (#9240) renders its subscribers again.
    useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T) {
      const index = state.index++;
      const generation = state.generation;
      if (index >= state.slots.length) {
        state.slots[index] = true;
        const unsubscribe: unknown = subscribe(() => { if (generation === state.generation) render(); });
        if (typeof unsubscribe === 'function') state.stores.push(unsubscribe as () => void);
      }
      return snapshot();
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
    state.generation++;
    for (const effect of state.effects) effect.cleanup?.();
    for (const unsubscribe of state.stores.splice(0)) unsubscribe();
    state.reduceMotion = false;
    state.slots = [];
    state.effects = [];
    state.queue = [];
    state.index = 0;
    state.effectIndex = 0;
    state.tree = null;
  }

  return { state, hooks, render, reset };
});


const fixture = vi.hoisted(() => ({
  store: new Map<string, string>(),
  deleted: [] as string[],
  uuid: 0,
  focused: true,
  path: '/work',
  push: vi.fn(),
  permission: vi.fn(async () => ({ granted: true })),
  prepare: vi.fn(async () => undefined),
  writeDelay: null as (() => Promise<void>) | null,
  failStorageRead: false,
  audioMode: vi.fn(async () => undefined),
  recorderStop: vi.fn(async () => undefined),
  recorderRelease: vi.fn(),
  recorderRecord: vi.fn(),
  recorderUri: 'file:///new-voice.m4a',
  sessionEpoch: 0,
  activeUserID: 'user-a' as string | null,
  play: vi.fn(),
  playerRemove: vi.fn(),
  fontScale: 1,
  platform: 'ios' as 'ios' | 'android',
  reveal: vi.fn<(target: unknown) => void>(),
  release: vi.fn<(target: unknown) => void>(),
  alert: vi.fn<(title: string, message?: string, buttons?: Array<{ text: string }>) => void>(),
  announce: vi.fn<(message: string) => void>(),
  announceQueued: vi.fn<(message: string, options: { queue: boolean }) => void>(),
  app: {
    mode: 'authenticated', memberLanguage: null as 'en' | 'es' | null,
    chapterRoles: ['steward'] as string[], organizationRoles: [] as string[], authorizedRoles: ['steward'] as string[],
    locked: false, privacyCovered: false,
    session: { user: { id: 'user-a' } }, organizationID: 'org-a' as string | null,
    chapterMemberships: [{ chapterID: 'chapter-a', organizationID: 'org-a' as string | null, selected: true }],
    dashboard: { cases: [], conversations: [] } as { cases: never[]; conversations: never[] } | null,
    refreshing: false, refresh: vi.fn(),
    captureAuthenticatedSessionGuard: vi.fn<() => () => boolean>(),
    captureAccountSessionGuard: vi.fn<(userID: string | null) => () => boolean>(),
  },
}));

vi.mock('react', async (original) => ({ ...await original<Record<string, unknown>>(), ...harness.hooks }));
vi.mock('react-native', () => ({
  Pressable: 'Pressable', View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  Alert: { alert: fixture.alert },
  AccessibilityInfo: { announceForAccessibility: fixture.announce, announceForAccessibilityWithOptions: fixture.announceQueued },
  Platform: { get OS() { return fixture.platform; } },
  StyleSheet: { create: (sheet: unknown) => sheet, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: fixture.fontScale }),
}));
vi.mock('expo-router', () => ({
  useIsFocused: () => fixture.focused,
  useRouter: () => ({ push: fixture.push }), useLocalSearchParams: () => ({}),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('./ui', () => ({ Body: 'Body', Button: 'Button', Heading: 'Heading', Screen: 'Screen', Card: 'Card', StateMessage: 'StateMessage' }));
vi.mock('./StatusPill', () => ({ StatusPill: 'StatusPill' }));
vi.mock('./ScreenKeyboardReveal', () => ({ useRevealAboveKeyboard: () => ({ reveal: fixture.reveal, release: fixture.release }) }));
vi.mock('./WorkWidgets', () => ({ WorkWidgets: 'WorkWidgets' }));
vi.mock('../data/useChannels', () => ({ useChannelStore: () => ({ subscribe: vi.fn(), getVersion: () => 0, channels: () => [] }) }));
vi.mock('../lib/chrome', () => ({ screenBottomInset: () => 0, useNativeTabContentInset: () => 0 }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ appearance: 'light' }) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn(), impact: vi.fn() } }));
vi.mock('../services/supabase', () => ({ sendMemberMessage: vi.fn(), startMemberConversation: vi.fn() }));
// The provider syncs the memory-only resume holder before its children render.
vi.mock('../state/AppProvider', async () => {
  const { syncResumeDraftContext } = await import('../lib/resumeDraftHolder');
  // These dashboards carry no member row; the provider's always does.
  return { useApp: () => {
    const app = { ...fixture.app, dashboard: fixture.app.dashboard && { member: { chapterID: null }, ...fixture.app.dashboard } };
    syncResumeDraftContext(app);
    return app;
  } };
});
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (fixture.failStorageRead && key.endsWith('.organization')) throw new Error('Storage temporarily unavailable');
    return fixture.store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => { await fixture.writeDelay?.(); fixture.store.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { fixture.store.delete(key); }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `id-${fixture.uuid++}` }));
vi.mock('../services/optionalFileSystem', () => ({ loadFileSystem: () => ({ deleteAsync: async (uri: string) => { fixture.deleted.push(uri); } }) }));
vi.mock('../services/optionalAudio', () => ({ loadAudioModule: () => audio }));

const { StaffQuickCapture } = await import('./StaffQuickCapture');
const { default: WorkScreen } = await import('../features/WorkScreen');
const captureService = await import('../services/quickCapture');
const { syncResumeDraftContext } = await import('../lib/resumeDraftHolder');
const { loadQuickNotes, loadQuickTasks, purgeQuickCaptureForUser } = captureService;
const audio = {
  requestRecordingPermissionsAsync: fixture.permission,
  setAudioModeAsync: fixture.audioMode,
  RecordingPresets: { HIGH_QUALITY: {} },
  AudioModule: { AudioRecorder: class {
    uri = fixture.recorderUri;
    prepareToRecordAsync = fixture.prepare;
    record = fixture.recorderRecord;
    getStatus = () => ({ durationMillis: 4500 });
    stop = fixture.recorderStop;
    release = fixture.recorderRelease;
  } },
  createAudioPlayer: vi.fn(() => ({ play: fixture.play, remove: fixture.playerRemove })),
};
type Props = {
  children?: React.ReactNode; accessibilityLabel?: string; label?: string;
  onPress?: () => void; onChangeText?: (text: string) => void; onFocus?: () => void; onBlur?: () => void; onLayout?: () => void;
  accessibilityState?: { checked?: boolean; disabled?: boolean };
  disabled?: boolean;
  value?: string;
  editable?: boolean;
  ref?: { current: unknown };
};
type Element = React.ReactElement<Props>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function texts(node: React.ReactNode): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  return React.isValidElement(node) ? texts((node as Element).props.children) : [];
}
let mountedKey: React.Key | null = null;
function mount() {
  const gate = StaffQuickCapture();
  if (!gate || typeof gate.type !== 'function') {
    harness.reset();
    harness.state.tree = gate;
    mountedKey = null;
    return;
  }
  if (mountedKey !== gate.key) { harness.reset(); mountedKey = gate.key; }
  const component = gate.type as (props: unknown) => React.ReactNode;
  harness.state.body = () => component(gate.props);
  harness.render();
}
async function flush() {
  // Flush bounded promise chains in the real storage service; no timers/polling.
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function find(label: string) {
  const element = elements(harness.state.tree).find((e) => e.props.accessibilityLabel === label || e.props.label === label);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element;
}
function type(label: string, value: string) { find(label).props.onChangeText!(value); }
function press(label: string) { find(label).props.onPress!(); }
function seedOld(scope: string) {
  const prefix = `org.unionground.app.quickcapture.v1.${scope}`;
  fixture.store.set(`${prefix}.notes.index`, '["old-note"]');
  fixture.store.set(`${prefix}.notes.old-note`, JSON.stringify({ id: 'old-note', body: 'Before the move', voiceUri: 'file:///old-voice.m4a', voiceDurationMs: 2100, createdAt: '2026-10-10T00:00:00-04:00' }));
  fixture.store.set(`${prefix}.tasks.index`, '["old-task"]');
  fixture.store.set(`${prefix}.tasks.old-task`, JSON.stringify({ id: 'old-task', title: 'Existing task', done: false, createdAt: '2026-10-10T00:00:00-04:00' }));
}
function live(role = 'admin') {
  fixture.app.mode = 'authenticated'; fixture.app.chapterRoles = [];
  fixture.app.authorizedRoles = [role]; fixture.app.organizationRoles = [role];
}
// The captured content of the signed-in steward in the selected chapter.
const SCOPE = 'authenticated.user-a.chapter-a';
let accountIdentity = createAccountSessionIdentity();
beforeEach(() => {
  harness.reset(); mountedKey = null;
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
  fixture.store.clear(); fixture.deleted = []; fixture.uuid = 0; fixture.focused = true;
  fixture.writeDelay = null;
  fixture.fontScale = 1;
  fixture.sessionEpoch = 0;
  fixture.activeUserID = 'user-a';
  accountIdentity = createAccountSessionIdentity();
  accountIdentity.current = { userID: 'user-a', accessToken: 'login-a', refreshToken: 'refresh-a' };
  fixture.failStorageRead = false;
  fixture.app.mode = 'authenticated'; fixture.app.memberLanguage = null; fixture.platform = 'ios';
  fixture.app.locked = false; fixture.app.privacyCovered = false;
  fixture.app.authorizedRoles = ['steward']; fixture.app.chapterRoles = ['steward']; fixture.app.organizationRoles = [];
  fixture.app.session = { user: { id: 'user-a' } }; fixture.app.organizationID = 'org-a';
  fixture.app.chapterMemberships = [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }];
  fixture.app.dashboard = { cases: [], conversations: [] };
  vi.clearAllMocks();
  fixture.app.captureAuthenticatedSessionGuard.mockImplementation(() => {
    const epoch = fixture.sessionEpoch;
    const userID = fixture.activeUserID;
    return () => userID !== null && fixture.sessionEpoch === epoch && fixture.activeUserID === userID;
  });
  fixture.app.captureAccountSessionGuard.mockImplementation((userID) => {
    const identityStillCurrent = accountIdentity.captureGuard(userID);
    return () => fixture.activeUserID === userID && identityStillCurrent();
  });
  fixture.permission.mockResolvedValue({ granted: true });
  fixture.prepare.mockResolvedValue(undefined);
  fixture.recorderStop.mockResolvedValue(undefined);
  fixture.audioMode.mockResolvedValue(undefined);
  fixture.recorderRecord.mockReset();
  fixture.recorderUri = 'file:///new-voice.m4a';
  vi.stubGlobal('React', React);
  vi.stubGlobal('require', (name: string) => { if (name === 'expo-audio') return audio; throw new Error(name); });
});

// BUG-UG-NATIVE-QUICK-NOTE-HIDDEN-BY-KEYBOARD-20261103: focusing a
// capture field asks the page to lift the field and its button above the
// keyboard; the scroll itself is executed in ScreenKeyboardReveal.test.ts.
describe('Work staff quick capture keeps the focused field and its button above the keyboard', () => {
  function blockAround(...labels: string[]) {
    const blocks = elements(harness.state.tree).filter((element) => element.type === 'View' && element.props.ref
      && labels.every((label) => elements(element.props.children).some((child) => child.props.accessibilityLabel === label || child.props.label === label)));
    expect(blocks).toHaveLength(1);
    return blocks[0]!;
  }

  it('lifts the Quick note field together with Save note', async () => {
    mount(); await flush();
    const block = blockAround('Quick note', 'Save note');
    const target = { measureInWindow: vi.fn() };
    block.props.ref!.current = target;
    type('Quick note', 'Half a thought');
    find('Quick note').props.onFocus!();
    expect(fixture.reveal).toHaveBeenCalledExactlyOnceWith(target);
    // Focusing scrolls; it neither saves nor clears the draft.
    expect(await loadQuickNotes(SCOPE)).toEqual([]);
    expect(find('Quick note').props.value).toBe('Half a thought');
  });

  it('lifts the note block again when it grows while the field is focused', async () => {
    mount(); await flush();
    const block = blockAround('Quick note', 'Save note');
    const target = { measureInWindow: vi.fn() };
    block.props.ref!.current = target;
    // A layout before focus, such as the first one, leaves the page alone.
    block.props.onLayout!();
    expect(fixture.reveal).not.toHaveBeenCalled();
    find('Quick note').props.onFocus!();
    // The multiline field grows from 48 to 120 pt as lines are typed; each
    // new layout of the block lifts it again, under the same clearance rule.
    type('Quick note', 'Line one\nLine two\nLine three\nLine four');
    blockAround('Quick note', 'Save note').props.onLayout!();
    blockAround('Quick note', 'Save note').props.onLayout!();
    expect(fixture.reveal).toHaveBeenCalledTimes(3);
    expect(fixture.reveal).toHaveBeenNthCalledWith(3, target);
    // Once the field loses focus, layout changes no longer scroll the page.
    find('Quick note').props.onBlur!();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(target);
    blockAround('Quick note', 'Save note').props.onLayout!();
    expect(fixture.reveal).toHaveBeenCalledTimes(3);
    expect(await loadQuickNotes(SCOPE)).toEqual([]);
  });

  it('lifts the Quick task field together with Create task', async () => {
    mount(); await flush();
    const block = blockAround('New task title', 'Create task');
    const target = { measureInWindow: vi.fn() };
    block.props.ref!.current = target;
    find('New task title').props.onFocus!();
    expect(fixture.reveal).toHaveBeenCalledExactlyOnceWith(target);
    find('New task title').props.onBlur!();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(target);
    expect(await loadQuickTasks(SCOPE)).toEqual([]);
  });
});

// BUG-UG-NATIVE-QUICK-NOTE-PLACEHOLDER-CLIPPED-AT-LARGEST-TEXT-IOS-20261103:
// at the largest iPhone text size the Quick note placeholder wrapped inside a
// fixed 120 pt cap and read "Capture a". Every Work drawer placeholder stays
// whole: the multiline fields may grow until theirs wraps one word per line,
// and the single-line task field's text grows only as far as its placeholder
// fits. src/lib/placeholderFit.test.ts covers the arithmetic.
describe('Work staff quick capture keeps every placeholder whole at the largest text size', () => {
  type FieldProps = {
    placeholder?: string; multiline?: boolean; maxFontSizeMultiplier?: number;
    style?: unknown; onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
  };
  const field = (label: string): FieldProps => find(label).props;
  const flatStyle = (style: unknown): Record<string, unknown> => Array.isArray(style)
    ? Object.assign({}, ...style.map(flatStyle)) as Record<string, unknown>
    : (style ?? {}) as Record<string, unknown>;
  const maxHeight = (label: string) => flatStyle(field(label).style).maxHeight as number;
  // React Native's fontScale for the largest iPhone accessibility size; the
  // fields' 22 pt line and 18 pt of padding and border scale with it.
  const LARGEST = 3.571;
  const line = 22 * LARGEST;

  it('keeps the 120 pt cap and the system text size at the default size', async () => {
    mount(); await flush();
    expect(field('Quick note').placeholder).toBe('Capture a note');
    expect(maxHeight('Quick note')).toBe(120);
    expect(field('New task title').maxFontSizeMultiplier).toBeUndefined();
  });

  it('lets the multiline placeholders wrap whole at the largest size', async () => {
    fixture.fontScale = LARGEST;
    mount(); await flush();
    expect(field('Quick note').multiline).toBe(true);
    // "Capture a" / "note" needed two lines, more than the old 120 pt cap.
    expect(maxHeight('Quick note')).toBeGreaterThanOrEqual(3 * line + 18);
  });

  it('caps the single-line task text where "Add a task" still fits its line', async () => {
    fixture.fontScale = LARGEST;
    mount(); await flush();
    expect(field('New task title').multiline).toBeFalsy();
    expect(field('New task title').placeholder).toBe('Add a task');
    // A 314 pt field on a 402 pt phone leaves a 288 pt line inside 12 pt
    // padding and 1 pt borders on each side.
    field('New task title').onLayout!({ nativeEvent: { layout: { width: 314 } } });
    const cap = field('New task title').maxFontSizeMultiplier!;
    expect(cap).toBeGreaterThanOrEqual(1);
    expect(cap * 16 * 0.5 * 'Add a task'.length).toBeLessThanOrEqual(288);
    // A narrower phone caps lower.
    field('New task title').onLayout!({ nativeEvent: { layout: { width: 240 } } });
    expect(field('New task title').maxFontSizeMultiplier).toBeLessThan(cap);
  });
});

describe('Work staff quick capture uses existing services and stored records', () => {
  it('Work mounts the capture component', () => {
    Object.assign(fixture.app, { staffRoleChoices: [], chosenStaffRole: null });
    harness.state.body = () => WorkScreen(); harness.render();
    expect(elements(harness.state.tree).filter((e) => e.type === StaffQuickCapture)).toHaveLength(1);
  });
  // Critic P7 C1 (Nov 6, 2026): a live session mounts no desk widgets at all,
  // so it never offers a Customize control that would drop edits.
  it('offers no desk customizing on a live staff session', () => {
    fixture.app.authorizedRoles = ['admin']; fixture.app.organizationRoles = ['admin'];
    Object.assign(fixture.app, { staffRoleChoices: [], chosenStaffRole: null });
    harness.state.body = () => WorkScreen(); harness.render();
    expect(elements(harness.state.tree).filter((e) => e.type === 'WorkWidgets')).toHaveLength(0);
    expect(texts(harness.state.tree)).not.toContain('Customize');
  });

  it('keeps local capture mounted while the authorized dashboard is unavailable', () => {
    live(); fixture.app.dashboard = null;
    harness.state.body = () => WorkScreen(); harness.render();
    expect(elements(harness.state.tree).filter((e) => e.type === StaffQuickCapture)).toHaveLength(1);
  });
  it('reads pre-move notes, tasks and voice files without rewriting their keys', async () => {
    seedOld(SCOPE); const before = new Map(fixture.store);
    mount(); await flush();
    expect(texts(harness.state.tree)).toContain('Quick capture');
    expect(texts(harness.state.tree)).toContain('Before the move');
    expect(find('Existing task').props.accessibilityState?.checked).toBe(false);
    press('Play voice note, 0:02');
    expect(audio.createAudioPlayer).toHaveBeenCalledWith('file:///old-voice.m4a');
    expect(fixture.play).toHaveBeenCalledOnce();
    for (const [key, value] of before) expect(fixture.store.get(key)).toBe(value);
    expect(fixture.deleted).toEqual([]);
  });
  it('creates and reads a note and task, then completes the task', async () => {
    mount(); await flush();
    type('Quick note', 'Captured in Work'); press('Save note'); await flush();
    expect((await loadQuickNotes(SCOPE))[0]?.body).toBe('Captured in Work');
    type('New task title', 'Follow up'); press('Create task'); await flush();
    expect((await loadQuickTasks(SCOPE))[0]?.done).toBe(false);
    press('Follow up'); await flush();
    expect((await loadQuickTasks(SCOPE))[0]?.done).toBe(true);
    expect(find('Follow up').props.accessibilityState?.checked).toBe(true);
  });
  it('records, saves and plays a voice note using the moved controls', async () => {
    mount(); await flush(); press('Record a voice note'); await flush();
    expect(fixture.permission).toHaveBeenCalledOnce();
    press('Stop recording'); await flush(); press('Save note'); await flush();
    expect((await loadQuickNotes(SCOPE))[0]).toMatchObject({ voiceUri: 'file:///new-voice.m4a', voiceDurationMs: 4500 });
    press('Play voice note, 0:05'); expect(fixture.play).toHaveBeenCalledOnce();
  });
  it('saves the attachment when Save overlaps an unfinished Stop', async () => {
    mount(); await flush(); type('Quick note', 'Gate note'); press('Record a voice note'); await flush();
    let finishStop!: () => void;
    fixture.recorderStop.mockImplementationOnce(() => new Promise((resolve) => { finishStop = () => resolve(undefined); }));
    press('Stop recording'); press('Save note'); await flush();
    finishStop(); await flush();
    expect(fixture.recorderStop).toHaveBeenCalledOnce();
    expect((await loadQuickNotes(SCOPE))[0]).toMatchObject({ body: 'Gate note', voiceUri: 'file:///new-voice.m4a', voiceDurationMs: 4500 });
  });
  it.each(['recorder-stop', 'audio-restore'])('keeps a same-account save across a non-retiring transition during %s', async (stage) => {
    live(); mount(); await flush();
    type('Quick note', 'Keep the signed-in recording');
    press('Record a voice note'); await flush();
    let resume!: () => void;
    const held = new Promise<undefined>((resolve) => { resume = () => resolve(undefined); });
    if (stage === 'audio-restore') fixture.audioMode.mockReturnValueOnce(held);
    else fixture.recorderStop.mockReturnValueOnce(held);
    press('Save note'); await flush();
    // Backgrounding and failed sign-out advance this transition without
    // ending the account's login. Hold passive cleanup to exercise the gap.
    fixture.sessionEpoch++;
    resume(); await flush();
    expect(fixture.activeUserID).toBe('user-a');
    expect(fixture.app.mode).toBe('authenticated');
    expect((await loadQuickNotes('authenticated.user-a.chapter-a'))[0]).toMatchObject({
      body: 'Keep the signed-in recording', voiceUri: 'file:///new-voice.m4a',
    });
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
  });
  it('keeps the mounted same-account Save handler usable after a failed sign-out transition', async () => {
    live(); mount(); await flush();
    type('Quick note', 'Still signed in');
    press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    const retainedSave = find('Save note').props.onPress!;
    fixture.sessionEpoch++;
    retainedSave(); await flush();
    expect((await loadQuickNotes('authenticated.user-a.chapter-a'))[0]).toMatchObject({
      body: 'Still signed in', voiceUri: 'file:///new-voice.m4a',
    });
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
  });
  const retirementStages: Array<'recorder-stop' | 'audio-restore' | 'same-account-login'> = ['recorder-stop', 'audio-restore', 'same-account-login'];
  it.each(retirementStages)('refuses addQuickNote when %s resumes after sign-out before component cleanup', async (stage) => {
    live(); mount(); await flush();
    type('Quick note', 'Must not survive sign-out');
    press('Record a voice note'); await flush();
    let resume!: () => void;
    const held = new Promise<undefined>((resolve) => { resume = () => resolve(undefined); });
    if (stage === 'audio-restore') fixture.audioMode.mockReturnValueOnce(held);
    else fixture.recorderStop.mockReturnValueOnce(held);
    const addNote = vi.spyOn(captureService, 'addQuickNote');
    let cleanupCurrent = true;
    try {
      press('Save note'); await flush();
      expect(addNote).not.toHaveBeenCalled();
      await purgeQuickCaptureForUser('user-a', () => cleanupCurrent);
      // Commit sign-out's synchronous ownership change but deliberately retain
      // the old component: React's passive cleanup has not run in this gap.
      fixture.sessionEpoch++;
      fixture.activeUserID = null;
      accountIdentity.current = null;
      fixture.app.mode = 'signedOut';
      cleanupCurrent = false;
      if (stage === 'same-account-login') {
        fixture.sessionEpoch++;
        fixture.activeUserID = 'user-a';
        accountIdentity.current = { userID: 'user-a', accessToken: 'replacement-a', refreshToken: 'replacement-refresh-a' };
        fixture.app.mode = 'authenticated';
      }
      resume(); await flush();

      expect(addNote).not.toHaveBeenCalled();
      expect(await loadQuickNotes('authenticated.user-a.chapter-a')).toEqual([]);
      expect([...fixture.store.keys()]).toEqual([]);
      expect(fixture.deleted).toContain('file:///new-voice.m4a');
      expect(fixture.recorderRelease).toHaveBeenCalledOnce();
      if (stage === 'same-account-login') {
        harness.reset(); mountedKey = null; mount(); await flush();
        type('Quick note', 'Authorized replacement'); press('Save note'); await flush();
        expect(addNote).toHaveBeenCalledOnce();
        expect((await loadQuickNotes('authenticated.user-a.chapter-a'))[0]?.body).toBe('Authorized replacement');
      }
    } finally {
      cleanupCurrent = false;
      resume();
      addNote.mockRestore();
    }
  });
  it('refuses a Save handler retained from the retired account render', async () => {
    live(); mount(); await flush();
    type('Quick note', 'Old account composer');
    press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    const staleSave = find('Save note').props.onPress!;
    const addNote = vi.spyOn(captureService, 'addQuickNote');
    let cleanupCurrent = true;
    try {
      await purgeQuickCaptureForUser('user-a', () => cleanupCurrent);
      fixture.sessionEpoch++;
      fixture.activeUserID = 'user-b';
      accountIdentity.current = { userID: 'user-b', accessToken: 'login-b', refreshToken: 'refresh-b' };
      fixture.app.session = { user: { id: 'user-b' } };
      cleanupCurrent = false;
      staleSave(); await flush();
      expect(addNote).not.toHaveBeenCalled();
      expect(await loadQuickNotes('authenticated.user-a.chapter-a')).toEqual([]);
      mount(); await flush();
      expect(fixture.deleted).toContain('file:///new-voice.m4a');
    } finally {
      cleanupCurrent = false;
      addNote.mockRestore();
    }
  });
  it('does not rebind an existing draft to a replacement login during an unrelated render', async () => {
    live(); mount(); await flush();
    type('Quick note', 'Retired composer');
    press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    accountIdentity.current = null;
    accountIdentity.current = { userID: 'user-a', accessToken: 'replacement-a', refreshToken: 'replacement-refresh-a' };
    const addNote = vi.spyOn(captureService, 'addQuickNote');
    try {
      type('Quick note', 'Unrelated render of the old composer');
      press('Save note'); await flush();
      expect(addNote).not.toHaveBeenCalled();
      expect(await loadQuickNotes('authenticated.user-a.chapter-a')).toEqual([]);
      harness.reset(); mountedKey = null; mount(); await flush();
      expect(fixture.deleted).toContain('file:///new-voice.m4a');
      type('Quick note', 'Replacement composer'); press('Save note'); await flush();
      expect((await loadQuickNotes('authenticated.user-a.chapter-a'))[0]?.body).toBe('Replacement composer');
    } finally { addNote.mockRestore(); }
  });
  it.each(['permission', 'audioMode', 'prepare'] as const)('refuses Save during the %s recording startup stage', async (stage) => {
    mount(); await flush(); type('Quick note', 'Gate note');
    const staleSave = find('Save note').props.onPress!;
    let finishStart!: () => void;
    if (stage === 'permission') {
      fixture.permission.mockImplementationOnce(() => new Promise((resolve) => { finishStart = () => resolve({ granted: true }); }));
    } else {
      fixture[stage].mockImplementationOnce(() => new Promise((resolve) => { finishStart = () => resolve(undefined); }));
    }
    press('Record a voice note'); await flush();
    const disabledDuringStart = find('Save note').props.disabled;
    staleSave(); await flush();
    expect(await loadQuickNotes(SCOPE)).toEqual([]);
    expect(disabledDuringStart).toBe(true);
    finishStart(); await flush();
    press('Stop recording'); await flush(); press('Save note'); await flush();
    expect(fixture.recorderRecord).toHaveBeenCalledOnce();
    expect((await loadQuickNotes(SCOPE))[0]).toMatchObject({ body: 'Gate note', voiceUri: 'file:///new-voice.m4a' });
  });
  it.each(['audioMode', 'prepare', 'record'] as const)('keeps the prior memo when replacement %s fails', async (stage) => {
    mount(); await flush(); press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    fixture.recorderUri = 'file:///replacement.m4a';
    if (stage === 'record') fixture.recorderRecord.mockImplementationOnce(() => { throw new Error('Start failed'); });
    else fixture[stage].mockRejectedValueOnce(new Error('Start failed'));
    press('Record a voice note'); await flush();
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
    expect(texts(harness.state.tree)).toContain('Recording could not start. Try again.');
    press('Play voice memo, 0:05');
    expect(audio.createAudioPlayer).toHaveBeenLastCalledWith('file:///new-voice.m4a');
    press('Save note'); await flush();
    expect((await loadQuickNotes(SCOPE))[0]?.voiceUri).toBe('file:///new-voice.m4a');
  });
  it('replaces the prior memo only after the new recorder starts', async () => {
    mount(); await flush(); press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    fixture.recorderUri = 'file:///replacement.m4a';
    let finishStart!: () => void;
    fixture.prepare.mockImplementationOnce(() => new Promise((resolve) => { finishStart = () => resolve(undefined); }));
    press('Record a voice note'); await flush();
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
    finishStart(); await flush();
    expect(fixture.deleted).toContain('file:///new-voice.m4a');
    press('Stop recording'); await flush(); press('Save note'); await flush();
    expect((await loadQuickNotes(SCOPE))[0]?.voiceUri).toBe('file:///replacement.m4a');
  });
  it('cleans an unsaved stopped take if Work locks during audio restoration', async () => {
    mount(); await flush(); type('Quick note', 'Gate note'); press('Record a voice note'); await flush();
    let finishRestore!: () => void;
    fixture.audioMode.mockImplementationOnce(() => new Promise((resolve) => { finishRestore = () => resolve(undefined); }));
    press('Stop recording'); press('Save note'); await flush();
    fixture.app.locked = true; mount();
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
    finishRestore(); await flush();
    expect(await loadQuickNotes(SCOPE)).toEqual([]);
    expect(fixture.deleted).toContain('file:///new-voice.m4a');
    expect(harness.state.tree).toBeNull();
  });
  it('refuses to discard a take before pending audio restoration and Save finish', async () => {
    mount(); await flush(); type('Quick note', 'Gate note'); press('Record a voice note'); await flush();
    let finishRestore!: () => void;
    fixture.audioMode.mockImplementationOnce(() => new Promise((resolve) => { finishRestore = () => resolve(undefined); }));
    press('Stop recording'); await flush();
    expect(find('Discard voice memo').props.disabled).toBe(true);
    press('Discard voice memo'); press('Save note'); await flush();
    finishRestore(); await flush();
    expect((await loadQuickNotes(SCOPE))[0]?.voiceUri).toBe('file:///new-voice.m4a');
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
  });
  it('creates only one task while its first save is pending', async () => {
    mount(); await flush(); type('New task title', 'Follow up');
    let finishWrite!: () => void;
    fixture.writeDelay = () => new Promise((resolve) => { finishWrite = resolve; });
    press('Create task'); await flush();
    const disabledDuringSave = find('Create task').props.disabled;
    press('Create task'); await flush();
    fixture.writeDelay = null; finishWrite(); await flush();
    expect((await loadQuickTasks(SCOPE)).map((task) => task.title)).toEqual(['Follow up']);
    expect(disabledDuringSave).toBe(true);
  });
  it.each(['Record a voice note', 'Discard voice memo'])('retains a saving attachment when %s receives a stale press', async (action) => {
    mount(); await flush(); press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    const stalePress = find(action).props.onPress!;
    let finishWrite!: () => void;
    fixture.writeDelay = () => new Promise((resolve) => { finishWrite = resolve; });
    press('Save note'); await flush();
    const disabledDuringSave = find(action).props.disabled;
    stalePress(); await flush();
    fixture.writeDelay = null; finishWrite(); await flush();
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
    expect(disabledDuringSave).toBe(true);
    expect(fixture.permission).toHaveBeenCalledOnce();
    expect((await loadQuickNotes(SCOPE))[0]?.voiceUri).toBe('file:///new-voice.m4a');
  });
  it('shows a staff role no member-voice composer in its own quick capture', async () => {
    live(); mount(); await flush();
    const shown = texts(harness.state.tree).join(' ');
    expect(shown).toContain('QUICK NOTE');
    for (const memberVoice of ['MESSAGE', 'Send message', 'Message your campaign committee members']) expect(shown).not.toContain(memberVoice);
    expect(() => find('Message the committee')).toThrow();
  });
  it('keeps the My campaign destination pinned from the Home catalog', async () => {
    fixture.store.set('org.unionground.app.deck.shortcuts.v1.authenticated.steward', '["my-campaign"]');
    mount(); await flush(); press('Campaign');
    expect(fixture.push).toHaveBeenCalledWith('/campaign');
  });
  it('retries a transient storage failure without remounting Work', async () => {
    live(); seedOld('authenticated.user-a.chapter-a'); fixture.failStorageRead = true;
    mount(); await flush();
    expect(texts(harness.state.tree)).toContain('Quick capture is unavailable for this campaign.');
    fixture.failStorageRead = false; press('Try quick capture again'); await flush();
    expect(texts(harness.state.tree)).toContain('Before the move');
    expect(find('Quick note')).toBeTruthy();
  });
  it('reads existing pinned destinations and filters out unauthorized saved keys', async () => {
    live('admin');
    fixture.store.set('org.unionground.app.deck.shortcuts.v1.authenticated.admin', '["operations","steward","not-real"]');
    mount(); await flush();
    const labels = elements(harness.state.tree).map((e) => e.props.label).filter(Boolean);
    expect(labels).toContain('Operations health'); expect(labels).not.toContain('Committee');
    press('Operations health'); expect(fixture.push).toHaveBeenCalledWith('/feature/operations');
    expect(fixture.store.get('org.unionground.app.deck.shortcuts.v1.authenticated.admin')).toBe('["operations","steward","not-real"]');
  });
  it('preserves chapter-less authenticated legacy records while binding their organization', async () => {
    live(); fixture.app.chapterMemberships = []; seedOld('authenticated.user-a.none');
    mount(); await flush();
    expect(texts(harness.state.tree)).toContain('Before the move');
    expect(fixture.store.get('org.unionground.app.quickcapture.v1.authenticated.user-a.none.organization')).toBe('org-a');
    fixture.app.organizationID = 'org-b'; mount(); await flush();
    expect(texts(harness.state.tree)).not.toContain('Before the move');
    expect(texts(harness.state.tree)).toContain('Quick capture is unavailable for this campaign.');
    expect(elements(harness.state.tree).some((e) => e.props.accessibilityLabel === 'Quick note')).toBe(false);
  });
  it.each<'account' | 'chapter'>(['account', 'chapter'])('never reads the previous %s captures after switching', async (change) => {
    live(); seedOld('authenticated.user-a.chapter-a'); mount(); await flush();
    expect(texts(harness.state.tree)).toContain('Before the move');
    if (change === 'account') fixture.app.session = { user: { id: 'user-b' } };
    if (change === 'chapter') fixture.app.chapterMemberships = [{ chapterID: 'chapter-b', organizationID: 'org-a', selected: true }];
    mount(); await flush(); expect(texts(harness.state.tree)).not.toContain('Before the move');
    expect(fixture.deleted).not.toContain('file:///old-voice.m4a');
  });
  it('refuses a stale campaign from another organization before reading content', async () => {
    live(); seedOld('authenticated.user-a.chapter-a'); fixture.app.organizationID = 'org-b';
    mount(); await flush(); expect(texts(harness.state.tree)).not.toContain('Before the move');
    expect(elements(harness.state.tree).some((e) => e.props.accessibilityLabel === 'Quick note')).toBe(false);
  });
  it('keeps authenticated capture closed without a verified organization', async () => {
    live(); seedOld('authenticated.user-a.chapter-a'); fixture.app.organizationID = null;
    fixture.app.chapterMemberships = [{ chapterID: 'chapter-a', organizationID: null, selected: true }];
    mount(); await flush();
    expect(texts(harness.state.tree)).not.toContain('Before the move');
    expect(elements(harness.state.tree).some((e) => e.props.accessibilityLabel === 'Quick note')).toBe(false);
    expect(fixture.deleted).not.toContain('file:///old-voice.m4a');
  });
  it('worker identity never gets capture access', async () => {
    fixture.app.chapterRoles = []; fixture.app.authorizedRoles = []; mount(); await flush();
    expect(harness.state.tree).toBeNull(); expect(fixture.store.size).toBe(0);
  });
  it.each(['locked', 'privacyCovered'] as const)('unmounts and stops recording on %s', async (cover) => {
    mount(); await flush(); press('Record a voice note'); await flush();
    fixture.app[cover] = true; mount(); await flush();
    expect(harness.state.tree).toBeNull(); expect(fixture.recorderStop).toHaveBeenCalledOnce();
    expect(fixture.recorderRelease).toHaveBeenCalledOnce();
    expect(fixture.deleted).toContain('file:///new-voice.m4a');
  });
  it('stops saved-voice playback when Work loses focus without deleting the saved file', async () => {
    seedOld(SCOPE); mount(); await flush(); press('Play voice note, 0:02');
    fixture.focused = false; mount(); await flush();
    expect(harness.state.tree).toBeNull(); expect(fixture.playerRemove).toHaveBeenCalledOnce();
    expect(fixture.deleted).not.toContain('file:///old-voice.m4a');
  });
  it('never starts the microphone after a lock interrupts its permission prompt', async () => {
    let allow!: (value: { granted: boolean }) => void;
    fixture.permission.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; }));
    mount(); await flush(); press('Record a voice note');
    fixture.app.locked = true; mount(); allow({ granted: true }); await flush();
    expect(fixture.audioMode).not.toHaveBeenCalled(); expect(fixture.recorderStop).not.toHaveBeenCalled();
    expect(harness.state.tree).toBeNull();
  });
  it('releases a recorder prepared after Work loses focus', async () => {
    let prepared!: () => void;
    fixture.prepare.mockImplementationOnce(() => new Promise((resolve) => { prepared = () => resolve(undefined); }));
    mount(); await flush(); press('Record a voice note'); await flush();
    fixture.focused = false; mount(); prepared(); await flush();
    expect(fixture.recorderRelease).toHaveBeenCalledOnce();
    expect(fixture.deleted).toContain('file:///new-voice.m4a');
    expect(harness.state.tree).toBeNull();
  });
  it('retains the saved voice file if lock arrives during note persistence', async () => {
    mount(); await flush(); press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    let finishWrite!: () => void;
    fixture.writeDelay = () => new Promise((resolve) => { finishWrite = resolve; });
    press('Save note'); await flush();
    fixture.app.locked = true; mount(); await flush();
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
    fixture.writeDelay = null; finishWrite(); await flush();
    expect((await loadQuickNotes(SCOPE))[0]?.voiceUri).toBe('file:///new-voice.m4a');
    expect(fixture.deleted).not.toContain('file:///new-voice.m4a');
    expect(harness.state.tree).toBeNull();
  });
});

// BUG-UG-QUICK-CAPTURE-FULL-LIST-DELETES-OLDEST-20261122 (#9536):
// Create on a full list used to save the new capture and silently delete the
// oldest one. Now it keeps what was typed or recorded, says how to make room in
// an alert and through the announcement queue, and deletes nothing.
async function announced() {
  // The shared announcement queue flushes on the next macrotask.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  return [...fixture.announceQueued.mock.calls.map(([message]) => message), ...fixture.announce.mock.calls.map(([message]) => message)];
}
function seedFull(scope: string) {
  const prefix = `org.unionground.app.quickcapture.v1.${scope}`;
  const noteIds = Array.from({ length: 12 }, (_, index) => `full-note-${index}`);
  const taskIds = Array.from({ length: 20 }, (_, index) => `full-task-${index}`);
  fixture.store.set(`${prefix}.notes.index`, JSON.stringify(noteIds));
  noteIds.forEach((id, index) => fixture.store.set(`${prefix}.notes.${id}`, JSON.stringify({ id, body: `Saved note ${index}`, voiceUri: null, voiceDurationMs: null, createdAt: '2026-11-01T00:00:00-04:00' })));
  fixture.store.set(`${prefix}.tasks.index`, JSON.stringify(taskIds));
  taskIds.forEach((id, index) => fixture.store.set(`${prefix}.tasks.${id}`, JSON.stringify({ id, title: `Saved task ${index}`, done: false, createdAt: '2026-11-01T00:00:00-04:00' })));
}

describe('quick capture at its limits keeps every saved item (#9536)', () => {
  const TASKS_FULL = 'Quick capture holds 20 tasks. Delete one, then add this.';
  const NOTES_FULL = 'Quick capture holds 12 notes, voice notes included. Delete one, then save this.';

  it('states both limits beside the lists before they are reached', async () => {
    mount(); await flush();
    const shown = texts(harness.state.tree);
    expect(shown).toContain('Holds up to 12 notes, voice notes included.');
    expect(shown).toContain('Holds up to 20 tasks.');
  });

  it('saves 20 tasks and 12 notes, refuses one more of each, and keeps every earlier item', async () => {
    mount(); await flush();
    for (let index = 0; index < 12; index += 1) {
      type('Quick note', `Note ${index}`); press('Save note'); await flush();
    }
    for (let index = 0; index < 20; index += 1) {
      type('New task title', `Task ${index}`); press('Create task'); await flush();
    }
    expect(fixture.alert).not.toHaveBeenCalled();
    const notesBefore = await loadQuickNotes(SCOPE);
    const tasksBefore = await loadQuickTasks(SCOPE);
    expect(notesBefore).toHaveLength(12);
    expect(tasksBefore).toHaveLength(20);

    type('New task title', 'Task 20'); press('Create task'); await flush();
    expect(fixture.alert).toHaveBeenCalledWith('Quick capture is full', TASKS_FULL, [{ text: 'OK' }]);
    expect(await announced()).toEqual([TASKS_FULL]);
    expect(fixture.announceQueued).toHaveBeenCalledWith(TASKS_FULL, { queue: true });
    expect(find('New task title').props.value).toBe('Task 20');
    expect(find('New task title').props.editable).toBe(true);
    expect(await loadQuickTasks(SCOPE)).toEqual(tasksBefore);
    for (let index = 0; index < 20; index += 1) expect(find(`Task ${index}`)).toBeTruthy();

    // A note with a voice take: the text and the take both stay.
    type('Quick note', 'Note 12'); press('Record a voice note'); await flush();
    press('Stop recording'); await flush(); press('Save note'); await flush();
    expect(fixture.alert).toHaveBeenLastCalledWith('Quick capture is full', NOTES_FULL, [{ text: 'OK' }]);
    expect(await announced()).toEqual([TASKS_FULL, NOTES_FULL]);
    expect(find('Quick note').props.value).toBe('Note 12');
    expect(find('Play voice memo, 0:05')).toBeTruthy();
    expect(await loadQuickNotes(SCOPE)).toEqual(notesBefore);
    expect(fixture.deleted).toEqual([]);
    expect(texts(harness.state.tree)).toEqual(expect.arrayContaining(notesBefore.map((note) => note.body)));

    // Deleting one makes room, and the held note then saves with its take.
    press('Delete note'); await flush();
    press('Save note'); await flush();
    const after = await loadQuickNotes(SCOPE);
    expect(after).toHaveLength(12);
    expect(after[0]).toMatchObject({ body: 'Note 12', voiceUri: 'file:///new-voice.m4a' });
    expect(fixture.alert).toHaveBeenCalledTimes(2);
  });

  it('lets a refused take still be discarded, so its file is not left behind', async () => {
    seedFull(SCOPE); mount(); await flush();
    press('Record a voice note'); await flush(); press('Stop recording'); await flush();
    press('Save note'); await flush();
    expect(fixture.alert).toHaveBeenCalledWith('Quick capture is full', NOTES_FULL, [{ text: 'OK' }]);
    expect(find('Discard voice memo').props.disabled).toBe(false);
    press('Discard voice memo');
    expect(fixture.deleted).toEqual(['file:///new-voice.m4a']);
    expect(await loadQuickNotes(SCOPE)).toHaveLength(12);
  });
});

const PLATFORMS: Array<'ios' | 'android'> = ['ios', 'android'];

// UX-UG-NATIVE-STAFF-DESKS-POLISH-BATCH-20261111 (#8302): quick
// capture speaks the saved member language on both phones: labels, hints,
// placeholders, validation and every action-result notice. Entered text stays
// exactly as typed, and the capture behavior itself is unchanged.
describe.each(PLATFORMS)('quick capture in the saved worker language on %s', (platform) => {
  function visible() {
    const all = elements(harness.state.tree);
    const attributes = all.flatMap((e) => [e.props.accessibilityLabel, e.props.label, (e.props as { placeholder?: string }).placeholder]);
    return [...texts(harness.state.tree), ...attributes.flatMap((text) => (typeof text === 'string' ? [text] : []))];
  }

  it('shows Spanish headings, controls, placeholders and pinned destinations', async () => {
    fixture.platform = platform; fixture.app.memberLanguage = 'es';
    mount(); await flush();
    const shown = visible();
    for (const text of ['Captura rápida', 'DESTINOS FIJADOS', 'NOTA RÁPIDA', 'TAREA RÁPIDA', 'Nota rápida', 'Anote algo', 'Grabar una nota de voz',
      'Guardar nota', 'Título de la nueva tarea', 'Añada una tarea', 'Crear tarea']) expect(shown, text).toContain(text);
    for (const text of ['Quick capture', 'Save note', 'Quick note', 'Create task', 'Capture a note', 'Add a task', 'PINNED DESTINATIONS']) expect(shown, text).not.toContain(text);
    const pinned = elements(harness.state.tree).filter((e) => e.type === 'Button' && e.props.label !== 'Guardar nota').map((e) => e.props.label);
    expect(pinned.length).toBeGreaterThan(0);
    const { nativeUiSpanish } = await import('../lib/nativeUiCopy');
    for (const label of pinned) expect(Object.values(nativeUiSpanish), label).toContain(label);
  });

  it('gives Spanish validation and result notices and keeps typed text as entered', async () => {
    fixture.platform = platform; fixture.app.memberLanguage = 'es';
    mount(); await flush();
    find('Guardar nota').props.onPress!(); await flush();
    expect(visible()).toContain('Escriba o grabe algo antes de guardar.');
    fixture.permission.mockResolvedValueOnce({ granted: false });
    press('Grabar una nota de voz'); await flush();
    expect(visible()).toContain('El acceso al micrófono está desactivado para Union Ground. Permítalo en Ajustes para grabar.');
    type('Título de la nueva tarea', 'Call the employer'); press('Crear tarea'); await flush();
    expect(elements(harness.state.tree).some((e) => e.props.accessibilityLabel === 'Call the employer')).toBe(true);
    expect(visible()).toContain('Eliminar tarea');
    fixture.writeDelay = () => Promise.reject(new Error('Keychain unavailable'));
    type('Nota rápida', 'Nota del turno'); press('Guardar nota'); await flush();
    expect(visible()).toContain('No se pudo guardar su nota de forma segura. Sigue en el editor para que pueda volver a intentarlo.');
    expect(find('Nota rápida').props.value).toBe('Nota del turno');
  });

  it('offers the Spanish retry when quick capture cannot load', async () => {
    live(); seedOld('authenticated.user-a.chapter-a');
    fixture.platform = platform; fixture.app.memberLanguage = 'es'; fixture.failStorageRead = true;
    mount(); await flush();
    expect(visible()).toContain('La captura rápida no está disponible para esta campaña.');
    fixture.failStorageRead = false; press('Reintentar la captura rápida'); await flush();
    // The retry behaves as before, and the member's own note keeps its words.
    expect(texts(harness.state.tree)).toContain('Before the move');
    expect(find('Nota rápida')).toBeTruthy();
  });

  it('explains a full list in Spanish and keeps the typed task (#9536)', async () => {
    seedFull(SCOPE);
    fixture.platform = platform; fixture.app.memberLanguage = 'es';
    mount(); await flush();
    expect(visible()).toContain('Admite hasta 12 notas, incluidas las notas de voz.');
    expect(visible()).toContain('Admite hasta 20 tareas.');
    type('Título de la nueva tarea', 'Llamar al empleador'); press('Crear tarea'); await flush();
    const tasksFull = 'La captura rápida admite 20 tareas. Elimine una y luego añada esta.';
    expect(fixture.alert).toHaveBeenCalledWith('La captura rápida está llena', tasksFull, [{ text: 'Aceptar' }]);
    expect(await announced()).toEqual([tasksFull]);
    if (platform === 'ios') expect(fixture.announceQueued).toHaveBeenCalledWith(tasksFull, { queue: true });
    else expect(fixture.announce).toHaveBeenCalledWith(tasksFull);
    expect(find('Título de la nueva tarea').props.value).toBe('Llamar al empleador');
    type('Nota rápida', 'Nota del turno'); press('Guardar nota'); await flush();
    expect(fixture.alert).toHaveBeenLastCalledWith('La captura rápida está llena',
      'La captura rápida admite 12 notas, incluidas las notas de voz. Elimine una y luego guarde esta.', [{ text: 'Aceptar' }]);
    expect(find('Nota rápida').props.value).toBe('Nota del turno');
    expect(await loadQuickTasks(SCOPE)).toHaveLength(20);
    expect(await loadQuickNotes(SCOPE)).toHaveLength(12);
  });

  it('keeps English for an English worker', async () => {
    fixture.platform = platform; fixture.app.memberLanguage = 'en';
    mount(); await flush();
    for (const text of ['Quick capture', 'PINNED DESTINATIONS', 'Save note', 'Capture a note', 'Create task']) expect(visible(), text).toContain(text);
  });
});

describe.each(PLATFORMS)('live Work staff desks in the saved worker language on %s', (platform) => {
  it.each(['steward', 'coordinator', 'advisor', 'admin', 'vp'])('words every %s desk row and its blurb in Spanish', async (role) => {
    const { nativeUiSpanish } = await import('../lib/nativeUiCopy');
    const spanish = new Set(Object.values(nativeUiSpanish));
    fixture.platform = platform; fixture.app.memberLanguage = 'es';
    fixture.app.mode = 'authenticated';
    fixture.app.authorizedRoles = [role]; fixture.app.chapterRoles = [role]; fixture.app.organizationRoles = [role];
    Object.assign(fixture.app, { staffRoleChoices: [], chosenStaffRole: null });
    harness.state.body = () => WorkScreen(); harness.render();
    expect(texts(harness.state.tree)).toContain('Sus áreas de trabajo');
    const desks = elements(harness.state.tree).filter((e) => e.type === 'Pressable' && e.props.accessibilityLabel?.startsWith('Abrir '));
    expect(desks.length).toBeGreaterThan(0);
    for (const desk of desks) {
      const render: unknown = desk.props.children;
      if (typeof render !== 'function') throw new Error('Each desk row renders from its pressed state');
      const card: React.ReactNode = render({ pressed: false });
      const words = texts(card);
      expect(words).toHaveLength(2);
      for (const text of words) expect(spanish.has(text) || text === 'Trabajo del personal de su campaña.', `${role}: ${text}`).toBe(true);
    }
  });
});
