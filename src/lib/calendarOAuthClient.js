import { withLoadDeadline } from "./loadDeadline.js";

async function sessionToken(client) {
  const { data, error } = await client.auth.getSession();
  const token = data?.session?.access_token;
  if (error || !token) throw new Error("Sign in to manage calendar sync.");
  return token;
}

// Keep the shared ten-second action deadline through session resolution,
// response headers and body consumption. Expiry also cancels fetch; a session
// read that resolves later must never issue an abandoned OAuth-start POST.
async function request(client, fetcher, init = {}) {
  const controller = new AbortController();
  try {
    return await withLoadDeadline(async () => {
      const token = await sessionToken(client);
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetcher("/api/calendar-oauth", {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      return { response, payload };
    });
  } catch (error) {
    controller.abort(error);
    throw error;
  }
}

export async function loadCalendarOAuthStatus(client, fetcher = fetch) {
  const { response, payload } = await request(client, fetcher);
  if (!response.ok || !payload?.ok) {
    return { ok: false, error: payload?.error || "catalog_unavailable" };
  }
  return payload;
}

export async function startCalendarOAuth(client, provider, fetcher = fetch) {
  const { response, payload } = await request(client, fetcher, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ provider }),
  });
  if (response.status === 409) {
    return { ok: false, error: "activation_unset", provider };
  }
  if (!response.ok || !payload?.ok) {
    return { ok: false, error: payload?.error || "catalog_unavailable" };
  }
  return payload;
}
