// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  REQUIRED_PROBE_DOMAINS,
  actorMeetsMfaBoundary,
  actorMeetsRoleBoundary,
  assertAuthorizedSupabaseEndpoint,
  authorizedRpcSigningPayload,
  sha256Hex,
  validateAuthorizedRpcManifest,
} from "../scripts/lib/authorized-rpc-manifest.mjs";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const now = new Date("2026-08-30T16:00:00.000Z");
const sourceSha = "a".repeat(40);
const targetProjectRef = "b".repeat(20);
const keyId = "owner-test-key";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedPublicKeys = {
  [keyId]: publicKey.export({ type: "spki", format: "pem" }),
};
const base = {
  schemaVersion: 1,
  authorization: {
    reference: "owner-authorization-2026-08-30",
    approvedBy: "product owner",
    approvedAt: "2026-08-30T15:00:00.000Z",
    expiresAt: "2026-08-31T15:00:00.000Z",
    sourceSha,
    targetProjectRef,
    dataClass: "legitimate-organization",
    keyId,
    signature: "",
  },
  actors: {
    member: {
      userId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000101",
      chapterId: "chapter-a",
    },
    staff: {
      userId: "00000000-0000-4000-8000-000000000002",
      organizationId: "00000000-0000-4000-8000-000000000101",
      chapterId: "chapter-a",
    },
    foreignStaff: {
      userId: "00000000-0000-4000-8000-000000000003",
      organizationId: "00000000-0000-4000-8000-000000000102",
      chapterId: "chapter-b",
    },
  },
  probeDomains: [...REQUIRED_PROBE_DOMAINS],
};

function signManifest(value) {
  value.authorization.signature = sign(
    null,
    Buffer.from(authorizedRpcSigningPayload(value)),
    privateKey,
  ).toString("base64");
  return value;
}

function parse(value = base) {
  const signed = signManifest(structuredClone(value));
  return validateAuthorizedRpcManifest(signed, {
    now,
    expectedSha: sourceSha,
    targetProjectRef,
    trustedPublicKeys,
  });
}

describe("authorized RPC behavior manifest", () => {
  it("accepts one short-lived exact-SHA authorization over the complete governed matrix", () => {
    expect(parse()).toMatchObject({ schemaVersion: 1, authorization: { sourceSha, targetProjectRef } });
  });

  it.each([
    ["expired", (value) => { value.authorization.expiresAt = "2026-08-30T15:30:00.000Z"; }],
    ["too long", (value) => { value.authorization.expiresAt = "2026-09-20T15:00:00.000Z"; }],
    ["wrong SHA", (value) => { value.authorization.sourceSha = "c".repeat(40); }],
    ["wrong target", (value) => { value.authorization.targetProjectRef = "d".repeat(20); }],
    ["sample data", (value) => { value.authorization.dataClass = "sample"; }],
    ["missing domain", (value) => { value.probeDomains.pop(); }],
    ["same foreign organization", (value) => { value.actors.foreignStaff.organizationId = value.actors.member.organizationId; }],
    ["different positive chapter", (value) => { value.actors.staff.chapterId = "chapter-other"; }],
    ["reused identity", (value) => { value.actors.foreignStaff.userId = value.actors.member.userId; }],
  ])("rejects %s authorization", (_label, mutate) => {
    const value = structuredClone(base);
    mutate(value);
    expect(() => parse(value)).toThrow();
  });

  it("rejects fields that could smuggle credentials or protected content", () => {
    const value = structuredClone(base);
    value.actors.member.email = "member@example.test";
    expect(() => parse(value)).toThrow(/unsupported field/);
  });

  it("pins the manifest bytes by SHA-256", () => {
    expect(sha256Hex(Buffer.from("authorization"))).toBe(
      "cbb82ebec6051b780ad26655ee48b5b42658c4ac49438888aac829e82195584f",
    );
  });

  it("requires authorization signed by a reviewed trusted owner key", () => {
    const signed = signManifest(structuredClone(base));
    expect(() => validateAuthorizedRpcManifest(signed, {
      now,
      expectedSha: sourceSha,
      targetProjectRef,
      trustedPublicKeys: {},
    })).toThrow(/not trusted/);

    signed.authorization.approvedBy = "self-authorized operator";
    expect(() => validateAuthorizedRpcManifest(signed, {
      now,
      expectedSha: sourceSha,
      targetProjectRef,
      trustedPublicKeys,
    })).toThrow(/signature is invalid/);
  });

  it("distinguishes member and staff role boundaries", () => {
    expect(actorMeetsRoleBoundary("member", {})).toBe(true);
    expect(actorMeetsRoleBoundary("member", { organizationRoles: ["steward"] })).toBe(false);
    expect(actorMeetsRoleBoundary("staff", { chapterRoles: ["admin"] })).toBe(false);
    expect(actorMeetsRoleBoundary("staff", { chapterRoles: ["coordinator"] })).toBe(false);
    expect(actorMeetsRoleBoundary("staff", {
      chapterRoles: ["steward"], organizationRoles: ["admin"],
    })).toBe(false);
    expect(actorMeetsRoleBoundary("staff", { chapterRoles: ["admin", "steward"] })).toBe(true);
    expect(actorMeetsRoleBoundary("foreignStaff", {
      chapterRoles: ["admin", "coordinator"],
    })).toBe(true);
  });

  it("requires an enrolled staff pair and an ordinary no-factor member", () => {
    expect(actorMeetsMfaBoundary("member", true, 0)).toBe(true);
    expect(actorMeetsMfaBoundary("member", true, 1)).toBe(false);
    expect(actorMeetsMfaBoundary("staff", true, 1)).toBe(true);
    expect(actorMeetsMfaBoundary("staff", false, 1)).toBe(false);
    expect(actorMeetsMfaBoundary("foreignStaff", true, 0)).toBe(false);
  });

  it.each([
    [`postgres://postgres:secret@db.${targetProjectRef}.supabase.co:5432/postgres`, "direct"],
    [`postgres://postgres.${targetProjectRef}:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, "pooler"],
    [`postgres://postgres.${targetProjectRef}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`, "pooler"],
  ])("accepts a recognized exact production endpoint", (url, kind) => {
    expect(assertAuthorizedSupabaseEndpoint(url, targetProjectRef)).toBe(kind);
  });

  it.each([
    `postgres://postgres:secret@proxy-${targetProjectRef}.example.test:5432/postgres`,
    `postgres://postgres.${targetProjectRef}:secret@proxy.example.test:5432/postgres`,
    `postgres://postgres.wrongprojectrefxxxx:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    `postgres://postgres:secret@db.${targetProjectRef}.supabase.co:5432/schema_copy`,
    `postgres://postgres.${targetProjectRef}:secret@aws-0-us-east-1.pooler.supabase.com:6543/schema_copy`,
    `postgres://postgres:secret@db.${targetProjectRef}.supabase.co/postgres`,
    `postgres://postgres:secret@db.${targetProjectRef}.supabase.co:6543/postgres`,
    `postgres://postgres.${targetProjectRef}:secret@aws-0-us-east-1.pooler.supabase.com:6432/postgres`,
  ])("rejects a noncanonical production endpoint", (url) => {
    expect(() => assertAuthorizedSupabaseEndpoint(url, targetProjectRef)).toThrow(/exact|recognized/);
  });

  it.each([
    `postgres://postgres:secret@db.${targetProjectRef}.supabase.co:5432/postgres?sslmode=disable`,
    `postgres://postgres.${targetProjectRef}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
    `postgres://postgres:secret@db.${targetProjectRef}.supabase.co:5432/postgres#override`,
  ])("rejects connection-string options that could override effective TLS settings", (url) => {
    expect(() => assertAuthorizedSupabaseEndpoint(url, targetProjectRef)).toThrow(/query parameters|fragments/);
  });
});

describe("authorized RPC behavior runner discipline", () => {
  const script = readFileSync(new URL("../scripts/verify-rpc-behaviour-authorized.mjs", import.meta.url), "utf8");
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("is exposed as a separate command and is not smuggled into the DB-free check chain", () => {
    expect(pkg.scripts["verify:rpc:authorized"]).toBe(
      "node --env-file-if-exists=.env.local scripts/verify-rpc-behaviour-authorized.mjs",
    );
    expect(pkg.scripts.check).not.toContain("verify:rpc:authorized");
  });

  it("uses a read-only transaction and never contains a product write verb", () => {
    expect(code).toContain("begin transaction isolation level repeatable read read only");
    expect(code).toContain('client.query("rollback")');
    expect(code).not.toMatch(/\b(insert|update|delete|truncate|alter|create|drop)\b/i);
  });

  it("requires an external checksum-pinned manifest, exact SHA, and guarded target before connect", () => {
    expect(code).toContain("RPC_BEHAVIOUR_AUTHORIZED_MANIFEST");
    expect(code).toContain("RPC_BEHAVIOUR_AUTHORIZATION_SHA256");
    expect(code).toContain("RPC_BEHAVIOUR_EXPECTED_SHA");
    expect(code).toContain('"rev-parse", "HEAD"');
    expect(code).toContain('"status", "--porcelain", "--untracked-files=all"');
    expect(code).toContain("realpathSync(resolve(manifestInput))");
    expect(code).toContain("outsideRepository(manifestPath)");
    expect(code).toContain("assertExactTarget(contract.target, connectionString)");
    expect(code).toContain("assertAuthorizedSupabaseEndpoint(connectionString, contract.target.projectRef)");
    expect(code).toContain("trustedPublicKeys: TRUSTED_AUTHORIZATION_KEYS");
    expect(code).toContain("ssl: { rejectUnauthorized: true }");
    expect(code).not.toContain("ssl: { rejectUnauthorized: false }");
    expect(code.indexOf("assertExactTarget(contract.target, connectionString)"))
      .toBeLessThan(code.indexOf("await client.connect()"));
  });

  it("qualifies active tenant and selected-chapter scope with chapter-bound staff roles", () => {
    expect(code).toContain("u.email is not null and btrim(u.email) <> ''");
    expect(code).toContain("u.encrypted_password is not null");
    expect(code).toContain("u.encrypted_password <> '' as password_login_capable");
    expect(code).toContain("row.password_login_capable");
    expect(code).toContain("u.deleted_at is null");
    expect(code).toContain("u.banned_until is null or u.banned_until <= now()");
    expect(code).toContain("row.auth_active");
    expect(code).toContain("public.organizations o");
    expect(code).toContain("row.organization_status === \"active\"");
    expect(code).toContain("public.member_chapter_memberships cm");
    expect(code).toContain("row.chapter_membership_status === \"active\"");
    expect(code).toContain("public.member_role_chapters rc");
    expect(code).toContain("rc.chapter_id = scope.chapter_id");
    expect(code).toContain("row.chapter_roles");
    expect(code).toContain("row.organization_roles");
    expect(code).toContain("public.org_security_policy p");
    expect(code).toContain("auth.mfa_factors f");
    expect(code).toContain("row.staff_mfa_required");
    expect(code).toContain("row.verified_totp_count");
  });

  it("refuses local fixture databases and executes only real RLS reads", () => {
    expect(code).toContain("the legitimate-identity lane refuses local or disposable databases");
    expect(code).toContain("set local role authenticated");
    expect(code).toContain("member cannot read the foreign-organization staff profile");
    expect(code).toContain("staff cannot read the foreign-organization staff profile");
    expect(code).toContain("foreign staff cannot read the member profile");
  });

  it("reports only identity qualification, not readiness for domain mutation probes", () => {
    expect(code).toContain("IDENTITY-QUALIFIED:");
    expect(code).toContain("domain-specific topology and mutation probes remain separately gated");
    expect(code).not.toContain("READY:");
  });

  it("keeps qualification and RLS probes on one repeatable-read snapshot", () => {
    expect(code.indexOf("begin transaction isolation level repeatable read read only"))
      .toBeLessThan(code.indexOf("const qualification = await client.query"));
  });
});
