// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, migrationNames, loadMigrationSql, sqlObjectsNamed, stripComments } from "./helpers/migration.js";
import { provenanceObjects } from "./helpers/knowledge-provenance.js";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";

// BUG-UG-STEWARD-DESK-RPC-LATENCY-AT-SCALE-20260908: the initial-wave
// latency repair is two additive indexes and a one-line change to the private
// visibility helper's final projection. These pins keep it that narrow.
const migrationName = "20260911044500_steward_desk_initial_wave_latency.sql";
const source = loadMigrationSql("steward_desk_initial_wave_latency");
const executable = stripComments(source);
const helper = fnBody(executable, "private.staff_visible_member_ids");
const priorHelper = fnBody(stripComments(loadMigrationSql("steward_visibility_organization_batch")), "private.staff_visible_member_ids");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const helperEntry = contract.functions.find((item) => item.sig === "private.staff_visible_member_ids(p_role text)");
const projection = "where profile.chapter_id = any (array(select visible_chapters.id from visible_chapters))";

describe("steward desk initial-wave latency migration", () => {
  it("applies after the organization-batch helper it refines", () => {
    const names = migrationNames();
    expect(names.indexOf(migrationName)).toBeGreaterThan(names.indexOf("20260910164000_steward_visibility_organization_batch.sql"));
  });

  it("is one forward-only transaction of access-path statements with no policy, table, grant or KPI change", () => {
    expect(executable).toMatch(/^\s*begin;/);
    expect(executable).toMatch(/commit;\s*$/);
    expect(executable).not.toMatch(/\b(create|drop|alter)\s+policy\b/i);
    expect(executable).not.toMatch(/\balter\s+table\b/i);
    expect(executable).not.toMatch(/row level security/i);
    expect(executable).not.toMatch(/get_steward_desk_kpis/);
    expect(executable).not.toMatch(/\bdo\s+\$/i);
    expect(executable).not.toMatch(/if not exists/i);
    expect(executable).not.toMatch(/grant\s+usage/i);
    expect(executable).not.toMatch(/statement_timeout/i);
  });

  it("adds exactly the two covering indexes and retains the contract-pinned chapter index", () => {
    expect(executable).toContain("create index member_profiles_chapter_id_idx\n  on public.member_profiles (chapter_id, id);");
    expect(executable).toContain("create index member_messages_convo_latest_idx\n  on public.member_messages (conversation_id, created_at desc, id desc)\n  include (sender_kind, user_id);");
    expect((executable.match(/create index/gi) || []).length).toBe(2);
    expect(executable).not.toMatch(/drop index/i);
    expect(contract.indexes.find((item) => item.name === "member_profiles_chapter_idx")).toMatchObject({ defContains: ["USING btree (chapter_id)"] });
  });

  it("changes only the helper's final projection and keeps every authorization branch and its ACL", () => {
    expect(helper).toContain(projection);
    expect(helper).not.toContain("join visible_chapters");
    const cut = (body) => body.slice(0, body.indexOf("select profile.id"));
    expect(cut(helper)).toBe(cut(priorHelper));
    for (const needle of ["language plpgsql", "stable", "security definer", "set search_path = ''", "return query"]) {
      expect(helper).toContain(needle);
    }
    for (const needle of helperEntry.bodyContains) expect(helper).toContain(needle);
    expect(executable).toContain("revoke all on function private.staff_visible_member_ids(text)\n  from public, anon, authenticated, service_role;");
    expect(executable).toContain("grant execute on function private.staff_visible_member_ids(text)\n  to authenticated, service_role;");
  });

  it("re-pins the helper and registers both indexes in the db contract", () => {
    expect(helperEntry).toMatchObject({ secdef: true, exec: "authenticated,service_role" });
    expect(helperEntry.bodyContains).toContain("profile.chapter_id = any (array(select visible_chapters.id from visible_chapters))");
    expect(helperEntry.bodyContains).toContain("from public.member_profiles profile");
    expect(helperEntry.bodyContains).not.toContain("join visible_chapters");
    expect(helperEntry.bodyContains).toContain("public.member_role_chapters");
    expect(helperEntry.note).toContain("20260911044500");
    expect(contract.indexes.find((item) => item.name === "member_profiles_chapter_id_idx")).toMatchObject({
      table: "member_profiles", defContains: ["USING btree (chapter_id, id)"],
    });
    expect(contract.indexes.find((item) => item.name === "member_messages_convo_latest_idx")).toMatchObject({
      table: "member_messages", defContains: ["USING btree (conversation_id, created_at DESC, id DESC) INCLUDE (sender_kind, user_id)"],
    });
  });

  it("is covered by the required live scale proof and names no knowledge provenance object", () => {
    expect(PROOF_FILES).toContain("tests/steward-desk-scale-latency-db.test.js");
    // The provenance pins' tails are derived now: a later migration needs a
    // review there only if it names one of their objects, and this one must not.
    expect(migrationNames()).toContain(migrationName);
    expect(sqlObjectsNamed(source, provenanceObjects())).toEqual([]);
  });
});
