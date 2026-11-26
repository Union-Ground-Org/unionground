// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: the native read of the
// server's own session inventory. The server is the only authority on which
// sessions exist, so this module never caches a list, never derives one from
// local storage, and never reports an unreadable list as an empty one.
import { normalizeMemberSessionRows, type MemberSessionRow } from '../lib/memberSessionInventory';
import { getSupabaseClient } from './supabase';

export type MemberSessionsFailureKind = 'transport' | 'service' | 'denied';

/**
 * A list that could not be read, carrying why. The screen phrases the three
 * kinds apart (see `memberSessionsFailureMessage`) because only one of them is
 * worth a retry on a better network.
 */
export class MemberSessionsUnavailableError extends Error {
  readonly kind: MemberSessionsFailureKind;

  constructor(kind: MemberSessionsFailureKind, message: string) {
    super(message);
    this.name = 'MemberSessionsUnavailableError';
    this.kind = kind;
  }
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/**
 * Which side failed. `list_my_sessions` raises 42501 for the one condition a
 * member can act on — the session the JWT names is no longer in
 * `auth.sessions`, so it was revoked, expired or reset elsewhere — and that is
 * reported as `denied`, not as a service fault. Any other answer the service
 * gave (a status, a PostgREST code) is `service`; postgrest-js marks a request
 * that never arrived with `status: 0`, which stays `transport`. An
 * unrecognizable value keeps the conservative transport diagnosis so a member
 * on a bad network is never told the service refused them.
 */
export function classifyMemberSessionsFailure(error: unknown): MemberSessionsFailureKind {
  const code = readField(error, 'code');
  if (typeof code === 'string' && code.trim() === '42501') return 'denied';
  const status = numeric(readField(error, 'status'));
  if (status !== null && status >= 400) return 'service';
  if (typeof code === 'string' && code.trim().toUpperCase().startsWith('PGRST')) return 'service';
  return 'transport';
}

/**
 * The caller's own sessions, exactly as the server reports them. A payload
 * that is not an array is a service answer that did not deliver a list, which
 * is a refusal rather than "no sessions": an empty array is the only thing
 * that means empty.
 */
export async function loadMemberSessions(): Promise<MemberSessionRow[]> {
  const client = getSupabaseClient();
  if (!client) {
    throw new MemberSessionsUnavailableError('service', 'The secure mobile backend is not configured.');
  }
  const response = await client.rpc('list_my_sessions');
  if (response.error) {
    // postgrest-js keeps the HTTP status on the response, not always on the
    // error: a non-JSON 502 arrives as an error with only a message. Without
    // the response status that answered failure would read as a dropped
    // connection, so the error's own fields win and the response fills in.
    const errorStatus = readField(response.error, 'status');
    throw new MemberSessionsUnavailableError(
      classifyMemberSessionsFailure({
        code: readField(response.error, 'code'),
        status: errorStatus ?? readField(response, 'status'),
      }),
      'Your sessions could not be read.',
    );
  }
  const payload: unknown = response.data;
  const rows = normalizeMemberSessionRows(payload);
  if (rows === null) {
    throw new MemberSessionsUnavailableError('service', 'The session list the service returned could not be read.');
  }
  return rows;
}
