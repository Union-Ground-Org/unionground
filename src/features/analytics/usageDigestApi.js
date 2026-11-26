// REQ-UG-AI-USAGE-DIGEST-20261001 — the two calls the usage digest panel
// makes. The server derives the organization from the session and verifies the
// hat; no organization id, member id or raw count is sent.
//
// The read runs only when a staff member opens the analytics Usage view, so it
// never fires on a passive page load.
export async function loadUsageDigests(client, hat) {
  if (!client || typeof client.rpc !== "function") throw new Error("usage-digest-unavailable");
  const { data, error } = await client.rpc("get_analytics_usage_digests", { p_selected_hat: hat });
  if (error) throw error;
  return data;
}

// The optional Compass wording runs through the governed server path
// (api/guide.js, mode usage_digest): quota reservation, dispatch
// authorization, mesh with Fireworks failover, and an aggregate-only payload
// the database assembles.
export async function requestUsageDigestWording(session, hat, digestId, fetcher = globalThis.fetch) {
  if (!session?.access_token) throw Object.assign(new Error("session_expired"), { status: 401 });
  const response = await fetcher("/api/guide", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "usage_digest", hat, digestId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || "compass_unavailable"), { status: response.status, code: payload.code ?? null });
  }
  return payload;
}
