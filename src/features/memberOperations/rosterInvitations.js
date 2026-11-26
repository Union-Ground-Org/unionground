import { isShippedLanguage } from "../../lib/languages.js";
import { parseMemberOperationsCsv } from "./csv.js";

// Parse locally. Never pass the original row (or ignored workplace columns)
// to the API or to the old import staging tables.
export function parseRosterInvitations(source) {
  const parsed = parseMemberOperationsCsv(source);
  if (!parsed.headers.includes("email") || !parsed.headers.includes("full_name")) {
    throw new Error("headers");
  }
  const seen = new Set();
  return parsed.rows.map((row, index) => {
    const email = row.email.trim().toLowerCase();
    const fullName = row.full_name.trim();
    const locale = row.locale?.trim().toLowerCase() || "en";
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      && email.length <= 254 && fullName.length >= 2 && fullName.length <= 120
      && !/[\p{Cc}<>]/u.test(fullName) && isShippedLanguage(locale);
    const duplicate = valid && seen.has(email);
    if (valid) seen.add(email);
    return { row: index + 2, email, fullName, locale, state: !valid ? "invalid" : duplicate ? "duplicate" : "ready" };
  });
}

// Duplicate matching against the invitations the desk already holds
// (REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030): a row whose
// email has a pending invitation is already invited and is skipped in the
// preview, so the import sends nobody a second live invitation. An accepted
// invitation proves nothing about today: the account may have been deleted
// since, and the server's own account check decides those rows. Expired,
// failed and revoked invitations stay ready too: inviting again repairs them.
export function matchRosterInvitations(rows, invitations = []) {
  const pending = new Set();
  for (const invitation of Array.isArray(invitations) ? invitations : []) {
    const email = String(invitation?.normalizedEmail ?? "").trim().toLowerCase();
    if (email && invitation.status === "pending") pending.add(email);
  }
  return rows.map((row) => row.state === "ready" && pending.has(row.email)
    ? { ...row, state: "invited" }
    : row);
}
