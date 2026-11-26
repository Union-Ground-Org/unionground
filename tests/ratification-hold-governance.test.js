import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = join(root, "supabase", "migrations");

function migration(name) {
  return readFileSync(join(migrations, name), "utf8").toLowerCase();
}

const sql = migration("20261014009000_unionground_ratification_hold_governance.sql");
const bargaining = migration("20261014008000_unionground_bargaining_writers.sql");

function functionBody(source, name, schema = "public") {
  const start = `create or replace function ${schema}.${name}`;
  const fallback = `create function ${schema}.${name}`;
  const startAt = source.includes(start)
    ? source.indexOf(start)
    : source.indexOf(fallback);
  expect(startAt, `${schema}.${name} missing`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("as $$", startAt);
  expect(bodyStart, `${name} body missing`).toBeGreaterThan(startAt);
  const endAt = source.indexOf("\n$$;", bodyStart);
  expect(endAt, `${name} terminator missing`).toBeGreaterThan(bodyStart);
  return source.slice(startAt, endAt + 4);
}

const resolver = functionBody(sql, "resolve_ratification_integrity_hold");
const trigger = functionBody(
  sql,
  "prevent_corrected_ratification_reactivation",
  "private",
);

describe("ratification integrity hold governance", () => {
  it("adds the resolution RPC with the signature the hold needs", () => {
    expect(sql).toContain("create function public.resolve_ratification_integrity_hold(");
    for (const parameter of [
      "p_cycle_id uuid",
      "p_expected_cycle_revision integer",
      "p_request_id uuid",
      "p_resolution_note text",
    ]) {
      expect(resolver).toContain(parameter);
    }
  });

  it("is security definer with a pinned empty search_path", () => {
    expect(resolver).toContain("security definer");
    expect(resolver).toContain("set search_path = ''");
    // The relaxed trigger runs with the same posture; a definer function that
    // lost its pinned search_path would be resolvable by a caller-controlled
    // schema.
    expect(trigger).toContain("security definer");
    expect(trigger).toContain("set search_path = ''");
  });

  it("takes the same coordinator writer lock as the correction it reverses", () => {
    expect(resolver).toContain("private.lock_bargaining_campaign_writer(");
    // `true` is the coordinator_only argument: an organizer may record a
    // correction's evidence but only a coordinator may lift the hold.
    expect(resolver).toMatch(
      /private\.lock_bargaining_campaign_writer\(\s*campaign\.id,\s*campaign\.chapter_id,\s*true\s*\) is null/,
    );
    expect(bargaining).toContain("create function private.lock_bargaining_campaign_writer(");
  });

  it("requires MFA and holds the same advisory locks in the same order", () => {
    expect(resolver).toContain("private.mfa_satisfied()");
    const resetLock = resolver.indexOf("'unionground:mfa-reset:'");
    const requestLock = resolver.indexOf("'unionground:lifecycle-request:");
    expect(resetLock).toBeGreaterThan(0);
    expect(requestLock).toBeGreaterThan(resetLock);
  });

  it("is retry-safe and revision-checked like the sibling bargaining writers", () => {
    expect(resolver).toContain("private.bargaining_request_fingerprint(");
    expect(resolver).toContain("where a.actor_id = caller");
    expect(resolver).toContain("request_fingerprint is distinct from fingerprint");
    expect(resolver).toContain("'changed', false");
    expect(resolver).toContain("using errcode = '40001'");
  });

  it("writes an append-only audit row before it clears the flag", () => {
    expect(resolver).toContain("insert into public.union_lifecycle_audit_events");
    expect(resolver).toContain("'bargaining.integrity_hold.resolved'");
    expect(resolver).toContain("'bargaining_integrity_hold'");
    const auditAt = resolver.indexOf("insert into public.union_lifecycle_audit_events");
    const clearAt = resolver.indexOf("ratification_integrity_hold = false");
    expect(auditAt).toBeGreaterThan(0);
    // Ordering is load-bearing: the trigger reads the receipt back, so a
    // clear written first would be rejected by the guard below.
    expect(clearAt).toBeGreaterThan(auditAt);
  });

  it("sets the transaction-local marker and clears it again", () => {
    expect(resolver).toContain(
      "pg_catalog.set_config(\n    'unionground.hold_resolution',\n    p_request_id::text,\n    true\n  )",
    );
    expect(resolver).toContain(
      "pg_catalog.set_config('unionground.hold_resolution', '', true)",
    );
  });

  it("permits the clear only under the marker, and only with a matching receipt", () => {
    expect(trigger).toContain("old.ratification_integrity_hold");
    expect(trigger).toContain("not new.ratification_integrity_hold");
    expect(trigger).toContain(
      "pg_catalog.current_setting('unionground.hold_resolution', true)",
    );
    expect(trigger).toContain("a.request_id = resolution::uuid");
    expect(trigger).toContain("a.event_type = 'bargaining.integrity_hold.resolved'");
    expect(trigger).toContain("a.entity_id = new.id");
    // A missing or malformed marker still hits the original refusal, so the
    // DBA-disables-the-trigger recovery is not silently re-enabled.
    expect(trigger).toContain("if resolution is null");
    expect(trigger).toContain(
      "raise exception 'ratification integrity hold requires governed resolution'",
    );
    // The hold is only legitimate after a correction, so the exit demands one.
    expect(trigger).toContain(
      "from public.organizing_bargaining_ratification_corrections correction",
    );
  });

  it("keeps the two pre-existing trigger refusals intact", () => {
    expect(trigger).toContain(
      "raise exception 'corrected ratification cannot become current'",
    );
    expect(trigger).toContain(
      "raise exception 'ratification integrity hold requires corrected contract authority'",
    );
  });

  it("exposes the RPC to authenticated only, and the trigger to nobody", () => {
    expect(sql).toMatch(
      /revoke all on function public\.resolve_ratification_integrity_hold\([\s\S]*?from public, anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /grant execute on function public\.resolve_ratification_integrity_hold\([\s\S]*?to authenticated;/,
    );
    expect(sql).toMatch(
      /revoke all on function private\.prevent_corrected_ratification_reactivation\(\)\s*from public, anon, authenticated, service_role;/,
    );
    expect(sql).not.toMatch(
      /grant execute on function public\.resolve_ratification_integrity_hold\([\s\S]*?to (anon|service_role|public)\b/,
    );
  });

  it("replaces the applied trigger instead of rewriting the applied migration", () => {
    expect(sql).toContain(
      "create or replace function private.prevent_corrected_ratification_reactivation()",
    );
    // 20261014008000 must still ship the original, unrelaxed body.
    const applied = functionBody(
      bargaining,
      "prevent_corrected_ratification_reactivation",
      "private",
    );
    expect(applied).not.toContain("unionground.hold_resolution");
  });
});
