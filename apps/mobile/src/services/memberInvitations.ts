import type { Session } from '@supabase/supabase-js';

import { mobileConfig } from '../lib/config';
import { isUnionGroundBackend } from '../lib/configPolicy';
import { easternDateTime } from '../lib/evidenceTimestamp';
import { nativeUiText, type NativeLanguage } from '../lib/nativeUiCopy';
import { withReadDeadline } from '../lib/readDeadline';
import { isAuthoritativeReadRefusal } from '../lib/readRefusal';
import { createCapturedSessionRpcClient } from './supabase';

// #8257, the native twin of the web member-send form (#8171). The switch is
// only presentation; the portal rechecks the caller, home chapter and limits.
export async function loadMemberInvitationsEnabled(session: Session): Promise<boolean> {
  return await loadMemberInvitationAccess(session) === 'enabled';
}

// A temporary read failure conceals the form; only a confirmed disabled
// switch or access refusal retires the unsent invitation permanently.
export async function loadMemberInvitationAccess(session: Session): Promise<'enabled' | 'disabled' | 'unavailable'> {
  if (!isUnionGroundBackend(mobileConfig) || !session.access_token) return 'disabled';
  try {
    const response = await withReadDeadline(Promise.resolve(
      createCapturedSessionRpcClient(session).rpc('get_member_organization_configuration'),
    ));
    const { data, error } = response;
    const configuration: { switches?: Record<string, unknown> } | null = data;
    if (error) return isAuthoritativeReadRefusal(response) || isAuthoritativeReadRefusal(error) ? 'disabled' : 'unavailable';
    return configuration?.switches?.['features.member_invitations.enabled'] === true ? 'enabled' : 'disabled';
  } catch (error) {
    return isAuthoritativeReadRefusal(error) ? 'disabled' : 'unavailable';
  }
}

export class MemberInvitationError extends Error {
  constructor(readonly code: string, readonly retryAt: string | null = null) {
    super(code);
    this.name = 'MemberInvitationError';
  }
}

type InvitationFields = { fullName: string; email: string; locale: string };
type InvitationReply = { accepted?: unknown; error?: unknown; retryAt?: unknown; limit?: unknown };

export async function sendMemberInvitation(session: Session, fields: InvitationFields): Promise<void> {
  // Refuse SAMPLE, preview, custom origins and partial configurations before
  // constructing a request. A manifest cannot choose where this bearer goes.
  if (!isUnionGroundBackend(mobileConfig) || !session.access_token) throw new MemberInvitationError('not-permitted');
  const accessToken = session.access_token;
  const controller = new AbortController();
  try {
    await withReadDeadline((async () => {
      const response = await fetch(`${mobileConfig.portalBaseUrl}/api/admin-invitations`, {
        method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'member-send', fullName: fields.fullName.trim(), email: fields.email.trim(), locale: fields.locale === 'es' ? 'es' : 'en' }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      const reply: InvitationReply = payload !== null && typeof payload === 'object' ? payload : {};
      if (!response.ok) {
        const code = typeof reply.error === 'string' ? reply.error : 'failed';
        const retryAt = code === 'rate-limited' && typeof reply.limit === 'string'
          && typeof reply.retryAt === 'string' && Number.isFinite(Date.parse(reply.retryAt)) ? reply.retryAt : null;
        throw new MemberInvitationError(code, retryAt);
      }
      if (reply.accepted !== true) throw new MemberInvitationError('failed');
    })());
  } catch (error) {
    throw error instanceof MemberInvitationError ? error : new MemberInvitationError('failed');
  } finally {
    // The shared deadline covers headers AND body, even for a transport that
    // ignores abort. There is no automatic resend of an uncertain mutation.
    controller.abort();
  }
}

// Match the web English answers. Its suggestion-below suffix is omitted:
// native has no suggestion form, so it must not promise one here.
export function memberInvitationNotice(error?: unknown, language: NativeLanguage = 'en'): string {
  const t = nativeUiText(language);
  if (!error) return t('If that address can be invited, the invitation is on its way. It works for 15 minutes.');
  if (error instanceof MemberInvitationError) {
    if (error.code === 'rate-limited') {
      const time = easternDateTime(error.retryAt);
      if (time) return t('You have sent as many invitations as you can for now. You can send more after {time}.', { time });
    }
    if (error.code === 'email-domain-blocked') return t("Use a personal email address. Government and employer email addresses can't be used for a Union Ground account.");
    if (error.code === 'not-permitted') return t("Your account can't send invitations right now. New accounts can send invitations after their first week.");
  }
  return t('The invitation could not be sent. Check it and try again.');
}
