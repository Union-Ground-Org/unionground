// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { stubPlainRequire } from '../testing/plainRequire';
import { resumeDraftKey, syncResumeDraftContext, readResumeDraft, writeResumeDraft, retireResumeDraftScope, retireRefusedResumeDraftScope, confirmResumeDraftMemberships, confirmPendingNoticeMemberships } from '../lib/resumeDraftHolder';
import * as noticeService from '../services/stewardDeskSections';
import { nativeUiText } from '../lib/nativeUiCopy';
import { createAccountSessionIdentity } from '../lib/accountSessionIdentity';
import { haptics } from '../services/haptics';
import { deriveLiveStaffRoles, narrowLiveStaffRoles, selectableLiveStaffRoles } from '../lib/hatFunctions';
import type { LiveStaffRole } from '../lib/hatFunctions';
import type { MobileStaffScope } from '../services/supabase';
import type { ResumeDraftReads } from '../lib/resumeDraftHolder';
import palette from '../theme/palette.json';
import { beginNoticeSend, readPendingNoticeSend, forgetNoticeSend } from './noticePendingSend';

// #9240: exercise the shipped screens and their load effects, not source text.
// Native hosts and network ports are fixtures; mount gates, read effects,
// draft owners and write services remain real.
const port = vi.hoisted(() => ({
  ballots: vi.fn(), rewards: vi.fn(), events: vi.fn(), directory: vi.fn(),
  campaigns: vi.fn(), orgs: vi.fn(), context: vi.fn(),
  api: null as unknown,
  app: {
    mode: 'authenticated', resumeDraftReads: undefined as ResumeDraftReads | undefined, refreshing: false, locked: false, assuranceUnavailable: false, chooseStaffRole: vi.fn(), chosenStaffRole: null, session: { user: { id: 'member-a' }, access_token: '' }, memberLanguage: 'en',
    organizationID: 'org-a', dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' } },
    authorizedRoles: ['admin'], chapterRoles: ['admin'], organizationRoles: [], staffRoleChoices: [],
    chapterMemberships: [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }],
    captureAccountSessionGuard: (userID: string | null): (() => boolean) => () => port.app.session?.user.id === userID,
    captureAuthenticatedSessionGuard: () => () => true,
  },
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
// The form signature pad (#8699) on the live Forms screen draws with react-native-svg.
vi.mock('react-native-svg', () => ({ default: () => null, Polyline: () => null }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, StateMessage: ({ title, body, action }: { title: string; body?: string; action?: ReactNode }) => h('section', null, title, body, action) };
});
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }), useRouter: () => ({ push: vi.fn(), dismissTo: vi.fn() }), Redirect: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-crypto', () => ({ randomUUID: () => {
  const key = `00000000-0000-4000-8000-${String(++uuidSerial).padStart(12, '0')}`;
  return keyGate ? keyGate.then(() => key) : key;
} }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
// Ledger 142: mocks of phone modules keep the module's real exports and
// replace only what the test drives, so the next export a screen starts using
// does not break this file. The supabase, calendar export, haptics, analytics
// and observability ports stay whole stand-ins: their real modules load native
// modules the React Native stand-in does not provide. So does
// mi1AnalyticsShared: its real module reaches a root package the Mobile
// application check does not install.
vi.mock('../services/supabase', async () => {
  const { stubSessionWriter } = await import('../testing/stubSessionWriter');
  return {
    getSupabaseClient: () => ({ rpc }), loadMobileBallots: port.ballots,
    captureSessionWriter: () => stubSessionWriter(() => ({ rpc })),
  };
});
vi.mock('../services/governance', async (original) => ({ ...(await original() as typeof import('../services/governance')), loadMobileOfficerRemovalDetails: async () => new Map() }));
vi.mock('../services/livedIn', async (original) => ({ ...(await original() as typeof import('../services/livedIn')), loadMobileEventsHistory: port.events, loadMobileRewardsHistory: port.rewards }));
vi.mock('../services/nativeCalendarExport', () => ({ isCalendarExportAvailable: () => false }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn() } }));
vi.mock('../services/analyticsPreference', () => ({ gatePageViewRecorder: (fn: unknown) => fn, useProductAnalyticsEnabled: () => false }));
vi.mock('../services/observability', () => ({ captureNativeScreen: vi.fn() }));
vi.mock('../services/ssoRelease', () => ({ useSsoReleased: () => false }));
vi.mock('../lib/announce', async (original) => ({ ...(await original() as typeof import('../lib/announce')), queueAccessibilityAnnouncement: vi.fn(), useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../lib/screenBack', async (original) => ({ ...(await original() as typeof import('../lib/screenBack')), useScreenBackInterceptor: () => {} }));
vi.mock('../lib/useFeaturePageView', async (original) => ({ ...(await original() as typeof import('../lib/useFeaturePageView')), useFeaturePageView: () => {} }));
vi.mock('../lib/mi1AnalyticsShared', () => ({ normalizeMemberReportCard: () => null }));
vi.mock('../lib/connectedWorkflows', async (original) => ({ ...(await original() as typeof import('../lib/connectedWorkflows')), connectedWorkflowApi: () => ({ context: port.context }) }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children), useScreenNameAlreadySpoken: () => ({ hiddenProps: {} }) }));
vi.mock('../components/SupportLink', () => ({ SupportLink: () => null }));
vi.mock('../../../../src/lib/civicApi.js', async (original) => ({ ...(await original() as object), createCivicApi: () => port.api }));
vi.mock('../data/useChannels', () => ({}));
vi.mock('../components/AskCompassButton', () => ({ AskCompassButton: () => null }));
vi.mock('../components/TransactionalAction', () => ({ useTransactionalAction: () => ({ done: false }) }));
vi.mock('../components/CaseRowPressable', () => ({}));
vi.mock('../components/PressableScale', () => ({}));
vi.mock('../components/ChapterVerificationControls', () => ({}));
vi.mock('../components/NumberFlow', () => ({}));
vi.mock('../components/StaffRolePicker', () => ({ StaffRolePicker: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: () => null }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: () => null }));
vi.mock('./LiveAppointmentsFeature', () => ({}));
vi.mock('./MemberSupportScreen', () => ({}));
vi.mock('./ChapterMembershipsScreen', () => ({}));
vi.mock('./ChapterInvitationsScreen', () => ({}));
vi.mock('./OrgStructureScreen', () => ({}));
vi.mock('./mi1/PayToolsScreen', () => ({}));
vi.mock('./mi1/Mi1FeatureScreen', () => ({}));
vi.mock('./mi1/Mi1AnalyticsScreen', () => ({}));
vi.mock('./mi1/ConnectionSuggestionsPanel', () => ({}));
vi.mock('./mi1/OrganizationIntelligenceScreens', () => ({}));
vi.mock('./mi1/Mi1QaFeatureScreen', () => ({}));
vi.mock('./learning/LearningContentManager', () => ({ LearningContentManager: () => null }));
vi.mock('./learning/LearningLibrarySection', () => ({ LearningLibrarySection: () => null }));
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('./ContextualPulseCard', () => ({ ContextualPulseCard: () => null, useNativeContextualPulse: () => null }));
vi.mock('./RightsResumeReading', () => ({ ContinueReadingCard: () => null, RightsReadingSections: () => null, rightsBookmarks: {}, useRightsBookmark: () => null, useRightsReadingScope: () => null }));
vi.mock('./TaskDocumentHandoffProvider', () => ({ useTaskDocumentHandoff: () => ({ active: false, pending: null }) }));
vi.mock('./WorkFilterPresetsCard', () => ({ WorkFilterButton: () => null, WorkFilterPresetsCard: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ ChapterCaseRowTopicCard: () => null }));

import { FeatureScreen } from './FeatureScreen';
import { StewardDeskSectionsScreen } from './StewardDeskSectionsScreen';

type Row = { id: string; title: string; summary: string; startsAt: string; location: string; chapterID: string; eventKind: 'meeting'; eventDate: null; checkInOffered: false };
type Write = { name: string; args: Record<string, unknown> };
let events: Row[] = [];
let notices: { key: string; title: string }[] = [];
let writes: Write[] = [];
let audienceRead: { data: unknown; error: unknown } | null = null;
let eventReadError: unknown = null;
let delayed: { promise: Promise<{ data: unknown; error: unknown }>; resolve: (value: { data: unknown; error: unknown }) => void } | null = null;
let delayNext = false;
let rejectNext: { code?: string; message: string; status?: number } | null = null;
let failAfterCommit = false;
let loseReplyAfterCommit = false;
let audienceGate: Promise<void> | null = null;
let delayAsFailure = false;
let serial = 0;
let uuidSerial = 0;
let keyGate: Promise<void> | null = null;

async function rpc(name: string, args: Record<string, unknown> = {}) {
  if (name === 'get_chapter_office_access') { if (audienceGate) await audienceGate; return audienceRead ?? { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true, scopes: [] }, error: null }; }
  if (name === 'list_my_member_notices') return { data: { notices: [], hasMore: false }, error: null };
  if (name === 'list_steward_broadcasts') return { data: [], error: null };
  writes.push({ name, args });
  if (rejectNext) { const { status, ...error } = rejectNext; rejectNext = null; return { data: null, error, status }; }
  if (!delayAsFailure && name === 'create_member_event_model') {
    if (events.some((row) => row.id === args.p_id)) return { data: null, error: { code: '22023', message: 'meeting id already exists' } };
    events.push({ id: String(args.p_id), title: String(args.p_title), summary: String(args.p_summary), startsAt: String(args.p_starts_at), location: String(args.p_location), chapterID: 'chapter-a', eventKind: 'meeting', eventDate: null, checkInOffered: false });
  } else if (!delayAsFailure && name === 'publish_chapter_office_notice') {
    const key = 'p_idempotency_key' in args ? String(args.p_idempotency_key) : `unkeyed-${notices.length}`;
    if (!notices.some((row) => row.key === key)) notices.push({ key, title: String(args.p_title) });
  } else if (!delayAsFailure) throw new Error(`Unexpected RPC ${name}`);
  if (delayNext) {
    delayNext = false;
    let resolve!: (value: { data: unknown; error: unknown }) => void;
    const promise = new Promise<{ data: unknown; error: unknown }>((done) => { resolve = done; });
    delayed = { promise, resolve };
    return promise;
  }
  if (loseReplyAfterCommit) { loseReplyAfterCommit = false; return { data: null, error: { code: '', message: 'Network request failed' } }; }
  if (failAfterCommit) { failAfterCommit = false; throw new TypeError('Network request failed'); }
  return { data: { id: args.p_id ?? 'notice-saved', broadcastId: 'notice-saved' }, error: null };
}

afterAll(stubPlainRequire({
  '../lib/config': { mobileConfig: { supabaseUrl: '' } },
  'expo-crypto': { getRandomBytes: (count: number) => Uint8Array.from({ length: count }, (_, at) => at + ++serial) },
}));

let screen: Rendered | null = null;
let surface: 'meeting' | 'notice' = 'meeting';
let sourceID: string | undefined;
let noticeFeatureGate = false;
let noticeEntry: 'chapter-notices' | 'steward-broadcasts' = 'chapter-notices';
let staffScope: MobileStaffScope | null | undefined;
let loginID = '00000000-0000-4000-8000-000000000001';
let tokenRotation = 0;
const loginIdentity = createAccountSessionIdentity();
const accessToken = () => `fixture.${btoa(JSON.stringify({ session_id: loginID, iat: tokenRotation }))}.fixture`;
const signedIn = () => ({
  mode: 'authenticated', resumeDraftReads: undefined as ResumeDraftReads | undefined, refreshing: false, session: { user: { id: 'member-a' }, access_token: accessToken() }, memberLanguage: 'en',
  organizationID: 'org-a', dashboard: { member: { id: 'member-a', chapterID: 'chapter-a', language: 'en' } },
  authorizedRoles: ['admin'], chapterRoles: ['admin'], organizationRoles: [], staffRoleChoices: [],
  chosenStaffRole: null, locked: false, assuranceUnavailable: false,
  chapterMemberships: [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }],
  captureAccountSessionGuard: (userID: string | null): (() => boolean) => loginIdentity.captureGuard(userID),
  captureAuthenticatedSessionGuard: () => () => true,
});
// The AppProvider network/native boundary is a fixture, as in the existing
// screen tests. Drive the exact cleared context and central holder observer;
// FeatureScreen, its mount gates, editors and write services stay real.
function syncContext() {
  loginIdentity.current = port.app.session ? { userID: port.app.session.user.id, accessToken: port.app.session.access_token, refreshToken: 'fixture-refresh' } : null;
  const context = { ...port.app, staffScope };
  syncResumeDraftContext(context);
}
// Drive the provider's actual full-grant projection and hat narrowing. The
// full staff response is independent of the currently selected hat.
function publishStaff(scope: MobileStaffScope | null, choice: LiveStaffRole | null = null,
  reads: ResumeDraftReads = { dashboard: true, memberships: true, staff: true }) {
  staffScope = scope;
  const full = deriveLiveStaffRoles({ mode: port.app.mode, previewRoles: [], organizationStaffScope: scope });
  const choices = selectableLiveStaffRoles(full);
  const chosen = choice && choices.includes(choice) ? choice : null;
  Object.assign(port.app, narrowLiveStaffRoles(full, chosen), { chosenStaffRole: chosen, staffRoleChoices: choices, resumeDraftReads: reads });
}
function Root() {
  syncContext();
  if (surface === 'notice' && noticeEntry === 'steward-broadcasts' && !noticeFeatureGate) return h(StewardDeskSectionsScreen, { featureKey: noticeEntry });
  return h(FeatureScreen, { featureKey: surface === 'meeting' ? 'events-desk' : noticeEntry, sourceID });
}
async function settle() { await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); }
async function draw() { await screen!.rerender(h(Root)); await settle(); }
async function boot() {
  Object.assign(port.app, { mode: 'booting', resumeDraftReads: { dashboard: false, memberships: false, staff: false }, dashboard: null, organizationID: null, chapterMemberships: [], authorizedRoles: [], chapterRoles: [], organizationRoles: [] });
  await draw();
  expect(screen!.container.textContent).not.toContain('Quillmere draft');
}
async function resume() { await boot(); Object.assign(port.app, signedIn()); await draw(); }
const field = () => getExposed(screen!.container, surface === 'meeting' ? 'Meeting title' : 'Broadcast title') as HTMLInputElement;
async function openDraft() {
  screen = await render(h(Root)); await settle();
  if (surface === 'meeting') await press(getExposed(screen.container, 'Schedule a meeting'));
  await type(field(), 'Quillmere draft');
  await type(getExposed(screen.container, surface === 'meeting' ? 'What the meeting is about' : 'Broadcast message'), 'Plan the next steps.');
  if (surface === 'meeting') await type(getExposed(screen.container, 'Location, room, or meeting link'), 'Room 2');
}
async function send() {
  const names = exposedNames(screen!.container);
  await press(getExposed(screen!.container, surface === 'meeting' ? 'Schedule meeting'
    : names.includes('Send again') ? 'Send again' : names.includes('Send unit notice') ? 'Send unit notice' : 'Send notice'));
  await settle();
}
async function assertEmpty() {
  if (surface === 'meeting' && exposedNames(screen!.container).includes('Schedule a meeting')) await press(getExposed(screen!.container, 'Schedule a meeting'));
  expect(field().value).toBe('');
}

beforeEach(() => {
  loginIdentity.current = null; loginID = '00000000-0000-4000-8000-000000000001'; tokenRotation = 0; noticeEntry = 'chapter-notices'; staffScope = undefined; noticeFeatureGate = false;
  Object.assign(port.app, signedIn());
  syncResumeDraftContext({ ...signedIn(), mode: 'signedOut', session: null });
  events = []; notices = []; writes = []; audienceRead = null; eventReadError = null;
  delayed = null; delayNext = false; rejectNext = null; failAfterCommit = false; serial = 0; uuidSerial = 0; keyGate = null; sourceID = undefined;
  audienceGate = null; delayAsFailure = false; loseReplyAfterCommit = false;
  vi.clearAllMocks();
  port.events.mockImplementation(async () => { if (eventReadError) throw eventReadError; return events.map((row) => ({ ...row })); });
  port.context.mockResolvedValue({ available: true });
});
afterEach(async () => { await screen?.unmount(); screen = null;
  for (const owner of ['member-a|chapter-a', 'member-a|chapter-b', 'member-b|chapter-a']) {
    const entry = readPendingNoticeSend(owner);
    if (entry) forgetNoticeSend(owner, entry.ticket);
  }
  syncResumeDraftContext({ ...signedIn(), mode: 'signedOut', session: null }); setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('unsent work survives the real screen remount on %s', (os) => {
  const owners: readonly ('meeting' | 'notice')[] = ['meeting', 'notice'];
  for (const owner of owners) {
    describe(owner, () => {
      beforeEach(() => { surface = owner; setPlatform(os); });
      it('restores the full draft only after the same-person fresh read succeeds', async () => {
        await openDraft();
        await resume();
        expect(field().value).toBe('Quillmere draft');
        expect((getExposed(screen!.container, owner === 'meeting' ? 'What the meeting is about' : 'Broadcast message') as HTMLInputElement).value).toBe('Plan the next steps.');
        if (owner === 'meeting') expect((getExposed(screen!.container, 'Location, room, or meeting link') as HTMLInputElement).value).toBe('Room 2');
        expect(writes).toHaveLength(0);
      });
      it('preserves current text by pausing edits and sends while a scope input is unconfirmed', async () => {
        await openDraft();
        port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: false }; await draw();
        expect(field().disabled).toBe(true);
        await type(field(), 'Must not overwrite the retained draft'); await send();
        expect(field().value).toBe(''); expect(writes).toHaveLength(0);
        port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: true }; await draw();
        expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(false);
        expect(writes).toHaveLength(0);
      });
      it('does not resurrect a local copy after a global refusal during the scope wait', async () => {
        await openDraft();
        port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: false }; await draw();
        expect(field().value).toBe('');
        await act(async () => { retireRefusedResumeDraftScope(port.app.session.user.id, { status: 403 }); });
        port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: true }; await draw();
        await assertEmpty(); expect(field().disabled).toBe(false); expect(writes).toHaveLength(0);
      });
      it('retains every field when several input meetings arrive in one React batch', async () => {
        screen = await render(h(Root)); await settle();
        if (owner === 'meeting') await press(getExposed(screen.container, 'Schedule a meeting'));
        await act(async () => {
          const fields = owner === 'meeting'
            ? [['Meeting title', 'Quillmere draft'], ['What the meeting is about', 'Plan the next steps.'], ['Location, room, or meeting link', 'Room 2']]
            : [['Broadcast title', 'Quillmere draft'], ['Broadcast message', 'Plan the next steps.']];
          for (const [label, value] of fields) {
            const input = getExposed(screen!.container, label!) as HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
            setter?.call(input, value!); input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        await resume(); expect(field().value).toBe('Quillmere draft');
        expect((getExposed(screen.container, owner === 'meeting' ? 'What the meeting is about' : 'Broadcast message') as HTMLInputElement).value).toBe('Plan the next steps.');
      });
      it.each([false, true])('R1 bootstrap: conceals an incomplete signed-in bootstrap and keeps work (pending=%s)', async (pending) => {
        await openDraft();
        if (pending) { delayNext = true; await send(); }
        await boot();
        Object.assign(port.app, { mode: 'authenticated', refreshing: true });
        await draw();
        expect([...screen!.container.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value)).not.toContain('Quillmere draft');
        Object.assign(port.app, signedIn()); await draw();
        expect(field().value).toBe('Quillmere draft');
        expect(field().disabled).toBe(pending);
        if (pending) {
          await send(); expect(writes).toHaveLength(1);
          await act(async () => { delayed!.resolve({ data: { id: 'saved', broadcastId: 'saved' }, error: null }); }); await settle();
          await assertEmpty(); await resume(); await assertEmpty();
          expect(writes).toHaveLength(1);
        }
      });
      const expiredTokens: readonly { code?: string; message: string; status?: number }[] = [
        { code: 'PGRST301', message: 'JWT expired' }, { code: 'PGRST302', message: 'Token unavailable' },
        { code: 'PGRST303', message: 'Token refused' }, { status: 401, message: 'Refresh needed' },
      ];
      for (const expiry of expiredTokens) {
        it(`R1 token: keeps concealed work after a refreshable read failure (${expiry.code ?? expiry.status})`, async () => {
          await openDraft(); await boot();
          if (owner === 'meeting') eventReadError = expiry;
          else audienceRead = { data: null, error: expiry };
          Object.assign(port.app, signedIn()); await draw();
          expect([...screen!.container.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value)).not.toContain('Quillmere draft');
          eventReadError = null; audienceRead = null;
          await press(getExposed(screen!.container, owner === 'meeting' ? 'Try again' : 'Reload audiences')); await settle();
          expect(field().value).toBe('Quillmere draft'); expect(writes).toHaveLength(0);
        });
        it(`R1 token: keeps editable work after a refreshable write failure (${expiry.code ?? expiry.status})`, async () => {
          await openDraft(); rejectNext = expiry; await send();
          await resume(); expect(field().value).toBe('Quillmere draft');
          expect(field().disabled).toBe(false);
          await send();
          expect(writes).toHaveLength(2); expect(owner === 'meeting' ? events : notices).toHaveLength(1);
        });
      }
      it('R1 token: a delayed confirmed write survives a token-expired access read without a second offer', async () => {
        await openDraft(); delayNext = true; await send(); await boot();
        if (owner === 'meeting') eventReadError = { code: 'PGRST301' };
        else audienceRead = { data: null, error: { code: 'PGRST301' } };
        Object.assign(port.app, signedIn()); await draw();
        const key = resumeDraftKey(port.app, owner, owner === 'meeting' ? 'new' : 'chapter-notices');
        expect(readResumeDraft(key)?.pending).toBe(true);
        expect([...screen!.container.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value)).not.toContain('Quillmere draft');
        await act(async () => { delayed!.resolve({ data: { id: 'saved', broadcastId: 'saved' }, error: null }); }); await settle();
        eventReadError = null; audienceRead = null;
        await press(getExposed(screen!.container, owner === 'meeting' ? 'Try again' : 'Reload audiences')); await settle();
        await assertEmpty(); expect(writes).toHaveLength(1);
      });
      const changes: readonly ('account' | 'sign-out' | 'organization' | 'chapter' | 'role')[] = ['account', 'sign-out', 'organization', 'chapter', 'role'];
      for (const change of changes) {
        it(`retires old work permanently after ${change}`, async () => {
          await openDraft(); await boot();
          const next = signedIn();
          if (change === 'account') { next.session.user.id = 'member-b'; next.dashboard.member.id = 'member-b'; }
          if (change === 'sign-out') Object.assign(next, { mode: 'signedOut', session: null });
          if (change === 'organization') next.organizationID = 'org-b';
          if (change === 'chapter') { next.chapterMemberships[0]!.chapterID = 'chapter-b'; next.dashboard.member.chapterID = 'chapter-b'; }
          if (change === 'role') { next.authorizedRoles = ['vp']; next.chapterRoles = ['vp']; }
          Object.assign(port.app, next); await draw();
          expect(screen!.container.textContent).not.toContain('Quillmere draft');
          Object.assign(port.app, signedIn()); await draw();
          await assertEmpty();
          expect(writes).toHaveLength(0);
        });
      }
      it('keeps pending work locked until a confirmed delayed acknowledgement retires it', async () => {
        await openDraft(); delayNext = true; await send();
        expect(delayed).not.toBeNull(); expect(writes).toHaveLength(1);
        await resume();
        expect(field().value).toBe('Quillmere draft');
        expect(field().disabled).toBe(true);
        const action = getExposed(screen!.container, owner === 'meeting' ? 'Schedule meeting' : exposedNames(screen!.container).includes('Send again') ? 'Send again' : 'Send notice');
        await press(action); expect(writes).toHaveLength(1);
        await act(async () => { delayed!.resolve({ data: { id: 'saved', broadcastId: 'saved' }, error: null }); }); await settle();
        await assertEmpty();
        await resume(); await assertEmpty();
        expect(writes).toHaveLength(1);
      });
      it('offers nothing again when the acknowledgement arrives while the tree is unmounted', async () => {
        await openDraft(); delayNext = true; await send(); await boot();
        await act(async () => { delayed!.resolve({ data: { id: 'saved', broadcastId: 'saved' }, error: null }); });
        Object.assign(port.app, signedIn()); await draw(); await assertEmpty();
        expect(writes).toHaveLength(1);
      });
      it('restores editable text after a delayed known failure', async () => {
        await openDraft(); delayNext = true; delayAsFailure = true; await send(); await resume();
        expect(field().disabled).toBe(true);
        const error = owner === 'meeting' ? { code: '22023', message: 'meeting id already exists' } : { code: '23514', message: 'validation refused' };
        await act(async () => { delayed!.resolve({ data: null, error }); }); await settle();
        expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(false);
        expect(events).toHaveLength(0); expect(notices).toHaveLength(0);
      });
      it.each([false, true])('R1 error: editing dismisses a known failure without clearing work (remounted=%s)', async (remounted) => {
        await openDraft();
        rejectNext = owner === 'meeting' ? { code: '22023', message: 'meeting id already exists' } : { code: '23514', message: 'validation refused' };
        await send(); if (remounted) await resume();
        const warning = owner === 'meeting' ? 'The meeting could not be scheduled. Try again.' : 'The broadcast was not sent. Try again.';
        expect(screen!.container.textContent).toContain(warning);
        await type(field(), 'Corrected draft');
        expect(screen!.container.textContent).not.toContain(warning);
        await resume(); expect(field().value).toBe('Corrected draft');
        expect(screen!.container.textContent).not.toContain(warning);
      });
      it('does not expose retained text or permit a second write before the fresh read answers', async () => {
        await openDraft(); await boot();
        let release!: () => void;
        const gate = new Promise<void>((done) => { release = done; });
        if (owner === 'meeting') port.events.mockImplementationOnce(async () => { await gate; return events; });
        else audienceGate = gate;
        Object.assign(port.app, signedIn()); await draw();
        expect([...screen!.container.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value)).not.toContain('Quillmere draft');
        if (owner === 'notice') { await type(field(), 'Must not replace the held notice'); expect(field().value).toBe(''); }
        await act(async () => { release(); }); await settle();
        expect(field().value).toBe('Quillmere draft'); expect(writes).toHaveLength(0);
      });
      it('preserves an uncertain operation identity across remount and retries without a second post', async () => {
        await openDraft(); failAfterCommit = true; await send();
        const first = writes[0];
        await resume();
        expect(field().value).toBe('Quillmere draft');
        expect(field().disabled).toBe(true);
        await press(getExposed(screen!.container, owner === 'meeting' ? 'Schedule meeting' : 'Send again')); await settle();
        expect(writes).toHaveLength(2);
        expect(owner === 'meeting' ? writes[1]?.args.p_id : writes[1]?.args.p_idempotency_key).toBe(owner === 'meeting' ? first?.args.p_id : first?.args.p_idempotency_key);
        expect(owner === 'meeting' ? events : notices).toHaveLength(1);
        await assertEmpty();
      });
      it('keeps a lost in-flight acknowledgement unconfirmed after resume and retries once with the same identity', async () => {
        await openDraft(); delayNext = true; await send();
        const first = writes[0]; await resume();
        await act(async () => { delayed!.resolve({ data: null, error: { code: '', message: 'Network request failed' } }); }); await settle();
        expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(true);
        await press(getExposed(screen!.container, owner === 'meeting' ? 'Schedule meeting' : 'Send again')); await settle();
        expect(writes).toHaveLength(2);
        expect(owner === 'meeting' ? writes[1]?.args.p_id : writes[1]?.args.p_idempotency_key).toBe(owner === 'meeting' ? first?.args.p_id : first?.args.p_idempotency_key);
        expect(owner === 'meeting' ? events : notices).toHaveLength(1); await assertEmpty();
      });
      it.each([false, true])(`${owner === 'notice' ? 'keeps the uncertain notice on a refused retry' : 'retires the uncertain meeting on an authoritative refusal'} (remounted=%s)`, async (remounted) => {
        await openDraft(); failAfterCommit = true; await send(); if (remounted) await resume();
        expect(field().disabled).toBe(true);
        rejectNext = { status: 403, message: 'Forbidden' };
        await press(getExposed(screen!.container, owner === 'meeting' ? 'Schedule meeting' : 'Send again')); await settle();
        if (owner === 'notice') {
          expect(readPendingNoticeSend('member-a|chapter-a')?.attempt?.operationKey).toBe(writes[0]?.args.p_idempotency_key);
          expect(field().disabled).toBe(true); expect(screen!.container.textContent).toContain('Not sent now:');
          await resume(); expect(field().value).toBe('Quillmere draft'); expect(writes).toHaveLength(2);
          return;
        }
        expect(readResumeDraft(resumeDraftKey(port.app, owner, owner === 'meeting' ? 'new' : 'chapter-notices'))).toBeNull();
        await assertEmpty(); expect(field().disabled).toBe(false);
        await resume(); await assertEmpty(); expect(writes).toHaveLength(2);
      });
      it('retires a refused fresh read permanently when access later returns', async () => {
        await openDraft(); await boot();
        if (owner === 'meeting') eventReadError = { code: '42501', message: 'permission denied' };
        else audienceRead = { data: null, error: { code: '42501', message: 'permission denied' } };
        Object.assign(port.app, signedIn()); await draw();
        const key = resumeDraftKey(port.app, owner, owner === 'meeting' ? 'new' : 'chapter-notices');
        expect(readResumeDraft(key)).toBeNull();
        eventReadError = null; audienceRead = null;
        await boot(); Object.assign(port.app, signedIn()); await draw();
        await assertEmpty();
      });
      const writeRefusals: readonly { code?: string; message: string; status?: number }[] = [
        { code: '42501', message: 'Permission refused' }, { status: 403, message: 'Forbidden' },
      ];
      for (const refusal of writeRefusals) {
        it(`${owner === 'notice' ? 'keeps a refused first notice editable' : 'retires a confirmed meeting refusal'} (${refusal.code ?? refusal.status}) through wrapping and recovery`, async () => {
          await openDraft(); rejectNext = refusal; await send();
          const key = resumeDraftKey(port.app, owner, owner === 'meeting' ? 'new' : 'chapter-notices');
          if (owner === 'notice') {
            expect(readResumeDraft(resumeDraftKey(port.app, 'notice', 'chapter-notices'))?.value.title).toBe('Quillmere draft');
            await resume(); expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(false);
            expect(writes).toHaveLength(1); expect(notices).toHaveLength(0); return;
          }
          expect(readResumeDraft(key)).toBeNull();
          await resume(); await assertEmpty(); expect(writes).toHaveLength(1);
          expect(owner === 'meeting' ? events : notices).toHaveLength(0);
        });
      }
      it('retires a missing source or audience permanently when it later returns', async () => {
        if (owner === 'meeting') {
          sourceID = 'anchor';
          events = [{ id: 'anchor', title: 'Anchor meeting', summary: '', startsAt: '2030-01-01T15:00:00Z', location: 'Room 2', chapterID: 'chapter-a', eventKind: 'meeting', eventDate: null, checkInOffered: false }];
        }
        await openDraft(); await boot();
        if (owner === 'meeting') port.context.mockResolvedValue({ available: false });
        else audienceRead = { data: null, error: null };
        Object.assign(port.app, signedIn()); await draw();
        expect(readResumeDraft(resumeDraftKey(port.app, owner, owner === 'meeting' ? 'anchor' : 'chapter-notices'))).toBeNull();
        port.context.mockResolvedValue({ available: true }); audienceRead = null;
        await boot(); Object.assign(port.app, signedIn()); await draw(); await assertEmpty();
      });
      it('removes a discarded or fully emptied draft', async () => {
        await openDraft();
        if (owner === 'meeting') await press(getExposed(screen!.container, 'Cancel'));
        else { await type(field(), ''); await type(getExposed(screen!.container, 'Broadcast message'), ''); }
        await resume(); await assertEmpty();
      });
      it('retains concealed work after a transient fresh-read failure and restores on retry', async () => {
        await openDraft(); await boot();
        if (owner === 'meeting') eventReadError = new TypeError('Network request failed');
        else audienceRead = { data: null, error: { message: 'Network request failed' } };
        Object.assign(port.app, signedIn()); await draw();
        expect(screen!.container.textContent).not.toContain('Quillmere draft');
        eventReadError = null; audienceRead = null;
        await press(getExposed(screen!.container, owner === 'meeting' ? 'Try again' : 'Reload audiences')); await settle();
        expect(field().value).toBe('Quillmere draft');
      });
      it('does not let a retired old acknowledgement clear a replacement draft', async () => {
        await openDraft(); delayNext = true; await send(); await boot();
        if (owner === 'meeting') eventReadError = { code: '42501' };
        else {
          audienceRead = { data: { chapterId: 'chapter-a', notices: false, unscopedNotices: false, scopes: [] }, error: null };
          confirmPendingNoticeMemberships('member-a', []);
        }
        Object.assign(port.app, signedIn()); await draw();
        eventReadError = null; audienceRead = null;
        await boot(); Object.assign(port.app, signedIn()); await draw();
        await assertEmpty(); await type(field(), 'Replacement draft');
        await act(async () => { delayed!.resolve({ data: { id: 'saved', broadcastId: 'saved' }, error: null }); }); await settle();
        expect(field().value).toBe('Replacement draft');
      });
      it('does not let a retired old failure replace new text or its operation identity', async () => {
        await openDraft(); delayNext = true; await send(); await boot();
        if (owner === 'notice') confirmPendingNoticeMemberships('member-a', [{ chapterID: 'chapter-b', organizationID: 'org-b', selected: true }]);
        Object.assign(port.app, { ...signedIn(), organizationID: 'org-b' }); await draw();
        Object.assign(port.app, signedIn()); await draw();
        await assertEmpty(); await type(field(), 'Replacement draft');
        await act(async () => { delayed!.resolve({ data: null, error: { code: '', message: 'Network request failed' } }); }); await settle();
        expect(field().value).toBe('Replacement draft'); expect(field().disabled).toBe(false);
      });
    });
  }
  it.each([false, true])('R1 error: Try again dismisses the retained notice failure (remounted=%s)', async (remounted) => {
    surface = 'notice'; setPlatform(os);
    await openDraft(); rejectNext = { code: '23514', message: 'validation refused' }; await send();
    if (remounted) await resume();
    expect(screen!.container.textContent).toContain('The broadcast was not sent. Try again.');
    await press(getExposed(screen!.container, 'Try again'));
    expect(screen!.container.textContent).not.toContain('The broadcast was not sent. Try again.');
    expect(field().value).toBe('Quillmere draft');
    await resume(); expect(field().value).toBe('Quillmere draft');
    expect(screen!.container.textContent).not.toContain('The broadcast was not sent. Try again.');
    expect(writes).toHaveLength(1);
  });
  it('R1 UUID: distinct new notice operations really draw distinct keys', async () => {
    surface = 'notice'; setPlatform(os);
    await openDraft(); await send(); await assertEmpty();
    await type(field(), 'A different notice'); await type(getExposed(screen!.container, 'Broadcast message'), 'A different message');
    await send();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.args.p_idempotency_key).not.toBe(writes[1]?.args.p_idempotency_key);
    expect(notices).toHaveLength(2);
  });
  describe.each<'chapter-notices' | 'steward-broadcasts'>(['chapter-notices', 'steward-broadcasts'])('T9 original login ownership: %s', (entryPoint) => {
    beforeEach(() => { surface = 'notice'; noticeEntry = entryPoint; setPlatform(os); });
    // A reply to a departed ticket must neither consume nor unlock a new
    // login's/recovered scope's send, including its success notification.
    async function replacementSurvives(oldReply: NonNullable<typeof delayed>, lost: boolean) {
      await type(field(), 'Replacement draft');
      await type(getExposed(screen!.container, 'Broadcast message'), 'Current work');
      delayNext = true; await send();
      const replacement = delayed!;
      await act(async () => { oldReply.resolve(lost ? { data: null, error: { message: 'Network request failed' } } : { data: { broadcastId: 'old' }, error: null }); }); await settle();
      expect(field().value).toBe('Replacement draft'); expect(field().disabled).toBe(true);
      expect(haptics.success).not.toHaveBeenCalled(); expect(writes).toHaveLength(2);
      await act(async () => { replacement.resolve({ data: { broadcastId: 'new' }, error: null }); }); await settle();
      await assertEmpty(); expect(haptics.success).toHaveBeenCalledTimes(1);
    }
    for (const signOut of [false, true]) {
      it.each([false, true])(`discards the old login's in-flight send (sign-out=${signOut}, lost=%s)`, async (lost) => {
        await openDraft(); delayNext = true; await send(); const oldReply = delayed!;
        await screen!.unmount(); screen = null;
        if (signOut) { Object.assign(port.app, { mode: 'signedOut', session: null }); syncContext(); }
        loginID = '00000000-0000-4000-8000-000000000002'; Object.assign(port.app, signedIn()); syncContext();
        screen = await render(h(Root)); await settle();
        await assertEmpty(); expect(exposedNames(screen.container)).not.toContain('Send again');
        expect(readPendingNoticeSend('member-a|chapter-a')).toBeNull();
        expect(writes).toHaveLength(1); expect(haptics.success).not.toHaveBeenCalled();
        await replacementSurvives(oldReply, lost);
      });
    }
    it('keeps the original attempt through a same-login token rotation', async () => {
      await openDraft(); delayNext = true; await send(); const oldReply = delayed!;
      const key = writes[0]?.args.p_idempotency_key;
      tokenRotation += 1; Object.assign(port.app, signedIn()); await draw();
      expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(true);
      await act(async () => { oldReply.resolve({ data: null, error: { message: 'Network request failed' } }); }); await settle();
      await press(getExposed(screen!.container, 'Send again')); await settle();
      expect(writes.map(write => write.args.p_idempotency_key)).toEqual([key, key]);
      expect(notices).toHaveLength(1); await assertEmpty(); expect(haptics.success).toHaveBeenCalledTimes(1);
    });
  });
  describe.each<'chapter-notices' | 'steward-broadcasts'>(['chapter-notices', 'steward-broadcasts'])('#9258 successor %s', entryPoint => {
    const originalRole: LiveStaffRole = entryPoint === 'chapter-notices' ? 'admin' : 'steward';
    const otherRole: LiveStaffRole = originalRole === 'admin' ? 'vp' : 'admin';
    const grants: MobileStaffScope = { organizationID: 'org-a', roles: [], chapterRoles: ['admin', 'vp', 'steward'], staffAuthorized: true };
    const current = () => readPendingNoticeSend('member-a|chapter-a');
    const key = () => writes[0]?.args.p_idempotency_key;
    beforeEach(() => {
      surface = 'notice'; noticeEntry = entryPoint; noticeFeatureGate = true; setPlatform(os);
      publishStaff(grants, originalRole);
      port.app.chooseStaffRole.mockImplementation((role: LiveStaffRole) => publishStaff(grants, role));
    });
    async function unknown(unit = false) {
      if (unit) audienceRead = { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true,
        scopes: [{ role: originalRole, notices: true, name: 'Held unit', unitId: 'unit-a' }] }, error: null };
      await openDraft();
      if (unit) await press(getExposed(screen!.container, 'Unit: Held unit'));
      failAfterCommit = true; await send(); expect(current()?.attempt?.operationKey).toBe(key());
    }
    async function replay() {
      await send(); expect(writes[1]?.args.p_idempotency_key).toBe(key());
      expect(notices).toHaveLength(1); await assertEmpty();
    }
    it('T1: preserves the held unit through an omitting still-granted hat and offers the card and switch back', async () => {
      await unknown(true); const held = current(); publishStaff(grants, otherRole); await draw();
      expect(current()?.attempt?.operationKey).toBe(key());
      expect(screen!.container.querySelector('[aria-label="Broadcast title"]')).toBeNull();
      expect(screen!.container.textContent).toContain('Unconfirmed notice');
      expect(screen!.container.textContent).toContain('Quillmere draft');
      expect(exposedNames(screen!.container)).not.toContain('Send again');
      await press(getExposed(screen!.container, 'Show notice message'));
      expect(screen!.container.textContent).toContain('Plan the next steps.');
      await press(getExposed(screen!.container, 'Hide notice message'));
      await press(getExposed(screen!.container, 'Check the notices you sent')); await settle(); expect(current()).toBe(held);
      await press(getExposed(screen!.container, 'Discard'));
      expect(screen!.container.textContent).toContain('Discard this notice? If it was already posted, it stays posted.');
      await press(getExposed(screen!.container, 'Keep notice')); expect(current()).toBe(held);
      port.app.memberLanguage = 'es'; await draw();
      expect(screen!.container.textContent).toContain(nativeUiText('es')('Unconfirmed notice'));
      expect(screen!.container.textContent).toContain(nativeUiText('es')('Discard'));
      port.app.memberLanguage = 'en'; await draw();
      const switchName = exposedNames(screen!.container).find(name => name.startsWith('Switch to '))!;
      await press(getExposed(screen!.container, switchName)); await draw();
      expect(port.app.chooseStaffRole).toHaveBeenCalledWith(originalRole);
      expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(true); await replay();
    });
    it('T2: keeps the same key through a successful empty staff scope while absent and a restored grant', async () => {
      await unknown(); await screen!.unmount(); screen = null;
      publishStaff({ organizationID: 'org-a', roles: [], chapterRoles: [], staffAuthorized: false }); syncContext();
      expect(current()?.attempt?.operationKey).toBe(key());
      screen = await render(h(Root)); await settle();
      expect(screen.container.querySelector('[aria-label="Broadcast title"]')).toBeNull();
      expect(screen.container.textContent).toContain("You can't send to My campaign with your current roles.");
      expect(exposedNames(screen.container)).toContain('Discard');
      publishStaff(grants, originalRole); await draw();
      expect(field().value).toBe('Quillmere draft'); await replay();
    });
    it('T1 explicit discard from the other-hat card clears the held operation and its resume copies', async () => {
      await unknown(true); publishStaff(grants, otherRole); await draw();
      await press(getExposed(screen!.container, 'Discard'));
      expect(current()).not.toBeNull(); await press(getExposed(screen!.container, 'Discard notice'));
      expect(current()).toBeNull(); publishStaff(grants, originalRole); await draw(); await assertEmpty();
      expect(writes).toHaveLength(1); expect(notices).toHaveLength(1);
    });
    it('T3: retires the resume copy on a global read refusal, conceals held text, then replays the original key', async () => {
      await unknown(); port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: false }; await draw();
      expect(screen!.container.querySelector('[aria-label="Broadcast title"]')).toBeNull();
      await act(async () => retireRefusedResumeDraftScope('member-a', { status: 403 }));
      expect(readResumeDraft(resumeDraftKey(port.app, 'notice', entryPoint))).toBeNull();
      expect(current()?.attempt?.operationKey).toBe(key());
      publishStaff(grants, originalRole); await draw(); expect(field().value).toBe('Quillmere draft'); await replay();
    });
    it('T3 an audience-read refusal conceals the held notice without deleting its key', async () => {
      await unknown(); audienceRead = { data: null, error: { code: '42501', message: 'permission denied' } };
      await resume();
      expect(current()?.attempt?.operationKey).toBe(key());
      expect(screen!.container.querySelector('[aria-label="Broadcast title"]')).toBeNull();
      expect(screen!.container.textContent).not.toContain('Quillmere draft');
      audienceRead = null; await press(getExposed(screen!.container, 'Reload audiences')); await settle();
      publishStaff(grants, originalRole); await draw();
      expect(field().value).toBe('Quillmere draft'); await replay();
    });
    it.each([{ code: '42501', message: 'permission denied' }, { code: 'PGRST301', message: 'JWT expired' }, { status: 429, code: '54000', message: 'rate limit' }, { status: 429, message: 'rate limit without a database code' }])('T4: a refused retry remains held with not-sent-now copy (%s)', async refusal => {
      await unknown(); rejectNext = refusal; await send();
      expect(current()?.attempt?.operationKey).toBe(key()); expect(field().disabled).toBe(true);
      expect(screen!.container.textContent).toContain('Not sent now:'); expect(writes).toHaveLength(2);
      await send(); expect(writes.map(row => row.args.p_idempotency_key)).toEqual([key(), key(), key()]);
      expect(notices).toHaveLength(1); await assertEmpty();
    });
    it('T5: key-reused 22023 confirms already posted, consumes the holder and mints no replacement key', async () => {
      await unknown(); const minted = uuidSerial;
      rejectNext = { code: '22023', message: 'idempotency key reused for a different request' }; await send();
      expect(current()).toBeNull(); expect(uuidSerial).toBe(minted); await assertEmpty();
      expect(screen!.container.textContent).toContain('This notice was already posted.'); expect(notices).toHaveLength(1);
    });
    it('T6: a campaign and organization switch with both memberships retained keeps the held send', async () => {
      await unknown(); const memberships = [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: false }, { chapterID: 'chapter-b', organizationID: 'org-b', selected: true }];
      await screen!.unmount(); screen = null;
      confirmResumeDraftMemberships('member-a', [{ chapterID: 'chapter-b', selected: true }]);
      Object.assign(port.app, { organizationID: 'org-b', chapterMemberships: memberships }); syncContext();
      expect(current()?.attempt?.operationKey).toBe(key());
      Object.assign(port.app, { organizationID: 'org-a', chapterMemberships: memberships.map(row => ({ ...row, selected: row.chapterID === 'chapter-a' })) });
      screen = await render(h(Root)); await settle(); expect(field().value).toBe('Quillmere draft'); await replay();
    });
    it.each(['chapter', 'organization'])('T7: confirmed departure from the %s retires held sends while absent, even with other reads failed', async departure => {
      await unknown(); await screen!.unmount(); screen = null;
      const memberships = [{ chapterID: departure === 'chapter' ? 'chapter-b' : 'chapter-a', organizationID: departure === 'chapter' ? 'org-a' : 'org-b', selected: true }];
      port.app.resumeDraftReads = { dashboard: false, memberships: false, staff: false };
      confirmPendingNoticeMemberships('member-a', memberships); expect(current()).toBeNull();
      Object.assign(port.app, signedIn()); publishStaff(grants, originalRole); screen = await render(h(Root)); await settle(); await assertEmpty();
      expect(exposedNames(screen.container)).not.toContain('Send again'); expect(writes).toHaveLength(1);
    });
    it('T8: a real MFA challenge in the same login conceals and preserves the held attempt', async () => {
      await unknown(); Object.assign(port.app, { mode: 'mfaRequired', assuranceUnavailable: false, dashboard: null, chapterMemberships: [], organizationID: null, resumeDraftReads: { dashboard: false, memberships: false, staff: false } }); await draw();
      expect(screen!.container.textContent).not.toContain('Quillmere draft'); expect(current()?.attempt?.operationKey).toBe(key());
      Object.assign(port.app, signedIn()); publishStaff(grants, originalRole); await draw(); expect(field().value).toBe('Quillmere draft'); await replay();
    });
    it('T7 preserves another still-joined campaign’s current draft when the held campaign departs', async () => {
      await unknown();
      const memberships = [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: false }, { chapterID: 'chapter-b', organizationID: 'org-b', selected: true }];
      audienceRead = { data: { chapterId: 'chapter-b', notices: true, unscopedNotices: true, scopes: [] }, error: null };
      Object.assign(port.app, { organizationID: 'org-b', chapterMemberships: memberships }); await draw();
      await type(field(), 'Campaign B work');
      Object.assign(port.app, { chapterMemberships: memberships.slice(1) });
      await act(async () => confirmPendingNoticeMemberships('member-a', memberships.slice(1))); await draw();
      expect(current()).toBeNull(); expect(field().value).toBe('Campaign B work'); expect(field().disabled).toBe(false);
      expect(readResumeDraft(resumeDraftKey(port.app, 'notice', entryPoint))?.value.title).toBe('Campaign B work');
    });
    it('T10: a different hat includes the same value but Send again uses the exact held audience object and payload', async () => {
      const publisher = vi.spyOn(noticeService, 'sendChapterBroadcast');
      await unknown(true); const heldAudience = current()!.audience;
      audienceRead = { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true,
        scopes: [{ role: otherRole, notices: true, name: 'A changed display name', unitId: 'unit-a' }] }, error: null };
      publishStaff(grants, otherRole); await draw(); await send();
      expect(publisher.mock.calls[1]?.[0].userId).toBe('member-a');
      expect(publisher.mock.calls[1]?.[3]).toBe(heldAudience);
      expect(writes[1]?.args).toEqual(writes[0]?.args); expect(notices).toHaveLength(1); publisher.mockRestore();
    });
    // C356 (gate r1s1/r2s1): Discard is disabled only while a request is
    // really in flight. A send that answers while the composer is concealed
    // (an unconfirmed read, a running refresh, or a failed audience read)
    // must leave Discard usable once the holder's ticket is idle.
    it.each<'read' | 'refresh' | 'audience'>(['read', 'refresh', 'audience'])('C356 A: a send that answers while the %s is unconfirmed never strands Discard', async unconfirmed => {
      const discard = () => getExposed(screen!.container, 'Discard') as HTMLButtonElement;
      await openDraft(); delayNext = true; await send();
      if (unconfirmed === 'read') port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: false };
      else port.app.refreshing = true;
      await draw();
      if (unconfirmed === 'audience') {
        audienceRead = { data: null, error: { code: '', message: 'Network request failed' } };
        port.app.refreshing = false; await draw();
        expect(screen!.container.textContent).toContain('Your notice audience could not be checked.');
      }
      expect(screen!.container.querySelector('[aria-label="Broadcast title"]')).toBeNull();
      expect(discard().getAttribute('aria-disabled')).toBe('true');
      await act(async () => { delayed!.resolve({ data: null, error: { code: '', message: 'Network request failed' } }); }); await settle();
      expect(current()?.busy).toBe(false); expect(current()?.attempt?.operationKey).toBe(key());
      expect(screen!.container.querySelector('[aria-label="Broadcast title"]')).toBeNull();
      expect(discard().getAttribute('aria-disabled')).toBeNull();
      await press(discard()); await press(getExposed(screen!.container, 'Discard notice'));
      expect(current()).toBeNull();
      if (unconfirmed === 'read') publishStaff(grants, originalRole);
      if (unconfirmed === 'refresh') port.app.refreshing = false;
      await draw();
      if (unconfirmed === 'audience') { audienceRead = null; await press(getExposed(screen!.container, 'Reload audiences')); await settle(); }
      await assertEmpty(); expect(field().disabled).toBe(false); expect(writes).toHaveLength(1);
    });
    it.each<'read' | 'refresh'>(['read', 'refresh'])('C356 A: a held retry that answers while the %s is unconfirmed leaves the restored draft actionable', async unconfirmed => {
      await unknown(); delayNext = true; await send();
      if (unconfirmed === 'read') port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: false };
      else port.app.refreshing = true;
      await draw();
      await act(async () => { delayed!.resolve({ data: null, error: { code: '', message: 'Network request failed' } }); }); await settle();
      if (unconfirmed === 'read') publishStaff(grants, originalRole); else port.app.refreshing = false;
      await draw();
      expect(field().value).toBe('Quillmere draft');
      expect(getExposed(screen!.container, 'Discard').getAttribute('aria-disabled')).toBeNull();
      expect(getExposed(screen!.container, 'Send again').getAttribute('aria-disabled')).toBeNull();
      await replay(); expect(writes.map(row => row.args.p_idempotency_key)).toEqual([key(), key(), key()]);
    });
  });
  it.each(['day', 'time', 'length', 'check-in'])('R1 choices: keeps a %s-only meeting edit with empty text fields', async (choice) => {
    surface = 'meeting'; setPlatform(os);
    screen = await render(h(Root)); await settle();
    await press(getExposed(screen.container, 'Schedule a meeting'));
    if (choice === 'check-in') await press(getExposed(screen.container, 'Workers check in with a code'));
    else {
      const prefix = choice === 'day' ? 'Later day: ' : choice === 'time' ? 'Start later: ' : 'Longer: ';
      await press(getExposed(screen.container, exposedNames(screen.container).find((name) => name.startsWith(prefix))!));
    }
    const selected = exposedNames(screen.container).filter((name) => /^(Later day|Start later|Longer): /.test(name));
    const checkIn = getExposed(screen.container, 'Workers check in with a code').getAttribute('aria-checked');
    await resume();
    expect(exposedNames(screen.container)).toContain('Meeting title');
    expect(exposedNames(screen.container).filter((name) => /^(Later day|Start later|Longer): /.test(name))).toEqual(selected);
    expect(getExposed(screen.container, 'Workers check in with a code').getAttribute('aria-checked')).toBe(checkIn);
    expect(field().value).toBe('');
    // Emptying text later must not erase the selected non-text work either.
    await type(field(), 'Temporary title'); await type(field(), '');
    await resume(); expect(exposedNames(screen.container)).toContain('Meeting title');
    expect(exposedNames(screen.container).filter((name) => /^(Later day|Start later|Longer): /.test(name))).toEqual(selected);
    await press(getExposed(screen.container, 'Cancel')); await resume();
    expect(exposedNames(screen.container)).toContain('Schedule a meeting'); expect(writes).toHaveLength(0);
  });
  it('R1 choices: retires an empty meeting after all non-text choices return to their starting defaults', async () => {
    surface = 'meeting'; setPlatform(os);
    screen = await render(h(Root)); await settle(); await press(getExposed(screen.container, 'Schedule a meeting'));
    const step = async (prefix: string) => press(getExposed(screen!.container, exposedNames(screen!.container).find((name) => name.startsWith(prefix))!));
    await step('Later day: '); await step('Longer: '); await resume();
    await step('Earlier day: '); await step('Shorter: ');
    expect(readResumeDraft(resumeDraftKey(port.app, 'meeting', 'new'))).toBeNull();
    await resume(); expect(exposedNames(screen.container)).toContain('Schedule a meeting'); expect(writes).toHaveLength(0);
  });
  it('keeps a deleted meeting gone while restoring the new-meeting draft', async () => {
    surface = 'meeting'; setPlatform(os);
    events = [{ id: 'removed', title: 'Removed meeting', summary: '', startsAt: '2030-01-01T15:00:00Z', location: 'Room 2', chapterID: 'chapter-a', eventKind: 'meeting', eventDate: null, checkInOffered: false }];
    await openDraft(); expect(screen!.container.textContent).toContain('Removed meeting');
    events = []; await resume();
    expect(screen!.container.textContent).not.toContain('Removed meeting');
    expect(port.events).toHaveBeenCalledTimes(2);
    expect(field().value).toBe('Quillmere draft');
  });
  it.each([false, true])('9258S R1: disables Discard while the RPC is in flight (concealed=%s)', async concealed => {
    surface = 'notice'; setPlatform(os);
    await openDraft(); delayNext = true; await send();
    const held = readPendingNoticeSend('member-a|chapter-a');
    if (concealed) { port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: false }; await draw(); }
    const discard = getExposed(screen!.container, 'Discard') as HTMLButtonElement;
    expect(discard.getAttribute('aria-disabled')).toBe('true');
    await press(discard);
    expect(exposedNames(screen!.container)).not.toContain('Discard notice');
    expect(readPendingNoticeSend('member-a|chapter-a')).toBe(held);
    await act(async () => delayed!.resolve({ data: { broadcastId: 'notice-saved' }, error: null })); await settle();
    port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: true }; await draw();
    expect(readPendingNoticeSend('member-a|chapter-a')).toBeNull();
    expect(writes).toHaveLength(1); await assertEmpty();
  });
  it('9258S R2: keeps a never-dispatched key without claiming its outcome is unconfirmed', async () => {
    surface = 'notice'; setPlatform(os); await openDraft();
    let release!: () => void;
    keyGate = new Promise<void>(resolve => { release = resolve; });
    await send();
    await act(async () => retireResumeDraftScope('member-a'));
    await act(async () => release()); keyGate = null; await settle(); await draw();
    const key = readPendingNoticeSend('member-a|chapter-a')?.attempt?.operationKey;
    expect(key).toBeTruthy(); expect(writes).toHaveLength(0);
    expect(screen!.container.textContent).toContain('The broadcast was not sent. Try again.');
    expect(screen!.container.textContent).not.toContain('We could not confirm');
    expect(screen!.container.textContent).not.toContain('Unconfirmed notice');
    await send(); expect(writes).toHaveLength(1); expect(writes[0]?.args.p_idempotency_key).toBe(key);
    expect(uuidSerial).toBe(1); await assertEmpty();
  });
  // C356 (gate r1s2/r2s2): holding an operation key is not proof that an
  // earlier try was published. Only a dispatched try whose outcome is unknown
  // is; a never-dispatched key whose first real try is refused stays known not sent.
  async function neverDispatched() {
    surface = 'notice'; setPlatform(os); await openDraft();
    let release!: () => void;
    keyGate = new Promise<void>(resolve => { release = resolve; });
    await send();
    await act(async () => retireResumeDraftScope('member-a'));
    await act(async () => release()); keyGate = null; await settle(); await draw();
    const key = readPendingNoticeSend('member-a|chapter-a')?.attempt?.operationKey;
    expect(key).toBeTruthy(); expect(writes).toHaveLength(0);
    return key;
  }
  it.each([{ code: '42501', message: 'permission denied' }, { code: 'PGRST301', message: 'JWT expired' }, { status: 429, code: '54000', message: 'rate limit' }, { status: 429, message: 'rate limit without a database code' }])('C356 B: a never-dispatched key whose first real try is refused stays known not sent (%s)', async refusal => {
    const key = await neverDispatched();
    rejectNext = refusal; await send();
    expect(writes.map(row => row.args.p_idempotency_key)).toEqual([key]); expect(notices).toHaveLength(0);
    expect(readPendingNoticeSend('member-a|chapter-a')).toBeNull();
    expect(screen!.container.textContent).not.toContain('We could not confirm');
    expect(screen!.container.textContent).not.toContain('Unconfirmed notice');
    expect(screen!.container.textContent).not.toContain('Not sent now:');
    expect(exposedNames(screen!.container)).not.toContain('Send again');
    expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(false);
    expect(readResumeDraft(resumeDraftKey(port.app, 'notice', 'chapter-notices'))?.value.attempt ?? null).toBeNull();
    if (exposedNames(screen!.container).includes('Reload audiences')) { await press(getExposed(screen!.container, 'Reload audiences')); await settle(); }
    await send(); expect(notices).toHaveLength(1); await assertEmpty();
  });
  it('C356 B: a never-dispatched key whose first real try loses its answer becomes unconfirmed, and its refused retry stays unconfirmed', async () => {
    const key = await neverDispatched();
    failAfterCommit = true; await send();
    expect(screen!.container.textContent).toContain('We could not confirm this notice was sent.');
    rejectNext = { code: '42501', message: 'permission denied' }; await send();
    expect(readPendingNoticeSend('member-a|chapter-a')?.attempt?.operationKey).toBe(key);
    expect(screen!.container.textContent).toContain('Not sent now:');
    expect(screen!.container.textContent).toContain('We could not confirm this notice was sent.');
    await send(); expect(writes.map(row => row.args.p_idempotency_key)).toEqual([key, key, key]);
    expect(notices).toHaveLength(1); await assertEmpty();
  });
  it('9258S R3: invalid-login notice retirement preserves meeting work and clears its notice copy', async () => {
    surface = 'meeting'; setPlatform(os); await openDraft();
    const meeting = resumeDraftKey(port.app, 'meeting', 'new')!;
    const savedMeeting = readResumeDraft(meeting);
    expect(savedMeeting).not.toBeNull();
    const notice = resumeDraftKey(port.app, 'notice', 'chapter-notices')!;
    writeResumeDraft(notice, { title: 'Old login notice', body: 'Body', locale: 'en', audienceValue: 'chapter', attempt: null, warning: null });
    let currentLogin = true;
    const held = beginNoticeSend('member-a|chapter-a', { title: 'Old login notice', body: 'Body', locale: 'en', postingRole: 'admin' },
      { value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' }, null, { userID: 'member-a', isCurrent: () => currentLogin });
    expect(held).not.toBeNull();
    currentLogin = false; syncContext();
    expect(readPendingNoticeSend('member-a|chapter-a')).toBeNull();
    expect(readResumeDraft(notice)).toBeNull();
    expect(readResumeDraft(meeting)).toBe(savedMeeting);
    await draw(); expect(field().value).toBe('Quillmere draft');
  });
  it('#9258 keeps the attempted notice across a granted hat change with the real resume holder active', async () => {
    surface = 'notice'; setPlatform(os);
    await openDraft(); delayNext = true; await send();
    const key = writes[0]?.args.p_idempotency_key;
    await boot();
    Object.assign(port.app, { ...signedIn(), chosenStaffRole: 'vp', authorizedRoles: ['vp'], chapterRoles: ['vp'] });
    await draw();
    expect(field().value).toBe('Quillmere draft'); expect(field().disabled).toBe(true);
    await act(async () => { delayed!.resolve({ data: null, error: { code: '', message: 'Network request failed' } }); }); await settle();
    await press(getExposed(screen!.container, 'Send again')); await settle();
    expect(writes.map(write => write.args.p_idempotency_key)).toEqual([key, key]);
    expect(notices).toHaveLength(1); await assertEmpty();
  });
  it('#9258 conceals an attempted notice through an unconfirmed read without dropping its retry identity', async () => {
    surface = 'notice'; setPlatform(os);
    await openDraft(); delayNext = true; await send();
    const key = writes[0]?.args.p_idempotency_key;
    port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: false }; await draw();
    expect(screen!.container.querySelector('[aria-label="Broadcast title"]')).toBeNull();
    await act(async () => { delayed!.resolve({ data: null, error: { code: '', message: 'Network request failed' } }); }); await settle();
    expect(screen!.container.querySelector('[aria-label="Broadcast title"]')).toBeNull(); expect(writes).toHaveLength(1);
    port.app.resumeDraftReads = { dashboard: true, memberships: true, staff: true }; await draw();
    expect(field().value).toBe('Quillmere draft');
    await press(getExposed(screen!.container, 'Send again')); await settle();
    expect(writes.map(write => write.args.p_idempotency_key)).toEqual([key, key]);
    expect(notices).toHaveLength(1); await assertEmpty();
  });
  it('keeps the notice audience and language together with the restored text', async () => {
    surface = 'notice'; setPlatform(os);
    audienceRead = { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true, scopes: [{ role: 'admin', notices: true, name: 'Quillmere unit', unitId: 'unit-a' }] }, error: null };
    await openDraft();
    await press(getExposed(screen!.container, 'Unit: Quillmere unit'));
    await press(getExposed(screen!.container, 'Español'));
    await resume(); await press(getExposed(screen!.container, 'Send unit notice')); await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toMatchObject({ p_title: 'Quillmere draft', p_locale: 'es', p_unit: 'unit-a' });
  });
  it('keeps a notice typed while its initial audience is loading, after the fresh grant arrives', async () => {
    surface = 'notice'; setPlatform(os);
    let release!: () => void;
    audienceGate = new Promise<void>((done) => { release = done; });
    screen = await render(h(Root)); await settle();
    await type(field(), 'Quillmere draft');
    await type(getExposed(screen.container, 'Broadcast message'), 'Plan the next steps.');
    expect(field().value).toBe('Quillmere draft'); expect(writes).toHaveLength(0);
    await act(async () => { release(); }); await settle();
    await resume(); expect(field().value).toBe('Quillmere draft');
  });
  it('requires a fresh item read before restoring a draft when the Meetings owner is reused for another source', async () => {
    surface = 'meeting'; setPlatform(os); sourceID = 'anchor-a';
    events = ['anchor-a', 'anchor-b'].map((id) => ({ id, title: id, summary: '', startsAt: '2030-01-01T15:00:00Z', location: 'Room 2', chapterID: 'chapter-a', eventKind: 'meeting', eventDate: null, checkInOffered: false }));
    await openDraft(); sourceID = 'anchor-b'; await draw();
    await press(getExposed(screen!.container, 'Schedule a meeting')); await type(field(), 'Other item draft');
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    port.context.mockImplementationOnce(async () => { await gate; return { available: true }; });
    sourceID = 'anchor-a'; await draw();
    expect([...screen!.container.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value)).not.toContain('Quillmere draft');
    expect([...screen!.container.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value)).not.toContain('Other item draft');
    await act(async () => { release(); }); await settle();
    expect(field().value).toBe('Quillmere draft'); expect(writes).toHaveLength(0);
  });
  it('retires a notice for a removed audience rather than assigning another audience', async () => {
    surface = 'notice'; setPlatform(os);
    audienceRead = { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true, scopes: [{ role: 'admin', notices: true, name: 'Quillmere unit', unitId: 'unit-a' }] }, error: null };
    await openDraft(); await press(getExposed(screen!.container, 'Unit: Quillmere unit'));
    audienceRead = null; await resume(); await assertEmpty();
    audienceRead = { data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true, scopes: [{ role: 'admin', notices: true, name: 'Quillmere unit', unitId: 'unit-a' }] }, error: null };
    await resume(); await assertEmpty(); expect(writes).toHaveLength(0);
  });
});
