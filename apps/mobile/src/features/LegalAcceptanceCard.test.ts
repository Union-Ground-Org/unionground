import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016: the native 18 gate. In an
// app-store age-law state the card asks the store for its age signal when the
// person presses Accept, before the self-attested box counts; a store-reported
// minor is stopped there, and every other outcome leaves the existing
// attestation in charge. The mobile package tests in plain node with no React
// renderer (the NativeSessionsCard harness), so the card's own code runs
// against a synchronous useState/useEffect/useRef and stubbed primitives.
const runtime = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as { deps: unknown[] | undefined; cleanup: (() => void) | void }[],
    effectIndex: 0,
  };
  return {
    state,
    useState<T>(initial: T) {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = initial;
      const set = (next: T | ((previous: T) => T)) => {
        state.slots[index] = typeof next === 'function'
          ? (next as (previous: T) => T)(state.slots[index] as T)
          : next;
      };
      return [state.slots[index] as T, set] as const;
    },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = state.effectIndex++;
      const previous = state.effects[index];
      const changed = !previous
        || previous.deps === undefined
        || deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, position) => value !== previous.deps?.[position]);
      if (!changed) return;
      if (typeof previous?.cleanup === 'function') previous.cleanup();
      state.effects[index] = { deps, cleanup: effect() };
    },
    useCallback<T>(callback: T) {
      return callback;
    },
    useRef<T>(initial: T) {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = { current: initial };
      return state.slots[index] as { current: T };
    },
  };
});

const store = vi.hoisted(() => ({
  // `null` models a build without the native module (web, Expo Go).
  module: null as { requestAgeSignalAsync: () => Promise<unknown> } | null,
  request: vi.fn<() => Promise<unknown>>(),
}));
const service = vi.hoisted(() => ({
  load: vi.fn(async () => ({ versions: {}, acceptedAt: null })),
  record: vi.fn(async (_versions: Record<string, string>, _state: string, _attested: boolean) => true),
}));
const auth = vi.hoisted(() => ({
  session: { user: { id: 'member-a' }, access_token: 'token-a' },
  current: { user: { id: 'member-a' }, access_token: 'token-a' } as { user: { id: string }; access_token: string } | null,
}));
// A live project by default; the SAMPLE describe below pins the SAMPLE origin.
const backend = vi.hoisted(() => ({ config: { backendConfigured: true, supabaseUrl: 'https://live-project.example.test' } }));
vi.mock('../lib/config', () => ({ mobileConfig: backend.config }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ session: auth.session }) }));
vi.mock('../services/supabase', () => ({
  getSupabaseClient: () => ({ auth: {
    getSession: async () => ({ data: { session: auth.current }, error: null }),
  } }),
}));

vi.mock('react', () => ({
  useCallback: runtime.useCallback,
  useEffect: runtime.useEffect,
  useRef: runtime.useRef,
  useState: runtime.useState,
}));
vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn(async () => undefined) },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: 'View',
}));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading' }));
vi.mock('../components/ResidenceAgeFields', () => ({ ResidenceAgeFields: 'ResidenceAgeFields' }));
vi.mock('../theme/ThemeProvider', () => ({
  useTheme: () => ({ border: '#ccc', destructive: '#b00020', input: '#fff', primary: '#004' }),
}));
vi.mock('../theme/tokens', () => ({ minimumTouchTarget: 48, radii: { sm: 4, md: 8 }, spacing: { sm: 8 } }));
vi.mock('../services/legalAcceptance', () => ({
  loadLegalAcceptance: service.load,
  recordLegalAcceptance: service.record,
}));
// A named alias rather than an inline `typeof import(...)` type argument: the
// security lane's semgrep parser stops at that form and fails the scan.
type LegalAcceptanceCopy = typeof import('../lib/legalAcceptance');
vi.mock('../lib/legalAcceptance', async (importOriginal) => ({
  ...(await importOriginal<LegalAcceptanceCopy>()),
  // Home asks only when the server's material-change flag says so; this
  // harness holds that answer fixed so the form is on screen.
  legalAcceptanceRequirement: () => ({ reacceptanceRequired: true, instruments: ['terms-of-use'] }),
}));
vi.mock('../../modules/store-age-signal/src/StoreAgeSignalModule', () => ({
  get default() { return store.module; },
}));

const { LegalAcceptanceCard } = await import('./LegalAcceptanceCard');
const {
  LEGAL_ACCEPTANCE_ACTION,
  LEGAL_ACCEPTANCE_REQUIRED,
  LEGAL_ACCEPTANCE_STORE_BLOCKED,
  LEGAL_ACCEPTANCE_STORE_CHECKING,
} = await import('../lib/legalAcceptance');

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function nodes(root: unknown): Node[] {
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root !== 'object' || root === null) return [];
  const node = root as Node;
  if (!('props' in node)) return [];
  return [node, ...nodes(node.props.children)];
}

function render(props: { language?: string | null } = {}): unknown {
  runtime.state.index = 0;
  runtime.state.effectIndex = 0;
  return LegalAcceptanceCard(props);
}

function text(tree: unknown): string {
  return nodes(tree)
    .flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []))
    .join(' | ');
}

function acceptButton(tree: unknown): Node | undefined {
  return nodes(tree).find((node) => node.type === 'Button');
}

function fields(tree: unknown): Node {
  const found = nodes(tree).find((node) => node.type === 'ResidenceAgeFields');
  expect(found).toBeTruthy();
  return found as Node;
}

function consentBox(tree: unknown): Node {
  const found = nodes(tree).find((node) => node.type === 'Pressable' && node.props.accessibilityRole === 'checkbox');
  expect(found).toBeTruthy();
  return found as Node;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

// Chooses a state and, when asked, ticks both boxes, re-rendering as the real
// fields and checkbox would make the card re-render.
async function fillIn(residence: string, { tick = true } = {}): Promise<unknown> {
  await settle();
  let tree = render();
  (fields(tree).props.onResidenceState as (code: string) => void)(residence);
  tree = render();
  if (tick) {
    (fields(tree).props.onAgeAttested as (value: boolean) => void)(true);
    (consentBox(tree).props.onPress as () => void)();
    tree = render();
  }
  return tree;
}

async function pressAccept(tree: unknown): Promise<unknown> {
  const button = acceptButton(tree);
  expect(button, 'the Accept button').toBeTruthy();
  const pressed = (button as Node).props.onPress as () => void;
  pressed();
  await settle();
  return render();
}

const shared = (lower: number | null, upper: number | null) => ({ platform: 'ios', status: 'shared', lower, upper, source: 'test' });

beforeEach(() => {
  backend.config.supabaseUrl = 'https://live-project.example.test';
  auth.session = { user: { id: 'member-a' }, access_token: 'token-a' };
  auth.current = auth.session;
  runtime.state.slots = [];
  runtime.state.effects = [];
  store.request.mockReset();
  store.module = { requestAgeSignalAsync: store.request };
  service.load.mockClear();
  service.record.mockClear();
  service.record.mockResolvedValue(true);
});

describe('a store-reported minor in an age-law state', () => {
  it('is stopped at Accept with the refusal in place of the button and nothing recorded', async () => {
    store.request.mockResolvedValue(shared(13, 15));
    const tree = await pressAccept(await fillIn('TX'));
    expect(text(tree)).toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
    expect(acceptButton(tree)).toBeUndefined();
    // The refusal names the state the person chose, so the fields stay usable
    // for correcting it once the read has settled.
    expect(fields(tree).props.disabled).toBe(false);
    const alert = nodes(tree).find((node) => node.props.testID === 'legal-acceptance-store-blocked');
    expect(alert?.props.accessibilityLiveRegion).toBe('assertive');
    expect(service.record).not.toHaveBeenCalled();
    expect(store.request).toHaveBeenCalledTimes(1);
  });

  it('is stopped before the boxes are even considered', async () => {
    store.request.mockResolvedValue(shared(null, 16));
    const tree = await pressAccept(await fillIn('CA', { tick: false }));
    expect(text(tree)).toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
    expect(text(tree)).not.toContain(LEGAL_ACCEPTANCE_REQUIRED);
    expect(service.record).not.toHaveBeenCalled();
  });

  it('reads the refusal in English when the worker language is Spanish', async () => {
    store.request.mockResolvedValue(shared(13, 15));
    await settle();
    let tree = render({ language: 'es' });
    (fields(tree).props.onResidenceState as (code: string) => void)('AL');
    tree = render({ language: 'es' });
    ((acceptButton(tree) as Node).props.onPress as () => void)();
    await settle();
    tree = render({ language: 'es' });
    expect(text(tree)).toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
    expect(text(tree)).not.toContain('indica una edad menor de 18 años');
  });

  it('is released by choosing another state, which falls back to the self-attestation', async () => {
    store.request.mockResolvedValue(shared(13, 15));
    let tree = await pressAccept(await fillIn('TX'));
    expect(acceptButton(tree)).toBeUndefined();
    (fields(tree).props.onResidenceState as (code: string) => void)('NY');
    tree = render();
    expect(acceptButton(tree)).toBeTruthy();
    expect(text(tree)).not.toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
  });
});

describe('every other outcome leaves the self-attested rule in charge', () => {
  it('records a store-reported adult once the boxes are ticked, asking the store once across a retry', async () => {
    store.request.mockResolvedValue(shared(18, null));
    service.record.mockResolvedValueOnce(false);
    let tree = await pressAccept(await fillIn('TX'));
    expect(service.record).toHaveBeenCalledWith(expect.any(Object), 'TX', true, auth.session);
    expect(acceptButton(tree)).toBeTruthy();
    tree = await pressAccept(tree);
    expect(service.record).toHaveBeenCalledTimes(2);
    expect(store.request).toHaveBeenCalledTimes(1);
    expect(text(tree)).not.toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
  });

  it('still requires both boxes when the signal is unavailable, declined or indeterminate', async () => {
    for (const answer of [
      { platform: 'android', status: 'unavailable', error: 'play-services-missing' },
      { platform: 'ios', status: 'declined' },
      shared(16, 20),
    ]) {
      runtime.state.slots = [];
      runtime.state.effects = [];
      store.request.mockReset();
      store.request.mockResolvedValue(answer);
      service.record.mockClear();
      const tree = await pressAccept(await fillIn('UT', { tick: false }));
      expect(text(tree)).toContain(LEGAL_ACCEPTANCE_REQUIRED);
      expect(text(tree)).not.toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
      expect(acceptButton(tree)).toBeTruthy();
      expect(service.record).not.toHaveBeenCalled();
    }
  });

  it('falls back to the self-attestation when the native module is missing', async () => {
    store.module = null;
    const tree = await pressAccept(await fillIn('LA'));
    expect(service.record).toHaveBeenCalledWith(expect.any(Object), 'LA', true, auth.session);
    expect(text(tree)).not.toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
    expect(store.request).not.toHaveBeenCalled();
  });

  it('never asks the store outside the age-law states', async () => {
    store.request.mockResolvedValue(shared(13, 15));
    await pressAccept(await fillIn('NY'));
    expect(store.request).not.toHaveBeenCalled();
    expect(service.record).toHaveBeenCalledWith(expect.any(Object), 'NY', true, auth.session);
  });

  it('says it is checking the store while the read is in flight and locks the form meanwhile', async () => {
    //  / on #4776: the store read is an await inside the
    // accept callback, which closes over the state and the boxes, so the
    // controls are disabled until it answers.
    let answer: (value: unknown) => void = () => undefined;
    store.request.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const before = await fillIn('TX');
    ((acceptButton(before) as Node).props.onPress as () => void)();
    await settle();
    const during = render();
    expect(acceptButton(during)?.props.label).toBe(LEGAL_ACCEPTANCE_STORE_CHECKING);
    expect(acceptButton(during)?.props.disabled).toBe(true);
    expect(fields(during).props.disabled).toBe(true);
    expect(consentBox(during).props.disabled).toBe(true);
    answer(shared(21, null));
    await settle();
    const after = render();
    expect(acceptButton(after)?.props.label).toBe(LEGAL_ACCEPTANCE_ACTION);
    expect(fields(after).props.disabled).toBe(false);
    expect(service.record).toHaveBeenCalledTimes(1);
  });

  it('drops a store answer that arrives after the state was changed during the read', async () => {
    // Belt and braces behind the disabled controls: a residence edit that
    // still lands mid-read means the answer belongs to a state no longer on
    // the form, so nothing is blocked and nothing is recorded for it.
    let answer: (value: unknown) => void = () => undefined;
    store.request.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    let tree = await fillIn('TX');
    ((acceptButton(tree) as Node).props.onPress as () => void)();
    await settle();
    tree = render();
    (fields(tree).props.onResidenceState as (code: string) => void)('CA');
    answer(shared(13, 15));
    await settle();
    tree = render();
    expect(service.record).not.toHaveBeenCalled();
    expect(text(tree)).not.toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
    expect(acceptButton(tree)).toBeTruthy();
    // The next Accept asks the store again for the state now chosen.
    store.request.mockResolvedValue(shared(13, 15));
    tree = await pressAccept(tree);
    expect(store.request).toHaveBeenCalledTimes(2);
    expect(text(tree)).toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
  });

  it.each(['member-b', 'same-user-new-session', 'signed-out'])('does not record old consent after Auth changes to %s during the store read', async (replacement) => {
    let answer: (value: unknown) => void = () => undefined;
    store.request.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const tree = await fillIn('TX');
    ((acceptButton(tree) as Node).props.onPress as () => void)();
    await settle();
    // Auth can install a replacement before React renders it. The operation
    // must check Auth itself, not just the session from the last render.
    auth.current = replacement === 'signed-out' ? null : {
      user: { id: replacement === 'member-b' ? 'member-b' : 'member-a' }, access_token: 'token-b',
    };
    answer(shared(21, null));
    await settle();
    expect(service.record).not.toHaveBeenCalled();
  });

  it('does not record consent when the card unmounts during the store read', async () => {
    let answer: (value: unknown) => void = () => undefined;
    store.request.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const tree = await fillIn('TX');
    ((acceptButton(tree) as Node).props.onPress as () => void)();
    await settle();
    for (const effect of runtime.state.effects) effect.cleanup?.();
    answer(shared(21, null));
    await settle();
    expect(service.record).not.toHaveBeenCalled();
  });

  it('requires fresh consent and a fresh store answer when a mounted card changes account', async () => {
    store.request.mockResolvedValueOnce(shared(21, null)).mockResolvedValueOnce(shared(13, 15));
    await pressAccept(await fillIn('TX'));
    expect(service.record).toHaveBeenCalledTimes(1);
    auth.session = { user: { id: 'member-b' }, access_token: 'token-b' };
    auth.current = auth.session;
    render();
    await settle();
    const replacement = render();
    expect(fields(replacement).props.residenceState).toBe('');
    expect(fields(replacement).props.ageAttested).toBe(false);
    expect((consentBox(replacement).props.accessibilityState as { checked: boolean }).checked).toBe(false);
    const blocked = await pressAccept(await fillIn('TX'));
    expect(store.request).toHaveBeenCalledTimes(2);
    expect(service.record).toHaveBeenCalledTimes(1);
    expect(text(blocked)).toContain(LEGAL_ACCEPTANCE_STORE_BLOCKED);
  });
});

// BUG-UG-SAMPLE-ACCOUNTS-ASKED-TO-ACCEPT-TERMS-20261029. Owner ruling,
// October 29, 2026: "NO TERMS FOR SAMPLE. SAMPLE HAS NO REAL USERS". The
// harness holds the material-change answer at "required", so only the SAMPLE
// backend can keep the card off Home (and off the Home drawer beside Work).
describe('a SAMPLE-pinned build', () => {
  it('never reads acceptance, never renders the card and never holds Home for it', async () => {
    const { pinnedSampleSupabaseOrigin } = await import('../../../../src/lib/sampleBackend');
    backend.config.supabaseUrl = pinnedSampleSupabaseOrigin();
    const required: boolean[] = [];
    runtime.state.index = 0;
    runtime.state.effectIndex = 0;
    const tree = LegalAcceptanceCard({ onRequiredChange: (value) => { required.push(value); } });
    await Promise.resolve();
    expect(tree).toBeNull();
    expect(service.load).not.toHaveBeenCalled();
    expect(service.record).not.toHaveBeenCalled();
    expect(required).toEqual([false]);
  });

  it('still shows the card on a live build', () => {
    const tree = render();
    expect(tree).not.toBeNull();
    expect(service.load).toHaveBeenCalled();
  });
});
