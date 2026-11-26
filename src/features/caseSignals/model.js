// Case queue next actions (REQ-UG-CASE-QUEUE-SIGNALS-AND-NEXT-ACTION-20261001)
// and the steward attention queue (REQ-UG-STEWARD-ATTENTION-TREND-20261001).
//
// The server ranks and authorizes; this module only validates the projection,
// computes the device-local "since your last visit" trend (old
// de7df4b57c^:lib/attention/trends.ts) and builds command-palette shortcuts
// (old lib/dashboard/cmdk-resolver.ts:37-72).

export const NEXT_ACTION_KINDS = Object.freeze(["deadline_risk", "missing_owner", "stale_contact", "missing_evidence", "weak_strength"]);
const SEVERITIES = ["critical", "high", "medium", "low"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = (value) => (Number.isInteger(value) ? value : null);
const text = (value, max = 200) => (typeof value === "string" && value.length <= max ? value : null);

export function normalizeNextActions(payload) {
  const empty = { enabled: false, items: [], summary: { total: 0, urgent: 0, missingOwner: 0 } };
  if (!payload || typeof payload !== "object" || payload.enabled !== true) return empty;
  const seen = new Set();
  const items = (Array.isArray(payload.items) ? payload.items : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || seen.has(raw.id)) return [];
    if (!NEXT_ACTION_KINDS.includes(raw.kind)) return [];
    seen.add(raw.id);
    return [{
      id: raw.id,
      kind: raw.kind,
      severity: SEVERITIES.includes(raw.severity) ? raw.severity : "medium",
      caseId: text(raw.caseId, 64),
      reference: text(raw.reference, 120),
      memberId: text(raw.memberId, 64),
      memberName: text(raw.memberName, 200) || "",
      dueDate: typeof raw.dueDate === "string" && ISO_DATE.test(raw.dueDate) ? raw.dueDate : null,
      // Which deadline dueDate is (BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110):
      // an open step deadline with its label, or the case's own deadline.
      dueKind: raw.dueKind === "step" || raw.dueKind === "case" ? raw.dueKind : null,
      dueLabel: text(raw.dueLabel, 200),
      days: int(raw.days),
      strength: int(raw.strength),
      openCases: int(raw.openCases),
      lastContactDays: int(raw.lastContactDays),
      // BUG-UG-WHAT-TO-DO-NEXT-DEADLINE-ITEM-DROPS-NO-EVIDENCE-20261124
      // (#9901): a deadline item inside the evidence window with no evidence
      // says so, since the case no longer raises a missing-evidence item too.
      noEvidence: raw.kind === "deadline_risk" && raw.noEvidence === true,
    }];
  });
  const summary = payload.summary && typeof payload.summary === "object" ? payload.summary : {};
  return {
    enabled: true,
    items,
    summary: {
      total: int(summary.total) ?? items.length,
      urgent: int(summary.urgent) ?? items.filter((item) => item.severity === "critical" || item.severity === "high").length,
      missingOwner: int(summary.missingOwner) ?? 0,
    },
  };
}

export function normalizeAttention(payload) {
  const empty = { enabled: false, members: [], count: 0, memberSurfaces: false, navigation: false, dominantReason: null, breakdown: { dueSoon: 0, openWithoutDeadlineRisk: 0 } };
  if (!payload || typeof payload !== "object" || payload.enabled !== true) return empty;
  const members = (Array.isArray(payload.members) ? payload.members : []).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.memberId !== "string") return [];
    const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((reason) => reason === "deadline_risk" || reason === "open_case") : [];
    return [{
      memberId: raw.memberId,
      memberName: text(raw.memberName, 200) || "",
      openCases: int(raw.openCases) ?? 1,
      reasons,
      urgency: int(raw.urgency) ?? 0,
      caseId: text(raw.caseId, 64),
      reference: text(raw.reference, 120),
      days: int(raw.days),
    }];
  });
  const breakdown = payload.breakdown && typeof payload.breakdown === "object" ? payload.breakdown : {};
  return {
    enabled: true,
    members,
    count: int(payload.count) ?? members.length,
    memberSurfaces: payload.memberSurfaces === true,
    navigation: payload.navigation === true,
    dominantReason: payload.dominantReason === "deadline_risk" || payload.dominantReason === "open_case" ? payload.dominantReason : null,
    breakdown: { dueSoon: int(breakdown.dueSoon) ?? 0, openWithoutDeadlineRisk: int(breakdown.openWithoutDeadlineRisk) ?? 0 },
  };
}

// Old buildTrendSummary: no headline without a previous visit; "No change",
// or "Up/Down N since your last visit" plus the main reason.
export function attentionTrend(previousCount, currentCount, dominantReason) {
  if (!Number.isInteger(previousCount) || !Number.isInteger(currentCount)) return null;
  const diff = currentCount - previousCount;
  if (diff === 0) return { direction: "same", magnitude: 0, reason: null };
  return { direction: diff > 0 ? "up" : "down", magnitude: Math.abs(diff), reason: dominantReason };
}

// Device-local visit snapshot. The product keeps no per-person page-view log,
// so the previous visit's count lives only on this device for this account,
// organization and hat.
const SNAPSHOT_PREFIX = "ug.attention.visit.v1";

export function attentionSnapshotKey({ userId, organizationId, hat }) {
  if (!userId || !organizationId || !hat) return null;
  return `${SNAPSHOT_PREFIX}:${userId}:${organizationId}:${hat}`;
}

export function readAttentionSnapshot(storage, key) {
  if (!storage || !key) return null;
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null");
    return parsed && Number.isInteger(parsed.count) && parsed.count >= 0 ? { count: parsed.count, at: typeof parsed.at === "string" ? parsed.at : null } : null;
  } catch {
    return null;
  }
}

export function writeAttentionSnapshot(storage, key, count, now = new Date()) {
  if (!storage || !key || !Number.isInteger(count)) return;
  try {
    storage.setItem(key, JSON.stringify({ count, at: now.toISOString() }));
  } catch {
    // Storage may be full or disabled; the trend simply starts over.
  }
}

// Organization switches the member-safe configuration carries
// (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 `switches`). A missing
// configuration or key reads as off; the server enforces every switch.
export function organizationSwitchOn(configuration, key) {
  const switches = configuration?.switches;
  return Boolean(switches && typeof switches === "object" && switches[key] === true);
}

export const ATTENTION_SHORTCUTS = Object.freeze([
  { id: "attention", labelKey: "caseSignals.shortcut.attention", keywords: ["who needs attention", "needs attention today", "needs attention"] },
  { id: "actions", labelKey: "caseSignals.shortcut.actions", keywords: ["what needs action", "action today", "next action"] },
  { id: "risk", labelKey: "caseSignals.shortcut.risk", keywords: ["grievance risk", "open grievance risk", "deadline risk"] },
]);

// Old resolveIntentShortcuts: only with the navigation switch (and its master)
// on, and only for the steward desk that hosts the attention queue.
export function attentionShortcutsEnabled(configuration, hat) {
  return hat === "steward"
    && organizationSwitchOn(configuration, "features.attention.guided_portal")
    && organizationSwitchOn(configuration, "features.attention.dashboard")
    && organizationSwitchOn(configuration, "features.attention.navigation");
}

// The next-actions projection read (REQ-UG-CASE-QUEUE-SIGNALS-AND-NEXT-ACTION-20261001),
// here rather than in CaseSignals.jsx so the shell can start it before the desk
// mounts without loading the panel (#9840). The literal RPC name keeps the
// read-RPC drift guard able to see the call.
export async function readNextActions(client, hat) {
  const { data, error } = await client.rpc("get_case_queue_next_actions", { p_selected_hat: hat, p_limit: 25 });
  if (error) throw error;
  return normalizeNextActions(data);
}
