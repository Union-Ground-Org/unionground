import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  mfaRecoveryCodeAccepted,
  mfaRecoveryMessage,
  normalizeMfaRecoveryCode,
  redeemMfaRecoveryCode,
  type MfaRecoveryOutcome,
  type MfaRecoveryRequest,
} from './mfaRecovery';

type SentRequest = { url: string; init: Parameters<MfaRecoveryRequest>[1] };

// Shaped exactly like a code the database issues: generate_mfa_recovery_codes()
// writes its prefix and four hex groups (the test below reads that prefix from
// the migration, so a prefix change there fails here instead of drifting).
const SAVED_CODE = 'PSG-1A2B-3C4D-5E6F-7089';
const generatorPath = fileURLToPath(new URL('../../../../supabase/migrations/20261014013000_unionground_organizing_seed_copy.sql', import.meta.url));
const generator = existsSync(generatorPath) ? readFileSync(generatorPath, 'utf8') : null;

type Attempt = {
  requests: SentRequest[];
  signOuts: number;
  outcome: MfaRecoveryOutcome;
};

async function attempt(code: string, answer: { status: number } | Error, token: string | null = 'aal1-token'): Promise<Attempt> {
  const requests: SentRequest[] = [];
  let signOuts = 0;
  const outcome = await redeemMfaRecoveryCode(code, {
    accessToken: async () => token,
    signOutLocally: async () => { signOuts += 1; },
    apiOrigin: () => 'https://sample.unionground.example',
    request: async (url, init) => {
      requests.push({ url, init });
      if (answer instanceof Error) throw answer;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status };
    },
  });
  return { requests, signOuts, outcome };
}

describe('native MFA recovery codes (UX-UG-NATIVE-MFA-CHALLENGE-HAS-NO-RECOVERY-CODE-PATH-20260921)', () => {
  it.skipIf(generator === null)('uses fixtures in the format the database actually generates', () => {
    const fn = (generator ?? '').slice((generator ?? '').indexOf('create or replace function public.generate_mfa_recovery_codes()'));
    const prefix = fn.match(/plain := '([A-Z]+-)' \|\| pg_catalog\.substr\(compact, 1, 4\)/)?.[1];
    expect(prefix).toBeTruthy();
    expect(SAVED_CODE).toMatch(new RegExp(`^${prefix}[0-9A-F]{4}(-[0-9A-F]{4}){3}$`));
    expect(mfaRecoveryCodeAccepted(SAVED_CODE)).toBe(true);
  });

  it('accepts the saved code shape the authenticator field could never hold', () => {
    // The challenge field gated on /^\d{6,8}$/, so an 18-32 character recovery
    // code was unenterable and the screen offered no other way through.
    expect(/^\d{6,8}$/.test(SAVED_CODE)).toBe(false);
    expect(mfaRecoveryCodeAccepted(SAVED_CODE)).toBe(true);
    expect(mfaRecoveryCodeAccepted('UG1A2B3C4D5E6F7089')).toBe(true);
    expect(mfaRecoveryCodeAccepted(` ${SAVED_CODE} `)).toBe(true);
  });

  it('refuses an authenticator code, a short code, and characters the server would strip', () => {
    expect(mfaRecoveryCodeAccepted('123456')).toBe(false);
    expect(mfaRecoveryCodeAccepted('PSG-1A2B-3C4D')).toBe(false);
    expect(mfaRecoveryCodeAccepted(`${SAVED_CODE}${SAVED_CODE}`)).toBe(false);
    expect(mfaRecoveryCodeAccepted('UG_1A2B_3C4D_5E6F_7089')).toBe(false);
  });

  it('strips the whitespace a phone keyboard adds without touching the separators', () => {
    expect(normalizeMfaRecoveryCode(' PSG-1A2B-3C4D-5E6F-7089 ')).toBe(SAVED_CODE);
    expect(normalizeMfaRecoveryCode('PSG-1A2B 3C4D-5E6F-7089')).toBe('PSG-1A2B3C4D-5E6F-7089');
  });

  it('posts the code to the one trusted portal origin with the aal1 bearer token', async () => {
    const { requests, outcome, signOuts } = await attempt(SAVED_CODE, { status: 200 });
    expect(outcome).toBe('recovered');
    expect(requests).toHaveLength(1);
    const post = requests[0];
    expect(post?.url).toBe('https://sample.unionground.example/api/mfa-recovery');
    expect(post?.init.method).toBe('POST');
    expect(post?.init.headers).toEqual({
      Authorization: 'Bearer aal1-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(post?.init.body))).toEqual({ code: SAVED_CODE });
    // The server revoked every session; the stored one goes with it.
    expect(signOuts).toBe(1);
  });

  it('keeps the worker signed in when the server refuses the code', async () => {
    const { outcome, signOuts } = await attempt(SAVED_CODE, { status: 400 });
    expect(outcome).toBe('rejected');
    expect(signOuts).toBe(0);
  });

  it('keeps the worker signed in when recovery is unavailable or the request never lands', async () => {
    for (const answer of [{ status: 401 }, { status: 403 }, { status: 502 }, { status: 503 }]) {
      const { outcome, signOuts } = await attempt(SAVED_CODE, answer);
      expect(outcome).toBe('unavailable');
      expect(signOuts).toBe(0);
    }
    const offline = await attempt(SAVED_CODE, new Error('network'));
    expect(offline.outcome).toBe('unavailable');
    expect(offline.signOuts).toBe(0);
  });

  it('never spends a server attempt on a code the field can already see is wrong', async () => {
    // Five refusals lock the code set for fifteen minutes, so a malformed code
    // stays on the device.
    const { requests, outcome, signOuts } = await attempt('123456', { status: 200 });
    expect(outcome).toBe('rejected');
    expect(requests).toHaveLength(0);
    expect(signOuts).toBe(0);
  });

  it('reports an expired session as unavailable instead of sending a bearer-less post', async () => {
    const { requests, outcome } = await attempt(SAVED_CODE, { status: 200 }, null);
    expect(outcome).toBe('unavailable');
    expect(requests).toHaveLength(0);
  });

  it('refuses an untrusted portal origin before any code is sent', async () => {
    let requested = 0;
    const outcome = await redeemMfaRecoveryCode(SAVED_CODE, {
      accessToken: async () => 'aal1-token',
      signOutLocally: async () => {},
      apiOrigin: () => { throw new Error('Portal origin is not trusted.'); },
      request: async () => { requested += 1; return { ok: true, status: 200 }; },
    });
    expect(outcome).toBe('unavailable');
    expect(requested).toBe(0);
  });

  // SEC-UG-MFA-RECOVERY-GLOBAL-LOGOUT-CLEARS-INCOMPLETE-WARNING-20261020:
  // the provider may lift an incomplete Sign out everywhere warning only on the
  // server's own statement that the global logout ran, and before the local
  // sign-out whose SIGNED_OUT would raise it again.
  it('confirms the global logout before the local sign-out, and only on the server statement', async () => {
    async function confirmOrder(response: Awaited<ReturnType<MfaRecoveryRequest>> | Error) {
      const order: string[] = [];
      const outcome = await redeemMfaRecoveryCode(SAVED_CODE, {
        accessToken: async () => 'aal1-token',
        apiOrigin: () => 'https://sample.unionground.example',
        confirmGlobalSignOut: () => { order.push('confirm'); },
        signOutLocally: async () => { order.push('local-sign-out'); },
        request: async () => { if (response instanceof Error) throw response; return response; },
      });
      return { outcome, order };
    }
    const body = (value: unknown) => async () => value;
    expect(await confirmOrder({ ok: true, status: 200, json: body({ recovered: true, removed: 1, sessionsRevoked: true, signInAgain: true }) }))
      .toEqual({ outcome: 'recovered', order: ['confirm', 'local-sign-out'] });
    for (const unconfirmed of [
      { ok: true, status: 200 },
      { ok: true, status: 200, json: body(null) },
      { ok: true, status: 200, json: body({ recovered: true }) },
      { ok: true, status: 200, json: body({ recovered: true, sessionsRevoked: false }) },
      { ok: true, status: 200, json: body({ recovered: true, sessionsRevoked: 'true' }) },
      { ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } },
    ]) {
      expect(await confirmOrder(unconfirmed)).toEqual({ outcome: 'recovered', order: ['local-sign-out'] });
    }
    for (const refused of [
      { ok: false, status: 400, json: body({ error: 'code-not-accepted' }) },
      { ok: false, status: 502, json: body({ error: 'recovery-unavailable', removed: 1 }) },
      new Error('network'),
    ]) {
      expect((await confirmOrder(refused)).order).toEqual([]);
    }
  });

  it('names the next step for every outcome', () => {
    expect(mfaRecoveryMessage('recovered')).toContain('Sign in again');
    expect(mfaRecoveryMessage('rejected')).toContain('not accepted');
    expect(mfaRecoveryMessage('unavailable')).toContain('campaign administrator');
    expect(mfaRecoveryMessage('cleanup-required')).toContain('code will not be sent again');
    const outcomes: MfaRecoveryOutcome[] = ['recovered', 'rejected', 'unavailable', 'cleanup-required'];
    for (const outcome of outcomes) {
      expect(mfaRecoveryMessage(outcome)).not.toMatch(/local office|factor/i);
    }
  });

  it.each(['refused', 'failed'])('keeps accepted recovery distinct from %s local clearing', async (cleanup) => {
    const outcome = await redeemMfaRecoveryCode(SAVED_CODE, {
      apiOrigin: () => 'https://sample.unionground.example', accessToken: async () => 'aal1-token',
      request: async () => ({ ok: true, status: 200, json: async () => ({ recovered: true, sessionsRevoked: true }) }),
      signOutLocally: async () => {
        if (cleanup === 'failed') throw new Error('secure storage unavailable');
        return false;
      },
    });
    expect(outcome).toBe('cleanup-required');
  });

  it('offers the recovery path on the native challenge screen itself', () => {
    const screen = readFileSync(fileURLToPath(new URL('../../app/mfa-challenge.tsx', import.meta.url)), 'utf8');
    expect(screen).toContain('redeemMfaRecoveryCode');
    expect(screen).toContain('accessibilityLabel="One-time recovery code"');
    expect(screen).toContain('accessibilityState={{ expanded: recoveryOpen }}');
    // The escape hatch is a field on the screen, not only an instruction to
    // telephone the office.
    expect(screen).toContain('Use a recovery code');
  });
});
