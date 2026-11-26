import { INVITATION_LINK_TOKEN, RESET_LINK_TICKET } from '../../../../src/lib/emailedAuthLink.js';

// 'passwordResume' carries no credential: it reopens the reset the member
// already began on this phone, from the state kept by pendingPasswordReset.ts.
export type EmailAuthLink = { kind: 'invitation' | 'passwordReset'; token: string } | { kind: 'passwordResume'; token: '' };
export const PASSWORD_RESUME_PARAM = 'resume';
export const PASSWORD_RESUME_VALUE = 'password-reset';
export const EMAIL_AUTH_SIGN_IN_PATH = '/sign-in';

// The router's query is internal to the app. It must not let repeated params,
// mixed credentials, or a PKCE code turn an invalid email into another flow.
export function emailAuthFromParams(params: Record<string, string | string[] | undefined>): EmailAuthLink | null {
  const keys = Object.keys(params).filter((key) => params[key] !== undefined);
  if (keys.length !== 1) return null;
  if (typeof params.invite === 'string' && INVITATION_LINK_TOKEN.test(params.invite)) {
    return { kind: 'invitation', token: params.invite };
  }
  if (typeof params.resetTicket === 'string' && RESET_LINK_TICKET.test(params.resetTicket)) {
    return { kind: 'passwordReset', token: params.resetTicket };
  }
  if (params[PASSWORD_RESUME_PARAM] === PASSWORD_RESUME_VALUE) return { kind: 'passwordResume', token: '' };
  return null;
}
