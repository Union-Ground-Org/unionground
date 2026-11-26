import { normalizeAutomationCapabilities } from "../features/automation/capabilities.js";
import { normalizeAutomationProposal } from "../features/automation/proposals.js";

const reasons = new Set([
  "unauthorized",
  "mfa_required",
  "governance_unavailable",
  "gateway_unavailable",
  "invalid_ai_result",
]);

function safeOpportunities(rows, capabilities) {
  if (!Array.isArray(rows) || rows.length > 8) return null;
  const safe = [];
  for (const row of rows) {
    const keys = row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row).sort() : [];
    if (keys.join(":") !== "candidateCount:covered:scope:thresholdDays:triggerKind"
        || !capabilities.triggers.includes(row.triggerKind)
        || !Number.isSafeInteger(row.candidateCount) || row.candidateCount < 0 || row.candidateCount > 9999
        || !Number.isSafeInteger(row.thresholdDays) || row.thresholdDays < 0 || row.thresholdDays > capabilities.maxThresholdDays
        || !["chapter", "organization"].includes(row.scope)
        || typeof row.covered !== "boolean") return null;
    safe.push({
      triggerKind: row.triggerKind,
      candidateCount: row.candidateCount,
      thresholdDays: row.thresholdDays,
      scope: row.scope,
      covered: row.covered,
    });
  }
  return safe;
}

export async function requestAutomationDraft({
  accessToken,
  intent,
  capabilities,
  opportunities = [],
  locale = "en",
  signal,
} = {}) {
  const installed = normalizeAutomationCapabilities(capabilities);
  const safeRows = installed ? safeOpportunities(opportunities, installed) : null;
  if (!accessToken) return { ok: false, reason: "unauthorized" };
  if (!installed || installed.schemaVersion !== 2 || !safeRows) return { ok: false, reason: "invalid_ai_result" };

  try {
    const response = await fetch("/api/guide", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "automation_draft",
        intent,
        capabilityVersion: installed.schemaVersion,
        triggers: [...installed.triggers],
        actions: [...installed.actions],
        opportunities: safeRows,
        locale,
      }),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload.code === "compass_paused"
        ? "governance_unavailable"
        : reasons.has(payload.code)
          ? payload.code
          : response.status === 401
            ? "unauthorized"
            : "gateway_unavailable";
      return { ok: false, reason };
    }
    const proposal = normalizeAutomationProposal(payload.proposal, installed);
    if (!proposal) return { ok: false, reason: "invalid_ai_result" };
    return { ok: true, proposal, meta: payload.meta ?? null };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "aborted" : "gateway_unavailable" };
  }
}
