import { normalizeIssueSignals, normalizeWeeklyDigests } from "./model.js";

// The only read: the server derives the organization from the session and
// verifies the hat. No organization id, count or text is sent or received.
export async function loadIssueSignals(client, hat = "member") {
  if (!client || typeof client.rpc !== "function") throw new Error("issue-intelligence-unavailable");
  const { data, error } = await client.rpc("get_issue_intelligence_signals", { p_selected_hat: hat });
  if (error) throw error;
  return normalizeIssueSignals(data);
}

// REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001: latest stored digest
// per family for a staff hat the caller holds.
export async function loadWeeklyDigests(client, hat) {
  if (!client || typeof client.rpc !== "function") throw new Error("issue-intelligence-unavailable");
  const { data, error } = await client.rpc("get_issue_intelligence_weekly_digests", { p_selected_hat: hat });
  if (error) throw error;
  return normalizeWeeklyDigests(data);
}

// The optional Compass summary runs through the governed server path
// (api/guide.js, mode issue_digest): quota reservation, dispatch
// authorization and an aggregate-only payload the database assembles.
export async function requestDigestSummary(session, hat, digestId, fetcher = globalThis.fetch) {
  if (!session?.access_token) throw Object.assign(new Error("session_expired"), { status: 401 });
  const response = await fetcher("/api/guide", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "issue_digest", hat, digestId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || "compass_unavailable"), { status: response.status, code: payload.code ?? null });
  return payload;
}
