// @vitest-environment node
//
// Offline pins for 20261012090000_union_catalog_research_tables
// (REQ-UG-UNION-CATALOG-RESEARCH-EXPORT-TRANSLATOR-20261012). The live
// half is tests/union-catalog-research-db.test.js.
import { describe, expect, it } from "vitest";
import { KEY_COLUMNS, LEGACY_RELEASE_COLUMNS as RELEASE_COLUMNS, STAGING_DIGEST_SQL } from "../scripts/load-union-catalog.mjs";
import { RELEASE_TABLES as CURRENT_TABLES, RESEARCH_FACT_KINDS } from "../scripts/union-catalog/catalog-shape.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const code = stripComments(loadMigrationSql("union_catalog_research_tables"));
const foundation = stripComments(loadMigrationSql("union_catalog_reference_foundation"));
// This suite pins the October research migration; identifiers were added later.
const RELEASE_TABLES = CURRENT_TABLES.filter((table) => table !== "identifiers");

describe("union catalog research tables migration", () => {
  it("is one begin/commit unit that forces RLS on, and revokes every role from, both research tables", () => {
    const statements = code.trim();
    expect(statements.startsWith("begin;")).toBe(true);
    expect(statements.endsWith("commit;")).toBe(true);
    for (const table of ["catalog_research_facts", "catalog_research_categories"]) {
      expect(code).toContain(`alter table private.${table} enable row level security;`);
      expect(code).toContain(`alter table private.${table} force row level security;`);
      expect(code).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
    }
    expect(code).not.toMatch(/create policy/i);
    // The one grant is the operator-only draft RPC, to the service role.
    expect(code.match(/grant /g)).toHaveLength(1);
    expect(code).toContain("grant execute on function public.get_union_catalog_research_draft(uuid, text, integer, uuid) to service_role;");
    expect(code).toMatch(/revoke all on function private\.catalog_activate_release\(text\) from public, anon, authenticated, service_role;/);
  });

  it("carries no person or packet-text column and keeps the evidence tier apart from the organization tier", () => {
    const facts = code.slice(code.indexOf("create table private.catalog_research_facts"), code.indexOf("create index catalog_research_facts_catalog_key_idx"));
    const categories = code.slice(code.indexOf("create table private.catalog_research_categories"), code.indexOf("create index catalog_research_categories_catalog_key_idx"));
    for (const table of [facts, categories]) {
      for (const forbidden of ["quote", "label", "value", "holder", "name", "email", "phone"]) {
        expect(table).not.toMatch(new RegExp(`^\\s+${forbidden} `, "m"));
      }
      expect(table).not.toMatch(/^\s+tier /m);
      expect(table).toMatch(/^\s+evidence_tier smallint not null$/m);
    }
    for (const column of RELEASE_COLUMNS.research_facts) expect(facts).toMatch(new RegExp(`^\\s+${column} `, "m"));
    for (const column of RELEASE_COLUMNS.research_categories) expect(categories).toMatch(new RegExp(`^\\s+${column} `, "m"));
    expect(facts).toContain(`check (fact_kind in (${RESEARCH_FACT_KINDS.slice(0, 3).map((k) => `'${k}'`).join(", ")},`);
    expect(facts).toContain("check ((binding = 'bound') = (catalog_key is not null))");
    expect(categories).toContain("check (gate_contract = 'usability_contract_v5.category_gate')");
  });

  it("widens the staging check to every release table", () => {
    expect(code).toContain("alter table private.catalog_staging drop constraint catalog_staging_table_name_check;");
    const check = code.slice(code.indexOf("add constraint catalog_staging_table_name_check"));
    const names = [...check.slice(0, check.indexOf(";")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(names).toEqual([...RELEASE_TABLES]);
  });

  it("replaces the activation with one that applies and retires every release table, research included", () => {
    const activate = fnBody(code, "private.catalog_activate_release");
    expect(code).toContain("create or replace function private.catalog_activate_release(p_label text)");
    for (const table of RELEASE_TABLES) {
      expect(activate, table).toContain(`null::private.catalog_${table},`);
      expect(activate, table).toContain(`and s.table_name = '${table}'\n  on conflict (${KEY_COLUMNS[table].join(", ")}) do update`);
      for (const column of RELEASE_COLUMNS[table].filter((c) => !KEY_COLUMNS[table].includes(c))) {
        expect(activate, `${table}.${column}`).toContain(`${column} = excluded.${column}`);
      }
      const rowKey = KEY_COLUMNS[table].map((k) => `t.${k}`).join(" || '|' || ");
      expect(activate, table).toContain(`s.table_name = '${table}' and s.row_key = ${rowKey})`);
      expect(activate, table).toContain(`select '${table}'`);
    }
    expect(activate).not.toMatch(/\bfirst_release_id = excluded\b/);
    expect(activate).not.toMatch(/\bdelete from private\.catalog_(?!coverage|staging)/);
    const flat = (text) => text.replace(/\s+/g, " ");
    expect(flat(activate)).toContain(flat(STAGING_DIGEST_SQL.slice(0, STAGING_DIGEST_SQL.indexOf(" as digest"))));
    // Everything the foundation's activation did, it still does: the new body
    // is the old one with research blocks added, never a line removed.
    const before = fnBody(foundation, "private.catalog_activate_release").split("\n")
      .filter((line) => line.trim() && !line.startsWith("create function"));
    const after = new Set(activate.split("\n"));
    expect(before.filter((line) => !after.has(line))).toEqual([]);
  });

  it("keeps the draft RPC to a service-role operator, reading only live, non-staging rows", () => {
    const draft = fnBody(code, "public.get_union_catalog_research_draft");
    expect(draft).toContain("if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then");
    expect(draft).toContain("perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);");
    expect(draft).not.toContain("catalog_staging");
    expect(draft).not.toMatch(/\b(insert|update|delete)\b/);
    expect(draft).toContain("private.catalog_scrub_text(listed.title)");
    expect(code).toContain("security definer\nset search_path = ''");
    for (const name of ["get_union_catalog_status", "search_union_catalog", "get_union_catalog_profile"]) {
      expect(code).not.toContain(`function public.${name}`);
    }
  });
});
