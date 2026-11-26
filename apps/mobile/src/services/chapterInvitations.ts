// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 4 of 4): a chapter administrator or president invites a member
// and follows pending invitations on the phone, through the website's own
// invitation desk calls (src/lib/adminInvitationApi.js and memberApi.js
// loadMemberInvitations): get_member_invitations for the list, and
// /api/admin-invitations (create, resend, revoke) for changes. The server
// checks the role, the chapter, the limits and the address again.
//
// The request carries the member's access token, so it goes only to the
// portal of the backend that issued it (privateFileApiOrigin: SAMPLE to
// sample.unionground.example, Union Ground to app.unionground.example), never to an address the
// public app manifest could change.
//
// A change belongs to the account that started it (the website's client takes
// the session the same way, src/lib/adminInvitationApi.js). Each writer takes
// the session the screen held when the officer pressed the button and sends
// only that session's token. Before the request leaves, the app's current
// session must still be that account; if another account signed in while the
// request waited, nothing is sent.
import type { SupabaseClient } from '@supabase/supabase-js';
import { withReadDeadline } from '../lib/readDeadline';
import { privateFileApiOrigin } from './privateFileAccess';
import { getSupabaseClient } from './supabase';

// The statuses get_member_invitations returns, kept as the server sends them.
// 'unknown' is a status this app does not know: shown without a label or actions.
export type InvitationStatus = 'pending' | 'accepting' | 'accepted' | 'revoked' | 'delivery_failed' | 'expired' | 'superseded' | 'unknown';

const STATUSES: ReadonlySet<string> = new Set(['pending', 'accepting', 'accepted', 'revoked', 'delivery_failed', 'expired', 'superseded']);

// The rows the website offers Resend and Revoke on (PresidentInvitations.jsx ACTIONABLE).
const ACTIONABLE: ReadonlySet<InvitationStatus> = new Set<InvitationStatus>(['pending', 'delivery_failed', 'expired']);

/** The session that started a change: its account and its access token. */
export type InvitationSession = { access_token: string; user: { id: string } };

export type ChapterInvitation = {
  id: string;
  email: string;
  fullName: string;
  chapterName: string;
  status: InvitationStatus;
  expiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
};

export type InvitationDesk = {
  chapter: { id: string; name: string } | null;
  chapters: { id: string; name: string }[];
  items: ChapterInvitation[];
};

// The error codes the route names (src/lib/adminInvitationApi.js KNOWN_ERRORS).
// 'unconfirmed' is the phone's own: the request left, but no answer arrived,
// or the server could not confirm the email went out.
export type InvitationErrorCode =
  | 'invalid-request' | 'not-configured' | 'not-permitted' | 'request-unavailable' | 'service-unavailable'
  | 'delivery-unavailable' | 'rate-limited' | 'email-domain-blocked' | 'session-expired' | 'unconfirmed';

const KNOWN: ReadonlySet<string> = new Set([
  'invalid-request', 'not-configured', 'not-permitted', 'request-unavailable', 'service-unavailable',
  'delivery-unavailable', 'rate-limited', 'email-domain-blocked',
]);

export class ChapterInvitationError extends Error {
  constructor(readonly code: InvitationErrorCode) {
    super(code);
    this.name = 'ChapterInvitationError';
  }
}

function requireClient(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new ChapterInvitationError('not-configured');
  return client;
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  if (!Array.isArray(value)) return rows;
  const list: readonly unknown[] = value;
  for (const item of list) if (item && typeof item === 'object') rows.push(item as Record<string, unknown>);
  return rows;
}

function status(value: string | null): InvitationStatus {
  return value !== null && STATUSES.has(value) ? value as InvitationStatus : 'unknown';
}

/** The chapter's invitations, newest first, as the website's desk reads them. */
export async function loadChapterInvitations(): Promise<InvitationDesk> {
  const result: { data: unknown; error: unknown } = await withReadDeadline(Promise.resolve(requireClient().rpc('get_member_invitations', { p_limit: 50 })));
  if (result.error) throw result.error;
  const data: Record<string, unknown> = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
  const chapterRow = data.chapter && typeof data.chapter === 'object' ? data.chapter as Record<string, unknown> : null;
  const chapter = chapterRow && text(chapterRow, 'id') && text(chapterRow, 'name')
    ? { id: text(chapterRow, 'id') ?? '', name: text(chapterRow, 'name') ?? '' } : null;
  const chapters = records(data.chapters).flatMap((row) => {
    const id = text(row, 'id');
    const name = text(row, 'name');
    return id && name ? [{ id, name }] : [];
  });
  const items: ChapterInvitation[] = [];
  for (const row of records(data.items)) {
    const id = text(row, 'id');
    if (!id) continue;
    items.push({
      id,
      email: text(row, 'normalizedEmail') ?? '',
      fullName: text(row, 'fullName') ?? '',
      chapterName: text(row, 'chapterName') ?? '',
      status: status(text(row, 'status')),
      expiresAt: text(row, 'expiresAt'),
      acceptedAt: text(row, 'acceptedAt'),
      revokedAt: text(row, 'revokedAt'),
    });
  }
  return { chapter, chapters, items };
}

/** A pending link whose expiry has passed since the list was read is expired, never pending. */
export function invitationDisplayStatus(invitation: Pick<ChapterInvitation, 'status' | 'expiresAt'>, nowMs: number): InvitationStatus {
  const expires = Date.parse(invitation.expiresAt ?? '');
  return invitation.status === 'pending' && Number.isFinite(expires) && expires <= nowMs ? 'expired' : invitation.status;
}

/** Whether the website offers Resend and Revoke on a row with this status. */
export function invitationIsActionable(shown: InvitationStatus): boolean {
  return ACTIONABLE.has(shown);
}

async function mutate(session: InvitationSession | null, body: Record<string, unknown>): Promise<void> {
  let origin: string;
  try {
    origin = privateFileApiOrigin();
  } catch {
    throw new ChapterInvitationError('not-configured');
  }
  // The token is fixed here, from the session that started the change, and is
  // never read again from the shared client.
  const token = session?.access_token;
  const userId = session?.user?.id;
  if (!token || !userId) throw new ChapterInvitationError('session-expired');
  const current = await requireClient().auth.getSession().catch(() => null); // swallow-ok: a session that cannot be read is not the starting account, so nothing is sent
  if (!current || current.error || current.data?.session?.user?.id !== userId) throw new ChapterInvitationError('session-expired');
  const controller = new AbortController();
  try {
    await withReadDeadline((async () => {
      let response: Response;
      try {
        response = await fetch(`${origin}/api/admin-invitations`, {
          method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        // The request may have reached the server: the answer is unknown.
        throw new ChapterInvitationError('unconfirmed');
      }
      const payload: unknown = await response.json().catch(() => ({})); // swallow-ok: an unreadable body is no confirmation; it reads as unconfirmed or by its status below
      const reply: Record<string, unknown> = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      if (!response.ok) {
        const code = typeof reply.error === 'string' ? reply.error : '';
        // The email may already be out; a resend would replace its link.
        if (code === 'delivery-status-unavailable') throw new ChapterInvitationError('unconfirmed');
        if (response.status === 401) throw new ChapterInvitationError('session-expired');
        throw new ChapterInvitationError(KNOWN.has(code) ? code as InvitationErrorCode : 'service-unavailable');
      }
      if (reply.accepted !== true) throw new ChapterInvitationError('unconfirmed');
    })());
  } catch (error) {
    throw error instanceof ChapterInvitationError ? error : new ChapterInvitationError('unconfirmed');
  } finally {
    controller.abort();
  }
}

/**
 * A plain invitation with no starting access, as the website's desk sends it
 * when no role is chosen. The route answers "accepted" and sends nothing when
 * the address already has a pending invitation, so sending the same
 * invitation again after an unconfirmed answer cannot send it twice.
 */
export function sendChapterInvitation(session: InvitationSession | null, fields: { fullName: string; email: string; chapterId: string; locale: 'en' | 'es' }): Promise<void> {
  return mutate(session, {
    action: 'create',
    email: fields.email.trim(),
    fullName: fields.fullName.trim(),
    chapterId: fields.chapterId,
    initialRole: null,
    locale: fields.locale === 'es' ? 'es' : 'en',
  });
}

export function resendChapterInvitation(session: InvitationSession | null, invitationId: string): Promise<void> {
  return mutate(session, { action: 'resend', invitationId });
}

export function revokeChapterInvitation(session: InvitationSession | null, invitationId: string): Promise<void> {
  return mutate(session, { action: 'revoke', invitationId });
}
