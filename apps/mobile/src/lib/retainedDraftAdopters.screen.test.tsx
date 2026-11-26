// @vitest-environment jsdom
import { act, createElement as h, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackHandler, exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import {
  boot, harnessApp, leaveChapter, leaveOrganization, mfa, otherAccount, refuseRead, restore, signIn, signOut, unconfirmReads, type StaffKind,
} from '../testing/retainedDraftHarness';
import { quickCaptureScope } from './quickActions';
import { noteResumeDraftReadFailure, retireRefusedResumeDraftScope } from './resumeDraftHolder';

// #9240 PR A (design R-9240D, section 2): every useRetainedDraft adopter runs
// the same twelve cases on iPhone and Android, for a chapter officer and a
// chapterless (organization) officer, through the provider's real session
// check transition. Each adopter brings its own read and write ports.

// A named alias: the security scanner cannot parse `typeof import()` inside a call's type arguments.
type QuickCaptureModule = typeof import('../services/quickCapture');
type ReadDeadlineModule = typeof import('./readDeadline');
type Gate = { promise: Promise<void>; open: () => void };
const held: Gate[] = [];
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((done) => { open = done; });
  const made = { promise, open };
  held.push(made);
  return made;
};

const ports = vi.hoisted(() => ({
  store: new Map<string, string>(),
  readGate: null as Promise<void> | null,
  writeGate: null as Promise<void> | null,
  failWrites: 0,
  // Invitations: the desk read, the create route and the client's session.
  rows: [] as { id: string; normalizedEmail: string; fullName: string; status: string }[],
  creates: 0,
  routeError: null as null | { status: number; error: string },
  loseNextReply: false,
  deskRefused: false,
  chapters: [] as { id: string; name: string }[],
  // The server's selected chapter, the desk's own default.
  deskChapter: { id: 'chapter-a', name: 'Tamarack Valley Campaign' },
  lastCreate: null as Record<string, unknown> | null,
  clientUser: () => null as string | null,
  // Quick capture's voice recorder and file store, and the keyboard reveal.
  audio: null as unknown,
  stops: 0,
  deleted: [] as string[],
  reveal: vi.fn<(target: unknown) => void>(),
  // A shorter write deadline for the hung-connection rows only.
  deadlineMs: null as number | null,
  release: vi.fn<(target: unknown) => void>(),
}));

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('./readDeadline', async (original) => {
  const actual = await original<ReadDeadlineModule>();
  return { ...actual, withReadDeadline: <T,>(request: Promise<T>, ms?: number) => actual.withReadDeadline(request, ports.deadlineMs ?? ms) };
});
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../state/AppProvider', async () => (await import('../testing/retainedDraftHarness')).appProviderStandIn);
vi.mock('expo-router', () => ({ useIsFocused: () => true, useRouter: () => ({ push: vi.fn() }), useLocalSearchParams: () => ({}) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `attempt-${Math.random().toString(36).slice(2)}` }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn(), warning: vi.fn(), impact: vi.fn() } }));
vi.mock('../components/ScreenKeyboardReveal', () => ({ useRevealAboveKeyboard: () => ({ reveal: ports.reveal, release: ports.release }) }));
vi.mock('../services/optionalAudio', () => ({ loadAudioModule: () => ports.audio }));
vi.mock('../services/optionalFileSystem', () => ({ loadFileSystem: () => ({ deleteAsync: async (uri: string) => { ports.deleted.push(uri); } }) }));
// Quick capture's device store: reads and writes can be held or fail.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => { if (ports.readGate) await ports.readGate; return ports.store.get(key) ?? null; }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (ports.writeGate) await ports.writeGate;
    if (ports.failWrites > 0) { ports.failWrites -= 1; throw new Error('Keychain unavailable'); }
    ports.store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => { ports.store.delete(key); }),
}));
vi.mock('../services/quickCapture', async (original) => {
  const actual = await original<QuickCaptureModule>();
  return { ...actual, addQuickNote: vi.fn(actual.addQuickNote), saveQuickTasks: vi.fn(actual.saveQuickTasks), createQuickTask: vi.fn(actual.createQuickTask), removeQuickNote: vi.fn(actual.removeQuickNote) };
});
// The invitation desk read and the website's create route, as the server
// answers them (see chapterInvitations.screen.test.tsx).
vi.mock('../services/supabase', () => ({
  getSupabaseClient: () => ({
    rpc: async () => {
      if (ports.readGate) await ports.readGate;
      if (ports.deskRefused) return { data: null, error: { code: '42501', message: 'admin role required' } };
      return { data: { chapter: ports.deskChapter, chapters: ports.chapters, items: ports.rows.map((row) => ({ ...row, chapterName: 'Tamarack Valley Campaign', expiresAt: '2026-11-26T19:00:00Z', acceptedAt: null, revokedAt: null })) }, error: null };
    },
    auth: { getSession: async () => { const id = ports.clientUser(); return { data: { session: id ? { access_token: `token-${id}`, user: { id } } : null }, error: null }; } },
  }),
}));
vi.mock('../services/privateFileAccess', () => ({ privateFileApiOrigin: () => 'https://sample.unionground.example' }));

const { StaffQuickCapture } = await import('../components/StaffQuickCapture');
const { ChapterInvitationsScreen } = await import('../features/ChapterInvitationsScreen');
const quickCapture = await import('../services/quickCapture');
const { useApp } = await import('../state/AppProvider');

async function route(_url: string, init: { body: string }) {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  if (body.action === 'create') {
    ports.creates += 1;
    ports.lastCreate = body;
    if (ports.writeGate) await ports.writeGate;
    if (ports.routeError) return { ok: false, status: ports.routeError.status, json: async () => ({ error: ports.routeError?.error }) };
    const email = String(body.email).toLowerCase();
    if (!ports.rows.some((row) => row.normalizedEmail === email)) ports.rows.unshift({ id: `inv-${ports.rows.length + 1}`, normalizedEmail: email, fullName: String(body.fullName), status: 'pending' });
    if (ports.loseNextReply) { ports.loseNextReply = false; throw new TypeError('Network request failed'); }
  }
  return { ok: true, status: 202, json: async () => ({ accepted: true }) };
}

// The root shows its own screen for any mode but signed in, and FeatureScreen's
// gate (`if (!dashboard) return <loading>`) unmounts the invitation desk
// through the session check, as on the phone.
function InvitationsHost() {
  const { mode, dashboard } = useApp();
  return mode === 'authenticated' && dashboard ? h(ChapterInvitationsScreen, { title: 'Invitations' }) : null;
}

type Adopter = {
  name: string;
  writeKind: 'local' | 'unkeyed';
  element: () => ReactElement;
  field: string;
  // Every field the composer holds.
  fields: string[];
  send: string;
  // The screen's own rows (saved by an earlier session), which never wait on the holder.
  seed: (staff: StaffKind) => Promise<void>;
  saved: string[];
  typed: string;
  fill: (view: Rendered) => Promise<void>;
  writes: () => number;
  failNextWrite: () => void;
  failureCopy: string;
  loseNextWrite?: () => void;
  // The authoritative refusal that governs this editor's read.
  refuse: () => void;
  allow: () => void;
};

const ADOPTERS: Adopter[] = [
  {
    name: 'StaffQuickCapture',
    writeKind: 'local',
    element: () => h(StaffQuickCapture),
    field: 'Quick note',
    fields: ['Quick note'],
    send: 'Save note',
    seed: async (staff) => {
      const scope = quickCaptureScope('authenticated', null, 'officer-a', staff === 'chapter' ? 'chapter-a' : null);
      await quickCapture.bindQuickCaptureOrganization(scope, 'org-a');
      await quickCapture.addQuickNote(scope, { body: 'Saved capture note', voiceUri: null, voiceDurationMs: null });
      await quickCapture.saveQuickTasks(scope, [quickCapture.createQuickTask('Saved capture task')]);
    },
    saved: ['Saved capture note', 'Saved capture task'],
    typed: '  Unfinished capture / borrador ñ\n  ',
    fill: async (view) => { await type(getExposed(view.container, 'Quick note'), '  Unfinished capture / borrador ñ\n  '); },
    writes: () => vi.mocked(quickCapture.addQuickNote).mock.calls.length,
    failNextWrite: () => { ports.failWrites = 1; },
    failureCopy: 'Your note could not be saved securely. It stays in the composer so you can try again.',
    // A device read is never refused; the provider's refusal of the officer's
    // own access reads is what retires this editor's work.
    refuse: () => refuseRead(),
    allow: () => undefined,
  },
  {
    name: 'ChapterInvitationsScreen',
    writeKind: 'unkeyed',
    element: () => h(InvitationsHost),
    field: 'Full name',
    fields: ['Full name', 'Email'],
    send: 'Send invitation',
    seed: async () => { ports.rows = [{ id: 'inv-saved', normalizedEmail: 'sam.saved@example.org', fullName: 'Sam Saved', status: 'pending' }]; },
    saved: ['Sam Saved', 'Revoke'],
    typed: '  Robin Fixture ñ  ',
    fill: async (view) => {
      await type(getExposed(view.container, 'Full name'), '  Robin Fixture ñ  ');
      await type(getExposed(view.container, 'Email'), 'robin.fixture@example.org');
    },
    writes: () => ports.creates,
    failNextWrite: () => { ports.routeError = { status: 429, error: 'rate-limited' }; },
    failureCopy: 'You have sent as many invitations as you can for now. Try again later.',
    loseNextWrite: () => { ports.loseNextReply = true; },
    refuse: () => { ports.deskRefused = true; },
    allow: () => { ports.deskRefused = false; },
  },
];

let view: Rendered | null = null;
async function settle() {
  for (let round = 0; round < 12; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function show(adopter: Adopter) { await view!.rerender(adopter.element()); await settle(); }
const field = (adopter: Adopter) => view!.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${adopter.field}"]`);
const control = (label: string) => view!.container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const text = () => view!.container.textContent ?? '';

beforeEach(() => {
  ports.store.clear(); ports.readGate = null; ports.writeGate = null; ports.failWrites = 0;
  ports.audio = null; ports.stops = 0; ports.deleted = []; ports.deadlineMs = null;
  ports.rows = []; ports.chapters = []; ports.deskChapter = { id: 'chapter-a', name: 'Tamarack Valley Campaign' }; ports.lastCreate = null; ports.creates = 0; ports.routeError = null; ports.loseNextReply = false; ports.deskRefused = false;
  ports.clientUser = () => harnessApp().session?.user.id ?? null;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn((url: string, init: { body: string }) => route(url, init)));
});
afterEach(async () => {
  // A failed case must not leave a held read or write for the next one.
  for (const left of held.splice(0)) left.open();
  await view?.unmount();
  view = null;
  vi.unstubAllGlobals();
  setPlatform('ios');
});

describe.each(ADOPTERS)('$name keeps unsent work through a session check', (adopter) => {
  describe.each<['ios' | 'android', StaffKind]>([['ios', 'chapter'], ['ios', 'chapterless'], ['android', 'chapter'], ['android', 'chapterless']])('on %s for a %s officer', (platform, staff) => {
    beforeEach(async () => {
      setPlatform(platform);
      signIn(staff);
      await adopter.seed(staff);
      vi.clearAllMocks();
      view = await render(adopter.element());
      await settle();
      await adopter.fill(view);
      expect(field(adopter)?.value).toBe(adopter.typed);
    });

    it('1. shows the same person the exact value after the check', async () => {
      boot(); await show(adopter);
      expect(field(adopter)).toBeNull();
      restore(); await show(adopter);
      expect(field(adopter)?.value).toBe(adopter.typed);
      expect(field(adopter)?.disabled).toBe(false);
      expect(adopter.writes()).toBe(0);
    });

    it('2. renders nothing held while the fresh read is pending', async () => {
      boot(); await show(adopter);
      const read = gate(); ports.readGate = read.promise;
      restore(); await show(adopter);
      expect(field(adopter)).toBeNull();
      expect(text()).not.toContain(adopter.typed.trim());
      ports.readGate = null; read.open(); await settle();
      expect(field(adopter)?.value).toBe(adopter.typed);
    });

    it('3. starts another account blank, and the first person blank after it', async () => {
      boot(); await show(adopter);
      otherAccount(); await show(adopter);
      expect(field(adopter)?.value).toBe('');
      boot(); await show(adopter);
      signIn(staff); await show(adopter);
      expect(field(adopter)?.value).toBe('');
    });

    it.each(['chapter', 'organization'])('4. starts blank after the officer leaves the %s', async (left) => {
      boot(); await show(adopter);
      if (left === 'chapter') leaveChapter(); else leaveOrganization();
      await show(adopter);
      restore(); await show(adopter);
      expect(field(adopter)).not.toBeNull();
      expect(field(adopter)?.value).toBe('');
    });

    it('5. retires the work after an authoritative refusal of the read', async () => {
      boot(); await show(adopter);
      adopter.refuse();
      restore(); await show(adopter);
      expect(text()).not.toContain(adopter.typed.trim());
      adopter.allow();
      await view!.unmount(); view = await render(adopter.element()); await settle();
      expect(field(adopter)?.value).toBe('');
    });

    it.each(['sign-out', 'MFA challenge'])('6. retires the work on a %s', async (change) => {
      if (change === 'sign-out') signOut(); else mfa();
      await show(adopter);
      restore(); await show(adopter);
      expect(field(adopter)?.value).toBe('');
    });

    it('7. keeps a write in flight locked through the check and leaves the editor blank once confirmed, written once', async () => {
      const write = gate(); ports.writeGate = write.promise;
      await press(getExposed(view!.container, adopter.send));
      expect(adopter.writes()).toBe(1);
      boot(); await show(adopter);
      restore(); await show(adopter);
      // The device store answers reads after the write it is finishing, so a
      // local editor stays concealed; a remote one shows the value locked.
      if (adopter.writeKind === 'local' && !field(adopter)) {
        expect(text()).not.toContain(adopter.typed.trim());
      } else {
        expect(field(adopter)?.value).toBe(adopter.typed);
        expect(field(adopter)?.disabled).toBe(true);
        await press(getExposed(view!.container, adopter.writeKind === 'local' ? 'Saving…' : adopter.send));
      }
      expect(adopter.writes()).toBe(1);
      ports.writeGate = null; write.open(); await settle();
      expect(field(adopter)?.value).toBe('');
      boot(); await show(adopter); restore(); await show(adopter);
      expect(field(adopter)?.value).toBe('');
      expect(adopter.writes()).toBe(1);
    });

    it('8. returns a definite failure as editable, with its message, through the check', async () => {
      adopter.failNextWrite();
      await press(getExposed(view!.container, adopter.send)); await settle();
      expect(field(adopter)?.disabled).toBe(false);
      boot(); await show(adopter);
      ports.routeError = null;
      restore(); await show(adopter);
      expect(field(adopter)?.value).toBe(adopter.typed);
      expect(field(adopter)?.disabled).toBe(false);
      expect(text()).toContain(adopter.failureCopy);
      expect(adopter.writes()).toBe(1);
    });

    it('9. never sends again on its own; an unknown outcome stays locked with Discard until a deliberate retry', async () => {
      if (adopter.loseNextWrite) adopter.loseNextWrite(); else adopter.failNextWrite();
      await press(getExposed(view!.container, adopter.send)); await settle();
      boot(); await show(adopter); restore(); await show(adopter);
      expect(field(adopter)?.value).toBe(adopter.typed);
      expect(adopter.writes()).toBe(1);
      if (adopter.writeKind === 'local') {
        // A device write either lands or throws: there is no unknown outcome.
        expect(field(adopter)?.disabled).toBe(false);
        return;
      }
      expect(field(adopter)?.disabled).toBe(true);
      expect(control('Cancel')).not.toBeNull();
      expect(text()).toContain('We could not confirm this invitation was sent.');
      await press(getExposed(view!.container, 'Send again')); await settle();
      expect(adopter.writes()).toBe(2);
      expect(field(adopter)?.value).toBe('');
    });

    it.each(['editing', 'failed', 'unknown'])('10. discards the work in the %s state', async (state) => {
      if (state === 'unknown' && !adopter.loseNextWrite) return;
      if (state === 'failed') adopter.failNextWrite();
      if (state === 'unknown') adopter.loseNextWrite!();
      if (state !== 'editing') { await press(getExposed(view!.container, adopter.send)); await settle(); }
      ports.routeError = null;
      // The adopter's own discard: Cancel where Main offers it, else clearing.
      if (control('Cancel')) await press(getExposed(view!.container, 'Cancel'));
      else for (const name of adopter.fields) await type(getExposed(view!.container, name), '');
      const values = () => adopter.fields.map((name) => view!.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${name}"]`)?.value);
      expect(values()).toEqual(adopter.fields.map(() => ''));
      expect(field(adopter)?.disabled).toBe(false);
      boot(); await show(adopter); restore(); await show(adopter);
      expect(values()).toEqual(adopter.fields.map(() => ''));
    });

    it('12. keeps the screen\'s own rows while the provider\'s read facts are unconfirmed, concealing only the composer', async () => {
      unconfirmReads(); await show(adopter);
      for (const saved of adopter.saved) expect(text()).toContain(saved);
      for (const name of adopter.fields) expect(view!.container.querySelector(`[aria-label="${name}"]`)).toBeNull();
      if (adopter.writeKind === 'local') expect(control('New task title')).toBeNull();
      expect(text()).not.toContain(adopter.typed.trim());
      restore(); await show(adopter);
      expect(field(adopter)?.value).toBe(adopter.typed);
    });

    it('11. adds no back or edge guard (neither editor had one on Main)', async () => {
      const listen = vi.spyOn(BackHandler, 'addEventListener');
      boot(); await show(adopter); restore(); await show(adopter);
      await type(getExposed(view!.container, adopter.field), 'Edited again');
      await view!.unmount(); view = await render(adopter.element()); await settle();
      expect(listen).not.toHaveBeenCalled();
    });
  });
});

// An unhandled rejection is the outcome on Main too; the test keeps it from
// failing the run and counts it.
async function withRejections(run: () => Promise<void>): Promise<unknown[]> {
  const saved = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const seen: unknown[] = [];
  const record = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', record);
  try {
    await run();
    await new Promise((done) => { setTimeout(done, 0); });
  } finally {
    process.off('unhandledRejection', record);
    for (const listener of saved) process.on('unhandledRejection', listener);
  }
  return seen;
}

describe.each<'ios' | 'android'>(['ios', 'android'])('adopter specifics on %s', (platform) => {
  beforeEach(() => { setPlatform(platform); signIn('chapter'); });

  it('StaffQuickCapture leaves a task editable when its new task cannot be built', async () => {
    view = await render(h(StaffQuickCapture)); await settle();
    await type(getExposed(view.container, 'New task title'), 'Unfiled task');
    vi.mocked(quickCapture.createQuickTask).mockImplementationOnce(() => { throw new Error('No random source'); });
    const seen = await withRejections(async () => { await press(getExposed(view!.container, 'Create task')); await settle(); });
    expect(seen).toHaveLength(1);
    const task = () => view!.container.querySelector<HTMLInputElement>('[aria-label="New task title"]');
    expect(task()?.value).toBe('Unfiled task');
    expect(task()?.disabled).toBe(false);
    await press(getExposed(view.container, 'Create task')); await settle();
    expect(task()?.value).toBe('');
    expect(text()).toContain('Unfiled task');
  });

  it.each(['note', 'task'])('StaffQuickCapture shows a failed change to a saved %s while its composer waits', async (row) => {
    await ADOPTERS[0]!.seed('chapter');
    view = await render(h(StaffQuickCapture)); await settle();
    unconfirmReads(); await view.rerender(h(StaffQuickCapture)); await settle();
    expect(control(row === 'note' ? 'Quick note' : 'New task title')).toBeNull();
    if (row === 'note') {
      vi.mocked(quickCapture.removeQuickNote).mockRejectedValueOnce(new Error('Keychain unavailable'));
      await press(getExposed(view.container, 'Delete note')); await settle();
      expect(text()).toContain('The note could not be deleted. Try again.');
    } else {
      vi.mocked(quickCapture.saveQuickTasks).mockRejectedValueOnce(new Error('Keychain unavailable'));
      await press(getExposed(view.container, 'Saved capture task')); await settle();
      expect(text()).toContain('The change could not be saved securely. Try again.');
    }
  });

  it('ChapterInvitationsScreen keeps the picked campaign after Cancel, as Main did', async () => {
    ports.chapters = [{ id: 'chapter-a', name: 'Tamarack Valley Campaign' }, { id: 'chapter-b', name: 'Cedar Ridge Campaign' }];
    view = await render(h(InvitationsHost)); await settle();
    await press(getExposed(view.container, 'Cedar Ridge Campaign'));
    await type(getExposed(view.container, 'Full name'), 'Robin Fixture');
    await type(getExposed(view.container, 'Email'), 'robin.fixture@example.org');
    ports.loseNextReply = true;
    await press(getExposed(view.container, 'Send invitation')); await settle();
    expect(ports.lastCreate?.chapterId).toBe('chapter-b');
    await press(getExposed(view.container, 'Cancel'));
    await type(getExposed(view.container, 'Full name'), 'Sam Second');
    await type(getExposed(view.container, 'Email'), 'sam.second@example.org');
    await press(getExposed(view.container, 'Send invitation')); await settle();
    expect(ports.lastCreate?.email).toBe('sam.second@example.org');
    expect(ports.lastCreate?.chapterId).toBe('chapter-b');
  });
});

// #9375 round 1 (r1s1, r2s1, r1s2, r2s2): an unresolved invitation stays
// unresolved, and a held invitation keeps the chapter it was written for.
describe.each<'ios' | 'android'>(['ios', 'android'])('an unresolved or held invitation on %s', (platform) => {
  const two = [{ id: 'chapter-a', name: 'Tamarack Valley Campaign' }, { id: 'chapter-b', name: 'Cedar Ridge Campaign' }];
  const nameField = () => view!.container.querySelector<HTMLInputElement>('[aria-label="Full name"]');
  const again = async () => { await view!.rerender(h(InvitationsHost)); await settle(); };
  async function unconfirmed(chapter?: string) {
    view = await render(h(InvitationsHost)); await settle();
    if (chapter) await press(getExposed(view.container, chapter));
    await type(getExposed(view.container, 'Full name'), 'Robin Fixture');
    await type(getExposed(view.container, 'Email'), 'robin.fixture@example.org');
    ports.loseNextReply = true;
    await press(getExposed(view.container, 'Send invitation')); await settle();
    expect(text()).toContain('We could not confirm this invitation was sent.');
  }
  beforeEach(() => { setPlatform(platform); signIn('chapter'); });

  it('stays unconfirmed, locked and keyed through a refused retry, a server error and the session check', async () => {
    await unconfirmed();
    for (const refusal of [{ status: 429, error: 'rate-limited' }, { status: 503, error: 'service-unavailable' }]) {
      ports.routeError = refusal;
      await press(getExposed(view!.container, 'Send again')); await settle();
      expect(text()).toContain('We could not confirm this invitation was sent.');
      expect(nameField()?.disabled).toBe(true);
      expect(control('Cancel')).not.toBeNull();
    }
    expect(text()).toContain('The invitation could not be sent. Try again.');
    boot(); await again(); restore(); await again();
    expect(nameField()?.value).toBe('Robin Fixture');
    expect(nameField()?.disabled).toBe(true);
    expect(text()).toContain('We could not confirm this invitation was sent.');
    ports.routeError = null;
    await press(getExposed(view!.container, 'Send again')); await settle();
    expect(ports.creates).toBe(4);
    expect(nameField()?.value).toBe('');
    expect(nameField()?.disabled).toBe(false);
  });

  it.each(['after the session check', 'after Check the invitations'])('never sends a held invitation into another campaign %s', async (how) => {
    ports.chapters = two;
    await unconfirmed('Cedar Ridge Campaign');
    expect(ports.lastCreate?.chapterId).toBe('chapter-b');
    ports.chapters = [two[0]!];
    if (how === 'after the session check') { boot(); await again(); restore(); await again(); }
    else { await press(getExposed(view!.container, 'Check the invitations')); await settle(); }
    expect(text()).toContain('This account cannot invite workers to that campaign.');
    expect(control('Send again')?.getAttribute('aria-disabled')).toBe('true');
    await press(getExposed(view!.container, 'Send again')); await settle();
    expect(ports.creates).toBe(1);
    await press(getExposed(view!.container, 'Cancel'));
    expect(nameField()?.value).toBe('');
    expect(nameField()?.disabled).toBe(false);
  });

  it('waits for a new campaign choice when an unsent draft\'s campaign is gone', async () => {
    ports.chapters = two;
    view = await render(h(InvitationsHost)); await settle();
    await press(getExposed(view.container, 'Cedar Ridge Campaign'));
    await type(getExposed(view.container, 'Full name'), 'Robin Fixture');
    await type(getExposed(view.container, 'Email'), 'robin.fixture@example.org');
    boot(); await again();
    ports.chapters = [two[0]!];
    restore(); await again();
    expect(nameField()?.value).toBe('Robin Fixture');
    expect(text()).toContain('This account cannot invite workers to that campaign.');
    await press(getExposed(view!.container, 'Send invitation')); await settle();
    expect(ports.creates).toBe(0);
    await press(getExposed(view!.container, 'Tamarack Valley Campaign'));
    await press(getExposed(view!.container, 'Send invitation')); await settle();
    expect(ports.creates).toBe(1);
    expect(ports.lastCreate?.chapterId).toBe('chapter-a');
  });
});

// #9375 final (r3s1, r4s1): a draft typed beside the desk's default chapter is
// written for that chapter; a later desk reload with another default (another
// device switched chapters; Resend reloads the list) never moves it.
describe.each<'ios' | 'android'>(['ios', 'android'])('a draft typed beside the default campaign on %s', (platform) => {
  const two = [{ id: 'chapter-a', name: 'Tamarack Valley Campaign' }, { id: 'chapter-b', name: 'Cedar Ridge Campaign' }];
  beforeEach(() => { setPlatform(platform); signIn('chapter'); });

  it.each(['still listed', 'no longer listed'])('keeps its campaign through a list reload when that campaign is %s', async (listing) => {
    ports.chapters = two;
    ports.rows = [{ id: 'inv-saved', normalizedEmail: 'sam.saved@example.org', fullName: 'Sam Saved', status: 'pending' }];
    view = await render(h(InvitationsHost)); await settle();
    await type(getExposed(view.container, 'Full name'), 'Robin Fixture');
    await type(getExposed(view.container, 'Email'), 'robin.fixture@example.org');
    ports.deskChapter = two[1]!;
    if (listing === 'no longer listed') ports.chapters = [two[1]!];
    await press(getExposed(view.container, 'Resend the invitation to Sam Saved')); await settle();
    await press(getExposed(view.container, 'Send invitation')); await settle();
    if (listing === 'still listed') {
      expect(ports.creates).toBe(1);
      expect(ports.lastCreate?.chapterId).toBe('chapter-a');
    } else {
      expect(ports.creates).toBe(0);
      expect(text()).toContain('This account cannot invite workers to that campaign.');
    }
  });
});

// #9399 final (r4s1): while the reads are unconfirmed only the held TEXT
// waits. Live state a composer holds besides its text stays operable: a running
// recorder keeps its status and Stop, a finished take survives and saves when
// the reads are back, and a focused field releases its keyboard lift.
function fakeAudio() {
  return {
    requestRecordingPermissionsAsync: async () => ({ granted: true }),
    setAudioModeAsync: async () => undefined,
    RecordingPresets: { HIGH_QUALITY: {} },
    AudioModule: { AudioRecorder: class {
      uri = 'file:///take.m4a';
      prepareToRecordAsync = async () => undefined;
      record = () => undefined;
      getStatus = () => ({ durationMillis: 5000 });
      stop = async () => { ports.stops += 1; };
      release = () => undefined;
    } },
    createAudioPlayer: () => ({ play: () => undefined, remove: () => undefined }),
  };
}
describe.each<'ios' | 'android'>(['ios', 'android'])('live composer state while the reads are unconfirmed on %s', (platform) => {
  const capture = async () => { await view!.rerender(h(StaffQuickCapture)); await settle(); };
  beforeEach(async () => {
    setPlatform(platform); signIn('chapter');
    ports.audio = fakeAudio();
    view = await render(h(StaffQuickCapture)); await settle();
  });

  it('keeps a running recording stoppable, and its take saveable once the reads are back', async () => {
    await press(getExposed(view!.container, 'Record a voice note')); await settle();
    expect(text()).toContain('Recording… tap stop to attach.');
    unconfirmReads(); await capture();
    expect(control('Quick note')).toBeNull();
    expect(text()).toContain('Recording… tap stop to attach.');
    await press(getExposed(view!.container, 'Stop recording')); await settle();
    expect(ports.stops).toBe(1);
    expect(text()).toContain('Voice memo · 0:05');
    expect(ports.deleted).toEqual([]);
    restore(); await capture();
    await press(getExposed(view!.container, 'Save note')); await settle();
    expect(vi.mocked(quickCapture.addQuickNote)).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ voiceUri: 'file:///take.m4a' }));
  });

  it('keeps a finished take through the hide, playable and saveable', async () => {
    await press(getExposed(view!.container, 'Record a voice note')); await settle();
    await press(getExposed(view!.container, 'Stop recording')); await settle();
    unconfirmReads(); await capture();
    expect(text()).toContain('Voice memo · 0:05');
    expect(control('Discard voice memo')).not.toBeNull();
    expect(ports.deleted).toEqual([]);
    restore(); await capture();
    await press(getExposed(view!.container, 'Save note')); await settle();
    expect(vi.mocked(quickCapture.addQuickNote)).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ voiceUri: 'file:///take.m4a' }));
  });

  it.each(['Quick note', 'New task title'])('releases the keyboard lift of a focused %s field when it is hidden', async (name) => {
    act(() => { view!.container.querySelector<HTMLElement>(`[aria-label="${name}"]`)!.focus(); });
    expect(ports.reveal).toHaveBeenCalled();
    ports.release.mockClear();
    unconfirmReads(); await capture();
    expect(control(name)).toBeNull();
    expect(ports.release).toHaveBeenCalled();
  });
});

// a review note (already met on Main: services/chapterInvitations.ts runs
// the send under the deadline with an abort; this row guards it): an invitation
// sent on a hung connection ends at the write
// deadline as unconfirmed (the email may still go out): locked, with Send
// again and Cancel, never a second automatic send, through the session check.
describe.each<'ios' | 'android'>(['ios', 'android'])('an invitation sent on a hung connection on %s', (platform) => {
  const nameField = () => view!.container.querySelector<HTMLInputElement>('[aria-label="Full name"]');
  beforeEach(() => { setPlatform(platform); signIn('chapter'); ports.deadlineMs = 25; });

  it('becomes unconfirmed at the deadline, sent once, and sends again only on Send again', async () => {
    view = await render(h(InvitationsHost)); await settle();
    await type(getExposed(view.container, 'Full name'), 'Robin Fixture');
    await type(getExposed(view.container, 'Email'), 'robin.fixture@example.org');
    const write = gate(); ports.writeGate = write.promise;
    await press(getExposed(view.container, 'Send invitation'));
    await act(async () => { await new Promise((done) => { setTimeout(done, 60); }); }); await settle();
    expect(text()).toContain('We could not confirm this invitation was sent.');
    expect(nameField()?.disabled).toBe(true);
    expect(control('Cancel')).not.toBeNull();
    expect(ports.creates).toBe(1);
    // The hung request lands later: nothing is sent again on its own.
    ports.writeGate = null; write.open(); await settle();
    boot(); await view!.rerender(h(InvitationsHost)); await settle();
    restore(); await view!.rerender(h(InvitationsHost)); await settle();
    expect(text()).toContain('We could not confirm this invitation was sent.');
    expect(ports.creates).toBe(1);
    await press(getExposed(view!.container, 'Send again')); await settle();
    expect(ports.creates).toBe(2);
    expect(nameField()?.value).toBe('');
  });
});

// #9459 M1-21: a session read that failed used to leave these editors on
// their loading line until some later refresh happened to succeed. Now the
// editor says its saved work could not be checked and offers Try again, which
// re-reads through the provider; a read still out keeps the loading line.
describe.each(ADOPTERS)('$name after a failed session read', (adopter) => {
  const FAILED = 'Your saved work could not be checked. Check your connection and try again.';
  const loading = adopter.name === 'StaffQuickCapture' ? 'Loading quick capture…' : 'Loading your work';
  const tryAgain = () => exposedNames(view!.container).includes('Try again');
  beforeEach(async () => { signIn('chapter'); await adopter.seed('chapter'); view = await render(adopter.element()); await settle(); });

  it('says the check failed, retries from Try again, and shows the form once the reads are confirmed', async () => {
    unconfirmReads(); await show(adopter);
    expect(field(adopter)).toBeNull();
    expect(text()).toContain(loading); expect(text()).not.toContain(FAILED); expect(tryAgain()).toBe(false);
    noteResumeDraftReadFailure({ status: 0 }); unconfirmReads();
    const refresh = vi.fn(async (_reason?: string) => undefined);
    Object.assign(harnessApp(), { refresh });
    await show(adopter);
    expect(field(adopter)).toBeNull();
    expect(text()).toContain(FAILED); expect(text()).not.toContain(loading);
    await press(getExposed(view!.container, 'Try again'));
    expect(refresh).toHaveBeenCalledWith('user-refresh');
    restore(); await show(adopter);
    expect(text()).not.toContain(FAILED); expect(tryAgain()).toBe(false);
    expect(field(adopter)).not.toBeNull();
  });

  // #9482 round 1: a second press before the busy state draws starts no second refresh.
  it('starts one refresh for two quick presses of Try again, and another once it ends', async () => {
    noteResumeDraftReadFailure({ status: 0 }); unconfirmReads();
    const running = gate();
    const refresh = vi.fn(async (_reason?: string) => { await running.promise; });
    Object.assign(harnessApp(), { refresh });
    await show(adopter);
    const retry = getExposed(view!.container, 'Try again');
    await press(retry); await press(retry);
    expect(refresh).toHaveBeenCalledTimes(1);
    running.open(); await settle();
    await press(getExposed(view!.container, 'Try again'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  // #9482 pre-final: a read that got a reply the app could not use
  // (an availability-false answer, a 500) does not blame the connection, and
  // the typed work is still there once the reads are confirmed.
  it.each<[string, unknown]>([['an availability-false answer', undefined], ['a 500', { status: 500, message: 'server error' }]])('after %s says the check failed without naming the connection and keeps the typed work', async (_case, error) => {
    await adopter.fill(view!);
    noteResumeDraftReadFailure(error); unconfirmReads();
    Object.assign(harnessApp(), { refresh: vi.fn(async (_reason?: string) => undefined) });
    await show(adopter);
    expect(text()).toContain('Your saved work could not be checked. Try again.');
    expect(text()).not.toContain(FAILED); expect(field(adopter)).toBeNull();
    restore(); await show(adopter);
    expect(field(adopter)?.value).toBe(adopter.typed);
  });

  // #9482 pre-final: a refusal retires the unsent work, so the line
  // never says it is only unchecked.
  it('after a refusal says nothing about unchecked work, and the retired text does not come back', async () => {
    await adopter.fill(view!);
    const refusal = { status: 403, code: '42501', message: 'permission denied' };
    noteResumeDraftReadFailure(refusal); unconfirmReads(); refuseRead();
    Object.assign(harnessApp(), { refresh: vi.fn(async (_reason?: string) => undefined) });
    await show(adopter);
    expect(text()).not.toContain('Your saved work could not be checked'); expect(tryAgain()).toBe(false);
    expect(text()).toContain(loading);
    restore(); await show(adopter);
    expect(field(adopter)?.value).toBe('');
  });

  // A later failure (the deadline after a 403) must not bring the line back.
  it('keeps a refusal through a later failure until the reads are confirmed', async () => {
    await adopter.fill(view!);
    noteResumeDraftReadFailure({ status: 403, code: '42501', message: 'permission denied' }); unconfirmReads(); refuseRead();
    noteResumeDraftReadFailure({ status: 0 }); noteResumeDraftReadFailure({ status: 500 });
    Object.assign(harnessApp(), { refresh: vi.fn(async (_reason?: string) => undefined) });
    await show(adopter);
    expect(text()).not.toContain('Your saved work could not be checked'); expect(tryAgain()).toBe(false);
    restore(); await show(adopter);
    // A confirmed context clears the refusal: the next failure is said again.
    noteResumeDraftReadFailure({ status: 0 }); unconfirmReads(); await show(adopter);
    expect(text()).toContain(FAILED);
  });

  // Slice 3 review: a refusal that retired nothing (an older
  // chapter's read, another person's) gives way to a later failure, so the line
  // and Try again come back and the typed work is still held.
  it.each<[string, () => void]>([['an older campaign', () => undefined], ['another person', () => retireRefusedResumeDraftScope('someone-else', { code: '42501' })]])('lets a later failure replace a refusal for %s that retired nothing', async (_case, retire) => {
    await adopter.fill(view!);
    noteResumeDraftReadFailure({ status: 403, code: '42501', message: 'permission denied' }); unconfirmReads(); retire();
    noteResumeDraftReadFailure({ status: 0 });
    Object.assign(harnessApp(), { refresh: vi.fn(async (_reason?: string) => undefined) });
    await show(adopter);
    expect(text()).toContain(FAILED); expect(text()).not.toContain(loading); expect(tryAgain()).toBe(true);
    restore(); await show(adopter);
    expect(field(adopter)?.value).toBe(adopter.typed);
  });
});
