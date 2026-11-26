// @vitest-environment node
//
// Restore-review hotfixes (supabase/migrations/20261002135600_restore_review_hotfixes.sql).
// Offline half: the migration's shape. Live half (owned disposable database,
// one rolled-back transaction, a savepoint per case): one proof per fix.
//   H1 SEC-UG-COMPASS-ORG-POLICY-ENFORCEMENT-20261002
//   H2 SEC-UG-INTEGRATION-OFF-NOT-ENFORCED-20261002
//   H3 SEC-UG-ENGAGEMENT-EMAIL-REVOKED-RECIPIENT-20261002
//   H4 BUG-UG-IDEMPOTENCY-KEY-REPLAY-20261002
//   H5 BUG-UG-SWEEP-TENANT-STARVATION-20261002
//   H6 SEC-UG-EXPORT-CASE-TENANCY-20261002
//   H7 BUG-UG-HOME-TAKEOVER-ORG-SCOPE-20261002
//   H8 BUG-UG-STEWARD-DEADLINE-SWEEP-UNBOUNDED-20261002
//   H10 SEC-UG-PASSWORD-GRANT-THROTTLE-BYPASS-20261002
//   H11 REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";

const MIGRATION = "supabase/migrations/20261002135600_restore_review_hotfixes.sql";
const sql = readFileSync(MIGRATION, "utf8");
const MESH = "union-ground-mesh";
const MODEL = "union-ground/compass-mesh:v1";
const REFUSED = { decision: "reject", message: "Invalid login credentials", should_logout_user: false };

describe("restore-review hotfix migration (offline)", () => {
  it("is one atomic migration whose writers take the case-graph gate first", () => {
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const name of [
      "public.reserve_compass_ai_request", "private.compass_ai_dispatch_gate",
      "public.complete_engagement_delivery", "public.staff_update_member_onboarding_plan",
      "public.save_site_guide", "private.run_survey_operations_sweep",
      "private.run_due_live_poll_transitions", "public.request_filtered_organization_export",
      // Installed with the 20260907151000 case-graph wrapper; a re-declaration keeps it.
      "public.authenticate_integration_api_key", "public.claim_integration_webhook_deliveries",
      "public.claim_integration_webhook_delivery", "private.suppress_disabled_integration_webhook_deliveries",
    ]) {
      expect(helperFirst(functions.find((fn) => fn.name === name).source), name).toBe(true);
    }
  });

  it("claims idempotency keys before mutating and never drops an audit row on conflict", () => {
    const functions = parseFunctions(sql);
    for (const [name, operation, mutation] of [
      ["public.staff_update_member_onboarding_plan", "'staff_update_member_onboarding_plan'", "update public.member_onboarding_plans"],
      ["public.save_site_guide", "'save_site_guide'", "delete from private.organization_site_guide_copy"],
    ]) {
      const source = functions.find((fn) => fn.name === name).source;
      const claim = source.indexOf(`private.member_operations_replay(org, ${operation}`);
      expect(claim, name).toBeGreaterThan(-1);
      expect(claim, name).toBeLessThan(source.indexOf(mutation));
      expect(source, name).not.toContain("on conflict (idempotency_key) do nothing");
      expect(source, name).not.toContain("member_support_record_event(p_idempotency_key");
    }
  });

  it("places a Home takeover message by its conversation's recorded organization, not by the sender's current roles", () => {
    const functions = parseFunctions(sql);
    const takeover = functions.find((fn) => fn.name === "public.get_member_home_takeover").source;
    expect(takeover).toContain("and c.organization_id = org");
    expect(sql).not.toContain("steward_message_in_organization");
    expect(sql).toContain("add column organization_id uuid\n    references public.organizations(id) on update cascade on delete restrict;");
    const stamp = functions.find((fn) => fn.name === "private.stamp_member_conversation_organization").source;
    expect(stamp).toContain("new.organization_id := private.current_member_organization();");
    expect(stamp).toContain("new.organization_id := old.organization_id;");
    expect(sql).toMatch(/create trigger b10_member_conversations_organization\nbefore insert or update of organization_id on public\.member_conversations/);
    expect(sql).toContain("having pg_catalog.count(distinct so.organization_id) = 1");
  });

  it("enables the password hook for local Auth", () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    expect(config).toMatch(/\[auth\.hook\.password_verification_attempt\]\nenabled = true\nuri = "pg-functions:\/\/postgres\/public\/auth_password_verification_attempt_hook"/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("restore-review hotfixes on a disposable database", () => {
  let db;
  const W = {};
  const q = (text, values = []) => db.query(text, values);

  async function call(text, values = [], user = null) {
    await q("savepoint hotfix_call");
    try {
      const claims = user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "service_role" };
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await q(`set local role ${user ? "authenticated" : "service_role"}`);
      const rows = (await q(text, values)).rows;
      await q("reset role");
      await q("select set_config('request.jwt.claims', '', true)");
      await q("release savepoint hotfix_call");
      return { ok: true, rows };
    } catch (error) {
      await q("rollback to savepoint hotfix_call");
      await q("release savepoint hotfix_call");
      await q("reset role");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const one = async (text, values, user) => {
    const result = await call(text, values, user);
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
    return result.rows[0];
  };
  const setting = (orgId, key, value) => q(
    `insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,$2,$3::jsonb)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [orgId, key, JSON.stringify(value)],
  );

  async function person(label, { org = null, chapter = null, memberships = [], roles = [], chapterRoles = [] } = {}) {
    const user = { id: randomUUID(), session: randomUUID(), label };
    await q("insert into auth.users(id,email) values ($1,$2)", [user.id, `hotfix-${label}-${user.id}@example.invalid`]);
    for (const organizationId of [org, ...memberships].filter(Boolean)) {
      await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organizationId, user.id]);
    }
    if (chapter) {
      await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapter]);
      await q("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [user.id, chapter, `Hotfix ${label}`]);
    }
    for (const role of roles) {
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, user.id, role]);
    }
    for (const role of chapterRoles) {
      await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapter]);
    }
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "restore-review-hotfixes-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    await q("set local lock_timeout = '15s'");
    // Only this proof's rows are due or claimable inside the transaction.
    await q("update public.engagement_delivery_outbox set available_at = now() + interval '1 day' where state in ('queued','failed','leased')");
    await q("update public.member_cases set status = 'resolved' where status = 'active' and (deadline is not null or exists (select 1 from public.casework_deadlines d where d.case_id = member_cases.id))");
    await q("update public.organization_surveys set operations_swept_at = now() + interval '1 day'");
    await q("update public.integration_webhook_deliveries set status = 'dead' where status in ('queued','failed','sending')");
    const bootstrap = randomUUID();
    await q("insert into auth.users(id,email) values ($1,$2)", [bootstrap, `hotfix-bootstrap-${bootstrap}@example.invalid`]);
    for (const key of ["orgA", "orgB"]) {
      W[key] = randomUUID();
      await q("insert into public.organizations(id,slug,name,created_by) values ($1,$2,$2,$3)", [W[key], `hotfix-${key.toLowerCase()}-${W[key].slice(0, 8)}`, bootstrap]);
    }
    W.chA = `hotfix-a-${W.orgA.slice(0, 8)}`;
    W.chA2 = `hotfix-a2-${W.orgA.slice(0, 8)}`;
    W.chB = `hotfix-b-${W.orgB.slice(0, 8)}`;
    for (const [chapter, org, order] of [[W.chA, W.orgA, 95011], [W.chA2, W.orgA, 95012], [W.chB, W.orgB, 95013]]) {
      await q("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,$3)", [chapter, org, order]);
    }
    W.adminA = await person("admin-a", { org: W.orgA, chapter: W.chA, roles: ["admin"], chapterRoles: ["admin"] });
    W.chapterlessAdminA = await person("chapterless-admin-a", { org: W.orgA, roles: ["admin"] });
    W.vpA = await person("vp-a", { org: W.orgA, chapter: W.chA2, roles: ["vp"] });
    W.stewardA = await person("steward-a", { org: W.orgA, chapter: W.chA, roles: ["steward"], chapterRoles: ["steward"] });
    W.memberA = await person("member-a", { org: W.orgA, chapter: W.chA });
    W.memberA2 = await person("member-a2", { org: W.orgA, chapter: W.chA2 });
    W.adminB = await person("admin-b", { org: W.orgB, chapter: W.chB, roles: ["admin"], chapterRoles: ["admin"] });
    W.stewardB = await person("steward-b", { org: W.orgB, chapter: W.chB, roles: ["steward"], chapterRoles: ["steward"] });
    W.ambiguous = await person("ambiguous", { memberships: [W.orgA, W.orgB] });
    // Belongs to both organizations; Home selects organization B.
    W.twoOrg = await person("two-org", { org: W.orgB, chapter: W.chB, memberships: [W.orgA] });
    for (const org of [W.orgA, W.orgB]) {
      await q("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values (true,$1,true) on conflict do nothing", [org]);
    }
  }, 120_000);

  beforeEach(async () => { await q("savepoint hotfix_case"); });
  afterEach(async () => { await q("rollback to savepoint hotfix_case"); });
  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  // -------------------------------------------------------------------------
  // H1 Compass organization policy
  // -------------------------------------------------------------------------

  async function compassOn() {
    await call("select public.set_compass_platform_operator($1,true,'Disposable hotfix proof')", [W.adminA.id]);
    await q("update public.compass_ai_policy set enabled = true, gateway = $1, model = $2 where id", [MESH, MODEL]);
    await q(`insert into public.compass_ai_provider_attestations(status,gateway,model,zero_data_retention,disallow_prompt_training,evidence_ref,expires_at,attested_by)
             values ('verified',$1,$2,true,true,$3,now() + interval '1 day',$4)`, [MESH, MODEL, `sha256:${"c".repeat(64)}`, W.adminA.id]);
    await q("delete from public.member_ai_requests");
  }
  const reserve = async (user) => (await one("select public.reserve_compass_ai_request($1,$2,$3,true,true) r", [user.id, MESH, MODEL])).r;
  const gate = async (reservation, user, rpc) => (await one(`select public.${rpc}($1,$2,$3,$4,true,true) r`, [reservation, user.id, MESH, MODEL])).r;

  it("H1 keeps chapterless staff under their organization's Compass switch and refuses an ambiguous context", async () => {
    await compassOn();
    const granted = await reserve(W.chapterlessAdminA);
    expect(granted).toMatchObject({ id: expect.any(String), cause: null, role: "admin", organization_id: W.orgA });
    // The context envelope reports the same organization the reservation used.
    expect((await one("select private.compass_context_organization() org", [], W.chapterlessAdminA)).org).toBe(W.orgA);
    await setting(W.orgA, "features.ai_assistant.enabled", false);
    expect(await reserve(W.chapterlessAdminA)).toEqual({ id: null, cause: "disabled" });
    expect(await reserve(W.ambiguous)).toEqual({ id: null, cause: "organization" });
    expect(await call("select private.compass_context_organization()", [], W.ambiguous)).toMatchObject({ ok: false, code: "42501" });
  });

  it("H1 re-checks the organization switch and cap in every dispatch phase; a pause never fails over", async () => {
    await compassOn();
    const first = (await reserve(W.adminA)).id;
    expect(await gate(first, W.adminA, "authorize_compass_ai_dispatch")).toMatchObject({ authorized: true, organization_id: W.orgA });
    await setting(W.orgA, "features.ai_assistant.enabled", false);
    expect((await one("select public.authorize_compass_ai_failover($1,$2,'transport') r", [first, W.adminA.id])).r)
      .toEqual({ authorized: false, cause: "disabled" });
    await setting(W.orgA, "features.ai_assistant.enabled", true);
    const second = (await reserve(W.adminA)).id;
    await setting(W.orgA, "features.ai_assistant.enabled", false);
    expect(await gate(second, W.adminA, "authorize_compass_ai_embedding")).toEqual({ authorized: false, cause: "disabled" });
    expect(await gate(second, W.adminA, "authorize_compass_ai_dispatch")).toEqual({ authorized: false, cause: "disabled" });
    await setting(W.orgA, "features.ai_assistant.enabled", true);
    const third = (await reserve(W.adminA)).id;
    await setting(W.orgA, "limits.ai_assistant.hourly_admin", 0);
    expect(await gate(third, W.adminA, "authorize_compass_ai_dispatch")).toEqual({ authorized: false, cause: "disabled" });
  });

  it("H1 applies the reward bonus before the organization cap, and a cap of 0 is a hard stop", async () => {
    await compassOn();
    // The reward effect itself is proven elsewhere; pin its answer to +10 here.
    await q("create or replace function private.compass_ai_reward_quota_bonus(p_user_id uuid) returns integer language sql stable security definer set search_path = '' as $$ select 10 $$");
    const platform = (await q("select hourly_limit from public.compass_ai_role_limits where role = 'admin'")).rows[0].hourly_limit;
    expect((await reserve(W.adminA)).limit).toBe(Math.min(200, platform + 10));
    await setting(W.orgA, "limits.ai_assistant.hourly_admin", 3);
    expect((await reserve(W.adminA)).limit).toBe(3);
    await setting(W.orgA, "limits.ai_assistant.hourly_admin", 0);
    expect(await reserve(W.adminA)).toEqual({ id: null, cause: "disabled" });
  });

  // -------------------------------------------------------------------------
  // H2 Integration off
  // -------------------------------------------------------------------------

  it("H2 refuses a stored API key while the customer API is off and accepts it again after reactivation", async () => {
    const hash = "a".repeat(63) + "1";
    await q("insert into public.organization_integrations(organization_id,provider,status) values ($1,'customer_api','configured')", [W.orgA]);
    await q("insert into public.integration_api_keys(organization_id,name,key_hash,key_prefix) values ($1,'Proof key',$2,'ugk_proof')", [W.orgA, hash]);
    const authenticate = async () => (await one("select public.authenticate_integration_api_key($1) r", [hash])).r;
    expect(await authenticate()).toMatchObject({ organizationId: W.orgA });
    expect(await call("select public.set_organization_integration_status('customer_api','disabled')", [], W.adminA)).toMatchObject({ ok: true });
    expect(await authenticate()).toBeNull();
    // Credentials stay stored for a deliberate reactivation.
    expect((await q("select count(*)::int n from public.integration_api_keys where key_hash = $1 and revoked_at is null", [hash])).rows[0].n).toBe(1);
    await q("update public.organization_integrations set status = 'configured' where organization_id = $1 and provider = 'customer_api'", [W.orgA]);
    expect(await authenticate()).toMatchObject({ organizationId: W.orgA });
  });

  it("H2 suppresses queued webhook deliveries of a turned-off integration instead of sending them", async () => {
    const secret = (await q("select vault.create_secret($1, $2, 'hotfix proof') id", ["s".repeat(40), `hotfix-webhook-${randomUUID()}`])).rows[0].id;
    await q("insert into public.organization_integrations(organization_id,provider,status) values ($1,'customer_webhooks','configured')", [W.orgA]);
    const webhook = (await q(`insert into public.integration_webhooks(organization_id,url,events,secret_hash,secret_ref)
      values ($1,'https://hooks.example.invalid/in',array['case.updated'],$2,$3) returning id`, [W.orgA, "b".repeat(64), secret])).rows[0].id;
    const delivery = async (key) => {
      const id = (await q(`insert into public.integration_webhook_deliveries(organization_id,webhook_id,event_name,event_id,idempotency_key,status,attempt_count,destination_host)
        values ($1,$2,'case.updated',$3,$3,'queued',0,'hooks.example.invalid') returning id`, [W.orgA, webhook, key])).rows[0].id;
      await q("insert into public.integration_jobs(organization_id,provider,job_kind,status,idempotency_key) values ($1,'customer_webhooks','webhook_deliver','queued',$2)", [W.orgA, `delivery:${id}`]);
      return id;
    };
    const queued = await delivery("proof:1");
    const single = await delivery("proof:2");
    expect(await call("select public.set_organization_integration_status('customer_webhooks','disabled')", [], W.adminA)).toMatchObject({ ok: true });
    expect((await one("select public.claim_integration_webhook_deliveries(10) r", [])).r).toEqual([]);
    expect((await one("select public.claim_integration_webhook_delivery($1) r", [single])).r).toBeNull();
    const rows = (await q("select id, status, error_code from public.integration_webhook_deliveries where id = any($1::uuid[]) order by id", [[queued, single]])).rows;
    expect(rows.map(({ status, error_code: code }) => [status, code])).toEqual([["skipped", "integration_disabled"], ["skipped", "integration_disabled"]]);
    expect((await q("select distinct status from public.integration_jobs where idempotency_key = any($1::text[])", [[`delivery:${queued}`, `delivery:${single}`]])).rows).toEqual([{ status: "skipped" }]);
    expect((await q("select secret_ref from public.integration_webhooks where id = $1", [webhook])).rows[0].secret_ref).toBe(secret);
    // Back on: new work is claimed again; the suppressed rows stay suppressed.
    await q("update public.organization_integrations set status = 'configured' where organization_id = $1 and provider = 'customer_webhooks'", [W.orgA]);
    const fresh = await delivery("proof:3");
    const claimed = (await one("select public.claim_integration_webhook_deliveries(10) r", [])).r;
    expect(claimed.map((row) => row.deliveryId)).toEqual([fresh]);
  });

  // -------------------------------------------------------------------------
  // H3 Engagement email recipient re-check
  // -------------------------------------------------------------------------

  it("H3 suppresses a queued broadcast or survey email terminally once the recipient lost access", async () => {
    const chapterOnly = `hotfix-broadcast-${randomUUID().slice(0, 8)}`;
    await q(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,created_by,locale,organization_id,chapter_id,audience_scope)
             values ($1,'Chapter','Chapter meeting','Chapter A meets tonight.',now(),995001,$2,'en',$3,$4,'chapter')`, [chapterOnly, W.adminA.id, W.orgA, W.chA]);
    const everyone = `hotfix-broadcast-${randomUUID().slice(0, 8)}`;
    await q(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,created_by,locale,organization_id,chapter_id,audience_scope)
             values ($1,'Chapter','Contract vote','Vote by Friday.',now(),995002,$2,'en',$3,$4,'organization')`, [everyone, W.adminA.id, W.orgA, W.chA]);
    const survey = randomUUID();
    await q("insert into public.organization_surveys(id,organization_id,title,status,created_by,owner_user_id,chapter_id) values ($1,$2,'Chapter A check-in','open',$3,$3,$4)", [survey, W.orgA, W.adminA.id, W.chA]);
    expect(await call("select public.prepare_organization_survey_distribution($1)", [survey], W.adminA)).toMatchObject({ ok: true });

    // memberA leaves chapter A (still in the organization); stewardA's membership is revoked.
    await q("update public.member_chapter_memberships set status = 'revoked', revoked_at = now() where user_id = $1 and chapter_id = $2", [W.memberA.id, W.chA]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [W.memberA.id, W.chA2]);
    await q("update public.member_profiles set chapter_id = $2 where id = $1", [W.memberA.id, W.chA2]);
    await q("update public.organization_memberships set status = 'revoked', revoked_at = now() where user_id = $1 and organization_id = $2", [W.stewardA.id, W.orgA]);

    const lease = randomUUID();
    const claimed = (await q("select public.claim_engagement_delivery_batch($1, 100, 300) rows", [lease])).rows[0].rows;
    const payload = async (row) => (await q("select public.get_engagement_delivery_payload($1,$2) p", [row.id, lease])).rows[0].p;
    const rowFor = async (source, user, kind) => (await q(
      "select id from public.engagement_delivery_outbox where source_id = $1 and recipient_user_id = $2 and delivery_kind = $3",
      [source, user.id, kind],
    )).rows[0];

    const leftChapter = await rowFor(chapterOnly, W.memberA, "broadcast");
    const revoked = await rowFor(everyone, W.stewardA, "broadcast");
    const leftSurvey = await rowFor(survey, W.memberA, "survey_invitation");
    const stillIn = await rowFor(everyone, W.memberA, "broadcast");
    for (const row of [leftChapter, revoked, leftSurvey, stillIn]) expect(claimed.some((entry) => entry.id === row.id)).toBe(true);

    for (const row of [leftChapter, revoked, leftSurvey]) {
      expect(await payload(row)).toEqual({ available: false, suppressed: true, reason: "recipient_access_revoked" });
    }
    expect(await payload(stillIn)).toMatchObject({ available: true, subject: "Contract vote" });
    // The new route names the reason; an older route's opt-out code is believed too.
    expect((await q("select public.complete_engagement_delivery($1,$2,false,'recipient_access_revoked',300) r", [leftChapter.id, lease])).rows[0].r.state).toBe("suppressed");
    expect((await q("select public.complete_engagement_delivery($1,$2,false,'recipient_opted_out',300) r", [revoked.id, lease])).rows[0].r.state).toBe("suppressed");
    expect((await q("select public.complete_engagement_delivery($1,$2,false,'recipient_access_revoked',300) r", [leftSurvey.id, lease])).rows[0].r.state).toBe("suppressed");
    // An eligible recipient's claimed revocation is not believed: a retryable failure.
    expect((await q("select public.complete_engagement_delivery($1,$2,false,'recipient_access_revoked',300) r", [stillIn.id, lease])).rows[0].r.state).toBe("failed");
    expect((await q("select state from public.organization_survey_deliveries where survey_id = $1 and recipient_user_id = $2", [survey, W.memberA.id])).rows[0].state).toBe("suppressed");
    const again = (await q("select public.claim_engagement_delivery_batch($1, 100, 300) rows", [randomUUID()])).rows[0].rows;
    expect(again.some((row) => [leftChapter.id, revoked.id, leftSurvey.id].includes(row.id))).toBe(false);
  });

  // REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030 (20261030203001):
  // a survey past its close time takes no answers, so no reminder is queued
  // for it and an email already queued before the close is not sent.
  it("sends no survey email after the survey's close time, queued or manual", async () => {
    const survey = randomUUID();
    await q("insert into public.organization_surveys(id,organization_id,title,status,created_by,owner_user_id,chapter_id) values ($1,$2,'Closing check-in','open',$3,$3,$4)", [survey, W.orgA, W.adminA.id, W.chA]);
    expect(await call("select public.prepare_organization_survey_distribution($1)", [survey], W.adminA)).toMatchObject({ ok: true });
    expect(await call("select public.queue_organization_survey_reminders($1)", [survey], W.adminA)).toMatchObject({ ok: true });
    await q("update public.organization_surveys set closes_at = now() - interval '1 hour' where id = $1", [survey]);

    expect(await call("select public.queue_organization_survey_reminders($1)", [survey], W.adminA)).toMatchObject({ ok: false, code: "P0002" });
    const lease = randomUUID();
    await q("select public.claim_engagement_delivery_batch($1, 100, 300)", [lease]);
    const queued = (await q("select id, delivery_kind from public.engagement_delivery_outbox where source_id = $1 and recipient_user_id = $2 and lease_token = $3",
      [survey, W.memberA.id, lease])).rows;
    expect(queued.map((row) => row.delivery_kind).sort()).toEqual(["survey_invitation", "survey_reminder"]);
    for (const row of queued) {
      expect((await q("select public.get_engagement_delivery_payload($1,$2) p", [row.id, lease])).rows[0].p).toMatchObject({ available: false });
    }
  });

  // -------------------------------------------------------------------------
  // H4 Idempotency keys
  // -------------------------------------------------------------------------

  it("H4 binds an onboarding key to its first request: replay returns it, any other reuse is refused, every change is audited", async () => {
    const steps = [randomUUID(), randomUUID()];
    await q(`insert into public.organization_onboarding_steps (id, organization_id, title, position, active)
             select step_id, $1, 'Step ' || ordinality, ordinality::integer * 10, true from unnest($2::uuid[]) with ordinality step_id`, [W.orgA, steps]);
    const plan = (await q("insert into public.member_onboarding_plans(id,organization_id,member_user_id,assigned_by,status) values (gen_random_uuid(),$1,$2,$3,'not_started') returning id", [W.orgA, W.memberA.id, W.adminA.id])).rows[0].id;
    const otherPlan = (await q("insert into public.member_onboarding_plans(id,organization_id,member_user_id,assigned_by,status) values (gen_random_uuid(),$1,$2,$3,'not_started') returning id", [W.orgA, W.memberA2.id, W.adminA.id])).rows[0].id;
    const key = randomUUID();
    const change = (user, planId, action, step) => call("select public.staff_update_member_onboarding_plan($1,$2,$3,$4) r", [planId, action, step, key], user);
    const events = async () => (await q("select event_type from public.member_support_events where entity_id = any($1::uuid[]) order by occurred_at, event_type", [[plan, otherPlan]])).rows.map((row) => row.event_type);
    const first = await change(W.adminA, plan, "complete", steps[0]);
    expect(first).toMatchObject({ ok: true });
    const replay = await change(W.adminA, plan, "complete", steps[0]);
    expect(replay.rows[0].r).toEqual(first.rows[0].r);
    expect(await events()).toEqual(["step_completed"]);
    expect(await change(W.adminA, plan, "reset", null)).toMatchObject({ ok: false, code: "22023" });
    expect(await change(W.adminA, otherPlan, "reset", null)).toMatchObject({ ok: false, code: "22023" });
    expect((await q("select completed_step_ids from public.member_onboarding_plans where id = $1", [plan])).rows[0].completed_step_ids).toEqual([steps[0]]);
    // Another staff member's own use of the same key value is a distinct, audited change.
    expect(await change(W.chapterlessAdminA, plan, "reset", null)).toMatchObject({ ok: true });
    expect((await events()).sort()).toEqual(["progress_reset", "step_completed"]);
  });

  it("H4 binds a Site Guide key to organization, actor and copy before writing", async () => {
    const key = randomUUID();
    const save = (user, title) => call("select public.save_site_guide($1,null,null,null,null,$2) r", [title, key], user);
    const ledger = async (org) => (await q("select count(*)::int n from public.organization_audit_ledger where organization_id = $1 and event_type = 'site_guide_copy_changed'", [org])).rows[0].n;
    const first = await save(W.adminA, "Using Union Ground");
    expect(first).toMatchObject({ ok: true });
    expect((await save(W.adminA, "Using Union Ground")).rows[0].r).toEqual(first.rows[0].r);
    expect(await ledger(W.orgA)).toBe(1);
    expect(await save(W.adminA, "Rewritten without audit")).toMatchObject({ ok: false, code: "22023" });
    expect((await q("select title from private.organization_site_guide_copy where organization_id = $1", [W.orgA])).rows[0].title).toBe("Using Union Ground");
    // Organization B's admin reusing the value saves and audits in organization B.
    expect(await save(W.adminB, "Organization B guide")).toMatchObject({ ok: true });
    expect(await ledger(W.orgB)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // H5 Sweep fairness
  // -------------------------------------------------------------------------

  it("H5 rotates the survey sweep through every enabled survey and skips switched-off organizations before LIMIT", async () => {
    const survey = async (org, title) => (await q(
      "insert into public.organization_surveys(organization_id,title,status,created_by,owner_user_id) values ($1,$2,'open',$3,$3) returning id",
      [org, title, org === W.orgA ? W.adminA.id : W.adminB.id],
    )).rows[0].id;
    const off = await survey(W.orgB, "Switched-off survey");
    await setting(W.orgB, "features.engagement_voice.survey_follow_up_automation", false);
    const first = await survey(W.orgA, "First survey");
    const second = await survey(W.orgA, "Second survey");
    const swept = async () => Object.fromEntries((await q("select id, operations_swept_at is not null swept from public.organization_surveys where id = any($1::uuid[])", [[off, first, second]])).rows.map((row) => [row.id, row.swept]));
    await q("select private.run_survey_operations_sweep(1)");
    await q("select private.run_survey_operations_sweep(1)");
    expect(await swept()).toEqual({ [off]: false, [first]: true, [second]: true });
  });

  it("H5 keeps switched-off organizations' due polls out of the live-poll scheduler batch", async () => {
    const poll = async (org, opensAgo) => (await q(
      `insert into public.organization_live_polls(organization_id,title,state,eligibility,results_visibility,opens_at,closes_at,created_by)
       values ($1,'Scheduled vote','scheduled','organization','after_close',now() - $2::interval,now() + interval '1 hour',$3) returning id`,
      [org, opensAgo, org === W.orgA ? W.adminA.id : W.adminB.id],
    )).rows[0].id;
    await setting(W.orgB, "features.engagement_voice.live_poll_auto_open_close", false);
    const blocked = await poll(W.orgB, "2 hours");
    const enabled = await poll(W.orgA, "1 minute");
    expect((await q("select private.run_due_live_poll_transitions(1) r")).rows[0].r).toEqual({ opened: 1, closed: 0 });
    const states = (await q("select id, state from public.organization_live_polls where id = any($1::uuid[])", [[blocked, enabled]])).rows;
    expect(Object.fromEntries(states.map((row) => [row.id, row.state]))).toEqual({ [blocked]: "scheduled", [enabled]: "open" });
  });

  // -------------------------------------------------------------------------
  // H6 Export case tenancy
  // -------------------------------------------------------------------------

  it("H6 exports cases by the case's own organization and chapter, and restricted cases only to a reader", async () => {
    const caseFor = async (title, extra = {}) => (await q(
      `insert into public.member_cases(id,user_id,reference,title,case_type,step,status,organization_id,chapter_id,is_restricted,restriction_reason,restricted_at,restricted_by)
       values (gen_random_uuid(),$1,$2,$3,'other','Step 1','active',$4,$5,$6,$7,$8,$9) returning id`,
      [extra.owner || W.memberA.id, `HOTFIX-${randomUUID().slice(0, 8)}`, title, W.orgA, W.chA, Boolean(extra.restricted),
        extra.restricted ? "Sensitive" : null, extra.restricted ? new Date().toISOString() : null, extra.restricted ? W.adminA.id : null],
    )).rows[0].id;
    // A case opened in organization A whose owner's profile later moved to organization B.
    const mover = await person("mover", { org: W.orgA, chapter: W.chA, memberships: [W.orgB] });
    const retained = await caseFor("Retained case", { owner: mover.id });
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [mover.id, W.chB]);
    await q("update public.member_profiles set chapter_id = $2 where id = $1", [mover.id, W.chB]);
    const restricted = await caseFor("Restricted case", { restricted: true });
    const exported = async (user) => {
      const result = await call("select public.request_filtered_organization_export(array['cases'], 'json', null, null, null) r", [], user);
      expect(result, result.message).toMatchObject({ ok: true });
      return result.rows[0].r.rows.map((row) => row.values);
    };
    const fromB = await exported(W.adminB);
    expect(fromB.some((row) => row.caseId === retained)).toBe(false);
    const fromA = await exported(W.adminA);
    expect(fromA.find((row) => row.caseId === retained)).toMatchObject({ chapterId: W.chA });
    expect(fromA.some((row) => row.caseId === restricted)).toBe(true);
    // The casework rule lets an organization vp read restricted cases, so the
    // vp's export carries both; the filter is the casework predicate itself.
    const fromVp = await exported(W.vpA);
    expect(fromVp.some((row) => row.caseId === retained)).toBe(true);
    expect(fromVp.some((row) => row.caseId === restricted)).toBe(true);
    const readable = async (user, caseId) => (await one("select private.casework_staff_can_access($1) ok", [caseId], user)).ok;
    expect(await readable(W.vpA, restricted)).toBe(true);
    // Organization B's admin can read neither case and exports neither.
    expect(await readable(W.adminB, restricted)).toBe(false);
    expect(fromB.some((row) => row.caseId === restricted)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // H7 Home takeover organization scope
  // -------------------------------------------------------------------------

  // The member W.twoOrg belongs to both organizations; selecting a chapter
  // selects its organization.
  const selectOrganization = (chapter) => q("update public.member_profiles set chapter_id = $2 where id = $1", [W.twoOrg.id, chapter]);
  // private.stamp_message_action_identity sets sender_id from auth.uid(), so
  // the steward's claims are in place for the insert.
  const stewardMessage = async (conversationId, sender, body, minutes = 1) => {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: sender })]);
    await q(
      `insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body,created_at)
       values ($1,$2,'steward','Steward',$3,now() - $4::interval)`,
      [conversationId, W.twoOrg.id, body, `${minutes} minutes`],
    );
    await q("select set_config('request.jwt.claims', '', true)");
  };
  const takeover = async () => (await one("select public.get_member_home_takeover() t", [], W.twoOrg)).t;

  it("H7 stamps a conversation with the creating sender's selected organization, never a client value", async () => {
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [W.twoOrg.id, W.chA]);
    await selectOrganization(W.chA);
    const started = await one("select public.start_member_conversation('Opened while organization A is selected') r", [], W.twoOrg);
    const conversationId = started.r.conversationId;
    expect((await q("select organization_id from public.member_conversations where id = $1", [conversationId])).rows[0].organization_id).toBe(W.orgA);
    // A signed-in caller can neither choose nor move the organization.
    await call("update public.member_conversations set organization_id = $2 where id = $1", [conversationId, W.orgB], W.twoOrg);
    expect((await q("select organization_id from public.member_conversations where id = $1", [conversationId])).rows[0].organization_id).toBe(W.orgA);
    const inserted = await call("insert into public.member_conversations(user_id,title,initials,organization_id) values ($1,'Chapter steward','CS',$2) returning organization_id", [W.twoOrg.id, W.orgB], W.twoOrg);
    if (inserted.ok) expect(inserted.rows[0].organization_id).toBe(W.orgA);
    else expect(inserted.code).toBe("42501");
  });

  it("H7 shows a two-organization steward's message only in the organization it was sent in, and never an unattributed one", async () => {
    // A steward of both organizations: current role grants cannot place a
    // message, the conversation's recorded organization does.
    const stewardAB = await person("steward-ab", { org: W.orgA, chapter: W.chA, memberships: [W.orgB], roles: ["steward"], chapterRoles: ["steward"] });
    await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [W.orgB, stewardAB.id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [W.twoOrg.id, W.chA]);
    const sentInA = (await q(
      "insert into public.member_conversations(user_id,title,initials,steward_user_id,organization_id) values ($1,'Chapter steward','CS',$2,$3) returning id",
      [W.twoOrg.id, stewardAB.id, W.orgA],
    )).rows[0].id;
    await stewardMessage(sentInA, stewardAB.id, "Sent in organization A");
    const unattributed = (await q(
      "insert into public.member_conversations(user_id,title,initials,steward_user_id) values ($1,'Chapter steward','CS',$2) returning id",
      [W.twoOrg.id, stewardAB.id],
    )).rows[0].id;
    await stewardMessage(unattributed, stewardAB.id, "Organization unknown", 0);
    // Organization B selected: the A message is not B's takeover.
    await selectOrganization(W.chB);
    expect((await takeover()).message).toBeNull();
    // Organization A selected: it is A's takeover; the unattributed one never shows.
    await selectOrganization(W.chA);
    expect((await takeover()).message).toMatchObject({ conversationId: sentInA, body: "Sent in organization A" });
    await q("update public.member_messages set read_at = now() where conversation_id = $1", [sentInA]);
    expect((await takeover()).message).toBeNull();
  });

  it("H7 backfills only conversations whose stewards resolve to exactly one organization", async () => {
    const stewardAB = await person("steward-ab-backfill", { org: W.orgA, chapter: W.chA, memberships: [W.orgB], roles: ["steward"] });
    await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [W.orgB, stewardAB.id]);
    const open = async (steward) => (await q(
      "insert into public.member_conversations(user_id,title,initials,steward_user_id) values ($1,'Chapter steward','CS',$2) returning id",
      [W.twoOrg.id, steward],
    )).rows[0].id;
    const boundA = await open(W.stewardA.id);
    const repliedB = await open(null);
    await stewardMessage(repliedB, W.stewardB.id, "Reply from B");
    const twoOrgSteward = await open(stewardAB.id);
    const mixed = await open(W.stewardA.id);
    await stewardMessage(mixed, W.stewardB.id, "A thread answered from B");
    const noSteward = await open(null);
    // The member's own id as a steward sender never counts.
    await stewardMessage(noSteward, W.twoOrg.id, "Not a steward");
    const start = sql.indexOf("with conversation_stewards as (");
    const end = sql.indexOf("where c.id = resolved.conversation_id;", start) + "where c.id = resolved.conversation_id;".length;
    expect(start).toBeGreaterThan(-1);
    expect((await q("select sender_id from public.member_messages where conversation_id = $1", [repliedB])).rows).toEqual([{ sender_id: W.stewardB.id }]);
    await q(sql.slice(start, end));
    const { rows } = await q("select id, organization_id from public.member_conversations where id = any($1::uuid[])", [[boundA, repliedB, twoOrgSteward, mixed, noSteward]]);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.organization_id]))).toEqual({
      [boundA]: W.orgA, [repliedB]: W.orgB, [twoOrgSteward]: null, [mixed]: null, [noSteward]: null,
    });
  });

  // -------------------------------------------------------------------------
  // H8 Bounded steward deadline sweep
  // -------------------------------------------------------------------------

  it("H8 reads at most 500 due deadlines per run, skips switched-off organizations, and reaches the rest next run", async () => {
    await q("update private.notification_controls set outbound_enabled = true where id");
    await q(`insert into public.member_cases(id,user_id,reference,title,case_type,step,status,deadline,steward_user_id,organization_id,chapter_id)
             select gen_random_uuid(), $1, 'HOTFIX-D-' || n, 'Deadline proof', 'other', 'Step 1', 'active', current_date + 1, $2, $3, $4
             from generate_series(1, 505) n`, [W.memberA.id, W.stewardA.id, W.orgA, W.chA]);
    await setting(W.orgB, "features.notifications.steward_deadline_reminders", false);
    await q(`insert into public.member_cases(id,user_id,reference,title,case_type,step,status,deadline,steward_user_id,organization_id,chapter_id)
             values (gen_random_uuid(), $1, 'HOTFIX-D-B', 'Deadline proof', 'other', 'Step 1', 'active', current_date + 1, $2, $3, $4)`,
    [W.twoOrg.id, W.stewardB.id, W.orgB, W.chB]);
    const marks = async (org) => (await q(
      "select count(*)::int n from private.staff_deadline_notice_marks m join public.member_cases c on c.id = m.deadline_id where c.organization_id = $1",
      [org],
    )).rows[0].n;
    await q("select private.staff_deadline_notice_sweep()");
    expect(await marks(W.orgA)).toBe(500);
    await q("select private.staff_deadline_notice_sweep()");
    expect(await marks(W.orgA)).toBe(505);
    expect(await marks(W.orgB)).toBe(0);
    expect((await q("select private.staff_deadline_notice_sweep() n")).rows[0].n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // H10 Password verification attempt hook
  // -------------------------------------------------------------------------

  it("H10 throttles failed password attempts per account with one flat refusal", async () => {
    const account = randomUUID();
    const attempt = async (valid, user = account) => (await q("select public.auth_password_verification_attempt_hook($1::jsonb) r", [JSON.stringify({ user_id: user, valid })])).rows[0].r;
    expect(await attempt(true)).toEqual({ decision: "continue" });
    const limit = (await q("select private.organization_limit(null, 'limits.security.signin_attempts_per_email_hour') n")).rows[0].n;
    for (let index = 0; index < limit; index += 1) expect(await attempt(false)).toEqual({ decision: "continue" });
    expect(await attempt(false)).toEqual(REFUSED);
    // The right password is refused the same way while the budget is spent.
    expect(await attempt(true)).toEqual(REFUSED);
    expect(await attempt(true, randomUUID())).toEqual({ decision: "continue" });
    expect((await q("select public.auth_password_verification_attempt_hook('{\"valid\": true}'::jsonb) r")).rows[0].r).toEqual(REFUSED);
    const grants = (await q(`select has_function_privilege('supabase_auth_admin', 'public.auth_password_verification_attempt_hook(jsonb)', 'execute') auth,
      has_function_privilege('authenticated', 'public.auth_password_verification_attempt_hook(jsonb)', 'execute') authed,
      has_function_privilege('anon', 'public.auth_password_verification_attempt_hook(jsonb)', 'execute') anon,
      has_function_privilege('service_role', 'public.auth_password_verification_attempt_hook(jsonb)', 'execute') service`)).rows[0];
    expect(grants).toEqual({ auth: true, authed: false, anon: false, service: false });
  });

  // -------------------------------------------------------------------------
  // H11 Server-enforced quarterly survey gate
  // -------------------------------------------------------------------------

  it("H11 locks the member report reads until the quarter's survey is submitted, and keeps every fail-open case", async () => {
    const reads = async (user) => ({
      workload: (await one("select public.get_workload_stats() r", [], user)).r,
      standing: (await one("select public.get_chapter_standing() r", [], user)).r,
      card: (await one("select public.get_my_analytics_report_card() r", [], user)).r,
    });
    const locked = (result) => result.workload.locked === true && result.standing.locked === true && result.card.locked === true;
    // No quarterly survey: open.
    expect(locked(await reads(W.memberA))).toBe(false);
    const period = (await q("select to_char(current_date, 'YYYY') || '-Q' || date_part('quarter', current_date)::integer p")).rows[0].p;
    const survey = (await q("insert into public.organization_surveys(organization_id,title,status,cadence,period_key,created_by) values ($1,'Quarterly check-in','open','quarterly',$2,$3) returning id", [W.orgA, period, W.adminA.id])).rows[0].id;
    const memberReads = await reads(W.memberA);
    expect(memberReads.workload).toMatchObject({ enoughData: false, locked: true, reason: "quarterly_survey_gate" });
    expect(memberReads.standing).toMatchObject({ enoughData: false, locked: true, reason: "quarterly_survey_gate" });
    expect(memberReads.card).toMatchObject({ overall: null, locked: true, reason: "quarterly_survey_gate", signals: [] });
    // Admins are exempt.
    expect(locked(await reads(W.adminA))).toBe(false);
    // The organization switch turns it off.
    await q("savepoint gate_switch");
    await setting(W.orgA, "features.engagement_voice.quarterly_survey_gate", false);
    expect(locked(await reads(W.memberA))).toBe(false);
    await q("rollback to savepoint gate_switch");
    // Submitting the survey unlocks the reads.
    await q("insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id,status,submitted_at) values ($1,$2,$3,'submitted',now())", [W.orgA, survey, W.memberA.id]);
    const after = await reads(W.memberA);
    expect(after.workload.locked).toBeUndefined();
    expect(after.standing.locked).toBeUndefined();
    expect(after.card.locked).toBeUndefined();
  });
});
