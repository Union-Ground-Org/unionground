// @vitest-environment node
//
// sol  F9 — steward appointments paging: text pins over
// list_steward_appointments, the re-created get_steward_appointments, and the
// keyset index in 20260809060000_steward_appointments_paging.sql, plus the
// matching scripts/db-contract.json pins. Text pins are a tripwire, not a
// proof (see staff-planes.test.js): they assert what THIS MIGRATION SAYS;
// current-state truth lives in the contract, checked by `npm run verify:db`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = loadMigrationSql("steward_appointments_paging");
const contract = JSON.parse(readFileSync(join(repoRoot, "scripts/db-contract.json"), "utf8"));

describe("appointments pager security shape", () => {
  it("list_steward_appointments is a DEFINER behind the blob's full gate", () => {
    const body = fnBody(sql, "list_steward_appointments");
    // Definer on purpose, unlike the desk queues: member_appointments has no
    // steward-side RLS read and member names resolve through the definer —
    // the appointment is the relationship that justifies them.
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body).toContain("not public.member_has_role(array['steward'])");
    expect(body).toContain("errcode = '42501'");
  });

  it("every branch hard self-scopes to the caller's own desk", () => {
    const body = fnBody(sql, "list_steward_appointments");
    // Four appearances: count + page for each of the two scopes. A definer
    // that ever forgot this predicate would serve another steward's desk.
    expect(body.split("a.steward_id = caller").length - 1).toBe(4);
  });

  it("is revoked from public/anon and granted to authenticated + service_role", () => {
    expect(sql).toContain("revoke all on function public.list_steward_appointments(text, timestamptz, uuid, integer) from public, anon;");
    expect(sql).toContain("grant execute on function public.list_steward_appointments(text, timestamptz, uuid, integer) to authenticated, service_role;");
  });
});

describe("closed-set validation and cursor guard", () => {
  it("an unknown scope raises 22023 — a typo never degrades to 'upcoming'", () => {
    const body = fnBody(sql, "list_steward_appointments");
    expect(body).toContain("if p_scope not in ('upcoming', 'recent') then");
    expect(body).toContain("errcode = '22023'");
  });

  it("a half-supplied cursor raises 'incomplete cursor' — starts_at is NOT NULL", () => {
    expect(fnBody(sql, "list_steward_appointments")).toContain("raise exception 'incomplete cursor' using errcode = '22023';");
  });

  it("clamps the page size to the JS caller's mirror", () => {
    expect(fnBody(sql, "list_steward_appointments")).toContain("least(greatest(coalesce(p_limit, 50), 1), 100)");
  });
});

describe("keyset walks are (starts_at, id) row comparisons over the blob's own windows", () => {
  it("upcoming ascends so ended-but-unmarked rows surface first", () => {
    const body = fnBody(sql, "list_steward_appointments");
    expect(body).toContain("(a.starts_at, a.id) > (p_after_starts, p_after_id)");
    expect(body).toContain("order by a.starts_at asc, a.id asc");
    expect(body).toContain("a.status = 'confirmed'");
  });

  it("recent descends over the settled statuses", () => {
    const body = fnBody(sql, "list_steward_appointments");
    expect(body).toContain("(a.starts_at, a.id) < (p_after_starts, p_after_id)");
    expect(body).toContain("order by a.starts_at desc, a.id desc");
    expect(body).toContain("a.status in ('completed', 'no_show', 'cancelled')");
  });

  it("both scopes keep the blob's 30-day floor", () => {
    const body = fnBody(sql, "list_steward_appointments");
    // Four appearances: count + page for each scope — the total answers "how
    // many match the window", never "how many exist all time".
    expect(body.split("now() - interval '30 days'").length - 1).toBe(4);
  });
});

describe("the re-created blob carries page one plus true totals", () => {
  it("stays a definer behind the same gate with an empty search_path", () => {
    const body = fnBody(sql, "get_steward_appointments");
    expect(sql).toContain("create or replace function public.get_steward_appointments()");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body).toContain("not public.member_has_role(array['steward'])");
    expect(body).toContain("errcode = '42501'");
  });

  it("lists shrink to one pager page each, id tiebreaks matching the pager", () => {
    const body = fnBody(sql, "get_steward_appointments");
    expect(body).toContain("order by a0.starts_at, a0.id limit 50");
    expect(body).toContain("order by a0.starts_at desc, a0.id desc limit 20");
  });

  it("carries the TRUE windowed totals alongside each list", () => {
    const body = fnBody(sql, "get_steward_appointments");
    expect(body).toContain("'upcomingTotal'");
    expect(body).toContain("'recentTotal'");
  });

  it("keeps its grant surface", () => {
    expect(sql).toContain("revoke all on function public.get_steward_appointments() from public, anon;");
    expect(sql).toContain("grant execute on function public.get_steward_appointments() to authenticated;");
  });
});

describe("keyset index", () => {
  it("ships the composite (steward_id, starts_at, id) index replayably", () => {
    expect(sql).toContain("create index if not exists member_appointments_steward_starts_id_idx");
    expect(sql).toContain("on public.member_appointments (steward_id, starts_at, id);");
  });
});

describe("db-contract pins", () => {
  it("pins the place wrapper and its non-executable guarded pager", () => {
    const entry = contract.functions.find((fn) => fn.sig === "public.list_steward_appointments(p_scope text, p_after_starts timestamp with time zone, p_after_id uuid, p_limit integer)");
    const legacy = contract.functions.find((fn) => fn.sig === "public.list_steward_appointments_without_place_legacy(p_scope text, p_after_starts timestamp with time zone, p_after_id uuid, p_limit integer)");
    expect(entry, "contract must pin list_steward_appointments").toBeDefined();
    expect(entry.secdef).toBe(true);
    expect(entry.exec).toBe("authenticated,service_role");
    expect(entry.bodyContains).toContain("list_steward_appointments_without_place_legacy");
    expect(legacy.exec).toBe("");
    expect(legacy.bodyContains).toContain("member_has_role(array['steward'])");
    expect(legacy.bodyContains).toContain("p_scope is null or p_scope not in ('upcoming', 'recent')");
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(legacy.sig);
  });

  it("pins the place wrapper and the guarded blob's totals", () => {
    const entry = contract.functions.find((fn) => fn.sig === "public.get_steward_appointments()");
    const legacy = contract.functions.find((fn) => fn.sig === "public.get_steward_appointments_without_place_legacy()");
    expect(entry).toBeDefined();
    expect(entry.secdef).toBe(true);
    expect(entry.bodyContains).toContain("get_steward_appointments_without_place_legacy");
    expect(legacy.bodyContains).toContain("upcomingTotal");
    expect(legacy.bodyContains).toContain("recentTotal");
    expect(contract.mfaCoverage.guardedDelegates).toHaveProperty(legacy.sig);
  });

  it("pins the keyset index with its live catalog definition", () => {
    const entry = contract.indexes.find((idx) => idx.name === "member_appointments_steward_starts_id_idx");
    expect(entry, "contract must pin the appointments keyset index").toBeDefined();
    expect(entry.defContains).toContain("USING btree (steward_id, starts_at, id)");
  });
});

// 20260809060000 was already applied
// and is immutable, so the two MED findings land as re-creates in a follow-up.
describe("appointments paging hardening follow-up (sol PR #736)", () => {
  const followUp = loadMigrationSql("appointments_paging_hardening");

  it("names null explicitly in the scope guard — `null not in` is never false", () => {
    const body = fnBody(followUp, "list_steward_appointments");
    expect(body).toContain("if p_scope is null or p_scope not in ('upcoming', 'recent') then");
    expect(body).toContain("errcode = '22023'");
    // The re-create keeps every attribute and the full gate.
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body.split("a.steward_id = caller").length - 1).toBe(4);
    expect(followUp).toContain("grant execute on function public.list_steward_appointments(text, timestamptz, uuid, integer) to authenticated, service_role;");
  });

  it("the blob's display aggregates tiebreak on id like the page boundaries", () => {
    const body = fnBody(followUp, "get_steward_appointments");
    expect(body).toContain("'routedVia', a.routed_via) order by a.starts_at, a.id)");
    expect(body).toContain("'status', a.status) order by a.starts_at desc, a.id desc)");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(followUp).toContain("grant execute on function public.get_steward_appointments() to authenticated;");
  });
});
