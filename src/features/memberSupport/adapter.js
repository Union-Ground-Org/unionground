import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "../../lib/loadDeadline.js";
import { createOperationKeys, operationIntent } from "../../lib/operationKey.js";
import { sensitiveContentRpc } from "../../lib/sensitiveContentApi.js";
import {
  EMPTY_MEMBER_SUPPORT_WORKSPACE,
  MEMBER_SUPPORT_RPCS,
} from "./contract.js";
import {
  canManageMemberSupport,
  canReadMemberSupport,
  normalizeMemberHandoffs,
  normalizeMemberSupportActor,
  normalizeMemberSupportWorkspace,
} from "./authorization.js";
import {
  MEMBER_ONBOARDING_OVERSIGHT_RPCS,
  ONBOARDING_OVERSIGHT_ACTIONS,
  normalizeOnboardingOversight,
} from "./onboardingOversight.js";

function unavailable(error) {
  const code = String(error?.code || error?.status || "");
  const message = String(error?.message || error || "");
  if (code === "PGRST202" || code === "42883" || /does not exist|could not find the function/i.test(message)) return "unavailable";
  if (code === "42501" && /mfa required/i.test(message)) return "mfa_required";
  if (code === "42501") return "unauthorized";
  if (code === "22023") return "invalid_input";
  return "error";
}

export function classifyMemberSupportError(error) {
  return unavailable(error);
}

function requireClient(client) {
  if (!client?.rpc) throw Object.assign(new Error("member support unavailable"), { code: "PGRST202" });
  return client;
}

async function rpc(client, name, args, origin = "") {
  const result = ["create_member_accommodation_request", "transition_member_accommodation_request", "get_member_support_workspace"].includes(name)
    ? await sensitiveContentRpc(requireClient(client), name, args, origin)
    : await requireClient(client).rpc(name, args);
  if (result?.error) throw result.error;
  return result?.data ?? null;
}

function browserRandomUUID() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw Object.assign(new Error("secure id generator unavailable"), { code: "UUID_UNAVAILABLE" });
}

function ensureReadable(actor) {
  if (!canReadMemberSupport(actor)) throw Object.assign(new Error("active organization membership required"), { code: "42501" });
}

function ensureStaff(actor) {
  if (!canManageMemberSupport(actor)) throw Object.assign(new Error("staff role and MFA required"), { code: "42501" });
}

/**
 * @param {unknown} client
 * @param {{ randomUUID?: () => string, apiOrigin?: string, loadDeadlineMs?: number }} [options]
 */
export function createMemberSupportAdapter(client, { randomUUID = browserRandomUUID, apiOrigin = "", loadDeadlineMs = SHELL_LOAD_DEADLINE_MS } = {}) {
  // A retry of the same write by the same person in the same organization
  // keeps the key of its first try until the server answers (or for ten
  // minutes), so a lost response cannot become a second request or contact
  // (the functions deduplicate by key). keep: false mints a key per call for a
  // write the server already merges, the emergency steward alert, where a kept
  // key could turn a later real alert into a no-op (review of #8648). The rpc
  // call stays directly inside mutate for the read-RPC drift guard.
  const operationKeys = createOperationKeys(randomUUID);
  // The kept intents still waiting for an answer,
  // with their RPC and arguments, so a reversal that succeeds can retire the
  // one write it reversed (complete, reset, complete; initiate, cancel,
  // initiate) and nothing else. A write unrelated to the reversal keeps its key.
  const pending = new Map();
  const retirePending = (match) => {
    for (const [intent, write] of pending) {
      if (!match(write)) continue;
      operationKeys.settle(intent);
      pending.delete(intent);
    }
  };
  // The member and receiving steward of each handoff this adapter has read,
  // so a cancel or decline by id can name the initiate it reverses.
  const handoffParties = new Map();
  /**
   * @template T
   * @param {T} page
   * @returns {T}
   */
  const rememberHandoffs = (page) => {
    for (const item of page?.items ?? []) handoffParties.set(item.id, { memberId: item.memberId, toStewardId: item.toStewardId });
    return page;
  };
  const retireInitiateFor = (handoffId) => {
    const parties = handoffParties.get(handoffId);
    if (!parties) return;
    retirePending(({ name, args }) => name === MEMBER_SUPPORT_RPCS.initiateHandoff
      && args.p_member_user_id === parties.memberId && args.p_to_steward_id === parties.toStewardId);
  };
  const mutate = async (actor, name, args = {}, { keep = true } = {}) => {
    const { userId, selectedOrganizationId } = normalizeMemberSupportActor(actor);
    const intent = keep ? operationIntent(name, { args, userId, selectedOrganizationId }) : null;
    const key = intent ? operationKeys.keyFor(intent) : operationKeys.mint();
    if (intent) pending.set(intent, { name, args });
    const result = await rpc(client, name, { ...args, p_idempotency_key: key }, apiOrigin);
    if (intent) {
      operationKeys.settle(intent);
      pending.delete(intent);
    }
    return result;
  };
  return {
    requestedRpcs: MEMBER_SUPPORT_RPCS,
    async load(actor) {
      const current = normalizeMemberSupportActor(actor);
      if (!canReadMemberSupport(current)) return { ...EMPTY_MEMBER_SUPPORT_WORKSPACE };
      try {
        // The snapshot travels through /api/sensitive-content, a plain fetch
        // with no transport bound, so a stalled call kept "Loading member
        // support…" up with no Try again. It is a read: past the shell
        // deadline it is abandoned as an error the page can retry
        // (REQ-UG-PAGE-LOADING-STALLS-20261030).
        const workspace = normalizeMemberSupportWorkspace(await withLoadDeadline(rpc(client, MEMBER_SUPPORT_RPCS.snapshot, undefined, apiOrigin), loadDeadlineMs), current);
        rememberHandoffs(workspace.handoffs);
        return workspace;
      } catch (error) {
        return { ...EMPTY_MEMBER_SUPPORT_WORKSPACE, state: unavailable(error) };
      }
    },
    async saveEmergencyChecklist(actor, input) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.saveEmergencyChecklist, {
        p_scenario: input.scenario,
        p_completed_steps: input.completedSteps || [],
        p_notes: input.notes || "",
      });
    },
    async alertEmergencySteward(actor, input) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.alertEmergencySteward, {
        p_scenario: input.scenario,
        p_completed_steps: input.completedSteps || [],
        p_notes: input.notes || "",
      }, { keep: false });
    },
    async resolveEmergencyChecklist(actor, checklistId) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.resolveEmergencyChecklist, {
        p_checklist_id: checklistId,
      });
    },
    async createAccommodation(actor, input) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.createAccommodation, {
        p_request_type: input.requestType,
        p_description: input.description,
      });
    },
    async transitionAccommodation(actor, input) {
      ensureReadable(actor);
      if (input.status !== "withdrawn") ensureStaff(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.transitionAccommodation, {
        p_request_id: input.requestId,
        p_status: input.status,
        p_staff_note: input.staffNote || "",
      });
    },
    async recordHrContact(actor, input) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.recordHrContact, {
        p_member_user_id: input.memberUserId || null,
        p_channel: input.channel,
        p_purpose: input.purpose,
        p_disposition: input.disposition,
        p_note: input.note || "",
        p_occurred_at: input.occurredAt || new Date().toISOString(),
        p_follow_up_on: input.followUpOn || null,
      });
    },
    async saveHrDirectory(actor, input) {
      ensureStaff(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.saveHrDirectory, {
        p_name: input.name || "",
        p_title: input.title || "",
        p_department: input.department || "",
        p_email: input.email || "",
        p_phone: input.phone || "",
        p_hours: input.hours || "",
        p_notes: input.notes || "",
        p_enabled: input.enabled !== false,
      });
    },
    async saveOnboardingStep(actor, input) {
      ensureStaff(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.saveOnboardingStep, {
        p_step_id: input.stepId || null,
        p_title: input.title,
        p_description: input.description || "",
        p_position: Number(input.position || 0),
        p_active: input.active !== false,
      });
    },
    /**
     * @param {unknown} actor
     * @param {string | null} [memberUserId]
     */
    async startOnboarding(actor, memberUserId = null) {
      ensureReadable(actor);
      if (memberUserId && memberUserId !== normalizeMemberSupportActor(actor).userId) ensureStaff(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.startOnboarding, { p_member_user_id: memberUserId });
    },
    async completeOnboardingStep(actor, stepId) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.completeOnboardingStep, { p_step_id: stepId });
    },
    // REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001: staff
    // roster with the stalled flag, and audited complete / skip / reset.
    async loadOnboardingOversight(actor) {
      ensureStaff(actor);
      return normalizeOnboardingOversight(await rpc(client, MEMBER_ONBOARDING_OVERSIGHT_RPCS.load, undefined, apiOrigin));
    },
    /**
     * @param {unknown} actor
     * @param {{ planId: string, action: "complete" | "skip" | "reset", stepId?: string | null, reason?: string | null }} input
     */
    async updateMemberOnboarding(actor, input) {
      ensureStaff(actor);
      if (!ONBOARDING_OVERSIGHT_ACTIONS.includes(input?.action) || typeof input?.planId !== "string") {
        throw Object.assign(new Error("invalid onboarding change"), { code: "22023" });
      }
      // REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: a skip carries
      // its reason; the server refuses one without.
      const result = await mutate(actor, MEMBER_ONBOARDING_OVERSIGHT_RPCS.update, {
        p_plan_id: input.planId,
        p_action: input.action,
        p_step_id: input.action === "reset" ? null : input.stepId ?? null,
        p_reason: input.action === "skip" ? String(input.reason ?? "").trim() || null : null,
      });
      // A reset the server applied reverses this plan's earlier complete and
      // skip writes, so a redo of one is a new write.
      if (input.action === "reset") {
        retirePending(({ name, args }) => name === MEMBER_ONBOARDING_OVERSIGHT_RPCS.update && args.p_plan_id === input.planId);
      }
      return result;
    },
    /** One reminder to a stalled member; the server enforces once a day and the member's opt-out. */
    async sendOnboardingReminder(actor, planId) {
      ensureStaff(actor);
      if (typeof planId !== "string") throw Object.assign(new Error("invalid onboarding reminder"), { code: "22023" });
      return mutate(actor, MEMBER_ONBOARDING_OVERSIGHT_RPCS.remind, { p_plan_id: planId });
    },
    async createMentorshipPair(actor, input) {
      ensureStaff(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.createMentorshipPair, {
        p_mentor_user_id: input.mentorUserId,
        p_mentee_user_id: input.menteeUserId,
        p_started_on: input.startedOn || null,
      });
    },
    async transitionMentorshipPair(actor, input) {
      ensureStaff(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.transitionMentorshipPair, {
        p_pair_id: input.pairId,
        p_status: input.status,
        p_outcome: input.outcome || "",
      });
    },
    async addMentorshipNote(actor, input) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.addMentorshipNote, {
        p_pair_id: input.pairId,
        p_body: input.body,
      });
    },
    async saveMentorshipGoal(actor, input) {
      ensureReadable(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.saveMentorshipGoal, {
        p_pair_id: input.pairId,
        p_goal_id: input.goalId || null,
        p_title: input.title,
        p_completed: Boolean(input.completed),
      });
    },
    async listHandoffs(actor, input = {}) {
      ensureStaff(actor);
      return rememberHandoffs(normalizeMemberHandoffs(await rpc(client, MEMBER_SUPPORT_RPCS.listHandoffs, {
        p_query: input.query || null,
        p_status: input.status || null,
        p_before_created_at: input.beforeCreatedAt || null,
        p_before_id: input.beforeId || null,
        p_limit: input.limit || 20,
      })));
    },
    async searchHandoffMembers(actor, query) {
      ensureStaff(actor);
      return rpc(client, MEMBER_SUPPORT_RPCS.searchHandoffMembers, { p_query: query });
    },
    async searchHandoffStewards(actor, query) {
      ensureStaff(actor);
      return rpc(client, MEMBER_SUPPORT_RPCS.searchHandoffStewards, { p_query: query });
    },
    async initiateHandoff(actor, input) {
      ensureStaff(actor);
      return mutate(actor, MEMBER_SUPPORT_RPCS.initiateHandoff, {
        p_member_user_id: input.memberUserId,
        p_to_steward_id: input.toStewardId,
        p_note: input.note || "",
      });
    },
    async acknowledgeHandoff(actor, handoffId) {
      ensureStaff(actor);
      return rpc(client, MEMBER_SUPPORT_RPCS.acknowledgeHandoff, { p_handoff_id: handoffId });
    },
    async declineHandoff(actor, handoffId) {
      ensureStaff(actor);
      const result = await rpc(client, MEMBER_SUPPORT_RPCS.declineHandoff, { p_handoff_id: handoffId });
      retireInitiateFor(handoffId);
      return result;
    },
    async cancelHandoff(actor, handoffId) {
      ensureStaff(actor);
      const result = await rpc(client, MEMBER_SUPPORT_RPCS.cancelHandoff, { p_handoff_id: handoffId });
      retireInitiateFor(handoffId);
      return result;
    },
  };
}
