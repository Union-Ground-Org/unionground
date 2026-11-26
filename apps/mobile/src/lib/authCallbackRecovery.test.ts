import { afterEach, describe, expect, it } from 'vitest';

import {
  readLifecycleDiagnostics,
  recordLifecycleEvent,
  resetLifecycleDiagnostics,
  setLifecycleDiagnosticsSink,
} from '../services/lifecycleDiagnostics';
import {
  AUTH_CALLBACK_INITIAL_STATE,
  AUTH_CALLBACK_WAIT_BUDGET_MS,
  authCallbackCopyFor,
  authCallbackLanguage,
  authCallbackReduce,
  authCallbackScreenModel,
  authCallbackWaitKey,
  resolveAuthCallbackView,
  type AuthCallbackAction,
  type AuthCallbackEvent,
  type AuthCallbackExchange,
  type AuthCallbackLanguage,
  type AuthCallbackMode,
  type AuthCallbackRecoveryReason,
  type AuthCallbackState,
} from './authCallbackRecovery';

const MODES: AuthCallbackMode[] = ['booting', 'signedOut', 'mfaRequired', 'authenticated', 'preview'];
const EXCHANGES: AuthCallbackExchange[] = ['pending', 'complete', 'failed'];
const REASONS: AuthCallbackRecoveryReason[] = [
  'missingCode', 'linkRejected', 'exchangeFailed', 'exchangeStalled', 'sessionRejected', 'previewActive', 'sessionStalled',
];
const LANGUAGES: AuthCallbackLanguage[] = ['en', 'es'];
const ACTIONS: AuthCallbackAction[] = ['keepWaiting', 'returnToSignIn', 'continueSession', 'continueToVerification', 'returnToDemo', 'leaveDemoAndSignIn'];

function view(exchange: AuthCallbackExchange, mode: AuthCallbackMode, waitTimedOut = false, hasCode = true) {
  return resolveAuthCallbackView({ hasCode, exchange, mode, waitTimedOut });
}

describe('auth callback outcomes (BUG-UG-MOBILE-IOS-AUTH-CALLBACK-SPINNER-NO-RECOVERY-20260919)', () => {
  it('redirects a completed exchange into mfaRequired to the MFA challenge', () => {
    expect(view('complete', 'mfaRequired')).toEqual({ kind: 'redirect', href: '/mfa-challenge' });
  });

  it('redirects a completed exchange into authenticated to Home', () => {
    expect(view('complete', 'authenticated')).toEqual({ kind: 'redirect', href: '/(tabs)/home' });
  });

  it('never redirects before the exchange completes, whatever the mode already is', () => {
    for (const mode of MODES) {
      expect(view('pending', mode).kind).toBe('waiting');
      expect(view('failed', mode).kind).toBe('recovery');
    }
  });

  it('gives a link without a code a recovery state that returns to sign in', () => {
    for (const exchange of EXCHANGES) {
      expect(view(exchange, 'signedOut', false, false)).toEqual({ kind: 'recovery', reason: 'missingCode', actions: ['returnToSignIn'] });
    }
    for (const mode of MODES) {
      for (const exchange of EXCHANGES) {
        expect(view(exchange, mode, false, false)).toMatchObject({ kind: 'recovery', reason: 'missingCode' });
      }
    }
  });

  // UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (tooling
  // ledger 18): an expired or already-used link comes back with the auth
  // server's error parameters and no code. It used to read "incomplete".
  it('says a link the auth server refused expired or was already used, not that it is incomplete', () => {
    for (const mode of MODES) {
      for (const exchange of EXCHANGES) {
        expect(resolveAuthCallbackView({ hasCode: false, linkRejected: true, exchange, mode, waitTimedOut: false })).toMatchObject({ kind: 'recovery', reason: 'linkRejected' });
      }
    }
    // A code wins: the error parameters never change what a real exchange shows.
    for (const mode of MODES) {
      for (const exchange of EXCHANGES) {
        for (const waitTimedOut of [false, true]) {
          expect(resolveAuthCallbackView({ hasCode: true, linkRejected: true, exchange, mode, waitTimedOut }))
            .toEqual(resolveAuthCallbackView({ hasCode: true, exchange, mode, waitTimedOut }));
        }
      }
    }
    expect(resolveAuthCallbackView({ hasCode: true, linkRejected: true, exchange: 'pending', mode: 'signedOut', waitTimedOut: false })).toEqual({ kind: 'waiting', phase: 'verifying' });
    const en = authCallbackScreenModel({ hasCode: false, linkRejected: true, state: AUTH_CALLBACK_INITIAL_STATE, mode: 'signedOut', language: 'en' });
    const es = authCallbackScreenModel({ hasCode: false, linkRejected: true, state: AUTH_CALLBACK_INITIAL_STATE, mode: 'signedOut', language: 'es' });
    expect(en).toMatchObject({ kind: 'recovery', title: 'Sign-in link expired', body: 'This sign-in link has expired or was already used. Request a new one.', diagnostic: { step: 'link-rejected', outcome: 'signedOut' } });
    expect(es).toMatchObject({ kind: 'recovery', title: 'El enlace de inicio de sesión venció', body: 'Este enlace de inicio de sesión venció o ya se usó. Solicita uno nuevo.' });
    for (const model of [en, es]) expect(model.kind === 'recovery' && model.body).not.toMatch(/incomplete|incompleto/);
    expect(en.kind === 'recovery' && en.buttons.map((button) => button.action)).toEqual(['returnToSignIn']);
  });

  it('sends a failed exchange to a fresh sign-in and never offers a retry', () => {
    // The auth client deletes the PKCE code verifier on every exchange outcome,
    // so re-exchanging the same link cannot succeed; only a new link can.
    expect(view('failed', 'signedOut')).toEqual({ kind: 'recovery', reason: 'exchangeFailed', actions: ['returnToSignIn'] });
    for (const hasCode of [true, false]) {
      for (const exchange of EXCHANGES) {
        for (const mode of MODES) {
          for (const waitTimedOut of [true, false]) {
            const resolved = view(exchange, mode, waitTimedOut, hasCode);
            if (resolved.kind === 'recovery') expect(resolved.actions).not.toContain('retryExchange');
          }
        }
      }
    }
    expect(Object.keys(authCallbackCopyFor('en').actions)).not.toContain('retryExchange');
  });

  it('bounds the exchange wait: past the budget the spinner yields to keep-waiting or sign in', () => {
    expect(view('pending', 'signedOut')).toEqual({ kind: 'waiting', phase: 'verifying' });
    expect(view('pending', 'signedOut', true)).toEqual({ kind: 'recovery', reason: 'exchangeStalled', actions: ['keepWaiting', 'returnToSignIn'] });
  });

  it('gives a completed exchange that ends signedOut a recovery state, not a spinner', () => {
    expect(view('complete', 'signedOut')).toEqual({ kind: 'recovery', reason: 'sessionRejected', actions: ['returnToSignIn'] });
  });

  it('gives a completed exchange while the demo is open a route back to the demo or out of it', () => {
    // Sign-in redirects to Home in preview, so returnToSignIn would land in the demo.
    expect(view('complete', 'preview')).toEqual({ kind: 'recovery', reason: 'previewActive', actions: ['returnToDemo', 'leaveDemoAndSignIn'] });
  });

  it('bounds the post-exchange booting wait: past the budget it offers keep-waiting or sign in', () => {
    expect(view('complete', 'booting')).toEqual({ kind: 'waiting', phase: 'finishing' });
    expect(view('complete', 'booting', true)).toEqual({ kind: 'recovery', reason: 'sessionStalled', actions: ['keepWaiting', 'returnToSignIn'] });
  });

  it('leaves no timed-out combination on a spinner and gives every recovery a way out', () => {
    for (const hasCode of [true, false]) {
      for (const exchange of EXCHANGES) {
        for (const mode of MODES) {
          const timedOut = view(exchange, mode, true, hasCode);
          expect(timedOut.kind, `${hasCode}/${exchange}/${mode}`).not.toBe('waiting');
          for (const waitTimedOut of [true, false]) {
            const resolved = view(exchange, mode, waitTimedOut, hasCode);
            if (resolved.kind === 'recovery') expect(resolved.actions.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('fails closed into a recovery state for a mode it does not know', () => {
    expect(view('complete', 'lockedOut' as never).kind).toBe('recovery');
    expect(view('complete', 'lockedOut' as never, true).kind).toBe('recovery');
  });

  it('keeps the wait budget finite and member-scale', () => {
    expect(AUTH_CALLBACK_WAIT_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    expect(AUTH_CALLBACK_WAIT_BUDGET_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('auth callback recovery exits name the destination the mode really reaches', () => {
  // app/sign-in.tsx redirects `authenticated` and `preview` to Home and
  // `mfaRequired` to the MFA challenge, so a plain /sign-in navigation only
  // reaches sign-in from these modes. memberDataBoundary.test.ts pins that rule.
  const SIGN_IN_RENDERS: AuthCallbackMode[] = ['booting', 'signedOut'];

  function recoveryModels() {
    const models = [];
    for (const hasCode of [true, false]) {
      for (const exchange of EXCHANGES) {
        for (const mode of MODES) {
          for (const waitTimedOut of [true, false]) {
            const model = authCallbackScreenModel({ hasCode, state: { exchange, waitTimedOut, waitEpoch: 0 }, mode, language: 'en' });
            if (model.kind === 'recovery') models.push({ mode, model });
          }
        }
      }
    }
    return models;
  }

  it('offers "Return to sign in" only where /sign-in renders sign-in', () => {
    const models = recoveryModels();
    expect(models.length).toBeGreaterThan(0);
    for (const { mode, model } of models) {
      for (const button of model.buttons) {
        if (button.effect.kind === 'navigate' && button.effect.href === '/sign-in') {
          expect(SIGN_IN_RENDERS, `${model.reason}/${mode}`).toContain(mode);
          expect(button.action).toBe('returnToSignIn');
        }
        if (button.action === 'returnToSignIn') expect(button.effect).toEqual({ kind: 'navigate', href: '/sign-in' });
      }
    }
  });

  it('in the demo offers the demo or leaving it, for every reachable recovery reason', () => {
    const reachable: Array<{ exchange: AuthCallbackExchange; hasCode: boolean; reason: AuthCallbackRecoveryReason }> = [
      { exchange: 'pending', hasCode: false, reason: 'missingCode' },
      { exchange: 'failed', hasCode: true, reason: 'exchangeFailed' },
      { exchange: 'complete', hasCode: true, reason: 'previewActive' },
    ];
    for (const { exchange, hasCode, reason } of reachable) {
      expect(view(exchange, 'preview', false, hasCode)).toEqual({ kind: 'recovery', reason, actions: ['returnToDemo', 'leaveDemoAndSignIn'] });
    }
    expect(view('pending', 'preview', true)).toEqual({
      kind: 'recovery', reason: 'exchangeStalled', actions: ['keepWaiting', 'returnToDemo', 'leaveDemoAndSignIn'],
    });
    const model = authCallbackScreenModel({ hasCode: true, state: { exchange: 'failed', waitTimedOut: false, waitEpoch: 0 }, mode: 'preview', language: 'en' });
    expect(model.kind === 'recovery' && model.buttons.map((button) => [button.label, button.variant, button.effect])).toEqual([
      ['Return to the demo', 'primary', { kind: 'navigate', href: '/(tabs)/home' }],
      // Leaving ends the demo session first; only then does /sign-in render sign-in.
      ['Leave the demo and sign in', 'secondary', { kind: 'endDemoThenNavigate', href: '/sign-in' }],
    ]);
  });

  it('with a live session open continues into it instead of claiming a return to sign in', () => {
    expect(view('failed', 'authenticated')).toEqual({ kind: 'recovery', reason: 'exchangeFailed', actions: ['continueSession'] });
    expect(view('pending', 'mfaRequired', true)).toEqual({ kind: 'recovery', reason: 'exchangeStalled', actions: ['keepWaiting', 'continueToVerification'] });
    const hrefFor = (mode: AuthCallbackMode) => {
      const model = authCallbackScreenModel({ hasCode: false, state: AUTH_CALLBACK_INITIAL_STATE, mode, language: 'en' });
      return model.kind === 'recovery' ? model.buttons.map((button) => button.effect) : null;
    };
    expect(hrefFor('authenticated')).toEqual([{ kind: 'navigate', href: '/(tabs)/home' }]);
    expect(hrefFor('mfaRequired')).toEqual([{ kind: 'navigate', href: '/mfa-challenge' }]);
  });

  it('names the MFA challenge, not Union Ground, as the way on while MFA is pending', () => {
    const exits = (mode: AuthCallbackMode, language: AuthCallbackLanguage) => {
      const model = authCallbackScreenModel({ hasCode: false, state: AUTH_CALLBACK_INITIAL_STATE, mode, language });
      return model.kind === 'recovery' ? model.buttons.map((button) => [button.action, button.label, button.effect]) : null;
    };
    expect(exits('mfaRequired', 'en')).toEqual([['continueToVerification', 'Continue to verification', { kind: 'navigate', href: '/mfa-challenge' }]]);
    expect(exits('mfaRequired', 'es')).toEqual([['continueToVerification', 'Continuar a la verificación', { kind: 'navigate', href: '/mfa-challenge' }]]);
    expect(exits('authenticated', 'en')).toEqual([['continueSession', 'Continue to Union Ground', { kind: 'navigate', href: '/(tabs)/home' }]]);
    expect(exits('authenticated', 'es')).toEqual([['continueSession', 'Continuar a Union Ground', { kind: 'navigate', href: '/(tabs)/home' }]]);
    // No reason in the matrix labels the challenge as Union Ground.
    for (const language of LANGUAGES) {
      for (const hasCode of [true, false]) {
        for (const exchange of EXCHANGES) {
          const model = authCallbackScreenModel({ hasCode, state: { exchange, waitTimedOut: true, waitEpoch: 0 }, mode: 'mfaRequired', language });
          if (model.kind !== 'recovery') continue;
          expect(model.buttons.map((button) => button.action)).not.toContain('continueSession');
        }
      }
    }
  });
});

describe('auth callback screen transitions and render model', () => {
  const reduce = (state: AuthCallbackState, ...events: AuthCallbackEvent[]) => events.reduce(authCallbackReduce, state);
  const modelFor = (state: AuthCallbackState, mode: AuthCallbackMode, hasCode = true) => (
    authCallbackScreenModel({ hasCode, state, mode, language: 'en' })
  );

  afterEach(() => {
    setLifecycleDiagnosticsSink(null);
    resetLifecycleDiagnostics();
  });

  it('starts pending inside a bounded wait', () => {
    expect(AUTH_CALLBACK_INITIAL_STATE).toEqual({ exchange: 'pending', waitTimedOut: false, waitEpoch: 0 });
    expect(modelFor(AUTH_CALLBACK_INITIAL_STATE, 'signedOut')).toEqual({
      kind: 'waiting', waitKey: 'verifying:0', title: 'Verifying secure link…', body: 'Union Ground is securely completing your session.', spinnerLabel: 'Verifying',
    });
  });

  it('redirects with exactly the resolver destinations once the exchange settles complete', () => {
    const complete = reduce(AUTH_CALLBACK_INITIAL_STATE, { type: 'exchangeSettled', exchange: 'complete' });
    expect(modelFor(complete, 'mfaRequired')).toEqual({ kind: 'redirect', href: '/mfa-challenge', waitKey: null });
    expect(modelFor(complete, 'authenticated')).toEqual({ kind: 'redirect', href: '/(tabs)/home', waitKey: null });
    // A recovery screen that was showing dissolves into the redirect.
    const late = reduce(AUTH_CALLBACK_INITIAL_STATE, { type: 'budgetElapsed' }, { type: 'exchangeSettled', exchange: 'complete' });
    expect(modelFor(late, 'authenticated').kind).toBe('redirect');
  });

  it('budgetElapsed turns either wait into a recovery and disarms the timer', () => {
    const stalled = reduce(AUTH_CALLBACK_INITIAL_STATE, { type: 'budgetElapsed' });
    expect(stalled.waitTimedOut).toBe(true);
    expect(modelFor(stalled, 'signedOut')).toMatchObject({ kind: 'recovery', reason: 'exchangeStalled', waitKey: null });
    const finishing = reduce(AUTH_CALLBACK_INITIAL_STATE, { type: 'exchangeSettled', exchange: 'complete' }, { type: 'budgetElapsed' });
    expect(modelFor(finishing, 'booting')).toMatchObject({ kind: 'recovery', reason: 'sessionStalled', waitKey: null });
  });

  it('settling clears a spent budget and the finishing wait arms a new one', () => {
    const settled = reduce(AUTH_CALLBACK_INITIAL_STATE, { type: 'budgetElapsed' }, { type: 'exchangeSettled', exchange: 'complete' });
    expect(settled).toEqual({ exchange: 'complete', waitTimedOut: false, waitEpoch: 0 });
    const before = modelFor(AUTH_CALLBACK_INITIAL_STATE, 'booting');
    const after = modelFor(settled, 'booting');
    expect(before.waitKey).toBe('verifying:0');
    expect(after).toMatchObject({ kind: 'waiting', waitKey: 'finishing:0', title: 'Finishing sign-in…' });
    // The timer effect depends on the wait key alone, so this change re-arms it.
    expect(after.waitKey).not.toBe(before.waitKey);
  });

  it('"Keep waiting" really waits again: it clears the timeout and re-arms the budget under a new key', () => {
    const waits: Array<{ mode: AuthCallbackMode; settle: AuthCallbackEvent[] }> = [
      { mode: 'signedOut', settle: [] },
      { mode: 'booting', settle: [{ type: 'exchangeSettled', exchange: 'complete' }] },
    ];
    for (const { mode, settle } of waits) {
      const waiting = reduce(AUTH_CALLBACK_INITIAL_STATE, ...settle);
      const stalled = reduce(waiting, { type: 'budgetElapsed' });
      const recovery = modelFor(stalled, mode);
      const keepWaiting = recovery.kind === 'recovery' ? recovery.buttons.find((button) => button.action === 'keepWaiting') : undefined;
      expect(keepWaiting).toMatchObject({ label: 'Keep waiting', variant: 'primary', effect: { kind: 'dispatch', event: { type: 'keepWaiting' } } });
      if (keepWaiting?.effect.kind !== 'dispatch') throw new Error('keepWaiting must dispatch');
      const resumed = reduce(stalled, keepWaiting.effect.event);
      expect(resumed).toEqual({ ...waiting, waitTimedOut: false, waitEpoch: waiting.waitEpoch + 1 });
      const again = modelFor(resumed, mode);
      expect(again.kind).toBe('waiting');
      expect(again.waitKey).not.toBeNull();
      expect(again.waitKey).not.toBe(modelFor(waiting, mode).waitKey);
      // And the re-armed budget is bounded again, not a permanent spinner.
      expect(modelFor(reduce(resumed, { type: 'budgetElapsed' }), mode).kind).toBe('recovery');
    }
  });

  it('a new code starts a fresh pending exchange with a fresh budget', () => {
    const failed = reduce(AUTH_CALLBACK_INITIAL_STATE, { type: 'exchangeSettled', exchange: 'failed' });
    expect(modelFor(failed, 'signedOut')).toMatchObject({ kind: 'recovery', reason: 'exchangeFailed' });
    const restarted = reduce(failed, { type: 'exchangeStarted' });
    expect(restarted).toEqual({ exchange: 'pending', waitTimedOut: false, waitEpoch: 1 });
    expect(modelFor(restarted, 'signedOut').waitKey).toBe('verifying:1');
  });

  it('keys the wait by phase and epoch, and has no key outside a wait', () => {
    expect(authCallbackWaitKey({ kind: 'waiting', phase: 'verifying' }, 0)).toBe('verifying:0');
    expect(authCallbackWaitKey({ kind: 'waiting', phase: 'finishing' }, 0)).toBe('finishing:0');
    expect(authCallbackWaitKey({ kind: 'waiting', phase: 'verifying' }, 1)).toBe('verifying:1');
    expect(authCallbackWaitKey({ kind: 'redirect', href: '/(tabs)/home' }, 3)).toBeNull();
    expect(authCallbackWaitKey({ kind: 'recovery', reason: 'missingCode', actions: ['returnToSignIn'] }, 3)).toBeNull();
    for (const exchange of EXCHANGES) {
      for (const mode of MODES) {
        for (const waitTimedOut of [true, false]) {
          const state = { exchange, waitTimedOut, waitEpoch: 2 };
          const model = modelFor(state, mode);
          expect(model.waitKey).toBe(authCallbackWaitKey(view(exchange, mode, waitTimedOut), 2));
          expect(model.waitKey === null).toBe(model.kind !== 'waiting');
        }
      }
    }
  });

  it('gives every recovery model localized copy, an announcement and at least one working button', () => {
    for (const language of LANGUAGES) {
      const copy = authCallbackCopyFor(language);
      for (const hasCode of [true, false]) {
        for (const exchange of EXCHANGES) {
          for (const mode of MODES) {
            const model = authCallbackScreenModel({ hasCode, state: { exchange, waitTimedOut: true, waitEpoch: 0 }, mode, language });
            expect(model.kind).not.toBe('waiting');
            if (model.kind !== 'recovery') continue;
            expect(model.title).toBe(copy.recovery[model.reason].title);
            expect(model.announcement).toBe(`${copy.recovery[model.reason].title}. ${copy.recovery[model.reason].body}`);
            expect(model.buttons.length).toBeGreaterThan(0);
            expect(model.buttons.map((button) => button.label)).toEqual(model.buttons.map((button) => copy.actions[button.action]));
            expect(model.buttons.filter((button) => button.variant === 'primary')).toHaveLength(model.buttons.length > 1 ? 1 : 0);
          }
        }
      }
    }
  });

  it('describes each recovery to the lifecycle channel with allowlisted tokens only', () => {
    const lines: string[] = [];
    setLifecycleDiagnosticsSink((line) => lines.push(line));
    const steps = new Set<string>();
    for (const hasCode of [true, false]) {
      for (const linkRejected of [false, true]) {
      for (const exchange of EXCHANGES) {
        for (const mode of MODES) {
          const model = authCallbackScreenModel({ hasCode, linkRejected, state: { exchange, waitTimedOut: true, waitEpoch: 0 }, mode, language: 'en' });
          if (model.kind !== 'recovery') continue;
          expect(Object.keys(model.diagnostic).sort()).toEqual(['outcome', 'scope', 'step']);
          expect(model.diagnostic.outcome).toBe(mode);
          steps.add(model.diagnostic.step);
          recordLifecycleEvent(model.diagnostic);
        }
      }
      }
    }
    expect([...steps].sort()).toEqual(['exchange-failed', 'exchange-stalled', 'link-rejected', 'missing-code', 'preview-active', 'session-rejected', 'session-stalled']);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('unsupported');
    for (const event of readLifecycleDiagnostics()) {
      expect(event.scope).toBe('auth-callback');
      expect(event.reason).toBeNull();
      expect(event.status).toBeNull();
    }
    const stalled = authCallbackScreenModel({ hasCode: true, state: { exchange: 'complete', waitTimedOut: true, waitEpoch: 0 }, mode: 'booting', language: 'es' });
    expect(stalled.kind === 'recovery' && stalled.diagnostic).toEqual({ scope: 'auth-callback', step: 'session-stalled', outcome: 'booting' });
  });
});

describe('auth callback copy', () => {
  it('says "return to the sign-in screen" in Spanish, not "sign in again"', () => {
    const es = authCallbackCopyFor('es');
    expect(es.actions.returnToSignIn).toBe('Volver al inicio de sesión');
    const everything = JSON.stringify(es).toLowerCase();
    expect(everything).not.toContain('volver a iniciar sesión');
    expect(everything).not.toContain('vuelve a iniciar sesión');
    expect(es.recovery.sessionRejected.body).toContain('Vuelve al inicio de sesión e inténtalo de nuevo.');
  });

  it('only names sign-in in a recovery body when that recovery can only lead there', () => {
    // exchangeStalled, missingCode and exchangeFailed occur in every mode, where
    // the exit may be the demo or a live session instead.
    for (const language of LANGUAGES) {
      const copy = authCallbackCopyFor(language);
      const anyModeReasons: AuthCallbackRecoveryReason[] = ['missingCode', 'linkRejected', 'exchangeFailed', 'exchangeStalled'];
      for (const reason of anyModeReasons) {
        expect(copy.recovery[reason].body).not.toMatch(/return to sign in|vuelve al inicio|vuelve a iniciar/i);
      }
    }
  });


  it('localizes every waiting phase, recovery reason and action in English and Spanish', () => {
    const en = authCallbackCopyFor('en');
    const es = authCallbackCopyFor('es');
    const phases: Array<'verifying' | 'finishing'> = ['verifying', 'finishing'];
    const fields: Array<'title' | 'body' | 'spinnerLabel'> = ['title', 'body', 'spinnerLabel'];
    for (const phase of phases) {
      for (const field of fields) {
        expect(en.waiting[phase][field]).toBeTruthy();
        expect(es.waiting[phase][field]).toBeTruthy();
        expect(es.waiting[phase][field]).not.toBe(en.waiting[phase][field]);
      }
    }
    expect(Object.keys(en.recovery).sort()).toEqual([...REASONS].sort());
    expect(Object.keys(es.recovery).sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) {
      expect(es.recovery[reason].title).not.toBe(en.recovery[reason].title);
      expect(es.recovery[reason].body).not.toBe(en.recovery[reason].body);
    }
    expect(Object.keys(en.actions).sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(es.actions).sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) expect(es.actions[action]).not.toBe(en.actions[action]);
  });

  it('prefers a known worker language and otherwise follows the device locale', () => {
    expect(authCallbackLanguage('es', 'en-US')).toBe('es');
    expect(authCallbackLanguage('en', 'es-MX')).toBe('en');
    expect(authCallbackLanguage(null, 'es-MX')).toBe('es');
    expect(authCallbackLanguage(null, 'ES')).toBe('es');
    expect(authCallbackLanguage(undefined, 'en-US')).toBe('en');
    expect(authCallbackLanguage(null, null)).toBe('en');
    expect(authCallbackLanguage(null, 'fr-FR')).toBe('en');
  });
});
