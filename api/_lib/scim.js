// SCIM 2.0 protocol helpers (RFC 7643 core schema, RFC 7644 protocol) for
// api/scim.js (REQ-UG-SCIM-PROVISIONING-20261001).
//
// Pure functions only: request parsing, filter and PATCH evaluation, and the
// resource/ListResponse/Error shapes. The database decides what a SCIM change
// does to a person (an invitation, a reactivation invitation, a revoked
// membership); nothing here can grant access.
import { brandText } from "./brand.js";

import { languageFromTag } from "../../src/lib/languages.js";

export const SCIM_CONTENT_TYPE = "application/scim+json";
export const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCHEMA_SPC = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCHEMA_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

export const SCIM_TOKEN = /^ug_scim_[0-9a-f]{48}$/;
export const SCIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PAGE = 200;
export const MAX_GROUP_MEMBERS = 5000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Only applyUserPatch can attach this metadata; client JSON cannot forge it.
const DIRECTORY_USER_NAME = Symbol("SCIM directory userName");

export class ScimError extends Error {
  constructor(status, detail, scimType = undefined) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

export function errorBody(status, detail, scimType) {
  return {
    schemas: [SCHEMA_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

function hasControl(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function boundedText(value, max, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ScimError(400, `${field} must be a string`, "invalidValue");
  const text = value.trim();
  if (text.length > max || hasControl(text)) throw new ScimError(400, `${field} is not valid`, "invalidValue");
  return text;
}

// Azure AD sends booleans as the strings "True" / "False".
export function scimBoolean(value, field = "active") {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  throw new ScimError(400, `${field} must be a boolean`, "invalidValue");
}

function primaryEmail(emails) {
  if (!Array.isArray(emails)) return "";
  const usable = emails.filter((item) => item && typeof item.value === "string");
  const chosen = usable.find((item) => item.primary === true || item.primary === "true")
    || usable.find((item) => String(item.type || "").toLowerCase() === "work")
    || usable[0];
  return chosen ? chosen.value.trim().toLowerCase() : "";
}

// The address normalizeUser provisions for a PATCH result: the trimmed
// userName when it is an address, otherwise the primary/work email.
function canonicalAddress(user) {
  const userName = boundedText(user.userName, 254, "userName").toLowerCase();
  return EMAIL.test(userName) ? userName : primaryEmail(user.emails);
}

// Normalizes a User resource body into the fields the database stores. The
// email that receives the invitation is userName when it is an address,
// otherwise the primary/work email. A full PUT replacement carries the
// independent directory userName and work email that GET projects, so its
// explicit email takes precedence; omitted/empty emails retain the fallback.
export function normalizeUser(body, { preferEmailAttribute = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ScimError(400, "request body must be a User resource", "invalidSyntax");
  }
  const rawUserName = boundedText(body.userName, 254, "userName").toLowerCase();
  const email = preferEmailAttribute && Array.isArray(body.emails) && body.emails.length
    ? primaryEmail(body.emails)
    : EMAIL.test(rawUserName) ? rawUserName : primaryEmail(body.emails);
  if (!rawUserName) throw new ScimError(400, "userName is required", "invalidValue");
  if (!EMAIL.test(email) || email.length > 254) {
    throw new ScimError(400, "userName or a primary email must be an email address", "invalidValue");
  }
  const directoryUserName = boundedText(DIRECTORY_USER_NAME in body ? body[DIRECTORY_USER_NAME] : rawUserName, 254, "userName").toLowerCase();
  if (!directoryUserName) throw new ScimError(400, "userName is required", "invalidValue");
  const name = body.name && typeof body.name === "object" ? body.name : {};
  const givenName = boundedText(name.givenName, 80, "name.givenName");
  const familyName = boundedText(name.familyName, 80, "name.familyName");
  const formatted = boundedText(name.formatted, 120, "name.formatted");
  const displayName = boundedText(body.displayName, 120, "displayName");
  const externalId = boundedText(body.externalId, 255, "externalId");
  const active = body.active === undefined ? true : scimBoolean(body.active);
  return {
    userName: email,
    ...(directoryUserName !== email ? { directoryUserName } : {}),
    externalId: externalId || null,
    givenName: givenName || null,
    familyName: familyName || null,
    displayName: displayName || formatted || [givenName, familyName].filter(Boolean).join(" ") || null,
    active,
    locale: languageFromTag(body.preferredLanguage ?? body.locale),
  };
}

export function normalizeGroup(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ScimError(400, "request body must be a Group resource", "invalidSyntax");
  }
  const displayName = boundedText(body.displayName, 120, "displayName");
  if (!displayName) throw new ScimError(400, "displayName is required", "invalidValue");
  const externalId = boundedText(body.externalId, 255, "externalId");
  const members = body.members === undefined ? [] : memberIds(body.members);
  return { displayName, externalId: externalId || null, members };
}

function memberIds(value) {
  if (!Array.isArray(value)) throw new ScimError(400, "members must be an array", "invalidValue");
  const ids = [];
  for (const item of value) {
    const id = typeof item === "string" ? item : item?.value;
    if (typeof id !== "string" || !SCIM_ID.test(id)) throw new ScimError(400, "members[].value must be a User id", "invalidValue");
    if (!ids.includes(id.toLowerCase())) ids.push(id.toLowerCase());
  }
  if (ids.length > MAX_GROUP_MEMBERS) throw new ScimError(400, "too many group members", "tooMany");
  return ids;
}

// Supports the equality filters identity providers send for lookups:
// `userName eq "a@b.org"`, `externalId eq "x"`, `id eq "uuid"`,
// `emails.value eq "a@b.org"` (Users) and `displayName eq "x"` (Groups).
export function parseFilter(filter, resource) {
  if (filter === undefined || filter === null || filter === "") return null;
  if (typeof filter !== "string" || filter.length > 512) throw new ScimError(400, "filter is not supported", "invalidFilter");
  const match = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!match) throw new ScimError(400, "only `attribute eq \"value\"` filters are supported", "invalidFilter");
  const attribute = match[1].toLowerCase();
  const value = match[2].replace(/\\(.)/g, "$1");
  const allowed = resource === "Groups"
    ? { displayname: "displayName", externalid: "externalId", id: "id" }
    : { username: "userName", externalid: "externalId", id: "id", "emails.value": "emails.value" };
  const field = allowed[attribute];
  if (!field) throw new ScimError(400, `filtering on ${match[1]} is not supported`, "invalidFilter");
  if (field === "id" && !SCIM_ID.test(value)) return { field, value: null };
  return { field, value: field === "userName" || field === "emails.value" ? value.trim().toLowerCase() : value };
}

export function pageParameters(query = {}) {
  const startIndex = Number.parseInt(String(query.startIndex ?? "1"), 10);
  const count = Number.parseInt(String(query.count ?? "100"), 10);
  return {
    startIndex: Number.isFinite(startIndex) && startIndex > 0 ? startIndex : 1,
    count: Number.isFinite(count) ? Math.min(Math.max(count, 0), MAX_PAGE) : 100,
  };
}

function patchOperations(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.Operations ?? body.operations)) {
    throw new ScimError(400, "PATCH body must carry Operations", "invalidSyntax");
  }
  const operations = body.Operations ?? body.operations;
  if (operations.length === 0 || operations.length > 100) throw new ScimError(400, "PATCH must carry 1 to 100 operations", "invalidValue");
  return operations.map((operation) => {
    const op = String(operation?.op || "").toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, "op must be add, replace or remove", "invalidSyntax");
    const path = typeof operation.path === "string" ? operation.path.trim() : "";
    return { op, path, value: operation.value };
  });
}

// Applies a SCIM PATCH to the current User resource (as returned by
// toUserResource) and returns the body PUT would carry. Attributes this
// service does not store (for example the enterprise extension) are accepted
// and ignored so a directory sync does not stall on them.
export function applyUserPatch(current, body) {
  const next = {
    userName: primaryEmail(current.emails) || current.userName,
    [DIRECTORY_USER_NAME]: current.userName,
    externalId: current.externalId,
    name: { ...(current.name || {}) },
    displayName: current.displayName,
    active: current.active,
    preferredLanguage: current.preferredLanguage,
    emails: current.emails,
  };
  const setAttribute = (path, value, op) => {
    const key = path.toLowerCase();
    const cleared = op === "remove";
    if (key === "active") next.active = cleared ? false : scimBoolean(value);
    else if (key === "username") {
      if (!cleared) {
        // Retain legacy address renames while the two attributes agree.
        // Once a work-email update separates them, directory identity changes
        // must not undo that address or repeatedly revoke its invitation.
        const previous = boundedText(next[DIRECTORY_USER_NAME], 254, "userName").toLowerCase();
        const address = boundedText(next.userName, 254, "userName").toLowerCase();
        if (previous === address) next.userName = value;
        next[DIRECTORY_USER_NAME] = value;
      }
    }
    else if (key === "externalid") next.externalId = cleared ? null : value;
    else if (key === "displayname") next.displayName = cleared ? null : value;
    else if (key === "name.givenname") next.name.givenName = cleared ? null : value;
    else if (key === "name.familyname") next.name.familyName = cleared ? null : value;
    else if (key === "name.formatted") next.name.formatted = cleared ? null : value;
    else if (key === "name") next.name = cleared ? {} : { ...next.name, ...(value || {}) };
    else if (key === "preferredlanguage" || key === "locale") next.preferredLanguage = cleared ? null : value;
    else if (key === "emails" || /^emails\[.*\]\.value$/.test(key) || /^emails\[.*\]$/.test(key)) {
      // Preserve the existing directory compatibility no-ops. This repair
      // concerns acknowledged address changes, not email removal semantics.
      if (cleared) return;
      if (key !== "emails") {
        const filter = /^emails\[\s*(type|primary|value)\s+eq\s+(?:"([^"\\]*)"|(true|false))\s*\](?:\.value)?$/.exec(key);
        if (!filter) throw new ScimError(400, "email filter is not supported", "invalidPath");
        const actual = filter[1] === "type" ? "work" : filter[1] === "primary" ? true : canonicalAddress(next);
        const expected = filter[3] === undefined ? filter[2].trim() : filter[3] === "true";
        if (actual !== expected) throw new ScimError(400, "email filter matches no value", "noTarget");
      }
      const candidate = Array.isArray(value) ? primaryEmail(value) : typeof value === "string" ? value : value?.value;
      if (typeof candidate !== "string" || !candidate.trim()) return;
      const address = boundedText(candidate, 254, "emails.value").toLowerCase();
      if (!EMAIL.test(address)) throw new ScimError(400, "emails.value must be an email address", "invalidValue");
      next.emails = [{ value: address, type: "work", primary: true }];
      // Provisioning uses the canonical work address; the directory's
      // independent userName is retained separately by normalizeUser.
      next.userName = address;
    }
  };
  for (const operation of patchOperations(body)) {
    if (!operation.path) {
      if (operation.op === "remove") throw new ScimError(400, "remove needs a path", "noTarget");
      if (!operation.value || typeof operation.value !== "object" || Array.isArray(operation.value)) {
        throw new ScimError(400, "a PATCH without a path needs an object value", "invalidValue");
      }
      const attributes = Object.entries(operation.value);
      const userName = attributes.find(([path]) => path.toLowerCase() === "username");
      if (userName) setAttribute(userName[0], userName[1], operation.op);
      for (const [path, value] of attributes) {
        if (path.toLowerCase() === "username") continue;
        if (path === "name" && value && typeof value === "object") setAttribute("name", value, operation.op);
        else setAttribute(path, value, operation.op);
      }
      // JSON members are unordered. An explicit work email updates the
      // work address, while userName updates the independent directory name.
    } else {
      setAttribute(operation.path, operation.value, operation.op);
    }
  }
  return next;
}

function memberFilterId(path) {
  const match = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
  return match ? match[1].toLowerCase() : null;
}

// Applies a SCIM PATCH to a Group and returns { displayName, externalId, members }.
export function applyGroupPatch(current, body) {
  const next = {
    displayName: current.displayName,
    externalId: current.externalId ?? null,
    members: [...(current.members || []).map((member) => String(member.value).toLowerCase())],
  };
  const addMembers = (value) => {
    for (const id of memberIds(Array.isArray(value) ? value : [value])) {
      if (!next.members.includes(id)) next.members.push(id);
    }
  };
  const removeMembers = (ids) => { next.members = next.members.filter((id) => !ids.includes(id)); };
  for (const operation of patchOperations(body)) {
    const path = operation.path.toLowerCase();
    const filtered = memberFilterId(operation.path);
    if (filtered) {
      if (operation.op === "remove") removeMembers([filtered]);
      else throw new ScimError(400, "a filtered members path supports remove only", "invalidPath");
    } else if (path === "members") {
      if (operation.op === "add") addMembers(operation.value);
      else if (operation.op === "replace") next.members = memberIds(Array.isArray(operation.value) ? operation.value : []);
      else if (operation.value === undefined) next.members = [];
      else removeMembers(memberIds(Array.isArray(operation.value) ? operation.value : [operation.value]));
    } else if (path === "displayname") {
      if (operation.op === "remove") throw new ScimError(400, "displayName is required", "mutability");
      next.displayName = operation.value;
    } else if (path === "externalid") {
      next.externalId = operation.op === "remove" ? null : operation.value;
    } else if (!path) {
      const value = operation.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScimError(400, "a PATCH without a path needs an object value", "invalidValue");
      if (value.displayName !== undefined) next.displayName = value.displayName;
      if (value.externalId !== undefined) next.externalId = value.externalId;
      if (value.members !== undefined) {
        if (operation.op === "add") addMembers(value.members);
        else next.members = memberIds(value.members);
      }
    }
    // Other attributes are not stored by this service and are ignored.
  }
  if (next.members.length > MAX_GROUP_MEMBERS) throw new ScimError(400, "too many group members", "tooMany");
  return next;
}

function meta(resourceType, row, location) {
  return {
    resourceType,
    created: row.createdAt,
    lastModified: row.updatedAt,
    location,
    version: `W/"${row.version ?? 1}"`,
  };
}

export function toUserResource(row, baseUrl) {
  const name = {};
  if (row.givenName) name.givenName = row.givenName;
  if (row.familyName) name.familyName = row.familyName;
  const formatted = [row.givenName, row.familyName].filter(Boolean).join(" ");
  if (formatted) name.formatted = formatted;
  return {
    schemas: [SCHEMA_USER],
    id: row.id,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    userName: row.directoryUserName ?? row.userName,
    name,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    emails: [{ value: row.userName, type: "work", primary: true }],
    active: row.active === true,
    preferredLanguage: row.locale || "en",
    meta: meta("User", row, `${baseUrl}/Users/${row.id}`),
  };
}

export function toGroupResource(row, baseUrl, { excludeMembers = false } = {}) {
  return {
    schemas: [SCHEMA_GROUP],
    id: row.id,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    displayName: row.displayName,
    ...(excludeMembers ? {} : {
      members: (row.members || []).map((member) => ({
        value: member.value,
        ...(member.display ? { display: member.display } : {}),
        $ref: `${baseUrl}/Users/${member.value}`,
        type: "User",
      })),
    }),
    meta: meta("Group", row, `${baseUrl}/Groups/${row.id}`),
  };
}

export function listResponse(resources, totalResults, startIndex) {
  return {
    schemas: [SCHEMA_LIST],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function serviceProviderConfig(baseUrl, documentationUri) {
  return {
    schemas: [SCHEMA_SPC],
    documentationUri,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description: brandText("Organization-scoped bearer token issued once on the Union Ground Integrations page (SCIM tab). Only its SHA-256 digest is stored."),
      primary: true,
    }],
    meta: { resourceType: "ServiceProviderConfig", location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypes(baseUrl) {
  return [
    {
      schemas: [SCHEMA_RESOURCE_TYPE],
      id: "User",
      name: "User",
      endpoint: "/Users",
      description: "A person provisioned by invitation into the organization",
      schema: SCHEMA_USER,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
    },
    {
      schemas: [SCHEMA_RESOURCE_TYPE],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      description: "A directory group; an organization admin may map it to a starting role",
      schema: SCHEMA_GROUP,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/Group` },
    },
  ];
}

function attribute(name, type, extra = {}) {
  return {
    name,
    type,
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: "readWrite",
    returned: "default",
    uniqueness: "none",
    ...extra,
  };
}

export function schemas(baseUrl) {
  return [
    {
      schemas: [SCHEMA_SCHEMA],
      id: SCHEMA_USER,
      name: "User",
      description: "User account",
      attributes: [
        attribute("userName", "string", { required: true, uniqueness: "server" }),
        attribute("externalId", "string", { caseExact: true }),
        attribute("name", "complex", {
          subAttributes: [attribute("givenName", "string"), attribute("familyName", "string"), attribute("formatted", "string")],
        }),
        attribute("displayName", "string"),
        attribute("emails", "complex", {
          multiValued: true,
          description: "The canonical work address, shared with userName. PATCH changes use the same invitation and account-rename safeguards as userName.",
          subAttributes: [attribute("value", "string"), attribute("type", "string"), attribute("primary", "boolean")],
        }),
        attribute("active", "boolean"),
        attribute("preferredLanguage", "string"),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCHEMA_USER}` },
    },
    {
      schemas: [SCHEMA_SCHEMA],
      id: SCHEMA_GROUP,
      name: "Group",
      description: "Group",
      attributes: [
        attribute("displayName", "string", { required: true, uniqueness: "server" }),
        attribute("externalId", "string", { caseExact: true }),
        attribute("members", "complex", {
          multiValued: true,
          subAttributes: [
            attribute("value", "string", { mutability: "immutable" }),
            attribute("display", "string", { mutability: "readOnly" }),
            attribute("$ref", "reference", { mutability: "immutable" }),
          ],
        }),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCHEMA_GROUP}` },
    },
  ];
}

// Splits the routed path (everything after /scim/v2/) into a resource and id.
export function routeOf(path) {
  const segments = String(path || "").split("/").filter(Boolean);
  if (segments.length > 2) return null;
  const [resource, id] = segments;
  if (!resource) return { resource: "", id: null };
  const known = ["Users", "Groups", "ServiceProviderConfig", "ResourceTypes", "Schemas"]
    .find((name) => name.toLowerCase() === resource.toLowerCase());
  if (!known) return null;
  try {
    return { resource: known, id: id ? decodeURIComponent(id) : null };
  } catch {
    // A malformed escape is an invalid resource path, just like an unknown
    // resource. Keep the handler on its ordinary SCIM Error response path.
    return null;
  }
}

export function parseBody(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "object" && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (text.length > 1_000_000) throw new ScimError(413, "request body is too large", "tooLarge");
  try {
    return JSON.parse(text);
  } catch {
    throw new ScimError(400, "request body is not JSON", "invalidSyntax");
  }
}
