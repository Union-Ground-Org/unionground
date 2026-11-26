import { describe, expect, it } from 'vitest';

import { mfaChallengeKey } from './mfaChallengeKey';

const token = (sessionID: string, iat: number) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ session_id: sessionID, iat })}.signature`;
};

describe('mfaChallengeKey', () => {
  it('keeps one challenge across a token refresh of the same session', () => {
    const user = { id: 'user-1' };
    expect(mfaChallengeKey({ user, access_token: token('11111111-1111-4111-8111-111111111111', 1) }))
      .toBe(mfaChallengeKey({ user, access_token: token('11111111-1111-4111-8111-111111111111', 2) }));
  });

  it('starts a fresh challenge after sign-out and on every new sign-in', () => {
    // Physical iPhone, October 1, 2026: the previous code, message and open
    // recovery section survived sign-out and garbled the next recovery code.
    const user = { id: 'user-1' };
    const first = mfaChallengeKey({ user, access_token: token('11111111-1111-4111-8111-111111111111', 1) });
    const second = mfaChallengeKey({ user, access_token: token('22222222-2222-4222-8222-222222222222', 1) });
    expect(mfaChallengeKey(null)).toBe('signed-out');
    expect(second).not.toBe(first);
    expect(first).not.toBe('signed-out');
  });
});
