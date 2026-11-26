import { createHash } from "node:crypto";
import { accountEmailDomainBlocked } from "./_lib/accountEmailDomains.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { bearerToken, json, requireEnv, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { digest, invitationSecret, invitationUrl, sendInvitationEmail } from "./_lib/memberInvitations.js";
import {
  SCIM_CONTENT_TYPE, SCIM_ID, SCIM_TOKEN, ScimError, applyGroupPatch, applyUserPatch, errorBody,
  listResponse, normalizeGroup, normalizeUser, pageParameters, parseBody, parseFilter, resourceTypes,
  routeOf, schemas, serviceProviderConfig, toGroupResource, toUserResource,
} from "./_lib/scim.js";

// SCIM 2.0 service (RFC 7643/7644) for REQ-UG-SCIM-PROVISIONING-20261001,
// reached as /scim/v2/* through the vercel.json rewrite.
//
// The caller is an identity provider (Okta, Microsoft Entra ID, Google), not a
// browser: it authenticates with the organization-scoped bearer token an
// organization admin issued on Integrations > SCIM. Only the token's SHA-256
// digest leaves this process. public.scim_authenticate resolves the
// organization, refuses a revoked/expired token, a suspended organization and
// a switched-off features.integrations.scim, and charges the per-token request
// budget. Every later RPC is scoped to that organization; a caller-supplied
// organization id is never read.
//
// Provisioning stays invitation-only: creating a User sends the person the
// same one-time invitation an admin sends (api/admin-invitations.js), and
// deprovisioning (active=false or DELETE) revokes the organization membership.
// Production only: the SAMPLE surface has no accept flow.
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function send(response, status, body, headers = {}) {
  response.status(status);
  response.setHeader("Content-Type", SCIM_CONTENT_TYPE);
  response.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function fail(response, status, detail, scimType, headers) {
  send(response, status, errorBody(status, detail, scimType), headers);
}

function routedPath(request) {
  const fromQuery = request.query?.scimPath;
  if (typeof fromQuery === "string") return fromQuery;
  if (Array.isArray(fromQuery)) return fromQuery.join("/");
  const url = String(request.url || "");
  const match = /^\/scim\/v2\/?([^?]*)/.exec(url);
  return match ? match[1] : "";
}

function rpcFailure(error) {
  const status = Number(error?.status || 0);
  if (error?.code === "23505") return new ScimError(409, "the account already has a SCIM identity in this organization", "uniqueness");
  if (error?.code === "P0001") return new ScimError(429, "the organization's daily SCIM invitation budget is spent; retry tomorrow", "tooMany");
  if (status === 400 || status === 422) return new ScimError(400, "the request was refused", "invalidValue");
  return new ScimError(503, "SCIM provisioning is temporarily unavailable");
}

// Test seam: the same handler with injected RPC, mail and environment.
export function createScimHandler(deps = {}) {
  return (request, response) => {
    if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
    return serve(request, response, deps);
  };
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  return serve(request, response, {});
}

async function serve(request, response, { rpc = supabaseRpc, sendInvitation = sendInvitationEmail, env = process.env }) {
  if (!METHODS.has(request.method)) return fail(response, 405, "method not allowed");
  const backend = resolveSupabaseBackend(request, env);
  if (backend.surface === "demo") return fail(response, 404, "SCIM is not available on this host");
  const config = {
    url: backend.url,
    serviceKey: backend.serviceRoleKey,
    resendKey: env.RESEND_API_KEY,
    from: env.NOTIFY_FROM_ADDRESS,
    appOrigin: String(env.INVITATION_APP_ORIGIN || "").replace(/\/$/, ""),
  };
  if (requireEnv(Object.values(config), () => fail(response, 503, "SCIM provisioning is not configured on this deployment"))) return;
  const baseUrl = `${config.appOrigin}/scim/v2`;
  const call = (name, body) => rpc(config.url, config.serviceKey, config.serviceKey, name, body);

  const token = bearerToken(request);
  if (!SCIM_TOKEN.test(token)) return fail(response, 401, "a SCIM bearer token is required", undefined, { "WWW-Authenticate": "Bearer" });
  let identity;
  try {
    identity = await call("scim_authenticate", { p_token_hash: createHash("sha256").update(token).digest("hex") });
  } catch {
    return fail(response, 503, "SCIM provisioning is temporarily unavailable");
  }
  if (!identity) return fail(response, 401, "the SCIM token is not valid", undefined, { "WWW-Authenticate": "Bearer" });
  if (identity.state === "disabled") return fail(response, 403, "SCIM provisioning is switched off for this organization");
  if (identity.state === "limited") return fail(response, 429, "too many requests for this token", "tooMany", { "Retry-After": "60" });
  if (identity.state !== "ok" || !SCIM_ID.test(String(identity.organizationId || ""))) {
    return fail(response, 503, "SCIM provisioning is temporarily unavailable");
  }
  const organizationId = identity.organizationId;

  const route = routeOf(routedPath(request));
  if (!route) return fail(response, 404, "unknown SCIM resource");

  try {
    if (route.resource === "ServiceProviderConfig" || route.resource === "ResourceTypes" || route.resource === "Schemas" || route.resource === "") {
      if (request.method !== "GET") return fail(response, 405, "method not allowed");
      return discovery(response, route, baseUrl, config.appOrigin);
    }
    if (route.resource === "Users") return await users(request, response, route, { call, organizationId, baseUrl, config, sendInvitation });
    return await groups(request, response, route, { call, organizationId, baseUrl });
  } catch (error) {
    const failure = error instanceof ScimError ? error : rpcFailure(error);
    return fail(response, failure.status, failure.message, failure.scimType,
      failure.status === 429 ? { "Retry-After": "3600" } : {});
  }
}

function discovery(response, route, baseUrl, appOrigin) {
  if (route.resource === "ServiceProviderConfig" || route.resource === "") {
    return send(response, 200, serviceProviderConfig(baseUrl, `${appOrigin}/m/integrations/scim`));
  }
  if (route.resource === "ResourceTypes") {
    const types = resourceTypes(baseUrl);
    if (!route.id) return send(response, 200, listResponse(types, types.length, 1));
    const type = types.find((item) => item.id === route.id);
    return type ? send(response, 200, type) : fail(response, 404, "unknown resource type");
  }
  const all = schemas(baseUrl);
  if (!route.id) return send(response, 200, listResponse(all, all.length, 1));
  const schema = all.find((item) => item.id === route.id);
  return schema ? send(response, 200, schema) : fail(response, 404, "unknown schema");
}

async function deliver(context, invitation) {
  if (!invitation?.send) return;
  const { config, call, organizationId, sendInvitation } = context;
  let sent;
  try {
    sent = await sendInvitation({
      resendKey: config.resendKey,
      from: config.from,
      to: invitation.email,
      locale: invitation.locale === "es" ? "es" : "en",
      link: invitationUrl(config.appOrigin, invitation.secret),
      appOrigin: config.appOrigin,
      invitationId: invitation.invitationId,
      deliveryVersion: invitation.deliveryVersion,
      names: { source: "scim" },
      organizationLookup: { supabaseUrl: config.url, serviceKey: config.serviceKey, organizationId },
    });
  } catch {
    sent = false;
  }
  // The directory change is already committed. A delivery that could not be
  // recorded leaves a pending invitation that expires in 15 minutes and is
  // replaced on the next sync, so the provider still gets its answer.
  await call("scim_record_invitation_delivery", {
    p_organization_id: organizationId,
    p_invitation_id: invitation.invitationId,
    p_delivery_version: invitation.deliveryVersion,
    p_outcome: sent ? "sent" : "failed",
  }).catch(() => null);
}

// The database names the constraint that refused a write (20261022061913). A
// database without that label answers as before: a userName conflict.
function userConflict(constraint) {
  if (constraint === "binding") return new ScimError(409, "the account already has a SCIM identity in this organization", "uniqueness");
  if (constraint === "other") return new ScimError(409, "the User conflicts with an existing directory record", "uniqueness");
  return new ScimError(409, "a User with this userName already exists", "uniqueness");
}

// A directory may not provision a new account on a government or employer
// address (REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102).
// Existing holders of that address are never refused: a User that already has
// it, an Auth account or pending invitation that already holds it (linking or
// a former member's reactivation creates no account), and any deprovisioning
// write, which sends no invitation and would otherwise leave the membership
// active. Acceptance and the auth.users trigger still refuse a new account.
async function refuseBlockedAddress(context, id, user) {
  if (user.active === false || !accountEmailDomainBlocked(user.userName)) return;
  if (id) {
    const row = await context.call("scim_get_user", { p_organization_id: context.organizationId, p_user_id: id });
    if (row && String(row.userName || "").toLowerCase() === user.userName) return;
  }
  const available = await context.call("open_signup_email_available", {
    p_email_hash: createHash("sha256").update(user.userName).digest("hex"),
  });
  if (available !== true) return;
  throw new ScimError(400, "Government and employer email addresses can't be used for a Union Ground account; use a personal email address", "invalidValue");
}

async function upsertUser(context, id, resource, options) {
  const user = normalizeUser(resource, options);
  await refuseBlockedAddress(context, id, user);
  const secret = invitationSecret();
  const result = await context.call("scim_upsert_user", {
    p_organization_id: context.organizationId,
    p_user_id: id,
    p_user: user,
    p_token_hash: digest(secret),
  });
  if (result?.outcome === "conflict") throw userConflict(result.conflict);
  if (result?.outcome === "not_found") throw new ScimError(404, "User not found");
  if (!result?.user) throw new ScimError(503, "SCIM provisioning is temporarily unavailable");
  if (result.user.active === false && result.user.state !== "deprovisioned") {
    throw new ScimError(409, "User could not be deprovisioned", "mutability");
  }
  await deliver(context, result.invitation ? { ...result.invitation, secret } : null);
  return result;
}

async function users(request, response, route, context) {
  const { call, organizationId, baseUrl } = context;
  const body = ["POST", "PUT", "PATCH"].includes(request.method) ? parseBody(request.body) : null;
  if (!route.id) {
    if (request.method === "GET") {
      const filter = parseFilter(request.query?.filter, "Users");
      const page = pageParameters(request.query);
      if (filter && filter.value === null) return send(response, 200, listResponse([], 0, page.startIndex));
      const result = await call("scim_list_users", {
        p_organization_id: organizationId,
        p_field: filter?.field ?? null,
        p_value: filter?.value ?? null,
        p_start_index: page.startIndex,
        p_count: page.count,
      });
      const items = Array.isArray(result?.items) ? result.items.map((row) => toUserResource(row, baseUrl)) : [];
      return send(response, 200, listResponse(items, Number(result?.totalResults || 0), page.startIndex));
    }
    if (request.method === "POST") {
      const result = await upsertUser(context, null, body);
      const resource = toUserResource(result.user, baseUrl);
      return send(response, 201, resource, { Location: resource.meta.location });
    }
    return fail(response, 405, "method not allowed");
  }
  if (!SCIM_ID.test(route.id)) return fail(response, 404, "User not found");
  if (request.method === "GET") {
    const row = await call("scim_get_user", { p_organization_id: organizationId, p_user_id: route.id });
    return row ? send(response, 200, toUserResource(row, baseUrl)) : fail(response, 404, "User not found");
  }
  if (request.method === "PUT") {
    const result = await upsertUser(context, route.id, body, { preferEmailAttribute: true });
    return send(response, 200, toUserResource(result.user, baseUrl));
  }
  if (request.method === "PATCH") {
    const row = await call("scim_get_user", { p_organization_id: organizationId, p_user_id: route.id });
    if (!row) return fail(response, 404, "User not found");
    const next = applyUserPatch(toUserResource(row, baseUrl), body);
    const result = await upsertUser(context, route.id, next);
    return send(response, 200, toUserResource(result.user, baseUrl));
  }
  if (request.method === "DELETE") {
    const result = await call("scim_delete_user", { p_organization_id: organizationId, p_user_id: route.id });
    if (result?.deleted === true && !result.reason) return send(response, 204);
    if (result?.reason && result.reason !== "last_organization_admin") {
      return fail(response, 409, "User could not be deprovisioned", "mutability");
    }
    if (result?.reason === "last_organization_admin") {
      return fail(response, 409, "the organization's only admin cannot be deprovisioned; add another admin first", "mutability");
    }
    return fail(response, 404, "User not found");
  }
  return fail(response, 405, "method not allowed");
}

// A group PATCH reads the group, applies its operations here and replaces the
// whole member set, so it names the version it read. If another write landed
// in between, the database changes nothing and answers version_conflict, and
// the PATCH re-reads and reapplies; otherwise one of two concurrent PATCHes
// would drop the other's member
// (BUG-UG-SCIM-CONCURRENT-GROUP-PATCH-LOST-MEMBERS-20261020).
const GROUP_PATCH_ATTEMPTS = 3;
const VERSION_CONFLICT = Symbol("version-conflict");
// PostgREST answers PGRST202 for a parameter the deployed function lacks: the
// version guard's migration is not applied yet, so write as before.
const missingFunction = (error) => Number(error?.status) === 404 && String(error?.code ?? "") === "PGRST202";

async function writeGroup(call, organizationId, id, group, expectedVersion = null) {
  const params = {
    p_organization_id: organizationId,
    p_group_id: id,
    p_display_name: group.displayName,
    p_external_id: group.externalId,
    p_members: group.members,
  };
  let result;
  try {
    result = await call("scim_upsert_group", expectedVersion === null ? params : { ...params, p_expected_version: expectedVersion });
  } catch (error) {
    if (expectedVersion === null || !missingFunction(error)) throw error;
    result = await call("scim_upsert_group", params);
  }
  if (result?.outcome === "version_conflict") return VERSION_CONFLICT;
  if (result?.outcome === "conflict") throw new ScimError(409, "a Group with this displayName already exists", "uniqueness");
  if (result?.outcome === "not_found") throw new ScimError(404, "Group not found");
  if (result?.outcome === "unknown_member") throw new ScimError(400, "every member must be a User of this organization", "invalidValue");
  if (!result?.group) throw new ScimError(503, "SCIM provisioning is temporarily unavailable");
  return result.group;
}

async function groups(request, response, route, { call, organizationId, baseUrl }) {
  const body = ["POST", "PUT", "PATCH"].includes(request.method) ? parseBody(request.body) : null;
  const excludeMembers = String(request.query?.excludedAttributes || "").split(",").map((item) => item.trim().toLowerCase()).includes("members");
  if (!route.id) {
    if (request.method === "GET") {
      const filter = parseFilter(request.query?.filter, "Groups");
      const page = pageParameters(request.query);
      if (filter && filter.value === null) return send(response, 200, listResponse([], 0, page.startIndex));
      const result = await call("scim_list_groups", {
        p_organization_id: organizationId,
        p_field: filter?.field ?? null,
        p_value: filter?.value ?? null,
        p_start_index: page.startIndex,
        p_count: page.count,
        p_include_members: !excludeMembers,
      });
      const items = Array.isArray(result?.items) ? result.items.map((row) => toGroupResource(row, baseUrl, { excludeMembers })) : [];
      return send(response, 200, listResponse(items, Number(result?.totalResults || 0), page.startIndex));
    }
    if (request.method === "POST") {
      const group = await writeGroup(call, organizationId, null, normalizeGroup(body));
      const resource = toGroupResource(group, baseUrl);
      return send(response, 201, resource, { Location: resource.meta.location });
    }
    return fail(response, 405, "method not allowed");
  }
  if (!SCIM_ID.test(route.id)) return fail(response, 404, "Group not found");
  if (request.method === "GET") {
    const row = await call("scim_get_group", { p_organization_id: organizationId, p_group_id: route.id });
    return row ? send(response, 200, toGroupResource(row, baseUrl, { excludeMembers })) : fail(response, 404, "Group not found");
  }
  if (request.method === "PUT") {
    const group = await writeGroup(call, organizationId, route.id, normalizeGroup(body));
    return send(response, 200, toGroupResource(group, baseUrl));
  }
  if (request.method === "PATCH") {
    for (let attempt = 1; attempt <= GROUP_PATCH_ATTEMPTS; attempt += 1) {
      const row = await call("scim_get_group", { p_organization_id: organizationId, p_group_id: route.id });
      if (!row) return fail(response, 404, "Group not found");
      const next = applyGroupPatch(row, body);
      const group = await writeGroup(call, organizationId, route.id, normalizeGroup(next), Number.isSafeInteger(row.version) ? row.version : null);
      // RFC 7644 3.5.2: 204 is allowed; Entra ID and Okta both accept 200 with the resource.
      if (group !== VERSION_CONFLICT) return send(response, 200, toGroupResource(group, baseUrl, { excludeMembers }));
    }
    return fail(response, 409, "the Group changed while this request was applied; retry the request");
  }
  if (request.method === "DELETE") {
    const result = await call("scim_delete_group", { p_organization_id: organizationId, p_group_id: route.id });
    return result?.deleted ? send(response, 204) : fail(response, 404, "Group not found");
  }
  return fail(response, 405, "method not allowed");
}
