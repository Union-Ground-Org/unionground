import { describe, expect, it, vi } from 'vitest';

// The shipped host list is empty; this suite exercises the parser against one
// fictional host and proves the sibling product's hosts stay refused.
vi.mock('../../../../src/lib/emailLinkHosts.js', () => ({ EMAIL_LINK_HOSTS: Object.freeze(['app.unionground.example']) }));

import { emailAuthFromParams } from './emailAuth';
import { parseAppRoute } from './routes';
import { redirectSystemPath } from '../../app/+native-intent';

const invite = 'A'.repeat(43);
const ticket = `t1.${'A'.repeat(16)}.${'B'.repeat(64)}`;

describe('native email callback dispatch', () => {
  it('refuses emailed links from a sibling product', () => {
    for (const host of ['sibling-saas.example', 'sibling-product.example']) {
      expect(redirectSystemPath({ path: `https://${host}/app/invite#invite=${invite}`, initial: true })).toBe('/');
      expect(parseAppRoute(`https://${host}/app/invite#invite=${invite}`)).toBeNull();
    }
  });

  it.each(['app.unionground.example'])('handles cold and warm invitation and reset links for %s', (host) => {
    for (const initial of [true, false]) {
      expect(redirectSystemPath({ path: `https://${host}/app/invite#invite=${invite}`, initial }))
        .toBe(`/auth/callback?invite=${invite}`);
      expect(redirectSystemPath({ path: `https://${host}/app/reset-password#token=${ticket}`, initial }))
        .toBe(`/auth/callback?resetTicket=${ticket}`);
    }
    expect(parseAppRoute(`https://${host}/app/invite#invite=${invite}`))
      .toEqual({ kind: 'emailAuth', action: 'invitation', token: invite });
  });

  it('keeps malformed email payloads out of the callback', () => {
    for (const path of [
      `https://app.unionground.example/app/invite?invite=${invite}`,
      `https://app.unionground.example/app/invite#invite=${invite}&next=/home`,
      `https://evil.example/app/reset-password#token=${ticket}`,
      `https://app.unionground.example/app/reset-password#token=raw-recovery-token`,
    ]) expect(redirectSystemPath({ path, initial: true })).toBe('/');
  });

  it('accepts exactly one credential and rejects repeated, mixed and unexpected callback parameters', () => {
    expect(emailAuthFromParams({ invite })).toEqual({ kind: 'invitation', token: invite });
    expect(emailAuthFromParams({ resetTicket: ticket })).toEqual({ kind: 'passwordReset', token: ticket });
    expect(emailAuthFromParams({ resume: 'password-reset' })).toEqual({ kind: 'passwordResume', token: '' });
    for (const params of [{ resume: 'other' }, { resume: 'password-reset', code: 'c' }, { resume: 'password-reset', resetTicket: ticket }, {}, { invite: [invite] }, { invite, resetTicket: ticket }, { invite, code: 'code' }, { resetTicket: ticket, next: '/home' }, { invite: 'short' }]) {
      expect(emailAuthFromParams(params)).toBeNull();
    }
  });
});
