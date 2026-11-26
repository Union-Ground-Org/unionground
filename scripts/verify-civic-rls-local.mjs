#!/usr/bin/env node
// Transaction-only local proof for the civic resolver port
// (supabase/migrations/20260922210000..20260922210600). It replays the
// standalone repo's RLS scenarios (civic-data-resolver tests/test_member_app_rls.py,
// test_local_officials.py, test_places.py and the DB half of test_state_bills.py)
// against the host seam: the "org" is a chapter, officers are resolved through
// the host's tenant-scoped role helpers, and every table carries the
// mfa_assurance floor. Every fictional organization, identity and row is
// rolled back. Loopback targets only.
//
//   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres \
//     node scripts/verify-civic-rls-local.mjs

import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { siblingIdentityIn } from "./lib/sibling-deny-list.mjs";

const url = requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] });
function assert(condition, message) { if (!condition) throw new Error(message); }
assertDisposableProofUrl(url);
for (const forbidden of ["supabase.co", ...siblingIdentityIn(url)]) {
  assert(!url.includes(forbidden), `Refusing target containing ${forbidden}`);
}

const ids = {
  org: "50978000-0000-4000-8000-000000000001",
  otherOrg: "50978000-0000-4000-8000-000000000002",
  alice: "50978000-0000-4000-8000-000000000011",
  bob: "50978000-0000-4000-8000-000000000012",
  officer: "50978000-0000-4000-8000-000000000013",
  orgAdmin: "50978000-0000-4000-8000-000000000014",
  outsider: "50978000-0000-4000-8000-000000000015",
  outsiderMember: "50978000-0000-4000-8000-000000000016",
  // Selected chapter SISTER, plus an ACTIVE secondary membership in LOCAL.
  carol: "50978000-0000-4000-8000-000000000017",
  // Selected chapter SISTER, plus a REVOKED membership in LOCAL.
  dan: "50978000-0000-4000-8000-000000000018",
};
const LOCAL = "civic-proof-a";
const SISTER = "civic-proof-a2";
const OTHER = "civic-proof-b";
const sessions = Object.fromEntries(Object.keys(ids).map((key, index) =>
  [key, `50978000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`]));
const client = new pg.Client({ connectionString: url, application_name: "civic-rls-rollback-proof" });
const checks = [];

async function as(user, { mfa = true } = {}) {
  await client.query("reset role");
  if (!user) {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await client.query("set local role anon");
    return;
  }
  const claims = { sub: ids[user], role: "authenticated", aal: "aal2" };
  if (mfa) claims.session_id = sessions[user];
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query("set local role authenticated");
}
async function asOwner() {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', '', true)");
}
async function rows(sql, values = []) { return (await client.query(sql, values)).rows; }
async function expectState(label, sql, values, state) {
  const point = `civic_${checks.length}`;
  await client.query(`savepoint ${point}`);
  try {
    await client.query(sql, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected SQLSTATE ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${point}`);
    await client.query(`release savepoint ${point}`);
  }
  checks.push(label);
}
function pass(label) { checks.push(label); }

const insertAddress = `insert into public.civic_member_addresses
  (user_id, full_name, line1, line2, city, state, postal_code, consent_version)
  values ($1, $2, $3, $4, $5, $6, $7, '2026-09')`;
const address = (user, over = {}) => {
  const a = { full_name: "Alice Member", line1: "1600 Pennsylvania Ave NW", line2: "Apt 2", city: "Washington", state: "DC", postal_code: "20500", ...over };
  return [ids[user], a.full_name, a.line1, a.line2, a.city, a.state, a.postal_code];
};
const insertCampaign = `insert into public.civic_campaigns (org_id, title, topic, status, created_by)
  values ($1, 'Safe staffing', 'Staffing ratios', $2, $3) returning id`;
const insertMessage = `insert into public.civic_member_messages
  (campaign_id, user_id, official_key, official_name, office, channel, status, body)
  values ($1, $2, 'bioguide:X000001', 'Rep X', 'U.S. Representative', 'email', $3, 'my own words') returning id`;
const insertMessageTo = `insert into public.civic_member_messages
  (campaign_id, user_id, official_key, official_name, office, channel, status, body)
  values ($1, $2, $3, 'Someone', 'Some office', 'email', 'drafted', 'my own words') returning id`;
const insertRating = `insert into public.civic_official_ratings (org_id, official_key, official_name, office, cycle, grade, published)
  values ($1, $2, 'Rep X', 'U.S. Representative', '2026', $3, $4)`;

try {
  await client.connect();
  await client.query("begin");
  await client.query("select pg_catalog.pg_advisory_xact_lock(509, 78000)");

  // ---------------------------------------------------------------- fixtures
  const everyone = Object.keys(ids).filter((key) => !["org", "otherOrg"].includes(key));
  for (const key of everyone) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [ids[key], `civic-${key}@example.invalid`]);
    await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [sessions[key], ids[key]]);
  }
  await client.query(`insert into public.organizations (id, slug, name, created_by) values
    ($1, 'civic-proof-a', 'Civic Proof A', $3), ($2, 'civic-proof-b', 'Civic Proof B', $4)`,
  [ids.org, ids.otherOrg, ids.orgAdmin, ids.outsider]);
  await client.query(`insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
    ($1, 'Civic Local A', 'civic-proof-a', true, 1, $4),
    ($2, 'Civic Sister A2', 'civic-proof-a2', false, 2, $4),
    ($3, 'Civic Local B', 'civic-proof-b', true, 1, $5)`, [LOCAL, SISTER, OTHER, ids.org, ids.otherOrg]);
  const home = { alice: LOCAL, bob: LOCAL, officer: LOCAL, orgAdmin: SISTER, outsider: OTHER, outsiderMember: OTHER, carol: SISTER, dan: SISTER };
  for (const [key, chapter] of Object.entries(home)) {
    const org = chapter === OTHER ? ids.otherOrg : ids.org;
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [org, ids[key]]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ids[key], chapter]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [ids[key], chapter]);
  }
  await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ids.carol, LOCAL]);
  await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status, revoked_at) values ($1, $2, 'revoked', now())", [ids.dan, LOCAL]);
  // A chapter-scoped steward hat in LOCAL, and organization-wide admin hats.
  await client.query("insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $1)", [ids.officer, LOCAL]);
  await client.query("insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $1)", [ids.officer, LOCAL]);
  await client.query(`insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values
    ($1, $3, 'admin', $3), ($2, $4, 'admin', $4)`, [ids.org, ids.otherOrg, ids.orgAdmin, ids.outsider]);
  await client.query(`insert into public.org_security_policy (id, organization_id, require_staff_mfa) values
    (true, $1, false), (true, $2, false)`, [ids.org, ids.otherOrg]);

  // ------------------------------------------------------------- the seam
  await as("alice");
  let orgs = await rows("select * from public.civic_my_orgs()");
  assert(JSON.stringify(orgs) === JSON.stringify([{ org_id: LOCAL, org_name: "Civic Local A", role: "member" }]), `alice orgs: ${JSON.stringify(orgs)}`);
  await as("officer");
  orgs = await rows("select * from public.civic_my_orgs()");
  assert(JSON.stringify(orgs) === JSON.stringify([{ org_id: LOCAL, org_name: "Civic Local A", role: "officer" }]), `officer orgs: ${JSON.stringify(orgs)}`);
  await as("orgAdmin");
  orgs = await rows("select * from public.civic_my_orgs()");
  assert(orgs.length === 2 && orgs[0].org_id === SISTER && orgs.every((o) => o.role === "officer")
    && orgs.some((o) => o.org_id === LOCAL), `org-wide admin orgs: ${JSON.stringify(orgs)}`);
  await as("outsider");
  orgs = await rows("select * from public.civic_my_orgs()");
  assert(JSON.stringify(orgs) === JSON.stringify([{ org_id: OTHER, org_name: "Civic Local B", role: "officer" }]),
    `another organization's admin must never reach this organization's chapters: ${JSON.stringify(orgs)}`);
  assert((await rows("select public.civic_is_org_officer($1) v", [LOCAL]))[0].v === false, "cross-tenant officer check must be false");
  pass("civic_my_orgs: member, chapter officer, org-wide officer, and cross-tenant isolation");
  // A suspended or archived organization takes its chapters' civic access
  // with it, exactly as the host's tenant rule does; restoring it restores them.
  for (const status of ["archived", "suspended"]) {
    await asOwner();
    await client.query("update public.organizations set status = $2 where id = $1", [ids.org, status]);
    await as("alice");
    assert((await rows("select * from public.civic_my_orgs()")).length === 0, `${status} organization: civic_my_orgs must list nothing`);
    assert((await rows("select public.civic_is_org_member($1) m", [LOCAL]))[0].m === false, `${status} organization: not a member`);
    await as("officer");
    assert((await rows("select public.civic_is_org_officer($1) o", [LOCAL]))[0].o === false, `${status} organization: not an officer`);
    await expectState(`${status} organization: officer cannot create a campaign`, "insert into public.civic_campaigns (org_id, title, topic, status, created_by) values ($1, 'Frozen', 'Frozen', 'draft', $2)", [LOCAL, ids.officer], "42501");
  }
  await asOwner();
  await client.query("update public.organizations set status = 'active' where id = $1", [ids.org]);
  await as("alice");
  assert((await rows("select public.civic_is_org_member($1) m", [LOCAL]))[0].m === true, "restored organization: member again");
  pass("a suspended or archived organization takes its chapters' civic access with it");
  await as("carol");
  orgs = await rows("select * from public.civic_my_orgs()");
  assert(JSON.stringify(orgs) === JSON.stringify([
    { org_id: SISTER, org_name: "Civic Sister A2", role: "member" },
    { org_id: LOCAL, org_name: "Civic Local A", role: "member" }]),
  `an active secondary membership must be listed after the selected chapter: ${JSON.stringify(orgs)}`);
  assert((await rows("select public.civic_is_org_member($1) v", [LOCAL]))[0].v === true, "an active secondary membership is membership");
  await as("dan");
  orgs = await rows("select * from public.civic_my_orgs()");
  assert(JSON.stringify(orgs) === JSON.stringify([{ org_id: SISTER, org_name: "Civic Sister A2", role: "member" }]),
    `a revoked membership must not be listed: ${JSON.stringify(orgs)}`);
  assert((await rows("select public.civic_is_org_member($1) v", [LOCAL]))[0].v === false, "a revoked membership is not membership");
  await asOwner();
  const roster = (await rows("select * from public.civic_org_member_ids($1) id", [LOCAL])).map((r) => r.id);
  assert(roster.includes(ids.carol) && !roster.includes(ids.dan) && roster.includes(ids.alice) && roster.length === new Set(roster).size,
    `chapter roster follows active memberships: ${JSON.stringify(roster)}`);
  pass("membership seam reads active member_chapter_memberships rows, not only the selected chapter");
  // The selected profile chapter stays reachable without a membership row.
  await client.query("delete from public.member_chapter_memberships where user_id = $1 and chapter_id = $2", [ids.dan, LOCAL]);
  await client.query("delete from public.member_chapter_memberships where user_id = $1 and chapter_id = $2", [ids.dan, SISTER]);
  await as("dan");
  assert((await rows("select public.civic_is_org_member($1) v", [SISTER]))[0].v === true, "the selected profile chapter needs no membership row");
  orgs = await rows("select * from public.civic_my_orgs()");
  assert(JSON.stringify(orgs) === JSON.stringify([{ org_id: SISTER, org_name: "Civic Sister A2", role: "member" }]),
    `the selected profile chapter is listed without a membership row: ${JSON.stringify(orgs)}`);
  await asOwner();
  assert((await rows("select * from public.civic_org_member_ids($1) id", [SISTER])).some((r) => r.id === ids.dan), "roster keeps a selected-chapter member without a row");
  pass("the selected profile chapter stays reachable without a membership row");
  await as("alice");
  await expectState("members cannot enumerate a chapter roster", "select * from public.civic_org_member_ids($1)", [LOCAL], "42501");
  await expectState("members cannot call the chapter-name seam", "select public.civic_org_display_name($1)", [LOCAL], "42501");

  // ---------------------------------------------------- address + consent
  await as("alice");
  await client.query(insertAddress, address("alice"));
  let saved = (await rows("select * from public.civic_member_addresses"))[0];
  assert(saved.full_address === "1600 Pennsylvania Ave NW Apt 2, Washington, DC 20500", `composed address: ${saved.full_address}`);
  assert(saved.civic_lookup_status === "needs_lookup" && saved.consented_at, "new address must queue a lookup with consent time");
  pass("address captured and composed for the geocoder");
  await asOwner();
  await client.query("update public.civic_member_addresses set civic_lookup_status = 'resolved' where user_id = $1", [ids.alice]);
  await as("alice");
  await client.query("update public.civic_member_addresses set full_name = 'Alice Q. Member'");
  assert((await rows("select civic_lookup_status from public.civic_member_addresses"))[0].civic_lookup_status === "resolved", "a name fix must not requeue");
  await client.query("update public.civic_member_addresses set line1 = '2 Main St', line2 = null");
  saved = (await rows("select civic_lookup_status, full_address from public.civic_member_addresses"))[0];
  assert(saved.civic_lookup_status === "needs_lookup" && saved.full_address === "2 Main St, Washington, DC 20500", "moving must requeue");
  await client.query("update public.civic_member_addresses set line1 = '1600 Pennsylvania Ave NW', line2 = 'Apt 2'");
  pass("moving requeues the lookup but a name fix does not");
  for (const [label, over] of [["lower-case state", { state: "dc" }], ["short ZIP", { postal_code: "2050" }],
    ["partial ZIP+4", { postal_code: "20500-12" }], ["blank street", { line1: " " }], ["one-letter name", { full_name: "A" }]]) {
    await as("bob");
    await expectState(`malformed address refused: ${label}`, insertAddress, address("bob", over), "23514");
  }
  await as("bob");
  assert((await rows("select * from public.civic_member_addresses")).length === 0, "bob must not read alice's address");
  assert((await client.query("update public.civic_member_addresses set line1 = 'hijack'")).rowCount === 0, "bob must not update alice's address");
  assert((await client.query("delete from public.civic_member_addresses")).rowCount === 0, "bob must not delete alice's address");
  await expectState("a member cannot file an address for someone else", insertAddress, address("alice"), "42501");
  await client.query(insertAddress, address("bob", { full_name: "Bob Member", line1: "9 Other Rd" }));
  await expectState("members cannot write the worker's lookup status", "update public.civic_member_addresses set civic_lookup_status = 'resolved'", [], "42501");
  await as("officer");
  assert((await rows("select * from public.civic_member_addresses")).length === 0, "officers see no member address");
  pass("members cannot read or write each other's addresses; officers see none");
  await as("alice", { mfa: false });
  assert((await rows("select * from public.civic_member_addresses")).length === 0, "the mfa_assurance floor must hide rows from an unproven session");
  assert((await rows("select * from public.civic_my_orgs()")).length === 0, "civic_my_orgs must be empty for an unproven session");
  pass("mfa_assurance floor applies to civic tables and the seam");
  for (const relation of ["civic_member_addresses", "civic_officials", "civic_campaigns", "civic_member_messages",
    "civic_member_officials", "civic_official_ratings", "civic_local_jurisdictions", "civic_places"]) {
    await as(null);
    await expectState(`signed-out visitors get nothing from ${relation}`, `select * from public.${relation}`, [], "42501");
  }

  // ------------------------------------------------------------ campaigns
  await as("officer");
  await client.query(insertCampaign, [LOCAL, "draft", ids.officer]);
  const live = (await rows(insertCampaign, [LOCAL, "active", ids.officer]))[0].id;
  const closed = (await rows(insertCampaign, [LOCAL, "closed", ids.officer]))[0].id;
  const draft = (await rows("select id from public.civic_campaigns where status = 'draft'"))[0].id;
  await as("outsider");
  const foreign = (await rows(insertCampaign, [OTHER, "active", ids.outsider]))[0].id;
  await as("alice");
  let seen = (await rows("select id from public.civic_campaigns order by id")).map((r) => r.id).sort();
  assert(JSON.stringify(seen) === JSON.stringify([live, closed].sort()), `members see published campaigns of their own chapter only: ${seen}`);
  await as("officer");
  assert((await rows("select id from public.civic_campaigns")).length === 3, "chapter officer sees its drafts too, never another chapter's");
  await as("orgAdmin");
  assert((await rows("select id from public.civic_campaigns where org_id = $1", [LOCAL])).length === 3, "org-wide officer covers every chapter of the organization");
  await as("carol");
  seen = (await rows("select id from public.civic_campaigns where org_id = $1", [LOCAL])).map((r) => r.id).sort();
  assert(JSON.stringify(seen) === JSON.stringify([live, closed].sort()), `a secondary-chapter member sees that chapter's published campaigns: ${seen}`);
  pass("members see published campaigns of their own chapter only; officers see drafts");
  for (const user of ["alice", "outsider"]) {
    await as(user);
    await expectState(`${user} cannot create a campaign for the chapter`, insertCampaign, [LOCAL, "active", ids[user]], "42501");
    assert((await client.query("update public.civic_campaigns set title = 'defaced' where org_id = $1", [LOCAL])).rowCount === 0, `${user} must not edit`);
    assert((await client.query("delete from public.civic_campaigns where org_id = $1", [LOCAL])).rowCount === 0, `${user} must not delete`);
  }
  await as("officer");
  await expectState("an officer cannot move a campaign to another organization's chapter", "update public.civic_campaigns set org_id = $1 where id = $2", [OTHER, live], "42501");
  pass("only officers of that chapter run its campaigns");

  // -------------------------------------------------------------- messages
  // Alice and Bob resolve to one district with a Representative and a Senator.
  await asOwner();
  await client.query(`insert into public.civic_districts (ocd_id, level, state, name, map_version, source, source_retrieved_at)
    values ('ocd-division/country:us/district:dc', 'state', 'DC', 'District of Columbia', 'cd120', 'mock', now())`);
  await client.query(`insert into public.civic_officials (ocd_id, office, full_name, external_ids, source, source_retrieved_at) values
    ('ocd-division/country:us/district:dc', 'U.S. Representative', 'Rep X', '{"bioguide":"X000001"}', 'mock', now()),
    ('ocd-division/country:us/district:dc', 'U.S. Senator', 'Senator Y', '{"bioguide":"Y000001"}', 'mock', now())`);
  await client.query(`insert into public.civic_user_districts (user_id, ocd_id, address_hash, map_version, resolver_source, resolved_at)
    values ($1, 'ocd-division/country:us/district:dc', 'h1', 'cd120', 'mock', now()), ($2, 'ocd-division/country:us/district:dc', 'h2', 'cd120', 'mock', now())`, [ids.alice, ids.bob]);
  await as("alice");
  const message = (await rows(insertMessage, [live, ids.alice, "drafted"]))[0].id;
  for (const user of ["bob", "officer", "orgAdmin", "outsider"]) {
    await as(user);
    assert((await rows("select * from public.civic_member_messages")).length === 0, `${user} must not read alice's letter`);
    assert((await rows("select * from public.civic_member_message_outcomes")).length === 0, `${user} must not read alice's outcomes`);
  }
  await as("alice");
  assert((await rows("select * from public.civic_member_message_outcomes")).length === 1, "alice sees her own outcome");
  pass("a letter is readable by its author alone");
  for (const [label, campaign] of [["draft", draft], ["closed", closed], ["another chapter's", foreign]]) {
    await expectState(`messages cannot join a ${label} campaign`, insertMessage, [campaign, ids.alice, "drafted"], "42501");
  }
  await as("bob");
  await expectState("nobody writes a letter in another member's name", insertMessage, [live, ids.alice, "drafted"], "42501");
  await as("alice");
  await expectState("a letter must go to one of the member's own resolved officials", insertMessageTo, [live, ids.alice, "bioguide:Z999999"], "42501");
  await as("officer");
  const senateOnly = (await rows(`insert into public.civic_campaigns (org_id, title, topic, status, target_offices)
    values ($1, 'Senate push', 'Staffing ratios', 'active', array['U.S. Senator']) returning id`, [LOCAL]))[0].id;
  await as("alice");
  await expectState("a letter must go to an office the campaign targets", insertMessageTo, [senateOnly, ids.alice, "bioguide:X000001"], "42501");
  await client.query(insertMessageTo, [senateOnly, ids.alice, "bioguide:Y000001"]);
  pass("letters bind to the member's resolved officials and the campaign's target offices");
  await as("alice");
  await client.query("update public.civic_member_messages set status = 'sent', sent_at = now() where id = $1", [message]);
  for (const [column, value] of [["user_id", ids.bob], ["campaign_id", live], ["official_key", "bioguide:OTHER"]]) {
    await expectState(`a saved message cannot be re-pointed via ${column}`, `update public.civic_member_messages set ${column} = $1 where id = $2`, [value, message], "42501");
  }
  await as("bob");
  await client.query(insertMessage, [live, ids.bob, "drafted"]);
  await as("officer");
  const stats = await rows("select * from public.civic_campaign_stats_for_org($1) where campaign_id = $2", [LOCAL, live]);
  assert(stats.length === 1 && Number(stats[0].messages_sent) === 1 && Number(stats[0].messages_drafted) === 1
    && Number(stats[0].members_participating) === 1 && Number(stats[0].officials_contacted) === 1, `officer counts: ${JSON.stringify(stats)}`);
  pass("officers get participation counts");
  for (const [user, org] of [["alice", LOCAL], ["outsider", LOCAL], ["officer", OTHER]]) {
    await as(user);
    await expectState(`${user} is refused counts for ${org}`, "select * from public.civic_campaign_stats_for_org($1)", [org], "42501");
  }
  await as("officer");
  await expectState("the raw stats view is not an officer surface", "select * from public.civic_campaign_stats", [], "42501");
  await expectState("a campaign with member letters cannot be deleted", "delete from public.civic_campaigns where id = $1", [live], "23503");
  await client.query("update public.civic_campaigns set status = 'closed' where id = $1", [senateOnly]);
  await expectState("closing a campaign keeps its letters and still refuses delete", "delete from public.civic_campaigns where id = $1", [senateOnly], "23503");
  assert((await client.query("delete from public.civic_campaigns where id = $1", [draft])).rowCount === 1, "a campaign with no letters can still be deleted");
  await asOwner();
  await expectState("even the service owner cannot cascade members' letters away", "delete from public.civic_campaigns where id = $1", [live], "23503");
  assert(Number((await rows("select count(*) n from public.civic_member_messages where campaign_id = any($1)", [[live, senateOnly]]))[0].n) === 3,
    "members' letters survive refused campaign deletes");
  pass("campaign deletion never takes members' letters; officers close instead");

  // --------------------------------------------------------------- ratings
  await as("officer");
  await client.query(insertRating, [LOCAL, "bioguide:X000001", "A", true]);
  await client.query(insertRating, [LOCAL, "bioguide:X000002", "F", false]);
  await as("outsider");
  await client.query(insertRating, [OTHER, "bioguide:X000001", "D", true]);
  await as("alice");
  const grades = await rows("select official_key, grade from public.civic_official_ratings");
  assert(JSON.stringify(grades) === JSON.stringify([{ official_key: "bioguide:X000001", grade: "A" }]), `alice ratings: ${JSON.stringify(grades)}`);
  await expectState("members cannot grade", insertRating, [LOCAL, "bioguide:X000003", "A", true], "42501");
  await as("outsider");
  await expectState("another organization's officer cannot grade for this chapter", insertRating, [LOCAL, "bioguide:X000004", "F", true], "42501");
  pass("ratings reach members only once published and only from their chapter");

  // --------------------------------------------- service-role-only surface
  await as("alice");
  for (const [label, sql] of [
    ["fingerprints", `select * from public.civic_campaign_fingerprints('${live}', '${ids.alice}')`],
    ["instant lookup claim", `select public.civic_claim_instant_lookup('${ids.alice}')`],
    ["instant lookup release", `select public.civic_unclaim_instant_lookup('${ids.alice}')`],
    ["resolver run ledger", "select * from public.resolver_runs"],
  ]) await expectState(`members cannot touch the ${label}`, sql, [], "42501");

  // ------------------------------------------------ officer bill requests
  await as("officer");
  const key = (await rows("select public.civic_request_bill($1, 'US', '119', 'H.R. 1') k", [LOCAL]))[0].k;
  assert(key === "us/119/hr/1", `federal bill key: ${key}`);
  const stateKey = (await rows("select public.civic_request_bill($1, 'va', '2026', 'HB 123') k", [LOCAL]))[0].k;
  assert(stateKey === "va/2026/hb123", `state bill key: ${stateKey}`);
  await expectState("a malformed bill is refused", "select public.civic_request_bill($1, 'us', '119', 'banana')", [LOCAL], "22023");
  for (const user of ["alice", "outsider"]) {
    await as(user);
    await expectState(`${user} cannot request tracking for the chapter`, "select public.civic_request_bill($1, 'us', '119', 'S 5')", [LOCAL], "42501");
  }
  await asOwner();
  const claim = (await rows("select public.civic_claim_instant_lookup($1) c", [ids.bob]))[0].c;
  const again = (await rows("select public.civic_claim_instant_lookup($1) c", [ids.bob]))[0].c;
  assert(claim.ok === true && again.cause === "already_requested", `instant lookup claim: ${JSON.stringify([claim, again])}`);
  pass("officer bill requests and the one-claim-per-address lookup");

  // --------------------------------------------- local officials + places
  await asOwner();
  await client.query(`insert into public.civic_places (geoid, kind, name, state, source, retrieved_at) values
    ('1150000', 'place', 'Washington city', 'DC', 'census', now())`);
  await client.query("insert into public.civic_user_places (user_id, geoid, resolved_at) values ($1, '1150000', now()), ($2, '1150000', now())", [ids.alice, ids.bob]);
  await as("officer");
  const zipEntry = (await rows(`insert into public.civic_local_jurisdictions (org_id, name, kind, state, match_zips)
    values ($1, 'Ward Nine', 'other', 'DC', array['20500']) returning id`, [LOCAL]))[0].id;
  const wardOfficial = (await rows("insert into public.civic_local_officials (jurisdiction_id, office, full_name, website) values ($1, 'Ward councilmember', 'Pat Ward', 'https://example.org/ward') returning id", [zipEntry]))[0].id;
  const placeEntry = (await rows(`insert into public.civic_local_jurisdictions (org_id, name, kind, state, place_geoid)
    values ($1, 'Washington city', 'city', 'DC', '1150000') returning id`, [LOCAL]))[0].id;
  const mayorOfficial = (await rows("insert into public.civic_local_officials (jurisdiction_id, office, full_name) values ($1, 'Mayor', 'Mayor Exact') returning id", [placeEntry]))[0].id;
  await expectState("an officer-typed javascript: link is refused", "insert into public.civic_local_officials (jurisdiction_id, office, full_name, website) values ($1, 'Clerk', 'Bad Link', 'javascript:alert(1)')", [zipEntry], "23514");
  await expectState("ZIP codes must be ZIP codes", "insert into public.civic_local_jurisdictions (org_id, name, kind, state, match_zips) values ($1, 'Bad Zip', 'other', 'DC', array['2050'])", [LOCAL], "22023");
  await as("alice");
  const mine = await rows("select full_name, match_exact from public.civic_member_officials_keyed where district_level = 'local' order by full_name");
  assert(JSON.stringify(mine) === JSON.stringify([{ full_name: "Mayor Exact", match_exact: true }, { full_name: "Pat Ward", match_exact: false }]),
    `alice local officials: ${JSON.stringify(mine)}`);
  await expectState("members cannot enter local officials", "insert into public.civic_local_jurisdictions (org_id, name, kind, state, match_zips) values ($1, 'Rogue', 'city', 'DC', array['20500'])", [LOCAL], "42501");
  await as("outsiderMember");
  const shared = await rows("select name from public.civic_local_jurisdictions order by name");
  assert(JSON.stringify(shared) === JSON.stringify([{ name: "Washington city" }]), `only exact shared places cross chapters: ${JSON.stringify(shared)}`);
  await as("outsider");
  await expectState("another organization's officer cannot enter this chapter's officials", "insert into public.civic_local_officials (jurisdiction_id, office, full_name) values ($1, 'Mayor', 'Impostor')", [placeEntry], "42501");
  pass("local officials: exact places, ZIP approximations, sharing and officer-only writes");
  await asOwner();
  await client.query("insert into public.civic_user_places (user_id, geoid, resolved_at) values ($1, '1150000', now())", [ids.officer]);
  await as("officer");
  let counts = await rows("select * from public.civic_member_place_counts($1)", [LOCAL]);
  assert(counts.length === 1 && Number(counts[0].members) === 3 && counts[0].entered_by === "Civic Local A" && counts[0].own_jurisdiction_id === placeEntry,
    `place counts: ${JSON.stringify(counts)}`);
  await asOwner();
  await client.query("delete from public.civic_user_places where user_id = $1", [ids.officer]);
  await as("officer");
  counts = await rows("select * from public.civic_member_place_counts($1)", [LOCAL]);
  assert(counts.length === 0, `a place with two members is not listed at all, not merely uncounted: ${JSON.stringify(counts)}`);
  await asOwner();
  await client.query("delete from public.civic_user_places where user_id = $1", [ids.bob]);
  await as("officer");
  counts = await rows("select * from public.civic_member_place_counts($1)", [LOCAL]);
  assert(counts.length === 0, `one member's place is not listed: ${JSON.stringify(counts)}`);
  await asOwner();
  await client.query("insert into public.civic_user_places (user_id, geoid, resolved_at) values ($1, '1150000', now())", [ids.bob]);
  await as("officer");
  await client.query("select public.civic_mark_jurisdiction_reviewed($1)", [zipEntry]);
  for (const user of ["alice", "outsider"]) {
    await as(user);
    await expectState(`${user} cannot read place counts`, "select * from public.civic_member_place_counts($1)", [LOCAL], "42501");
    await expectState(`${user} cannot stamp a jurisdiction`, "select public.civic_mark_jurisdiction_reviewed($1)", [zipEntry], "42501");
  }
  pass("places with fewer than three members are left out and counts are officer-only");

  // ------------------------------------- officials represented in a chapter
  // Carol (active secondary LOCAL membership) and Dan (LOCAL revoked) each get
  // a Representative of their own.
  await asOwner();
  await client.query(`insert into public.civic_districts (ocd_id, level, state, name, map_version, source, source_retrieved_at) values
    ('ocd-division/country:us/state:pa/cd:1', 'federal', 'PA', 'Pennsylvania 1st', 'cd120', 'mock', now()),
    ('ocd-division/country:us/state:pa/cd:2', 'federal', 'PA', 'Pennsylvania 2nd', 'cd120', 'mock', now())`);
  await client.query(`insert into public.civic_officials (ocd_id, office, full_name, external_ids, source, source_retrieved_at) values
    ('ocd-division/country:us/state:pa/cd:1', 'U.S. Representative', 'Rep C', '{"bioguide":"C000001"}', 'mock', now()),
    ('ocd-division/country:us/state:pa/cd:2', 'U.S. Representative', 'Rep D', '{"bioguide":"D000001"}', 'mock', now())`);
  await client.query(`insert into public.civic_user_districts (user_id, ocd_id, address_hash, map_version, resolver_source, resolved_at) values
    ($1, 'ocd-division/country:us/state:pa/cd:1', 'h3', 'cd120', 'mock', now()),
    ($2, 'ocd-division/country:us/state:pa/cd:2', 'h4', 'cd120', 'mock', now())`, [ids.carol, ids.dan]);
  await as("officer");
  // Alice and Bob share Rep X / Senator Y (two members) and Carol alone has
  // Rep C: no official reaches three members yet, so the picker lists none of
  // them rather than pointing at one or two members' districts.
  let represented = await rows("select * from public.civic_member_officials_for_org($1)", [LOCAL]);
  assert(represented.length === 0, `two-member and single-member cohorts are withheld: ${JSON.stringify(represented)}`);
  await asOwner();
  // The officer's own address lands in the same DC district (three members
  // now share Rep X / Senator Y) and, as a second district, next to Carol
  // (still only two share Rep C).
  await client.query(`insert into public.civic_user_districts (user_id, ocd_id, address_hash, map_version, resolver_source, resolved_at) values
    ($1, 'ocd-division/country:us/district:dc', 'h5', 'cd120', 'mock', now()),
    ($1, 'ocd-division/country:us/state:pa/cd:1', 'h5', 'cd120', 'mock', now())`, [ids.officer]);
  await as("officer");
  represented = await rows("select * from public.civic_member_officials_for_org($1)", [LOCAL]);
  const keys = represented.map((r) => r.official_key);
  assert(keys.includes("bioguide:X000001") && keys.includes("bioguide:Y000001") && !keys.includes("bioguide:C000001")
    && !keys.includes("bioguide:D000001") && keys.length === new Set(keys).size
    && represented.every((r) => r.full_name && r.office && !Object.hasOwn(r, "user_id")),
  `only officials three or more members share, with no member columns: ${JSON.stringify(represented)}`);
  for (const user of ["alice", "outsider", "outsiderMember"]) {
    await as(user);
    await expectState(`${user} cannot list the chapter's represented officials`, "select * from public.civic_member_officials_for_org($1)", [LOCAL], "42501");
  }
  pass("the rating picker lists only officials three or more members share, officers only");

  // ------------------------------------------------------------ member flags
  const insertFlag = "insert into public.civic_local_flags (jurisdiction_id, user_id, note) values ($1, $2, $3)";
  const insertOfficialFlag = "insert into public.civic_local_flags (jurisdiction_id, official_id, user_id, note) values ($1, $2, $3, $4)";
  await as("alice");
  await expectState("a flagged official must serve the flagged jurisdiction", insertOfficialFlag, [placeEntry, wardOfficial, ids.alice, "Wrong place for this one."], "42501");
  await client.query(insertOfficialFlag, [placeEntry, mayorOfficial, ids.alice, "The mayor changed last month."]);
  await expectState("flags cannot be filed in another member's name", insertFlag, [placeEntry, ids.bob, "Forged report here."], "42501");
  await as("outsiderMember");
  await expectState("flags only for places the member can see", insertFlag, [zipEntry, ids.outsiderMember, "Not my chapter at all."], "42501");
  await as("alice");
  for (let n = 1; n < 5; n += 1) await client.query(insertFlag, [placeEntry, ids.alice, `Report number ${n} here.`]);
  await expectState("at most five open reports per member", insertFlag, [placeEntry, ids.alice, "One report too many."], "54000");
  await as("officer");
  const flags = await rows("select * from public.civic_local_flags_for_org($1)", [LOCAL]);
  assert(flags.length === 5 && flags.every((flag) => !Object.hasOwn(flag, "user_id")), "officers see what was reported, never who");
  assert(flags.filter((flag) => flag.official_id).length === 1 && flags.find((flag) => flag.official_id).official_name === "Mayor Exact",
    `only the jurisdiction's own official is named: ${JSON.stringify(flags)}`);
  await as("outsider");
  await expectState("another organization's officer cannot resolve the report", "select public.civic_resolve_local_flag($1, 'resolved')", [flags[0].id], "42501");
  await as("officer");
  await client.query("select public.civic_resolve_local_flag($1, 'resolved')", [flags[0].id]);
  await expectState("flag status is validated", "select public.civic_resolve_local_flag($1, 'deleted')", [flags[1].id], "22023");
  pass("member flags: anonymous to officers, capped, officer-resolved");

  // ------------------------------------------ withdrawal, export, deletion
  await as("alice");
  const exported = (await rows("select public.get_member_data_export() v"))[0].v;
  assert(exported.civic?.address?.line1 === "1600 Pennsylvania Ave NW" && exported.civic.messages.length === 2
    && exported.civic.places.length === 1 && exported.civic.localReports.length === 5 && exported.civic.districts.length === 1,
  `export civic section: ${JSON.stringify(exported.civic)}`);
  assert(!JSON.stringify(exported.civic).includes("9 Other Rd"), "export must not include another member's address");
  pass("the member export carries the civic section");
  await client.query("select public.civic_withdraw_address()");
  await asOwner();
  const left = (await rows(`select
    (select count(*) from public.civic_member_addresses where user_id = $1)::int a,
    (select count(*) from public.civic_user_districts where user_id = $1)::int d,
    (select count(*) from public.civic_user_places where user_id = $1)::int p,
    (select count(*) from public.civic_member_messages where user_id = $1)::int m,
    (select count(*) from public.civic_user_districts where user_id = $2)::int other`, [ids.alice, ids.bob]))[0];
  assert(left.a === 0 && left.d === 0 && left.p === 0 && left.m === 2 && left.other === 1, `withdrawal: ${JSON.stringify(left)}`);
  pass("withdrawing consent erases the address and everything derived, and only the caller's");

  // Moving: Bob holds districts, places, a quarantine result and an instant
  // lookup claim (taken above) for his old address.
  await client.query(`insert into public.civic_quarantine (user_id, address_hash, reason, quarantined_at) values ($1, 'h2', 'po_box', now())`, [ids.bob]);
  await client.query("update public.civic_member_addresses set civic_lookup_status = 'resolved' where user_id = $1", [ids.bob]);
  assert((await rows("select public.civic_claim_instant_lookup($1) c", [ids.bob]))[0].c.cause === "not_pending", "resolved address holds no claim");
  await client.query("update public.civic_member_addresses set lookup_requested_at = now() where user_id = $1", [ids.bob]);
  await as("bob");
  await client.query("update public.civic_member_addresses set full_name = 'Bob Q. Member'");
  await asOwner();
  let bobState = (await rows(`select
    (select count(*) from public.civic_user_districts where user_id = $1)::int d,
    (select count(*) from public.civic_quarantine where user_id = $1)::int q,
    (select lookup_requested_at is not null from public.civic_member_addresses where user_id = $1) claimed`, [ids.bob]))[0];
  assert(bobState.d === 1 && bobState.q === 1 && bobState.claimed === true, `a name fix keeps officials, quarantine and claim: ${JSON.stringify(bobState)}`);
  await as("bob");
  await client.query("update public.civic_member_addresses set line1 = '10 New Home Ln', city = 'Newtown', state = 'PA', postal_code = '18940'");
  assert((await rows("select * from public.civic_member_officials_keyed where district_level <> 'local'")).length === 0, "a moved member sees none of the old officials");
  assert((await rows("select * from public.civic_quarantine")).length === 0, "a moved member is no longer quarantined");
  await expectState("a moved member cannot write to an old official", insertMessageTo, [live, ids.bob, "bioguide:Y000001"], "42501");
  await asOwner();
  bobState = (await rows(`select
    (select count(*) from public.civic_user_districts where user_id = $1)::int d,
    (select count(*) from public.civic_user_places where user_id = $1)::int p,
    (select count(*) from public.civic_quarantine where user_id = $1)::int q,
    (select civic_lookup_status from public.civic_member_addresses where user_id = $1) status,
    (select lookup_requested_at from public.civic_member_addresses where user_id = $1) requested`, [ids.bob]))[0];
  assert(bobState.d === 0 && bobState.p === 0 && bobState.q === 0 && bobState.status === "needs_lookup" && bobState.requested === null,
    `moving clears districts, places, quarantine and the old claim: ${JSON.stringify(bobState)}`);
  assert((await rows("select public.civic_claim_instant_lookup($1) c", [ids.bob]))[0].c.ok === true, "the new address can claim an instant lookup at once");
  pass("moving drops old officials, quarantine and the old lookup claim");
  await client.query("delete from auth.users where id = $1", [ids.bob]);
  const bobLeft = (await rows(`select
    (select count(*) from public.civic_member_addresses where user_id = $1)::int a,
    (select count(*) from public.civic_member_messages where user_id = $1)::int m,
    (select count(*) from public.civic_user_places where user_id = $1)::int p,
    (select count(*) from public.civic_user_districts where user_id = $1)::int d,
    (select count(*) from public.civic_campaigns where id = $2)::int c`, [ids.bob, live]))[0];
  assert(bobLeft.a === 0 && bobLeft.m === 0 && bobLeft.p === 0 && bobLeft.d === 0 && bobLeft.c === 1, `account deletion: ${JSON.stringify(bobLeft)}`);
  await client.query("delete from auth.users where id = $1", [ids.officer]);
  const detached = (await rows("select created_by from public.civic_campaigns where id = $1", [live]))[0];
  assert(detached.created_by === null, "officer attribution must detach while the campaign stays");
  pass("account deletion removes civic member rows and detaches officer attribution");

  await client.query("rollback");
  console.log(JSON.stringify({ status: "passed", checks: checks.length, labels: checks }));
} catch (error) {
  await client.query("rollback").catch(() => {});
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
