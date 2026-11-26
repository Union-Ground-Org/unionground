import { describe, expect, it } from 'vitest';

import { createResumeRefreshProvenance, createSignInCompletion, SESSION_NOT_CONFIRMED_NOTICE, SIGN_IN_DID_NOT_COMPLETE_NOTICE } from './signInCompletion';

// BUG-UG-NATIVE-SIGN-IN-SILENT-DROP-20261104.
describe('sign-in completion notices', () => {
  it('owes the did-not-complete notice once when a pending sign-in loses its session', () => {
    const tracker = createSignInCompletion();
    tracker.begin();
    expect(tracker.sessionLost()).toBe(SIGN_IN_DID_NOT_COMPLETE_NOTICE);
    expect(tracker.sessionLost()).toBeNull();
  });

  it('says nothing for a loss with no sign-in pending, or after it settled', () => {
    const tracker = createSignInCompletion();
    expect(tracker.sessionLost()).toBeNull();
    tracker.begin();
    tracker.settle();
    expect(tracker.isPending()).toBe(false);
    expect(tracker.sessionLost()).toBeNull();
  });

  it('names a refused revalidation, and a pending sign-in as not completed', () => {
    const tracker = createSignInCompletion();
    expect(tracker.sessionRefused()).toBe(SESSION_NOT_CONFIRMED_NOTICE);
    tracker.begin();
    expect(tracker.sessionRefused()).toBe(SIGN_IN_DID_NOT_COMPLETE_NOTICE);
    expect(tracker.isPending()).toBe(false);
  });

  it('writes plain sentences that say what to do next', () => {
    for (const notice of [SIGN_IN_DID_NOT_COMPLETE_NOTICE, SESSION_NOT_CONFIRMED_NOTICE]) {
      expect(notice).toMatch(/Sign in again/);
      expect(notice).not.toMatch(/session_id|token|AAL|RLS/i);
    }
  });
});

describe('the worker\'s own exit and a refresh outliving its resume (#7021 round 2)', () => {
  const token = (sessionID: string) => `header.${Buffer.from(JSON.stringify({ session_id: sessionID })).toString('base64url')}.signature`;
  const SID_A = '11111111-1111-4111-8111-111111111111';
  const SID_B = '22222222-2222-4222-8222-222222222222';

  it('owes nothing for a loss inside an intentional exit, and clears a pending sign-in', async () => {
    const tracker = createSignInCompletion();
    tracker.begin();
    const seen = await tracker.intentionalExit(async () => [tracker.sessionLost(), tracker.sessionRefused()]);
    expect(seen).toEqual([null, null]);
    expect(tracker.isPending()).toBe(false);
    expect(tracker.sessionRefused()).toBe(SESSION_NOT_CONFIRMED_NOTICE);
  });

  it('covers a lineage only while its refresh awaits Auth, whether it resolves or rejects', async () => {
    const provenance = createResumeRefreshProvenance();
    const lineage = { userID: 'member', accessToken: token(SID_A) };
    let finish!: (value: never) => void;
    let fail!: (error: Error) => void;
    const answers = [
      new Promise<never>((resolve) => { finish = resolve; }),
      new Promise<never>((_resolve, reject) => { fail = reject; }),
    ];
    const auth = provenance.track({
      refreshSession: () => answers.shift()!,
      getUser: async () => ({ data: { user: null }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: null, error: null }) },
    } as never, lineage);
    const first = auth.refreshSession();
    expect(provenance.covers(lineage)).toBe(true);
    expect(provenance.covers({ userID: 'member', accessToken: token(SID_B) })).toBe(false);
    expect(provenance.covers({ userID: 'other', accessToken: token(SID_A) })).toBe(false);
    finish({ data: { session: null }, error: null } as never);
    await first;
    expect(provenance.covers(lineage)).toBe(false);
    const second = auth.refreshSession();
    expect(provenance.covers(lineage)).toBe(true);
    fail(new Error('refused'));
    await expect(second).rejects.toThrow('refused');
    expect(provenance.covers(lineage)).toBe(false);
    expect(provenance.covers(null)).toBe(false);
  });
});

describe('the provenance covers the whole resume check (#7021 round 3)', () => {
  it('covers the user lookup and the assurance read, each until Auth answers', async () => {
    const provenance = createResumeRefreshProvenance();
    const lineage = { userID: 'member', accessToken: `header.${Buffer.from(JSON.stringify({ session_id: '33333333-3333-4333-8333-333333333333' })).toString('base64url')}.signature` };
    let rejectUser!: (error: Error) => void;
    let answerAssurance!: (value: never) => void;
    const auth = provenance.track({
      refreshSession: async () => ({ data: { session: null }, error: null }),
      getUser: () => new Promise((_resolve, reject) => { rejectUser = reject; }),
      mfa: { getAuthenticatorAssuranceLevel: () => new Promise((resolve) => { answerAssurance = resolve as never; }) },
    } as never, lineage);
    await auth.refreshSession();
    expect(provenance.covers(lineage)).toBe(false);
    const lookup = auth.getUser();
    expect(provenance.covers(lineage)).toBe(true);
    rejectUser(new Error('session_not_found'));
    await expect(lookup).rejects.toThrow('session_not_found');
    expect(provenance.covers(lineage)).toBe(false);
    const assurance = auth.mfa.getAuthenticatorAssuranceLevel();
    expect(provenance.covers(lineage)).toBe(true);
    answerAssurance({ data: null, error: null } as never);
    await assurance;
    expect(provenance.covers(lineage)).toBe(false);
  });
});
