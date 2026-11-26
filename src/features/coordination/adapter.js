import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { captureSanitizedDiagnostic } from "../../lib/deferredObservability.js";
import {
  COORDINATION_EXPORT_FORMATS,
  COORDINATION_RPCS,
  EMPTY_COORDINATION_EXTENSIONS,
  EMPTY_COORDINATION_SNAPSHOT,
} from "./contract.js";
import {
  canManageCoordination,
  canPerformCoordinationIntent,
  canReadCoordination,
  coordinationScopeIsAuthoritative,
  normalizeCoordinationActor,
  normalizeCoordinationExtensions,
  normalizeCoordinationMessagePage,
  normalizeCoordinationRecordPage,
  normalizeCoordinationSnapshot,
} from "./authorization.js";

function intentId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Secure randomness is required for coordination operation keys");
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function classifyCoordinationRefusal(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  if (code === "42501" && /mfa required/i.test(message)) return "mfa_required";
  if (code === "42501") return "unauthorized";
  return "other";
}

function errorState(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  if (code === "PGRST202" || code === "42883" || /does not exist|could not find the function/i.test(message)) return "unavailable";
  const refusal = classifyCoordinationRefusal(error);
  return refusal === "other" ? "error" : refusal;
}

function requireClient(client) {
  if (!client?.rpc) throw Object.assign(new Error("coordination unavailable"), { code: "PGRST202" });
  return client;
}

// The same classification for the ONE projection whose RPC writes, and it is
// deliberately narrower than errorState() above. `get_organization_coordination_
// extensions` INSERTs a ('directory_viewed','allowed') row before it returns, and
// it carries no idempotency key, so "may this be pressed again?" is really "can
// the client PROVE the function never ran?".
//
// Only two failures prove it, and both are pre-execution by construction:
// requireClient() raising before any request leaves the browser, and PostgREST
// answering PGRST202 — a schema-cache miss, which is decided before the function
// is called. Both surface as PGRST202, and the code alone is the evidence: the
// message-pattern arm errorState() uses for a mount read (/does not exist/) is
// NOT reused here, because that text can equally come from inside the function
// body, after the audit row committed.
//
// Everything else is ambiguous and must be reported as the latched `error`: a
// dropped connection, an aborted response, a 5xx, or a 42883 raised by something
// the body itself called can each arrive with the insert already committed. The
// desk then says it could not confirm the result and asks for a reload rather
// than offering a press that would write a second audit row.
function deferredDirectoryState(error) {
  const refusal = classifyCoordinationRefusal(error);
  if (refusal !== "other") return refusal;
  const code = String(error?.code || error?.status || "");
  if (code === "PGRST202") return "unavailable";
  return "error";
}

async function rpc(client, name, args) {
  const result = await requireClient(client).rpc(name, args);
  if (result?.error) throw result.error;
  return result?.data ?? null;
}

// A staff projection that misses this deadline degrades instead of holding the
// whole mount against the shell's load deadline. Deliberately shorter than
// SHELL_LOAD_DEADLINE_MS: the desk's substance is the snapshot, and an admin
// waiting on a slow additional projection must still get the page the member
// hat already gets.
const STAFF_PROJECTION_DEADLINE_MS = 6_000;

export function createOrganizationCoordinationAdapter(client, { staffProjectionDeadlineMs = STAFF_PROJECTION_DEADLINE_MS } = {}) {
  // The staff-only mount arms. Each is an ADDITION to the snapshot every hat
  // reads, so a rejection or a slow answer degrades that one projection to its
  // empty value and names itself; it never rejects the mount. Before this, one
  // failing staff RPC rejected the whole Promise.all below and every admin
  // visit to /m/coordination/* rendered the whole-page "Coordination is
  // unavailable" panel while the identical member desk rendered its records
  // (PR1815 READY_MUST_NOT_BE_UNAVAILABLE). The snapshot and the message page
  // stay required: without those there is no desk to render.
  const optional = async (field, enabled, empty, work) => {
    if (!enabled) return { field, value: empty, degraded: false };
    try {
      return { field, value: await withLoadDeadline(work(), staffProjectionDeadlineMs), degraded: false };
    } catch (error) {
      // The desk tells the operator which addition is missing, but "no coalition
      // decisions in this organization" and "this RPC is failing for every admin
      // in the tenant" look identical from the outside. Report the class of
      // failure so an outage behind a degraded panel is visible without a user
      // report. Same privacy-filtered sink, and the same shape, that
      // memberSessionLoader already uses for a swallowed per-resource failure:
      // a bounded label, the arm name, the error code and the error class, and
      // nothing from the request or the member.
      captureSanitizedDiagnostic({
        kind: "coordination_staff_projection_failure",
        resource: field,
        code: error?.code,
        name: error?.name,
      });
      return { field, value: empty, degraded: true };
    }
  };
  return {
    requestedRpcs: COORDINATION_RPCS,
    // MOUNT IS READ-ONLY. Every call in this Promise.all must be a projection
    // that changes no row. `COORDINATION_RPCS.extensions` used to be here and
    // is deliberately absent: its SQL body INSERTs a 'directory_viewed' access
    // event, so loading it on view both mutated on view and manufactured an
    // audit record nobody asked for. It now has its own method below, reached
    // only by an explicit control. Adding a writing RPC back to this list is a
    // regression the mount tests and the PR1815 acceptance runner both refuse.
    async load(actor) {
      const current = normalizeCoordinationActor(actor);
      if (!canReadCoordination(current)) return { ...EMPTY_COORDINATION_SNAPSHOT };
      try {
        const staff = canManageCoordination(current);
        const [snapshot, messagePage, networkAccessEvents, coalitionDecisions, micrositeEditor] = await Promise.all([
          rpc(client, COORDINATION_RPCS.snapshot),
          rpc(client, COORDINATION_RPCS.messagesPage, {
            p_before_created_at: null,
            p_before_id: null,
            p_limit: 30,
          }),
          optional("networkAccessEvents", staff, [], () => rpc(client, COORDINATION_RPCS.networkAccessEvents, { p_limit: 50 })),
          optional("coalitionDecisions", staff, [], () => rpc(client, COORDINATION_RPCS.coalitionDecisions)),
          optional("micrositeEditor", Boolean(staff && current.chapterId), EMPTY_COORDINATION_SNAPSHOT.micrositeEditor,
            () => rpc(client, COORDINATION_RPCS.micrositeEditor, { p_chapter_code: current.chapterId })),
        ]);
        return normalizeCoordinationSnapshot({
          ...snapshot,
          messages: messagePage?.messages || [],
          nextMessagesCursor: messagePage?.nextCursor || null,
          networkAccessEvents: networkAccessEvents.value,
          coalitionDecisions: coalitionDecisions.value,
          micrositeEditor: micrositeEditor.value,
          degradedProjections: [networkAccessEvents, coalitionDecisions, micrositeEditor]
            .filter((arm) => arm.degraded).map((arm) => arm.field),
        }, current);
      } catch (error) {
        return { ...EMPTY_COORDINATION_SNAPSHOT, state: errorState(error) };
      }
    },
    // The partner directory, invitations, badges, activity and mapping surfaces
    // the deferred projection carries. Called from an explicit member control —
    // any actor who can read the desk, staff or not — so the 'directory_viewed'
    // row its SQL writes records a real decision to look at other organizations
    // rather than an incidental page mount.
    async loadDirectoryExtensions(actor) {
      const current = normalizeCoordinationActor(actor);
      // Not "empty": no call was made, so the backend never answered, and the
      // desk's empty copy says the projection loaded. An actor who cannot read
      // this organization is refused, which is the state whose copy says exactly
      // that and offers no retry.
      if (!canReadCoordination(current)) return { ...EMPTY_COORDINATION_EXTENSIONS, state: "unauthorized" };
      // This RPC is parameterless: it resolves its own organization from
      // private.current_member_organization() and INSERTs the 'directory_viewed'
      // row for THAT organization before anything here can compare it with the
      // actor. So while the session's scope is still the one the route mounted
      // with — get_my_chapter_memberships not answered, or answered unavailable —
      // a press under the org-1 desk could write org-2's audit row and only then
      // be told the answer is unauthorized. There is no argument to bind and no
      // way to undo the row, so the call is not made at all.
      //
      // The answer is `idle`, not a refusal: nothing was asked of the backend, so
      // the desk keeps its explanatory request panel (which is non-interactive
      // until the scope resolves) instead of claiming a decision was made. The
      // desk gate is the real guard; this is the same rule stated where the call
      // actually happens, so no future caller can reach the RPC around it.
      if (!coordinationScopeIsAuthoritative(current)) return { ...EMPTY_COORDINATION_EXTENSIONS, state: "idle" };
      try {
        return normalizeCoordinationExtensions(await rpc(client, COORDINATION_RPCS.extensions), current);
      } catch (error) {
        return { ...EMPTY_COORDINATION_EXTENSIONS, state: deferredDirectoryState(error) };
      }
    },
    async loadMore(actor, cursor) {
      if (!canReadCoordination(actor)) throw Object.assign(new Error("organization membership required"), { code: "42501" });
      if (!cursor?.updatedAt || !cursor?.id) return { records: [], nextRecordsCursor: null };
      const page = await rpc(client, COORDINATION_RPCS.recordsPage, {
        p_before_updated_at: cursor.updatedAt,
        p_before_id: cursor.id,
        p_limit: 50,
      });
      return normalizeCoordinationRecordPage(page);
    },
    async loadMoreMessages(actor, cursor) {
      if (!canReadCoordination(actor)) throw Object.assign(new Error("organization membership required"), { code: "42501" });
      if (!cursor?.createdAt || !cursor?.id) return { messages: [], nextMessagesCursor: null };
      const page = await rpc(client, COORDINATION_RPCS.messagesPage, {
        p_before_created_at: cursor.createdAt,
        p_before_id: cursor.id,
        p_limit: 30,
      });
      return normalizeCoordinationMessagePage(page);
    },
    async create(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.create, {
        p_kind: input.kind,
        p_title: input.title,
        p_summary: input.summary || "",
        p_visibility: input.visibility || "staff",
        p_partner_organization_id: input.partnerOrganizationId || null,
        p_parent_id: input.parentId || null,
        p_chapter_id: input.chapterId || null,
        p_config: input.config || {},
        p_idempotency_key: input.idempotencyKey || intentId(),
      });
    },
    async join(actor, recordId, role = "participant", config = {}) {
      if (!canReadCoordination(actor)) throw Object.assign(new Error("organization membership required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.join, {
        p_record_id: recordId,
        p_role: role,
        p_config: config,
        p_idempotency_key: intentId(),
      });
    },
    async transition(actor, recordId, transition, { config = {}, points = 0 } = {}) {
      if (!canReadCoordination(actor)) throw Object.assign(new Error("organization membership required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.transition, {
        p_record_id: recordId,
        p_transition: transition,
        p_config: config,
        p_points: points,
        p_idempotency_key: intentId(),
      });
    },
    async respond(actor, recordId, accept) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.respond, {
        p_record_id: recordId,
        p_accept: Boolean(accept),
        p_idempotency_key: intentId(),
      });
    },
    async message(actor, conversationId, body) {
      if (!canReadCoordination(actor)) throw Object.assign(new Error("organization membership required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.message, {
        p_conversation_id: conversationId,
        p_body: body,
        p_idempotency_key: intentId(),
      });
    },
    async resource(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.resource, {
        p_record_id: input.recordId,
        p_resource_kind: input.kind,
        p_title: input.title,
        p_chapter_document_id: input.documentId || null,
        p_idempotency_key: intentId(),
      });
    },
    async runExport(actor, scheduleId, format = "csv") {
      if (!canPerformCoordinationIntent(actor, "runExport")) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      // The server refuses any format outside ('csv','json') with 22023; the
      // client validates the same set so a hand-built call fails before the RPC.
      if (!COORDINATION_EXPORT_FORMATS.includes(format)) throw Object.assign(new Error("export format unavailable"), { code: "22023" });
      return rpc(client, COORDINATION_RPCS.export, {
        p_schedule_id: scheduleId,
        p_format: format,
        p_idempotency_key: intentId(),
      });
    },
    async loadExportPayload(actor, runId) {
      if (!canPerformCoordinationIntent(actor, "downloadExport")) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.exportPayload, { p_run_id: runId });
    },
    async outreach(actor, input = {}) {
      if (!canPerformCoordinationIntent(actor, "outreach")) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.outreach, {
        p_campaign_id: input.campaignId,
        p_target_user_id: input.targetUserId,
        p_disposition: input.disposition,
        p_note: input.note || "",
        p_idempotency_key: intentId(),
      });
    },
    async saveProfile(actor, input = {}) {
      if (!canPerformCoordinationIntent(actor, "saveProfile")) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.profile, {
        p_display_name: input.displayName,
        p_summary: input.summary || "",
        p_visibility: input.visibility || "private",
        p_contact_mode: input.contactMode || "disabled",
        p_parent_organization_id: input.parentOrganizationId || null,
      });
    },
    async setPermission(actor, input = {}) {
      if (!canPerformCoordinationIntent(actor, "setPermission")) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.permission, {
        p_network_record_id: input.networkRecordId,
        p_grantee_organization_id: input.granteeOrganizationId,
        p_capability: input.capability,
        p_enabled: Boolean(input.enabled),
      });
    },
    async inviteOrganization(actor, input = {}) {
      if (!canPerformCoordinationIntent(actor, "inviteOrganization")) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.inviteOrganization, {
        p_record_id: input.recordId,
        p_organization_id: input.organizationId,
        p_role: input.role || "member",
        p_idempotency_key: intentId(),
      });
    },
    async respondParticipant(actor, recordId, accept) {
      if (!canPerformCoordinationIntent(actor, "respondParticipant")) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.respondParticipant, {
        p_record_id: recordId,
        p_accept: Boolean(accept),
        p_idempotency_key: intentId(),
      });
    },
    async respondResource(actor, resourceId, accept) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.respondResource, {
        p_resource_id: resourceId,
        p_accept: Boolean(accept),
        p_idempotency_key: intentId(),
      });
    },
    async loadSharedDocument(actor, resourceId) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.sharedDocument, { p_resource_id: resourceId });
    },
    async assignParticipant(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.assignParticipant, {
        p_record_id: input.recordId,
        p_user_id: input.userId,
        p_role: input.role,
        p_active: input.active !== false,
        p_idempotency_key: intentId(),
      });
    },
    async proposeCoalitionDecision(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.proposeCoalitionDecision, {
        p_campaign_id: input.campaignId,
        p_subject_record_id: input.subjectRecordId,
        p_title: input.title,
        p_rationale: input.rationale || "",
        p_action: input.action || "authorize_work",
        p_required_approvals: input.requiredApprovals || null,
        p_idempotency_key: intentId(),
      });
    },
    async voteCoalitionDecision(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.voteCoalitionDecision, {
        p_decision_id: input.decisionId,
        p_vote: input.vote,
        p_comment: input.comment || "",
        p_idempotency_key: intentId(),
      });
    },
    async reviewMergeMatch(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.reviewMergeMatch, {
        p_plan_id: input.planId,
        p_source_user_id: input.sourceUserId,
        p_target_user_id: input.targetUserId,
        p_decision: input.decision,
      });
    },
    async executeMerge(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.executeMerge, {
        p_plan_id: input.planId,
        p_expected_source_organization_id: input.sourceOrganizationId,
        p_expected_target_organization_id: input.targetOrganizationId,
        p_idempotency_key: intentId(),
      });
    },
    async saveChapterProfile(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.saveChapterProfile, {
        p_chapter_code: input.chapterCode,
        p_title_en: input.titleEn,
        p_title_es: input.titleEs,
        p_body_en: input.bodyEn,
        p_body_es: input.bodyEs,
        p_is_published: Boolean(input.published),
        p_expected_updated_at: input.expectedUpdatedAt ?? null,
        p_expected_missing: input.expectedMissing === true,
      });
    },
    async saveMicrositeSection(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.saveMicrositeSection, {
        p_chapter_code: input.chapterCode,
        p_slug: input.slug,
        p_title_en: input.titleEn,
        p_title_es: input.titleEs,
        p_body_en: input.bodyEn,
        p_body_es: input.bodyEs,
        p_sort_order: Number(input.sortOrder || 0),
        p_is_published: Boolean(input.published),
      });
    },
    async saveMicrositePage(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.saveMicrositePage, {
        p_chapter_code: input.chapterCode,
        p_section_slug: input.sectionSlug,
        p_slug: input.slug,
        p_title_en: input.titleEn,
        p_title_es: input.titleEs,
        p_body_en: input.bodyEn,
        p_body_es: input.bodyEs,
        p_sort_order: Number(input.sortOrder || 0),
        p_is_published: Boolean(input.published),
      });
    },
    async attachPublicPageDocument(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.attachPublicPageDocument, {
        p_chapter_code: input.chapterCode,
        p_section_slug: input.sectionSlug,
        p_page_slug: input.pageSlug,
        p_chapter_document_id: input.documentId,
        p_label: input.label,
      });
    },
    async takeOverPublicPage(actor, input = {}) {
      if (!canManageCoordination(actor)) throw Object.assign(new Error("coordination staff role required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.takeOverPublicPage, {
        p_chapter_code: input.chapterCode,
        p_section_slug: input.sectionSlug,
        p_page_slug: input.pageSlug,
        p_reason: input.reason,
        p_idempotency_key: intentId(),
      });
    },
    async recommendCoverage(actor, chapterId, at = null) {
      if (!canReadCoordination(actor)) throw Object.assign(new Error("organization membership required"), { code: "42501" });
      return rpc(client, COORDINATION_RPCS.recommendCoverage, {
        p_chapter_id: chapterId,
        p_at: at || new Date().toISOString(),
      });
    },
  };
}
