// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP1-20261022.
//
// The guide engine's only doors to the server. It reads what exists today,
// get_member_onboarding_guide, get_member_support_workspace and
// get_member_home_nudges, each failing open, and it writes only through the
// member support adapter's start_member_onboarding_plan and
// complete_member_onboarding_step. Any other action is refused here, so a
// later surface cannot widen the engine's writes by accident.
import { t } from "../../lib/i18n.js";
import { localeFor } from "../../lib/i18n/format.js";
import { guideEngineCatalogue } from "../../lib/i18n/guideEngine.js";
import { lookup } from "../../lib/i18n/runtime.js";
import { ONBOARDING_GUIDE_REFRESH_EVENT } from "../../lib/onboardingGuide.js";
import { GUIDE_RPC, NUDGES_RPC } from "../memberHome/nudges.js";
import { classifyMemberSupportError } from "../memberSupport/adapter.js";
import { MEMBER_SUPPORT_RPCS } from "../memberSupport/contract.js";

export const GUIDE_ENGINE_READS = Object.freeze([GUIDE_RPC, MEMBER_SUPPORT_RPCS.snapshot, NUDGES_RPC]);
export const GUIDE_ENGINE_WRITES = Object.freeze([MEMBER_SUPPORT_RPCS.startOnboarding, MEMBER_SUPPORT_RPCS.completeOnboardingStep]);

// Each call names its RPC literally, so the read-RPC drift guard
// (tests/pr1815-read-rpc-drift-guard.test.js) can resolve it.
async function read(call) {
  try {
    const result = await call();
    if (result?.error) return { data: null, state: classifyMemberSupportError(result.error) };
    return { data: result?.data ?? null, state: "ready" };
  } catch (error) {
    return { data: null, state: classifyMemberSupportError(error) };
  }
}

/**
 * The three reads, in parallel. The workspace goes through the member
 * support adapter, which owns its sensitive-content path and normalization.
 * @param {{ client: { rpc: Function } | null, supportAdapter: { load: Function } | null, actor: unknown }} input
 */
export async function loadGuideEngineReads({ client, supportAdapter, actor }) {
  if (!client?.rpc) return { guide: null, guideFailed: true, nudges: null, nudgesState: "error", workspace: null };
  const [guide, nudges, workspace] = await Promise.all([
    read(() => client.rpc(GUIDE_RPC)),
    read(() => client.rpc(NUDGES_RPC)),
    supportAdapter?.load ? Promise.resolve(supportAdapter.load(actor)).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    guide: guide.data,
    guideFailed: guide.state !== "ready",
    nudges: nudges.data,
    nudgesState: nudges.state === "ready" ? "ready" : nudges.state === "unauthorized" ? "unauthorized" : "error",
    workspace: workspace?.state === "ready" ? { onboardingProgram: workspace.onboardingProgram, onboardingPlan: workspace.onboardingPlan } : null,
  };
}

/**
 * Carry out the engine's one action. Only Start and Complete exist.
 * @param {{ supportAdapter: { startOnboarding: Function, completeOnboardingStep: Function }, actor: unknown, action: { kind: string, stepId?: string } | null, target?: { dispatchEvent?: Function } }} input
 */
export async function performGuideAction({ supportAdapter, actor, action, target = globalThis }) {
  let result;
  if (action?.kind === "start_plan") result = await supportAdapter.startOnboarding(actor, null);
  else if (action?.kind === "complete_step" && typeof action.stepId === "string") result = await supportAdapter.completeOnboardingStep(actor, action.stepId);
  else throw Object.assign(new Error("guide action is not allowed"), { code: "22023" });
  // Same refresh signal MemberSupportView sends, so the shell re-reads.
  if (typeof target?.dispatchEvent === "function" && typeof Event === "function") target.dispatchEvent(new Event(ONBOARDING_GUIDE_REFRESH_EVENT));
  return result;
}

const DATE_PARAMS = new Set(["day", "until", "date"]);

/**
 * Render one engine line in a language. Params that are lines themselves are
 * rendered first; ISO dates in day, until and date are shown as dates. The
 * engine's own guideEngine.* lines come from their chunk; the product's
 * onboardingGuide.* and homeNudge.* lines from the barrel.
 * @param {string} lang
 * @param {{ key: string, params?: Record<string, unknown> }} entry
 * @returns {string}
 */
export function renderGuideCopy(lang, entry, translate = null) {
  const params = Object.fromEntries(Object.entries(entry?.params ?? {}).map(([name, value]) => {
    if (value && typeof value === "object" && typeof (/** @type {any} */ (value).key) === "string") return [name, renderGuideCopy(lang, /** @type {any} */ (value), translate)];
    if (DATE_PARAMS.has(name) && typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      return [name, new Intl.DateTimeFormat(localeFor(lang), { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(value))];
    }
    return [name, value];
  }));
  if (translate) return translate(entry.key, params);
  return entry.key.startsWith("guideEngine.") ? lookup(guideEngineCatalogue, lang, entry.key, params) : t(lang, entry.key, params);
}
