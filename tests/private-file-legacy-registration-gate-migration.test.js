// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins for 20260906023000. The live-database twins are `npm run verify:db`
// (bodyMd5 + bodyContains/bodyForbids on all five RPCs) and the two proofs in
// tests/private-file-workflow-gates-db.test.js. This file is what keeps the
// intent readable and what fails first if someone re-opens the legacy
// registration path or lets the two MIME allowlists drift apart again.
const NAME = "20260906023000_gate_legacy_registration_rpcs";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const GATE = "if not private.private_upload_is_current(inserted.bucket_id, inserted.object_name) then";
const GATED = ["public.register_member_case_file", "public.register_chapter_task_file"];
const UNGATED = [
  "public.register_member_form_file",
  "public.begin_member_case_file_upload",
  "public.begin_chapter_task_file_upload",
];

const body = (name) => stripComments(fnBody(code, name));

describe("legacy registration gate migration", () => {
  it("runs as one forward-only transaction after the workflow gates it completes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    expect(names.indexOf(`${NAME}.sql`))
      .toBeGreaterThan(names.indexOf("20260906020000_private_upload_workflow_gates.sql"));
    expect(names.indexOf(`${NAME}.sql`))
      .toBeGreaterThan(names.indexOf("20260906010000_private_upload_write_path_hardening.sql"));
  });

  it("gates both legacy one-step registrations on the one predicate, over the inserted row", () => {
    for (const rpc of GATED) {
      const definition = body(rpc);
      expect(definition, `${rpc} must carry the gate`).toContain(GATE);
      // The gate reads a server-owned row, never an argument: invariant 1.
      expect(definition).not.toMatch(/private_upload_is_current\(\s*p_/);
      // Same refusal shape as confirm_*, so a client branches on one thing.
      const gateAt = definition.indexOf(GATE);
      expect(definition.slice(gateAt, gateAt + 220))
        .toContain("raise exception 'file inspection required' using errcode = '42501'");
      // And it sits after the insert it judges, which is the only place it can
      // read the minted bucket_id/object_name from.
      expect(definition.indexOf("returning * into inserted;")).toBeLessThan(gateAt);
    }
    // The task registration also publishes a chapter-visible activity row; the
    // gate must precede it, not merely precede the return.
    const task = body("public.register_chapter_task_file");
    expect(task.indexOf(GATE)).toBeLessThan(task.indexOf("public.chapter_task_activity"));
  });

  it("leaves the pre-scan write path and the form registration ungated", () => {
    // Gating these would make it impossible to upload the bytes that need
    // scanning, or would break the form path outright: their rows stay
    // invisible until the gated confirm_* runs.
    for (const rpc of UNGATED) {
      expect(body(rpc), `${rpc} must stay ungated`).not.toContain("private.private_upload_is_current");
    }
  });

  it("keeps every grant and every earlier error shape", () => {
    // A revoke would refuse service-role callers too and would change the
    // error a stale client sees. The whole change is a runtime gate.
    expect(code).not.toMatch(/\b(grant|revoke)\b/i);
    expect(code).not.toMatch(/\bdrop\s+function\b/i);
    expect(code).not.toMatch(/\balter\s+function\b/i);
    for (const rpc of [...GATED, ...UNGATED]) {
      const definition = body(rpc);
      expect(definition, `${rpc} keeps its definer/search_path pin`).toContain("security definer");
      expect(definition).toContain("set search_path = ''");
      expect(definition).toContain("raise exception 'authentication required' using errcode = '42501'");
      expect(definition).toContain("file name must be 1-160 characters without path separators");
      expect(definition).toContain("file must be between 1 byte and 10 MB");
      expect(definition).toContain("file type is not accepted");
    }
  });

  it("removes image/heic from all five per-call MIME allowlists and nothing else", () => {
    expect(code).not.toContain("image/heic");
    for (const rpc of [...GATED, ...UNGATED]) {
      const definition = body(rpc);
      for (const type of [
        "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ]) {
        expect(definition, `${rpc} must keep ${type}`).toContain(`'${type}'`);
      }
    }
  });

  it("re-pins every replaced function in the database contract", () => {
    for (const rpc of [...GATED, ...UNGATED]) {
      const entry = contract.functions.find((candidate) => candidate.sig.startsWith(`${rpc}(`));
      expect(entry, `${rpc} must stay contracted`).toBeTruthy();
      expect(entry.secdef).toBe(true);
      expect(entry.bodyMd5, `${rpc} md5 must be refreshed from the live database`).toMatch(/^[0-9a-f]{32}$/);
      expect(entry.bodyForbids).toContain("image/heic");
      expect(entry.exec).toContain("authenticated");
    }
    for (const rpc of GATED) {
      const entry = contract.functions.find((candidate) => candidate.sig.startsWith(`${rpc}(`));
      expect(entry.bodyContains).toContain("private.private_upload_is_current(inserted.bucket_id, inserted.object_name)");
    }
  });
});
