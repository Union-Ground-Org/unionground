import { createSensitiveServiceClient } from "./_lib/sensitiveSupabase.js";
import { scanSensitivePatterns } from "./_lib/sensitivePatterns.js";
import { createClient } from "@supabase/supabase-js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, methodGuard, validateMutationOrigin } from "./_lib/http.js";
import { sensitiveKeyring } from "./_lib/sensitiveDataCrypto.js";
import {
  protectArguments, revealRow, revealRowOrError, hydrateAccommodations, trustedSensitiveWrite, SENSITIVE_OPERATIONS,
  SEALED_FORM_TEMPLATES, filledFormKeys, revealFormAnswers, sameFormAnswers, sealFormAnswers,
} from "./_lib/sensitiveContent.js";
import { isConflictRefusalCode } from "../src/lib/memberApiError.js";

const FORM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The most sealed forms one member data export opens (#5767); past it every
// sealed form is reported unavailable rather than a silently partial export.
export const EXPORT_SEALED_FORM_LIMIT = 1000;

// #7667: a sealed form names the unit it is for (null for chapter settings)
// with the caller's own actor, chapter and organization; the database checks
// them again against live membership. Returns null when no unit is named and
// false when the arguments are malformed.
function sealedFormUnit(args, organizationId) {
  if (!Object.hasOwn(args, "unitId")) return null;
  if ((args.unitId !== null && !FORM_ID.test(String(args.unitId))) || !FORM_ID.test(String(args.actorId))
    || !FORM_ID.test(String(args.organizationId)) || args.organizationId !== organizationId
    || typeof args.chapterId !== "string" || args.chapterId.length > 200) return false;
  return { p_unit: args.unitId, p_actor: args.actorId, p_chapter: args.chapterId, p_organization: args.organizationId };
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "not-authorized" });
  const backend = resolveSupabaseBackend(request);
  const { operation, args = {} } = request.body || {};
  if (typeof operation !== "string" || (!Object.hasOwn(SENSITIVE_OPERATIONS, operation)
    && !["get_member_support_workspace", "list_retaliation", "list_patterns", "casework_scan_retaliation_patterns",
      "prepare_sealed_form", "save_sealed_form_draft", "get_sealed_forms", "get_my_sealed_form_answers"].includes(operation))) return json(response, 400, { error: "invalid-operation" });
  try {
    const ring = sensitiveKeyring(backend.surface);
    // Every query and RPC carries the caller JWT, including writes. No service
    // role authorization bypass or caller-supplied organization is used.
    const client = createClient(backend.url, backend.publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const scope = await client.rpc("sensitive_data_organization");
    if (scope.error || !scope.data) return json(response, 403, { error: "not-authorized" });
    if (ring.revoked.has(scope.data)) throw new Error("sensitive-data-revoked");
    let data;
    if (operation === "get_member_support_workspace") {
      const snapshot = await client.rpc(operation);
      if (snapshot.error) throw new Error("sensitive-data-read-unavailable");
      data = await hydrateAccommodations(client, snapshot.data, scope.data, ring);
    } else if (operation === "casework_scan_retaliation_patterns") {
      if (typeof args.p_chapter_id !== "string" || args.p_chapter_id.length > 200) return json(response, 400, { error: "invalid-input" });
      const service = createSensitiveServiceClient(backend.url, backend.serviceRoleKey);
      data = await scanSensitivePatterns(client, service, args.p_chapter_id, scope.data, ring);
    } else if (operation === "list_patterns") {
      const rows = await client.from("casework_retaliation_patterns")
        .select("*,casework_retaliation_pattern_reports(report_id),casework_retaliation_pattern_notes(id,body,created_at)")
        .eq("organization_id", scope.data).eq("chapter_id", args.chapterId).order("detected_at", { ascending: false }).limit(100);
      if (rows.error) throw new Error("sensitive-data-read-unavailable");
      data = rows.data.map((row) => revealRowOrError("casework_retaliation_patterns", row, ring));
    } else if (operation === "list_retaliation") {
      if (!/^[0-9a-f-]{36}$/.test(args.caseId || "")) return json(response, 400, { error: "invalid-input" });
      const cursor = args.cursor;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      // Preserve Postgres timestamp precision; do not round a cursor to JS milliseconds.
      if (cursor != null && (typeof cursor !== "object" || !uuid.test(cursor.id || "")
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.createdAt || ""))) return json(response, 400, { error: "invalid-input" });
      let query = client.from("casework_retaliation_reports").select("*").eq("organization_id", scope.data)
        .eq("case_id", args.caseId).order("created_at", { ascending: false }).order("id", { ascending: false });
      if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
      const rows = await query.limit(201);
      if (rows.error) throw new Error("sensitive-data-read-unavailable");
      const page = rows.data.slice(0, 200), last = page.at(-1);
      data = { reports: page.map((row) => revealRowOrError("casework_retaliation_reports", row, ring)),
        nextCursor: rows.data.length > 200 ? { createdAt: last.created_at, id: last.id } : null };
    } else if (operation === "prepare_sealed_form") {
      // The draft's identity before any answers are sent (#6363 round 2): the
      // editor binds its save lane to this id, so a lost save reply can never
      // leave the lane without one. At most an empty draft is created; no
      // envelope or answers are returned.
      if (!SEALED_FORM_TEMPLATES.has(args.templateKey)) return json(response, 400, { error: "invalid-input" });
      const unit = sealedFormUnit(args, scope.data);
      if (unit === false) return json(response, 400, { error: "invalid-input" });
      const draft = await (unit ? client.rpc("prepare_unit_sealed_form", { p_template_key: args.templateKey, ...unit })
        : client.rpc("prepare_sealed_form", { p_template_key: args.templateKey }));
      const form = draft.data;
      if (draft.error || !FORM_ID.test(form?.formId || "") || form.organizationId !== scope.data) throw new Error("sensitive-data-write-refused");
      data = { formId: form.formId };
    } else if (operation === "save_sealed_form_draft") {
      // FMLA answers (#5747): the caller's open draft is found or created
      // first, so its envelope binds to the form id; an unchanged draft keeps
      // its envelope and signatures.
      const step = args.step ?? 0;
      if (!SEALED_FORM_TEMPLATES.has(args.templateKey) || !Number.isInteger(step)) return json(response, 400, { error: "invalid-input" });
      // The caller names the data version its answers were built from (null
      // before the first envelope). save_sealed_form_draft compares exactly
      // that under the form lock, so a retry dispatched before newer answers
      // were saved elsewhere is refused instead of writing over them; a fresh
      // prepare read would only ever see the newer version (#6233).
      const expected = args.expectedDataVersion;
      if (!Object.hasOwn(args, "expectedDataVersion") || (expected !== null && !FORM_ID.test(String(expected)))) {
        return json(response, 400, { error: "invalid-input" });
      }
      if (Object.hasOwn(args, "formId") && !FORM_ID.test(String(args.formId))) return json(response, 400, { error: "invalid-input" });
      const filled = filledFormKeys(args.answers);
      const unit = sealedFormUnit(args, scope.data);
      if (unit === false) return json(response, 400, { error: "invalid-input" });
      const draft = await (unit ? client.rpc("prepare_unit_sealed_form", { p_template_key: args.templateKey, ...unit })
        : client.rpc("prepare_sealed_form", { p_template_key: args.templateKey }));
      const form = draft.data;
      if (draft.error || !FORM_ID.test(form?.formId || "") || form.organizationId !== scope.data) throw new Error("sensitive-data-write-refused");
      // A save prepared against one draft never lands in another: if that
      // draft was submitted in between, prepare now names a new one (#6363 r3s2).
      if (Object.hasOwn(args, "formId") && args.formId !== form.formId) return json(response, 409, { error: "sensitive-data-conflict" });
      const row = { id: form.formId, organization_id: form.organizationId, template_key: args.templateKey };
      let changed = Object.keys(args.answers).length > 0;
      // A stored envelope that cannot be opened is never overwritten: the
      // save is refused and the draft keeps its sealed answers (#5827 r1g3).
      if (form.envelope) {
        const previous = revealFormAnswers({ ...row, answers: { sealed: true }, encrypted_content: { answers: form.envelope } }, ring);
        changed = !sameFormAnswers(previous, args.answers);
      }
      const envelope = changed ? sealFormAnswers(args.answers, row, ring) : null;
      const service = createSensitiveServiceClient(backend.url, backend.serviceRoleKey);
      const result = await trustedSensitiveWrite(client, service, {
        p_operation: operation,
        p_arguments: { p_form_id: form.formId, p_step: step, p_changed: changed, p_filled: filled, p_data_version: envelope?.dataVersion ?? null,
          p_expected_data_version: expected },
        p_envelopes: envelope ? { answers: envelope } : {},
      });
      if (isConflictRefusalCode(result.error?.code)) return json(response, 409, { error: "sensitive-data-conflict" });
      if (result.error) return json(response, 403, { error: "sensitive-data-write-refused" });
      data = { formId: form.formId, dataVersion: envelope ? envelope.dataVersion : expected };
    } else if (operation === "get_sealed_forms") {
      // Row visibility is the caller's own RLS (owner, steward scope); this
      // route only opens what the caller can already select.
      const ids = args.formIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => !FORM_ID.test(id))) return json(response, 400, { error: "invalid-input" });
      const rows = await client.from("member_forms").select("id,template_key,organization_id,answers,encrypted_content")
        .eq("organization_id", scope.data).in("id", ids);
      if (rows.error) throw new Error("sensitive-data-read-unavailable");
      // Answers and their envelope's dataVersion come from the same row
      // read: the version is what the locked save compares, so an editor
      // opening these answers names it as its baseline (#6281).
      data = rows.data.map((row) => {
        try {
          const answers = revealFormAnswers(row, ring);
          const dataVersion = row.encrypted_content?.answers?.dataVersion;
          return { id: row.id, answers, dataVersion: typeof dataVersion === "string" ? dataVersion : null };
        } catch { return { id: row.id, answers: {}, contentError: "sensitive-content-unavailable" }; }
      });
    } else if (operation === "get_my_sealed_form_answers") {
      // REQ-UG-MEMBER-EXPORT-SEALED-FMLA-ANSWERS-20261022 (#5767): the
      // member's own data export opens only the caller's own sealed forms, in
      // the organization scope get_sealed_forms uses. A steward's wider RLS
      // never widens it: the row filter names the verified caller. Answers
      // leave only in this response, with the envelope's dataVersion so the
      // export can tell a form saved after its SQL snapshot; nothing is stored
      // or logged.
      const user = await client.auth.getUser(token);
      const userId = user.data?.user?.id;
      if (user.error || !FORM_ID.test(userId || "")) return json(response, 401, { error: "not-authorized" });
      const rows = await client.from("member_forms").select("id,user_id,template_key,organization_id,answers,encrypted_content")
        .eq("organization_id", scope.data).eq("user_id", userId).in("template_key", [...SEALED_FORM_TEMPLATES])
        .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(EXPORT_SEALED_FORM_LIMIT + 1);
      if (rows.error || rows.data.length > EXPORT_SEALED_FORM_LIMIT) throw new Error("sensitive-data-read-unavailable");
      data = rows.data.filter((row) => row.user_id === userId && row.organization_id === scope.data).map((row) => {
        try {
          const answers = revealFormAnswers(row, ring);
          const dataVersion = row.encrypted_content?.answers?.dataVersion;
          return { id: row.id, answers, dataVersion: typeof dataVersion === "string" ? dataVersion : null };
        } catch { return { id: row.id, answers: {}, contentError: "sensitive-content-unavailable" }; }
      });
    } else {
      const prepared = protectArguments(operation, args, scope.data, ring);
      const service = createSensitiveServiceClient(backend.url, backend.serviceRoleKey);
      const result = await trustedSensitiveWrite(client, service, prepared);
      if (result.error) return json(response, 403, { error: "sensitive-data-write-refused" });
      data = SENSITIVE_OPERATIONS[operation].table === "casework_retaliation_reports"
        ? revealRow("casework_retaliation_reports", result.data, ring) : result.data;
    }
    return json(response, 200, { data });
  } catch (error) {
    // Fixed codes only; no raw exceptions, keyring, content or envelopes in logs.
    const invalid = error?.message === "sensitive-data-invalid-input";
    return json(response, invalid ? 400 : 503, { error: invalid ? "invalid-input" : "sensitive-data-key-or-backfill-unavailable" });
  }
}
