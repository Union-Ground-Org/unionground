// Client calls for the organization Google activations panel
// (REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001).

import { MemberApiError } from "../../lib/memberApiError.js";

class GoogleActivationError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function accessToken(client) {
  const { data, error } = await client.auth.getSession();
  if (error || !data?.session?.access_token) throw new GoogleActivationError("Session unavailable", 401);
  return data.session.access_token;
}

async function activationRequest(client, action) {
  const response = await fetch(`/api/google-activations?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(client)}`, "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new GoogleActivationError(result?.error || `HTTP ${response.status}`, response.status), { siteAddress: result?.siteAddress });
  }
  return result;
}

// A connect finishes only in the browser and on the host that started it
// (#9557). Started from another host (a deployment or preview address), the
// route names the site address; open the same page there to connect.
function openOnSiteAddress(error, path) {
  const site = String(error?.siteAddress || "");
  if (error?.message !== "use-site-address" || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site) || site === globalThis.location?.origin) return false;
  globalThis.location?.assign(`${site}${path}`);
  return true;
}

function unwrap({ data, error }, label) {
  if (error) throw new MemberApiError(label, error);
  return data;
}

export async function loadGoogleActivations(client) {
  const result = await activationRequest(client, "status");
  return {
    calendar: {
      configured: result?.calendar?.configured === true,
      enabled: result?.calendar?.enabled === true,
      scope: result?.calendar?.scope === "all_events" ? "all_events" : "public_events",
      connection: result?.calendar?.connection && typeof result.calendar.connection === "object" ? result.calendar.connection : null,
      copiedEvents: Number(result?.calendar?.copiedEvents || 0),
      failingEvents: Number(result?.calendar?.failingEvents || 0),
    },
  };
}

export async function startOrganizationCalendarConnection(client) {
  let result;
  try {
    result = await activationRequest(client, "calendar-start");
  } catch (error) {
    if (openOnSiteAddress(error, "/m/integrations")) return;
    throw error;
  }
  if (!/^https:\/\/accounts\.google\.com\//.test(result?.authorizationUrl || "")) {
    throw new GoogleActivationError("Google authorization URL is invalid");
  }
  globalThis.location?.assign(result.authorizationUrl);
}

export function saveOrganizationCalendarId(client, calendarId) {
  const value = String(calendarId || "").trim();
  if (!/^[A-Za-z0-9._@#+-]{1,255}$/.test(value)) return Promise.reject(new GoogleActivationError("Invalid calendar id"));
  return client.rpc("set_organization_calendar_push_calendar", { p_calendar_id: value })
    .then((result) => unwrap(result, "Save organization calendar"));
}

export async function disconnectOrganizationCalendar(client) {
  return unwrap(await client.rpc("disconnect_organization_calendar_push", {}), "Disconnect organization calendar");
}
