// @vitest-environment jsdom
import { stubSessionWriter } from '../../testing/stubSessionWriter';
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029 (native): a
// feature guide waits for the device's stored marks before it shows or
// records anything, so a first render never overwrites a stored dismissal;
// and any staff role, at either scope, keeps member-only guides away.

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  pendingRead: null as null | ((value: string | null) => void),
  // Held reads wait for pendingRead; otherwise the store answers at once.
  holdReads: false,
  proof: null as Promise<void> | null,
  mode: 'authenticated',
  focused: true,
  platform: 'ios',
  memberLanguage: 'en',
  announce: vi.fn<(message: string) => void>(),
  roles: { organizationRoles: [] as string[], chapterRoles: [] as string[], authorizedRoles: [] as string[] },
  rpc: vi.fn<(name?: string, args?: { p_mark?: string }) => Promise<{ data: unknown; error: unknown }>>(async () => ({ data: { switches: { 'features.guidance_onboarding.feature_guides': true } }, error: null })),
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return mocks.platform; } },
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
  Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-router', () => ({ useIsFocused: () => mocks.focused, useRouter: () => ({ push: vi.fn<(path: string) => void>() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fictional-save-id' }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn((key: string) => mocks.holdReads
    ? new Promise((resolve) => { mocks.pendingRead = () => { mocks.holdReads = false; resolve(mocks.store.get(key) ?? null); }; })
    : Promise.resolve(mocks.store.get(key) ?? null)),
  setItemAsync: vi.fn(async (key: string, value: string) => { mocks.store.set(key, value); }),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('../../services/supabase', () => ({ getSupabaseClient: () => ({ rpc: mocks.rpc }), captureSessionWriter: () => ({ ...stubSessionWriter(() => ({ rpc: mocks.rpc })), check: async () => { if (mocks.proof) { const proof = mocks.proof; mocks.proof = null; await proof; } return 'current'; } }) }));
vi.mock('../../services/haptics', () => ({ haptics: { select: vi.fn(async () => undefined) } }));
// #6248: the PostHog flag that gates the coach mark, as the hook serves it.
const flag = vi.hoisted(() => ({ variant: 'control', exposed: [] as boolean[] }));
vi.mock('../../services/nativeFeatureFlag', () => ({ useNativeFeatureFlag: (_key: string, options: { exposed?: boolean }) => { flag.exposed.push(Boolean(options.exposed)); return flag.variant; } }));
vi.mock('../../state/AppProvider', () => ({
  useApp: () => ({ mode: mocks.mode, session: SESSION, memberLanguage: mocks.memberLanguage, ...mocks.roles }),
}));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../../theme/tokens', async () => ({
  ...await vi.importActual<typeof import('../../theme/tokens')>('../../theme/tokens'),
  minimumTouchTarget: 48,
  radii: { md: 8 },
  spacing: { sm: 8, md: 12 },
}));
vi.mock('../../components/ui', () => ({
  Body: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
  Button: ({ label, onPress, variant = 'primary', disabled, busy }: { label: string; onPress: () => void; variant?: string; disabled?: boolean; busy?: boolean }) =>
    createElement('button', { onClick: onPress, disabled: disabled || busy, 'aria-busy': busy, 'data-variant': variant }, label),
  Notice: ({ children }: { children: string }) => createElement('p', { 'data-notice': true }, children),
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  Heading: ({ children }: { children?: ReactNode }) => createElement('h2', null, children),
}));

const SESSION = { user: { id: 'member-a' } };

import { NativeCoachMark, NativeFeatureGuide, NativeOrgStartGuide, isMemberOnly, useOrganizationStartGuide } from './GuideLayers';
import { NativeStaffGuides } from './StaffGuides';
import { featureMarksKey, guideText } from './guideLayersData';

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.store.clear();
  mocks.pendingRead = null;
  mocks.holdReads = false;
  mocks.proof = null;
  mocks.mode = 'authenticated';
  mocks.focused = true;
  mocks.platform = 'ios';
  mocks.memberLanguage = 'en';
  mocks.announce.mockClear();
  mocks.rpc.mockReset().mockResolvedValue({ data: { switches: { 'features.guidance_onboarding.feature_guides': true } }, error: null });
  mocks.roles = { organizationRoles: [], chapterRoles: [], authorizedRoles: [] };
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

it('holds overlapping guide writes until proof settles, then keeps the newer result', async () => {
  let guide!: ReturnType<typeof useOrganizationStartGuide>;
  function Probe() { guide = useOrganizationStartGuide(true); return createElement('p', null, JSON.stringify(guide.payload)); }
  root = createRoot(host);
  await act(async () => { root?.render(createElement(Probe)); });
  let release!: () => void;
  mocks.proof = new Promise<void>((resolve) => { release = resolve; });
  let old!: Promise<void>;
  let oldSettled = false;
  await act(async () => { old = guide.run(async () => ({ marker: 'old' })); await Promise.resolve(); });
  void old.then(() => { oldSettled = true; });
  await act(async () => { await Promise.resolve(); });
  expect(oldSettled).toBe(false);
  const newerWrite = vi.fn(async () => ({ marker: 'new' }));
  await act(async () => { await guide.run(newerWrite); });
  expect(newerWrite).not.toHaveBeenCalled();
  expect(oldSettled).toBe(false);
  await act(async () => { release(); await old; });
  expect(oldSettled).toBe(true);
  expect(host.textContent).toContain('old');
  await act(async () => { await guide.run(newerWrite); });
  expect(newerWrite).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('new');
  expect(host.textContent).not.toContain('old');
});

it('keeps an accepted organization-guide result through a same-person resume', async () => {
  let guide!: ReturnType<typeof useOrganizationStartGuide>;
  function Probe() { guide = useOrganizationStartGuide(true); return createElement('p', null, JSON.stringify(guide.payload)); }
  root = createRoot(host); await act(async () => { root?.render(createElement(Probe)); });
  let release!: () => void;
  mocks.proof = new Promise<void>((resolve) => { release = resolve; });
  let pending!: Promise<void>;
  await act(async () => { pending = guide.run(async () => ({ marker: 'accepted-through-resume' })); await Promise.resolve(); });
  mocks.mode = 'booting'; await act(async () => { root?.render(createElement(Probe)); });
  mocks.rpc.mockResolvedValueOnce({ data: { marker: 'accepted-through-resume' }, error: null });
  mocks.mode = 'authenticated'; await act(async () => { root?.render(createElement(Probe)); });
  await act(async () => { release(); await pending; });
  expect(host.textContent).toContain('accepted-through-resume');
});

it.each([
  { os: 'ios', read: 'displayed' }, { os: 'android', read: 'displayed' },
  { os: 'ios', read: 'pending' }, { os: 'android', read: 'pending' },
])('round 1 guide write keeps the newer $read read on $os', async ({ os, read }) => {
  mocks.platform = os;
  let guide!: ReturnType<typeof useOrganizationStartGuide>;
  function Probe() { guide = useOrganizationStartGuide(true); return createElement('p', null, JSON.stringify(guide.payload)); }
  root = createRoot(host); await act(async () => { root?.render(createElement(Probe)); });
  let finishProof!: () => void;
  mocks.proof = new Promise(resolve => { finishProof = resolve; });
  let saved!: Promise<void>;
  await act(async () => { saved = guide.run(async () => ({ marker: 'older-A' })); });
  mocks.focused = false; await act(async () => { root?.render(createElement(Probe)); });
  let finishRead!: (value: { data: unknown; error: null }) => void;
  const latest = { data: { marker: 'newer-B' }, error: null };
  mocks.rpc.mockImplementationOnce(() => read === 'pending' ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve(latest));
  mocks.focused = true; await act(async () => { root?.render(createElement(Probe)); });
  if (read === 'displayed') expect(host.textContent).toContain('newer-B');
  await act(async () => { finishProof(); await saved; });
  if (read === 'pending') await act(async () => { finishRead(latest); });
  expect(host.textContent).toContain('newer-B');
  expect(host.textContent).not.toContain('older-A');
});

// Ledger 692 (stage 511 on #9429): when the organization guide could not be
// read, the Work screen offers a read-only Refresh, as the steward desk does.
// It reads only on current session proof and holds its control until done.
type GuideAnswer = { data: unknown; error: unknown };
const GUIDE_READ = 'get_organization_start_guide';
function answerGuide(guide: () => Promise<GuideAnswer>) {
  mocks.rpc.mockImplementation(async (name?: string) => name === GUIDE_READ ? guide()
    : { data: { switches: { 'features.guidance_onboarding.org_start_guide': true } }, error: null });
}
const guideReads = () => mocks.rpc.mock.calls.filter((call: unknown[]) => call[0] === GUIDE_READ).length;
const ACTIVE_GUIDE = { state: 'active', organizationName: 'Quillmere Workers', viewer: { isAdmin: false }, milestones: [] };
describe.each(['ios', 'android'])('organization guide that could not be read on %s', (os) => {
  it('offers a guarded Refresh that reads the guide again on current proof', async () => {
    mocks.platform = os;
    answerGuide(async () => ({ data: null, error: { message: 'offline' } }));
    let guide!: ReturnType<typeof useOrganizationStartGuide>;
    function Probe() { guide = useOrganizationStartGuide(true); return createElement('p', null, guide.unavailable ? 'unavailable' : JSON.stringify(guide.payload)); }
    root = createRoot(host); await act(async () => { root?.render(createElement(Probe)); });
    expect(host.textContent).toBe('unavailable');
    expect(guideReads()).toBe(1);
    answerGuide(async () => ({ data: ACTIVE_GUIDE, error: null }));
    let release!: () => void;
    mocks.proof = new Promise<void>((resolve) => { release = resolve; });
    let first: Promise<void> = Promise.resolve(), second: Promise<void> = Promise.resolve();
    await act(async () => { first = guide.refresh(); second = guide.refresh(); await Promise.resolve(); });
    expect(guide.busy).toBe(true);
    expect(guideReads()).toBe(1);
    await act(async () => { release(); await first; await second; });
    expect(guideReads()).toBe(2);
    expect(guide.busy).toBe(false);
    expect(host.textContent).toContain('Quillmere Workers');
  });

  it('shows Refresh on the Work screen only when the guide could not be read', async () => {
    mocks.platform = os;
    answerGuide(async () => ({ data: null, error: { message: 'offline' } }));
    root = createRoot(host); await act(async () => { root?.render(createElement(NativeOrgStartGuide)); });
    await settle();
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Refresh']);
    act(() => root?.unmount());
    answerGuide(async () => ({ data: { state: 'off' }, error: null }));
    root = createRoot(host); await act(async () => { root?.render(createElement(NativeOrgStartGuide)); });
    await settle();
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});

type MountedFeature = 'events' | 'home' | 'pulse';
async function mount(...features: MountedFeature[]) {
  root = createRoot(host);
  const guides = (features.length ? features : ['events' as const]).map((feature) => createElement('div', { key: feature, 'data-guide': feature }, createElement(NativeFeatureGuide, { feature })));
  await act(async () => { root?.render(createElement(Fragment, null, ...guides)); });
}

// Lets the shared mark queue, its reads and writes, and the renders they cause finish.
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const storedMarks = () => JSON.parse(mocks.store.get(featureMarksKey('member-a')) ?? '{}') as { seen?: Record<string, number>; got?: Record<string, number> };

describe('native feature guide', () => {
  it('shows and records nothing until the stored marks load, and keeps a stored dismissal', async () => {
    const stored = JSON.stringify({ seen: { events: 1 }, got: { events: 2 }, reopen: {}, acted: {} });
    mocks.store.set(featureMarksKey('member-a'), stored);
    mocks.holdReads = true;
    await mount();
    expect(host.textContent).toBe('');
    expect(mocks.store.get(featureMarksKey('member-a'))).toBe(stored);
    await act(async () => { mocks.pendingRead?.(null); });
    // Already closed with Got it: still closed, and the record is untouched.
    expect(host.textContent).toBe('');
    expect(mocks.store.get(featureMarksKey('member-a'))).toBe(stored);
  });

  it('shows a first-time guide once the empty record loads and records it as seen', async () => {
    await mount();
    await settle();
    expect(host.textContent).toContain('Meetings');
    expect(storedMarks().seen?.events).toEqual(expect.any(Number));
  });

  // BUG-UG-NATIVE-FEATURE-GUIDE-MARKS-AND-PULSE-20261102: native
  // tabs stay mounted, so two guides are live at once. Each used to write its
  // own copy back, and the second Got it dropped the first.
  it('keeps both guides\' marks when two mounted guides mark in turn', async () => {
    await mount('events', 'home');
    await settle();
    expect(storedMarks().seen).toEqual({ events: expect.any(Number), home: expect.any(Number) });
    const gotIt = (feature: string) => Array.from(host.querySelectorAll(`[data-guide="${feature}"] button`)).find((button) => button.textContent === 'Got it') as HTMLButtonElement;
    await act(async () => { gotIt('events').click(); });
    await settle();
    await act(async () => { gotIt('home').click(); });
    await settle();
    expect(storedMarks().got).toEqual({ events: expect.any(Number), home: expect.any(Number) });
    expect(storedMarks().seen).toEqual({ events: expect.any(Number), home: expect.any(Number) });
    expect(host.textContent).toBe('');
  });

  it('shows the Pulse guide when feature guides are on', async () => {
    await mount('pulse');
    await settle();
    expect(host.textContent).toContain('Campaign pulse');
    expect(storedMarks().seen?.pulse).toEqual(expect.any(Number));
  });

  it.each<MountedFeature>(['events', 'home', 'pulse'])('keeps %s guide actions secondary and remembers Got it after a remount', async (feature) => {
    await mount(feature);
    await settle();
    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.dataset.variant === 'secondary')).toBe(true);
    await act(async () => { buttons.find((button) => button.textContent === 'Got it')!.click(); });
    await settle();
    expect(storedMarks().got?.[feature]).toEqual(expect.any(Number));
    act(() => root?.unmount());
    await mount(feature);
    await settle();
    expect(host.textContent).toBe('');
  });

  it('keeps worker guides away from a chapter-only staff role', async () => {
    mocks.roles = { organizationRoles: [], chapterRoles: ['steward'], authorizedRoles: ['steward'] };
    await mount();
    await settle();
    expect(host.textContent).toBe('');
    expect(isMemberOnly([], [], [])).toBe(true);
    expect(isMemberOnly([], ['steward'], [])).toBe(false);
  });
});

// OPS-UG-POSTHOG-FLAGS-EXPERIMENTS-SURVEYS-HEATMAPS-20261027 (#6248).
describe('native coach mark behind member-coach-mark', () => {
  async function coachMark(variant: string) {
    vi.useFakeTimers();
    flag.variant = variant;
    flag.exposed.length = 0;
    const coachMarksOn: Record<string, boolean> = { 'features.guidance_onboarding.coach_marks': true };
    mocks.rpc.mockResolvedValue({ data: { switches: coachMarksOn as { 'features.guidance_onboarding.feature_guides': boolean } }, error: null });
    root = createRoot(host);
    await act(async () => { root?.render(createElement(NativeCoachMark, { stepId: 'step-1', stepTitle: 'Confirm your email' })); });
    await act(async () => { mocks.pendingRead?.(null); });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    vi.useRealTimers();
    return host.textContent ?? '';
  }

  it('shows the coach mark for the default control variant and withholds it for test, exposing the flag only where the switch is on', async () => {
    expect(await coachMark('control')).toContain('Next step');
    expect(host.querySelector('button')?.dataset.variant).toBe('secondary');
    expect(flag.exposed.at(-1)).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(await coachMark('test')).not.toContain('Next step');
    expect(flag.exposed.at(-1)).toBe(true);
  });

  it('shows and announces the coach mark in the profile language while preserving the named next step', async () => {
    mocks.memberLanguage = 'es';
    const text = await coachMark('control');
    expect(text).toContain('Siguiente paso');
    expect(text).toContain('Tu siguiente paso es: Confirm your email');
    expect(text).not.toContain('Your next step is:');
    expect(host.querySelector('button')?.textContent).toBe('Entendido');
    expect(mocks.announce).toHaveBeenCalledExactlyOnceWith('Siguiente paso. Tu siguiente paso es: Confirm your email');
  });
});

describe.each([
  ['en', 'That did not save. Try again.'],
  ['es', 'No se guardó. Inténtelo de nuevo.'],
])('staff guide save feedback in %s', (language, refusal) => {
  const control = (name: RegExp) => [...host.querySelectorAll('button')].find((button) => name.test(button.getAttribute('aria-label') ?? button.textContent ?? ''));
  const cases: [string, typeof NativeStaffGuides, RegExp, string][] = [
    ['Got it', NativeStaffGuides, /^(Got it|Entendido)$/, 'mark_staff_onboarding_step'],
    ['Done', NativeOrgStartGuide, /^(Done|Listo)$/, 'acknowledge_organization_start_celebration'],
  ];

  it.each(cases)('%s keeps the card and offers another try after a failed save', async (action, Component, buttonName, rpc) => {
    mocks.memberLanguage = language;
    mocks.roles = { organizationRoles: [], chapterRoles: ['steward'], authorizedRoles: ['steward'] };
    const staff = { state: 'active', roles: ['steward'], steps: [] };
    const save = vi.fn<() => Promise<GuideAnswer>>()
      .mockResolvedValueOnce({ data: null, error: { message: 'fixture offline' } })
      .mockResolvedValueOnce({ data: action === 'Done' ? { state: 'done' } : staff, error: null });
    mocks.rpc.mockImplementation(async (name, args) => {
      if (name === GUIDE_READ) return { data: { state: 'live', organizationName: 'Quillmere Workers' }, error: null };
      if (name === rpc && (action === 'Done' || args?.p_mark === 'got')) return save();
      if (name === 'get_staff_onboarding_guide' || name === 'mark_staff_onboarding_step') return { data: staff, error: null };
      return { data: { switches: { 'features.guidance_onboarding.org_start_guide': true } }, error: null };
    });
    root = createRoot(host);
    await act(async () => { root?.render(createElement(Component)); });
    if (action === 'Got it') await act(async () => { control(/^Issue work,/i)!.click(); });
    await act(async () => { control(buttonName)!.click(); });
    expect(host.querySelector('[data-notice]')?.textContent).toBe(refusal);
    expect(control(buttonName)?.disabled).toBe(false);

    await act(async () => { control(buttonName)!.click(); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-notice]')).toBeNull();
    expect(control(buttonName)).toBeUndefined();
  });
});

// BUG-UG-PHONE-STAFF-GUIDES-FAILED-READ-LOOKS-EMPTY-20261125 (#9957,
// carved from #9465): a failed staff guide read dropped the card, exactly as a
// person with no guides sees, so a steward could not tell the read had failed.
// The card keeps its own heading (the phone's guide lines, guideText).
const GUIDE_FAILURE_CASES: Array<[string, string, string, string]> = [
  ['en', 'Your feature guides could not be loaded.', 'Loading your feature guides.', 'Try again'],
  ['es', 'No se pudieron cargar tus guías de funciones.', 'Cargando tus guías de funciones.', 'Reintentar'],
];
describe.each(GUIDE_FAILURE_CASES)('a failed staff guide read in %s', (language, failed, loading, retry) => {
  const heading = guideText({ key: 'guideEngine.sf.yourGuides' });
  const control = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === name);
  const staffGuide = { state: 'active', roles: ['steward'], steps: [] };

  it('keeps the card, says the guides could not be loaded, and loads them on Try again', async () => {
    mocks.memberLanguage = language;
    mocks.roles = { organizationRoles: [], chapterRoles: ['steward'], authorizedRoles: ['steward'] };
    let release: (answer: GuideAnswer) => void = () => {};
    const read = vi.fn<() => Promise<GuideAnswer>>()
      .mockResolvedValueOnce({ data: null, error: { message: 'fixture offline' } })
      .mockImplementationOnce(() => new Promise<GuideAnswer>((resolve) => { release = resolve; }));
    mocks.rpc.mockImplementation(async (name) => {
      if (name === 'get_staff_onboarding_guide') return read();
      return { data: staffGuide, error: null };
    });
    root = createRoot(host);
    await act(async () => { root?.render(createElement(NativeStaffGuides)); });
    expect(host.querySelector('h2')?.textContent).toBe(heading);
    expect(host.querySelector('[data-notice]')?.textContent).toBe(failed);
    await act(async () => { control(retry)!.click(); });
    // While the retry read runs, the card and its heading stay, with a loading line and a busy button.
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.querySelector('h2')?.textContent).toBe(heading);
    expect(host.textContent).toContain(loading);
    expect(host.textContent).not.toContain(failed);
    expect(control(retry)?.disabled).toBe(true);
    await act(async () => { release({ data: staffGuide, error: null }); });
    expect(host.textContent).not.toContain(loading);
    expect(host.textContent).toContain('Issue work');
  });

  it.each([
    ['switched off', { state: 'off', organizationId: 'org-a' }],
    ['hidden', { state: 'hidden' }],
  ])('shows no card when a staff read succeeds with no guides (%s)', async (_answer, data) => {
    mocks.memberLanguage = language;
    mocks.roles = { organizationRoles: [], chapterRoles: ['steward'], authorizedRoles: ['steward'] };
    mocks.rpc.mockImplementation(async (name) => (name === 'get_staff_onboarding_guide' ? { data, error: null } : { data: null, error: null }));
    root = createRoot(host);
    await act(async () => { root?.render(createElement(NativeStaffGuides)); });
    expect(mocks.rpc).toHaveBeenCalledWith('get_staff_onboarding_guide');
    expect(host.textContent).toBe('');
  });

  it('makes no read and shows no card for a person with no staff hat', async () => {
    mocks.memberLanguage = language;
    mocks.roles = { organizationRoles: [], chapterRoles: [], authorizedRoles: [] };
    root = createRoot(host);
    await act(async () => { root?.render(createElement(NativeStaffGuides)); });
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_staff_onboarding_guide');
    expect(host.textContent).toBe('');
  });
});
