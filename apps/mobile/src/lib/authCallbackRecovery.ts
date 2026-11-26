// Terminal outcomes of the secure-link callback (app/auth/callback.tsx).
//
// BUG-UG-MOBILE-IOS-AUTH-CALLBACK-SPINNER-NO-RECOVERY-20260919: the screen
// redirected only when the exchange completed into `mfaRequired` or
// `authenticated`; a completed exchange into `signedOut`, `preview`, or a
// `booting` that never settled kept the spinner forever. Every combination of
// exchange state and app mode now resolves here to exactly one of: a bounded
// wait, a redirect, or a recovery state that names at least one way out. The
// resolver, the screen's state transitions and the model the screen renders are
// all pure, so each outcome and each transition is unit-tested without a
// renderer; the screen only draws the model and runs its effects.

import type { LifecycleStep } from '../services/lifecycleDiagnostics';

export type AuthCallbackMode = 'booting' | 'signedOut' | 'mfaRequired' | 'authenticated' | 'preview';
export type AuthCallbackExchange = 'pending' | 'complete' | 'failed';
export type AuthCallbackLanguage = 'en' | 'es';

export type AuthCallbackRecoveryReason =
  // The link carried no one-time code; nothing was exchanged.
  | 'missingCode'
  // The auth server sent the link back with an error instead of a code (an
  // expired or already-used link: error=access_denied, error_code=otp_expired).
  | 'linkRejected'
  // The exchange itself failed (network, expired, or already-used code).
  | 'exchangeFailed'
  // The exchange never answered inside the budget.
  | 'exchangeStalled'
  // The exchange completed but session establishment ended signed out.
  | 'sessionRejected'
  // The exchange completed but the in-memory demo session is still showing.
  | 'previewActive'
  // The exchange completed but session establishment never left `booting`.
  | 'sessionStalled';

// There is deliberately no "try again": the auth client deletes the stored
// PKCE code verifier on every exchange outcome, so a second exchange of the
// same link fails before any request is made. A failed link needs a new link.
export type AuthCallbackAction =
  | 'keepWaiting'
  | 'returnToSignIn'
  | 'continueSession'
  // MFA is still pending: the way on is the challenge, and the label says so.
  | 'continueToVerification'
  | 'returnToDemo'
  | 'leaveDemoAndSignIn';
export type AuthCallbackHref = '/sign-in' | '/mfa-challenge' | '/(tabs)/home';

export type AuthCallbackView =
  | { kind: 'waiting'; phase: 'verifying' | 'finishing' }
  | { kind: 'redirect'; href: '/mfa-challenge' | '/(tabs)/home' }
  | { kind: 'recovery'; reason: AuthCallbackRecoveryReason; actions: readonly [AuthCallbackAction, ...AuthCallbackAction[]] };

// One budget bounds both waits (the exchange request and the post-exchange
// session establishment: forced refresh, getUser, MFA assurance, and the first
// RLS bootstrap). Past it the spinner yields to a recovery state; "keep
// waiting" re-arms the same budget rather than hiding the way out again.
export const AUTH_CALLBACK_WAIT_BUDGET_MS = 20_000;

type AuthCallbackActions = readonly [AuthCallbackAction, ...AuthCallbackAction[]];

// The sign-in route redirects to Home while the demo or a live session is
// open, and to the MFA challenge while one is pending, so "Return to sign in"
// would land there instead of on sign-in. Every recovery therefore names the
// destination the member will actually reach from the current mode.
function exitActions(mode: AuthCallbackMode): AuthCallbackActions {
  switch (mode) {
    case 'preview': return ['returnToDemo', 'leaveDemoAndSignIn'];
    case 'authenticated': return ['continueSession'];
    case 'mfaRequired': return ['continueToVerification'];
    default: return ['returnToSignIn'];
  }
}

const STALLED_REASONS: ReadonlySet<AuthCallbackRecoveryReason> = new Set(['exchangeStalled', 'sessionStalled']);

function recovery(reason: AuthCallbackRecoveryReason, mode: AuthCallbackMode): AuthCallbackView {
  const exits = exitActions(mode);
  return { kind: 'recovery', reason, actions: STALLED_REASONS.has(reason) ? ['keepWaiting', ...exits] : exits };
}

export function resolveAuthCallbackView(input: {
  hasCode: boolean;
  // UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (tooling
  // ledger 18): the link arrived with the auth server's error parameters, so
  // it was refused, not cut short.
  linkRejected?: boolean;
  exchange: AuthCallbackExchange;
  mode: AuthCallbackMode;
  waitTimedOut: boolean;
}): AuthCallbackView {
  if (!input.hasCode) return recovery(input.linkRejected === true ? 'linkRejected' : 'missingCode', input.mode);
  if (input.exchange === 'failed') return recovery('exchangeFailed', input.mode);
  if (input.exchange === 'pending') {
    return input.waitTimedOut ? recovery('exchangeStalled', input.mode) : { kind: 'waiting', phase: 'verifying' };
  }
  switch (input.mode) {
    case 'mfaRequired': return { kind: 'redirect', href: '/mfa-challenge' };
    case 'authenticated': return { kind: 'redirect', href: '/(tabs)/home' };
    case 'signedOut': return recovery('sessionRejected', input.mode);
    case 'preview': return recovery('previewActive', input.mode);
    case 'booting': return input.waitTimedOut ? recovery('sessionStalled', input.mode) : { kind: 'waiting', phase: 'finishing' };
    default: {
      // A mode added to AppProvider later must be given an outcome here; until
      // then it fails closed into a recovery state, never back into a spinner.
      const unhandled: never = input.mode;
      void unhandled;
      return recovery('sessionRejected', input.mode);
    }
  }
}

type AuthCallbackCopy = {
  waiting: Record<'verifying' | 'finishing', { title: string; body: string; spinnerLabel: string }>;
  recovery: Record<AuthCallbackRecoveryReason, { title: string; body: string }>;
  actions: Record<AuthCallbackAction, string>;
};

// Fixed, worker-safe copy only. No branch renders the thrown auth error.
const authCallbackCopy: Record<AuthCallbackLanguage, AuthCallbackCopy> = {
  en: {
    waiting: {
      verifying: { title: 'Verifying secure link…', body: 'Union Ground is securely completing your session.', spinnerLabel: 'Verifying' },
      finishing: { title: 'Finishing sign-in…', body: 'The link was verified. Union Ground is confirming your session security.', spinnerLabel: 'Finishing sign-in' },
    },
    recovery: {
      missingCode: { title: 'Sign-in link unavailable', body: 'This sign-in link is incomplete. Request a new one.' },
      linkRejected: { title: 'Sign-in link expired', body: 'This sign-in link has expired or was already used. Request a new one.' },
      exchangeFailed: { title: 'Sign-in link unavailable', body: 'This sign-in link could not be verified. Request a new one.' },
      exchangeStalled: { title: 'Still verifying', body: 'Verifying this sign-in link is taking longer than expected. Check your connection, then keep waiting or leave this screen.' },
      sessionRejected: { title: 'Sign-in not completed', body: 'The link was verified, but Union Ground could not start your secure session. Return to sign in and try again.' },
      previewActive: { title: 'The demo is still open', body: 'This link did not sign you in because the demo is open on this phone. Return to the demo, or leave it to sign in.' },
      sessionStalled: { title: 'Sign-in is taking too long', body: 'The link was verified, but your secure session has not finished loading. Check your connection, then keep waiting or return to sign in.' },
    },
    actions: {
      keepWaiting: 'Keep waiting',
      returnToSignIn: 'Return to sign in',
      continueSession: 'Continue to Union Ground',
      continueToVerification: 'Continue to verification',
      returnToDemo: 'Return to the demo',
      leaveDemoAndSignIn: 'Leave the demo and sign in',
    },
  },
  es: {
    waiting: {
      verifying: { title: 'Verificando el enlace seguro…', body: 'Union Ground está completando tu sesión de forma segura.', spinnerLabel: 'Verificando' },
      finishing: { title: 'Terminando el inicio de sesión…', body: 'El enlace se verificó. Union Ground está confirmando la seguridad de tu sesión.', spinnerLabel: 'Terminando el inicio de sesión' },
    },
    recovery: {
      missingCode: { title: 'Enlace de inicio de sesión no disponible', body: 'Este enlace de inicio de sesión está incompleto. Solicita uno nuevo.' },
      linkRejected: { title: 'El enlace de inicio de sesión venció', body: 'Este enlace de inicio de sesión venció o ya se usó. Solicita uno nuevo.' },
      exchangeFailed: { title: 'Enlace de inicio de sesión no disponible', body: 'No se pudo verificar este enlace de inicio de sesión. Solicita uno nuevo.' },
      exchangeStalled: { title: 'Seguimos verificando', body: 'La verificación de este enlace está tardando más de lo esperado. Revisa tu conexión y sigue esperando o sal de esta pantalla.' },
      sessionRejected: { title: 'No se completó el inicio de sesión', body: 'El enlace se verificó, pero Union Ground no pudo iniciar tu sesión segura. Vuelve al inicio de sesión e inténtalo de nuevo.' },
      previewActive: { title: 'La demostración sigue abierta', body: 'Este enlace no inició tu sesión porque la demostración está abierta en este teléfono. Vuelve a la demostración o sal de ella para iniciar sesión.' },
      sessionStalled: { title: 'El inicio de sesión está tardando demasiado', body: 'El enlace se verificó, pero tu sesión segura no ha terminado de cargar. Revisa tu conexión y sigue esperando o vuelve al inicio de sesión.' },
    },
    actions: {
      keepWaiting: 'Seguir esperando',
      returnToSignIn: 'Volver al inicio de sesión',
      continueSession: 'Continuar a Union Ground',
      continueToVerification: 'Continuar a la verificación',
      returnToDemo: 'Volver a la demostración',
      leaveDemoAndSignIn: 'Salir de la demostración e iniciar sesión',
    },
  },
};

export function authCallbackCopyFor(language: AuthCallbackLanguage): AuthCallbackCopy {
  return authCallbackCopy[language];
}

// The callback usually runs before any member profile has loaded, so the
// device locale decides unless a profile language is already known.
export function authCallbackLanguage(memberLanguage: string | null | undefined, deviceLocale: string | null | undefined): AuthCallbackLanguage {
  if (memberLanguage === 'es') return 'es';
  if (memberLanguage === 'en') return 'en';
  return (deviceLocale ?? '').toLowerCase().startsWith('es') ? 'es' : 'en';
}

// Screen state and its transitions. The screen holds this in useReducer; every
// transition that decides whether a spinner stays bounded is here, not there.
export type AuthCallbackState = { exchange: AuthCallbackExchange; waitTimedOut: boolean; waitEpoch: number };

export type AuthCallbackEvent =
  // A new one-time code started its exchange.
  | { type: 'exchangeStarted' }
  | { type: 'exchangeSettled'; exchange: 'complete' | 'failed' }
  | { type: 'budgetElapsed' }
  | { type: 'keepWaiting' };

export const AUTH_CALLBACK_INITIAL_STATE: AuthCallbackState = { exchange: 'pending', waitTimedOut: false, waitEpoch: 0 };

export function authCallbackReduce(state: AuthCallbackState, event: AuthCallbackEvent): AuthCallbackState {
  switch (event.type) {
    case 'exchangeStarted': return { exchange: 'pending', waitTimedOut: false, waitEpoch: state.waitEpoch + 1 };
    // The session-establishment wait gets its own full budget.
    case 'exchangeSettled': return { ...state, exchange: event.exchange, waitTimedOut: false };
    case 'budgetElapsed': return { ...state, waitTimedOut: true };
    // Bumping the epoch changes the wait key, which re-arms the same budget.
    case 'keepWaiting': return { ...state, waitTimedOut: false, waitEpoch: state.waitEpoch + 1 };
    default: return state;
  }
}

// Identity of the wait the budget timer is armed for; null when nothing is
// waiting. The screen's timer effect depends on this alone, so a new phase or
// a "keep waiting" always arms a fresh budget and no wait is unbounded.
function waitKeyFor(phase: 'verifying' | 'finishing', waitEpoch: number): string {
  return `${phase}:${waitEpoch}`;
}

export function authCallbackWaitKey(view: AuthCallbackView, waitEpoch: number): string | null {
  return view.kind === 'waiting' ? waitKeyFor(view.phase, waitEpoch) : null;
}

export type AuthCallbackButtonEffect =
  | { kind: 'navigate'; href: AuthCallbackHref }
  // The demo session ends first; sign-in would otherwise redirect back Home.
  | { kind: 'endDemoThenNavigate'; href: AuthCallbackHref }
  | { kind: 'dispatch'; event: AuthCallbackEvent };

function buttonEffect(action: AuthCallbackAction): AuthCallbackButtonEffect {
  switch (action) {
    case 'keepWaiting': return { kind: 'dispatch', event: { type: 'keepWaiting' } };
    case 'returnToSignIn': return { kind: 'navigate', href: '/sign-in' };
    case 'continueSession': return { kind: 'navigate', href: '/(tabs)/home' };
    case 'continueToVerification': return { kind: 'navigate', href: '/mfa-challenge' };
    case 'returnToDemo': return { kind: 'navigate', href: '/(tabs)/home' };
    case 'leaveDemoAndSignIn': return { kind: 'endDemoThenNavigate', href: '/sign-in' };
  }
}

// One content-free lifecycle line per recovery state: which state, and the app
// mode that produced it. Never the thrown error.
const RECOVERY_DIAGNOSTIC_STEP: Record<AuthCallbackRecoveryReason, LifecycleStep> = {
  missingCode: 'missing-code',
  linkRejected: 'link-rejected',
  exchangeFailed: 'exchange-failed',
  exchangeStalled: 'exchange-stalled',
  sessionRejected: 'session-rejected',
  previewActive: 'preview-active',
  sessionStalled: 'session-stalled',
};

export type AuthCallbackButton = {
  action: AuthCallbackAction;
  label: string;
  variant: 'primary' | 'secondary';
  effect: AuthCallbackButtonEffect;
};

export type AuthCallbackScreenModel =
  | { kind: 'redirect'; href: AuthCallbackHref; waitKey: null }
  | { kind: 'waiting'; waitKey: string; title: string; body: string; spinnerLabel: string }
  | {
    kind: 'recovery';
    waitKey: null;
    reason: AuthCallbackRecoveryReason;
    title: string;
    body: string;
    announcement: string;
    diagnostic: { scope: 'auth-callback'; step: LifecycleStep; outcome: AuthCallbackMode };
    buttons: readonly AuthCallbackButton[];
  };

// Everything the screen draws and every place a button can lead, decided here.
export function authCallbackScreenModel(input: {
  hasCode: boolean;
  linkRejected?: boolean;
  state: AuthCallbackState;
  mode: AuthCallbackMode;
  language: AuthCallbackLanguage;
}): AuthCallbackScreenModel {
  const view = resolveAuthCallbackView({
    hasCode: input.hasCode,
    linkRejected: input.linkRejected,
    exchange: input.state.exchange,
    mode: input.mode,
    waitTimedOut: input.state.waitTimedOut,
  });
  const copy = authCallbackCopy[input.language];
  if (view.kind === 'redirect') return { kind: 'redirect', href: view.href, waitKey: null };
  if (view.kind === 'waiting') {
    return { kind: 'waiting', waitKey: waitKeyFor(view.phase, input.state.waitEpoch), ...copy.waiting[view.phase] };
  }
  const message = copy.recovery[view.reason];
  return {
    kind: 'recovery',
    waitKey: null,
    reason: view.reason,
    title: message.title,
    body: message.body,
    announcement: `${message.title}. ${message.body}`,
    diagnostic: { scope: 'auth-callback', step: RECOVERY_DIAGNOSTIC_STEP[view.reason], outcome: input.mode },
    buttons: view.actions.map((action, index) => ({
      action,
      label: copy.actions[action],
      variant: index === 0 && view.actions.length > 1 ? 'primary' : 'secondary',
      effect: buttonEffect(action),
    })),
  };
}
