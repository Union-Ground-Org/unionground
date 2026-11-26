import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { noteResumeDraftReadFailure, syncResumeDraftContext } from '../lib/resumeDraftHolder';
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert, exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { nativeUiText } from '../lib/nativeUiCopy';

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 3 of 4): a president opens Campaigns on the phone, writes a
// vote and a pulse survey, publishes and closes them, with no website. The
// stand-in registry answers the website's own RPCs: get_staff_vote_campaigns
// (with canManageChapter and canManageUnion), save_vote_campaign_draft,
// publish_vote_campaign and close_vote_campaign.

type Row = { id: string; kind: 'ballot' | 'pulse'; state: 'draft' | 'open' | 'closed'; scope: 'chapter' | 'union'; titleEn: string; titleEs: string; bodyEn: string; closesAt: string | null; quorumTarget: number | null; options: unknown[] };

const backend = vi.hoisted(() => ({
  rows: [] as Row[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  canManageChapter: true,
  // #9533: undefined leaves the field out of the answer, as an older server would.
  canManageUnion: false as boolean | undefined,
  failRead: false,
  holdRead: null as Promise<void> | null,
  refuse: null as null | { code: string; message: string },
  // The RPC saves, then its answer is lost on the way back.
  loseNextReply: false,
  language: 'en' as 'en' | 'es',
  memberships: true, // #9459 M1-21
  refresh: vi.fn(async (_reason?: string) => undefined),
}));

function rpc(name: string, args: Record<string, unknown> = {}) {
  backend.calls.push({ name, args });
  if (name === 'get_staff_vote_campaigns') {
    if (backend.failRead) return { data: null, error: { code: '', message: 'TypeError: Network request failed' } };
    const rows = backend.rows.filter((row) => !args.p_state || row.state === args.p_state);
    const count = (state: string) => backend.rows.filter((row) => row.state === state).length;
    return { data: { campaigns: rows, counts: { all: backend.rows.length, draft: count('draft'), open: count('open'), closed: count('closed') }, nextCursor: null, canManageChapter: backend.canManageChapter, ...(backend.canManageUnion === undefined ? {} : { canManageUnion: backend.canManageUnion }) }, error: null };
  }
  if (name === 'save_vote_campaign_draft') {
    if (backend.refuse) return { data: null, error: backend.refuse };
    const id = `${String(args.p_kind)}-${backend.rows.length + 1}`;
    backend.rows.unshift({ id, kind: args.p_kind as Row['kind'], state: 'draft', scope: args.p_scope as Row['scope'], titleEn: String(args.p_title_en), titleEs: String(args.p_title_es), bodyEn: String(args.p_body_en), closesAt: String(args.p_closes_at), quorumTarget: args.p_quorum_target as number | null, options: args.p_options as unknown[] });
    if (backend.loseNextReply) { backend.loseNextReply = false; return { data: null, error: { code: '', message: 'TypeError: Network request failed' } }; }
    return { data: { campaignId: id }, error: null };
  }
  const row = backend.rows.find((item) => item.id === args.p_campaign_id && item.kind === args.p_kind);
  if (name === 'delete_vote_campaign_draft' && row) { backend.rows = backend.rows.filter((item) => item !== row); return { data: { ok: true }, error: null }; }
  if (name === 'publish_vote_campaign' && row && backend.refuse) return { data: null, error: backend.refuse };
  if (name === 'publish_vote_campaign' && row) { row.state = 'open'; return { data: { ok: true }, error: null }; }
  if (name === 'close_vote_campaign' && row) { row.state = 'closed'; return { data: { ok: true }, error: null }; }
  return { data: null, error: { code: 'PGRST202', message: `unexpected ${name}` } };
}

// The survey card, the unit editors (#9240 pull request D), the campaign draft and Be heard (pull request C) import the shared draft hook, whose attempt keys come from expo-crypto.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => undefined), select: vi.fn() } }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../lib/hatFunctions', () => ({ STAFF_HAT_FUNCTIONS: { steward: [] } }));
// The provider syncs the draft holder on every render; an open campaign draft
// is held there (#9240 pull request C).
vi.mock('../state/AppProvider', async () => {
  const { syncResumeDraftContext } = await import('../lib/resumeDraftHolder');
  return { useApp: () => {
    const app = {
      mode: 'authenticated', memberLanguage: backend.language, session: { user: { id: 'president-fixture' } }, organizationID: 'org-fixture',
      dashboard: { member: { id: 'president-fixture', chapterID: 'chapter-fixture', language: backend.language } },
      chapterMemberships: [{ chapterID: 'chapter-fixture', organizationID: 'org-fixture', selected: true }],
      authorizedRoles: ['vp'], chapterRoles: ['vp'], organizationRoles: [], chosenStaffRole: 'vp',
      resumeDraftReads: { dashboard: true, memberships: backend.memberships, staff: true },
      refresh: backend.refresh, refreshing: false,
    };
    syncResumeDraftContext(app);
    return app;
  } };
});
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({ rpc: async (name: string, args?: Record<string, unknown>) => rpc(name, args) }), session?.user?.id ?? 'member-a'),
  getSupabaseClient: () => ({ rpc: async (name: string, args?: Record<string, unknown>) => { if (name === 'get_staff_vote_campaigns' && backend.holdRead) await backend.holdRead; return rpc(name, args); } }),
}));

// LiveFeatureScreens also holds Forms and Casework, which reach native modules.
vi.mock('../services/attachments', () => ({ pickAuthorizedDocument: vi.fn() }));
vi.mock('../services/privateFileAccess', () => ({ PrivateFileError: class extends Error {}, requestPrivateFileInspection: vi.fn(), downloadPrivateObjectToFile: vi.fn(), privateFileApiOrigin: () => 'https://sample.unionground.example' }));
vi.mock('../components/SignaturePad', () => ({ SignaturePad: () => null }));
vi.mock('../services/unitSettings', () => ({ loadNativeUnitSettings: vi.fn(), loadNativeUnitEditor: vi.fn(), saveNativeUnitWorkload: vi.fn(), saveNativeUnitOverrides: vi.fn(), saveNativeChapterUnitSettings: vi.fn() }));

import { LiveCampaignsScreen } from './LiveFeatureScreens';
import { CampaignDraftCard } from './CampaignDraftCard';
import { normalizeCampaignRegistryPage } from '../services/campaignRegistry';

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const text = (view: Rendered) => view.container.textContent ?? '';
const saves = () => backend.calls.filter((call) => call.name === 'save_vote_campaign_draft');

let view: Rendered | null = null;

async function open(): Promise<Rendered> {
  view = await render(h(LiveCampaignsScreen));
  await settle();
  return view;
}

async function writeDraft(screen: Rendered, kind: 'Vote' | 'Pulse survey', title: string, choices: string[]) {
  await press(getExposed(screen.container, 'Write a draft'));
  await press(getExposed(screen.container, kind));
  await type(getExposed(screen.container, 'Title in English'), title);
  for (const [index, label] of choices.entries()) {
    if (index >= 2) await press(getExposed(screen.container, 'Add a choice'));
    await type(getExposed(screen.container, `Choice ${index + 1}`), label);
  }
  await press(getExposed(screen.container, 'Save draft'));
  await settle();
}

beforeEach(() => {
  backend.rows = [];
  backend.calls = [];
  backend.canManageChapter = true;
  backend.canManageUnion = false;
  backend.failRead = false;
  backend.holdRead = null;
  backend.refuse = null;
  backend.loseNextReply = false;
  backend.language = 'en';
  backend.memberships = true;
  backend.refresh.mockClear();
  // Confirm every publish and close the way the person would.
  vi.spyOn(Alert, 'alert').mockImplementation((...args: unknown[]) => {
    const buttons: unknown = args[2];
    if (!Array.isArray(buttons)) return;
    const last: unknown = buttons[buttons.length - 1];
    const onPress: unknown = typeof last === 'object' && last !== null ? Reflect.get(last, 'onPress') : null;
    if (typeof onPress === 'function') onPress();
  });
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.restoreAllMocks();
  setPlatform('ios');
  // Held drafts live in the module-level draft holder: no test inherits another's.
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
});

describe.each(['ios', 'android'] as const)('a campaign chair runs a vote and a pulse survey on %s', (os) => {
  it('drafts, publishes and closes a vote', async () => {
    setPlatform(os);
    const screen = await open();
    expect(text(screen)).not.toContain('on the website');
    await writeDraft(screen, 'Vote', 'Ratify the tentative agreement', ['Yes', 'No']);

    expect(saves().map((call) => call.args)).toEqual([expect.objectContaining({
      p_kind: 'ballot', p_campaign_id: null, p_scope: 'chapter', p_title_en: 'Ratify the tentative agreement', p_title_es: 'Ratify the tentative agreement',
      p_quorum_target: 1, p_body_en: '', p_body_es: '', p_options: [{ labelEn: 'Yes', labelEs: 'Yes' }, { labelEn: 'No', labelEs: 'No' }],
    })]);
    expect(text(screen)).toContain('Draft saved. Publish it from the list when it is ready.');
    expect(backend.rows[0]?.state).toBe('draft');

    await press(getExposed(screen.container, 'Publish Ratify the tentative agreement'));
    await settle();
    expect(backend.rows[0]?.state).toBe('open');
    await press(getExposed(screen.container, 'Close Ratify the tentative agreement'));
    await settle();
    expect(backend.rows[0]?.state).toBe('closed');
  });

  it('drafts, publishes and closes a pulse survey with three choices and no quorum', async () => {
    setPlatform(os);
    const screen = await open();
    await writeDraft(screen, 'Pulse survey', 'How safe do you feel on the night shift?', ['Safe', 'Unsure', 'Unsafe']);
    expect(saves()[0]?.args).toMatchObject({ p_kind: 'pulse', p_quorum_target: null, p_options: [{ labelEn: 'Safe', labelEs: 'Safe' }, { labelEn: 'Unsure', labelEs: 'Unsure' }, { labelEn: 'Unsafe', labelEs: 'Unsafe' }] });
    await press(getExposed(screen.container, 'Publish How safe do you feel on the night shift?'));
    await settle();
    await press(getExposed(screen.container, 'Close How safe do you feel on the night shift?'));
    await settle();
    expect(backend.rows.map((row) => [row.kind, row.state])).toEqual([['pulse', 'closed']]);
  });

  it('names a missing choice label and sends nothing', async () => {
    setPlatform(os);
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Contract vote', ['Yes']);
    expect(text(screen)).toContain('Give every choice a label, with 2 to 20 choices.');
    expect(saves()).toHaveLength(0);
  });
});

// The save rules parts 1 and 2 ended with: a save with no answer keeps the
// draft locked and unconfirmed; nothing in the list counts as proof it saved.
describe.each<'ios' | 'android'>(['ios', 'android'])('a draft whose save was not confirmed, on %s', (os) => {
  const unconfirmed = 'We could not confirm this draft was saved. Check the campaign list first: saving it again may make a second draft.';
  const field = (screen: Rendered, label: string) => getExposed(screen.container, label) as HTMLInputElement;
  const registryReads = () => backend.calls.filter((call) => call.name === 'get_staff_vote_campaigns').length;

  it('keeps the draft open, locked and unconfirmed although the list now shows the same draft', async () => {
    setPlatform(os);
    backend.loseNextReply = true;
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Ratify the tentative agreement', ['Yes', 'No']);
    expect(text(screen)).toContain(unconfirmed);
    expect(backend.rows).toHaveLength(1);
    expect(field(screen, 'Title in English').disabled).toBe(true);
    await type(field(screen, 'Title in English'), 'Edited title');
    await press(getExposed(screen.container, 'Pulse survey'));
    expect(field(screen, 'Title in English').value).toBe('Ratify the tentative agreement');
    expect(exposedNames(screen.container)).toEqual(expect.arrayContaining(['Check the campaign list', 'Save again', 'Cancel']));
    const before = registryReads();
    await press(getExposed(screen.container, 'Check the campaign list'));
    await settle();
    expect(registryReads()).toBe(before + 1);
    // The saved row is in the list, and the draft is still kept, unconfirmed.
    expect(exposedNames(screen.container)).toContain('Publish Ratify the tentative agreement');
    expect(field(screen, 'Title in English').value).toBe('Ratify the tentative agreement');
    expect(text(screen)).toContain(unconfirmed);
  });

  it('saves again only when asked, with the same content, and closes once that save succeeds', async () => {
    setPlatform(os);
    backend.refuse = { code: '', message: 'TypeError: Network request failed' };
    const screen = await open();
    await writeDraft(screen, 'Pulse survey', 'Break room survey', ['Better', 'Same']);
    expect(text(screen)).toContain(unconfirmed);
    expect(backend.rows).toHaveLength(0);
    backend.refuse = null;
    await press(getExposed(screen.container, 'Save again'));
    await settle();
    const [first, again] = saves().map((call) => call.args);
    expect(again).toEqual(first);
    expect(backend.rows).toHaveLength(1);
    expect(text(screen)).toContain('Draft saved. Publish it from the list when it is ready.');
    expect(exposedNames(screen.container)).not.toContain('Save again');
  });

  it('stays unconfirmed when saving again gets no answer either', async () => {
    setPlatform(os);
    backend.refuse = { code: '', message: 'TypeError: Network request failed' };
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Contract vote', ['Yes', 'No']);
    await press(getExposed(screen.container, 'Save again'));
    await settle();
    expect(text(screen)).toContain(unconfirmed);
    expect(field(screen, 'Title in English').value).toBe('Contract vote');
  });

  it('cancels an unconfirmed draft, and the next draft starts unlocked', async () => {
    setPlatform(os);
    backend.loseNextReply = true;
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Contract vote', ['Yes', 'No']);
    await press(getExposed(screen.container, 'Cancel'));
    await press(getExposed(screen.container, 'Write a draft'));
    expect(field(screen, 'Title in English').disabled).toBe(false);
    expect(field(screen, 'Title in English').value).toBe('');
    expect(text(screen)).not.toContain(unconfirmed);
  });

  // R-9224 R1: a refreshed registry that withdraws the draft's audience no
  // longer removes the open, unconfirmed draft.
  it('keeps an unconfirmed draft through Check when authority is withdrawn, then lets it be saved again when authority returns', async () => {
    setPlatform(os);
    backend.loseNextReply = true;
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Ratify the tentative agreement', ['Yes', 'No']);
    expect(text(screen)).toContain(unconfirmed);
    const permission = 'Your permission to write campaigns for this audience changed, so this draft cannot be saved here.';
    backend.canManageChapter = false;
    await press(getExposed(screen.container, 'Check the campaign list'));
    await settle();
    // Still mounted, read only, with its uncertainty line, Check and Cancel.
    expect(field(screen, 'Title in English').value).toBe('Ratify the tentative agreement');
    expect(field(screen, 'Title in English').disabled).toBe(true);
    expect(text(screen)).toContain(unconfirmed);
    expect(text(screen)).toContain(permission);
    expect(exposedNames(screen.container)).toEqual(expect.arrayContaining(['Check the campaign list', 'Cancel']));
    expect(exposedNames(screen.container)).not.toContain('Save again');
    // Authority comes back: Save again returns, with the same text.
    backend.canManageChapter = true;
    await press(getExposed(screen.container, 'Check the campaign list'));
    await settle();
    expect(text(screen)).not.toContain(permission);
    expect(exposedNames(screen.container)).toContain('Save again');
    expect(field(screen, 'Title in English').value).toBe('Ratify the tentative agreement');
    await press(getExposed(screen.container, 'Save again'));
    await settle();
    expect(saves()).toHaveLength(2);
    expect(saves()[1]?.args).toEqual(saves()[0]?.args);
  });

  it('cancels a draft whose authority was withdrawn, and then offers no new draft', async () => {
    setPlatform(os);
    backend.loseNextReply = true;
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Contract vote', ['Yes', 'No']);
    backend.canManageChapter = false;
    await press(getExposed(screen.container, 'Check the campaign list'));
    await settle();
    await press(getExposed(screen.container, 'Cancel'));
    await settle();
    expect(exposedNames(screen.container)).not.toContain('Write a draft');
    expect(text(screen)).not.toContain(unconfirmed);
  });

  it('keeps the draft editable after a refusal the server answered', async () => {
    setPlatform(os);
    backend.refuse = { code: '42501', message: 'campaign scope unavailable' };
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Contract vote', ['Yes', 'No']);
    expect(text(screen)).toContain('This account cannot write a campaign for that audience.');
    expect(field(screen, 'Title in English').disabled).toBe(false);
    expect(exposedNames(screen.container)).not.toContain('Save again');
  });
});

describe('who may write a draft', () => {
  it('offers no draft form when the registry allows no scope', async () => {
    backend.canManageChapter = false;
    const screen = await open();
    expect(exposedNames(screen.container)).not.toContain('Write a draft');
  });

  it('offers a choice of audience when both scopes are allowed, and sends the one chosen', async () => {
    backend.canManageUnion = true;
    const screen = await open();
    await press(getExposed(screen.container, 'Write a draft'));
    await press(getExposed(screen.container, 'Whole union'));
    await type(getExposed(screen.container, 'Title in English'), 'Union-wide strike vote');
    await type(getExposed(screen.container, 'Choice 1'), 'Yes');
    await type(getExposed(screen.container, 'Choice 2'), 'No');
    await press(getExposed(screen.container, 'Save draft'));
    await settle();
    expect(saves()[0]?.args.p_scope).toBe('union');
  });

  it('says plainly when the server refuses the audience', async () => {
    backend.refuse = { code: '42501', message: 'campaign scope unavailable' };
    const screen = await open();
    await writeDraft(screen, 'Vote', 'Contract vote', ['Yes', 'No']);
    expect(text(screen)).toContain('This account cannot write a campaign for that audience.');
    expect(backend.rows).toHaveLength(0);
  });

  it('reads in Spanish', async () => {
    backend.language = 'es';
    const screen = await open();
    const t = nativeUiText('es');
    expect(screen.container.querySelector('[role="heading"]')?.textContent).toBe(t('Campaigns'));
    // R-9224 A2: the screen's own lines are translated too.
    expect(text(screen)).toContain(t('Write a vote or pulse draft here, then publish it with clear eligibility and close it explicitly. To change a draft, delete it and write it again.'));
    expect(t('A draft you write appears here, ready to publish.')).not.toBe('A draft you write appears here, ready to publish.');
    expect(t('Write a draft')).not.toBe('Write a draft');
    await press(getExposed(screen.container, t('Write a draft')));
    getExposed(screen.container, t('Title in English'));
    getExposed(screen.container, t('Save draft'));
  });
});

// #9533 (B-43), the phone twin of the website's pull request #9786: the
// organization's ballots and pulses are left out of a chapter steward's
// registry (private.can_manage_vote_scope refuses that scope), so Open read 0
// while members saw six open ballots. The screen now says where they are run
// and where members find them, only when the registry answered
// canManageUnion: false.
describe('where organization-wide votes are run', () => {
  const elsewhere = 'Votes and pulses for the whole organization are run by an organization-wide Admin or Campaign chair, so they are not listed here. Workers find the votes under Votes.';
  const elsewhereEs = 'Las votaciones y los sondeos de toda la organización los organiza un Administrador o Presidente de alcance sindical. Por eso no aparecen aquí. Los afiliados encuentran las votaciones en Votaciones.';
  const steward = () => { backend.canManageChapter = false; backend.canManageUnion = false; };

  it.each<'ios' | 'android'>(['ios', 'android'])('tells a campaign committee member on %s, with no draft form', async (os) => {
    setPlatform(os);
    steward();
    const screen = await open();
    expect(text(screen)).toContain(elsewhere);
    expect(exposedNames(screen.container)).not.toContain('Write a draft');
  });

  it('tells a campaign chair who manages only the campaign, beside the draft form', async () => {
    const screen = await open();
    expect(text(screen)).toContain(elsewhere);
    expect(exposedNames(screen.container)).toContain('Write a draft');
  });

  it('reads in Spanish, with the phone\'s own name for the voting screen', async () => {
    steward();
    backend.language = 'es';
    const screen = await open();
    const t = nativeUiText('es');
    expect(t(elsewhere)).toBe(elsewhereEs);
    expect(elsewhereEs).toContain(t('Votes'));
    expect(text(screen)).toContain(elsewhereEs);
    expect(text(screen)).not.toContain(elsewhere);
  });

  it('says nothing to an account that manages the whole organization', async () => {
    backend.canManageUnion = true;
    const screen = await open();
    expect(text(screen)).not.toContain(elsewhere);
  });

  it('says nothing when the answer does not carry the field', async () => {
    backend.canManageChapter = false;
    backend.canManageUnion = undefined;
    const screen = await open();
    expect(text(screen)).toContain('No campaigns yet');
    expect(text(screen)).not.toContain(elsewhere);
  });

  it('says nothing while the registry is loading', async () => {
    steward();
    let release = () => {};
    backend.holdRead = new Promise<void>((resolve) => { release = resolve; });
    const screen = await open();
    expect(text(screen)).toContain('Loading campaigns');
    expect(text(screen)).not.toContain(elsewhere);
    backend.holdRead = null;
    release();
    await settle();
    expect(text(screen)).toContain(elsewhere);
  });

  it('says nothing when the registry read fails', async () => {
    steward();
    backend.failRead = true;
    const screen = await open();
    expect(text(screen)).toContain('Campaigns unavailable');
    expect(text(screen)).not.toContain(elsewhere);
  });

  it('keeps only an explicit false in the page the screen reads', () => {
    const page = (extra: Record<string, unknown>) => normalizeCampaignRegistryPage({ campaigns: [], counts: {}, nextCursor: null, ...extra });
    expect(page({ canManageUnion: false })).toMatchObject({ canManageUnion: false, organizationVotesElsewhere: true });
    expect(page({ canManageUnion: true })).toMatchObject({ canManageUnion: true, organizationVotesElsewhere: false });
    expect(page({})).toMatchObject({ canManageUnion: false, organizationVotesElsewhere: false });
    expect(page({ canManageUnion: null })).toMatchObject({ canManageUnion: false, organizationVotesElsewhere: false });
    expect(page({ canManageUnion: 'false' })).toMatchObject({ canManageUnion: false, organizationVotesElsewhere: false });
  });
});

describe('the draft form on its own', () => {
  it('saves a pulse draft and tells its screen', async () => {
    const onSaved = vi.fn();
    view = await render(h(CampaignDraftCard, { canManageChapter: true, canManageUnion: false, onSaved }));
    await settle();
    await writeDraft(view, 'Pulse survey', 'Break room survey', ['Better', 'Same']);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(saves()).toHaveLength(1);
  });
});

// Ledger 527: both platform screens use the real registry service and its RPC error.
describe.each<'ios' | 'android'>(['ios', 'android'])('expired campaign drafts on %s', (os) => {
  const now = Date.parse('2030-01-01T12:00:00Z');
  const reason = {
    en: 'The close date has passed. Change it before publishing.',
    es: 'La fecha de cierre ya pasó. Cámbiela antes de publicar.',
  };
  function draftRow(kind: Row['kind'], closesAt: number | null): Row {
    return { id: 'expired-draft', kind, state: 'draft', scope: 'chapter', titleEn: 'Shift vote', titleEs: 'Votación del turno', bodyEn: '', closesAt: closesAt === null ? null : new Date(closesAt).toISOString(), quorumTarget: kind === 'ballot' ? 1 : null, options: [{}, {}] };
  }
  const languages: readonly ('en' | 'es')[] = ['en', 'es'];
  const kinds: readonly Row['kind'][] = ['ballot', 'pulse'];
  for (const language of languages) for (const kind of kinds) {
    it(`explains an expired ${kind} in ${language}, without offering Publish`, async () => {
      setPlatform(os);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      backend.language = language;
      backend.rows = [draftRow(kind, now - 6 * 60000)];
      const screen = await open();
      expect(text(screen)).toContain(reason[language]);
      expect(exposedNames(screen.container)).not.toContain('Publish Shift vote');
      expect(exposedNames(screen.container)).toContain('Delete draft Shift vote');
      expect(backend.calls.filter((call) => call.name === 'publish_vote_campaign')).toHaveLength(0);
    });

    it(`shows the same ${language} reason if ${kind} expires during confirmation`, async () => {
      setPlatform(os);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      backend.language = language;
      backend.rows = [draftRow(kind, now + 60000)];
      backend.refuse = { code: '22023', message: 'campaign is not ready to publish' };
      // The date passes after the list rendered and before the person confirms.
      vi.mocked(Alert.alert).mockImplementation((...args: unknown[]) => {
        clock.mockReturnValue(now + 60001);
        const buttons: unknown = args[2];
        if (!Array.isArray(buttons)) throw new Error('Confirmation buttons missing');
        const confirm: unknown = Reflect.get(buttons[buttons.length - 1] as object, 'onPress');
        if (typeof confirm !== 'function') throw new Error('Confirmation handler missing');
        confirm();
      });
      const screen = await open();
      await press(getExposed(screen.container, 'Publish Shift vote'));
      await settle();
      expect(text(screen)).toContain(reason[language]);
      expect(text(screen)).not.toContain('The campaign did not change. Refresh and try again.');
      expect(exposedNames(screen.container)).toContain('Publish Shift vote');
      expect(text(screen).split(reason[language])).toHaveLength(2);
      expect(backend.rows[0]?.state).toBe('draft');
      expect(backend.calls.filter((call) => call.name === 'publish_vote_campaign')).toEqual([{ name: 'publish_vote_campaign', args: { p_kind: kind, p_campaign_id: 'expired-draft' } }]);
    });
    it.each<[string, number | null, boolean]>([
      ['two minutes past', now - 2 * 60000, true],
      ['six minutes past', now - 6 * 60000, false],
      ['two minutes before', now + 2 * 60000, true],
      ['null close time', null, true],
    ])(`keeps the server in charge for ${kind} in ${language}: %s`, async (label, closesAt, publishable) => {
      setPlatform(os);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      backend.language = language;
      backend.rows = [draftRow(kind, closesAt)];
      backend.refuse = { code: '22023', message: 'campaign is not ready to publish' };
      const screen = await open();
      if (publishable) {
        expect(exposedNames(screen.container)).toContain('Publish Shift vote');
        expect(text(screen)).not.toContain(reason[language]);
      } else {
        expect(exposedNames(screen.container)).not.toContain('Publish Shift vote');
        expect(text(screen)).toContain(reason[language]);
      }
      if (label === 'two minutes past') {
        await press(getExposed(screen.container, 'Publish Shift vote'));
        await settle();
        expect(text(screen)).toContain(reason[language]);
        expect(text(screen).split(reason[language])).toHaveLength(2);
        expect(exposedNames(screen.container)).toContain('Publish Shift vote');
        expect(backend.calls.filter((call) => call.name === 'publish_vote_campaign')).toEqual([{ name: 'publish_vote_campaign', args: { p_kind: kind, p_campaign_id: 'expired-draft' } }]);
      } else expect(backend.calls.filter((call) => call.name === 'publish_vote_campaign')).toHaveLength(0);
    });
  }

  it('lets a person replace an expired draft with a future one and publish it', async () => {
    setPlatform(os);
    // The existing writer uses the real clock; keep the list on that same clock.
    backend.rows = [draftRow('ballot', Date.now() - 6 * 60000)];
    const screen = await open();
    expect(text(screen)).toContain(reason.en);
    await press(getExposed(screen.container, 'Delete draft Shift vote'));
    await settle();
    await writeDraft(screen, 'Vote', 'New shift vote', ['Yes', 'No']);
    expect(text(screen)).not.toContain(reason.en);
    await press(getExposed(screen.container, 'Publish New shift vote'));
    await settle();
    expect(backend.rows[0]?.state).toBe('open');
  });

  it.each<[string, string, boolean]>([
    ['22023', 'campaign not found', true],
    ['42501', 'campaign is not ready to publish', true],
    ['22023', 'campaign is not ready to publish', false],
    ['', 'Network request failed', true],
  ])('keeps unrelated refusal %s / %s generic (expired: %s)', async (code, message, expires) => {
    setPlatform(os);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    backend.rows = [draftRow('ballot', now + 60000)];
    backend.refuse = { code, message };
    const screen = await open();
    if (expires) clock.mockReturnValue(now + 60001);
    await press(getExposed(screen.container, 'Publish Shift vote'));
    await settle();
    expect(text(screen)).toContain('The campaign did not change. Refresh and try again.');
  });
});

// #9459 M1-21: the card used to vanish without a word after a failed read.
describe('the campaign draft card after a failed session read', () => {
  const FAILED = 'Your saved work could not be checked. Check your connection and try again.';
  it('stays away while the read is out, then says it failed and retries', async () => {
    backend.memberships = false;
    view = await render(h(CampaignDraftCard, { canManageChapter: true, canManageUnion: false, onSaved: vi.fn() }));
    await settle();
    expect(text(view)).not.toContain('New campaign'); expect(text(view)).not.toContain(FAILED);
    noteResumeDraftReadFailure({ status: 0 });
    await view.rerender(h(CampaignDraftCard, { canManageChapter: true, canManageUnion: false, onSaved: vi.fn() })); await settle();
    expect(text(view)).toContain('New campaign'); expect(text(view)).toContain(FAILED);
    expect(exposedNames(view.container)).not.toContain('Write a draft');
    await press(getExposed(view.container, 'Try again'));
    expect(backend.refresh).toHaveBeenCalledWith('user-refresh');
    backend.memberships = true;
    await view.rerender(h(CampaignDraftCard, { canManageChapter: true, canManageUnion: false, onSaved: vi.fn() })); await settle();
    expect(text(view)).not.toContain(FAILED);
    expect(exposedNames(view.container)).toContain('Write a draft');
  });

  it.each<[boolean, string]>([[false, ''], [true, FAILED]])('tells a union officer (%s), never one who cannot write', async (union, words) => {
    backend.memberships = false;
    const card = () => h(CampaignDraftCard, { canManageChapter: false, canManageUnion: union, onSaved: vi.fn() });
    view = await render(card()); await settle();
    noteResumeDraftReadFailure({ status: 0 });
    await view.rerender(card()); await settle();
    if (words) expect(text(view)).toContain(words); else expect(text(view)).toBe('');
  });
});
