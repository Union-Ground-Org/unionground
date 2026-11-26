// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins for 20260906010000. The live-database twin of these assertions is
// `npm run verify:db`; this file is what keeps the intent readable and what
// fails first when someone reintroduces the parallel write path.
const NAME = "20260906010000_private_upload_write_path_hardening";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const PRIVATE_BUCKETS = ["case-files", "chapter-task-files", "member-form-files", "organization-knowledge"];

// Every RPC that mints an object name and states its own per-call MIME
// allowlist. Decision E2 is a policy about accepted types, so it has to hold at
// both boundaries: the bucket allowlist this migration narrowed AND the RPC
// allowlist a caller is told the answer by. They disagreed for three
// migrations, which was fail-closed but dishonest — the RPC accepted the type,
// minted a row and an object name, and Storage then refused the bytes with an
// unrelated error.
const REGISTRATION_RPCS = [
  "public.register_member_case_file",
  "public.register_chapter_task_file",
  "public.register_member_form_file",
  "public.begin_member_case_file_upload",
  "public.begin_chapter_task_file_upload",
];

// The last migration that declares `name`. migrationFiles() is filename-sorted,
// which is the order Postgres applies them in, so the last declaration is the
// live one — pinning the first would keep a superseded generation green while
// the database moved on.
function latestDeclaration(name) {
  const declaring = migrationFiles().filter((entry) => entry.sql.includes(`function ${name}(`));
  expect(declaring.length, `${name} must be declared by some migration`).toBeGreaterThan(0);
  const latest = declaring.at(-1);
  return { name: latest.name, body: stripComments(fnBody(latest.sql, name)) };
}

describe("private upload write-path hardening migration", () => {
  it("runs as one forward-only transaction after the authorization migration", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    const names = migrationNames();
    expect(names.indexOf(`${NAME}.sql`))
      .toBeGreaterThan(names.indexOf("20260905034500_private_upload_inspection_authorization.sql"));
  });

  it("drops the public path-addressed verdict wrapper with its exact signature", () => {
    // Spelled with the canonical type names Postgres reports, so the drop the
    // contract blames for the absence is textually the signature it names.
    expect(code.replace(/\s+/g, " ")).toContain(
      "drop function if exists public.record_private_upload_scan(text, text, uuid, text, text, text,"
      + " text, bigint, timestamp with time zone, timestamp with time zone);",
    );
  });

  it("leaves the private implementation and its service-only grant untouched", () => {
    // The verdict writer itself is not the hazard; a public, path-addressed
    // entrypoint to it was. Recreating or re-granting it here would defeat the
    // whole migration.
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function\s+(public|private)\.record_private_upload_scan/);
    expect(code).not.toMatch(/grant\s+execute\s+on\s+function\s+(public|private)\.record_private_upload_scan/);
    expect(code).not.toMatch(/drop\s+function\s+if\s+exists\s+private\.record_private_upload_scan/);

    const quarantine = stripComments(loadMigrationSql("20260905021500_private_upload_quarantine"));
    expect(quarantine).toContain(
      "revoke all on function private.record_private_upload_scan(text,text,uuid,text,text,text,text,bigint,timestamptz,timestamptz)\n  from public, anon, authenticated, service_role",
    );
    expect(quarantine).toContain(
      "grant execute on function private.record_private_upload_scan(text,text,uuid,text,text,text,text,bigint,timestamptz,timestamptz)\n  to service_role",
    );
  });

  it("removes image/heic from every private bucket allowlist and keeps the supported types", () => {
    const update = code.slice(code.indexOf("update storage.buckets"));
    expect(update).toContain("update storage.buckets set allowed_mime_types");
    expect(update).not.toContain("image/heic");
    for (const type of [
      "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]) {
      expect(update, `${type} must stay accepted`).toContain(`'${type}'`);
    }
    for (const bucket of PRIVATE_BUCKETS) {
      expect(update, `${bucket} must be re-declared`).toContain(`'${bucket}'`);
    }
    // The inspector permanently refuses HEIC, so accepting it would only mint
    // objects that can never earn a clean verdict.
    expect(code).not.toContain("image/heic");
  });

  it("leaves no registration RPC advertising a type the buckets refuse", () => {
    for (const rpc of REGISTRATION_RPCS) {
      const { name, body } = latestDeclaration(rpc);
      expect(body, `${rpc} (last declared in ${name}) must not admit image/heic`).not.toContain("image/heic");
      // Narrowing, not breaking: the types both boundaries accept stay.
      expect(body, `${rpc} keeps the supported types`).toContain("image/jpeg");
      expect(body, `${rpc} keeps the supported types`).toContain("application/pdf");
    }
    const contracted = contract.functions.filter((entry) => REGISTRATION_RPCS.some((rpc) => entry.sig.startsWith(`${rpc}(`)));
    expect(contracted).toHaveLength(REGISTRATION_RPCS.length);
    for (const entry of contracted) {
      expect(entry.bodyForbids, `${entry.sig} must pin the narrowing against drift`).toContain("image/heic");
      expect(entry.bodyMd5, `${entry.sig} must pin its whole live definition`).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("states the real control on the private verdict writer, not a schema-isolation claim", () => {
    // `authenticated` holds USAGE on schema private — the mfa_assurance
    // restrictive policy needs it — so the EXECUTE grant is the entire control,
    // and a header that claimed otherwise invited a future reviewer to relax
    // the grant on the strength of a second layer that does not exist.
    expect(sql).not.toContain("no schema USAGE granted to any client role");
    expect(sql).toContain("`authenticated` does hold USAGE on schema private");
    expect(sql).toContain("Do not relax it.");

    const implementation = contract.functions.find((entry) => entry.sig.startsWith("private.record_private_upload_scan("));
    expect(implementation.exec, "the EXECUTE grant is the control, so it is pinned exactly").toBe("service_role");
    const usage = contract.schemaUsage.find((entry) => entry.schema === "private" && entry.role === "authenticated");
    expect(usage?.usage, "the comment must describe the USAGE the contract records").toBe(true);
  });

  it("removes the dropped wrapper from the database contract and records why", () => {
    const live = contract.functions.filter((entry) => entry.sig.startsWith("public.record_private_upload_scan("));
    expect(live, "the dropped wrapper must not stay pinned as live").toEqual([]);

    const absent = contract.functionsAbsent.find((entry) => entry.sig.startsWith("public.record_private_upload_scan("));
    expect(absent, "the drop must be recorded so verify:db proves it stays gone").toBeTruthy();
    expect(absent.droppedBy).toBe(NAME);
    expect(absent.note).toMatch(/service-role/i);

    // The private implementation stays contracted, service-role only.
    const implementation = contract.functions.find((entry) => entry.sig.startsWith("private.record_private_upload_scan("));
    expect(implementation).toBeTruthy();
    expect(implementation.exec).toBe("service_role");
    expect(implementation.secdef).toBe(true);

    // And the only remaining route to it is the attempt-bound completion RPC.
    const finish = contract.functions.find((entry) => entry.sig.startsWith("public.finish_private_upload_inspection("));
    expect(finish.exec).toBe("service_role");
    expect(finish.bodyContains).toContain("private.record_private_upload_scan");
  });
});
