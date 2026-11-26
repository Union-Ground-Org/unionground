// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20260924140100_dues_stripe_disconnect_tenant_audit";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const migrations = migrationFiles();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const previousEventSql = loadMigrationSql("20260924100200_public_interest_lead_tenant_scoped_reads");
const disconnectOriginalSql = loadMigrationSql("20260831110200_mi1_dues_stripe_provider");
const completeOriginalSql = loadMigrationSql("20260831170400_mi1_dues_settlement_reconciliation");

const DISCONNECT = "public.disconnect_dues_stripe_account";
const COMPLETE = "public.complete_dues_stripe_disconnect";

function eventTypes(source) {
  const definitions = [...source.matchAll(
    /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
  )];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function wrap(source) {
  const rtrimmed = source.replace(/[\n\r\t ]+$/, "");
  const semi = rtrimmed.endsWith(";") ? "" : ";";
  return `\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n${rtrimmed}${semi}\nend;\n`;
}

function parsed(name, source = sql, file = `${NAME}.sql`) {
  const fn = parseFunctions(source, file).find((entry) => entry.name === name);
  expect(fn, `missing ${name} in ${file}`).toBeTruthy();
  return fn;
}

function latestFunction(name) {
  const migration = [...migrations].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${name.toLowerCase()}(`)
  ));
  expect(migration, `missing migration for ${name}`).toBeTruthy();
  return {
    name: migration.name,
    sql: stripComments(migration.sql),
    body: stripComments(fnBody(migration.sql, name)),
    parsed: parsed(name, migration.sql, migration.name),
  };
}

function auditPayloads(body) {
  return [
    ...body.matchAll(/private\.mi1_write_tenant_audit\s*\(([\s\S]*?)\)\s*;/g),
    ...body.matchAll(/audit_metadata := ([\s\S]*?\));/g),
  ].map((match) => match[1]);
}

describe("Dues Stripe disconnect tenant audit migration", () => {
  const disconnect = latestFunction(DISCONNECT);
  const complete = latestFunction(COMPLETE);

  it("is the last definition of both disconnect RPCs", () => {
    expect(disconnect.name).toBe(`${NAME}.sql`);
    expect(complete.name).toBe(`${NAME}.sql`);
  });

  it("runs as one forward-only transaction after the wrapped originals", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260907151000_account_deletion_finalization_reconciliation").toBe(true);
    expect(NAME > "20260917131000_mi1_dues_oauth_recovery_row_shape").toBe(true);
  });

  it("admits only the reviewed 20260907151000-wrapped originals as predecessors", () => {
    expect(sql).toContain("f5fe4bbad253435d9c55ad755eaea53d3743ae73cb272c40967560490581df7f");
    expect(sql).toContain("bcdd21a5e2bee3b152773402af3c89eb13c8bf1dafb90150059f584b965be7b9");
    const originalDisconnect = parsed(DISCONNECT, disconnectOriginalSql, "20260831110200.sql");
    const originalComplete = parsed(COMPLETE, completeOriginalSql, "20260831170400.sql");
    expect(originalDisconnect.sourceSha256)
      .toBe("f793b871f6fc6754ecb98d1253a7b1d88af3cee9ed9b1d57801761e7e135201f");
    expect(originalComplete.sourceSha256)
      .toBe("4b60625058b9b67a4a9ac9f36e7b0c81d5feff295d46e30a28bc63a7b8d42bf9");
    expect(createHash("sha256").update(wrap(originalDisconnect.source)).digest("hex"))
      .toBe("f5fe4bbad253435d9c55ad755eaea53d3743ae73cb272c40967560490581df7f");
    expect(createHash("sha256").update(wrap(originalComplete.source)).digest("hex"))
      .toBe("bcdd21a5e2bee3b152773402af3c89eb13c8bf1dafb90150059f584b965be7b9");
  });

  it("keeps the installation lock wrapper as the first statement of each replaced body", () => {
    const lock = /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/;
    expect(disconnect.parsed.source).toMatch(lock);
    expect(complete.parsed.source).toMatch(lock);
  });

  it("writes a tenant audit event from the last disconnect request body", () => {
    expect(disconnect.body).toContain("private.mi1_write_tenant_audit");
    expect(disconnect.body).toContain("'dues_stripe_disconnect_requested'");
    expect(disconnect.body).toContain("if found then");
    expect(disconnect.body).toContain("'fromStatus', prior_state");
    expect(disconnect.body).toContain("'included', prior_label_present");
    expect(disconnect.body).toContain("'requestedBy', (select auth.uid())");
    expect(disconnect.body).toContain("jsonb_build_object(\n    'state', coalesce((select state from public.dues_provider_connections where organization_id = org), 'unset')\n  )");
  });

  it("writes a distinct tenant audit event on each completion terminal branch", () => {
    expect(complete.body).toContain("private.mi1_write_tenant_audit");
    expect(complete.body).toContain("'dues_stripe_disconnected'");
    expect(complete.body).toContain("'dues_stripe_disconnect_attention'");
    expect(complete.body).toContain("'requestedBy', audit_actor");
    const disconnectedStart = complete.body.indexOf("if p_outcome = 'disconnected'");
    const attentionUpdate = complete.body.lastIndexOf("set state = 'attention_required'");
    expect(disconnectedStart).toBeGreaterThan(-1);
    expect(attentionUpdate).toBeGreaterThan(disconnectedStart);
    expect(complete.body.indexOf("'dues_stripe_disconnected'")).toBeGreaterThan(disconnectedStart);
    expect(complete.body.indexOf("'dues_stripe_disconnected'")).toBeLessThan(attentionUpdate);
    expect(complete.body.indexOf("'dues_stripe_disconnect_attention'")).toBeGreaterThan(attentionUpdate);
  });

  it("attributes completion to the retained requester and never substitutes another member", () => {
    const requestLookup = complete.body.indexOf("event.event_type = 'dues_stripe_disconnect_requested'");
    const fallback = complete.body.indexOf("if audit_actor is null then");
    expect(requestLookup).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(requestLookup);
    // The request actor is read without a membership join, so a deleted
    // requester is not replaced by the connecting or an arbitrary member.
    expect(complete.body.slice(requestLookup, fallback)).not.toContain("organization_memberships");
    expect(complete.body.slice(0, complete.body.indexOf("if p_outcome = 'disconnected'")))
      .not.toContain("organization_memberships");
    expect(complete.body).toContain("elsif audit_actor is not null then");
    expect(complete.body).toMatch(
      /insert into public\.organization_audit_events \(\s*organization_id, event_type, actor_user_id, idempotency_key, metadata\s*\) values \(\s*connection\.organization_id, audit_event, audit_actor,/,
    );
  });

  it("records the bounded failure class on the attention event", () => {
    const attention = complete.body.slice(complete.body.indexOf("audit_event := 'dues_stripe_disconnect_attention'"));
    expect(attention).toContain("'failureClass', nullif(pg_catalog.left(p_failure_class, 80), '')");
  });

  it("preserves the lease-stale refusal, active-checkout refusal, and returned jsonb keys", () => {
    expect(complete.body).toContain("dues disconnect lease stale");
    expect(complete.body).toContain("using errcode = '42501'");
    expect(complete.body).toContain("dues disconnect has active checkout");
    expect(complete.body).toContain("using errcode = '55000'");
    expect(complete.body).toContain("jsonb_build_object('state', p_outcome)");
    expect(complete.body).toContain("p_outcome not in ('disconnected', 'attention_required')");
    expect(complete.body).toContain("connection.disconnect_lease_epoch <> p_lease_epoch");
    expect(complete.body).toContain("connection.disconnect_lease_owner is distinct from p_lease_owner");
  });

  it("never places stripe_account_id inside a tenant-audit jsonb payload", () => {
    const payloads = [
      ...auditPayloads(disconnect.body),
      ...auditPayloads(complete.body),
    ];
    expect(payloads.length).toBe(4);
    for (const payload of payloads) {
      expect(payload).not.toMatch(/stripe_account_id/);
    }
  });

  it("admits the three disconnect event types without rewriting metadata keys", () => {
    expect(sql).toContain("drop constraint organization_audit_events_event_type_check");
    expect(sql).not.toContain("drop constraint organization_audit_events_metadata_keys");
    expect(sql).not.toContain("organization_audit_events_metadata_keys check");
    const before = eventTypes(previousEventSql);
    const after = eventTypes(sql);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      "dues_stripe_disconnect_requested",
      "dues_stripe_disconnected",
      "dues_stripe_disconnect_attention",
    ]);
    expect(new Set(after).size).toBe(after.length);
  });

  it("re-derives the live source digests from the replaced bodies and pins them", () => {
    expect(createHash("sha256").update(disconnect.parsed.source).digest("hex"))
      .toBe(disconnect.parsed.sourceSha256);
    expect(disconnect.parsed.sourceSha256)
      .toBe("4a17773fa5a1d0c4e1d7c35d7be5c0e3882c33f1370ed2d66d4070a4a65a1e68");
    expect(sql).toContain("4a17773fa5a1d0c4e1d7c35d7be5c0e3882c33f1370ed2d66d4070a4a65a1e68");
    expect(createHash("sha256").update(complete.parsed.source).digest("hex"))
      .toBe(complete.parsed.sourceSha256);
    expect(complete.parsed.sourceSha256)
      .toBe("5d8daaa3fd6af175113b911b5197fbb2468fc54773ed4e81c4d9820d8a4da685");
    expect(sql).toContain("5d8daaa3fd6af175113b911b5197fbb2468fc54773ed4e81c4d9820d8a4da685");
  });

  it("pins the new predicates on the live contract entries", () => {
    const disconnectEntry = contract.functions.find((entry) => (
      entry.sig === "public.disconnect_dues_stripe_account(p_selected_hat text)"
    ));
    const completeEntry = contract.functions.find((entry) => (
      entry.sig === "public.complete_dues_stripe_disconnect(p_account_id text, p_lease_epoch integer, p_lease_owner uuid, p_outcome text, p_failure_class text)"
    ));
    const eventCheck = contract.constraints.find((entry) => (
      entry.name === "organization_audit_events_event_type_check"
    ));
    expect(disconnectEntry.bodyContains).toEqual([
      "private.mi1_write_tenant_audit",
      "'dues_stripe_disconnect_requested'",
      "'fromStatus', prior_state",
      "'included', prior_label_present",
      "'requestedBy', (select auth.uid())",
    ]);
    expect(completeEntry.bodyContains).toEqual([
      "private.mi1_write_tenant_audit",
      "'dues_stripe_disconnected'",
      "'dues_stripe_disconnect_attention'",
      "'requestedBy', audit_actor",
      "dues disconnect lease stale",
      "dues disconnect has active checkout",
    ]);
    expect(eventCheck.defContains).toEqual(expect.arrayContaining([
      "dues_stripe_disconnect_requested",
      "dues_stripe_disconnected",
      "dues_stripe_disconnect_attention",
    ]));
  });

  it("does not retain provider credentials", () => {
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });
});
