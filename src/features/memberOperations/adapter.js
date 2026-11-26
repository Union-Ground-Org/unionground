import { MEMBER_OPERATIONS_RPCS } from "./contract.js";
import {
  canManageMemberOperations,
  normalizeMemberOperationsWorkspace,
} from "./authorization.js";

function requireAdmin(actor) {
  if (!canManageMemberOperations(actor)) {
    throw Object.assign(new Error("admin role and MFA required"), { code: "42501" });
  }
}

function requireClient(client) {
  if (!client?.rpc) throw Object.assign(new Error("member operations unavailable"), { code: "PGRST202" });
  return client;
}

async function rpc(client, name, args) {
  const result = await requireClient(client).rpc(name, args);
  if (result?.error) throw result.error;
  return result?.data ?? null;
}

function randomUUID() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw Object.assign(new Error("secure id generator unavailable"), { code: "UUID_UNAVAILABLE" });
}

function unavailable(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  if (code === "PGRST202" || code === "42883" || /does not exist|could not find the function/i.test(message)) return "unavailable";
  if (code === "42501" && /mfa required/i.test(message)) return "mfa_required";
  if (code === "42501") return "unauthorized";
  return "error";
}

export function createMemberOperationsAdapter(client, { randomUUID: uuid = randomUUID } = {}) {
  const mutate = (name, args = {}) => rpc(client, name, { ...args, p_idempotency_key: uuid() });
  return {
    requestedRpcs: MEMBER_OPERATIONS_RPCS,
    async load(actor) {
      if (!canManageMemberOperations(actor)) {
        // An otherwise authorized Admin awaiting MFA already wears the right
        // hat. Explain the missing check without relaxing it or issuing a read.
        return { state: canManageMemberOperations({ ...actor, mfaSatisfied: true }) ? "mfa_required" : "unauthorized" };
      }
      try {
        return normalizeMemberOperationsWorkspace(await rpc(client, MEMBER_OPERATIONS_RPCS.workspace), actor);
      } catch (error) {
        return { state: unavailable(error) };
      }
    },
    async listDirectory(actor, input = {}) {
      requireAdmin(actor);
      return rpc(client, MEMBER_OPERATIONS_RPCS.directory, {
        p_query: input.query || null,
        p_after_name: input.afterName || null,
        p_after_id: input.afterId || null,
        p_limit: input.limit || 25,
      });
    },
    async loadProfile(actor, memberUserId) {
      requireAdmin(actor);
      return rpc(client, MEMBER_OPERATIONS_RPCS.profile, { p_member_user_id: memberUserId });
    },
    async saveProfile(actor, input) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.saveProfile, {
        p_member_user_id: input.memberUserId,
        p_expected_version: Number(input.expectedVersion || 0),
        p_fields: input.fields || {},
      });
    },
    async bulkUpdateProfiles(actor, input) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.bulkUpdateProfiles, {
        p_member_user_ids: input.memberUserIds || [], p_field: input.field, p_value: input.value ?? null,
      });
    },
    async saveWelcomeCampaign(actor, input) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign, {
        p_campaign_id: input.campaignId || null, p_name: input.name, p_state: input.state || "draft",
      });
    },
    async listWelcomeEnrollments(actor, input) {
      requireAdmin(actor);
      return rpc(client, MEMBER_OPERATIONS_RPCS.welcomeEnrollments, {
        p_campaign_id: input.campaignId,
        p_before_enrolled_at: input.beforeEnrolledAt || null,
        p_before_id: input.beforeId || null,
        p_limit: input.limit || 10,
      });
    },
    async saveWelcomeStep(actor, input) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.saveWelcomeStep, {
        p_campaign_id: input.campaignId, p_step_id: input.stepId || null, p_position: Number(input.position || 0),
        p_delay_days: Number(input.delayDays || 0), p_locale: input.locale || "en", p_subject: input.subject,
        p_body: input.body, p_active: input.active !== false,
      });
    },
    async enrollWelcome(actor, input) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.enrollWelcome, { p_campaign_id: input.campaignId, p_member_user_id: input.memberUserId });
    },
    async transitionWelcome(actor, input) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.transitionWelcome, { p_enrollment_id: input.enrollmentId, p_state: input.state });
    },
    async queueWelcome(actor) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.queueWelcome);
    },
    async stageImport(actor, input) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.stageImport, {
        p_kind: input.kind, p_filename: input.filename, p_mapping: input.mapping || {}, p_rows: input.rows || [],
      });
    },
    async listImports(actor, input = {}) {
      requireAdmin(actor);
      return rpc(client, MEMBER_OPERATIONS_RPCS.importBatches, {
        p_before_created_at: input.beforeCreatedAt || null,
        p_before_id: input.beforeId || null,
        p_limit: input.limit || 10,
      });
    },
    async validateImport(actor, batchId) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.validateImport, { p_batch_id: batchId });
    },
    async commitImport(actor, batchId) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.commitImport, { p_batch_id: batchId });
    },
    async discardImport(actor, batchId) {
      requireAdmin(actor);
      return mutate(MEMBER_OPERATIONS_RPCS.discardImport, { p_batch_id: batchId });
    },
  };
}
