import { SCIM_TOKEN_PREFIX, generateSecret, hashSecret, oneTimeSecretEnvelope } from "./secrets.js";

// SCIM 2.0 directory provisioning (REQ-UG-SCIM-PROVISIONING-20261001).
// (2026-10-01) brought SCIM back as an unset activation
// inside the Invitation-only accounts contract. CR-094 had shipped the token
// custody behind SCIM_SHIP_GATE = 'disabled_enterprise_later'; that gate is now
// the organization switch features.integrations.scim (default off), enforced
// by the database (public.issue_scim_token, public.scim_authenticate) and by
// api/scim.js. The organization admin turns it on, picks a default chapter,
// issues a token and points the identity provider at the endpoint.

export const SCIM_PROTOCOL_VERSION = "2.0";
export const SCIM_SWITCH_KEY = "features.integrations.scim";
const SCIM_ENDPOINT_PATH = "/scim/v2";
// Old app: app/dashboard/admin/integrations/registry-client.tsx issued
// 90-day SCIM tokens (issueScimToken({ expiresInDays: 90 })).
export const SCIM_TOKEN_LIFETIME_DAYS = 90;
// A steward needs a chapter unit, which a directory group cannot
// supply, so stewards are granted on Chapter access, never through SCIM.
export const SCIM_MAPPABLE_ROLES = Object.freeze(["coordinator", "advisor"]);
// The generic provider controls (Request setup, chapter overrides, jobs) do
// not apply to SCIM; its setup lives on the SCIM tab.
export const SCIM_GENERIC_PROVIDER_REASON = "scim_setup_on_scim_tab";

const SCIM_RESOURCES = Object.freeze(["Users", "Groups"]);
const SCIM_USER_OPERATIONS = Object.freeze([
  "GET /Users",
  "GET /Users/{id}",
  "POST /Users",
  "PUT /Users/{id}",
  "PATCH /Users/{id}",
  "DELETE /Users/{id}",
]);
const SCIM_GROUP_OPERATIONS = Object.freeze([
  "GET /Groups",
  "GET /Groups/{id}",
  "POST /Groups",
  "PUT /Groups/{id}",
  "PATCH /Groups/{id}",
  "DELETE /Groups/{id}",
]);

export function scimEndpointUrl(origin = globalThis.location?.origin || "") {
  return `${String(origin).replace(/\/$/, "")}${SCIM_ENDPOINT_PATH}`;
}

// The static protocol description; live state (switch, tokens, groups) comes
// from public.get_scim_control().
export function getScimControlSurface() {
  return Object.freeze({
    switchKey: SCIM_SWITCH_KEY,
    // Native English copy: SCIM setup is a web-only organization admin task.
    publicMessage: "SCIM directory provisioning is set up by an organization admin on the website (Integrations, SCIM tab). It stays off until the organization turns it on, and it only sends invitations: nobody gets an account until they accept one.",
    protocol: Object.freeze({
      version: SCIM_PROTOCOL_VERSION,
      resources: SCIM_RESOURCES,
      userOperations: SCIM_USER_OPERATIONS,
      groupOperations: SCIM_GROUP_OPERATIONS,
      provisioning: "a new person receives the ordinary one-time invitation; nothing creates an account directly",
      deprovision: "active=false or DELETE revokes the organization membership; the account itself is never deleted",
      token: "hashed bearer token, displayed once, organization-scoped, 90-day lifetime",
    }),
  });
}

export function evaluateScimMutation() {
  return { ok: false, reason: SCIM_GENERIC_PROVIDER_REASON };
}

export async function buildScimTokenCustody({ expiresInDays = SCIM_TOKEN_LIFETIME_DAYS } = {}) {
  const plaintext = generateSecret(SCIM_TOKEN_PREFIX);
  const tokenHash = await hashSecret(plaintext);
  const oneTime = oneTimeSecretEnvelope(plaintext, SCIM_TOKEN_PREFIX);
  return {
    storage: { tokenHash, tokenPrefix: oneTime.prefix, expiresInDays },
    oneTime,
  };
}

export function matchScimBearer(presented, storedHash) {
  return hashSecret(presented).then((digest) => digest === storedHash);
}

// The ordered setup checklist the SCIM tab renders. Each step is done only
// when the server says so; nothing here is optimistic.
export function scimSetupSteps(control) {
  const liveTokens = (control?.tokens || []).filter((token) => !token.revokedAt
    && (!token.expiresAt || Date.parse(token.expiresAt) > Date.now()));
  const mapped = (control?.groups || []).some((group) => group.mappedRole);
  return [
    { id: "switch", done: control?.enabled === true },
    { id: "chapter", done: Boolean(control?.defaultChapterId) },
    { id: "token", done: liveTokens.length > 0 },
    { id: "provider", done: Number(control?.users?.total || 0) > 0 },
    { id: "roles", done: mapped, optional: true },
  ];
}
