// BUG-UG-NATIVE-CONVERSATION-REFRESH-FAILURE-HIDES-LOADED-MESSAGES-20261115
//: a polling screen keeps what it loaded
// when a background read fails or times out, but never when the server refused
// the read. A refusal is a permission error (SQLSTATE 42501), a token or session
// PostgREST would not accept (PGRST301 to PGRST303, HTTP 401 or 403), for example
// when a second factor is newly required, or a connected-workflow refusal
// (not_authorized, scope_changed, source_unavailable, source_removed). The screen
// clears what it showed, as before.
//
// The code can sit in any of the fields a wrapper moves it to: `code` (raw
// PostgREST errors and the facade's own code), `sqlState` (the facade keeps the
// raw code there, so an expired token arrives as code "unavailable" with
// sqlState "PGRST301"), a `cw:<code>` marker in `details` or `message` (server
// refusals), `status`, or the wrapped error in `cause`.
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  '42501', 'PGRST301', 'PGRST302', 'PGRST303',
  'not_authorized', 'scope_changed', 'source_unavailable', 'source_removed',
]);
const REFUSED_STATUSES: ReadonlySet<unknown> = new Set([401, 403]);
const REFRESHABLE_CODES: ReadonlySet<string> = new Set(['PGRST301', 'PGRST302', 'PGRST303']);
const SERVER_MARKER = /\bcw:([a-z_]+)/;

function refusalCode(value: unknown, authoritativeOnly: boolean): boolean {
  return typeof value === 'string' && REFUSAL_CODES.has(value) && (!authoritativeOnly || !REFRESHABLE_CODES.has(value));
}

function refusalMarker(value: unknown, authoritativeOnly: boolean): boolean {
  const match = typeof value === 'string' ? SERVER_MARKER.exec(value) : null;
  return Boolean(match && refusalCode(match[1], authoritativeOnly));
}

function readRefusal(error: unknown, authoritativeOnly: boolean, depth: number): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const { code, sqlState, status, details, message, cause } = error as {
    code?: unknown; sqlState?: unknown; status?: unknown; details?: unknown; message?: unknown; cause?: unknown;
  };
  return refusalCode(code, authoritativeOnly) || refusalCode(sqlState, authoritativeOnly)
    || (REFUSED_STATUSES.has(status) && (!authoritativeOnly || status !== 401))
    || refusalMarker(details, authoritativeOnly) || refusalMarker(message, authoritativeOnly)
    || readRefusal(cause, authoritativeOnly, depth + 1);
}

export function isReadRefusal(error: unknown, depth = 0): boolean {
  return readRefusal(error, false, depth);
}

//: an expired token conceals loaded content, but a same-person refresh
// can restore access. Only a confirmed permission/item refusal retires unsent
// work. Keep the ordinary read-concealment policy above unchanged.
export function isAuthoritativeReadRefusal(error: unknown): boolean {
  return readRefusal(error, true, 0);
}
