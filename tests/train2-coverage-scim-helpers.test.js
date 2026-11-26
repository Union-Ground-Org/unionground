// @vitest-environment node
//
// REQ-UG-SCIM-PROVISIONING-20261001: branch-level coverage of the pure
// SCIM 2.0 helpers in api/_lib/scim.js (RFC 7643 / RFC 7644 shapes). Every
// case runs through the public exports with no network and no database.
import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_MEMBERS, MAX_PAGE, SCHEMA_ERROR, SCHEMA_GROUP, SCHEMA_LIST, SCHEMA_SCHEMA, SCHEMA_SPC, SCHEMA_USER,
  ScimError, applyGroupPatch, applyUserPatch, errorBody, listResponse, normalizeGroup, normalizeUser, pageParameters,
  parseBody, parseFilter, resourceTypes, routeOf, schemas, scimBoolean, serviceProviderConfig, toGroupResource,
  toUserResource,
} from "../api/_lib/scim.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BASE = "https://app.example.org/scim/v2";

function patch(...operations) {
  return { Operations: operations };
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return { status: error.status, scimType: error.scimType, message: error.message, isScim: error instanceof ScimError };
  }
  return null;
}

describe("SCIM error and boolean helpers", () => {
  it("shapes an Error resource with an optional scimType", () => {
    expect(errorBody(409, "exists", "uniqueness")).toEqual({ schemas: [SCHEMA_ERROR], status: "409", scimType: "uniqueness", detail: "exists" });
    expect(errorBody(500, "boom")).toEqual({ schemas: [SCHEMA_ERROR], status: "500", detail: "boom" });
    const error = new ScimError(404, "missing");
    expect(error.status).toBe(404);
    expect(error.scimType).toBeUndefined();
    expect(error.message).toBe("missing");
  });

  it("reads real booleans and the Azure AD True/False strings and refuses anything else", () => {
    expect(scimBoolean(true)).toBe(true);
    expect(scimBoolean(false)).toBe(false);
    expect(scimBoolean("True")).toBe(true);
    expect(scimBoolean(" false ")).toBe(false);
    expect(codeOf(() => scimBoolean("yes"))).toMatchObject({ status: 400, scimType: "invalidValue", message: "active must be a boolean" });
    expect(codeOf(() => scimBoolean(1, "enabled"))).toMatchObject({ message: "enabled must be a boolean" });
    expect(codeOf(() => scimBoolean(undefined))).toMatchObject({ scimType: "invalidValue" });
  });
});

describe("normalizeUser", () => {
  it("refuses a body that is not a User resource", () => {
    for (const body of [null, undefined, "text", 7, ["a@b.org"]]) {
      expect(codeOf(() => normalizeUser(body))).toMatchObject({ status: 400, scimType: "invalidSyntax", isScim: true });
    }
  });

  it("validates userName and every bounded text field", () => {
    expect(codeOf(() => normalizeUser({}))).toMatchObject({ message: "userName is required" });
    expect(codeOf(() => normalizeUser({ userName: "   " }))).toMatchObject({ message: "userName is required" });
    expect(codeOf(() => normalizeUser({ userName: 42 }))).toMatchObject({ message: "userName must be a string" });
    expect(codeOf(() => normalizeUser({ userName: "a@b.org\u0000" }))).toMatchObject({ message: "userName is not valid" });
    expect(codeOf(() => normalizeUser({ userName: "a@b.org\u007f" }))).toMatchObject({ message: "userName is not valid" });
    expect(codeOf(() => normalizeUser({ userName: `${"a".repeat(250)}@b.org` }))).toMatchObject({ message: "userName is not valid" });
    expect(codeOf(() => normalizeUser({ userName: "a@b.org", name: { givenName: "x".repeat(81) } }))).toMatchObject({ message: "name.givenName is not valid" });
    expect(codeOf(() => normalizeUser({ userName: "a@b.org", displayName: "x".repeat(121) }))).toMatchObject({ message: "displayName is not valid" });
    expect(codeOf(() => normalizeUser({ userName: "a@b.org", externalId: 5 }))).toMatchObject({ message: "externalId must be a string" });
    expect(codeOf(() => normalizeUser({ userName: "a@b.org", active: "maybe" }))).toMatchObject({ message: "active must be a boolean" });
  });

  it("falls back from userName to the primary or work email and rejects when none is an address", () => {
    expect(normalizeUser({ userName: "00u1", emails: [{ value: "x@y.org" }, { value: "W@Y.org", type: "Work" }] }).userName).toBe("w@y.org");
    expect(normalizeUser({ userName: "00u1", emails: [{ value: "first@y.org" }, { value: "p@y.org", primary: "true" }] }).userName).toBe("p@y.org");
    expect(normalizeUser({ userName: "00u1", emails: [null, { value: 5 }, { value: " Only@Y.org " }] }).userName).toBe("only@y.org");
    expect(codeOf(() => normalizeUser({ userName: "00u1", emails: "a@b.org" }))).toMatchObject({ message: "userName or a primary email must be an email address" });
    expect(codeOf(() => normalizeUser({ userName: "00u1", emails: [{ value: "not-an-email" }] }))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => normalizeUser({ userName: "00u1" }))).toMatchObject({ status: 400 });
  });

  it("derives the display name and locale from the optional fields", () => {
    const full = normalizeUser({
      userName: " Ana@Example.ORG ",
      externalId: " 00u1 ",
      name: { givenName: " Ana ", familyName: "Example" },
      preferredLanguage: "es-MX",
      active: "True",
    });
    expect(full).toEqual({
      userName: "ana@example.org", externalId: "00u1", givenName: "Ana", familyName: "Example",
      displayName: "Ana Example", active: true, locale: "es",
    });
    expect(normalizeUser({ userName: "a@b.org", displayName: "Shown", name: { formatted: "Formatted" } }).displayName).toBe("Shown");
    expect(normalizeUser({ userName: "a@b.org", name: { formatted: "Formatted" } }).displayName).toBe("Formatted");
    expect(normalizeUser({ userName: "a@b.org", name: { familyName: "Only" } }).displayName).toBe("Only");
    const bare = normalizeUser({ userName: "a@b.org", name: "not-an-object", locale: "ES" });
    expect(bare).toMatchObject({ externalId: null, givenName: null, familyName: null, displayName: null, active: true, locale: "es" });
    expect(normalizeUser({ userName: "a@b.org", locale: 7 }).locale).toBe("en");
    expect(normalizeUser({ userName: "a@b.org", preferredLanguage: "fr" }).locale).toBe("en");
  });
});

describe("normalizeGroup", () => {
  it("refuses non-objects and a missing displayName", () => {
    for (const body of [null, "x", ["x"]]) {
      expect(codeOf(() => normalizeGroup(body))).toMatchObject({ scimType: "invalidSyntax", message: "request body must be a Group resource" });
    }
    expect(codeOf(() => normalizeGroup({}))).toMatchObject({ message: "displayName is required" });
    expect(codeOf(() => normalizeGroup({ displayName: "  " }))).toMatchObject({ scimType: "invalidValue" });
  });

  it("accepts string and object member ids, lowercases and de-duplicates them", () => {
    const group = normalizeGroup({
      displayName: " Stewards ",
      externalId: "g-1",
      members: [{ value: USER_A.toUpperCase() }, USER_A, { value: USER_B }, USER_C],
    });
    expect(group).toEqual({ displayName: "Stewards", externalId: "g-1", members: [USER_A, USER_B, USER_C] });
    expect(normalizeGroup({ displayName: "Empty" })).toEqual({ displayName: "Empty", externalId: null, members: [] });
  });

  it("rejects malformed members and oversized groups", () => {
    expect(codeOf(() => normalizeGroup({ displayName: "G", members: "nope" }))).toMatchObject({ message: "members must be an array" });
    expect(codeOf(() => normalizeGroup({ displayName: "G", members: [{ value: "not-a-uuid" }] }))).toMatchObject({ message: "members[].value must be a User id" });
    expect(codeOf(() => normalizeGroup({ displayName: "G", members: [{ value: 12 }] }))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => normalizeGroup({ displayName: "G", members: [null] }))).toMatchObject({ scimType: "invalidValue" });
    const many = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(codeOf(() => normalizeGroup({ displayName: "G", members: many }))).toMatchObject({ scimType: "tooMany", message: "too many group members" });
  });
});

describe("parseFilter", () => {
  it("treats an absent filter as no filter", () => {
    expect(parseFilter(undefined, "Users")).toBeNull();
    expect(parseFilter(null, "Users")).toBeNull();
    expect(parseFilter("", "Groups")).toBeNull();
  });

  it("refuses non-string, oversized, malformed and unsupported-attribute filters", () => {
    expect(codeOf(() => parseFilter(42, "Users"))).toMatchObject({ scimType: "invalidFilter", message: "filter is not supported" });
    expect(codeOf(() => parseFilter(`userName eq "${"a".repeat(600)}"`, "Users"))).toMatchObject({ scimType: "invalidFilter" });
    expect(codeOf(() => parseFilter('userName co "a"', "Users"))).toMatchObject({ scimType: "invalidFilter" });
    expect(codeOf(() => parseFilter('title eq "a"', "Users"))).toMatchObject({ scimType: "invalidFilter", message: "filtering on title is not supported" });
    expect(codeOf(() => parseFilter('userName eq "a"', "Groups"))).toMatchObject({ scimType: "invalidFilter" });
  });

  it("resolves the supported equality filters per resource", () => {
    expect(parseFilter('displayName eq "Stewards"', "Groups")).toEqual({ field: "displayName", value: "Stewards" });
    expect(parseFilter('externalId eq "g\\"1"', "Groups")).toEqual({ field: "externalId", value: 'g"1' });
    expect(parseFilter(`id eq "${USER_A}"`, "Groups")).toEqual({ field: "id", value: USER_A });
    expect(parseFilter('USERNAME EQ " Ana@B.org "', "Users")).toEqual({ field: "userName", value: "ana@b.org" });
    expect(parseFilter('externalId eq "00u1"', "Users")).toEqual({ field: "externalId", value: "00u1" });
    expect(parseFilter(`id eq "${USER_B}"`, undefined)).toEqual({ field: "id", value: USER_B });
    expect(parseFilter('id eq "short"', "Groups")).toEqual({ field: "id", value: null });
  });
});

describe("pageParameters", () => {
  it("defaults to the first page of 100", () => {
    expect(pageParameters()).toEqual({ startIndex: 1, count: 100 });
    expect(pageParameters({})).toEqual({ startIndex: 1, count: 100 });
  });

  it("clamps the paging values", () => {
    expect(pageParameters({ startIndex: "5", count: "10" })).toEqual({ startIndex: 5, count: 10 });
    expect(pageParameters({ startIndex: "0", count: "-3" })).toEqual({ startIndex: 1, count: 0 });
    expect(pageParameters({ startIndex: "-9", count: "9999" })).toEqual({ startIndex: 1, count: MAX_PAGE });
    expect(pageParameters({ startIndex: "abc", count: "abc" })).toEqual({ startIndex: 1, count: 100 });
    expect(pageParameters({ startIndex: 3, count: 7 })).toEqual({ startIndex: 3, count: 7 });
  });
});

describe("applyUserPatch", () => {
  const current = {
    userName: "ana@example.org",
    externalId: "00u1",
    name: { givenName: "Ana", familyName: "Example", formatted: "Ana Example" },
    displayName: "Ana Example",
    active: true,
    preferredLanguage: "en",
    emails: [{ value: "ana@example.org", type: "work", primary: true }],
  };

  it("validates the PATCH envelope", () => {
    expect(codeOf(() => applyUserPatch(current, null))).toMatchObject({ scimType: "invalidSyntax", message: "PATCH body must carry Operations" });
    expect(codeOf(() => applyUserPatch(current, {}))).toMatchObject({ scimType: "invalidSyntax" });
    expect(codeOf(() => applyUserPatch(current, { Operations: "x" }))).toMatchObject({ scimType: "invalidSyntax" });
    expect(codeOf(() => applyUserPatch(current, { Operations: [] }))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => applyUserPatch(current, { Operations: Array.from({ length: 101 }, () => ({ op: "add", path: "active", value: true })) }))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => applyUserPatch(current, patch(null)))).toMatchObject({ scimType: "invalidSyntax" });
    expect(codeOf(() => applyUserPatch(current, patch({ op: "copy", path: "active" })))).toMatchObject({ scimType: "invalidSyntax" });
    expect(applyUserPatch(current, { operations: [{ op: "REPLACE", path: "active", value: "False" }] }).active).toBe(false);
  });

  it("does not mutate the current resource and carries the untouched fields", () => {
    const frozen = structuredClone(current);
    const next = applyUserPatch(current, patch({ op: "replace", path: "displayName", value: "Changed" }));
    expect(current).toEqual(frozen);
    expect(next).toMatchObject({ userName: "ana@example.org", externalId: "00u1", displayName: "Changed", active: true, preferredLanguage: "en" });
    expect(applyUserPatch({ userName: "a@b.org" }, patch({ op: "add", path: "title", value: "x" })).name).toEqual({});
  });

  it("applies add, replace and remove on each stored attribute path", () => {
    const replaced = applyUserPatch(current, patch(
      { op: "replace", path: "userName", value: "new@example.org" },
      { op: "replace", path: "externalId", value: "00u2" },
      { op: "replace", path: "name.givenName", value: "Anna" },
      { op: "replace", path: "name.familyName", value: "Ex" },
      { op: "replace", path: "name.formatted", value: "Anna Ex" },
      { op: "replace", path: "preferredLanguage", value: "es" },
      { op: "replace", path: " Active ", value: true },
    ));
    expect(replaced).toMatchObject({
      userName: "new@example.org", externalId: "00u2", preferredLanguage: "es", active: true,
      name: { givenName: "Anna", familyName: "Ex", formatted: "Anna Ex" },
    });
    expect(applyUserPatch(current, patch({ op: "replace", path: "locale", value: "es" })).preferredLanguage).toBe("es");

    const cleared = applyUserPatch(current, patch(
      { op: "remove", path: "username" },
      { op: "remove", path: "externalId" },
      { op: "remove", path: "displayName" },
      { op: "remove", path: "name.givenName" },
      { op: "remove", path: "name.familyName" },
      { op: "remove", path: "name.formatted" },
      { op: "remove", path: "preferredLanguage" },
      { op: "remove", path: "active" },
    ));
    expect(cleared).toMatchObject({
      userName: "ana@example.org", externalId: null, displayName: null, preferredLanguage: null, active: false,
      name: { givenName: null, familyName: null, formatted: null },
    });
    expect(applyUserPatch(current, patch({ op: "remove", path: "name" })).name).toEqual({});
    expect(applyUserPatch(current, patch({ op: "add", path: "name", value: { givenName: "Zed" } })).name).toEqual({ givenName: "Zed", familyName: "Example", formatted: "Ana Example" });
    expect(applyUserPatch(current, patch({ op: "replace", path: "name", value: null })).name).toEqual(current.name);
    expect(codeOf(() => applyUserPatch(current, patch({ op: "replace", path: "active", value: "nope" })))).toMatchObject({ scimType: "invalidValue" });
  });

  it("accepts the several email path shapes and ignores a removal or an unusable value", () => {
    const asString = applyUserPatch(current, patch({ op: "replace", path: "emails[type eq \"work\"].value", value: "x@y.org" }));
    expect(asString.emails).toEqual([{ value: "x@y.org", type: "work", primary: true }]);
    expect(normalizeUser(asString).userName).toBe("x@y.org");
    const asArray = applyUserPatch(current, patch({ op: "add", path: "emails", value: [{ value: "a@y.org" }, { value: "b@y.org", primary: true }] }));
    expect(asArray.emails[0].value).toBe("b@y.org");
    expect(normalizeUser(asArray).userName).toBe("b@y.org");
    const asObject = applyUserPatch(current, patch({ op: "replace", path: "emails[primary eq true]", value: { value: "o@y.org" } }));
    expect(asObject.emails[0].value).toBe("o@y.org");
    expect(normalizeUser(asObject).userName).toBe("o@y.org");
    expect(applyUserPatch(current, patch({ op: "remove", path: "emails" })).emails).toBe(current.emails);
    expect(applyUserPatch(current, patch({ op: "add", path: "emails", value: 12 })).emails).toBe(current.emails);
    expect(applyUserPatch(current, patch({ op: "add", path: "emails", value: null })).emails).toBe(current.emails);
  });

  it("applies a path-less PATCH as an object of attributes", () => {
    const next = applyUserPatch(current, patch({
      op: "replace",
      value: { active: false, displayName: "Whole", name: { givenName: "Z" }, title: "ignored", "name.familyName": "Q" },
    }));
    expect(next).toMatchObject({ active: false, displayName: "Whole", name: { givenName: "Z", familyName: "Q" } });
    expect(next.title).toBeUndefined();
    expect(applyUserPatch(current, patch({ op: "add", value: { name: null } })).name).toEqual(current.name);
    expect(codeOf(() => applyUserPatch(current, patch({ op: "remove" })))).toMatchObject({ scimType: "noTarget", message: "remove needs a path" });
    expect(codeOf(() => applyUserPatch(current, patch({ op: "replace" })))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => applyUserPatch(current, patch({ op: "replace", value: "text" })))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => applyUserPatch(current, patch({ op: "replace", value: [1] })))).toMatchObject({ scimType: "invalidValue" });
    expect(applyUserPatch(current, patch({ op: "replace", path: 7, value: { active: false } })).active).toBe(false);
  });
});

describe("applyGroupPatch", () => {
  const group = {
    displayName: "Stewards",
    externalId: "g-1",
    members: [{ value: USER_A.toUpperCase() }, { value: USER_B }],
  };

  it("carries the current members, tolerating a group without any", () => {
    expect(applyGroupPatch(group, patch({ op: "replace", path: "displayName", value: "Renamed" }))).toEqual({
      displayName: "Renamed", externalId: "g-1", members: [USER_A, USER_B],
    });
    expect(applyGroupPatch({ displayName: "Bare" }, patch({ op: "replace", path: "externalId", value: "x" }))).toEqual({
      displayName: "Bare", externalId: "x", members: [],
    });
    expect(codeOf(() => applyGroupPatch(group, null))).toMatchObject({ scimType: "invalidSyntax" });
  });

  it("adds, replaces and removes members by path", () => {
    expect(applyGroupPatch(group, patch({ op: "add", path: "members", value: [{ value: USER_C }, { value: USER_A }] })).members).toEqual([USER_A, USER_B, USER_C]);
    expect(applyGroupPatch(group, patch({ op: "add", path: "members", value: { value: USER_C } })).members).toEqual([USER_A, USER_B, USER_C]);
    expect(applyGroupPatch(group, patch({ op: "replace", path: "members", value: [{ value: USER_C }] })).members).toEqual([USER_C]);
    expect(applyGroupPatch(group, patch({ op: "replace", path: "members", value: "not-an-array" })).members).toEqual([]);
    expect(applyGroupPatch(group, patch({ op: "remove", path: "members" })).members).toEqual([]);
    expect(applyGroupPatch(group, patch({ op: "remove", path: "members", value: [{ value: USER_A }] })).members).toEqual([USER_B]);
    expect(applyGroupPatch(group, patch({ op: "remove", path: "members", value: { value: USER_B } })).members).toEqual([USER_A]);
    expect(applyGroupPatch(group, patch({ op: "remove", path: "members", value: USER_B })).members).toEqual([USER_A]);
    expect(codeOf(() => applyGroupPatch(group, patch({ op: "add", path: "members", value: [{ value: "bad" }] })))).toMatchObject({ scimType: "invalidValue" });
  });

  it("supports a filtered members path for removal only", () => {
    expect(applyGroupPatch(group, patch({ op: "remove", path: `members[value eq "${USER_A.toUpperCase()}"]` })).members).toEqual([USER_B]);
    expect(codeOf(() => applyGroupPatch(group, patch({ op: "add", path: `members[value eq "${USER_A}"]`, value: {} })))).toMatchObject({ scimType: "invalidPath" });
    expect(codeOf(() => applyGroupPatch(group, patch({ op: "replace", path: `members[value eq "${USER_A}"]`, value: {} })))).toMatchObject({ scimType: "invalidPath" });
  });

  it("changes displayName and externalId and refuses to drop the required name", () => {
    expect(applyGroupPatch(group, patch({ op: "replace", path: "displayName", value: "Named" })).displayName).toBe("Named");
    expect(codeOf(() => applyGroupPatch(group, patch({ op: "remove", path: "displayName" })))).toMatchObject({ scimType: "mutability" });
    expect(applyGroupPatch(group, patch({ op: "remove", path: "externalId" })).externalId).toBeNull();
    expect(applyGroupPatch({ displayName: "G", externalId: undefined }, patch({ op: "add", path: "externalId", value: "e" })).externalId).toBe("e");
    expect(applyGroupPatch({ displayName: "G" }, patch({ op: "replace", path: "title", value: "ignored" }))).toEqual({ displayName: "G", externalId: null, members: [] });
  });

  it("applies a path-less PATCH object", () => {
    const replaced = applyGroupPatch(group, patch({ op: "replace", value: { displayName: "All", externalId: "e2", members: [{ value: USER_C }] } }));
    expect(replaced).toEqual({ displayName: "All", externalId: "e2", members: [USER_C] });
    expect(applyGroupPatch(group, patch({ op: "add", value: { members: [{ value: USER_C }] } })).members).toEqual([USER_A, USER_B, USER_C]);
    expect(applyGroupPatch(group, patch({ op: "replace", value: {} })).members).toEqual([USER_A, USER_B]);
    expect(codeOf(() => applyGroupPatch(group, patch({ op: "replace" })))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => applyGroupPatch(group, patch({ op: "replace", value: [1] })))).toMatchObject({ scimType: "invalidValue" });
    expect(codeOf(() => applyGroupPatch(group, patch({ op: "replace", value: "text" })))).toMatchObject({ scimType: "invalidValue" });
  });

  it("refuses a PATCH that leaves more members than a group may hold", () => {
    const members = Array.from({ length: MAX_GROUP_MEMBERS }, (_, index) => ({ value: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    expect(codeOf(() => applyGroupPatch({ displayName: "Big", members }, patch({ op: "add", path: "members", value: [{ value: USER_A }] })))).toMatchObject({ scimType: "tooMany" });
  });
});

describe("SCIM resource shapes", () => {
  const userRow = {
    id: USER_A, externalId: "00u1", userName: "ana@example.org", givenName: "Ana", familyName: "Example",
    displayName: "Ana Example", active: true, locale: "es", version: 3,
    createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T11:00:00Z",
  };

  it("renders a full User resource", () => {
    expect(toUserResource(userRow, BASE)).toEqual({
      schemas: [SCHEMA_USER],
      id: USER_A,
      externalId: "00u1",
      userName: "ana@example.org",
      name: { givenName: "Ana", familyName: "Example", formatted: "Ana Example" },
      displayName: "Ana Example",
      emails: [{ value: "ana@example.org", type: "work", primary: true }],
      active: true,
      preferredLanguage: "es",
      meta: { resourceType: "User", created: "2026-10-02T10:00:00Z", lastModified: "2026-10-02T11:00:00Z", location: `${BASE}/Users/${USER_A}`, version: 'W/"3"' },
    });
  });

  it("omits what the row does not carry and defaults the locale and version", () => {
    const sparse = toUserResource({ id: USER_B, userName: "b@example.org", active: "yes", createdAt: "c", updatedAt: "u" }, BASE);
    expect(sparse.name).toEqual({});
    expect(sparse).not.toHaveProperty("externalId");
    expect(sparse).not.toHaveProperty("displayName");
    expect(sparse.active).toBe(false);
    expect(sparse.preferredLanguage).toBe("en");
    expect(sparse.meta.version).toBe('W/"1"');
    expect(toUserResource({ ...userRow, givenName: null }, BASE).name).toEqual({ familyName: "Example", formatted: "Example" });
    expect(toUserResource({ ...userRow, familyName: "", locale: null }, BASE)).toMatchObject({ name: { givenName: "Ana", formatted: "Ana" }, preferredLanguage: "en" });
  });

  it("renders a Group with members, without them, and with a bare row", () => {
    const row = {
      id: USER_C, externalId: "g-1", displayName: "Stewards", version: 2, createdAt: "c", updatedAt: "u",
      members: [{ value: USER_A, display: "Ana Example" }, { value: USER_B }],
    };
    const full = toGroupResource(row, BASE);
    expect(full).toMatchObject({ schemas: [SCHEMA_GROUP], id: USER_C, externalId: "g-1", displayName: "Stewards" });
    expect(full.members).toEqual([
      { value: USER_A, display: "Ana Example", $ref: `${BASE}/Users/${USER_A}`, type: "User" },
      { value: USER_B, $ref: `${BASE}/Users/${USER_B}`, type: "User" },
    ]);
    expect(full.meta).toEqual({ resourceType: "Group", created: "c", lastModified: "u", location: `${BASE}/Groups/${USER_C}`, version: 'W/"2"' });
    expect(toGroupResource(row, BASE, { excludeMembers: true })).not.toHaveProperty("members");
    const bare = toGroupResource({ id: USER_C, displayName: "Bare", createdAt: "c", updatedAt: "u" }, BASE);
    expect(bare.members).toEqual([]);
    expect(bare).not.toHaveProperty("externalId");
  });

  it("wraps resources in a ListResponse", () => {
    expect(listResponse([{ id: 1 }, { id: 2 }], 40, 11)).toEqual({
      schemas: [SCHEMA_LIST], totalResults: 40, startIndex: 11, itemsPerPage: 2, Resources: [{ id: 1 }, { id: 2 }],
    });
    expect(listResponse([], 0, 1).itemsPerPage).toBe(0);
  });

  it("describes the service honestly in the discovery documents", () => {
    const config = serviceProviderConfig(BASE, "https://app.example.org/docs/scim");
    expect(config).toMatchObject({
      schemas: [SCHEMA_SPC],
      documentationUri: "https://app.example.org/docs/scim",
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      meta: { resourceType: "ServiceProviderConfig", location: `${BASE}/ServiceProviderConfig` },
    });
    expect(config.authenticationSchemes).toHaveLength(1);
    expect(config.authenticationSchemes[0]).toMatchObject({ type: "oauthbearertoken", primary: true });

    const types = resourceTypes(BASE);
    expect(types.map((type) => [type.id, type.endpoint, type.schema])).toEqual([
      ["User", "/Users", SCHEMA_USER],
      ["Group", "/Groups", SCHEMA_GROUP],
    ]);
    expect(types[1].meta.location).toBe(`${BASE}/ResourceTypes/Group`);

    const [user, group] = schemas(BASE);
    expect(user).toMatchObject({ schemas: [SCHEMA_SCHEMA], id: SCHEMA_USER, name: "User" });
    expect(user.attributes.map((attr) => attr.name)).toEqual(["userName", "externalId", "name", "displayName", "emails", "active", "preferredLanguage"]);
    expect(user.attributes[0]).toMatchObject({ required: true, uniqueness: "server", mutability: "readWrite", returned: "default" });
    expect(user.attributes[2].subAttributes.map((attr) => attr.name)).toEqual(["givenName", "familyName", "formatted"]);
    expect(user.attributes[4]).toMatchObject({ multiValued: true });
    expect(group).toMatchObject({ id: SCHEMA_GROUP, name: "Group" });
    expect(group.attributes[2].subAttributes.map((attr) => [attr.name, attr.mutability])).toEqual([
      ["value", "immutable"], ["display", "readOnly"], ["$ref", "immutable"],
    ]);
    expect(group.meta.location).toBe(`${BASE}/Schemas/${SCHEMA_GROUP}`);
  });
});

describe("routeOf and parseBody", () => {
  it("splits the routed path into a canonical resource and a decoded id", () => {
    expect(routeOf("")).toEqual({ resource: "", id: null });
    expect(routeOf(undefined)).toEqual({ resource: "", id: null });
    expect(routeOf("/")).toEqual({ resource: "", id: null });
    expect(routeOf("groups/g%201")).toEqual({ resource: "Groups", id: "g 1" });
    expect(routeOf("//serviceproviderconfig/")).toEqual({ resource: "ServiceProviderConfig", id: null });
    expect(routeOf("RESOURCETYPES")).toEqual({ resource: "ResourceTypes", id: null });
    expect(routeOf("Schemas/urn:x")).toEqual({ resource: "Schemas", id: "urn:x" });
    expect(routeOf("Roles")).toBeNull();
    expect(routeOf("Users/a/b")).toBeNull();
  });

  it("returns empty bodies as null and objects as they are", () => {
    expect(parseBody(undefined)).toBeNull();
    expect(parseBody(null)).toBeNull();
    expect(parseBody("")).toBeNull();
    const object = { userName: "a@b.org" };
    expect(parseBody(object)).toBe(object);
  });

  it("parses JSON text and Buffers and refuses bad or oversized input", () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody(Buffer.from('{"b":2}'))).toEqual({ b: 2 });
    expect(parseBody(12)).toBe(12);
    expect(codeOf(() => parseBody("{not json"))).toMatchObject({ status: 400, scimType: "invalidSyntax" });
    expect(codeOf(() => parseBody(Buffer.from("{nope")))).toMatchObject({ status: 400 });
    expect(codeOf(() => parseBody(`"${"x".repeat(1_000_001)}"`))).toMatchObject({ status: 413, scimType: "tooLarge" });
    expect(codeOf(() => parseBody(Buffer.alloc(1_000_001, "x")))).toMatchObject({ status: 413 });
  });
});
