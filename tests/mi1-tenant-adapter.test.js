// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BROADCAST_AUDIENCE_SCOPES,
  CHAPTER_RECORD_MEMBER_TYPES,
  CHAPTER_RECORD_STAFF_TYPES,
  ORGANIZATION_AUDIT_METADATA_KEYS,
  ORGANIZATION_BOOTSTRAP_RPC,
  ORGANIZATION_ROLE_RPC,
  ORGANIZATION_ROLES,
  isBroadcastAudienceScope,
  isOrganizationRole,
} from "../src/features/tenancy/organizationScope.js";

describe("tenancy adapter", () => {
  it("names the frozen organization-scope surface without secrets", () => {
    expect(ORGANIZATION_BOOTSTRAP_RPC).toBe("bootstrap_first_organization");
    expect(ORGANIZATION_ROLE_RPC).toBe("set_member_organization_role");
    expect(ORGANIZATION_ROLES).toEqual(["steward", "coordinator", "advisor", "admin", "vp"]);
    expect(BROADCAST_AUDIENCE_SCOPES).toEqual(["chapter", "organization"]);
    expect(CHAPTER_RECORD_MEMBER_TYPES).toContain("minutes");
    expect(CHAPTER_RECORD_STAFF_TYPES).toEqual(["member_contact", "management_contact"]);
    expect(ORGANIZATION_AUDIT_METADATA_KEYS).toContain("requireStaffMfa");
    expect(isOrganizationRole("admin")).toBe(true);
    expect(isOrganizationRole("member")).toBe(false);
    expect(isBroadcastAudienceScope("organization")).toBe(true);
    expect(isBroadcastAudienceScope("global")).toBe(false);
  });
});
