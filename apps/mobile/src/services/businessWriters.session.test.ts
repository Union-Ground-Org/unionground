// Part B of record 9254: extracted without changing assertions from businessWriters.session.test.ts
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { processLock, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Exercise the pinned SDK and its real Auth lock. These are local fake
// transports; no hosted database, user content or real token is involved.
type SupabaseSdk = typeof import('@supabase/supabase-js');
const port = vi.hoisted(() => ({
  shared: null as SupabaseClient | null,
  fetch: null as null | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({}) }));
vi.mock('../state/useAppActive', () => ({ useAppActive: () => true }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { releaseEnvironment: 'development' } } } }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, compassNetworkEnabled: true, supabaseUrl: 'https://business-writer-test.invalid', supabasePublishableKey: 'sb_publishable_test', portalApiOrigin: 'https://portal-test.invalid' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('@supabase/supabase-js', async (original) => {
  const sdk = await original<SupabaseSdk>();
  return { ...sdk, createClient: (...args: Parameters<typeof sdk.createClient>) => args[2]?.accessToken
    ? sdk.createClient(args[0], args[1], { ...args[2], global: { ...args[2].global, fetch: (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init) } })
    : port.shared };
});

import { captureSessionWriter, type MobileSessionWriter } from './supabase';

import { completeStaffOnboardingStep, markStaffOnboardingStep, finishStaffGuide } from '../features/guideLayers/staffGuidesData';
import { sendBeHeardReport } from './beHeard';
import * as business from './supabase';
import { saveMobileAppointmentWindows, saveMobileAppointmentAccepting, bookMobileAppointment } from './appointmentBooking';
import { createMobileChapterMeeting } from './chapterMeetings';
import { createMeetingArgs } from '../lib/chapterMeeting';
import { saveMobileCampaignDraft, changeCampaign } from './campaignRegistry';
import { emptyCampaignDraft, saveCampaignDraftArgs } from '../lib/campaignDraft';
import { saveTaskEdits } from './taskEditing';
import { saveMobileSurveySession, submitMobileSurveySession } from './memberSurveys';
import { evaluateNativePulse, respondNativePulse } from './contextualPulse';
import { setMobileEventRsvp, checkInMobileEvent, scanMobileEventCheckin, saveMobileRightsProgress, requestMobileSteward, markMobileBroadcastRead } from './livedIn';
import { saveNativeOrganizationWorkload, saveNativeUnitOverrides, saveNativeChapterUnitSettings, saveNativeUnitWorkload, type UnitWorkspace } from './unitSettings';
import { claimMobileChapterLeadership, withdrawMobileLeadershipClaim } from './governance';
import { saveMyProfilePhone } from './profileDetails';

import { triageStewardRequest, reviewStewardForm, sendChapterBroadcast } from './stewardDeskSections';
import { createMobileConnectionAdapter } from './chapterConnections';
import { bindBusinessApi } from './businessWriters';
import { createQaRpcAdapter } from '../lib/mi1QaShared';
import { createPayRpcAdapter } from '../lib/mi1PayShared';
import { createMemberSupportAdapter } from '../../../../src/features/memberSupport/adapter.js';

import { reviewOrganizationStartSwitches, saveOrganizationStartContacts, acknowledgeOrganizationStartCelebration } from '../features/guideLayers/guideLayersData';

vi.mock('expo-crypto', () => ({ randomUUID: () => '33333333-3333-4333-8333-333333333333' }));
vi.mock('expo-secure-store', () => ({}));

const owner = '11111111-1111-4111-8111-111111111111';
const replacement = '22222222-2222-4222-8222-222222222222';
const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = (sub: string, nonce = 'initial') => [encode({ alg: 'HS256', typ: 'JWT' }), encode({ sub, exp: 9999999999, role: 'authenticated', nonce }), 'sig0'].join('.');
const ownerToken = token(owner);
const replacementToken = token(replacement);
const renewedToken = token(owner, 'renewed');
const emptyEffective = { workload: [], forms: [], templates: [], capabilities: {} };
const unitWorkspace: UnitWorkspace = {
  actorId: owner, chapterId: owner, units: [], unitId: owner, canSetChapter: true,
  allowed: {}, defaults: emptyEffective, effective: emptyEffective, organizationDefaults: emptyEffective,
  chapterOverrides: {}, overrides: {}, chapterVersion: 1, unitVersion: 1,
  formChoices: [], templateChoices: [], audit: [],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let requested = deferred<void>();
let replacementUser = deferred<Response>();
let writes: { path: string; actor: string }[] = [];
let afterWrite: null | (() => Promise<void>) = null;

beforeEach(async () => {
  requested = deferred<void>(); replacementUser = deferred<Response>(); writes = []; afterWrite = null;
  port.fetch = async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const url = String(input);
    const authorization = new Headers(init?.headers).get('Authorization');
    if (url.endsWith('/auth/v1/user')) {
      if (authorization === `Bearer ${replacementToken}`) { requested.resolve(); return replacementUser.promise; }
      return json({ id: owner, aud: 'authenticated', role: 'authenticated' });
    }
    if (url.includes('/auth/v1/token')) return json({ access_token: renewedToken, refresh_token: 'owner-refresh', token_type: 'bearer', expires_in: 3600, user: { id: owner, aud: 'authenticated', role: 'authenticated' } });
    const actor = authorization === `Bearer ${ownerToken}` ? 'owner' : authorization === `Bearer ${renewedToken}` ? 'owner-renewed' : authorization === `Bearer ${replacementToken}` ? 'replacement' : 'unknown';
    writes.push({ path: new URL(url).pathname, actor });
    if (afterWrite) { const callback = afterWrite; afterWrite = null; await callback(); }
    if (url.endsWith('/casework_decide_deadline_extension')) return json({ status: 'approved' });
    if (url.endsWith('/update_chapter_task_fields')) return json({ id: owner, title: 'Follow up', updated_at: '2026-11-19T20:00:00Z' });
    if (url.endsWith('/scan_event_checkin')) return json({ checkedIn: true, memberUserId: owner, memberName: 'Worker', alreadyCheckedIn: false, memberAwardedPoints: 0, scannerAwardedPoints: 0 });
    if (url.endsWith('/save_unit_settings') || url.endsWith('/save_chapter_unit_settings')) return json(unitWorkspace);
    if (url.endsWith('/api/sensitive-content')) return json({ data: { id: owner } });
    if (url.includes('/rest/v1/member_notifications')) return json({ id: owner, title: 'Campaign news', body: 'An update', kind: 'general', read_at: '2026-11-19T20:00:00Z', created_at: '2026-11-19T19:00:00Z' });
    return json({ ok: true, receiptCode: 'receipt-confirmed', voteId: owner, id: owner });
  };
  const sdk = await vi.importActual<SupabaseSdk>('@supabase/supabase-js');
  port.shared ??= sdk.createClient('https://business-writer-test.invalid', 'sb_publishable_test', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init) },
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => port.fetch!(input, init));
  expect((await port.shared.auth.setSession({ access_token: ownerToken, refresh_token: 'owner-refresh' })).error).toBeNull();
});
afterEach(() => vi.unstubAllGlobals());

async function prepare() {
  const session = (await port.shared!.auth.getSession()).data.session;
  expect(session?.user.id).toBe(owner);
  return { session: session as Session, writer: captureSessionWriter(session) };
}
async function holdReplacement() {
  const pending = port.shared!.auth.setSession({ access_token: replacementToken, refresh_token: 'replacement-refresh' });
  await requested.promise;
  return async () => { replacementUser.resolve(json({ id: replacement, aud: 'authenticated', role: 'authenticated' })); await pending; };
}
const families: [string, (writer: MobileSessionWriter, session: Session) => Promise<unknown>][] = [
['staff guide completion', (writer) => completeStaffOnboardingStep(writer, 'admin:settings')],
['staff guide mark', (writer) => markStaffOnboardingStep(writer, 'admin:settings', 'got')],
['staff guide finish', (writer) => finishStaffGuide(writer, 'admin', 'settings')],
['organization workload', (writer) => saveNativeOrganizationWorkload(writer, { organizationId: owner, version: 0, definition: { title: 'Workload', period: 'month', statuses: ['logged'], fields: [] } }, { cases: 1 }, 'logged')],
['unit overrides', (writer) => saveNativeUnitOverrides(writer, unitWorkspace, {})],
['campaign settings', (writer) => saveNativeChapterUnitSettings(writer, unitWorkspace, {}, {})],
['unit workload', (writer) => saveNativeUnitWorkload(writer, {
    actorId: owner, chapterId: owner, organizationId: owner, units: [], unitId: owner, needsChoice: false, canManage: true,
    effective: { ...emptyEffective, configuration: { actorId: owner, chapterId: owner, organizationId: owner, unitId: owner, unitName: 'Unit', version: 1, settingsRevision: 'revision-1', definition: { title: 'Workload', period: 'month', statuses: ['logged'], fields: [] } } },
  }, { cases: 1 }, 'logged')],
['profile phone', (writer) => saveMyProfilePhone(writer, { pronouns: null, jobTitle: null, worksite: null, phone: null, detailsVisibility: 'only_me', phoneVisibility: 'only_me' }, '', 'only_me')],
['pay factory', (writer) => bindBusinessApi(port.shared!, writer, createPayRpcAdapter, []).upsertGrade({ selectedOrganizationId: owner, membershipStatus: 'active', roles: ['admin'] }, { organizationId: owner, grade: 'A', title: 'Grade A', jobFamily: 'General', stepCount: 1, description: '' })]
];

it.each(families)('%s refuses a replacement held across dispatch', async (_name, write) => {
  const { session, writer } = await prepare(); const release = await holdReplacement();
  const pending = write(writer, session); pending.catch(() => undefined);
  await release(); await pending.catch(() => undefined);
  expect(writes).toEqual([]);
});
it.each(families)('%s performs a legitimate write with the composing account', async (_name, write) => {
  const { session, writer } = await prepare(); await write(writer, session);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((request) => request.actor === 'owner')).toBe(true);
});
it.each(families)('%s permits renewed same-person sign-in with the checked token', async (_name, write) => {
  const { session, writer } = await prepare();
  await port.shared!.auth.setSession({ access_token: renewedToken, refresh_token: 'owner-renewed' });
  await write(writer, session);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((request) => request.actor === 'owner-renewed')).toBe(true);
});

it.each(families)('%s fails closed without a composing session', async (_name, write) => {
  const { session } = await prepare();
  await write(captureSessionWriter(null), session).catch(() => undefined);
  expect(writes).toEqual([]);
});

it.each(families)('%s uses the checked same-person refresh token', async (_name, write) => {
  const { session, writer } = await prepare();
  expect((await port.shared!.auth.refreshSession()).error).toBeNull();
  await write(writer, session);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((request) => request.actor === 'owner-renewed')).toBe(true);
});

it.each(families)('%s refuses after sign-out', async (_name, write) => {
  const { session, writer } = await prepare();
  await port.shared!.auth.signOut({ scope: 'local' });
  writes = [];
  await write(writer, session).catch(() => undefined);
  expect(writes).toEqual([]);
});

it.each(families)('%s keeps acknowledgement separate from the replacement continuation', async (_name, write) => {
  const { session, writer } = await prepare();
  afterWrite = async () => {
    replacementUser.resolve(json({ id: replacement, aud: 'authenticated', role: 'authenticated' }));
    await port.shared!.auth.setSession({ access_token: replacementToken, refresh_token: 'replacement-refresh' });
  };
  const value = await write(writer, session);
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every((request) => request.actor === 'owner')).toBe(true);
  expect(await writer.acknowledged(value)).toMatchObject({ acknowledged: true, continuationCurrent: false });
});
