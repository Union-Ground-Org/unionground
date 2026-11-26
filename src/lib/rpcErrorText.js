import { isRequestTimeoutError } from "./outbox.js";

// UB-EVT-05, finding 3: server refusals used to reach members as raw English.
//
// Until now the only translation shim in the app was the voting one in App.jsx,
// which regex-matches the English sentence the database happened to raise. That
// breaks the moment anyone rewords the SQL, and it cannot work at all for a
// Spanish member reading a Spanish screen.
//
// The database now stamps a stable machine token in the exception DETAIL field
// (PostgREST hands it to supabase-js as `details`). This maps that token onto a
// catalogue string. The English `error.message` stays as the fallback, so a
// path that loses the detail field degrades to today's behaviour rather than to
// nothing.
//
// The allowlist is deliberate and not a lookup on an arbitrary string: t() falls
// back to the raw key when a key is missing, so an unrecognised token would
// otherwise render the literal "rpcError.something" to a member.
const TRANSLATED_TOKENS = new Set([
  "scan_not_steward",
  "scan_code_missing",
  "scan_code_invalid",
  "scan_code_used",
  "scan_code_expired",
  "scan_code_self",
  "scan_event_cancelled",
  "event_cancelled",
  "event_has_attendance",
  // Event check-in refusals. One token for both windows (a door code or a
  // personal code outside 2 hours before to 4 hours after the start), and one
  // for a wrong or locked-out code, which the owner ruled indistinguishable.
  "checkin_not_open",
  "checkin_code_invalid",
  // An event saved with no check-in code (a deadline or reminder) refuses
  // every check-in path.
  "checkin_not_offered",
  // An event whose staff switched RSVP collection off refuses a new "going".
  "rsvp_closed",
  // An event edit saved from a form opened before someone else's change (an
  // undo included) is refused rather than overwriting it.
  "event_changed",
  // submit_workload_log refuses a fourth log on the same Eastern day.
  "workload_daily_limit",
  // BUG-UG-STAFF-MESSAGES-TO-CHAPTER-STEWARD-UNDELIVERED-20261003: a
  // Chapter steward message nobody could read was refused, not sent.
  "no_steward_assigned",
  // REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030:
  // start_officer_conversation refusals.
  "officer_unavailable",
  "officer_contact_limit",
  // REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109:
  // send_cross_chapter_peer_message refusals.
  "cross_chapter_peer_unavailable",
  "cross_chapter_recipients",
  "cross_chapter_contact_limit",
  // Private-upload inspection outcomes. The client stamps these itself rather
  // than reading them off a database DETAIL, because the refusal is decided by
  // the inspection endpoint; the token shape is shared so one translation
  // table serves both origins.
  "private_file_rejected",
  "private_file_pending_check",
  "private_file_rate_limited",
  "private_file_stale",
  "private_file_unavailable",
  "private_file_unsupported_format",
  "casework_grant_reason_invalid",
  "casework_grantee_cannot_use_grant",
  "casework_grantee_outside_case_organization",
  "casework_restriction_self_lockout",
  // sign_member_form: another session saved the form after the signer
  // reviewed it, so nothing was signed (r3s2).
  "form_changed_since_review",
  // save_form_draft: the form this editor saves was submitted or closed
  // elsewhere, so the change was not saved and no second draft was made (#8702).
  "form_not_editable",
  // respond_to_cosign: the filer changed the grievance after the co-signer's
  // preview, so nothing was co-signed (#8703).
  "cosign_changed_since_preview",
  // save_form_draft: another session saved the draft after the answers this
  // save was based on, so nothing was written (#8719).
  "form_saved_elsewhere",
]);

// BUG-UG-PAGES-FAIL-HARD-ON-MISSING-OR-SLOW-FUNCTION-20261003. A
// statement timeout (57014), a lock wait (55P03) or a function that is not
// deployed yet (PGRST202 at the API, 42883 inside a body that calls a missing
// helper; PGRST002, the schema cache reloading) means the service is busy.
// During the October 3 apply window members read "Mark notifications read:
// canceling statement due to statement timeout"; they get one plain sentence
// instead. It never claims nothing changed: a multi-step flow (an upload's
// confirmation, say) can time out after earlier steps already landed.
const SERVICE_BUSY_CODES = new Set(["57014", "55P03", "PGRST202", "42883", "PGRST002"]);

export function isServiceBusyError(error) {
  return SERVICE_BUSY_CODES.has(String(error?.code ?? ""));
}

// `t` is the 2-arg component-level translator from LanguageContext.
// `fallbackKey` is used only when the error carries no message at all.
export function rpcErrorText(t, error, fallbackKey) {
  const token = typeof error?.details === "string" ? error.details.trim() : "";
  if (TRANSLATED_TOKENS.has(token)) return t(`rpcError.${token}`);
  if (isRequestTimeoutError(error)) return t("error.requestTimedOut");
  if (isServiceBusyError(error)) return t("error.serviceBusy");
  return error?.message || (fallbackKey ? t(fallbackKey) : "");
}

// SQLSTATE families a desk can explain without quoting the server. PostgREST
// hands the class through as `code`, and supabase-js carries it onto
// MemberApiError, so this is the one machine-readable fact a refusal always
// has even when nobody thought to stamp a DETAIL token.
//
// Only families a reader can act on earn a sentence. A code with no copy is
// not better served by an invented one, so everything else takes the caller's
// fallback: "that did not finish" is honest, and guessing is not.
const REFUSAL_CODE_KEYS = Object.freeze({
  23514: "rpcError.checkViolation", // CHECK constraint or a raised validation
  42501: "rpcError.notPermitted", // insufficient privilege, i.e. a policy
  40001: "rpcError.conflict", // serialization failure: somebody was first
  PT409: "rpcError.conflict", // the same refusal since 20261106220000 (HTTP 409, never retried)
});

// The key-returning sibling of rpcErrorText, for a surface that has catalogue
// copy for every outcome it can reach.
//
// rpcErrorText falls back to `error.message`, which is right for the older
// toast paths: without it they would go silent. A surface that can name every
// failure wants the opposite contract, so this returns a KEY and `error.message`
// is never one of the answers — the driver sentence cannot reach the DOM
// through here at all, in any locale.
export function rpcRefusalKey(error, fallbackKey) {
  const token = typeof error?.details === "string" ? error.details.trim() : "";
  if (TRANSLATED_TOKENS.has(token)) return `rpcError.${token}`;
  if (isRequestTimeoutError(error)) return "error.requestTimedOut";
  if (isServiceBusyError(error)) return "error.serviceBusy";
  const code = error?.code == null ? "" : String(error.code);
  // SQLSTATE 42501 also covers an unfinished sign-in. MemberApiError may
  // prefix the server's exact message with the action label.
  if (code === "42501" && typeof error.message === "string"
    && /^(?:[^:\r\n]+: )?authentication required$/.test(error.message)) return "rpcError.authenticationRequired";
  // Own-property only: a server that answered with a code of "constructor" or
  // "__proto__" must reach the fallback, not an inherited member of Object.
  return Object.hasOwn(REFUSAL_CODE_KEYS, code) ? REFUSAL_CODE_KEYS[code] : fallbackKey;
}

// BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920. Some notice
// surfaces must never show `error.message` at all: a refused write arrives
// from PostgREST as raw English policy/constraint text ("new row violates
// row-level security policy for table ..."), which is both untranslated and
// an internal schema leak. Same token and timeout mapping as rpcErrorText,
// but the fallback is caller-supplied translated catalogue copy, never the
// raw message.
export function rpcErrorTextStrict(t, error, fallbackText) {
  const key = rpcErrorKeyStrict(error, null);
  return key ? t(key) : fallbackText ?? "";
}

// Store a key without changing the strict surface's existing fallback mapping.
export function rpcErrorKeyStrict(error, fallbackKey) {
  const token = typeof error?.details === "string" ? error.details.trim() : "";
  if (TRANSLATED_TOKENS.has(token)) return `rpcError.${token}`;
  if (isRequestTimeoutError(error)) return "error.requestTimedOut";
  if (isServiceBusyError(error)) return "error.serviceBusy";
  return fallbackKey ?? "";
}

// Existing state may also carry literal notices or conditional placeholders.
// Unknown catalogue keys retain their literal text; non-text values preserve
// their existing React rendering behavior.
export function rpcErrorTextAtRender(t, value) {
  return typeof value === "string" && /^[\w-]+(?:\.[\w-]+)+$/.test(value) ? t(value) : value;
}

export const TRANSLATED_RPC_TOKENS = TRANSLATED_TOKENS;
