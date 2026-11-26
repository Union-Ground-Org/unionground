// @vitest-environment node
//
// SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917.
//
// The desk CSV export is still built in the browser from rows already
// rendered. What 20260918202000_casework_case_export_audit adds is the receipt
// and the bound: public.casework_record_case_export writes exactly one
// 'cases_exported' casework_audit_events row, refuses above the documented cap,
// and refuses any case the caller cannot read under the shared staff predicate.
//
// Static SQL pins can show the argument list and the vocabularies. Only a live
// apply shows that the row that lands carries the actor, the count and the ids
// and NO case, note or member text; that the caps are enforced by the server
// and not only by the browser; and that a same-organization actor who cannot
// read a case cannot name it in an export.
//
// The live half runs inside one transaction that is rolled back against
// fixtures it creates itself, so the shared disposable catalogue keeps no
// synthetic organization, chapter, case or audit row.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const raw = loadMigrationSql("casework_case_export_audit");
const sql = stripComments(raw);
const liveRoutine = latestFnBody("public.casework_record_case_export");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SIGNATURE = "public.casework_record_case_export(p_case_ids uuid[], p_scope text, p_filter_keys text[])";
// The routine's executable text only: the trailing grants and the comment name
// the predicate and the caps in prose, and prose is not the contract here.
const routine = sql.slice(
  sql.indexOf("create or replace function public.casework_record_case_export"),
  sql.indexOf("$function$;") + "$function$;".length,
);

// The five row fields the export column set carries. If any of these words can
// appear in the routine's executable text, the audit row could carry case or
// member content; the whole point of the design is that they cannot.
const ROW_CONTENT_COLUMNS = ["reference", "title", "full_name", "body", "memberName"];

describe("casework case export audit migration", () => {
  it("sorts after the newest open-PR stamp and re-emits the enumeration with every prior member", () => {
    expect(findMigrationName("casework_case_export_audit") > "20260918090000").toBe(true);
    // The enumeration is re-emitted exactly the way the macro migration does
    // it: drop the CHECK, add it back. Every member the previous generation
    // carried is still present, plus the new one.
    const previous = stripComments(loadMigrationSql("casework_macros_case_note_mentions"));
    const members = (text) => [...text.matchAll(/'(\w+)'/g)]
      .map((match) => match[1])
      .filter((value, index, all) => all.indexOf(value) === index);
    const previousEnum = members(previous.slice(
      previous.indexOf("add constraint casework_audit_events_event_type_check"),
      previous.indexOf("));", previous.indexOf("add constraint casework_audit_events_event_type_check")),
    ));
    const nextEnum = members(sql.slice(
      sql.indexOf("add constraint casework_audit_events_event_type_check"),
      sql.indexOf("));", sql.indexOf("add constraint casework_audit_events_event_type_check")),
    ));
    expect(sql).toContain("drop constraint casework_audit_events_event_type_check");
    for (const member of previousEnum) expect(nextEnum).toContain(member);
    expect(nextEnum).toEqual([...previousEnum, "cases_exported"]);
  });

  it("can never carry free text: both text inputs are closed vocabularies and no row column is read", () => {
    const body = routine;
    // Scope is one of exactly two literals; a filter key is one of exactly the
    // six facet NAMES the case list publishes. Neither is truncated, escaped or
    // stored on a mismatch — it is refused.
    expect(body).toContain("if v_scope not in ('selection', 'visible') then");
    expect(body).toContain("entry.key not in ('step', 'caseType', 'assignee', 'deadline', 'status', 'chapter')");
    expect(body.split("using errcode = '22023'")).toHaveLength(8);
    // The recorded values are derived, not copied: the count comes from the id
    // array's cardinality, the actor from auth.uid(), the tenant from
    // member_cases, the entity id is minted here.
    expect(body).toContain("select pg_catalog.count(distinct entry.id) into v_count");
    expect(body).toContain("'rowCount', v_count");
    expect(body).toContain("v_export_id := extensions.gen_random_uuid();");
    // Only these four metadata keys exist, and every one of them is a uuid, an
    // integer or a member of a closed vocabulary.
    const recorded = body.slice(
      body.indexOf("'cases_exported', 'case_export', v_export_id"),
      body.indexOf("return pg_catalog.jsonb_build_object"),
    );
    expect([...recorded.matchAll(/'(\w+)',/g)].map((match) => match[1]))
      .toEqual(["cases_exported", "case_export", "scope", "rowCount", "filterKeys", "caseIds"]);
    // No case, note or member column is read anywhere in the routine.
    for (const column of ROW_CONTENT_COLUMNS) expect(body).not.toContain(column);
  });

  // Review finding M1. A receipt nobody can filter for is not reviewable
  // evidence: public.list_casework_audit_events is the only surfaced reader of
  // this sink and its p_kind vocabulary is a hardcoded array, so the reader is
  // re-emitted here with exactly ONE new member.
  it("re-emits the surfaced audit-sink reader with exactly one new kind", () => {
    const reader = sql.slice(
      sql.indexOf("create or replace function public.list_casework_audit_events"),
      sql.indexOf("$function$;", sql.indexOf("create or replace function public.list_casework_audit_events")),
    );
    const previousFile = stripComments(loadMigrationSql("dormant_audit_sinks_read_rpcs"));
    const previous = previousFile.slice(
      previousFile.indexOf("create or replace function public.list_casework_audit_events"),
      previousFile.indexOf("$function$;", previousFile.indexOf("create or replace function public.list_casework_audit_events")),
    );
    const vocabulary = (text) => {
      const start = text.indexOf("p_kind <> all (array[");
      return [...text.slice(start, text.indexOf("])", start)).matchAll(/'(\w+)'/g)].map((match) => match[1]);
    };
    expect(vocabulary(reader)).toEqual([...vocabulary(previous), "cases_exported"]);
    // The projection and the envelope name it too, or the panel drops the row.
    const projection = readFileSync(new URL("../src/features/operations/auditProjection.js", import.meta.url), "utf8");
    expect(projection).toContain('cases_exported: { domain: "casework", eventType: "case.cases_exported", action: "export" }');
    expect(readFileSync(new URL("../src/features/operations/auditEnvelope.js", import.meta.url), "utf8"))
      .toContain('"case.cases_exported"');
    // A read takes no row lock and writes no graph relation, so it carries no
    // lock_case_graph gate; a casework-named migration file owns every
    // definition it carries, hence the reviewed read-only exception.
    expect(reader).not.toContain("private.lock_case_graph");
    expect(JSON.parse(readFileSync(new URL("../scripts/account-case-graph-review.json", import.meta.url), "utf8"))
      .exceptions["public.list_casework_audit_events"].reason).toMatch(/read-only/i);
  });

  it("uses the shared staff predicate as its only read gate and introduces no second one", () => {
    const body = routine;
    expect(body).toContain("and private.casework_staff_can_access(c.id)");
    expect(body.split("private.casework_staff_can_access")).toHaveLength(2);
    // The whole request is refused rather than narrowed, so a recorded export
    // can never understate what left the browser.
    expect(body).toContain("raise exception 'export selection is not authorized' using errcode = 'P0002'");
    // No other authorization predicate appears; the case-graph gate and the
    // MFA gate are the shared casework preamble, not a second read test.
    expect([...body.matchAll(/private\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(["casework_require_mfa", "casework_staff_can_access", "lock_case_graph"]);
  });

  it("documents both caps and enforces them in the routine, not only in the browser", () => {
    expect(raw).toContain("WHY 500, AND WHY 100 FOR A SELECTION");
    expect(sql).toContain("if v_count not between 1 and 500 then");
    expect(sql).toContain("raise exception 'an export is limited to 500 cases'");
    expect(sql).toContain("if v_scope = 'selection' and v_count > 100 then");
    expect(sql).toContain("raise exception 'a selection export is limited to 100 cases'");
    // The client carries the same two numbers.
    const client = readFileSync(new URL("../src/lib/caseExport.js", import.meta.url), "utf8");
    expect(client).toContain("export const CASE_EXPORT_LIMIT = 500;");
    expect(readFileSync(new URL("../src/lib/caseSelection.js", import.meta.url), "utf8"))
      .toContain("export const SELECTION_LIMIT = 100;");
  });

  it("keeps the sibling casework definer shape, grants and db-contract pins", () => {
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("revoke all on function public.casework_record_case_export(uuid[], text, text[]) from public, anon;");
    expect(sql).toContain("grant execute on function public.casework_record_case_export(uuid[], text, text[]) to authenticated;");

    const entry = contract.functions.find((candidate) => candidate.sig === SIGNATURE);
    expect(entry).toBeDefined();
    expect(entry.secdef).toBe(true);
    expect(entry.exec).toBe("authenticated");
    expect(entry.bodyMd5).toMatch(/^[a-f0-9]{32}$/);
    for (const pin of entry.bodyContains) expect(liveRoutine).toContain(pin);

    const constraint = contract.constraints.find((candidate) =>
      candidate.table === "casework_audit_events" && candidate.name === "casework_audit_events_event_type_check");
    expect(constraint).toBeDefined();
    expect(constraint.convalidated).toBe(true);
    expect(constraint.defContains).toContain("cases_exported");
  });
});

// SEC-UG-CASE-EXPORT-AUDIT-METADATA-VISIBILITY-20260921.
//
// The receipt above is deliberately a null-case row, and
// casework_audit_events_staff_read admits a null-case row to any organization
// coordinator while a case-scoped row additionally needs the parent case to be
// visible under the member_cases policies. The table itself is client-readable
// (20260828210000 grants SELECT to authenticated), so the selection branch may
// not carry the exported case ids themselves: 20260925600200 re-emits the
// routine to record one export-salted, truncated digest per case instead.
const repairRaw = loadMigrationSql("case_export_audit_metadata_visibility");
const repair = stripComments(repairRaw);
const repaired = repair.slice(
  repair.indexOf("create or replace function public.casework_record_case_export"),
  repair.indexOf("$function$;") + "$function$;".length,
);
const squash = (text) => text.replace(/\s+/g, " ").trim();
const selectionBranch = (text) => text.slice(
  text.indexOf("|| (case when v_scope = 'selection'"),
  text.indexOf("else '{}'::jsonb end));"),
);

describe("casework case export audit metadata visibility", () => {
  it("records one export-salted digest per case rather than the case ids", () => {
    expect(findMigrationName("case_export_audit_metadata_visibility") > "20260921221000").toBe(true);
    expect(repaired).toContain("'caseIdDigests'");
    expect(repaired).not.toContain("'caseIds'");
    // Salted with the receipt's own export id, so two receipts naming the same
    // case cannot be correlated, and truncated to 128 bits, so a 100-case
    // selection still fits the metadata bound the selection cap was chosen for.
    expect(repaired).toContain("extensions.digest(v_export_id::text || ':' || entry.id::text, 'sha256')");
    expect(repaired).toContain("'hex'), 32)");
  });

  it("re-emits that one routine and moves nothing else inside it", () => {
    expect(repair.match(/create or replace function/g)).toHaveLength(1);
    // Everything outside the selection metadata branch is the shipped routine
    // byte for byte: the same case-graph and MFA gates, the same vocabularies,
    // the same derived count, the same caps and the same read predicate.
    const without = (text) => squash(text.replace(selectionBranch(text), ""));
    expect(without(repaired)).toBe(without(routine));
    expect(selectionBranch(repaired)).not.toBe(selectionBranch(routine));
  });

  it("keeps the definer shape and the grants, and repins the db contract", () => {
    expect(repair).toContain("security definer");
    expect(repair).toContain("set search_path = ''");
    expect(repair).toContain("revoke all on function public.casework_record_case_export(uuid[], text, text[]) from public, anon, service_role;");
    expect(repair).toContain("grant execute on function public.casework_record_case_export(uuid[], text, text[]) to authenticated;");

    const entry = contract.functions.find((candidate) => candidate.sig === SIGNATURE);
    // Current contract pins follow the latest definition, including subsequent
    // boundary repairs; this historical migration still preserves metadata.
    // The negative pin refuses a return to raw ids.
    for (const pin of entry.bodyContains) expect(liveRoutine).toContain(pin);
    expect(entry.bodyMd5).toMatch(/^[a-f0-9]{32}$/);
    expect(entry.bodyMd5).not.toBe("2af6aaeafb295862ba488c977bde7411");
    expect(entry.bodyForbids).toContain("'caseids'");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework case export audit", () => {
  let client;
  let ids;

  const as = async (user, role = "authenticated") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ role, sub: user, session_id: ids.sessions[user], aal: "aal2" })]);
    await client.query(`set local role ${role}`);
  };

  const refused = async (statement, params, expected) => {
    await client.query("savepoint export_probe");
    let caught;
    try { await client.query(statement, params); } catch (error) { caught = error; }
    finally { await client.query("rollback to savepoint export_probe"); await client.query("release savepoint export_probe"); }
    expect(caught?.code, caught?.message).toBe(expected);
    return caught.message;
  };

  const recordExport = (caseIds, scope, filters = []) =>
    client.query("select public.casework_record_case_export($1::uuid[],$2,$3::text[]) value", [caseIds, scope, filters]);

  // The receipt's selection digest, exactly as 20260925600200 records it:
  // sha256 over the export id and the case id, truncated to 128 bits.
  const digestOf = (exportId, caseId) =>
    createHash("sha256").update(`${exportId}:${caseId}`).digest("hex").slice(0, 32);

  const auditRows = async () => {
    await as(ids.admin, "postgres");
    const { rows } = await client.query(
      `select organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata
       from public.casework_audit_events where event_type = 'cases_exported' order by id`);
    await as(ids.admin);
    return rows;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-case-export-audit-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    if (!(await client.query(
      "select to_regprocedure('public.casework_record_case_export(uuid[],text,text[])') is not null as installed")).rows[0].installed) {
      throw new Error("the disposable stack must have 20260918202000_casework_case_export_audit applied");
    }

    ids = Object.fromEntries([
      "orgA", "orgB", "admin", "coordinator", "steward", "member", "outsider",
      "adminSession", "coordinatorSession", "stewardSession", "memberSession", "outsiderSession",
      "caseOne", "caseTwo", "caseOther", "restrictedCase",
    ].map((key) => [key, randomUUID()]));
    ids.chapterA = `export-proof-a-${ids.orgA}`;
    ids.chapterB = `export-proof-b-${ids.orgB}`;
    ids.sessions = {
      [ids.admin]: ids.adminSession,
      [ids.coordinator]: ids.coordinatorSession,
      [ids.steward]: ids.stewardSession,
      [ids.member]: ids.memberSession,
      [ids.outsider]: ids.outsiderSession,
    };

    for (const [org, chapter, people] of [
      [ids.orgA, ids.chapterA, [[ids.admin, ids.adminSession, ["admin", "coordinator"]], [ids.coordinator, ids.coordinatorSession, ["coordinator"]], [ids.steward, ids.stewardSession, ["steward"]], [ids.member, ids.memberSession, []]]],
      [ids.orgB, ids.chapterB, [[ids.outsider, ids.outsiderSession, ["admin", "coordinator"]]]],
    ]) {
      const [firstUser] = people[0];
      for (const [user, session] of people) {
        await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
        await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
        await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic export factor','totp','verified',now(),now())", [randomUUID(), user]);
      }
      await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `export-proof-${org}`, firstUser]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9901)", [chapter, org]);
      // Keep the negative controls in the leadership-selected assigned-only mode.
      await client.query("insert into private.chapter_access_policies(chapter_id,steward_grievances) values($1,false)", [chapter]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
      for (const [user, , roles] of people) {
        await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
        await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
        await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, `Export Proof ${user.slice(0, 8)}`]);
        for (const role of roles) {
          await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [org, user, role]);
          await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
          await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
        }
      }
    }
    // Two cases in the first organization and one in the second. The titles and
    // references are distinctive so the shoulder test below can prove no row
    // content reached the audit row.
    for (const [caseId, owner] of [[ids.caseOne, ids.member], [ids.caseTwo, ids.member]]) {
      await client.query(
        "insert into public.member_cases(id,user_id,reference,title,case_type,step,status) values($1,$2,$3,'Synthetic export case title','other','Intake','active')",
        [caseId, owner, `EXPORTREF-${caseId.slice(0, 8)}`]);
    }
    // A restricted case in the first organization, seeded restricted at INSERT
    // because the restriction columns carry a BEFORE UPDATE staff guard. The
    // organization admin is an explicit restriction bypass and can export it;
    // the plain coordinator holds no casework_access_grants row and cannot even
    // see the case row.
    await client.query(
      `insert into public.member_cases(
         id,user_id,reference,title,case_type,step,status,
         is_restricted,restriction_reason,restricted_at,restricted_by)
       values($1,$2,$3,'Synthetic export case title','other','Intake','active',
         true,'sensitive investigation',now(),$4)`,
      [ids.restrictedCase, ids.member, `EXPORTREF-${ids.restrictedCase.slice(0, 8)}`, ids.admin]);
    await client.query("update public.member_profiles set chapter_id=$1 where id=$2", [ids.chapterB, ids.outsider]);
    await client.query(
      "insert into public.member_cases(id,user_id,reference,title,case_type,step,status) values($1,$2,$3,'Synthetic other-org case','other','Intake','active')",
      [ids.caseOther, ids.outsider, `EXPORTREF-${ids.caseOther.slice(0, 8)}`]);
    // A note body, so the shoulder test covers note text as well as case text.
    await client.query("insert into public.member_case_updates(case_id,user_id,body) values($1,$2,'Synthetic export note body')", [ids.caseOne, ids.member]);
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  });

  it("writes exactly one audit row naming the actor, the count and the case digests, and no case or note text", async () => {
    await as(ids.admin);
    const value = (await recordExport([ids.caseOne, ids.caseTwo], "selection")).rows[0].value;
    expect(value).toMatchObject({ scope: "selection", rowCount: 2, limit: 500, selectionLimit: 100 });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: ids.orgA,
      chapter_id: ids.chapterA,
      case_id: null,
      actor_user_id: ids.admin,
      event_type: "cases_exported",
      entity_type: "case_export",
      entity_id: value.exportId,
    });
    expect(rows[0].metadata.rowCount).toBe(2);
    expect(rows[0].metadata.scope).toBe("selection");
    expect([...rows[0].metadata.caseIdDigests].sort())
      .toEqual([digestOf(value.exportId, ids.caseOne), digestOf(value.exportId, ids.caseTwo)].sort());
    expect(Object.keys(rows[0].metadata).sort()).toEqual(["caseIdDigests", "filterKeys", "rowCount", "scope"]);
    // Shoulder test: the whole row, serialized, names no case reference, no
    // case title, no note body, no member name — and, since
    // SEC-UG-CASE-EXPORT-AUDIT-METADATA-VISIBILITY-20260921, no case id
    // either.
    const serialized = JSON.stringify(rows[0]);
    for (const text of ["EXPORTREF-", "Synthetic export case title", "Synthetic export note body", "Export Proof",
      ids.caseOne, ids.caseTwo]) {
      expect(serialized).not.toContain(text);
    }
  });

  it("records a visible-slice export as facet names and a count, never as ids or facet values", async () => {
    await as(ids.admin);
    await recordExport([ids.caseOne, ids.caseTwo], "visible", ["status", "step"]);
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].metadata).toEqual({ scope: "visible", rowCount: 2, filterKeys: ["status", "step"] });
    expect(rows[1].metadata.caseIdDigests).toBeUndefined();

    // A facet VALUE, a search string, or any unlisted key is refused outright.
    await refused("select public.casework_record_case_export($1::uuid[],'visible',$2::text[])",
      [[ids.caseOne], ["Ana Ruiz"]], "22023");
    await refused("select public.casework_record_case_export($1::uuid[],'visible',$2::text[])",
      [[ids.caseOne], ["search"]], "22023");
    await refused("select public.casework_record_case_export($1::uuid[],'everything',$2::text[])",
      [[ids.caseOne], []], "22023");
    expect(await auditRows()).toHaveLength(2);
  });

  it("refuses a request above either documented cap before it reads a single case", async () => {
    await as(ids.admin);
    const many = (count) => Array.from({ length: count }, () => randomUUID());
    expect(await refused("select public.casework_record_case_export($1::uuid[],'visible','{}'::text[])", [many(501)], "22023"))
      .toContain("limited to 500 cases");
    expect(await refused("select public.casework_record_case_export($1::uuid[],'selection','{}'::text[])", [many(101)], "22023"))
      .toContain("limited to 100 cases");
    await refused("select public.casework_record_case_export('{}'::uuid[],'visible','{}'::text[])", [], "22023");
    // The cap is not a client-side number: none of the three refusals wrote a
    // row, and none of them needed the ids to exist.
    expect(await auditRows()).toHaveLength(2);
  });

  it("holds a full selection export inside the audit metadata bound the cap was chosen for", async () => {
    await as(ids.admin, "postgres");
    const { rows } = await client.query(
      `insert into public.member_cases(user_id, reference, title, case_type, step, status)
       select $1, 'EXPORTREF-bulk-' || n, 'Synthetic export case title', 'other', 'Intake', 'active'
       from pg_catalog.generate_series(1, 98) n returning id`, [ids.member]);
    const selection = [ids.caseOne, ids.caseTwo, ...rows.map((row) => row.id)];
    expect(selection).toHaveLength(100);

    await as(ids.admin);
    expect((await recordExport(selection, "selection")).rows[0].value.rowCount).toBe(100);
    const recorded = (await auditRows()).at(-1);
    expect(recorded.metadata.caseIdDigests).toHaveLength(100);
    await as(ids.admin, "postgres");
    // casework_audit_metadata_bounded is 8192 bytes; 100 digests fit — they are
    // the same order of size as the uuids they replaced — and 500 would not,
    // which is exactly why the selection scope carries the smaller cap.
    expect((await client.query(
      "select pg_catalog.pg_column_size(metadata) size from public.casework_audit_events where entity_id=$1", [recorded.entity_id]))
      .rows[0].size).toBeLessThanOrEqual(8192);
    await as(ids.admin);
  }, 60_000);

  it("refuses any case the caller cannot read, inside their own organization and outside it", async () => {
    // The steward is chapter staff in the same organization but is neither
    // assigned to the case nor a coordinator, so the shared predicate says no.
    await as(ids.steward);
    expect(await refused("select public.casework_record_case_export($1::uuid[],'selection','{}'::text[])",
      [[ids.caseOne]], "P0002")).toContain("not authorized");

    // The other organization's admin cannot reach the first organization's
    // case at all, and cannot launder it by mixing in one of their own.
    await as(ids.outsider);
    await refused("select public.casework_record_case_export($1::uuid[],'selection','{}'::text[])", [[ids.caseOne]], "P0002");
    await refused("select public.casework_record_case_export($1::uuid[],'selection','{}'::text[])",
      [[ids.caseOther, ids.caseOne]], "P0002");
    // A repeated id cannot stand in for one the actor may not read.
    await refused("select public.casework_record_case_export($1::uuid[],'selection','{}'::text[])",
      [[ids.caseOther, ids.caseOther, ids.caseOne]], "P0002");
    // The member owns the case but is not staff, so they have no export at all.
    await as(ids.member);
    await refused("select public.casework_record_case_export($1::uuid[],'selection','{}'::text[])", [[ids.caseOne]], "P0002");

    await as(ids.admin);
    expect((await auditRows()).filter((row) => row.actor_user_id !== ids.admin)).toEqual([]);
  });

  // Review finding M1, live half: the receipt must be reachable through the one
  // surfaced reader of this sink, filtered by its own kind. Without the
  // re-emitted p_kind vocabulary this call is a 22023 and the operator can only
  // find the export by dumping every casework event.
  it("is readable back through the surfaced audit sink, filtered by its own kind", async () => {
    await as(ids.admin);
    const value = (await recordExport([ids.caseOne], "selection")).rows[0].value;
    const page = (await client.query(
      "select public.list_casework_audit_events(p_limit => 50, p_kind => 'cases_exported') value")).rows[0].value;
    const mine = page.filter((row) => row.entityId === value.exportId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      source: "casework_audit_events",
      kind: "cases_exported",
      organizationId: ids.orgA,
      actorUserId: ids.admin,
      caseId: null,
    });
    // The reader never returns the bounded metadata payload, so the ids and the
    // count stay behind the RPC exactly as every other kind does.
    expect(Object.keys(mine[0]).sort()).toEqual(
      ["actorUserId", "caseId", "chapterId", "createdAt", "entityId", "id", "kind", "organizationId", "source"]);

    // Only this lane's member was added: an unrelated kind is still refused.
    await refused("select public.list_casework_audit_events(p_limit => 50, p_kind => $1)", ["exported_cases"], "22023");
  });

  // Review finding L2: a repeated id must not inflate the recorded count.
  it("records the distinct case count when the request repeats an id", async () => {
    await as(ids.admin);
    const value = (await recordExport([ids.caseOne, ids.caseTwo, ids.caseOne], "selection")).rows[0].value;
    expect(value.rowCount).toBe(2);
    const recorded = (await auditRows()).at(-1);
    expect(recorded.metadata.rowCount).toBe(2);
    expect([...recorded.metadata.caseIdDigests].sort())
      .toEqual([digestOf(value.exportId, ids.caseOne), digestOf(value.exportId, ids.caseTwo)].sort());

    // The caps are measured against the same distinct count, so padding a
    // request with duplicates cannot push it over either one.
    await as(ids.admin, "postgres");
    const { rows } = await client.query(
      `insert into public.member_cases(user_id, reference, title, case_type, step, status)
       select $1, 'EXPORTREF-dup-' || n, 'Synthetic export case title', 'other', 'Intake', 'active'
       from pg_catalog.generate_series(1, 98) n returning id`, [ids.member]);
    await as(ids.admin);
    const hundred = [ids.caseOne, ids.caseTwo, ...rows.map((row) => row.id)];
    expect((await recordExport([...hundred, ...hundred], "selection")).rows[0].value.rowCount).toBe(100);
  }, 60_000);

  it("is executable by authenticated only, and no client may write the event type by hand", async () => {
    await as(ids.admin, "postgres");
    const { rows } = await client.query(
      `select grantee, privilege_type from information_schema.role_routine_grants
       where routine_name = 'casework_record_case_export' order by grantee`);
    expect(rows.map((row) => row.grantee)).toContain("authenticated");
    expect(rows.map((row) => row.grantee)).not.toContain("anon");

    await as(ids.admin);
    await refused(
      `insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
       values ($1, $2, null, $3, 'cases_exported', 'case_export', $4, '{}'::jsonb)`,
      [ids.orgA, ids.chapterA, ids.admin, randomUUID()], "42501");
  });

  // SEC-UG-CASE-EXPORT-AUDIT-METADATA-VISIBILITY-20260921. The receipt is a
  // null-case row, which casework_audit_events_staff_read shows to every
  // organization coordinator, while the same policy hides a case-scoped row
  // from a coordinator who is not authorized for the parent case. Two readers,
  // one row: the receipt stays visible to both, and the identifiers stay with
  // the reader who is already authorized for the case.
  it("shows the receipt to a second reader without naming a case they may not read", async () => {
    // Reader one exports, and is an explicit restriction bypass.
    await as(ids.admin);
    const value = (await recordExport([ids.caseOne, ids.restrictedCase], "selection")).rows[0].value;
    expect(value.rowCount).toBe(2);
    const recorded = (await auditRows()).at(-1);
    expect(recorded.entity_id).toBe(value.exportId);
    // The receipt is still an honest record of the selection: a reader holding
    // a case id can settle, case by case, whether it was in this export.
    expect([...recorded.metadata.caseIdDigests].sort())
      .toEqual([digestOf(value.exportId, ids.caseOne), digestOf(value.exportId, ids.restrictedCase)].sort());

    // Reader two is a plain organization coordinator — no advisor/admin/vp
    // role, no casework_access_grants row. The oracle first: their chapter
    // widening DOES cover this member, so the zero below is the restriction
    // gate and not a fixture that put them out of scope.
    await as(ids.coordinator);
    expect((await client.query("select public.staff_can_see_user($1,'coordinator') as ok", [ids.member])).rows[0].ok)
      .toBe(true);
    expect((await client.query("select count(*)::int n from public.member_cases where id = $1", [ids.restrictedCase]))
      .rows[0].n).toBe(0);

    // The receipt itself remains visible to them: an export is a tenant event,
    // not an event on one case.
    const seen = (await client.query(
      `select entity_id, case_id, actor_user_id, metadata from public.casework_audit_events
       where event_type = 'cases_exported' and entity_id = $1`, [value.exportId])).rows;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ case_id: null, actor_user_id: ids.admin });
    expect(seen[0].metadata).toMatchObject({ scope: "selection", rowCount: 2, filterKeys: [] });

    // And it names no case identifier. Before this repair the same row handed
    // this reader the restricted case's id in full.
    const metadata = JSON.stringify(seen[0].metadata);
    expect(metadata).not.toContain(ids.restrictedCase);
    expect(metadata).not.toContain(ids.caseOne);
    expect(seen[0].metadata.caseIds).toBeUndefined();
    // The digest is not a second copy of the id: it is only checkable by a
    // reader who already holds the id, which is what the fixture does here.
    expect(seen[0].metadata.caseIdDigests).toContain(digestOf(value.exportId, ids.restrictedCase));

    // The surfaced reader is unchanged for them: the receipt is listed, and the
    // bounded metadata payload never leaves the RPC at all.
    const page = (await client.query(
      "select public.list_casework_audit_events(p_limit => 50, p_kind => 'cases_exported') value")).rows[0].value;
    const mine = page.filter((row) => row.entityId === value.exportId);
    expect(mine).toHaveLength(1);
    expect(mine[0].metadata).toBeUndefined();
  });
});
