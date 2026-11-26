import { deleteMobileAccount } from '../services/accountDeletion';
import type { Session } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { purgeHomeWidgets, suspendHomeWidgets } from '../services/homeWidgets';
import { READ_DEADLINE_MS, ReadDeadlineError } from '../lib/readDeadline';

import {
  previewCompassReply,
  previewConversationThreadsFor,
  previewDashboardFor,
  previewDeskFor,
  PREVIEW_ORGANIZATION_ID,
  type PreviewDesk,
  type PreviewHatKey,
  type PreviewShell,
} from '../data/preview';
import { resetPreviewHandoffs } from '../features/memberSupportHandoffs';
import { liveChannelStore } from '../data/liveChannels';
import { activateOfflineScope, purgeOfflineAvailability, suspendOfflineAvailability } from '../services/offlineAvailability';
import { OFFLINE_CLEANUP_MESSAGE, requestOfflineSignOutCleanup, retryPendingOfflineSignOutCleanup } from '../services/offlineSignOutCleanup';
import { accessTokensShareSessionLineage, replacesAuthenticatedLineage, sessionIDFromAccessToken } from '../lib/sessionLineage';
import { createAccountSessionIdentity } from '../lib/accountSessionIdentity';
import { nativeAuthGate } from '../lib/nativeAuthGate';
import { shouldCoverOnAppState } from '../lib/appStatePrivacyCover';
import { refreshLowDataSignals, startLowDataMonitoring } from '../services/lowData';
import { pollIntervalMsFor } from '../lib/lowDataPolicy';
import { useLowData } from './useLowData';
import { useSessionCheckRecovery } from './useSessionCheckRecovery';
import { useSharedDemoVisit } from './useSharedDemoVisit';
import { mobileConfig } from '../lib/config';
import { beginStoreDemo, endStoreDemo, isStoreDemo, offersStoreDemo, STORE_DEMO_UNAVAILABLE } from '../lib/storeDemo';
import { storeDemoDevice } from '../lib/storeDemoDevice';
import { backendReachable } from '../services/backendReachability';
import { conversationUnreadStore, createConversationUnreadPoller, type ConversationUnreadPoller } from '../lib/conversationUnread';
import { createForegroundSessionRevocationWatch, SIGNED_OUT_ELSEWHERE_NOTICE } from '../lib/foregroundSessionRevocationWatch';
import { deriveLiveStaffRoles, narrowLiveStaffRoles, selectableLiveStaffRoles, type WidgetLayout } from '../lib/hatFunctions';
import { noBackendMode } from '../lib/noBackendMode';
import { resumeRefreshProvenance, signInCompletion } from '../lib/signInCompletion';
import { SESSION_UNAVAILABLE_ERROR } from '../lib/sessionUnavailableCopy';
import { initialsForName, type CompassMessage, type CompassReply, type MemberConversationThread, type MemberDashboard, type MemberProfile } from '../models/member';
import { startSupabaseAuthRefreshLifecycle } from '../services/authRefreshLifecycle';
import { isLiveSampleBackend, openSampleSession, SAMPLE_UNAVAILABLE, sampleHatForSession, switchSampleSession } from '../services/sampleSession';
import { chooseDemoVisitorLanguage, demoVisitorLanguage, resetDemoVisitorLanguage, shownDemoMember } from '../lib/demoPersonaLanguage';
import { nativeDirectAudience, replaceDirectRows, setNativeDirectAudience, stewardDirectRefusalEpoch, type NativeDirectAudience } from '../services/stewardDirectInbox';
import { purgeAttachmentCache, purgeAttachmentCacheForSessionLoss, purgeAttachmentCacheForSignOut } from '../services/attachments';
import { authenticateForUnlock, biometricsAvailable, readBiometricLockPreference, saveBiometricLockPreference } from '../services/biometrics';
import { haptics } from '../services/haptics';
import { biometricAvailabilityRefreshDue, foregroundLockAfterRefresh, readBiometricAvailability, type BiometricAvailabilitySnapshot } from '../lib/biometricAvailability';
import { recordLifecycleEvent } from '../services/lifecycleDiagnostics';
import { createAccountLocalTeardown, ACCOUNT_CLEANUP_MESSAGE } from '../services/accountLocalTeardown';
import { purgeQuickCaptureForUser } from '../services/quickCapture';
import {
  ShareIntakeError,
  captureSecureShareCleanupBoundary,
  discardAllPendingSharedAttachments,
  isSecureShareStagingCleanupRequired,
  preparePendingSharedAttachmentUploadForSessionEstablishment,
  preparePendingSharedAttachmentUploadForSessionLoss,
  preparePendingSharedAttachmentUploadForSignOut,
  preparePendingSharedAttachmentStagingForPreviewExit,
  retryPendingSharedAttachmentCleanup,
  subscribeSecureShareStagingCleanup,
  type SecureShareCleanupBoundary,
} from '../services/secureShareIntake';
import {
  boundColdSessionRead,
  type SessionUnavailableReason,
  createSessionResumeAttemptCoordinator,
  createSessionResumeGuard,
  createSessionSignOutAttemptCoordinator,
  exactSessionIdentity,
  exactSessionIdentityMatches,
  prepareSessionForServerSignOut,
  resumeProtectedSession,
  SESSION_BOOTSTRAP_DEADLINE_MS,
  type ExactSessionIdentity,
} from '../services/sessionResume';
import {
  GLOBAL_SIGN_OUT_INCOMPLETE_MESSAGE,
  globalSignOutIncompleteSignedOutMessage,
  classifySignOutFailure,
  runLocalSignOutStep,
  signOutCleanupRejection,
  signOutFailureMessage,
  type SignOutScope,
  tagSignOutProvenance,
} from '../services/signOutFailure';
import { prepareMySignOut } from '../services/sessionSignOut';
import {
  clearLocalNotificationPreference,
  clearNativePushPreferenceForSignOut,
  deleteNativePushInstallationForSignOut,
  pauseNativePushRegistration,
  resumeNativePushRegistration,
  startNativePushTokenRotationListener,
  syncNativePushRegistration,
} from '../services/notifications';
import {
  askCompass as sendCompassQuestion,
  capturedSessionIsGone,
  clearCapturedMobileSessionLocally,
  createCapturedSessionRpcClient,
  captureSessionWriter,
  type MobileSessionWriter,
  getSupabaseClient,
  loadConversationSummaries,
  loadDashboard,
  loadMobileChapterMemberships,
  loadMobileStaffScope,
  setMobileChapterPin,
  setNotificationReadState,
  signInWithEmailPassword,
  sessionNeedsMfa,
  switchMobileChapter,
  updateSignedInPassword,
  updateMemberProfile,
  readPersistedMobileSession,
  revokeAndClearCapturedMobileSession,
  verifyMfaCode,
  type MobileChapterMembership,
  type MobileMembershipSelection,
  type MobileStaffScope,
  type MobileStaffRole,
} from '../services/supabase';
import { setNativeAnalyticsMember } from '../services/observability';
import type { HatKey } from '../lib/hatFunctions';
import { nativeSignInPlatform } from '../services/passwordSignIn';
// Union Ground runs no dues; the field stays null so shared screens keep one shape.
type NativeDuesContext = { runsDues: boolean | null };
import { confirmPendingNoticeMemberships, confirmResumeDraftMemberships, noteResumeDraftReadFailure, retireRefusedResumeDraftScope, retireResumeDraftScope, syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';
import { isAuthoritativeReadRefusal } from '../lib/readRefusal';
import { resumeDraftOwnerFacts, type ResumeDraftOwner } from '../lib/resumeDraftOwnership';
import type { BusinessProof } from '../lib/businessWriteContinuation';

const accountCleanupLedgerKey = 'org.unionground.app.account-signout-cleanup.v1';
const accountLocalTeardown = createAccountLocalTeardown({
  readPending: () => SecureStore.getItemAsync(accountCleanupLedgerKey),
  writePending: (value) => SecureStore.setItemAsync(accountCleanupLedgerKey, value),
  clearPush: clearNativePushPreferenceForSignOut,
  purgeCaptures: purgeQuickCaptureForUser,
});

export type AppMode = 'booting' | 'signedOut' | 'mfaRequired' | 'authenticated' | 'preview';

function secureShareRecoveryNotice(error: unknown): string {
  if (error instanceof ShareIntakeError && error.reauthRequired) {
    return 'Verify it is you to finish recovering the interrupted attachment upload. Protected data remains locked until recovery completes.';
  }
  if (error instanceof ShareIntakeError && error.code === 'authorization') {
    return 'An interrupted attachment upload belongs to another secure account. Keep protected data locked and finish recovery from that account.';
  }
  return 'An interrupted attachment upload could not be recovered securely. Keep protected data locked and try again.';
}

type DeletionOutcome = { audited: boolean; uncertain: boolean; language: 'en' | 'es' };

// The account an MFA recovery was started for, and the incomplete global
// sign-out record held on this device when it started (by identity, so a
// newer failed attempt is a different record).
export type MfaRecoveryAttempt = {
  readonly userID: string;
  readonly session: Session;
  readonly latch: GlobalSignOutIncompleteOwner | null;
};
type GlobalSignOutIncompleteOwner = { readonly userID: string };

type AppContextValue = {
  deletionOutcome: DeletionOutcome | null;
  deletionCleanup: 'pending' | 'done' | 'failed';
  deleteAccount(confirmation: string, password?: string): Promise<void>;
  retryDeletionCleanup(): Promise<void>;
  acknowledgeDeletion(): void;
  mode: AppMode;
  session: Session | null;
  dashboard: MemberDashboard | null;
  memberLanguage: MemberDashboard['member']['language'] | null;
  refreshing: boolean;
  resumeDraftReads?: ResumeDraftReads;
  offlineDraftsReady: boolean;
  error: string | null;
  locked: boolean;
  privacyCovered: boolean;
  assuranceUnavailable: boolean;
  /** Why the session could not be confirmed while assuranceUnavailable is true; null otherwise. */
  assuranceUnavailableReason: SessionUnavailableReason | null;
  signOutError: string | null;
  /** The sign-in screen's notice after this session was proven ended elsewhere; null otherwise. */
  signedOutNotice: string | null;
  /** How often the conversation summary poll reads the first page now (longer under Low data). */
  conversationPollIntervalMs: number;
  /** False while the device network signal says offline; the conversation and task-discussion polls skip their ticks then. */
  conversationPollConnected: boolean;
  /** True while any sign-out runs on this device; both Sign out controls stay disabled. */
  signOutBusy: boolean;
  biometricLockEnabled: boolean;
  biometricAvailable: boolean;
  refreshBiometricAvailability: () => Promise<BiometricAvailabilitySnapshot>;
  previewAllowed: boolean;
  chapterMemberships: MobileChapterMembership[];
  confirmedMembershipScope: MobileMembershipSelection[] | null;
  organizationID: string | null;
  organizationRoles: MobileStaffRole[];
  chapterRoles: MobileStaffRole[];
  duesContext: NativeDuesContext | null;
  /** False means the role read is unavailable, never an authoritative role loss. */
  staffScopeAvailable: boolean;
  authorizedRoles: MobileStaffRole[];
  /** Server-confirmed staff roles the person may choose between; empty unless they hold more than one. */
  staffRoleChoices: MobileStaffRole[];
  /** The staff role chosen for this session, or null while none is chosen. */
  chosenStaffRole: MobileStaffRole | null;
  chooseStaffRole(role: MobileStaffRole | null): void;
  previewHat: PreviewHatKey | null;
  previewShell: PreviewShell | null;
  previewDesk: PreviewDesk | null;
  previewWidgetLayout(hat: PreviewHatKey): WidgetLayout | null;
  setPreviewWidgetLayout(hat: PreviewHatKey, layout: WidgetLayout): void;
  signInWithPassword(email: string, password: string): Promise<void>;
  // A PIN session is restricted until the member signs
  // in again with a password or passkey.
  sessionRestricted: boolean;
  /** A PIN/OTP restriction check has not yet authorized or refused this token. */
  sessionRestrictionPending: boolean;
  stepUpWithPassword(password: string): Promise<void>;
  enterSample(): Promise<void>;
  sampleEntryBusy: boolean;
  sampleHat: HatKey | null;
  sharedDemoVisit: ReturnType<typeof useSharedDemoVisit>;
  // True when the build itself targets the pinned SAMPLE project: fixture
  // data, never a live member's calendar.
  liveSampleBackend: boolean;
  switchSampleHat(hat: PreviewHatKey): Promise<void>;
  // True on the unionground-production store build while it runs the SAMPLE
  // demo (lib/storeDemo); Exit demo ends the demo session and restarts the
  // app on the Production sign-in.
  storeDemo: boolean;
  // Explore the demo on the Production store build, under the same sign-in
  // ownership as every other sign-in.
  enterStoreDemo(): Promise<void>;
  exitStoreDemo(): Promise<void>;
  storeDemoExitBusy: boolean;
  updatePassword(password: string, currentPassword: string): Promise<void>;
  switchChapter(chapterID: string): Promise<void>;
  refreshChapterMemberships(): Promise<void>;
  setChapterPinned(chapterID: string, pinned: boolean): Promise<void>;
  verifyMfa(code: string): Promise<void>;
  /**
   * Taken before an authenticator recovery code is redeemed. Binds the
   * recovery to the account at the challenge and the incomplete global
   * sign-out (if any) the device holds at that moment; null without a session.
   */
  beginMfaRecovery(): MfaRecoveryAttempt | null;
  finishMfaRecovery(attempt: MfaRecoveryAttempt): Promise<boolean>;
  /**
   * Called only after /api/mfa-recovery confirmed it revoked every session of
   * the attempt's account, before the local sign-out. Releases the incomplete
   * global sign-out latch and its signed-out warning when they belong to that
   * same account and attempt; returns whether anything held is now released.
   */
  confirmMfaRecoveryGlobalSignOut(attempt: MfaRecoveryAttempt): boolean;
  /** Resolves `true` when revalidation ran, `false` when it was refused. */
  retrySessionAuthentication(): Promise<boolean>;
  sessionRetryBusy: boolean;
  enterPreview(options?: { hat?: PreviewHatKey; shell?: PreviewShell }): void;
  switchPreviewHat(hat: PreviewHatKey): void;
  setPreviewShell(shell: PreviewShell): void;
  startPreviewConversation(body: string): string;
  sendPreviewMessage(conversationID: string, body: string): MemberConversationThread;
  previewThread(conversationID: string): MemberConversationThread | null;
  signOut(options?: { silent?: boolean; scope?: SignOutScope }): Promise<void>;
  refresh(reason?: 'automatic' | 'user-refresh'): Promise<void>;
  setNotificationRead(notificationID: string, read: boolean, options?: { silent?: boolean }): Promise<void>;
  saveProfile(input: Pick<MemberProfile, 'firstName' | 'fullName' | 'language'>): Promise<BusinessProof>;
  askCompass(question: string, history: CompassMessage[], writer?: MobileSessionWriter): Promise<CompassReply>;
  setBiometricLock(enabled: boolean): Promise<boolean>;
  unlock(): Promise<boolean>;
  captureAuthenticatedSessionGuard(): () => boolean;
  captureAccountSessionGuard(userID: string | null): () => boolean;
};

const AppContext = createContext<AppContextValue | null>(null);
const lockAfterMilliseconds = 30_000;

type ObservedAuthIdentity = ExactSessionIdentity;

type BlockedShareIsolation = {
  previousUserID: string;
  cleanupBoundary: SecureShareCleanupBoundary;
};

function authIdentityFor(session: Session | null): ObservedAuthIdentity | null {
  return session ? exactSessionIdentity(session) : null;
}

function authIdentityMatches(identity: ObservedAuthIdentity | null, session: Session | null): boolean {
  return Boolean(session && exactSessionIdentityMatches(identity, exactSessionIdentity(session)));
}

export function AppProvider({ children }: PropsWithChildren) {
  const [mode, setMode] = useState<AppMode>('booting');
  const [deletionOutcome, setDeletionOutcome] = useState<DeletionOutcome | null>(null);
  const [deletionCleanup, setDeletionCleanup] = useState<'pending' | 'done' | 'failed'>('pending');
  const deletionSession = useRef<Session | null>(null);
  const deletedUserID = useRef<string | null>(null);
  const deletedSessionID = useRef<string | null>(null);
  const deletionReceipt = useRef(false);
  const deletionCleanupAction = useRef<() => Promise<void>>(async () => undefined);
  const [session, setSessionState] = useState<Session | null>(null);
  const demoLanguageChosen = useRef(false);
  const demoPersonaHandoff = useRef<'signing-out' | 'opening' | null>(null);
  const clearDemoLanguage = useCallback(() => {
    if (!demoLanguageChosen.current) return;
    demoLanguageChosen.current = false;
    resetDemoVisitorLanguage();
  }, []);
  useEffect(() => clearDemoLanguage, [clearDemoLanguage]);
  const setSession = useCallback((nextSession: Session | null) => {
    // A role switch can receive a second null session while opening its next persona.
    if (nextSession && demoPersonaHandoff.current === 'opening') demoPersonaHandoff.current = null;
    const keepsDemoLanguage = nextSession ? sampleHatForSession(mobileConfig, nextSession) !== null : demoPersonaHandoff.current !== null;
    if (!keepsDemoLanguage) clearDemoLanguage();
    setSessionState(nextSession);
  }, [clearDemoLanguage]);
  const [dashboard, setDashboard] = useState<MemberDashboard | null>(null);
  const [memberLanguage, setMemberLanguage] = useState<MemberDashboard['member']['language'] | null>(null);
  //: the language a shared demo person has saved on its account, kept
  // only so a name change there sends it back unchanged.
  const demoPersonSavedLanguage = useRef<{ userID: string; language: MemberProfile['language'] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [offlineDraftsReady, setOfflineDraftsReady] = useState(false);
  const lowData = useLowData();
  const unreadPollInterval = pollIntervalMsFor(lowData);
  useEffect(() => startLowDataMonitoring(), []);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [privacyCovered, setPrivacyCovered] = useState(false);
  const [assuranceUnavailable, setAssuranceUnavailableState] = useState(false);
  // Offline, the fail-closed screen says the phone has no connection instead
  // of describing a security check; the reason travels with the flag so the
  // two can never disagree (UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018).
  const [assuranceUnavailableReason, setAssuranceUnavailableReason] = useState<SessionUnavailableReason | null>(null);
  const setAssuranceUnavailable = useCallback((unavailable: boolean, reason: SessionUnavailableReason = 'assurance') => {
    setAssuranceUnavailableState(unavailable);
    setAssuranceUnavailableReason(unavailable ? reason : null);
  }, []);
  const [signOutError, setSignOutErrorState] = useState<string | null>(null);
  // A global sign-out whose deferred resume signed this device out left the
  // account's other devices possibly live. That is a condition of the
  // signed-out surface, not one more diagnosis string: the cleanup that
  // follows a session loss (account-local, offline, protected-share recovery)
  // writes and clears `signOutError` as it settles, after this flag is set,
  // so the warning is composed into the published value at render instead
  // and no cleanup write can displace it. A new session clears it
  // (SEC-UG-FAILED-SIGN-OUT-EVERYWHERE-END-SIGN-SCREEN-WARNING-20261013).
  const [globalSignOutIncompleteSignedOut, setGlobalSignOutIncompleteSignedOut] = useState(false);
  // The foreground watch proved this Auth session ID gone on the server
  // (BUG-UG-NATIVE-SIGN-OUT-EVERYWHERE-NOT-NOTICED-IN-FOREGROUND-20261103).
  // The signed-out surface that follows shows the web's notice; a new
  // session clears both.
  const revokedElsewhereSessionID = useRef<string | null>(null);
  const [signedOutElsewhere, setSignedOutElsewhere] = useState(false);
  // A sign-in that lost its new session, or a refused revalidation, owes the
  // signed-out form a plain notice (BUG-UG-NATIVE-SIGN-IN-SILENT-DROP-20261104).
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  // The latch behind that flag: a global attempt returned with this device
  // still signed in. The drain inside `serializedSignOut` is one way this
  // device can then lose its session, but not the only one: an attempt that
  // settles while the app is backgrounded leaves the resume to the next
  // foreground, and Auth can report the loss itself. Each of those paths
  // consults the latch when it signs this device out, so the signed-out
  // surface warns however the session ended. A completed global sign-out or
  // a new session that reaches authenticated releases it (
  const globalSignOutIncompleteRef = useRef(false);
  // Whose global attempt set the latch, as a fresh object per admission. A
  // confirmed MFA recovery revokes one account's sessions, so it may release
  // the latch only for that account and only for the attempt it saw when it
  // started (SEC-UG-MFA-RECOVERY-GLOBAL-LOGOUT-CLEARS-INCOMPLETE-WARNING-20261020).
  const globalSignOutIncompleteOwnerRef = useRef<GlobalSignOutIncompleteOwner | null>(null);
  // The user whose session last reached authenticated on this device, or
  // null once that session ended. A commit for a different user, or for any
  // user after a session loss, is a replacement login and releases the latch;
  // a same-session token refresh commits the same user and keeps it. Judged
  // at the authenticated commit itself, so neither an MFA step, a fail-closed
  // establishment, a sign-in path that writes `activeUserID` before the
  // establishment, nor a superseded establishment can mis-record it
  // (Grok/Sol rounds 3 and 4 on).
  const lastAuthenticatedUserIDRef = useRef<string | null>(null);
  // The session_id of that commit, from its access token, or null when it
  // cannot be read. A later commit for the same user with a different
  // session_id is a replacement login too: identity linking or a fresh
  // sign-in of the same account starts a new session, while a token rotation
  // keeps the one it had (replacesAuthenticatedLineage).
  const lastAuthenticatedSessionIDRef = useRef<string | null>(null);
  // Keep every diagnosis write synchronous across sign-out and resume awaits.
  // A healthy resume is not evidence that a failed sign-out later succeeded.
  const signOutErrorRef = useRef<string | null>(null);
  const shareRecoveryErrorRef = useRef<symbol | null>(null);
  const setSignOutError = useCallback((next: string | null | ((previous: string | null) => string | null)) => {
    const message = typeof next === 'function' ? next(signOutErrorRef.current) : next;
    if (typeof next !== 'function' || message !== signOutErrorRef.current) shareRecoveryErrorRef.current = null;
    signOutErrorRef.current = message;
    setSignOutErrorState(message);
  }, []);
  // One sign-out at a time, whatever its scope (see serializedSignOut). The
  // ref is the guard; the state lets both Sign out controls show it.
  const signOutInFlight = useRef(false);
  // A foreground that lands while a sign-out is in flight may not resume the
  // session: `prepareSession` bumps `sessionTransition`, the token the
  // sign-out owns, so the attempt stops before its revoke and the member is
  // told Sign out everywhere may be incomplete after doing nothing but locking
  // the phone while it ran
  // (BUG-UG-FOREGROUND-RESUME-CANCELS-AN-IN-FLIGHT-GLOBAL-SIGN-OUT-20261010).
  // Refusing the resume outright would not do either: the resume is what
  // reveals the privacy cover the background put up, so a sign-out that failed
  // closed would leave the member holding a covered screen with no way back.
  // The lifecycle handler parks its resume here instead and `serializedSignOut`
  // drains it once the attempt has settled. The flag parks the request, not a
  // callback: a token refresh while the attempt runs replaces the session and
  // the resume that matches it, so the drain calls the latest resume through
  // `latestResumeAuthenticatedSession`.
  const deferredForegroundResume = useRef(false);
  const latestResumeAuthenticatedSession = useRef<() => Promise<void>>(async () => undefined);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [biometricLockEnabled, setBiometricLockEnabled] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [chapterMemberships, setChapterMembershipsState] = useState<MobileChapterMembership[]>([]);
  const publishedMemberships = useRef<MobileChapterMembership[]>([]);
  const setChapterMemberships = useCallback((next: MobileChapterMembership[] | ((previous: MobileChapterMembership[]) => MobileChapterMembership[])) => {
    const memberships = typeof next === 'function' ? next(publishedMemberships.current) : next;
    // Publish synchronously with every setter, including clears and switches:
    // an async completion can run before the next React render commits.
    publishedMemberships.current = memberships;
    setChapterMembershipsState(memberships);
  }, []);
  // Retain the last successful membership answer through same-person refresh
  // gaps. A different account cannot observe it; failures never publish [] as
  // a confirmed removal. This boundary does not wait for dashboard or staff.
  const [membershipScope, setMembershipScope] = useState<{ userID: string; selected: MobileMembershipSelection[] } | null>(null);
  const [organizationStaffScope, setOrganizationStaffScope] = useState<MobileStaffScope | null>(null);
  // Availability belongs to the read, not its fail-closed UI projection.
  // Empty roles after an outage are not a confirmed loss of those roles.
  const [resumeDraftReads, setResumeDraftReads] = useState<ResumeDraftReads>({ dashboard: false, memberships: false, staff: false });
  const profileSaveOwnership = useRef<{ owner: ResumeDraftOwner | null; available: boolean }>({ owner: null, available: false });
  //: no read restores an earlier access fact. A read that runs past its
  // deadline conceals exactly like a failed read, and only the next confirmed
  // answer brings held work back. This is the membership request whose
  // confirmed answer or refusal settled last; it orders overlapping reads.
  const settledMembershipAt = useRef(0);
  // A shared read ticket orders full, rail and pin reads. Merely starting a
  // newer dashboard generation must not suppress an older security answer.
  const publishedDashboardAt = useRef(0);
  const selectedReadChapter = useRef<{ userID: string; chapterID: string | null } | null>(null);
  const currentReadChapter = useCallback((userID: string) => selectedReadChapter.current?.userID === userID
    ? selectedReadChapter.current.chapterID : null, []);
  //  round 1 (r1s1, r2s1): a read's late answer can arrive after this
  // provider has unmounted (a remount after a render error) or its login has
  // ended. Every continuation below that runs after an await and can reach the
  // shared holder or start a read checks this ref, or a counter that unmount
  // also advances (dashboardRequest, sessionTransition, the resume guard), and
  // the read deadlines are cancelled on unmount and sign-out, so a gone
  // instance publishes, conceals and retires nothing in the shared holder.
  const providerMounted = useRef(true);
  const readDeadlineTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // A cancelled deadline never fires; its read then settles only when its own
  // request answers, as on Main, and every continuation is guarded above.
  const cancelReadDeadlines = useCallback(() => {
    for (const timer of readDeadlineTimers.current) clearTimeout(timer);
    readDeadlineTimers.current.clear();
  }, []);
  useEffect(() => {
    providerMounted.current = true;
    return () => {
      providerMounted.current = false;
      cancelReadDeadlines();
    };
  }, [cancelReadDeadlines]);
  useEffect(() => {
    if (mode === 'signedOut') cancelReadDeadlines();
  }, [cancelReadDeadlines, mode]);
  //  read R-9381F: the context hands actions to screens whose closures
  // can outlive this instance or its login (a rejected pin or switch runs the
  // rail's catch, a late MFA code, a stale refresh). An action that can start
  // a read, touch the shared holder, clear shared state or arm a timer opens
  // only for the mounted instance and the closure's own login, observed now
  // (exact, or the same token lineage after a refresh), and checks again
  // after each await.
  const doorOpen = useCallback((closureSession: Session | null) => {
    const observed = observedAuthIdentity.current;
    // observedAuthIdentity is one object for this instance's lifetime.
    return providerMounted.current && closureSession !== null && observed !== null
      && (authIdentityMatches(observed, closureSession)
        || (observed.userID === closureSession.user.id && accessTokensShareSessionLineage(observed.accessToken, closureSession.access_token)));
  }, []);
  // The shared read deadline (lib/readDeadline), with its timer owned by this
  // provider so unmount and sign-out can cancel it.
  // observedAuthIdentity is one object for this instance's lifetime, read only
  // when a deadline is armed.
  const withProviderReadDeadline = useCallback(<T,>(request: Promise<T>): Promise<T> => {
    // An unmounted or signed-out instance never arms a deadline ( final,
    // r3s1); its read, if any, waits on its own request as on Main.
    if (!providerMounted.current || observedAuthIdentity.current === null) return request;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (timer) readDeadlineTimers.current.delete(timer);
        reject(new ReadDeadlineError());
      }, READ_DEADLINE_MS);
      readDeadlineTimers.current.add(timer);
    });
    return Promise.race([request, deadline]).finally(() => {
      if (timer) {
        clearTimeout(timer);
        readDeadlineTimers.current.delete(timer);
      }
    });
  }, []);
  // The pick is session-only and tied to the person who made it, so another
  // sign-in on the same device never inherits it.
  const [staffRolePick, setStaffRolePick] = useState<{ userID: string; sessionID: string; role: MobileStaffRole } | null>(null);
  const [duesContext, setDuesContext] = useState<NativeDuesContext | null>(null);
  const [previewHat, setPreviewHat] = useState<PreviewHatKey | null>(null);
  const [previewShell, setPreviewShellState] = useState<PreviewShell | null>(null);
  const [previewDesk, setPreviewDesk] = useState<PreviewDesk | null>(null);
  const [previewThreads, setPreviewThreads] = useState<Record<string, MemberConversationThread>>({});
  const [widgetLayouts, setWidgetLayouts] = useState<Partial<Record<PreviewHatKey, WidgetLayout>>>({});
  const [secureShareCleanupRequired, setSecureShareCleanupRequired] = useState(
    isSecureShareStagingCleanupRequired(),
  );
  const previewStore = useRef<Partial<Record<PreviewHatKey, {
    dashboard: MemberDashboard;
    desk: PreviewDesk;
    threads: Record<string, MemberConversationThread>;
  }>>>({});
  const backgroundedAt = useRef<number | null>(null);
  const activeUserID = useRef<string | null>(null);
  const observedAuthIdentity = useRef(createAccountSessionIdentity()).current;
  const pendingAuthTransition = useRef<{ transition: number; identity: ObservedAuthIdentity } | null>(null);
  const shareIsolationBlocked = useRef(false);
  const blockedShareIsolation = useRef<BlockedShareIsolation | null>(null);
  const conversationPollerRef = useRef<ConversationUnreadPoller | null>(null);
  const dashboardRequest = useRef(0);
  const membershipRequest = useRef(0);
  const membershipScopeChanged = useRef(0);
  const sessionTransition = useRef(0);
  const confirmedAbsentSessionTransition = useRef<number | null>(null);
  const sessionResumeGuard = useMemo(() => createSessionResumeGuard(), []);
  // A fresh login starts at ten seconds. Only an owned bootstrap timeout
  // grows this budget; repeated slow valid reads must eventually finish.
  const sessionBootstrapDeadline = useRef(SESSION_BOOTSTRAP_DEADLINE_MS);
  const sessionRetryOwner = useRef<ExactSessionIdentity | null>(null);
  const [sessionRetryInFlight, setSessionRetryInFlight] = useState<ExactSessionIdentity | null>(null);
  const sessionResumeAttempts = useMemo(() => createSessionResumeAttemptCoordinator(), []);
  const sessionSignOutAttempts = useMemo(() => createSessionSignOutAttemptCoordinator(), []);
  const observedAppState = useRef<AppStateStatus>(AppState.currentState);
  const biometricLockEnabledRef = useRef(false);
  const previewAllowed = mobileConfig.previewEnabled;

  const captureAuthenticatedSessionGuard = useCallback(() => {
    const capturedTransition = sessionTransition.current;
    const capturedUserID = activeUserID.current;
    return () => (
      capturedUserID !== null
      && sessionTransition.current === capturedTransition
      && activeUserID.current === capturedUserID
    );
  }, []);

  const captureAccountSessionGuard = useCallback((userID: string | null) => {
    const identityStillCurrent = observedAuthIdentity.captureGuard(userID);
    return () => userID !== null && activeUserID.current === userID && identityStillCurrent();
  }, [observedAuthIdentity]);

  const purgeSecureShareStaging = useCallback(async (
    cleanupBoundary: SecureShareCleanupBoundary = captureSecureShareCleanupBoundary(),
  ) => {
    const cleanupTransition = sessionTransition.current;
    await discardAllPendingSharedAttachments(
      () => sessionTransition.current === cleanupTransition,
      cleanupBoundary,
    );
  }, []);

  useEffect(() => subscribeSecureShareStagingCleanup(setSecureShareCleanupRequired), []);

  useEffect(() => {
    if (!secureShareCleanupRequired) return;
    const cleanupTransition = sessionTransition.current;
    void retryPendingSharedAttachmentCleanup(
      () => sessionTransition.current === cleanupTransition,
    ).catch(() => undefined);
  }, [secureShareCleanupRequired]);

  const clearProtectedState = useCallback(() => {
    // A resume temporarily removes protected rows. Retain consent only for an
    // identical scope after fresh authorization, never counts during the check.
    suspendHomeWidgets();
    suspendOfflineAvailability();
    setOfflineDraftsReady(false);
    setMode('booting');
    setResumeDraftReads({ dashboard: false, memberships: false, staff: false });
    dashboardRequest.current += 1;
    liveChannelStore.resetForSession();
    conversationUnreadStore.reset();
    setDashboard(null);
    setMemberLanguage(null);
    setChapterMemberships([]);
    setOrganizationStaffScope(null);
    setRefreshing(false);
  }, []);

  const invalidateResumeDraftRead = useCallback((userID: string, fact: keyof ResumeDraftReads, error: unknown, readChapter: string | null, membershipsAt?: number) => {
    if (profileSaveOwnership.current.owner?.person === userID && readChapter === currentReadChapter(userID)) profileSaveOwnership.current.available = false;
    if (fact === 'memberships' && membershipsAt !== undefined) {
      // An unavailable/invalid answer cannot supersede an older permission
      // refusal. Only a real authorization answer owns that ordering marker.
      if (isAuthoritativeReadRefusal(error)) settledMembershipAt.current = membershipsAt;
      membershipScopeChanged.current = Math.max(membershipScopeChanged.current, membershipsAt);
    }
    setResumeDraftReads(current => ({ ...current, [fact]: false }));
    //: every failure that conceals held work also feeds the own-text
    // latch. An availability-false answer arrives with no error and sets it.
    noteResumeDraftReadFailure(error);
    // An old chapter's denial conceals, but cannot retire a newer chapter's
    // work. The newer chapter's own authorization answer decides retirement.
    if (readChapter === currentReadChapter(userID)) retireRefusedResumeDraftScope(userID, error);
  }, [currentReadChapter]);

  const fetchDashboard = useCallback(async (nextSession: Session, reason: 'automatic' | 'user-refresh' = 'automatic', bootstrap = false) => {
    if (!providerMounted.current) return; // #9381: an unmounted instance starts no read.
    const userID = nextSession.user.id;
    const ownsNoticeLogin = captureAccountSessionGuard(userID);
    const request = ++dashboardRequest.current;
    const membershipsAt = ++membershipRequest.current;
    let readChapter = currentReadChapter(userID);
    let membershipChapter = readChapter;
    suspendOfflineAvailability();
    setOfflineDraftsReady(false);
    // A full dashboard reload is the newest authoritative conversation
    // projection; an older poll already in flight must not publish over it
    // when it resolves.
    conversationPollerRef.current?.invalidate();
    //: a shared demo person shows the visitor's language, not its saved one.
    const sharedDemoPerson = sampleHatForSession(mobileConfig, nextSession) !== null;
    setRefreshing(true);
    setResumeDraftReads({ dashboard: false, memberships: false, staff: false });
    setError(null);
    const startedRefusalEpoch = stewardDirectRefusalEpoch();
    let reading = true;
    const sameGeneration = () => providerMounted.current && activeUserID.current === userID && dashboardRequest.current === request;
    const ownsRead = () => reading && sameGeneration();
    // A late check runs only while this instance is mounted and the same
    // login is signed in (ownsNoticeLogin also checks the account).
    const canConceal = () => providerMounted.current && ownsNoticeLogin() && publishedDashboardAt.current < membershipsAt;
    const confirmChapter = (chapterID: string | null) => {
      readChapter = chapterID;
      selectedReadChapter.current = { userID, chapterID };
    };
    // Every dashboard query's own failure, and the aggregate's, conceals on
    // the original promise, early or late: a sibling that hangs or fails first
    // cannot hide a refusal, and a refusal after the deadline still retires.
    const concealDashboard = (error: unknown) => {
      if (canConceal()) invalidateResumeDraftRead(userID, 'dashboard', error, readChapter);
    };
    const load = async () => {
      let membershipsConfirmed = true;
      let staffConfirmed = true;
      const [loadedDashboard, nextMemberships, nextStaffScope] = await Promise.all([
        loadDashboard(userID, (savedLanguage) => {
          if (ownsRead()) {
            const language = sharedDemoPerson ? demoVisitorLanguage() : savedLanguage;
            setMemberLanguage(language);
          }
        }, reason, concealDashboard).catch((error: unknown) => {
          concealDashboard(error);
          throw error;
        }),
        loadMobileChapterMemberships((selected) => {
          if (ownsRead()) {
            membershipChapter = selected.find(row => row.chapterID !== null)?.chapterID ?? null;
            setMembershipScope({ userID, selected });
          }
        }, available => {
          membershipsConfirmed = available;
          if (available && ownsRead() && settledMembershipAt.current < membershipsAt) confirmChapter(membershipChapter);
        }).then(rows => {
          //: a confirmed full membership answer of this login and read
          // retires held notice sends for departed chapters or organizations.
          if (ownsNoticeLogin() && dashboardRequest.current === request && membershipsConfirmed) confirmPendingNoticeMemberships(userID, rows);
          if (ownsRead() && membershipsConfirmed && settledMembershipAt.current < membershipsAt) confirmChapter(rows.find(row => row.selected)?.chapterID ?? null);
          if (canConceal() && !membershipsConfirmed && settledMembershipAt.current < membershipsAt) {
            invalidateResumeDraftRead(userID, 'memberships', undefined, readChapter, membershipsAt);
          }
          // A late removal can retire work, but cannot publish a stale scope.
          if (canConceal() && readChapter === currentReadChapter(userID) && membershipsConfirmed
            && settledMembershipAt.current < membershipsAt && confirmResumeDraftMemberships(userID, rows)) {
            setResumeDraftReads({ dashboard: false, memberships: false, staff: false });
          }
          return rows;
        }).catch((error: unknown) => {
          if (canConceal() && settledMembershipAt.current < membershipsAt) {
            invalidateResumeDraftRead(userID, 'memberships', error, readChapter, membershipsAt);
          }
          throw error;
        }),
        loadMobileStaffScope(available => { staffConfirmed = available; }).then(scope => {
          if (canConceal() && !staffConfirmed) invalidateResumeDraftRead(userID, 'staff', undefined, readChapter);
          // Both the shared staff gate and draft retention use the same fact:
          // an unavailable projection is null, a confirmed empty grant is not.
          return staffConfirmed ? scope : null;
        }).catch((error: unknown) => {
          if (canConceal()) invalidateResumeDraftRead(userID, 'staff', error, readChapter);
          return null; // swallow-ok: preserve unavailable roles separately from a confirmed empty grant set
        }),
      ]);
      if (!ownsRead()) return;
      const offlineOrganizationID = nextStaffScope?.organizationID
        ?? nextMemberships.find((membership) => membership.selected)?.organizationID ?? null;
      let notesReady = false;
      try {
        if (offlineOrganizationID) {
          await retryPendingOfflineSignOutCleanup();
          if (!ownsRead()) return;
          await activateOfflineScope({ accountID: userID, organizationID: offlineOrganizationID }, sessionIDFromAccessToken(nextSession.access_token) ?? undefined);
          notesReady = true;
        }
      } catch {
        // A keychain failure cannot grant access to another account's drafts.
        // The online workspace remains usable; offline notes stay unavailable.
      }
      if (!ownsRead()) return;
      // A Steward Direct refusal landed at any point after this load began
      // (during the reads or the offline scope above): rows it still carries
      // were read before the refusal and are not shown. The epoch is read here,
      // after the last await and immediately before the publish. An empty list
      // is always kept; it is what a refused read returns.
      const checkedDashboard = stewardDirectRefusalEpoch() !== startedRefusalEpoch && loadedDashboard.conversations.length > 0
        ? { ...loadedDashboard, conversations: [] }
        : loadedDashboard;
      if (sharedDemoPerson) demoPersonSavedLanguage.current = { userID, language: checkedDashboard.member.language };
      // The demo helpers run only for a shared demo person.
      const nextDashboard = sharedDemoPerson
        ? { ...checkedDashboard, member: shownDemoMember(true, checkedDashboard.member) }
        : checkedDashboard;
      setOfflineDraftsReady(notesReady);
      setMemberLanguage(nextDashboard.member.language);
      // Publish through the versioned store the Messages tab badge subscribes
      // to, so badge and inbox always read the same conversation projection.
      conversationUnreadStore.publish(nextDashboard.conversations);
      setDashboard(nextDashboard);
      setChapterMemberships(nextMemberships);
      setOrganizationStaffScope(nextStaffScope);
      // Only a confirmed scope change from an overlapping membership read
      // invalidates these sibling proofs. An unchanged rail/pin read can
      // share this completed full snapshot without freezing its composers.
      const sameMembershipRead = membershipRequest.current === membershipsAt || membershipScopeChanged.current <= membershipsAt;
      // This answers the full read, not a newer standalone request that has
      // merely started. Preserve any genuinely newer answer already settled.
      if (membershipsConfirmed && sameMembershipRead) settledMembershipAt.current = Math.max(settledMembershipAt.current, membershipsAt);
      const facts = { dashboard: sameMembershipRead, memberships: sameMembershipRead && membershipsConfirmed, staff: sameMembershipRead && nextStaffScope !== null };
      if (facts.dashboard && facts.memberships && facts.staff) publishedDashboardAt.current = membershipsAt;
      setResumeDraftReads(facts);
      setDuesContext(null);
    };
    try {
      // Bootstrap already has its adaptive session deadline. An ordinary
      // refresh needs its own bound over every wait that conceals held work.
      if (bootstrap) await load();
      else await withProviderReadDeadline(load());
    } catch (nextError) {
      reading = false;
      if (providerMounted.current && activeUserID.current === userID && dashboardRequest.current === request) {
        // A read past its deadline ends exactly like a failed read: held work
        // stays concealed and kept, nothing is restored from before it, and
        // only the next confirmed full answer brings the work back.
        if (!bootstrap && nextError instanceof ReadDeadlineError) suspendOfflineAvailability();
        //: the deadline itself is a no-answer failure; an aggregate
        // error that already concealed above simply notes the same outcome.
        noteResumeDraftReadFailure(nextError);
        setResumeDraftReads({ dashboard: false, memberships: false, staff: false });
        if (readChapter === currentReadChapter(userID)) retireRefusedResumeDraftScope(userID, nextError);
        setError('Your worker workspace could not be loaded securely. Check your connection and try again.');
      }
      throw nextError;
    } finally {
      reading = false;
      if (activeUserID.current === userID && dashboardRequest.current === request) {
        setRefreshing(false);
      }
    }
  }, [captureAccountSessionGuard, currentReadChapter, invalidateResumeDraftRead, withProviderReadDeadline]);

  const establishSession = useCallback(async (
    nextSession: Session,
    shareCleanupBoundary: SecureShareCleanupBoundary = captureSecureShareCleanupBoundary(),
  ) => {
    if (!providerMounted.current) return; // #9381: a gone instance establishes nothing.
    sessionResumeGuard.invalidate();
    const transition = ++sessionTransition.current;
    const userID = nextSession.user.id;
    const previousUserID = activeUserID.current;
    if (previousUserID && previousUserID !== userID) {
      void purgeOfflineAvailability().catch(() => undefined);
    }
    // Every auth event is a reauthorization boundary, including a same-user
    // token refresh. Cover and remove prior protected rows before MFA, share
    // recovery, or fresh RLS reads so a failed bootstrap cannot leave revoked
    // data rendered underneath an out-of-date notice.
    setPrivacyCovered(true);
    clearProtectedState();
    const isolationBoundary = blockedShareIsolation.current
      ?? (previousUserID && previousUserID !== userID
        ? { previousUserID, cleanupBoundary: shareCleanupBoundary }
        : null);
    if (isolationBoundary) {
      try {
        await preparePendingSharedAttachmentUploadForSessionLoss(
          isolationBoundary.previousUserID,
          isolationBoundary.cleanupBoundary,
        );
      } catch {
        if (sessionTransition.current !== transition
          || !authIdentityMatches(observedAuthIdentity.current, nextSession)) return;
        // Supabase has already installed the next account. Protected rows are
        // empty, so publish B as the actionable auth owner while retaining the
        // failed A-share isolation as a separate recovery condition. This
        // keeps the restricted screen's "Sign out instead" action functional.
        activeUserID.current = userID;
        shareIsolationBlocked.current = true;
        blockedShareIsolation.current = isolationBoundary;
        setSession(nextSession);
        setDashboard(null);
        setMemberLanguage(null);
        setChapterMemberships([]);
        setOrganizationStaffScope(null);
        setLocked(false);
        setAssuranceUnavailable(true);
        setError('Union Ground could not isolate a staged share before changing accounts. Keep protected data locked and try again.');
        setMode('mfaRequired');
        setPrivacyCovered(false);
        return;
      }
      if (sessionTransition.current !== transition
        || !authIdentityMatches(observedAuthIdentity.current, nextSession)) return;
      blockedShareIsolation.current = null;
    }
    activeUserID.current = userID;
    shareIsolationBlocked.current = false;
    dashboardRequest.current += 1;
    setSession(nextSession);
    setError(null);
    setAssuranceUnavailable(false);
    // A token refresh is not a new account action that dismisses a diagnosis.
    if (previousUserID !== userID) setSignOutError(null);

    setPreviewHat(null);
    setPreviewShellState(null);
    setPreviewDesk(null);
    setPreviewThreads({});
    previewStore.current = {};
    setWidgetLayouts({});

    let requiresMfa = false;
    try {
      requiresMfa = await sessionNeedsMfa();
    } catch {
      if (sessionTransition.current !== transition) return;
      setError('Union Ground could not confirm your session security. Try again or sign out.');
      setAssuranceUnavailable(true);
      setDashboard(null);
      setMemberLanguage(null);
      setChapterMemberships([]);
      setOrganizationStaffScope(null);
      setLocked(false);
      setMode('mfaRequired');
      setPrivacyCovered(false);
      void purgeSecureShareStaging().catch(() => undefined);
      return;
    }
    if (sessionTransition.current !== transition || activeUserID.current !== userID) return;
    if (requiresMfa) {
      setDashboard(null);
      setMemberLanguage(null);
      setChapterMemberships([]);
      setOrganizationStaffScope(null);
      setLocked(false);
      setMode('mfaRequired');
      setPrivacyCovered(false);
      void purgeSecureShareStaging().catch(() => undefined);
      return;
    }

    const recoveringError = shareRecoveryErrorRef.current;
    try {
      await preparePendingSharedAttachmentUploadForSessionEstablishment(userID, captureSessionWriter(nextSession));
    } catch (nextError) {
      if (sessionTransition.current !== transition || activeUserID.current !== userID) return;
      const message = secureShareRecoveryNotice(nextError);
      setDashboard(null);
      setMemberLanguage(null);
      setChapterMemberships([]);
      setOrganizationStaffScope(null);
      setLocked(false);
      if (nextError instanceof ShareIntakeError && nextError.reauthRequired) {
        setAssuranceUnavailable(false);
      } else {
        setAssuranceUnavailable(true);
      }
      setError(message);
      setSignOutError(message);
      shareRecoveryErrorRef.current = Symbol('share-recovery');
      setMode('mfaRequired');
      setPrivacyCovered(false);
      return;
    }
    if (sessionTransition.current !== transition || activeUserID.current !== userID) return;
    if (recoveringError && shareRecoveryErrorRef.current === recoveringError) setSignOutError(null);

    // A valid session does not prove that its previous row access still exists.
    // Keep protected state empty until a fresh RLS-scoped dashboard read has
    // reauthorized every record; offline snapshots are intentionally disabled.
    // Only now can the signed-in surface reach Sign out everywhere itself, so
    // only now is the signed-out copy that pointed there finished. An MFA step
    // or a fail-closed establishment keeps it, with its Sign out instead. The
    // latch behind it is released only by a replacement login (a return from
    // sign-in, or another account): a same-session token refresh also lands
    // here, and it proves nothing about the other devices, so a local sign-out
    // or a session loss after it must still warn (Sol/Grok final on).
    const committedSessionID = sessionIDFromAccessToken(nextSession.access_token);
    if (replacesAuthenticatedLineage(
      lastAuthenticatedUserIDRef.current === null
        ? null
        : { userID: lastAuthenticatedUserIDRef.current, sessionID: lastAuthenticatedSessionIDRef.current },
      { userID, sessionID: committedSessionID },
    )) globalSignOutIncompleteRef.current = false;
    lastAuthenticatedUserIDRef.current = userID;
    lastAuthenticatedSessionIDRef.current = committedSessionID;
    setGlobalSignOutIncompleteSignedOut(false);
    setMode('authenticated');
    // Retire late writes before revealing Retry, but let the next attempt wait
    // longer. A permanently fixed cut would starve every slower valid read.
    let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      fetchDashboard(nextSession, 'automatic', true).then(() => true, () => true),
      new Promise<false>((resolve) => {
        bootstrapTimer = setTimeout(() => {
          if (sessionTransition.current === transition && activeUserID.current === userID) {
            dashboardRequest.current += 1;
            sessionBootstrapDeadline.current = Math.min(sessionBootstrapDeadline.current * 2, 2_147_483_647);
          }
          resolve(false);
        }, sessionBootstrapDeadline.current);
      }),
    ]).finally(() => clearTimeout(bootstrapTimer));
    if (!settled && sessionTransition.current === transition && activeUserID.current === userID) {
      clearProtectedState();
      setError(SESSION_UNAVAILABLE_ERROR.assurance);
      setAssuranceUnavailable(true);
      setMode('mfaRequired');
      setPrivacyCovered(false);
      return;
    }
    if (sessionTransition.current === transition && activeUserID.current === userID) {
      // The sign-in completes when the member can see the signed-in surface;
      // a loss while the cover is up and the first load is pending still owes
      // the notice ( round 1).
      signInCompletion.settle();
      setPrivacyCovered(false);
    }
  }, [clearProtectedState, fetchDashboard, purgeSecureShareStaging, sessionResumeGuard, setSession]);

  const revalidateAuthenticatedSession = useCallback(async (coveredSession: Session) => {
    if (pendingAuthTransition.current
      || !authIdentityMatches(observedAuthIdentity.current, coveredSession)) return;
    const blockedIsolation = blockedShareIsolation.current;
    if (blockedIsolation) {
      const isolationTransition = sessionTransition.current;
      setPrivacyCovered(true);
      clearProtectedState();
      try {
        await preparePendingSharedAttachmentUploadForSessionLoss(
          blockedIsolation.previousUserID,
          blockedIsolation.cleanupBoundary,
        );
      } catch {
        if (sessionTransition.current !== isolationTransition
          || !authIdentityMatches(observedAuthIdentity.current, coveredSession)) return;
        setError('Union Ground could not isolate a staged share before changing accounts. Sign out, then share it again.');
        setAssuranceUnavailable(true);
        setMode('mfaRequired');
        setPrivacyCovered(false);
        return;
      }
      if (sessionTransition.current !== isolationTransition
        || !authIdentityMatches(observedAuthIdentity.current, coveredSession)) return;
      blockedShareIsolation.current = null;
      shareIsolationBlocked.current = false;
    }
    const supabase = getSupabaseClient();
    if (!supabase) {
      setPrivacyCovered(true);
      clearProtectedState();
      setError('Union Ground could not confirm your session security. Try again or sign out.');
      setAssuranceUnavailable(true);
      setMode('mfaRequired');
      setPrivacyCovered(false);
      return;
    }

    const resumeAttempt = sessionResumeAttempts.begin(coveredSession.user.id);
    try {
      await resumeProtectedSession({
        // The refresh can outlive the deadline; its refusal still names itself.
        auth: resumeRefreshProvenance.track(supabase.auth, { userID: coveredSession.user.id, accessToken: coveredSession.access_token }),
        expectedUserID: coveredSession.user.id,
        guard: sessionResumeGuard,
        bootstrapDeadlineMs: sessionBootstrapDeadline.current,
        bootstrapTimedOut: () => {
          // Clamp only at the platform's maximum timer, not a fixed retry cap.
          sessionBootstrapDeadline.current = Math.min(sessionBootstrapDeadline.current * 2, 2_147_483_647);
        },
        isSessionCurrent: (nextSession) => (
          sessionResumeAttempts.sessionIsCurrent(resumeAttempt, nextSession)
          && authIdentityMatches(observedAuthIdentity.current, nextSession)
        ),
        cover: () => setPrivacyCovered(true),
        reachable: () => (mobileConfig.supabaseUrl
          ? backendReachable(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey)
          : Promise.resolve(true)),
        clearProtectedState,
        clearLocalSession: async () => {
          const cleared = await clearCapturedMobileSessionLocally(coveredSession);
          if (!cleared) throw new Error('The persisted session changed during local cleanup.');
        },
        prepareSession: (nextSession) => {
          sessionTransition.current += 1;
          observedAuthIdentity.current = authIdentityFor(nextSession);
          activeUserID.current = nextSession.user.id;
          shareIsolationBlocked.current = false;
          setSession(nextSession);
          setPreviewHat(null);
          setPreviewShellState(null);
          setPreviewDesk(null);
          setPreviewThreads({});
          previewStore.current = {};
          setWidgetLayouts({});
          setError(null);
          setAssuranceUnavailable(false);
          // The retained sign-out diagnosis is neither dismissed nor hidden
          // here: the privacy cover already hides it, and a hidden copy would
          // need an owner to show it again if this attempt were superseded.
        },
        // A newer login, a new SID for this user, a background or a sign-out
        // can replace this attempt while recovery awaits. `isCurrent` is the
        // attempt's ownership capability; a superseded continuation returns
        // without touching the replacement's diagnosis, recovery marker or
        // dashboard request, and the helper reports it stale.
        bootstrap: async (nextSession, isCurrent) => {
          if (!isCurrent()) return;
          const recoveringError = shareRecoveryErrorRef.current;
          try {
            await preparePendingSharedAttachmentUploadForSessionEstablishment(nextSession.user.id, captureSessionWriter(nextSession));
          } catch (nextError) {
            if (!isCurrent()) return;
            setSignOutError(secureShareRecoveryNotice(nextError));
            shareRecoveryErrorRef.current = Symbol('share-recovery');
            throw nextError;
          }
          // fetchDashboard writes refresh/error state and suspends offline
          // availability on entry, so ownership is checked with no await
          // between this check and that call.
          if (!isCurrent()) return;
          // Clear only the warning this recovery fixed. Another diagnostic
          // written while it awaited owns a different marker (or none).
          if (recoveringError && shareRecoveryErrorRef.current === recoveringError) setSignOutError(null);
          await fetchDashboard(nextSession, 'automatic', true);
        },
        authenticated: (resumedSession) => {
          // The bootstrap has loaded; the reveal follows with no await between.
          signInCompletion.settle();
          setError(null);
          setAssuranceUnavailable(false);
          // A replacement login can reach authenticated through this resume
          // (Try again after a fail-closed establishment); it releases the
          // latch the same way the establishment's own commit does.
          const resumedSessionID = resumedSession ? sessionIDFromAccessToken(resumedSession.access_token) : null;
          if (activeUserID.current === null || replacesAuthenticatedLineage(
            lastAuthenticatedUserIDRef.current === null
              ? null
              : { userID: lastAuthenticatedUserIDRef.current, sessionID: lastAuthenticatedSessionIDRef.current },
            { userID: activeUserID.current, sessionID: resumedSessionID },
          )) globalSignOutIncompleteRef.current = false;
          lastAuthenticatedUserIDRef.current = activeUserID.current;
          lastAuthenticatedSessionIDRef.current = resumedSessionID;
          setGlobalSignOutIncompleteSignedOut(false);
          setMode('authenticated');
        },
        mfaRequired: (nextSession) => {
          sessionTransition.current += 1;
          observedAuthIdentity.current = authIdentityFor(nextSession);
          activeUserID.current = nextSession.user.id;
          shareIsolationBlocked.current = false;
          setSession(nextSession);
          setError(null);
          setAssuranceUnavailable(false);
          setLocked(false);
          setMode('mfaRequired');
          void purgeSecureShareStaging().catch(() => undefined);
        },
        signedOut: () => {
          const lossTransition = ++sessionTransition.current;
          sessionRetryOwner.current = null;
          setSessionRetryInFlight(null);
          sessionBootstrapDeadline.current = SESSION_BOOTSTRAP_DEADLINE_MS;
          const shareCleanupBoundary = captureSecureShareCleanupBoundary();
          observedAuthIdentity.current = null;
          pendingAuthTransition.current = null;
          shareIsolationBlocked.current = false;
          conversationUnreadStore.reset();
          // This device is definitively signed out. Its earlier refusal copy
          // belongs to the signed-in account and must not return in finally.
          setSignOutError(null);
          // A refused revalidation says so on the form; a proven sign-out
          // elsewhere carries its own notice instead.
          const refusedNotice = signInCompletion.sessionRefused();
          setSignInNotice(revokedElsewhereSessionID.current === null ? refusedNotice : null);
          lastAuthenticatedUserIDRef.current = null;
          lastAuthenticatedSessionIDRef.current = null;
          // ...unless a global attempt left the account's other devices
          // possibly live: that outcome belongs to this signed-out surface.
          if (globalSignOutIncompleteRef.current) setGlobalSignOutIncompleteSignedOut(true);
          void preparePendingSharedAttachmentUploadForSessionLoss(
            coveredSession.user.id,
            shareCleanupBoundary,
          )
            .then((result) => {
              if (sessionTransition.current !== lossTransition || activeUserID.current !== null) return;
              if (result === 'recovery-required') {
                setSignOutError('An interrupted attachment upload remains isolated for this account. Sign back in to finish exact recovery.');
              }
            })
            .catch(() => {
              if (sessionTransition.current !== lossTransition || activeUserID.current !== null) return;
              setSignOutError('Union Ground signed out, but protected share recovery still needs attention. Sign back in to the same account and try again.');
            });
          dashboardRequest.current += 1;
          suspendOfflineAvailability();
          setOfflineDraftsReady(false);
          void requestOfflineSignOutCleanup().catch(() => {
            if (sessionTransition.current === lossTransition) setSignOutError(OFFLINE_CLEANUP_MESSAGE);
          });
          activeUserID.current = null;
          setSession(null);
          setPreviewHat(null);
          setPreviewShellState(null);
          setPreviewDesk(null);
          setPreviewThreads({});
          previewStore.current = {};
          setWidgetLayouts({});
          setError(null);
          setAssuranceUnavailable(false);
          setLocked(false);
          setMode('signedOut');
          void accountLocalTeardown.request(coveredSession.user.id,
            () => sessionTransition.current === lossTransition && activeUserID.current === null,
          ).then((clean) => {
            if (!clean && sessionTransition.current === lossTransition && activeUserID.current === null) {
              setSignOutError(ACCOUNT_CLEANUP_MESSAGE);
            }
          });
          void clearLocalNotificationPreference().catch(() => undefined);
        },
        unavailable: (reason) => {
          sessionTransition.current += 1;
          // The covered account stays the actionable owner of this fail-closed
          // screen, so "Sign out instead" can release it. A cold restore never
          // set it before reaching here (BUG-UG-MOBILE-REVOKED-SESSION-STUCK-20261002).
          activeUserID.current = coveredSession.user.id;
          setError(SESSION_UNAVAILABLE_ERROR[reason]);
          setAssuranceUnavailable(true, reason);
          setMode('mfaRequired');
          void purgeSecureShareStaging().catch(() => undefined);
        },
        // Read the latest write, not the diagnosis captured when resume began:
        // cleanup can report a newer failure, or a later action can clear it.
        // Only the owning attempt settles; a stale one writes nothing.
        settle: () => setSignOutErrorState(signOutErrorRef.current),
        reveal: () => setPrivacyCovered(false),
      });
    } finally {
      sessionResumeAttempts.finish(resumeAttempt);
    }
  }, [clearProtectedState, fetchDashboard, purgeSecureShareStaging, sessionResumeAttempts, sessionResumeGuard, setSession]);

  const resumeAuthenticatedSession = useCallback(async () => {
    if (!providerMounted.current || !session || pendingAuthTransition.current
      || !authIdentityMatches(observedAuthIdentity.current, session)) return;
    await revalidateAuthenticatedSession(session);
  }, [revalidateAuthenticatedSession, session]);
  // A deferred sign-out can settle before passive effects from a token-refresh
  // render. Publish its matching callback in that render, before it can drain.
  latestResumeAuthenticatedSession.current = resumeAuthenticatedSession;

  // Re-read device biometric availability (and resolve the stored re-lock
  // preference against it) whenever the row is about to be shown or the app
  // returns to the foreground; Settings can change enrollment at any time.
  const refreshBiometricAvailability = useCallback(async () => {
    const snapshot = await readBiometricAvailability(biometricsAvailable, readBiometricLockPreference);
    setBiometricAvailable(snapshot.available);
    biometricLockEnabledRef.current = snapshot.lockEnabled;
    setBiometricLockEnabled(snapshot.lockEnabled);
    return snapshot;
  }, []);

  useEffect(() => {
    let active = true;
    const supabase = getSupabaseClient();
    if (!supabase) {
      // Preview is an explicit choice beside sign-in, never a fallback that
      // silently replaces the signed-out screen when backend config is absent.
      // This effect can settle after that explicit choice, so preserve only
      // the deliberate in-memory PREVIEW session; every other mode signs out.
      setMode((current) => noBackendMode(current));
      return () => { active = false; };
    }
    const coldRestoreAttempt = sessionResumeAttempts.begin(null);
    const coldRestoreTransition = ++sessionTransition.current;
    const stopAuthRefresh = startSupabaseAuthRefreshLifecycle(supabase.auth);
    const coldSessionRead = supabase.auth.getSession();
    let coldReadBounded = false;

    Promise.all([
      readBiometricLockPreference(),
      biometricsAvailable(),
      boundColdSessionRead(coldSessionRead, {
        reachable: () => (mobileConfig.supabaseUrl
          ? backendReachable(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey)
          : Promise.resolve(true)),
      }),
    ]).then(async ([enabled, available, coldRead]) => {
      // Device biometrics are a device fact: apply the reading whether or not
      // an auth event moved the session transition while it was in flight
      // (BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918).
      if (active) setBiometricAvailable(available);
      if (!active || sessionTransition.current !== coldRestoreTransition) return;
      const lockEnabled = enabled && available;
      biometricLockEnabledRef.current = lockEnabled;
      setBiometricLockEnabled(lockEnabled);
      setBiometricAvailable(available);
      if (coldRead.status === 'unavailable') {
        // getSession() is still waiting on an offline refresh
        // (BUG-UG-ANDROID-COLD-OFFLINE-BOOT-BLANK-20261001). The cold
        // attempt stays active until that read really settles, so a late
        // refresh event is still an interruption that must pass the full
        // refresh/getUser/MFA/RLS resume and never a direct establishment.
        coldReadBounded = true;
        void coldSessionRead.then(() => undefined, () => undefined)
          .then(() => { sessionResumeAttempts.finish(coldRestoreAttempt); });
        const persistedSession = await readPersistedMobileSession().catch(() => null);
        if (!active || sessionTransition.current !== coldRestoreTransition) return;
        // The late getSession() result can no longer apply to this transition.
        sessionTransition.current += 1;
        if (!persistedSession) {
          observedAuthIdentity.current = null;
          setMode('signedOut');
          return;
        }
        // Same fail-closed surface as an unavailable resume: the persisted
        // session is only the covered retry and sign-out handle, protected
        // state stays cleared, and nothing is revealed.
        observedAuthIdentity.current = authIdentityFor(persistedSession);
        activeUserID.current = persistedSession.user.id;
        clearProtectedState();
        setSession(persistedSession);
        if (lockEnabled) setLocked(true);
        // Offline is said in plain words; a slow or refused read keeps the
        // security wording. Both stay fail-closed with the same controls.
        setError(SESSION_UNAVAILABLE_ERROR[coldRead.reason]);
        setAssuranceUnavailable(true, coldRead.reason);
        setMode('mfaRequired');
        void purgeSecureShareStaging().catch(() => undefined);
        return;
      }
      const { data, error: sessionError } = coldRead.value;
      if (sessionError) throw sessionError;
      if (data.session) {
        // The persisted session is only a covered retry handle until a forced
        // refresh, authoritative user lookup, MFA check, and fresh RLS
        // bootstrap all succeed. It never establishes authorization itself.
        observedAuthIdentity.current = authIdentityFor(data.session);
        setSession(data.session);
        if (lockEnabled) setLocked(true);
        await revalidateAuthenticatedSession(data.session);
      } else {
        // Only a successful Auth read of an absent session permits marker-free
        // cold cleanup. A device/storage/restore error can also show signedOut
        // while the member still has a persisted session and saved notes.
        confirmedAbsentSessionTransition.current = data.session === null ? coldRestoreTransition : null;
        observedAuthIdentity.current = null;
        setMode('signedOut');
      }
    }).catch(() => {
      if (!active || sessionTransition.current !== coldRestoreTransition) return;
      observedAuthIdentity.current = null;
      setError('Union Ground could not restore your secure session. Sign in again.');
      setMode('signedOut');
    }).finally(() => {
      if (!coldReadBounded) sessionResumeAttempts.finish(coldRestoreAttempt);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      if (event === 'INITIAL_SESSION') return;
      // Deletion has already cleared protected state and owns local teardown.
      // Auth losing that session must not restart or invalidate its cleanup.
      if (deletionReceipt.current && !nextSession) return;
      // A delayed refresh for a deleted account must never remount its data.
      if (deletionReceipt.current && nextSession
        && nextSession.user.id === deletedUserID.current
        && sessionIDFromAccessToken(nextSession.access_token) === deletedSessionID.current) return;
      if (!nativeAuthGate.observe(nextSession)) return;
      // The native operation adopts its staged session after setSession has
      // released the Auth lock and ownership is checked again. A late native
      // event cannot bootstrap protected state or dismiss deletion by itself.
      if (nativeAuthGate.isStaged(nextSession)) return;
      if (deletionReceipt.current && nextSession) {
        deletionReceipt.current = false;
        deletionSession.current = null;
        deletedUserID.current = null;
        deletedSessionID.current = null;
        deletionCleanupAction.current = async () => undefined;
        setDeletionOutcome(null);
      }
      const signOutDecision = sessionSignOutAttempts.observe(event, nextSession);
      if (signOutDecision.status === 'adopted-refresh') {
        if (!nextSession) return;
        // A token rotation is still the exact server session being closed.
        // Adopt its newest tuple without invalidating the sign-out; a distinct
        // session_id or user falls through and interrupts the attempt.
        observedAuthIdentity.current = authIdentityFor(nextSession);
        activeUserID.current = nextSession.user.id;
        setSession(nextSession);
        return;
      }
      const authEventShareCleanupBoundary = captureSecureShareCleanupBoundary();
      const authEventTransition = ++sessionTransition.current;
      const lostIdentity = observedAuthIdentity.current;
      observedAuthIdentity.current = authIdentityFor(nextSession);
      pendingAuthTransition.current = null;
      const resumeDecision = sessionResumeAttempts.observe(event, nextSession);
      // refreshSession emits auth events synchronously. Its returned session,
      // authoritative getUser result, and MFA assurance are applied together
      // by resumeProtectedSession after the auth callback releases its lock.
      if (resumeDecision.status === 'expected-refresh') {
        if (!nextSession) return;
        // Keep the newest exact token as the covered retry/teardown handle.
        // Protected rows remain cleared until the owning resume validates
        // getUser, MFA assurance, and a fresh RLS bootstrap.
        activeUserID.current = nextSession.user.id;
        setSession(nextSession);
        return;
      }
      const interruptedResume = resumeDecision.interrupted;
      const interruptedResumeExpectedUserID = resumeDecision.interruptedExpectedUserID;
      // Expected rotations returned above. Every other auth boundary retires
      // the old retry immediately, even if its network work never settles.
      sessionRetryOwner.current = null;
      setSessionRetryInFlight(null);
      sessionBootstrapDeadline.current = SESSION_BOOTSTRAP_DEADLINE_MS;
      sessionResumeGuard.invalidate();
      if (nextSession) {
        const nextIdentity = authIdentityFor(nextSession);
        if (!nextIdentity) return;
        const pending = { transition: authEventTransition, identity: nextIdentity };
        pendingAuthTransition.current = pending;
        setPrivacyCovered(true);
        clearProtectedState();
        // Supabase advises against awaiting another auth method from inside the
        // auth-state callback. Move assurance inspection to the next task so
        // the callback can release the auth lock first.
        setTimeout(() => {
          if (!active
            || sessionResumeAttempts.hasActive()
            || sessionTransition.current !== authEventTransition
            || pendingAuthTransition.current !== pending
            || !authIdentityMatches(observedAuthIdentity.current, nextSession)) return;
          if (interruptedResume
            && interruptedResumeExpectedUserID
            && interruptedResumeExpectedUserID !== nextSession.user.id) {
            void preparePendingSharedAttachmentUploadForSessionLoss(
              interruptedResumeExpectedUserID,
              authEventShareCleanupBoundary,
            ).then(() => {
              if (!active
                || sessionResumeAttempts.hasActive()
                || sessionTransition.current !== authEventTransition
                || pendingAuthTransition.current !== pending
                || !authIdentityMatches(observedAuthIdentity.current, nextSession)) return;
              pendingAuthTransition.current = null;
              setSession(nextSession);
              void revalidateAuthenticatedSession(nextSession);
            }).catch(() => {
              if (!active
                || sessionTransition.current !== authEventTransition
                || pendingAuthTransition.current !== pending
                || !authIdentityMatches(observedAuthIdentity.current, nextSession)) return;
              pendingAuthTransition.current = null;
              activeUserID.current = nextSession.user.id;
              shareIsolationBlocked.current = true;
              blockedShareIsolation.current = {
                previousUserID: interruptedResumeExpectedUserID,
                cleanupBoundary: authEventShareCleanupBoundary,
              };
              setSession(nextSession);
              setLocked(false);
              setAssuranceUnavailable(true);
              setError('Union Ground could not isolate a staged share before changing accounts. Keep protected data locked and try again.');
              setMode('mfaRequired');
              setPrivacyCovered(false);
            });
          } else if (interruptedResume) {
            // A cold-restore or newer same-account event still requires the
            // full refresh/getUser/MFA/RLS sequence. It must never inherit a
            // direct establishment path from an older in-flight attempt.
            pendingAuthTransition.current = null;
            setSession(nextSession);
            void revalidateAuthenticatedSession(nextSession);
          } else {
            pendingAuthTransition.current = null;
            void establishSession(nextSession, authEventShareCleanupBoundary);
          }
        }, 0);
      } else {
        liveChannelStore.resetForSession();
        conversationUnreadStore.reset();
        const lostUserID = activeUserID.current;
        const lossTransition = authEventTransition;
        if (lostUserID) {
          void preparePendingSharedAttachmentUploadForSessionLoss(
            lostUserID,
            authEventShareCleanupBoundary,
          )
            .then((result) => {
              if (sessionTransition.current !== lossTransition || activeUserID.current !== null) return;
              if (result === 'recovery-required') {
                setSignOutError('An interrupted attachment upload remains isolated for the signed-out account. Return to that account to finish exact recovery.');
              }
            })
            .catch(() => {
              if (sessionTransition.current !== lossTransition || activeUserID.current !== null) return;
              setSignOutError('Union Ground signed out, but protected share recovery still needs attention. Return to the same account and try again.');
            });
        } else {
          void purgeSecureShareStaging(authEventShareCleanupBoundary).catch(() => {
            setError('Union Ground signed out, but local share cleanup is still pending. Keep the app open to retry.');
          });
        }
        void purgeAttachmentCacheForSessionLoss(() => sessionTransition.current === lossTransition).then((clean) => {
          if (sessionTransition.current !== lossTransition) return;
          if (!clean) setError('Union Ground signed out, but local attachment cleanup is still pending. Keep the app open to retry.');
        }).catch(() => undefined);
        if (event === 'SIGNED_OUT' && lostUserID) {
          void accountLocalTeardown.request(lostUserID,
            () => active && sessionTransition.current === lossTransition && activeUserID.current === null,
          ).then((clean) => {
            if (!clean && active && sessionTransition.current === lossTransition && activeUserID.current === null) {
              setSignOutError(ACCOUNT_CLEANUP_MESSAGE);
            }
          });
        }
        if (event === 'SIGNED_OUT') void clearLocalNotificationPreference().catch(() => undefined);
        dashboardRequest.current += 1;
        suspendOfflineAvailability();
        setOfflineDraftsReady(false);
        if (event === 'SIGNED_OUT') void requestOfflineSignOutCleanup().catch(() => {
          if (sessionTransition.current === lossTransition) setSignOutError(OFFLINE_CLEANUP_MESSAGE);
        });
        activeUserID.current = null;
        shareIsolationBlocked.current = false;
        blockedShareIsolation.current = null;
        setSession(null);
        setDashboard(null);
        setMemberLanguage(null);
        setChapterMemberships([]);
        setOrganizationStaffScope(null);
        setPreviewHat(null);
        setPreviewShellState(null);
        setPreviewDesk(null);
        setPreviewThreads({});
        previewStore.current = {};
        setWidgetLayouts({});
        setLocked(false);
        setPrivacyCovered(false);
        setAssuranceUnavailable(false);
        // The fail-closed screen's words (offline or assurance) end with the
        // session; sign-in renders `error`, so a stale offline sentence there
        // would be false (UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018).
        setError(null);
        // Session loss ends the signed-in diagnosis. Cleanup may still
        // report a new warning with guidance for this signed-out surface.
        setSignOutError(null);
        lastAuthenticatedUserIDRef.current = null;
        lastAuthenticatedSessionIDRef.current = null;
        if (globalSignOutIncompleteRef.current) setGlobalSignOutIncompleteSignedOut(true);
        // A sign-in that set this session and lost it before the signed-in
        // surface says so instead of returning to the form silently. A loss
        // that interrupts a resume is Auth refusing the session: auth-js
        // emits SIGNED_OUT before refreshSession returns, which leaves the
        // resume stale so its own signed-out exit never runs ( round 1).
        // The member's own sign-out and a proven sign-out elsewhere keep
        // their own copy.
        // A refresh this device's resume started and that is still awaiting
        // Auth is the same refusal after the resume's deadline (round 2).
        // The member's own sign-out owns its loss and keeps a pending sign-in
        // until its revoke succeeds.
        const lostNotice = signOutInFlight.current
          ? null
          : interruptedResume || resumeRefreshProvenance.covers(lostIdentity)
            ? signInCompletion.sessionRefused()
            : signInCompletion.sessionLost();
        if (lostNotice && revokedElsewhereSessionID.current === null) setSignInNotice(lostNotice);
        setMode('signedOut');
      }
    });

    return () => {
      active = false;
      sessionResumeGuard.invalidate();
      sessionTransition.current += 1;
      dashboardRequest.current += 1;
      pendingAuthTransition.current = null;
      sessionRetryOwner.current = null;
      listener.subscription.unsubscribe();
      stopAuthRefresh();
    };
  }, [clearProtectedState, establishSession, purgeSecureShareStaging, revalidateAuthenticatedSession, sessionResumeAttempts, sessionResumeGuard, sessionSignOutAttempts, setSession]);

  useEffect(() => {
    if (mode !== 'signedOut') return;
    let active = true;
    const cleanupTransition = sessionTransition.current;
    const cleanupIsCurrent = () => active && sessionTransition.current === cleanupTransition && activeUserID.current === null;
    void accountLocalTeardown.retry(cleanupIsCurrent).then((clean) => {
      if (!cleanupIsCurrent()) return;
      if (!clean) setSignOutError(ACCOUNT_CLEANUP_MESSAGE);
      else setSignOutError((previous) => previous === ACCOUNT_CLEANUP_MESSAGE ? null : previous);
    });
    void retryPendingOfflineSignOutCleanup(() => cleanupIsCurrent()
      && confirmedAbsentSessionTransition.current === cleanupTransition).then(() => {
      if (active) setSignOutError((previous) => previous === OFFLINE_CLEANUP_MESSAGE ? null : previous);
    }).catch(() => { if (active) setSignOutError(OFFLINE_CLEANUP_MESSAGE); });
    return () => { active = false; };
  }, [mode]);

  useEffect(() => {
    const cleanupTransition = sessionTransition.current;
    void purgeAttachmentCache(() => sessionTransition.current === cleanupTransition).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onAppState = (next: AppStateStatus) => {
      const previous = observedAppState.current;
      observedAppState.current = next;
      // Completion contains no protected data and owns its cleanup even if
      // this callback still captures the session from the previous render.
      if (deletionReceipt.current) {
        backgroundedAt.current = null;
        return;
      }
      if ((next === 'background' || next === 'inactive') && backgroundedAt.current === null) {
        backgroundedAt.current = Date.now();
      }
      // The demo session honors the same cover and re-lock so the biometric
      // functions can be tried out without creating an account.
      const protectedSurface = Boolean(session) || mode === 'preview';
      if (next === 'background' || next === 'inactive') {
        sessionRetryOwner.current = null;
        setSessionRetryInFlight(null);
        sessionResumeGuard.invalidate();
        // A sign-out in flight owns `sessionTransition`: bumping it here ends
        // that ownership, so every remaining step fails `signOutStillCurrent`
        // and the attempt returns silently. For a global sign-out that is the
        // one outcome this feature may not produce, because
        // `prepare_my_signout('global')` has already closed the account's
        // barriers and deleted every push row by then, leaving the account half
        // signed out with this device still signed in and the card back at idle
        // (REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009). The sign-out
        // does its own bump when it commits, and its fail-closed exit keeps
        // this session intact, so skipping the bump strands nothing: in-flight
        // work either belongs to the session that is still signed in or is
        // cancelled by the sign-out's own transition. The resume guard and the
        // privacy cover below are unconditional and still run.
        if (!signOutInFlight.current) sessionTransition.current += 1;
        dashboardRequest.current += 1;
        if (shouldCoverOnAppState(next, protectedSurface, nativeAuthGate.isBusy())) setPrivacyCovered(true);
      }
      if (next === 'active') {
        void refreshLowDataSignals();
        const offlineCleanupTransition = sessionTransition.current;
        void retryPendingOfflineSignOutCleanup(() => mode === 'signedOut' && activeUserID.current === null
          && sessionTransition.current === offlineCleanupTransition
          && confirmedAbsentSessionTransition.current === offlineCleanupTransition).then(() => {
          setSignOutError((previousError) => previousError === OFFLINE_CLEANUP_MESSAGE ? null : previousError);
        }).catch(() => {
          // The retry may reject after resume or a newer sign-out failure.
          // Signed-out cleanup copy cannot replace a signed-in diagnosis, and
          // a newer recovery warning already owns the signed-out alert.
          if (activeUserID.current === null) {
            setSignOutError((previousError) => previousError ?? OFFLINE_CLEANUP_MESSAGE);
          }
        });
        const accountCleanupTransition = sessionTransition.current;
        const accountCleanupIsCurrent = () => sessionTransition.current === accountCleanupTransition && activeUserID.current === null;
        if (mode === 'signedOut') void accountLocalTeardown.retry(accountCleanupIsCurrent).then((clean) => {
          if (!accountCleanupIsCurrent()) return;
          if (!clean) setSignOutError(ACCOUNT_CLEANUP_MESSAGE);
          else setSignOutError((previousError) => previousError === ACCOUNT_CLEANUP_MESSAGE ? null : previousError);
        });
        const cleanupTransition = sessionTransition.current;
        void purgeAttachmentCache(() => sessionTransition.current === cleanupTransition).catch(() => undefined);
        if (isSecureShareStagingCleanupRequired()) {
          void retryPendingSharedAttachmentCleanup(
            () => sessionTransition.current === cleanupTransition,
          ).catch(() => undefined);
        }
        const lockDue = protectedSurface && backgroundedAt.current !== null
          && Date.now() - backgroundedAt.current >= lockAfterMilliseconds;
        if (biometricLockEnabled && lockDue) setLocked(true);
        backgroundedAt.current = null;
        if (biometricAvailabilityRefreshDue(previous, next)) {
          // Enrollment can change while backgrounded: re-read the device and
          // take the re-lock decision again on the fresh reading (release a
          // lock nothing can open; lock when a stored preference just became
          // honourable), before the resumed session reveals protected rows.
          void refreshBiometricAvailability().then((snapshot) => {
            if (deletionReceipt.current) return;
            const decision = foregroundLockAfterRefresh(snapshot, lockDue);
            if (decision === 'release') setLocked(false);
            else if (decision === 'lock') setLocked(true);
          }).catch(() => undefined);
        }
        if (previous === 'active') return;
        if (session) {
          // Deferred, never dropped: `serializedSignOut` drains it when the
          // sign-out that owns the session transition has settled.
          if (signOutInFlight.current) deferredForegroundResume.current = true;
          else void resumeAuthenticatedSession();
        } else {
          // PREVIEW has no live auth session; signed-out and booting surfaces
          // contain no protected rows. They can be revealed immediately.
          setPrivacyCovered(false);
        }
      }
    };
    const subscription = AppState.addEventListener('change', onAppState);
    return () => subscription.remove();
  }, [biometricLockEnabled, mode, refreshBiometricAvailability, resumeAuthenticatedSession, session, sessionResumeGuard]);

  useEffect(() => {
    if (mode !== 'authenticated' || !session) return undefined;
    let active = true;
    const handleFailure = () => {
      // Registration failures are reflected by Account's verified state. Raw
      // provider tokens and provider error text must never enter logs here.
    };
    void syncNativePushRegistration().catch(handleFailure);
    const tokenSubscription = startNativePushTokenRotationListener(() => {
      if (active) handleFailure();
    });
    return () => {
      active = false;
      tokenSubscription.remove();
    };
  }, [mode, session]);

  // Foreground unread poll: member_conversation_summaries is a view and cannot
  // be a Realtime source, so while an authenticated session exists and the app
  // is active, re-project the conversation half of the dashboard on the same
  // normal 30s cadence (120s in low data). A failed tick keeps the last
  // good counts; the timer never runs in preview mode and stops on background
  // and sign-out.
  useEffect(() => {
    if (mode !== 'authenticated' || !session) return undefined;
    const userID = session.user.id;
    const poller = createConversationUnreadPoller(userID, {
      load: loadConversationSummaries,
      refusalEpoch: stewardDirectRefusalEpoch,
      intervalMs: unreadPollInterval,
      connected: lowData.signals.connected !== false,
      onPublished: (conversations) => {
        setDashboard((previous) => (previous
          ? { ...previous, conversations: replaceDirectRows(previous.conversations, conversations) }
          : previous));
      },
    });
    conversationPollerRef.current = poller;
    const handleAppState = (next: AppStateStatus) => {
      if (next === 'active') poller.start();
      else poller.stop();
    };
    if (AppState.currentState === 'active') poller.start();
    const subscription = AppState.addEventListener('change', handleAppState);
    return () => {
      subscription.remove();
      conversationPollerRef.current = null;
      poller.stop();
    };
  }, [mode, session?.user.id]);

  useEffect(() => {
    conversationPollerRef.current?.setPolicy(unreadPollInterval, lowData.signals.connected !== false);
  }, [mode, session?.user.id, unreadPollInterval, lowData.signals.connected]);

  // Foreground revocation watch
  // (BUG-UG-NATIVE-SIGN-OUT-EVERYWHERE-NOT-NOTICED-IN-FOREGROUND-20261103):
  // the resume asks Auth only on a return to the foreground, so a "Sign out
  // everywhere" from another device went unnoticed while this app stayed
  // open. While authenticated and active, the watch asks the isolated probe
  // about this exact session; a proven absence hands over to the ordinary
  // resume, whose own refresh, local clear and fail-closed exits decide what
  // the screen shows. Stopped in the background and on any session change.
  useEffect(() => {
    if (mode !== 'authenticated' || !session) return undefined;
    const watch = createForegroundSessionRevocationWatch(session, {
      isGone: capturedSessionIsGone,
      onRevoked: (gone) => {
        if (!authIdentityMatches(observedAuthIdentity.current, gone)) return;
        // A sign-out in flight owns the session transition; it drains the
        // parked resume when it settles, as it does for a foreground return.
        // Its own revoke can be what the probe saw, and its signed-out surface
        // is the member's own, so it carries no "signed out elsewhere" notice.
        if (signOutInFlight.current) {
          deferredForegroundResume.current = true;
          return;
        }
        revokedElsewhereSessionID.current = sessionIDFromAccessToken(gone.access_token);
        void latestResumeAuthenticatedSession.current();
      },
    });
    const handleAppState = (next: AppStateStatus) => {
      if (next === 'active') watch.start();
      else watch.stop();
    };
    if (AppState.currentState === 'active') watch.start();
    const subscription = AppState.addEventListener('change', handleAppState);
    return () => {
      subscription.remove();
      watch.stop();
    };
  }, [mode, session]);

  // The notice belongs to the signed-out surface the proven revocation led to.
  // The resume it starts clears protected state first, which shows 'booting'
  // with the same session until it signs out; a resume superseded by a
  // background keeps the proof for the next one while that session is still
  // held. Another session or a fail-closed exit (mfaRequired) drops it.
  useEffect(() => {
    if (mode === 'signedOut') {
      if (revokedElsewhereSessionID.current !== null) setSignedOutElsewhere(true);
      revokedElsewhereSessionID.current = null;
      return;
    }
    setSignedOutElsewhere(false);
    if ((mode !== 'authenticated' && mode !== 'booting') || !session
      || sessionIDFromAccessToken(session.access_token) !== revokedElsewhereSessionID.current) {
      revokedElsewhereSessionID.current = null;
    }
  }, [mode, session]);

  useEffect(() => {
    if (mode === 'authenticated' || mode === 'mfaRequired' || mode === 'preview') setSignInNotice(null);
  }, [mode]);

  const sampleEntryPending = useRef(false);
  const [sampleEntryBusy, setSampleEntryBusy] = useState(false);
  // The SAMPLE demo entry (UB-UG-NATIVE-DEMO-ENTRY-RESTORED-20261107,
  // owner ruling an owner decision): mint the member persona's
  // session through the server's demo-session endpoint and let the ordinary
  // auth listener establish it, exactly as a password sign-in would. Refused
  // while anything else is settling a session, so no two sign-ins race.
  const enterSample = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (!supabase || mode !== 'signedOut' || observedAuthIdentity.current !== null
      || pendingAuthTransition.current !== null || sessionResumeAttempts.hasActive()
      || sampleEntryPending.current) throw new Error(SAMPLE_UNAVAILABLE);
    sampleEntryPending.current = true;
    setSampleEntryBusy(true);
    const transition = sessionTransition.current;
    setError(null);
    setSignInNotice(null);
    signInCompletion.begin();
    try {
      await openSampleSession(mobileConfig, supabase.auth, () => (
        sessionTransition.current === transition && observedAuthIdentity.current === null
      ));
      await haptics.success();
    } catch (failure) {
      // A refused entry shows its own message under the button.
      signInCompletion.settle();
      await haptics.warning();
      throw failure;
    } finally {
      sampleEntryPending.current = false;
      setSampleEntryBusy(false);
    }
  }, [mode, sessionResumeAttempts]);

  // Explore the demo on the Production store build:
  // it holds the shared sign-in ownership while sample.unionground.example is read, so no
  // other sign-in starts, and it gives up (taking its marker back) if a
  // session arrived or the transition moved on before the restart.
  const enterStoreDemo = useCallback(async () => {
    if (!offersStoreDemo(mobileConfig) || mode !== 'signedOut' || observedAuthIdentity.current !== null
      || pendingAuthTransition.current !== null || sessionResumeAttempts.hasActive()
      || sampleEntryPending.current) throw new Error(STORE_DEMO_UNAVAILABLE);
    sampleEntryPending.current = true;
    setSampleEntryBusy(true);
    const transition = sessionTransition.current;
    try {
      await beginStoreDemo(mobileConfig, storeDemoDevice, () => (
        sessionTransition.current === transition && observedAuthIdentity.current === null
        && pendingAuthTransition.current === null && !sessionResumeAttempts.hasActive()
      ));
    } finally {
      sampleEntryPending.current = false;
      setSampleEntryBusy(false);
    }
  }, [mode, sessionResumeAttempts]);

  const signInWithPassword = useCallback(async (email: string, password: string, onAdopted?: (session: Session) => void) => {
    if (sampleEntryPending.current) throw new Error('The demo is opening. Try again shortly.');
    sampleEntryPending.current = true;
    setSampleEntryBusy(true);
    setError(null);
    setSignInNotice(null);
    signInCompletion.begin();
    try {
      await signInWithEmailPassword(email.trim().toLowerCase(), password, nativeSignInPlatform(Platform.OS), onAdopted);
      await haptics.success();
    } catch (nextError) {
      // A refused attempt shows its own message on the form.
      signInCompletion.settle();
      await haptics.warning();
      throw nextError;
    } finally {
      sampleEntryPending.current = false;
      setSampleEntryBusy(false);
    }
  }, []);

  // Union Ground has no member PIN, so no session is ever restricted and no
  // step-up exists; the fields stay so shared screens keep one shape.
  const sessionRestricted = false;
  const sessionRestrictionPending = false;
  const stepUpWithPassword = useCallback(async (_password: string) => {
    throw new Error('Sign in again with your password.');
  }, []);

  const updatePassword = useCallback(async (password: string, currentPassword: string) => {
    setError(null);
    try {
      const updated = await updateSignedInPassword(password, currentPassword, session);
      if (updated && authIdentityMatches(observedAuthIdentity.current, updated)) setSession(updated);
      await haptics.success();
    } catch (nextError) {
      await haptics.warning();
      throw nextError;
    }
  }, [session, setSession]);

  const verifyMfa = useCallback(async (code: string) => {
    if (!providerMounted.current) return; // #9393: a gone instance sends no code.
    setError(null);
    const expected = observedAuthIdentity.current;
    let establishment: Promise<void> | null = null;
    try {
      await verifyMfaCode(code, session, (nextSession) => {
        const now = observedAuthIdentity.current;
        if (!providerMounted.current || !expected || !now || expected.userID !== now.userID
          || !accessTokensShareSessionLineage(expected.accessToken, now.accessToken)
          || nextSession.user.id !== expected.userID
          || !accessTokensShareSessionLineage(expected.accessToken, nextSession.access_token)) {
          throw new Error('The authenticated session changed during MFA verification.');
        }
        // Staged Auth events intentionally cannot bootstrap the provider.
        // Adopt only the service's guarded installation, as native sign-in does.
        observedAuthIdentity.current = authIdentityFor(nextSession);
        pendingAuthTransition.current = null;
        establishment = establishSession(nextSession);
        void establishment.catch(() => undefined); // swallow-ok: awaited below after the Auth operation releases its gate
      });
      if (!providerMounted.current) return; // #9381: a gone instance establishes nothing.
      if (!establishment) throw new Error('The authenticated session was not installed.');
      await establishment;
      await haptics.success();
    } catch {
      await haptics.warning();
      throw new Error('That authenticator code could not be verified.');
    }
  }, [establishSession, session]);

  const beginMfaRecovery = useCallback((): MfaRecoveryAttempt | null => {
    const userID = activeUserID.current;
    const observed = observedAuthIdentity.current;
    if (!session || userID !== session.user.id || !observed) return null;
    const captured = authIdentityMatches(observed, session) ? session
      : observed.userID === userID && accessTokensShareSessionLineage(observed.accessToken, session.access_token)
        ? { ...session, access_token: observed.accessToken, refresh_token: observed.refreshToken } : null;
    if (!captured) return null;
    return { userID, session: captured, latch: globalSignOutIncompleteRef.current ? globalSignOutIncompleteOwnerRef.current : null };
  }, [session]);

  const finishMfaRecovery = useCallback(async (attempt: MfaRecoveryAttempt): Promise<boolean> => {
    const observed = observedAuthIdentity.current;
    if (!providerMounted.current) return false;
    if (!observed && activeUserID.current === null) return true;
    if (!observed || activeUserID.current !== attempt.userID || observed.userID !== attempt.userID
      || (!authIdentityMatches(observed, attempt.session)
        && !accessTokensShareSessionLineage(observed.accessToken, attempt.session.access_token))) return false;
    const captured = { ...attempt.session, access_token: observed.accessToken, refresh_token: observed.refreshToken };
    const signOutAttempt = sessionSignOutAttempts.begin(captured);
    const cleanupBoundary = captureSecureShareCleanupBoundary();
    const stillOwned = () => providerMounted.current && activeUserID.current === attempt.userID
      && sessionSignOutAttempts.identityIsCurrent(signOutAttempt, observedAuthIdentity.current);
    // Retire an already-scheduled same-session establishment before storage
    // I/O. Recovery's server logout is complete; no authenticated barrier or
    // remote share reconciliation can be a prerequisite for this local clear.
    sessionTransition.current += 1;
    pendingAuthTransition.current = null;
    sessionRetryOwner.current = null;
    setSessionRetryInFlight(null);
    sessionResumeGuard.invalidate();
    nativeAuthGate.cancel();
    try {
      let cleared = false;
      for (let tries = 0; tries < 3 && stillOwned(); tries += 1) {
        const current = sessionSignOutAttempts.latestSessionFor(signOutAttempt);
        if (!current) return false;
        cleared = await clearCapturedMobileSessionLocally(current);
        if (!stillOwned()) return activeUserID.current === null && observedAuthIdentity.current === null;
        if (cleared) break;
        const latest = sessionSignOutAttempts.latestSessionFor(signOutAttempt);
        if (!latest || authIdentityMatches(exactSessionIdentity(current), latest)) return false;
      }
      if (!cleared) return false;
      signInCompletion.settle();
      setSignInNotice(null);
      purgeHomeWidgets();
      observedAuthIdentity.current = null;
      activeUserID.current = null;
      pendingAuthTransition.current = null;
      shareIsolationBlocked.current = false;
      blockedShareIsolation.current = null;
      lastAuthenticatedUserIDRef.current = null;
      lastAuthenticatedSessionIDRef.current = null;
      clearProtectedState();
      setSession(null);
      setLocked(false);
      setPrivacyCovered(false);
      setAssuranceUnavailable(false);
      setError(null);
      setSignOutError(null);
      setGlobalSignOutIncompleteSignedOut(globalSignOutIncompleteRef.current);
      setMode('signedOut');
      const settledTransition = sessionTransition.current;
      const stillSignedOut = () => providerMounted.current && activeUserID.current === null
        && sessionTransition.current === settledTransition;
      const cleanup = await Promise.allSettled([
        preparePendingSharedAttachmentUploadForSessionLoss(attempt.userID, cleanupBoundary),
        accountLocalTeardown.request(attempt.userID, stillSignedOut),
        requestOfflineSignOutCleanup(), purgeAttachmentCacheForSessionLoss(stillSignedOut),
        clearLocalNotificationPreference(),
      ]);
      if (stillSignedOut()) {
        if (cleanup[0]?.status === 'fulfilled' && cleanup[0].value === 'recovery-required') {
          setSignOutError('An interrupted attachment upload remains isolated for the signed-out account. Return to that account to finish exact recovery.');
        } else if (cleanup.some((item) => item.status === 'rejected' || item.value === false)) {
          setSignOutError(ACCOUNT_CLEANUP_MESSAGE);
        }
      }
      return true;
    } finally { sessionSignOutAttempts.finish(signOutAttempt); }
  }, [clearProtectedState, sessionResumeGuard, sessionSignOutAttempts, setSession]);

  // A recovery code redeemed at the challenge makes the server remove the
  // factor and run GoTrue's global logout for the account, and it answers
  // recovered only once that logout succeeded. The local sign-out that follows
  // reaches the auth handler, which re-raises the signed-out warning from the
  // latch, so the latch and the warning are released here first. A rejected,
  // unavailable or unconfirmed recovery never calls this, and an attempt for
  // another account, or one older than the latch now held, releases nothing:
  // the account whose global sign-out failed may still have live devices.
  // This device may already have lost the session before the answer arrives
  // (a foreground resume sees the revoked refresh token and signs out), which
  // leaves no active account; that is still the attempt's own account, so only
  // a different account now signed in refuses.
  const confirmMfaRecoveryGlobalSignOut = useCallback((attempt: MfaRecoveryAttempt) => {
    if (activeUserID.current !== null && activeUserID.current !== attempt.userID) return false;
    if (!globalSignOutIncompleteRef.current) return false;
    const owner = globalSignOutIncompleteOwnerRef.current;
    if (!owner || owner !== attempt.latch || owner.userID !== attempt.userID) return false;
    globalSignOutIncompleteRef.current = false;
    globalSignOutIncompleteOwnerRef.current = null;
    setGlobalSignOutIncompleteSignedOut(false);
    return true;
  }, []);

  const retrySessionAuthentication = useCallback(async () => {
    // A running sign-out owns the session; a revalidation now would supersede
    // it and could end a "Sign out everywhere" without its warning. The caller
    // is told it was refused so a once-per-account latch is not spent on a call
    // that never ran (REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009).
    if (!providerMounted.current || !session || signOutInFlight.current || deletionReceipt.current || nativeAuthGate.isBusy()
      || !authIdentityMatches(observedAuthIdentity.current, session)) return false;
    const identity = exactSessionIdentity(session);
    const owner = sessionRetryOwner.current;
    if (owner && owner.userID === identity.userID
      && (exactSessionIdentityMatches(owner, identity)
        || accessTokensShareSessionLineage(owner.accessToken, identity.accessToken))) return false;
    const pending = pendingAuthTransition.current;
    if (pending && !exactSessionIdentityMatches(pending.identity, identity)) return false;
    // Retire a stalled establishment before retrying through the full forced
    // refresh/getUser/MFA/RLS path. Late work retains no write capability.
    sessionRetryOwner.current = identity;
    setSessionRetryInFlight(identity);
    sessionResumeGuard.invalidate();
    sessionTransition.current += 1;
    dashboardRequest.current += 1;
    pendingAuthTransition.current = null;
    try {
      await resumeAuthenticatedSession();
      return true;
    } finally {
      if (sessionRetryOwner.current === identity) {
        sessionRetryOwner.current = null;
        setSessionRetryInFlight(null);
      }
    }
  }, [resumeAuthenticatedSession, session, sessionResumeGuard]);

  useSessionCheckRecovery(Boolean(session) && (privacyCovered || assuranceUnavailable)
    && !signOutBusy && !deletionOutcome && !blockedShareIsolation.current,
  session, retrySessionAuthentication);

  const applyPreviewHat = useCallback((hat: PreviewHatKey) => {
    const stored = previewStore.current[hat];
    const dashboard = stored?.dashboard ?? previewDashboardFor(hat);
    const desk = stored?.desk ?? previewDeskFor(hat);
    const threads = stored?.threads ?? previewConversationThreadsFor(hat);
    setPreviewHat(hat);
    setDashboard(dashboard);
    setPreviewDesk(desk);
    setPreviewThreads(threads);
    setMemberLanguage(dashboard.member.language);
    setChapterMemberships([{
      chapterID: dashboard.member.chapterID ?? 'sample-chapter',
      organizationID: PREVIEW_ORGANIZATION_ID,
      name: 'Harborview Care United',
      region: 'Fictional preview',
      selected: true,
      pinned: true,
      lastSelectedAt: new Date().toISOString(),
      joinedAt: '2026-01-01T00:00:00.000Z',
      roles: hat === 'member' ? [] : [hat],
      organizationRoles: hat === 'member' ? [] : [hat],
      chapterRoles: [],
    }]);
  }, []);

  const snapshotPreviewHat = useCallback((hat: PreviewHatKey | null, dashboard: MemberDashboard | null, desk: PreviewDesk | null, threads: Record<string, MemberConversationThread>) => {
    if (!hat || !dashboard || !desk) return;
    previewStore.current[hat] = { dashboard, desk, threads };
  }, []);

  const enterPreview = useCallback((options?: { hat?: PreviewHatKey; shell?: PreviewShell }) => {
    if (sampleEntryPending.current || !previewAllowed
      || observedAuthIdentity.current !== null
      || pendingAuthTransition.current !== null
      || sessionResumeAttempts.hasActive()
      || session !== null
      || activeUserID.current !== null) return;
    sessionResumeGuard.invalidate();
    sessionTransition.current += 1;
    dashboardRequest.current += 1;
    suspendOfflineAvailability();
    setOfflineDraftsReady(false);
    void purgeOfflineAvailability().catch(() => undefined);
    activeUserID.current = null;
    liveChannelStore.resetForSession();
    conversationUnreadStore.reset();
    resetPreviewHandoffs();
    setSession(null);
    applyPreviewHat(options?.hat ?? 'member');
    setPreviewShellState(options?.shell ?? 'tabs');
    setMode('preview');
    setError(null);
    setPrivacyCovered(false);
    setAssuranceUnavailable(false);
    setSignOutError(null);
    void haptics.select();
  }, [applyPreviewHat, previewAllowed, session, sessionResumeAttempts, sessionResumeGuard]);

  const switchPreviewHat = useCallback((hat: PreviewHatKey) => {
    if (mode !== 'preview') return;
    snapshotPreviewHat(previewHat, dashboard, previewDesk, previewThreads);
    applyPreviewHat(hat);
    void haptics.select();
  }, [applyPreviewHat, dashboard, mode, previewDesk, previewHat, previewThreads, snapshotPreviewHat]);

  const previewThread = useCallback((conversationID: string) => previewThreads[conversationID] ?? null, [previewThreads]);

  const startPreviewConversation = useCallback((body: string) => {
    if (mode !== 'preview' || !dashboard) throw new Error('The demo account is not unlocked.');
    const clean = body.trim();
    if (!clean) throw new Error('Write a message before starting the conversation.');
    const id = Crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const thread: MemberConversationThread = {
      conversation: {
        id,
        counterpartRole: 'steward',
        title: 'Organizing committee',
        initials: 'SO',
        createdAt,
        updatedAt: createdAt,
        unreadCount: 0,
        latestMessage: clean,
      },
      messages: [{
        id: Crypto.randomUUID(),
        conversationID: id,
        senderKind: 'member',
        senderName: dashboard.member.fullName,
        body: clean,
        readAt: createdAt,
        createdAt,
      }],
    };
    setPreviewThreads((current) => ({ ...current, [id]: thread }));
    setDashboard({
      ...dashboard,
      conversations: [thread.conversation, ...dashboard.conversations],
    });
    void haptics.success();
    return id;
  }, [dashboard, mode]);

  const sendPreviewMessage = useCallback((conversationID: string, body: string) => {
    if (mode !== 'preview' || !dashboard) throw new Error('The demo account is not unlocked.');
    const clean = body.trim();
    if (!clean) throw new Error('Write a message before sending.');
    const existing = previewThreads[conversationID];
    if (!existing) throw new Error('Conversation not available');
    const createdAt = new Date().toISOString();
    const thread: MemberConversationThread = {
      conversation: { ...existing.conversation, updatedAt: createdAt, latestMessage: clean, unreadCount: 0 },
      messages: [...existing.messages, {
        id: Crypto.randomUUID(),
        conversationID,
        senderKind: 'member',
        senderName: dashboard.member.fullName,
        body: clean,
        readAt: createdAt,
        createdAt,
      }],
    };
    setPreviewThreads((current) => ({ ...current, [conversationID]: thread }));
    setDashboard({
      ...dashboard,
      conversations: dashboard.conversations.map((item) => item.id === conversationID ? thread.conversation : item),
    });
    void haptics.success();
    return thread;
  }, [dashboard, mode, previewThreads]);

  const setPreviewShell = useCallback((shell: PreviewShell) => {
    if (mode !== 'preview') return;
    setPreviewShellState(shell);
  }, [mode]);

  const previewWidgetLayout = useCallback((hat: PreviewHatKey) => widgetLayouts[hat] ?? null, [widgetLayouts]);

  const setPreviewWidgetLayout = useCallback((hat: PreviewHatKey, layout: WidgetLayout) => {
    if (mode !== 'preview') return;
    setWidgetLayouts((current) => ({ ...current, [hat]: layout }));
  }, [mode]);

  const retryDeletionCleanup = useCallback(async () => {
    await deletionCleanupAction.current();
  }, []);

  const acknowledgeDeletion = useCallback(() => {
    if (deletionCleanup !== 'done') return;
    deletionReceipt.current = false;
    deletionSession.current = null;
    deletedUserID.current = null;
    deletedSessionID.current = null;
    deletionCleanupAction.current = async () => undefined;
    setDeletionOutcome(null);
  }, [deletionCleanup]);

  const deleteAccount = useCallback(async (confirmation: string, password?: string) => {
    if (mode !== 'authenticated' || !session || sampleHatForSession(mobileConfig, session)
      || confirmation !== 'DELETE MY ACCOUNT'
      || deletionSession.current || deletionReceipt.current || signOutInFlight.current) throw new Error('not-permitted');
    const captured = session;
    const language = memberLanguage === 'es' ? 'es' : 'en';
    deletionSession.current = captured;
    let result: { deleted: true; audited: boolean } | null = null;
    try { result = await deleteMobileAccount(captured, confirmation, password); }
    catch (failure) {
      if (!(failure instanceof Error) || failure.message !== 'account-delete-indeterminate') {
        deletionSession.current = null;
        throw failure;
      }
    }
    const current = observedAuthIdentity.current;
    if (current && (current.userID !== captured.user.id
      || (current.accessToken !== captured.access_token
        && !accessTokensShareSessionLineage(current.accessToken, captured.access_token)))) {
      deletionSession.current = null;
      return;
    }
    // Publish above navigation before any asynchronous cleanup. Auth teardown
    // may unmount Account immediately; the receipt contains no protected data.
    deletionReceipt.current = true;
    deletedUserID.current = captured.user.id;
    deletedSessionID.current = sessionIDFromAccessToken(captured.access_token);
    setDeletionOutcome({ audited: result?.audited === true, uncertain: result === null, language });
    setDeletionCleanup('pending');
    sessionTransition.current += 1;
    sessionResumeGuard.invalidate();
    nativeAuthGate.cancel();
    pendingAuthTransition.current = null;
    clearProtectedState();
    activeUserID.current = null;
    observedAuthIdentity.current = null;
    setSession(null);
    setPreviewHat(null);
    setPreviewShellState(null);
    setPreviewDesk(null);
    setPreviewThreads({});
    previewStore.current = {};
    setWidgetLayouts({});
    setLocked(false);
    setPrivacyCovered(false);
    setMode('signedOut');
    const userID = captured.user.id;
    let cleanupSession: Session | null = captured;
    // AppState can advance the session transition while this signed-out
    // cleanup awaits storage. Only an accepted replacement account retires
    // the deletion receipt; ordinary background/auth loss cannot cancel it.
    const stillDeleted = () => deletionReceipt.current && deletedUserID.current === userID
      && activeUserID.current === null;
    deletionCleanupAction.current = async () => {
      if (!stillDeleted()) return;
      setDeletionCleanup('pending');
      try {
        // Never call prepare_my_signout: this account is already gone. Clear
        // only its exact stored credential and use the existing local purges.
        const client = getSupabaseClient();
        if (!client) throw new Error('cleanup-pending');
        if (cleanupSession) {
          const cleared = await clearCapturedMobileSessionLocally(cleanupSession);
          if (!cleared && (await client.auth.getSession()).data.session) throw new Error('cleanup-pending');
          cleanupSession = null;
          deletionSession.current = null;
        }
        if (!stillDeleted()) return;
        const results = await Promise.allSettled([
          accountLocalTeardown.request(userID, stillDeleted),
          requestOfflineSignOutCleanup(),
          purgeAttachmentCacheForSessionLoss(stillDeleted),
          discardAllPendingSharedAttachments(stillDeleted),
        ]);
        if (!stillDeleted()) return;
        if (results.some((item) => item.status === 'rejected' || item.value === false)) throw new Error('cleanup-pending');
        setDeletionCleanup('done');
        deletionCleanupAction.current = async () => undefined;
      } catch { if (stillDeleted()) setDeletionCleanup('failed'); }
    };
    await deletionCleanupAction.current();
  }, [mode, session, memberLanguage, clearProtectedState, sessionResumeGuard, setSession]);

  const signOut = useCallback(async (options?: { silent?: boolean; scope?: SignOutScope }) => {
    const liveSession = mode === 'authenticated' || mode === 'mfaRequired';
    // REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009. `global` is the
    // Account > Sessions "Sign out everywhere" action: one confirmed press
    // revokes every session of the account on the server and then performs the
    // ordinary local teardown, so this device returns to sign-in with its
    // protected state cleared. There is no server session to revoke in
    // preview, so that mode stays local whatever the caller asked for.
    const scope: SignOutScope = liveSession && options?.scope === 'global' ? 'global' : 'local';
    const renderedSession = liveSession ? session : null;
    const observedIdentity = observedAuthIdentity.current;
    // Recovery's getSession (or its POST) may rotate this session before the
    // captured action starts. Begin against that newest tuple only when the
    // user and server session_id still match; a replacement login owns itself.
    const capturedSession = renderedSession && observedIdentity
      && !authIdentityMatches(observedIdentity, renderedSession)
      && observedIdentity.userID === renderedSession.user.id
      && accessTokensShareSessionLineage(observedIdentity.accessToken, renderedSession.access_token)
      ? { ...renderedSession, access_token: observedIdentity.accessToken, refresh_token: observedIdentity.refreshToken }
      : renderedSession;
    const expectedUserID = capturedSession?.user.id ?? null;
    if (pendingAuthTransition.current !== null) return;
    if (liveSession && (!capturedSession
      || !expectedUserID
      || activeUserID.current !== expectedUserID
      || !authIdentityMatches(observedAuthIdentity.current, capturedSession))) return;
    if (mode === 'preview' && (session !== null
      || activeUserID.current !== null
      || observedAuthIdentity.current !== null)) return;
    if (!liveSession && mode !== 'preview') return;
    purgeHomeWidgets();
    sessionRetryOwner.current = null;
    setSessionRetryInFlight(null);
    nativeAuthGate.cancel();
    const signOutAttempt = liveSession && capturedSession
      ? sessionSignOutAttempts.begin(capturedSession)
      : null;
    const finishSignOutAttempt = () => {
      if (signOutAttempt) sessionSignOutAttempts.finish(signOutAttempt);
    };
    const isolationAlreadyBlocked = shareIsolationBlocked.current;
    const signOutTransition = ++sessionTransition.current;
    // BUG-UG-NATIVE-SIGN-OUT-DURING-SESSION-CHECK-SHOWS-OFFLINE-20261103:
    // a check this press interrupts goes stale and never settles its screen,
    // so a sign-out that then keeps the session left the cover, or an earlier
    // verdict, with no owner. The interrupted check is owed again exactly as a
    // foreground during the sign-out is: `serializedSignOut` drains it once
    // this attempt settles, revealing a committed sign-out or re-running the
    // check for a session that stayed.
    if (sessionResumeAttempts.hasActive()) deferredForegroundResume.current = true;
    sessionResumeGuard.invalidate();
    const signOutActionStillOwned = () => (
      sessionTransition.current === signOutTransition
      && (liveSession
        ? expectedUserID !== null && activeUserID.current === expectedUserID
        : activeUserID.current === null)
    );
    const signOutStillCurrent = () => {
      const current = signOutActionStillOwned()
      && pendingAuthTransition.current === null
      && (liveSession
        ? signOutAttempt !== null
          && sessionSignOutAttempts.identityIsCurrent(signOutAttempt, observedAuthIdentity.current)
        : observedAuthIdentity.current === null);
      if (!current) finishSignOutAttempt();
      return current;
    };
    setSignOutError(null);
    if (!isolationAlreadyBlocked) {
      // The offline-lock abort in BUG-UG-MOBILE-SIGNOUT-CACHE-PURGE-ABORT
      // was observed once and its originating exception was never captured,
      // because this catch discarded it. Name the step in flight and record an
      // enumerated, content-free reason code so the next drill can locate the
      // failing call. The refusal names that step and keeps the session intact.
      let cleanupStep: 'purge-attachment-cache' | 'pending-share-upload' | 'pending-share-staging' =
        'purge-attachment-cache';
      try {
        recordLifecycleEvent({ scope: 'sign-out', step: 'cleanup-step-start', outcome: cleanupStep });
        await purgeAttachmentCacheForSignOut(signOutStillCurrent);
        recordLifecycleEvent({ scope: 'sign-out', step: 'cleanup-step-done', outcome: cleanupStep });
        if (!signOutStillCurrent()) return;
        cleanupStep = liveSession && expectedUserID ? 'pending-share-upload' : 'pending-share-staging';
        recordLifecycleEvent({ scope: 'sign-out', step: 'cleanup-step-start', outcome: cleanupStep });
        if (liveSession && expectedUserID) {
          await preparePendingSharedAttachmentUploadForSignOut(expectedUserID, signOutStillCurrent, captureSessionWriter(capturedSession));
        } else {
          await preparePendingSharedAttachmentStagingForPreviewExit(signOutStillCurrent);
        }
        recordLifecycleEvent({ scope: 'sign-out', step: 'cleanup-step-done', outcome: cleanupStep });
        if (!signOutStillCurrent()) return;
      } catch (attachmentCleanupFailure) {
        recordLifecycleEvent({
          scope: 'sign-out',
          step: 'cleanup-failed',
          outcome: cleanupStep,
          error: attachmentCleanupFailure,
        });
        if (signOutStillCurrent()) {
          finishSignOutAttempt();
          if (cleanupStep === 'purge-attachment-cache') {
            setSignOutError('Union Ground could not clear temporary attachments. You remain signed in; keep the app open and try again.');
          } else {
            setSignOutError('Union Ground could not prepare pending shared attachments for sign-out. You remain signed in; keep the app open and try again.');
          }
          if (!options?.silent) await haptics.warning();
        }
        return;
      }
    }
    if (mode === 'preview') {
      await clearLocalNotificationPreference().catch(() => undefined);
      if (!signOutStillCurrent()) return;
    }
    if (liveSession) {
      if (!capturedSession || !expectedUserID) {
        finishSignOutAttempt();
        return;
      }
      let registrationPauseOwned = false;
      let serverSignOutPrepared = false;
      const releaseRegistrationPause = () => {
        if (!registrationPauseOwned) return;
        resumeNativePushRegistration();
        registrationPauseOwned = false;
      };
      const latestSignOutSession = () => {
        if (!signOutAttempt || !signOutStillCurrent()) return null;
        return sessionSignOutAttempts.latestSessionFor(signOutAttempt);
      };
      try {
        const sessionReady = await prepareSessionForServerSignOut(latestSignOutSession, async () => {
          const authClient = getSupabaseClient();
          if (!authClient) throw tagSignOutProvenance(new Error('The secure mobile backend is not configured.'), 'local');
          return authClient.auth.getSession();
        }, {
          reachable: () => (mobileConfig.supabaseUrl
            ? backendReachable(mobileConfig.supabaseUrl, mobileConfig.supabasePublishableKey)
            : Promise.resolve(false)),
        });
        if (!sessionReady || !signOutStillCurrent()) {
          finishSignOutAttempt();
          return;
        }
        registrationPauseOwned = true;
        // Native/local cleanup steps are tagged `local` at the boundary so a
        // device failure (a SecureStore or native-module error code) is never
        // read as a service answer. The RPC steps below keep their own service
        // provenance and must not be wrapped.
        await runLocalSignOutStep(() => pauseNativePushRegistration());
        if (!signOutStillCurrent()) {
          releaseRegistrationPause();
          return;
        }
        try {
          const pushCleanupSession = latestSignOutSession();
          if (!pushCleanupSession) {
            releaseRegistrationPause();
            return;
          }
          const pushCleanupClient = createCapturedSessionRpcClient(pushCleanupSession);
          await deleteNativePushInstallationForSignOut(
            pushCleanupClient,
            expectedUserID,
            pushCleanupSession.access_token,
            signOutStillCurrent,
          );
          if (!signOutStillCurrent()) {
            releaseRegistrationPause();
            return;
          }
          const serverCleanupSession = latestSignOutSession();
          if (!serverCleanupSession) {
            releaseRegistrationPause();
            return;
          }
          const serverCleanupClient = createCapturedSessionRpcClient(serverCleanupSession);
          // Keep the whole response, not `{ data, error }`. PostgREST answers a
          // non-JSON 4xx/5xx with `error: { message }` — no code, no status — and
          // reports the real HTTP status only as the response-level `status`, so
          // destructuring the pair throws away the one fact that proves the
          // service answered and makes a 502 read as a dropped connection.
          const cleanupResponse = await prepareMySignOut(serverCleanupClient, scope, expectedUserID);
          if (!signOutStillCurrent()) {
            releaseRegistrationPause();
            return;
          }
          const cleanupRejection = signOutCleanupRejection(cleanupResponse);
          if (cleanupRejection) throw cleanupRejection;
          serverSignOutPrepared = true;
        } catch (serverBarrierFailure) {
          // A session already revoked on the server (an MFA recovery on another
          // phone) is refused by both barrier calls: they need a live
          // auth.sessions row. Their 42501 alone proves nothing, so only Auth's
          // own session_not_found for this captured token lets sign-out finish
          // locally; any other answer stays fail-closed through the outer catch
          // (BUG-UG-MOBILE-REVOKED-SESSION-STUCK-20261002).
          // A global sign-out never takes this exit. This session being gone
          // proves nothing about the account's other devices, so finishing
          // locally would return the member to sign-in while every other
          // session stayed live — a silent false success for the one action
          // whose whole purpose is the other devices. It stays fail-closed and
          // the member is told to sign out of this device instead.
          const barrierSession = scope === 'global' ? null : latestSignOutSession();
          if (!barrierSession || !(await capturedSessionIsGone(barrierSession))) throw serverBarrierFailure;
          if (!signOutStillCurrent()) {
            releaseRegistrationPause();
            return;
          }
          recordLifecycleEvent({ scope: 'sign-out', step: 'server-barrier-skipped', outcome: 'session-end' });
        }
        await runLocalSignOutStep(() => clearNativePushPreferenceForSignOut(expectedUserID, signOutStillCurrent));
        if (!signOutStillCurrent()) {
          releaseRegistrationPause();
          return;
        }
        const revocationSession = latestSignOutSession();
        if (!revocationSession) {
          releaseRegistrationPause();
          return;
        }
        const sessionCleared = await runLocalSignOutStep(() => revokeAndClearCapturedMobileSession(revocationSession, scope));
        if (!signOutStillCurrent()) {
          releaseRegistrationPause();
          return;
        }
        // A revoke that reports the persisted session changed is a local
        // client-state condition, not a service answer.
        if (!sessionCleared) throw tagSignOutProvenance(new Error('The persisted session changed during sign-out.'), 'local');
        // The member's own sign-out is not a sign-in that failed to complete.
        // Settled only once the revoke has succeeded: a refused or failed one
        // keeps the session and its pending sign-in ( rounds 1 and 2).
        signInCompletion.settle();
        await clearLocalNotificationPreference().catch(() => undefined);
        if (!signOutStillCurrent()) {
          releaseRegistrationPause();
          return;
        }
        observedAuthIdentity.current = null;
        pendingAuthTransition.current = null;
      } catch (serverSignOutFailure) {
        releaseRegistrationPause();
        // The fail-closed refusal below is deliberate and unchanged: a failure
        // here never reports a completed sign-out. Only the diagnosis is
        // classified. A server that answers and refuses the call — the hosted
        // prepare_my_signout shape drift returns PGRST202 — is not a
        // connectivity problem, and telling a well-connected member to
        // reconnect sends them into an unbounded retry and points an operator
        // away from the real cause. See
        // FIX-UG-MOBILE-SIGNOUT-FAILURE-COPY-20260905.
        const failureKind = classifySignOutFailure(serverSignOutFailure);
        recordLifecycleEvent({
          scope: 'sign-out',
          step: 'server-cleanup-failed',
          outcome: failureKind,
          detail: { serverSignOutPrepared },
          error: serverSignOutFailure,
        });
        if (!signOutStillCurrent()) return;
        finishSignOutAttempt();
        // A completed prepare transaction leaves an intentional closing
        // barrier. Never silently re-register behind it after an uncertain
        // revoke or prepare: either request may still finish on the server.
        // Earlier installation cleanup may also have succeeded before prepare.
        setSignOutError(signOutFailureMessage(failureKind, { serverSignOutPrepared, scope }));
        if (!options?.silent) await haptics.warning();
        return;
      }
      releaseRegistrationPause();
    }
    finishSignOutAttempt();
    if (!signOutActionStillOwned()) return;
    // The server/session commit is complete; account-local failures remain
    // retryable and cannot turn a completed sign-out into a signed-in state.
    let accountCleanupFailed = false;
    if (liveSession && expectedUserID) {
      accountCleanupFailed = !(await accountLocalTeardown.request(expectedUserID,
        signOutActionStillOwned, { pushAlreadyCleared: true }));
    }
    if (!signOutActionStillOwned()) return;
    suspendOfflineAvailability();
    setOfflineDraftsReady(false);
    let offlineCleanupFailed = false;
    try { await requestOfflineSignOutCleanup(); }
    catch { offlineCleanupFailed = true; }
    if (!signOutActionStillOwned()) return;
    sessionTransition.current += 1;
    dashboardRequest.current += 1;
    activeUserID.current = null;
    shareIsolationBlocked.current = false;
    blockedShareIsolation.current = null;
    liveChannelStore.resetForSession();
    setSession(null);
    setDashboard(null);
    setMemberLanguage(null);
    setChapterMemberships([]);
    setOrganizationStaffScope(null);
    setPreviewHat(null);
    setPreviewShellState(null);
    setPreviewDesk(null);
    setPreviewThreads({});
    previewStore.current = {};
    setWidgetLayouts({});
    setMode('signedOut');
    setLocked(false);
    setPrivacyCovered(false);
    setAssuranceUnavailable(false);
    // Same as the SIGNED_OUT listener: the fail-closed words end with the session.
    setError(null);
    setSignOutError(accountCleanupFailed ? ACCOUNT_CLEANUP_MESSAGE : offlineCleanupFailed ? OFFLINE_CLEANUP_MESSAGE : null);
    // A committed global sign-out ends the account's other sessions, so the
    // latch is released. A committed local one after an incomplete global
    // attempt leaves them possibly live, and this signed-out surface says so.
    lastAuthenticatedUserIDRef.current = null;
    lastAuthenticatedSessionIDRef.current = null;
    if (scope === 'global') globalSignOutIncompleteRef.current = false;
    else if (globalSignOutIncompleteRef.current) setGlobalSignOutIncompleteSignedOut(true);
    if (!options?.silent) await haptics.select();
  }, [mode, session, sessionResumeGuard, sessionSignOutAttempts, setSession]);

  // One sign-out owns the device until it settles, whatever its scope. Any
  // second attempt would supersede the first at its ownership check: a global
  // attempt would stop silently while a local one returned this device to
  // sign-in with every other session still live, and a global press during a
  // local logout would find this session already gone and fail
  // (REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009).
  const serializedSignOut = useCallback(async (options?: { silent?: boolean; scope?: SignOutScope }) => {
    if (signOutInFlight.current) return;
    const signOutUserID = activeUserID.current;
    signOutInFlight.current = true;
    setSignOutBusy(true);
    // The latch is set when a global attempt is admitted, not only when it
    // returns: Auth can end this session while prepare_my_signout is still
    // pending, and its handler clears `activeUserID`, so an attempt that is
    // then no longer current returns silently and the wrapper's own check
    // below sees a signed-out device. The handler consults the latch as it
    // signs the device out, so the warning survives that order too (Sol final
    // on). A completed global sign-out releases it in the commit path.
    if (options?.scope === 'global' && activeUserID.current !== null) {
      globalSignOutIncompleteRef.current = true;
      globalSignOutIncompleteOwnerRef.current = { userID: activeUserID.current };
    }
    let globalSignOutIncomplete = false;
    try {
      await signOut(options);
    } finally {
      signOutInFlight.current = false;
      // A global attempt that returns with this device still signed in has
      // left the account at best half signed out. That outcome is read here,
      // before the deferred resume below can change what this device knows
      // about its own session: a resume that finds the session definitively
      // gone clears `activeUserID` and the retained refusal copy together,
      // which is right for the signed-in screen that copy addressed but would
      // also erase the one fact the signed-out surface still owes the member
      // (SEC-UG-FAILED-SIGN-OUT-EVERYWHERE-END-SIGN-SCREEN-WARNING-20261013).
      // Read from the latch set at admission, never re-armed here: a stale
      // attempt that returns after a replacement login released the latch
      // must not hang the previous account's warning on the new one (Sol
      // round 4 on).
      globalSignOutIncomplete = options?.scope === 'global' && activeUserID.current !== null
        && activeUserID.current === signOutUserID && globalSignOutIncompleteRef.current;
      // The foreground this attempt deferred runs now that the attempt no
      // longer owns the session transition, so the privacy cover is cleared on
      // both outcomes: a session that survived a fail-closed exit is revealed
      // by its own resume, and a committed sign-out reveals the signed-out
      // surface, which holds no protected rows and has no session to resume.
      // The resume reports its own failures through the card. A foreground that
      // has ended since keeps the cover up: the resume guard it invalidated
      // cannot stop a resume that starts after it, so this drain runs only
      // while the app is active, and the next foreground resumes otherwise.
      const resumeDeferred = deferredForegroundResume.current;
      deferredForegroundResume.current = false;
      if (resumeDeferred && observedAppState.current === 'active') {
        if (activeUserID.current === null) setPrivacyCovered(false);
        else await latestResumeAuthenticatedSession.current().catch(() => undefined);
      }
      setSignOutBusy(false);
    }
    // Belt and braces for every cancellation the lock cannot prevent (an
    // auth event, a session loss, a lifecycle bump this wrapper does not
    // own): a global attempt that returns with this device still signed in
    // may have left the account half signed out, and the member has to be
    // told rather than watch the card return to idle. This runs after the
    // deferred foreground above, so a cancelled attempt is still reported when
    // a lock and unlock interleaved.
    // The functional update keeps a specific diagnosis the sign-out path
    // already wrote.
    if (!globalSignOutIncomplete) return;
    if (activeUserID.current !== null) {
      // The deferred resume may have installed a replacement still at MFA.
      if (activeUserID.current !== signOutUserID) return;
      setSignOutError((previous) => previous ?? GLOBAL_SIGN_OUT_INCOMPLETE_MESSAGE);
      return;
    }
    // The drained resume found this session gone and returned the member to
    // sign-in, clearing the refusal copy on the way. The signed-out surface
    // gets its own warning. It is a flag, not a `setSignOutError` write: the
    // cleanup the session loss started (account-local, offline, share
    // recovery) is still settling and writes or clears the diagnosis
    // unconditionally when it does, so a string here would be displaced by
    // the first cleanup callback to land.
    setGlobalSignOutIncompleteSignedOut(true);
  }, [signOut]);

  const sampleHat = mode === 'authenticated' ? sampleHatForSession(mobileConfig, session) : null;
  const sharedDemoVisit = useSharedDemoVisit(mode, session?.user.id, sampleHat);
  const liveSampleBackend = isLiveSampleBackend(mobileConfig);
  const switchSampleHat = useCallback(async (hat: HatKey) => {
    if (signOutInFlight.current) return;
    const supabase = getSupabaseClient();
    if (!supabase || !sampleHat || !session || locked || privacyCovered
      || !authIdentityMatches(observedAuthIdentity.current, session)
      || pendingAuthTransition.current !== null || sessionResumeAttempts.hasActive()
      || sampleEntryPending.current) throw new Error('The demo is unavailable. Try again.');
    sampleEntryPending.current = true;
    setSampleEntryBusy(true);
    let interruptedBySignOut = false;
    try {
      await switchSampleSession(mobileConfig, supabase.auth, sampleHat, hat, async () => {
        if (signOutInFlight.current) {
          interruptedBySignOut = true;
          throw new Error(SAMPLE_UNAVAILABLE);
        }
        demoPersonaHandoff.current = 'signing-out';
        await serializedSignOut({ silent: true });
        demoPersonaHandoff.current = observedAuthIdentity.current ? null : 'opening';
      }, () => sampleEntryPending.current);
      void haptics.select();
    } catch {
      if (interruptedBySignOut || signOutInFlight.current) return;
      setError('The demo is unavailable. Try again.');
      void haptics.warning();
      throw new Error('The demo is unavailable. Try again.');
    } finally {
      demoPersonaHandoff.current = null;
      if (!observedAuthIdentity.current) clearDemoLanguage();
      sampleEntryPending.current = false;
      setSampleEntryBusy(false);
    }
  }, [sampleHat, session, serializedSignOut, sessionResumeAttempts, locked, privacyCovered, clearDemoLanguage, observedAuthIdentity]);

  const storeDemo = isStoreDemo(mobileConfig);
  const storeDemoExitPending = useRef(false);
  const [storeDemoExitBusy, setStoreDemoExitBusy] = useState(false);
  // Exit demo: end the demo persona's
  // SAMPLE session through the ordinary sign-out, then remove the device
  // marker and restart, which brings the app back on its Production
  // configuration at the sign-in screen. A demo session that cannot be ended
  // stays under the demo's own storage key, which the Production build never
  // reads; the marker is removed either way so the visitor is never held in
  // the demo.
  const exitStoreDemo = useCallback(async () => {
    if (!storeDemo || storeDemoExitPending.current) return;
    storeDemoExitPending.current = true;
    setStoreDemoExitBusy(true);
    try {
      await endStoreDemo(activeUserID.current !== null ? () => serializedSignOut({ silent: true }) : null, storeDemoDevice);
    } catch {
      setError('The demo could not close. Try again.');
      throw new Error('The demo could not close. Try again.');
    } finally {
      storeDemoExitPending.current = false;
      setStoreDemoExitBusy(false);
    }
  }, [storeDemo, serializedSignOut]);

  const refresh = useCallback(async (reason: 'automatic' | 'user-refresh' = 'automatic') => {
    if (mode === 'preview') {
      setRefreshing(true);
      snapshotPreviewHat(previewHat, dashboard, previewDesk, previewThreads);
      await new Promise((resolve) => setTimeout(resolve, 250));
      setRefreshing(false);
      return;
    }
    if (session && doorOpen(session)) {
      try {
        await fetchDashboard(session, reason);
      } catch {
        // Refresh is also used by polling and read acknowledgement. The
        // initiating action owns feedback; refresh must stay silent.
      }
    }
  }, [applyPreviewHat, dashboard, doorOpen, fetchDashboard, mode, previewDesk, previewHat, previewThreads, session, snapshotPreviewHat]);

  const switchChapter = useCallback(async (chapterID: string) => {
    if (!providerMounted.current) return;
    if (mode !== 'authenticated' || !session) throw new Error('Sign in to switch campaigns.');
    // The shared widget purge runs only through the door ( r1s1 class).
    if (!doorOpen(session)) return;
    purgeHomeWidgets();
    setError(null);
    const writer = captureSessionWriter(session);
    const current = () => providerMounted.current && activeUserID.current === session.user.id
      && lastAuthenticatedSessionIDRef.current === sessionIDFromAccessToken(session.access_token);
    await switchMobileChapter(writer, chapterID);
    if (!current()) return;
    selectedReadChapter.current = { userID: session.user.id, chapterID };
    const proof = await writer.check();
    if (proof === 'changed' || !current()) return;
    confirmResumeDraftMemberships(session.user.id, [{ chapterID, selected: true }]);
    // The live channel store outlives the Home render and is scoped by the
    // server-side current chapter. Purge it at the same boundary as the
    // dashboard so chapter A rows cannot remain visible under chapter B.
    liveChannelStore.resetForSession();
    setMembershipScope({ userID: session.user.id, selected: [{ chapterID, organizationID: chapterMemberships.find((entry) => entry.chapterID === chapterID)?.organizationID ?? null }] });
    setDashboard(null);
    setOrganizationStaffScope(null);
    setChapterMemberships((chapters) => current() ? chapters.map((chapter) => ({
      ...chapter,
      selected: chapter.chapterID === chapterID,
    })) : chapters);
    try {
      if (proof === 'unavailable') throw new Error('Session proof unavailable.');
      await fetchDashboard(session);
      const refreshed = await writer.check();
      if (refreshed === 'changed' || !current()) return;
      if (refreshed === 'unavailable') throw new Error('Session proof unavailable.');
      await haptics.success();
    } catch {
      const failed = await writer.check();
      if (failed === 'changed' || !current()) return;
      await haptics.warning();
      throw new Error('Campaign changed, but the workspace could not refresh. Pull to refresh and try again.');
    }
  }, [chapterMemberships, doorOpen, fetchDashboard, mode, session]);

  const refreshChapterMemberships = useCallback(async () => {
    // The rail re-reads the server's active-membership list every time it
    // opens, so a chapter revoked since the last dashboard load is not shown
    // as switchable or pinnable.
    if (mode !== 'authenticated' || !session || !doorOpen(session)) return;
    const userID = session.user.id;
    const ownsNoticeLogin = captureAccountSessionGuard(userID);
    const request = ++membershipRequest.current;
    const dashboardAt = dashboardRequest.current;
    let readChapter = currentReadChapter(userID);
    let membershipChapter = readChapter;
    setResumeDraftReads(current => ({ ...current, memberships: false }));
    let membershipsConfirmed = true;
    let reading = true;
    const ownsRead = () => reading && providerMounted.current && activeUserID.current === userID && membershipRequest.current === request && dashboardRequest.current === dashboardAt;
    const canConceal = () => providerMounted.current && ownsNoticeLogin() && publishedDashboardAt.current < request;
    const confirmChapter = (chapterID: string | null) => {
      readChapter = chapterID;
      selectedReadChapter.current = { userID, chapterID };
    };
    const next = await withProviderReadDeadline(loadMobileChapterMemberships((selected) => {
      if (ownsRead()) {
        membershipChapter = selected.find(row => row.chapterID !== null)?.chapterID ?? null;
        setMembershipScope({ userID, selected });
      }
    }, available => {
      membershipsConfirmed = available;
      if (available && ownsRead() && settledMembershipAt.current < request) confirmChapter(membershipChapter);
    }).then(rows => {
      if (ownsRead() && membershipsConfirmed && settledMembershipAt.current < request) confirmChapter(rows.find(row => row.selected)?.chapterID ?? null);
      if (canConceal() && !membershipsConfirmed && settledMembershipAt.current < request) {
        invalidateResumeDraftRead(userID, 'memberships', undefined, readChapter, request);
      }
      //: a confirmed answer that arrives after the read deadline still
      // retires this login's held notice sends for departed chapters; an
      // on-time answer does so after the await below.
      if (!reading && membershipsConfirmed && ownsNoticeLogin() && activeUserID.current === userID
        && membershipRequest.current === request && dashboardRequest.current === dashboardAt) confirmPendingNoticeMemberships(userID, rows);
      if (!reading && canConceal() && readChapter === currentReadChapter(userID)
        && membershipsConfirmed && settledMembershipAt.current < request && confirmResumeDraftMemberships(userID, rows)) {
        settledMembershipAt.current = request;
        membershipScopeChanged.current = Math.max(membershipScopeChanged.current, request);
        setResumeDraftReads(current => ({ ...current, memberships: false }));
      }
      return rows;
    }).catch((error: unknown) => {
      if (canConceal() && settledMembershipAt.current < request) {
        invalidateResumeDraftRead(userID, 'memberships', error, readChapter, request);
      }
      throw error;
    })).finally(() => { reading = false; }).catch((error: unknown) => {
      if (activeUserID.current === userID && membershipRequest.current === request && dashboardRequest.current === dashboardAt) {
        // A failure or a deadline restores no earlier fact: held work stays
        // concealed and kept until the next confirmed answer.
        noteResumeDraftReadFailure(error);
        setResumeDraftReads(current => ({ ...current, memberships: false }));
      }
      throw error;
    });
    // Publish only while this account, this request and the dashboard
    // generation it was read against are still current: a sign-out, account
    // change, chapter switch or newer refresh in flight wins over this result.
    if (canConceal() && readChapter === currentReadChapter(userID) && (membershipRequest.current !== request || dashboardRequest.current !== dashboardAt)
      && settledMembershipAt.current < request && membershipsConfirmed && confirmResumeDraftMemberships(userID, next)) {
      membershipScopeChanged.current = Math.max(membershipScopeChanged.current, request);
      settledMembershipAt.current = request;
      setResumeDraftReads(current => ({ ...current, memberships: false }));
    }
    if (!doorOpen(session) || activeUserID.current !== userID || membershipRequest.current !== request || dashboardRequest.current !== dashboardAt) return;
    if (ownsNoticeLogin() && membershipsConfirmed) confirmPendingNoticeMemberships(userID, next);
    if (membershipsConfirmed) settledMembershipAt.current = request;
    const previousSelected = publishedMemberships.current.find((entry) => entry.selected)?.chapterID ?? null;
    const nextSelected = next.find((entry) => entry.selected)?.chapterID ?? null;
    const changedScope = membershipsConfirmed && confirmResumeDraftMemberships(userID, next);
    if (changedScope) membershipScopeChanged.current = request;
    setResumeDraftReads(current => changedScope
      ? { dashboard: false, memberships: true, staff: false }
      : { ...current, memberships: membershipsConfirmed });
    if (previousSelected !== null && nextSelected !== previousSelected) {
      // The server promoted a replacement chapter (the selected membership was
      // revoked). Clear every chapter-scoped store and reload under the new
      // chapter exactly as a user-initiated switch does.
      liveChannelStore.resetForSession();
      setDashboard(null);
      setOrganizationStaffScope(null);
      setChapterMemberships(next);
      await fetchDashboard(session);
      return;
    }
    setChapterMemberships(next);
  }, [captureAccountSessionGuard, chapterMemberships, currentReadChapter, doorOpen, fetchDashboard, invalidateResumeDraftRead, mode, session, withProviderReadDeadline]);

  const setChapterPinned = useCallback(async (chapterID: string, pinned: boolean) => {
    if (mode !== 'authenticated' || !session) throw new Error('Sign in to change campaign pins.');
    if (!doorOpen(session)) return;
    const userID = session.user.id;
    const ownsLogin = captureAccountSessionGuard(userID);
    const sameLogin = () => ownsLogin() && observedAuthIdentity.current !== null
      && (authIdentityMatches(observedAuthIdentity.current, session)
        || accessTokensShareSessionLineage(observedAuthIdentity.current.accessToken, session.access_token));
    const writer = captureSessionWriter(session);
    await setMobileChapterPin(writer, chapterID, pinned);
    //  final (r3s1, r4s1): a pin write that returns after this provider
    // unmounted or its login ended starts no read, arms no deadline and
    // touches nothing in the shared holder.
    if (!providerMounted.current || !sameLogin()) return;
    // Main always rereads after an acknowledged pin. Capture the generation
    // now so a reload during the write cannot suppress that fresh answer.
    const dashboardAt = dashboardRequest.current;
    const request = ++membershipRequest.current;
    let readChapter = currentReadChapter(userID);
    let membershipChapter = readChapter;
    setResumeDraftReads(current => ({ ...current, memberships: false }));
    let membershipsConfirmed = true;
    let reading = true;
    const ownsRead = () => reading && providerMounted.current && sameLogin() && activeUserID.current === userID && membershipRequest.current === request && dashboardRequest.current === dashboardAt;
    const canConceal = () => providerMounted.current && sameLogin() && activeUserID.current === userID && publishedDashboardAt.current < request;
    const confirmChapter = (chapterID: string | null) => {
      readChapter = chapterID;
      selectedReadChapter.current = { userID, chapterID };
    };
    const next = await withProviderReadDeadline(loadMobileChapterMemberships((selected) => {
      if (ownsRead()) {
        membershipChapter = selected.find(row => row.chapterID !== null)?.chapterID ?? null;
        setMembershipScope({ userID, selected });
      }
    }, available => {
      membershipsConfirmed = available;
      if (available && ownsRead() && settledMembershipAt.current < request) confirmChapter(membershipChapter);
    }).then(rows => {
      if (ownsRead() && membershipsConfirmed && settledMembershipAt.current < request) confirmChapter(rows.find(row => row.selected)?.chapterID ?? null);
      if (canConceal() && !membershipsConfirmed && settledMembershipAt.current < request) {
        invalidateResumeDraftRead(userID, 'memberships', undefined, readChapter, request);
      }
      //: as on the rail, a confirmed late answer of this login still
      // retires held notice sends for departed chapters.
      if (!reading && membershipsConfirmed && providerMounted.current && sameLogin() && userID && activeUserID.current === userID
        && membershipRequest.current === request && dashboardRequest.current === dashboardAt) confirmPendingNoticeMemberships(userID, rows);
      if (!reading && canConceal() && readChapter === currentReadChapter(userID)
        && membershipsConfirmed && settledMembershipAt.current < request && confirmResumeDraftMemberships(userID, rows)) {
        settledMembershipAt.current = request;
        membershipScopeChanged.current = Math.max(membershipScopeChanged.current, request);
        setResumeDraftReads(current => ({ ...current, memberships: false }));
      }
      return rows;
    }).catch((error: unknown) => {
      if (canConceal() && settledMembershipAt.current < request) {
        invalidateResumeDraftRead(userID, 'memberships', error, readChapter, request);
      }
      throw error;
    })).finally(() => { reading = false; }).catch((error: unknown) => {
      if (providerMounted.current && sameLogin() && userID && activeUserID.current === userID && membershipRequest.current === request && dashboardRequest.current === dashboardAt) {
        noteResumeDraftReadFailure(error);
        setResumeDraftReads(current => ({ ...current, memberships: false }));
      }
      throw error;
    });
    if (canConceal() && readChapter === currentReadChapter(userID) && (membershipRequest.current !== request || dashboardRequest.current !== dashboardAt)
      && settledMembershipAt.current < request && membershipsConfirmed && confirmResumeDraftMemberships(userID, next)) {
      membershipScopeChanged.current = Math.max(membershipScopeChanged.current, request);
      settledMembershipAt.current = request;
      setResumeDraftReads(current => ({ ...current, memberships: false }));
    }
    if (!providerMounted.current || !sameLogin() || !userID || activeUserID.current !== userID || membershipRequest.current !== request || dashboardRequest.current !== dashboardAt) return;
    if (membershipsConfirmed) confirmPendingNoticeMemberships(userID, next);
    if (membershipsConfirmed) settledMembershipAt.current = request;
    const changedScope = membershipsConfirmed && confirmResumeDraftMemberships(userID, next);
    if (changedScope) membershipScopeChanged.current = request;
    setResumeDraftReads(current => changedScope
      ? { dashboard: false, memberships: true, staff: false }
      : { ...current, memberships: membershipsConfirmed });
    const previousSelected = publishedMemberships.current.find((entry) => entry.selected)?.chapterID ?? null;
    const nextSelected = next.find((entry) => entry.selected)?.chapterID ?? null;
    const selectedChapterChanged = previousSelected !== null && nextSelected !== previousSelected;
    if (selectedChapterChanged) {
      // A pin refresh can discover the same revocation/promotion as a rail
      // refresh. Drop the old chapter's stores before revealing its successor.
      liveChannelStore.resetForSession();
      setDashboard(null);
      setOrganizationStaffScope(null);
      setDuesContext(null);
    }
    setChapterMemberships(next);
    if (selectedChapterChanged && sameLogin()) await fetchDashboard(session);
    await haptics.select();
  }, [captureAccountSessionGuard, currentReadChapter, doorOpen, fetchDashboard, invalidateResumeDraftRead, mode, session, withProviderReadDeadline]);

  const setNotificationRead = useCallback(async (notificationID: string, read: boolean, options?: { silent?: boolean }) => {
    if (!dashboard) throw new Error('Your workspace is not available yet.');
    if (mode === 'preview') {
      setDashboard((current) => current ? {
        ...current,
        notifications: current.notifications.map((item) => item.id === notificationID
          ? { ...item, readAt: read ? new Date().toISOString() : null }
          : item),
      } : current);
      if (!options?.silent) await haptics.select();
      return;
    }
    if (!session) throw new Error('Your secure session has expired.');
    const writer = captureSessionWriter(session);
    const ownsAccount = captureAccountSessionGuard(session.user.id);
    const chapterID = currentReadChapter(session.user.id);
    const scope = profileSaveOwnership.current.owner?.scope;
    const scopeCurrent = () => providerMounted.current && ownsAccount()
      && currentReadChapter(session.user.id) === chapterID && profileSaveOwnership.current.owner?.scope === scope;
    const updated = await setNotificationReadState(writer, session.user.id, notificationID, read);
    const proof = await writer.check();
    if (proof === 'changed' || !scopeCurrent()) return;
    setDashboard((current) => scopeCurrent() && current?.member.id === writer.userId ? {
      ...current,
      notifications: current.notifications.map((item) => item.id === updated.id ? updated : item),
    } : current);
    if (proof === 'current' && !options?.silent) await haptics.select();
  }, [dashboard, mode, session, captureAccountSessionGuard, currentReadChapter]);

  const saveProfile = useCallback(async (input: Pick<MemberProfile, 'firstName' | 'fullName' | 'language'>): Promise<BusinessProof> => {
    if (!dashboard) throw new Error('Your profile is not available yet.');
    if (mode === 'preview') {
      const fullName = input.fullName.trim();
      const firstName = input.firstName.trim();
      if (!firstName || !fullName || !initialsForName(fullName)) throw new Error('Enter a valid preferred and full name.');
      const member = { ...dashboard.member, ...input, firstName, fullName, initials: initialsForName(fullName) };
      setDashboard({ ...dashboard, member });
      setMemberLanguage(member.language);
      await haptics.success();
      return 'current';
    }
    if (!session) throw new Error('Your secure session has expired.');
    const ownsAccount = captureAccountSessionGuard(session.user.id);
    const chapterID = currentReadChapter(session.user.id);
    const scope = profileSaveOwnership.current.owner?.scope;
    const current = () => providerMounted.current && ownsAccount()
      && currentReadChapter(session.user.id) === chapterID && profileSaveOwnership.current.owner?.scope === scope;
    //: on a shared demo person the language is the visitor's. It stays
    // in this app and is never saved on the shared account; a name change
    // still saves, with the account's own language left as it was.
    const sharedDemoPerson = sampleHat !== null;
    if (sharedDemoPerson) {
      if (!current()) return 'changed';
      chooseDemoVisitorLanguage(input.language);
      demoLanguageChosen.current = true;
      if (input.firstName.trim() === dashboard.member.firstName && input.fullName.trim() === dashboard.member.fullName) {
        setDashboard((shown) => shown?.member.id === session.user.id ? { ...shown, member: shownDemoMember(true, shown.member) } : shown);
        setMemberLanguage(input.language);
        await haptics.success();
        return current() ? 'current' : 'changed';
      }
    }
    const accountLanguage = sharedDemoPerson && demoPersonSavedLanguage.current?.userID === session.user.id
      ? demoPersonSavedLanguage.current.language : null;
    const accountInput = accountLanguage ? { ...input, language: accountLanguage } : input;
    const savedMember = await updateMemberProfile(session.user.id, accountInput);
    const member = sharedDemoPerson ? shownDemoMember(true, savedMember) : savedMember;
    if (!current() || member.id !== session.user.id) return 'changed';
    const available = profileSaveOwnership.current.available;
    if (available) setDashboard((dashboard) => current() && profileSaveOwnership.current.available && dashboard?.member.id === session.user.id ? { ...dashboard, member } : dashboard);
    setMemberLanguage(member.language);
    if (!available) return 'unavailable';
    await haptics.success();
    return !current() ? 'changed' : profileSaveOwnership.current.available ? 'current' : 'unavailable';
  }, [dashboard, mode, session, sampleHat, captureAccountSessionGuard, currentReadChapter]);

  const askCompass = useCallback(async (question: string, history: CompassMessage[], writer = captureSessionWriter(session)) => {
    if (mode === 'preview') {
      await haptics.impact();
      return previewCompassReply(question);
    }
    const current = captureAuthenticatedSessionGuard();
    const reply = await sendCompassQuestion(writer, question, history);
    if (await writer.isCurrent() && current()) await haptics.success();
    return reply;
  }, [mode, session, captureAuthenticatedSessionGuard]);

  // SEC-UG-MOBILE-BIOMETRIC-LOCK-DISABLE-REAUTH-20260920: weakening the
  // re-lock is challenged exactly like arming it. The prompt is keyed on what
  // the device can actually verify, not on the direction of the change, so a
  // device that has lost its enrollment can still be turned off (there is no
  // enrolled biometric left to authenticate against) while turning it on there
  // stays refused.
  const setBiometricLock = useCallback(async (enabled: boolean) => {
    const available = await biometricsAvailable();
    if (enabled && !available) return false;
    if (available && !(await authenticateForUnlock())) return false;
    await saveBiometricLockPreference(enabled);
    biometricLockEnabledRef.current = enabled;
    setBiometricLockEnabled(enabled);
    setLocked(false);
    await haptics.select();
    return true;
  }, []);

  const unlock = useCallback(async () => {
    const success = await authenticateForUnlock();
    if (success) {
      setLocked(false);
      await haptics.success();
    } else {
      await haptics.warning();
    }
    return success;
  }, []);

  const confirmedMembershipScope = membershipScope?.userID === session?.user.id ? membershipScope?.selected ?? null : null;
  const selectedMembership = chapterMemberships.find((entry) => entry.selected) ?? null;
  const previewRoles: MobileStaffRole[] = previewHat && previewHat !== 'member' ? [previewHat] : [];
  const organizationID = mode === 'preview'
    ? PREVIEW_ORGANIZATION_ID
    : mode === 'authenticated'
      ? organizationStaffScope?.organizationID ?? selectedMembership?.organizationID ?? null
      : null;
  //: the pseudonymous analytics identity follows the signed-in member.
  const analyticsUserID = mode === 'authenticated' ? session?.user.id ?? null : null;
  useEffect(() => {
    void setNativeAnalyticsMember(analyticsUserID ? { userID: analyticsUserID, organizationID } : null);
  }, [analyticsUserID, organizationID]);
  const staffScopeAvailable = organizationStaffScope !== null;
  const liveStaffRoles = deriveLiveStaffRoles({
    mode,
    previewRoles,
    organizationStaffScope,
  });
  const staffRoleChoices = selectableLiveStaffRoles(liveStaffRoles);
  // The pick belongs to one sign-in: the Auth session ID survives a token
  // refresh but not a sign-out and a new sign-in by the same account.
  const staffRoleSessionID = session ? sessionIDFromAccessToken(session.access_token) : null;
  const chosenStaffRole = mode === 'authenticated' && session && staffRoleSessionID !== null
    && staffRolePick?.userID === session.user.id && staffRolePick.sessionID === staffRoleSessionID
    && staffRoleChoices.includes(staffRolePick.role) ? staffRolePick.role : null;
  const { organizationRoles, chapterRoles, authorizedRoles } = narrowLiveStaffRoles(liveStaffRoles, chosenStaffRole);
  const directAudience: NativeDirectAudience = mode === 'authenticated'
    ? nativeDirectAudience({ previewHat: null, sampleHat, chosenStaffRole, authorizedRoles })
    : 'member';
  setNativeDirectAudience(mode === 'authenticated' ? directAudience : 'member');
  const appliedDirectAudience = useRef<NativeDirectAudience | null>(null);
  useEffect(() => {
    if (mode !== 'authenticated' || !session) {
      appliedDirectAudience.current = null;
      setNativeDirectAudience('member');
      return;
    }
    setNativeDirectAudience(directAudience);
    const previousAudience = appliedDirectAudience.current;
    appliedDirectAudience.current = directAudience;
    // The first member read is the one establishSession already started.
    // A steward hat, and every later hat change, replaces that projection.
    if (previousAudience === directAudience) return;
    if (previousAudience === null && directAudience === 'member') return;
    // Drop the previous hat's rows before the new read returns. An in-flight
    // poll from the old audience must not publish over the empty list.
    conversationPollerRef.current?.invalidate();
    const cleared = replaceDirectRows(conversationUnreadStore.conversations() ?? [], []);
    conversationUnreadStore.publish(cleared);
    setDashboard((previous) => (previous ? { ...previous, conversations: cleared } : previous));
    void fetchDashboard(session).catch(() => undefined);
  }, [directAudience, fetchDashboard, mode, session]);
  const chooseStaffRole = useCallback((role: MobileStaffRole | null) => {
    //  r1s1: the whole choice is behind the door. A callback of a gone
    // instance or an earlier login saves no role and removes no held work.
    if (!session || !doorOpen(session)) return;
    const userID = session.user.id;
    const currentRole = staffRolePick?.userID === userID && staffRolePick?.sessionID === staffRoleSessionID ? staffRolePick?.role ?? null : null;
    if (currentRole !== role) retireResumeDraftScope(userID);
    setStaffRolePick(role && staffRoleSessionID ? { userID, sessionID: staffRoleSessionID, role } : null);
  }, [doorOpen, session, staffRoleSessionID, staffRolePick]);

  const visibleDashboard = dashboard;
  const profileOwnerFacts = resumeDraftOwnerFacts({ mode, session, organizationID, dashboard: visibleDashboard,
    chapterMemberships, authorizedRoles, chapterRoles, organizationRoles, chosenStaffRole, assuranceUnavailable, refreshing, resumeDraftReads }, profileSaveOwnership.current.owner);
  profileSaveOwnership.current = {
    owner: profileOwnerFacts.checkingSamePerson && !profileOwnerFacts.knownScopeChange ? profileSaveOwnership.current.owner : profileOwnerFacts,
    available: !profileOwnerFacts.checking,
  };
  syncResumeDraftContext({ mode, session, organizationID, dashboard: visibleDashboard,
    chapterMemberships, authorizedRoles, chapterRoles, organizationRoles, chosenStaffRole, assuranceUnavailable, refreshing, resumeDraftReads });
  const visibleSignOutError = globalSignOutIncompleteSignedOut ? globalSignOutIncompleteSignedOutMessage(signOutError) : signOutError;
  const signedOutNotice = mode === 'signedOut' ? (signedOutElsewhere ? SIGNED_OUT_ELSEWHERE_NOTICE : signInNotice) : null;
  // A refresh can rotate tokens while the same retry awaits user/MFA/RLS.
  // Keep that session busy, without passing the state to a replacement login.
  const sessionRetryBusy = Boolean(session && sessionRetryInFlight
    && session.user.id === sessionRetryInFlight.userID
    && (exactSessionIdentityMatches(sessionRetryInFlight, exactSessionIdentity(session))
      || accessTokensShareSessionLineage(sessionRetryInFlight.accessToken, session.access_token)));

  const value = useMemo<AppContextValue>(() => ({
    sharedDemoVisit,
    deletionOutcome, deletionCleanup, deleteAccount, retryDeletionCleanup, acknowledgeDeletion,
    mode, session, dashboard: visibleDashboard, memberLanguage, refreshing, resumeDraftReads, offlineDraftsReady, error, locked, privacyCovered, assuranceUnavailable, assuranceUnavailableReason, signOutError: visibleSignOutError, signedOutNotice, signOutBusy, biometricLockEnabled,
    biometricAvailable, previewAllowed, chapterMemberships, confirmedMembershipScope, organizationID, organizationRoles, chapterRoles, duesContext, staffScopeAvailable, authorizedRoles, staffRoleChoices, chosenStaffRole, chooseStaffRole,
    previewHat, previewShell, previewDesk, previewWidgetLayout, setPreviewWidgetLayout, signInWithPassword, enterSample, sampleEntryBusy, sampleHat, liveSampleBackend, switchSampleHat, storeDemo, enterStoreDemo, exitStoreDemo, storeDemoExitBusy, updatePassword, switchChapter, refreshChapterMemberships, setChapterPinned, verifyMfa, beginMfaRecovery, finishMfaRecovery, confirmMfaRecoveryGlobalSignOut, retrySessionAuthentication, enterPreview,
    switchPreviewHat, setPreviewShell, startPreviewConversation, sendPreviewMessage, previewThread, signOut: serializedSignOut, refresh,
    setNotificationRead, saveProfile, askCompass, setBiometricLock, refreshBiometricAvailability, unlock, captureAuthenticatedSessionGuard, captureAccountSessionGuard,
    sessionRestricted, sessionRestrictionPending, stepUpWithPassword, sessionRetryBusy, conversationPollIntervalMs: unreadPollInterval,
    conversationPollConnected: lowData.signals.connected !== false,
  }), [
    sharedDemoVisit,
    deletionOutcome, deletionCleanup, deleteAccount, retryDeletionCleanup, acknowledgeDeletion,
    mode, session, visibleDashboard, memberLanguage, refreshing, resumeDraftReads, offlineDraftsReady, error, locked, privacyCovered, assuranceUnavailable, assuranceUnavailableReason, visibleSignOutError, signedOutNotice, signOutBusy, biometricLockEnabled,
    biometricAvailable, previewAllowed, chapterMemberships, confirmedMembershipScope, organizationID, organizationRoles, chapterRoles, duesContext, staffScopeAvailable, authorizedRoles, staffRoleChoices, chosenStaffRole, chooseStaffRole, previewHat, previewShell, previewDesk, previewWidgetLayout, setPreviewWidgetLayout, signInWithPassword, enterSample, sampleEntryBusy, sampleHat, liveSampleBackend, switchSampleHat, storeDemo, enterStoreDemo, exitStoreDemo, storeDemoExitBusy, updatePassword, switchChapter, refreshChapterMemberships, setChapterPinned, verifyMfa, beginMfaRecovery, finishMfaRecovery, confirmMfaRecoveryGlobalSignOut, retrySessionAuthentication, enterPreview,
    switchPreviewHat, setPreviewShell, startPreviewConversation, sendPreviewMessage, previewThread, serializedSignOut, refresh, setNotificationRead,
    saveProfile, askCompass, setBiometricLock, refreshBiometricAvailability, unlock, captureAuthenticatedSessionGuard, captureAccountSessionGuard,
    sessionRestricted, sessionRestrictionPending, stepUpWithPassword, sessionRetryBusy, unreadPollInterval, lowData.signals.connected,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider.');
  return value;
}
