// @vitest-environment node
//
// REQ-UG-CONNECTION-SUGGESTIONS-20260927 (backend persistence half).
//
// Opt-in CHAPTER / LOCAL connection profiles, a keyset-paged published
// registry bound to a snapshot epoch, reciprocal hides, a reviewed-source
// boundary that derives contributors from real tenant records, and frozen
// quarterly aggregates published as coarse bands.
//
// The static half pins the text of 20260928103000 (tables, grants, gates,
// vocabularies, parser allowlist, projection). The live half runs the RPCs as
// real authenticated JWT callers against a disposable proof database
// (SUPABASE_DB_URL) with EVERY migration applied, so it asserts the combined
// behaviour of 20260928103000 and the 20260928103100 review repairs (same-org
// siblings are candidates, the snapshot token carries a scope hash, a NULL
// "reviewed" marker row per source, strict >= 25 complement, registry
// triggers that also advance the epoch). It is skipped without a database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeOnly, graphWriter, helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { CONNECTION_ISSUE_TOPICS, CONNECTION_SECTORS, MIN_CONNECTION_CONTRIBUTORS } from "../src/features/connectionSuggestions/contract.js";
import { fnBody, latestFnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const NAME = "20260928103000_chapter_connection_suggestions_backend";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const functions = parseFunctions(sql, `${NAME}.sql`);
const adapterSource = readFileSync(new URL("../src/features/connectionSuggestions/adapter.js", import.meta.url), "utf8");
const contractSql = readFileSync(new URL("./sql/connection-suggestions-contract.sql", import.meta.url), "utf8");
// The ledger's metadata key allowlist, as last widened.
const LEDGER_KEYS = new Set(
  [...stripComments(loadMigrationSql("20260911070000_automation_shared_intelligence_v3"))
    .match(/metadata - array\[([\s\S]*?)\]/)[1].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]),
);

const RPCS = {
  "public.get_chapter_connection_workspace": "text, text",
  "public.save_chapter_connection_profile": "text, text, jsonb, boolean",
  "public.withdraw_chapter_connection_profile": "text, text",
  "public.set_chapter_connection_hidden": "text, text, text, boolean",
  "public.set_chapter_connection_source_tags": "text, text, text, uuid, text[]",
  "public.freeze_chapter_connection_issue_aggregates": "text, text",
  "public.list_chapter_connection_profiles": "text, text, integer, text",
};
const READERS = ["public.get_chapter_connection_workspace", "public.list_chapter_connection_profiles"];
const WRITERS = Object.keys(RPCS).filter((name) => !READERS.includes(name));
const PRIVATE_TABLES = [
  "chapter_connection_registry_epoch",
  "chapter_connection_profiles",
  "chapter_connection_hides",
  "chapter_connection_source_tags",
  "chapter_connection_aggregate_runs",
  "chapter_connection_issue_aggregates",
];
const GRAPH_TABLES = PRIVATE_TABLES.filter((table) => table !== "chapter_connection_registry_epoch");

const fn = (name) => {
  const entry = functions.find((row) => row.name === name);
  expect(entry, name).toBeTruthy();
  return entry;
};
const body = (name) => codeOnly(fn(name).source);
const PERSON_OR_COUNT = /\b(count|counts|summary|contributor|contributors|user_id|email)\b/;

describe("chapter connection suggestions migration (static)", () => {
  it("runs as one forward-only transaction after everything it depends on", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    expect(names).toContain(`${NAME}.sql`);
    expect(NAME > "20260927110100_uniondemo_production_removal_window_relock").toBe(true);
    for (const dependency of [
      "20260907150000_account_lifecycle_manifest",
      "20260925960000_catalog_organization_self_placement",
      "20260925995000_member_case_visibility_row_helper",
      "20260828034122_member_engagement_completion",
      "20260821012000_mobile_ship_complete_workflows",
    ]) expect(names.some((name) => name.startsWith(dependency)) && NAME > dependency, dependency).toBe(true);
  });

  it("grants each of the seven RPCs to authenticated only, as SECURITY DEFINER with an empty search_path", () => {
    for (const [name, args] of Object.entries(RPCS)) {
      const bare = name.replace("public.", "");
      expect(code).toContain(`revoke all on function ${name}(${args})\n  from public, anon, authenticated, service_role;`);
      expect(code).toContain(`grant execute on function ${name}(${args}) to authenticated;`);
      expect(code).not.toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${name.replace(".", "\\.")}\\([^)]*\\)\\s+to\\s+[^;]*(anon|service_role|public)`, "i"));
      const declaration = fnBody(sql, name);
      expect(declaration).toMatch(/\nsecurity definer\n/);
      expect(declaration).toMatch(/\nset search_path = ''\n/);
      expect(bare.startsWith("get_") || bare.startsWith("list_")
        ? /\nstable\nsecurity definer/.test(declaration)
        : !/\nstable\n/.test(declaration), `${name} volatility`).toBe(true);
    }
    const publicFunctions = functions.filter((row) => row.name.startsWith("public."));
    expect(publicFunctions.map((row) => row.name).sort()).toEqual(Object.keys(RPCS).sort());
  });

  it("revokes every private helper from every client role and grants none", () => {
    const privateFunctions = functions.filter((row) => row.name.startsWith("private."));
    expect(privateFunctions.length).toBeGreaterThanOrEqual(18);
    for (const row of privateFunctions) {
      expect(code, row.name).toMatch(new RegExp(`revoke all on function ${row.name.replace(".", "\\.")}\\([^)]*\\)\\s+from public, anon, authenticated, service_role;`));
    }
    expect(code).not.toMatch(/grant\s+execute\s+on\s+function\s+private\./i);
    for (const row of functions) {
      expect(fnBody(sql, row.name), row.name).toMatch(/set search_path = ''/);
    }
  });

  it("creates six private tables with FORCE row level security, no client grant and no policy", () => {
    for (const table of PRIVATE_TABLES) {
      expect(code).toContain(`create table private.${table} (`);
      expect(code).toContain(`alter table private.${table} enable row level security;`);
      expect(code).toContain(`alter table private.${table} force row level security;`);
      expect(code).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
    }
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/\bgrant\s+(?!execute)[a-z, ]+\s+on\s+(table\s+)?private\./i);
    expect(code).not.toMatch(/create\s+table\s+public\./i);
    expect(code).not.toMatch(/insert\s+into\s+public\.(organizations|chapters|member_profiles|union_orgs)\b/i);
  });

  it("joins the five foreign-keyed tables to the case graph and reviews their triggers", () => {
    for (const table of GRAPH_TABLES) {
      expect(code).toContain(`create trigger a00_case_graph_lock before insert or update or delete on private.${table}\nfor each statement execute function private.lock_case_graph_statement();`);
    }
    for (const table of GRAPH_TABLES.filter((name) => name !== "chapter_connection_source_tags")) {
      expect(code).toContain(`on private.${table}\nfor each row execute function private.lock_case_graph_row_keys('', '');`);
    }
    expect(code).toContain("on private.chapter_connection_source_tags\nfor each row execute function private.lock_case_graph_row_keys('{contributor_user_id}', '{case_id}');");
    expect(code).toContain("insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)");
    for (const table of GRAPH_TABLES) expect(code).toContain(`'${table}'`);
    expect(code).toContain("select 1 from private.account_lifecycle_referential_action_trigger_issues()");
    expect(code).toContain("select 1 from private.account_lifecycle_unmanaged_restrictive_fks()");
    expect(code).toContain("select 1 from private.account_lifecycle_unmanaged_export_fks()");
    expect(code).not.toMatch(/on private\.chapter_connection_registry_epoch\nfor each/);
  });

  it("reviews the one auth.users column in the lifecycle manifest as cascade + excluded_with_reason", () => {
    expect(code).toContain("values ('private', 'chapter_connection_source_tags', 'contributor_user_id', 'cascade',\n  'excluded_with_reason', 'auth_user_fk',");
    expect(code).toContain("contributor_user_id uuid not null\n    references auth.users(id) on delete cascade");
    expect([...code.matchAll(/references auth\.users\(id\)/g)]).toHaveLength(1);
  });

  it("pins the canonical issue taxonomy, the frontend sector list and issue-keyed expertise", () => {
    expect(body("private.chapter_connection_issue_keys")).toContain(
      "'staffing', 'scheduling', 'pay', 'benefits', 'safety', 'discipline',\n    'discrimination', 'workload', 'training', 'contract-enforcement'",
    );
    const issueLiterals = [...body("private.chapter_connection_issue_keys").matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
    expect(issueLiterals).toEqual([...CONNECTION_ISSUE_TOPICS]);
    const sectorLiterals = [...body("private.chapter_connection_sector_keys").matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
    expect(sectorLiterals.sort()).toEqual([...CONNECTION_SECTORS].sort());
    expect(body("private.chapter_connection_expertise_keys").trim()).toBe("select private.chapter_connection_issue_keys();");
  });

  it("bounds every list and enum on the profile table with CHECK constraints and holds no count or person", () => {
    const table = code.slice(code.indexOf("create table private.chapter_connection_profiles ("), code.indexOf("create index chapter_connection_profiles_published_idx"));
    expect(table).toContain("check (kind in ('chapter', 'local'))");
    expect(table).toContain("check (location_country ~ '^[A-Z]{2}$')");
    expect(table).toContain("check (location_state ~ '^[A-Z]{2,3}$')");
    expect(table).toContain("location_metro !~ '[[:digit:]]{5,}'");
    expect(table).toContain("check (private.chapter_connection_keys_valid(sector_keys, private.chapter_connection_sector_keys(), 5))");
    expect(table).toContain("check (private.chapter_connection_keys_valid(expertise_offered, private.chapter_connection_expertise_keys(), 10))");
    expect(table).toContain("check (private.chapter_connection_keys_valid(declared_issue_keys, private.chapter_connection_issue_keys(), 10))");
    expect(table).toContain("check (declared_local_key ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$')");
    expect(table).toContain("check (publication_status in ('draft', 'published', 'withdrawn'))");
    expect(table).toContain("and expires_at = published_at + interval '180 days'");
    expect(table).toContain("and consent_version is not null and consent_recorded_at is not null and consent_hat is not null");
    expect(table).not.toMatch(PERSON_OR_COUNT);
    const valid = body("private.chapter_connection_keys_valid");
    expect(valid).toContain("pg_catalog.array_position(p_keys, null) is null");
    expect(valid).toContain("p_keys <@ p_allowed");
    expect(valid).toContain("select pg_catalog.count(distinct key) from pg_catalog.unnest(p_keys) as key");
  });

  it("parses the profile payload against a closed field allowlist and refuses everything else", () => {
    const parse = body("private.chapter_connection_parse_profile");
    expect(parse).toContain("'kind', 'location', 'sectorkeys', 'expertiseoffered', 'declaredissuekeys',\n      'declaredlocalkey', 'declaredunionfamilykey', 'shareanalyzedissues'");
    expect(parse).toContain("raise exception 'unknown profile field: %', field using errcode = '22023'");
    expect(parse).toContain("raise exception 'unknown location field: %', field using errcode = '22023'");
    expect(parse).toContain("raise exception 'profile must be an object'");
    expect(parse).toContain("raise exception 'profile location required'");
    expect(parse).toContain("kind not in ('chapter', 'local')");
    expect(parse).toContain("raise exception 'declared local key unavailable'");
    expect(parse).toContain("private.organization_catalog_parent(declared_local)");
    expect(parse).toContain("raise exception 'share analyzed issues must be boolean'");
    const allowlist = parse.slice(parse.indexOf("field <> all (array["), parse.indexOf("]) then"));
    for (const forbidden of ["issuepriorities", "contributor", "count", "summary", "displayname", "publication", "organizationid"]) {
      expect(allowlist).not.toContain(forbidden);
    }
    const save = body("public.save_chapter_connection_profile");
    expect(save).toContain("parsed := private.chapter_connection_parse_profile(p_profile);");
    expect(save).toContain("raise exception 'publish flag required'");
    expect(save).toContain("raise exception 'profile change limit'");
    expect(save).toContain("private.chapter_connection_recent_events(org, chapter, 'chapter_connection_profile_saved') >= 30");
  });

  it("derives the organization from the session and validates the hat as an exact granted role, null-safe", () => {
    for (const name of Object.keys(RPCS)) {
      const source = body(name);
      expect(source, name).toContain("org := private.mi1_require_selected_organization();");
      expect(source, name).toContain("private.chapter_connection_require_hat(");
      expect(source, name).not.toMatch(/p_organization_id|p_expected_organization/);
    }
    for (const name of WRITERS) expect(body(name), name).toContain("array['advisor', 'admin', 'vp']");
    for (const name of READERS) expect(body(name), name).toContain("array['steward', 'coordinator', 'advisor', 'admin', 'vp']");
    const allows = body("private.chapter_connection_hat_allows");
    expect(allows).toContain("when p_selected_hat is null\n      or p_selected_hat <> all (p_allowed_hats)");
    expect(allows).toContain("when private.has_organization_role(p_organization_id, array[p_selected_hat]) then true");
    expect(allows).toContain("and private.member_has_chapter_role(p_chapter_id, array[p_selected_hat])");
    expect(allows).toContain("private.chapter_connection_chapter_organization(p_chapter_id) = p_organization_id");
    expect(body("private.chapter_connection_require_chapter")).toContain("raise exception 'chapter outside organization' using errcode = '42501'");
    const workspace = body("public.get_chapter_connection_workspace");
    expect(workspace.indexOf("chapter_connection_require_chapter(")).toBeLessThan(workspace.indexOf("chapter_connection_require_hat("));
    expect(workspace).toContain("private.current_member_chapter()");
    expect(workspace).toContain("private.chapter_connection_hat_allows(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp'])");
  });

  it("takes the case-graph gate first in every writer and never writes from a reader", () => {
    for (const name of WRITERS) {
      const source = fn(name).source;
      expect(helperFirst(source), name).toBe(true);
      expect(/^\s*declare\b[\s\S]*?(?::=|\bdefault\b)[\s\S]*?\bbegin\b/.test(codeOnly(source)), `${name} initializer precedes helper`).toBe(false);
      expect(codeOnly(source)).toMatch(/^\s*declare[\s\S]*?\bbegin\s+perform private\.lock_case_graph\(array\[\(select auth\.uid\(\)\)\], array\[\]::uuid\[\]\);/);
    }
    for (const name of READERS) {
      const source = body(name);
      expect(graphWriter(source), name).toBe(false);
      expect(source, name).not.toMatch(/\b(insert\s+into|update\s+private|delete\s+from|for\s+update|for\s+share|pg_advisory)/);
      expect(source, name).not.toMatch(/chapter_connection_audit\(|chapter_connection_bump_epoch\(/);
    }
    expect(helperFirst(fn("private.chapter_connection_audit").source)).toBe(true);
    expect(body("private.chapter_connection_audit")).toContain("insert into public.organization_audit_ledger");
  });

  it("writes content-free audit rows inside the ledger's key allowlist", () => {
    const audit = body("private.chapter_connection_audit");
    expect(audit).toContain("'administration', p_event_type, 'update', (select auth.uid()),\n    'chapter', p_chapter_id, extensions.gen_random_uuid()");
    expect(LEDGER_KEYS.size).toBeGreaterThan(30);
    const lowerAllowlist = new Set([...LEDGER_KEYS].map((key) => key.toLowerCase()));
    let seen = 0;
    for (const name of WRITERS) {
      for (const call of body(name).matchAll(/chapter_connection_audit\([\s\S]*?jsonb_build_object\(([\s\S]*?)\)\s*\)\s*;/g)) {
        // A key is a quoted word followed by a comma and a non-string value.
        for (const key of call[1].matchAll(/'([a-z]+)',(?=\s*[^\s'])/g)) {
          seen += 1;
          expect(lowerAllowlist.has(key[1]), `${name} metadata key ${key[1]}`).toBe(true);
        }
        expect(call[1]).not.toMatch(/p_source_id|topics|contributor|occurred_at|p_target|target\b|p_profile|parsed/);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });

  it("derives the contributor and occurrence time from the source row and trusts no client count", () => {
    const tags = body("public.set_chapter_connection_source_tags");
    expect(fnBody(sql, "public.set_chapter_connection_source_tags")).toContain(
      "p_selected_hat text,\n  p_chapter_id text,\n  p_source_kind text,\n  p_source_id uuid,\n  p_topic_keys text[]\n)",
    );
    expect(tags).toContain("select c.user_id, c.updated_at, c.status into contributor, occurred_at, source_status\n    from public.member_cases c");
    expect(tags).toContain("or source_status <> 'resolved'\n       or not private.casework_can_read(p_source_id)\n       or not private.member_case_visible_to_caller(p_source_id)");
    expect(tags).toContain("select s.respondent_user_id, s.submitted_at, s.status, v.chapter_id");
    expect(tags).toContain("or source_status <> 'submitted'");
    expect(tags).toContain("select e.user_id, e.responded_at, e.state, pr.chapter_id");
    expect(tags).toContain("or source_status <> 'responded'");
    expect((tags.match(/perform private\.engagement_require_staff\(org\);/g) || []).length).toBe(2);
    expect((tags.match(/raise exception 'source record unavailable' using errcode = '22023'/g) || []).length).toBe(4);
    expect(tags).toContain("and c.organization_id = org\n      and c.chapter_id = chapter;");
    expect(tags).toContain("and s.organization_id = org;");
    expect(tags).toContain("and e.organization_id = org;");
    expect(tags).toContain("m.user_id = contributor and m.chapter_id = chapter and m.status = 'active'");
    expect(tags).toContain("raise exception 'source kind invalid'");
    expect(tags).toContain("raise exception 'topic keys invalid'");
    expect(tags).toContain("private.chapter_connection_keys_valid(topics, private.chapter_connection_issue_keys(), 10)");
    expect(tags).toContain("set status = 'removed', updated_at = pg_catalog.now()\n  where t.source_kind = kind\n    and t.source_id = p_source_id\n    and t.status = 'confirmed'\n    and t.topic_key <> all (topics);");
    expect(tags).toContain("on conflict (source_kind, source_id, topic_key) do update\n    set status = 'confirmed'");
    const table = code.slice(code.indexOf("create table private.chapter_connection_source_tags ("), code.indexOf("create index chapter_connection_source_tags_window_idx"));
    expect(table).toContain("source_id uuid generated always as (coalesce(case_id, survey_session_id, pulse_event_id)) stored");
    expect(table).toContain("references public.member_cases(id) on delete cascade");
    expect(table).toContain("references public.organization_survey_sessions(id) on delete cascade");
    expect(table).toContain("references public.organization_pulse_events(id) on delete cascade");
    expect(table).toContain("check (topic_key = any (private.chapter_connection_issue_keys()))");
  });

  it("freezes the previous UTC calendar quarter once, counts each contributor once per topic, and publishes bands only", () => {
    const freeze = body("public.freeze_chapter_connection_issue_aggregates");
    expect(freeze).toContain("select * into quarter from private.chapter_connection_previous_quarter();");
    expect(freeze).toContain("already := found;");
    expect(freeze).toContain("if not already then");
    expect(freeze).toContain("pg_catalog.count(distinct t.contributor_user_id) as contributors");
    expect(freeze).toContain(`where per_topic.contributors >= ${MIN_CONNECTION_CONTRIBUTORS}`);
    expect(freeze).toContain(`total.contributors - per_topic.contributors >= ${MIN_CONNECTION_CONTRIBUTORS}`);
    expect(freeze).toContain("when per_topic.contributors * 3 <= total.contributors then 'some'");
    expect(freeze).toContain("when per_topic.contributors * 3 <= total.contributors * 2 then 'many'");
    expect(freeze).toContain("and t.source_occurred_at >= quarter.starts_at\n        and t.source_occurred_at < quarter.ends_at");
    const returned = freeze.slice(freeze.lastIndexOf("return pg_catalog.jsonb_build_object("));
    expect(returned).not.toMatch(/contributors|count\(/);
    expect(code).toContain("published_topic_count integer not null default 0");
    expect(code).toContain("check (band in ('some', 'many', 'most'))");
    const quarter = body("private.chapter_connection_previous_quarter");
    expect(quarter).toContain("pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'utc') - interval '3 months'");
    expect(quarter).toContain("'yyyy\"q\"q'");
    const strengths = body("private.chapter_connection_band_strength");
    expect(strengths).toContain("when 'some' then 0.25");
    expect(strengths).toContain("when 'many' then 0.50");
    expect(strengths).toContain("when 'most' then 0.75");
  });

  it("projects exactly the engine contract, labels issue origin, and never a count, a source row or a person", () => {
    const projection = body("private.chapter_connection_profile_projection");
    for (const key of ["'id'", "'kind'", "'displayname'", "'profilerevision'", "'publication'", "'location'", "'sectorkeys'", "'issuepriorities'", "'expertiseoffered'", "'localkey'", "'unionfamilykey'", "'identityprovenance'", "'sourceasof'"]) {
      expect(projection).toContain(key);
    }
    expect(projection).not.toMatch(PERSON_OR_COUNT);
    expect(projection).not.toMatch(/source_tags|organization_id/);
    const priorities = body("private.chapter_connection_issue_priorities");
    expect(priorities).toContain("case when m.declared then 1.0 else private.chapter_connection_band_strength(m.band) end");
    expect(priorities).toContain("case when m.declared then 'declared' else 'analyzed' end");
    expect(priorities).toContain("where p_row.share_analyzed_issues");
    expect(priorities).toContain("select pg_catalog.max(r.period_key)");
    const identity = body("private.chapter_connection_identity");
    expect(identity).toContain("from public.chapter_union_org_bindings b\n  join public.union_orgs u on u.id = b.union_org_id\n  where b.chapter_id = p_chapter_id\n    and b.status = 'verified'");
    expect(identity).toContain("'localkey', 'olms-' || verified.olms_file_number::text,\n      'localkeysource', 'verified'");
    expect(identity).toContain("'localkeysource', case when p_declared_local_key is null then null else 'declared' end");
  });

  it("pages the registry by chapter id under an epoch-bound snapshot token, excluding hidden pairs and expired rows", () => {
    const list = body("public.list_chapter_connection_profiles");
    expect(list).toContain("cap := least(greatest(coalesce(p_limit, 250), 1), 500);");
    expect(list).toContain("raise exception 'connection registry snapshot token invalid'");
    expect(list).toContain("raise exception 'connection registry snapshot changed'");
    expect(list).toContain("raise exception 'connection registry snapshot expired'");
    expect(list).toContain("or snapshot_at < pg_catalog.now() - interval '1 hour'");
    expect(list).toContain("limit cap + 1");
    expect(list).toContain("and p.expires_at > snapshot_at");
    expect(list).toContain("join public.organizations o on o.id = p.organization_id and o.status = 'active'");
    expect(list).toContain("where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)\n           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)");
    expect(list).toContain("and (after_id is null or p.chapter_id collate \"c\" > after_id collate \"c\")");
    expect(list).toContain("'nextcursor', case when fetched > cap then last_id else null end,\n    'complete', fetched <= cap");
    expect(list).not.toMatch(/limit\s+1000/);
    const save = body("public.save_chapter_connection_profile");
    expect(save).toContain("if prior_status = 'published' or next_status = 'published' then\n    perform private.chapter_connection_bump_epoch();");
    expect(body("public.withdraw_chapter_connection_profile")).toContain("perform private.chapter_connection_bump_epoch();");
    expect(body("public.freeze_chapter_connection_issue_aggregates")).toContain("and p.share_analyzed_issues\n    ) then\n      perform private.chapter_connection_bump_epoch();");
    const hidden = body("public.set_chapter_connection_hidden");
    expect(hidden).toContain("raise exception 'target chapter unavailable'");
    expect(hidden).toContain("and p.publication_status = 'published'\n        and p.expires_at > pg_catalog.now()");
  });

  // REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031
  // adds the standing-offer and partner-invitation RPCs to the same adapter.
  const PARTNER_OFFICE_RPCS = ["list_partner_offices_not_on_platform", "list_chapter_handshake_offers", "create_chapter_handshake_offer",
    "withdraw_chapter_handshake_offer", "request_partner_founder_invitation"].map((name) => `public.${name}`);
  it("matches the controller adapter's RPC names and argument names against the latest definitions", () => {
    const calls = [...adapterSource.matchAll(/rpc\("([a-z_]+)",\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const [, name, args] of calls) {
      expect([...Object.keys(RPCS), "public.request_chapter_connection_handshake", ...PARTNER_OFFICE_RPCS], `${name} is one of the shipped RPCs`).toContain(`public.${name}`);
      const declaration = latestFnBody(`public.${name}`);
      const params = new Set([...declaration.matchAll(/\b(p_[a-z_]+)\s+(text|jsonb|boolean|uuid|integer|text\[\])/g)].map((match) => match[1]));
      for (const argument of args.matchAll(/\b(p_[a-z_]+)\s*:/g)) {
        expect(params.has(argument[1]), `${name}.${argument[1]}`).toBe(true);
      }
    }
  });

  it("ships a SQL contract that pins every private table and RPC it creates", () => {
    for (const table of PRIVATE_TABLES) expect(contractSql).toContain(`'private.${table}'`);
    for (const name of Object.keys(RPCS)) expect(contractSql).toContain(`'${name.replace("public.", "")}'`);
    expect(contractSql).toContain("set local role authenticated;");
    expect(contractSql).toContain("reset role;");
  });
});

// ---------------------------------------------------------------------------
// Live half: the RPCs as authenticated JWT callers on a disposable database.
// ---------------------------------------------------------------------------

const ID = {
  orgA: "50927000-0000-4000-8000-00000000000a",
  orgB: "50927000-0000-4000-8000-00000000000b",
  orgC: "50927000-0000-4000-8000-00000000000c",
  adminA: "50927000-0000-4000-8000-000000000101",
  stewardA: "50927000-0000-4000-8000-000000000102",
  chapterAdminA1: "50927000-0000-4000-8000-000000000103",
  memberA: "50927000-0000-4000-8000-000000000104",
  adminB: "50927000-0000-4000-8000-000000000105",
  adminC: "50927000-0000-4000-8000-000000000106",
  survey: "50927000-0000-4000-8000-000000000301",
  prompt: "50927000-0000-4000-8000-000000000302",
};
const CH = { a1: "cs-a1", a2: "cs-a2", b1: "cs-b1", b2: "cs-b2", c1: "cs-c1" };
const CONTRIBUTORS = 80;
const contributor = (n) => `50927000-0000-4000-8000-0000000${String(1000 + n).padStart(5, "0")}`;
const caseOf = (n) => `50927000-0000-4000-8000-0000000${String(2000 + n).padStart(5, "0")}`;
const sessionOf = (n) => `50927000-0000-4000-8000-0000000${String(3000 + n).padStart(5, "0")}`;
const eventOf = (n) => `50927000-0000-4000-8000-0000000${String(4000 + n).padStart(5, "0")}`;
const sessionFor = (userId) => `50927000-0000-4000-8000-${userId.slice(-12).replace(/^0/, "9")}`;
const TOKEN = /^\d+:\d+:[a-f0-9]{32}$/;
const LIVE_TIMEOUT = 90_000;
// Words that must never appear in anything the registry publishes. Whole
// words, so "country" is not read as "count".
const LEAK = /\b(contributor|contributors|count|counts|user_id|userId|email|respondent)\b/i;

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter connection suggestions on a disposable database", () => {
  let db;
  let quarter;

  async function as(userId, statement, values = []) {
    const savepoint = `cs_as_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db.query(`savepoint ${savepoint}`);
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionFor(userId), aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query(`release savepoint ${savepoint}`);
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query(`rollback to savepoint ${savepoint}`);
      await db.query(`release savepoint ${savepoint}`);
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }
  const rpc = async (userId, name, params) => {
    const keys = Object.keys(params);
    const result = await as(userId, `select public.${name}(${keys.map((key, index) => `${key} := $${index + 1}`).join(", ")}) as value`, keys.map((key) => params[key]));
    return { ...result, value: result.rows[0]?.value };
  };
  const ids = (page) => page.value.rows.map((row) => row.id);
  const epoch = async () => BigInt((await db.query("select epoch from private.chapter_connection_registry_epoch")).rows[0].epoch);
  const profileInput = (extra = {}) => ({
    location: { country: "us", state: "ma", metro: "Greater Boston" },
    sectorKeys: ["healthcare", "public-services"],
    expertiseOffered: ["staffing", "safety"],
    declaredIssueKeys: ["pay"],
    ...extra,
  });
  async function within(name, run) {
    await db.query(`savepoint ${name}`);
    try { await run(); } finally {
      await db.query(`rollback to savepoint ${name}`);
      await db.query(`release savepoint ${name}`);
    }
  }
  async function publishAll() {
    for (const [userId, chapter, extra] of [
      [ID.adminB, CH.b1, {}],
      [ID.adminB, CH.b2, { location: { country: "US", state: "NY" } }],
      [ID.adminC, CH.c1, { kind: "local", declaredLocalKey: null, declaredUnionFamilyKey: "afscme" }],
      [ID.adminA, CH.a1, {}],
      [ID.adminA, CH.a2, {}],
    ]) {
      const saved = await rpc(userId, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: chapter, p_profile: JSON.stringify(profileInput(extra)), p_publish: true });
      expect(saved, `${chapter}: ${saved.message}`).toMatchObject({ code: "" });
    }
  }
  async function tag(userId, kind, sourceId, topics, chapter = CH.a1) {
    const result = await rpc(userId, "set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: chapter, p_source_kind: kind, p_source_id: sourceId, p_topic_keys: topics });
    expect(result, `${kind} ${sourceId}: ${result.message}`).toMatchObject({ code: "" });
    return result.value;
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapter-connection-suggestions-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");

    quarter = (await db.query(`
      select to_char(date_trunc('quarter', now() at time zone 'utc') - interval '3 months', 'YYYY"Q"Q') as key,
             ((date_trunc('quarter', now() at time zone 'utc') - interval '3 months') at time zone 'utc') as starts_at
    `)).rows[0];

    const actors = [
      [ID.adminA, ID.orgA, CH.a1], [ID.stewardA, ID.orgA, CH.a1], [ID.chapterAdminA1, ID.orgA, CH.a1],
      [ID.memberA, ID.orgA, CH.a1], [ID.adminB, ID.orgB, CH.b1], [ID.adminC, ID.orgC, CH.c1],
    ];
    const contributors = Array.from({ length: CONTRIBUTORS }, (_, index) => [contributor(index + 1), ID.orgA, CH.a1]);
    for (const [userId] of [...actors, ...contributors]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [userId, `${userId}@example.invalid`]);
    }
    for (const [org, slug] of [[ID.orgA, "cs-org-a"], [ID.orgB, "cs-org-b"], [ID.orgC, "cs-org-c"]]) {
      await db.query("insert into public.organizations(id, slug, name, created_by) values ($1, $2, $3, null)", [org, slug, `Connection ${slug}`]);
      await db.query("insert into public.org_security_policy(id, organization_id, require_staff_mfa) values (true, $1, true)", [org]);
    }
    let order = 9500;
    for (const [chapter, org] of [[CH.a1, ID.orgA], [CH.a2, ID.orgA], [CH.b1, ID.orgB], [CH.b2, ID.orgB], [CH.c1, ID.orgC]]) {
      await db.query(
        "insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, $2, $1, $3, false, $4)",
        [chapter, `Connection chapter ${chapter}`, org, order += 1],
      );
    }
    for (const [userId, org, chapter] of [...actors, ...contributors]) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [userId, chapter]);
      await db.query("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [userId, chapter, `Proof ${userId.slice(-4)}`]);
    }
    await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [ID.adminA, CH.a2]);
    for (const [userId, org, role] of [[ID.adminA, ID.orgA, "admin"], [ID.stewardA, ID.orgA, "steward"], [ID.adminB, ID.orgB, "admin"], [ID.adminC, ID.orgC, "admin"]]) {
      await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)", [org, userId, role]);
    }
    // A chapter-scoped admin with no organization grant at all.
    await db.query("insert into public.member_roles(user_id, role, chapter_id) values ($1, 'admin', $2)", [ID.chapterAdminA1, CH.a1]);
    await db.query("insert into public.member_role_chapters(user_id, role, chapter_id) values ($1, 'admin', $2)", [ID.chapterAdminA1, CH.a1]);
    for (const [userId] of actors) {
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [sessionFor(userId), userId]);
    }
    for (const userId of [ID.adminA, ID.stewardA, ID.chapterAdminA1, ID.adminB, ID.adminC]) {
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'cs-totp', 'totp', 'verified', now(), now())`,
        [userId],
      );
    }

    // Finalized tenant sources inside the previous quarter: one submitted
    // survey response per contributor, resolved grievances for the first 26
    // (plus one unresolved and one restricted), and five responded pulses.
    await db.query(
      "insert into public.organization_surveys(id, organization_id, chapter_id, title, status) values ($1, $2, $3, 'Connection proof survey', 'closed')",
      [ID.survey, ID.orgA, CH.a1],
    );
    for (let n = 1; n <= CONTRIBUTORS; n += 1) {
      await db.query(
        `insert into public.organization_survey_sessions(id, organization_id, survey_id, respondent_user_id, status, submitted_at)
         values ($1, $2, $3, $4, 'submitted', $5::timestamptz + interval '10 days')`,
        [sessionOf(n), ID.orgA, ID.survey, contributor(n), quarter.starts_at],
      );
    }
    for (let n = 1; n <= 26; n += 1) {
      await db.query(
        `insert into public.member_cases(id, user_id, reference, title, case_type, status, created_at, updated_at)
         values ($1, $2, $3, $3, 'other', 'resolved', $4::timestamptz + interval '15 days', $4::timestamptz + interval '20 days')`,
        [caseOf(n), contributor(n), `CS-PROOF-${n}`, quarter.starts_at],
      );
    }
    await db.query(
      `insert into public.member_cases(id, user_id, reference, title, case_type, status, created_at, updated_at)
       values ($1, $2, 'CS-PROOF-OPEN', 'CS-PROOF-OPEN', 'other', 'active', $3::timestamptz + interval '15 days', $3::timestamptz + interval '20 days')`,
      [caseOf(27), contributor(27), quarter.starts_at],
    );
    await db.query(
      `insert into public.member_cases(id, user_id, reference, title, case_type, status, created_at, updated_at,
         is_restricted, restriction_reason, restricted_at, restricted_by)
       values ($1, $2, 'CS-PROOF-RESTRICTED', 'CS-PROOF-RESTRICTED', 'other', 'resolved',
         $3::timestamptz + interval '15 days', $3::timestamptz + interval '20 days',
         true, 'sensitive investigation', now(), $4)`,
      [caseOf(28), contributor(28), quarter.starts_at, ID.adminA],
    );
    await db.query(
      `insert into public.organization_pulse_prompts(id, organization_id, chapter_id, event_key, question, options)
       values ($1, $2, $3, 'contract.page', 'How did this go?', '["good", "bad"]'::jsonb)`,
      [ID.prompt, ID.orgA, CH.a1],
    );
    for (let n = 1; n <= 5; n += 1) {
      await db.query(
        `insert into public.organization_pulse_events(id, organization_id, prompt_id, user_id, context_key, state, response_value, responded_at)
         values ($1, $2, $3, $4, 'cs-ctx', 'responded', '"good"'::jsonb, $5::timestamptz + interval '5 days')`,
        [eventOf(n), ID.orgA, ID.prompt, contributor(n), quarter.starts_at],
      );
    }
    await db.query(
      `insert into public.organization_pulse_events(id, organization_id, prompt_id, user_id, context_key, state)
       values ($1, $2, $3, $4, 'cs-ctx-shown', 'shown')`,
      [eventOf(6), ID.orgA, ID.prompt, contributor(6)],
    );

    // A VERIFIED catalog binding for one candidate chapter, so the registry
    // derives its organizational identity instead of trusting a declaration.
    await db.query(
      `insert into public.union_orgs(id, olms_file_number, name, affiliation, level, enrichment_status, atlas_manifest_sha)
       values ('cs-union-1', 543210, 'Connection proof local', 'Tamarack Proof', 'local', 'no_web_presence', 'cs-proof')`,
    );
    await db.query(
      `insert into public.chapter_union_org_bindings(chapter_id, union_org_id, status, requested_by, verified_at)
       values ($1, 'cs-union-1', 'verified', $2, now())`,
      [CH.b1, ID.adminB],
    );
  }, 180_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("passes the SQL contract file inside a savepoint", async () => {
    await within("sql_contract", async () => {
      await db.query(contractSql);
    });
  }, LIVE_TIMEOUT);

  it("reads the workspace for the selected chapter with the exact hat, and refuses everyone else", async () => {
    const admin = await rpc(ID.adminA, "get_chapter_connection_workspace", { p_selected_hat: "admin" });
    expect(admin, admin.message).toMatchObject({ code: "" });
    expect(admin.value).toMatchObject({
      organizationId: ID.orgA, chapterId: CH.a1, chapterName: `Connection chapter ${CH.a1}`,
      profile: null, draft: null, canPublish: true, hiddenChapterIds: [],
      chapters: [{ id: CH.a1, name: `Connection chapter ${CH.a1}` }, { id: CH.a2, name: `Connection chapter ${CH.a2}` }],
    });
    expect(admin.value.taxonomy).toMatchObject({
      issueKeys: [...CONNECTION_ISSUE_TOPICS], sectorKeys: [...CONNECTION_SECTORS],
      expertiseKeys: [...CONNECTION_ISSUE_TOPICS], consentVersion: 1, publicationDays: 180,
    });
    expect(admin.value.analysis).toMatchObject({ nextPeriodKey: quarter.key, nextPeriodFrozen: false, latest: null });

    const steward = await rpc(ID.stewardA, "get_chapter_connection_workspace", { p_selected_hat: "steward" });
    expect(steward, steward.message).toMatchObject({ code: "" });
    expect(steward.value.canPublish).toBe(false);

    const otherChapter = await rpc(ID.adminA, "get_chapter_connection_workspace", { p_selected_hat: "admin", p_chapter_id: CH.a2 });
    expect(otherChapter.value).toMatchObject({ chapterId: CH.a2, canPublish: true });

    for (const [userId, hat, why] of [
      [ID.memberA, "member", "member hat is not a staff hat"],
      [ID.memberA, "admin", "hat not granted"],
      [ID.memberA, null, "null hat"],
      [ID.stewardA, "admin", "steward claiming admin"],
      [ID.adminA, "vp", "admin claiming vp"],
      [ID.adminA, "ADMIN", "hat is exact"],
    ]) {
      const refused = await rpc(userId, "get_chapter_connection_workspace", { p_selected_hat: hat });
      expect(refused.code, why).toBe("42501");
      expect(refused.message, why).toMatch(/not authorized/);
    }
    const foreign = await rpc(ID.adminA, "get_chapter_connection_workspace", { p_selected_hat: "admin", p_chapter_id: CH.b1 });
    expect(foreign.code).toBe("42501");
    expect(foreign.message).toMatch(/chapter outside organization/);
    const unknown = await rpc(ID.adminA, "get_chapter_connection_workspace", { p_selected_hat: "admin", p_chapter_id: "cs-nope" });
    expect(unknown.message).toMatch(/chapter outside organization/);
  }, LIVE_TIMEOUT);

  it("refuses every malformed, out-of-vocabulary or extra profile field with a specific 22023", async () => {
    const cases = [
      [{ contributorCount: 5 }, /unknown profile field: contributorCount/],
      [{ issuePriorities: [] }, /unknown profile field: issuePriorities/],
      [{ sourceSummary: "x" }, /unknown profile field: sourceSummary/],
      [{ location: undefined }, /profile location required/],
      [{ location: { country: "USA" } }, /location country invalid/],
      [{ location: { country: "US", zip: "02116" } }, /unknown location field: zip/],
      [{ location: { country: "US", state: "Massachusetts" } }, /location state invalid/],
      [{ location: { country: "US", metro: "02116 Boston" } }, /location metro invalid/],
      [{ location: { country: "US", metro: "12 Main Street 02116" } }, /location metro invalid/],
      [{ location: { country: "US", metro: "steward@example.invalid" } }, /location metro invalid/],
      [{ sectorKeys: ["aerospace"] }, /sector keys invalid/],
      [{ sectorKeys: ["healthcare", "healthcare"] }, /sector keys invalid/],
      [{ sectorKeys: ["healthcare", "education", "public-services", "transportation", "logistics", "retail"] }, /sector keys invalid/],
      [{ sectorKeys: "healthcare" }, /sector keys invalid/],
      [{ expertiseOffered: ["organizing"] }, /expertise keys invalid/],
      [{ declaredIssueKeys: ["overtime"] }, /declared issue keys invalid/],
      [{ declaredIssueKeys: [1] }, /declared issue keys invalid/],
      [{ declaredLocalKey: "Tamarack Local 7" }, /declared local key invalid/],
      [{ declaredLocalKey: "olms-999999999" }, /declared local key unavailable/],
      [{ declaredUnionFamilyKey: "Tamarack Local!" }, /declared union family key invalid/],
      [{ shareAnalyzedIssues: "yes" }, /share analyzed issues must be boolean/],
      [{ kind: "person" }, /profile kind invalid/],
    ];
    for (const [patch, message] of cases) {
      const input = profileInput(patch);
      if (Object.hasOwn(patch, "location") && patch.location === undefined) delete input.location;
      const refused = await rpc(ID.adminA, "save_chapter_connection_profile", {
        p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(input), p_publish: true,
      });
      expect(refused.code, JSON.stringify(patch)).toBe("22023");
      expect(refused.message, JSON.stringify(patch)).toMatch(message);
    }
    const notObject = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: "[]", p_publish: true });
    expect(notObject.message).toMatch(/profile must be an object/);
    const noFlag = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput()), p_publish: null });
    expect(noFlag.message).toMatch(/publish flag required/);
    expect((await db.query("select count(*)::int as n from private.chapter_connection_profiles")).rows[0].n).toBe(0);
  }, LIVE_TIMEOUT);

  it("lets organization advisor/admin/vp or a chapter-scoped admin publish their own chapter, nobody else", async () => {
    await within("write_gate", async () => {
      const steward = await rpc(ID.stewardA, "save_chapter_connection_profile", { p_selected_hat: "steward", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput()), p_publish: false });
      expect(steward.code).toBe("42501");
      const foreign = await rpc(ID.adminB, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput()), p_publish: false });
      expect(foreign.code).toBe("42501");
      expect(foreign.message).toMatch(/chapter outside organization/);
      const chapterAdminElsewhere = await rpc(ID.chapterAdminA1, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a2, p_profile: JSON.stringify(profileInput()), p_publish: false });
      expect(chapterAdminElsewhere.code).toBe("42501");
      expect(chapterAdminElsewhere.message).toMatch(/not authorized/);
      const chapterAdmin = await rpc(ID.chapterAdminA1, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput()), p_publish: false });
      expect(chapterAdmin, chapterAdmin.message).toMatchObject({ code: "" });
      expect(chapterAdmin.value.draft).toMatchObject({ publication: { status: "draft", version: 0 }, profileRevision: 1 });
      expect(chapterAdmin.value.profile).toBeNull();
      const chapterAdminWorkspace = await rpc(ID.chapterAdminA1, "get_chapter_connection_workspace", { p_selected_hat: "admin" });
      expect(chapterAdminWorkspace.value.canPublish).toBe(true);
    });
  }, LIVE_TIMEOUT);

  it("publishes with consent, renews the 180-day window and version on every publish, and withdraws immediately", async () => {
    await within("publish_flow", async () => {
      let mark = await epoch();
      const moved = async () => { const next = await epoch(); expect(next > mark).toBe(true); mark = next; };
      const held = async () => { expect(await epoch()).toBe(mark); };

      const published = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput()), p_publish: true });
      expect(published, published.message).toMatchObject({ code: "" });
      const profile = published.value.profile;
      expect(profile).toMatchObject({
        id: CH.a1, kind: "chapter", displayName: `Connection chapter ${CH.a1}`, profileRevision: 1,
        publication: { status: "published", version: 1 },
        location: { country: "US", state: "MA", metro: "Greater Boston" },
        sectorKeys: ["healthcare", "public-services"], expertiseOffered: ["staffing", "safety"],
        issuePriorities: [{ key: "pay", strength: 1.0, origin: "declared" }],
        localKey: null, unionFamilyKey: null, identityProvenance: { localKey: null, unionFamilyKey: null },
      });
      expect(new Date(profile.publication.expiresAt) - new Date(profile.publication.publishedAt)).toBe(180 * 86_400_000);
      expect(published.value.draft).toMatchObject({ consent: { version: 1, hat: "admin" }, publication: { status: "published", version: 1, expired: false } });
      expect(JSON.stringify(profile)).not.toMatch(LEAK);
      await moved();

      const republished = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput({ location: { country: "US", state: "MA", metro: "Worcester" } })), p_publish: true });
      expect(republished.value.profile).toMatchObject({ profileRevision: 2, publication: { version: 2 }, location: { metro: "Worcester" } });
      await moved();

      const unpublished = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput()), p_publish: false });
      expect(unpublished.value.profile).toBeNull();
      expect(unpublished.value.draft).toMatchObject({ publication: { status: "withdrawn", version: 2 }, profileRevision: 3 });
      expect(unpublished.value.draft.publication.withdrawnAt).toBeTruthy();
      await moved();

      const idle = await rpc(ID.adminA, "withdraw_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1 });
      expect(idle.value.draft.publication.status).toBe("withdrawn");
      await held();

      const again = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput()), p_publish: true });
      expect(again.value.profile.publication.version).toBe(3);
      await moved();
      const withdrawn = await rpc(ID.adminA, "withdraw_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1 });
      expect(withdrawn.value.profile).toBeNull();
      expect(withdrawn.value.draft.publication.status).toBe("withdrawn");
      await moved();

      const stewardWithdraw = await rpc(ID.stewardA, "withdraw_chapter_connection_profile", { p_selected_hat: "steward", p_chapter_id: CH.a1 });
      expect(stewardWithdraw.code).toBe("42501");

      // One content-free ledger row per publication, re-publication and
      // withdrawal (all share the transaction's occurred_at, so compare as a
      // multiset).
      const audits = await db.query(
        "select event_type, metadata from public.organization_audit_ledger where organization_id = $1 and entity_type = 'chapter' and entity_id = $2",
        [ID.orgA, CH.a1],
      );
      expect(audits.rows.map((row) => row.metadata.reasonCode).sort()).toEqual(["published", "published", "published", "withdrawn", "withdrawn"]);
      expect(audits.rows.map((row) => `${row.metadata.fromStatus}>${row.metadata.toStatus}@${row.metadata.version}`).sort()).toEqual(
        ["published>published@2", "published>withdrawn@2", "published>withdrawn@3", "unset>published@1", "withdrawn>published@3"],
      );
      for (const row of audits.rows) {
        expect(row.event_type).toBe("chapter_connection_profile_saved");
        expect(Object.keys(row.metadata).sort()).toEqual(["chapterId", "fromStatus", "reasonCode", "toStatus", "version"]);
      }
    });
  }, LIVE_TIMEOUT);

  it("lists every published candidate but the viewer's own chapter in one epoch-bound keyset scan", async () => {
    await within("registry", async () => {
      await publishAll();
      const page = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(page, page.message).toMatchObject({ code: "" });
      expect(ids(page)).toEqual([CH.a2, CH.b1, CH.b2, CH.c1]);
      expect(page.value).toMatchObject({ complete: true, nextCursor: null });
      expect(page.value.snapshotToken).toMatch(TOKEN);
      const b1 = page.value.rows.find((row) => row.id === CH.b1);
      expect(b1).toMatchObject({
        kind: "chapter", displayName: `Connection chapter ${CH.b1}`, publication: { status: "published", version: 1 },
        localKey: "olms-543210", unionFamilyKey: "tamarack-proof", identityProvenance: { localKey: "verified", unionFamilyKey: "verified" },
      });
      expect(page.value.rows.find((row) => row.id === CH.c1)).toMatchObject({ kind: "local", localKey: null, unionFamilyKey: "afscme", identityProvenance: { localKey: null, unionFamilyKey: "declared" } });
      for (const row of page.value.rows) {
        expect(Object.keys(row).sort()).toEqual(["displayName", "expertiseOffered", "handshake", "id", "identityProvenance", "issuePriorities", "kind", "localKey", "location", "profileRevision", "publication", "sectorKeys", "sourceAsOf", "unionFamilyKey"]);
        expect(JSON.stringify(row)).not.toMatch(LEAK);
        expect(JSON.stringify(row)).not.toMatch(/organizationId/);
      }

      // Keyset paging: two rows, cursor, then the rest under the same token.
      const first = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin", p_limit: 2 });
      expect(ids(first)).toEqual([CH.a2, CH.b1]);
      expect(first.value).toMatchObject({ complete: false, nextCursor: CH.b1 });
      const second = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin", p_limit: 2, p_after_id: first.value.nextCursor, p_snapshot_token: first.value.snapshotToken });
      expect(ids(second)).toEqual([CH.b2, CH.c1]);
      expect(second.value).toMatchObject({ complete: true, nextCursor: null, snapshotToken: first.value.snapshotToken });

      // A withdrawal between pages moves the epoch and the stale token is refused.
      await rpc(ID.adminB, "withdraw_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.b2 });
      const stale = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin", p_after_id: CH.b1, p_snapshot_token: first.value.snapshotToken });
      expect(stale.code).toBe("22023");
      expect(stale.message).toMatch(/connection registry snapshot changed/);
      const fresh = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(ids(fresh)).toEqual([CH.a2, CH.b1, CH.c1]);

      const [freshEpoch, , scope] = fresh.value.snapshotToken.split(":");
      for (const [token, message] of [["abc", /snapshot token invalid/], [`${freshEpoch}:1000000000:${scope}`, /snapshot expired/]]) {
        const refused = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin", p_snapshot_token: token });
        expect(refused.code, token).toBe("22023");
        expect(refused.message, token).toMatch(message);
      }

      // Staff hats read; a member does not; every viewer omits only itself.
      const steward = await rpc(ID.stewardA, "list_chapter_connection_profiles", { p_selected_hat: "steward" });
      expect(ids(steward)).toEqual([CH.a2, CH.b1, CH.c1]);
      const member = await rpc(ID.memberA, "list_chapter_connection_profiles", { p_selected_hat: "member" });
      expect(member.code).toBe("42501");
      const fromB = await rpc(ID.adminB, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(ids(fromB)).toEqual([CH.a1, CH.a2, CH.c1]);

      // Expiry and a suspended organization drop candidates.
      await db.query("update private.chapter_connection_profiles set published_at = now() - interval '181 days', expires_at = now() - interval '181 days' + interval '180 days' where chapter_id = $1", [CH.c1]);
      const expired = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(ids(expired)).toEqual([CH.a2, CH.b1]);
      const workspaceC = await rpc(ID.adminC, "get_chapter_connection_workspace", { p_selected_hat: "admin" });
      expect(workspaceC.value.profile).toBeNull();
      expect(workspaceC.value.draft.publication).toMatchObject({ status: "published", expired: true });
      await db.query("update public.organizations set status = 'suspended' where id = $1", [ID.orgB]);
      const suspended = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(ids(suspended)).toEqual([CH.a2]);
    });
  }, LIVE_TIMEOUT);

  it("hides candidates reciprocally and refuses hiding anything that is not a published candidate", async () => {
    await within("hides", async () => {
      await publishAll();
      const hidden = await rpc(ID.adminA, "set_chapter_connection_hidden", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_target_chapter_id: CH.b1, p_hidden: true });
      expect(hidden, hidden.message).toMatchObject({ code: "" });
      expect(hidden.value).toMatchObject({ chapterId: CH.a1, targetChapterId: CH.b1, hidden: true, changed: true, hiddenChapterIds: [CH.b1] });
      const fromA = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(ids(fromA)).toEqual([CH.a2, CH.b2, CH.c1]);
      const fromB1 = await rpc(ID.adminB, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(ids(fromB1)).toEqual([CH.a2, CH.b2, CH.c1]);
      const workspace = await rpc(ID.adminA, "get_chapter_connection_workspace", { p_selected_hat: "admin" });
      expect(workspace.value.hiddenChapterIds).toEqual([CH.b1]);

      const again = await rpc(ID.adminA, "set_chapter_connection_hidden", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_target_chapter_id: CH.b1, p_hidden: true });
      expect(again.value.changed).toBe(false);
      const unhidden = await rpc(ID.adminA, "set_chapter_connection_hidden", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_target_chapter_id: CH.b1, p_hidden: false });
      expect(unhidden.value).toMatchObject({ changed: true, hiddenChapterIds: [] });
      const restored = await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      expect(ids(restored)).toEqual([CH.a2, CH.b1, CH.b2, CH.c1]);

      // A published sibling is a candidate too, so it can be hidden.
      const sibling = await rpc(ID.adminA, "set_chapter_connection_hidden", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_target_chapter_id: CH.a2, p_hidden: true });
      expect(sibling.value.changed).toBe(true);
      expect(ids(await rpc(ID.adminA, "list_chapter_connection_profiles", { p_selected_hat: "admin" }))).toEqual([CH.b1, CH.b2, CH.c1]);

      for (const [target, why] of [[CH.a1, "self"], ["cs-nope", "unknown"], ["", "blank"]]) {
        const refused = await rpc(ID.adminA, "set_chapter_connection_hidden", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_target_chapter_id: target, p_hidden: true });
        expect(refused.code, why).toBe("22023");
        expect(refused.message, why).toMatch(/target chapter unavailable/);
      }
      await rpc(ID.adminB, "withdraw_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.b2 });
      const unpublishedTarget = await rpc(ID.adminA, "set_chapter_connection_hidden", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_target_chapter_id: CH.b2, p_hidden: true });
      expect(unpublishedTarget.message).toMatch(/target chapter unavailable/);
      const noFlag = await rpc(ID.adminA, "set_chapter_connection_hidden", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_target_chapter_id: CH.b1, p_hidden: null });
      expect(noFlag.message).toMatch(/hidden flag required/);
      const steward = await rpc(ID.stewardA, "set_chapter_connection_hidden", { p_selected_hat: "steward", p_chapter_id: CH.a1, p_target_chapter_id: CH.b1, p_hidden: true });
      expect(steward.code).toBe("42501");
    });
  }, LIVE_TIMEOUT);

  it("tags only existing finalized sources the reviewer may read, deriving the contributor server-side", async () => {
    await within("tags", async () => {
      const tagged = await tag(ID.adminA, "grievance", caseOf(1), ["Staffing", " pay "]);
      expect(tagged).toMatchObject({ chapterId: CH.a1, sourceKind: "grievance", sourceId: caseOf(1), topicKeys: ["staffing", "pay"], periodKey: quarter.key });
      const stored = await db.query(
        "select topic_key, status, contributor_user_id, source_kind, case_id from private.chapter_connection_source_tags where source_id = $1 and topic_key is not null order by topic_key",
        [caseOf(1)],
      );
      expect(stored.rows).toEqual([
        { topic_key: "pay", status: "confirmed", contributor_user_id: contributor(1), source_kind: "grievance", case_id: caseOf(1) },
        { topic_key: "staffing", status: "confirmed", contributor_user_id: contributor(1), source_kind: "grievance", case_id: caseOf(1) },
      ]);
      // Exactly one reviewed-source marker (NULL topic) per source, from the review repairs.
      expect((await db.query("select count(*)::int as n from private.chapter_connection_source_tags where source_id = $1 and topic_key is null", [caseOf(1)])).rows[0].n).toBe(1);

      // Set semantics: an unlisted tag is removed, not deleted, and never counted.
      const narrowed = await tag(ID.adminA, "grievance", caseOf(1), ["staffing"]);
      expect(narrowed.topicKeys).toEqual(["staffing"]);
      const afterNarrow = await db.query("select topic_key, status from private.chapter_connection_source_tags where source_id = $1 and topic_key is not null order by topic_key", [caseOf(1)]);
      expect(afterNarrow.rows).toEqual([{ topic_key: "pay", status: "removed" }, { topic_key: "staffing", status: "confirmed" }]);

      await tag(ID.adminA, "survey", sessionOf(2), ["benefits"]);
      expect((await db.query("select contributor_user_id, survey_session_id from private.chapter_connection_source_tags where source_id = $1 and topic_key = 'benefits'", [sessionOf(2)])).rows[0])
        .toEqual({ contributor_user_id: contributor(2), survey_session_id: sessionOf(2) });
      await tag(ID.adminA, "feedback", eventOf(3), ["workload"]);
      expect((await db.query("select contributor_user_id, pulse_event_id from private.chapter_connection_source_tags where source_id = $1 and topic_key = 'workload'", [eventOf(3)])).rows[0])
        .toEqual({ contributor_user_id: contributor(3), pulse_event_id: eventOf(3) });

      for (const [kind, sourceId, why] of [
        ["grievance", caseOf(27), "unresolved case"],
        ["grievance", sessionOf(1), "a survey session id offered as a grievance"],
        ["grievance", "50927000-0000-4000-8000-0000000fffff", "unknown case"],
        ["survey", caseOf(1), "a case id offered as a survey"],
        ["feedback", eventOf(6), "a pulse that was only shown"],
        ["feedback", null, "no source"],
      ]) {
        const refused = await rpc(ID.adminA, "set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_source_kind: kind, p_source_id: sourceId, p_topic_keys: ["pay"] });
        expect(refused.code, why).toBe("22023");
        expect(refused.message, why).toMatch(/source record unavailable/);
      }
      const otherChapter = await rpc(ID.adminA, "set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: CH.a2, p_source_kind: "grievance", p_source_id: caseOf(1), p_topic_keys: ["pay"] });
      expect(otherChapter.message).toMatch(/source record unavailable/);
      for (const [params, message] of [
        [{ p_source_kind: "email", p_source_id: caseOf(1), p_topic_keys: ["pay"] }, /source kind invalid/],
        [{ p_source_kind: "grievance", p_source_id: caseOf(1), p_topic_keys: ["bogus"] }, /topic keys invalid/],
        [{ p_source_kind: "grievance", p_source_id: caseOf(1), p_topic_keys: ["pay", "pay"] }, /topic keys invalid/],
        [{ p_source_kind: "grievance", p_source_id: caseOf(1), p_topic_keys: ["pay", null] }, /topic keys invalid/],
      ]) {
        const refused = await rpc(ID.adminA, "set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: CH.a1, ...params });
        expect(refused.code, message.source).toBe("22023");
        expect(refused.message).toMatch(message);
      }

      // Read authority follows the existing casework and survey gates, not the
      // hat alone: a chapter-scoped admin with no organization grant holds the
      // write hat (it can publish) but clears neither the casework read
      // predicate nor the survey review gate, so it cannot tag either kind;
      // an organization admin clears both, including a restricted case; a
      // steward and a foreign admin are refused outright.
      for (const [sourceId, why] of [[caseOf(4), "unrestricted case"], [caseOf(28), "restricted case"]]) {
        const refused = await rpc(ID.chapterAdminA1, "set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_source_kind: "grievance", p_source_id: sourceId, p_topic_keys: ["pay"] });
        expect(refused.code, why).toBe("22023");
        expect(refused.message, why).toMatch(/source record unavailable/);
      }
      await tag(ID.adminA, "grievance", caseOf(4), ["pay"]);
      await tag(ID.adminA, "grievance", caseOf(28), ["discrimination"]);
      const chapterAdminSurvey = await rpc(ID.chapterAdminA1, "set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_source_kind: "survey", p_source_id: sessionOf(5), p_topic_keys: ["pay"] });
      expect(chapterAdminSurvey.code).toBe("42501");
      const steward = await rpc(ID.stewardA, "set_chapter_connection_source_tags", { p_selected_hat: "steward", p_chapter_id: CH.a1, p_source_kind: "grievance", p_source_id: caseOf(5), p_topic_keys: ["pay"] });
      expect(steward.code).toBe("42501");
      const foreign = await rpc(ID.adminB, "set_chapter_connection_source_tags", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_source_kind: "grievance", p_source_id: caseOf(5), p_topic_keys: ["pay"] });
      expect(foreign.code).toBe("42501");

      // Audit rows are content-free: kind and a topic count, never the source or topic.
      const audits = await db.query(
        "select metadata from public.organization_audit_ledger where organization_id = $1 and event_type = 'chapter_connection_source_tags_changed' order by occurred_at",
        [ID.orgA],
      );
      expect(audits.rows.length).toBeGreaterThanOrEqual(6);
      for (const row of audits.rows) {
        expect(Object.keys(row.metadata).sort()).toEqual(["chapterId", "count", "entityType", "operation"]);
        expect(JSON.stringify(row.metadata)).not.toMatch(/staffing|pay|50927000-0000-4000-8000-0000000[234]/);
      }
    });
  }, LIVE_TIMEOUT);

  it("freezes the previous quarter once, dedupes contributors across sources, and publishes bands only where safe", async () => {
    await within("aggregates", async () => {
      // 80 contributors in the window.
      //   staffing   54 -> complement 26 -> 54*3 > 160        -> most
      //   pay        40 -> complement 40 -> 120 in (80, 160]  -> many
      //   scheduling 26 by survey AND the same 26 by grievance: one count
      //              each -> complement 54 -> 78 <= 80        -> some
      //              (double-counted it would be 52 -> many, so the band is
      //              the dedup proof)
      //   benefits   60 -> complement 20 < 25                  -> suppressed
      //   safety     10 -> below the floor                     -> suppressed
      for (let n = 1; n <= CONTRIBUTORS; n += 1) {
        const topics = [];
        if (n <= 54) topics.push("staffing");
        if (n <= 40) topics.push("pay");
        if (n <= 26) topics.push("scheduling");
        if (n <= 60) topics.push("benefits");
        if (n <= 10) topics.push("safety");
        await tag(ID.adminA, "survey", sessionOf(n), topics);
      }
      for (let n = 1; n <= 26; n += 1) await tag(ID.adminA, "grievance", caseOf(n), ["scheduling"]);

      const workspaceBefore = await rpc(ID.adminA, "get_chapter_connection_workspace", { p_selected_hat: "admin" });
      expect(workspaceBefore.value.analysis).toMatchObject({ nextPeriodKey: quarter.key, nextPeriodFrozen: false, latest: null });

      const expected = [{ key: "pay", band: "many" }, { key: "scheduling", band: "some" }, { key: "staffing", band: "most" }];
      const frozen = await rpc(ID.adminA, "freeze_chapter_connection_issue_aggregates", { p_selected_hat: "admin", p_chapter_id: CH.a1 });
      expect(frozen, frozen.message).toMatchObject({ code: "" });
      expect(frozen.value).toMatchObject({ chapterId: CH.a1, periodKey: quarter.key, alreadyFrozen: false, topics: expected });
      // Bands only: the payload has no count field anywhere.
      expect(Object.keys(frozen.value).sort()).toEqual(["alreadyFrozen", "chapterId", "frozenAt", "periodEndsAt", "periodKey", "periodStartsAt", "topics"]);
      for (const topic of frozen.value.topics) expect(Object.keys(topic).sort()).toEqual(["band", "key"]);
      expect((await db.query("select published_topic_count from private.chapter_connection_aggregate_runs where chapter_id = $1", [CH.a1])).rows[0].published_topic_count).toBe(3);

      // Frozen: a later tag change does not move the quarter's publication.
      for (let n = 61; n <= CONTRIBUTORS; n += 1) await tag(ID.adminA, "survey", sessionOf(n), ["benefits"]);
      const again = await rpc(ID.adminA, "freeze_chapter_connection_issue_aggregates", { p_selected_hat: "admin", p_chapter_id: CH.a1 });
      expect(again.value).toMatchObject({ alreadyFrozen: true, topics: expected });

      const workspace = await rpc(ID.adminA, "get_chapter_connection_workspace", { p_selected_hat: "admin" });
      expect(workspace.value.analysis).toMatchObject({ nextPeriodFrozen: true, latest: { periodKey: quarter.key, topics: expected } });

      // Analyzed bands reach the published profile only with the opt-in, always
      // labelled analyzed and never ahead of the declared agenda.
      const declaredOnly = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput({ declaredIssueKeys: ["pay", "staffing"] })), p_publish: true });
      expect(declaredOnly.value.profile.issuePriorities).toEqual([
        { key: "pay", strength: 1.0, origin: "declared" },
        { key: "staffing", strength: 1.0, origin: "declared" },
      ]);
      const mark = await epoch();
      const shared = await rpc(ID.adminA, "save_chapter_connection_profile", { p_selected_hat: "admin", p_chapter_id: CH.a1, p_profile: JSON.stringify(profileInput({ declaredIssueKeys: ["pay"], shareAnalyzedIssues: true })), p_publish: true });
      expect(shared.value.profile.issuePriorities).toEqual([
        { key: "pay", strength: 1.0, origin: "declared", band: "many", periodKey: quarter.key },
        { key: "staffing", strength: 0.75, origin: "analyzed", band: "most", periodKey: quarter.key },
        { key: "scheduling", strength: 0.25, origin: "analyzed", band: "some", periodKey: quarter.key },
      ]);
      expect((await epoch()) > mark).toBe(true);
      // The registry hands other tenants the same bands and nothing more.
      const seenFromB = await rpc(ID.adminB, "list_chapter_connection_profiles", { p_selected_hat: "admin" });
      const a1 = seenFromB.value.rows.find((row) => row.id === CH.a1);
      expect(a1.issuePriorities.map((item) => [item.key, item.strength])).toEqual([["pay", 1.0], ["staffing", 0.75], ["scheduling", 0.25]]);
      for (const item of a1.issuePriorities) {
        expect(Object.keys(item).every((key) => ["key", "strength", "origin", "band", "periodKey"].includes(key)), JSON.stringify(item)).toBe(true);
      }
      expect(JSON.stringify(a1)).not.toMatch(LEAK);

      const steward = await rpc(ID.stewardA, "freeze_chapter_connection_issue_aggregates", { p_selected_hat: "steward", p_chapter_id: CH.a1 });
      expect(steward.code).toBe("42501");
    });
  }, LIVE_TIMEOUT);

  it("suppresses a topic below the floor or without a safe complement, and freezes an empty quarter", async () => {
    await within("floor", async () => {
      // 24 contributors: below the floor even though it is the only topic.
      for (let n = 1; n <= 24; n += 1) await tag(ID.adminA, "survey", sessionOf(n), ["training"]);
      const frozen = await rpc(ID.adminA, "freeze_chapter_connection_issue_aggregates", { p_selected_hat: "admin", p_chapter_id: CH.a1 });
      expect(frozen.value).toMatchObject({ alreadyFrozen: false, topics: [] });
      const emptyChapter = await rpc(ID.adminA, "freeze_chapter_connection_issue_aggregates", { p_selected_hat: "admin", p_chapter_id: CH.a2 });
      expect(emptyChapter.value).toMatchObject({ chapterId: CH.a2, alreadyFrozen: false, topics: [] });
      expect((await db.query("select count(*)::int as n from private.chapter_connection_issue_aggregates")).rows[0].n).toBe(0);
    });
    await within("complement", async () => {
      // 30 of 30 reviewed contributors on one topic: above the floor, but the
      // complement is empty, so the band would name everyone. Suppressed.
      for (let n = 1; n <= 30; n += 1) await tag(ID.adminA, "survey", sessionOf(n), ["training"]);
      const frozen = await rpc(ID.adminA, "freeze_chapter_connection_issue_aggregates", { p_selected_hat: "admin", p_chapter_id: CH.a1 });
      expect(frozen.value).toMatchObject({ alreadyFrozen: false, topics: [] });
    });
  }, LIVE_TIMEOUT);
});
