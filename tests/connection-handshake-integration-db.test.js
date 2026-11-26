// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { connectionHandshakeOutcome, isConnectionHandshakeReceipt } from "../src/features/connectionSuggestions/contract.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("published connections use the existing exact-chapter handshake lifecycle", () => {
  let db;
  const ids = Object.fromEntries(["org", "otherOrg", "admin", "receiver", "session", "receiverSession"].map((key) => [key, randomUUID()]));
  const prefix = `handshake-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-source`, sibling = `${prefix}-sibling`, target = `${prefix}-target`;
  const partner = `${prefix}-union`;
  async function call(sql, params = [], receiving = false, claims = {}) {
    await db.query("savepoint handshake_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: receiving ? ids.receiver : ids.admin, role: "authenticated", session_id: receiving ? ids.receiverSession : ids.session, aal: "aal2", ...claims })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint handshake_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint handshake_call");
      await db.query("release savepoint handshake_call");
      return { code: error.code, message: error.message };
    }
  }
  const request = (overrides = {}, claims = {}) => {
    const args = { hat: "admin", source: chapter, target, title: "Staffing collaboration", purpose: "Share published staffing resources", scope: "docs_only", key: randomUUID(), ...overrides };
    return call("select public.request_chapter_connection_handshake($1,$2,$3,$4,$5,$6,$7) data", [args.hat, args.source, args.target, args.title, args.purpose, args.scope, args.key], false, claims);
  };
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "connection-handshake-proof" });
    await db.connect(); await db.query("begin");
    await db.query("set local statement_timeout='60s'");
    await db.query("set local lock_timeout='15s'");
    await db.query("insert into auth.users(id,email) values ($1,$3),($2,$4)", [ids.admin, ids.receiver, `${ids.admin}@example.invalid`, `${ids.receiver}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$3,$3,$5),($2,$4,$4,$6)", [ids.org, ids.otherOrg, `${prefix}-org`, `${prefix}-other`, ids.admin, ids.receiver]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$4,false,9911),($2,$2,$2,$4,false,9912),($3,$3,$3,$5,false,9913)", [chapter, sibling, target, ids.org, ids.otherOrg]);
    for (const [user, org, source, session] of [[ids.admin, ids.org, chapter, ids.session], [ids.receiver, ids.otherOrg, target, ids.receiverSession]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user, source]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, source]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [session, user]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Handshake proof','totp','verified',now(),now())", [randomUUID(), user]);
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org, user]);
    }
    await db.query(`insert into private.chapter_connection_profiles
      (chapter_id,organization_id,location_country,sector_keys,declared_issue_keys,publication_status,publication_version,published_at,expires_at,consent_version,consent_recorded_at,consent_hat)
      values ($1,$2,'US',array['healthcare'],array['staffing'],'published',1,now(),now()+interval '180 days',1,now(),'admin')`, [target, ids.otherOrg]);
    await db.query("insert into public.union_orgs(id,olms_file_number,name,affiliation,level,enrichment_status,atlas_manifest_sha) values ($1,$2,'Synthetic resource partner','SYNTHETIC','local','no_web_presence','handshake-proof')", [partner, 700000000 + Math.floor(Math.random() * 100000000)]);
    await db.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by,verified_at) values ($1,$2,'verified',$3,now())", [target, partner, ids.receiver]);
  }, 60000);
  beforeEach(async () => { await db.query("savepoint handshake_test"); });
  afterEach(async () => { await db.query("rollback to savepoint handshake_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("exposes verified public identity and selected-chapter capability without tenant internals", async () => {
    const listed = await call("select public.list_chapter_connection_profiles('admin',null,500,null,$1) data", [chapter]);
    expect(listed.code, listed.message).toBe("");
    const row = listed.data.rows.find((item) => item.id === target);
    expect(row.handshake).toEqual({ eligible: true, partnerOrgId: partner });
    expect(JSON.stringify(row)).not.toContain(ids.otherOrg);
    expect(JSON.stringify(row)).not.toContain(ids.receiver);
    expect((await call("select public.get_chapter_connection_workspace('admin',$1) data", [chapter])).data.canRequestHandshake).toBe(true);
    expect((await call("select public.get_chapter_connection_workspace('admin',$1) data", [sibling])).data.canRequestHandshake).toBe(false);
    await db.query("update public.chapter_union_org_bindings set status='rejected' where chapter_id=$1", [target]);
    const unavailable = await call("select public.list_chapter_connection_profiles('admin',null,500,null,$1) data", [chapter]);
    expect(unavailable.data.rows.find((item) => item.id === target).handshake).toEqual({ eligible: false, partnerOrgId: null });
  });

  it("requests the exact chapter, accepts and countersigns through existing RPCs", async () => {
    const created = await request();
    expect(created, created.message).toMatchObject({ code: "", data: { chapter_id: chapter, receiving_chapter_id: target, partner_org_id: partner, status: "requested" } });
    expect((await db.query("select count(*)::int n from public.member_notifications where user_id=$1 and title='Partnership request received'", [ids.receiver])).rows[0].n).toBe(1);
    const accepted = await call("select public.respond_chapter_handshake($1,'accept',$2) data", [created.data.id, randomUUID()], true);
    expect(accepted, accepted.message).toMatchObject({ code: "", data: { status: "accepted" } });
    const active = await call("select public.countersign_chapter_handshake($1,$2) data", [created.data.id, randomUUID()]);
    expect(active, active.message).toMatchObject({ code: "", data: { status: "active", requester_signed_by: ids.admin, receiver_signed_by: ids.receiver } });
    const events = await db.query("select transition from public.chapter_handshake_events where handshake_id=$1 order by created_at,id", [created.data.id]);
    expect(events.rows.map((row) => row.transition).sort()).toEqual(["accepted", "activated", "requested"]);
  });

  it("retries one request once, rejects changed payloads, and retains legacy requests", async () => {
    const key = randomUUID();
    const first = await request({ key });
    expect(first.code, first.message).toBe("");
    expect((await request({ key })).data.id).toBe(first.data.id);
    expect((await request({ key, title: "Changed" })).code).toBe("22023");
    expect((await db.query("select count(*)::int n from public.chapter_handshake_events where idempotency_key=$1", [key])).rows[0].n).toBe(1);
    expect((await db.query("select count(*)::int n from public.member_notifications where user_id=$1 and title='Partnership request received'", [ids.receiver])).rows[0].n).toBe(1);
    const legacy = await call("select public.request_chapter_handshake($1,'Legacy request','Review published documents','docs_only',$2) data", [partner, randomUUID()]);
    expect(legacy, legacy.message).toMatchObject({ code: "", data: { receiving_chapter_id: target, status: "requested" } });
  });

  it.each([null, "member", "steward", "Admin"])("rejects a null, nonstaff or ungranted exact hat: %s", async (hat) => {
    expect((await request({ hat })).code).toBe("42501");
  });
  it.each(["declined", "closed"])("replays a %s request as the same finished lifecycle without a new notification", async (status) => {
    const key = randomUUID();
    const first = await request({ key });
    expect(first.code, first.message).toBe("");
    const finished = status === "declined"
      ? await call("select public.respond_chapter_handshake($1,'decline',$2) data", [first.data.id, randomUUID()], true)
      : await call("select public.close_chapter_handshake($1,$2) data", [first.data.id, randomUUID()]);
    expect(finished, finished.message).toMatchObject({ code: "", data: { status } });
    const replay = await request({ key });
    expect(replay, replay.message).toMatchObject({ code: "", data: { id: first.data.id, status } });
    expect(isConnectionHandshakeReceipt(replay.data, chapter, target)).toBe(true);
    expect(connectionHandshakeOutcome(replay.data)).toBe(status);
    expect((await db.query("select publication_status from private.chapter_connection_profiles where chapter_id=$1", [target])).rows[0].publication_status).toBe("published");
    expect((await db.query("select count(*)::int n from public.chapter_handshake_events where idempotency_key=$1", [key])).rows[0].n).toBe(1);
    expect((await db.query("select count(*)::int n from public.member_notifications where user_id=$1 and title='Partnership request received'", [ids.receiver])).rows[0].n).toBe(1);
  });
  it("rejects another source chapter and downgraded MFA", async () => {
    expect((await request({ source: sibling })).code).toBe("42501");
    expect((await request({ source: target })).code).toBe("42501");
    expect((await request({}, { aal: "aal1" })).code).toBe("42501");
  });
  it.each([
    ["withdrawn", "update private.chapter_connection_profiles set publication_status='withdrawn',withdrawn_at=now(),published_at=null,expires_at=null where chapter_id=$1", [target]],
    ["expired", "update private.chapter_connection_profiles set published_at=now()-interval '181 days',expires_at=now()-interval '1 day' where chapter_id=$1", [target]],
    ["unbound", "update public.chapter_union_org_bindings set status='rejected' where chapter_id=$1", [target]],
    ["quarantined", "update public.organizations set status='suspended' where id=$1", [ids.otherOrg]],
    ["hidden", "insert into private.chapter_connection_hides(chapter_id,hidden_chapter_id,organization_id) values ($1,$2,$3)", [chapter, target, ids.org]],
    ["reciprocally hidden", "insert into private.chapter_connection_hides(chapter_id,hidden_chapter_id,organization_id) values ($1,$2,$3)", [target, chapter, ids.otherOrg]],
  ])("rechecks %s targets before replaying a previous request", async (_label, sql, args) => {
    const key = randomUUID();
    expect((await request({ key })).code).toBe("");
    await db.query(sql, args);
    expect(await request({ key })).toMatchObject({ code: "22023", message: "target chapter unavailable" });
    expect((await db.query("select count(*)::int n from public.chapter_handshake_events where idempotency_key=$1", [key])).rows[0].n).toBe(1);
  });
  it("rejects unknown, self and nullable scope inputs without creating state", async () => {
    expect((await request({ target: `${prefix}-absent` })).code).toBe("22023");
    expect((await request({ target: chapter })).code).toBe("22023");
    expect((await request({ scope: null })).code).toBe("22023");
    expect((await db.query("select count(*)::int n from public.chapter_handshakes where chapter_id=$1", [chapter])).rows[0].n).toBe(0);
  });
  it("holds registry invalidation until the request transaction ends", async () => {
    const shareLocks = async () => (await db.query("select count(*)::int n from pg_locks where pid=pg_backend_pid() and relation='private.chapter_connection_registry_epoch'::regclass and mode='RowShareLock' and granted")).rows[0].n;
    expect(await shareLocks()).toBe(0);
    expect((await request()).code).toBe("");
    expect(await shareLocks()).toBe(1);
    const concurrent = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await concurrent.connect();
    try {
      await concurrent.query("begin");
      await concurrent.query("set local lock_timeout='200ms'");
      await expect(concurrent.query("update private.chapter_connection_registry_epoch set epoch=epoch+1 where singleton")).rejects.toMatchObject({ code: "55P03" });
    } finally { await concurrent.query("rollback"); await concurrent.end(); }
  });
  it("grants the new RPC to authenticated only", async () => {
    const result = await db.query("select has_function_privilege('authenticated',$1,'execute') staff,has_function_privilege('anon',$1,'execute') anonymous,has_function_privilege('service_role',$1,'execute') service", ["public.request_chapter_connection_handshake(text,text,text,text,text,text,uuid)"]);
    expect(result.rows[0]).toEqual({ staff: true, anonymous: false, service: false });
  });
});
