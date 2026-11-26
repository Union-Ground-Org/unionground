// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: ballot
// nominations. A standard ballot draft's managers open a nominations period;
// eligible members nominate a person by name and another member seconds it;
// the election committee exports every nomination and turns the seconded
// nominees into the ballot's choices. Every rule is the server's
// (supabase/migrations/20261030214501_ballot_nominations_and_minutes_approval.sql).

import { MemberApiError } from "../../lib/memberApi.js";

// How many nominations one member may make per ballot. The server enforces it
// (nominate_for_ballot refuses the next one with 54000); this copy only lets
// the card say the number before it is reached (#9467 W5-4), and
// tests/limits-stated-9467.test.jsx fails if it ever differs from the
// migration's number.
export const NOMINATIONS_PER_BALLOT_MAX = 10;

function unwrap(result, operation) {
  if (result?.error) throw new MemberApiError(operation, { ...result.error, message: result.error.message || "request failed" });
  return result?.data;
}

export async function loadOpenNominations(client) {
  const data = unwrap(await client.rpc("get_open_ballot_nominations"), "Load nominations");
  return Array.isArray(data) ? data : [];
}

export async function nominateForBallot(client, ballotId, nomineeName, statement) {
  return unwrap(await client.rpc("nominate_for_ballot", {
    p_ballot_id: ballotId,
    p_nominee_name: String(nomineeName ?? "").trim(),
    p_statement: String(statement ?? "").trim() || null,
  }), "Nominate");
}

export async function secondNomination(client, nominationId) {
  return unwrap(await client.rpc("second_ballot_nomination", { p_nomination_id: nominationId }), "Second nomination");
}

export async function setNominationsPeriod(client, ballotId, closeAt) {
  return unwrap(await client.rpc("set_ballot_nominations_period", {
    p_ballot_id: ballotId,
    p_close_at: closeAt || null,
  }), "Nominations period");
}

export async function loadNominations(client, ballotId) {
  return unwrap(await client.rpc("get_ballot_nominations", { p_ballot_id: ballotId }), "Load nominations");
}

export async function exportNominations(client, ballotId) {
  return unwrap(await client.rpc("export_ballot_nominations", { p_ballot_id: ballotId }), "Export nominations");
}

// One cell per field, quoted, with formula-leading text neutralized so a
// nominee name can never run as a spreadsheet formula.
function csvCell(value) {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function nominationsCsv(exported, headers) {
  const rows = (exported?.nominations || []).map((nomination) => [
    nomination.nomineeName, nomination.statement, nomination.nominatedBy, nomination.nominatedAt,
    nomination.secondedBy, nomination.secondedAt,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// The seconded nominees, once each, in nomination order: the ballot's choices.
export function secondedNominees(exported) {
  const seen = new Set();
  return (exported?.nominations || [])
    .filter((nomination) => nomination.secondedAt)
    .map((nomination) => String(nomination.nomineeName || "").trim())
    .filter((name) => name && !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()));
}
