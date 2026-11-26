// @vitest-environment node
//
// REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031
//
// A chapter reaches a catalogue office with no chapter on Union Ground: the
// office is listed as not yet on the platform, a standing handshake offer
// waits for it (capped, one per office, withdrawable, expiring), an
// invitation request waits for the operator's founder invitation and keeps
// the contact only until it is decided, and when the office's chapter binding
// is verified the offer becomes an ordinary handshake request that nobody
// has accepted.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261101224749_standing_handshake_offers.sql", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("standing handshake offers (static)", () => {
  it("pins every routine in the database contract and grants the chapter ones to authenticated only", () => {
    const sigs = contract.functions.map((row) => row.sig).filter((sig) => /partner_offices|handshake_offers?\(|partner_founder_invitation|partner_invitation_request/.test(sig));
    expect(sigs).toHaveLength(10);
    for (const sig of sigs) {
      const entry = contract.functions.find((row) => row.sig === sig);
      for (const needle of entry.bodyContains) expect(migration, `${sig}: ${needle}`).toContain(needle);
    }
    for (const name of ["take_partner_invitation_request(uuid)", "note_partner_founder_invitation(uuid, uuid)", "finish_partner_invitation_request(uuid, text)", "deliver_standing_handshake_offers(text, text, uuid)"]) {
      expect(migration).toContain(`grant execute on function public.${name} to service_role;`);
    }
    expect(migration).not.toMatch(/grant [a-z, ]+ on (table )?private\./i);
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/standing-handshake-offers-db.test.js");
  });
});

const n = (suffix) => `50906672-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ID = {
  org: n(1), arrivingOrg: n(2),
  admin: n(101), member: n(102), arriving: n(103), reviewer: n(104),
  adminSession: n(201), memberSession: n(202), arrivingSession: n(203),
};
const CHAPTER = "standing-offer-proof";
const ARRIVING = "standing-offer-arriving";
const OFFICE = "standing-offer-office";
const OTHER_OFFICE = "standing-offer-office-elsewhere";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("standing handshake offers on a disposable database", () => {
  let db;
  const SESSION = { [ID.admin]: ID.adminSession, [ID.member]: ID.memberSession, [ID.arriving]: ID.arrivingSession };

  async function as(userId, sql, values = [], { aal = "aal2", role = "authenticated" } = {}) {
    await db.query("savepoint as_user");
    try {
      const claims = role === "service_role" ? { role } : { sub: userId, role, session_id: SESSION[userId], aal };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.query(`set local role ${role}`);
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role");
      await db.query("release savepoint as_user");
      return rows[0]?.data;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      throw error;
    }
  }
  let keys = 0;
  const key = () => n(900000 + (keys += 1));
  const offer = (office = OFFICE, overrides = {}) => as(ID.admin,
    "select public.create_chapter_handshake_offer($1,$2,$3,$4,$5,$6,$7) data",
    [overrides.hat ?? "admin", CHAPTER, office, overrides.title ?? "Shared training calendar", "Share our published training dates", "docs_only", overrides.key ?? key()],
    overrides.options);
  const office = async (id, state = "IL", name = "Riverside Transit Workers") => db.query(
    `insert into public.union_orgs(id,olms_file_number,name,affiliation,level,city,state,sector_tags,enrichment_status,atlas_manifest_sha)
     values ($1,$2,$3,'SYNTHETIC','local','Springfield',$4,array['transit'],'no_web_presence','standing-offer-proof')`,
    [id, 790000000 + (keys += 1), name, state]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "standing-handshake-offers-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    for (const id of [ID.admin, ID.member, ID.arriving, ID.reviewer]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `standing-${id.slice(-3)}@example.invalid`]);
    }
    for (const id of [ID.admin, ID.member, ID.arriving]) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [SESSION[id], id]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values (gen_random_uuid(),$1,'Standing offer proof','totp','verified',now(),now())", [id]);
    }
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,'standing-offer-proof','Standing offer proof',$3),($2,'standing-offer-arriving','Riverside Transit Workers',$4)", [ID.org, ID.arrivingOrg, ID.admin, ID.arriving]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,'Garage 7',$1,$3,false,9941),($2,'Riverside',$2,$4,false,9942)", [CHAPTER, ARRIVING, ID.org, ID.arrivingOrg]);
    for (const [user, org, chapter] of [[ID.admin, ID.org, CHAPTER], [ID.member, ID.org, CHAPTER], [ID.arriving, ID.arrivingOrg, ARRIVING]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user, chapter]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2),($3,$4,'admin',$4)", [ID.org, ID.admin, ID.arrivingOrg, ID.arriving]);
    await office(OFFICE);
    await office(OTHER_OFFICE, "WI", "Lakeshore Bus Drivers");
    // The reviewer is a platform operator; the arriving chapter's own
    // administrator is not.
    await db.query("insert into private.compass_platform_operators(user_id, granted_note) values ($1, 'standing offer proof operator')", [ID.reviewer]);
  }, 60_000);
  beforeEach(async () => { await db.query("savepoint offer_test"); });
  afterEach(async () => { await db.query("rollback to savepoint offer_test"); });
  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("lists offices not yet on the platform by name, never one with a verified chapter, and nothing unmatched without a profile state", async () => {
    const found = await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'Riverside',25) data", [CHAPTER]);
    expect(found.matchedOn).toBe("name");
    expect(found.rows).toEqual([expect.objectContaining({ unionOrgId: OFFICE, name: "Riverside Transit Workers", notOnPlatform: true, openOffer: null, invitationPending: false })]);
    expect(await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,null,25) data", [CHAPTER])).toEqual({ rows: [], matchedOn: "none", hasMore: false });
    // Every word must appear in the name, affiliation, designation, local number or city.
    const words = await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'synthetic springfield riverside',25) data", [CHAPTER]);
    expect(words.rows.map((row) => row.unionOrgId)).toEqual([OFFICE]);
    expect((await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'springfield nowhere',25) data", [CHAPTER])).rows).toEqual([]);
    // Pages: one row and a next page, then the second row and no more.
    const first = await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'springfield',1,0) data", [CHAPTER]);
    const second = await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'springfield',1,1) data", [CHAPTER]);
    expect([first.rows.length, first.hasMore, second.rows.length, second.hasMore]).toEqual([1, true, 1, false]);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.unionOrgId))).toEqual(new Set([OFFICE, OTHER_OFFICE]));
    // No offset ceiling: a page past the end is simply empty.
    expect(await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'springfield',25,5000) data", [CHAPTER])).toEqual({ rows: [], matchedOn: "name", hasMore: false });
    await expect(as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'x',25) data", [CHAPTER])).rejects.toMatchObject({ code: "22023" });
    await db.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by,verified_at) values ($1,$2,'verified',$3,now())", [ARRIVING, OFFICE, ID.arriving]);
    expect((await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'Riverside',25) data", [CHAPTER])).rows).toEqual([]);
  });

  it("keeps one open offer per office, at most ten per chapter, and refuses one to an office already on the platform", async () => {
    const created = await offer();
    expect(created).toMatchObject({ status: "open", idempotent: false });
    await expect(offer()).rejects.toMatchObject({ code: "23505" });
    for (let index = 0; index < 9; index += 1) {
      await office(`standing-offer-cap-${index}`, "IL", `Cap office ${index}`);
      await offer(`standing-offer-cap-${index}`);
    }
    await office("standing-offer-cap-x", "IL", "Cap office x");
    await expect(offer("standing-offer-cap-x")).rejects.toMatchObject({ code: "22023" });
    await db.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by,verified_at) values ($1,$2,'verified',$3,now())", [ARRIVING, OTHER_OFFICE, ID.arriving]);
    await db.query("update private.chapter_handshake_offers set status='withdrawn', withdrawn_at=now() where union_org_id like 'standing-offer-cap-%'");
    await expect(offer(OTHER_OFFICE)).rejects.toMatchObject({ code: "22023" });
  });

  it("is idempotent by key, lists the chapter's own offers, and lets the chapter withdraw them", async () => {
    const k = key();
    const first = await offer(OFFICE, { key: k });
    expect(await offer(OFFICE, { key: k })).toMatchObject({ id: first.id, idempotent: true });
    await expect(offer(OFFICE, { key: k, title: "Something else" })).rejects.toMatchObject({ code: "22023" });
    const listed = await as(ID.admin, "select public.list_chapter_handshake_offers('admin',$1) data", [CHAPTER]);
    expect(listed.offers).toEqual([expect.objectContaining({ id: first.id, officeName: "Riverside Transit Workers", status: "open" })]);
    expect(await as(ID.admin, "select public.withdraw_chapter_handshake_offer('admin',$1,$2) data", [CHAPTER, first.id])).toEqual({ id: first.id, status: "withdrawn" });
    await expect(as(ID.admin, "select public.withdraw_chapter_handshake_offer('admin',$1,$2) data", [CHAPTER, first.id])).rejects.toMatchObject({ code: "P0002" });
  });

  it("ranks same-state offices first and never lets an office with no state outrank them", async () => {
    await db.query("insert into private.chapter_connection_profiles(chapter_id, organization_id, location_country, location_state) values ($1, $2, 'US', 'IL')", [CHAPTER, ID.org]);
    await db.query(`insert into public.union_orgs(id,olms_file_number,name,affiliation,level,city,state,sector_tags,enrichment_status,atlas_manifest_sha)
      values ('standing-offer-stateless', 790099999, 'Riverside Unlocated', 'SYNTHETIC', 'local', 'Springfield', null, '{}', 'no_web_presence', 'standing-offer-proof')`);
    const ranked = await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,'riverside',25) data", [CHAPTER]);
    expect(ranked.rows.map((row) => [row.unionOrgId, row.sameState])).toEqual([[OFFICE, true], ["standing-offer-stateless", false]]);
    // With no search, the profile's state lists its offices.
    const byState = await as(ID.admin, "select public.list_partner_offices_not_on_platform('admin',$1,null,25) data", [CHAPTER]);
    expect(byState.matchedOn).toBe("state");
    expect(byState.rows.map((row) => row.unionOrgId)).toEqual([OFFICE]);
  });

  it("always lists every open offer, however much history follows it", async () => {
    const open = await offer();
    await db.query(`insert into private.chapter_handshake_offers
      (organization_id, chapter_id, union_org_id, title, purpose, data_scope, status, expires_at, idempotency_key, created_by, created_at, withdrawn_at)
      select $1, $2, $3, 'Old offer ' || g, 'History', 'docs_only', 'withdrawn', now() + interval '1 day', gen_random_uuid(), $4, now() + g * interval '1 second', now()
      from generate_series(1, 55) g`, [ID.org, CHAPTER, OTHER_OFFICE, ID.admin]);
    const listed = await as(ID.admin, "select public.list_chapter_handshake_offers('admin',$1) data", [CHAPTER]);
    expect(listed.offers).toHaveLength(51);
    expect(listed.offers.some((row) => row.id === open.id && row.status === "open")).toBe(true);
  });

  it("shows an expired offer as expired and frees its slot", async () => {
    const first = await offer();
    await db.query("update private.chapter_handshake_offers set expires_at = now() - interval '1 minute' where id = $1", [first.id]);
    expect((await as(ID.admin, "select public.list_chapter_handshake_offers('admin',$1) data", [CHAPTER])).offers[0].status).toBe("expired");
    expect(await offer()).toMatchObject({ status: "open" });
  });

  it("refuses a member, a staff hat for writes, and a call without two-step sign-in", async () => {
    await expect(as(ID.member, "select public.create_chapter_handshake_offer('admin',$1,$2,'t','p','docs_only',$3) data", [CHAPTER, OFFICE, key()])).rejects.toMatchObject({ code: "42501" });
    await expect(offer(OFFICE, { hat: "steward" })).rejects.toMatchObject({ code: "42501" });
    await expect(offer(OFFICE, { options: { aal: "aal1" } })).rejects.toMatchObject({ code: "42501" });
    await expect(as(ID.member, "select public.list_chapter_handshake_offers('admin',$1) data", [CHAPTER])).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps an invitation request for the operator only until it is decided", async () => {
    const created = await offer();
    const request = (overrides = {}) => as(ID.admin, "select public.request_partner_founder_invitation('admin',$1,$2,$3,$4,$5,'es',$6) data",
      [CHAPTER, overrides.office ?? OFFICE, overrides.offer ?? created.id, overrides.name ?? "Ana Ruiz", overrides.email ?? "Ana.Ruiz@Riverside.example", overrides.key ?? key()]);
    const asked = await request();
    expect(asked).toMatchObject({ status: "pending" });
    await expect(request()).rejects.toMatchObject({ code: "23505" });
    await expect(request({ office: OTHER_OFFICE, offer: null, email: "not-an-address" })).rejects.toMatchObject({ code: "22023" });
    const listed = await as(ID.admin, "select public.list_chapter_handshake_offers('admin',$1) data", [CHAPTER]);
    expect(JSON.stringify(listed)).not.toContain("riverside.example");
    await expect(as(ID.admin, "select public.take_partner_invitation_request($1) data", [asked.id])).rejects.toMatchObject({ code: "42501" });
    const taken = await as(null, "select public.take_partner_invitation_request($1) data", [asked.id], { role: "service_role" });
    expect(taken).toMatchObject({ contactName: "Ana Ruiz", contactEmail: "ana.ruiz@riverside.example", locale: "es", officeName: "Riverside Transit Workers", invitingChapter: "Garage 7", offerTitle: "Shared training calendar", onPlatform: false, invitationId: null });
    // The operator records the founder invitation it issued, so a rerun resends the latest one.
    const founder = await as(null, "select public.create_organization_founder_invitation('Riverside Transit Workers Proof','ana.ruiz@riverside.example','Ana Ruiz','es',$1,$2) data",
      ["a".repeat(64), asked.id], { role: "service_role" });
    expect(founder).toMatchObject({ status: "invited" });
    await expect(as(ID.admin, "select public.note_partner_founder_invitation($1,$2) data", [asked.id, founder.invitationId])).rejects.toMatchObject({ code: "42501" });
    await expect(as(null, "select public.note_partner_founder_invitation($1,$2) data", [asked.id, key()], { role: "service_role" })).rejects.toMatchObject({ code: "22023" });
    expect(await as(null, "select public.note_partner_founder_invitation($1,$2) data", [asked.id, founder.invitationId], { role: "service_role" })).toEqual({ id: asked.id, invitationId: founder.invitationId });
    expect(await as(null, "select public.take_partner_invitation_request($1) data", [asked.id], { role: "service_role" })).toMatchObject({ invitationId: founder.invitationId });
    // A resend whose replacement was never recorded is still the one found.
    const replaced = await as(null, "select public.resend_organization_founder_invitation($1,$2) data", [founder.invitationId, "b".repeat(64)], { role: "service_role" });
    expect(replaced).toMatchObject({ send: true });
    expect(replaced.invitationId).not.toBe(founder.invitationId);
    expect(await as(null, "select public.take_partner_invitation_request($1) data", [asked.id], { role: "service_role" })).toMatchObject({ invitationId: replaced.invitationId });
    // An expired offer is not advertised to the contact.
    await db.query("update private.chapter_handshake_offers set expires_at = now() - interval '1 minute' where id = $1", [created.id]);
    expect(await as(null, "select public.take_partner_invitation_request($1) data", [asked.id], { role: "service_role" })).toMatchObject({ offerTitle: null });
    expect(await as(null, "select public.finish_partner_invitation_request($1,'sent') data", [asked.id], { role: "service_role" })).toEqual({ id: asked.id, status: "sent" });
    const row = (await db.query("select contact_name, contact_email, status from private.chapter_partner_invitation_requests where id = $1", [asked.id])).rows[0];
    expect(row).toEqual({ contact_name: null, contact_email: null, status: "sent" });
    expect(await as(null, "select public.take_partner_invitation_request($1) data", [asked.id], { role: "service_role" })).toBeNull();
    const notes = (await db.query("select title from public.member_notifications where user_id = $1 and title like 'Partner invitation%'", [ID.admin])).rows;
    expect(notes).toEqual([{ title: "Partner invitation sent" }]);
  });

  it("withdraws an expired offer instead of delivering it when the office arrives", async () => {
    const created = await offer();
    await db.query("update private.chapter_handshake_offers set expires_at = now() - interval '1 minute' where id = $1", [created.id]);
    await db.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by) values ($1,$2,'requested',$3)", [ARRIVING, OFFICE, ID.arriving]);
    await as(null, "select public.verify_chapter_union_org_binding($1,$2,true,'',$3) data", [ARRIVING, OFFICE, ID.reviewer], { role: "service_role" });
    expect((await db.query("select count(*)::int n from public.chapter_handshakes where partner_org_id = $1", [OFFICE])).rows[0].n).toBe(0);
    expect((await db.query("select status from private.chapter_handshake_offers where id = $1", [created.id])).rows[0].status).toBe("withdrawn");
  });

  // The verified side-review P0: a tenant administrator could bind their own
  // chapter to an unclaimed catalogue office and verify that binding
  // themselves. That must not hand them the office's standing offers. Since
  // SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101 the
  // verifier refuses anyone but an operator, so such a binding exists only as
  // a row verified before that, written here directly.
  const verify = (verifier, office = OFFICE) => as(null, "select public.verify_chapter_union_org_binding($1,$2,true,'',$3) data", [ARRIVING, office, verifier], { role: "service_role" });
  const selfVerified = async (office = OFFICE) => {
    await expect(verify(ID.arriving, office)).rejects.toMatchObject({ code: "42501" });
    await db.query("update public.chapter_union_org_bindings set status = 'verified', verified_by = $2, verified_at = now() where chapter_id = $1 and union_org_id = $3", [ARRIVING, ID.arriving, office]);
  };
  const handshakesFor = async (office) => (await db.query("select count(*)::int n from public.chapter_handshakes where partner_org_id = $1", [office])).rows[0].n;
  const offerStatus = async (id) => (await db.query("select status from private.chapter_handshake_offers where id = $1", [id])).rows[0].status;

  it("delivers nothing on a binding the chapter's own administrator verified, and the offers stay open", async () => {
    const created = await offer();
    await db.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by) values ($1,$2,'requested',$3)", [ARRIVING, OFFICE, ID.arriving]);
    await selfVerified();
    expect((await db.query("select status, verified_by from public.chapter_union_org_bindings where chapter_id = $1", [ARRIVING])).rows[0]).toEqual({ status: "verified", verified_by: ID.arriving });
    expect(await handshakesFor(OFFICE)).toBe(0);
    expect(await offerStatus(created.id)).toBe("open");
    expect((await db.query("select count(*)::int n from public.member_notifications where user_id = $1 and title = 'Partnership request received'", [ID.arriving])).rows[0].n).toBe(0);
    // A revoked operator counts as no operator.
    await db.query("update private.compass_platform_operators set revoked_at = now() where user_id = $1", [ID.reviewer]);
    await expect(as(null, "select public.deliver_standing_handshake_offers($1,$2,$3) data", [ARRIVING, OFFICE, ID.reviewer], { role: "service_role" })).rejects.toMatchObject({ code: "42501" });
    await db.query("update private.compass_platform_operators set revoked_at = null where user_id = $1", [ID.reviewer]);
    // Only the service role, on behalf of an active operator, can deliver them.
    await expect(as(ID.arriving, "select public.deliver_standing_handshake_offers($1,$2,$3) data", [ARRIVING, OFFICE, ID.arriving])).rejects.toMatchObject({ code: "42501" });
    await expect(as(null, "select public.deliver_standing_handshake_offers($1,$2,$3) data", [ARRIVING, OFFICE, ID.arriving], { role: "service_role" })).rejects.toMatchObject({ code: "42501" });
    await expect(as(null, "select public.deliver_standing_handshake_offers($1,$2,$3) data", [ARRIVING, OTHER_OFFICE, ID.reviewer], { role: "service_role" })).rejects.toMatchObject({ code: "22023" });
    expect(await as(null, "select public.deliver_standing_handshake_offers($1,$2,$3) data", [ARRIVING, OFFICE, ID.reviewer], { role: "service_role" }))
      .toEqual({ chapterId: ARRIVING, unionOrgId: OFFICE, delivered: 1 });
    expect(await offerStatus(created.id)).toBe("delivered");
    const handshake = (await db.query("select chapter_id, receiving_chapter_id, status, requested_by from public.chapter_handshakes where partner_org_id = $1", [OFFICE])).rows;
    expect(handshake).toEqual([{ chapter_id: CHAPTER, receiving_chapter_id: ARRIVING, status: "requested", requested_by: ID.admin }]);
    // A second call finds nothing open.
    expect(await as(null, "select public.deliver_standing_handshake_offers($1,$2,$3) data", [ARRIVING, OFFICE, ID.reviewer], { role: "service_role" })).toMatchObject({ delivered: 0 });
  });

  it("delivers nothing when a self-verified binding is re-pointed at another office", async () => {
    const first = await offer();
    const second = await offer(OTHER_OFFICE, { title: "Second office offer" });
    await db.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by) values ($1,$2,'requested',$3)", [ARRIVING, OFFICE, ID.arriving]);
    await selfVerified();
    // The same upsert public.request_chapter_union_org_binding performs.
    await db.query(`update public.chapter_union_org_bindings set union_org_id = $2, status = 'requested', requested_by = $3,
      requested_at = clock_timestamp(), verified_by = null, verified_at = null, public_note = '' where chapter_id = $1`, [ARRIVING, OTHER_OFFICE, ID.arriving]);
    await selfVerified(OTHER_OFFICE);
    expect([await handshakesFor(OFFICE), await handshakesFor(OTHER_OFFICE)]).toEqual([0, 0]);
    expect([await offerStatus(first.id), await offerStatus(second.id)]).toEqual(["open", "open"]);
    // The first office's binding is gone, so an operator cannot deliver it there.
    await expect(as(null, "select public.deliver_standing_handshake_offers($1,$2,$3) data", [ARRIVING, OFFICE, ID.reviewer], { role: "service_role" })).rejects.toMatchObject({ code: "22023" });
    // An operator who re-verifies the current office delivers only its offer.
    await db.query(`update public.chapter_union_org_bindings set status = 'requested', verified_by = null, verified_at = null where chapter_id = $1`, [ARRIVING]);
    await verify(ID.reviewer, OTHER_OFFICE);
    expect([await offerStatus(first.id), await offerStatus(second.id)]).toEqual(["open", "delivered"]);
  });

  it("turns open offers into a waiting handshake request when the office's chapter is verified, and accepts nothing", async () => {
    const created = await offer();
    await db.query("insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by) values ($1,$2,'requested',$3)", [ARRIVING, OFFICE, ID.arriving]);
    expect((await db.query("select count(*)::int n from public.chapter_handshakes where partner_org_id = $1", [OFFICE])).rows[0].n).toBe(0);
    // The operator's verification runs with the service credential and no
    // member identity, as the verification API calls it.
    await as(null, "select public.verify_chapter_union_org_binding($1,$2,true,'',$3) data", [ARRIVING, OFFICE, ID.reviewer], { role: "service_role" });
    const handshake = (await db.query("select chapter_id, receiving_chapter_id, status, requested_by, title, data_scope from public.chapter_handshakes where partner_org_id = $1", [OFFICE])).rows;
    expect(handshake).toEqual([{ chapter_id: CHAPTER, receiving_chapter_id: ARRIVING, status: "requested", requested_by: ID.admin, title: "Shared training calendar", data_scope: "docs_only" }]);
    const stored = (await db.query("select status, delivered_handshake_id is not null delivered, delivering_txid from private.chapter_handshake_offers where id = $1", [created.id])).rows[0];
    expect(stored).toEqual({ status: "delivered", delivered: true, delivering_txid: null });
    const arrivingNotes = (await db.query("select title from public.member_notifications where user_id = $1", [ID.arriving])).rows.map((row) => row.title);
    expect(arrivingNotes).toContain("Partnership request received");
    const offeringNotes = (await db.query("select title from public.member_notifications where user_id = $1", [ID.admin])).rows.map((row) => row.title);
    expect(offeringNotes).toContain("Standing offer delivered");
    // The arriving chapter answers with the existing respond routine.
    const handshakeId = (await db.query("select id from public.chapter_handshakes where partner_org_id = $1", [OFFICE])).rows[0].id;
    const answered = await as(ID.arriving, "select public.respond_chapter_handshake($1,'accept',$2) data", [handshakeId, key()]);
    expect(answered).toMatchObject({ status: "accepted" });
  });
});
