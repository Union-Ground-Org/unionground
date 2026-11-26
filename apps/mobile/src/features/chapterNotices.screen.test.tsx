import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { canOpenFeature } from '../lib/featureCatalog';
import { STAFF_HAT_FUNCTIONS } from '../lib/hatFunctions';
import { nativeUiText } from '../lib/nativeUiCopy';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 2 of 4): working as Chapter Administrator or President, an
// officer opens Chapter notices, writes and sends a chapter notice, and the
// saved row is listed under "Notices you sent". The stand-in backend answers
// the website's own RPCs: get_chapter_office_access for the audience,
// publish_chapter_office_notice to store a chapter notice, and
// list_my_member_notices to read it back.

type Notice = { id: string; title: string; body: string; locale: string; publishedAt: string; retractedAt: null; readCount: number; audienceCount: number; unitId: string | null };

const backend = vi.hoisted(() => ({
  notices: [] as Notice[],
  userID: 'officer-fixture',
  sessionUserID: undefined as string | null | undefined,
  reply: null as Promise<void> | null,
  keyWait: null as Promise<void> | null,
  // The publisher answers a repeat of an operation key with the notice it
  // already published, as publish_chapter_office_notice does since
  // 20261119180000 (#9220).
  published: new Map<string, string>(),
  uuid: 0,
  // A transient 404 from the API in front of the database: nothing ran.
  missingFunction: false,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  role: 'admin' as string,
  officeNotices: true,
  refuse: null as null | { code: string; message: string },
  language: 'en' as 'en' | 'es',
  // The RPC publishes, then its answer is lost on the way back.
  loseNextReply: false,
  failListRead: false,
  holdReply: null as Promise<void> | null,
  holdProof: null as Promise<void> | null,
  proof: 'current' as 'current' | 'unavailable' | 'changed',
  writerRefused: false,
  // A refusal that only copies the writer's marker, not the
  // WriterSessionChanged object the writer throws.
  writerMarkerCopied: false,
  // Granted unit audiences (get_chapter_office_access scopes) and whether the
  // role may also send to the whole chapter.
  unscoped: true,
  scopes: [] as { name: string; unitId: string }[],
}));

function rpc(name: string, args: Record<string, unknown> = {}) {
  backend.calls.push({ name, args });
  if (name === 'get_chapter_office_access') {
    return { data: { chapterId: 'chapter-fixture', notices: backend.officeNotices, unscopedNotices: backend.officeNotices && backend.unscoped, scopes: backend.scopes.map((scope) => ({ ...scope, role: backend.role, notices: true })) }, error: null };
  }
  if (name === 'publish_chapter_office_notice') {
    if (backend.missingFunction) return { data: null, status: 404, error: { code: 'PGRST202', message: 'Could not find the function' } };
    if (backend.refuse) return { data: null, error: backend.refuse };
    const key = typeof args.p_idempotency_key === 'string' ? args.p_idempotency_key : null;
    const repeat = key ? backend.published.get(key) : undefined;
    if (repeat) return { data: { broadcastId: repeat }, error: null };
    const id = `bc-${backend.notices.length + 1}`;
    if (key) backend.published.set(key, id);
    backend.notices.unshift({ id, title: String(args.p_title), body: String(args.p_body), locale: String(args.p_locale), publishedAt: new Date().toISOString(), retractedAt: null, readCount: 0, audienceCount: 42, unitId: args.p_unit == null ? null : String(args.p_unit) });
    if (backend.reply) {
      const reply = backend.reply; backend.reply = null;
      const lost = backend.loseNextReply; backend.loseNextReply = false;
      return reply.then(() => lost ? { data: null, error: { code: '', message: 'TypeError: Network request failed' } } : { data: { broadcastId: id }, error: null });
    }
    if (backend.loseNextReply) { backend.loseNextReply = false; return { data: null, error: { code: '', message: 'TypeError: Network request failed' } }; }
    return { data: { broadcastId: id }, error: null };
  }
  if (name === 'list_steward_broadcasts') return { data: backend.notices.map((row) => ({ ...row, published_at: row.publishedAt })), error: null };
  if (name === 'list_my_member_notices' && backend.failListRead) return { data: null, error: { code: '', message: 'TypeError: Network request failed' } };
  if (name === 'list_my_member_notices') return { data: { notices: backend.notices.map((notice) => ({ ...notice })), hasMore: false }, error: null };
  return { data: null, error: { code: 'PGRST202', message: `unexpected ${name}` } };
}

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => {
  const key = `00000000-0000-4000-8000-${String(++backend.uuid).padStart(12, '0')}`;
  return backend.keyWait ? backend.keyWait.then(() => key) : key;
} }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn() } }));
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    session: (backend.sessionUserID === undefined ? backend.userID : backend.sessionUserID) === null ? null : { user: { id: backend.sessionUserID ?? backend.userID } },
    mode: 'authenticated', dashboard: { member: { id: backend.userID, chapterID: 'chapter-fixture', language: backend.language } },
    captureAccountSessionGuard: (userID: string) => () => (backend.sessionUserID === undefined ? backend.userID : backend.sessionUserID) === userID,
    memberLanguage: backend.language, chosenStaffRole: backend.role, authorizedRoles: [backend.role], chapterRoles: [backend.role], organizationRoles: [],
    chapterMemberships: [{ chapterID: 'chapter-fixture', selected: true }],
  }),
}));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => {
  const base = stubSessionWriter(() => ({ rpc: async (name: string, args?: Record<string, unknown>) => {
    const result = rpc(name, args);
    if (name === 'publish_chapter_office_notice' && backend.holdReply) { const held = backend.holdReply; backend.holdReply = null; await held; }
    return result;
  } }), session?.user?.id ?? 'member-a');
  return {
    ...base,
    isCurrent: async () => { if (backend.holdProof) await backend.holdProof; return backend.proof === 'current'; },
    check: async () => { if (backend.holdProof) await backend.holdProof; return backend.proof; },
    client: async () => {
      if (backend.writerRefused) throw new (await import('../../../../src/lib/sessionBoundWriter.js')).WriterSessionChanged();
      if (backend.writerMarkerCopied) throw Object.assign(new Error('The account changed before this was sent.'), { name: 'WriterSessionChanged', details: 'writer_session_changed' });
      return base.client();
    },
  };
},
  getSupabaseClient: () => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }),
}));

import { ChapterNoticesScreen } from './ChapterNoticesScreen';
import { StewardDeskSectionsScreen } from './StewardDeskSectionsScreen';
import { NoticeComposer } from './NoticeComposer';
import { haptics } from '../services/haptics';
import { beginNoticeSend, forgetNoticeSend, noticeSendIsCurrent, readPendingNoticeSend, retireDepartedNoticeSends, updateNoticeSend } from './noticePendingSend';

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const text = (view: Rendered) => view.container.textContent ?? '';
const publishes = () => backend.calls.filter((call) => call.name === 'publish_chapter_office_notice' || call.name === 'publish_member_broadcast');

let view: Rendered | null = null;

async function open(): Promise<Rendered> {
  view = await render(h(ChapterNoticesScreen, { title: 'Campaign notices' }));
  await settle();
  return view;
}

beforeEach(() => {
  backend.userID = `officer-${++backend.uuid}`;
  backend.sessionUserID = undefined;
  backend.reply = null;
  backend.keyWait = null;
  backend.notices = [];
  backend.published.clear();
  backend.missingFunction = false;
  backend.calls = [];
  backend.role = 'admin';
  backend.officeNotices = true;
  backend.refuse = null;
  backend.language = 'en';
  backend.loseNextReply = false;
  backend.failListRead = false;
  backend.holdReply = null; backend.holdProof = null;
  backend.proof = 'current';
  backend.writerRefused = false;
  backend.writerMarkerCopied = false;
  backend.unscoped = true;
  backend.scopes = [];
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  setPlatform('ios');
});

it.each(['send', 'proof'])('keeps the next scope draft and suppresses old success when scope changes during %s', async (stage) => {
  vi.mocked(haptics.success).mockClear();
  const onSentFirst = vi.fn(); const onSentSecond = vi.fn();
  view = await render(h(NoticeComposer, { scope: { key: 'officer|admin|chapter-fixture', chapterID: 'chapter-fixture', role: 'admin' }, onSent: onSentFirst }));
  await settle();
  await type(getExposed(view.container, 'Broadcast title'), 'Office closed Friday');
  await type(getExposed(view.container, 'Broadcast message'), 'The office reopens Monday.');
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  if (stage === 'send') backend.holdReply = held; else backend.holdProof = held;
  await press(getExposed(view.container, 'Send notice')); await settle();
  await view.rerender(h(NoticeComposer, { scope: { key: 'officer|admin|chapter-other', chapterID: 'chapter-other', role: 'admin' }, onSent: onSentSecond }));
  await settle();
  await type(getExposed(view.container, 'Broadcast title'), 'Second campaign draft');
  await act(async () => { release(); }); await settle();
  expect((getExposed(view.container, 'Broadcast title') as HTMLInputElement).value).toBe('Second campaign draft');
  expect(onSentFirst).not.toHaveBeenCalled(); expect(onSentSecond).not.toHaveBeenCalled();
  expect(haptics.success).not.toHaveBeenCalled();
});

describe.each<['ios' | 'android', 'admin' | 'vp']>([
  ['ios', 'admin'],
  ['android', 'admin'],
  ['ios', 'vp'],
  ['android', 'vp'],
])('campaign notices on %s working as %s', (os, role) => {
  it('sends a campaign notice and lists the saved row under Notices you sent', async () => {
    setPlatform(os);
    backend.role = role;
    const screen = await open();
    expect(text(screen)).toContain('You have not sent a notice yet.');
    expect(text(screen)).toContain('My campaign');

    await type(getExposed(screen.container, 'Broadcast title'), 'Contract vote this Thursday');
    await type(getExposed(screen.container, 'Broadcast message'), 'Polls open at noon in the union hall.');
    await press(getExposed(screen.container, 'Send notice'));
    await settle();

    expect(publishes().map((call) => call.args)).toEqual([{
      p_title: 'Contract vote this Thursday', p_body: 'Polls open at noon in the union hall.', p_locale: 'en',
      p_chapter: 'chapter-fixture', p_unit: null, p_committee: null, p_idempotency_key: expect.stringMatching(/^00000000-0000-4000-8000-/),
    }]);
    expect(backend.calls.find((call) => call.name === 'publish_chapter_office_notice')).toBeDefined();
    expect(backend.notices).toHaveLength(1);
    expect(text(screen)).toContain('Contract vote this Thursday');
    expect(text(screen)).toContain('Read by 0 of 42');
    expect(text(screen)).not.toContain('You have not sent a notice yet.');
  });
});

describe.each<'ios' | 'android'>(['ios', 'android'])('a notice whose answer was lost, on %s', (os) => {
  async function writeNotice(screen: Rendered) {
    await type(getExposed(screen.container, 'Broadcast title'), 'Contract vote this Thursday');
    await type(getExposed(screen.container, 'Broadcast message'), 'Polls open at noon in the union hall.');
  }
  // Every try carries the draft's key, so none can post twice (#9220).
  const unconfirmed = 'We could not confirm this notice was sent. Check the notices you sent first. Sending it again will not post it twice.';
  const title = (screen: Rendered) => (getExposed(screen.container, 'Broadcast title') as HTMLInputElement);

  it('keeps the draft locked and unconfirmed, offering check, send again and cancel', async () => {
    setPlatform(os);
    const screen = await open();
    await writeNotice(screen);
    backend.loseNextReply = true;
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    expect(text(screen)).toContain(unconfirmed);
    expect(backend.notices).toHaveLength(1);
    expect(title(screen).disabled).toBe(true);
    await type(title(screen), 'Edited title');
    await press(getExposed(screen.container, 'Español'));
    expect(title(screen).value).toBe('Contract vote this Thursday');
    expect(exposedNames(screen.container)).toEqual(expect.arrayContaining(['Check the notices you sent', 'Send again', 'Discard']));
    // Checking the list reloads it and keeps the unconfirmed draft.
    const reads = backend.calls.filter((call) => call.name === 'list_my_member_notices').length;
    await press(getExposed(screen.container, 'Check the notices you sent'));
    await settle();
    expect(backend.calls.filter((call) => call.name === 'list_my_member_notices').length).toBe(reads + 1);
    expect(text(screen)).toContain('Contract vote this Thursday');
    expect(title(screen).value).toBe('Contract vote this Thursday');
    expect(text(screen)).toContain(unconfirmed);
  });

  it('sends again only when asked, with the same notice, and clears the draft once that send succeeds', async () => {
    setPlatform(os);
    const screen = await open();
    await writeNotice(screen);
    backend.refuse = { code: '', message: 'TypeError: Network request failed' };
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    expect(text(screen)).toContain(unconfirmed);
    backend.refuse = null;
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    expect(publishes().map((call) => [call.args.p_title, call.args.p_body, call.args.p_locale])).toEqual([
      ['Contract vote this Thursday', 'Polls open at noon in the union hall.', 'en'],
      ['Contract vote this Thursday', 'Polls open at noon in the union hall.', 'en'],
    ]);
    // Send again is the same operation as the first try (#9220).
    const [first, again] = publishes().map((call) => call.args.p_idempotency_key);
    expect(first).toEqual(expect.any(String));
    expect(again).toBe(first);
    expect(backend.notices).toHaveLength(1);
    expect(text(screen)).not.toContain(unconfirmed);
    expect(title(screen).value).toBe('');
    expect(title(screen).disabled).toBe(false);
  });

  // #9220: the lost try was published. Send again carries the draft's key, so
  // the server answers with that notice and members get it once.
  it('publishes the notice once when Send again follows a published try whose answer was lost', async () => {
    setPlatform(os);
    const screen = await open();
    await writeNotice(screen);
    backend.loseNextReply = true;
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    expect(text(screen)).toContain(unconfirmed);
    expect(backend.notices).toHaveLength(1);
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    const [first, again] = publishes().map((call) => call.args.p_idempotency_key);
    expect(again).toBe(first);
    expect(backend.notices).toHaveLength(1);
    expect(text(screen)).not.toContain(unconfirmed);
    expect(title(screen).value).toBe('');
  });

  // React Native's fetch has no timeout on Android, so a
  // publish that never answered kept the composer busy until the app
  // restarted. At the 20-second deadline the notice is held unconfirmed, and
  // Send again carries the first try's key, so it posts once.
  it('ends a publish that never answers at the deadline, held unconfirmed, and sends again with the same key', async () => {
    setPlatform(os);
    const screen = await open();
    await writeNotice(screen);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      backend.holdReply = new Promise<void>(() => undefined);
      await press(getExposed(screen.container, 'Send notice'));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(publishes()).toHaveLength(1);
      expect(text(screen)).toContain('Sending…');
      expect(getExposed(screen.container, 'Send again').getAttribute('aria-disabled')).toBe('true');
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(text(screen)).toContain(unconfirmed);
    expect(text(screen)).not.toContain('Sending…');
    expect(title(screen).value).toBe('Contract vote this Thursday');
    expect(getExposed(screen.container, 'Send again').getAttribute('aria-disabled')).toBeNull();
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    const [first, again] = publishes().map((call) => call.args.p_idempotency_key);
    expect(again).toBe(first);
    expect(backend.notices).toHaveLength(1);
    expect(text(screen)).not.toContain(unconfirmed);
    expect(title(screen).value).toBe('');
  });

  // 20261119180000 is applied on both databases, so a 404
  // to the keyed call is a failure like any other: nothing goes without the
  // key and the composer says the notice was not sent. The server answered,
  // so nothing ran and the next press posts once (with a key of its own, as
  // after any answered refusal on the phone).
  it('says a notice was not sent after a 404, sends nothing without the key, and posts once on the next press', async () => {
    setPlatform(os);
    backend.missingFunction = true;
    const screen = await open();
    await writeNotice(screen);
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    expect(text(screen)).toContain('The broadcast was not sent. Try again.');
    expect(text(screen)).not.toContain('may post it twice');
    expect(backend.notices).toHaveLength(0);
    backend.missingFunction = false;
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    const keys = publishes().map((call) => call.args.p_idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => typeof key === 'string' && key !== '')).toBe(true);
    expect(backend.notices).toHaveLength(1);
    expect(title(screen).value).toBe('');
  });

  it('starts a new key for the next draft after Cancel', async () => {
    setPlatform(os);
    const screen = await open();
    await writeNotice(screen);
    backend.refuse = { code: '', message: 'TypeError: Network request failed' };
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    await press(getExposed(screen.container, 'Discard'));
    await press(getExposed(screen.container, 'Discard notice'));
    backend.refuse = null;
    await writeNotice(screen);
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    const [cancelled, fresh] = publishes().map((call) => call.args.p_idempotency_key);
    expect(fresh).not.toBe(cancelled);
    expect(backend.notices).toHaveLength(1);
  });

  it('stays unconfirmed, keeping the draft, when sending again fails with no answer too', async () => {
    setPlatform(os);
    const screen = await open();
    await writeNotice(screen);
    backend.refuse = { code: '', message: 'TypeError: Network request failed' };
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    expect(text(screen)).toContain(unconfirmed);
    expect(title(screen).value).toBe('Contract vote this Thursday');
    expect(backend.notices).toHaveLength(0);
  });

  it('cancels an unconfirmed draft and unlocks a fresh one', async () => {
    setPlatform(os);
    const screen = await open();
    await writeNotice(screen);
    backend.loseNextReply = true;
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    await press(getExposed(screen.container, 'Discard'));
    await press(getExposed(screen.container, 'Discard notice'));
    await settle();
    expect(title(screen).disabled).toBe(false);
    expect(title(screen).value).toBe('');
    expect(exposedNames(screen.container)).not.toContain('Discard');
    expect(text(screen)).not.toContain(unconfirmed);
  });

  // R-9219 R1, the reviewer's two cases: no earlier notice with the same text
  // is taken as proof that this draft was sent.
  it('sends the Unit B draft although the same text was already sent to Unit A', async () => {
    setPlatform(os);
    backend.officeNotices = true;
    backend.unscoped = false;
    backend.scopes = [{ name: 'Unit A', unitId: 'unit-a' }, { name: 'Unit B', unitId: 'unit-b' }];
    const screen = await open();
    await writeNotice(screen);
    await press(getExposed(screen.container, 'Send unit notice'));
    await settle();
    expect(backend.notices[0]?.unitId).toBe('unit-a');
    await writeNotice(screen);
    await press(getExposed(screen.container, 'Unit: Unit B'));
    backend.refuse = { code: '', message: 'TypeError: Network request failed' };
    await press(getExposed(screen.container, 'Send unit notice'));
    await settle();
    expect(text(screen)).toContain(unconfirmed);
    expect(title(screen).value).toBe('Contract vote this Thursday');
    backend.refuse = null;
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    expect(backend.notices.map((row) => row.unitId)).toEqual(['unit-b', 'unit-a']);
    expect(text(screen)).not.toContain(unconfirmed);
  });

  it('sends the draft although an identical notice was sent five minutes earlier', async () => {
    setPlatform(os);
    backend.notices.push({ id: 'bc-prior', title: 'Contract vote this Thursday', body: 'Polls open at noon in the union hall.', locale: 'en', publishedAt: new Date(Date.now() - 5 * 60_000).toISOString(), retractedAt: null, readCount: 3, audienceCount: 42, unitId: null });
    const screen = await open();
    await writeNotice(screen);
    backend.refuse = { code: '', message: 'TypeError: Network request failed' };
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    expect(title(screen).value).toBe('Contract vote this Thursday');
    backend.refuse = null;
    await press(getExposed(screen.container, 'Send again'));
    await settle();
    expect(backend.notices).toHaveLength(2);
    expect(publishes()).toHaveLength(2);
  });
});

describe('the notice language (#9117)', () => {
  it('starts at the account language and sends the language chosen', async () => {
    backend.language = 'es';
    const screen = await open();
    const t = nativeUiText('es');
    await type(getExposed(screen.container, t('Broadcast title')), 'Reunion general');
    await type(getExposed(screen.container, t('Broadcast message')), 'Nos vemos el jueves.');
    await press(getExposed(screen.container, t('Send notice')));
    await settle();
    expect(publishes()[0]?.args.p_locale).toBe('es');
  });

  it('sends Spanish when an English-language officer picks Espanol', async () => {
    const screen = await open();
    await type(getExposed(screen.container, 'Broadcast title'), 'Reunion general');
    await type(getExposed(screen.container, 'Broadcast message'), 'Nos vemos el jueves.');
    await press(getExposed(screen.container, 'Español'));
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    expect(publishes()[0]?.args.p_locale).toBe('es');
    expect(backend.notices[0]?.locale).toBe('es');
  });
});

describe('campaign notices refusals', () => {
  it('says so when the role has no notice audience, and sends nothing', async () => {
    backend.officeNotices = false;
    const screen = await open();
    expect(text(screen)).toContain('No notice audience is available for this role.');
    expect(exposedNames(screen.container)).toContain('Send notice');
    expect(publishes()).toHaveLength(0);
  });

  it('names a server refusal and keeps the draft', async () => {
    backend.refuse = { code: '54000', message: 'broadcast limit reached' };
    const screen = await open();
    await type(getExposed(screen.container, 'Broadcast title'), 'Reminder');
    await type(getExposed(screen.container, 'Broadcast message'), 'Dues office hours moved.');
    await press(getExposed(screen.container, 'Send notice'));
    await settle();
    expect(text(screen)).toContain('The broadcast was not sent. Try again.');
    expect(backend.notices).toHaveLength(0);
  });

  it('reads in Spanish', async () => {
    backend.language = 'es';
    const screen = await open();
    const t = nativeUiText('es');
    expect(screen.container.querySelector('[role="heading"]')?.textContent).toBe(t('Campaign notices'));
    expect(t('Notices you sent')).not.toBe('Notices you sent');
    expect(text(screen)).toContain(t('Notices you sent'));
    expect(text(screen)).toContain(t('You have not sent a notice yet.'));
  });

  it('says in Spanish that Send again will not post a keyed notice twice', async () => {
    backend.language = 'es';
    const screen = await open();
    const t = nativeUiText('es');
    await type(getExposed(screen.container, t('Broadcast title')), 'Votación del contrato');
    await type(getExposed(screen.container, t('Broadcast message')), 'Las urnas abren al mediodía.');
    backend.loseNextReply = true;
    await press(getExposed(screen.container, t('Send notice')));
    await settle();
    const line = t('We could not confirm this notice was sent. Check the notices you sent first. Sending it again will not post it twice.');
    expect(line).toContain('no se publicará dos veces');
    expect(text(screen)).toContain(line);
  });
});

describe('the shared notice composer on its own', () => {
  describe.each<'en' | 'es'>(['en', 'es'])('guarded notice-check feedback in %s', (language) => {
    it.each<'granted' | 'alternate'>(['granted', 'alternate'])('shows a failed check in the %s audience view', async (audienceView) => {
      backend.language = language;
      const t = nativeUiText(language);
      const scope = { key: `${backend.userID}|admin|chapter-fixture`, chapterID: 'chapter-fixture', role: 'admin' };
      view = await render(h(NoticeComposer, { scope, onSent: vi.fn() })); await settle();
      await type(getExposed(view.container, t('Broadcast title')), 'A held notice');
      await type(getExposed(view.container, t('Broadcast message')), 'Keep its original operation.');
      backend.loseNextReply = true;
      await press(getExposed(view.container, t('Send notice'))); await settle();
      if (audienceView === 'alternate') {
        backend.officeNotices = false; backend.role = 'vp';
        await view.rerender(h(NoticeComposer, { scope: { ...scope, key: `${backend.userID}|vp|chapter-fixture`, role: 'vp' }, onSent: vi.fn() }));
        await settle(); expect(exposedNames(view.container)).toContain(t('Show notice message'));
      }
      backend.proof = 'unavailable';
      await press(getExposed(view.container, t('Check the notices you sent'))); await settle();
      expect(text(view)).toContain(t('The notices could not be checked. Try again when your connection is available.'));
      expect(publishes()).toHaveLength(1);
    });
  });
  describe.each<'ios' | 'android'>(['ios', 'android'])('merged writer refusal on %s', (os) => {
    it('knows a first send refused before the RPC was not published', async () => {
      setPlatform(os);
      const scope = { key: `${backend.userID}|admin|chapter-fixture`, chapterID: 'chapter-fixture', role: 'admin' };
      view = await render(h(NoticeComposer, { scope, onSent: vi.fn() }));
      await settle();
      await type(getExposed(view.container, 'Broadcast title'), 'Never left the phone');
      await type(getExposed(view.container, 'Broadcast message'), 'The writer refused before publishing.');
      backend.writerRefused = true;
      await press(getExposed(view.container, 'Send notice')); await settle();
      expect(publishes()).toHaveLength(0);
      const held = readPendingNoticeSend(`${backend.userID}|chapter-fixture`);
      expect(held?.outcomeUnknown ?? false).toBe(false);
      expect(text(view)).not.toContain('could not confirm');
      expect(text(view)).toContain('The broadcast was not sent. Try again.');
    });
    it('keeps a send unconfirmed when the error only copies the writer marker (ledger 714)', async () => {
      setPlatform(os);
      const scope = { key: `${backend.userID}|admin|chapter-fixture`, chapterID: 'chapter-fixture', role: 'admin' };
      view = await render(h(NoticeComposer, { scope, onSent: vi.fn() }));
      await settle();
      await type(getExposed(view.container, 'Broadcast title'), 'Copied marker');
      await type(getExposed(view.container, 'Broadcast message'), 'Not the writer refusal.');
      backend.writerMarkerCopied = true;
      await press(getExposed(view.container, 'Send notice')); await settle();
      const held = readPendingNoticeSend(`${backend.userID}|chapter-fixture`);
      expect(held?.outcomeUnknown).toBe(true);
      expect(text(view)).toContain('could not confirm');
      expect(exposedNames(view.container)).toContain('Send again');
    });
    it('keeps an earlier uncertain publication and key when the retry writer refuses', async () => {
      setPlatform(os);
      const scope = { key: `${backend.userID}|admin|chapter-fixture`, chapterID: 'chapter-fixture', role: 'admin' };
      view = await render(h(NoticeComposer, { scope, onSent: vi.fn() }));
      await settle();
      await type(getExposed(view.container, 'Broadcast title'), 'Earlier publication may exist');
      await type(getExposed(view.container, 'Broadcast message'), 'Keep the first operation identity.');
      backend.loseNextReply = true;
      await press(getExposed(view.container, 'Send notice')); await settle();
      const owner = `${backend.userID}|chapter-fixture`;
      const key = readPendingNoticeSend(owner)?.attempt?.operationKey;
      backend.writerRefused = true;
      await press(getExposed(view.container, 'Send again')); await settle();
      expect(publishes()).toHaveLength(1);
      expect(readPendingNoticeSend(owner)?.outcomeUnknown).toBe(true);
      expect(readPendingNoticeSend(owner)?.attempt?.operationKey).toBe(key);
      expect(text(view)).toContain('could not confirm');
    });
    it('shows one accepted receipt when a different hat cannot reach its audience', async () => {
      setPlatform(os);
      const scope = { key: `${backend.userID}|admin|chapter-fixture`, chapterID: 'chapter-fixture', role: 'admin' };
      view = await render(h(NoticeComposer, { scope, onSent: vi.fn() }));
      await settle();
      await type(getExposed(view.container, 'Broadcast title'), 'Accepted for the original audience');
      await type(getExposed(view.container, 'Broadcast message'), 'Keep one acknowledgement.');
      backend.proof = 'unavailable';
      await press(getExposed(view.container, 'Send notice')); await settle();
      backend.officeNotices = false; backend.role = 'vp';
      await view.rerender(h(NoticeComposer, { scope: { ...scope, key: `${backend.userID}|vp|chapter-fixture`, role: 'vp' }, onSent: vi.fn() }));
      await settle();
      expect(exposedNames(view.container)).toContain('Show notice message');
      expect(text(view).split('Notice sent. Refresh to see it in the list.').length - 1).toBe(1);
    });
  });
  it.each<'ios' | 'android'>(['ios', 'android'])('keeps the accepted receipt and exact send key across a remount with unavailable proof on %s', async (os) => {
    setPlatform(os);
    const firstSent = vi.fn(); const remountedSent = vi.fn();
    const scope = { key: `${backend.userID}|admin|chapter-fixture`, chapterID: 'chapter-fixture', role: 'admin' };
    view = await render(h(NoticeComposer, { scope, onSent: firstSent }));
    await settle();
    await type(getExposed(view.container, 'Broadcast title'), 'Accepted before leaving');
    await type(getExposed(view.container, 'Broadcast message'), 'Keep this exact operation while checking.');
    backend.proof = 'unavailable';
    await press(getExposed(view.container, 'Send notice')); await settle();
    const owner = `${backend.userID}|chapter-fixture`;
    const operationKey = publishes()[0]?.args.p_idempotency_key;
    expect(readPendingNoticeSend(owner)?.attempt?.operationKey).toBe(operationKey);
    expect(readPendingNoticeSend(owner)?.confirmed).toBe(true);
    await view.unmount();
    view = await render(h(NoticeComposer, { scope, onSent: remountedSent }));
    await settle();
    expect(text(view)).toContain('Notice sent. Refresh to see it in the list.');
    expect(text(view).split('Notice sent. Refresh to see it in the list.').length - 1).toBe(1);
    expect(exposedNames(view.container)).not.toContain('Send again');
    expect((getExposed(view.container, 'Broadcast title') as HTMLInputElement).value).toBe('Accepted before leaving');
    await press(getExposed(view.container, 'Check the notices you sent')); await settle();
    expect(remountedSent).not.toHaveBeenCalled();
    expect(readPendingNoticeSend(owner)?.attempt?.operationKey).toBe(operationKey);
    backend.proof = 'current';
    await press(getExposed(view.container, 'Check the notices you sent')); await settle();
    expect(remountedSent).toHaveBeenCalledOnce(); expect(firstSent).not.toHaveBeenCalled();
    expect(readPendingNoticeSend(owner)).toBeNull(); expect(publishes()).toHaveLength(1);
  });
  it('delta P3-6: checking an unconfirmed attempt names unavailable proof without rereading or sending', async () => {
    const onSent = vi.fn();
    view = await render(h(NoticeComposer, { scope: { key: 'officer|admin|chapter-fixture', chapterID: 'chapter-fixture', role: 'admin' }, onSent }));
    await settle();
    await type(getExposed(view.container, 'Broadcast title'), 'Unconfirmed notice');
    await type(getExposed(view.container, 'Broadcast message'), 'Keep the exact original operation.');
    backend.loseNextReply = true;
    await press(getExposed(view.container, 'Send notice')); await settle();
    backend.proof = 'unavailable';
    await press(getExposed(view.container, 'Check the notices you sent')); await settle();
    expect(text(view)).toContain('The notices could not be checked. Try again when your connection is available.');
    expect(onSent).not.toHaveBeenCalled(); expect(publishes()).toHaveLength(1);
    expect(exposedNames(view.container)).toContain('Send again');
  });
  it('r1s3: retains the accepted notice and operation key until a guarded read-only refresh', async () => {
    const onSent = vi.fn();
    view = await render(h(NoticeComposer, { scope: { key: 'officer|admin|chapter-fixture', chapterID: 'chapter-fixture', role: 'admin' }, onSent }));
    await settle();
    await type(getExposed(view.container, 'Broadcast title'), 'Accepted notice');
    await type(getExposed(view.container, 'Broadcast message'), 'Do not post this notice twice.');
    backend.proof = 'unavailable';
    await press(getExposed(view.container, 'Send notice')); await settle();
    expect(text(view)).toContain('Notice sent. Refresh to see it in the list.');
    expect(publishes()).toHaveLength(1); expect(onSent).not.toHaveBeenCalled();
    expect(exposedNames(view.container)).not.toContain('Send again');
    await press(getExposed(view.container, 'Check the notices you sent')); await settle();
    expect(onSent).not.toHaveBeenCalled(); expect(publishes()).toHaveLength(1);
    backend.proof = 'current';
    await press(getExposed(view.container, 'Check the notices you sent')); await settle();
    expect(onSent).toHaveBeenCalledOnce(); expect(publishes()).toHaveLength(1);
  });
  it('sends to the granted campaign audience and tells its screen', async () => {
    const onSent = vi.fn();
    view = await render(h(NoticeComposer, { scope: { key: 'officer|admin|chapter-fixture', chapterID: 'chapter-fixture', role: 'admin' }, onSent }));
    await settle();
    await type(getExposed(view.container, 'Broadcast title'), 'Office closed Friday');
    await type(getExposed(view.container, 'Broadcast message'), 'The union office reopens Monday.');
    await press(getExposed(view.container, 'Send notice'));
    await settle();
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(publishes()).toHaveLength(1);
    expect(backend.notices[0]?.title).toBe('Office closed Friday');
  });
});

describe('who reaches Campaign notices', () => {
  it('is on the Campaign Administrator and Campaign chair lists and opens only for those hats', () => {
    expect(STAFF_HAT_FUNCTIONS.admin.some((row) => row.href === '/feature/chapter-notices')).toBe(true);
    expect(STAFF_HAT_FUNCTIONS.vp.some((row) => row.href === '/feature/chapter-notices')).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-notices', null, ['admin'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-notices', null, [], ['vp'])).toBe(true);
    expect(canOpenFeature('authenticated', 'chapter-notices', null, ['steward'])).toBe(false);
    expect(canOpenFeature('authenticated', 'chapter-notices', null, ['advisor'])).toBe(false);
    expect(canOpenFeature('authenticated', 'chapter-notices', null, [])).toBe(false);
    expect(canOpenFeature('preview', 'chapter-notices', null, ['admin'])).toBe(false);
    expect(canOpenFeature('preview', 'chapter-notices', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'chapter-notices', 'vp')).toBe(true);
    expect(canOpenFeature('preview', 'chapter-invitations', 'member')).toBe(false);
  });
});

// #9258: a committed notice outlives the route that started it. The same
// shared composer serves Chapter notices and Steward desk Broadcasts.
describe.each<'ios' | 'android'>(['ios', 'android'])('leaving a notice send on %s', (os) => {
  function holdReply(lost = true) {
    let release!: () => void;
    backend.reply = new Promise<void>((resolve) => { release = resolve; });
    backend.loseNextReply = lost;
    return async () => { await act(async () => release()); await settle(); };
  }
  async function composer() {
    view = await render(h(StewardDeskSectionsScreen, { featureKey: 'steward-broadcasts' }));
    await settle(); return view;
  }
  async function leave() { await view!.unmount(); view = null; }
  async function draft(screen: Rendered) {
    await type(getExposed(screen.container, 'Broadcast title'), 'A notice in flight');
    await type(getExposed(screen.container, 'Broadcast message'), 'Only one copy should reach workers.');
  }
  it('notifies success once when two same-owner composers observe one confirmed reply', async () => {
    setPlatform(os);
    const onFirst = vi.fn(), onSecond = vi.fn();
    const scope = { key: `${backend.userID}|admin|chapter-fixture`, chapterID: 'chapter-fixture', role: 'admin' };
    view = await render(h('div', null,
      h(NoticeComposer, { scope, onSent: onFirst }),
      h(NoticeComposer, { scope, onSent: onSecond })));
    await settle(); await draft(view);
    const release = holdReply(false);
    await press(getExposed(view.container, 'Send notice')); await settle();
    await release();
    expect(onFirst.mock.calls.length + onSecond.mock.calls.length).toBe(1);
    for (const field of view.container.querySelectorAll<HTMLInputElement>('[aria-label="Broadcast title"]')) expect(field.value).toBe('');
    expect(backend.notices).toHaveLength(1);
  });
  it('uses the session owner while the preceding dashboard is still visible', async () => {
    setPlatform(os);
    const first = await open(); await draft(first);
    const release = holdReply();
    await press(getExposed(first.container, 'Send notice')); await settle();
    await leave(); backend.sessionUserID = 'replacement-session';
    const replacement = await open();
    expect((getExposed(replacement.container, 'Broadcast title') as HTMLInputElement).value).toBe('');
    await release();
    expect(text(replacement)).not.toContain('Sending it again will not post it twice.');
    await leave(); backend.sessionUserID = undefined;
    const returned = await open();
    expect(text(returned)).toContain('Sending it again will not post it twice.');
    await press(getExposed(returned.container, 'Send again')); await settle();
    expect(publishes()[1]?.args.p_idempotency_key).toBe(publishes()[0]?.args.p_idempotency_key);
    expect(backend.notices).toHaveLength(1);
  });
  it('does not mint a key when there is no composing session', async () => {
    setPlatform(os);
    backend.sessionUserID = null;
    const screen = await open(); await draft(screen);
    const uuidCount = backend.uuid;
    await press(getExposed(screen.container, 'Send notice')); await settle();
    expect(backend.uuid).toBe(uuidCount);
    expect(publishes()).toHaveLength(0);
  });
  it('gives workers exactly one copy when the person returns and sends the same words', async () => {
    setPlatform(os);
    const first = await open(); await draft(first);
    const release = holdReply();
    await press(getExposed(first.container, 'Send notice')); await settle();
    await leave(); await release();
    const returned = await open();
    // Drive the reported journey even on the broken composer, whose fields
    // are empty: the person writes the same notice and sends it once more.
    if (exposedNames(returned.container).includes('Send again')) {
      await press(getExposed(returned.container, 'Send again'));
    } else {
      await draft(returned); await press(getExposed(returned.container, 'Send notice'));
    }
    await settle();
    expect(backend.notices).toHaveLength(1);
    expect(publishes()).toHaveLength(2);
  });
  it('does not dispatch a key-generation continuation after the account changes', async () => {
    setPlatform(os);
    const first = await open(); await draft(first);
    let release!: () => void;
    backend.keyWait = new Promise<void>((resolve) => { release = resolve; });
    await press(getExposed(first.container, 'Send notice')); await settle();
    const author = backend.userID;
    await leave(); backend.userID = 'replacement';
    const replacement = await open();
    await act(async () => release()); await settle(); backend.keyWait = null;
    expect(publishes()).toHaveLength(0);
    expect((getExposed(replacement.container, 'Broadcast title') as HTMLInputElement).value).toBe('');
    await leave(); backend.userID = author;
    const original = await open();
    expect((getExposed(original.container, 'Broadcast title') as HTMLInputElement).value).toBe('A notice in flight');
    await press(getExposed(original.container, 'Send again')); await settle();
    expect(publishes()).toHaveLength(1);
    expect(backend.notices).toHaveLength(1);
  });
  it.each<'chapter' | 'shared'>(['chapter', 'shared'])('retains the key and reconciles a lost answer after the %s composer remounts', async (entry) => {
    setPlatform(os);
    const enter = entry === 'chapter' ? open : composer;
    const first = await enter(); await draft(first);
    const release = holdReply();
    await press(getExposed(first.container, 'Send notice')); await settle();
    expect(backend.notices).toHaveLength(1);
    await leave();
    const returned = await enter();
    // Returning before the first reply cannot start a competing operation.
    expect((getExposed(returned.container, 'Broadcast title') as HTMLInputElement).value).toBe('A notice in flight');
    await press(getExposed(returned.container, 'Send again'));
    expect(publishes()).toHaveLength(1);
    await release();
    expect(text(returned)).toContain('Sending it again will not post it twice.');
    await press(getExposed(returned.container, 'Send again')); await settle();
    expect(publishes().map((call) => call.args.p_idempotency_key)).toEqual([expect.any(String), publishes()[0]?.args.p_idempotency_key]);
    expect(backend.notices).toHaveLength(1);
    expect((getExposed(returned.container, 'Broadcast title') as HTMLInputElement).value).toBe('');
  });
  it.each([true, false])('reconciles an answer received while absent (lost=%s)', async (lost) => {
    setPlatform(os);
    const first = await open(); await draft(first);
    const release = holdReply(lost);
    await press(getExposed(first.container, 'Send notice')); await settle();
    await leave();
    if (lost) await release();
    const returned = await open();
    if (!lost) {
      // P3-2: the base also returns empty after success; first prove that
      // this mount recovered the still-running draft before its reply.
      expect((getExposed(returned.container, 'Broadcast title') as HTMLInputElement).value).toBe('A notice in flight');
      expect((getExposed(returned.container, 'Broadcast title') as HTMLInputElement).disabled).toBe(true);
      expect(publishes()).toHaveLength(1);
      await release();
    }
    if (lost) {
      expect(text(returned)).toContain('Sending it again will not post it twice.');
      await press(getExposed(returned.container, 'Send again')); await settle();
      expect(publishes()[1]?.args.p_idempotency_key).toBe(publishes()[0]?.args.p_idempotency_key);
    } else {
      expect((getExposed(returned.container, 'Broadcast title') as HTMLInputElement).value).toBe('');
      expect(exposedNames(returned.container)).not.toContain('Send again');
    }
    expect(backend.notices).toHaveLength(1);
  });
  it('conceals another account’s pending notice and never replays its key', async () => {
    setPlatform(os);
    const first = await open(); await draft(first);
    const release = holdReply();
    await press(getExposed(first.container, 'Send notice')); await settle();
    const owner = backend.userID;
    await leave(); backend.userID = 'replacement';
    const replacement = await open();
    expect((getExposed(replacement.container, 'Broadcast title') as HTMLInputElement).value).toBe('');
    expect(text(replacement)).not.toContain('Sending it again will not post it twice.');
    await release();
    expect(publishes()).toHaveLength(1);
    await draft(replacement); await press(getExposed(replacement.container, 'Send notice')); await settle();
    expect(publishes()[1]?.args.p_idempotency_key).not.toBe(publishes()[0]?.args.p_idempotency_key);
    await leave(); backend.userID = owner;
    const original = await open();
    expect(text(original)).toContain('Sending it again will not post it twice.');
    await press(getExposed(original.container, 'Send again')); await settle();
    expect(publishes()[2]?.args.p_idempotency_key).toBe(publishes()[0]?.args.p_idempotency_key);
    expect(backend.notices).toHaveLength(2);
  });
  it('keeps the same account’s pending notice when returning in another granted hat', async () => {
    setPlatform(os);
    const first = await open(); await draft(first);
    const release = holdReply();
    await press(getExposed(first.container, 'Send notice')); await settle();
    await leave(); backend.role = 'vp'; await release();
    const returned = await open();
    expect(text(returned)).toContain('Sending it again will not post it twice.');
    await press(getExposed(returned.container, 'Send again')); await settle();
    expect(publishes()[1]?.args.p_idempotency_key).toBe(publishes()[0]?.args.p_idempotency_key);
    expect(backend.notices).toHaveLength(1);
  });
  it('restores the original unit audience, never the first newly loaded option', async () => {
    setPlatform(os);
    backend.unscoped = false;
    backend.scopes = [{ name: 'Unit A', unitId: 'unit-a' }, { name: 'Unit B', unitId: 'unit-b' }];
    const first = await open(); await draft(first);
    await press(getExposed(first.container, 'Unit: Unit B'));
    const release = holdReply();
    await press(getExposed(first.container, 'Send unit notice')); await settle();
    await leave(); await release();
    const returned = await open();
    await press(getExposed(returned.container, 'Send again')); await settle();
    expect(publishes().map((call) => call.args.p_unit)).toEqual(['unit-b', 'unit-b']);
    expect(backend.notices).toHaveLength(1);
  });
});


describe('pending notice ticket ownership', () => {
  const work: { title: string; body: string; locale: 'en'; postingRole: string } = { title: 'A notice', body: 'One copy', locale: 'en', postingRole: 'admin' };
  const login = { userID: 'ticket-fixture', isCurrent: () => true };
  const audience: Parameters<typeof beginNoticeSend>[2] = { value: 'chapter', kind: 'chapter', chapterId: 'chapter-fixture', name: '' };
  it('a stale ticket cannot delete a newer pending send', () => {
    const owner = `${backend.userID}|chapter-fixture`;
    const old = beginNoticeSend(owner, work, audience, null, login)!;
    updateNoticeSend(old, { busy: false });
    expect(forgetNoticeSend(owner, old.ticket, true)).toBe(true);
    const current = beginNoticeSend(owner, work, audience, null, login)!;
    const removed = forgetNoticeSend(owner, old.ticket);
    // Assert retention, not just the helper's return value: the busy new
    // operation must still exclude a competing claim after stale cleanup.
    expect(beginNoticeSend(owner, work, audience, null, login)).toBeNull();
    expect(removed).toBe(false);
    expect(forgetNoticeSend(owner, current.ticket)).toBe(true);
    expect(forgetNoticeSend(owner, current.ticket)).toBe(false);
  });
  it('refuses an empty composing owner', () => {
    expect(beginNoticeSend('', work, audience, null, login)).toBeNull();
  });
  it('9258S N1: a null organization projection does not prove departure from the held organization', () => {
    const owner = `${backend.userID}|chapter-fixture`;
    const held = beginNoticeSend(owner, { ...work, organizationID: 'org-fixture' }, audience, null, login)!;
    expect(retireDepartedNoticeSends(login.userID, [{ chapterID: audience.chapterId, organizationID: null }])).toEqual([]);
    expect(readPendingNoticeSend(owner)).toBe(held);
    expect(retireDepartedNoticeSends(login.userID, [{ chapterID: audience.chapterId, organizationID: 'other-org' }])).toEqual([audience.chapterId]);
    expect(readPendingNoticeSend(owner)).toBeNull();
  });
  it('T11 refuses a new operation while an unknown send exists and preserves the held request on a same-key retry', () => {
    const owner = `${backend.userID}|chapter-fixture`;
    const attempt = { ...work, operationKey: 'original-operation' };
    const held = beginNoticeSend(owner, work, audience, attempt, login)!;
    updateNoticeSend(held, { busy: false });
    expect(beginNoticeSend(owner, work, audience, { ...attempt, operationKey: 'different-operation' }, login)).toBeNull();
    expect(beginNoticeSend(owner, work, audience, null, login)).toBeNull();
    const retry = beginNoticeSend(owner, { ...work, title: 'Must not replace payload' }, { ...audience, name: 'Different view' }, attempt, login)!;
    expect(retry.audience).toBe(audience); expect(retry.title).toBe(work.title);
    expect(forgetNoticeSend(owner, held.ticket)).toBe(false);
    expect(forgetNoticeSend(owner, retry.ticket, true)).toBe(true);
  });
  it('C356 B: an unknown outcome is its own fact, not the possession of a key, and survives a same-key retry', () => {
    const owner = `${backend.userID}|chapter-fixture`;
    const attempt = { ...work, operationKey: 'kept-operation' };
    const held = beginNoticeSend(owner, work, audience, null, login)!;
    expect(held.outcomeUnknown).toBe(false);
    updateNoticeSend(held, { attempt, busy: false });
    expect(readPendingNoticeSend(owner)?.attempt).toBe(attempt);
    expect(readPendingNoticeSend(owner)?.outcomeUnknown).toBe(false);
    const dispatched = beginNoticeSend(owner, work, audience, attempt, login)!;
    expect(dispatched.outcomeUnknown).toBe(false);
    updateNoticeSend(dispatched, { outcomeUnknown: true });
    updateNoticeSend(dispatched, { busy: false });
    const retry = beginNoticeSend(owner, work, audience, attempt, login)!;
    expect(retry.outcomeUnknown).toBe(true);
    expect(forgetNoticeSend(owner, retry.ticket, true)).toBe(true);
  });
  it('requires the original login to read, confirm, retry or consume a ticket', () => {
    const owner = `${backend.userID}|chapter-fixture`;
    let originalLogin = true;
    const oldLogin = { userID: backend.userID, isCurrent: () => originalLogin };
    const old = beginNoticeSend(owner, work, audience, null, oldLogin)!;
    originalLogin = false;
    updateNoticeSend(old, { confirmed: true, busy: false });
    expect(readPendingNoticeSend(owner)).toBeNull();
    expect(noticeSendIsCurrent(old)).toBe(false);
    expect(forgetNoticeSend(owner, old.ticket)).toBe(false);
    expect(beginNoticeSend(owner, work, audience, null, oldLogin)).toBeNull();
    const current = beginNoticeSend(owner, work, audience, null, login)!;
    updateNoticeSend(old, { confirmed: true, busy: false });
    updateNoticeSend(old, { error: 'The broadcast was not sent. Try again.', busy: false });
    expect(forgetNoticeSend(owner, old.ticket)).toBe(false);
    expect(readPendingNoticeSend(owner)).toBe(current);
    expect(current.confirmed).toBe(false); expect(current.busy).toBe(true);
    expect(forgetNoticeSend(owner, current.ticket)).toBe(true);
  });
});

// UX-UG-BLOCKED-BUTTON-GIVES-NO-REASON-STAFF-DESKS-20261122 (#9468,
// M2-15): Send stayed grey until both fields were filled, with no word why and
// no visible field names.
const REASON_LANGUAGES: Array<'en' | 'es'> = ['en', 'es'];
describe.each(REASON_LANGUAGES)('a notice held for a missing field, in %s', (language) => {
  it('labels both fields and says, on a press, that a notice needs a title and a message', async () => {
    backend.language = language;
    const t = nativeUiText(language);
    const screen = await open();
    expect(text(screen)).toContain(t('Title'));
    expect(text(screen)).toContain(t('Message'));
    const reason = t('A broadcast needs a title and a message.');
    expect(getExposed(screen.container, t('Send notice')).getAttribute('aria-description')).toBe(reason);
    expect(text(screen)).not.toContain(reason);
    await type(getExposed(screen.container, t('Broadcast title')), 'Contract vote');
    await press(getExposed(screen.container, t('Send notice')));
    await settle();
    expect(text(screen)).toContain(reason);
    expect(publishes()).toHaveLength(0);
    await type(getExposed(screen.container, t('Broadcast message')), 'Polls open at noon.');
    expect(text(screen)).not.toContain(reason);
    await press(getExposed(screen.container, t('Send notice')));
    await settle();
    expect(publishes()).toHaveLength(1);
  });
});
