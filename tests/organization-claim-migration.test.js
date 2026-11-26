// @vitest-environment node
//
// Offline pins for the Phase 3a claims and verification database half
// (SEC-UG-UNION-CATALOG-CLAIM-ANTI-TAKEOVER-20260925). The live half is
// tests/organization-claim-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MULTI_LABEL_SUFFIXES } from "../scripts/union-catalog/privacy-filter.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const raw = loadMigrationSql("union_catalog_claims_verification");
const code = stripComments(raw);
const placementCode = stripComments(loadMigrationSql("catalog_organization_self_placement"));

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const blocked = readJson("../config/catalog-blocked-email-domains.json");
const families = readJson("../config/catalog-family-domains.json");

const NEW_TABLES = ["platform_operators", "catalog_claim_blocked_domains", "organization_claims", "catalog_review_events"];

// Every function the migration declares, with its identity signature and the
// exact EXECUTE grantee ("" = nobody).
const SERVICE = {
  "public.submit_organization_claim": "text, text, text, jsonb, jsonb, jsonb, text, text, uuid, uuid",
  "public.confirm_organization_claim": "text, text",
  "public.review_organization_claim": "uuid, uuid, text, text, text, text, text, text, uuid, uuid",
  "public.issue_organization_claim_mailback": "uuid, uuid, text, uuid, uuid",
  "public.revoke_organization_claim": "uuid, uuid, text, text, uuid, uuid",
  "public.set_platform_operator": "uuid, boolean, text, uuid",
  "public.list_organization_claims": "uuid, text, integer, uuid",
  "public.get_organization_claim": "uuid, uuid, uuid",
};
const PRIVATE = {
  "private.catalog_url_host": "text",
  "private.catalog_registrable_domain": "text",
  "private.catalog_claim_domain_signals": "uuid",
  "private.organization_claim_require_operator": "uuid, uuid",
  "private.organization_claim_mailback_hmac": "uuid, text",
  "private.organization_claim_hold_contested": "text, uuid, text, uuid",
  "private.organization_claim_verify_placement": "uuid, text, uuid",
  "private.organization_claim_withdraw": "uuid, text, text, uuid, uuid, text",
  "private.organization_claim_review_result": "uuid, boolean",
  "private.organization_claim_vouch_relationship": "uuid, text",
  "private.purge_organization_claim_personal_data": "",
};
// Executable by authenticated: the admin reads and the vouch (MFA-guarded), and
// the isolation predicate a later policy can call.
const AUTHENTICATED = {
  "public.get_organization_catalog_verification": "text, uuid",
  "public.list_vouchable_organization_claims": "text, uuid",
  "public.vouch_for_organization_claims": "text, uuid, uuid[], uuid",
  "private.organization_is_verified": "uuid",
};
const WRITERS = [
  "public.submit_organization_claim",
  "public.confirm_organization_claim",
  "public.review_organization_claim",
  "public.issue_organization_claim_mailback",
  "public.revoke_organization_claim",
  "public.set_platform_operator",
  "public.vouch_for_organization_claims",
  "private.organization_claim_hold_contested",
  "private.organization_claim_verify_placement",
  "private.organization_claim_withdraw",
  "private.purge_organization_claim_personal_data",
  "public.set_organization_catalog_placement",
  "public.clear_organization_catalog_placement",
];
const OPERATIONS = [
  "network-15m", "email-interest-day", "stop-network-15m", "stop-email-day",
  "claim-network-hour", "claim-email-day", "claim-org-day", "claim-confirm-network-15m",
];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (text, needle) => text.split(needle).length - 1;
const body = (name) => fnBody(code, name);
const firstStatement = (fn) => fn.slice(fn.indexOf("begin", fn.indexOf("as $")) + "begin".length).trim();

describe("union catalog claims and verification migration", () => {
  it("names both records, then is one begin/commit unit with local timeouts and a PostgREST reload", () => {
    expect(raw.split("\n")[0]).toBe(
      "-- SEC-UG-UNION-CATALOG-CLAIM-ANTI-TAKEOVER-20260925 / REQ-UG-UNION-CATALOG-CLAIMS-AND-VERIFICATION-20260925",
    );
    const statements = code.trim();
    expect(statements.startsWith("begin;")).toBe(true);
    expect(statements.endsWith("commit;")).toBe(true);
    expect(code.match(/^begin;$/gm)).toHaveLength(1);
    expect(code.match(/^commit;$/gm)).toHaveLength(1);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("set local statement_timeout = '60s';");
    expect(code).toContain("notify pgrst, 'reload schema';");
    expect(code).not.toMatch(/\bexecute\s+(?:format|'|\$)/i);
    expect(code).not.toMatch(/\bE'/);
    // Top-level DO blocks: the lifecycle assertion, the Vault key and the cron schedule only.
    expect(code.match(/^do \$/gm)).toHaveLength(3);
  });

  it("creates four deny-all private tables with forced RLS and no policy or grant", () => {
    for (const table of NEW_TABLES) {
      expect(code, table).toContain(`create table private.${table} (`);
      expect(code, table).toContain(`alter table private.${table} enable row level security;`);
      expect(code, table).toContain(`alter table private.${table} force row level security;`);
      expect(code, table).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
      expect(code, table).toMatch(new RegExp(`comment on table private\\.${table} is`));
    }
    expect(code.match(/create table /g)).toHaveLength(NEW_TABLES.length);
    expect(code).not.toMatch(/\b(?:create|alter)\s+policy\b/i);
    expect(code).not.toMatch(/\bgrant\s+(?!execute\s+on\s+function)[^;]*\bon\s+(?:table\s+)?private\./i);
  });

  it("extends the Phase 4a placement table by ALTER only", () => {
    expect(code).not.toMatch(/create table (?:if not exists )?private\.organization_catalog_placements/);
    expect(placementCode).toContain("create table private.organization_catalog_placements (");
    const alter = code.slice(code.indexOf("alter table private.organization_catalog_placements"));
    for (const clause of [
      "add column identity_catalog_key text",
      "add column verified_claim_id uuid",
      "add column verified_at timestamptz",
      "drop constraint organization_catalog_placements_verification_status_check",
      "check (verification_status in ('self_reported', 'verified'))",
      "drop constraint organization_catalog_placements_something_placed",
      "add constraint organization_catalog_placements_verified_shape",
      "add constraint organization_catalog_placements_identity_verified",
      "add constraint organization_catalog_placements_identity_one",
      "add constraint organization_catalog_placements_parent_not_self",
    ]) expect(alter, clause).toContain(clause);
    expect(code).toContain(
      "create unique index organization_catalog_placements_identity_catalog_key_idx\n  on private.organization_catalog_placements (identity_catalog_key)\n  where identity_catalog_key is not null;",
    );
    // No auth.users column is added to 4a's table, so its gate triggers stay as merged.
    expect(alter.slice(0, alter.indexOf(";"))).not.toContain("auth.users");
    expect(code).not.toMatch(/create trigger [a-z0-9_]+ before insert or update or delete on private\.organization_catalog_placements/);
  });

  it("gates the three auth-referencing tables with the case-graph trigger pair and nothing else", () => {
    for (const [table, keys] of [
      ["platform_operators", "{user_id}"],
      ["organization_claims", "{claimant_user_id},{reviewed_by}"],
      ["catalog_review_events", "{actor_user_id},{subject_user_id}"],
    ]) {
      expect(code).toContain(`create trigger a00_case_graph_lock before insert or update or delete on private.${table}\nfor each statement execute function private.lock_case_graph_statement();`);
      expect(code).toContain(`create trigger z99_case_graph_keys before insert or update or delete on private.${table}\nfor each row execute function private.lock_case_graph_row_keys('${keys}', '');`);
    }
    expect(code.match(/create trigger /g)).toHaveLength(6);
  });

  it("declares every function once, pins search_path and grants exactly the planned roles", () => {
    const all = { ...SERVICE, ...PRIVATE, ...AUTHENTICATED, "public.get_organization_public_verification": "text" };
    for (const [name, args] of Object.entries(all)) {
      expect(code.match(new RegExp(`create function ${escape(name)}\\(`, "g")), name).toHaveLength(1);
      expect(body(name), name).toContain("set search_path = ''");
      expect(code, name).toMatch(new RegExp(`revoke all on function ${escape(name)}\\(${escape(args)}\\)\\s+from public, anon, authenticated, service_role;`));
    }
    for (const [name, args] of Object.entries(SERVICE)) {
      expect(body(name), name).toContain("security definer");
      expect(code, name).toMatch(new RegExp(`grant execute on function ${escape(name)}\\(${escape(args)}\\)\\s+to service_role;`));
      expect(body(name), name).toContain("coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'");
    }
    for (const [name, args] of Object.entries(AUTHENTICATED)) {
      expect(code, name).toContain(`grant execute on function ${name}(${args}) to authenticated;`);
    }
    for (const name of ["public.get_organization_catalog_verification", "public.list_vouchable_organization_claims", "public.vouch_for_organization_claims"]) {
      for (const guard of ["private.mi1_require_expected_selected_organization(p_expected_organization_id)", "if not private.mfa_satisfied() then", "private.has_organization_role(org, array['admin'])"]) {
        expect(body(name), `${name} ${guard}`).toContain(guard);
      }
    }
    expect(code).toContain("grant execute on function public.get_organization_public_verification(text) to anon, authenticated, service_role;");
    for (const name of Object.keys(PRIVATE)) {
      expect(code, name).not.toMatch(new RegExp(`grant execute on function ${escape(name)}\\(`));
    }
    const grants = [...code.matchAll(/grant execute on function ([a-z_.]+)\(/g)].map((m) => m[1]).sort();
    expect(grants).toEqual([...Object.keys(SERVICE), ...Object.keys(AUTHENTICATED), "public.get_organization_public_verification", "public.list_organization_job_health"].sort());
  });

  it("starts every writer with the case-graph lock and never initializes a declaration", () => {
    for (const name of WRITERS) {
      const fn = body(name);
      expect(firstStatement(fn), name).toMatch(/^perform private\.lock_case_graph\(/);
      const declare = fn.slice(fn.indexOf("as $"), fn.indexOf("begin", fn.indexOf("as $")));
      expect(declare, name).not.toMatch(/:=|\bdefault\b/);
    }
  });

  it("requires a named active claim_verification operator on every verifier RPC", () => {
    const guard = body("private.organization_claim_require_operator");
    for (const needle of ["private.platform_operators", "revoked_at is null", "'claim_verification' = any", "errcode = '42501'"]) {
      expect(guard).toContain(needle);
    }
    for (const name of ["public.review_organization_claim", "public.issue_organization_claim_mailback", "public.revoke_organization_claim", "public.list_organization_claims", "public.get_organization_claim"]) {
      expect(body(name), name).toContain("perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);");
    }
  });

  it("keeps the review history append-only and never reads tenant-issued chapter bindings", () => {
    expect(code).not.toContain("chapter_union_org_bindings");
    expect(code).not.toMatch(/update\s+private\.catalog_review_events/);
    expect(code).not.toMatch(/delete\s+from\s+private\.catalog_review_events/);
    expect(code).not.toMatch(/delete\s+from\s+private\.organization_claims/);
    expect(code).not.toContain("organization_audit_events");
    expect(code).not.toContain("mi1_write_tenant_audit");
    // 4a's own event stays 4a's: only its re-emitted set and clear write it.
    for (const name of [...Object.keys(SERVICE), ...Object.keys(PRIVATE), ...Object.keys(AUTHENTICATED), "public.get_organization_public_verification"]) {
      expect(body(name), name).not.toContain("organization_catalog_placement_changed");
    }
  });

  it("deletes a placement row only in the one withdraw writer and in 4a's re-emitted clear", () => {
    expect(count(code, "delete from private.organization_catalog_placements")).toBe(2);
    expect(count(body("private.organization_claim_withdraw"), "delete from private.organization_catalog_placements")).toBe(1);
    expect(count(body("public.clear_organization_catalog_placement"), "delete from private.organization_catalog_placements")).toBe(1);
    // The verifier undo and 4a's set and clear withdraw only through it.
    for (const name of ["public.revoke_organization_claim", "public.set_organization_catalog_placement", "public.clear_organization_catalog_placement"]) {
      expect(body(name), name).toContain("private.organization_claim_withdraw(");
    }
    for (const name of ["public.revoke_organization_claim", "private.organization_claim_withdraw"]) {
      for (const forbidden of ["delete from public.", "auth.admin", "organization_memberships", "organization_role_grants", "update public.organizations", "parent_catalog_key ="]) {
        expect(body(name), `${name} ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("creates no organization, account, membership, role grant or chapter (organizations are created at signup)", () => {
    for (const write of [
      "insert into public.organizations", "update public.organizations", "insert into public.org_security_policy",
      "insert into public.chapters", "insert into public.organization_memberships", "insert into public.organization_role_grants",
      "insert into public.member_chapter_memberships", "update public.member_profiles", "insert into auth.users",
      "import_organization_structure", "bootstrap_first_organization", "provision_catalog_organization",
    ]) expect(code, write).not.toContain(write);
  });

  it("models the verification ladder as data: verifier kinds, methods and the vouching organization", () => {
    expect(code).toContain("check (verifier_kind in ('domain', 'platform_operator', 'parent_organization', 'sibling_organization'))");
    expect(code).toContain("'written_authorization', 'parent_body_confirmation', 'sibling_handshake')),");
    expect(code).toContain("constraint organization_claims_vouching_organization_id_fkey foreign key (vouching_organization_id)\n    references public.organizations (id) on update cascade on delete set null");
    expect(body("public.confirm_organization_claim")).toContain("verifier_kind = 'domain'");
    expect(body("public.review_organization_claim")).toContain("verifier_kind = 'platform_operator'");
    const vouch = body("public.vouch_for_organization_claims");
    expect(vouch).toContain("when relationship = 'parent' then 'parent_organization' else 'sibling_organization'");
    expect(vouch).toContain("if claim.status <> 'under_review'");
    expect(vouch).toContain("raise exception 'verified catalog identity required' using errcode = '42501';");
    const relation = body("private.organization_claim_vouch_relationship");
    // Parents come from the public record for a listed claim; only an unlisted
    // claim falls back to its own self-reported parent. Sisters share a
    // parent_body parent, never just the national olms_parent.
    expect(relation.match(/e\.edge_kind in \('olms_parent', 'parent_body'\)/g)).toHaveLength(2);
    // An unlisted claim's self-reported parent must itself be a public-record parent body, and has no sisters.
    expect(relation).toContain("where e.parent_key = p.parent_catalog_key");
    expect(relation).toContain("claim_sibling_parents := array[]::text[];");
    expect(relation).toContain("filter (where e.edge_kind = 'parent_body')");
    expect(relation).toContain("and e.edge_kind = 'parent_body';");
    expect(relation.indexOf("p.parent_catalog_key")).toBeGreaterThan(relation.indexOf("if claim.catalog_key is not null then"));
    expect(relation.indexOf("p.parent_catalog_key")).toBeGreaterThan(relation.indexOf("\n  else\n"));
    for (const guard of [
      "claim.claimant_user_id is not distinct from (select auth.uid())",
      "verified_by.verifier_kind is distinct from 'sibling_organization'",
      "coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2'",
      "not private.has_second_factor((select auth.uid()))",
    ]) expect(vouch, guard).toContain(guard);
    expect(body("private.catalog_claim_domain_signals")).toContain("'stewardCount', steward_count");
  });

  it("exposes one isolation predicate keyed on verified_at and changes no policy", () => {
    const predicate = body("private.organization_is_verified");
    expect(predicate).toContain("p.verified_at is not null");
    expect(predicate).toContain("stable");
    expect(code).not.toMatch(/\b(?:create|alter|drop)\s+policy\b/i);
  });

  it("keeps the public landing read free of member, admin, claimant and verifier data", () => {
    const read = body("public.get_organization_public_verification");
    for (const forbidden of ["organization_memberships", "organization_role_grants", "member_profiles", "claimant", "reviewed_by", "verification_method", "organization_claims", "'unlistedParentName'"]) {
      expect(read, forbidden).not.toContain(forbidden);
    }
    expect(read).toContain("o.status = 'active'");
  });

  it("seeds exactly the union of the two blocked-domain configs", () => {
    const pattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
    const expected = new Map();
    for (const [list, domains] of [["consumer", blocked.consumer], ["hosting", blocked.hosting], ["family", Object.values(families.families).flat()]]) {
      for (const domain of domains) {
        expect(domain, `${list} ${domain}`).toMatch(pattern);
        if (!expected.has(domain)) expected.set(domain, list);
      }
    }
    const seed = code.slice(code.indexOf("insert into private.catalog_claim_blocked_domains (domain, list) values"));
    const rows = [...seed.slice(0, seed.indexOf(";")).matchAll(/\('([^']+)', '([a-z]+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(new Map(rows)).toEqual(expected);
    expect(rows).toHaveLength(expected.size);
  });

  it("mirrors the exporter's multi-label suffix list in SQL", () => {
    const fn = body("private.catalog_registrable_domain");
    const array = fn.slice(fn.indexOf("any (array["), fn.indexOf("]::text[]"));
    const suffixes = [...array.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]);
    expect(suffixes).toEqual([...MULTI_LABEL_SUFFIXES]);
  });

  it("names the same eight limiter operations in the CHECK and in the limiter body", () => {
    const check = code.slice(code.indexOf("add constraint public_interest_submission_limits_operation_check"));
    const checkOps = [...check.slice(0, check.indexOf(";")).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    const limiter = body("private.consume_public_interest_submission_limit");
    const list = limiter.slice(limiter.indexOf("p_operation not in ("), limiter.indexOf("or p_limit < 1"));
    const bodyOps = [...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(checkOps).toEqual(OPERATIONS);
    expect(bodyOps).toEqual(OPERATIONS);
  });

  it("re-emits 4a's clear byte-for-byte except the verified-row refusal and the vouch withdrawal", () => {
    const merged = fnBody(placementCode, "public.clear_organization_catalog_placement").replace(/^create function/, "create or replace function");
    const reemitted = body("public.clear_organization_catalog_placement");
    const read = "  select p.verification_status, p.verified_claim_id, c.verifier_kind\n    into prior_status, prior_claim_id, prior_verifier_kind\n    from private.organization_catalog_placements as p\n    left join private.organization_claims as c on c.id = p.verified_claim_id\n   where p.organization_id = org;\n";
    // A domain or platform verification is refused; a vouched one is withdrawn with reason parent_changed.
    const guard = "\n  if prior_status = 'verified'\n     and coalesce(prior_verifier_kind, '') not in ('parent_organization', 'sibling_organization') then\n    raise exception 'placement verified' using errcode = '22023';\n  end if;";
    const withdraw = "  if prior_status = 'verified' then\n    perform private.organization_claim_withdraw(\n      prior_claim_id, 'parent_changed', 'organization_admin', (select auth.uid()),\n      extensions.gen_random_uuid(), null);\n  end if;\n\n";
    for (const piece of [read, guard, withdraw]) expect(reemitted).toContain(piece);
    const restored = reemitted
      .replace("  prior_claim_id uuid;\n  prior_verifier_kind text;\n", "")
      .replace(read, "  select p.verification_status into prior_status\n    from private.organization_catalog_placements as p\n   where p.organization_id = org;\n")
      .replace(guard, "")
      .replace(withdraw, "");
    const squeeze = (text) => text.split("\n").filter((line) => line.trim() !== "").join("\n");
    expect(squeeze(restored)).toBe(squeeze(merged));
  });

  it("re-emits 4a's set keeping the verified status and refusing an identity flip while verified", () => {
    const merged = fnBody(placementCode, "public.set_organization_catalog_placement").replace(/^create function/, "create or replace function");
    const reemitted = body("public.set_organization_catalog_placement");
    // The re-emission updates an existing row in place (an INSERT's proposed
    // row meets the CHECKs before ON CONFLICT) and keeps 4a's upsert, minus the
    // status reset, for a first placement.
    const upsertAt = reemitted.indexOf("    insert into private.organization_catalog_placements as p (");
    const inPlace = reemitted.slice(reemitted.indexOf("  if prior_status is not null then\n"), reemitted.indexOf("  end if;\n\n  insert into public.organization_audit_ledger") + "  end if;\n".length);
    const upsert = reemitted.slice(upsertAt, reemitted.indexOf("updated_at = pg_catalog.now();\n", upsertAt) + "updated_at = pg_catalog.now();\n".length)
      .split("\n").map((line) => line.replace(/^ {2}/, "")).join("\n")
      .replace("        identity_unlisted = excluded.identity_unlisted,\n", "        identity_unlisted = excluded.identity_unlisted,\n        verification_status = 'self_reported',\n");
    expect(inPlace).toContain("  if prior_status is not null then\n    update private.organization_catalog_placements\n");
    const earlyRead = "  select p.verification_status, p.identity_unlisted, p.identity_catalog_key\n    into prior_status, prior_identity_unlisted, prior_identity_key\n    from private.organization_catalog_placements as p\n   where p.organization_id = org;\n";
    expect(reemitted).toContain(earlyRead);
    // Round 3: a parent-union or sister vouch pins the parent; changing the
    // parent key withdraws that verification before the write.
    const pinRead = "  select p.parent_catalog_key, p.verified_claim_id, c.verifier_kind\n    into prior_parent_key, prior_claim_id, prior_verifier_kind\n    from private.organization_catalog_placements as p\n    left join private.organization_claims as c on c.id = p.verified_claim_id\n   where p.organization_id = org;\n  withdraw := coalesce(prior_status = 'verified'\n    and prior_verifier_kind in ('parent_organization', 'sibling_organization')\n    and parent_key is distinct from prior_parent_key, false);\n";
    const pinWithdraw = "  if withdraw then\n    perform private.organization_claim_withdraw(\n      prior_claim_id, 'parent_changed', 'organization_admin', (select auth.uid()),\n      extensions.gen_random_uuid(), null);\n    select p.verification_status, p.identity_unlisted, p.identity_catalog_key\n      into prior_status, prior_identity_unlisted, prior_identity_key\n      from private.organization_catalog_placements as p\n     where p.organization_id = org;\n  end if;\n\n";
    for (const piece of [pinRead, pinWithdraw]) expect(reemitted).toContain(piece);
    const restored = reemitted
      .replace("  prior_parent_key text;\n  prior_claim_id uuid;\n  prior_verifier_kind text;\n  withdraw boolean;\n", "")
      .replace(pinRead, "")
      .replace(pinWithdraw, "")
      .replace("  if parent_key is null and parent_name is null and not identity_only\n     and (prior_identity_key is null or withdraw) then", "  if parent_key is null and parent_name is null and not identity_only and prior_identity_key is null then")
      .replace("  prior_identity_unlisted boolean;\n  prior_identity_key text;\n", "")
      .replace(earlyRead, "")
      .replace(" and not identity_only and prior_identity_key is null then", " and not identity_only then")
      .replace("\n  if prior_status = 'verified' and identity_only is distinct from prior_identity_unlisted then\n    raise exception 'placement verified' using errcode = '22023';\n  end if;",
        "\n  select p.verification_status into prior_status\n    from private.organization_catalog_placements as p\n   where p.organization_id = org;")
      .replace("'toStatus', coalesce(prior_status, 'self_reported'),", "'toStatus', 'self_reported',")
      .replace("      'reasonCode', case when parent_key is not null or parent_name is not null then 'parent_set'\n                         when identity_only then 'identity_unlisted'\n                         else 'parent_cleared' end",
        "      'reasonCode', case when parent_key is not null or parent_name is not null\n                         then 'parent_set' else 'identity_unlisted' end")
      .replace(inPlace, upsert);
    // Blank lines only: the in-place branch carries a comment the stripper leaves as whitespace.
    const squeeze = (text) => text.split("\n").filter((line) => line.trim() !== "").join("\n");
    expect(squeeze(restored)).toBe(squeeze(merged));
    expect(reemitted).not.toMatch(/do update[\s\S]*verification_status\s*=/);
  });

  it("forbids the set's status reset in the contract with the literal as written in SQL", () => {
    // A merge once stripped the quotes, leaving a needle no SQL body can
    // contain, so the forbid could never fire (PR #3415 review C4).
    const contract = readJson("../scripts/db-contract.json");
    const entry = contract.functions.find((f) => f.sig.startsWith("public.set_organization_catalog_placement("));
    expect(entry.bodyForbids).toContain("verification_status = 'self_reported'");
    expect(entry.bodyForbids).not.toContain("verification_status = self_reported");
  });

  it("monitors the retention job in the CHECK, the cron mirror and the job-health catalog", () => {
    const check = code.slice(code.indexOf("add constraint organization_job_runs_job_name_check"));
    expect(check.slice(0, check.indexOf(";"))).toContain("'organization-claim-retention'");
    expect(body("private.sync_organization_job_runs_from_cron_history")).toContain("'organization-claim-retention'");
    expect(body("public.list_organization_job_health")).toContain("'organization-claim-retention'");
    expect(code).toContain("'organization-claim-retention',\n      '41 5 * * *',\n      'select private.purge_organization_claim_personal_data();'");
  });

  it("writes tenant ledger rows for verifier and automatic decisions without a user id", () => {
    for (const [name, event] of [
      ["private.organization_claim_verify_placement", "organization_catalog_placement_verified"],
      ["private.organization_claim_withdraw", "organization_catalog_placement_verification_revoked"],
    ]) {
      const fn = body(name);
      const insert = fn.slice(fn.indexOf("insert into public.organization_audit_ledger"));
      expect(insert, name).toContain(`'${event}'`);
      expect(insert.slice(insert.indexOf(`'${event}'`), insert.indexOf(`'${event}'`) + 80), name).toMatch(/'(?:update|create)',\s+null,/);
    }
    // The vouching organization's own ledger names its admin; the claiming
    // organization's verified row (written by verify_placement) does not.
    const vouch = body("public.vouch_for_organization_claims");
    expect(vouch).toMatch(/'organization_catalog_claim_vouched', 'update',\s+\(select auth\.uid\(\)\)/);
  });
});
