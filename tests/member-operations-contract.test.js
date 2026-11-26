import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { pairs } from "../scripts/contrast-audit.mjs";
import {
  MEMBER_OPERATIONS_DONOR,
  MEMBER_OPERATIONS_RPCS,
  canManageMemberOperations,
  createMemberOperationsAdapter,
  normalizeMemberOperationsActor,
  normalizeMemberOperationsWorkspace,
  parseMemberOperationsCsv,
  validateMemberOperationsMapping,
} from "../src/features/memberOperations/index.js";

const admin = {
  userId: "11111111-1111-4111-8111-111111111111",
  selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
  membershipStatus: "active",
  selectedHat: "admin",
  organizationRoles: ["admin"],
  mfaSatisfied: true,
};

describe("member operations browser contract", () => {
  it("pins import row errors to the audited readable danger ink", () => {
    const css = readFileSync("src/features/memberOperations/member-operations.css", "utf8");
    expect(css).toMatch(/\.member-operations-error\s*\{[^}]*border-left:\s*3px solid var\(--learn-terra-ink\)[^}]*color:\s*var\(--learn-terra-ink\)/s);
    expect(pairs).toContainEqual([
      "--card-2",
      "--learn-terra-ink",
      4.5,
      "Member operations import row errors",
    ]);
  });

  it("requires the explicit admin hat, matching role, active membership, and MFA", () => {
    expect(canManageMemberOperations(admin)).toBe(true);
    expect(canManageMemberOperations({ ...admin, selectedHat: "member" })).toBe(false);
    expect(canManageMemberOperations({ ...admin, organizationRoles: ["steward"] })).toBe(false);
    expect(canManageMemberOperations({ ...admin, membershipStatus: "invited" })).toBe(false);
    expect(canManageMemberOperations({ ...admin, mfaSatisfied: false })).toBe(false);
    expect(normalizeMemberOperationsActor({ ...admin, organizationRoles: ["admin", "admin", "unknown"] }).organizationRoles).toEqual(["admin"]);
  });

  it("records the exact donor baseline and rejects unsafe legacy assumptions", () => {
    expect(MEMBER_OPERATIONS_DONOR.baseline).toBe("donor-baseline-20260721");
    expect(MEMBER_OPERATIONS_DONOR.rejected).toEqual(expect.arrayContaining([
      "request-supplied tenant identity",
      "service-role browser paths",
      "PIN and self-signup welcome flows",
      "partial imports reported as success",
    ]));
  });

  it("normalizes hostile server payloads into bounded UI states", () => {
    const workspace = normalizeMemberOperationsWorkspace({
      state: "ready",
      organizationId: admin.selectedOrganizationId,
      directory: { items: [{ userId: "member-1", fullName: "A" }, {}, { userId: "member-2", fullName: "B", version: "3" }] },
      campaigns: [{ id: "campaign-1", name: "Welcome", state: "invalid", steps: [{ id: "step-1", delayDays: "2", locale: "es" }] }],
      imports: [{ id: "batch-1", kind: "invalid", state: "invalid", errorCount: "4" }],
    }, admin);
    expect(workspace.state).toBe("ready");
    expect(workspace.directory.items).toHaveLength(2);
    expect(workspace.directory.items[1].version).toBe(3);
    expect(workspace.campaigns[0]).toMatchObject({ state: "draft", steps: [{ delayDays: 2, locale: "es" }] });
    expect(workspace.imports[0]).toMatchObject({ kind: "member", state: "uploaded", errorCount: 4 });
    expect(normalizeMemberOperationsWorkspace({ state: "ready", organizationId: "other" }, admin).state).toBe("unauthorized");
  });

  it("never sends an organization id and uses secure operation keys for mutations", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { state: "ready", organizationId: admin.selectedOrganizationId }, error: null }) };
    const adapter = createMemberOperationsAdapter(client, { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await adapter.load(admin);
    await adapter.saveProfile(admin, { memberUserId: "member-1", expectedVersion: 2, fields: { department: "Nursing" } });
    await adapter.queueWelcome(admin);
    expect(client.rpc.mock.calls[0]).toEqual([MEMBER_OPERATIONS_RPCS.workspace, undefined]);
    for (const [, args] of client.rpc.mock.calls.slice(1)) {
      expect(args).not.toHaveProperty("p_organization_id");
      expect(args.p_idempotency_key).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    }
  });

  it("covers the complete directory, welcome, and import adapter boundary", async () => {
    const client = { rpc: vi.fn(async (name) => ({
      data: name === MEMBER_OPERATIONS_RPCS.workspace
        ? { state: "ready", organizationId: admin.selectedOrganizationId, directory: { items: [] }, campaigns: [], imports: [] }
        : name === MEMBER_OPERATIONS_RPCS.commitImport ? { state: "committed", importedCount: 1 } : { ok: true },
      error: null,
    })) };
    const adapter = createMemberOperationsAdapter(client, { randomUUID: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    await adapter.load(admin);
    await expect(adapter.listDirectory(admin, { query: "Avery", afterName: "Brooks", afterId: "member-1", limit: 10 })).resolves.toEqual({ ok: true });
    await expect(adapter.loadProfile(admin, "member-1")).resolves.toEqual({ ok: true });
    await adapter.saveProfile(admin, { memberUserId: "member-1", fields: {} });
    await adapter.bulkUpdateProfiles(admin, { memberUserIds: ["member-1"], field: "department" });
    await adapter.saveWelcomeCampaign(admin, { name: "Welcome" });
    await adapter.listWelcomeEnrollments(admin, { campaignId: "campaign-1" });
    await adapter.saveWelcomeStep(admin, { campaignId: "campaign-1", position: 2, delayDays: 5, subject: "Hello", body: "Welcome" });
    await adapter.enrollWelcome(admin, { campaignId: "campaign-1", memberUserId: "member-1" });
    await adapter.transitionWelcome(admin, { enrollmentId: "enrollment-1", state: "paused" });
    await adapter.queueWelcome(admin);
    await adapter.stageImport(admin, { kind: "member", filename: "members.csv" });
    await adapter.listImports(admin);
    await adapter.validateImport(admin, "batch-1");
    await adapter.commitImport(admin, "batch-1");
    await adapter.discardImport(admin, "batch-1");
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(
      Object.values(MEMBER_OPERATIONS_RPCS).filter((name) => ![
        MEMBER_OPERATIONS_RPCS.welcomeWorkspace,
        MEMBER_OPERATIONS_RPCS.importWorkspace,
      ].includes(name)),
    ));
    expect(client.rpc).toHaveBeenCalledWith(MEMBER_OPERATIONS_RPCS.directory, {
      p_query: "Avery", p_after_name: "Brooks", p_after_id: "member-1", p_limit: 10,
    });
    expect(client.rpc).toHaveBeenCalledWith(MEMBER_OPERATIONS_RPCS.saveWelcomeStep, expect.objectContaining({
      p_step_id: null, p_position: 2, p_delay_days: 5, p_locale: "en", p_active: true,
    }));
    expect(client.rpc).toHaveBeenCalledWith(MEMBER_OPERATIONS_RPCS.stageImport, expect.objectContaining({
      p_mapping: {}, p_rows: [],
    }));
  });

  it("returns a noncommitted import result so the UI can refresh row errors", async () => {
    const result = { state: "validated", committed: false, reason: "revalidation_failed" };
    const client = { rpc: vi.fn().mockResolvedValue({ data: result, error: null }) };
    const adapter = createMemberOperationsAdapter(client, { randomUUID: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    await expect(adapter.commitImport(admin, "batch-1")).resolves.toEqual(result);
  });

  it("maps unavailable, MFA, authorization, and unexpected adapter failures", async () => {
    const failure = (error) => createMemberOperationsAdapter({ rpc: vi.fn().mockResolvedValue({ data: null, error }) });
    await expect(failure({ code: "PGRST202" }).load(admin)).resolves.toEqual({ state: "unavailable" });
    await expect(failure({ code: "42883" }).load(admin)).resolves.toEqual({ state: "unavailable" });
    await expect(failure({ message: "could not find the function" }).load(admin)).resolves.toEqual({ state: "unavailable" });
    await expect(failure({ code: "42501", message: "MFA required" }).load(admin)).resolves.toEqual({ state: "mfa_required" });
    await expect(failure({ code: "42501", message: "role required" }).load(admin)).resolves.toEqual({ state: "unauthorized" });
    await expect(failure(new Error("network" )).load(admin)).resolves.toEqual({ state: "error" });
    await expect(createMemberOperationsAdapter(null).load(admin)).resolves.toEqual({ state: "unavailable" });
    await expect(createMemberOperationsAdapter({ rpc: vi.fn() }).listDirectory({ ...admin, selectedHat: "member" })).rejects.toMatchObject({ code: "42501" });
  });

  it("parses bounded CSV without evaluating formulas or retaining the original file", () => {
    const result = parseMemberOperationsCsv('member_id,department,notes\nmember-1,Nursing,"=HYPERLINK(""x"")"');
    expect(result.headers).toEqual(["member_id", "department", "notes"]);
    expect(result.rows[0]).toEqual({ member_id: "member-1", department: "Nursing", notes: '=HYPERLINK("x")' });
    expect(result).not.toHaveProperty("source");
    expect(() => parseMemberOperationsCsv("a\n".repeat(502))).toThrow(/500 rows/i);
  });

  it("rejects incomplete, duplicate, and unsupported import mappings before upload", () => {
    expect(validateMemberOperationsMapping("member", { source: "email", team: "department" })).toEqual({ valid: true, errors: [] });
    expect(validateMemberOperationsMapping("member", { first: "email", second: "email" })).toMatchObject({ valid: false });
    expect(validateMemberOperationsMapping("member", { source: "department" }).errors.join(" ")).toMatch(/member id or email/i);
    expect(validateMemberOperationsMapping("grievance", { who: "member_email", chapter: "chapter_id" }).errors.join(" ")).toMatch(/reference, title/i);
    expect(validateMemberOperationsMapping("grievance", { who: "member_email", chapter: "chapter_id", ref: "reference", title: "title", secret: "role" }).errors.join(" ")).toMatch(/unsupported/i);
  });
});
