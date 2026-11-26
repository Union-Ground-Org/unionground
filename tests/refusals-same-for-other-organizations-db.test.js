// @vitest-environment node
//
// SEC-UG-NON-INTERFERENCE-REFUSALS-REVEAL-OTHER-ORGANIZATIONS-OBJECTS-20261111
// (#8365) on a disposable database. Given the id of another organization's
// object, each group of functions refuses exactly as for an id that does not
// exist. The leak guard (tests/non-interference-db.test.js) proves the
// answers no longer change with a neighbour; this file pins one function of
// each group by name.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseGraphWrappedSource, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { beforeSameRefusals, SAME_REFUSALS_MIGRATION } from "./helpers/refusals-same-for-other-organizations.js";
import {
  as, createRecord, expectRefusal, hideChapter, invite, onboardedPartner, rpc, saveConnectionProfile, verifiedOrg, withClient,
} from "./helpers/openSignupOrganization.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("refusals for objects of other organizations on a disposable database", () => {
  let client;
  const sessions = new Map();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "refusals-same-for-other-organizations-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function inTransaction(body) {
    await client.query("begin");
    try {
      return await body();
    } finally {
      await client.query("rollback");
    }
  }

  async function organization(label) {
    const org = randomUUID();
    const chapter = `${label}-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `${label}-${org}`, `Fictional ${label}`]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$2,$1,'proof',$3,9971)",
      [chapter, `Fictional ${label} chapter`, org]);
    return { org, chapter };
  }

  async function person(t, label, { orgRoles = [], chapterRoles = [] } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email,created_at) values ($1,$2,now() - interval '30 days')", [id, `${id}@same-refusal.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, t.chapter, `Fictional ${label}`]);
    await client.query("insert into public.organization_memberships(user_id,organization_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.org]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.chapter]);
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    sessions.set(id, session);
    for (const role of orgRoles) {
      await client.query("insert into public.organization_role_grants(user_id,organization_id,role) values ($1,$2,$3)", [id, t.org, role]);
    }
    for (const role of chapterRoles) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [id, role, t.chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, t.chapter]);
    }
    return id;
  }

  // One statement as the given account, inside a savepoint so a refusal leaves
  // the transaction usable.
  async function as(userId, statement, args = []) {
    await client.query("savepoint cell");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: sessions.get(userId) })]);
      await client.query("set local role authenticated");
      const result = await client.query(statement, args);
      await client.query("reset role");
      await client.query("release savepoint cell");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      await client.query("reset role");
      return { ok: false, code: error.code || "", message: error.message || "" };
    }
  }

  // A coordinator and organization admin in one organization; a member with a
  // case in another.
  async function twoOrganizations() {
    const own = await organization("own");
    const other = await organization("other");
    const caller = await person(own, "Coordinator", { orgRoles: ["admin"], chapterRoles: ["coordinator", "steward"] });
    const member = await person(other, "Other Member");
    const caseId = randomUUID();
    await client.query(
      "insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,created_at) values ($1,$2,$3,$4,$5,'Fictional case','Other',now())",
      [caseId, member, other.org, other.chapter, `SAME-${caseId.slice(0, 8)}`]);
    return { own, other, caller, caseId };
  }

  async function sameRefusal(caller, statement, missingArgs, otherArgs) {
    const missing = await as(caller, statement, missingArgs);
    const other = await as(caller, statement, otherArgs);
    expect(missing.ok).toBe(false);
    expect(other).toEqual(missing);
    return missing;
  }

  it("a strict lookup refuses another organization's case as a missing one", async () => {
    await inTransaction(async () => {
      const t = await twoOrganizations();
      const result = await sameRefusal(t.caller, "select public.casework_create_alert($1,'deadline','high','Fictional alert')",
        [randomUUID()], [t.caseId]);
      expect(result).toMatchObject({ code: "P0002", message: "case not found" });
    });
  });

  it("the coordinator helper refuses another organization's case as a missing one", async () => {
    await inTransaction(async () => {
      const t = await twoOrganizations();
      const result = await sameRefusal(t.caller, "select public.coordinator_add_case_note($1,'Fictional note')", [randomUUID()], [t.caseId]);
      expect(result).toMatchObject({ code: "42501", message: "case unavailable" });
    });
  });

  it("assigning a case refuses another organization's case as a missing one", async () => {
    await inTransaction(async () => {
      const t = await twoOrganizations();
      const result = await sameRefusal(t.caller, "select public.assign_member_case($1,null,null)", [randomUUID()], [t.caseId]);
      expect(result).toMatchObject({ code: "P0002", message: "case not found" });
    });
  });

  it("a coordination partner the caller cannot see is refused as a missing one", async () => {
    await inTransaction(async () => {
      const t = await twoOrganizations();
      const result = await sameRefusal(t.caller,
        "select public.create_organization_coordination_record('network_link','Fictional link','','staff',$1)", [randomUUID()], [t.other.org]);
      expect(result).toMatchObject({ code: "22023", message: "partner organization unavailable" });
    });
  });
});

describe("refusals for objects of other organizations (static)", () => {
  // Each body is the live definition with only #8365's edits, so undoing them
  // gives the body the migrations before it installed: no later rewrite is lost.
  it("re-emits 17 bodies that differ from their predecessors only by the same-refusal edits", () => {
    const functions = readMigrationFunctions(fileURLToPath(new URL("../supabase/migrations/", import.meta.url)));
    const ours = functions.historical.filter((fn) => fn.file === SAME_REFUSALS_MIGRATION);
    expect(ours).toHaveLength(17);
    for (const fn of ours) {
      const before = functions.historical.filter((entry) => entry.name === fn.name && entry.file < SAME_REFUSALS_MIGRATION).at(-1);
      // The coordination record's latest migration text predates the case
      // graph wrapper that 20260907151000 installs over it.
      const expected = fn.name === "public.create_organization_coordination_record" ? caseGraphWrappedSource(before.source) : before.source;
      expect(beforeSameRefusals(fn.name, fn.source), fn.name).toBe(expected);
      expect(fn.source, fn.name).not.toMatch(/\binto\s+strict\b/i);
    }
  });
});

live("partners and snapshot tokens follow what the caller can see (gate round 1)", () => {
  it("lets an accepted coalition participant create a campaign under the coalition, with the owner inferred as partner", () => withClient(async (c) => {
    const host = await verifiedOrg(c);
    const guest = await verifiedOrg(c);
    await as(c, host.admin);
    const coalition = await rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4)", ["coalition", "Example coalition", "", "participants"]);
    await invite(c, coalition.id, guest.org);
    await as(c, guest.admin);
    await rpc(c, "public.respond_organization_coordination_participant($1,$2,$3)", [coalition.id, true, randomUUID()]);
    // Naming the host outright is accepted, before any record links the two
    // organizations; an unknown partner under the same parent is not.
    const named = await rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4,$5,$6)",
      ["coalition_campaign", "Example named campaign", "", "participants", host.org, coalition.id]);
    expect(named).toMatchObject({ kind: "coalition_campaign", organizationId: guest.org });
    // Taking the host from the coalition is accepted as well.
    const campaign = await rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4,$5,$6)",
      ["coalition_campaign", "Example campaign", "", "participants", null, coalition.id]);
    expect(campaign).toMatchObject({ kind: "coalition_campaign", organizationId: guest.org });
    await expectRefusal(rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4,$5,$6)",
      ["coalition_campaign", "Example unknown campaign", "", "participants", randomUUID(), coalition.id]), "22023", "partner organization unavailable");
    // An unknown partner named outright is still refused.
    await expectRefusal(createRecord(c, "network_link", randomUUID()), "22023", "partner organization unavailable");
  }));

  it("accepts a coalition host as partner without a parent, for an accepted participant", () => withClient(async (c) => {
    const host = await verifiedOrg(c);
    const guest = await verifiedOrg(c);
    await as(c, host.admin);
    const coalition = await rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4)", ["coalition", "Example coalition", "", "participants"]);
    await invite(c, coalition.id, guest.org);
    await as(c, guest.admin);
    await rpc(c, "public.respond_organization_coordination_participant($1,$2,$3)", [coalition.id, true, randomUUID()]);
    // No parent named: the coalition the guest joined already shows it the host.
    expect(await createRecord(c, "network_link", host.org)).toMatchObject({ kind: "network_link", status: "requested" });
  }));

  // #8775: the coalition owner may name an organization that accepted its
  // coalition; one that was only invited, declined or removed reads as missing.
  it("lets a coalition owner name an accepted participant as partner, and refuses invited, declined, removed and unrelated ones as missing (#8775)", () => withClient(async (c) => {
    const host = await verifiedOrg(c);
    const accepted = await verifiedOrg(c);
    const invited = await verifiedOrg(c);
    const declined = await verifiedOrg(c);
    const removed = await verifiedOrg(c);
    const stranger = await verifiedOrg(c);
    await as(c, host.admin);
    const coalition = await rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4)", ["coalition", "Example coalition", "", "participants"]);
    for (const guest of [accepted, invited, declined, removed]) await invite(c, coalition.id, guest.org);
    await as(c, accepted.admin);
    await rpc(c, "public.respond_organization_coordination_participant($1,$2,$3)", [coalition.id, true, randomUUID()]);
    await as(c, declined.admin);
    await rpc(c, "public.respond_organization_coordination_participant($1,$2,$3)", [coalition.id, false, randomUUID()]);
    await as(c, removed.admin);
    await rpc(c, "public.respond_organization_coordination_participant($1,$2,$3)", [coalition.id, true, randomUUID()]);
    await c.query("update public.organization_coordination_organization_participants set status='revoked' where record_id=$1 and organization_id=$2", [coalition.id, removed.org]);
    const statuses = (await c.query(
      "select organization_id, status from public.organization_coordination_organization_participants where record_id=$1", [coalition.id])).rows;
    expect(Object.fromEntries(statuses.map((row) => [row.organization_id, row.status]))).toEqual({
      [host.org]: "active", [accepted.org]: "active", [invited.org]: "invited", [declined.org]: "declined", [removed.org]: "revoked",
    });
    await as(c, host.admin);
    expect(await createRecord(c, "network_link", accepted.org)).toMatchObject({ kind: "network_link", status: "requested", organizationId: host.org });
    const missing = await expectRefusal(createRecord(c, "network_link", randomUUID()), "22023", "partner organization unavailable");
    for (const other of [invited, declined, removed, stranger]) {
      const refusal = await expectRefusal(createRecord(c, "network_link", other.org), "22023", "partner organization unavailable");
      expect({ code: refusal.code, message: refusal.message, detail: refusal.detail, hint: refusal.hint })
        .toEqual({ code: missing.code, message: missing.message, detail: missing.detail, hint: missing.hint });
    }
    // Another organization's coalition does not make its participants known to this one.
    await as(c, stranger.admin);
    await expectRefusal(createRecord(c, "network_link", accepted.org), "22023", "partner organization unavailable");
  }));

  it("refuses an existing organization the caller cannot see under a parent that has no partner", () => withClient(async (c) => {
    const host = await verifiedOrg(c);
    const stranger = await verifiedOrg(c);
    await as(c, host.admin);
    const coalition = await rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4)", ["coalition", "Example coalition", "", "participants"]);
    // The coalition has no partner, so a comparison with it must not turn
    // into a pass: the stranger reads as a missing organization.
    await expectRefusal(rpc(c, "public.create_organization_coordination_record($1,$2,$3,$4,$5,$6)",
      ["coalition_campaign", "Example stranger campaign", "", "participants", stranger.org, coalition.id]), "22023", "partner organization unavailable");
  }));

  it("moves the snapshot token only when the rows the caller can see change", () => withClient(async (c) => {
    const viewer = await verifiedOrg(c);
    const [shown, hidden, expired, unseen] = [await onboardedPartner(c, 11), await onboardedPartner(c, 12), await onboardedPartner(c, 13), await onboardedPartner(c, 14)];
    for (const org of [shown, hidden, expired, unseen]) {
      await as(c, org.admin);
      await saveConnectionProfile(c, org.chapter, true);
    }
    // Published 182 days ago, so it expired two days ago.
    await c.query("update private.chapter_connection_profiles set published_at = now() - interval '182 days', expires_at = now() - interval '2 days' where chapter_id = $1", [expired.chapter]);
    // The unseen organization is fictional, so the viewer never sees it.
    await c.query("update public.organizations set is_fictional = true where id = $1", [unseen.org]);
    await as(c, viewer.admin);
    await hideChapter(c, viewer.chapter, hidden.chapter);
    const snapshot = async () => {
      await as(c, viewer.admin);
      const answer = await rpc(c, "public.list_chapter_connection_profiles($1,$2,$3,$4,$5)", ["admin", null, 500, null, viewer.chapter]);
      return { epoch: answer.snapshotToken.split(":")[0], rows: answer.rows.map((row) => row.id) };
    };
    const before = await snapshot();
    expect(before.rows).toContain(shown.chapter);
    for (const chapter of [hidden.chapter, expired.chapter, unseen.chapter]) expect(before.rows).not.toContain(chapter);
    const edit = (chapter) => c.query("update private.chapter_connection_profiles set location_metro = 'Worcester' where chapter_id = $1", [chapter]);
    // A hidden profile, an expired one and an invisible chapter's incoming
    // hide change nothing the viewer can observe.
    await edit(hidden.chapter);
    await edit(expired.chapter);
    await c.query("insert into private.chapter_connection_hides(chapter_id,hidden_chapter_id,organization_id) values ($1,$2,$3)", [unseen.chapter, viewer.chapter, unseen.org]);
    expect(await snapshot()).toEqual(before);
    // Control: editing a profile the viewer sees moves the token.
    await edit(shown.chapter);
    const after = await snapshot();
    expect(after.rows).toEqual(before.rows);
    expect(after.epoch).not.toBe(before.epoch);
  }));

  it("refuses an expired token as expired whatever changed after its snapshot", () => withClient(async (c) => {
    const viewer = await verifiedOrg(c);
    const lapsed = await onboardedPartner(c, 15);
    await as(c, lapsed.admin);
    await saveConnectionProfile(c, lapsed.chapter, true);
    // Expired an hour ago, so it was listed two hours ago.
    await c.query("update private.chapter_connection_profiles set published_at = now() - interval '180 days 1 hour', expires_at = now() - interval '1 hour' where chapter_id = $1", [lapsed.chapter]);
    await as(c, viewer.admin);
    const list = (token) => rpc(c, "public.list_chapter_connection_profiles($1,$2,$3,$4,$5)", ["admin", null, 500, token, viewer.chapter]);
    const [epoch, at, scope] = (await list(null)).snapshotToken.split(":");
    const stale = [epoch, String(Number(at) - 7200), scope].join(":");
    await expectRefusal(list(stale), "22023", "connection registry snapshot expired");
    // Removing the lapsed profile changes nothing the viewer can see now.
    await c.query("delete from private.chapter_connection_profiles where chapter_id = $1", [lapsed.chapter]);
    await expectRefusal(list(stale), "22023", "connection registry snapshot expired");
  }));
});
