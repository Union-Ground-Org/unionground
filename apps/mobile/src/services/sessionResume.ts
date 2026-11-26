import type { Session } from '@supabase/supabase-js';

import { sessionRequiresTotp } from '../lib/authPolicy';
import { accessTokensShareSessionLineage } from '../lib/sessionLineage';
import { tagSignOutProvenance } from './signOutFailure';
import type { BackendReachability } from './backendReachability';

type Assurance = {
  currentLevel?: string | null;
  nextLevel?: string | null;
};

const definitiveSessionInvalidationCodes = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
  'session_expired',
  'user_not_found',
  'user_banned',
  'bad_jwt',
  'invalid_jwt',
  'no_authorization',
]);

function isDefinitiveSessionInvalidation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown; name?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : null;
  // Provider outages and gateway failures remain retryable even if a proxy
  // copies an auth-shaped code into the response body.
  if (status === null || status < 400 || status >= 500) return false;
  if (candidate.name === 'AuthSessionMissingError' || candidate.name === 'AuthInvalidJwtError') return true;
  if (typeof candidate.code === 'string' && definitiveSessionInvalidationCodes.has(candidate.code)) return true;
  // A gateway's bare 401 is not evidence that the Auth session ended.
  return false;
}

export type SessionResumeAuth = {
  refreshSession(): Promise<{
    data: { session: Session | null };
    error: unknown;
  }>;
  getUser(): Promise<{
    data: { user: { id: string } | null };
    error: unknown;
  }>;
  mfa: {
    getAuthenticatorAssuranceLevel(): Promise<{
      data: Assurance | null;
      error: unknown;
    }>;
  };
};

// Why a session could not be confirmed. `offline` means the device had no
// path to the backend at all, so the screen can say so instead of describing
// a security check (UX-UG-NATIVE-OFFLINE-START-SHOWN-AS-SECURITY-CHECK-20261018);
// `assurance` covers every other reason (a slow network past the deadline, a
// refused refresh, a failed MFA or RLS check). Both stay fail-closed.
export type SessionUnavailableReason = 'offline' | 'assurance';

export type SessionResumeResult =
  | { status: 'authenticated'; session: Session }
  | { status: 'mfaRequired'; session: Session }
  | { status: 'signedOut' }
  | { status: 'unavailable'; reason?: SessionUnavailableReason };

/**
 * A revalidation whose resume attempt was superseded between stages. It is
 * not a verdict on the session: the newer owner decides what the app shows.
 */
export type SessionRevalidationResult = SessionResumeResult | { status: 'stale' };

export type SessionResumeGuard = {
  begin(): { isCurrent(): boolean };
  invalidate(): void;
};

export type ExactSessionIdentity = {
  userID: string;
  accessToken: string;
  refreshToken: string;
};

export type SessionResumeAttempt = {
  readonly id: number;
  readonly expectedUserID: string | null;
  observedRefreshIdentity: ExactSessionIdentity | null;
};

export type SessionResumeEventDecision =
  | { status: 'expected-refresh'; attempt: SessionResumeAttempt }
  | { status: 'handle'; interrupted: boolean; interruptedExpectedUserID: string | null };

export type SessionSignOutAttempt = {
  readonly id: number;
  readonly capturedIdentity: ExactSessionIdentity;
  currentIdentity: ExactSessionIdentity;
  currentSession: Session;
};

export type SessionSignOutEventDecision =
  | { status: 'adopted-refresh'; attempt: SessionSignOutAttempt }
  | { status: 'handle'; interrupted: boolean };

export function exactSessionIdentity(session: Session): ExactSessionIdentity {
  return {
    userID: session.user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };
}

export function exactSessionIdentityMatches(
  left: ExactSessionIdentity | null,
  right: ExactSessionIdentity | null,
): boolean {
  return Boolean(left && right
    && left.userID === right.userID
    && left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken);
}

function exactIdentitiesShareSessionLineage(
  left: ExactSessionIdentity | null,
  right: ExactSessionIdentity | null,
): boolean {
  return Boolean(left && right
    && left.userID === right.userID
    && accessTokensShareSessionLineage(left.accessToken, right.accessToken));
}

/** Owns one explicit sign-out while harmless rotations retain the same SID. */
export function createSessionSignOutAttemptCoordinator() {
  let sequence = 0;
  let active: SessionSignOutAttempt | null = null;
  return {
    begin(session: Session): SessionSignOutAttempt {
      const identity = exactSessionIdentity(session);
      const attempt = {
        id: ++sequence,
        capturedIdentity: identity,
        currentIdentity: identity,
        currentSession: session,
      };
      active = attempt;
      return attempt;
    },
    observe(event: string, session: Session | null): SessionSignOutEventDecision {
      const attempt = active;
      if (!attempt) return { status: 'handle', interrupted: false };
      const identity = session ? exactSessionIdentity(session) : null;
      if (event === 'TOKEN_REFRESHED'
        && exactIdentitiesShareSessionLineage(attempt.currentIdentity, identity)) {
        attempt.currentIdentity = identity!;
        attempt.currentSession = session!;
        return { status: 'adopted-refresh', attempt };
      }
      active = null;
      return { status: 'handle', interrupted: true };
    },
    identityIsCurrent(attempt: SessionSignOutAttempt, identity: ExactSessionIdentity | null): boolean {
      return active === attempt && exactSessionIdentityMatches(attempt.currentIdentity, identity);
    },
    latestSessionFor(attempt: SessionSignOutAttempt): Session | null {
      return active === attempt ? attempt.currentSession : null;
    },
    finish(attempt: SessionSignOutAttempt): boolean {
      if (active !== attempt) return false;
      active = null;
      return true;
    },
  };
}

/**
 * Owns resume attempts with a never-reused generation. The first exact
 * TOKEN_REFRESHED event for the expected user belongs to that refresh call;
 * a later different token, even for the same user, supersedes the attempt.
 */
export function createSessionResumeAttemptCoordinator() {
  let sequence = 0;
  let active: SessionResumeAttempt | null = null;
  return {
    begin(expectedUserID: string | null): SessionResumeAttempt {
      const attempt: SessionResumeAttempt = {
        id: ++sequence,
        expectedUserID,
        observedRefreshIdentity: null,
      };
      active = attempt;
      return attempt;
    },
    observe(event: string, session: Session | null): SessionResumeEventDecision {
      const attempt = active;
      if (!attempt) {
        return { status: 'handle', interrupted: false, interruptedExpectedUserID: null };
      }
      if (event === 'TOKEN_REFRESHED'
        && session
        && attempt.expectedUserID === session.user.id) {
        const identity = exactSessionIdentity(session);
        if (!attempt.observedRefreshIdentity) {
          attempt.observedRefreshIdentity = identity;
          return { status: 'expected-refresh', attempt };
        }
        if (exactSessionIdentityMatches(attempt.observedRefreshIdentity, identity)) {
          return { status: 'expected-refresh', attempt };
        }
      }
      active = null;
      return {
        status: 'handle',
        interrupted: true,
        interruptedExpectedUserID: attempt.expectedUserID,
      };
    },
    isActive(attempt: SessionResumeAttempt): boolean {
      return active === attempt;
    },
    hasActive(): boolean {
      return active !== null;
    },
    sessionIsCurrent(attempt: SessionResumeAttempt, session: Session): boolean {
      return active === attempt
        && (!attempt.observedRefreshIdentity
          || exactSessionIdentityMatches(
            attempt.observedRefreshIdentity,
            exactSessionIdentity(session),
          ));
    },
    finish(attempt: SessionResumeAttempt): boolean {
      if (active !== attempt) return false;
      active = null;
      return true;
    },
  };
}

export function createSessionResumeGuard(): SessionResumeGuard {
  let generation = 0;
  return {
    begin() {
      const attemptGeneration = ++generation;
      return { isCurrent: () => attemptGeneration === generation };
    },
    invalidate() {
      generation += 1;
    },
  };
}

function validAssurance(data: Assurance | null): data is Required<Assurance> {
  return Boolean(
    data
    && (data.currentLevel === 'aal1' || data.currentLevel === 'aal2')
    && (data.nextLevel === 'aal1' || data.nextLevel === 'aal2'),
  );
}

/**
 * Re-establishes server authority after an app-background boundary. A cached
 * Session is deliberately not an input: refreshSession must prove that the
 * refresh token remains valid before getUser and MFA assurance are trusted.
 */
export async function revalidateSessionOnResume(
  auth: SessionResumeAuth,
  expectedUserID?: string,
  // Ownership of the calling attempt. A superseded or timed-out attempt must
  // not start another Auth request; cancelling the shared client instead
  // would abort the replacement session's work too.
  isCurrent: () => boolean = () => true,
  // Told when Auth has answered with a session, so the deadline knows the
  // network carried traffic even if a later stage stalls.
  onAuthAnswer: () => void = () => undefined,
): Promise<SessionRevalidationResult> {
  let refreshed: Awaited<ReturnType<SessionResumeAuth['refreshSession']>>;
  try {
    refreshed = await auth.refreshSession();
  } catch (error) {
    return { status: isDefinitiveSessionInvalidation(error) ? 'signedOut' : 'unavailable' };
  }
  if (refreshed.error) {
    return { status: isDefinitiveSessionInvalidation(refreshed.error) ? 'signedOut' : 'unavailable' };
  }
  const nextSession = refreshed.data?.session ?? null;
  if (!nextSession) return { status: 'unavailable' };
  onAuthAnswer();
  if (expectedUserID && nextSession.user.id !== expectedUserID) return { status: 'unavailable' };
  if (!isCurrent()) return { status: 'stale' };

  let authoritativeUser: Awaited<ReturnType<SessionResumeAuth['getUser']>>;
  try {
    authoritativeUser = await auth.getUser();
  } catch (error) {
    return { status: isDefinitiveSessionInvalidation(error) ? 'signedOut' : 'unavailable' };
  }
  if (authoritativeUser.error) {
    return { status: isDefinitiveSessionInvalidation(authoritativeUser.error) ? 'signedOut' : 'unavailable' };
  }
  if (!authoritativeUser.data?.user || authoritativeUser.data.user.id !== nextSession.user.id) {
    return { status: 'unavailable' };
  }
  if (!isCurrent()) return { status: 'stale' };

  let assurance: Awaited<ReturnType<SessionResumeAuth['mfa']['getAuthenticatorAssuranceLevel']>>;
  try {
    assurance = await auth.mfa.getAuthenticatorAssuranceLevel();
  } catch (error) {
    return { status: isDefinitiveSessionInvalidation(error) ? 'signedOut' : 'unavailable' };
  }
  if (assurance.error) {
    return { status: isDefinitiveSessionInvalidation(assurance.error) ? 'signedOut' : 'unavailable' };
  }
  if (!isCurrent()) return { status: 'stale' };
  if (!validAssurance(assurance.data)) return { status: 'unavailable' };
  if (sessionRequiresTotp(assurance.data)) return { status: 'mfaRequired', session: nextSession };
  return { status: 'authenticated', session: nextSession };
}

type ResumeProtectedSessionOptions = {
  auth: SessionResumeAuth;
  expectedUserID?: string;
  guard: SessionResumeGuard;
  cover(): void;
  clearProtectedState(): void;
  isSessionCurrent?(session: Session): boolean;
  clearLocalSession(): Promise<void>;
  prepareSession(session: Session): void;
  // `isCurrent` is this attempt's ownership capability. Bootstrap must check
  // it after each await and immediately before any state write, cleanup or
  // new request: the helper's own checks run only after bootstrap settles.
  bootstrap(session: Session, isCurrent: () => boolean): Promise<void>;
  authenticated(session: Session): void;
  mfaRequired(session: Session): void;
  signedOut(): void;
  unavailable(reason: SessionUnavailableReason): void;
  // Final UI settlement, run only while this attempt still owns the surface,
  // immediately before reveal.
  settle?(): void;
  reveal(): void;
  revalidationDeadlineMs?: number;
  bootstrapDeadlineMs?: number;
  // Called only when a still-owned bootstrap expires, never for auth failures
  // or a superseded account. The provider can grant its next read more time.
  bootstrapTimedOut?(): void;
  reachable?(): Promise<ReachabilityAnswer>;
};

export type ProtectedSessionResumeOutcome = SessionResumeResult['status'] | 'stale';

// Offline, Supabase retries a token refresh with backoff for up to its 30 s
// tick before reporting failure, and the privacy cover stays up the whole
// time, so a cold or warm open without a network shows a blank screen. Past
// this deadline the resume takes the same fail-closed `unavailable` path a
// failed request takes: protected state stays cleared and the member gets the
// retry and sign-out surface instead of a blank cover.
export const SESSION_REVALIDATION_DEADLINE_MS = 10_000;
export const SESSION_BOOTSTRAP_DEADLINE_MS = 10_000;
// How long the fresh probe that confirms the offline words may take. It runs
// inside the check's own deadline, never after it.
export const SESSION_OFFLINE_CONFIRM_MS = 3_000;

// What a reachability probe may answer: the boolean view (true = some path
// exists, false = definitely offline) or the three-state probe, whose
// `silent` means the probe ended by its own abort with no HTTP answer.
export type ReachabilityAnswer = boolean | BackendReachability;

async function withinDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  unavailable: T,
  reachable?: () => Promise<ReachabilityAnswer>,
  // Runs synchronously when the deadline or offline answer wins, before the
  // caller's continuation, so work still in flight can see it has expired.
  expire?: () => void,
  // The answer when the device has no path to the backend; defaults to the
  // deadline answer so callers that do not tell the two apart need no change.
  offlineUnavailable: T = unavailable,
  // True once the backend itself has answered this attempt. A silent probe then
  // proves nothing about the deadline: the network carried an answer, so a
  // later stage that runs out the clock keeps the `unavailable` answer.
  heard: () => boolean = () => false,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A probe that ended by its own abort proved no path either way. If the
  // work then also fails to answer by the deadline, the member is offline for
  // every practical purpose (a blackholed network), so the deadline says so
  // (UX-UG-NATIVE-BLACKHOLED-NETWORK-SHOWN-AS-SECURITY-CHECK-20261020).
  let silent = false;
  // BUG-UG-NATIVE-SIGN-OUT-DURING-SESSION-CHECK-SHOWS-OFFLINE-20261103:
  // the one probe sent as the check began chose the words, so a probe that was
  // only queued or failed once (on Android a sign-out's requests and the
  // interrupted check's requests wait in the same per-host queue) told a member
  // with a working network that they were offline. The check is still decided
  // and fails closed at the same moment as before; only its words wait for a
  // fresh probe, which has its own short timer inside the original deadline
  // . An answered fresh probe means the network is up,
  // so the member gets the ordinary `unavailable` words; no answer in time
  // keeps the offline words.
  const startedAt = Date.now();
  const distinguishesOffline = Boolean(reachable) && offlineUnavailable !== unavailable;
  const freshProbe = (windowMs: number): Promise<boolean> => {
    if (!reachable || windowMs <= 0) return Promise.resolve(false);
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      reachable().then((answer) => answer === true || answer === 'reachable', () => false),
      new Promise<boolean>((resolve) => { confirmTimer = setTimeout(() => resolve(false), windowMs); }),
    ]).finally(() => clearTimeout(confirmTimer));
  };
  const remaining = () => startedAt + deadlineMs - Date.now();
  // After a silent probe the fresh one is sent early enough to answer by the
  // deadline, so the deadline verdict needs no wait of its own.
  let freshScheduled = false;
  let freshAnswered = false;
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleFreshProbe = () => {
    if (!distinguishesOffline || freshScheduled) return;
    freshScheduled = true;
    const window = Math.min(SESSION_OFFLINE_CONFIRM_MS, Math.max(0, remaining()));
    freshTimer = setTimeout(() => {
      void freshProbe(window).then((answered) => { freshAnswered = answered; });
    }, Math.max(0, remaining() - window));
  };
  // Each contender resolves to a thunk, so the race is decided the moment the
  // deadline or the offline answer wins: work that settles after `expire` can
  // no longer win.
  const deadline = new Promise<() => T>((resolve) => {
    timer = setTimeout(() => {
      expire?.();
      resolve(() => (silent && !heard() && !freshAnswered ? offlineUnavailable : unavailable));
    }, deadlineMs);
  });
  // When the device already has no path to the backend, nothing is gained by
  // waiting out the deadline: answer `unavailable` as soon as that is known.
  const never = new Promise<never>(() => undefined);
  const offline: Promise<() => T | Promise<T>> = reachable
    ? reachable().then((answer: ReachabilityAnswer): Promise<never> | (() => T | Promise<T>) => {
      if (answer === true || answer === 'reachable') return never;
      if (answer === 'silent') { silent = true; scheduleFreshProbe(); return never; }
      expire?.();
      if (!distinguishesOffline) return () => offlineUnavailable;
      const window = Math.min(SESSION_OFFLINE_CONFIRM_MS, Math.max(0, remaining()));
      return async () => ((await freshProbe(window)) ? unavailable : offlineUnavailable);
    }, (): Promise<never> => never)
    : never;
  try {
    const settle = await Promise.race([work.then((value: T) => () => value), deadline, offline]);
    return await settle();
  } finally {
    clearTimeout(timer);
    clearTimeout(freshTimer);
  }
}

/** Settle an expiring token only after sign-out's local cleanup has finished. */
export async function prepareSessionForServerSignOut(
  latestSession: () => Session | null,
  readSession: () => Promise<{ data: { session: Session | null }; error: unknown }>,
  options: { deadlineMs?: number; reachable?: () => Promise<ReachabilityAnswer>; now?: () => number } = {},
): Promise<boolean> {
  const initial = latestSession();
  if (!initial) return false;
  const now = options.now ?? Date.now;
  // The SDK's refresh margin is 90 seconds. A healthy captured token needs
  // no Auth lookup; offline recovery-free cleanup remains entirely local.
  if (typeof initial.expires_at !== 'number' || initial.expires_at * 1000 > now() + 90_000) return true;
  const answer = await withinDeadline<{ data: { session: Session | null }; error: unknown } | null>(
    readSession(), options.deadlineMs ?? 5_000, null, options.reachable,
  );
  const current = latestSession();
  if (!current) return false;
  if (!answer) throw tagSignOutProvenance(new Error('Account security refresh is unavailable.'), 'transport');
  if (answer.error) throw answer.error;
  const refreshed = answer.data.session;
  // Only the coordinator's adopted same-session rotation may reach a
  // captured-token RPC. Reading a new login never authorizes closing it.
  const sameLineage = exactSessionIdentityMatches(exactSessionIdentity(initial), exactSessionIdentity(current))
    || (initial.user.id === current.user.id
      && accessTokensShareSessionLineage(initial.access_token, current.access_token));
  if (!sameLineage || !refreshed
    || !exactSessionIdentityMatches(exactSessionIdentity(current), exactSessionIdentity(refreshed))
    || typeof refreshed.expires_at !== 'number' || !Number.isFinite(refreshed.expires_at)
    || refreshed.expires_at * 1000 <= now()) {
    throw tagSignOutProvenance(new Error('The current session could not be settled for sign-out.'), 'local');
  }
  return true;
}

async function withinRevalidationDeadline(
  revalidation: Promise<SessionRevalidationResult>,
  deadlineMs: number,
  reachable?: () => Promise<ReachabilityAnswer>,
  expire?: () => void,
  heard?: () => boolean,
): Promise<SessionRevalidationResult> {
  return withinDeadline<SessionRevalidationResult>(
    revalidation,
    deadlineMs,
    { status: 'unavailable', reason: 'assurance' },
    reachable,
    expire,
    { status: 'unavailable', reason: 'offline' },
    heard,
  );
}

export type ColdSessionRead<T> =
  | { status: 'settled'; value: T }
  | { status: 'unavailable'; reason: SessionUnavailableReason };

// A cold launch reads the persisted session through getSession(), which first
// waits for the auth client's own initialization. When the stored access token
// is within Supabase's expiry margin, that initialization refreshes it, and
// offline the refresh retries with backoff for up to its 30 s tick, so the
// launch sat on a blank boot screen until connectivity returned
// (BUG-UG-ANDROID-COLD-OFFLINE-BOOT-BLANK-20261001). The read is bounded the
// same way as a resume: no path to the backend answers `unavailable` at once,
// otherwise the revalidation deadline does. A late result is never delivered;
// the caller keeps the persisted session only as a covered retry handle.
export function boundColdSessionRead<T>(
  read: Promise<T>,
  options: { deadlineMs?: number; reachable?: () => Promise<ReachabilityAnswer> } = {},
): Promise<ColdSessionRead<T>> {
  return withinDeadline<ColdSessionRead<T>>(
    read.then((value: T): ColdSessionRead<T> => ({ status: 'settled', value })),
    options.deadlineMs ?? SESSION_REVALIDATION_DEADLINE_MS,
    { status: 'unavailable', reason: 'assurance' },
    options.reachable,
    undefined,
    { status: 'unavailable', reason: 'offline' },
  );
}

/**
 * Orders the UI boundary around revalidation. Callers can invalidate the guard
 * as soon as the app leaves the foreground; stale attempts then cannot reveal
 * or repopulate a protected surface.
 */
export async function resumeProtectedSession(
  options: ResumeProtectedSessionOptions,
): Promise<ProtectedSessionResumeOutcome> {
  const attempt = options.guard.begin();
  options.cover();
  options.clearProtectedState();

  // Ownership comes from the never-reused guard generation, never from user-ID
  // equality: A -> B -> A and a new SID for the same user both leave this
  // attempt stale. Once the deadline or offline answer wins, the revalidation
  // still in flight may not start its next stage either: the predicate closes
  // in that handler, not after this await, whose resumption comes later.
  let revalidationOpen = true;
  // A silent probe means offline only while Auth has not answered this attempt
  // .
  let authAnswered = false;
  const result = await withinRevalidationDeadline(
    revalidateSessionOnResume(
      options.auth,
      options.expectedUserID,
      () => revalidationOpen && attempt.isCurrent(),
      () => { authAnswered = true; },
    ),
    options.revalidationDeadlineMs ?? SESSION_REVALIDATION_DEADLINE_MS,
    options.reachable,
    () => { revalidationOpen = false; },
    () => authAnswered,
  );
  revalidationOpen = false;
  if (result.status === 'stale' || !attempt.isCurrent()) return 'stale';

  if ((result.status === 'authenticated' || result.status === 'mfaRequired')
    && options.isSessionCurrent
    && !options.isSessionCurrent(result.session)) return 'stale';

  const finish = () => {
    options.settle?.();
    options.reveal();
  };

  if (result.status === 'signedOut') {
    try {
      // Local scope removes the rejected persisted session without revoking
      // the account's sessions on other devices. This runs outside the auth
      // callback, whose refresh lock must never be re-entered.
      await options.clearLocalSession();
    } catch {
      if (!attempt.isCurrent()) return 'stale';
      options.clearProtectedState();
      options.unavailable('assurance');
      finish();
      return 'unavailable';
    }
    if (!attempt.isCurrent()) return 'stale';
    options.signedOut();
    finish();
    return result.status;
  }
  if (result.status === 'unavailable') {
    options.unavailable(result.reason ?? 'assurance');
    finish();
    return result.status;
  }
  if (result.status === 'mfaRequired') {
    options.mfaRequired(result.session);
    finish();
    return result.status;
  }

  const session = result.session;
  // The coordinator-accepted exact identity, not the provider's transition
  // counter: prepareSession advances that counter for this very attempt.
  const stillCurrent = () => attempt.isCurrent()
    && (!options.isSessionCurrent || options.isSessionCurrent(session));
  let bootstrapOpen = true;
  const owns = () => bootstrapOpen && stillCurrent();
  options.prepareSession(session);
  if (!owns()) return 'stale';
  let bootstrapped = false;
  try {
    bootstrapped = await withinDeadline(
      options.bootstrap(session, owns).then(() => true),
      options.bootstrapDeadlineMs ?? SESSION_BOOTSTRAP_DEADLINE_MS,
      false,
      undefined,
      // Revoke the capability in the timer itself. A late continuation may
      // run before this function resumes, and must already be unable to write.
      () => {
        bootstrapOpen = false;
        if (stillCurrent()) options.bootstrapTimedOut?.();
      },
    );
  } catch {
    // A rejected bootstrap takes the same fail-closed path as its deadline.
  } finally {
    bootstrapOpen = false;
  }
  if (!stillCurrent()) return 'stale';
  if (!bootstrapped) {
    // Bootstrap may publish an independently completed field (for example,
    // member language) before a sibling RLS query rejects. Re-clear that
    // partial result before exposing the fail-closed retry surface.
    options.clearProtectedState();
    options.unavailable('assurance');
    finish();
    return 'unavailable';
  }
  options.authenticated(session);
  finish();
  return result.status;
}
