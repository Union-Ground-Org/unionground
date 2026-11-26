// @vitest-environment node
//
// SEC-UG-CASEWORK-NOTE-RESTRICTION-BYPASS-20260917
//
// A chapter coordinator with no casework_access_grants row could append notes
// to a RESTRICTED case through public.coordinator_add_case_note and
// public.casework_add_case_note, then read the whole thread back through
// public.list_case_latest_updates and a direct select on
// public.member_case_updates. Both halves were closed on Main by the sibling
// records' repairs (PR #2158): 20260917104000 gates
// private.coordinator_case_for_update, which both note writers call, on
// private.member_case_visible_to_caller, and 20260917103000 gates
// member_case_updates_select_coordinator on the parent case row. Neither proof
// exercised casework_add_case_note or the list RPC, and neither proved the
// write-then-read-back composition this record names. This file does, and
// adds a catalog guard so a future note writer that skips the gate fails here.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const GATE = "private.coordinator_case_for_update(p_case_id)";
const NOTE_WRITERS = [
  "public.coordinator_add_case_note(p_case_id uuid, p_body text)",
  "public.casework_add_case_note(p_case_id uuid, p_body text, p_mention_ids uuid[])",
];
// REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030
// (20261031010000): the steward's own note writer is the one reviewed writer
// that does not take the coordinator hat. It admits only the case's assigned
// steward, and only while private.casework_staff_can_access still admits them,
// which keeps a restricted case to its own steward, coordinator, an
// organization advisor/admin/vp or an active casework_access_grants row: the
// same restriction rule the coordinator helper enforces.
const STEWARD_NOTE_WRITER = "public.steward_add_case_note(p_case_id uuid, p_body text, p_occurred_on date)";
const STEWARD_GATES = [
  "v_case.steward_user_id is distinct from caller",
  "or not private.casework_staff_can_access(v_case.id) then",
];

describe("casework note restriction contract", () => {
  it("pins both note writers behind the visibility-gated coordinator helper and the gated read surfaces", () => {
    for (const sig of NOTE_WRITERS) {
      const entry = contract.functions.find((fn) => fn.sig === sig);
      expect(entry, sig).toBeDefined();
      expect(entry.bodyContains, sig).toContain(GATE);
    }
    const steward = contract.functions.find((fn) => fn.sig === STEWARD_NOTE_WRITER);
    expect(steward, STEWARD_NOTE_WRITER).toBeDefined();
    expect(steward.bodyContains).toEqual(expect.arrayContaining(STEWARD_GATES));
    const gate = contract.functions.find((fn) => fn.sig === "private.coordinator_case_for_update(p_case_id uuid)");
    expect(gate.bodyContains).toEqual(expect.arrayContaining([
      "private.member_case_visible_to_caller(p_case_id)",
      "private.member_case_visible_to_caller(c.id)",
    ]));
    // Invoker security is what makes the list RPC inherit the policy below.
    const list = contract.functions.find((fn) => fn.sig === "public.list_case_latest_updates(p_case_ids uuid[], p_per_case integer)");
    expect(list.secdef).toBe(false);
    const read = contract.policies.find((p) => (
      p.table === "member_case_updates" && p.name === "member_case_updates_select"
    ));
    // Since 20261106226000 (#7360) the policy is the readable-parent branch
    // alone: the coordinator branch it held already implied it, so a note
    // follows its case row and nothing else.
    expect(read.qual).toBe("(EXISTS ( SELECT 1\n   FROM member_cases c\n  WHERE ((c.id = member_case_updates.case_id) AND private.chapter_case_readable(c.*))))");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a restricted case's note thread follows the case row", () => {
  let client;
  const id = Object.fromEntries([
    "owner", "coordinator", "steward", "ownerSession", "coordinatorSession", "stewardSession",
    "org", "openCase", "restrictedCase",
  ].map((key) => [key, randomUUID()]));
  const chapter = `case-note-gate-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const attempt = async (sqlText, params = []) => {
    await client.query("savepoint note_gate");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint note_gate");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint note_gate");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  // Ground truth, read as the table owner so RLS cannot hide a leaked write.
  const storedNotes = async (caseId) => {
    const previous = (await client.query("select current_user as u")).rows[0].u;
    await client.query("reset role");
    try {
      return (await client.query(
        "select count(*)::int as n from public.member_case_updates where case_id = $1", [caseId],
      )).rows[0].n;
    } finally {
      if (previous === "authenticated") await client.query("set local role authenticated");
    }
  };

  const writeBoth = async (caseId, label) => ({
    legacy: await attempt("select public.coordinator_add_case_note($1, $2)", [caseId, `${label} legacy note`]),
    casework: await attempt(
      "select public.casework_add_case_note($1, $2, $3::uuid[])",
      [caseId, `${label} casework note`, [id.steward]],
    ),
  });

  const readBack = async (caseId) => ({
    direct: (await client.query(
      "select body from public.member_case_updates where case_id = $1 order by body", [caseId],
    )).rows.map((row) => row.body),
    // One transaction gives every note the same created_at, so compare by body.
    listed: (await client.query(
      "select body, mentions from public.list_case_latest_updates($1::uuid[], 100) order by body", [[caseId]],
    )).rows,
  });

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-note-restriction-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.owner, id.ownerSession, "Note Gate Owner"],
      [id.coordinator, id.coordinatorSession, "Note Gate Coordinator"],
      [id.steward, id.stewardSession, "Note Gate Steward"],
    ];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic note-gate factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `case-note-gate-${id.org}`, id.owner]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9903)", [chapter, id.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const [user, , name] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, name]);
    }
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.coordinator]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)", [id.org, id.steward]);
    // casework_add_case_note resolves the mention audience from member_roles.
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [id.steward, chapter]);

    for (const [caseId, reference, restricted] of [
      [id.openCase, "CASE-NOTE-OPEN", false],
      [id.restrictedCase, "CASE-NOTE-RESTRICTED", true],
    ]) {
      await client.query(
        `insert into public.member_cases(
           id,user_id,reference,title,case_type,organization_id,chapter_id,steward_user_id,
           is_restricted,restriction_reason,restricted_at,restricted_by)
         values($1,$2,$3,$3,'other',$4,$5,$6,$7,$8,$9,$10)`,
        [caseId, id.owner, reference, id.org, chapter, id.steward,
          restricted, restricted ? "sensitive investigation" : null,
          restricted ? new Date() : null, restricted ? id.owner : null],
      );
      // The thread already holds a note that mentions the steward by name, as
      // an organization admin's note would.
      await client.query(
        "insert into public.member_case_updates(case_id,user_id,body,mentioned_user_ids) values($1,$2,$3,$4::uuid[])",
        [caseId, id.owner, `${reference} admin note`, [id.steward]],
      );
    }

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(client);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses both note writers and returns no thread to a grant-less coordinator on a restricted case", async () => {
    await act(id.coordinator, id.coordinatorSession);
    expect((await client.query("select public.staff_can_see_user($1,'coordinator') as ok", [id.owner])).rows[0].ok).toBe(true);
    expect((await client.query("select count(*)::int as n from public.member_cases where id = $1", [id.restrictedCase])).rows[0].n).toBe(0);

    const before = await storedNotes(id.restrictedCase);
    const writes = await writeBoth(id.restrictedCase, "restricted-denied");
    expect(writes.legacy).toMatchObject({ ok: false, code: "42501" });
    expect(writes.casework).toMatchObject({ ok: false, code: "42501" });
    expect(await storedNotes(id.restrictedCase)).toBe(before);

    expect(before).toBeGreaterThan(0);
    expect(await readBack(id.restrictedCase)).toEqual({ direct: [], listed: [] });
  });

  it("keeps both writers and both reads for the same coordinator on a non-restricted case", async () => {
    await act(id.coordinator, id.coordinatorSession);
    const writes = await writeBoth(id.openCase, "open-allowed");
    expect(writes.legacy.ok, writes.legacy.message).toBe(true);
    expect(writes.casework.ok, writes.casework.message).toBe(true);
    const thread = await readBack(id.openCase);
    expect(thread.direct).toEqual([
      "CASE-NOTE-OPEN admin note", "open-allowed casework note", "open-allowed legacy note",
    ]);
    expect(thread.listed.map((row) => row.body)).toEqual(thread.direct);
  });

  it("opens the restricted thread with an active grant and closes it again on revoke", async () => {
    await client.query("reset role");
    const grant = randomUUID();
    await client.query(
      `insert into public.casework_access_grants(id,case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
       values($1,$2,$3,$4,$5,$6,'cover for the assigned coordinator')`,
      [grant, id.restrictedCase, id.org, chapter, id.coordinator, id.owner],
    );

    await act(id.coordinator, id.coordinatorSession);
    const writes = await writeBoth(id.restrictedCase, "restricted-granted");
    expect(writes.legacy.ok, writes.legacy.message).toBe(true);
    expect(writes.casework.ok, writes.casework.message).toBe(true);
    const thread = await readBack(id.restrictedCase);
    expect(thread.direct).toEqual([
      "CASE-NOTE-RESTRICTED admin note", "restricted-granted casework note", "restricted-granted legacy note",
    ]);
    expect(thread.listed.map((row) => row.body)).toEqual(thread.direct);
    expect(thread.listed[0].mentions.map((m) => m.userId)).toEqual([id.steward]);
    expect(thread.listed[1].mentions.map((m) => m.userId)).toEqual([id.steward]);

    await client.query("reset role");
    await client.query("update public.casework_access_grants set revoked_at=now(), revoked_by=$2 where id=$1", [grant, id.owner]);

    await act(id.coordinator, id.coordinatorSession);
    const before = await storedNotes(id.restrictedCase);
    const refused = await writeBoth(id.restrictedCase, "restricted-revoked");
    expect(refused.legacy).toMatchObject({ ok: false, code: "42501" });
    expect(refused.casework).toMatchObject({ ok: false, code: "42501" });
    expect(await storedNotes(id.restrictedCase)).toBe(before);
    expect(await readBack(id.restrictedCase)).toEqual({ direct: [], listed: [] });
  });

  it("leaves the case owner's and the assigned steward's note reads on both cases unchanged", async () => {
    for (const [actor, session] of [[id.owner, id.ownerSession], [id.steward, id.stewardSession]]) {
      await act(actor, session);
      for (const caseId of [id.openCase, id.restrictedCase]) {
        const thread = await readBack(caseId);
        const stored = await storedNotes(caseId);
        expect(thread.direct.length, `${actor} ${caseId}`).toBe(stored);
        expect(thread.listed.map((row) => row.body)).toEqual(thread.direct);
      }
    }
  });

  it("finds no client-callable note writer that skips the visibility-gated coordinator helper", async () => {
    await client.query("reset role");
    const writers = (await client.query(
      `select n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig, p.prosrc
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema')
          and p.prosrc ~* 'insert\\s+into\\s+public\\.member_case_updates'
          and pg_catalog.has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`,
    )).rows;
    // The member's own note path (20261104075000) is gated on owning the
    // case and on the same case-row visibility the scoped-parent policy uses.
    const OWN_NOTE_WRITER = "public.add_my_case_update(p_case_id uuid, p_body text, p_occurred_on date)";
    expect(writers.map((row) => row.sig)).toEqual([
      OWN_NOTE_WRITER,
      "public.casework_add_case_note(p_case_id uuid, p_body text, p_mention_ids uuid[])",
      "public.coordinator_add_case_note(p_case_id uuid, p_body text)",
      STEWARD_NOTE_WRITER,
    ]);
    for (const row of writers) {
      if (row.sig === OWN_NOTE_WRITER) {
        for (const gate of ["c.id = p_case_id and c.user_id = caller", "private.chapter_case_readable(case_row)"]) expect(row.prosrc, row.sig).toContain(gate);
      } else if (row.sig === STEWARD_NOTE_WRITER) for (const gate of STEWARD_GATES) expect(row.prosrc, row.sig).toContain(gate);
      else expect(row.prosrc, row.sig).toContain(GATE);
    }
  });
});
