// @vitest-environment node
//
// SEC-UG-COORDINATION-TRANSITION-RPC-NO-OWNING-ORGANIZATION-PREDICATE-20260920
//
// public.transition_organization_coordination_record is the write path behind
// Activate, Publish, Pause, Complete and Close on the organization coordination
// desk. Coordination records are deliberately readable across partner
// organizations, so readability cannot be the write boundary. The installed
// definition (20260828235000_mi1_organization_coordination_hardening.sql)
// refuses a staff transition unless the record's organization is the caller's
// selected organization, with an error distinct from the read refusal:
//
//   read refusal       22023 'coordination record unavailable'
//   ownership refusal  42501 'coordination record owner role required'
//
// Until now only a text pin covered that predicate. This proof seeds two
// organizations linked as coordination partners and shows, on the live
// catalogue, that partner staff who CAN read the record are refused with the
// ownership error and change nothing, while the owning staff succeed.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const databaseIt = process.env.RUN_COORDINATION_TRANSITION_OWNERSHIP_DB_TESTS === "1" ? it : it.skip;
const TRANSITION_SIG = "public.transition_organization_coordination_record(p_record_id uuid, p_transition text, p_config jsonb, p_points integer, p_idempotency_key uuid)";
const OWNERSHIP_PREDICATE = "if item.organization_id <> organization then";
const OWNERSHIP_REFUSAL = "coordination record owner role required";
const READ_REFUSAL = "coordination record unavailable";

describe("coordination transition ownership predicate, offline", () => {
  it("pins the ownership predicate and its distinct refusal in the database contract", () => {
    const entry = contract.functions.find((fn) => fn.sig === TRANSITION_SIG);
    expect(entry).toBeTruthy();
    expect(entry.secdef).toBe(true);
    expect(entry.bodyContains).toContain(OWNERSHIP_PREDICATE);
    expect(entry.bodyContains).toContain(OWNERSHIP_REFUSAL);
    expect(entry.bodyContains).toContain("private.organization_coordination_can_read(item.id)");
  });

  it("orders the ownership refusal before any status or configuration write", () => {
    const body = stripComments(fnBody(
      loadMigrationSql("20260828235000_mi1_organization_coordination_hardening"),
      "public.transition_organization_coordination_record",
    )).replace(/\s+/g, " ");
    const ownership = body.indexOf(`${OWNERSHIP_PREDICATE} raise exception '${OWNERSHIP_REFUSAL}' using errcode = '42501';`);
    expect(ownership).toBeGreaterThan(-1);
    expect(body.indexOf(`raise exception '${READ_REFUSAL}' using errcode = '22023';`)).toBeGreaterThan(-1);
    expect(ownership).toBeLessThan(body.indexOf("update public.organization_coordination_records set status = next_status"));
  });
});

const PEOPLE = ["staffA", "staffB"];

async function seed(client) {
  const ids = { orgA: randomUUID(), orgB: randomUUID() };
  ids.chapterA = `coord-owner-a-${ids.orgA}`;
  ids.chapterB = `coord-owner-b-${ids.orgB}`;
  for (const name of PEOPLE) {
    ids[name] = randomUUID();
    ids[`${name}Session`] = randomUUID();
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [ids[name], `${ids[name]}@example.invalid`]);
  }
  for (const [org, chapter, staff] of [["orgA", "chapterA", "staffA"], ["orgB", "chapterB", "staffB"]]) {
    const user = ids[staff];
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids[org], `coord-owner-${ids[org]}`, user]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9903)", [ids[chapter], ids[org]]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids[org]]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[`${staff}Session`], user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic coordination owner factor','totp','verified',now(),now())", [randomUUID(), user]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids[org], user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids[chapter]]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, ids[chapter]]);
    for (const role of ["admin", "coordinator"]) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids[org], user, role]);
    }
  }
  // A partner must be one the caller can already see (#8365):
  // organization B is listed in the network directory.
  await client.query("insert into public.organization_network_directory_profiles(organization_id,display_name,visibility,contact_mode) values($1,'Synthetic coordination partner','directory','disabled')", [ids.orgB]);
  return ids;
}

async function withFixture(run) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  await client.query("begin");
  try {
    const ids = await seed(client);
    const sessions = Object.fromEntries(PEOPLE.map((name) => [ids[name], ids[`${name}Session`]]));
    let savepoint = 0;
    const callAs = async (user, sql, values = []) => {
      const label = `coord_owner_${++savepoint}`;
      await client.query(`savepoint ${label}`);
      try {
        await client.query("select set_config('request.jwt.claims',$1,true)",
          [JSON.stringify({ role: "authenticated", sub: user, session_id: sessions[user], aal: "aal2" })]);
        await client.query("set local role authenticated");
        const result = await client.query(sql, values);
        await client.query("reset role");
        await client.query(`release savepoint ${label}`);
        return { code: "", rows: result.rows };
      } catch (error) {
        await client.query(`rollback to savepoint ${label}`);
        await client.query("reset role");
        return { code: error.code || "?", message: error.message || "", rows: [] };
      }
    };
    const recordState = async (recordId) => (await client.query(
      "select status, config from public.organization_coordination_records where id=$1", [recordId])).rows[0];
    await run({ ids, callAs, recordState });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

const transition = "select public.transition_organization_coordination_record($1,$2,$3::jsonb,0,$4) result";

describe("coordination transition ownership predicate, live", () => {
  databaseIt("refuses partner staff who can read the record and lets the owning staff transition it", async () => {
    await withFixture(async ({ ids, callAs, recordState }) => {
      const link = await callAs(ids.staffA,
        "select public.create_organization_coordination_record('network_link','Owner proof link','', 'staff', $1, null, null, '{}', $2) result",
        [ids.orgB, randomUUID()]);
      expect(link, link.message).toMatchObject({ code: "" });
      const recordId = link.rows[0].result.id;

      // Invited, not yet a reader: the read refusal.
      const invited = await callAs(ids.staffB, transition, [recordId, "pause", "{}", randomUUID()]);
      expect(invited).toMatchObject({ code: "22023", message: READ_REFUSAL });

      // Organization B accepts; its staff can now read the owner's record.
      expect((await callAs(ids.staffB,
        "select public.respond_organization_coordination_invitation($1,true,$2)", [recordId, randomUUID()])).code).toBe("");
      // The desk reads through the snapshot RPC; it now returns the owner's
      // record to the partner's staff.
      const partnerRead = await callAs(ids.staffB, "select public.get_organization_coordination_snapshot() result");
      expect(partnerRead, partnerRead.message).toMatchObject({ code: "" });
      expect(partnerRead.rows[0].result.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: recordId, organizationId: ids.orgA }),
      ]));
      const before = await recordState(recordId);
      expect(before.status).toBe("active");

      // Partner staff: the ownership refusal, distinct from the read refusal,
      // and neither the status nor the configuration moves.
      for (const step of ["pause", "complete", "close"]) {
        const refused = await callAs(ids.staffB, transition, [recordId, step, '{"hijacked":true}', randomUUID()]);
        expect(refused, step).toMatchObject({ code: "42501", message: OWNERSHIP_REFUSAL });
      }
      expect(await recordState(recordId)).toEqual(before);

      // The owning staff succeed through the same RPC.
      const owned = await callAs(ids.staffA, transition, [recordId, "pause", '{"note":"owner"}', randomUUID()]);
      expect(owned, owned.message).toMatchObject({ code: "" });
      expect(owned.rows[0].result).toMatchObject({ transitioned: true, recordId, status: "paused" });
      const after = await recordState(recordId);
      expect(after.status).toBe("paused");
      expect(after.config).toMatchObject({ note: "owner" });
      expect(after.config).not.toHaveProperty("hijacked");
    });
  }, 60_000);
});
