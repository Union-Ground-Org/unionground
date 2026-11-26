// @vitest-environment node
// REQ-UG-REQUEST-TO-JOIN-PAGE-20261017: offline pins on the migration
// that gives the landing table its request-to-join row shape, the owner access
// ledger and the three service-only functions. Live behaviour is
// tests/request-to-join-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { RESIDENCE_REGIONS } from "../src/lib/residenceRegions.js";
import { loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const NAME = "20261017224500_request_to_join_intake";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
const SUBMIT = "public.submit_join_request(p_email text, p_organization_name text, p_role text, p_size_band text, p_state text, p_phone text, p_note text, p_campaign_code text, p_website text, p_scope_hash text, p_email_scope_hash text)";
// The catalog spells the identity arguments out (pg_get_function_identity_arguments),
// so the contract entry says "timestamp with time zone", not the alias.
const LIST = "public.list_join_requests(p_status text, p_actor text, p_before timestamp with time zone, p_before_id uuid)";
const STATUS = "public.set_join_request_status(p_id uuid, p_status text, p_actor text)";
const SIGNATURES = [
  ["submit_join_request", "(text, text, text, text, text, text, text, text, text, text, text)"],
  ["list_join_requests", "(text, text, timestamptz, uuid)"],
  ["set_join_request_status", "(uuid, text, text)"],
];

function fn(name) {
  const entry = parseFunctions(sql, `${NAME}.sql`).find((row) => row.name === name);
  expect(entry, name).toBeTruthy();
  return stripComments(entry.source);
}

describe("request-to-join intake migration", () => {
  it("follows its prerequisites and runs as one forward-only transaction", () => {
    const names = migrationNames();
    for (const prerequisite of [
      "20260812130000_public_site_content_and_interest.sql",
      "20260831105356_public_interest_suppression.sql",
    ]) {
      expect(names).toContain(prerequisite);
      expect(names.indexOf(prerequisite)).toBeLessThan(names.indexOf(`${NAME}.sql`));
    }
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("notify pgrst, 'reload schema';");
  });

  it("adds the request-to-join row shape to the landing table without touching the landing shape", () => {
    expect(code).toContain("check (interest in ('chapter_updates', 'public_meetings', 'union_news', 'request_to_join'))");
    expect(code).toContain("check (source in ('public-landing', 'request-to-join'))");
    for (const column of ["organization_name", "role", "size_band", "state", "phone", "note", "campaign_code"]) {
      expect(code).toContain(`add column ${column} text`);
    }
    const shape = code.slice(
      code.indexOf("add constraint public_interest_submissions_request_to_join_shape"),
      code.indexOf("comment on column public.public_interest_submissions.organization_name"),
    );
    expect(shape).toContain("when source = 'request-to-join' then");
    expect(shape).toContain("interest = 'request_to_join'");
    expect(shape).toContain("role in ('officer', 'staff', 'steward', 'member', 'other')");
    expect(shape).toContain("size_band in ('under-100', '100-499', '500-1999', '2000-9999', '10000-plus')");
    expect(shape).toContain("campaign_code ~ '^[a-z0-9][a-z0-9-]{0,31}$'");
    expect(shape).toContain("interest <> 'request_to_join'");
    expect(shape).toContain("and campaign_code is null");
    // No tenant is ever assigned and no client grant or policy is added.
    expect(code).not.toContain("organization_id");
    expect(code).not.toMatch(/grant\s+[^;]*on\s+(table\s+)?public\.public_interest_submissions/i);
    expect(code).not.toMatch(/create policy/i);
  });

  it("keeps the owner access ledger definer-only and shaped per action", () => {
    const table = code.slice(
      code.indexOf("create table private.join_request_access_events"),
      code.indexOf("comment on table private.join_request_access_events"),
    );
    expect(table).toContain("action text not null check (action in ('list', 'status'))");
    expect(table).toContain("constraint join_request_access_events_shape check (");
    expect(table).toContain("alter table private.join_request_access_events enable row level security;");
    expect(table).toContain("alter table private.join_request_access_events force row level security;");
    expect(table).toContain("revoke all on private.join_request_access_events from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant\s+[^;]+on\s+(table\s+)?private\.join_request_access_events/i);
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual(expect.objectContaining({ table: "private.join_request_access_events", role, privileges: "" }));
    }
  });

  it("writes a request only behind the landing limits, the suppression check and the transaction lock, one per address", () => {
    const source = fn("public.submit_join_request");
    const order = [
      "if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then",
      "if pg_catalog.btrim(coalesce(p_website, '')) <> '' then",
      "p_scope_hash, 'network-15m', 20, interval '15 minutes'",
      "'VT','VA','WA','WV','WI','WY','AS','GU','MP','PR','VI','outside-us'",
      "p_email_scope_hash, 'email-interest-day', 3, interval '1 day'",
      "private.public_interest_suppression_scope(normalized_email)",
      "'public-interest-suppression:' || derived_suppression_scope_hash",
      "where suppression.suppression_scope_hash = derived_suppression_scope_hash",
      "normalized_email, null, 'request_to_join', 'en', 'request-to-join',",
      "on conflict (email, interest) do nothing",
      "stored := found;",
      "for update skip locked",
      "return pg_catalog.jsonb_build_object('accepted', true, 'stored', stored);",
    ];
    let at = -1;
    for (const needle of order) {
      const next = source.indexOf(needle, at + 1);
      expect(next, needle).toBeGreaterThan(at);
      at = next;
    }
    // The page offers exactly the regions the function accepts: one list, so a
    // code the page offers can never be silently dropped by the write
    // .
    const array = source.slice(source.indexOf("p_state <> all (array["), source.indexOf("]::text[])"));
    expect([...array.matchAll(/'([A-Za-z-]+)'/g)].map((match) => match[1])).toEqual(RESIDENCE_REGIONS.map((region) => region.code));
    expect(source).toContain("or normalized_email ~ '[[:cntrl:]]'");
    // Duplicates never re-arm an answered request, and nothing is updated.
    expect(source).not.toContain("do update");
    expect(source).not.toContain("status = 'new'");
    // All three functions are definers with the empty search path pinned.
    expect(code.match(/security definer\s+set search_path = ''/g)).toHaveLength(3);
  });

  it("gives the owner a read and a status path that each write one audit row and refuse other roles", () => {
    const list = fn("public.list_join_requests");
    expect(list).toContain("if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then");
    expect(list).toContain("raise exception 'actor required'");
    expect(list).toContain("where s.source = 'request-to-join'");
    expect(list).toContain("raise exception 'cursor needs both parts'");
    expect(list).toContain("or (s.last_submitted_at = p_before and s.id > p_before_id))");
    // One statement feeds the page, the cursor and hasMore.
    expect(list).toContain("order by s.last_submitted_at desc, s.id\n    limit 501");
    expect(list.match(/from public\.public_interest_submissions s/g)).toHaveLength(1);
    expect(list).toContain("has_more := fetched > 500;");
    expect(list).toContain("requests_json := requests_json - 500;");
    expect(list).toContain("'hasMore', has_more,");
    expect(list).toContain("'cursorSubmittedAt', case when total > 0 then requests_json -> (total - 1) -> 'lastSubmittedAt' end,");
    expect(list).toContain("'cursorId', case when total > 0 then requests_json -> (total - 1) -> 'id' end");
    expect(list).toContain("insert into private.join_request_access_events (actor, action, status_filter, row_count)");
    expect(list.indexOf("from public.public_interest_submissions s")).toBeLessThan(list.indexOf("insert into private.join_request_access_events"));

    const status = fn("public.set_join_request_status");
    expect(status).toContain("if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then");
    expect(status).toContain("p_status not in ('new', 'contacted', 'closed')");
    expect(status).toContain("where id = p_id and source = 'request-to-join'");
    expect(status).toContain("for update;");
    expect(status).toContain("'refusal', 'not-found'");
    expect(status).toContain("'refusal', 'unchanged'");
    expect(status).toContain("insert into private.join_request_access_events (actor, action, request_id, from_status, to_status)");
    expect(status.indexOf("update public.public_interest_submissions")).toBeLessThan(status.indexOf("insert into private.join_request_access_events"));

    for (const [name, signature] of SIGNATURES) {
      const escaped = signature.replace(/[()]/g, "\\$&");
      expect(code).toMatch(new RegExp(`revoke all on function public\\.${name}${escaped}\\s+from public, anon, authenticated, service_role;`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${name}${escaped}\\s+to service_role;`));
      expect(code).not.toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\([^)]*\\)\\s+to\\s+[^;]*(?:anon|authenticated|public)`, "i"));
    }
  });

  it("is pinned in the database contract and the required disposable proof lane", () => {
    for (const sig of [SUBMIT, LIST, STATUS]) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry, sig).toBeTruthy();
      expect(entry.secdef).toBe(true);
      expect(entry.exec).toBe("service_role");
      const body = fn(sig.slice(0, sig.indexOf("(")));
      for (const needle of entry.bodyContains) expect(body, needle).toContain(needle);
      for (const needle of entry.bodyForbids ?? []) expect(body, needle).not.toContain(needle);
    }
    expect(PROOF_FILES).toContain("tests/request-to-join-db.test.js");
  });
});
