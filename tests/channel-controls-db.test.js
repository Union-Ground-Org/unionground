// @vitest-environment node
//
// REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 — live proof against a
// disposable loopback database (skipped without SUPABASE_DB_URL). Everything
// runs inside one transaction that is rolled back.
//
// Proves: server authorization and switch enforcement for every control;
// mention sanitizing; real member_notifications rows with the 'messages' kind
// for mentions, @here (online readers only, cooldown), keyword alerts and the
// 'all' level; the mute/level precedence; tenant scoping; that a muted member
// still receives an urgent steward-request notice; that the outbound pipeline
// applies the topic preference and quiet-hours rules to 'messages'; mention
// search and candidates; and the account-lifecycle export.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// [name, organization, staff roles]
const ACTORS = [
  ["steward", "orgA", ["steward"]],
  ["author", "orgA", []],
  ["mentioned", "orgA", []],
  ["online", "orgA", []],
  ["watcher", "orgA", []],
  ["follower", "orgA", []],
  ["herald", "orgA", []],
  ["outsider", "orgB", []],
];

live("restored chapter channel controls (live)", () => {
  let client;
  const ids = Object.fromEntries([
    "orgA", "orgB", "space", "staffSpace", "spaceB", "thread", "staffThread", "threadB",
    ...ACTORS.flatMap(([name]) => [name, `${name}Session`]),
  ].map((key) => [key, randomUUID()]));
  const chapter = { orgA: `cc-a-${ids.orgA.slice(0, 8)}`, orgB: `cc-b-${ids.orgB.slice(0, 8)}` };
  let savepoint = 0;

  async function as(name) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(
      { sub: ids[name], role: "authenticated", session_id: ids[`${name}Session`], aal: "aal2" },
    )]);
    await client.query("set local role authenticated");
  }

  async function attempt(text, values = []) {
    const label = `cc_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      const { rows } = await client.query(text, values);
      await client.query(`release savepoint ${label}`);
      return { ok: true, rows, code: null, detail: null };
    } catch (error) {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
      return { ok: false, rows: [], code: error.code, detail: error.detail ?? null, message: error.message };
    }
  }

  async function asPostgres(text, values = []) {
    await client.query("reset role");
    return (await client.query(text, values)).rows;
  }

  async function post(name, thread, body, mentions = []) {
    await as(name);
    const { rows } = await client.query(
      "insert into public.chapter_thread_posts (thread_id, body, mentioned_user_ids) values ($1, $2, $3::uuid[]) returning id, mentioned_user_ids",
      [thread, body, mentions],
    );
    return rows[0];
  }

  async function notices(name) {
    return asPostgres(
      "select title, kind from public.member_notifications where user_id = $1 and kind = 'messages' order by created_at, title",
      [ids[name]],
    );
  }

  async function setSwitch(org, key, value) {
    await asPostgres(
      `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, $2, $3::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [ids[org], key, JSON.stringify(value)],
    );
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "channel-controls-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    for (const [name] of ACTORS) {
      await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [ids[name], `${ids[name]}@example.invalid`]);
    }
    for (const [org, owner] of [["orgA", "steward"], ["orgB", "outsider"]]) {
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [ids[org], chapter[org], ids[owner]]);
      await client.query(
        "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9908)",
        [chapter[org], ids[org]],
      );
      await client.query("insert into public.org_security_policy (id, organization_id, require_staff_mfa) values (true, $1, true)", [ids[org]]);
    }
    for (const [name, org, roles] of ACTORS) {
      const user = ids[name];
      await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [ids[`${name}Session`], user]);
      await client.query(
        "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Channel proof factor', 'totp', 'verified', now(), now())",
        [randomUUID(), user],
      );
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids[org], user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter[org]]);
      await client.query("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [user, chapter[org], `Proof ${name}`]);
      for (const role of roles) {
        await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)", [ids[org], user, role]);
        await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter[org]]);
        await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter[org]]);
      }
    }
    for (const [space, thread, org, visibility, title] of [
      ["space", "thread", "orgA", "chapter", "Shop floor"],
      ["staffSpace", "staffThread", "orgA", "staff", "Stewards"],
      ["spaceB", "threadB", "orgB", "chapter", "Elsewhere"],
    ]) {
      // stamp_product_identity takes chapter and creator from auth.uid().
      const creator = ids[org === "orgA" ? "steward" : "outsider"];
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: creator, role: "authenticated" })]);
      await client.query(
        "insert into public.chapter_spaces (id, name, visibility) values ($1, $2, $3)",
        [ids[space], title, visibility],
      );
      await client.query(
        "insert into public.chapter_threads (id, space_id, title, kind) values ($1, $2, $3, 'topic')",
        [ids[thread], ids[space], `${title} thread`],
      );
    }
    await client.query("select set_config('request.jwt.claims', '', true)");
  }, 120_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("reports the organization switches, the keyword budget and who may pin", async () => {
    await as("author");
    const member = (await client.query("select public.get_my_channel_controls() c")).rows[0].c;
    expect(member).toMatchObject({
      available: true, organizationId: ids.orgA, keywordLimit: 10, keywordCount: 0, canPin: false, spaces: {},
      switches: { channelPinning: true, notificationLevels: true, channelMute: true, mentions: true, hereMentions: true, mentionSearch: true, keywordAlerts: true },
    });
    await as("steward");
    expect((await client.query("select public.get_my_channel_controls() c")).rows[0].c.canPin).toBe(true);
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', '', true)");
    await client.query("set local role anon");
    expect(await attempt("select public.get_my_channel_controls()")).toMatchObject({ ok: false, code: "42501" });
    await client.query("reset role");
  });

  it("authorizes level, mute and keyword writes server-side and enforces each switch", async () => {
    await as("follower");
    const saved = (await client.query("select public.set_channel_notification_level($1, 'all') r", [ids.space])).rows[0].r;
    expect(saved).toMatchObject({ spaceId: ids.space, level: "all", muted: false, keywords: [] });
    expect(await attempt("select public.set_channel_notification_level($1, 'loud')", [ids.space])).toMatchObject({ ok: false, code: "22023" });
    // Another tenant's channel and a staff-only channel look missing.
    expect(await attempt("select public.set_channel_notification_level($1, 'all')", [ids.spaceB])).toMatchObject({ ok: false, code: "P0002" });
    expect(await attempt("select public.set_channel_notification_level($1, 'all')", [ids.staffSpace])).toMatchObject({ ok: false, code: "P0002" });
    expect(await attempt("select public.set_channel_mute($1, true, now() - interval '1 minute')", [ids.space])).toMatchObject({ ok: false, code: "22023" });
    // No client grant on the settings table at all.
    expect(await attempt("insert into public.chapter_space_notification_settings (organization_id, space_id, user_id) values ($1, $2, $3)", [ids.orgA, ids.space, ids.follower]))
      .toMatchObject({ ok: false, code: "42501" });

    await setSwitch("orgA", "features.messaging.channel_notification_levels", false);
    await as("follower");
    expect(await attempt("select public.set_channel_notification_level($1, 'none')", [ids.space])).toMatchObject({ ok: false, code: "42501", detail: "feature-disabled" });
    await setSwitch("orgA", "features.messaging.channel_notification_levels", true);

    await as("watcher");
    const keywords = (await client.query("select public.set_channel_keyword_alerts($1, array['  Overtime ', 'overtime', 'Mandatory OT']) r", [ids.space])).rows[0].r;
    expect(keywords.keywords).toEqual(["overtime", "mandatory ot"]);
    expect(await attempt("select public.set_channel_keyword_alerts($1, array['x'])", [ids.space])).toMatchObject({ ok: false, code: "22023" });
    await setSwitch("orgA", "limits.messaging.keyword_alerts_per_member", 2);
    await as("watcher");
    expect(await attempt("select public.set_channel_keyword_alerts($1, array['overtime', 'mandatory ot', 'layoff'])", [ids.space]))
      .toMatchObject({ ok: false, code: "22023", detail: "keyword-limit" });
    await setSwitch("orgA", "limits.messaging.keyword_alerts_per_member", 10);
  });

  it("lets only chapter staff pin, through the RPC, while the switch is on", async () => {
    await as("author");
    expect(await attempt("select public.set_chapter_thread_pinned($1, true)", [ids.thread])).toMatchObject({ ok: false, code: "42501" });
    expect(await attempt("update public.chapter_threads set pinned_at = now() where id = $1", [ids.thread])).toMatchObject({ ok: false, code: "42501" });
    await as("steward");
    const pinned = (await client.query("select public.set_chapter_thread_pinned($1, true) r", [ids.thread])).rows[0].r;
    expect(pinned.pinnedAt).toBeTruthy();
    await as("author");
    expect((await client.query("select pinned_at from public.chapter_threads where id = $1", [ids.thread])).rows[0].pinned_at).not.toBeNull();
    await setSwitch("orgA", "features.messaging.channel_pinning", false);
    await as("steward");
    expect(await attempt("select public.set_chapter_thread_pinned($1, false)", [ids.thread])).toMatchObject({ ok: false, code: "42501", detail: "feature-disabled" });
    await setSwitch("orgA", "features.messaging.channel_pinning", true);
  });

  it("keeps only readable mentions and notifies each mentioned person once", async () => {
    const created = await post("author", ids.thread, "Can you take the overtime list?", [ids.mentioned, ids.outsider, ids.author, ids.mentioned]);
    expect(created.mentioned_user_ids).toEqual([ids.mentioned]);
    expect(await notices("mentioned")).toEqual([{ title: "Proof author mentioned you in a chapter channel", kind: "messages" }]);
    expect(await notices("outsider")).toEqual([]);
    // The keyword watcher hears it once, as a keyword alert.
    expect(await notices("watcher")).toEqual([{ title: "A chapter channel post matched one of your keywords", kind: "messages" }]);
    // Level 'all' follower hears every post.
    expect(await notices("follower")).toEqual([{ title: "Proof author posted in a chapter channel you follow", kind: "messages" }]);
    // Whole words only.
    await post("author", ids.thread, "Overtimes are posted.");
    expect(await notices("watcher")).toHaveLength(1);
    // With the switch off, mentions are dropped before storage.
    await setSwitch("orgA", "features.messaging.mentions", false);
    const off = await post("author", ids.thread, "Ping", [ids.mentioned]);
    expect(off.mentioned_user_ids).toEqual([]);
    await setSwitch("orgA", "features.messaging.mentions", true);
  });

  it("sends @here only to channel readers online now, once per ten minutes per author and channel", async () => {
    await asPostgres(
      `insert into public.member_presence (organization_id, user_id, status, last_seen_at) values
         ($1, $3, 'online', now()), ($1, $4, 'online', now() - interval '20 minutes'), ($2, $5, 'online', now())
       on conflict (organization_id, user_id) do update set status = excluded.status, last_seen_at = excluded.last_seen_at`,
      [ids.orgA, ids.orgB, ids.online, ids.mentioned, ids.outsider],
    );
    const before = (await notices("mentioned")).length;
    await post("herald", ids.thread, "@here meeting in the break room");
    expect(await notices("online")).toEqual([{ title: "Proof herald pinged everyone online in a chapter channel", kind: "messages" }]);
    expect(await notices("mentioned")).toHaveLength(before);
    expect(await notices("outsider")).toEqual([]);
    await post("herald", ids.thread, "@here again");
    expect(await notices("online")).toHaveLength(1);
    // Not a token inside an address.
    await post("author", ids.thread, "mail team@here.org");
    expect(await notices("online")).toHaveLength(1);
  });

  it("applies mute, then level, deterministically and only to this channel's notices", async () => {
    await as("mentioned");
    const muted = (await client.query("select public.set_channel_mute($1, true, null) r", [ids.space])).rows[0].r;
    expect(muted).toMatchObject({ muted: true, mutedUntil: null, muteActive: true });
    const before = (await notices("mentioned")).length;
    await post("author", ids.thread, "Still need you here", [ids.mentioned]);
    expect(await notices("mentioned")).toHaveLength(before + 1);
    expect((await asPostgres(
      "select private.channel_alert_decision($1, $2, $3, 'mention') d", [ids.orgA, ids.space, ids.mentioned],
    ))[0].d).toBe("deliver");
    expect((await asPostgres("select private.channel_alert_decision($1, $2, $3, 'here') d", [ids.orgA, ids.space, ids.mentioned]))[0].d).toBe("muted");
    // The mute switch off restores @here delivery without touching the stored choice.
    await setSwitch("orgA", "features.messaging.channel_mute", false);
    expect((await asPostgres("select private.channel_alert_decision($1, $2, $3, 'here') d", [ids.orgA, ids.space, ids.mentioned]))[0].d).toBe("deliver");
    await setSwitch("orgA", "features.messaging.channel_mute", true);
    // Level 'none' silences even a mention; 'mentions' never delivers a plain post.
    await as("mentioned");
    await client.query("select public.set_channel_mute($1, false, null)", [ids.space]);
    await client.query("select public.set_channel_notification_level($1, 'none')", [ids.space]);
    expect((await asPostgres("select private.channel_alert_decision($1, $2, $3, 'mention') d", [ids.orgA, ids.space, ids.mentioned]))[0].d).toBe("level_none");
    expect((await asPostgres("select private.channel_alert_decision($1, $2, $3, 'post') d", [ids.orgA, ids.space, ids.watcher]))[0].d).toBe("level_mentions");
    // Tenant scope: another organization's switches and rows are never read.
    expect((await asPostgres("select private.channel_alert_decision($1, $2, $3, 'mention') d", [ids.orgB, ids.space, ids.mentioned]))[0].d).toBe("deliver");
  });

  it("never mutes an urgent steward-request notice for a member who muted every channel", async () => {
    await as("steward");
    await client.query("select public.set_channel_mute($1, true, null)", [ids.space]);
    await client.query("select public.set_channel_mute($1, true, null)", [ids.staffSpace]);
    await client.query("select public.set_channel_notification_level($1, 'none')", [ids.staffSpace]);
    await asPostgres("insert into public.member_steward_requests (user_id) values ($1)", [ids.author]);
    const urgent = await asPostgres("select kind from public.member_notifications where user_id = $1 and kind = 'cases'", [ids.steward]);
    expect(urgent).toHaveLength(1);
  });

  it("routes 'messages' through the outbound pipeline: topic preference and quiet hours apply", async () => {
    await asPostgres("update private.notification_controls set outbound_enabled = true where id");
    await asPostgres("update public.member_profiles set notification_prefs = notification_prefs || '{\"messages\": false}'::jsonb where id = $1", [ids.watcher]);
    await post("author", ids.thread, "Mandatory OT starts Monday", [ids.online]);
    const deliveries = await asPostgres(
      `select n.user_id, d.channel from public.member_notification_deliveries d
       join public.member_notifications n on n.id = d.notification_id
       where n.kind = 'messages' and n.user_id = any($1::uuid[]) order by 1, 2`,
      [[ids.online, ids.watcher]],
    );
    expect(deliveries).toEqual([{ user_id: ids.online, channel: "email" }]);
    await asPostgres("update public.member_profiles set dnd_enabled = true where id = $1", [ids.online]);
    const [focus] = await asPostgres("select private.member_focus_blocks($1, 'messages') messages, private.member_focus_blocks($1, 'cases') cases", [ids.online]);
    expect(focus).toEqual({ messages: true, cases: false });
  });

  it("searches only the caller's mentions in channels they can read, and suggests only safe names", async () => {
    await as("online");
    const hits = (await client.query("select public.search_my_channel_mentions(null, 30) r")).rows[0].r;
    // Both @here posts use the token (the second was rate-limited as a ping,
    // not hidden as a post); the third hit names the member directly.
    expect(hits.map((hit) => hit.reason).sort()).toEqual(["here", "here", "mention"]);
    const filtered = (await client.query("select public.search_my_channel_mentions('mandatory', 30) r")).rows[0].r;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ threadId: ids.thread, reason: "mention" });
    await as("outsider");
    expect((await client.query("select public.search_my_channel_mentions(null, 30) r")).rows[0].r).toEqual([]);

    // A member sees authors in this channel and published stewards, never a directory.
    await as("watcher");
    const memberCandidates = (await client.query("select public.list_channel_mention_candidates($1, 'proof', 10) r", [ids.space])).rows[0].r;
    const memberNames = memberCandidates.map((row) => row.name);
    expect(memberNames).toContain("Proof author");
    expect(memberNames).not.toContain("Proof follower");
    await as("steward");
    const staffNames = (await client.query("select public.list_channel_mention_candidates($1, 'proof', 10) r", [ids.space])).rows[0].r.map((row) => row.name);
    expect(staffNames).toContain("Proof follower");
    expect(staffNames).not.toContain("Proof outsider");
    await setSwitch("orgA", "features.messaging.mention_search", false);
    await as("online");
    expect(await attempt("select public.search_my_channel_mentions(null, 30)")).toMatchObject({ ok: false, code: "42501", detail: "feature-disabled" });
  });

  it("exports the member's own settings and deletes them with the account", async () => {
    const [row] = await asPostgres("select private.account_lifecycle_export_chapter_space_notification_settings($1) e", [ids.mentioned]);
    expect(row.e).toEqual([expect.objectContaining({ space_id: ids.space, notification_level: "none", user_id: ids.mentioned })]);
    const [domains] = await asPostgres("select private.account_lifecycle_export_additional_domains($1) d", [ids.mentioned]);
    expect(domains.d).toHaveProperty("chapter_space_notification_settings");
    const [manifest] = await asPostgres(
      "select delete_disposition, export_disposition from private.account_lifecycle_manifest where table_name = 'chapter_space_notification_settings'",
    );
    expect(manifest).toEqual({ delete_disposition: "cascade", export_disposition: "included" });
    const [issues] = await asPostgres("select count(*)::integer n from private.account_lifecycle_referential_action_trigger_issues()");
    expect(issues.n).toBe(0);
    // The full lifecycle trigger review takes about 11 s on a migrated stack.
  }, 120_000);
});
