// One budget shared by the browser and server route. Every sequential stage
// counts at its own ceiling: the caller lookup and the password grant (eight
// seconds, as in sign-in), the authorize, claim, mark, finalize and
// terminal-audit RPCs (eight seconds each), the irreversible GoTrue delete,
// and the throttle and logout calls of a password re-entry. The browser waits
// beyond that composite deadline but inside the function ceiling pinned for
// api/account-lifecycle.js in vercel.json.
export const ACCOUNT_DELETION_RPC_TIMEOUT_MS = 8_000;
export const ACCOUNT_DELETION_DELETE_TIMEOUT_MS = 20_000;
// A member with no second factor re-enters their password in the dialog: the
// route charges the sign-in throttle and ends the one-use session on this
// shorter boundary.
export const ACCOUNT_DELETION_REAUTH_TIMEOUT_MS = 3_000;
export const ACCOUNT_DELETION_SERVER_TIMEOUT_MS = (
  (7 * ACCOUNT_DELETION_RPC_TIMEOUT_MS) + ACCOUNT_DELETION_DELETE_TIMEOUT_MS
  + (2 * ACCOUNT_DELETION_REAUTH_TIMEOUT_MS)
);
export const ACCOUNT_DELETION_CLIENT_TIMEOUT_MS = 90_000;
