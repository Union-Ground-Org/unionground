// @vitest-environment node
//
// BUG-UG-ACCEPTED-INVITATIONS-SHOW-EXPIRY-20261102 (#6816)
//
// The invitation lists showed the link's expiry on accepted and revoked rows.
// get_member_invitations now returns when each invitation was accepted and
// revoked, straight from accepted_at and revoked_at, with every other part of
// the read unchanged. One fictional tenant (Harbor Workers Local 7); every row
// is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261103005000_member_invitations_lifecycle_times";
const PREVIOUS = "20261022171700_roster_invitation_import";
const LIST = "public.get_member_invitations(p_limit integer default 50)";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const HASH = (pair) => pair.repeat(32);

describe("invitation lifecycle times (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const list = stripComments(fnBody(sql, LIST));

  it("is one atomic migration that only adds the two times to the list read", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const previous = stripComments(fnBody(stripComments(loadMigrationSql(PREVIOUS)), LIST));
    expect(list.replace(",\n        'acceptedAt', s.accepted_at,\n        'revokedAt', s.revoked_at", "")).toBe(previous);
    // REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171) later adds the
    // source and the sending member after these two times, and nothing else.
    expect(stripComments(latestFnBody(LIST)).replace(/,\s*'source', s\.source,[\s\S]*?\) end(?=\n\s*\) order by)/u, "")).toBe(list);
  });

  it("keeps the browser grant to authenticated callers only", () => {
    expect(sql).toContain("revoke all on function public.get_member_invitations(integer)\n  from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_member_invitations(integer)\n  to authenticated;");
  });

  it("pins both times in the database contract", () => {
    expect(contract.functions.find((row) => row.sig === "public.get_member_invitations(p_limit integer)").bodyContains)
      .toEqual(expect.arrayContaining(["'acceptedAt', s.accepted_at", "'revokedAt', s.revoked_at"]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("invitation lifecycle times on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "member-invitations-lifecycle-times-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  it("lists accepted and revoked times only where the database recorded them, and a lapsed link as expired", async () => {
    await client.query("begin");
    try {
      const org = randomUUID();
      const local = `hwl7-local-${org}`;
      await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `hwl7-${org}`, `Harbor Workers Local 7 ${org}`]);
      await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Harbor Local',$1,'proof',$2,9973)", [local, org]);
      const admin = randomUUID();
      await client.query("insert into auth.users(id,email) values ($1,$2)", [admin, `${admin}@example.invalid`]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [admin, local]);
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, admin]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [admin, local]);
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), admin]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [admin, local]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [admin, local]);

      const invite = async (name, fields) => (await client.query(
        `insert into public.member_invitations (normalized_email, full_name, first_name, initials, chapter_id, locale, token_hash, status, invited_by, expires_at, accepted_at, revoked_at)
         values ($1, $2, 'Proof', 'PI', $3, 'en', $4, $5, $6, $7, $8, $9) returning id`,
        [`${name}-${org}@example.invalid`, `Proof ${name}`, local, fields.token ?? null, fields.status, admin, fields.expiresAt, fields.acceptedAt ?? null, fields.revokedAt ?? null],
      )).rows[0].id;
      const pending = await invite("pending", { status: "pending", token: HASH("c1"), expiresAt: "2099-01-01T00:00:00Z" });
      const toRevoke = await invite("to-revoke", { status: "pending", token: HASH("c2"), expiresAt: "2099-01-01T00:00:00Z" });
      const lapsed = await invite("lapsed", { status: "pending", token: HASH("c3"), expiresAt: "2026-10-01T00:00:00Z" });
      const accepted = await invite("accepted", { status: "accepted", expiresAt: "2026-11-02T16:23:00Z", acceptedAt: "2026-11-02T16:14:00Z" });
      const revokedUntimed = await invite("revoked-untimed", { status: "revoked", expiresAt: "2026-11-02T16:23:00Z" });

      await actAs(admin);
      const revoke = (await client.query("select public.revoke_member_invitation($1) as v", [toRevoke])).rows[0].v;
      const listed = (await client.query("select public.get_member_invitations(50) as v")).rows[0].v;
      await asOwner();
      const revokedAt = (await client.query("select revoked_at from public.member_invitations where id=$1", [toRevoke])).rows[0].revoked_at;

      expect(revoke).toMatchObject({ accepted: true, revoked: true });
      const byId = new Map(listed.items.map((item) => [item.id, item]));
      const at = (value) => (value === null ? null : Date.parse(value));
      expect(byId.get(pending)).toMatchObject({ status: "pending", acceptedAt: null, revokedAt: null });
      expect(at(byId.get(pending).expiresAt)).toBe(Date.parse("2099-01-01T00:00:00Z"));
      expect(byId.get(lapsed)).toMatchObject({ status: "expired", acceptedAt: null, revokedAt: null });
      expect(byId.get(accepted)).toMatchObject({ status: "accepted", revokedAt: null });
      expect(at(byId.get(accepted).acceptedAt)).toBe(Date.parse("2026-11-02T16:14:00Z"));
      expect(byId.get(toRevoke)).toMatchObject({ status: "revoked", acceptedAt: null });
      expect(at(byId.get(toRevoke).revokedAt)).toBe(revokedAt.getTime());
      // A revocation that recorded no time lists none; the read never fills one in.
      expect(byId.get(revokedUntimed)).toMatchObject({ status: "revoked", acceptedAt: null, revokedAt: null });
    } finally {
      await client.query("rollback");
    }
  });
});
