// @vitest-environment node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { rlsTableCountRestatements } from "./helpers/rls-table-count-restatements.mjs";
import { readRlsTableInventory } from "../scripts/lib/db-contract-tables.mjs";
import { canonicaliseCatalogSql } from "../scripts/lib/sql-text.mjs";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";
import { DENIED_SUPABASE_REFS } from "./helpers/denied-identity-fixtures.js";

// Offline anti-rot guards for scripts/db-contract.json.
//
// The contract itself is only meaningful against a live database, and CI does
// not always have one. That would make it exactly the kind of artefact that
// quietly stops being true: a migration adds a function grant or a policy, the
// contract never learns about it, and `npm run verify:db` keeps reporting PASS
// on a shrinking subset of reality.
//
// These tests need no database. They read supabase/migrations/*.sql the same
// way the rest of the suite does and assert that the contract has an OPINION
// about every grant and every policy the migrations create — present, or
// explicitly recorded as dropped. They cannot tell you the opinion is correct.
// That is what verify:db is for.
const migrations = migrationFiles();

// Comments in these files legitimately quote statements they are explaining
// ("-- we deliberately do NOT grant execute on ... to anon"). Every scan below
// runs against executable SQL only.
const code = migrations.map((entry) => ({ name: entry.name, sql: stripComments(entry.sql) }));

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const verifierSrc = readFileSync(new URL("../scripts/verify-db-contract.mjs", import.meta.url), "utf8");

// Postgres reports identity arguments with parameter names and canonical type
// spellings; migrations write grants with types only and the short aliases.
// Reduce both to the same key: schema.name(type, type).
const TYPE_ALIASES = {
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  bool: "boolean",
  varchar: "character varying",
  // The live catalog renders the installed pgvector type without its schema.
  "extensions.vector": "vector",
};

function canonicalType(raw) {
  const type = raw.trim().replace(/\s+/g, " ").toLowerCase();
  const suffix = type.endsWith("[]") ? "[]" : "";
  let base = suffix ? type.slice(0, -2) : type;
  // to_regprocedure treats `public.chapter_spaces` and `chapter_spaces` as the
  // same type, and the live sweep renders identity arguments unqualified; a
  // migration that spells the schema out must reduce to the same key.
  base = base.replace(/^public\./, "");
  return (TYPE_ALIASES[base] || base) + suffix;
}

function signatureKey(signature) {
  const open = signature.indexOf("(");
  const name = signature.slice(0, open).trim().toLowerCase();
  const args = signature.slice(open + 1, signature.lastIndexOf(")")).trim();
  if (!args) return `${name}()`;
  const types = args.split(",").map((arg) => {
    // "p_form_id uuid" -> "uuid"; row alias "a member_kb_articles"
    // also drops its parameter name; a bare "uuid" is left alone.
    // CREATE declarations can add DEFAULT clauses that are not part of the
    // function identity; DROP/GRANT signatures never carry them.
    const identityArg = arg.trim().replace(/\s+default\s+.*$/i, "").replace(/\s*=\s*.*$/, "");
    const parts = identityArg.split(/\s+/);
    return canonicalType(parts.length > 1 && /^(?:p_[a-z0-9_]+|a)$/.test(parts[0]) ? parts.slice(1).join(" ") : identityArg);
  });
  return `${name}(${types.join(", ")})`;
}

const contractedFunctions = new Set(contract.functions.map((entry) => signatureKey(entry.sig)));
const absentFunctions = new Set(contract.functionsAbsent.map((entry) => signatureKey(entry.sig)));

// Union Ground decision, 2026-10-15: both dispatch setup functions only ever
// accepted the sibling product's dispatcher, so the final migration replaces
// them with a named refusal. The historical bodies stay in their migrations;
// what is installed, and what the contract pins, is the refusal.
describe("dispatch setup functions cannot wire this database to the sibling product", () => {
  const neutralizing = "20261015120000_unionground_sibling_dispatch_neutralized.sql";
  const sql = stripComments(loadMigrationSql(neutralizing));
  const setups = [
    ["public.configure_notification_dispatch", "public.configure_notification_dispatch(p_dispatch_url text, p_dispatch_secret text)", "notification dispatch has no Union Ground endpoint to configure", "(text, text)"],
    ["public.configure_integration_webhook_dispatch", "public.configure_integration_webhook_dispatch(p_dispatch_url text, p_cron_secret text)", "integration webhook dispatch has no Union Ground endpoint to configure", "(text, text)"],
  ];

  // 20261019212500 re-creates both refusals with their arguments discarded
  // (written out literally); it is the last definition and is still the refusal.
  const assurance = "20261019212500_db_assurance_unused_values.sql";
  const lastSql = stripComments(loadMigrationSql(assurance));

  it("installs a refusal as the last definition, before any Vault or control-row write", () => {
    for (const [name, , refusal] of setups) {
      const definers = code.filter((entry) => new RegExp(`create (?:or replace )?function ${name.replace(".", "\\.")}\\(`).test(entry.sql));
      expect(definers.map((entry) => entry.name).slice(-2)).toEqual([neutralizing, assurance]);
      for (const body of [fnBody(sql, name), fnBody(lastSql, name)]) {
        expect(body).toContain(`raise exception '${refusal}'`);
        expect(body).toContain("errcode = '55000'");
        for (const mutation of ["vault.", "notification_controls", "integration_webhook_dispatch_controls", "https://"]) {
          expect(body).not.toContain(mutation);
        }
      }
    }
  });

  it("keeps the service-role-only grant so a caller gets the named refusal", () => {
    for (const [name, sig, , args] of setups) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry.exec).toBe("service_role");
      expect(sql).toContain(`revoke all on function ${name}${args}\n  from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant execute on function ${name}${args} to service_role;`);
    }
  });

  it("pins the refusal in the live contract and clears both control rows", () => {
    for (const [, sig, refusal] of setups) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry.bodyContains).toEqual([refusal, "errcode = '55000'"]);
      expect(siblingIdentityIn(JSON.stringify(entry))).toEqual([]);
    }
    expect(sql).toMatch(/update private\.integration_webhook_dispatch_controls\s+set dispatch_url = null/);
    expect(sql).toMatch(/update private\.notification_controls\s+set dispatch_url = null, files_reconcile_url = null/);
  });
});

describe("db-contract.json is a well-formed contract", () => {
  it("matches pgvector grants to catalog identity without aliasing another schema", () => {
    const catalog = "public.search_member_kb_hybrid(p_query text, p_embedding vector, p_limit integer)";
    expect(signatureKey("public.search_member_kb_hybrid(text, extensions.vector, integer)"))
      .toBe(signatureKey(catalog));
    expect(signatureKey("public.search_member_kb_hybrid(text, private.vector, integer)"))
      .not.toBe(signatureKey(catalog));
  });

  it("matches named row arguments to their type-only grant signatures", () => {
    expect(signatureKey("private.compass_article_classification_current(a member_kb_articles)"))
      .toBe(signatureKey("private.compass_article_classification_current(public.member_kb_articles)"));
    expect(signatureKey("private.compass_article_classification_current(a private.member_kb_articles)"))
      .not.toBe(signatureKey("private.compass_article_classification_current(public.member_kb_articles)"));
  });

  it("declares every section verify-db-contract.mjs reads", () => {
    for (const section of [
      "target", "functionDefaults", "functions", "functionsAbsent", "functionSweeps", "schemaUsage",
      "policyCoverage", "policies", "policiesForbidden", "tableGrants", "columnGrants",
      "constraints", "constraintsAbsent", "indexes", "triggers", "publication", "cron",
      "controlPlane", "knownGaps",
    ]) {
      expect(contract, `missing section: ${section}`).toHaveProperty(section);
    }
    expect(Object.prototype.hasOwnProperty.call(contract.target, "projectRef")).toBe(true);
    expect(Array.isArray(contract.target.forbiddenProjectRefSha256)).toBe(true);
  });

  it("gives every function entry a signature, a definer flag and an EXECUTE grantee list", () => {
    for (const entry of contract.functions) {
      // Lowercase snake_case, digits allowed after the first letter (the _v2
      // reservation RPC is the first digit-bearing name in the contract).
      expect(entry.sig, "signature must be schema-qualified").toMatch(/^(public|private)\.[a-z][a-z0-9_]*\(.*\)$/);
      expect(typeof entry.secdef, `${entry.sig} secdef`).toBe("boolean");
      expect(typeof entry.exec, `${entry.sig} exec`).toBe("string");
      if (Object.hasOwn(entry, "volatility")) expect(["v", "s", "i"], `${entry.sig} volatility`).toContain(entry.volatility);
      for (const role of entry.exec.split(",").filter(Boolean)) {
        expect(["anon", "authenticated", "public", "service_role"], `${entry.sig} grantee`).toContain(role);
      }
    }
    // Duplicate signatures would make one of the two entries unreachable.
    expect(new Set(contract.functions.map((entry) => entry.sig)).size).toBe(contract.functions.length);
  });

  it("gives every policy entry a table, a name, a command and a role list", () => {
    for (const entry of contract.policies) {
      expect(entry.table, `${entry.name} table`).toBeTruthy();
      expect(["r", "a", "w", "d", "*"], `${entry.name} cmd`).toContain(entry.cmd);
      expect(entry.roles, `${entry.name} roles`).toBeTruthy();
    }
    expect(new Set(contract.policies.map((entry) => `${entry.table}.${entry.name}`)).size).toBe(contract.policies.length);
  });

  it("keys every table and column grant pin once, because the verifier resolves them with .find()", () => {
    //  review: a duplicated {table, role} row is resolved to the first
    // match, so a wrong pin could hide behind a correct one. The cardinality
    // pin in reftrigger-maintain-revoke.test.js only catches it by accident.
    expect(new Set(contract.tableGrants.map((entry) => `${entry.table}|${entry.role}`)).size)
      .toBe(contract.tableGrants.length);
    expect(new Set(contract.columnGrants.map((entry) => `${entry.table}|${entry.role}|${entry.privilege}`)).size)
      .toBe(contract.columnGrants.length);
    expect(verifierSrc).toContain("const duplicatePins = duplicateGrantPins(contract);");
    expect(verifierSrc).toContain('check("tableGrants {table, role} keys are unique"');
    expect(verifierSrc).toContain('check("columnGrants {table, role, privilege} keys are unique"');
  });

  it("pins the table-wide service-role SELECT used by founder invitation delivery", () => {
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: "public.organizations", role: "service_role", privileges: "MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE",
    }));
    expect(contract.columnGrants.some((entry) => entry.table === "public.organizations"
      && entry.role === "service_role")).toBe(false);
    const sql = stripComments(loadMigrationSql("20261023050341_founder_invitation_organization_name_grant.sql"));
    expect(sql).toMatch(/grant\s+select\s+on\s+table\s+public\.organizations\s+to\s+service_role\s*;/i);
  });

  it("pins every listed high-risk policy expression exactly so an added OR cannot hide", () => {
    const exactQual = [
      "chapters.chapters_select_all",
      "member_broadcasts.member_broadcasts_read_authenticated",
      "member_events.member_events_select_scoped",
      // PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028: the
      // former chapter_records_read_chapter OR chapter_records_read_staff.
      "chapter_records.chapter_records_select",
      "organizations.organizations_select_member",
      "organization_memberships.organization_memberships_select_visible",
      "organization_role_grants.organization_role_grants_select_visible",
      "organization_audit_events.organization_audit_events_select_admin",
      "member_reward_grants.member_reward_grants_select_own",
    ];
    const exactWithCheck = [
      "member_broadcast_receipts.member_broadcast_receipts_insert_own",
    ];
    const byKey = new Map(contract.policies.map((entry) => [`${entry.table}.${entry.name}`, entry]));
    for (const key of exactQual) {
      const entry = byKey.get(key);
      expect(entry?.qual, `${key} exact qual`).toBeTruthy();
      expect(entry?.qualContains, `${key} must not use substring-only qual`).toBeUndefined();
      expect(canonicaliseCatalogSql(`${entry.qual} OR true`)).not.toBe(canonicaliseCatalogSql(entry.qual));
    }
    for (const key of exactWithCheck) {
      const entry = byKey.get(key);
      expect(entry?.withCheck, `${key} exact with_check`).toBeTruthy();
      expect(entry?.withCheckContains, `${key} must not use substring-only with_check`).toBeUndefined();
      expect(canonicaliseCatalogSql(`${entry.withCheck} OR true`)).not.toBe(
        canonicaliseCatalogSql(entry.withCheck),
      );
    }
    expect(verifierSrc).toContain("policy ${key} with_check");
    expect(verifierSrc).toContain("canonicaliseCatalogSql(entry.withCheck)");
  });

  it("never lists the same signature as both live and absent", () => {
    const overlap = [...absentFunctions].filter((sig) => contractedFunctions.has(sig));
    expect(overlap, "a signature cannot be contracted and dropped at the same time").toEqual([]);
  });

  it("marks every knownGap function in the functions list, and never contradicts tableGrants", () => {
    for (const sig of contract.knownGaps.publicExecuteOnPrivateFunctions.entries) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry, `${sig} must still have a functions[] entry`).toBeTruthy();
      expect(entry.exec, `${sig} is recorded as a PUBLIC-execute gap`).toContain("public");
      expect(entry.gap).toBe("publicExecuteOnPrivateFunction");
    }
    // A table cannot simultaneously be contracted as "SELECT only" and recorded
    // as a surplus-grant gap; that would make one of the two checks a lie.
    for (const gap of contract.knownGaps.surplusClientTableGrants.entries) {
      const contracted = contract.tableGrants.find((entry) => entry.table === `public.${gap.table}` && entry.role === gap.role);
      expect(contracted, `public.${gap.table} → ${gap.role} is both contracted and recorded as a gap`).toBeUndefined();
    }
  });

  // Added by SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904 after a live apply
  // caught it. verify-db-contract.mjs projects pg_indexes as
  //   case when schemaname = 'public' then tablename
  //        else schemaname || '.' || tablename end
  // so a public index's `table` is the BARE relation name and only a non-public
  // schema is qualified. Writing "public.member_messages" produced a mismatch
  // that no offline pin could see, because the contract is only meaningful
  // against a database. The projection is read out of the verifier's own source
  // here rather than restated, so the convention cannot drift on one side only.
  it("spells every index table the way the verifier projects it", () => {
    expect(
      verifierSrc,
      "the verifier must still strip the public schema from an index's table name",
    ).toContain("case when schemaname = 'public' then tablename else schemaname || '.' || tablename end as tbl");
    for (const entry of contract.indexes) {
      expect(entry.table, `index ${entry.name} needs a table`).toBeTruthy();
      expect(
        entry.table,
        `index ${entry.name}: a public table is projected bare, so "${entry.table}" can never match`,
      ).not.toMatch(/^public\./);
      const schema = entry.table.includes(".") ? entry.table.split(".")[0] : "public";
      expect(["public", "private"], `index ${entry.name} is outside the verifier's schema scope`).toContain(schema);
    }
  });
});

// Every private table the migrations leave standing, keyed by the migration
// that last created it.
//
// authenticated holds USAGE on schema private (see schemaUsage — the
// mfa_assurance policy needs it), so `grant select on private.<secret-table>
// to authenticated` is reachable SQL even though PostgREST never exposes the
// schema. A private table WITH a tableGrants pin fails verify:db on the
// exact-privilege assertion the moment such a grant lands. A private table
// WITHOUT one is caught by nothing in the lane that gates merges: the surplus
// client-grant sweep in verify-db-contract.mjs is filtered to
// nspname = 'public' and never sees a private relation at all, and the
// unbounded vendor-schema sweep that would is skipped under the
// disposable-application profile CI sets for verify:db. So the pin below is
// the load-bearing half — it makes the contract have an OPINION about every
// private table, and the exact-privilege assertion supplies the teeth.
const PRIVATE_GRANTEE_ROLES = ["anon", "authenticated", "service_role"];

const standingPrivateTables = (() => {
  const live = new Map();
  for (const { name, sql } of code) {
    const events = [];
    // `unlogged` is tolerated though no migration uses it yet; a silently
    // unmatched create is exactly the hole this pin exists to close.
    for (const match of sql.matchAll(/create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?private\.([a-z0-9_]+)/gi)) {
      events.push({ at: match.index, table: match[1].toLowerCase(), kind: "create" });
    }
    for (const match of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?private\.([a-z0-9_]+)/gi)) {
      events.push({ at: match.index, table: match[1].toLowerCase(), kind: "drop" });
    }
    // The seed migrations drop and re-create the same ledger inside one file,
    // so only the last event in file order decides whether it is standing.
    for (const event of events.sort((left, right) => left.at - right.at)) {
      if (event.kind === "create") live.set(event.table, name);
      else live.delete(event.table);
    }
  }
  return live;
})();

describe("the contract stays in lockstep with the migrations", () => {
  it("pins the membership projection EXECUTE grant to the final migration", () => {
    const signature = "public.get_my_chapter_memberships()";
    const entry = contract.functions.find((candidate) => candidate.sig === signature);
    const finalMigration = code.find(({ name }) => name.includes("20260826155000_mi1_append_only_review_repairs"));

    expect(entry?.exec, `${signature} exact EXECUTE grantees`).toBe("authenticated");
    expect(finalMigration, "final membership projection migration").toBeTruthy();
    expect(finalMigration.sql).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.get_my_chapter_memberships\(\)\s+from\s+public,\s*anon,\s*authenticated,\s*service_role\s*;/i,
    );
    expect(finalMigration.sql).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.get_my_chapter_memberships\(\)\s+to\s+authenticated\s*;/i,
    );
    expect(finalMigration.sql).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.get_my_chapter_memberships\(\)\s+to\s+[^;]*service_role/i,
    );
  });

  it("has an entry for every function the migrations grant EXECUTE on", () => {
    // Without this, a migration can add a brand new definer RPC, grant it to
    // authenticated, and verify:db will never look at it.
    const granted = new Map();
    for (const { name, sql } of code) {
      // Name classes match the sig-format guard above: digits allowed after
      // the first letter, or a digit-named RPC's grant (reserve_…_v2) would
      // silently escape this scan while passing the format check.
      for (const match of sql.matchAll(/grant\s+execute\s+on\s+function\s+([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\s*\([^)]*\))\s+to\s+([a-z_,\s]+)/gi)) {
        granted.set(signatureKey(match[1].replace(/\s+/g, " ")), name);
      }
    }
    expect(granted.size, "no grant execute statements were parsed — the scan regex has rotted").toBeGreaterThan(50);

    const unaccounted = [...granted.entries()]
      .filter(([sig]) => !contractedFunctions.has(sig) && !absentFunctions.has(sig))
      .map(([sig, name]) => `${sig} (granted in ${name})`);
    expect(unaccounted, "add these to functions[] — or to functionsAbsent[] if a later migration dropped them").toEqual([]);
  });

  it("does not leave a contracted function dropped by the final migration event", () => {
    const lastDefinitionEvent = new Map();
    for (const { name, sql } of code) {
      const events = [];
      for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\s*\([^)]*\))/gi)) {
        events.push({ at: match.index, sig: signatureKey(match[1]), kind: "create", name });
      }
      for (const match of sql.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\s*\([^)]*\))/gi)) {
        events.push({ at: match.index, sig: signatureKey(match[1]), kind: "drop", name });
      }
      for (const event of events.sort((left, right) => left.at - right.at)) {
        lastDefinitionEvent.set(event.sig, event);
      }
    }

    const dropped = [...contractedFunctions]
      .map((sig) => lastDefinitionEvent.get(sig))
      .filter((event) => event?.kind === "drop")
      .map((event) => `${event.sig} (dropped in ${event.name})`);
    expect(dropped, "remove dropped signatures from functions[] or restore them in a later migration").toEqual([]);
  });

  it("has an entry for every policy the migrations create and never drop", () => {
    const created = new Map();
    for (const { name, sql } of code) {
      for (const match of sql.matchAll(/create\s+policy\s+([a-z_0-9]+)\s+on\s+(?:([a-z_0-9]+)\.)?([a-z_0-9]+)/gi)) {
        const table = match[2] && match[2].toLowerCase() !== "public"
          ? `${match[2].toLowerCase()}.${match[3].toLowerCase()}`
          : match[3].toLowerCase();
        created.set(`${table}.${match[1].toLowerCase()}`, name);
      }
      for (const match of sql.matchAll(/drop\s+policy\s+(?:if\s+exists\s+)?([a-z_0-9]+)\s+on\s+(?:([a-z_0-9]+)\.)?([a-z_0-9]+)/gi)) {
        const table = match[2] && match[2].toLowerCase() !== "public"
          ? `${match[2].toLowerCase()}.${match[3].toLowerCase()}`
          : match[3].toLowerCase();
        created.delete(`${table}.${match[1].toLowerCase()}`);
      }
      // PostgreSQL removes a table's policies with the table itself. Preserve
      // historical CREATE coverage without demanding retired policy entries.
      for (const match of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:([a-z_0-9]+)\.)?([a-z_0-9]+)\s*;/gi)) {
        const table = match[1] && match[1].toLowerCase() !== "public"
          ? `${match[1].toLowerCase()}.${match[2].toLowerCase()}` : match[2].toLowerCase();
        for (const key of created.keys()) if (key.startsWith(`${table}.`)) created.delete(key);
      }
    }
    expect(created.size, "no create policy statements were parsed — the scan regex has rotted").toBeGreaterThan(30);

    const contracted = new Set(contract.policies.map((entry) => `${entry.table}.${entry.name}`));
    const unaccounted = [...created.entries()]
      // mfa_assurance is applied to every RLS table by a DO loop, so it is
      // contracted once as a coverage sweep rather than 48 times as rows.
      // The demo plane is synthetic, read-only, and covered by that same sweep.
      .filter(([key]) => !key.endsWith(".mfa_assurance") && !key.startsWith("demo_"))
      .filter(([key]) => !contracted.has(key))
      .map(([key, name]) => `${key} (created in ${name})`);
    expect(unaccounted, "add these to policies[] in scripts/db-contract.json").toEqual([]);
  });

  it("blames a real migration that really drops each absent signature", () => {
    for (const entry of contract.functionsAbsent) {
      expect(entry.droppedBy, `${entry.sig} must name the migration that removed it`).toBeTruthy();
      const source = code.find(({ name }) => name.includes(entry.droppedBy));
      expect(source, `${entry.sig} names a migration that is not in the tree: ${entry.droppedBy}`).toBeTruthy();
      // The claim is falsifiable: the named migration has to contain a drop for
      // exactly this signature, not merely exist.
      const signature = signatureKey(entry.sig);
      const dropped = [...source.sql.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?((?:public|private)\.[a-z0-9_]+\([^)]*\))/gi)]
        .some((match) => signatureKey(match[1]) === signature);
      expect(dropped, `${entry.droppedBy} does not drop ${entry.sig}`).toBe(true);
    }
  });

  it("pins anon, authenticated and service_role on every standing private table", () => {
    expect(standingPrivateTables.size, "no create table private.* statements were parsed — the scan regex has rotted")
      .toBeGreaterThan(50);
    const pinned = new Set(contract.tableGrants.map((entry) => `${entry.table}|${entry.role}`));
    const unpinned = [];
    for (const [table, name] of [...standingPrivateTables].sort()) {
      for (const role of PRIVATE_GRANTEE_ROLES) {
        if (!pinned.has(`private.${table}|${role}`)) unpinned.push(`private.${table} → ${role} (created in ${name})`);
      }
    }
    expect(unpinned, 'add these to tableGrants[] in scripts/db-contract.json with privileges "" — an unpinned private table is the one place a client grant can land unseen').toEqual([]);
  });

  it("never pins a private table the migrations dropped, and never widens one past its grants", () => {
    // verify:db resolves every tableGrants key through
    // has_table_privilege(role, tbl, ...), which casts `tbl` to regclass. A pin
    // for a table no migration leaves standing does not fail one check; it
    // aborts the whole verification with an undefined-table error.
    const stray = contract.tableGrants
      .filter((entry) => entry.table.startsWith("private."))
      .filter((entry) => !standingPrivateTables.has(entry.table.slice("private.".length)))
      .map((entry) => `${entry.table} → ${entry.role}`);
    expect(stray, "remove these from tableGrants[]: the table is dropped, renamed, or was never created").toEqual([]);

    // The pins are empty because no migration grants a client role anything
    // inside schema private. Widening one to silence a verify:db failure would
    // ratify the grant instead of reporting it, so the widening has to name a
    // migration that really made it.
    const granted = new Set();
    for (const { sql } of code) {
      for (const match of sql.matchAll(/\bgrant\s+[^;]+?\s+on\s+(?:table\s+)?private\.([a-z0-9_]+)\s+to\s+([a-z_,\s]+)/gi)) {
        for (const role of match[2].split(",")) granted.add(`private.${match[1].toLowerCase()}|${role.trim().toLowerCase()}`);
      }
    }
    const widened = contract.tableGrants
      .filter((entry) => entry.table.startsWith("private.") && entry.privileges !== "")
      .filter((entry) => !granted.has(`${entry.table}|${entry.role}`))
      .map((entry) => `${entry.table} → ${entry.role} = ${entry.privileges}`);
    expect(widened, "no migration grants these; a private pin may only carry privileges a migration really gives").toEqual([]);
  });

  // SYS-UG-DB-CONTRACT-CASEWORK-ALERT-CRON-UNPINNED-20260921. The cron
  // section had the same shape as the grant and policy sections before the
  // scans above existed: verify-db-contract.mjs iterates contract.cron and
  // nothing else, so a job the contract never heard of is invisible to it. The
  // casework alert escalation tick — the only producer of 'alert_escalated',
  // and the CR-027 safety/retaliation path — was unscheduled-able from
  // 20260828210000 without turning verify:db red until
  // OPS-UG-CRON-HEALTH-MIRROR-OMITS-SIX-JOBS-20260921 listed it by hand.
  // The scan below keeps the next such job from needing the same catch.
  //
  // Which schedules belong in the contract is decided structurally, not by
  // name. Every cron.schedule() in supabase/migrations sits inside a
  // dollar-quoted block, and the block says who runs it: a top-level
  // `do $tag$ ... $tag$` runs when the migration is APPLIED, so an ordinary
  // project must carry the job; a `create function ... as $tag$ ... $tag$`
  // body only runs when something calls it, which for the private.demo_seed_*
  // lane means "when an operator seeds a demo project". Pinning a seed-time
  // job would make verify:db fail on every project that is not a demo.
  //
  // Dollar quoting does not nest — once a tag is open only that exact tag
  // closes it — so the $job$-quoted command arguments inside a block are
  // stepped over rather than read as regions of their own.
  function applyTimeSchedules(sql) {
    const tag = /\$[a-z_][a-z0-9_]*\$|\$\$/gi;
    const jobnames = [];
    for (let match = tag.exec(sql); match; match = tag.exec(sql)) {
      const open = match[0];
      const appliesNow = /\bdo\s*$/i.test(sql.slice(Math.max(0, match.index - 8), match.index));
      const closesAt = sql.indexOf(open, match.index + open.length);
      const end = closesAt === -1 ? sql.length : closesAt;
      if (appliesNow) {
        for (const call of sql.slice(match.index, end).matchAll(/cron\.schedule\s*\(\s*'([^'\n]+)'/g)) {
          jobnames.push(call[1]);
        }
      }
      tag.lastIndex = end + open.length;
    }
    return jobnames;
  }

  it("has an entry for every cron job the migrations schedule at apply time", () => {
    const scheduled = new Map();
    for (const { name, sql } of code) {
      for (const jobname of applyTimeSchedules(sql)) if (!scheduled.has(jobname)) scheduled.set(jobname, name);
    }
    expect(scheduled.size, "no apply-time cron.schedule calls were parsed — the scan has rotted").toBeGreaterThan(15);
    // The classifier is only useful while it can still tell the two lanes
    // apart. If it ever called everything seed-time the check above would
    // still pass on the remaining jobs; if it ever called everything
    // apply-time, the demo-seed lane would be demanded of every project.
    expect([...scheduled.keys()], "the DO-block lane must still be recognised").toContain("casework-alert-escalation-tick");
    expect([...scheduled.keys()].filter((jobname) => jobname.startsWith("demo-seed-")),
      "private.demo_seed_* schedules run at seed time and must not be demanded of an ordinary project").toEqual([]);

    const pinned = new Set(contract.cron.map((entry) => entry.jobname));
    const unaccounted = [...scheduled.entries()]
      .filter(([jobname]) => !pinned.has(jobname))
      .map(([jobname, name]) => `${jobname} (scheduled in ${name})`);
    expect(unaccounted, "add these to cron[] in scripts/db-contract.json").toEqual([]);
  });

  it("pins the casework escalation tick to the command the migration schedules", () => {
    // jobname + schedule say nothing about what runs, and this job is the one
    // that moves an overdue, unacknowledged safety alert into the restricted
    // staff queue. A job that kept its slot but lost its command would leave
    // those alerts sitting unescalated.
    const entry = contract.cron.find((candidate) => candidate.jobname === "casework-alert-escalation-tick");
    expect(entry, "casework-alert-escalation-tick must be pinned in cron[]").toBeTruthy();
    expect(entry.schedule).toBe("* * * * *");
    expect(entry.active).toBe(false);
    const dispatcher = contract.cron.find((job) => job.jobname === "mi1-job-health-sync");
    expect(dispatcher.active).toBe(true);
    expect(dispatcher.commandContains).toContain("select private.run_minute_cron_task('casework-alert-escalation-tick'); commit;");
    expect(entry.commandContains.some((fragment) => fragment.includes("private.casework_escalate_due_alerts")),
      "the pinned command must name private.casework_escalate_due_alerts").toBe(true);

    const source = code.find(({ name }) => name.includes("20260828210000_mi1_casework_suite"));
    expect(source, "the casework suite migration must still be in the tree").toBeTruthy();
    expect(source.sql).toContain(
      "cron.schedule('casework-alert-escalation-tick', '* * * * *', 'select private.casework_escalate_due_alerts(200)')",
    );
  });
});

describe("the verifier's target guard is documented, not hard-coded into the environment", () => {
  const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

  it("documents SUPABASE_DB_URL with a placeholder and never the real project", () => {
    expect(envExample, "verify:db's transport must be documented").toContain("SUPABASE_DB_URL=");
    const line = envExample.split(/\r?\n/).find((entry) => entry.startsWith("SUPABASE_DB_URL="));
    expect(line).toMatch(/replace-with/);
    expect(line, "a real password must never sit in the checked-in example").not.toMatch(/:[^@/]{12,}@/);
  });

  it("documents the host form the contract's project ref plugs into, without naming any project", () => {
    expect(contract.target.hostForm).toBe("db.<project-ref>.supabase.co");
    expect(envExample, "the example must show the shape the target guard matches").toContain(contract.target.hostForm);
    expect(siblingIdentityIn(envExample), ".env.example must not carry a sibling project ref").toEqual([]);
  });
});

// Union Ground has no provisioned database, so the contract names no
// project and every hosted target is refused, the sibling product's included.
describe("the contract targets no database until Union Ground has its own", () => {
  // The one maintained deny list (config/sample-backend.json) that
  // src/lib/providerContract.js enforces, by digest.
  const legacyRefDigests = JSON.parse(readFileSync(new URL("../config/sample-backend.json", import.meta.url), "utf8")).forbiddenSupabaseRefSha256;

  it("clears the project ref and refuses every sibling project by digest", () => {
    expect(contract.target.projectRef).toBeNull();
    expect(legacyRefDigests.length).toBeGreaterThan(0);
    expect([...contract.target.forbiddenProjectRefSha256].sort()).toEqual([...legacyRefDigests].sort());
  });

  it("refuses hosted targets and admits only the confirmed disposable loopback database", async () => {
    const { assertExactTarget, DISPOSABLE_DB_CONFIRM } = await import("../scripts/lib/assert-exact-target.mjs");
    for (const ref of DENIED_SUPABASE_REFS) {
      expect(() => assertExactTarget(contract.target, `postgresql://postgres:secret@db.${ref}.supabase.co:5432/postgres`))
        .toThrow(`Forbidden legacy Supabase project: ${ref}`);
      expect(() => assertExactTarget(contract.target, `postgresql://postgres.${ref}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`))
        .toThrow(`Forbidden legacy Supabase project: ${ref}`);
    }
    expect(() => assertExactTarget(contract.target, "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres"))
      .toThrow("No Union Ground database target is provisioned");
    expect(() => assertExactTarget({ ...contract.target, projectRef: "unionground-unset" }, "postgresql://postgres.unionground-unset:secret@pooler.example.invalid:6543/postgres"))
      .toThrow("No Union Ground database target is provisioned");
    expect(assertExactTarget(contract.target, "postgresql://postgres:postgres@127.0.0.1:55432/postgres", { disposableConfirm: DISPOSABLE_DB_CONFIRM }))
      .toBe("confirmed-loopback-disposable");
    expect(() => assertExactTarget(contract.target, "postgresql://postgres:postgres@127.0.0.1:55432/postgres"))
      .toThrow("Loopback database verification requires DB_VERIFY_DISPOSABLE_CONFIRM");
  });
});

describe("the verifier reads guards from code, never from comments", () => {
  // Recurring trap (see, MFA batches 1-2): a bodyContains needle or a
  // coverage term must not be satisfiable by a `-- ... member_has_role ...`
  // comment. Both the per-function needle loop AND the mfaCoverage term sweep
  // must run over comment-stripped code. This source tripwire fails loudly if a
  // future refactor reverts either to raw pg_get_functiondef.
  it("defines a shared codeOf() comment-stripper", () => {
    expect(verifierSrc).toContain("const codeOf = (def) => def.replace(");
  });

  it("matches bodyContains needles against comment-stripped code", () => {
    expect(verifierSrc).toContain("codeOf(row.def).includes(needle.toLowerCase())");
    // The un-hardened form (raw def, comments included) must be gone.
    expect(verifierSrc).not.toMatch(/row\.def\.includes\(needle\.toLowerCase\(\)\)/);
  });

  it("pins the dependency trigger's complete stored source body", () => {
    const dependency = contract.functions.find((entry) => entry.sig === "private.prepare_chapter_task_dependency()");
    expect(dependency.sourceMd5).toMatch(/^[a-f0-9]{32}$/);
    expect(verifierSrc).toContain("md5(p.prosrc) as source_md5");
    expect(verifierSrc).toContain("entry.sourceMd5, row.source_md5");
  });

  it("matches PostgreSQL's quoted catalog spelling for the reserved position column", () => {
    const bounded = contract.constraints.find((entry) => entry.name === "chapter_task_assignments_position_bounded");
    const taskPosition = contract.indexes.find((entry) => entry.name === "chapter_task_assignments_task_position_key");
    const chapterPosition = contract.indexes.find((entry) => entry.name === "chapter_task_assignments_chapter_idx");
    expect(bounded.defContains).toEqual(['"position" >= 0', '"position" <= 11']);
    expect(taskPosition.defContains).toContain('USING btree (task_id, "position")');
    expect(chapterPosition.defContains).toContain('USING btree (chapter_id, task_id, "position")');
  });

  it("matches mfaCoverage terms against comment-stripped code", () => {
    expect(verifierSrc).toContain("const defCode = codeOf(row.def);");
    expect(verifierSrc).toContain("defCode.includes(needle.toLowerCase())");
  });

  it("uses plaintext only for an exact-target loopback alias", () => {
    expect(verifierSrc).toContain("postgresSslForTarget");
    expect(verifierSrc).toContain("ssl: postgresSslForTarget(connectionString)");
    const guardIndex = verifierSrc.indexOf("const targetKind = assertExactTarget(contract.target, connectionString, {");
    const sslIndex = verifierSrc.indexOf("ssl: postgresSslForTarget(connectionString)");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(sslIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(sslIndex);
  });

  it("canonicalizes policy expressions without lowercasing SQL literals or quoted identifiers", () => {
    expect(verifierSrc).toContain('import { canonicaliseCatalogSql } from "./lib/sql-text.mjs"');
    expect(verifierSrc).toContain("canonicaliseCatalogSql(expression).includes(canonicaliseCatalogSql(needle))");
    expect(verifierSrc).not.toMatch(/row\.qual\.toLowerCase\(\)/);
  });
});

// TEST-UG-MEMBER-SUPPORT-STAFF-CONTRACT-WEAK-ROLE-NEEDLES-20260921: the
// bare role words ("vp" among them) matched a widened or vp-token-swapped role
// array, and the entry has no bodyMd5. The entry now pins the array literal, as
// private.mi1_qa_is_officer does. Offline: mutate the declaring migration's body
// and prove the old needles miss the change while the current pin catches it.
describe("private.member_support_is_staff pins its staff role array as a literal", () => {
  const SIG = "private.member_support_is_staff(p_organization_id uuid)";
  const MIGRATION = "20260829030000_member_support_programs.sql";
  const ROLE_ARRAY = "array['steward', 'coordinator', 'advisor', 'admin', 'vp']";
  const BARE_WORD_NEEDLES = ["private.has_organization_role", "steward", "coordinator", "advisor", "admin", "vp"];

  const entry = contract.functions.find((candidate) => candidate.sig === SIG);
  const body = stripComments(fnBody(loadMigrationSql(MIGRATION), "private.member_support_is_staff"));

  // The verifier's test, reduced to the part an offline body can answer:
  // `codeOf(row.def).includes(needle.toLowerCase())` for every needle.
  const unmatched = (needles, sql) => needles.filter((needle) => !sql.includes(needle.toLowerCase()));

  const MUTATIONS = {
    "widened to a non-staff role": (sql) => sql.replace("'vp']", "'vp', 'member']"),
    "'vp' replaced by a vp-containing non-role": (sql) => sql.replace("'admin', 'vp']", "'admin', 'vpn_service']"),
  };

  it("is declared in exactly one migration, so the offline body is the whole story", () => {
    const declaring = code.filter((file) => file.sql.includes("function private.member_support_is_staff("));
    expect(declaring.map((file) => file.name)).toEqual([MIGRATION]);
  });

  it("pins the array literal and keeps no needle short enough to match by accident", () => {
    expect(entry, `${SIG} must stay in the contract`).toBeDefined();
    expect(entry.bodyContains).toContain(ROLE_ARRAY);
    expect(entry.bodyContains.filter((needle) => needle.length < 4)).toEqual([]);
  });

  it("matches every pinned needle against the declared body", () => {
    expect(body).toContain(ROLE_ARRAY);
    expect(unmatched(entry.bodyContains, body)).toEqual([]);
  });

  it.each(Object.entries(MUTATIONS))("fails verification when the role array is %s", (_name, mutate) => {
    const mutated = mutate(body);
    expect(mutated, "the mutation must actually change the body").not.toBe(body);
    expect(mutated).not.toContain(ROLE_ARRAY);
    // The regression this guards: the old pin could not see the change at all.
    expect(unmatched(BARE_WORD_NEEDLES, mutated), "every bare-word needle still matches the mutated body").toEqual([]);
    // The repair: the current pin can.
    expect(unmatched(entry.bodyContains, mutated).length).toBeGreaterThan(0);
  });
});

// Found by the corresponding change: three scripts assert a literal
// rlsTableCount and they had drifted apart — verify-mi1-w2-feature-persistence
// tracked the contract while verify-member-engagement-behaviour and
// verify-mi1-organization-scope sat 7 too high from before the W2 case-flow
// retirement dropped its tables, and  and  then incremented all three
// by one each, preserving the gap. Neither stale script was CI-gated then, so the
// drift was invisible until someone ran them by hand; verify-mi1-organization-scope
// is gated now (see the last describe in this file), verify-member-engagement-behaviour
// still is not, which is why this guard reads the number rather than trusting a run.
// The number is derived live by
// scripts/verify-db-contract.mjs against pg_class.relrowsecurity; this pins
// that every offline restatement of it agrees with the contract, so a future
// mover cannot update one copy and leave the others behind.
describe("offline scripts cannot reintroduce hand-kept RLS table totals", () => {
  // Discovered, not listed: a fourth script that restates the number joins the
  // guard by existing, at any depth under scripts/ and in any spelling the
  // parser-backed scan reads. A spelling it cannot read is reported rather than
  // skipped. Planted controls exercise discovery even though every current
  // source consumer now checks named table files instead of a number. Only
  // the live checker and the retained legacy-format reader may read the count.
  const DERIVERS = ["verify-db-contract.mjs", "lib/db-contract-tables.mjs"];
  const KNOWN_RESTATERS = [
    "verify-member-engagement-behaviour.mjs",
    "verify-mi1-organization-scope.mjs",
    "verify-mi1-w2-feature-persistence.mjs",
  ];
  const scriptsRoot = fileURLToPath(new URL("../scripts/", import.meta.url));
  const expected = readRlsTableInventory(contract).count;

  const verdict = (root) => {
    const restating = rlsTableCountRestatements(root, { derivers: DERIVERS });
    return {
      names: restating.map((entry) => entry.name),
      disagreeing: restating.flatMap(({ name, literals }) =>
        literals.map((literal) => `${name}:${literal}`)),
      unreadable: restating.flatMap((entry) => entry.unreadable),
    };
  };

  it("rejects every numeric restatement outside the legacy reader", () => {
    expect(Number.isInteger(expected)).toBe(true);
    const real = verdict(scriptsRoot);
    expect(real.names).toEqual([]);
    expect(real.disagreeing).toEqual([]);
    expect(real.unreadable).toEqual([]);
  });

  describe("against a planted stale restater", () => {
    const stale = expected + 7;
    const access = "contract.policyCoverage.rlsTableCount";
    const SPELLINGS = {
      "strict inequality": `if (${access} !== ${stale}) fail("stale");`,
      "reversed operands": `if (${stale} !== ${access}) fail("stale");`,
      "loose inequality": `if (${access} != ${stale}) fail("stale");`,
      "parenthesised operand": `if ((${access}) !== ${stale}) fail("stale");`,
      "bracket access": `if (contract.policyCoverage["rlsTableCount"] !== ${stale}) fail("stale");`,
      "numeric separator": `if (${access} !== ${String(stale).replace(/^(\d)/, "$1_")}) fail("stale");`,
      "assert.equal": `assert.equal(${access}, ${stale});`,
      "assert.strictEqual, reversed": `assert.strictEqual(${stale}, ${access}, "stale");`,
      "named constant": `const EXPECTED_RLS_TABLES = ${stale};\nif (${access} !== EXPECTED_RLS_TABLES) fail("stale");`,
      "destructured": `const { rlsTableCount } = contract.policyCoverage;\nif (rlsTableCount !== ${stale}) fail("stale");`,
      "object pin": `const pinned = { rlsTableCount: ${stale} };`,
    };
    const UNREADABLE = {
      "arithmetic operand": `if (${access} !== ${expected} + 7) fail("stale");`,
      "aliased destructuring": `const { rlsTableCount: count } = contract.policyCoverage;\nif (count !== ${stale}) fail("stale");`,
      "ordering comparison": `if (${access} < ${stale}) fail("stale");`,
    };

    // A temp copy of the real restaters plus one planted script in a
    // subdirectory, which is where the first version of this guard never looked.
    let root;
    const plant = (source) => {
      mkdirSync(join(root, "nested", "deeper"), { recursive: true });
      writeFileSync(join(root, "nested", "deeper", "planted.mjs"), `${source}\n`);
      return verdict(root);
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "rls-table-count-restaters-"));
      for (const name of KNOWN_RESTATERS) copyFileSync(join(scriptsRoot, name), join(root, name));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("stays green on the copy before anything is planted", () => {
      const copy = verdict(root);
      expect(copy.names).toEqual([]);
      expect(copy.disagreeing).toEqual([]);
      expect(copy.unreadable).toEqual([]);
    });

    it('rejects a reintroduced literal even when it equals the current total', () => {
      expect(plant(`if (${access} !== ${expected}) fail("pin");`).disagreeing)
        .toEqual([`nested/deeper/planted.mjs:${expected}`]);
    });

    it.each(Object.entries(SPELLINGS))("reads the stale number spelled as %s", (_spelling, source) => {
      const planted = plant(source);
      expect(planted.disagreeing).toEqual([`nested/deeper/planted.mjs:${stale}`]);
      expect(planted.unreadable).toEqual([]);
    });

    it.each(Object.entries(UNREADABLE))("reports %s as unreadable instead of passing it", (_spelling, source) => {
      const planted = plant(source);
      expect(planted.disagreeing).toEqual([]);
      expect(planted.unreadable).toHaveLength(1);
      expect(planted.unreadable[0]).toMatch(/^nested\/deeper\/planted\.mjs:\d+$/);
    });

    it("ignores the number inside comments and string literals", () => {
      const planted = plant([
        `// rlsTableCount !== ${stale}`,
        `/* assert.equal(${access}, ${stale}) */`,
        `const note = "rlsTableCount === ${stale}";`,
        `const other = 'rlsTableCount: ${stale}';`,
        `const message = \`rlsTableCount !== ${stale}, got \${${access}}\`;`,
      ].join("\n"));
      expect(planted.names).not.toContain("nested/deeper/planted.mjs");
      expect(planted.disagreeing).toEqual([]);
      expect(planted.unreadable).toEqual([]);
    });

    it("still reads a stale restatement that sits beside a decoy comment", () => {
      const planted = plant(`if (${stale} !== ${access}) fail("stale"); // note: rlsTableCount !== ${expected}`);
      expect(planted.disagreeing).toEqual([`nested/deeper/planted.mjs:${stale}`]);
    });
  });
});

// The guard above pins that the offline restatements agree with each other. It
// says nothing about whether anyone ever runs them, which was the other half of
// the same defect: verify-mi1-organization-scope.mjs statically pins ~35 safety
// invariants of the tenant-isolation foundation migration in a mode that needs
// no database and takes ~250ms, and until this guard it had no npm alias and
// appeared in no workflow. Its only enforcement was a single manual run recorded
// in a worklist audit note at  merge time. A verifier nothing runs is a
// comment, so this pins the invocation: a verify-mi1-* entry point whose default
// mode needs nothing but the checkout has to be reachable from `npm run check`.
describe("every static MI1 verifier is reachable from npm run check", () => {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const scriptsRoot = join(repositoryRoot, "scripts");
  const packageScripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts;

  // Classified from the source, not from a list: a module another verifier
  // imports is a library rather than an entry point, a Playwright import means
  // the script needs the app served, and importing the required-database-url
  // helper means the default mode already demands a connection string. What is
  // left runs on the checkout alone and belongs in the pipeline.
  const classifyVerifiers = (root) => {
    const files = readdirSync(root).filter((name) => /^verify-mi1-.+\.mjs$/.test(name)).sort();
    const sources = new Map(files.map((name) => [name, readFileSync(join(root, name), "utf8")]));
    const imported = new Set();
    for (const source of sources.values()) {
      for (const match of source.matchAll(/from\s+"\.\/(verify-mi1-[\w.-]+\.mjs)"/g)) imported.add(match[1]);
    }
    return new Map(files.map((name) => {
      const source = sources.get(name);
      if (imported.has(name)) return [name, "library"];
      if (source.includes("@playwright/test")) return [name, "needs-served-app"];
      if (source.includes("required-database-url.mjs")) return [name, "needs-database"];
      return [name, "static"];
    }));
  };

  // `npm run x` inside the chain is only a real invocation when it is a whole
  // link: matching a bare substring would accept `verify:mi1-w2` as coverage for
  // `verify:mi1-w2:live` and vice versa.
  const chainRuns = (chain, alias) =>
    new RegExp(`(^|&&)\\s*npm run ${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(&&|$)`).test(chain);

  const gatingFindings = (root, scripts) => {
    const chain = scripts.check ?? "";
    const findings = [];
    for (const [name, kind] of classifyVerifiers(root)) {
      if (kind !== "static") continue;
      const alias = Object.entries(scripts)
        .find(([key, value]) => !key.endsWith(":live") && value === `node scripts/${name}`)?.[0];
      if (!alias) {
        findings.push(`${name}: no npm script runs "node scripts/${name}"`);
        continue;
      }
      if (!chainRuns(chain, alias)) findings.push(`${name}: npm run ${alias} is missing from the check pipeline`);
    }
    return findings;
  };

  // Stated, so that a new verifier cannot be waved past by landing in a bucket
  // nobody looked at, and so that adding `requireDatabaseUrl` to a static
  // verifier to dodge the gate has to be argued for here.
  const EXPECTED_CLASSIFICATION = {
    "verify-mi1-automation-control-local.mjs": "needs-database",
    "verify-mi1-casework-suite.mjs": "static",
    "verify-mi1-organization-scope.mjs": "static",
    "verify-mi1-pay-browser.mjs": "needs-served-app",
    "verify-mi1-qa-browser.mjs": "needs-served-app",
    "verify-mi1-retention-engine-local.mjs": "needs-database",
    "verify-mi1-w2-feature-persistence.mjs": "static",
    "verify-mi1-xdb-security-extensions.mjs": "library",
  };

  it("classifies every verify-mi1-* module the checkout actually has", () => {
    expect(Object.fromEntries(classifyVerifiers(scriptsRoot))).toEqual(EXPECTED_CLASSIFICATION);
  });

  it("runs every static verifier from npm run check", () => {
    expect(gatingFindings(scriptsRoot, packageScripts)).toEqual([]);
  });

  it("keeps each static verifier green with nothing but the checkout", () => {
    // The classification claims these need no database and no served app. Proving
    // it here is what stops the pipeline entries above from turning CI red, and
    // stops "static" from decaying into a naming convention.
    const { MI1_EXCLUSIVE_DB_URL, SUPABASE_DB_URL, DATABASE_URL, ...env } = process.env;
    for (const [name, kind] of classifyVerifiers(scriptsRoot)) {
      if (kind !== "static") continue;
      expect(() => execFileSync(process.execPath, [join(scriptsRoot, name)], {
        cwd: repositoryRoot,
        env,
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      }), `${name} must exit 0 offline`).not.toThrow();
    }
  });

  describe("against a planted verifier", () => {
    let root;
    const plant = (name, source) => {
      writeFileSync(join(root, name), `${source}\n`);
      return root;
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "mi1-verifier-gating-"));
      for (const name of Object.keys(EXPECTED_CLASSIFICATION)) {
        copyFileSync(join(scriptsRoot, name), join(root, name));
      }
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("stays quiet on the copy before anything is planted", () => {
      expect(Object.fromEntries(classifyVerifiers(root))).toEqual(EXPECTED_CLASSIFICATION);
      expect(gatingFindings(root, packageScripts)).toEqual([]);
    });

    it("reports a new static verifier that nothing aliases", () => {
      plant("verify-mi1-planted.mjs", 'import { readFileSync } from "node:fs";\nreadFileSync("package.json");');
      expect(classifyVerifiers(root).get("verify-mi1-planted.mjs")).toBe("static");
      expect(gatingFindings(root, packageScripts))
        .toEqual(['verify-mi1-planted.mjs: no npm script runs "node scripts/verify-mi1-planted.mjs"']);
    });

    it("reports an aliased static verifier the check chain never reaches", () => {
      plant("verify-mi1-planted.mjs", 'export const planted = true;');
      const scripts = {
        ...packageScripts,
        "verify:mi1-planted": "node scripts/verify-mi1-planted.mjs",
      };
      expect(gatingFindings(root, scripts))
        .toEqual(["verify-mi1-planted.mjs: npm run verify:mi1-planted is missing from the check pipeline"]);
      expect(gatingFindings(root, { ...scripts, check: `${scripts.check} && npm run verify:mi1-planted` }))
        .toEqual([]);
    });

    it("refuses a live-only alias as coverage for the default mode", () => {
      plant("verify-mi1-planted.mjs", 'export const planted = true;');
      const scripts = {
        ...packageScripts,
        "verify:mi1-planted:live": "node scripts/verify-mi1-planted.mjs",
        check: `${packageScripts.check} && npm run verify:mi1-planted:live`,
      };
      expect(gatingFindings(root, scripts))
        .toEqual(['verify-mi1-planted.mjs: no npm script runs "node scripts/verify-mi1-planted.mjs"']);
    });

    it("refuses a near-miss chain link as coverage", () => {
      // `npm run verify:mi1-w2:live` contains `npm run verify:mi1-w2`; only the
      // whole link counts, or a live-only pipeline would read as gated.
      const chain = packageScripts.check.replace(
        /(^|&& )npm run verify:mi1-organization-scope (&&|$)/,
        "$1npm run verify:mi1-organization-scope:live $2",
      );
      expect(chain).not.toEqual(packageScripts.check);
      expect(gatingFindings(root, { ...packageScripts, check: chain }))
        .toEqual(["verify-mi1-organization-scope.mjs: npm run verify:mi1-organization-scope is missing from the check pipeline"]);
    });

    it("leaves a planted verifier that needs a database or a served app out of the pipeline", () => {
      plant("verify-mi1-planted-db.mjs", 'import { requireDatabaseUrl } from "./lib/required-database-url.mjs";\nrequireDatabaseUrl("SUPABASE_DB_URL");');
      plant("verify-mi1-planted-browser.mjs", 'import { chromium } from "@playwright/test";\nawait chromium.launch();');
      const classification = classifyVerifiers(root);
      expect(classification.get("verify-mi1-planted-db.mjs")).toBe("needs-database");
      expect(classification.get("verify-mi1-planted-browser.mjs")).toBe("needs-served-app");
      expect(gatingFindings(root, packageScripts)).toEqual([]);
    });

    it("treats a module another verifier imports as a library, not an entry point", () => {
      plant("verify-mi1-planted-lib.mjs", 'export const helper = () => true;');
      expect(classifyVerifiers(root).get("verify-mi1-planted-lib.mjs")).toBe("static");
      plant("verify-mi1-planted.mjs", 'import { helper } from "./verify-mi1-planted-lib.mjs";\nhelper();');
      expect(classifyVerifiers(root).get("verify-mi1-planted-lib.mjs")).toBe("library");
      expect(gatingFindings(root, packageScripts))
        .toEqual(['verify-mi1-planted.mjs: no npm script runs "node scripts/verify-mi1-planted.mjs"']);
    });
  });
});
