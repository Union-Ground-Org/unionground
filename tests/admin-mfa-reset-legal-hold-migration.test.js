// @vitest-environment node
//
// REQ-UG-DORMANT-62-ADMIN-MFA-RESET-LEGAL-HOLD-20260917 — offline pins for
// 20260917120000_admin_mfa_reset_notice_and_legal_hold_surface.sql.
//
// What these prove is what a text diff can prove: that the dormant
// authorization-only RPC remains side-effect free, that the security-critical
// self-reset refusal survives in the RPC that replaced it, and that the four
// new functions follow the house conventions. Behaviour against a live
// catalogue is tests/admin-mfa-reset-legal-hold-db.test.js.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";
import { LEGAL_HOLD_REASONS } from "../src/features/messaging/index.js";

// Anchored to this module, not to the working directory: vitest may be invoked
// from a subdirectory with --root, and tests/helpers/migration.js says as much.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MIGRATION = "20260917120000_admin_mfa_reset_notice_and_legal_hold_surface.sql";
const migrations = migrationFiles();
const entry = migrations.find((file) => file.name === MIGRATION);
const sql = stripComments(entry.sql);
const lower = sql.toLowerCase();

function latestFunction(signature) {
  const migration = [...migrations].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${signature.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return { name: migration.name, body: stripComments(fnBody(migration.sql, signature)) };
}

// [declared name, EXECUTE signature as the grant statements spell it]
const NEW_FUNCTIONS = [
  ["public.notify_member_mfa_reset", "public.notify_member_mfa_reset(uuid)"],
  ["public.get_member_conversation_legal_holds", "public.get_member_conversation_legal_holds(uuid[])"],
  ["public.list_member_message_legal_holds", "public.list_member_message_legal_holds()"],
  ["public.list_legal_hold_conversations", "public.list_legal_hold_conversations(text, integer)"],
];

describe("MFA authorization and durable reset boundary", () => {
  it("keeps authorization side-effect free and refuses self-reset", () => {
    expect(lower).not.toContain("drop function if exists public.authorize_mfa_reset");
    const { body } = latestFunction("public.authorize_mfa_reset(p_user_id uuid)");
    expect(body).toContain("p_user_id = caller");
    expect(body).not.toMatch(/\b(insert into|update public|delete from)\b/);
    const route = readFileSync(resolve(repoRoot, "api/admin-mfa-reset.js"), "utf8");
    // Prove both call sites exist before comparing them: a bare indexOf compare
    // reads a deleted authorization call (-1) as "ordered first".
    const authorizeAt = route.indexOf('"authorize_mfa_reset"');
    const beginAt = route.indexOf('"begin_mfa_reset"');
    expect(authorizeAt, "the endpoint no longer calls authorize_mfa_reset").toBeGreaterThan(-1);
    expect(beginAt, "the endpoint no longer calls begin_mfa_reset").toBeGreaterThan(-1);
    expect(authorizeAt).toBeLessThan(beginAt);
  });

  it("preserves the self-reset refusal in the RPC the endpoint actually calls", () => {
    // Break caught: relaxing `p_user_id = caller` in begin_mfa_reset hands a
    // thief of an admin password a one-call MFA bypass. The refusal must be an
    // exception (not a silent no-op) and must carry the privilege errcode so
    // the endpoint's flat 403 covers it.
    const { body } = latestFunction("public.begin_mfa_reset(p_user_id uuid)");
    expect(body).toMatch(/if\s+p_user_id\s*=\s*caller\s+then\s+raise\s+exception\s+'an admin cannot reset their own second factor'\s+using\s+errcode\s*=\s*'42501'/i);
    // ...and it fires before the reset boundary is written.
    expect(body.indexOf("p_user_id = caller")).toBeLessThan(body.indexOf("insert into private.member_mfa_reset_boundaries"));
  });

  it("keeps the endpoint's own self-target refusal ahead of every provider call", () => {
    const route = readFileSync(resolve(repoRoot, "api/admin-mfa-reset.js"), "utf8");
    const guard = route.indexOf("tokenSubject(token)");
    const firstCall = route.indexOf('"begin_mfa_reset"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstCall);
    expect(route).toContain('json(response, 403, { error: "not-permitted" })');
  });
});

describe("house conventions on the four new functions", () => {
  it.each(NEW_FUNCTIONS)("%s is a definer with an empty search_path", (name) => {
    const declared = stripComments(fnBody(entry.sql, name)).toLowerCase();
    expect(declared.startsWith("create function "), `${name} is created, not replaced`).toBe(true);
    const declaration = declared.slice(0, declared.indexOf("as $function$"));
    expect(declaration).toContain("security definer");
    expect(declaration).toContain("set search_path = ''");
  });

  it.each(NEW_FUNCTIONS)("%s revokes PUBLIC/anon/authenticated/service_role and grants exactly authenticated", (_, signature) => {
    const escaped = signature.replace(/[()[\]]/g, "\\$&");
    expect(lower).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${escaped}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role\\s*;`, "i"));
    expect(lower).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${escaped}\\s+to\\s+authenticated\\s*;`, "i"));
    expect(lower).not.toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${escaped}\\s+to\\s+[^;]*(service_role|anon)`, "i"));
  });

  it("gates every new function on member_has_role, which ANDs the MFA assurance predicate", () => {
    for (const [name] of NEW_FUNCTIONS) {
      const body = stripComments(fnBody(entry.sql, name));
      expect(body, name).toContain("public.member_has_role(array[");
    }
  });
});

describe("notify_member_mfa_reset", () => {
  const body = stripComments(fnBody(entry.sql, "public.notify_member_mfa_reset"));

  it("enters the case-graph gate first, before any declaration initializer", () => {
    // scripts/account-case-graph-inventory.mjs requires this of every writer
    // to a graph relation; member_notifications is one.
    const plpgsql = body.slice(body.indexOf("$function$") + "$function$".length);
    expect(plpgsql).toMatch(/^\s*declare[\s\S]*?begin\s+perform\s+private\.lock_case_graph\(array\[auth\.uid\(\)\],\s*array\[\]::uuid\[\]\);/i);
    expect(plpgsql).not.toMatch(/^\s*declare[\s\S]*?(:=|\bdefault\b)[\s\S]*?\bbegin\b/i);
  });

  it("refuses non-admins and a self-target with the same flat errcode", () => {
    expect(body).toContain("not public.member_has_role(array['admin'])");
    expect(body).toMatch(/if\s+p_user_id\s+is\s+null\s+or\s+p_user_id\s*=\s*caller\s+then\s+raise\s+exception\s+'invalid target'\s+using\s+errcode\s*=\s*'42501'/i);
  });

  it("resolves the member inside the admin's own organization, like authorize_mfa_reset", () => {
    // Break caught: record_mfa_reset (Main) accepts any auth.users id, so a
    // language lookup without the tenant predicate lets an administrator of
    // organization A write this notice into an organization-B member's inbox.
    expect(body).toMatch(/from\s+public\.member_profiles\s+p\s+join\s+public\.chapters\s+c\s+on\s+c\.id\s*=\s*p\.chapter_id\s+where\s+p\.id\s*=\s*p_user_id\s+and\s+c\.organization_id\s*=\s*private\.current_member_organization\(\)/);
  });

  it("is bound to a reset this admin recorded for this member and writes one localized notice", () => {
    expect(body).toContain("a.actor = caller");
    expect(body).toContain("a.target_user = p_user_id");
    expect(body).toContain("a.action = 'reset_mfa'");
    expect(body).toContain("interval '15 minutes'");
    expect(body).toContain("insert into public.member_notifications (user_id, title, body, kind)");
    expect(body).toContain("'general'");
    expect(body).toContain("'Two-step sign-in was reset by an administrator'");
    expect(body).toContain("'Un administrador restableció la verificación en dos pasos'");
    // Dedup window is anchored on the recorded reset, not on the clock.
    expect(body).toContain("n.created_at >= recorded_at");
    // The notice never restates who did it or any secret.
    expect(body).not.toMatch(/caller::text/);
  });
});

describe("legal hold read surface", () => {
  it("discloses status only inside the steward visibility set and the reason only to an admin", () => {
    const body = stripComments(fnBody(entry.sql, "public.get_member_conversation_legal_holds"));
    expect(body).toContain("public.member_has_role(array['steward', 'coordinator', 'admin'])");
    expect(body).toContain("v.user_id in (select private.staff_visible_member_ids('steward'))");
    expect(body).toContain("h.released_at is null");
    expect(body).toMatch(/case when is_admin then h\.reason_code end/);
    expect(body).toMatch(/case when is_admin then h\.placed_at end/);
    expect(body).toContain("pg_catalog.cardinality(p_conversation_ids) > 100");
    // Read-only: no acquisitions, no DML.
    expect(body).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(body).not.toMatch(/\bfor\s+(update|share|key share|no key update)\b/i);
  });

  it("lists active holds only for an organization admin inside their own tenant", () => {
    const body = stripComments(fnBody(entry.sql, "public.list_member_message_legal_holds"));
    expect(body).toContain("public.member_has_role(array['admin'])");
    expect(body).toContain("private.current_member_organization()");
    expect(body).toContain("h.organization_id = org");
    expect(body).toContain("h.released_at is null");
    expect(body).toContain("limit 100");
    // Never message content.
    expect(body).not.toMatch(/member_messages\b/);
    expect(body).not.toMatch(/\bbody\b/);
  });

  it("offers the clients exactly the reason codes the table's CHECK constraint accepts", () => {
    const lifecycle = migrations.find((file) => file.name === "20260907121000_member_message_body_lifecycle.sql");
    const table = stripComments(lifecycle.sql);
    const start = table.indexOf("create table public.member_message_legal_holds");
    const check = table.slice(start, table.indexOf(");", start));
    const constraint = check.slice(check.indexOf("reason_code text"), check.indexOf("))", check.indexOf("reason_code text")));
    expect([...constraint.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort()).toEqual([...LEGAL_HOLD_REASONS].sort());
  });
});

describe("the retention engine still refuses held conversations", () => {
  // The record asked whether the engine already checks the hold table. It
  // does, in every generation since 20260907121000; these pins keep a later
  // re-declaration from dropping the term.
  it.each([
    "private.retention_eligible_count",
    "private.perform_organization_retention_run",
  ])("%s excludes held conversations from both durable copies", (name) => {
    const { body } = latestFunction(name);
    // Delivered rows (m) and never-dispatched scheduled copies (s) alike.
    expect(body).toContain("not private.member_message_under_legal_hold(m.conversation_id)");
    expect(body).toContain("not private.member_message_under_legal_hold(s.conversation_id)");
  });
});
