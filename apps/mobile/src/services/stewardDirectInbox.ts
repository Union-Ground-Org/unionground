import type { MemberConversation } from '../models/member';
import { initialsForName } from '../models/member';

// The native Direct inbox has two audiences. A member sees only conversations
// they own. A worn steward hat sees the member conversations the server
// already permits that steward to read. The client never unions those sets:
// a hat, role, chapter or account change replaces the previous rows.

export type NativeDirectAudience = 'member' | 'steward';

let audience: NativeDirectAudience = 'member';

export function setNativeDirectAudience(next: NativeDirectAudience): void {
  audience = next === 'steward' ? 'steward' : 'member';
}

export function currentNativeDirectAudience(): NativeDirectAudience {
  return audience;
}

// Preview and SAMPLE hats are explicit. A live account with several staff
// roles stays on the member inbox until that person picks Steward. A sole
// steward assignment is the one unambiguous live staff identity.
export function nativeDirectAudience(input: {
  previewHat?: string | null;
  sampleHat?: string | null;
  chosenStaffRole?: string | null;
  authorizedRoles?: readonly string[] | null;
}): NativeDirectAudience {
  if (input.previewHat) return input.previewHat === 'steward' ? 'steward' : 'member';
  if (input.sampleHat) return input.sampleHat === 'steward' ? 'steward' : 'member';
  if (input.chosenStaffRole) return input.chosenStaffRole === 'steward' ? 'steward' : 'member';
  const roles = input.authorizedRoles ?? [];
  return roles.length === 1 && roles[0] === 'steward' ? 'steward' : 'member';
}

export type StewardDirectRow = {
  id?: unknown;
  user_id?: unknown;
  updated_at?: unknown;
  member_name?: unknown;
  member_initials?: unknown;
  last_body?: unknown;
  last_sender_kind?: unknown;
};

// Retain the conversation owner so a Steward's own thread can keep its
// ordinary inbox placement. The Steward projection has no counterpart role.
export function mapStewardDirectConversation(row: StewardDirectRow): MemberConversation | null {
  if (typeof row.id !== 'string' || !row.id || typeof row.updated_at !== 'string' || !row.updated_at) return null;
  const name = typeof row.member_name === 'string' ? row.member_name.trim() : '';
  const title = name || 'Worker';
  const provided = typeof row.member_initials === 'string' ? row.member_initials.trim() : '';
  const latest = typeof row.last_body === 'string' && row.last_body.trim() ? row.last_body : null;
  return {
    id: row.id,
    ...(typeof row.user_id === 'string' && row.user_id ? { ownerUserId: row.user_id } : {}),
    title,
    initials: provided || initialsForName(title) || 'M',
    createdAt: row.updated_at,
    updatedAt: row.updated_at,
    unreadCount: row.last_sender_kind === 'member' ? 1 : 0,
    latestMessage: latest,
  };
}

export function projectStewardDirectInbox(data: unknown): MemberConversation[] {
  if (!Array.isArray(data)) return [];
  const rows: MemberConversation[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const mapped = mapStewardDirectConversation(entry as StewardDirectRow);
    if (mapped) rows.push(mapped);
  }
  return rows;
}

// The server orders Steward Direct by (updated_at, id) descending and pages
// strictly after a cursor of the last row it served. A full page means the
// server may hold more rows; a short page is the end of the list.
export const STEWARD_DIRECT_PAGE = 100;

export type StewardDirectCursor = { updatedAt: string; id: string };

export type StewardDirectPage = {
  rows: MemberConversation[];
  next: StewardDirectCursor | null;
  total: number | null;
  /** The server refused the steward role (42501): no row may stay on screen. */
  refused?: boolean;
};

export function stewardDirectCursor(row: Pick<MemberConversation, 'id' | 'updatedAt'> | undefined): StewardDirectCursor | null {
  return row ? { updatedAt: row.updatedAt, id: row.id } : null;
}

export function projectStewardDirectPage(data: unknown, pageSize: number): StewardDirectPage {
  const rows = projectStewardDirectInbox(data);
  const served = Array.isArray(data) ? data.length : 0;
  const first = Array.isArray(data) ? data[0] as { total_count?: unknown } | undefined : undefined;
  const total = typeof first?.total_count === 'number' ? first.total_count
    : typeof first?.total_count === 'string' && /^\d+$/.test(first.total_count) ? Number(first.total_count)
      : null;
  return { rows, next: served >= pageSize ? stewardDirectCursor(rows[rows.length - 1]) : null, total };
}

// Loaded pages are kept in server order after the rows that lead the list.
// The leading rows are the freshest read (the dashboard's first page), so
// their copy of a conversation wins and a conversation never appears twice.
export function mergeStewardDirectRows(leading: readonly MemberConversation[], ...pages: readonly (readonly MemberConversation[])[]): MemberConversation[] {
  const seen = new Set<string>();
  const merged: MemberConversation[] = [];
  for (const rows of [leading, ...pages]) {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  return merged;
}

// Every 42501 on a Steward Direct read advances the refusal epoch. A read
// that began before the newest refusal (a summary poll or a dashboard load
// already in flight) carries the old epoch, and its rows are dropped instead
// of showing the refused steward's conversations again.
let refusalEpoch = 0;

export function stewardDirectRefusalEpoch(): number {
  return refusalEpoch;
}

export function noteStewardDirectRefusal(): void {
  refusalEpoch += 1;
}

// The first page is the server's newest rows, in (updated_at, id) order, and
// a row only ever moves up the list (a newer update). So a cached row that
// sorts above the first page's last row and is missing from it is no longer
// listed for this steward, and is dropped. A short first page is the whole
// list: nothing outside it is kept. Rows below the last one (older pages) stay.
export function pruneStewardDirectRows<T extends Pick<MemberConversation, 'id' | 'updatedAt'>>(
  rows: readonly T[],
  firstPage: readonly Pick<MemberConversation, 'id' | 'updatedAt'>[],
  pageSize = STEWARD_DIRECT_PAGE,
): readonly T[] {
  const listed = new Set(firstPage.map((row) => row.id));
  const last = firstPage[firstPage.length - 1];
  const kept = rows.filter((row) => {
    if (listed.has(row.id)) return true;
    if (firstPage.length < pageSize || !last) return false;
    return row.updatedAt < last.updatedAt || (row.updatedAt === last.updatedAt && row.id < last.id);
  });
  return kept.length === rows.length ? rows : kept;
}

// A revoked steward role is an empty staff inbox. Any other failure stays a
// failure so a network error cannot look like "no one is waiting".
export function isStewardRoleRefusal(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '42501');
}

// `previous` is accepted so a caller cannot concatenate by accident. The
// returned list is only the next page of rows.
export function replaceDirectRows<T>(previous: readonly T[], next: readonly T[]): T[] {
  void previous;
  return [...next];
}
