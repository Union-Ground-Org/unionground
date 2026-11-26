// Executable authorization proof on an owned PostgreSQL container only.
// This focused substrate uses the canonical tenant/event predicate and exact
// pinned producer predecessors. It is local regression evidence, not a hosted receipt.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { fnBody } from "./helpers/migration.js";
import { foreignKeyCatalogueSql, normalizeForeignKeyRow } from "../scripts/account-case-graph-inventory.mjs";

const image = "postgres@sha256:a3b7f434b2dc57ce85a67e171163eb8ab1a1ebcb39d27484661f26b1dfbe30d6";
const sql = readFileSync(new URL("../supabase/migrations/20261007023000_authorized_event_notification_email.sql", import.meta.url), "utf8");
const predecessors = JSON.parse(readFileSync(new URL("./fixtures/event-email-predecessors.json", import.meta.url), "utf8"));
const lifecycleSurface = fnBody(readFileSync(new URL('../supabase/migrations/20260907150000_account_lifecycle_manifest.sql', import.meta.url), 'utf8'), 'private.account_lifecycle_trigger_surface');
const scope = fnBody(readFileSync(new URL("../supabase/migrations/20260901153739_event_organization_isolation.sql", import.meta.url), "utf8"), "private.member_can_access_event_scope_for_user");

test("event email requires live source authorization and the exact delivery lease", async (t) => {
  const container = `event-email-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  let client;
  try {
    execFileSync("docker", ["run", "--detach", "--rm", "--name", container,
      "--label", "net.unionground.test-fixture=event-email", "--env", "POSTGRES_PASSWORD=postgres",
      "--publish", "127.0.0.1::5432", image], { stdio: "ignore" });
    started = true;
    const port = Number(execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
    assert.ok(Number.isInteger(port) && port > 0);
    // One bounded startup pause, no polling and no shared or hosted database URL.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres", connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema private;
      grant usage on schema public, auth, private to anon, authenticated, service_role;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      create function auth.role() returns text language sql stable as $$select auth.jwt()->>'role'$$;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz default now(), deleted_at timestamptz, banned_until timestamptz);
      create table public.organizations(id uuid primary key, status text);
      create table public.chapters(id text primary key, organization_id uuid references public.organizations, region text);
      create table public.organization_memberships(organization_id uuid, user_id uuid, status text);
      create table public.member_chapter_memberships(user_id uuid, chapter_id text, status text);
      create table public.member_profiles(id uuid primary key, chapter_id text, language text default 'en', quiet_hours_timezone text default 'America/New_York', notification_prefs jsonb default '{}');
      create table public.member_events(id text primary key, title text, starts_at timestamptz, chapter_id text,
        is_public boolean default false, is_public_across_agencies boolean default false, cancelled_at timestamptz,
        cancelled_reason text, created_at timestamptz default now(), location text, summary text, check_in_code text,
        order_index integer, reminder_notice_sent_at timestamptz);
      create table public.member_event_rsvps(event_id text, user_id uuid, status text);
      create table public.member_admin_audit(actor uuid, action text, detail jsonb);
      create table public.member_notifications(id uuid primary key default gen_random_uuid(), user_id uuid, title text, body text,
        kind text, copy_key text, source_chapter_id text, read_at timestamptz, created_at timestamptz default now());
      grant select on public.member_notifications to authenticated;
      grant update(read_at) on public.member_notifications to authenticated;
      create table public.member_notification_deliveries(id uuid primary key default gen_random_uuid(), notification_id uuid, user_id uuid,
        channel text default 'email', status text default 'sending', attempts integer default 1, delivery_lease_epoch bigint default 1,
        updated_at timestamptz default now(), created_at timestamptz default now());
      create table private.account_lifecycle_manifest(schema_name text,table_name text,user_column text,delete_disposition text,export_disposition text,
        export_projection text,export_inventory_basis text,exclusion_reason text,note text,reviewed_at date);
      create table private.account_lifecycle_trigger_review(kind text,schema_name text,table_name text,object_name text,definition_hash text);
      create function private.lock_case_graph_statement() returns trigger language plpgsql as $$begin return null; end$$;
      create function private.lock_case_graph_row_keys() returns trigger language plpgsql as $$begin return coalesce(new,old); end$$;
      create table private.notification_controls(id boolean primary key, outbound_enabled boolean);
      insert into private.notification_controls values(true, true);
      create table private.notification_copy(key text, lang text, title text, body text, primary key(key, lang));
      insert into private.notification_copy select 'event.' || change, lang, 'Event update', 'Open the app'
        from unnest(array['created','rescheduled','cancelled','restored','reminder']) change, unnest(array['en','es']) lang;
      create table private.member_stress_ledger(user_id uuid);
      create function private.lock_case_graph(uuid[], uuid[]) returns void language plpgsql as $$begin return; end$$;
      create function private.member_focus_blocks(uuid, text) returns boolean language sql stable as $$select exists(select 1 from private.member_stress_ledger where user_id=$1)$$;
      create function private.current_member_chapter() returns text language sql stable as $$select chapter_id from public.member_profiles where id=auth.uid()$$;
      create function private.member_can_manage_events() returns boolean language sql stable as $$select auth.uid() is not null$$;
      create function private.engagement_follow_up_sweep(integer) returns void language plpgsql as $$begin return; end$$;
    `);
    await client.query(scope);
    await client.query(lifecycleSurface);
    const originalWriters = new Map();
    for (const writer of predecessors.writers) {
      await client.query(writer.definition);
      await client.query(`revoke all on function ${writer.signature} from public, anon, authenticated, service_role`);
      if (writer.signature.startsWith("public.")) {
        await client.query(`grant execute on function ${writer.signature} to authenticated`);
      }
      await client.query(`comment on function ${writer.signature} is 'Retained event producer catalog marker'`);
      const original = (await client.query(`select p.prosrc source,
        to_jsonb(p) - 'prosrc' - 'proargdefaults' attributes,
        pg_catalog.pg_get_expr(p.proargdefaults, 0) defaults,
        pg_catalog.obj_description(p.oid, 'pg_proc') comment from pg_catalog.pg_proc p where p.oid=$1::regprocedure`,
      [writer.signature])).rows[0];
      originalWriters.set(writer.signature, original);
    }
    for (const writer of predecessors.writers) await t.test(`migration refuses unreviewed ${writer.signature} and rolls every change back`, async () => {
      await client.query("begin");
      try {
        await client.query(writer.definition.replace("\nbegin", "\nbegin\n-- unreviewed source"));
        await assert.rejects(client.query(sql), { code: "55000" });
      } finally { await client.query("rollback"); }
      assert.equal((await client.query("select count(*)::integer count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='member_notification_event_sources'")).rows[0].count, 0);
      assert.equal((await client.query("select to_regprocedure('public.get_event_notification_email(uuid,integer,bigint,text)') signature")).rows[0].signature, null);
    });
    await t.test("the independent call-count guard rejects duplicate notifications with a matching source digest", async () => {
      const writer = predecessors.writers[0];
      await client.query("begin");
      try {
        await client.query(writer.definition.replace(writer.old, `${writer.old}\n      ${writer.old}`));
        const digest = (await client.query("select md5(prosrc) digest from pg_catalog.pg_proc where oid=$1::regprocedure", [writer.signature])).rows[0].digest;
        assert.notEqual(digest, writer.sourceMd5);
        await assert.rejects(client.query(sql.replace(writer.sourceMd5, digest)), { code: "55000" });
      } finally { await client.query("rollback"); }
      assert.equal((await client.query("select to_regprocedure('public.get_event_notification_email(uuid,integer,bigint,text)') signature")).rows[0].signature, null);
    });
    await t.test("constant replacements refuse execution-attribute drift without normalizing the predecessor", async () => {
      const writer = predecessors.writers[0];
      await client.query("begin");
      try {
        await client.query(`alter function ${writer.signature} stable`);
        await assert.rejects(client.query(sql), { code: "55000", message: /unreviewed event notification producer attributes/ });
      } finally { await client.query("rollback"); }
    });
    await t.test("constant replacements refuse default-argument drift without normalizing the predecessor", async () => {
      const writer = predecessors.writers[0];
      await client.query("begin");
      try {
        await client.query(writer.definition.replace("p_is_public boolean default false", "p_is_public boolean default true"));
        await assert.rejects(client.query(sql), { code: "55000", message: /unreviewed event notification producer attributes/ });
      } finally { await client.query("rollback"); }
    });
    await client.query(sql);
    for (const writer of predecessors.writers) await t.test(`constant ${writer.signature} preserves its catalog and changes only the reviewed call`, async () => {
      const original = originalWriters.get(writer.signature);
      const installed = (await client.query(`select p.prosrc source,
        to_jsonb(p) - 'prosrc' - 'proargdefaults' attributes,
        pg_catalog.pg_get_expr(p.proargdefaults, 0) defaults,
        pg_catalog.obj_description(p.oid, 'pg_proc') comment from pg_catalog.pg_proc p where p.oid=$1::regprocedure`,
      [writer.signature])).rows[0];
      assert.deepEqual(installed.attributes, original.attributes, "OID, owner, ACL, defaults, arguments and execution attributes stay identical");
      assert.equal(installed.defaults, original.defaults, "default expressions stay identical without comparing parser offsets");
      assert.equal(installed.comment, original.comment);
      assert.equal(installed.source, original.source.replace(writer.old, writer.new), "authorization, locking and every other source byte stay identical");
      assert.equal(installed.source.split(writer.new).length, 2);
      assert.equal(installed.source.includes(writer.old), false);
      assert.ok(sql.includes(writer.definition.replace(writer.old, writer.new)), "the replacement is top-level canonical constant SQL");
    });
    await t.test("the retained source FK inventory equals its installed catalog", async () => {
      const catalog = (await client.query(foreignKeyCatalogueSql)).rows.map(normalizeForeignKeyRow)
        .filter((entry) => entry.child === "private.member_notification_event_sources");
      const expected = JSON.parse(readFileSync(new URL("../scripts/account-case-graph-fks.json", import.meta.url), "utf8"))
        .foreign_keys.filter((entry) => entry.child === "private.member_notification_event_sources");
      assert.deepEqual(catalog, expected);
      assert.equal((await client.query("select count(*)::integer count from private.account_lifecycle_trigger_review where table_name='member_notification_event_sources'")).rows[0].count, 2);
    });

    const orgA = randomUUID(), orgB = randomUUID(), user = randomUUID(), caller = randomUUID(), foreign = randomUUID();
    const email = "member@example.invalid";
    await client.query("insert into public.organizations values($1,'active'),($2,'active')", [orgA, orgB]);
    await client.query("insert into public.chapters values('event-a',$1,'east'),('event-a2',$1,'east'),('event-a3',$1,'west'),('event-b',$2,'east')", [orgA, orgB]);
    for (const [id, chapter, org] of [[user, "event-a", orgA], [caller, "event-a", orgA], [foreign, "event-b", orgB]]) {
      await client.query("insert into auth.users(id,email) values($1,$2)", [id, id === user ? email : `${id}@example.invalid`]);
      await client.query("insert into public.member_profiles(id,chapter_id) values($1,$2)", [id, chapter]);
      await client.query("insert into public.organization_memberships values($1,$2,'active')", [org, id]);
      await client.query("insert into public.member_chapter_memberships values($1,$2,'active')", [id, chapter]);
    }
    await client.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: "authenticated", sub: caller })]);
    await client.query("select public.create_member_event('test-event','Safe meeting',now()+interval '12 hours','PRIVATE-LOCATION','PRIVATE-SUMMARY','SG-ABC',false,false)");
    const notification = (await client.query("select notification.*, source.source_event_id,source.source_event_chapter_id,source.source_event_organization_id from public.member_notifications notification join private.member_notification_event_sources source on source.notification_id=notification.id where notification.user_id=$1 and notification.copy_key='event.created'", [user])).rows[0];
    assert.equal(notification.source_event_id, "test-event");
    assert.equal(notification.source_event_chapter_id, "event-a");
    assert.equal(notification.source_event_organization_id, orgA);
    assert.equal(notification.title, "Event update", "in-app copy remains generic");
    const delivery = (await client.query("insert into public.member_notification_deliveries(notification_id,user_id) values($1,$2) returning id", [notification.id, user])).rows[0].id;
    await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false)");
    const project = async (overrides = {}) => (await client.query("select public.get_event_notification_email($1,$2,$3,$4) value",
      [Object.hasOwn(overrides, "id") ? overrides.id : delivery,
        Object.hasOwn(overrides, "attempt") ? overrides.attempt : 1,
        Object.hasOwn(overrides, "epoch") ? overrides.epoch : 1,
        Object.hasOwn(overrides, "email") ? overrides.email : email])).rows[0].value;
    const mutate = async (query, params = [], expected = "refused") => {
      await client.query("begin");
      try { await client.query(query, params); assert.equal((await project()).status, expected); }
      finally { await client.query("rollback"); }
    };
    await t.test("authorized source exposes only the bounded title, date and change", async () => {
      const projection = await project();
      assert.equal(projection.status, "authorized"); assert.equal(projection.title, "Safe meeting");
      assert.equal(projection.change, "created"); assert.equal(projection.email, email); assert.equal(projection.lang, "en");
      assert.deepEqual(Object.keys(projection).sort(), ["attempt","change","deliveryId","email","lang","leaseEpoch","startsAt","status","timeZone","title"].sort());
      assert.ok(!JSON.stringify(projection).includes("PRIVATE-"));
    });
    for (const [name, change] of Object.entries({ wrongDelivery: { id: randomUUID() }, wrongAttempt: { attempt: 2 }, wrongEpoch: { epoch: 2 }, wrongEmail: { email: "another@example.invalid" }, zeroAttempt: { attempt: 0 }, zeroEpoch: { epoch: 0 }, missingDelivery: { id: null }, missingAttempt: { attempt: null }, missingEpoch: { epoch: null }, missingEmail: { email: null } })) {
      await t.test(name, async () => assert.deepEqual(await project(change), { status: "refused" }));
    }
    for (const [name, query, params] of [
      ["revoked organization membership", "update public.organization_memberships set status='revoked' where user_id=$1", [user]],
      ["revoked chapter membership", "update public.member_chapter_memberships set status='revoked' where user_id=$1", [user]],
      ["inactive organization", "update public.organizations set status='inactive' where id=$1", [orgA]],
      ["foreign tenant after claim even when across-agency public", "update public.member_profiles set chapter_id='event-b' where id=$1; update public.member_events set is_public_across_agencies=true", []],
      ["changed source chapter", "update public.member_events set chapter_id='event-a2'", []],
      ["recreated event id", "update public.member_events set created_at=created_at+interval '1 second'", []],
      ["deleted event", "delete from public.member_events", []],
      ["cancelled event after creation", "update public.member_events set cancelled_at=now()", []],
      ["disabled email preference", "update public.member_profiles set notification_prefs='{\"events\":false}' where id=$1", [user]],
      ["focus pause", "insert into private.member_stress_ledger values($1)", [user]],
      ["unconfirmed email", "update auth.users set email_confirmed_at=null where id=$1", [user]],
      ["changed email after claim", "update auth.users set email='changed@example.invalid' where id=$1", [user]],
      ["deleted account", "update auth.users set deleted_at=now() where id=$1", [user]],
      ["banned account", "update auth.users set banned_until=now()+interval '1 hour' where id=$1", [user]],
      ["outbound switch disabled", "update private.notification_controls set outbound_enabled=false", []],
      ["wrong channel", "update public.member_notification_deliveries set channel='push'", []],
      ["unclaimed delivery", "update public.member_notification_deliveries set status='pending'", []],
      ["missing lease timestamp", "update public.member_notification_deliveries set updated_at=null", []],
      ["completed lease", "update public.member_notification_deliveries set status='sent'", []],
      ["expired lease", "update public.member_notification_deliveries set updated_at=now()-interval '16 minutes'", []],
      ["expired delivery", "update public.member_notification_deliveries set created_at=now()-interval '49 hours'", []],
      ["substituted recipient", "update public.member_notification_deliveries set user_id=$1", [foreign]],
      ["substituted source recipient", "update private.member_notification_event_sources set user_id=$1", [foreign]],
      ["substituted notification change", "update public.member_notifications set copy_key='event.reminder'", []],
      ["unbounded event title", "update public.member_events set title=repeat('x',121)", []],
      ["control character event title", "update public.member_events set title='Meeting'||chr(10)||'Injected'", []],
      ["infinite event date", "update public.member_events set starts_at='infinity'", []],
    ]) {
      await t.test(name, async () => {
        if (name.startsWith("foreign tenant")) {
          await client.query("begin");
          try {
            await client.query("update public.member_profiles set chapter_id='event-b' where id=$1", [user]);
            await client.query("update public.member_events set is_public_across_agencies=true");
            assert.equal((await project()).status, "refused");
          } finally { await client.query("rollback"); }
        } else await mutate(query, params);
      });
    }
    await t.test("the first authorized attempt uses live server language and configured time zone", async () => {
      await client.query("begin");
      try {
        await client.query("update private.member_notification_event_sources set email_projection=null");
        await client.query("update public.member_profiles set language='es',quiet_hours_timezone='America/Los_Angeles' where id=$1", [user]);
        const projection = await project(); assert.equal(projection.lang, "es");
        assert.equal(projection.timeZone, "America/Los_Angeles");
      }
      finally { await client.query("rollback"); }
    });
    await t.test("a retry freezes title, date, language and zone while rebinding the fresh lease", async () => {
      await client.query("begin");
      try {
        const before = await project();
        await client.query("update public.member_events set title='Renamed meeting', starts_at=starts_at+interval '2 days'");
        await client.query("update public.member_profiles set language='es', quiet_hours_timezone='America/Los_Angeles' where id=$1", [user]);
        await client.query("update public.member_notification_deliveries set attempts=2,delivery_lease_epoch=2,updated_at=clock_timestamp()");
        const after = await project({ attempt: 2, epoch: 2 });
        assert.deepEqual(after, { ...before, attempt: 2, leaseEpoch: 2 });
        await client.query("update public.organization_memberships set status='revoked' where user_id=$1", [user]);
        assert.equal((await project({ attempt: 2, epoch: 2 })).status, "refused");
      } finally { await client.query("rollback"); }
    });
    await t.test("a changed confirmed address cannot reuse frozen provider copy", async () => {
      await client.query("begin");
      try {
        await client.query("update auth.users set email='new@example.invalid' where id=$1", [user]);
        assert.equal((await project({ email: "new@example.invalid" })).status, "refused");
      } finally { await client.query("rollback"); }
    });
    await t.test("an invalid configured zone cannot seed retry copy", async () => {
      await client.query("begin");
      try {
        await client.query("update private.member_notification_event_sources set email_projection=null");
        await client.query("update public.member_profiles set quiet_hours_timezone='Mars/Olympus' where id=$1", [user]);
        assert.equal((await project()).status, "refused");
      } finally { await client.query("rollback"); }
    });
    await t.test("legacy notices stay generic without guessing an event source", async () => {
      await client.query("begin");
      try {
        await client.query("delete from private.member_notification_event_sources");
        const projection = await project(); assert.equal(projection.status, "generic"); assert.equal(projection.title, undefined);
      } finally { await client.query("rollback"); }
    });
    await t.test("provenance is removed with its notification or account", async () => {
      for (const query of ["delete from public.member_notifications where id=$1", "delete from auth.users where id=$1"]) {
        await client.query("begin");
        try {
          await client.query(query, [query.includes("member_notifications") ? notification.id : user]);
          assert.equal((await client.query("select count(*)::integer count from private.member_notification_event_sources where user_id=$1", [user])).rows[0].count, 0);
          assert.equal((await project()).status, "refused");
        } finally { await client.query("rollback"); }
      }
    });
    await t.test("other event visibility obeys the same tenant-first predicate", async () => {
      await client.query("begin");
      try {
        await client.query("update public.member_profiles set chapter_id='event-a2' where id=$1", [user]);
        await client.query("insert into public.member_chapter_memberships values($1,'event-a2','active')", [user]);
        assert.equal((await project()).status, "refused");
        await client.query("update public.member_events set is_public=true"); assert.equal((await project()).status, "authorized");
        await client.query("update public.member_profiles set chapter_id='event-a3' where id=$1", [user]);
        await client.query("insert into public.member_chapter_memberships values($1,'event-a3','active')", [user]);
        assert.equal((await project()).status, "refused");
        await client.query("update public.member_events set is_public_across_agencies=true"); assert.equal((await project()).status, "authorized");
        await client.query("update public.member_chapter_memberships set status='revoked' where chapter_id='event-a3'");
        assert.equal((await project()).status, "refused");
      } finally { await client.query("rollback"); }
    });
    await t.test("the producer refuses revoked and foreign recipients before it writes a source", async () => {
      await client.query("begin");
      try {
        await client.query("update public.member_events set is_public=true,is_public_across_agencies=true");
        await client.query("select private.notify_member_event($1,'test-event','created')", [foreign]);
        assert.equal((await client.query("select count(*)::integer count from public.member_notifications where user_id=$1", [foreign])).rows[0].count, 0);
        await client.query("update public.organization_memberships set status='revoked' where user_id=$1", [user]);
        await client.query("select private.notify_member_event($1,'test-event','created')", [user]);
        assert.equal((await client.query("select count(*)::integer count from public.member_notifications where user_id=$1", [user])).rows[0].count, 1);
      } finally { await client.query("rollback"); }
    });
    await t.test("all five producers attach the event and change without notification text", async () => {
      await client.query("begin");
      try {
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: caller })]);
        await client.query("insert into public.member_event_rsvps values('test-event',$1,'going')", [user]);
        await client.query("select public.update_member_event('test-event',null,now()+interval '14 hours')");
        await client.query("select private.event_notice_sweep()");
        await client.query("select public.cancel_member_event('test-event','PRIVATE-CANCELLATION-REASON')");
        const rows = (await client.query("select source_event_id,source_event_change from private.member_notification_event_sources where user_id=$1 order by source_event_change", [user])).rows;
        assert.deepEqual(rows.map((row) => row.source_event_change), ["cancelled","created","reminder","rescheduled"]);
        assert.ok(rows.every((row) => row.source_event_id === "test-event"));
        const id = (await client.query("insert into public.member_notification_deliveries(notification_id,user_id) select notification_id,user_id from private.member_notification_event_sources where source_event_change='cancelled' returning id")).rows[0].id;
        await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
        const projection = await project({ id }); assert.equal(projection.change, "cancelled"); assert.ok(!JSON.stringify(projection).includes("PRIVATE-CANCELLATION"));
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: caller })]);
        await client.query("select public.restore_member_event('test-event')");
        await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
        assert.equal((await project({ id })).status, "refused");
        const restored = (await client.query("insert into public.member_notification_deliveries(notification_id,user_id) select notification_id,user_id from private.member_notification_event_sources where source_event_change='restored' and user_id=$1 returning id", [user])).rows[0].id;
        assert.equal((await project({ id: restored })).change, "restored");
      } finally { await client.query("rollback"); }
    });
    await t.test("no client role can read/write source fields or execute event projections", async () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const access = (await client.query("select has_function_privilege($1,'public.get_event_notification_email(uuid,integer,bigint,text)','execute') allowed", [role])).rows[0].allowed;
        assert.equal(access, role === "service_role");
        assert.equal((await client.query("select has_function_privilege($1,'private.notify_member_event(uuid,text,text)','execute') allowed", [role])).rows[0].allowed, false);
      }
      for (const role of ["anon","authenticated","service_role"]) {
        for (const privilege of ["SELECT","INSERT","UPDATE","DELETE"]) assert.equal((await client.query("select has_table_privilege($1,'private.member_notification_event_sources',$2) allowed", [role, privilege])).rows[0].allowed, false);
      }
      await client.query("set role authenticated");
      try { await client.query("select * from public.member_notifications"); await assert.rejects(client.query("select public.get_event_notification_email($1,1,1,$2)", [delivery,email]), { code: "42501" }); }
      finally { await client.query("reset role"); }
    });
  } finally {
    if (client) await client.end();
    if (started) execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
});
