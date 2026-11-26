import { businessRpc } from './businessWriters';
import { createSessionBoundWriter } from '../../../../src/lib/sessionBoundWriter.js';
import { NEW_PASSWORD_MIN, NEW_PASSWORD_RULE } from "../../../../src/lib/passwordPolicy.js";
import { aggregateMessageReactions, isMessageReactionKind } from '../lib/messagingShared';
import 'react-native-url-polyfill/auto';

import { createClient, processLock, type Session, type SupabaseClient } from '@supabase/supabase-js';

import { createFailClosedAuthFetch } from './authFetch';
import { accessTokensShareSessionLineage } from '../lib/sessionLineage';

import { mobileConfig } from '../lib/config';
import { authStorageKeyFor } from '../lib/storeDemo';
import { isLiveSampleBackend } from './sampleSession';
import { sessionRequiresTotp } from '../lib/authPolicy';
import { calendarRecordGone } from '../lib/calendarExportFailure';
import { normalizeChapterBinding, normalizeUnionOrganizations } from '../lib/chapterLifecycle';
import { buildRegistryQuery, registrySearchPlan } from '../../../../src/features/unionCatalog/registryQuery.js';
import {
  DIRECTORY_PAGE_LIMIT,
  type MobileAdminScope,
  type MobileChapterUnit,
  type MobileChapterRole,
  type MobileDirectoryCursor,
  type MobileDirectoryMember,
  directoryPageWasTruncated,
  membershipRpcFailure,
  normalizeAdminScope,
  normalizeChapterUnits,
  normalizeDirectoryCursor,
  normalizeDirectoryMembers,
} from '../lib/chapterAdministration';
import { MEMBER_ORG_RPC_NAMES } from '../lib/memberOrgContract';
import { compassSourcesWithDestinations } from '../lib/compassSourceNavigation';
import { notificationDestination } from '../lib/notificationKinds';
import {
  NOTIFICATION_PREFERENCES_COLUMNS,
  notificationPreferencesFromRow,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
  type NotificationPreferencesRow,
} from '../lib/notificationPreferences';
import { createBackendScopedSessionStorage } from '../lib/secureSessionStorage';
import { nativeAuthGate } from '../lib/nativeAuthGate';
import { resolvePortalApiOrigin } from '../lib/portalApiOrigin';
import { directUnreadCount, projectMessageBody, projectMessagePreview } from '../lib/messagingShared';
import { initialsForName } from '../models/member';
import {
  currentNativeDirectAudience,
  isStewardRoleRefusal,
  noteStewardDirectRefusal,
  projectStewardDirectPage,
  STEWARD_DIRECT_PAGE,
  type StewardDirectCursor,
  type StewardDirectPage,
} from './stewardDirectInbox';
import { OPEN_STEP_DEADLINE_STATUSES, withNextDeadlines, type StepDeadlineRow } from '../lib/whatMattersShared';
import { readWithTimeZoneFallback } from '../lib/timeZoneColumn';
import { loadCaseStepLabels, loadCaseStepLabelsByScope } from '../lib/caseStepLabels';
import { isAuthoritativeReadRefusal, isReadRefusal } from '../lib/readRefusal';
import type { CalendarExportPayload } from './nativeCalendarExport';
import { classifySignOutFailure, tagSignOutProvenance } from './signOutFailure';
import { signInThroughPortalPasswordProxy, type NativeSignInPlatform } from './passwordSignIn';
import type {
  CompassMessage,
  CompassReply,
  MemberAction,
  MemberCase,
  MemberCaseDetail,
  MemberCaseUpdate,
  MemberConversation,
  MemberConversationThread,
  MessageHistoryCursor,
  MemberDashboard,
  MemberMessage,
  MemberNotification,
  MemberProfile,
} from '../models/member';

type ProfileRow = {
  id: string;
  first_name: string;
  full_name: string;
  initials: string;
  role_line: string;
  member_since: number | null;
  chapter_id: string | null;
  language: string | null;
};

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  kind: string | null;
  copy_key?: string | null;
  peer_conversation_id?: string | null;
  read_at: string | null;
  created_at: string;
};

type CaseRow = {
  id: string;
  user_id?: string;
  reference: string;
  title: string;
  deadline: string | null;
  case_type: string;
  step: string;
  status: string;
  updated_at: string;
  organization_id?: string | null;
  chapter_id?: string | null;
  // The zone the case's dates are counted in .
  time_zone?: string | null;
};

type ActionRow = {
  action_key: string;
  action_kind: string;
  occurred_at: string;
};

type CaseUpdateRow = {
  id: string;
  case_id: string;
  body: string;
  created_at: string;
};

type ConversationRow = {
  id: string;
  steward_user_id: string | null;
  title: string;
  initials: string;
  created_at: string;
  updated_at: string;
};

type ConversationSummaryRow = {
  conversation_id: string;
  latest_message: string | null;
  unread_count: number;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_kind: string;
  sender_name: string;
  body: string;
  read_at: string | null;
  created_at: string;
  redacted_at?: string | null;
  redaction_reason?: string | null;
  edited_at?: string | null;
  parent_message_id?: string | null;
};

export type MobileIntegrationProvider = {
  id: string;
  provider: string;
  status: string;
  allowChapterOverrides: boolean;
};

export type MobileStaffRole = 'organizer' | 'steward' | 'coordinator' | 'advisor' | 'admin' | 'vp';

export type MobileStaffScope = {
  organizationID: string | null;
  roles: MobileStaffRole[];
  chapterRoles: MobileStaffRole[];
  staffAuthorized: boolean;
};

// A successful membership read can confirm a place even without a chapter.
export type MobileMembershipSelection = { chapterID: string | null; organizationID: string | null };

export type MobileChapterMembership = {
  chapterID: string;
  organizationID: string | null;
  name: string;
  region: string | null;
  selected: boolean;
  pinned: boolean;
  lastSelectedAt: string | null;
  joinedAt: string;
  roles: MobileStaffRole[];
  organizationRoles: MobileStaffRole[];
  chapterRoles: MobileStaffRole[];
};

export type MobileHandshake = {
  id: string;
  title: string;
  purpose: string;
  dataScope: 'docs_only' | 'no_member_data' | 'aggregate_only';
  status: 'draft' | 'requested' | 'accepted' | 'active' | 'declined' | 'closed';
  direction: 'incoming' | 'outgoing';
  partnerName: string;
  updatedAt: string;
};

export type MobileHandshakeTarget = {
  id: string;
  name: string;
  location: string;
  affiliation: string;
};

export type MobileChapterBinding = {
  chapterID: string;
  unionOrgID: string;
  organizationName: string;
  status: 'requested' | 'verified' | 'rejected';
  publicNote: string;
};

export type MobileUnionOrganization = {
  id: string;
  name: string;
  location: string;
  affiliation: string;
};

export type MobileHandshakeDocument = {
  id: string;
  title: string;
  documentType: string;
  updatedAt: string;
};

export type MobileHealthChapter = {
  chapterId: string;
  chapterName: string;
  databaseDate: string;
  measuredOn: string | null;
  cohortProtected: boolean;
  memberCount: number | null;
  score: number | null;
  drivers: Record<string, number> | null;
  trend: { measuredOn: string; score: number }[];
  recordedAt?: string | null;
  recordedBy?: string | null;
  revisedAt?: string | null;
  revisedBy?: string | null;
  coaching: { id: string; summary: string; nextAction: string; attentionLevel: string; createdAt: string; authorName?: string }[];
};

export type MobileHealthDrivers = {
  participation: number;
  caseTimeliness: number;
  stewardCapacity: number;
  trainingCoverage: number;
  communicationReach: number;
  governanceReadiness: number;
};

export type MobileAppointment = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  appointmentType: string;
  reasonCategory?: string;
  memberName?: string;
  stewardName?: string;
};

export type MobileAppointmentHistory = {
  appointment: MobileAppointment;
  items: { id: string; action: string; createdAt: string; actorKind: string; detail: Record<string, unknown> }[];
  nextBefore: string | null;
  nextBeforeID: string | null;
};

export type MobileConnectionReadiness = {
  capability: 'sms' | 'calendar_google' | 'calendar_microsoft' | 'cba' | 'notion' | 'enterprise';
  status: 'unset' | 'configuring' | 'active' | 'error' | 'disabled';
  providerLabel: string;
  publicMessage: string;
  updatedAt: string | null;
  // The chapter the row belongs to. The read policy returns the server's
  // current chapter, which another session can change, so a decision is
  // recorded against this chapter, never one the screen assumes.
  chapterID: string | null;
};

export type MobileSmsPreference = {
  activationStatus: MobileConnectionReadiness['status'];
  publicMessage: string;
  consented: boolean;
  phoneLast4: string | null;
  updatedAt: string | null;
};

export type MobileBallot = {
  id: string;
  chapterId?: string | null;
  title: string;
  closesAt: string;
  closed: boolean;
  receiptCode: string | null;
  options: { id: string; label: string; orderIndex: number }[];
};

type MobileChapterMembershipWire = {
  chapterId?: unknown;
  organizationId?: unknown;
  name?: unknown;
  region?: unknown;
  selected?: unknown;
  pinned?: unknown;
  lastSelectedAt?: unknown;
  joinedAt?: unknown;
  roles?: unknown;
  organizationRoles?: unknown;
  chapterRoles?: unknown;
};

let client: SupabaseClient | null = null;
let mobileSessionStorage: ReturnType<typeof createBackendScopedSessionStorage> | null = null;
const mobileAuthStorageKey = 'org.unionground.app.auth';
const MAX_DASHBOARD_NOTIFICATIONS = 200;
const MAX_DASHBOARD_CASES = 200;
const MAX_DASHBOARD_CONVERSATIONS = 200;

function memberNotification(row: NotificationRow): MemberNotification {
  const kind = row.kind ?? 'general';
  // REQ-UNION-BASE-MOBILE-MEMBER-PARITY-20260814 F2: a live row carries no
  // target column, so its destination is the feature its kind belongs to
  // (notificationDestination); a kind with no feature stays text-only. The
  // destination screen performs its own reauthorization; nothing protected is
  // copied into the notification.
  // A private two-person message notice  names its conversation, and
  // opens it; that screen reads the member's own list before showing it.
  const href = notificationDestination(kind, row.copy_key, row.peer_conversation_id);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind,
    readAt: row.read_at,
    createdAt: row.created_at,
    ...(href ? { href } : {}),
  };
}

// casework_get_case_procedure for one case, which its owner may call .
function caseProcedureRequest(supabase: NonNullable<ReturnType<typeof getSupabaseClient>>) {
  return (caseID: string) => supabase.rpc('casework_get_case_procedure', { p_case_id: caseID });
}

function withStepLabel(item: MemberCase, label: string | undefined): MemberCase {
  return label ? { ...item, stepLabel: label } : item;
}

function memberCase(row: CaseRow): MemberCase {
  return {
    id: row.id,
    ownerID: row.user_id,
    reference: row.reference,
    title: row.title,
    deadline: row.deadline,
    caseType: row.case_type,
    step: row.step,
    status: row.status,
    updatedAt: row.updated_at,
    timeZone: row.time_zone ?? null,
  };
}

function memberMessage(row: MessageRow): MemberMessage {
  // The projection is shared with responsive web: a redacted row can never be
  // rendered as text, and the notice key is resolved by the client.
  const projected = projectMessageBody(row);
  return {
    id: row.id,
    conversationID: row.conversation_id,
    senderKind: row.sender_kind === 'steward' ? 'steward' : 'member',
    senderName: row.sender_name,
    body: projected.body,
    readAt: row.read_at,
    createdAt: row.created_at,
    redactedAt: row.redacted_at ?? null,
    redactionReason: projected.reason,
    editedAt: row.edited_at ?? null,
    parentMessageID: row.parent_message_id ?? null,
  };
}

function conversationSummary(row: ConversationRow, messages: MessageRow[]): MemberConversation {
  const matching = messages.filter((message) => message.conversation_id === row.id);
  const latest = matching[0] ?? null;
  return {
    id: row.id,
    counterpartRole: 'steward',
    stewardUserId: row.steward_user_id ?? null,
    title: row.title,
    initials: row.initials,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // TEST-UG-SHARED-UNREAD-CONTRACT: one predicate, shared with the browser.
    unreadCount: directUnreadCount(matching),
    // SEC-UG-MESSAGE-BODY-LIFECYCLE: a redacted latest message must not
    // leave its old text sitting in the conversation row preview.
    latestMessage: latest ? (projectMessagePreview(latest).preview || null) : null,
  };
}

export function getSupabaseClient(): SupabaseClient | null {
  if (!mobileConfig.backendConfigured || !mobileConfig.supabaseUrl) return null;
  mobileSessionStorage ??= createBackendScopedSessionStorage(mobileConfig.supabaseUrl, nativeAuthGate.canWrite);
  client ??= createClient(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey, {
    global: { fetch: createFailClosedAuthFetch(mobileConfig.supabaseUrl), headers: { 'X-Client-Info': 'union-ground-expo/0.3' } },
    auth: {
      storage: mobileSessionStorage,
      storageKey: mobileAuthStorageKey,
      flowType: 'pkce',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      experimental: { passkey: false },
      // React Native has one auth process. Serialize complete auth operations
      // so one callback cannot replace this adapter's observed removal lineage
      // while an older cleanup is awaiting provider I/O.
      lock: processLock,
      lockAcquireTimeout: -1,
    },
  });
  return client;
}

// Ledger 530: notices are an invalidation signal, never another message store.
// Keep auth observation alive when the foreground socket is paused, so a late
// callback or pending getSession cannot survive a replacement account .
export function watchMemberNotificationInserts(userID: string, onInsert: () => void, onAccountChange: () => void) {
  const supabase = getSupabaseClient();
  let current = true;
  let ready = false;
  let active = false;
  let failed = false;
  let authRevision = 0;
  let channel: ReturnType<SupabaseClient['channel']> | null = null;
  let authSubscription: { unsubscribe(): void } | null = null;
  const stopChannel = () => {
    const retired = channel;
    channel = null; // invalidate callbacks before asynchronous removal
    if (retired && supabase) void supabase.removeChannel(retired).catch(() => undefined); // swallow-ok: polling remains available if socket removal fails
  };
  const remove = () => {
    current = false;
    ready = false;
    stopChannel();
    authSubscription?.unsubscribe();
    authSubscription = null;
  };
  const startChannel = () => {
    if (!supabase || !current || !ready || !active || failed || channel) return;
    try {
      const next = supabase.channel(`peer-notices:${userID}`);
      channel = next;
      let subscribed = false;
      next.on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'member_notifications', filter: `user_id=eq.${userID}`,
      }, (payload) => {
        if (current && ready && active && channel === next && payload.new.user_id === userID) onInsert();
      }).subscribe((status) => {
        if (channel === next && current && ready && active && status === 'SUBSCRIBED' && !subscribed) {
          subscribed = true;
          onInsert(); // close the gap between the first read and the socket joining
        }
        if (channel !== next || !['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) return;
        failed = true;
        stopChannel();
      });
    } catch {
      failed = true;
      stopChannel(); // swallow-ok: a refused socket leaves push and poll in place
    }
  };
  const observe = (session: Session | null) => {
    if (!current) return;
    if (session?.user.id !== userID) {
      remove();
      onAccountChange();
      return;
    }
    ready = true;
    startChannel();
  };
  if (supabase) {
    authSubscription = supabase.auth.onAuthStateChange((_event, session) => {
      authRevision += 1;
      observe(session); // synchronous invalidation; never await inside the auth lock
    }).data.subscription;
    if (!current) { authSubscription.unsubscribe(); authSubscription = null; }
    const revision = authRevision;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (current && revision === authRevision && !error) observe(data.session);
    }).catch(() => undefined); // swallow-ok: an unreadable session cannot start a socket; polling remains available
  }
  return {
    isCurrent: () => current && ready,
    setActive(next: boolean) {
      if (next !== active) failed = false;
      active = next;
      if (active) startChannel(); else stopChannel();
    },
    remove,
  };
}

export function createCapturedSessionRpcClient(capturedSession: Session): SupabaseClient {
  if (!mobileConfig.backendConfigured || !mobileConfig.supabaseUrl || !capturedSession.access_token) {
    throw new Error('The secure mobile backend is not configured.');
  }
  const capturedAccessToken = capturedSession.access_token;
  return createClient(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey, {
    accessToken: async () => capturedAccessToken,
    global: { fetch: createFailClosedAuthFetch(mobileConfig.supabaseUrl), headers: { 'X-Client-Info': 'union-ground-expo/0.3-captured-session' } },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

export type MobileWriteAcknowledgement<T> = { acknowledged: true; value: T; continuationCurrent: boolean };
export type MobileSessionWriter = {
  readonly userId: string | null;
  session(): Promise<Session>;
  client(): Promise<SupabaseClient>;
  check(): Promise<'current' | 'changed' | 'unavailable'>;
  isCurrent(): Promise<boolean>;
  acknowledged<T>(value: T): Promise<MobileWriteAcknowledgement<T>>;
};

// The screen/operation owner calls this synchronously, before any await.
export function captureSessionWriter(session: Session | null): MobileSessionWriter {
  return createSessionBoundWriter({ session, sharedClient: getSupabaseClient(), createSessionClient: createCapturedSessionRpcClient }) as MobileSessionWriter;
}

function isPersistedSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const candidate: { access_token?: unknown; refresh_token?: unknown; user?: unknown } = value;
  if (typeof candidate.access_token !== 'string' || !candidate.access_token) return false;
  if (typeof candidate.refresh_token !== 'string' || !candidate.refresh_token) return false;
  const user: unknown = candidate.user;
  if (!user || typeof user !== 'object') return false;
  const owner: { id?: unknown } = user;
  return typeof owner.id === 'string' && owner.id.length > 0;
}

// The persisted session exactly as stored, read without the auth client and
// so without its refresh. A bounded cold launch uses it only as the covered
// retry and sign-out handle of the fail-closed surface; it never authorizes
// protected state (BUG-UG-ANDROID-COLD-OFFLINE-BOOT-BLANK-20261001).
export async function readPersistedMobileSession(): Promise<Session | null> {
  getSupabaseClient();
  if (!mobileSessionStorage) return null;
  const stored = await mobileSessionStorage.getItem(mobileAuthStorageKey);
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  return isPersistedSession(parsed) ? parsed : null;
}

export async function clearCapturedMobileSessionLocally(capturedSession: Session): Promise<boolean> {
  getSupabaseClient();
  if (!mobileSessionStorage) throw new Error('The secure mobile backend is not configured.');
  return mobileSessionStorage.removeSessionIfMatches(mobileAuthStorageKey, {
    accessToken: capturedSession.access_token,
    refreshToken: capturedSession.refresh_token,
  });
}

/**
 * REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009 widened this to the two
 * GoTrue scopes. `local` revokes the captured session; `global` revokes every
 * session of the account, which is what Account > Sessions' "Sign out
 * everywhere" needs and what makes a second device re-authenticate.
 */
type CapturedSessionRevocationScope = 'local' | 'global';

type CapturedSessionRevocationDependencies = {
  signOut(
    accessToken: string,
    scope: CapturedSessionRevocationScope,
  ): Promise<{ error: { status?: unknown } | null }>;
  compareAndClear(): Promise<boolean>;
};

// auth-js 2.110.7 turns an HTTP session_not_found into AuthSessionMissingError
// (status 400, no code). Only an explicit-token request reaches these helpers,
// so the error is a server answer, never the client's own "no session" check.
// Every client uses the HTTP guard above: all 5xx are refused before parsing.
function serverSessionAlreadyGone(error: { name?: unknown } | null | undefined): boolean {
  return error?.name === 'AuthSessionMissingError';
}

/**
 * Definitive evidence that a captured session no longer exists on the server:
 * Auth answers GET /user for that exact access token with session_not_found
 * (BUG-UG-MOBILE-REVOKED-SESSION-STUCK-20261002). A live user, an
 * expired or refused token, a 5xx or a transport failure is not proof and
 * returns false, so callers stay fail-closed. Runs on a throwaway client so
 * auth-js's own cleanup never touches the persisted session.
 */
export async function capturedSessionIsGone(capturedSession: Session): Promise<boolean> {
  if (!mobileConfig.backendConfigured || !mobileConfig.supabaseUrl || !capturedSession.access_token) return false;
  try {
    const probe = createClient(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey, {
      global: { fetch: createFailClosedAuthFetch(mobileConfig.supabaseUrl) },
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { error } = await probe.auth.getUser(capturedSession.access_token);
    return serverSessionAlreadyGone(error);
  } catch {
    return false;
  }
}

export async function revokeCapturedSessionWithLocalCompareAndSwap(
  capturedAccessToken: string,
  dependencies: CapturedSessionRevocationDependencies,
  scope: CapturedSessionRevocationScope = 'local',
): Promise<boolean> {
  let error: unknown;
  try {
    ({ error } = await dependencies.signOut(capturedAccessToken, scope));
  } catch (transportError) {
    throw tagSignOutProvenance(
      new Error('Union Ground could not securely close this session.'),
      classifySignOutFailure(transportError),
    );
  }
  // An expired or refused access token does not prove that the same server
  // session's rotated refresh credential was revoked. Never erase the local
  // lineage on an ambiguous provider error; foreground revalidation can clear
  // a definitively invalid session, or the member can retry with its newest
  // same-lineage token.
  // Exception: Auth answering session_not_found (auth-js raises it as
  // AuthSessionMissingError) proves the server session row, and with it every
  // refresh credential, is already gone, so the local copy can be cleared.
  // That exception does not extend to a global revoke. This session being
  // absent says nothing about the account's other devices, and GoTrue never
  // reached the user-wide delete, so accepting it would clear this device and
  // silently leave every other session alive — the one outcome "Sign out
  // everywhere" may not produce (REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009).
  if (error && !(scope === 'local' && serverSessionAlreadyGone(error))) {
    throw tagSignOutProvenance(
      new Error(scope === 'global'
        ? 'Union Ground could not sign out your other devices.'
        : 'Union Ground could not securely close this session.'),
      classifySignOutFailure(error),
    );
  }
  return dependencies.compareAndClear();
}

export async function revokeAndClearCapturedMobileSession(
  capturedSession: Session,
  scope: CapturedSessionRevocationScope = 'local',
): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  // GoTrue's explicit JWT path revokes the captured session even if the main
  // client has since persisted another account. It does not mutate local
  // storage; the compare-and-clear below owns that exact operation.
  return revokeCapturedSessionWithLocalCompareAndSwap(capturedSession.access_token, {
    signOut: (accessToken, revocationScope) => supabase.auth.admin.signOut(accessToken, revocationScope),
    compareAndClear: () => clearCapturedMobileSessionLocally(capturedSession),
  }, scope);
}

export async function assertFreshMobileCalendarSession(): Promise<string> {
  // REQ-UNION-GROUND-MOBILE-NATIVE-CALENDAR-EXPORT-20260825 item 4: SAMPLE
  // fixtures never reach a real device calendar. Refused before any auth or
  // data read so the native composer is never invoked (item 5, fail closed).
  if (isLiveSampleBackend(mobileConfig)) throw new Error('Calendar export is not offered on SAMPLE.');
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const userID = typeof userData.user?.id === 'string' ? userData.user.id.trim() : '';
  if (userError || !userID) throw new Error('Calendar export requires a current session.');
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (
    assuranceError
    || !assurance
    || !['aal1', 'aal2'].includes(String(assurance.currentLevel ?? ''))
    || !['aal1', 'aal2'].includes(String(assurance.nextLevel ?? ''))
  ) throw new Error('Calendar export assurance could not be confirmed.');
  if (sessionRequiresTotp(assurance)) throw new Error('Calendar export requires MFA revalidation.');
  return userID;
}

export function isMfaRequiredRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === '42501' && /mfa required/i.test(String(candidate.message ?? ''));
}

export function isNotAuthorizedRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== '42501') return false;
  const message = String(candidate.message ?? '');
  // MFA is classified first by isMfaRequiredRpcError; the remaining
  // list_organization_integrations 42501 envelopes are authorization
  // denials (role loss, missing session, or lost membership).
  if (/mfa required/i.test(message)) return false;
  return /not authorized|authentication required|active organization membership required/i.test(message);
}

export async function loadMobileIntegrationProviders(): Promise<MobileIntegrationProvider[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('list_organization_integrations');
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Integration state could not be confirmed.');
  return data.flatMap((entry: Record<string, unknown>) => {
    if (typeof entry.id !== 'string' || typeof entry.provider !== 'string' || typeof entry.status !== 'string') return [];
    return [{
      id: entry.id,
      provider: entry.provider,
      status: entry.status,
      allowChapterOverrides: entry.allowChapterOverrides === true,
    }];
  });
}

// Directory sync (SCIM) is held with single sign-on for its release date
// . Read as the web Integrations page reads it: a held answer
// (released false), a refusal or a failed read all read as held.
export async function loadMobileScimReleased(): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  const { data, error }: { data: unknown; error: unknown } = await supabase.rpc('get_scim_control');
  if (error || !data || typeof data !== 'object') return false;
  return (data as Record<string, unknown>).released !== false;
}

export async function signInWithEmailPassword(
  email: string,
  password: string,
  platform: NativeSignInPlatform | null = null,
  onAdopted?: (session: Session) => void,
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  // A fetch rejection before any response shows the connection message.
  // Every HTTP answer stays flat across credential and provider failures,
  // except the proxy's address-independent 429, which gets its own "wait"
  // message. The portal proxy records refused attempts for the organization.
  await signInThroughPortalPasswordProxy(
    { portalOrigin: mobileConfig.portalBaseUrl, email, password, platform },
    { fetch: (...args) => fetch(...args), setSession: async (tokens) => {
      const result = await supabase.auth.setSession(tokens);
      if (onAdopted && !result.error && result.data?.session) onAdopted(result.data.session);
      return result;
    } },
  );
}

export async function verifyCapturedMobileSession(session: Session) {
  if (!mobileConfig.supabaseUrl) throw new Error('The secure mobile backend is not configured.');
  const probe = createClient(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey, {
    global: { fetch: createFailClosedAuthFetch(mobileConfig.supabaseUrl) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try { return await probe.auth.getUser(session.access_token); }
  finally {
    try { await probe.auth.dispose?.(); }
    catch { /* swallow-ok: isolated-probe disposal cannot change the authorization result */ }
  }
}

// Account proofs belong to the original Auth session, including its lineage.
// Use the shared binder's checked read, then an isolated Auth client: captured
// RPC clients deliberately have no mutable Auth namespace.
async function accountSession(writer: MobileSessionWriter, initiatingSession?: Session | null): Promise<Session> {
  const current = await writer.session();
  if (!initiatingSession || !accessTokensShareSessionLineage(current.access_token, initiatingSession.access_token)) {
    throw new Error('The account changed before this was sent.');
  }
  return current;
}

async function accountAuthClient(writer: MobileSessionWriter, initiatingSession?: Session | null): Promise<SupabaseClient> {
  const current = await accountSession(writer, initiatingSession);
  if (!mobileConfig.supabaseUrl) throw new Error('The secure mobile backend is not configured.');
  const isolated = createClient(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey, {
    global: { fetch: createFailClosedAuthFetch(mobileConfig.supabaseUrl) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const seeded = await isolated.auth.setSession(current);
  if (seeded.error || seeded.data.session?.user.id !== writer.userId) throw new Error('Sign in again.');
  return isolated;
}

export async function updateSignedInPassword(password: string, currentPassword: string, initiatingSession?: Session | null): Promise<Session | null> {
  const writer = captureSessionWriter(initiatingSession ?? null);
  if (password.length < NEW_PASSWORD_MIN) throw new Error(NEW_PASSWORD_RULE.en);
  if (!currentPassword) throw new Error('Enter your current password to change it.');
  const supabase = await accountAuthClient(writer, initiatingSession);
  let updatedSession: Session | null = null;
  try {
    // Keep the existing session (including staff AAL2); Auth validates the proof.
    const { error } = await supabase.auth.updateUser({ password, current_password: currentPassword });
    if (error?.code === 'current_password_required' || error?.code === 'current_password_invalid' || error?.code === 'current_password_mismatch') {
      throw new Error('Check your current password and try again. If you do not know it, use Forgot password on the sign-in screen.');
    }
    if (error?.code === 'reauthentication_needed' || error?.code === 'reauthentication_not_valid') {
      throw new Error('For your security, sign out, sign in again, then try changing your password.');
    }
    if (error) throw new Error('Your password change could not be confirmed. Check your connection and try again.');
    // Its own call, after the password is safe: writing user_metadata fires the
    // case-graph bookkeeping lock, which must never roll the password back. A
    // null value deletes the emailed-password stamp the Home prompt reads.
    try {
      const current = await accountSession(writer, initiatingSession);
      const metadataSeed = await supabase.auth.setSession(current);
      if (metadataSeed.error) throw metadataSeed.error;
      const metadata = await supabase.auth.updateUser({ data: { union_ground_password_issued_at: null } });
      if (!metadata.error) {
        const live = await accountSession(writer, initiatingSession);
        const operation = nativeAuthGate.begin(live);
        try {
          operation.stage(live);
          const installed = await getSupabaseClient()!.auth.setSession(live);
          if (operation.current() && !installed.error && installed.data.session
            && installed.data.session.user.id === writer.userId
            && accessTokensShareSessionLineage(live.access_token, installed.data.session.access_token)) updatedSession = installed.data.session;
        } finally { operation.finish(); }
      }
    } catch { /* the accepted password remains changed; a later refresh can clear its prompt */ }
    return updatedSession;
  } finally {
    try { await supabase.auth.dispose?.(); } catch { /* swallow-ok: isolated client disposal cannot undo the password acknowledgement */ }
  }
}

function mobileStaffRoles(value: unknown): MobileStaffRole[] {
  if (!Array.isArray(value)) return [];
  const roles: unknown[] = value;
  return [...new Set(roles.filter((role): role is MobileStaffRole => (
    role === 'organizer' || role === 'steward' || role === 'coordinator' || role === 'advisor' || role === 'admin' || role === 'vp'
  )))];
}

export async function loadMobileChapterMemberships(
  onSelection?: (selected: MobileMembershipSelection[]) => void,
  onReadAvailability?: (available: boolean) => void,
): Promise<MobileChapterMembership[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error, status } = await supabase.rpc('get_my_chapter_memberships');
  if (error) throw Object.assign(error, typeof status === 'number' ? { status } : {});
  if (!Array.isArray(data)) throw new Error('Campaign authorization could not be confirmed.');
  // Keep organization-only rows out of chapter navigation, but do not discard
  // their independently confirmed ownership boundary when staff reads fail.
  onSelection?.((data as MobileChapterMembershipWire[]).flatMap((entry) => (
    entry.selected === true && typeof entry.name === 'string' && typeof entry.joinedAt === 'string'
      && (typeof entry.chapterId === 'string' || (entry.chapterId === null && typeof entry.organizationId === 'string'))
      ? [{ chapterID: typeof entry.chapterId === 'string' ? entry.chapterId : null, organizationID: typeof entry.organizationId === 'string' ? entry.organizationId : null }]
      : []
  )).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const memberships = (data as MobileChapterMembershipWire[]).flatMap((entry) => {
    if (
      typeof entry.chapterId !== 'string'
      || typeof entry.name !== 'string'
      || typeof entry.joinedAt !== 'string'
    ) return [];
    return [{
      chapterID: entry.chapterId,
      organizationID: typeof entry.organizationId === 'string' ? entry.organizationId : null,
      name: entry.name,
      region: typeof entry.region === 'string' ? entry.region : null,
      selected: entry.selected === true,
      pinned: entry.pinned === true,
      lastSelectedAt: typeof entry.lastSelectedAt === 'string' ? entry.lastSelectedAt : null,
      joinedAt: entry.joinedAt,
      roles: mobileStaffRoles(entry.roles),
      organizationRoles: mobileStaffRoles(entry.organizationRoles),
      chapterRoles: mobileStaffRoles(entry.chapterRoles),
    }];
  });
  onReadAvailability?.(data.every((entry: MobileChapterMembershipWire) => (
    ((typeof entry.chapterId === 'string' && entry.chapterId.length > 0)
      || (entry.chapterId === null && typeof entry.organizationId === 'string' && entry.organizationId.length > 0))
    && typeof entry.name === 'string' && typeof entry.joinedAt === 'string' && typeof entry.selected === 'boolean'
    && ((typeof entry.organizationId === 'string' && entry.organizationId.length > 0) || entry.organizationId === null)
  )));
  return memberships;
}

export async function loadMobileStaffScope(onReadAvailability?: (available: boolean) => void): Promise<MobileStaffScope> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error, status } = await supabase.rpc('get_my_mobile_staff_scope');
  if (error) throw Object.assign(error, typeof status === 'number' ? { status } : {});
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    onReadAvailability?.(false);
    return { organizationID: null, roles: [], chapterRoles: [], staffAuthorized: false };
  }
  const row = data as Record<string, unknown>;
  onReadAvailability?.(typeof row.staffAuthorized === 'boolean' && Array.isArray(row.roles) && Array.isArray(row.chapterRoles)
    && row.roles.every((role: unknown) => typeof role === 'string') && row.chapterRoles.every((role: unknown) => typeof role === 'string')
    && ((typeof row.organizationId === 'string' && row.organizationId.length > 0) || row.organizationId === null));
  return {
    organizationID: typeof row.organizationId === 'string' ? row.organizationId : null,
    roles: mobileStaffRoles(row.roles),
    chapterRoles: mobileStaffRoles(row.chapterRoles),
    staffAuthorized: row.staffAuthorized === true,
  };
}

export async function loadMobileOrganizationAnalyticsSnapshot(): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error }: { data: unknown; error: unknown } = await supabase.rpc('get_organization_analytics_snapshot');
  if (error) throw error;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Organization analytics could not be verified.');
  }
  return data as Record<string, unknown>;
}

async function securityDefinerRpc(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const request = supabase.rpc(name, args);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return data;
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} could not be verified.`);
  return value as Record<string, unknown>;
}

export async function loadMobileOrganizationIntelligenceSnapshot(selectedHat: string): Promise<Record<string, unknown>> {
  return objectPayload(await securityDefinerRpc('get_organization_intelligence_snapshot', {
    p_selected_hat: selectedHat,
  }), 'Organization intelligence');
}

// REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001: the member banner reads the
// member-safe projection only. The organization comes from the session.
export async function loadMobileMemberIssueSignals(): Promise<unknown> {
  return securityDefinerRpc('get_issue_intelligence_signals', { p_selected_hat: 'member' });
}

// Member-facing org-structure reads. The names come from the corresponding change
// §5, which the web/backend lane owns; native never spells an RPC name of its
// own here. Both are security-definer and derive the caller's organization and
// chapter from the session, so neither takes a tenant key, and both go through
// the same definer helper the other definer reads use.
// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
//: one authenticated page view per feature screen
// focus, through the RPC the web client also calls. The organization is
// session-derived on the server; the native app never names one.
// The signal is the Product analytics switch's: turning it off aborts a view
// still waiting on authentication (analyticsPreference.ts).
export async function recordMobileFeaturePageView(writer: MobileSessionWriter, page: string, hat: string, signal: AbortSignal): Promise<unknown> {
  return businessRpc(writer, 'record_workspace_page_view', {
    p_page: page,
    p_hat: hat,
    p_organization_id: null,
  }, signal);
}

export async function loadMobileMemberChapterStewards(): Promise<unknown> {
  return securityDefinerRpc(MEMBER_ORG_RPC_NAMES.stewardRoster);
}

export async function loadMobileMemberOrganizationStructure(): Promise<unknown> {
  return securityDefinerRpc(MEMBER_ORG_RPC_NAMES.organizationStructure);
}

export async function startMobileMemberStewardConversation(writer: MobileSessionWriter, stewardUserID: string, body: string): Promise<unknown> {
  const client = await writer.client();
  const { data, error } = await client.rpc(MEMBER_ORG_RPC_NAMES.stewardConversation, {
    p_steward_user_id: stewardUserID,
    p_body: body,
  });
  if (error) throw error;
  return data;
}

export async function loadMobileCollectiveActions(selectedHat: string, limit = 25, offset = 0): Promise<Record<string, unknown>> {
  return objectPayload(await securityDefinerRpc('get_collective_actions', {
    p_selected_hat: selectedHat,
    p_limit: limit,
    p_offset: offset,
  }), 'Collective actions');
}

export async function saveMobileOrganizationChartNode(writer: MobileSessionWriter, selectedHat: string, input: Record<string, unknown>): Promise<void> {
  await businessRpc(writer, 'save_organization_chart_node', { p_selected_hat: selectedHat, ...input });
}

export async function saveMobileOrganizationRelationship(writer: MobileSessionWriter, selectedHat: string, input: Record<string, unknown>): Promise<void> {
  await businessRpc(writer, 'save_organization_relationship', { p_selected_hat: selectedHat, ...input });
}

export async function saveMobileOrganizationTopicProgress(writer: MobileSessionWriter, selectedHat: string, input: Record<string, unknown>): Promise<void> {
  await businessRpc(writer, 'save_organization_topic_progress', { p_selected_hat: selectedHat, ...input });
}

export async function saveMobileOrganizationTimelineEvent(writer: MobileSessionWriter, selectedHat: string, input: Record<string, unknown>): Promise<void> {
  await businessRpc(writer, 'save_organization_timeline_event', { p_selected_hat: selectedHat, ...input });
}

export async function saveMobileCollectiveAction(writer: MobileSessionWriter, selectedHat: string, input: Record<string, unknown>): Promise<void> {
  await businessRpc(writer, 'save_digital_action', { p_selected_hat: selectedHat, ...input });
}

export async function toggleMobileCollectiveActionParticipation(writer: MobileSessionWriter, input: {
  actionId: string;
  participationKind: string;
  joined: boolean;
}): Promise<void> {
  await businessRpc(writer, 'toggle_digital_action_participation', {
    p_action_id: input.actionId,
    p_participation_kind: input.participationKind,
    p_joined: input.joined,
  });
}

export async function requestMobileCollectiveActionExport(writer: MobileSessionWriter, selectedHat: string, actionId: string, participationKind: string): Promise<Record<string, unknown>> {
  return objectPayload(await businessRpc(writer, 'request_digital_action_participant_export', {
    p_selected_hat: selectedHat,
    p_action_id: actionId,
    p_participation_kind: participationKind,
  }), 'Participant export');
}

export async function loadMobileOrganizationAnalyticsWorkspace(): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error }: { data: unknown; error: unknown } = await supabase.rpc('get_organization_analytics_workspace');
  if (error) throw error;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Organization analytics workspace could not be verified.');
  }
  return data as Record<string, unknown>;
}

export async function loadMobileMemberReportCard(): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error }: { data: unknown; error: unknown } = await supabase.rpc('get_my_analytics_report_card');
  if (error) throw error;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Your report card could not be verified.');
  }
  return data as Record<string, unknown>;
}

export type MobileOperationsAuditEvent = {
  id: string;
  domain: string;
  eventType: string;
  occurredAt: string;
  // The one metadata field the ledger label reads .
  reviewStatus: string | null;
};

export type MobileOperationsJobHealth = {
  jobName: string;
  organizationId: string;
  lastRunId: string | null;
  lastStatus: 'in_progress' | 'completed' | 'failed' | 'skipped' | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  failureCode: string | null;
  acknowledged: boolean;
  remediation: 'acknowledge' | 'request_retry' | null;
};

function auditReviewStatus(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).reviewStatus;
  return typeof value === 'string' ? value : null;
}

export async function loadMobileOperationsAudit(): Promise<MobileOperationsAuditEvent[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('list_organization_audit_ledger', {
    p_limit: 50,
    p_before: null,
    p_before_id: null,
    p_domain: null,
    p_action: null,
  });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('The organization audit log could not be confirmed.');
  return data.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (
      typeof item.id !== 'string'
      || typeof item.domain !== 'string'
      || typeof item.eventType !== 'string'
      || typeof item.occurredAt !== 'string'
    ) return [];
    return [{
      id: item.id,
      domain: item.domain,
      eventType: item.eventType,
      occurredAt: item.occurredAt,
      reviewStatus: auditReviewStatus(item.metadata),
    }];
  });
}

export async function loadMobileOperationsJobHealth(): Promise<MobileOperationsJobHealth[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('list_organization_job_health');
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Background job health could not be confirmed.');
  return data.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    if (typeof item.jobName !== 'string' || typeof item.organizationId !== 'string') return [];
    const lastStatus = typeof item.lastStatus === 'string'
      && ['in_progress', 'completed', 'failed', 'skipped'].includes(item.lastStatus)
      ? item.lastStatus as MobileOperationsJobHealth['lastStatus']
      : null;
    const remediation = item.remediation === 'acknowledge' || item.remediation === 'request_retry'
      ? item.remediation
      : null;
    return [{
      jobName: item.jobName,
      organizationId: item.organizationId,
      lastRunId: typeof item.lastRunId === 'string' ? item.lastRunId : null,
      lastStatus,
      lastStartedAt: typeof item.lastStartedAt === 'string' ? item.lastStartedAt : null,
      lastFinishedAt: typeof item.lastFinishedAt === 'string' ? item.lastFinishedAt : null,
      failureCode: typeof item.failureCode === 'string' ? item.failureCode : null,
      acknowledged: item.acknowledged === true,
      remediation,
    }];
  });
}

async function remediateMobileOperationsJob(
  writer: MobileSessionWriter, rpc: 'acknowledge_organization_job_run' | 'request_organization_job_retry',
  jobName: string,
  runId: string,
): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc(rpc, { p_job_name: jobName, p_run_id: runId });
  if (error) throw error;
}

export async function acknowledgeMobileOperationsJob(writer: MobileSessionWriter, jobName: string, runId: string): Promise<void> {
  await remediateMobileOperationsJob(writer, 'acknowledge_organization_job_run', jobName, runId);
}

export async function requestMobileOperationsJobRetry(writer: MobileSessionWriter, jobName: string, runId: string): Promise<void> {
  await remediateMobileOperationsJob(writer, 'request_organization_job_retry', jobName, runId);
}

export async function switchMobileChapter(writer: MobileSessionWriter, chapterID: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('switch_my_chapter', { p_chapter_id: chapterID });
  if (error) throw new Error('That campaign is no longer available to this account.');
}

export async function setMobileChapterPin(writer: MobileSessionWriter, chapterID: string, pinned: boolean): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('set_my_chapter_pin', { p_chapter_id: chapterID, p_pinned: pinned });
  if (error) throw new Error('That campaign pin could not be changed.');
}

export async function loadMobileChapterBinding(chapterID: string): Promise<MobileChapterBinding | null> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('backend-unavailable');
  // The binding row is shaped by the pure lib normalizer, so the wire type is
  // declared as unknown here rather than read as any.
  const { data, error } = await supabase.from('chapter_union_org_bindings')
    .select('chapter_id,union_org_id,status,public_note,union_orgs(name)')
    .eq('chapter_id', chapterID).limit(1)
    .returns<unknown[]>();
  if (error) throw error;
  return normalizeChapterBinding(Array.isArray(data) ? data[0] : null);
}

export async function searchMobileUnionOrganizations(query: string): Promise<MobileUnionOrganization[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('backend-unavailable');
  const request = buildRegistryQuery(supabase, registrySearchPlan(query)) as PromiseLike<{ data: unknown; error: unknown }> | null;
  if (!request) return [];
  const { data, error } = await request;
  if (error) throw error;
  return normalizeUnionOrganizations(data);
}

export async function requestMobileChapterBinding(writer: MobileSessionWriter, unionOrgID: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('backend-unavailable');
  const { error } = await supabase.rpc('request_chapter_union_org_binding', { p_union_org_id: unionOrgID });
  if (error) throw new Error('binding-request-failed');
}

export async function loadMobileHandshakeDocuments(chapterID: string): Promise<MobileHandshakeDocument[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('backend-unavailable');
  const { data, error } = await supabase.from('chapter_documents')
    .select('id,title,document_type,updated_at')
    .eq('chapter_id', chapterID).eq('status', 'published')
    .order('updated_at', { ascending: false }).limit(100).returns<Record<string, unknown>[]>();
  if (error) throw error;
  return (Array.isArray(data) ? data : []).flatMap((row: Record<string, unknown>) => (
    typeof row.id === 'string' && typeof row.title === 'string' && typeof row.updated_at === 'string'
      ? [{ id: row.id, title: row.title, documentType: String(row.document_type || ''), updatedAt: row.updated_at }]
      : []
  ));
}

export async function shareMobileHandshakeDocument(writer: MobileSessionWriter, handshakeID: string, documentID: string, idempotencyKey: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('backend-unavailable');
  const { error } = await supabase.rpc('share_chapter_handshake_document', {
    p_handshake_id: handshakeID,
    p_document_id: documentID,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw new Error('document-share-failed');
}

export async function loadMobileHandshakes(currentChapterID: string): Promise<MobileHandshake[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.from('chapter_handshakes')
    .select('id,chapter_id,receiving_chapter_id,title,purpose,data_scope,status,updated_at,union_orgs(name)')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  const chapterIDs = [...new Set(data.flatMap((row: Record<string, unknown>) => (
    typeof row.chapter_id === 'string' ? [row.chapter_id] : []
  )))];
  const { data: bindings, error: bindingError } = chapterIDs.length
    ? await supabase.from('chapter_union_org_bindings')
      .select('chapter_id,union_orgs(name)')
      .eq('status', 'verified')
      .in('chapter_id', chapterIDs)
    : { data: [], error: null };
  if (bindingError) throw bindingError;
  const organizationByChapter = new Map((Array.isArray(bindings) ? bindings : []).flatMap((row: Record<string, unknown>) => {
    const raw = Array.isArray(row.union_orgs) ? row.union_orgs[0] : row.union_orgs;
    if (typeof row.chapter_id !== 'string' || !raw || typeof raw !== 'object' || !('name' in raw)) return [];
    return [[row.chapter_id, String((raw as { name?: unknown }).name ?? 'Sister campaign')] as const];
  }));
  return data.flatMap((row: Record<string, unknown>) => {
    if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.purpose !== 'string'
        || typeof row.data_scope !== 'string' || typeof row.status !== 'string' || typeof row.updated_at !== 'string') return [];
    const organization = Array.isArray(row.union_orgs) ? row.union_orgs[0] : row.union_orgs;
    const receivingOrganizationName = organization && typeof organization === 'object' && 'name' in organization
      ? String((organization as { name?: unknown }).name ?? 'Sister campaign') : 'Sister campaign';
    const incoming = row.receiving_chapter_id === currentChapterID;
    const partnerName = incoming && typeof row.chapter_id === 'string'
      ? organizationByChapter.get(row.chapter_id) ?? 'Sister campaign'
      : receivingOrganizationName;
    return [{
      id: row.id,
      title: row.title,
      purpose: row.purpose,
      dataScope: row.data_scope as MobileHandshake['dataScope'],
      status: row.status as MobileHandshake['status'],
      direction: incoming ? 'incoming' : 'outgoing',
      partnerName,
      updatedAt: row.updated_at,
    }];
  });
}

export async function loadMobileHandshakeTargets(currentChapterID: string): Promise<MobileHandshakeTarget[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.from('chapter_union_org_bindings')
    .select('chapter_id,union_orgs(id,name,city,state,affiliation)')
    .eq('status', 'verified')
    .limit(250);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).flatMap((row: Record<string, unknown>) => {
    if (row.chapter_id === currentChapterID) return [];
    const raw = Array.isArray(row.union_orgs) ? row.union_orgs[0] : row.union_orgs;
    if (!raw || typeof raw !== 'object') return [];
    const organization = raw as Record<string, unknown>;
    if (typeof organization.id !== 'string' || typeof organization.name !== 'string') return [];
    return [{
      id: organization.id,
      name: organization.name,
      location: [organization.city, organization.state].filter((part) => typeof part === 'string' && part).join(', '),
      affiliation: typeof organization.affiliation === 'string' ? organization.affiliation : '',
    }];
  });
}

export async function requestMobileHandshake(writer: MobileSessionWriter, fields: {
  partnerOrgID: string;
  title: string;
  purpose: string;
  dataScope: MobileHandshake['dataScope'];
  idempotencyKey: string;
}): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('request_chapter_handshake', {
    p_partner_org_id: fields.partnerOrgID,
    p_title: fields.title.trim(),
    p_purpose: fields.purpose.trim(),
    p_data_scope: fields.dataScope,
    p_idempotency_key: fields.idempotencyKey,
  });
  if (error) throw new Error('The sister campaign is no longer verified or the request was not confirmed. Refresh and try again.');
}

export async function respondMobileHandshake(writer: MobileSessionWriter, handshakeID: string, decision: 'accept' | 'decline', idempotencyKey: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('respond_chapter_handshake', {
    p_handshake_id: handshakeID, p_decision: decision, p_idempotency_key: idempotencyKey,
  });
  if (error) throw new Error('The request changed or is no longer authorized. Refresh and review it again.');
}

export async function countersignMobileHandshake(writer: MobileSessionWriter, handshakeID: string, idempotencyKey: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('countersign_chapter_handshake', {
    p_handshake_id: handshakeID, p_idempotency_key: idempotencyKey,
  });
  if (error) throw new Error('Both campaign signatures could not be confirmed. Refresh and try again.');
}

export async function closeMobileHandshake(writer: MobileSessionWriter, handshakeID: string, idempotencyKey: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('close_chapter_handshake', {
    p_handshake_id: handshakeID, p_idempotency_key: idempotencyKey,
  });
  if (error) throw new Error('The request could not be closed. Refresh and try again.');
}

export async function loadMobileHealthPortfolio(): Promise<MobileHealthChapter[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('get_chapter_health_portfolio');
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Campaign health dates could not be verified.');
  if (data.some((entry) => (
    !entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof (entry as Record<string, unknown>).databaseDate !== 'string'
  ))) throw new Error('Campaign health dates could not be verified.');
  return data as MobileHealthChapter[];
}

export async function recordMobileHealthSnapshot(
  writer: MobileSessionWriter, chapterID: string,
  measuredOn: string,
  drivers: MobileHealthDrivers,
): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('record_chapter_health_snapshot', {
    p_chapter_id: chapterID,
    p_measured_on: measuredOn,
    p_participation: drivers.participation,
    p_case_timeliness: drivers.caseTimeliness,
    p_steward_capacity: drivers.stewardCapacity,
    p_training_coverage: drivers.trainingCoverage,
    p_communication_reach: drivers.communicationReach,
    p_governance_readiness: drivers.governanceReadiness,
  });
  if (error) throw new Error('The health snapshot was not confirmed. Check the date, measures, and your leadership access.');
}

export async function addMobileHealthCoaching(writer: MobileSessionWriter, chapterID: string, summary: string, nextAction: string, attentionLevel: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('add_chapter_health_coaching', {
    p_chapter_id: chapterID, p_summary: summary.trim(), p_next_action: nextAction.trim(), p_attention_level: attentionLevel,
  });
  if (error) throw new Error('The coaching note was not confirmed. Refresh your authorization and try again.');
}

export async function loadMobileAppointments(): Promise<MobileAppointment[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.from('member_appointments')
    .select('id,starts_at,ends_at,status,appointment_type,reason_category')
    .order('starts_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((row) => ({
    id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, status: row.status,
    appointmentType: row.appointment_type, reasonCategory: row.reason_category,
  })) as MobileAppointment[];
}

export async function loadMobileSupervisedAppointments(): Promise<MobileAppointment[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('list_chapter_appointments', {
    p_after_starts: null,
    p_after_id: null,
    p_limit: 50,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    appointmentType: row.appointment_type,
    memberName: row.member_name,
    stewardName: row.steward_name,
  })) as MobileAppointment[];
}

export async function loadMobileAppointmentHistory(appointmentID: string, before: { createdAt: string; id: string } | null = null): Promise<MobileAppointmentHistory> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('get_appointment_history', {
    p_appointment_id: appointmentID, p_before: before?.createdAt ?? null, p_before_id: before?.id ?? null, p_limit: 30,
  });
  //: 42501 "history unavailable" is the RPC's answer for an appointment
  // that is gone or not this account's; only that is tagged gone.
  if (error?.code === '42501' && /history unavailable/i.test(error.message ?? '')) throw calendarRecordGone('One-on-one history could not be loaded.');
  if (error || !data || typeof data !== 'object') throw new Error('One-on-one history could not be loaded.');
  return data as unknown as MobileAppointmentHistory;
}

export async function prepareAuthorizedAppointmentCalendarExport(
  appointmentID: string,
  nowMs: number,
): Promise<CalendarExportPayload> {
  const authorizedUserID = await assertFreshMobileCalendarSession();
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('get_appointment_history', {
    p_appointment_id: appointmentID,
    p_before: null,
    p_before_id: null,
    p_limit: 1,
  });
  if (await assertFreshMobileCalendarSession() !== authorizedUserID) {
    throw new Error('Calendar export authorization changed.');
  }
  const rawAppointment = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).appointment
    : null;
  //  (M2-11): get_appointment_history answers 42501 "history unavailable"
  // when the appointment is gone or not this account's; only that, or an
  // answer with no appointment, is told as "gone". A failed read is not.
  const gone = error
    ? error.code === '42501' && /history unavailable/i.test(error.message ?? '')
    : !rawAppointment;
  if (gone) throw calendarRecordGone('One-on-one export is no longer authorized.');
  if (error || !rawAppointment || typeof rawAppointment !== 'object' || Array.isArray(rawAppointment)) {
    throw new Error('One-on-one export is no longer authorized.');
  }
  const row = rawAppointment as Record<string, unknown>;
  if (
    row.id !== appointmentID
    || typeof row.startsAt !== 'string'
    || typeof row.endsAt !== 'string'
    || !['confirmed', 'cancelled', 'completed', 'no_show'].includes(String(row.status ?? ''))
  ) throw new Error('One-on-one export is no longer authorized.');
  const freshAppointment: MobileAppointment = {
    id: appointmentID,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status as MobileAppointment['status'],
    appointmentType: '',
  };
  const { calendarExportPayloadForAppointment } = await import('./nativeCalendarExport');
  const payload = calendarExportPayloadForAppointment(freshAppointment, nowMs);
  if (!payload) throw calendarRecordGone('One-on-one export is no longer authorized.');
  return payload;
}

export async function loadMobileConnectionReadiness(): Promise<MobileConnectionReadiness[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.from('chapter_connection_readiness')
    .select('chapter_id,capability,status,provider_label,public_message,updated_at')
    .order('capability');
  if (error) throw error;
  return (Array.isArray(data) ? data as Record<string, unknown>[] : []).map((row) => ({
    capability: row.capability,
    status: row.status,
    providerLabel: row.provider_label,
    publicMessage: row.public_message,
    updatedAt: row.updated_at,
    chapterID: typeof row.chapter_id === 'string' && row.chapter_id ? row.chapter_id : null,
  })) as MobileConnectionReadiness[];
}

export async function requestMobileConnectionSetup(writer: MobileSessionWriter, capability: MobileConnectionReadiness['capability'], providerLabel = ''): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('request_chapter_connection_setup', {
    p_capability: capability, p_provider_label: providerLabel,
  });
  if (error) throw new Error('The setup request was not confirmed. Refresh your admin authorization and try again.');
}

// Chapter-membership administration. Every call below is one audited RPC
// with the exact argument names the migration declares; the database repeats
// the authorization check after taking its tenant lock, so a screen that
// offered a wider action would only earn a refusal.

export async function loadMobileAdminChapterScope(): Promise<MobileAdminScope | null> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('get_admin_org_structure');
  if (error) throw new Error('Your administrator scope could not be confirmed.');
  return normalizeAdminScope(data);
}

export async function loadMobileChapterUnits(chapterID: string): Promise<MobileChapterUnit[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const result: { data: unknown; error: unknown } = await supabase.rpc('list_chapter_units');
  if (result.error || !Array.isArray(result.data)) throw new Error('Campaign units could not be confirmed.');
  const rows: unknown[] = result.data;
  return normalizeChapterUnits(rows, chapterID);
}

export async function loadMobileStewardUnitAssignment(userID: string, chapterID: string): Promise<{ legacyChapterCoverage: boolean }> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const result: { data: unknown; error: unknown } = await supabase.rpc('get_steward_unit_assignment', { p_user: userID, p_chapter: chapterID });
  const row = result.data;
  if (result.error || !row || typeof row !== 'object') throw new Error('The committee member unit could not be confirmed.');
  const assignment = row as Record<string, unknown>;
  if (assignment.userId !== userID || assignment.chapterId !== chapterID || typeof assignment.legacyChapterCoverage !== 'boolean') throw new Error('The committee member unit could not be confirmed.');
  return { legacyChapterCoverage: assignment.legacyChapterCoverage };
}

export type MobileDirectoryPage = {
  members: MobileDirectoryMember[];
  truncated: boolean;
  nextCursor: MobileDirectoryCursor | null;
};

export async function searchMobileAdminMemberDirectory(
  query: string,
  after: MobileDirectoryCursor | null = null,
): Promise<MobileDirectoryPage> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  // The RPC refuses a one-character needle rather than scanning the whole
  // directory, so an unusable query never leaves the device.
  const needle = query.trim();
  if (needle.length === 1) return { members: [], truncated: false, nextCursor: null };
  // The cursor the RPC handed back is sent back whole: (name, id) together or
  // not at all, exactly as the function's "incomplete cursor" check requires.
  const { data, error } = await supabase.rpc('get_admin_member_directory', {
    p_query: needle,
    p_after_name: after?.name ?? null,
    p_after_id: after?.id ?? null,
    p_limit: DIRECTORY_PAGE_LIMIT,
  });
  if (error) throw new Error('The worker directory could not be searched through your current authorization.');
  // The page is up to 25 matches. The cursor is carried out of here so the
  // screen can follow it to the next page rather than present a cut list.
  const payload: unknown = data;
  return {
    members: normalizeDirectoryMembers(payload),
    truncated: directoryPageWasTruncated(payload),
    nextCursor: normalizeDirectoryCursor(payload),
  };
}

export async function grantMobileChapterMembership(writer: MobileSessionWriter, userID: string, chapterID: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('grant_member_chapter_membership', {
    p_user_id: userID, p_chapter_id: chapterID,
  });
  if (error) throw membershipRpcFailure(error, 'membership-grant-refused');
}

export async function revokeMobileChapterMembership(writer: MobileSessionWriter, userID: string, chapterID: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.rpc('revoke_member_chapter_membership', {
    p_user_id: userID, p_chapter_id: chapterID,
  });
  if (error) throw membershipRpcFailure(error, 'membership-revoke-refused');
}

export async function setMobileChapterRole(
  writer: MobileSessionWriter, userID: string,
  chapterID: string,
  role: MobileChapterRole,
  enabled: boolean,
  unitID?: string,
): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  if (role === 'steward' && enabled && !unitID) throw new Error('steward-unit-required');
  const { error } = role === 'steward' && enabled
    ? await supabase.rpc('set_member_access_role', { p_user: userID, p_chapter: chapterID, p_role: role, p_enabled: true, p_unit: unitID, p_committee: null })
    : await supabase.rpc('set_member_chapter_role', { p_user_id: userID, p_chapter_id: chapterID, p_role: role, p_enabled: enabled === true });
  if (error) throw membershipRpcFailure(error, 'chapter-role-refused');
}

export async function loadMobileBallots(): Promise<MobileBallot[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const [ballotsResult, receiptsResult] = await Promise.all([
    supabase.from('member_ballots')
      .select('id,title,closes_at,active,campaign_state,chapter_id,member_ballot_options(id,label,order_index)')
      .order('order_index')
      .limit(100),
    supabase.from('member_ballot_receipts').select('ballot_id,receipt_code').limit(100),
  ]);
  if (ballotsResult.error) throw ballotsResult.error;
  if (receiptsResult.error) throw receiptsResult.error;
  const receiptByBallot = new Map((Array.isArray(receiptsResult.data) ? receiptsResult.data : []).flatMap((row: Record<string, unknown>) => (
    typeof row.ballot_id === 'string' && typeof row.receipt_code === 'string'
      ? [[row.ballot_id, row.receipt_code] as const]
      : []
  )));
  return (Array.isArray(ballotsResult.data) ? ballotsResult.data : []).flatMap((row: Record<string, unknown>) => {
    if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.closes_at !== 'string') return [];
    const options = (Array.isArray(row.member_ballot_options) ? row.member_ballot_options : []).flatMap((option: Record<string, unknown>) => (
      typeof option.id === 'string' && typeof option.label === 'string' && typeof option.order_index === 'number'
        ? [{ id: option.id, label: option.label, orderIndex: option.order_index }]
        : []
    )).sort((left, right) => left.orderIndex - right.orderIndex);
    return [{
      id: row.id,
      title: row.title,
      closesAt: row.closes_at,
      chapterId: typeof row.chapter_id === 'string' ? row.chapter_id : null,
      closed: row.active === false || row.campaign_state === 'closed' || new Date(row.closes_at).getTime() <= Date.now(),
      receiptCode: receiptByBallot.get(row.id) ?? null,
      options,
    }];
  });
}

export async function submitMobileBallotVote(writer: MobileSessionWriter, ballotID: string, optionID: string): Promise<string> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error }: { data: unknown; error: unknown } = await supabase.rpc('submit_ballot_vote', {
    p_ballot_id: ballotID,
    p_option_id: optionID,
  });
  if (error) throw new Error('That vote changed, closed, or already has your choice. Refresh and review it again.');
  if (!data || typeof data !== 'object' || !('receiptCode' in data) || typeof data.receiptCode !== 'string') {
    throw new Error('The vote could not be confirmed with a receipt. Refresh before trying again.');
  }
  return data.receiptCode;
}

export async function loadMobileSmsPreference(): Promise<MobileSmsPreference> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.rpc('get_my_sms_preference');
  if (error || !data || typeof data !== 'object') throw new Error('SMS status could not be loaded.');
  return data as unknown as MobileSmsPreference;
}

export function normalizeMobileSmsPhone(input: string): string | null {
  const phone = input.replace(/[\s().-]/g, '');
  return /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone : null;
}

export async function setMobileSmsConsent(phoneInput: string | null, consented: boolean, writer?: MobileSessionWriter): Promise<MobileSmsPreference> {
  const phone = consented ? normalizeMobileSmsPhone(phoneInput ?? '') : null;
  if (consented && phone === null) throw new Error('SMS consent was not changed.');
  if (!writer) throw new Error('SMS consent was not changed.');
  const supabase = await writer.client();
  const { data, error } = await supabase.rpc('set_my_sms_consent', {
    p_phone_e164: phone, p_consented: consented,
  });
  if (error || !data || typeof data !== 'object') throw new Error('SMS consent was not changed.');
  return data as unknown as MobileSmsPreference;
}

export async function sessionNeedsMfa(): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  if (sessionRequiresTotp(data)) return true;
  if (data?.currentLevel === 'aal2') return false;
  const requirementResponse: { data: unknown; error: { code?: string } | null } = await supabase.rpc('get_my_mfa_requirement');
  const requirement = requirementResponse.data;
  // Allow the app to deploy before the additive RPC. Other failures retain
  // the existing fail-closed session-security screen, never member data.
  if (requirementResponse.error && requirementResponse.error.code !== 'PGRST202') throw requirementResponse.error;
  return Boolean(requirement && typeof requirement === 'object' && 'required' in requirement && requirement.required === true);
}

export async function verifyMfaCode(rawCode: string, initiatingSession?: Session | null, onAdopt?: (session: Session) => void): Promise<Session> {
  const writer = captureSessionWriter(initiatingSession ?? null);
  const supabase = await accountAuthClient(writer, initiatingSession);
  try {
    const code = rawCode.replace(/\s+/g, '');
    const { data: factorData, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) throw listError;
    const factors = (factorData?.all ?? []).filter((factor) => (
      factor.factor_type === 'totp' && factor.status === 'verified'
    ));
    if (factors.length === 0) throw new Error('No authenticator is set up for this account.');

    let lastError: unknown = null;
    for (const factor of factors) {
      const challengeSession = await accountSession(writer, initiatingSession);
      const challengeSeed = await supabase.auth.setSession(challengeSession);
      if (challengeSeed.error) throw challengeSeed.error;
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor.id });
      if (challengeError) {
        lastError = challengeError;
        continue;
      }
      const verifySession = await accountSession(writer, initiatingSession);
      const verifySeed = await supabase.auth.setSession(verifySession);
      if (verifySeed.error) throw verifySeed.error;
      const { error } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code,
      });
      if (!error) {
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (sessionData.session) {
          await accountSession(writer, initiatingSession);
          const operation = nativeAuthGate.begin(initiatingSession!);
          try {
            operation.stage(sessionData.session);
            const installed = await getSupabaseClient()!.auth.setSession(sessionData.session);
            if (!operation.current() || installed.error || !installed.data.session
              || installed.data.session.user.id !== writer.userId
              || !accessTokensShareSessionLineage(installed.data.session.access_token, sessionData.session.access_token)) throw new Error('The account changed.');
            onAdopt?.(installed.data.session);
            return installed.data.session;
          } finally { operation.finish(); }
        }
      }
      lastError = error;
    }
    throw lastError ?? new Error('That authenticator code could not be verified.');
  } finally {
    try { await supabase.auth.dispose?.(); } catch { /* swallow-ok: disposal of the isolated client cannot change the live MFA outcome */ }
  }
}

export async function exchangeAuthCode(code: string): Promise<Session> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw error;
  return data.session;
}

export async function loadDashboard(
  userID: string,
  onMemberLanguage?: (language: MemberProfile['language']) => void,
  reason: 'automatic' | 'user-refresh' = 'automatic',
  onQueryError?: (error: unknown) => void,
): Promise<MemberDashboard> {
  const read = () => readDashboard(userID, onMemberLanguage, onQueryError);
  // Only an explicit Home refresh can consume the test slot. Bootstrap and
  // resume must remain able to finish behind the normal privacy cover.
  if (reason === 'user-refresh' && typeof __DEV__ !== 'undefined' && __DEV__) {
    const { withShareRecoveryTestBoundary } = await import('./shareRecoveryTestHook');
    // Finish every dependent read (including conversation summaries) before
    // holding the result. Releasing A after a switch must start no query as B.
    return withShareRecoveryTestBoundary('notifications', read);
  }
  return read();
}

async function readDashboard(
  userID: string,
  onMemberLanguage?: (language: MemberProfile['language']) => void,
  onQueryError?: (error: unknown) => void,
): Promise<MemberDashboard> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const weekFloor = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
  //: the aggregate below returns at the first profile error and reports
  // one sibling error, so a query that hangs or fails first could hide another
  // query's refusal. Each required query reports its own failure on its own
  // promise, early or late, whatever the order and timing of the others.
  const observed = <T extends { error: unknown }>(query: PromiseLike<T>): Promise<T> => {
    const promise = Promise.resolve(query);
    if (onQueryError) {
      void promise.then((result) => { if (result.error) onQueryError(result.error); }, onQueryError);
    }
    return promise;
  };

  // Start all four RLS-scoped reads together, but surface the member's language
  // as soon as the profile succeeds. Account can then render notification
  // controls in the right language even if a sibling dashboard query fails.
  const profilePromise = observed(supabase.from('member_profiles')
      .select('id,first_name,full_name,initials,role_line,member_since,chapter_id,language')
      .eq('id', userID)
      .single());
  const notificationsPromise = observed(supabase.from('member_notifications')
      .select('id,title,body,kind,copy_key,peer_conversation_id,read_at,created_at')
      .eq('user_id', userID)
      .order('created_at', { ascending: false })
      .limit(MAX_DASHBOARD_NOTIFICATIONS));
  const casesPromise = observed(readWithTimeZoneFallback('id,user_id,reference,title,deadline,case_type,step,status,updated_at,organization_id,chapter_id,time_zone',
    (columns) => supabase.from('member_cases')
      .select(columns)
      .eq('user_id', userID)
      .order('updated_at', { ascending: false })
      .limit(MAX_DASHBOARD_CASES)));
  const actionsPromise = observed(supabase.from('member_action_log')
      .select('action_key,action_kind,occurred_at')
      .eq('user_id', userID)
      .gte('occurred_at', weekFloor)
      .order('occurred_at', { ascending: false }));
  const stewardDirect = currentNativeDirectAudience() === 'steward';
  const conversationsPromise: Promise<{ data: unknown; error: { message?: string } | null }> = observed(stewardDirect
    //  (gate stage 456, r5s1): the steward list keeps its empty page on a
    // 42501, but the refusal itself still reaches the provider.
    ? loadStewardDirectConversations(onQueryError).then((rows) => ({ data: rows, error: null }))
    : supabase.from('member_conversations')
      .select('id,steward_user_id,title,initials,created_at,updated_at')
      .eq('user_id', userID)
      .order('updated_at', { ascending: false })
      .limit(MAX_DASHBOARD_CONVERSATIONS));

  const profileResult = await profilePromise;
  if (profileResult.error) throw profileResult.error;

  const profile = profileResult.data as ProfileRow;
  const member: MemberProfile = {
    id: profile.id,
    firstName: profile.first_name,
    fullName: profile.full_name,
    initials: profile.initials,
    roleLine: profile.role_line,
    memberSince: profile.member_since,
    chapterID: profile.chapter_id,
    language: profile.language === 'es' ? 'es' : 'en',
  };
  onMemberLanguage?.(member.language);

  const [notificationsResult, casesResult, actionsResult, conversationsResult] = await Promise.all([
    notificationsPromise,
    casesPromise,
    actionsPromise,
    conversationsPromise,
  ]);
  // A refusal outranks an ordinary failure, so the aggregate error never
  // reports a transport or server error over a sibling's refusal.
  const errors = [notificationsResult.error, casesResult.error, actionsResult.error, conversationsResult.error];
  const error = errors.find(isAuthoritativeReadRefusal) ?? errors.find(isReadRefusal) ?? errors.find(Boolean);
  if (error) throw error;
  const notifications = (notificationsResult.data as NotificationRow[]).map(memberNotification);
  // Union Ground shows issues without legal filing deadlines or ULP flags.
  const cases = (casesResult.data as CaseRow[]).map(memberCase);
  const conversations = stewardDirect
    ? conversationsResult.data as MemberConversation[]
    : await projectMemberConversations(
      supabase,
      conversationsResult.data as ConversationRow[],
    );
  const weeklyActions: MemberAction[] = (actionsResult.data as ActionRow[]).map((row) => ({
    actionKey: row.action_key,
    actionKind: row.action_kind,
    occurredAt: row.occurred_at,
  }));

  return { member, notifications, cases, conversations, weeklyActions };
}

// The conversation half of the dashboard projection, shared by loadDashboard
// and the bounded foreground poll so both publish byte-identical
// MemberConversation rows through the same mapping. member_conversation_summaries
// is a view, so callers must poll or query it — never subscribe to it with
// Realtime postgres_changes.
async function projectMemberConversations(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
  conversationRows: ConversationRow[],
): Promise<MemberConversation[]> {
  const conversationIDs = conversationRows.map((row) => row.id);
  const summariesResult = conversationIDs.length
    ? await supabase.from('member_conversation_summaries')
        .select('conversation_id,latest_message,unread_count')
        .in('conversation_id', conversationIDs)
    : { data: [], error: null };
  if (summariesResult.error) throw summariesResult.error;
  const summaries = new Map((summariesResult.data as ConversationSummaryRow[])
    .map((row) => [row.conversation_id, row]));
  return conversationRows.map((row) => {
    const summary = summaries.get(row.id);
    return {
      id: row.id,
      counterpartRole: 'steward' as const,
      stewardUserId: row.steward_user_id ?? null,
      title: row.title,
      initials: row.initials,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      unreadCount: summary?.unread_count ?? 0,
      latestMessage: summary?.latest_message ?? null,
    };
  });
}

// Lightweight re-read of the dashboard's conversation projection for the
// foreground unread poll; intentionally fetches only what the badge and inbox
// row need instead of the full dashboard. Keep the steward binding: these
// rows replace dashboard.conversations and also drive steward routing.
export async function loadConversationSummaries(userID: string): Promise<MemberConversation[]> {
  if (currentNativeDirectAudience() === 'steward') return loadStewardDirectConversations();
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.from('member_conversations')
    .select('id,steward_user_id,title,initials,created_at,updated_at')
    .eq('user_id', userID)
    .order('updated_at', { ascending: false })
    .limit(MAX_DASHBOARD_CONVERSATIONS);
  if (error) throw error;
  return projectMemberConversations(supabase, data as ConversationRow[]);
}

export async function loadCase(userID: string, caseID: string): Promise<MemberCase | null> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.from('member_cases')
    .select('id,user_id,reference,title,deadline,case_type,step,status,updated_at')
    .eq('user_id', userID)
    .eq('id', caseID)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return memberCase(data as CaseRow);
}

export async function loadCaseDetail(
  userID: string,
  caseID: string,
  coordinatorAccess = false,
): Promise<MemberCaseDetail | null> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const caseQuery = supabase.from('member_cases')
    .select('id,user_id,reference,title,deadline,case_type,step,status,updated_at')
    .eq('id', caseID);
  const updatesQuery = supabase.from('member_case_updates')
    .select('id,case_id,body,created_at')
    .eq('case_id', caseID);
  const [caseResult, updatesResult] = await Promise.all([
    Promise.resolve((coordinatorAccess ? caseQuery : caseQuery.eq('user_id', userID)).maybeSingle()),
    Promise.resolve((coordinatorAccess ? updatesQuery : updatesQuery.eq('user_id', userID))
      .order('created_at', { ascending: true })),
  ]);
  if (caseResult.error) throw caseResult.error;
  if (updatesResult.error) throw updatesResult.error;
  if (!caseResult.data) return null;
  const updates: MemberCaseUpdate[] = (updatesResult.data as CaseUpdateRow[]).map((row) => ({
    id: row.id,
    caseID: row.case_id,
    body: row.body,
    createdAt: row.created_at,
  }));
  // Resolve the owned/authorized case before reading its operational history.
  // RLS remains authoritative for each child table, with no staff RPC involved.
  // The recorded outcome is read under the owner's select policy .
  const [deadlinesResult, transitionsResult, stepLabels, outcomeResult] = await Promise.all([
    supabase.from('casework_deadlines').select('id,kind,label,due_at,status')
      .eq('case_id', caseID).order('due_at', { ascending: true }),
    supabase.from('casework_step_transitions').select('id,from_step,to_step,outcome,created_at')
      .eq('case_id', caseID).order('created_at', { ascending: true }),
    // Soft: a failed procedure read leaves every step as stored .
    loadCaseStepLabels(caseProcedureRequest(supabase), caseID),
    supabase.from('member_case_outcomes').select('outcome,summary,recorded_at,updated_at')
      .eq('case_id', caseID).maybeSingle(),
  ]);
  if (deadlinesResult.error) throw deadlinesResult.error;
  if (transitionsResult.error) throw transitionsResult.error;
  if (outcomeResult.error) throw outcomeResult.error;
  const caseRow = caseResult.data as CaseRow;
  const item = withStepLabel(memberCase(caseRow), stepLabels.get(String(caseRow.step ?? '').trim()));
  return {
    item,
    updates,
    deadlines: (deadlinesResult.data ?? []) as MemberCaseDetail['deadlines'],
    transitions: (transitionsResult.data ?? []) as MemberCaseDetail['transitions'],
    stepLabels,
    outcome: (outcomeResult.data ?? null) as MemberCaseDetail['outcome'],
  };
}

export async function setNotificationReadState(
  writer: MobileSessionWriter,
  userID: string,
  notificationID: string,
  read: boolean,
): Promise<MemberNotification> {
  if (!writer.userId || writer.userId !== userID) throw new Error('The composing account is unavailable.');
  const supabase = await writer.client();
  const { data, error } = await supabase.from('member_notifications')
    .update({ read_at: read ? new Date().toISOString() : null })
    .eq('user_id', userID)
    .eq('id', notificationID)
    .select('id,title,body,kind,copy_key,peer_conversation_id,read_at,created_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('That update is no longer available to this session.');
  return memberNotification(data as NotificationRow);
}

export async function loadConversationThread(
  userID: string,
  conversationID: string,
  options: { messageID?: string; staff?: boolean } = {},
): Promise<MemberConversationThread | null> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  // A cold record link checks the exact source before reading its conversation.
  // Staff scope is used only by the explicitly authorized staff reader; RLS is
  // still authoritative, and a member read remains pinned to that member.
  const staff = options.staff === true;
  if (options.messageID) {
    const { data, error } = await supabase.rpc('get_connected_workflow_context', { p_kind: 'private_message', p_id: options.messageID });
    if (error) throw error;
    const source = data as { available?: boolean; state?: string } | null;
    if (!source?.available || source.state === 'removed') return null;
  }
  let conversationQuery = supabase.from('member_conversations').select('id,user_id,steward_user_id,title,initials,created_at,updated_at').eq('id', conversationID);
  if (!staff) conversationQuery = conversationQuery.eq('user_id', userID);
  const [conversationResult, messagesResult] = await Promise.all([
    Promise.resolve(conversationQuery.maybeSingle<ConversationRow & { user_id: string }>()),
    Promise.resolve(threadMessagePage(supabase, userID, conversationID, staff, null)),
  ]);
  if (conversationResult.error) throw conversationResult.error;
  if (messagesResult.error) throw messagesResult.error;
  if (!conversationResult.data) return null;
  const newestFirst = messagesResult.data as MessageRow[];
  // The cursor is the oldest row of the contiguous newest page, read before
  // an exact record-link message is added, so earlier history has no gap.
  const earlierCursor = historyCursor(newestFirst);
  const rows = [...newestFirst].reverse();
  if (options.messageID) {
    let exact = supabase.from('member_messages').select('id,conversation_id,sender_kind,sender_name,body,read_at,created_at,redacted_at,redaction_reason,edited_at,parent_message_id').eq('conversation_id', conversationID).eq('id', options.messageID);
    if (!staff) exact = exact.eq('user_id', userID);
    const result = await exact.maybeSingle<MessageRow>();
    if (result.error) throw result.error;
    if (!result.data || result.data.redacted_at) return null;
    if (!rows.some((row) => row.id === options.messageID)) rows.push(result.data as MessageRow);
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }
  const summaryRows = [...rows].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  return {
    readerIsStaff: staff && conversationResult.data.user_id !== userID,
    conversation: conversationSummary(conversationResult.data as ConversationRow, summaryRows),
    messages: await withMessageReactions(supabase, rows, userID),
    earlierCursor,
  };
}

// BUG-UG-NATIVE-DIRECT-THREAD-HIDES-OLDER-MESSAGES-20261109: every
// thread read is one bounded newest-first page, ordered by (created_at, id)
// so equal timestamps cannot straddle a page edge. A member read stays pinned
// to that member; the staff read is the same one the newest page used, and
// RLS stays authoritative for both.
export const THREAD_MESSAGE_PAGE = 200;
const THREAD_MESSAGE_COLUMNS = 'id,conversation_id,sender_kind,sender_name,body,read_at,created_at,redacted_at,redaction_reason,edited_at,parent_message_id';

function threadMessagePage(supabase: SupabaseClient, userID: string, conversationID: string, staff: boolean, before: MessageHistoryCursor | null) {
  let query = supabase.from('member_messages').select(THREAD_MESSAGE_COLUMNS).eq('conversation_id', conversationID);
  if (!staff) query = query.eq('user_id', userID);
  if (before) {
    const at = JSON.stringify(before.createdAt);
    const id = JSON.stringify(before.id);
    query = query.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`);
  }
  return query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(THREAD_MESSAGE_PAGE);
}

function historyCursor(newestFirst: readonly MessageRow[]): MessageHistoryCursor | null {
  const oldest = newestFirst[newestFirst.length - 1];
  return newestFirst.length >= THREAD_MESSAGE_PAGE && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null;
}

async function withMessageReactions(supabase: SupabaseClient, rows: readonly MessageRow[], userID: string): Promise<MemberMessage[]> {
  const reactionsResult = rows.length ? await supabase.from('member_message_reactions')
    .select('private_message_id,reaction,actor_id').eq('source_kind', 'private')
    .in('private_message_id', rows.map((row) => row.id)) : { data: [], error: null };
  if (reactionsResult.error) throw reactionsResult.error;
  const reactionRows = (reactionsResult.data ?? []) as { private_message_id: string; reaction: string; actor_id: string }[];
  return rows.map((row) => ({ ...memberMessage(row), reactions: aggregateMessageReactions(
    reactionRows.filter((reaction) => reaction.private_message_id === row.id), userID,
  ) }));
}

// The page of messages strictly before `before`, oldest first, with the next
// cursor when that page was full. The caller keeps the pages it already has.
export async function loadEarlierConversationMessages(
  userID: string,
  conversationID: string,
  before: MessageHistoryCursor,
  options: { staff?: boolean } = {},
): Promise<{ messages: MemberMessage[]; earlierCursor: MessageHistoryCursor | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const result = await threadMessagePage(supabase, userID, conversationID, options.staff === true, before);
  if (result.error) throw new Error('Earlier messages did not load. Try again.');
  const newestFirst = (result.data ?? []) as MessageRow[];
  return {
    messages: await withMessageReactions(supabase, [...newestFirst].reverse(), userID),
    earlierCursor: historyCursor(newestFirst),
  };
}

export async function markConversationRead(writer: MobileSessionWriter, userID: string, conversationID: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { error } = await supabase.from('member_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userID)
    .eq('conversation_id', conversationID)
    .eq('sender_kind', 'steward')
    .is('read_at', null);
  if (error) throw error;
}

export async function sendMemberMessage(writer: MobileSessionWriter, conversationID: string, body: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const cleanBody = body.trim();
  if (!cleanBody || cleanBody.length > 4_000) throw new Error('Messages must be between 1 and 4,000 characters.');
  const { error } = await supabase.rpc('send_member_message', {
    p_conversation_id: conversationID,
    p_body: cleanBody,
  });
  if (error) throw error;
}

// A steward reply on a member's conversation. The member's own send stays
// send_member_message. The server checks the steward role and visibility.
export async function sendStewardReply(writer: MobileSessionWriter, conversationID: string, body: string): Promise<void> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const cleanBody = body.trim();
  if (!cleanBody || cleanBody.length > 4_000) throw new Error('Messages must be between 1 and 4,000 characters.');
  const { error } = await supabase.rpc('send_steward_reply', {
    p_conversation_id: conversationID,
    p_body: cleanBody,
  });
  if (error) throw error;
}

export async function startMemberConversation(writer: MobileSessionWriter, body: string): Promise<string> {
  const supabase = await writer.client();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const cleanBody = body.trim();
  if (!cleanBody || cleanBody.length > 4_000) throw new Error('Messages must be between 1 and 4,000 characters.');
  const { data, error } = await supabase.rpc('start_member_conversation', { p_body: cleanBody });
  if (error) throw error;
  const conversationID = (data as { conversationId?: unknown } | null)?.conversationId;
  if (typeof conversationID !== 'string') throw new Error('The conversation could not be confirmed.');
  return conversationID;
}

// Every native member_profiles write goes through update_my_member_profile,
// the RPC web Settings and the profile dialog call: it writes only the
// caller's own row and journals the change during a learning period so it can
// be undone. userID is the account the screen was opened for; the server
// refuses the save if the session now belongs to someone else. The RPC
// returns no row, so the saved values are read back
// (REQ-UG-NATIVE-MEMBER-PROFILE-RPC-AND-GRANT-REVOKE-20261104).
export async function updateMemberProfile(
  userID: string,
  input: Pick<MemberProfile, 'firstName' | 'fullName' | 'language'>,
): Promise<MemberProfile> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const firstName = input.firstName.trim();
  const fullName = input.fullName.trim();
  const initials = initialsForName(fullName);
  if (!firstName || firstName.length > 80 || !fullName || fullName.length > 160 || !initials) {
    throw new Error('Enter a valid preferred and full name.');
  }
  const saved = await supabase.rpc('update_my_member_profile', {
    p_expected_user_id: userID,
    p_fields: { first_name: firstName, full_name: fullName, initials, language: input.language },
  });
  if (saved.error) throw saved.error;
  const { data, error } = await supabase.from('member_profiles')
    .select('id,first_name,full_name,initials,role_line,member_since,chapter_id,language')
    .eq('id', userID)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Your profile is no longer available to this session.');
  const profile = data as ProfileRow;
  return {
    id: profile.id,
    firstName: profile.first_name,
    fullName: profile.full_name,
    initials: profile.initials,
    roleLine: profile.role_line,
    memberSince: profile.member_since,
    chapterID: profile.chapter_id,
    language: profile.language === 'es' ? 'es' : 'en',
  };
}

// Topic, Do not disturb and quiet-hours choices live on the member's own
// profile row, the same columns web Settings writes (memberApi.js
// updateMemberSettings). RLS scopes reads to auth.uid(); the id filter only
// names the row. Saves go through update_my_member_profile like web's.
export async function loadMemberNotificationPreferences(userID: string): Promise<NotificationPreferences> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await supabase.from('member_profiles')
    .select(NOTIFICATION_PREFERENCES_COLUMNS)
    .eq('id', userID)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Your profile is no longer available to this session.');
  return notificationPreferencesFromRow(data as NotificationPreferencesRow);
}

export async function saveMemberNotificationPreferences(
  userID: string,
  patch: Partial<NotificationPreferencesPatch>,
): Promise<NotificationPreferences> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const saved = await supabase.rpc('update_my_member_profile', { p_expected_user_id: userID, p_fields: patch });
  if (saved.error) throw saved.error;
  const { data, error } = await supabase.from('member_profiles')
    .select(NOTIFICATION_PREFERENCES_COLUMNS)
    .eq('id', userID)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Your profile is no longer available to this session.');
  return notificationPreferencesFromRow(data as NotificationPreferencesRow);
}

export class CompassPausedError extends Error {
  constructor() {
    super('The Guide is paused by an administrator.');
    this.name = 'CompassPausedError';
  }
}

// BUG-UG-COMPASS-GUIDE-503-PRODUCTION-20261003: the API refuses
// wording its privacy minimizer cannot send (422 question_withheld) before any
// reservation. That is the member's to reword, not an outage.
export const COMPASS_QUESTION_WITHHELD_MESSAGE = "The Guide can't send that question as written. Ask it as a general organizing question, with no names and no personal health, discipline or immigration details, or try one of the suggested questions or ask the committee.";

export class CompassQuestionWithheldError extends Error {
  constructor() {
    super(COMPASS_QUESTION_WITHHELD_MESSAGE);
    this.name = 'CompassQuestionWithheldError';
  }
}

export type CompassRateLimitScope = 'role' | 'shared';

export function compassRateLimitMessage(scope: CompassRateLimitScope): string {
  if (scope === 'role') {
    return "You've reached your hourly Guide question limit. Room frees up as the hour rolls over.";
  }
  return 'The Guide is at the shared hourly limit. Room frees up as the hour rolls over.';
}

export class CompassRateLimitError extends Error {
  readonly scope: CompassRateLimitScope;

  constructor(scope: CompassRateLimitScope) {
    super(compassRateLimitMessage(scope));
    this.name = 'CompassRateLimitError';
    this.scope = scope;
  }
}

export function isCompassRateLimitError(error: unknown): error is CompassRateLimitError {
  return error instanceof CompassRateLimitError;
}

export function isCompassPausedError(error: unknown): error is CompassPausedError {
  return error instanceof CompassPausedError;
}

export function isCompassQuestionWithheldError(error: unknown): boolean {
  return error instanceof CompassQuestionWithheldError;
}

// Mirror src/lib/guideApi.js compactHistory: keep only member turns, then
// cap. Capping the raw interleaved transcript first starves the window —
// six mixed items become three user turns after the server drops assistants.
type CompactCompassHistoryMessage = {
  role: 'user';
  body: string;
};

export function compactCompassHistory(
  messages: readonly Pick<CompassMessage, 'role' | 'body'>[],
): CompactCompassHistoryMessage[] {
  return messages
    .filter((message) => message.role === 'user')
    .slice(-6)
    .map((message) => ({
      role: 'user',
      body: String(message.body || '').slice(0, 1_200),
    }));
}

// "Ask Compass about this case" (REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001).
// Sends only the case id and a fixed question key; the answer is never saved.
export class CompassCaseHelpError extends Error {
  readonly code: string | null;
  constructor(code: string | null) {
    super('Guide issue help is unavailable.');
    this.name = 'CompassCaseHelpError';
    this.code = code;
  }
}

export async function askCompassAboutCase(writer: MobileSessionWriter, caseID: string, questionKey: 'next' | 'prepare' | 'rights'): Promise<CompassReply> {
  if (!mobileConfig.compassNetworkEnabled) throw new CompassCaseHelpError(null);
  const session = await writer.session();

  const response = await fetch(`${resolvePortalApiOrigin()}/api/guide`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'case_help', caseId: caseID, questionKey }),
  });
  let payload: { answer?: unknown; sources?: unknown; code?: unknown } | null = null;
  try {
    payload = await response.json() as { answer?: unknown; sources?: unknown; code?: unknown };
  } catch {
    payload = null;
  }
  if (!response.ok || typeof payload?.answer !== 'string' || !payload.answer) {
    throw new CompassCaseHelpError(typeof payload?.code === 'string' ? payload.code : null);
  }
  return { answer: payload.answer, sources: compassSourcesWithDestinations(payload.sources) };
}

export async function askCompass(writer: MobileSessionWriter, question: string, history: CompassMessage[]): Promise<CompassReply> {
  if (!mobileConfig.compassNetworkEnabled) {
    throw new Error('The Guide is not enabled for this secure backend yet.');
  }
  const session = await writer.session();

  const response = await fetch(`${resolvePortalApiOrigin()}/api/guide`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      question: question.slice(0, 1_200),
      history: compactCompassHistory(history),
    }),
  });

  if (!response.ok) {
    let payload: { code?: unknown } | null = null;
    try {
      payload = await response.json() as { code?: unknown };
    } catch {
      // A non-JSON gateway response remains a generic availability failure.
    }
    if (payload?.code === 'compass_paused') {
      throw new CompassPausedError();
    }
    if (payload?.code === 'question_withheld') {
      throw new CompassQuestionWithheldError();
    }
    if (payload?.code === 'role_rate_limit') {
      throw new CompassRateLimitError('role');
    }
    if (payload?.code === 'shared_rate_limit') {
      throw new CompassRateLimitError('shared');
    }
    // governance_unavailable, unrecognised codes, non-JSON bodies, and the two
    // gateway codes the API already gives identical copy (gateway_timeout,
    // gateway_unavailable) all stay the generic availability failure.
    throw new Error('The Guide is unavailable right now.');
  }
  const payload = await response.json() as { answer?: unknown; sources?: unknown };
  if (typeof payload.answer !== 'string') throw new Error('The Guide returned an invalid answer.');
  return { answer: payload.answer, sources: compassSourcesWithDestinations(payload.sources) };
}

// No local reaction is treated as confirmed. Success and denial both reconcile
// through the same authorized loader; loss of read access clears the thread.
export async function reactToConversationMessage(writer: MobileSessionWriter, userID: string, conversationID: string, messageID: string, kind: string, options?: { messageID?: string; staff?: boolean }) {
  if (!isMessageReactionKind(kind)) return { thread: null, failed: true };
  let failed = false;
  try {
    const client = await writer.client();
    const result = await client.rpc('toggle_member_message_reaction', {
      p_source_kind: 'private', p_message_id: messageID, p_reaction: kind,
    });
    failed = Boolean(result.error);
  } catch { failed = true; }
  if (!(await writer.isCurrent())) return { thread: null, failed };
  try { return { thread: await loadConversationThread(userID, conversationID, options), failed }; }
  catch { return { thread: null, failed: true }; }
}

async function loadStewardDirectConversations(onRefusal?: (error: unknown) => void): Promise<MemberConversation[]> {
  return (await loadStewardDirectPage({ onRefusal })).rows;
}

// Steward Direct reads the existing invoker RPC. It does not select
// member_conversations as the signed-in user, and a 42501 (the role is gone)
// becomes an empty list instead of the previous hat's rows. Other failures
// stay failures, with no server text on the error. Each read is one bounded
// page; Messages asks for the pages after the first, or a server search, so
// every conversation the server permits stays reachable. onRefusal receives
// the original 42501, so the dashboard read can still act on the refusal.
export async function loadStewardDirectPage(options: {
  search?: string | null;
  after?: StewardDirectCursor | null;
  onRefusal?: (error: unknown) => void;
} = {}): Promise<StewardDirectPage> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const search = options.search?.trim() ? options.search.trim() : null;
  const { data, error } = await supabase.rpc('list_steward_conversations', {
    p_filter: 'all',
    p_search: search,
    p_after_updated: options.after?.updatedAt ?? null,
    p_after_id: options.after?.id ?? null,
    p_limit: STEWARD_DIRECT_PAGE,
  });
  if (error) {
    if (isStewardRoleRefusal(error)) {
      noteStewardDirectRefusal();
      options.onRefusal?.(error);
      return { rows: [], next: null, total: 0, refused: true };
    }
    throw new Error('Worker conversations did not load. Try again.');
  }
  return projectStewardDirectPage(data, STEWARD_DIRECT_PAGE);
}

export async function readStepDeadlinePages(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<StepDeadlineRow[]> {
  const rows: StepDeadlineRow[] = [];
  try {
    for (let page = 0; page < STEP_DEADLINE_MAX_PAGES; page += 1) {
      const from = page * STEP_DEADLINE_PAGE;
      const { data, error } = await fetchPage(from, from + STEP_DEADLINE_PAGE - 1);
      if (error || !Array.isArray(data)) return [];
      rows.push(...(data as StepDeadlineRow[]));
      if (data.length < STEP_DEADLINE_PAGE) return rows;
    }
    return [];
  } catch {
    return [];
  }
}
const STEP_DEADLINE_MAX_PAGES = 20;
export const STEP_DEADLINE_PAGE = 1000;
