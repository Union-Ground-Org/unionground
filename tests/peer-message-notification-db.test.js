// @vitest-environment node
//
// BUG-UG-PRIVATE-TWO-PERSON-MESSAGES-SEND-NO-NOTIFICATION-20261118 (#9173)
//
// 20261118200500 makes every private two-person message write one notice of
// kind 'messages' for the other participant and none for the sender, through
// all three entry points (start_officer_conversation, send_reward_peer_message,
// send_cross_chapter_peer_message). The notice and the dispatch claim carry
// no message text and no name. Fictional tenants; every row is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261118200500_peer_message_notification";
const TITLE = "New private message";
const BODY = "Someone wrote to you in a private conversation. Open Messages to read it.";

describe("peer message notification (static)", () => {
  const raw = loadMigrationSql(MIGRATION);
  const sql = stripComments(raw);

  it("is one guarded transaction that adds a trigger, not a second send path", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("pg_catalog.to_regprocedure('public.claim_notification_deliveries(text, integer)'))) is distinct from '3db7070d2d24709325daae3e25a7ca1b'");
    expect(sql).toMatch(/create trigger member_peer_messages_notify_recipient\s+after insert on public\.member_peer_messages\s+for each row execute function private\.peer_message_notify_after_insert\(\);/);
    expect(sql).not.toMatch(/function public\.send_reward_peer_message|function public\.start_officer_conversation|function public\.send_cross_chapter_peer_message/);
    expect(sql).toContain("revoke all on function private.peer_message_notify_after_insert() from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant select (peer_conversation_id) on public.member_notifications to authenticated;");
    expect(sql).not.toMatch(/grant (update|insert|all)[^;]*member_notifications/i);
  });

  it("writes fixed copy with no placeholder, and the claim still never returns the title or body", () => {
    expect(sql).toContain("('peer.message', 'en', 'New private message', 'Someone wrote to you in a private conversation. Open Messages to read it.')");
    const copy = sql.slice(sql.indexOf("insert into private.notification_copy"), sql.indexOf("create function private.peer_message_notify_after_insert"));
    expect(copy).not.toMatch(/\{[a-z]+\}/);
    const claim = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_notification_deliveries"));
    expect(claim).toContain("'source', case when n.peer_conversation_id is not null then 'peer' end,");
    expect(claim).not.toMatch(/n\.title|n\.body/);
    // The trigger reads the body of nothing: no message text reaches the notice.
    const trigger = sql.slice(sql.indexOf("create function private.peer_message_notify_after_insert"), sql.indexOf("create trigger member_peer_messages_notify_recipient"));
    expect(trigger).not.toMatch(/new\.body|full_name|member_peer_profile_label/);
    expect(trigger).toMatch(/exception\s+when query_canceled then/);
  });

  it("stamps the notice with the organization of the conversation's chapter (#9191 round 1)", () => {
    const trigger = sql.slice(sql.indexOf("create function private.peer_message_notify_after_insert"), sql.indexOf("create trigger member_peer_messages_notify_recipient"));
    expect(trigger).toMatch(/ch\.organization_id\s+into recipient, source_org\s+from public\.member_peer_conversations c\s+left join public\.chapters ch on ch\.id = c\.chapter_id/);
    expect(trigger).toContain("insert into public.member_notifications (user_id, title, body, kind, copy_key, peer_conversation_id, organization_id)");
    expect(trigger).toContain("values (recipient, copy_row.title, copy_row.body, 'messages', 'peer.message', new.conversation_id, source_org);");
    // Never the recipient's current organization, never a selected chapter.
    expect(trigger).not.toMatch(/member_organization_for|current_member_organization|current_member_chapter|source_chapter_id/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("peer message notification on a disposable database", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "peer-message-notification-proof" });
    await db.connect();
    await db.query("set statement_timeout='20s'");
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
  async function call(person, sql, args = []) {
    await as(person);
    const value = (await db.query(sql, args)).rows[0]?.v;
    await owner();
    return value;
  }

  async function fixtures() {
    const org = randomUUID(), otherOrg = randomUUID();
    const main = `pmn-main-${org}`, east = `pmn-east-${org}`, foreign = `pmn-other-${otherOrg}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Juniper'),($2::uuid,$2::text,'Fictional Copperline')", [org, otherOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Main',$1,$4,9981),($2,'East',$2,$4,9982),($3,'Other',$3,$5,9983)", [main, east, foreign, org, otherOrg]);
    const people = {};
    for (const [name, home, organization, role] of [
      ["member", main, org, null], ["mainLead", main, org, "vp"], ["eastLead", east, org, "vp"],
      ["bystander", main, org, null], ["foreignLead", foreign, otherOrg, "vp"],
    ]) {
      const id = randomUUID(), session = randomUUID();
      people[name] = { id, session, name: `Fictional ${name} Quillfeather` };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, home, people[name].name]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [organization, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, home]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
      }
    }
    await db.query("update private.notification_controls set outbound_enabled = true where id");
    return { org, main, east, people };
  }

  // Every peer notice a person holds, read as the owner.
  async function notices(person) {
    await owner();
    return (await db.query(
      "select * from public.member_notifications where user_id=$1 and copy_key='peer.message' order by created_at, id",
      [person.id])).rows;
  }
  async function deliveries(notice) {
    await owner();
    return (await db.query(
      "select channel, status from public.member_notification_deliveries where notification_id=$1 order by channel",
      [notice.id])).rows;
  }
  // The dispatcher's view: claim as service_role, then pick out this person's rows.
  async function claimed(channel, person) {
    await owner();
    await db.query("set local role service_role");
    const rows = (await db.query("select public.claim_notification_deliveries($1, 500) as v", [channel])).rows[0].v;
    await owner();
    const mine = (await db.query(
      "select id::text from public.member_notification_deliveries where user_id=$1", [person.id])).rows.map((row) => row.id);
    return rows.filter((row) => mine.includes(row.deliveryId));
  }

  function expectNeutral(value, f, texts) {
    const text = JSON.stringify(value);
    for (const body of texts) expect(text).not.toContain(body);
    for (const person of Object.values(f.people)) {
      expect(text).not.toContain(person.name);
      expect(text).not.toContain("Quillfeather");
    }
  }

  it("notifies the other participant once and the sender never, through each entry point and from each side", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { member, mainLead, eastLead, bystander } = f.people;
      const texts = ["Private first note 41", "Officer answer 42", "Member follow-up 43", "Cross chapter hello 44", "Cross chapter reply 45", "Cross chapter answer 46"];
      const counts = async () => {
        const result = {};
        for (const [name, person] of Object.entries(f.people)) result[name] = (await notices(person)).length;
        return result;
      };

      // 1. start_officer_conversation: member -> officer.
      const started = await call(member, "select public.start_officer_conversation($1,$2) v", [mainLead.id, texts[0]]);
      const officerConversation = started.conversation.id;
      expect(await counts()).toEqual({ member: 0, mainLead: 1, eastLead: 0, bystander: 0, foreignLead: 0 });

      // 2. send_reward_peer_message: the officer answers, then the member replies.
      await call(mainLead, "select public.send_reward_peer_message($1,$2) v", [officerConversation, texts[1]]);
      expect(await counts()).toEqual({ member: 1, mainLead: 1, eastLead: 0, bystander: 0, foreignLead: 0 });
      await call(member, "select public.send_reward_peer_message($1,$2) v", [officerConversation, texts[2]]);
      expect(await counts()).toEqual({ member: 1, mainLead: 2, eastLead: 0, bystander: 0, foreignLead: 0 });

      // 3. send_cross_chapter_peer_message, from each side; and a reply in that conversation.
      const crossSent = await call(mainLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[eastLead.id], texts[3]]);
      const crossConversation = crossSent.conversations[0].id;
      expect(await counts()).toEqual({ member: 1, mainLead: 2, eastLead: 1, bystander: 0, foreignLead: 0 });
      await call(eastLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[mainLead.id], texts[4]]);
      expect(await counts()).toEqual({ member: 1, mainLead: 3, eastLead: 1, bystander: 0, foreignLead: 0 });
      await call(eastLead, "select public.send_reward_peer_message($1,$2) v", [crossConversation, texts[5]]);
      expect(await counts()).toEqual({ member: 1, mainLead: 4, eastLead: 1, bystander: 0, foreignLead: 0 });

      // The row: fixed copy, kind messages, the conversation it opens, no chapter.
      const officerNotices = await notices(mainLead);
      // One transaction: every row has the same created_at, so compare as a set.
      expect(officerNotices.map((row) => row.peer_conversation_id).sort()).toEqual([officerConversation, officerConversation, crossConversation, crossConversation].sort());
      for (const row of [...officerNotices, ...(await notices(member)), ...(await notices(eastLead))]) {
        expect(row).toMatchObject({ kind: "messages", copy_key: "peer.message", title: TITLE, body: BODY, source_chapter_id: null, organization_id: f.org, read_at: null, message_reminder_id: null, workload_event: null, workload_receipt_code: null });
        expectNeutral(row, f, texts);
      }
      expect((await notices(member))[0].peer_conversation_id).toBe(officerConversation);

      // The recipient reads it through the app's own grants (select *), the sender cannot.
      const own = await call(mainLead, "select coalesce(json_agg(n.*),'[]'::json) v from public.member_notifications n where n.copy_key='peer.message'");
      expect(own).toHaveLength(4);
      expect(own.map((row) => row.peer_conversation_id).sort()).toEqual([officerConversation, officerConversation, crossConversation, crossConversation].sort());
      expect(await call(member, "select count(*)::int v from public.member_notifications where user_id=$1", [mainLead.id])).toBe(0);
      await as(member);
      await db.query("savepoint grant_check");
      let refused;
      try { await db.query("update public.member_notifications set peer_conversation_id=null where user_id=$1", [member.id]); } catch (error) { refused = error; }
      await db.query("rollback to savepoint grant_check");
      expect(refused?.code).toBe("42501");
      await owner();

      // Outbound: an email row for each notice, and the dispatch claim carries
      // no text and no name; it marks the row as a peer notice.
      for (const row of officerNotices) expect(await deliveries(row)).toEqual([{ channel: "email", status: "pending" }]);
      const claim = await claimed("email", mainLead);
      expect(claim).toHaveLength(4);
      for (const row of claim) {
        expect(row).toMatchObject({ kind: "messages", source: "peer", event: null, receiptCode: null });
        expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["title"]));
        expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["body"]));
        expectNeutral({ ...row, email: null }, f, texts);
        expect(JSON.stringify(row)).not.toContain(officerConversation);
        expect(JSON.stringify(row)).not.toContain(f.org);
      }
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("applies the messages topic switch and quiet time exactly as for other message notices", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { member, mainLead } = f.people;
      // A channel-style message notice through the existing helper, for comparison.
      const compare = async (person) => {
        await owner();
        await db.query("select private.notify_member($1,'channel.keyword','{}'::jsonb,'messages')", [person.id]);
        return (await db.query("select * from public.member_notifications where user_id=$1 and copy_key='channel.keyword' order by created_at desc, id limit 1", [person.id])).rows[0];
      };

      // Topic switched off (ruled parity with the channel notices,
      // Nov 18, 2026): exactly one in-app notice is still written for the
      // recipient, none for the sender, and no email or push is queued for it,
      // exactly as for a channel notice.
      await db.query("update public.member_profiles set notification_prefs = notification_prefs || '{\"messages\": false}'::jsonb where id=$1", [mainLead.id]);
      const started = await call(member, "select public.start_officer_conversation($1,'Topic off 51') v", [mainLead.id]);
      const offNotices = await notices(mainLead);
      expect(offNotices).toHaveLength(1);
      const [off] = offNotices;
      expect(off).toMatchObject({ kind: "messages", copy_key: "peer.message", title: TITLE, body: BODY, peer_conversation_id: started.conversation.id, read_at: null });
      expect(await notices(member)).toEqual([]);
      expect(await deliveries(off)).toEqual([]);
      expect(await deliveries(await compare(mainLead))).toEqual([]);

      // Switched back on: queued.
      await db.query("update public.member_profiles set notification_prefs = notification_prefs || '{\"messages\": true}'::jsonb where id=$1", [mainLead.id]);
      await call(member, "select public.send_reward_peer_message($1,'Topic on 52') v", [started.conversation.id]);
      const on = (await notices(mainLead)).find((row) => row.id !== off.id);
      expect(await deliveries(on)).toEqual([{ channel: "email", status: "pending" }]);

      // Do not disturb holds the delivery back at claim time, as for every
      // non-urgent kind; turning it off releases it.
      await db.query("update public.member_profiles set dnd_enabled = true where id=$1", [mainLead.id]);
      expect(await claimed("email", mainLead)).toEqual([]);
      await db.query("update public.member_profiles set dnd_enabled = false where id=$1", [mainLead.id]);
      const released = await claimed("email", mainLead);
      expect(released).toHaveLength(1);
      expect(released[0]).toMatchObject({ kind: "messages", source: "peer" });

      // A channel notice is claimed without the peer mark, so it keeps its own text.
      await db.query("update public.member_notification_deliveries set status='sent' where user_id=$1", [mainLead.id]);
      await compare(mainLead);
      const channel = await claimed("email", mainLead);
      expect(channel).toHaveLength(1);
      expect(channel[0].source).toBeNull();

      // Push is queued only for someone with a push target, like every kind.
      await db.query("insert into public.member_push_subscriptions(user_id,endpoint,p256dh,auth_key) values($1,'https://fcm.googleapis.com/fcm/send/pmn-proof','p256dh-proof','auth-proof')", [member.id]);
      await call(mainLead, "select public.send_reward_peer_message($1,'With push 53') v", [started.conversation.id]);
      const [memberNotice] = await notices(member);
      expect(await deliveries(memberNotice)).toEqual([{ channel: "email", status: "pending" }, { channel: "push", status: "pending" }]);
      const push = await claimed("push", member);
      expect(push).toHaveLength(1);
      expect(push[0]).toMatchObject({ kind: "messages", source: "peer" });
      expectNeutral({ ...push[0], subscriptions: null }, f, ["Topic off 51", "Topic on 52", "With push 53"]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("never refuses a message for a failed notice, and a notice goes with its conversation", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { member, mainLead } = f.people;
      const started = await call(member, "select public.start_officer_conversation($1,'Fenced 61') v", [mainLead.id]);
      expect((await notices(mainLead))).toHaveLength(1);

      // With the notice copy gone the trigger fails inside its fence: the
      // message is still stored and nobody gets a broken notice.
      await owner();
      await db.query("delete from private.notification_copy where key='peer.message'");
      await call(mainLead, "select public.send_reward_peer_message($1,'Still delivered 62') v", [started.conversation.id]);
      await owner();
      expect((await db.query("select count(*)::int n from public.member_peer_messages where conversation_id=$1", [started.conversation.id])).rows[0].n).toBe(2);
      expect(await notices(member)).toEqual([]);

      // A message row whose sender is not a participant notifies nobody.
      await db.query("insert into private.notification_copy(key,lang,title,body) values('peer.message','en',$1,$2)", [TITLE, BODY]);
      const before = (await db.query("select count(*)::int n from public.member_notifications where copy_key='peer.message'")).rows[0].n;
      await db.query("insert into public.member_peer_messages(conversation_id,sender_id,body) values($1,$2,'Outsider 63')", [started.conversation.id, f.people.bystander.id]);
      expect((await db.query("select count(*)::int n from public.member_notifications where copy_key='peer.message'")).rows[0].n).toBe(before);

      // When the conversation is removed (a participant's account deletion
      // cascades it), its notices go with it.
      await db.query("delete from public.member_peer_conversations where id=$1", [started.conversation.id]);
      expect(await notices(mainLead)).toEqual([]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  // #9191 round 1 (r1s2 = r2s3): the row carries the organization of the
  // conversation's chapter, so organization notification retention takes it
  // and its deliveries; a chapter with no organization still gets the notice.
  it("is purged with its deliveries by the organization's notification retention", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { member, mainLead, bystander } = f.people;
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, bystander.id]);
      const started = await call(member, "select public.start_officer_conversation($1,'Old note 71') v", [mainLead.id]);
      const [old] = await notices(mainLead);
      expect(old).toMatchObject({ organization_id: f.org, peer_conversation_id: started.conversation.id });
      expect(await deliveries(old)).toEqual([{ channel: "email", status: "pending" }]);
      await owner();
      await db.query("update public.member_notifications set created_at = now() - interval '31 days' where id=$1", [old.id]);
      await call(member, "select public.send_reward_peer_message($1,'Fresh note 72') v", [started.conversation.id]);
      const fresh = (await notices(mainLead)).find((row) => row.id !== old.id);
      expect(fresh.organization_id).toBe(f.org);

      expect((await db.query("select private.retention_eligible_count($1,'member_notifications',30) n", [f.org])).rows[0].n).toBe(1);
      await call(bystander, "select public.upsert_organization_retention_policy('member_notifications',30,true,'ENABLE member_notifications') v");
      const run = await call(bystander, "select public.preview_organization_retention_run('member_notifications') v");
      expect(run.eligibleCount).toBe(1);
      await call(bystander, "select public.authorize_organization_retention_run($1,'AUTHORIZE member_notifications') v", [run.id]);
      await owner();
      expect((await db.query("select private.perform_organization_retention_run($1) v", [run.id])).rows[0].v).toMatchObject({ status: "completed", deletedCount: 1 });

      expect((await notices(mainLead)).map((row) => row.id)).toEqual([fresh.id]);
      expect((await db.query("select count(*)::int n from public.member_notification_deliveries where notification_id=$1", [old.id])).rows[0].n).toBe(0);
      expect(await deliveries(fresh)).toEqual([{ channel: "email", status: "pending" }]);
      // The messages themselves are not this data class.
      expect((await db.query("select count(*)::int n from public.member_peer_messages where conversation_id=$1", [started.conversation.id])).rows[0].n).toBe(2);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("leaves no peer notice in the way of removing a chapter or its organization", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { member, mainLead } = f.people;
      const started = await call(member, "select public.start_officer_conversation($1,'Removal 81') v", [mainLead.id]);
      const [notice] = await notices(mainLead);
      expect(notice.organization_id).toBe(f.org);
      // The conversation holds its chapter first (chapter_id ON DELETE RESTRICT),
      // and the notice and its deliveries hang from the conversation by cascade.
      await owner();
      const actions = (await db.query(`
        select conrelid::regclass::text tbl, confrelid::regclass::text ref, confdeltype action
        from pg_constraint
        where contype='f' and (
          (conrelid='public.member_peer_conversations'::regclass and confrelid='public.chapters'::regclass)
          or (conrelid='public.member_notifications'::regclass and confrelid in ('public.member_peer_conversations'::regclass,'public.organizations'::regclass))
          or (conrelid='public.member_notification_deliveries'::regclass and confrelid='public.member_notifications'::regclass))
        order by 1, 2`)).rows;
      expect(actions).toEqual([
        { tbl: "member_notification_deliveries", ref: "member_notifications", action: "c" },
        { tbl: "member_notifications", ref: "member_peer_conversations", action: "c" },
        { tbl: "member_notifications", ref: "organizations", action: "r" },
        { tbl: "member_peer_conversations", ref: "chapters", action: "r" },
      ]);
      // ...and removing the conversation takes the notice and its deliveries with it.
      await db.query("delete from public.member_peer_conversations where id=$1", [started.conversation.id]);
      expect(await notices(mainLead)).toEqual([]);
      expect((await db.query("select count(*)::int n from public.member_notification_deliveries where notification_id=$1", [notice.id])).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int n from public.member_notifications where organization_id=$1 and copy_key='peer.message'", [f.org])).rows[0].n).toBe(0);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("still writes the notice, with no organization, when the conversation's chapter has none", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { member, mainLead } = f.people;
      const started = await call(member, "select public.start_officer_conversation($1,'Before move 91') v", [mainLead.id]);
      await owner();
      const loose = `pmn-loose-${f.org}`;
      // Since 20260822010000 (private.forbid_ownerless_chapter_write) no chapter
      // can be written without an organization; a legacy one from before it is
      // stood in for by writing past the triggers, inside this rolled-back test.
      await db.query("set local session_replication_role = replica");
      await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Loose',$1,null,9984)", [loose]);
      // #9189: a conversation on a chapter with no organization stays open
      // only while both people are members of that chapter, so both are.
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$3,'active'),($2,$3,'active')", [member.id, mainLead.id, loose]);
      await db.query("set local session_replication_role = origin");
      await db.query("update public.member_peer_conversations set chapter_id=$2 where id=$1", [started.conversation.id, loose]);
      await call(mainLead, "select public.send_reward_peer_message($1,'No organization 92') v", [started.conversation.id]);
      const memberNotices = await notices(member);
      expect(memberNotices).toHaveLength(1);
      expect(memberNotices[0]).toMatchObject({ kind: "messages", copy_key: "peer.message", title: TITLE, body: BODY, organization_id: null, source_chapter_id: null, peer_conversation_id: started.conversation.id });
      expect(await deliveries(memberNotices[0])).toEqual([{ channel: "email", status: "pending" }]);
      // Outside every organization's purge, as any unstamped notice.
      expect((await db.query("select private.retention_eligible_count($1,'member_notifications',30) n", [f.org])).rows[0].n).toBe(0);
    } finally { await db.query("rollback"); }
  }, 120_000);
});
