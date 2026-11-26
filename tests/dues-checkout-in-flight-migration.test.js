// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "supabase/migrations";
const NAME = "20260925621000_dues_checkout_in_flight_named_condition.sql";
const migration = readFileSync(`${DIR}/${NAME}`, "utf8");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function functionBody(sql, head) {
  const start = sql.indexOf(head);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("$function$", start) + "$function$".length;
  return sql.slice(open, sql.indexOf("$function$", open));
}

function pinnedDigest(signature) {
  const at = migration.indexOf(`'${signature}'::regprocedure`);
  expect(at).toBeGreaterThan(0);
  return /is distinct from '([a-f0-9]{64})'/.exec(migration.slice(at))[1];
}

function stateList(text) {
  return /state in \(([^)]*)\)/.exec(text)[1].split(",").map((value) => value.trim().replaceAll("'", "")).sort();
}

const provider = readFileSync(`${DIR}/20260831110200_mi1_dues_stripe_provider.sql`, "utf8");
const indexPredicate = stateList(/create unique index dues_one_active_checkout_per_obligation[\s\S]*?;/.exec(provider)[0]);

describe("dues checkout in-flight migration", () => {
  it("supersedes exactly the reviewed predecessor bodies", () => {
    // 20260907151000 wraps the 20260831110200 body in the case-graph lock with
    // this exact text; re-derive it rather than trusting a copied digest.
    const original = functionBody(provider, "create or replace function public.create_dues_checkout_reservation");
    const trimmed = original.replace(/[\n\r\t ]+$/, "");
    const wrapped = "\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n"
      + trimmed + (trimmed.endsWith(";") ? "" : ";") + "\nend;\n";
    const wrappers = readFileSync(`${DIR}/20260907151000_account_deletion_finalization_reconciliation.sql`, "utf8");
    expect(wrappers).toContain(`('public.create_dues_checkout_reservation(uuid,text)', '${sha256(original)}')`);
    expect(pinnedDigest("public.create_dues_checkout_reservation(uuid, text)")).toBe(sha256(wrapped));

    const repairs = readFileSync(`${DIR}/20260831211500_mi1_dues_review_repairs.sql`, "utf8");
    expect(pinnedDigest("public.get_my_dues_workspace(uuid, integer)"))
      .toBe(sha256(functionBody(repairs, "create or replace function public.get_my_dues_workspace(")));

    const later = readdirSync(DIR).filter((file) => file.endsWith(".sql") && file > "20260907151000" && file !== NAME);
    for (const file of later) {
      const sql = readFileSync(`${DIR}/${file}`, "utf8");
      expect(sql, file).not.toMatch(/function public\.(create_dues_checkout_reservation|get_my_dues_workspace)\s*\(/);
      expect(sql, file).not.toMatch(/dues_one_active_checkout_per_obligation/);
    }
  });

  it("raises a named in-flight condition over the index's own states and keeps the case-graph lock", () => {
    const body = functionBody(migration, "create or replace function public.create_dues_checkout_reservation");
    expect(body).toMatch(/^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n/);
    const guard = /if exists \(select 1 from public\.dues_checkout_reservations active[^\n]*raise exception 'dues checkout in flight' using errcode = '55006'; end if;/.exec(body);
    expect(guard).not.toBeNull();
    expect(stateList(guard[0])).toEqual(indexPredicate);
    // The same-key idempotent return still answers before the new refusal.
    expect(body.indexOf("'idempotent', true")).toBeLessThan(guard.index);
    expect(body.indexOf("insert into public.dues_checkout_reservations")).toBeGreaterThan(guard.index);
  });

  it("projects checkoutInFlight per member obligation over the same states", () => {
    const body = functionBody(migration, "create or replace function public.get_my_dues_workspace(");
    const flag = /'checkoutInFlight', exists \([\s\S]*?\)\s*\),/.exec(body);
    expect(flag).not.toBeNull();
    expect(flag[0]).toContain("reservation.obligation_id = visible.id");
    expect(stateList(flag[0])).toEqual(indexPredicate);
  });

  it("runs as one transaction without table, policy or grant changes", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd().endsWith("commit;")).toBe(true);
    const statements = migration.replace(/--[^\n]*/g, "");
    expect(statements).not.toMatch(/\b(alter|create) (table|policy|index)\b|\bgrant\b|\brevoke\b/i);
  });
});
