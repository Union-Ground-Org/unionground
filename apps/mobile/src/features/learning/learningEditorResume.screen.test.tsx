// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert, getExposed, press, render, setPlatform, type, type Rendered } from '../../testing/reactNativeStandIn';
import {
  boot, harnessApp, leaveChapter, leaveOrganization, mfa, otherAccount, refuseRead, restore, signIn, signOut, unconfirmReads, type StaffKind,
} from '../../testing/retainedDraftHarness';

// #9240 pull request B (design R-9240D, row B): the phone's learning editor
// keeps unsent work through a session check on the shared draft hook
// (src/lib/retainedDraft.ts), as the quick capture and invitation adopters do
// (src/lib/retainedDraftAdopters.screen.test.tsx). The host unmounts the
// manager through the check, as both real hosts do (Account closes it while its
// administration read is pending; the Rights screen sits behind FeatureScreen's
// dashboard gate), so every return is a remount with fresh reads. Each case
// runs on iPhone and Android, for a chapter officer (chapter content) and a
// chapterless platform owner (platform content).

type Raw = Record<string, unknown>;
// A named alias: the security scanner cannot parse `typeof import()` inside a call's type arguments.
type LearningContentModule = typeof import('../../services/learningContent');
type ReadDeadlineModule = typeof import('../../lib/readDeadline');
type Gate = { promise: Promise<void>; open: () => void };
const held: Gate[] = [];
const gate = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((done) => { open = done; });
  const made = { promise, open };
  held.push(made);
  return made;
};

const server = vi.hoisted(() => ({
  staff: 'chapter' as 'chapter' | 'chapterless',
  items: [] as Raw[],
  policies: {} as Record<string, { quotesEnabled: boolean; lessonsEnabled: boolean; selectedIds: string[] | null; revision: number }>,
  readGate: null as Promise<void> | null,
  writeGate: null as Promise<void> | null,
  failNext: null as unknown,
  loseNext: false,
  contentWrites: [] as Raw[],
  policyWrites: [] as Raw[],
  transitions: 0,
  created: 0,
  attempts: 0,
  // A shorter write deadline for the hung-connection rows only.
  deadlineMs: null as number | null,
  setOptions: vi.fn<(options: { gestureEnabled: boolean }) => void>(),
}));

vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../lib/readDeadline', async (original) => {
  const actual = await original<ReadDeadlineModule>();
  return { ...actual, withReadDeadline: <T,>(request: Promise<T>, ms?: number) => actual.withReadDeadline(request, server.deadlineMs ?? ms) };
});
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
vi.mock('../../state/AppProvider', async () => (await import('../../testing/retainedDraftHarness')).appProviderStandIn);
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: server.setOptions }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// Attempt keys only need to differ from each other.
vi.mock('expo-crypto', () => ({ randomUUID: () => { server.attempts += 1; return `attempt-${server.attempts}`; } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined) }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn(), warning: vi.fn(), impact: vi.fn() } }));
vi.mock('../../services/supabase', () => ({ createCapturedSessionRpcClient: vi.fn(), getSupabaseClient: vi.fn() }));
// The governed learning RPCs, answered as the server answers them: content and
// policy saves are revision-guarded, a content create is not keyed.
vi.mock('../../services/learningContent', async (original) => {
  const actual = await original<LearningContentModule>();
  const { normalizeLearningItem } = await import('../../lib/learningContentModel');
  const read = async () => { if (server.readGate) await server.readGate; };
  const write = async () => {
    if (server.writeGate) await server.writeGate;
    if (server.failNext) { const error = server.failNext; server.failNext = null; throw error; }
  };
  const lost = () => { if (server.loseNext) { server.loseNext = false; throw new TypeError('Network request failed'); } };
  const api = {
    getPolicy: async () => { await read(); return { canManage: server.staff === 'chapter', isPlatformOwner: server.staff === 'chapterless' }; },
    getWorkspace: async ({ scope }: { scope: string }) => {
      await read();
      return { items: server.items.filter((item) => item.scope === scope).map((item) => normalizeLearningItem(item)!), hasMore: false, policy: server.policies[scope] };
    },
    listChoices: async () => ({ items: [], hasMore: false }),
    getHistory: async () => ({ items: [], hasMore: false }),
    saveContent: async ({ form }: { form: Raw }) => {
      server.contentWrites.push(form);
      await write();
      const current = form.id ? server.items.find((item) => item.id === form.id) : undefined;
      if (current && current.revision !== form.revision) throw new actual.LearningRequestError('conflict', 'save_learning_content_refused');
      server.created += current ? 0 : 1;
      const saved: Raw = {
        ...(current ?? { id: `a1b2c3d4-0000-4000-8000-0000000001${String(server.created).padStart(2, '0')}`, organization_id: form.scope === 'platform' ? null : 'org-a', chapter_id: form.scope === 'chapter' ? 'chapter-a' : null }),
        scope: form.scope, kind: form.kind, locale: form.locale, locale_state: form.locale_state, title: String(form.title).trim(), body: String(form.body).trim(),
        source: form.source, rights_note: form.rights_note, review_note: form.review_note, audience: form.audience, status: 'draft', priority: 0,
        revision: Number(current?.revision ?? 0) + 1,
      };
      server.items = [...server.items.filter((item) => item.id !== saved.id), saved];
      lost();
      return normalizeLearningItem(saved)!;
    },
    savePolicy: async (change: { scope: string; quotesEnabled: boolean; lessonsEnabled: boolean; selectedIds: string[] | null; expectedRevision: number }) => {
      server.policyWrites.push(change);
      await write();
      const current = server.policies[change.scope]!;
      if (current.revision !== change.expectedRevision) throw new actual.LearningRequestError('conflict', 'save_learning_policy_refused');
      server.policies[change.scope] = { quotesEnabled: change.quotesEnabled, lessonsEnabled: change.lessonsEnabled, selectedIds: change.selectedIds, revision: current.revision + 1 };
      lost();
      return server.policies[change.scope];
    },
    transition: async () => { server.transitions += 1; await write(); throw new actual.LearningRequestError('conflict', 'transition_learning_content_refused'); },
    setHomeHidden: async () => false,
  };
  return { ...actual, learningApiForSession: () => api };
});

const { LearningContentManager } = await import('./LearningContentManager');
const { LearningRequestError } = await import('../../services/learningContent');
const { learningCopy } = await import('../../lib/learningContentCopy');
const { useApp } = await import('../../state/AppProvider');
const copy = learningCopy('en');

const HELD_LOADING = 'Loading your work';
const UNCERTAIN = 'We could not confirm this draft was saved.';
const ITEM_STALE = 'This item changed while you were away.';
const POLICY_STALE = 'These settings changed while you were away.';

function itemRow(scope: string, overrides: Raw = {}): Raw {
  return {
    id: `a1b2c3d4-0000-4000-8000-00000000000${scope === 'chapter' ? 'a' : scope === 'organization' ? 'b' : 'c'}`,
    scope, organization_id: scope === 'platform' ? null : 'org-a', chapter_id: scope === 'chapter' ? 'chapter-a' : null,
    kind: 'quote', locale: 'en', locale_state: 'reviewed', title: 'Reviewed writing', body: 'Original writing.', source: 'Original authored writing',
    rights_note: 'Author permits reuse.', review_note: 'Reviewed.', audience: 'all', status: 'draft', priority: 0, revision: 3, ...overrides,
  };
}

// The host closes the manager for any mode but signed in, as both real hosts do.
const onClose = vi.fn();
function Host() {
  const { mode, dashboard } = useApp();
  return mode === 'authenticated' && dashboard ? h(LearningContentManager, { onClose, origin: 'account' }) : null;
}

let view: Rendered | null = null;
async function settle() {
  for (let round = 0; round < 16; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
async function show() { await view!.rerender(h(Host)); await settle(); }
async function check() { boot(); await show(); restore(); await show(); }
const control = (label: string) => view!.container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const input = (label: string) => view!.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
const text = () => view!.container.textContent ?? '';
const disabled = (label: string) => control(label)?.getAttribute('aria-disabled') === 'true';
const contentScope = (staff: StaffKind) => (staff === 'chapter' ? 'chapter' : 'platform');
type AlertButton = { text: string; onPress?: () => void };
const alertWith = (run: (buttons: AlertButton[]) => void) => vi.spyOn(Alert, 'alert')
  .mockImplementation(((...args: unknown[]) => { run((args[2] ?? []) as AlertButton[]); }) as typeof Alert.alert);
const alertDiscards = () => alertWith((buttons) => { buttons.find((button) => button.text === copy.discard)?.onPress?.(); });

beforeEach(() => {
  server.items = [itemRow('chapter'), itemRow('organization'), itemRow('platform')];
  server.policies = {
    chapter: { quotesEnabled: true, lessonsEnabled: true, selectedIds: null, revision: 1 },
    organization: { quotesEnabled: true, lessonsEnabled: true, selectedIds: null, revision: 1 },
    platform: { quotesEnabled: true, lessonsEnabled: true, selectedIds: null, revision: 1 },
  };
  server.readGate = null; server.writeGate = null; server.failNext = null; server.loseNext = false;
  server.contentWrites = []; server.policyWrites = []; server.transitions = 0; server.created = 0; server.deadlineMs = null;
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const left of held.splice(0)) left.open();
  await view?.unmount();
  view = null;
  vi.restoreAllMocks();
  setPlatform('ios');
});

type Editor = {
  name: string;
  open: () => Promise<void>;
  // The baseline the editor shows with nothing held.
  blank: string;
  // A content create is not keyed: its lost answer is an unknown outcome.
  create: boolean;
};
const EDITORS: Editor[] = [
  { name: 'a new quote', open: async () => { await press(getExposed(view!.container, copy.newQuote)); await settle(); }, blank: '', create: true },
  { name: 'a saved item', open: async () => { await press(getExposed(view!.container, copy.editLabel('Reviewed writing'))); await settle(); }, blank: 'Reviewed writing', create: false },
];
const TYPED = 'Unfinished quote / borrador ñ';
const TYPED_BODY = 'Every word typed by the editor.';

describe.each(EDITORS)('the learning editor keeps $name through a session check', (editor) => {
  describe.each<['ios' | 'android', StaffKind]>([['ios', 'chapter'], ['ios', 'chapterless'], ['android', 'chapter'], ['android', 'chapterless']])('on %s for a %s officer', (platform, staff) => {
    const title = () => input(copy.fields.title);
    beforeEach(async () => {
      setPlatform(platform);
      signIn(staff); server.staff = staff;
      view = await render(h(Host));
      await settle();
      await editor.open();
      await type(getExposed(view.container, copy.fields.title), TYPED);
      await type(getExposed(view.container, copy.quoteBodyLabel), TYPED_BODY);
      expect(title()?.value).toBe(TYPED);
    });

    it('1. reopens the same editor for the same person with the exact text, unsent', async () => {
      await check();
      expect(title()?.value).toBe(TYPED);
      expect(input(copy.quoteBodyLabel)?.value).toBe(TYPED_BODY);
      expect(title()?.disabled).toBe(false);
      expect(server.contentWrites).toHaveLength(0);
      expect(server.items.filter((item) => item.scope === contentScope(staff))).toHaveLength(1);
    });

    it('2. shows nothing held while the fresh reads are pending', async () => {
      boot(); await show();
      const read = gate(); server.readGate = read.promise;
      restore(); await show();
      expect(title()).toBeNull();
      expect(text()).not.toContain(TYPED);
      server.readGate = null; read.open(); await settle();
      expect(title()?.value).toBe(TYPED);
    });

    it('3. starts another account blank, and the first person blank after it', async () => {
      boot(); await show();
      otherAccount(); await show();
      expect(title()).toBeNull();
      expect(text()).not.toContain(TYPED);
      await editor.open();
      expect(title()?.value).toBe(editor.blank);
      boot(); await show();
      signIn(staff); await show();
      expect(text()).not.toContain(TYPED);
      await editor.open();
      expect(title()?.value).toBe(editor.blank);
    });

    it.each(['chapter', 'organization'])('4. starts blank after the officer leaves the %s', async (left) => {
      boot(); await show();
      if (left === 'chapter') leaveChapter(); else leaveOrganization();
      await show();
      restore(); await show();
      expect(text()).not.toContain(TYPED);
      await editor.open();
      expect(title()?.value).toBe(editor.blank);
    });

    it('5. retires the work after an authoritative refusal of the access reads', async () => {
      boot(); await show();
      refuseRead();
      restore(); await show();
      expect(text()).not.toContain(TYPED);
      await editor.open();
      expect(title()?.value).toBe(editor.blank);
    });

    it.each(['sign-out', 'MFA challenge'])('6. retires the work on a %s', async (change) => {
      if (change === 'sign-out') signOut(); else mfa();
      await show();
      restore(); await show();
      expect(text()).not.toContain(TYPED);
      await editor.open();
      expect(title()?.value).toBe(editor.blank);
    });

    it('7. keeps a save in flight locked through the check, written once; once it lands the list shows it', async () => {
      const write = gate(); server.writeGate = write.promise;
      await press(getExposed(view!.container, copy.saveDraft));
      expect(server.contentWrites).toHaveLength(1);
      await check();
      expect(title()?.value).toBe(TYPED);
      expect(title()?.disabled).toBe(true);
      expect(disabled(copy.saveDraft)).toBe(true);
      await press(getExposed(view!.container, copy.saveDraft));
      expect(server.contentWrites).toHaveLength(1);
      server.writeGate = null; write.open(); await settle();
      expect(title()).toBeNull();
      expect(control(copy.editLabel(TYPED))).not.toBeNull();
      await check();
      expect(title()).toBeNull();
      expect(server.contentWrites).toHaveLength(1);
    });

    it('8. returns a definite failure as editable, with its message, through the check', async () => {
      server.failNext = new LearningRequestError('invalid', 'save_learning_content_refused');
      await press(getExposed(view!.container, copy.saveDraft)); await settle();
      expect(text()).toContain(copy.invalid);
      await check();
      expect(title()?.value).toBe(TYPED);
      expect(title()?.disabled).toBe(false);
      expect(text()).toContain(copy.invalid);
      expect(server.contentWrites).toHaveLength(1);
    });

    it('9. never saves again on its own; a lost answer to a create stays locked with Discard until a deliberate Save again', async () => {
      server.loseNext = true;
      await press(getExposed(view!.container, copy.saveDraft)); await settle();
      await check();
      expect(title()?.value).toBe(TYPED);
      expect(server.contentWrites).toHaveLength(1);
      if (!editor.create) {
        // An update carries its revision, so it cannot make a copy. This one
        // landed: the fresh item carries the text, the editor follows it, and
        // there is nothing left to send.
        expect(title()?.disabled).toBe(false);
        expect(text()).not.toContain(copy.failed);
        expect(disabled(copy.saveDraft)).toBe(true);
        return;
      }
      expect(title()?.disabled).toBe(true);
      expect(text()).toContain(UNCERTAIN);
      expect(control(copy.discard)).not.toBeNull();
      await press(getExposed(view!.container, 'Save again')); await settle();
      expect(server.contentWrites).toHaveLength(2);
      expect(text()).toContain(copy.saved);
      expect(title()?.value).toBe(TYPED);
      expect(title()?.disabled).toBe(false);
    });

    it.each(['editing', 'failed', 'unknown'])('10. discards the work in the %s state', async (state) => {
      if (state === 'unknown' && !editor.create) return;
      if (state === 'failed') server.failNext = new LearningRequestError('invalid', 'save_learning_content_refused');
      if (state === 'unknown') server.loseNext = true;
      if (state !== 'editing') { await press(getExposed(view!.container, copy.saveDraft)); await settle(); }
      alertDiscards();
      if (state === 'unknown') await press(getExposed(view!.container, copy.discard));
      else await press(getExposed(view!.container, copy.backToList));
      await settle();
      expect(text()).not.toContain(TYPED);
      await check();
      if (state === 'unknown') {
        // That create had landed: nothing is held, and the fresh list shows it.
        expect(title()).toBeNull();
        expect(control(copy.editLabel(TYPED))).not.toBeNull();
      } else {
        expect(text()).not.toContain(TYPED);
      }
      if (state !== 'unknown' || !control(copy.fields.title)) await editor.open();
      expect(title()?.value).toBe(editor.blank);
      expect(title()?.disabled).toBe(false);
    });

    it('11. keeps the back and edge guards: the swipe stays off and Back asks before discarding the restored work', async () => {
      const asked = alertWith(() => undefined);
      server.setOptions.mockClear();
      await check();
      expect(server.setOptions).toHaveBeenCalledWith({ gestureEnabled: false });
      await press(getExposed(view!.container, copy.backToList));
      expect(asked).toHaveBeenCalledWith(copy.discardTitle, undefined, expect.any(Array));
      expect(title()?.value).toBe(TYPED);
    });

    it('12. while the provider\'s reads are unconfirmed only the held text waits; the failure line and Back stay', async () => {
      server.failNext = new LearningRequestError('invalid', 'save_learning_content_refused');
      await press(getExposed(view!.container, copy.saveDraft)); await settle();
      unconfirmReads(); await show();
      expect(title()).toBeNull();
      expect(text()).not.toContain(TYPED);
      expect(text()).toContain(HELD_LOADING);
      expect(text()).toContain(copy.invalid);
      expect(control(copy.backToList)).not.toBeNull();
      restore(); await show();
      expect(title()?.value).toBe(TYPED);
    });
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('the learning editor\'s targets and live state on %s', (platform) => {
  const title = () => input(copy.fields.title);
  beforeEach(() => { setPlatform(platform); server.staff = 'chapter'; });

  it('returns an organization draft to the organization scope and never shows it in the campaign scope', async () => {
    signIn('chapter', { organizationAdmin: true });
    view = await render(h(Host)); await settle();
    await press(getExposed(view.container, copy.scope.organization)); await settle();
    await press(getExposed(view.container, copy.newQuote)); await settle();
    await type(getExposed(view.container, copy.fields.title), TYPED);
    await check();
    expect(title()?.value).toBe(TYPED);
    expect(text()).toContain(copy.newItemTitle(copy.kind.quote));
    alertDiscards();
    // Leaving with Back keeps nothing behind for the chapter's own new quote.
    await press(getExposed(view.container, copy.backToList)); await settle();
    await press(getExposed(view.container, copy.scope.chapter)); await settle();
    await press(getExposed(view.container, copy.newQuote)); await settle();
    expect(title()?.value).toBe('');
  });

  it('keeps a held edit of an item that changed during the check, says so, and never saves over the newer revision', async () => {
    signIn('chapter');
    view = await render(h(Host)); await settle();
    await press(getExposed(view.container, copy.editLabel('Reviewed writing'))); await settle();
    await type(getExposed(view.container, copy.fields.title), TYPED);
    boot(); await show();
    server.items = server.items.map((item) => (item.scope === 'chapter' ? { ...item, title: 'Newer reviewed writing', revision: 4 } : item));
    restore(); await show();
    expect(title()?.value).toBe(TYPED);
    expect(text()).toContain(ITEM_STALE);
    await press(getExposed(view.container, copy.saveDraft)); await settle();
    expect(server.contentWrites.at(-1)).toEqual(expect.objectContaining({ revision: 3, title: TYPED }));
    expect(text()).toContain(copy.conflict);
    expect(server.items.find((item) => item.scope === 'chapter')?.title).toBe('Newer reviewed writing');
  });

  it('keeps the held text when Back is pressed while it waits, and shows it when the item is opened again', async () => {
    signIn('chapter');
    view = await render(h(Host)); await settle();
    await press(getExposed(view.container, copy.editLabel('Reviewed writing'))); await settle();
    await type(getExposed(view.container, copy.fields.title), TYPED);
    const asked = alertWith(() => undefined);
    unconfirmReads(); await show();
    await press(getExposed(view.container, copy.backToList)); await settle();
    expect(asked).not.toHaveBeenCalled();
    expect(title()).toBeNull();
    restore(); await show();
    expect(title()).toBeNull();
    await press(getExposed(view.container, copy.editLabel('Reviewed writing'))); await settle();
    expect(title()?.value).toBe(TYPED);
  });

  // The read of db613114, P2 A: the unconfirmed line sends the person to the
  // list, so the list is read again after a lost create answer.
  it.each(['while the editor is open', 'after the check'])('reads the list again after a create whose answer was lost %s', async (when) => {
    signIn('chapter');
    view = await render(h(Host)); await settle();
    await press(getExposed(view.container, copy.newQuote)); await settle();
    await type(getExposed(view.container, copy.fields.title), TYPED);
    await type(getExposed(view.container, copy.quoteBodyLabel), TYPED_BODY);
    server.loseNext = true;
    if (when === 'after the check') {
      const write = gate(); server.writeGate = write.promise;
      await press(getExposed(view.container, copy.saveDraft));
      await check();
      server.writeGate = null; write.open(); await settle();
    } else {
      await press(getExposed(view.container, copy.saveDraft)); await settle();
    }
    expect(text()).toContain(UNCERTAIN);
    alertDiscards();
    await press(getExposed(view.container, copy.discard)); await settle();
    await press(getExposed(view.container, copy.backToList)); await settle();
    expect(title()).toBeNull();
    expect(control(copy.editLabel(TYPED))).not.toBeNull();
    expect(server.created).toBe(1);
  });

  // The read of db613114, P2 B: a create that lands while the manager is
  // unmounted leaves nothing held, so the return is the fresh list.
  it('opens the list, not a blank editor, when a create lands during the unmount', async () => {
    signIn('chapter');
    view = await render(h(Host)); await settle();
    await press(getExposed(view.container, copy.newQuote)); await settle();
    await type(getExposed(view.container, copy.fields.title), TYPED);
    await type(getExposed(view.container, copy.quoteBodyLabel), TYPED_BODY);
    const write = gate(); server.writeGate = write.promise;
    await press(getExposed(view.container, copy.saveDraft));
    boot(); await show();
    server.writeGate = null; write.open(); await settle();
    restore(); await show();
    expect(title()).toBeNull();
    expect(control(copy.editLabel(TYPED))).not.toBeNull();
    expect(server.created).toBe(1);
    expect(server.contentWrites).toHaveLength(1);
  });

  it('keeps an open publication confirmation working while the held text waits', async () => {
    signIn('chapter');
    view = await render(h(Host)); await settle();
    await press(getExposed(view.container, copy.editLabel('Reviewed writing'))); await settle();
    await press(getExposed(view.container, copy.publishNow)); await settle();
    unconfirmReads(); await show();
    expect(title()).toBeNull();
    await press(getExposed(view.container, copy.confirm)); await settle();
    expect(server.transitions).toBe(1);
    expect(text()).toContain(copy.conflict);
    expect(disabled(copy.cancel)).toBe(false);
  });
});

describe.each<['ios' | 'android', StaffKind]>([['ios', 'chapter'], ['ios', 'chapterless'], ['android', 'chapter'], ['android', 'chapterless']])('the policy editor on %s for a %s officer', (platform, staff) => {
  const quotes = () => control(copy.quotesSwitch);
  const scopeOf = () => contentScope(staff);
  beforeEach(async () => {
    setPlatform(platform);
    signIn(staff); server.staff = staff;
    view = await render(h(Host)); await settle();
    await press(getExposed(view.container, copy.quotesSwitch));
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps an unsaved switch change through the check, unsent', async () => {
    await check();
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
    expect(server.policyWrites).toHaveLength(0);
  });

  it('shows nothing held while the fresh reads are pending, and nothing for another account', async () => {
    boot(); await show();
    const read = gate(); server.readGate = read.promise;
    restore(); await show();
    expect(quotes()).toBeNull();
    server.readGate = null; read.open(); await settle();
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
    boot(); await show(); otherAccount(); await show();
    expect(quotes()?.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a save in flight locked through the check, sent once, and shows the saved settings once it lands', async () => {
    const write = gate(); server.writeGate = write.promise;
    await press(getExposed(view!.container, copy.savePolicy));
    await check();
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
    expect(disabled(copy.savePolicy)).toBe(true);
    server.writeGate = null; write.open(); await settle();
    expect(server.policyWrites).toHaveLength(1);
    expect(server.policies[scopeOf()]?.quotesEnabled).toBe(false);
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
    expect(disabled(copy.savePolicy)).toBe(true);
    await check();
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
    expect(server.policyWrites).toHaveLength(1);
  });

  it('returns a definite failure as editable, with its message, through the check', async () => {
    server.failNext = new LearningRequestError('invalid', 'save_learning_policy_refused');
    await press(getExposed(view!.container, copy.savePolicy)); await settle();
    await check();
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
    expect(disabled(copy.savePolicy)).toBe(false);
    expect(text()).toContain(copy.invalid);
  });

  it('keeps a change typed against settings that moved during the check, says so, never saves over them, and Reload takes the current ones', async () => {
    boot(); await show();
    server.policies[scopeOf()] = { quotesEnabled: true, lessonsEnabled: false, selectedIds: null, revision: 2 };
    restore(); await show();
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain(POLICY_STALE);
    await press(getExposed(view!.container, copy.savePolicy)); await settle();
    expect(server.policyWrites.at(-1)).toEqual(expect.objectContaining({ expectedRevision: 1, quotesEnabled: false }));
    expect(server.policies[scopeOf()]?.lessonsEnabled).toBe(false);
    expect(text()).toContain(copy.conflict);
    await press(getExposed(view!.container, copy.policyReload)); await settle();
    expect(quotes()?.getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain(POLICY_STALE);
    await check();
    expect(quotes()?.getAttribute('aria-checked')).toBe('true');
  });

  it('waits while the provider\'s reads are unconfirmed, keeping the content list', async () => {
    unconfirmReads(); await show();
    expect(quotes()).toBeNull();
    expect(control(copy.editLabel('Reviewed writing'))).not.toBeNull();
    restore(); await show();
    expect(quotes()?.getAttribute('aria-checked')).toBe('false');
  });
});

// A save on a hung connection ends at the write deadline.
// An unkeyed create becomes unconfirmed (locked, Save again, Discard), never a
// second automatic send; a revision-guarded save becomes a definite failure.
describe.each<'ios' | 'android'>(['ios', 'android'])('a learning save on a hung connection on %s', (platform) => {
  const title = () => input(copy.fields.title);
  const pastDeadline = async () => { await act(async () => { await new Promise((done) => { setTimeout(done, 60); }); }); await settle(); };
  beforeEach(async () => {
    setPlatform(platform); signIn('chapter'); server.staff = 'chapter'; server.deadlineMs = 25;
    server.writeGate = gate().promise;
    view = await render(h(Host)); await settle();
  });

  it('leaves a hung create unconfirmed and locked, sent once, until a deliberate Save again', async () => {
    await press(getExposed(view!.container, copy.newQuote)); await settle();
    await type(getExposed(view!.container, copy.fields.title), TYPED);
    await type(getExposed(view!.container, copy.quoteBodyLabel), TYPED_BODY);
    await press(getExposed(view!.container, copy.saveDraft));
    await pastDeadline();
    expect(text()).toContain(UNCERTAIN);
    expect(title()?.disabled).toBe(true);
    expect(disabled('Save again')).toBe(false);
    expect(control(copy.discard)).not.toBeNull();
    await check();
    expect(title()?.value).toBe(TYPED);
    expect(text()).toContain(UNCERTAIN);
    expect(server.contentWrites).toHaveLength(1);
  });

  it.each(['create', 'update'])('drops a %s that lands after the deadline: no Saved line, written once', async (what) => {
    const write = gate(); server.writeGate = write.promise;
    if (what === 'create') await press(getExposed(view!.container, copy.newQuote));
    else await press(getExposed(view!.container, copy.editLabel('Reviewed writing')));
    await settle();
    await type(getExposed(view!.container, copy.fields.title), TYPED);
    await type(getExposed(view!.container, copy.quoteBodyLabel), TYPED_BODY);
    await press(getExposed(view!.container, copy.saveDraft));
    await pastDeadline();
    server.writeGate = null; write.open(); await settle();
    expect(text()).not.toContain(copy.saved);
    expect(server.contentWrites).toHaveLength(1);
    if (what === 'create') {
      expect(text()).toContain(UNCERTAIN);
      expect(server.created).toBe(1);
    } else {
      // The landed update moved the revision: the next Save is refused.
      expect(text()).toContain(copy.failed);
      await press(getExposed(view!.container, copy.saveDraft)); await settle();
      expect(server.contentWrites).toHaveLength(2);
      expect(text()).toContain(copy.conflict);
    }
  });

  it('returns a hung update as a definite failure, editable', async () => {
    await press(getExposed(view!.container, copy.editLabel('Reviewed writing'))); await settle();
    await type(getExposed(view!.container, copy.fields.title), TYPED);
    await press(getExposed(view!.container, copy.saveDraft));
    await pastDeadline();
    expect(text()).toContain(copy.failed);
    expect(title()?.disabled).toBe(false);
    expect(disabled(copy.saveDraft)).toBe(false);
    expect(server.contentWrites).toHaveLength(1);
  });

  it('returns a hung policy save as a definite failure, editable', async () => {
    await press(getExposed(view!.container, copy.quotesSwitch));
    await press(getExposed(view!.container, copy.savePolicy));
    await pastDeadline();
    expect(text()).toContain(copy.failed);
    expect(disabled(copy.savePolicy)).toBe(false);
    expect(control(copy.quotesSwitch)?.getAttribute('aria-checked')).toBe('false');
    expect(server.policyWrites).toHaveLength(1);
  });
});

// Keeps the fixture honest: the harness officer is who the manager serves.
it('serves the harness officer', () => {
  signIn('chapter');
  expect(harnessApp().captureAuthenticatedSessionGuard()()).toBe(true);
});
