// @vitest-environment node
//
// Offline pins for the union catalog database half
// (REQ-UG-UNION-CATALOG-REFERENCE-FOUNDATION-20260924; spec
// docs/superpowers/specs/2026-09-24-union-catalog-prefilled-organizations-design.md
// §2.2, §2.6 and §6.1). The live half is tests/union-catalog-db.test.js.
import { describe, expect, it } from "vitest";
// This suite pins the historical foundation, before the additive locale migration.
import { KEY_COLUMNS, LEGACY_RELEASE_COLUMNS as RELEASE_COLUMNS, STAGING_DIGEST_SQL } from "../scripts/load-union-catalog.mjs";
import { CONTENT_TABLES } from "../scripts/union-catalog/catalog-shape.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const code = stripComments(loadMigrationSql("union_catalog_reference_foundation"));

const TABLES = [
  "catalog_releases",
  "catalog_organizations",
  "catalog_edges",
  "catalog_subunits",
  "catalog_seat_outlines",
  "catalog_contacts",
  "catalog_documents",
  "catalog_document_subunits",
  "catalog_coverage",
  "catalog_staging",
];

const READ_RPCS = {
  "public.get_union_catalog_status": "public.get_union_catalog_status()",
  "public.search_union_catalog": "public.search_union_catalog(text, text, text, text, integer)",
  "public.get_union_catalog_profile": "public.get_union_catalog_profile(text)",
};

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("union catalog reference foundation migration", () => {
  it("is one begin/commit unit with local timeouts and a PostgREST reload", () => {
    const statements = code.trim();
    expect(statements.startsWith("begin;")).toBe(true);
    expect(statements.endsWith("commit;")).toBe(true);
    expect(code.match(/^\s*begin;\s*$/gim)).toHaveLength(1);
    expect(code.match(/^\s*commit;\s*$/gim)).toHaveLength(1);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("set local statement_timeout = '60s';");
    expect(code).toContain("notify pgrst, 'reload schema';");
  });

  it("enables and forces RLS on every catalog table and revokes all four roles", () => {
    for (const table of TABLES) {
      expect(code, table).toContain(`create table private.${table} (`);
      expect(code, table).toContain(`alter table private.${table} enable row level security;`);
      expect(code, table).toContain(`alter table private.${table} force row level security;`);
      expect(code, table).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
      expect(code, table).toMatch(new RegExp(`comment on table private\\.${table} is`));
    }
    expect(code.match(/create table /g)).toHaveLength(TABLES.length);
  });

  it("grants nothing on a catalog table and defines no policy and no trigger", () => {
    expect(code).not.toMatch(/\bgrant\s+(?!execute\s+on\s+function)[^;]*\bon\s+(?:table\s+)?private\.catalog_/i);
    expect(code).not.toMatch(/\b(?:create|alter)\s+policy\b/i);
    expect(code).not.toMatch(/\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b/i);
    expect(code).not.toMatch(/\bdo\s+\$/i);
    expect(code).not.toMatch(/\bexecute\s+(?!on\s+function)/i);
  });

  it("keeps every foreign key among the private catalog tables", () => {
    const targets = [...code.matchAll(/\breferences\s+([a-z_.]+)/gi)].map((match) => match[1]);
    expect(targets).toHaveLength(14);
    for (const target of targets) expect(target).toMatch(/^private\.catalog_(?:releases|organizations|subunits|documents)$/);
    expect(code).not.toMatch(/references\s+(?:auth\.users|public\.)/i);
    // union_org_id is a soft link to public.union_orgs, never a foreign key,
    // held to a bounded, control-free registry id (public.union_orgs.id is
    // free text, not a uuid).
    expect(code).toMatch(/^\s*union_org_id text\n\s*constraint catalog_organizations_union_org_id_check check \(char_length\(union_org_id\) between 1 and 200 and union_org_id !~ '\[\[:cntrl:\]\]'\),$/m);
  });

  it("pins search_path, definer mode and volatility on every function", () => {
    for (const name of Object.keys(READ_RPCS)) {
      const body = fnBody(code, name);
      expect(body, name).toMatch(/language plpgsql\s+stable\s+security definer\s+set search_path = ''/);
      expect(body, name).not.toMatch(/\b(?:insert\s+into|update\s+[a-z_]+\.|delete\s+from)\b/i);
    }
    const activate = fnBody(code, "private.catalog_activate_release");
    expect(activate).toMatch(/language plpgsql\s+volatile\s+security definer\s+set search_path = ''/);
    expect(activate).toContain("pg_catalog.pg_advisory_xact_lock(");
    const scrub = fnBody(code, "private.catalog_scrub_text");
    expect(scrub).toMatch(/language sql\s+immutable\s+set search_path = ''/);
    expect(scrub).not.toContain("security definer");
    expect(code.match(/^create function /gm)).toHaveLength(5);
    expect(code).not.toMatch(/\bselect\b[^;]*\bfrom\s+public\.organizations\b/i);
  });

  it("revokes every function from all four roles before granting exactly its callers", () => {
    for (const signature of Object.values(READ_RPCS)) {
      const s = escape(signature);
      expect(code, signature).toMatch(new RegExp(`revoke all on function ${s} from public, anon, authenticated, service_role;\\s*grant execute on function ${s} to anon, authenticated, service_role;`));
    }
    expect(code).toMatch(/revoke all on function private\.catalog_scrub_text\(text\) from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant\s+execute\s+on\s+function\s+private\.catalog_scrub_text/i);
    // Activation is owner-only: revoked from every role and granted to none,
    // so no Data API role (none of which holds USAGE on schema private
    // except authenticated) can reach it.
    expect(code).toMatch(/revoke all on function private\.catalog_activate_release\(text\) from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant\s+execute\s+on\s+function\s+private\.catalog_activate_release/i);
    expect(code.match(/grant execute on function/g)).toHaveLength(3);
  });

  it("applies every release column of every content table from the staging rows, retires by staged key, and never reads staging in a read RPC", () => {
    const activate = fnBody(code, "private.catalog_activate_release");
    // The research tables arrive with 20261012090000_union_catalog_research_tables
    // (tests/union-catalog-research-migration.test.js pins its activation).
    for (const table of CONTENT_TABLES) {
      expect(activate, table).toContain(`null::private.catalog_${table},`);
      expect(activate, table).toContain(`and s.table_name = '${table}'\n  on conflict (${KEY_COLUMNS[table].join(", ")}) do update`);
      for (const column of RELEASE_COLUMNS[table].filter((c) => !KEY_COLUMNS[table].includes(c))) {
        expect(activate, `${table}.${column}`).toContain(`${column} = excluded.${column}`);
      }
      const rowKey = KEY_COLUMNS[table].map((k) => `t.${k}`).join(" || '|' || ");
      expect(activate, table).toContain(`s.table_name = '${table}' and s.row_key = ${rowKey})`);
    }
    expect(activate).not.toMatch(/\bfirst_release_id = excluded\b/);
    expect(activate).not.toMatch(/\bdelete from private\.catalog_(?!coverage|staging)/);
    expect(activate).toContain("target_verified_at is null or target_verified_at < target_loaded_at");
    // The verify digest: recomputed here with the loader's exact expression,
    // compared, and a retired release loses its stamp.
    const digestExpression = STAGING_DIGEST_SQL.slice(0, STAGING_DIGEST_SQL.indexOf(" as digest"));
    const flat = (text) => text.replace(/\s+/g, " ");
    expect(flat(activate)).toContain(flat(digestExpression));
    expect(activate).toContain("if target_verified_sha256 is null or staged_sha256 is distinct from target_verified_sha256 then");
    expect(activate).toContain("set status = 'retired',\n         verified_at = null,\n         verified_sha256 = null\n   where r.status = 'active';");
    expect(code).toContain("constraint catalog_releases_verified_sha256_check check (verified_sha256 ~ '^[0-9a-f]{64}$')");
    expect(activate).toContain("s.release_id <> target_id\n     and s.release_id is distinct from previous_id");
    for (const name of Object.keys(READ_RPCS)) expect(fnBody(code, name), name).not.toContain("catalog_staging");
  });

  it("gives every search row a parentName: past a scrubbed label edge for a catalog row, the scrubbed registry parent name for a registry row", () => {
    const search = fnBody(code, "public.search_union_catalog");
    expect(search).toContain("and coalesce(parent.name, private.catalog_scrub_text(e.parent_label)) is not null");
    expect(search).toContain(") else private.catalog_scrub_text(page.registry_parent) end)");
    expect(search).toContain("u.parent_name as registry_parent");
    expect(search).toContain("null::text as registry_parent");
    expect(search).not.toMatch(/'parentName', u\.parent_name/);
  });
});
