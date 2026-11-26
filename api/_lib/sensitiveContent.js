import { decryptSensitive, encryptSensitive } from "./sensitiveDataCrypto.js";

export const SENSITIVE_FIELDS = {
  casework_retaliation_patterns: { subject_label: [2, 200] },
  member_accommodation_requests: { description: [1, 4000], staff_note: [0, 2000] },
  casework_retaliation_reports: { management_person: [2, 200], protected_activity: [8, 4000], adverse_action: [8, 4000], requested_support: [0, 2000], withdrawal_reason: [0, 1000] },
};
export const SENSITIVE_OPERATIONS = {
  create_member_accommodation_request: { table: "member_accommodation_requests", id: "p_idempotency_key", fields: { p_description: "description" } },
  transition_member_accommodation_request: { table: "member_accommodation_requests", id: "p_request_id", fields: { p_staff_note: "staff_note" } },
  casework_submit_retaliation_report: { table: "casework_retaliation_reports", id: "p_idempotency_key", fields: { p_management_person: "management_person", p_protected_activity: "protected_activity", p_adverse_action: "adverse_action", p_requested_support: "requested_support" } },
  casework_withdraw_retaliation_report: { table: "casework_retaliation_reports", id: "p_report_id", fields: { p_reason: "withdrawal_reason" } },
};
export function protectArguments(operation, args, organization, ring) {
  const spec = SENSITIVE_OPERATIONS[operation];
  if (!spec || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("sensitive-data-invalid-input");
  const safe = { ...args };
  const envelopes = {};
  for (const [argument, field] of Object.entries(spec.fields)) {
    const value = args[argument];
    const [min, max] = SENSITIVE_FIELDS[spec.table][field];
    if (value == null && min === 0) continue;
    if (typeof value !== "string" || value.trim().length < min || value.trim().length > max
      || [...value].some((c) => (c.charCodeAt(0) < 32 && !"\n\r\t".includes(c)) || c.charCodeAt(0) === 127)) throw new Error("sensitive-data-invalid-input");
    if (!value.trim()) continue;
    envelopes[field] = encryptSensitive(Buffer.from(value.trim()), {
      organization, record: args[spec.id], field, purpose: spec.table,
    }, ring);
    safe[argument] = "[encrypted]";
  }
  return { p_operation: operation, p_arguments: safe, p_envelopes: envelopes };
}
export function revealRow(table, row, ring) {
  const fields = SENSITIVE_FIELDS[table];
  if (!fields || !row?.id || !row?.organization_id) throw new Error("sensitive-data-row-unavailable");
  const result = { ...row };
  for (const field of Object.keys(fields)) {
    const envelope = row.encrypted_content?.[field];
    if (envelope) {
      const bytes = decryptSensitive(envelope, { organization: row.organization_id, record: row.id, field, purpose: table }, ring);
      try { result[field] = bytes.toString("utf8"); } finally { bytes.fill(0); }
    } else if (row[field]) {
      // Explicit backfill required. Never silently return legacy plaintext.
      throw new Error("sensitive-data-backfill-required");
    }
  }
  delete result.encrypted_content;
  return result;
}

// Errors are local to a record; never return legacy text or ciphertext metadata.
export function revealRowOrError(table, row, ring) {
  try { return revealRow(table, row, ring); }
  catch {
    const safe = { ...row, contentError: "sensitive-content-unavailable" };
    delete safe.encrypted_content;
    for (const field of Object.keys(SENSITIVE_FIELDS[table])) safe[field] = "";
    return safe;
  }
}
export async function hydrateAccommodations(client, snapshot, organization, ring) {
  const items = snapshot.accommodations || [];
  const byId = new Map();
  // The snapshot supplies the exact authorized IDs. Read those IDs in bounded
  // pages, so the PostgREST row cap cannot silently truncate hydration.
  for (let offset = 0; offset < items.length; offset += 200) {
    const ids = items.slice(offset, offset + 200).map((item) => item.id);
    const rows = await client.from("member_accommodation_requests").select("*")
      .eq("organization_id", organization).in("id", ids);
    if (!rows.error) for (const row of rows.data || []) byId.set(row.id, row);
  }
  return { ...snapshot, accommodations: items.map((item) => {
    const row = revealRowOrError("member_accommodation_requests", byId.get(item.id), ring);
    return { ...item, description: row.contentError ? "Content unavailable" : row.description,
      staffNote: row.staff_note, ...(row.contentError ? { contentError: row.contentError } : {}) };
  }) };
}
export async function trustedSensitiveWrite(client, service, prepared) {
  // getUser verifies the token with Auth; never decode a caller claim locally.
  const identity = await client.auth.getUser();
  if (identity.error || !identity.data?.user?.id) throw new Error("sensitive-data-write-refused");
  const ticket = await service.rpc("stage_sensitive_write", { p_actor: identity.data.user.id, ...prepared });
  if (ticket.error || typeof ticket.data !== "string") throw new Error("sensitive-data-write-refused");
  return client.rpc("write_sensitive_content", { ...prepared, p_ticket: ticket.data });
}

// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022: the FMLA
// templates' answers are one envelope per form (owner default D1). Must match
// private.form_template_is_sealed in supabase/migrations.
export const SEALED_FORM_TEMPLATES = new Set(["fmla_self", "fmla_family"]);
const FORM_KEY = /^[A-Za-z0-9_]{1,80}$/;
// The template contract allows 1-12 steps of 1-30 fields (upsert_form_template
// in 20260723110000), so a form can hold up to 360 answers; the SQL marker
// guard in the sealed form migration uses the same bound (#6320).
export const MAX_FORM_ANSWER_KEYS = 12 * 30;
const formContext = (row) => ({ organization: row.organization_id, record: row.id, field: "answers", purpose: "member_forms" });

function plainAnswers(answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("sensitive-data-invalid-input");
  const keys = Object.keys(answers);
  if (keys.length > MAX_FORM_ANSWER_KEYS || keys.some((key) => !FORM_KEY.test(key)) || JSON.stringify(answers).length > 20000) {
    throw new Error("sensitive-data-invalid-input");
  }
  return answers;
}

// The keys submit_form counts as answered, by the same rule as its SQL check.
export function filledFormKeys(answers) {
  return Object.keys(plainAnswers(answers)).filter((key) => {
    const value = answers[key];
    return Array.isArray(value) ? value.length > 0 : String(value ?? "").trim() !== "";
  });
}

// Key order is not content: an autosave that only reorders keys keeps the envelope.
export function sameFormAnswers(left, right) {
  const stable = (value) => (value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : Array.isArray(value) ? value.map(stable) : value);
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function sealFormAnswers(answers, row, ring) {
  return encryptSensitive(Buffer.from(JSON.stringify(plainAnswers(answers))), formContext(row), ring);
}

// Never returns legacy plaintext: an unsealed FMLA row with real answers needs
// the maintenance backfill first. Empty and seed-only rows have no answers.
export function revealFormAnswers(row, ring) {
  if (!row?.id || !SEALED_FORM_TEMPLATES.has(row.template_key)) throw new Error("sensitive-data-row-unavailable");
  if (row.answers?.sealed !== true) {
    if (Object.keys(row.answers || {}).every((key) => key === "seedSequence")) return {};
    throw new Error("sensitive-data-backfill-required");
  }
  const envelope = row.encrypted_content?.answers;
  if (!envelope || !row.organization_id) throw new Error("sensitive-data-backfill-required");
  const bytes = decryptSensitive(envelope, formContext(row), ring);
  try { return plainAnswers(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new Error("sensitive-data-row-unavailable"); }
  finally { bytes.fill(0); }
}
