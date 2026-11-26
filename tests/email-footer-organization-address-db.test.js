// @vitest-environment node
//
// BUG-UG-LOCAL-PROFILE-IS-READ-BY-NOTHING-AND-EVERY-UNION-SHARES-ONE-FOOTER-ADDRESS-20261122
// (#9507) on a disposable database, inside one rolled-back transaction. Two
// fictional organizations with two different office addresses each get their
// own address back from the notification claim and from the engagement
// payload; a member of both gets each notice with its own organization's
// address; an organization with none on file, and a notice that names no
// organization, get the key with a null value, never another's address. Push
// rows carry no address.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const ALDER = "1 Alder Way\nFictionville, ST 00001";
const BIRCH = "2 Birch Road, Exampletown, ST 00002";

live("email footer address of the sending organization, on a disposable database", () => {
  let db;
  const ID = { admin: randomUUID(), alder: randomUUID(), birch: randomUUID(), bare: randomUUID() };
  const MEMBER = { alder: randomUUID(), birch: randomUUID(), bare: randomUUID(), none: randomUUID(), dual: randomUUID() };
  const q = (sql, values = []) => db.query(sql, values);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "email-footer-organization-address-proof" });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout = '120s'");
    await q("update private.notification_controls set outbound_enabled = true where id");
    // Keep every other claimable row out of these claims.
    await q("update public.member_notification_deliveries set next_attempt_at = now() + interval '1 day' where status = 'pending'");
    await q("update public.engagement_delivery_outbox set available_at = now() + interval '1 day' where state in ('queued','failed','leased')");
    for (const id of [ID.admin, ...Object.values(MEMBER)]) {
      await q("insert into auth.users(id,email,created_at) values ($1,$2,now())", [id, `${id}@footer.invalid`]);
    }
    for (const name of ["alder", "birch", "bare"]) {
      await q("insert into public.organizations(id,slug,name,created_by,is_fictional) values ($1,$2,$3,$4,true)",
        [ID[name], `footer-${name}-${ID[name].slice(0, 8)}`, `Footer proof ${name} ${ID[name].slice(0, 8)}`, ID.admin]);
      await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ID[name], MEMBER[name]]);
    }
    // A member of both Alder and Birch.
    for (const organization of [ID.alder, ID.birch]) {
      await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [organization, MEMBER.dual]);
    }
    await q("insert into private.organization_local_profiles(organization_id, office_address) values ($1,$2), ($3,$4)", [ID.alder, ALDER, ID.birch, BIRCH]);
    // The bare organization has a profile with no address on file.
    await q("insert into private.organization_local_profiles(organization_id, employer) values ($1, 'Fictional Transit Authority')", [ID.bare]);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await q("rollback").catch(() => {});
      await db.end();
    }
  });

  it("gives each email row its own organization's address, and null for none on file or no organization", async () => {
    await q("savepoint claim_email");
    const notices = {};
    // The member of two organizations gets one notice from each.
    for (const [name, organization, member] of [["alder", ID.alder, MEMBER.alder], ["birch", ID.birch, MEMBER.birch], ["bare", ID.bare, MEMBER.bare], ["none", null, MEMBER.none], ["dualAlder", ID.alder, MEMBER.dual], ["dualBirch", ID.birch, MEMBER.dual]]) {
      notices[name] = randomUUID();
      await q("insert into public.member_notifications(id,user_id,title,body,kind,organization_id) values ($1,$2,'Fictional proof','Fictional proof','events',$3)",
        [notices[name], member, organization]);
      for (const channel of ["email", "push"]) {
        await q("insert into public.member_notification_deliveries(notification_id,user_id,channel) values ($1,$2,$3) on conflict (notification_id, channel) do nothing",
          [notices[name], member, channel]);
      }
      await q("update public.member_notification_deliveries set next_attempt_at = now() where notification_id = $1", [notices[name]]);
    }
    await q("set local role service_role");
    const email = (await q("select public.claim_notification_deliveries('email', 50) as rows")).rows[0].rows;
    const push = (await q("select public.claim_notification_deliveries('push', 50) as rows")).rows[0].rows;
    await q("reset role");
    const deliveryOf = async (name, channel) => (await q("select id from public.member_notification_deliveries where notification_id = $1 and channel = $2", [notices[name], channel])).rows[0].id;
    const emailRow = async (name) => {
      const id = await deliveryOf(name, "email");
      return email.find((row) => row.deliveryId === id);
    };
    const alder = await emailRow("alder");
    const birch = await emailRow("birch");
    const bare = await emailRow("bare");
    const none = await emailRow("none");
    expect(alder.postalAddress).toBe(ALDER);
    expect(birch.postalAddress).toBe(BIRCH);
    // Each notice carries its producing organization's address, not the member's other one.
    expect((await emailRow("dualAlder")).postalAddress).toBe(ALDER);
    expect((await emailRow("dualBirch")).postalAddress).toBe(BIRCH);
    for (const row of [bare, none]) {
      expect(Object.hasOwn(row, "postalAddress")).toBe(true);
      expect(row.postalAddress).toBeNull();
    }
    const pushIds = new Set(await Promise.all(["alder", "birch"].map((name) => deliveryOf(name, "push"))));
    for (const row of push.filter((entry) => pushIds.has(entry.deliveryId))) expect(row.postalAddress ?? null).toBeNull();
    await q("rollback to savepoint claim_email");
  });

  it("gives each engagement payload its own organization's address, and null for none on file", async () => {
    await q("savepoint payload");
    const lease = randomUUID();
    const rows = {};
    for (const name of ["alder", "birch", "bare"]) {
      rows[name] = randomUUID();
      await q(`insert into public.engagement_delivery_outbox(id,organization_id,recipient_user_id,delivery_kind,source_kind,source_id,locale,
          subject_snapshot,body_snapshot,action_path_snapshot,state,lease_token,lease_expires_at)
        values ($1,$2::uuid,$3,'welcome','first_signin_welcome',$2::text,'en','Welcome','Fictional welcome.','/m','leased',$4,now() + interval '5 minutes')`,
      [rows[name], ID[name], MEMBER[name], lease]);
    }
    await q("set local role service_role");
    const payload = async (name) => (await q("select public.get_engagement_delivery_payload($1,$2) p", [rows[name], lease])).rows[0].p;
    const alder = await payload("alder");
    const birch = await payload("birch");
    const bare = await payload("bare");
    await q("reset role");
    for (const entry of [alder, birch, bare]) expect(entry).toMatchObject({ available: true, category: "welcome" });
    expect(alder.postalAddress).toBe(ALDER);
    expect(birch.postalAddress).toBe(BIRCH);
    expect(Object.hasOwn(bare, "postalAddress")).toBe(true);
    expect(bare.postalAddress).toBeNull();
    await q("rollback to savepoint payload");
  });
});
