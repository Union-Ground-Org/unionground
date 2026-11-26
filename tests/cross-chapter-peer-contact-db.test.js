// @vitest-environment node
// REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109 (#7666): a chapter
// lead reaches the chapter leads of the organization's other chapters one to
// one (ruling in record comment 6766273827). Every fixture mutation is rolled
// back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const SETTING = "features.messaging.cross_chapter_peer_roles";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("cross-chapter peer contact on an owned disposable database", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "cross-chapter-peer-proof" });
    await db.connect();
    await db.query("set statement_timeout='15s'");
  });
  afterAll(async () => { await db?.end(); });

  async function owner() {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims','',true)");
  }
  async function as(person) {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, role: "authenticated", aal: "aal2", session_id: person.session })]);
    await db.query("set local role authenticated");
  }
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.v;
  async function refused(sql, args, code = "42501") {
    await db.query("savepoint refusal");
    let error;
    try { await db.query(sql, args); } catch (caught) { error = caught; }
    await db.query("rollback to savepoint refusal");
    await db.query("release savepoint refusal");
    expect(error?.code).toBe(code);
    return error;
  }
  async function fixtures() {
    const org = randomUUID(), otherOrg = randomUUID();
    const main = `peer-main-${org}`, east = `peer-east-${org}`, west = `peer-west-${org}`, foreign = `peer-other-${otherOrg}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Juniper'),($2::uuid,$2::text,'Fictional Copperline')", [org, otherOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Main',$1,$5,9971),($2,'East',$2,$5,9972),($3,'West',$3,$5,9973),($4,'Other',$4,$6,9974)", [main, east, west, foreign, org, otherOrg]);
    const people = {};
    for (const [name, home, organization, role, organizationRole] of [
      ["mainLead", main, org, "vp", null], ["eastLead", east, org, "vp", null], ["westLead", west, org, "vp", null],
      ["mainSteward", main, org, "steward", null], ["eastSteward", east, org, "steward", null],
      ["member", main, org, null, null], ["foreignLead", foreign, otherOrg, "vp", null], ["orgAdmin", main, org, null, "admin"],
    ]) {
      const id = randomUUID(), session = randomUUID();
      people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, home, `Fictional ${name}`]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [organization, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, home]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
      }
      // 20261112-0032: every new steward fixture has its required unit.
      if (role === "steward") await scopeFixtureSteward(db, id, home);
      if (organizationRole) await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)", [organization, id, organizationRole]);
    }
    await db.query("update public.member_chapter_memberships set display_title='Chair' where user_id=$1 and chapter_id=$2", [people.westLead.id, west]);
    return { org, otherOrg, main, east, west, foreign, people };
  }
  async function enableLevels(f, levels) {
    await owner();
    await db.query(
      "insert into public.organization_setting_values(organization_id,setting_key,value) values($1,$2,$3::jsonb) on conflict (organization_id,setting_key) do update set value=excluded.value",
      [f.org, SETTING, JSON.stringify(levels)]);
  }
  // Many people with a chapter role at once, in a few set-based statements.
  async function addPeople(f, rows) {
    await owner();
    const ids = rows.map(() => randomUUID());
    const chapters = rows.map(([, chapter]) => chapter);
    await db.query("insert into auth.users(id,email) select id, id::text || '@example.invalid' from unnest($1::uuid[]) id", [ids]);
    await db.query("update public.member_profiles p set chapter_id=x.chapter, full_name=x.name from unnest($1::uuid[],$2::text[],$3::text[]) x(id,chapter,name) where p.id=x.id",
      [ids, chapters, rows.map(([name]) => `Fictional ${name}`)]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) select $2, id, 'active' from unnest($1::uuid[]) id", [ids, f.org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) select x.id, x.chapter, 'active' from unnest($1::uuid[],$2::text[]) x(id,chapter)", [ids, chapters]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) select gen_random_uuid(), id, 'totp', 'verified', now(), now() from unnest($1::uuid[]) id", [ids]);
    for (const table of ["member_roles", "member_role_chapters"]) {
      await db.query(`insert into public.${table}(user_id,role,chapter_id) select x.id, x.role, x.chapter from unnest($1::uuid[],$2::text[],$3::text[]) x(id,role,chapter)`,
        [ids, rows.map(([, , role]) => role), chapters]);
    }
    return ids;
  }
  const listed = (result) => result.peers.map((peer) => peer.id).sort();
  async function writes(f) {
    await owner();
    const { rows } = await db.query(
      "select (select count(*) from public.member_peer_contact_requests where requester_id=any($1::uuid[]))::int requests, (select count(*) from public.member_peer_conversations where user_low=any($1::uuid[]) or user_high=any($1::uuid[]))::int conversations, (select count(*) from public.member_peer_messages where sender_id=any($1::uuid[]))::int messages",
      [Object.values(f.people).map((person) => person.id)]);
    return rows[0];
  }

  it("lists the other chapters' leads by name, title and chapter only, by default only for chapter leads", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      // Contact details on file never travel through the list.
      await as(f.people.westLead);
      await one("select public.set_my_profile_details('they/them','Fictional job','Fictional site','555-0100','admins','admins') v");
      await as(f.people.mainLead);
      const result = await one("select public.list_cross_chapter_peers() v");
      expect(result.available).toBe(true);
      expect(result.levels).toEqual(["vp"]);
      expect(result.muted).toBe(false);
      expect(result.nextOffset).toBeNull();
      // Not the caller's own chapter, not a steward, not another organization.
      expect(listed(result)).toEqual([f.people.eastLead.id, f.people.westLead.id].sort());
      const west = result.peers.find((peer) => peer.id === f.people.westLead.id);
      expect(west).toEqual({ id: f.people.westLead.id, name: "Fictional westLead", title: "Chair", chapters: ["West"], levels: ["vp"] });
      for (const peer of result.peers) expect(Object.keys(peer).sort()).toEqual(["chapters", "id", "levels", "name", "title"]);
      expect(JSON.stringify(result)).not.toContain("555-0100");
      expect(JSON.stringify(result)).not.toContain("example.invalid");

      // Steward is off until an administrator enables it; a member has no level.
      for (const person of [f.people.mainSteward, f.people.member]) {
        await as(person);
        expect(await one("select public.list_cross_chapter_peers() v")).toMatchObject({ available: false, levels: [], peers: [] });
      }
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("sends one message as separate one-to-one conversations with no acceptance step, and reuses them", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await as(f.people.mainLead);
      const sent = await one("select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[f.people.eastLead.id, f.people.westLead.id], "  Joint meeting Thursday?  "]);
      expect(sent.created).toBe(2);
      expect(sent.conversations.map((item) => item.peerName).sort()).toEqual(["Fictional eastLead", "Fictional westLead"]);
      expect(sent.conversations.every((item) => item.message.body === "Joint meeting Thursday?")).toBe(true);
      await owner();
      const requests = (await db.query("select recipient_id, status, cross_chapter_contact, staff_authorized, officer_contact from public.member_peer_contact_requests where requester_id=$1 order by recipient_id", [f.people.mainLead.id])).rows;
      expect(requests).toEqual([f.people.eastLead.id, f.people.westLead.id].sort().map((id) => ({ recipient_id: id, status: "accepted", cross_chapter_contact: true, staff_authorized: false, officer_contact: false })));

      // Each recipient sees only their own two-person conversation, and replies there.
      await as(f.people.eastLead);
      const inbox = await one("select public.list_reward_peer_contact() v");
      expect(inbox.conversations).toHaveLength(1);
      expect(inbox.conversations[0]).toMatchObject({ peerName: "Fictional mainLead", messages: [{ sentByMe: false, body: "Joint meeting Thursday?" }] });
      await one("select public.send_reward_peer_message($1,'Yes, 6 pm') v", [inbox.conversations[0].id]);
      await as(f.people.westLead);
      const westInbox = await one("select public.list_reward_peer_contact() v");
      expect(westInbox.conversations[0].messages.map((message) => message.body)).toEqual(["Joint meeting Thursday?"]);

      // A second send to the same person reuses the pair's conversation.
      await as(f.people.mainLead);
      const again = await one("select public.send_cross_chapter_peer_message($1::uuid[],'Agenda attached') v", [[f.people.eastLead.id]]);
      expect(again.created).toBe(0);
      expect(again.conversations[0].id).toBe(inbox.conversations[0].id);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("refuses another organization, a level that is not enabled, the caller's own chapter and bad recipient lists, writing nothing", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const before = await writes(f);
      await as(f.people.mainLead);
      for (const target of [f.people.foreignLead, f.people.eastSteward, f.people.mainSteward, f.people.member, f.people.mainLead]) {
        const error = await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[target.id]]);
        expect(error.detail).toBe("cross_chapter_peer_unavailable");
      }
      // One unreachable recipient refuses the whole send.
      await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastLead.id, f.people.foreignLead.id]]);
      for (const ids of [[], [f.people.eastLead.id, f.people.eastLead.id], Array.from({ length: 21 }, () => randomUUID())]) {
        const error = await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [ids], "22023");
        expect(error.detail).toBe("cross_chapter_recipients");
      }
      // Steward is off by default, in both directions.
      await as(f.people.mainSteward);
      await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastSteward.id]]);
      // The foreign lead cannot reach into this organization either.
      await as(f.people.foreignLead);
      expect((await one("select public.list_cross_chapter_peers() v")).peers).toEqual([]);
      await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastLead.id]]);
      expect(await writes(f)).toEqual(before);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("follows the organization setting: steward on when added, chapter lead off when removed", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await enableLevels(f, ["vp", "steward"]);
      await as(f.people.mainSteward);
      const stewards = await one("select public.list_cross_chapter_peers() v");
      expect(stewards.levels).toEqual(["steward"]);
      expect(listed(stewards)).toEqual([f.people.eastSteward.id]);
      expect((await one("select public.send_cross_chapter_peer_message($1::uuid[],'Steward huddle') v", [[f.people.eastSteward.id]])).created).toBe(1);
      // Equivalent role is the same access level: a steward never reaches a lead.
      await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastLead.id]]);

      await enableLevels(f, ["steward"]);
      await as(f.people.mainLead);
      expect(await one("select public.list_cross_chapter_peers() v")).toMatchObject({ available: false, peers: [] });
      await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastLead.id]]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("lets a person mute cross-chapter contact and take the mute back", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await as(f.people.eastLead);
      expect(await one("select public.set_my_cross_chapter_peer_mute(true) v")).toEqual({ muted: true });
      expect((await one("select public.list_cross_chapter_peers() v")).muted).toBe(true);
      await as(f.people.mainLead);
      expect(listed(await one("select public.list_cross_chapter_peers() v"))).toEqual([f.people.westLead.id]);
      await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastLead.id]]);
      await as(f.people.eastLead);
      await refused("select public.set_my_cross_chapter_peer_mute(null) v", [], "22023");
      expect(await one("select public.set_my_cross_chapter_peer_mute(false) v")).toEqual({ muted: false });
      await as(f.people.mainLead);
      expect(listed(await one("select public.list_cross_chapter_peers() v"))).toEqual([f.people.eastLead.id, f.people.westLead.id].sort());
    } finally { await db.query("rollback"); }
  }, 120_000);

  // 20261112-0032 / an owner decision: a committee-only
  // steward grant is now refused before it exists. Keep every peer visibility
  // and send refusal after the failed atomic grant on either side.
  it("refuses committee-only steward grants and their peer access, on either side", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await enableLevels(f, ["vp", "steward"]);
      await owner();
      const unit = randomUUID();
      await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Fictional unit')", [unit, f.org, f.east]);
      await scopeFixtureSteward(db, f.people.eastSteward.id, f.east, unit);
      await as(f.people.mainSteward);
      expect(listed(await one("select public.list_cross_chapter_peers() v"))).toEqual([f.people.eastSteward.id]);

      async function committeeOnly(person, chapter, startsIn, endsIn) {
        await owner();
        const committee = randomUUID();
        await db.query("delete from public.member_role_chapters where user_id=$1 and chapter_id=$2 and role='steward'", [person.id, chapter]);
        await db.query("delete from public.member_roles where user_id=$1 and role='steward'", [person.id]);
        await db.query("insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on) values($1,$2,'Fictional committee','Fictional purpose',current_date + $3::int, current_date + $4::int)", [committee, chapter, startsIn, endsIn]);
        const error = await refused(`with role_row as (
          insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2)
          returning user_id,role,chapter_id
        ), chapter_grant as (
          insert into public.member_role_chapters(user_id,role,chapter_id)
          select user_id,role,chapter_id from role_row returning user_id,role,chapter_id
        ) insert into private.chapter_role_scopes(user_id,chapter_id,role,committee_id)
          select user_id,chapter_id,role,$3 from chapter_grant`, [person.id, chapter, committee], "23514");
        expect(error.constraint).toBe("steward_scope_requires_unit");
        expect(await one("select count(*)::int v from public.member_role_chapters where user_id=$1 and chapter_id=$2 and role='steward'", [person.id, chapter])).toBe(0);
      }
      const before = await writes(f);
      for (const [label, startsIn, endsIn] of [["expired", -30, -1], ["future", 5, 30]]) {
        await db.query("savepoint scope_window");
        // The recipient's only grant is outside its committee's dates.
        await committeeOnly(f.people.eastSteward, f.east, startsIn, endsIn);
        await as(f.people.mainSteward);
        expect(listed(await one("select public.list_cross_chapter_peers() v")), label).toEqual([]);
        await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastSteward.id]]);
        await owner();
        await db.query("rollback to savepoint scope_window");

        // The caller's only grant is outside its committee's dates.
        await committeeOnly(f.people.mainSteward, f.main, startsIn, endsIn);
        await as(f.people.mainSteward);
        expect(await one("select public.list_cross_chapter_peers() v"), label).toMatchObject({ available: false, peers: [] });
        await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastSteward.id]]);
        await as(f.people.eastSteward);
        expect(listed(await one("select public.list_cross_chapter_peers() v")), label).toEqual([]);
        await owner();
        await db.query("rollback to savepoint scope_window");
        await db.query("release savepoint scope_window");
      }
      expect(await writes(f)).toEqual(before);
    } finally { await db.query("rollback"); }
  }, 120_000);

  // Sol early read B3: cross-chapter conversations have their own allowance and
  // leave the three a day of the officer route and the code request alone.

  it("refuses a committee-only steward assignment on either side before it can reach a peer", async () => {
    // 20261112-0032 / an owner decision:
    // keep the mandatory-unit refusal, for expired and future committees alike.
    await db.query("begin");
    try {
      const f = await fixtures();
      const before = await writes(f);
      for (const [person, chapter] of [[f.people.mainSteward, f.main], [f.people.eastSteward, f.east]]) {
        for (const [startsIn, endsIn] of [[-30, -1], [5, 30]]) {
          const committee = randomUUID();
          await db.query("insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on) values($1,$2,'Fictional committee','Fictional purpose',current_date + $3::int, current_date + $4::int)", [committee, chapter, startsIn, endsIn]);
          const error = await refused("update private.chapter_role_scopes set unit_id=null,committee_id=$3 where user_id=$1 and chapter_id=$2 and role='steward'", [person.id, chapter, committee], "23514");
          expect(error.constraint).toBe("steward_scope_requires_unit");
          expect(await one("select count(*)::int v from private.chapter_role_scopes where user_id=$1 and chapter_id=$2 and unit_id is not null and committee_id is null", [person.id, chapter])).toBe(1);
        }
      }
      expect(await writes(f)).toEqual(before);
    } finally { await db.query("rollback"); }
  });

  it("keeps the officer and code-request allowances after three cross-chapter conversations", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await owner();
      const south = `peer-south-${f.org}`;
      await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'South',$1,$2,9975)", [south, f.org]);
      const southLead = await addPeople(f, [["southLead", south, "vp"]]);
      // A display title makes the main steward one of the chapter's listed officers.
      await db.query("update public.member_chapter_memberships set display_title='Secretary' where user_id=$1 and chapter_id=$2", [f.people.mainSteward.id, f.main]);
      await as(f.people.mainLead);
      expect((await one("select public.send_cross_chapter_peer_message($1::uuid[],'Joint meeting?') v", [[f.people.eastLead.id, f.people.westLead.id, southLead[0]]])).created).toBe(3);
      expect((await one("select public.start_officer_conversation($1,'Agenda for Thursday') v", [f.people.mainSteward.id])).created).toBe(true);
      await as(f.people.orgAdmin);
      const code = (await one("select public.list_reward_peer_contact() v")).code;
      await as(f.people.mainLead);
      expect(await one("select public.request_reward_peer_contact($1) v", [code])).toMatchObject({ requested: true });
      await owner();
      const counted = (await db.query("select cross_chapter_contact, count(*)::int n from public.member_peer_contact_requests where requester_id=$1 group by 1 order by 1", [f.people.mainLead.id])).rows;
      expect(counted).toEqual([{ cross_chapter_contact: false, n: 2 }, { cross_chapter_contact: true, n: 3 }]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  // Sol early read B2: every eligible person can be reached, past any page.
  it("pages and searches past two hundred people so the last one can be reached", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const bulk = await addPeople(f, Array.from({ length: 201 }, (_, index) => [`bulk${String(index).padStart(3, "0")}`, f.east, "vp"]));
      await as(f.people.mainLead);
      // Grok final P2 on #8095: every page holds at most p_limit people; the
      // row read past the page only says whether there is another.
      const seen = [];
      const sizes = [];
      const offsets = [];
      let offset = 0;
      for (let pages = 0; offset !== null && pages < 10; pages += 1) {
        const page = await one("select public.list_cross_chapter_peers(null,$1,100) v", [offset]);
        sizes.push(page.peers.length);
        seen.push(...page.peers.map((peer) => peer.id));
        offset = page.nextOffset;
        offsets.push(offset);
      }
      expect(sizes).toEqual([100, 100, 3]);
      expect(offsets).toEqual([100, 200, null]);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...bulk, f.people.eastLead.id, f.people.westLead.id].sort());
      // Exactly one page of 100 says there is no other after the last 100.
      expect((await one("select public.list_cross_chapter_peers(null,103,100) v")).peers.length).toBe(100);
      expect((await one("select public.list_cross_chapter_peers(null,103,100) v")).nextOffset).toBeNull();
      const last = (await one("select public.list_cross_chapter_peers('bulk200',0,10) v")).peers;
      expect(last.map((peer) => peer.name)).toEqual(["Fictional bulk200"]);
      expect((await one("select public.list_cross_chapter_peers('wes',0,10) v")).peers.map((peer) => peer.id)).toEqual([f.people.westLead.id]);
      expect((await one("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[last[0].id]])).created).toBe(1);
      for (const [query, offsetArg, limit] of [[null, -1, 10], [null, 0, 0], [null, 0, 101], ["x".repeat(81), 0, 10]]) {
        await refused("select public.list_cross_chapter_peers($1,$2,$3) v", [query, offsetArg, limit], "22023");
      }
    } finally { await db.query("rollback"); }
  }, 180_000);

  // #8353: under a nested-loop plan the holders' per-person checks ran once per
  // pair of candidates (164,024 calls and 3.5 s for one page of 203 leads on the
  // DGX Spark; past 15 s on a CI runner). The plan follows table statistics, so
  // this proof forces nested loops and counts the checks: one page must stay
  // linear in the number of holders.
  it("keeps one page linear in the number of holders under a nested-loop plan", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const bulk = await addPeople(f, Array.from({ length: 201 }, (_, index) => [`loop${String(index).padStart(3, "0")}`, f.east, "vp"]));
      await owner();
      await db.query("set local track_functions = 'all'");
      await db.query("set local enable_hashjoin = off");
      await db.query("set local enable_mergejoin = off");
      const CHECKS = ["has_second_factor", "chapter_role_scope_expired"];
      const calls = async () => {
        await owner();
        const { rows } = await db.query("select funcname, calls::int from pg_catalog.pg_stat_xact_user_functions where schemaname = 'private' and funcname = any($1)", [CHECKS]);
        return Object.fromEntries(CHECKS.map((name) => [name, rows.find((row) => row.funcname === name)?.calls ?? 0]));
      };
      const before = await calls();
      await as(f.people.mainLead);
      const page = await one("select public.list_cross_chapter_peers(null,0,100) v");
      expect(page.peers).toHaveLength(100);
      expect(page.nextOffset).toBe(100);
      const after = await calls();
      // Holders of the chapter-lead level: the three seeded leads and the bulk.
      const holders = bulk.length + 3;
      for (const name of CHECKS) {
        const made = after[name] - before[name];
        expect(made, name).toBeGreaterThan(0);
        // A handful of passes over the holders (10 here), never one per pair.
        expect(made, `${name}: ${made} calls for ${holders} holders`).toBeLessThanOrEqual(16 * holders);
      }
    } finally { await db.query("rollback"); }
  }, 180_000);

  // Sol final G6-8095-1: a lead who signs in with a security key only meets
  // staff two-step through their own live verified-key session, as
  // private.member_peer_staff_eligible allows; a lead with no second factor
  // does not.
  it("lists and reaches a lead with a security key only, and not a lead with no second factor", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await owner();
      expect(await one("select private.staff_mfa_required($1) v", [f.org])).toBe(true);
      await db.query("update private.verified_key_policy set enabled=true, allow_staff=true where singleton");
      await db.query("delete from auth.mfa_factors where user_id = any($1::uuid[])", [[f.people.eastLead.id, f.people.westLead.id]]);
      // Factor removal installs a reset boundary; the key session starts after it.
      const session = randomUUID();
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',clock_timestamp(),clock_timestamp())", [session, f.people.eastLead.id]);
      await db.query("insert into auth.mfa_amr_claims(id,session_id,authentication_method,created_at,updated_at) values ($1,$2,'passkey',now(),now())", [randomUUID(), session]);
      const digest = () => randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      await db.query("insert into private.verified_key_sessions(session_id,user_id,challenge_sha256,assertion_sha256,backup_eligible,backed_up) values ($1,$2,$3,$4,false,false)", [session, f.people.eastLead.id, digest(), digest()]);
      expect(await one("select private.verified_key_session($1,$2) v", [f.people.eastLead.id, session])).toBe(true);

      await as(f.people.mainLead);
      expect(listed(await one("select public.list_cross_chapter_peers() v"))).toEqual([f.people.eastLead.id]);
      expect((await one("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.eastLead.id]])).created).toBe(1);
      // The control: no factor and no key session.
      await refused("select public.send_cross_chapter_peer_message($1::uuid[],'Hello') v", [[f.people.westLead.id]]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("keeps the setting to chapter lead and steward and the new routes to signed-in members", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      await owner();
      const definition = (await db.query("select value_kind, default_value, allowed_values, category, member_visible from public.platform_setting_definitions where key=$1", [SETTING])).rows[0];
      expect(definition).toEqual({ value_kind: "text_list", default_value: ["vp"], allowed_values: ["vp", "steward"], category: "messaging", member_visible: false });
      const valid = async (value) => one("select private.setting_value_valid(d.value_kind,$2::jsonb,d.minimum,d.maximum,d.allowed_values) v from public.platform_setting_definitions d where d.key=$1", [SETTING, JSON.stringify(value)]);
      expect(await valid(["vp", "steward"])).toBe(true);
      expect(await valid([])).toBe(true);
      for (const value of [["admin"], ["coordinator"], ["vp", "steward", "admin"]]) expect(await valid(value), JSON.stringify(value)).toBe(false);
      // Even a stored value outside the allowed list grants nothing.
      await enableLevels(f, ["admin", "vp"]);
      expect(await one("select private.cross_chapter_peer_levels($1) v", [f.org])).toEqual(["vp"]);
      const grants = (await db.query("select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') authed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname like '%cross\\_chapter%peer%' order by p.proname")).rows;
      expect(grants).toEqual([
        { proname: "cross_chapter_peer_caller_levels", anon: false, authed: false },
        { proname: "cross_chapter_peer_holders", anon: false, authed: false },
        { proname: "cross_chapter_peer_levels", anon: false, authed: false },
        { proname: "cross_chapter_reachable_peers", anon: false, authed: false },
        { proname: "list_cross_chapter_peers", anon: false, authed: true },
        { proname: "send_cross_chapter_peer_message", anon: false, authed: true },
        { proname: "set_my_cross_chapter_peer_mute", anon: false, authed: true },
      ]);
      await db.query("set local role anon");
      await refused("select public.list_cross_chapter_peers() v", []);
    } finally { await db.query("rollback"); }
  }, 120_000);
});
