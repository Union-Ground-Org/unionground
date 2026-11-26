// @vitest-environment node
//
// SEC-UG-EVENT-SCAN-TENANT-ISOLATION-20260921
//
// public.scan_event_checkin was the one event entry point 20260901153739 did
// not re-emit: its scanned-member predicate admitted the caller's chapter, any
// cross-agency event, or a same-region public event, none of which checks the
// event's organization. 20260925550700 resolves eligibility through
// private.member_can_access_event_scope_for_user and changes nothing else.
//
// The offline half pins the migration text and the db-contract entry. The
// live half (disposable loopback only) scans two organizations' tokens at a
// public, cross-agency event whose chapters share a region, in one rolled-back
// transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20260925550700_event_scan_tenant_isolation.sql";
const SIGNATURE = "public.scan_event_checkin(p_event_id text, p_token text)";
const sql = loadMigrationSql("event_scan_tenant_isolation");
const scan = stripComments(fnBody(sql, SIGNATURE));
const legacy = stripComments(fnBody(loadMigrationSql("20260812231000_event_scan_acceptance_repair.sql"), SIGNATURE));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const LOCK = "begin perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]); declare";

describe("event scan tenant isolation migration", () => {
  it("is the newest emitter of scan_event_checkin, inside one bounded transaction", () => {
    expect(findMigrationName("event_scan_tenant_isolation")).toBe(NAME);
    const later = migrationFiles()
      .filter(({ name }) => name > NAME)
      .filter(({ sql: body }) => /function public\.scan_event_checkin\s*\(/i.test(stripComments(body)));
    // 20261008235000 re-emits the installed body with only the no-code
    // refusal added (BUG-UG-EVENT-SAVE-SILENT-WITHOUT-CHECKIN-CODE-20261006);
    // the tenant-first eligibility statement this file pins is unchanged.
    // 20261104110000 (REQ-UG-LEARNING-PERIOD-EVENTS-20261103) re-emits
    // it with only a learning-period journal call after a new check-in.
    expect(later.map(({ name }) => name)).toEqual(["20261008235000_event_checkin_code_optional.sql", "20261104110000_learning_period_events.sql"]);
    for (const { sql: body } of later) {
      expect(stripComments(body)).toContain("private.member_can_access_event_scope_for_user(\n      tok.user_id, ev.chapter_id, ev.is_public, ev.is_public_across_agencies\n    )");
    }
    expect(stripComments(sql).trimStart().startsWith("begin;")).toBe(true);
    expect(stripComments(sql).trimEnd().endsWith("commit;")).toBe(true);
    // Only the 20260907151000-wrapped installed source may be replaced.
    expect(sql).toContain("raise exception 'unreviewed scan_event_checkin predecessor: %'");
  });

  it("keeps the case-graph entry lock first and resolves the token owner through the tenant-first helper", () => {
    expect(squash(scan)).toContain(`as $function$ ${LOCK} caller uuid := (select auth.uid());`);
    const eligibility = scan.slice(scan.indexOf("select p.full_name into scanned_name"), scan.indexOf("for update of p"));
    expect(eligibility).toMatch(
      /private\.member_can_access_event_scope_for_user\(\s*tok\.user_id,\s*ev\.chapter_id,\s*ev\.is_public,\s*ev\.is_public_across_agencies\s*\)/,
    );
    expect(eligibility).not.toContain("or ev.is_public_across_agencies");
    expect(eligibility).not.toContain("event_chapter.region = member_chapter.region");
  });

  it("changes nothing outside the eligibility statement", () => {
    const start = "select p.full_name into scanned_name";
    const end = "for update of p;";
    const current = squash(scan).replace(`${LOCK} `, "declare ");
    const previous = squash(legacy).replace(/^.*?as \$\$ /, "as $function$ ").replace(/ \$\$;$/, " $function$;");
    expect(current.slice(current.indexOf("as $function$"), current.indexOf(start)))
      .toBe(previous.slice(previous.indexOf("as $function$"), previous.indexOf(start)));
    expect(current.slice(current.indexOf(end), current.lastIndexOf("end;") + 4))
      .toBe(`${previous.slice(previous.indexOf(end), previous.lastIndexOf("end;") + 4)} end;`);
    expect(sql).toContain("revoke all on function public.scan_event_checkin(text, text) from public, anon;");
    expect(sql).toContain("grant execute on function public.scan_event_checkin(text, text) to authenticated;");
  });

  it("pins the helper call in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === SIGNATURE);
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])",
      "private.member_can_access_event_scope_for_user(",
      "tok.user_id, ev.chapter_id, ev.is_public, ev.is_public_across_agencies",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("event scan refuses another organization's token and keeps same-organization scans", () => {
  let client;
  const id = Object.fromEntries(["orgA", "orgB", "steward", "memberA", "memberB", "stewardSession"].map((key) => [key, randomUUID()]));
  const suffix = id.orgA.slice(0, 8);
  const chapterA = `scan-iso-a-${suffix}`;
  const chapterB = `scan-iso-b-${suffix}`;
  const event = `scan-iso-event-${suffix}`;
  const sameToken = `SAME${suffix}`.toUpperCase();
  const otherToken = `OTHER${suffix}`.toUpperCase();

  async function scanAs(token) {
    await client.query("savepoint scan_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: id.steward, role: "authenticated", session_id: id.stewardSession, aal: "aal2",
      })]);
      await client.query("set local role authenticated");
      const result = await client.query("select public.scan_event_checkin($1, $2) result", [event, token]);
      await client.query("reset role");
      await client.query("release savepoint scan_probe");
      return { code: "", result: result.rows[0].result };
    } catch (error) {
      await client.query("rollback to savepoint scan_probe");
      return { code: error.code || "?", detail: error.detail || "", message: error.message || "" };
    }
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "event-scan-tenant-isolation-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query(
      "insert into auth.users (id, email) values ($1, $4), ($2, $5), ($3, $6)",
      [id.steward, id.memberA, id.memberB, `${id.steward}@example.invalid`, `${id.memberA}@example.invalid`, `${id.memberB}@example.invalid`],
    );
    await client.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, $3, 'Scan Tenant A', $5), ($2, $4, 'Scan Tenant B', $5)",
      [id.orgA, id.orgB, `scan-tenant-a-${suffix}`, `scan-tenant-b-${suffix}`, id.steward],
    );
    // Transaction-only fixture: both chapters share a region, so the legacy
    // region and cross-agency branches would admit the other tenant's member.
    await client.query("set local session_replication_role = replica");
    await client.query(
      `insert into public.chapters (id, slug, name, region, order_index, organization_id) values
       ($1, $1, 'Scan Iso A', 'SCAN-ISO', 95541, $3), ($2, $2, 'Scan Iso B', 'SCAN-ISO', 95542, $4)`,
      [chapterA, chapterB, id.orgA, id.orgB],
    );
    await client.query("insert into public.member_roles (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $1)", [id.steward, chapterA]);
    await client.query("insert into public.member_role_chapters (user_id, role, chapter_id, granted_by) values ($1, 'steward', $2, $1)", [id.steward, chapterA]);
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id, full_name = fixture.full_name
       from (values ($1::uuid, $4::text, 'Scan Steward'::text),
                    ($2::uuid, $4::text, 'Same Tenant Member'::text),
                    ($3::uuid, $5::text, 'Other Tenant Member'::text)) fixture(id, chapter_id, full_name)
       where member_profiles.id = fixture.id`,
      [id.steward, id.memberA, id.memberB, chapterA, chapterB],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1, $4, 'active', true, now()), ($2, $4, 'active', true, now()), ($3, $5, 'active', true, now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [id.steward, id.memberA, id.memberB, chapterA, chapterB],
    );
    await client.query(
      "insert into public.organization_memberships (organization_id, user_id) values ($1, $3), ($1, $4), ($2, $5)",
      [id.orgA, id.orgB, id.steward, id.memberA, id.memberB],
    );
    await client.query("insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [id.stewardSession, id.steward]);
    await client.query(
      "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'scan-steward-totp', 'totp', 'verified', now(), now())",
      [id.steward],
    );
    await client.query(
      `insert into public.member_events
       (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id, is_public, is_public_across_agencies)
       values ($1, 'Scan isolation event', now(), 'Hall', '', $2, 95541, $3, true, true)`,
      [event, `SG-${suffix}`.toUpperCase(), chapterA],
    );
    await client.query(
      `insert into private.member_event_checkin_tokens (event_id, user_id, token_hash, expires_at)
       values ($1, $2, encode(extensions.digest($4, 'sha256'), 'hex'), now() + interval '5 minutes'),
              ($1, $3, encode(extensions.digest($5, 'sha256'), 'hex'), now() + interval '5 minutes')`,
      [event, id.memberA, id.memberB, sameToken, otherToken],
    );
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses another organization's member token even on a public, cross-agency event", async () => {
    const refused = await scanAs(otherToken);
    expect(refused, refused.message).toMatchObject({ code: "22023", detail: "scan_code_invalid" });
    const token = await client.query(
      "select consumed_at from private.member_event_checkin_tokens where event_id = $1 and user_id = $2",
      [event, id.memberB],
    );
    expect(token.rows[0].consumed_at).toBeNull();
    const checkins = await client.query(
      "select count(*)::int n from public.member_event_checkins where event_id = $1 and user_id = $2",
      [event, id.memberB],
    );
    expect(checkins.rows[0].n).toBe(0);
  });

  it("still checks in a same-organization member", async () => {
    const scanned = await scanAs(sameToken);
    expect(scanned, scanned.message).toMatchObject({ code: "" });
    expect(scanned.result).toMatchObject({
      memberUserId: id.memberA,
      memberName: "Same Tenant Member",
      checkedIn: true,
      alreadyCheckedIn: false,
    });
  });
});
