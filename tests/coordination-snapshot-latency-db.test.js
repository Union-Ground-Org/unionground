// @vitest-environment node
// Owned loopback only. Fixtures and diagnostic function replacements roll back.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("coordination snapshot authorization and bounded work", () => {
  let db;
  const orgA = randomUUID(), orgB = randomUUID();
  const people = Object.fromEntries(["member", "staff", "other"].map(name => [name, { id: randomUUID(), session: randomUUID() }]));
  const records = [];
  const ids = {};

  async function identity(name, overrides = {}) {
    await db.query("reset role");
    const person = people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, role: "authenticated", aal: "aal2", session_id: person.session, ...overrides })]);
  }
  async function rpc(name, sql = "select public.get_organization_coordination_snapshot() value", args = [], overrides = {}) {
    await identity(name, overrides);
    await db.query("savepoint rpc");
    try {
      await db.query("set local role authenticated");
      return (await db.query(sql, args)).rows[0]?.value;
    } finally {
      await db.query("rollback to savepoint rpc");
      await db.query("reset role");
    }
  }
  async function record(name, org, visibility, kind = "mission", participation = null) {
    const id = randomUUID(); ids[name] = id;
    records.push({ id, org, visibility, kind });
    await db.query(`insert into public.organization_coordination_records
      (id,organization_id,kind,title,status,visibility,created_by,idempotency_key)
      values ($1,$2,$3,$4,'active',$5,$6,$7)`, [id, org, kind, name, visibility, people.staff.id, randomUUID()]);
    if (participation) await db.query(`insert into public.organization_coordination_organization_participants
      (record_id,organization_id,role,status) values ($1,$2,'partner',$3)`, [id, orgA, participation]);
    return id;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "coordination-snapshot-latency-proof" });
    await db.connect(); await db.query("begin");
    await db.query("set local statement_timeout='60s'");
    for (const org of [orgA, orgB]) {
      await db.query("insert into public.organizations(id,slug,name) values ($1::uuid,$1::text,$1::text)", [org]);
      await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,9983)", [`coord-${org}`, org]);
    }
    for (const [name, person] of Object.entries(people)) {
      const org = name === "other" ? orgB : orgA;
      await db.query("insert into auth.users(id,email) values ($1,$2)", [person.id, `${person.id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [person.id, `coord-${org}`]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, person.id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [person.id, `coord-${org}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [person.session, person.id]);
      if (name === "staff") {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org, person.id]);
        await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), person.id]);
      }
    }
    // Bypass only fixture inheritance/stamping, never the reader or its auth helpers.
    await db.query("set local session_replication_role=replica");
    for (const visibility of ["members", "public", "staff", "participants"]) {
      await record(`own-${visibility}`, orgA, visibility);
      await record(`foreign-${visibility}`, orgB, visibility);
    }
    await record("shared-active", orgB, "participants", "mission", "active");
    await record("shared-invited", orgB, "participants", "mission", "invited");
    await record("shared-revoked", orgB, "participants", "mission", "revoked");
    for (const name of ["own-participants", "shared-active", "shared-invited", "shared-revoked"]) {
      await db.query(`insert into public.organization_coordination_user_participants
        (record_id,organization_id,user_id,role,status,privacy_alias)
        values ($1,$2,$3,'participant','completed','Member proof')`, [ids[name], orgA, people.member.id]);
    }
    for (const name of ["own-chat", "shared-chat", "invited-chat", "foreign-chat"]) {
      const own = name === "own-chat";
      const id = await record(name, own ? orgA : orgB, "participants", "network_conversation", name === "shared-chat" ? "active" : name === "invited-chat" ? "invited" : null);
      if (own || name === "shared-chat") await db.query(`insert into public.organization_coordination_user_participants
        (record_id,organization_id,user_id,role,status,privacy_alias)
        values ($1,$2,$3,'conversation_member','active','Member proof')`, [id, orgA, people.member.id]);
    }
    // 665 total records, 367 owned by the selected organization, 170 messages.
    await db.query(`insert into public.organization_coordination_records
      (organization_id,kind,title,status,visibility,created_by,idempotency_key)
      select case when n<=362 then $1::uuid else $2::uuid end,'network_link',
        'Load fixture '||n,'active','members',$3,gen_random_uuid()
      from generate_series(1,650) n`, [orgA, orgB, people.staff.id]);
    for (const [index, name] of ["own-chat", "shared-chat", "invited-chat", "foreign-chat"].entries()) {
      await db.query(`insert into public.organization_coordination_messages
        (conversation_id,sender_organization_id,sender_user_id,body,idempotency_key,created_at)
        select $1,$2,$3,'Load fixture message',gen_random_uuid(),
          '2026-10-01'::timestamptz + ((n*4+$4)::text||' seconds')::interval
        from generate_series(1,$5) n`, [ids[name], name === "own-chat" ? orgA : orgB, people.staff.id, index, index < 2 ? 43 : 42]);
      await db.query(`insert into public.organization_coordination_resources
        (record_id,resource_kind,title,status,from_organization_id,to_organization_id,created_by,idempotency_key)
        values ($1,'request','Fixture resource','requested',$2,$3,$4,gen_random_uuid())`, [ids[name], orgB, orgA, people.staff.id]);
    }
    await db.query("set local session_replication_role=origin");
  }, 60_000);
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("preserves owner, active partner, member, staff and participant visibility", async () => {
    for (const name of Object.keys(people)) {
      await identity(name);
      const expected = (await db.query(`select id, kind from public.organization_coordination_records
        where private.organization_coordination_can_read(id) order by updated_at desc,id desc`)).rows;
      const value = await rpc(name);
      expect(value.records.map(r => r.id)).toEqual(expected.slice(0, 50).map(r => r.id));
      // Union Ground (D5): no leaderboards leave the database.
      expect(value).not.toHaveProperty("leaderboards");
      expect(value.messages.map(r => r.id)).toEqual((await db.query(`select id from public.organization_coordination_messages
        where private.organization_coordination_can_read(conversation_id) order by created_at desc,id desc limit 30`)).rows.map(r => r.id));
      expect(value.resources.map(r => r.recordId).sort()).toEqual(["own-chat", "shared-chat", "invited-chat", "foreign-chat"].map(n => ids[n]).filter(id => expected.some(r => r.id === id)).sort());
    }
  }, 120_000);

  it("pages messages without losing partner messages or admitting invitations", async () => {
    await identity("member");
    const expected = (await db.query(`select id from public.organization_coordination_messages
      where private.organization_coordination_can_read(conversation_id) order by created_at desc,id desc`)).rows.map(r => r.id);
    const actual = []; let cursor = null;
    do {
      const page = await rpc("member", "select public.list_organization_coordination_messages($1,$2,30) value", [cursor?.createdAt ?? null, cursor?.id ?? null]);
      actual.push(...page.messages.map(r => r.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(86);
  }, 60_000);

  it("does not invoke per-row identity resolution in either public reader", async () => {
    await db.query("savepoint predicate_probe");
    try {
      await db.query(`create or replace function private.organization_coordination_can_read(p_record_id uuid)
        returns boolean language plpgsql stable security definer set search_path='' as
        $probe$ begin raise exception 'per-row authorization probe'; end; $probe$`);
      expect((await rpc("member")).state).toBe("ready");
      expect((await rpc("member", "select public.list_organization_coordination_messages() value")).messages).toHaveLength(30);
    } finally { await db.query("rollback to savepoint predicate_probe"); }
  });

  it("revalidates revoked participation and refuses direct helper execution", async () => {
    await db.query("savepoint revoke_probe");
    try {
      await db.query("update public.organization_coordination_organization_participants set status='revoked' where record_id=any($1::uuid[])", [[ids["shared-active"], ids["shared-chat"]]]);
      await db.query("update public.organization_coordination_user_participants set status='revoked' where record_id=$1 and user_id=$2", [ids["own-participants"], people.member.id]);
      const value = await rpc("member");
      expect(value.records.some(r => r.id === ids["shared-active"])).toBe(false);
      expect(value.records.some(r => r.id === ids["own-participants"])).toBe(false);
      expect(value.messages.some(m => m.conversationId === ids["shared-chat"])).toBe(false);
      await expect(rpc("member", "select private.organization_coordination_visible_records($1,$2,true) value", [orgB, people.member.id])).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("rollback to savepoint revoke_probe"); }
  });

  it("retains MFA, empty-organization and anonymous execution boundaries", async () => {
    await expect(rpc("staff", undefined, [], { aal: "aal1" })).rejects.toMatchObject({ code: "42501", message: "mfa required" });
    await expect(rpc("staff", "select public.list_organization_coordination_messages() value", [], { aal: "aal1" })).rejects.toMatchObject({ code: "42501", message: "mfa required" });
    await db.query("savepoint membership_probe");
    try {
      await db.query("update public.organization_memberships set status='revoked',revoked_at=now() where organization_id=$1 and user_id=$2", [orgA, people.member.id]);
      const empty = await rpc("member");
      expect(empty.state).toBe("empty");
      expect(empty.organizationId).toBeNull();
      for (const key of ["records", "messages", "resources", "exportRuns", "outreach"]) expect(empty[key]).toEqual([]);
      expect(empty).not.toHaveProperty("leaderboards");
      await expect(rpc("member", "select public.list_organization_coordination_messages() value")).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query("rollback to savepoint membership_probe"); }
    for (const signature of ["public.get_organization_coordination_snapshot()", "public.list_organization_coordination_messages(timestamptz,uuid,integer)", "private.organization_coordination_visible_records(uuid,uuid,boolean)"]) {
      expect((await db.query("select has_function_privilege('anon',$1,'EXECUTE') allowed", [signature])).rows[0].allowed).toBe(false);
    }
  });

  it("bounds member reads with matching and nonmatching participant rows at fixture scale", async () => {
    await db.query("savepoint participant_scale");
    try {
      await db.query("set local session_replication_role=replica");
      await db.query("update public.organization_coordination_records set visibility='participants' where organization_id=any($1::uuid[]) and title like 'Load fixture %'", [[orgA, orgB]]);
      await db.query(`insert into public.organization_coordination_user_participants
        (record_id,organization_id,user_id,role,status,privacy_alias)
        select id,$1,$2,'participant',case when (substring(title from '[0-9]+$'))::int%4=0 then 'completed' else 'active' end,'Member scale'
        from public.organization_coordination_records
        where organization_id=$1 and title like 'Load fixture %'
          and (substring(title from '[0-9]+$'))::int%2=0`, [orgA, people.member.id]);
      await db.query("set local session_replication_role=origin");
      const value = await rpc("member");
      // Compare the full visibility order with the existing scalar predicate;
      // both matching and nonmatching participant paths are exercised.
      const allowed = (await db.query(`select id from public.organization_coordination_records
        where private.organization_coordination_can_read(id)
        order by updated_at desc,id desc limit 50`)).rows.map(r => r.id);
      expect(value.records).toHaveLength(50);
      expect(value.records.map(r => r.id)).toEqual(allowed);
      const bulk = value.records.filter(r => r.title.startsWith("Load fixture "));
      expect(bulk.length).toBeGreaterThan(0);
      expect(bulk.every(r => Number(r.title.split(" ").at(-1)) % 2 === 0)).toBe(true);
      for (const [label, sql] of [["participants-snapshot", "select public.get_organization_coordination_snapshot() value"], ["participants-messages", "select public.list_organization_coordination_messages() value"]]) {
        await rpc("member", sql);
        const samples = [];
        for (let n = 0; n < 5; n++) { const start = performance.now(); await rpc("member", sql); samples.push(+(performance.now() - start).toFixed(2)); }
        const median = [...samples].sort((a,b) => a-b)[2];
        const report = JSON.stringify({ label, samples_ms: samples, median_ms: median, records: 665, messages: 170, matching_bulk_participants: 181, nonmatching_bulk_records: 469 });
        if (process.env.COORDINATION_PARTICIPANTS_BENCHMARK_OUTPUT) appendFileSync(process.env.COORDINATION_PARTICIPANTS_BENCHMARK_OUTPUT, report + "\n");
        if (process.env.COORDINATION_BASELINE !== "1") expect(median).toBeLessThan(runnerTimeout(2000));
      }
    } finally { await db.query("rollback to savepoint participant_scale"); }
  }, 180_000);

  if (process.env.COORDINATION_BENCHMARK === "1") it("reports five-call warm medians for the fixture", async () => {
    for (const [label, sql] of [["snapshot", "select public.get_organization_coordination_snapshot() value"], ["messages", "select public.list_organization_coordination_messages() value"]]) {
      await rpc("member", sql);
      const samples = [];
      for (let n = 0; n < 5; n++) { const start = performance.now(); await rpc("member", sql); samples.push(+(performance.now() - start).toFixed(2)); }
      const median = [...samples].sort((a,b) => a-b)[2];
      const report = JSON.stringify({ label, samples_ms: samples, median_ms: median, records: 665, messages: 170 });
      process.stdout.write(report + "\n");
      if (process.env.COORDINATION_BENCHMARK_OUTPUT) appendFileSync(process.env.COORDINATION_BENCHMARK_OUTPUT, report + "\n");
      if (process.env.COORDINATION_BASELINE !== "1") expect(median).toBeLessThan(runnerTimeout(2000));
    }
  }, 180_000);
});
