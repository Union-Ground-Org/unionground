// @vitest-environment node
// BUG-UG-TWO-PERSON-CONVERSATIONS-HAVE-NO-LEAVE-OR-BLOCK-RULE-20261118
//: a two-person conversation closes for writing when either person
// leaves the organization (and the chapter, for a chapter conversation), and
// either person can block the other (ruling (c),
// 00:13 ET). Every refused send writes no message and no notice. Each case
// rolls its fixture back, except the two-connection race, which commits a
// uniquely named fictional tenant on the disposable stack.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const CLOSED = { ok: false, code: "22023", message: "message unavailable", detail: "peer_conversation_closed" };
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("two-person conversations close when a person leaves, and either person can block", () => {
  let db;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "peer-leave-and-block-proof" });
    await db.connect();
    await db.query("set statement_timeout='15s'");
  });
  afterAll(async () => { await db?.end(); });

  async function owner() {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims','',true)");
  }
  async function capture(sql, args = []) {
    await db.query("savepoint cell");
    try {
      const result = await db.query(sql, args);
      await db.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null };
    } catch (error) {
      await db.query("rollback to savepoint cell");
      return { ok: false, code: error.code ?? "", message: error.message ?? "", detail: error.detail ?? "" };
    }
  }
  async function as(person, sql, args = []) {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, role: "authenticated", aal: "aal2", session_id: person.session })]);
    await db.query("set local role authenticated");
    const result = await capture(sql, args);
    await owner();
    return result;
  }
  const value = async (person, sql, args) => {
    const result = await as(person, sql, args);
    expect(result.ok, result.message).toBe(true);
    return result.value;
  };

  async function fixtures() {
    const org = randomUUID(), otherOrg = randomUUID();
    const main = `plb-main-${org}`, east = `plb-east-${org}`, west = `plb-west-${org}`, foreign = `plb-other-${otherOrg}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Tamarack Riverworks ' || left($1::text,8)),($2::uuid,$2::text,'Fictional Tamarack Ferry ' || left($2::text,8))", [org, otherOrg]);
    await db.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values($1,'Main',$1,'proof',$5,9981),($2,'East',$2,'proof',$5,9982),($3,'West',$3,'proof',$5,9983),($4,'Other',$4,'proof',$6,9984)", [main, east, west, foreign, org, otherOrg]);
    const people = {};
    for (const [name, home, role, title, orgRole] of [
      ["ann", main, null, null, null], ["ben", main, null, null, null], ["cal", main, null, null, null],
      ["officer", main, null, "Secretary", null], ["officer2", main, null, "Treasurer", null],
      ["orgAdmin", east, null, null, "admin"], ["mainLead", main, "vp", null, null], ["eastLead", east, "vp", null, null],
    ]) {
      const id = randomUUID(), session = randomUUID();
      people[name] = { id, session, name };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, home, `Fictional ${name}`]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,display_title) values($1,$2,'active',$3)", [id, home, title]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, home]);
      }
      if (orgRole) await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)", [org, id, orgRole]);
    }
    return { org, otherOrg, main, east, west, foreign, people };
  }

  // A code-route conversation: requester holds the im-anyone reward, the recipient accepts.
  async function codeConversation(f, requester, recipient) {
    await db.query("insert into public.member_reward_grants(user_id,item_key,status,source,organization_id) values ($1,'im-anyone','granted','admin_grant',$2)", [requester.id, f.org]);
    const { code } = await value(recipient, "select public.list_reward_peer_contact() v");
    expect(await value(requester, "select public.request_reward_peer_contact($1) v", [code])).toMatchObject({ requested: true });
    await owner();
    const request = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1 and recipient_id=$2 and status='pending'", [requester.id, recipient.id])).rows[0].id;
    const accepted = await value(recipient, "select public.respond_reward_peer_contact($1,true) v", [request]);
    expect(accepted).toMatchObject({ accepted: true, conversation: { state: "open" } });
    return accepted.conversation.id;
  }
  const send = (person, conversation, body) => as(person, "select public.send_reward_peer_message($1,$2) v", [conversation, body]);
  const block = (person, conversation, blocked = true) => as(person, "select public.set_peer_conversation_block($1,$2) v", [conversation, blocked]);

  async function keyedSend(name, person, target, body, operationId) {
    const keyed = (await db.query("select to_regprocedure($1) is not null as present", [`public.${name}(uuid,text,uuid)`])).rows[0].present;
    // Run the same retry scenario against the legacy endpoint on Main.
    const args = keyed ? [target, body, operationId] : [target, body];
    return as(person, `select public.${name}(${keyed ? "$1,$2,$3" : "$1,$2"}) v`, args);
  }

  it.each(["send_reward_peer_message", "start_officer_conversation"])(
    "%s replays a committed message after its response is lost",
    async (name) => {
      await db.query("begin");
      let f;
      let target;
      let first;
      const operationId = randomUUID();
      const body = "A private question";
      try {
        f = await fixtures();
        const { ann, ben, officer } = f.people;
        target = name === "send_reward_peer_message" ? await codeConversation(f, ann, ben) : officer.id;
        first = await keyedSend(name, ann, target, body, operationId);
        expect(first.ok, first.message).toBe(true);
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }

      // The caller lost the first response. Retain it here only for the oracle.
      await db.query("begin");
      try {
        const { ann, ben, officer } = f.people;
        const retry = await keyedSend(name, ann, target, body, operationId);
        expect(retry.ok, retry.message).toBe(true);
        const conversation = first.value.conversation?.id ?? target;
        expect(await tally(conversation, [ann, ben, officer])).toMatchObject({ messages: 1 });
        expect(retry.value).toEqual(first.value);
        const notices = await db.query("select count(*)::int as total from public.member_notifications where copy_key='peer.message' and peer_conversation_id=$1", [conversation]);
        expect(notices.rows[0].total).toBe(1);
      } finally { await db.query("rollback"); }
    },
    120_000,
  );

  it("refuses an operation key reused by a different sender, conversation or payload", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben, officer } = f.people;
      const conversation = await codeConversation(f, ann, ben);
      const other = (await value(ann, "select public.start_officer_conversation($1,$2) v", [officer.id, "Hello"])).conversation.id;
      const operationId = randomUUID();
      const body = "Checking in";
      const attempt = (sender, target, text = body, key = operationId) =>
        keyedSend("send_reward_peer_message", sender, target, text, key);

      expect((await attempt(ann, conversation)).ok).toBe(true);
      expect(await attempt(ben, conversation)).toMatchObject({ ok: false, code: "22023" });
      expect(await attempt(ann, other)).toMatchObject({ ok: false, code: "22023" });
      expect(await attempt(ann, conversation, "Different draft")).toMatchObject({ ok: false, code: "22023" });
      expect(await attempt(ann, conversation, body, null)).toMatchObject({ ok: false, code: "22023" });
      expect(await keyedSend("start_officer_conversation", ann, officer.id, body, null)).toMatchObject({ ok: false, code: "22023" });
      expect((await attempt(ann, conversation, body, randomUUID())).ok).toBe(true);
      expect(await tally(conversation, [ann, ben])).toMatchObject({ messages: 2 });
      expect(await tally(other, [ann, officer])).toMatchObject({ messages: 1 });
      await block(ben, conversation);
      expect(await attempt(ann, conversation)).toEqual(CLOSED);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("never reopens a closed officer conversation on replay or key collision", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben, officer } = f.people;
      const body = "Checking in";
      const officerKey = randomUUID();
      const otherKey = randomUUID();
      const start = (key) => keyedSend("start_officer_conversation", ann, officer.id, body, key);
      const first = await start(officerKey);
      expect(first.ok, first.message).toBe(true);
      const conversation = first.value.conversation.id;
      const other = await codeConversation(f, ann, ben);
      expect((await keyedSend("send_reward_peer_message", ben, other, body, otherKey)).ok).toBe(true);

      for (const [person, title] of [[ann, null], [officer, "Secretary"]]) {
        await leaveChapter(person, f.main);
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,display_title) values($1,$2,'active',$3)", [person.id, f.east, title]);
        await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [person.id, f.east]);
      }
      expect(await stateOf(ann, conversation)).toBe("closed");
      const readConversation = async () => (await db.query(
        "select chapter_id, scope, updated_at, ctid::text as row_version from public.member_peer_conversations where id=$1",
        [conversation],
      )).rows[0];
      const before = await readConversation();
      expect(await start(officerKey)).toEqual(CLOSED);
      expect(await start(otherKey)).toMatchObject({ ok: false, code: "22023", detail: "" });
      expect(await readConversation()).toEqual(before);
      expect(await tally(conversation, [ann, officer])).toMatchObject({ messages: 1 });

      const renewed = await start(randomUUID());
      expect(renewed).toMatchObject({ ok: true, value: { created: false, conversation: { id: conversation } } });
      expect(await readConversation()).toMatchObject({ chapter_id: f.east, scope: "chapter" });
      expect(await stateOf(ann, conversation)).toBe("open");
      expect(await tally(conversation, [ann, officer])).toMatchObject({ messages: 2 });
    } finally { await db.query("rollback"); }
  }, 120_000);

  async function view(person, conversation) {
    const list = await value(person, "select public.list_reward_peer_contact() v");
    return list.conversations.find((item) => item.id === conversation) ?? null;
  }
  const stateOf = async (person, conversation) => (await view(person, conversation))?.state;
  async function tally(conversation, recipients) {
    await owner();
    const { rows } = await db.query(
      "select (select count(*) from public.member_peer_messages where conversation_id=$1)::int messages, (select count(*) from public.member_notifications where user_id=any($2::uuid[]))::int notices",
      [conversation, recipients.map((person) => person.id)]);
    return rows[0];
  }
  async function leaveChapter(person, chapter) {
    await owner();
    await db.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [person.id, chapter]);
  }
  async function rejoinChapter(person, chapter) {
    await owner();
    await db.query("update public.member_chapter_memberships set status='active', revoked_at=null where user_id=$1 and chapter_id=$2", [person.id, chapter]);
  }
  async function leaveOrganization(f, person) {
    await owner();
    await db.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1 and organization_id=$2", [person.id, f.org]);
  }
  async function rejoinOrganization(f, person) {
    await owner();
    await db.query("update public.organization_memberships set status='active', revoked_at=null where user_id=$1 and organization_id=$2", [person.id, f.org]);
  }
  async function refusedBothWays(conversation, one, two) {
    const before = await tally(conversation, [one, two]);
    expect(await send(one, conversation, "Are you there?")).toEqual(CLOSED);
    expect(await send(two, conversation, "Are you there?")).toEqual(CLOSED);
    expect(await tally(conversation, [one, two])).toEqual(before);
  }
  const crossList = async (person) => (await value(person, "select public.list_cross_chapter_peers() v")).peers.map((peer) => peer.id);
  async function officerCard(person, officer) {
    const roster = await value(person, "select public.get_chapter_leadership() v");
    return roster.people.find((row) => row.id === officer.id) ?? null;
  }

  it("closes a chapter conversation when either person leaves its chapter, keeps it readable, and reopens on return", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben } = f.people;
      const conversation = await codeConversation(f, ann, ben);
      expect((await send(ann, conversation, "Lunch at noon?")).ok).toBe(true);
      await owner();
      expect((await db.query("select scope, chapter_id from public.member_peer_conversations where id=$1", [conversation])).rows[0]).toEqual({ scope: "chapter", chapter_id: f.main });

      // Ben moves to East (still in the organization): closed both ways, still readable by both.
      await leaveChapter(ben, f.main);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ben.id, f.east]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ben.id, f.east]);
      await refusedBothWays(conversation, ann, ben);
      for (const person of [ann, ben]) {
        expect(await view(person, conversation)).toMatchObject({ state: "closed", messages: [{ body: "Lunch at noon?" }] });
      }

      // An organization administrator is in scope of every chapter conversation
      // of the organization, a code-route one too (ruling Q2).
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, ben.id]);
      expect(await stateOf(ann, conversation)).toBe("open");
      await db.query("delete from public.organization_role_grants where organization_id=$1 and user_id=$2", [f.org, ben.id]);
      expect(await stateOf(ann, conversation)).toBe("closed");

      // Coming back reopens it by itself; nothing sent while closed exists.
      await rejoinChapter(ben, f.main);
      expect(await stateOf(ann, conversation)).toBe("open");
      expect(await stateOf(ben, conversation)).toBe("open");
      expect((await send(ben, conversation, "Back on Main")).ok).toBe(true);
      expect((await view(ann, conversation)).messages.map((message) => message.body).sort()).toEqual(["Back on Main", "Lunch at noon?"]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("closes any conversation when a person leaves the organization or is suspended, while an organization conversation survives a chapter move", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben, mainLead, eastLead } = f.people;
      const sent = await value(mainLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[eastLead.id], "Joint meeting?"]);
      const cross = sent.conversations[0].id;
      await owner();
      expect((await db.query("select scope from public.member_peer_conversations where id=$1", [cross])).rows[0].scope).toBe("organization");

      // A chapter move inside the organization leaves an organization conversation open.
      await leaveChapter(eastLead, f.east);
      expect(await stateOf(mainLead, cross)).toBe("open");
      expect((await send(mainLead, cross, "Still there?")).ok).toBe(true);
      // Leaving the organization closes it, and returning reopens it.
      await leaveOrganization(f, eastLead);
      await refusedBothWays(cross, mainLead, eastLead);
      expect(await stateOf(eastLead, cross)).toBe("closed");
      await rejoinOrganization(f, eastLead);
      expect(await stateOf(mainLead, cross)).toBe("open");

      // A chapter conversation closes too when a person leaves the organization.
      const code = await codeConversation(f, ann, ben);
      await leaveOrganization(f, ann);
      await refusedBothWays(code, ann, ben);
      await rejoinOrganization(f, ann);
      expect(await stateOf(ben, code)).toBe("open");

      // A suspended account counts as left, and the conversation reopens when the suspension ends (Q6).
      await db.query("update auth.users set banned_until=now() + interval '1 day' where id=$1", [ben.id]);
      await refusedBothWays(code, ann, ben);
      await db.query("update auth.users set banned_until=null where id=$1", [ben.id]);
      expect((await send(ann, code, "Welcome back")).ok).toBe(true);

      // An organization that is shut down closes its conversations.
      await db.query("update public.organizations set status='suspended' where id=$1", [f.org]);
      expect(await stateOf(ann, code)).toBe("closed");
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("keeps the officer route to an organization administrator outside the chapter open, and closes it when the member leaves the chapter", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, orgAdmin } = f.people;
      const started = await value(ann, "select public.start_officer_conversation($1,$2) v", [orgAdmin.id, "A question for the organization"]);
      const conversation = started.conversation.id;
      expect(await stateOf(ann, conversation)).toBe("open");
      expect(await stateOf(orgAdmin, conversation)).toBe("open");
      expect((await send(orgAdmin, conversation, "Happy to help")).ok).toBe(true);
      await leaveChapter(ann, f.main);
      await refusedBothWays(conversation, ann, orgAdmin);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("blocks both ways, refuses every route for the pair, keeps other officers and the history, and unblocks", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben, cal, officer, officer2, mainLead, eastLead } = f.people;
      const conversation = await codeConversation(f, ann, ben);
      expect((await send(ben, conversation, "Hello")).ok).toBe(true);

      expect(await block(ann, conversation)).toEqual({ ok: true, value: { id: conversation, state: "blocked_by_viewer" } });
      // Blocking twice is harmless; a non-participant gets one flat refusal and writes nothing.
      expect((await block(ann, conversation)).value.state).toBe("blocked_by_viewer");
      expect(await block(cal, conversation)).toEqual({ ok: false, code: "22023", message: "message unavailable", detail: "peer_conversation_unavailable" });
      expect(await block(cal, randomUUID())).toEqual({ ok: false, code: "22023", message: "message unavailable", detail: "peer_conversation_unavailable" });
      await owner();
      expect((await db.query("select blocker_id, blocked_id from private.member_peer_blocks where blocker_id=any($1::uuid[]) or blocked_id=any($1::uuid[])", [[ann.id, ben.id, cal.id]])).rows)
        .toEqual([{ blocker_id: ann.id, blocked_id: ben.id }]);

      expect(await stateOf(ann, conversation)).toBe("blocked_by_viewer");
      expect(await stateOf(ben, conversation)).toBe("closed");
      await refusedBothWays(conversation, ann, ben);
      expect((await view(ben, conversation)).messages.map((message) => message.body)).toEqual(["Hello"]);

      // A blocked pair cannot renew contact by code either way.
      await db.query("update public.member_peer_contact_requests set created_at=now() - interval '20 days' where requester_id=$1", [ann.id]);
      await db.query("insert into public.member_reward_grants(user_id,item_key,status,source,organization_id) values ($1,'im-anyone','granted','admin_grant',$2)", [ben.id, f.org]);
      const { code } = await value(ann, "select public.list_reward_peer_contact() v");
      expect(await value(ben, "select public.request_reward_peer_contact($1) v", [code])).toEqual({ requested: false, reason: "contact request unavailable" });

      // Both may block; each must unblock before it reopens.
      expect((await block(ben, conversation)).value.state).toBe("blocked_by_viewer");
      expect((await block(ann, conversation, false)).value.state).toBe("closed");
      expect((await block(ben, conversation, false)).value.state).toBe("open");
      expect((await send(ann, conversation, "Sorry about that")).ok).toBe(true);

      // A block outlives leaving and coming back.
      await block(ann, conversation);
      await leaveOrganization(f, ben);
      await rejoinOrganization(f, ben);
      expect(await stateOf(ben, conversation)).toBe("closed");
      expect(await stateOf(ann, conversation)).toBe("blocked_by_viewer");
      await block(ann, conversation, false);

      // An officer who blocks a member drops out of that member's officer list
      // only; the member still reaches every other officer (ruling addition 3).
      const toOfficer = (await value(ann, "select public.start_officer_conversation($1,$2) v", [officer.id, "About my shift"])).conversation.id;
      await block(officer, toOfficer);
      expect(await officerCard(ann, officer)).toMatchObject({ canMessage: false });
      expect(await officerCard(ann, officer2)).toMatchObject({ canMessage: true });
      expect(await as(ann, "select public.start_officer_conversation($1,$2) v", [officer.id, "Again"])).toMatchObject({ ok: false, code: "42501", detail: "officer_unavailable" });
      expect((await as(ann, "select public.start_officer_conversation($1,$2) v", [officer2.id, "About my shift"])).ok).toBe(true);
      await block(officer, toOfficer, false);
      expect(await officerCard(ann, officer)).toMatchObject({ canMessage: true });

      // A cross-chapter peer who blocks is left out of the list and the whole send is refused.
      const cross = (await value(mainLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[eastLead.id], "Joint meeting?"])).conversations[0].id;
      await block(eastLead, cross);
      expect(await crossList(mainLead)).not.toContain(eastLead.id);
      expect(await crossList(eastLead)).not.toContain(mainLead.id);
      const before = await tally(cross, [mainLead, eastLead]);
      expect(await as(mainLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[eastLead.id], "Hello?"])).toMatchObject({ ok: false, code: "42501", detail: "cross_chapter_peer_unavailable" });
      expect(await tally(cross, [mainLead, eastLead])).toEqual(before);
      // Nothing about a block reaches a notice, the audit trail or the journal.
      await owner();
      expect((await db.query("select count(*)::int n from public.organization_audit_ledger where organization_id=$1 and metadata::text ilike '%block%'", [f.org])).rows[0].n).toBe(0);
    } finally { await db.query("rollback"); }
  }, 180_000);

  it("shows the blocked person exactly what leaving shows: the same state, refusal and list omissions", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { mainLead, eastLead } = f.people;
      const cross = (await value(mainLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[eastLead.id], "Joint meeting?"])).conversations[0].id;
      await owner();
      await db.query("select pg_catalog.set_config('request.jwt.claims','',true)");
      // What eastLead can learn about mainLead through the API.
      async function seenByEastLead() {
        const projection = await view(eastLead, cross);
        delete projection.updatedAt;
        return {
          projection,
          refusal: await send(eastLead, cross, "Is this still open?"),
          listed: (await crossList(eastLead)).includes(mainLead.id),
          resend: await as(eastLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[mainLead.id], "Hello?"]),
        };
      }
      const open = await seenByEastLead();
      expect(open.projection.state).toBe("open");
      expect(open.listed).toBe(true);

      await block(mainLead, cross);
      const blocked = await seenByEastLead();
      await block(mainLead, cross, false);
      await leaveOrganization(f, mainLead);
      const left = await seenByEastLead();

      expect(blocked).toEqual(left);
      expect(blocked.projection.state).toBe("closed");
      expect(blocked.refusal).toEqual(CLOSED);
      expect(blocked.listed).toBe(false);
      expect(blocked.resend).toMatchObject({ ok: false, code: "42501", detail: "cross_chapter_peer_unavailable" });
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("lets a route the pair may use again re-scope a conversation closed only by scope, never a blocked one", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben, mainLead, eastLead } = f.people;
      // An older chapter conversation of two leads now in different chapters is closed.
      const [low, high] = [mainLead.id, eastLead.id].sort();
      const request = (await db.query("insert into public.member_peer_contact_requests(requester_id,recipient_id,chapter_id,status,responded_at) values($1,$2,$3,'accepted',now()) returning id", [mainLead.id, eastLead.id, f.main])).rows[0].id;
      const old = (await db.query("insert into public.member_peer_conversations(chapter_id,user_low,user_high,created_from_request) values($1,$2,$3,$4) returning id", [f.main, low, high, request])).rows[0].id;
      expect(await stateOf(mainLead, old)).toBe("closed");
      // A block holds it: the cross-chapter route refuses and leaves the row alone.
      await block(eastLead, old);
      expect((await as(mainLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[eastLead.id], "Hi"])).detail).toBe("cross_chapter_peer_unavailable");
      await owner();
      expect((await db.query("select scope from public.member_peer_conversations where id=$1", [old])).rows[0].scope).toBe("chapter");
      await block(eastLead, old, false);
      // Unblocked, the cross-chapter route reuses it as an organization conversation.
      const reused = await value(mainLead, "select public.send_cross_chapter_peer_message($1::uuid[],$2) v", [[eastLead.id], "Joint meeting?"]);
      expect(reused).toMatchObject({ created: 0, conversations: [{ id: old }] });
      await owner();
      expect((await db.query("select scope, chapter_id from public.member_peer_conversations where id=$1", [old])).rows[0]).toEqual({ scope: "organization", chapter_id: f.main });
      expect(await stateOf(eastLead, old)).toBe("open");

      // A pair who both moved to East can renew contact by code there; accepting re-scopes it.
      const code = await codeConversation(f, ann, ben);
      for (const person of [ann, ben]) {
        await leaveChapter(person, f.main);
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [person.id, f.east]);
        await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [person.id, f.east]);
      }
      expect(await stateOf(ann, code)).toBe("closed");
      await db.query("update public.member_peer_contact_requests set created_at=now() - interval '20 days' where requester_id=$1", [ann.id]);
      const { code: benCode } = await value(ben, "select public.list_reward_peer_contact() v");
      expect(await value(ann, "select public.request_reward_peer_contact($1) v", [benCode])).toMatchObject({ requested: true });
      await owner();
      const renewal = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1 and status='pending'", [ann.id])).rows[0].id;
      expect(await value(ben, "select public.respond_reward_peer_contact($1,true) v", [renewal])).toMatchObject({ accepted: true, conversation: { id: code, state: "open" } });
      await owner();
      expect((await db.query("select scope, chapter_id from public.member_peer_conversations where id=$1", [code])).rows[0]).toEqual({ scope: "chapter", chapter_id: f.east });
      // An open conversation still stops a new request.
      await db.query("update public.member_peer_contact_requests set created_at=now() - interval '20 days' where requester_id=$1", [ann.id]);
      expect(await value(ann, "select public.request_reward_peer_contact($1) v", [benCode])).toEqual({ requested: false, reason: "contact request unavailable" });
    } finally { await db.query("rollback"); }
  }, 120_000);

  //  round 1 (r1s2/r2s1, r1s3/r2s3): renewing contact by code refuses a
  // target who is suspended or left exactly as it refuses a blocked pair, and
  // accepting the renewal returns the conversation's kept history.
  it("refuses a renewal to a person who left or is suspended exactly as to a blocked pair, and an accepted renewal keeps the history", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben } = f.people;
      const conversation = await codeConversation(f, ann, ben);
      expect((await send(ann, conversation, "Before the move")).ok).toBe(true);
      for (const person of [ann, ben]) {
        await leaveChapter(person, f.main);
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [person.id, f.east]);
        await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [person.id, f.east]);
      }
      await db.query("update public.member_peer_contact_requests set created_at=now() - interval '20 days' where requester_id=$1", [ann.id]);
      const { code } = await value(ben, "select public.list_reward_peer_contact() v");
      const renew = () => value(ann, "select public.request_reward_peer_contact($1) v", [code]);
      const refused = {};
      await owner();
      await db.query("update auth.users set banned_until=now() + interval '1 day' where id=$1", [ben.id]);
      refused.suspended = await renew();
      await owner();
      await db.query("update auth.users set banned_until=null where id=$1", [ben.id]);
      await leaveOrganization(f, ben);
      refused.left = await renew();
      await rejoinOrganization(f, ben);
      await leaveChapter(ben, f.east);
      refused.leftChapter = await renew();
      await rejoinChapter(ben, f.east);
      await db.query("insert into private.member_peer_blocks(blocker_id,blocked_id) values($1,$2)", [ben.id, ann.id]);
      refused.blocked = await renew();
      await db.query("delete from private.member_peer_blocks where blocker_id=$1", [ben.id]);
      for (const outcome of Object.values(refused)) expect(outcome).toEqual({ requested: false, reason: "contact request unavailable" });
      await owner();
      expect((await db.query("select count(*)::int n from public.member_peer_contact_requests where requester_id=$1 and status='pending'", [ann.id])).rows[0].n).toBe(0);

      expect(await renew()).toMatchObject({ requested: true });
      await owner();
      const renewal = (await db.query("select id from public.member_peer_contact_requests where requester_id=$1 and status='pending'", [ann.id])).rows[0].id;
      const accepted = await value(ben, "select public.respond_reward_peer_contact($1,true) v", [renewal]);
      expect(accepted).toMatchObject({ accepted: true, conversation: { id: conversation, state: "open" } });
      expect(accepted.conversation.messages.map((message) => [message.body, message.sentByMe])).toEqual([["Before the move", false]]);
    } finally { await db.query("rollback"); }
  }, 120_000);

  it("leaves out a request from a person who left or a blocked pair, and refuses to accept it, while a decline still works", async () => {
    await db.query("begin");
    try {
      const f = await fixtures();
      const { ann, ben, cal } = f.people;
      for (const requester of [ann, cal]) {
        await db.query("insert into public.member_reward_grants(user_id,item_key,status,source,organization_id) values ($1,'im-anyone','granted','admin_grant',$2)", [requester.id, f.org]);
      }
      const { code } = await value(ben, "select public.list_reward_peer_contact() v");
      for (const requester of [ann, cal]) expect((await value(requester, "select public.request_reward_peer_contact($1) v", [code])).requested).toBe(true);
      expect((await value(ben, "select public.list_reward_peer_contact() v")).incoming).toHaveLength(2);
      await leaveOrganization(f, ann);
      // Cal and Ben share no conversation, so the block is recorded directly.
      await db.query("insert into private.member_peer_blocks(blocker_id,blocked_id) values($1,$2)", [cal.id, ben.id]);
      expect((await value(ben, "select public.list_reward_peer_contact() v")).incoming).toEqual([]);
      await owner();
      const pending = (await db.query("select id, requester_id from public.member_peer_contact_requests where recipient_id=$1 order by requester_id", [ben.id])).rows;
      for (const request of pending) {
        expect(await value(ben, "select public.respond_reward_peer_contact($1,true) v", [request.id])).toEqual({ accepted: false, reason: "contact request unavailable" });
      }
      expect(await value(ben, "select public.respond_reward_peer_contact($1,false) v", [pending[0].id])).toEqual({ accepted: false, declined: true });
      await owner();
      expect((await db.query("select count(*)::int n from public.member_peer_conversations where user_low=$1 or user_high=$1", [ben.id])).rows[0].n).toBe(0);
    } finally { await db.query("rollback"); }
  }, 120_000);
});

// The race needs two sessions, so it commits a uniquely named fictional tenant
// (the disposable stack is destroyed after the run, which is the reset).
live("a block and a send on one conversation are ordered", () => {
  let one; let two; let three;
  const ids = {};
  async function connect() {
    const conn = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "peer-block-race-proof" });
    await conn.connect();
    await conn.query("set statement_timeout = '30s'");
    return conn;
  }
  async function as(conn, person) {
    await conn.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, role: "authenticated", aal: "aal2", session_id: person.session })]);
    await conn.query("set local role authenticated");
  }
  beforeAll(async () => {
    one = await connect(); two = await connect(); three = await connect();
    ids.org = randomUUID();
    ids.chapter = `plb-race-${ids.org.slice(0, 8)}`;
    await three.query("begin");
    await three.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [ids.org, ids.chapter, `Fictional Tamarack Lockworks ${ids.org}`]);
    await three.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9985)", [ids.chapter, ids.org]);
    for (const label of ["dana", "eli"]) {
      const id = randomUUID(); const session = randomUUID();
      await three.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
      await three.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
      await three.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, ids.chapter, `Fictional ${label}`]);
      await three.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, ids.chapter]);
      await three.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ids.org, id]);
      await three.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      ids[label] = { id, session };
    }
    const [low, high] = [ids.dana.id, ids.eli.id].sort();
    const request = (await three.query("insert into public.member_peer_contact_requests(requester_id,recipient_id,chapter_id,status,responded_at) values ($1,$2,$3,'accepted',now()) returning id", [ids.dana.id, ids.eli.id, ids.chapter])).rows[0].id;
    ids.conversation = (await three.query("insert into public.member_peer_conversations(chapter_id,user_low,user_high,created_from_request) values ($1,$2,$3,$4) returning id", [ids.chapter, low, high, request])).rows[0].id;
    await three.query("commit");
  });
  afterAll(async () => { for (const conn of [one, two, three]) await conn?.end().catch(() => {}); });

  it("refuses a send that waited on a committed block, and writes nothing", async () => {
    await one.query("begin"); await as(one, ids.dana);
    await two.query("begin"); await as(two, ids.eli);
    expect((await one.query("select public.set_peer_conversation_block($1,true) v", [ids.conversation])).rows[0].v.state).toBe("blocked_by_viewer");
    const waiting = two.query("select public.send_reward_peer_message($1,'Racing the block') v", [ids.conversation]);
    const settled = await Promise.race([waiting.then(() => "done", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 700))]);
    expect(settled).toBe("waiting");
    await one.query("commit");
    let failure = null;
    try { await waiting; } catch (error) { failure = error; }
    await two.query("rollback");
    expect(failure).toMatchObject({ code: "22023", message: "message unavailable", detail: "peer_conversation_closed" });
    expect((await three.query("select count(*)::int n from public.member_peer_messages where conversation_id=$1", [ids.conversation])).rows[0].n).toBe(0);
  }, 60_000);
});
