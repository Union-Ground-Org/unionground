// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

// These are text pins, and text pins are a tripwire, not a proof: they assert
// what the migration SAYS, not what the database ENDS UP with. Anything that
// depends on final catalog state — RLS actually denying a cross-member read,
// one and only one enqueue trigger being installed, the claim genuinely
// skipping locked rows under concurrency — is verified after apply by
// scripts/verify-notification-schema.sql against the live database, and that
// output is the evidence. What lives here is the cheap half: it catches an
// edit that drops a guard, and it runs on every commit.
const migration = loadMigrationSql;

// These files are heavily commented, and a comment that happens to quote the
// statement it is explaining will satisfy a naive `toContain`. Any assertion
// about what the migration DOES has to look at code only — including the
// comments that TRAIL a line of live SQL, which the copy this file used to
// carry left in place.
const code = stripComments;

describe("member_push_subscriptions migration invariants", () => {
  const sql = migration("member_push_subscriptions");

  it("allow-lists the push-service host so the dispatcher is not an SSRF primitive", () => {
    // A bare ^https:// check would let a member point the service-role
    // dispatcher at any host it can reach.
    expect(sql).toContain("googleapis\\.com|push\\.services\\.mozilla\\.com|notify\\.windows\\.com|push\\.apple\\.com");
    expect(sql).not.toMatch(/endpoint ~ '\^https:\/\/'/);
    // Enforced twice: in the CHECK and again in the writer RPC.
    expect(sql.match(/googleapis\\\.com/g).length).toBeGreaterThanOrEqual(2);
  });

  it("rejects credentials, ports and IP literals in the endpoint grammar", () => {
    expect(sql).toContain("'^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*/[[:graph:]]*$'");
  });

  it("keys uniqueness on the endpoint alone, because an endpoint is a browser", () => {
    expect(sql).toContain("endpoint text not null unique");
    expect(sql).not.toContain("unique (user_id, endpoint)");
  });

  it("routes every write through the definer RPC and leaves clients no insert or update", () => {
    expect(sql).toContain("create or replace function public.upsert_push_subscription");
    expect(sql).toContain("on conflict (endpoint) do update");
    expect(sql).toContain("set user_id = caller");
    expect(sql).toContain("grant select, delete on public.member_push_subscriptions to authenticated");
    expect(sql).not.toMatch(/grant[^;]*insert[^;]*on public\.member_push_subscriptions to authenticated/);
    expect(sql).not.toMatch(/grant[^;]*update[^;]*on public\.member_push_subscriptions to authenticated/);
    expect(sql).toContain("drop policy if exists member_push_subscriptions_insert_own");
    expect(sql).toContain("drop policy if exists member_push_subscriptions_update_own");
  });

  it("caps devices per member so one account cannot build a fan-out bomb", () => {
    expect(sql).toContain("max_devices constant integer := 10");
    expect(sql).toContain("before insert on public.member_push_subscriptions");
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  it("is RLS-enabled, self-scoped, and never granted to anon", () => {
    expect(sql).toContain("enable row level security");
    expect(sql.match(/\(select auth\.uid\(\)\) = user_id/g).length).toBeGreaterThanOrEqual(2);
    expect(sql).not.toMatch(/grant [^;]* to [^;]*\banon\b/i);
  });
});

// The `kind` column lives in its own migration on purpose: every statement in
// it takes ACCESS EXCLUSIVE on the ~300k-row feed, and a lock is held for the
// whole transaction, so folding it back into the large migration would stall
// every member's notification read for the length of that batch.
describe("notification kind column migration invariants", () => {
  const sql = migration("notification_kind_column");

  it("adds the closed topic list including the separate forms topic", () => {
    expect(sql).toContain("add column if not exists kind text not null default 'general'");
    expect(sql).toContain("check (kind in ('deadlines', 'cases', 'forms', 'votes', 'events', 'general'))");
  });

  it("adds the CHECK NOT VALID so it does not scan the populated feed under lock", () => {
    expect(sql).toMatch(/check \(kind in \([^)]*\)\)\s*\n\s*not valid/);
  });

  it("stops a member re-topicking their own notification", () => {
    expect(sql).toContain("revoke update on public.member_notifications from authenticated");
    expect(sql).toContain("grant update (read_at) on public.member_notifications to authenticated");
  });

  // RLS default-denies INSERT/DELETE today, but TRUNCATE bypasses RLS entirely
  // and every row here is written by a definer body.
  it("drops the stock grants the client provably does not need", () => {
    expect(sql).toContain("revoke insert, delete, truncate, references, trigger on public.member_notifications from authenticated");
    expect(sql).toContain("revoke insert, delete, truncate, references, trigger on public.member_notifications from anon");
  });

  it("holds no other lock on the feed in this file", () => {
    // A create trigger here would re-extend the ACCESS EXCLUSIVE window.
    expect(code(sql)).not.toMatch(/create trigger/i);
  });
});

describe("notification enqueue trigger migration invariants", () => {
  const sql = migration("notification_enqueue_trigger");

  it("installs exactly one AFTER INSERT enqueue trigger", () => {
    expect(sql).toContain("drop trigger if exists member_notifications_enqueue_deliveries on public.member_notifications");
    expect(sql).toContain("after insert on public.member_notifications");
    expect(sql).toContain("for each row execute function private.enqueue_notification_deliveries()");
    expect(code(sql).match(/create trigger/gi)).toHaveLength(1);
  });
});

describe("notification constraint validation migration invariants", () => {
  const sql = migration("notification_constraint_validation");

  // A validation step that lives only in a runbook comment is a validation step
  // that eventually does not happen, and leaves convalidated=false forever.
  it("validates both deferred constraints as executable statements", () => {
    expect(sql).toContain("validate constraint member_notifications_kind_check");
    expect(sql).toContain("validate constraint member_profiles_notification_prefs_boolean");
    expect(sql).not.toMatch(/^--\s*alter table public\.member_profiles$/m);
  });

  // This assertion used to require "set local lock_timeout" — the exact spelling
  // that guarantees the wait is NOT bounded. The CLI applies each migration file
  // outside an explicit transaction, so SET LOCAL has no transaction to be local
  // to: Postgres raises WARNING 25P01 and discards the setting. The test passed
  // for as long as the guard was broken and would have failed the moment it was
  // fixed, so it was not protecting this behaviour, it was pinning its absence.
  // Session-scoped SET is what actually bounds the wait here.
  it("bounds its lock wait rather than queueing in front of application traffic", () => {
    expect(sql).toMatch(/^\s*set\s+lock_timeout\s*=\s*'5s'\s*;/m);
    expect(sql).not.toMatch(/\bset\s+local\s+lock_timeout\b/);
  });

  it("refuses to finish with a constraint still NOT VALID", () => {
    expect(sql).toMatch(/raise exception[^;]*NOT VALID/);
  });
});

describe("notification kind + delivery queue migration invariants", () => {
  const sql = migration("notification_kind_and_deliveries");
  // Three pins below read the enqueue trigger's own text rather than the whole
  // migration, so that a match cannot come from one of the sibling statements.
  const enqueue = fnBody(sql, "private.enqueue_notification_deliveries");

  it("keeps the deliveries table reachable only through the RPCs", () => {
    expect(sql).toContain("alter table public.member_notification_deliveries enable row level security");
    expect(sql).not.toMatch(/create policy[^;]*member_notification_deliveries/i);
    expect(sql).toContain("revoke all on public.member_notification_deliveries from anon, authenticated");
    expect(sql).toContain("revoke all on public.member_notification_deliveries from service_role");
    expect(sql).toContain("grant select on public.member_notification_deliveries to service_role");
    expect(sql).not.toMatch(/grant[^;]*insert[^;]*on public\.member_notification_deliveries to service_role/);
  });

  it("cannot enqueue the same notification twice on one channel", () => {
    expect(sql).toContain("unique (notification_id, channel)");
  });

  it("constrains channel and status to the closed dispatch state machine", () => {
    expect(sql).toContain("check (channel in ('email', 'push', 'sms'))");
    expect(sql).toContain("check (status in ('pending', 'sending', 'sent', 'failed', 'skipped'))");
  });

  // The defect this pins: `(prefs ->> new.kind)::boolean` on a member-writable
  // JSON value raises 22P02 for {"cases": []} and took the enclosing approval
  // down with it.
  it("never casts a member-written preference value", () => {
    expect(enqueue).not.toContain("::boolean");
    expect(enqueue).not.toMatch(/prefs\s*->>/);
    expect(enqueue).toContain("pref_value := prefs -> new.kind");
    expect(enqueue).toContain("if pref_value = 'false'::jsonb then");
  });

  it("cannot fail the transaction that produced the notification", () => {
    expect(sql).toContain("when others then");
    expect(sql).toContain("raise warning 'enqueue_notification_deliveries failed");
    // `when others` is documented NOT to match query_canceled, so a
    // statement_timeout while this trigger waited on a lock would otherwise
    // propagate and roll back the steward's form approval.
    expect(sql).toContain("when query_canceled then");
  });

  it("serializes the recipient rate window so concurrent inserts cannot both pass", () => {
    const lockAt = enqueue.indexOf("pg_advisory_xact_lock");
    const countAt = enqueue.indexOf("into recent_hour");
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(countAt);
  });

  // Charging the org allowance for suppressed attempts turns a per-recipient
  // cap into an org-wide denial of service: one rate-limited account could burn
  // everyone else's quota with rejected work.
  it("charges the org allowance only for accepted work", () => {
    const suppressReturnAt = enqueue.indexOf("if limit_reason is not null then");
    const incrementAt = enqueue.indexOf("insert into private.notification_outbound_counters");
    expect(suppressReturnAt).toBeGreaterThan(-1);
    expect(incrementAt).toBeGreaterThan(suppressReturnAt);
  });

  it("shards the org counter so unrelated business transactions do not serialize", () => {
    expect(sql).toContain("primary key (day, shard)");
    expect(sql).toContain("pg_catalog.pg_backend_pid() % 16");
  });

  it("short-circuits non-outbound kinds before reading anything", () => {
    const body = sql.slice(sql.indexOf("create or replace function private.enqueue_notification_deliveries"));
    const guardAt = body.indexOf("if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events') then");
    const prefsAt = body.indexOf("notification_prefs");
    const controlsAt = body.indexOf("outbound_enabled");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(prefsAt);
    expect(guardAt).toBeLessThan(controlsAt);
  });

  it("starts inert so applying the migration queues nothing", () => {
    expect(sql).toContain("outbound_enabled boolean not null default false");
    expect(sql).toContain("if not coalesce(outbound_on, false) then");
  });

  it("rate limits per recipient and org-wide, and leaves a visible trace", () => {
    expect(sql).toContain("max_per_recipient_hour constant integer := 12");
    expect(sql).toContain("max_per_recipient_day constant integer := 50");
    expect(sql).toContain("max_org_day constant integer := 20000");
    expect(sql).toContain("'skipped', limit_reason");
  });

  it("is the only thing that enqueues, across every migration in the repo", () => {
    const triggers = migrationFiles().flatMap(({ name, sql: body }) =>
      [...body.matchAll(/create trigger (\w+)[\s\S]{0,120}?insert on public\.member_notifications/g)]
        .map((match) => `${name}:${match[1]}`));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toContain("member_notifications_enqueue_deliveries");
  });

  it("gives every notification insert site an explicit kind", () => {
    const inserts = sql.match(/insert into public\.member_notifications \(([^)]*)\)/g) || [];
    expect(inserts).toHaveLength(12);
    for (const insert of inserts) expect(insert).toContain("kind");
  });

  it("keeps the fictional signup seed rows in-app only", () => {
    expect(sql.match(/'general', now\(\) - interval/g)).toHaveLength(3);
  });

  // Form approvals are not case movement: seven templates exist and only two
  // can ever become a case.
  it("files form-flow notifications under forms and reserves cases for real cases", () => {
    expect(sql.match(/, 'forms'\)/g)).toHaveLength(7);
    expect(sql.match(/, 'forms'\n/g)).toHaveLength(2);
    expect(sql.match(/, 'cases'\)/g)).toHaveLength(2);
    expect(sql).toContain("Grievance case opened");
  });

  // Order matters and is the reverse of the obvious one: the constraint has to
  // exist BEFORE the cleanup, or a member writing a non-boolean between the
  // UPDATE scanning their row and the constraint committing is grandfathered
  // forever by a constraint that never re-examines existing rows.
  it("constrains preference values to booleans and only then normalizes them", () => {
    expect(sql).toContain("create or replace function private.notification_prefs_are_boolean");
    expect(sql).toContain("member_profiles_notification_prefs_boolean");
    expect(sql).toContain("not valid");
    const constraintAt = sql.indexOf("add constraint member_profiles_notification_prefs_boolean");
    const normalizeAt = sql.indexOf("update public.member_profiles p");
    expect(constraintAt).toBeGreaterThan(-1);
    expect(normalizeAt).toBeGreaterThan(-1);
    expect(constraintAt).toBeLessThan(normalizeAt);
  });

  it("reloads the PostgREST schema cache after the DDL", () => {
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  // Every migration that adds or changes something PostgREST exposes has to
  // end with the reload, not just the big one. Missing it on the LAST such
  // file is the case that bites: the schema is correct but the RPC 404s with
  // PGRST202 until something else happens to reload the cache.
  it.each([
    "member_push_subscriptions",
    "notification_kind_column",
    "notification_kind_and_deliveries",
    "notification_enqueue_trigger",
    "notification_delivery_rpcs",
    "notification_dispatch_cron",
  ])("%s ends with a PostgREST schema reload", (fragment) => {
    expect(migration(fragment).trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe("delivery claim/record RPC migration invariants", () => {
  const sql = migration("notification_delivery_rpcs");

  it("claims with FOR UPDATE SKIP LOCKED inside the statement that flips the rows", () => {
    expect(sql).toContain("for update skip locked");
    // The lock must be in the CTE the UPDATE actually consumes, not parked in
    // an unused one.
    const candidates = sql.slice(sql.indexOf("with candidates as"), sql.indexOf("flipped as"));
    expect(candidates).toContain("for update skip locked");
    expect(sql).toContain("from candidates c\n      where d.id = c.id");
  });

  it("increments the attempt exactly once, at claim time", () => {
    expect(sql.match(/attempts = d\.attempts \+ 1/g)).toHaveLength(1);
  });

  it("bounds reclaim by both age and attempt budget", () => {
    expect(sql).toContain("d.attempts < 6");
    expect(sql).toContain("d.created_at >= pg_catalog.now() - interval '48 hours'");
    expect(sql).toContain("d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'");
  });

  it("gates every claim on the database-side outbound switch", () => {
    expect(sql).toContain("select c.outbound_enabled into outbound_on");
    expect(sql).toContain("return '[]'::jsonb");
  });

  it("caps the per-delivery subscription fan-out", () => {
    expect(sql).toContain("max_subscriptions constant integer := 10");
    expect(sql).toContain("limit max_subscriptions");
  });

  it("never hands the dispatcher the notification's own text", () => {
    const claim = sql.slice(sql.indexOf("create or replace function public.claim_notification_deliveries"));
    expect(claim).not.toMatch(/'title'|n\.title|'body'|n\.body/);
  });

  // The defect this pins: matching on the delivery id alone let a late 'failed'
  // reopen a row already recorded 'sent', which then sent again.
  it("accepts a result only against the live lease", () => {
    expect(sql.match(/where d\.id = v_id and d\.status = 'sending' and d\.attempts = v_attempt/g)).toHaveLength(3);
  });

  it("caps the backoff exponent so a reclaim loop cannot overflow int4", () => {
    expect(sql).toContain("least(60, pg_catalog.power(2, least(d.attempts, 10))::integer) * interval '1 minute'");
    expect(sql).toContain("case when d.attempts >= 6 then 'failed' else 'pending' end");
  });

  it("never pg_catalog-qualifies the grammar constructs", () => {
    expect(sql).not.toMatch(/pg_catalog\.(least|greatest|coalesce|nullif)\b/);
  });

  it("sweeps expiry independently of any claim", () => {
    expect(sql).toContain("create or replace function public.expire_notification_deliveries");
    expect(sql).toContain("'expired before dispatch'");
    expect(sql).toContain("attempts >= 6");
    expect(sql).toContain("'kind is not outbound-eligible'");
  });

  it("grants all three RPCs to service_role only", () => {
    expect(sql.match(/revoke all on function [^;]* from public, anon, authenticated/g)).toHaveLength(3);
    expect(sql.match(/grant execute on function [^;]* to service_role/g)).toHaveLength(3);
    expect(sql).not.toMatch(/grant execute on function [^;]* to (authenticated|anon)/i);
  });

  it("reloads the PostgREST schema cache after creating the RPCs", () => {
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe("realtime + cron migration invariants", () => {
  const realtime = migration("member_notifications_realtime");
  const cron = migration("notification_dispatch_cron");

  it("adds member_notifications to supabase_realtime behind existence guards", () => {
    expect(realtime).toContain("pg_publication where pubname = 'supabase_realtime'");
    expect(realtime).toContain("pg_publication_tables");
    expect(realtime).toContain("alter publication supabase_realtime add table public.member_notifications");
  });

  // Realtime cannot apply a row policy to a delete payload, so publishing
  // DELETE would broadcast other members' notification ids.
  it("narrows the publication to INSERT before adding the table, and refuses otherwise", () => {
    expect(realtime).toContain("set (publish = ''insert'')");
    // A raise notice is not a control: it scrolls past in a log and the schema
    // still ships with DELETE publishing cross-member notification ids.
    expect(code(realtime)).toMatch(/if other_tables > 0 then\s*\n\s*raise exception/);
    expect(code(realtime)).not.toContain("raise notice");
    // Narrow first, then add — discovering afterwards that the flags cannot be
    // narrowed would already have exposed the table.
    const narrowAt = realtime.indexOf("set (publish = ''insert'')");
    const addAt = realtime.indexOf("add table public.member_notifications");
    expect(narrowAt).toBeLessThan(addAt);
  });

  it("refuses to commit a publication that can still emit a DELETE for this table", () => {
    expect(realtime).toMatch(/pubdelete or pubupdate or pubtruncate/);
  });

  it("schedules the tick only where pg_cron/pg_net exist, authed from the vault secret", () => {
    expect(cron).toContain("pg_available_extensions where name = 'pg_cron'");
    expect(cron).toContain("pg_available_extensions where name = 'pg_net'");
    expect(cron).toContain("'notifications-dispatch-tick'");
    expect(cron).toContain("'*/5 * * * *'");
    expect(cron).toContain("vault.decrypted_secrets");
    expect(cron).toContain("'notifications-dispatch-secret'");
  });

  // Hard-coding the production URL means applying this file to any other
  // project immediately points a 5-minute cron at production.
  it("reads the endpoint from configuration rather than hard-coding production", () => {
    // No literal dispatch endpoint on any host, production or otherwise.
    expect(cron).not.toMatch(/https?:\/\/[^\s'"]*\/api\/notifications-dispatch/);
    expect(cron).toContain("url := c.dispatch_url");
    expect(cron).toContain("c.dispatch_url is not null");
  });

  it("records the async request id so a silently 401ing tick is discoverable", () => {
    expect(cron).toContain("insert into private.notification_dispatch_ticks (request_id)");
    expect(cron).toContain("create or replace function public.get_notification_dispatch_health");
    expect(cron).toContain("net._http_response");
  });

  it("runs the expiry sweep on its own schedule", () => {
    expect(cron).toContain("'notifications-expiry-sweep'");
    expect(cron).toContain("select public.expire_notification_deliveries();");
  });

  it("points the pg_cron tick and the vercel cron backstop at the same handler", () => {
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    const paths = (vercel.crons || []).map((entry) => entry.path);
    expect(paths).toContain("/api/notifications-dispatch");
    expect(paths.filter((path) => path.includes("notifications-dispatch"))).toEqual([
      "/api/notifications-dispatch",
    ]);
    expect(vercel.functions?.["api/notifications-dispatch.js"]?.maxDuration).toBeGreaterThanOrEqual(60);
  });

  it("documents a server-only SAMPLE dispatch bearer without adding a client-prefixed copy", () => {
    const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(envExample).toContain("SAMPLE_NOTIFICATION_DISPATCH_SECRET=");
    expect(envExample).toContain("SAMPLE_NOTIFY_KILL_SWITCH=0");
    expect(envExample).not.toMatch(/^(?:VITE_|EXPO_PUBLIC_)SAMPLE_NOTIFICATION_DISPATCH_SECRET=/m);
  });
});

describe("cross-migration safety", () => {
  it("has no policy that neutralizes its own row check", () => {
    for (const { name, sql } of migrationFiles()) {
      expect(sql, name).not.toMatch(/using\s*\([^)]*\bor\s+true\b/i);
      expect(sql, name).not.toMatch(/with check\s*\([^)]*\bor\s+true\b/i);
    }
  });

  it("never grants execute to PUBLIC", () => {
    for (const { name, sql } of migrationFiles()) {
      expect(sql, name).not.toMatch(/grant execute on function [^;]* to public\b/i);
    }
  });
});
