// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const mesh = "union-ground-mesh";
const model = "union-ground/compass-mesh:v1";
const fireworks = "accounts/fireworks/models/muse-spark-open";
const key = "synthetic-platform-proof-credential";
live("platform Fireworks authorization on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "platform-ai-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });
  async function rpc(sql, values = [], user = null, aal = "aal2") {
    await c.query("savepoint rpc_call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal }
        : { role: "service_role" })]);
      await c.query(user ? "set local role authenticated" : "set local role service_role");
      const value = (await c.query(`select ${sql} as value`, values)).rows[0].value;
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
      await c.query("release savepoint rpc_call");
      return value;
    } catch (error) {
      await c.query("rollback to savepoint rpc_call");
      await c.query("release savepoint rpc_call");
      throw error;
    }
  }
  beforeEach(async () => {
    await c.query("begin");
    world = {};
    for (const label of ["a", "b"]) {
      const user = { id: randomUUID(), session: randomUUID(), org: randomUUID(), chapter: `platform-${label}-${randomUUID().slice(0, 8)}` };
      world[label] = user;
      await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
      await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [user.org, user.chapter]);
      await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98273)", [user.chapter, user.org]);
      await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [user.org, user.id]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, user.chapter]);
      await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, user.chapter]);
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [user.org, user.id]);
      await c.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa,updated_by) values (true,$1,false,$2)", [user.org, user.id]);
      await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    }
    await rpc("public.set_compass_platform_operator($1,true,'Disposable platform proof')", [world.a.id]);
    await c.query("update public.compass_ai_policy set enabled=true, gateway=$1,model=$2 where id", [mesh, model]);
    await c.query("insert into public.compass_ai_provider_attestations(status,gateway,model,zero_data_retention,disallow_prompt_training,evidence_ref,expires_at,attested_by) values ('verified',$1,$2,true,true,$3,now()+interval '1 day',$4)", [mesh, model, `sha256:${"a".repeat(64)}`, world.a.id]);
  });
  afterEach(async () => { await c.query("rollback"); });
  const configure = (credential = key, user = world.a) => rpc("public.configure_compass_platform_fireworks($1,$2,true)", [fireworks, credential], user);
  const reserve = (user = world.a) => rpc("public.reserve_compass_ai_request($1,$2,$3,true,true)", [user.id, mesh, model]);
  const dispatch = (id, user = world.a, fn = "authorize_compass_ai_dispatch") => rpc(`public.${fn}($1,$2,$3,$4,true,true)`, [id, user.id, mesh, model]);
  const fallback = (id, user = world.a, cause = "temporary_http") => rpc("public.authorize_compass_ai_failover($1,$2,$3)", [id, user.id, cause]);
  async function dispatched(user = world.a) {
    const request = await reserve(user);
    expect(request.id).toEqual(expect.any(String));
    expect(await dispatch(request.id, user)).toMatchObject({ authorized: true });
    return request.id;
  }

  it("keeps mesh primary for both organizations and returns no credential during resolution", async () => {
    await configure();
    for (const user of [world.a, world.b]) expect(await rpc("public.resolve_compass_ai_provider($1)", [user.id])).toEqual({ gateway: mesh, model });
    expect(await rpc("public.reserve_compass_ai_request($1,'union-ground-fireworks',$2,true,true)", [world.a.id, fireworks])).toEqual({ id: null, cause: "config" });
  });
  it("lets both organizations use one central credential with distinct server-derived scopes", async () => {
    await configure();
    for (const user of [world.a, world.b]) {
      expect(await fallback(await dispatched(user), user)).toMatchObject({ authorized: true, gateway: "union-ground-fireworks", api_key: key, model: fireworks, isolation_scope: user.org });
    }
  });
  it("does not consume primary dispatch when authorizing an embedding", async () => {
    const { id } = await reserve();
    expect(await dispatch(id, world.a, "authorize_compass_ai_embedding")).toMatchObject({ authorized: true });
    expect(await dispatch(id, world.a, "authorize_compass_ai_embedding")).toMatchObject({ authorized: false });
    expect(await dispatch(id)).toMatchObject({ authorized: true });
    expect(await dispatch(id)).toMatchObject({ authorized: false });
  });
  it("allows one fallback only and keeps a dispatched fallback counted after failure", async () => {
    await configure(); const id = await dispatched();
    expect(await fallback(id)).toMatchObject({ authorized: true });
    expect(await fallback(id)).toMatchObject({ authorized: false, cause: "reservation" });
    expect(await rpc("public.release_member_ai_request($1)", [id])).toBe(false);
    expect((await c.query("select count(*)::int n from public.member_ai_requests where id=$1", [id])).rows[0].n).toBe(1);
  });
  it("refuses fallback before primary dispatch, for another member, and for non-outage reasons", async () => {
    await configure(); const { id } = await reserve();
    expect(await fallback(id)).toMatchObject({ authorized: false });
    await dispatch(id);
    expect(await fallback(id, world.b)).toMatchObject({ authorized: false });
    for (const cause of [null, "disabled", "privacy", "unauthorized", "model_mismatch"]) {
      expect(await fallback(id, world.a, cause)).toEqual({ authorized: false, cause: "outage" });
    }
    expect(await fallback(id)).toMatchObject({ authorized: true });
  });
  it("refuses a switch to another organization after reservation even if the member belongs to both", async () => {
    await configure(); const id = await dispatched();
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [world.b.org, world.a.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [world.a.id, world.b.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [world.a.id, world.b.chapter]);
    expect(await fallback(id)).toEqual({ authorized: false, cause: "reservation" });
  });
  it("refuses fallback after membership removal or account suspension", async () => {
    await configure(); const id = await dispatched();
    await c.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1", [world.a.id]);
    expect(await fallback(id)).toMatchObject({ authorized: false });
    await c.query("update public.organization_memberships set status='active',revoked_at=null where user_id=$1", [world.a.id]);
    await c.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [world.a.id]);
    expect(await fallback(id)).toMatchObject({ authorized: false });
  });
  it("rechecks the global pause and current role limit before using Fireworks", async () => {
    await configure(); const id = await dispatched();
    await c.query("update public.compass_ai_policy set enabled=false where id");
    expect(await fallback(id)).toEqual({ authorized: false, cause: "disabled" });
    await c.query("update public.compass_ai_policy set enabled=true where id");
    await c.query("update public.compass_ai_role_limits set hourly_limit=0 where role='admin'");
    expect(await fallback(id)).toEqual({ authorized: false, cause: "role" });
  });
  it("refuses a missing fallback key and revoked or expired provider attestation", async () => {
    const id = await dispatched();
    expect(await fallback(id)).toMatchObject({ authorized: false, cause: "fallback_unconfigured" });
    await configure();
    await c.query("update public.compass_ai_provider_attestations set created_at=now()-interval '2 days', expires_at=now()-interval '1 day' where gateway='union-ground-fireworks'");
    expect(await fallback(id)).toEqual({ authorized: false, cause: "unattested" });
  });
  it("defaults the failover model to Muse Spark Open and never stores a contributor model", async () => {
    const column = await c.query(`select column_default from information_schema.columns
      where table_schema='private' and table_name='compass_platform_fireworks' and column_name='model'`);
    expect(column.rows[0].column_default).toContain("accounts/fireworks/models/muse-spark-open");
    for (const contributor of ["accounts/fireworks/models/muse-spark-1p3-contributor", "accounts/fireworks/models/muse-spark-contributor-open"]) {
      await expect(rpc("public.configure_compass_platform_fireworks($1,$2,true)", [contributor, key], world.a)).rejects.toMatchObject({ code: "23514" });
      await c.query("savepoint direct_write");
      await expect(c.query("update private.compass_platform_fireworks set model=$1", [contributor])).rejects.toMatchObject({ code: "23514" });
      await c.query("rollback to savepoint direct_write");
    }
    expect((await configure()).model).toBe(fireworks);
  });
  it("keeps credential storage and setup restricted to an explicitly granted MFA platform operator", async () => {
    await expect(configure(key, world.b)).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("public.configure_compass_platform_fireworks($1,$2,true)", [fireworks, key], world.a, "aal1")).rejects.toMatchObject({ code: "42501" });
    const result = await configure();
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result).toMatchObject({ enabled: true, canManage: true });
    expect(await rpc("public.get_compass_platform_ai()", [], world.b)).toMatchObject({ enabled: true, canManage: false });
    await expect(rpc("public.set_compass_ai_enabled(false)", [], world.b)).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("public.enable_organization_ai_connector('ai_connector_fireworks',$1,$2)", [fireworks, key], world.b)).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("public.authorize_compass_ai_failover($1,$2,'timeout')", [randomUUID(), world.b.id], world.b)).rejects.toMatchObject({ code: "42501" });
  });
  it("rotates the central key without changing the primary route, and disabling prevents fallback", async () => {
    await configure(); const id = await dispatched();
    const old = (await c.query("select credential_ref from private.compass_platform_fireworks")).rows[0].credential_ref;
    await configure(`${key}-rotated`);
    expect((await c.query("select count(*)::int n from vault.secrets where id=$1", [old])).rows[0].n).toBe(0);
    expect(await fallback(id)).toMatchObject({ api_key: `${key}-rotated` });
    await rpc("public.disable_compass_platform_fireworks()", [], world.a);
    expect(await fallback(await dispatched())).toMatchObject({ authorized: false, cause: "fallback_unconfigured" });
  });
  it("renews the Fireworks attestation up to 90 days without rotating the key, operator and MFA only", async () => {
    const renew = (days, user = world.a, aal = "aal2", confirm = true) => rpc("public.renew_compass_platform_fireworks_attestation($1::int,$2,$2)", [days, confirm], user, aal);
    const status = (user = world.a) => rpc("public.get_compass_platform_ai()", [], user);
    // Renewal never creates an authorization, and nothing is configured yet.
    await expect(renew(90)).rejects.toMatchObject({ code: "55000" });
    expect(await status()).toMatchObject({ enabled: false, configured: false });
    await configure(); const id = await dispatched();
    // An expired attestation leaves the key on record: not authorized, still
    // configured, so the card keeps the renewal control instead of key re-entry.
    await c.query("update public.compass_ai_provider_attestations set created_at=now()-interval '2 days', expires_at=now()-interval '1 day' where gateway='union-ground-fireworks'");
    const lapsed = await status();
    expect(lapsed).toMatchObject({ enabled: false, configured: true, canManage: true });
    expect(new Date(lapsed.attestationExpiresAt).getTime()).toBeLessThan(Date.now());
    expect(await fallback(await dispatched())).toEqual({ authorized: false, cause: "unattested" });
    const ref = (await c.query("select credential_ref, revision from private.compass_platform_fireworks")).rows[0];
    await expect(renew(90, world.b)).rejects.toMatchObject({ code: "42501" });
    await expect(renew(90, world.a, "aal1")).rejects.toMatchObject({ code: "42501" });
    await expect(renew(91)).rejects.toMatchObject({ code: "22023" });
    await expect(renew(0)).rejects.toMatchObject({ code: "22023" });
    await expect(renew(90, world.a, "aal2", false)).rejects.toMatchObject({ code: "22023" });
    const result = await renew(90);
    expect(result).toMatchObject({ enabled: true, configured: true, canManage: true });
    expect(JSON.stringify(result)).not.toContain(key);
    const expires = new Date(result.attestationExpiresAt).getTime() - Date.now();
    expect(expires).toBeGreaterThan(89 * 86_400_000);
    expect(expires).toBeLessThanOrEqual(90 * 86_400_000 + 60_000);
    // Same key, same revision; one more verified row and one audit row.
    expect((await c.query("select credential_ref, revision from private.compass_platform_fireworks")).rows[0]).toEqual(ref);
    expect((await c.query("select count(*)::int n from public.compass_ai_provider_attestations where gateway='union-ground-fireworks' and status='verified'")).rows[0].n).toBe(2);
    expect((await c.query("select count(*)::int n from public.member_admin_audit where action='attest_compass_ai_provider' and (detail->>'renewal')::boolean")).rows[0].n).toBe(1);
    expect(await fallback(id)).toMatchObject({ authorized: true, api_key: key });
    // After the previous row would have expired, the renewed one still authorizes.
    await c.query("update public.compass_ai_provider_attestations set created_at=now()-interval '2 days', expires_at=now()-interval '1 day' where gateway='union-ground-fireworks' and sequence_no=(select min(sequence_no) from public.compass_ai_provider_attestations where gateway='union-ground-fireworks' and status='verified')");
    expect(await fallback(await dispatched())).toMatchObject({ authorized: true });
    await rpc("public.disable_compass_platform_fireworks()", [], world.a);
    expect(await status()).toMatchObject({ enabled: false, configured: false });
    await expect(renew(90)).rejects.toMatchObject({ code: "55000" });
  });
  it("permits centrally managed setup without belonging to an application organization", async () => {
    await c.query("update public.member_profiles set chapter_id=null where id=$1", [world.a.id]);
    // A chapterless account with one active membership resolves to that
    // organization (SEC-UG-COMPASS-ORG-POLICY-ENFORCEMENT-20261002), so the
    // operator here holds none at all.
    await c.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1", [world.a.id]);
    expect(await configure()).toMatchObject({ enabled: true, canManage: true });
    expect(await fallback(await dispatched())).toMatchObject({ authorized: true, isolation_scope: world.a.id });
  });
  it("adopts only the operator's explicitly selected organization credential without exporting it", async () => {
    const secret = (await c.query("select vault.create_secret($1) id", [key])).rows[0].id;
    await c.query("insert into public.organization_integrations(organization_id,provider,status,account_owner,allow_chapter_overrides,allow_chapter_owned_accounts,default_settings,credential_ref) values ($1,'ai_connector_fireworks','connected','organization',false,false,$2,$3)", [world.a.org, JSON.stringify({ model: fireworks, enabledAt: new Date().toISOString(), enabledBy: world.a.id, attestation: "Disposable fixture", termsAcknowledged: true }), secret]);
    await expect(rpc("public.adopt_compass_platform_fireworks($1,true)", [world.a.org], world.b)).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("public.adopt_compass_platform_fireworks($1,true)", [world.b.org], world.a)).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("public.adopt_compass_platform_fireworks($1,false)", [world.a.org], world.a)).rejects.toMatchObject({ code: "42501" });
    const result = await rpc("public.adopt_compass_platform_fireworks($1,true)", [world.a.org], world.a);
    expect(result).toMatchObject({ enabled: true });
    expect(JSON.stringify(result)).not.toContain(key);
    expect((await c.query("select status,credential_ref from public.organization_integrations where organization_id=$1 and provider='ai_connector_fireworks'", [world.a.org])).rows[0]).toEqual({ status: "disabled", credential_ref: null });
    expect(await fallback(await dispatched(world.b), world.b)).toMatchObject({ authorized: true, api_key: key, isolation_scope: world.b.org });
  });
  it("labels context atomically and preserves member RLS for lexical and hybrid retrieval", async () => {
    for (const user of [world.a, world.b]) {
      await c.query("insert into public.member_kb_articles(slug,kind,title,article_ref,body,keywords,order_index,chapter_id,status,is_sample,version,created_by,updated_by,verified_by,verified_at,content_origin) values ($1,'contract',$1,'Article 12',$2,array['zebraworkscope'],9921,$3,'published',false,1,$4,$4,$4,now(),'authored')", [user.chapter, `zebraworkscope ${user.chapter} authorized article`, user.chapter, user.id]);
    }
    for (const user of [world.a, world.b]) {
      expect(await rpc("public.get_compass_ai_context('portal')", [], user)).toMatchObject({ organization_id: user.org });
      for (const kind of ["lexical", "hybrid"]) {
        const context = await rpc("public.get_compass_ai_context($1,$2)", [kind, JSON.stringify({ p_query: "zebraworkscope", p_embedding: JSON.stringify(Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)) })], user);
        expect(context.organization_id).toBe(user.org);
        expect(context.data).toHaveLength(1);
        expect(context.data[0].snippet).toContain(user.chapter);
        expect(JSON.stringify(context.data)).not.toContain(user === world.a ? world.b.chapter : world.a.chapter);
      }
    }
    await expect(rpc("public.get_compass_ai_context('portal')")).rejects.toMatchObject({ code: "42501" });
  });

  const outcome = (id, user = world.a, result = "answered") => rpc(
    "public.record_compass_ai_request_outcome($1,$2,$3)", [id, user.id, result]);
  const ticks = async (org, metric) => (await c.query(
    "select coalesce(sum(value),0)::int n from private.mesh_agency_usage_counters where organization_id=$1 and metric=$2",
    [org, metric])).rows[0].n;
  async function selectB() {
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [world.b.org, world.a.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [world.a.id, world.b.chapter]);
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [world.a.id, world.b.chapter]);
  }
  it("attributes an answered outcome to reservation A after the member selects B", async () => {
    const id = await dispatched();
    await selectB();
    await outcome(id);
    expect(await ticks(world.a.org, "compass_requests")).toBe(1);
    expect(await ticks(world.a.org, "compass_answered")).toBe(1);
    expect(await ticks(world.b.org, "compass_answered")).toBe(0);
  });
  it("attributes a no-source outcome before dispatch to reservation A after selecting B", async () => {
    const { id } = await reserve();
    await selectB();
    await outcome(id, world.a, "no_source");
    expect(await ticks(world.a.org, "compass_no_source")).toBe(1);
    expect(await ticks(world.b.org, "compass_no_source")).toBe(0);
    expect((await c.query("select dispatch_authorized_at from public.member_ai_requests where id=$1", [id])).rows[0].dispatch_authorized_at).toBeNull();
  });
  it("counts chapterless single-organization requests and outcomes in the reservation scope", async () => {
    await c.query("update public.member_profiles set chapter_id=null where id=$1", [world.a.id]);
    const id = await dispatched();
    await outcome(id);
    expect(await ticks(world.a.org, "compass_requests")).toBe(1);
    expect(await ticks(world.a.org, "compass_answered")).toBe(1);
  });
  it("does not recreate an archived organization's counters for a late outcome", async () => {
    const id = await dispatched();
    await c.query("update public.organizations set status='archived' where id=$1", [world.a.org]);
    await outcome(id);
    expect(await ticks(world.a.org, "compass_requests")).toBe(0);
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
    expect(await ticks(world.b.org, "compass_answered")).toBe(0);
  });
  it("refuses unknown requests, another user, null or invalid outcomes, and undispatched answers", async () => {
    const { id } = await reserve();
    await outcome(id);
    await outcome(id, world.b);
    await outcome(randomUUID());
    await outcome(null);
    await rpc("public.record_compass_ai_request_outcome($1,null,'no_source')", [id]);
    await outcome(id, world.a, null);
    await outcome(id, world.a, "member_email");
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
    expect(await ticks(world.b.org, "compass_answered")).toBe(0);
  });
  it("keeps outcomes service-only and retires the mutable-scope entry point", async () => {
    const id = await dispatched();
    await expect(rpc("public.record_compass_ai_request_outcome($1,$2,'answered')", [id, world.a.id], world.a)).rejects.toMatchObject({ code: "42501" });
    await expect(rpc("public.record_compass_ai_outcome($1,'answered')", [world.a.id])).rejects.toMatchObject({ code: "42501" });
    const grants = (await c.query(`select
      has_function_privilege('anon', 'public.record_compass_ai_request_outcome(uuid,uuid,text)', 'EXECUTE') anon,
      has_function_privilege('authenticated', 'public.record_compass_ai_request_outcome(uuid,uuid,text)', 'EXECUTE') authenticated,
      has_function_privilege('service_role', 'public.record_compass_ai_request_outcome(uuid,uuid,text)', 'EXECUTE') service`)).rows[0];
    expect(grants).toEqual({ anon: false, authenticated: false, service: true });
    const retired = (await c.query(`select rolname from pg_roles where rolname in ('anon','authenticated','service_role')
      and has_function_privilege(oid, 'public.record_compass_ai_outcome(uuid,text)', 'EXECUTE')`)).rows;
    expect(retired).toEqual([]);
    // Even an internal owner call cannot revive mutable-selection attribution.
    await c.query("select public.record_compass_ai_outcome($1,'answered')", [world.a.id]);
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
  });

  it("rejects forged and invalid calls even for a dispatched request", async () => {
    const id = await dispatched();
    await outcome(id, world.b);
    await outcome(id, world.b, "no_source");
    await outcome(id, world.a, null);
    await outcome(id, world.a, "member_email");
    await outcome(null, world.a, "no_source");
    await outcome(randomUUID(), world.a, "no_source");
    await rpc("public.record_compass_ai_request_outcome($1,null,'no_source')", [id]);
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
    expect(await ticks(world.a.org, "compass_no_source")).toBe(0);
    expect(await ticks(world.b.org, "compass_answered")).toBe(0);
    expect(await ticks(world.b.org, "compass_no_source")).toBe(0);
  });

  it("skips historical unattributed and nongoverned requests instead of guessing from the current selection", async () => {
    const id = await dispatched();
    await c.query("update public.member_ai_requests set compass_organization_id=null where id=$1", [id]);
    await outcome(id);
    await outcome(id, world.a, "no_source");
    await c.query("update public.member_ai_requests set compass_organization_id=$2, compass_role=null, compass_limit=null where id=$1", [id, world.a.org]);
    await outcome(id);
    await outcome(id, world.a, "no_source");
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
    expect(await ticks(world.a.org, "compass_no_source")).toBe(0);
  });

  it("never substitutes the separate retention organization for the Compass scope", async () => {
    await c.query("update public.member_profiles set chapter_id=null where id=$1", [world.a.id]);
    const id = await dispatched();
    expect((await c.query("select organization_id from public.member_ai_requests where id=$1", [id])).rows[0].organization_id).toBeNull();
    await outcome(id);
    expect(await ticks(world.a.org, "compass_answered")).toBe(1);
    expect(await ticks(world.b.org, "compass_answered")).toBe(0);
  });

  it.each(["suspended", "archived"])("skips an original organization that became %s", async (status) => {
    const id = await dispatched();
    await selectB();
    await c.query("update public.organizations set status=$2 where id=$1", [world.a.org, status]);
    await outcome(id);
    await outcome(id, world.a, "no_source");
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
    expect(await ticks(world.a.org, "compass_no_source")).toBe(0);
    expect(await ticks(world.b.org, "compass_answered")).toBe(0);
    expect(await ticks(world.b.org, "compass_no_source")).toBe(0);
  });

  it("skips a missing original organization without redirecting late outcomes", async () => {
    const id = await dispatched();
    // No FK on the immutable Compass snapshot: historical requests may outlive
    // their organization. Exercise the missing lookup without other erasures.
    await c.query("update public.member_ai_requests set compass_organization_id=$2 where id=$1", [id, randomUUID()]);
    await selectB();
    await outcome(id);
    await outcome(id, world.a, "no_source");
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
    expect(await ticks(world.b.org, "compass_answered")).toBe(0);
    expect(await ticks(world.b.org, "compass_no_source")).toBe(0);
  });

  it("keeps the full-week reactivation floor for both late outcomes", async () => {
    const id = await dispatched();
    await c.query("update public.organizations set status='archived' where id=$1", [world.a.org]);
    await c.query("update public.organizations set status='active' where id=$1", [world.a.org]);
    await outcome(id);
    await outcome(id, world.a, "no_source");
    expect(await ticks(world.a.org, "compass_answered")).toBe(0);
    expect(await ticks(world.a.org, "compass_no_source")).toBe(0);
    await c.query("update private.mesh_agency_usage_start set counting_from=date_trunc('week',now())::date where organization_id=$1", [world.a.org]);
    await outcome(id);
    expect(await ticks(world.a.org, "compass_answered")).toBe(1);
  });

  it("counts completion in its current week even when the reservation is older", async () => {
    const id = await dispatched();
    await c.query("update public.member_ai_requests set created_at=now()-interval '8 days' where id=$1", [id]);
    await outcome(id);
    expect((await c.query("select period_start=date_trunc('week',now())::date current_week from private.mesh_agency_usage_counters where organization_id=$1 and metric='compass_answered'", [world.a.org])).rows).toEqual([{ current_week: true }]);
  });

  it("counts a chapterless member's synchronous rate-limit ticks using the quota resolver", async () => {
    await c.query("update public.member_profiles set chapter_id=null where id=$1", [world.a.id]);
    await c.query("update public.compass_ai_role_limits set hourly_limit=1 where role='admin'");
    await dispatched();
    expect(await reserve()).toMatchObject({ id: null, cause: "role" });
    expect(await ticks(world.a.org, "compass_requests")).toBe(1);
    expect(await ticks(world.a.org, "compass_rate_limited")).toBe(1);
  });

  async function lifecycleOutcome(operation, outcomeFirst) {
    // Model a retained request after membership removal. Bare organizations
    // have no unrelated FK dependents, so this exercises the real delete and
    // erasure triggers without relaxing any constraints or changing a snapshot.
    await c.query("rollback");
    const org = randomUUID();
    const user = randomUUID();
    const request = randomUUID();
    const peer = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    await peer.connect();
    const change = operation === "archive" ? "update public.organizations set status='archived' where id=$1" : "delete from public.organizations where id=$1";
    try {
      await c.query("begin");
      await c.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
      await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, `outcome-lifecycle-${org}`]);
      await c.query("insert into public.member_ai_requests(id,user_id,compass_role,compass_limit,compass_organization_id,dispatch_authorized_at) values ($1,$2,'member',20,$3,now())", [request,user,org]);
      await c.query("commit");
      await c.query("begin");
      await c.query("set local lock_timeout='100ms'");
      await peer.query("set lock_timeout='100ms'");
      if (outcomeFirst) {
        await rpc("public.record_compass_ai_request_outcome($1,$2,'answered')", [request,user]);
        expect(await ticks(org, "compass_answered")).toBe(1);
        await expect(peer.query(change,[org])).rejects.toMatchObject({code:"55P03"});
        await c.query("commit");
        await peer.query(change,[org]);
        await c.query("begin");
      } else {
        await peer.query("begin");
        await peer.query(change,[org]);
        await expect(rpc("public.record_compass_ai_request_outcome($1,$2,'answered')", [request,user])).rejects.toMatchObject({code:"55P03"});
        await peer.query("commit");
      }
      await rpc("public.record_compass_ai_request_outcome($1,$2,'answered')", [request,user]);
      expect(await ticks(org, "compass_answered")).toBe(0);
    } finally {
      await peer.query("rollback");
      await peer.end();
      await c.query("rollback");
      await c.query("begin");
      await c.query("delete from auth.users where id=$1",[user]);
      await c.query("delete from public.organizations where id=$1",[org]);
      await c.query("commit");
      await c.query("begin");
    }
  }
  it.each(["archive", "delete"])("serializes an outcome before an organization %s", async (operation) => lifecycleOutcome(operation,true));
  it.each(["archive", "delete"])("waits behind a pending organization %s before reading the request", async (operation) => lifecycleOutcome(operation,false));
});
