// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// REQ-UG-STORAGE-SCHEMA-GRANTS-20260726. Text pins are a tripwire, not a
// proof: current-state truth lives in scripts/db-contract.json and is checked by
// `npm run verify:db`, whose sweeps this same commit extends beyond schema
// public for the first time. These pins keep the WIRING and the reasoning from
// rotting while that lane still SKIPs unarmed in CI.

const sql = loadMigrationSql("storage_default_acl_revoke");
const statements = stripComments(sql);

const verifierSrc = readFileSync(new URL("../scripts/verify-db-contract.mjs", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const vendor = contract.knownGaps.vendorSchemaClientGrants;

const VOCAB = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];

describe("storage default-ACL revoke migration", () => {
  it("revokes the four non-row bits from the postgres default ACL in schema storage", () => {
    expect(statements).toContain("alter default privileges for role postgres in schema storage");
    expect(statements).toContain("revoke truncate, references, trigger, maintain on tables from anon, authenticated;");
    expect(statements, "service_role keeps its full default set").not.toMatch(/from[^;]*service_role/i);
  });

  it("does NOT attempt a table-level revoke on vendor-owned tables", () => {
    // The trap this migration exists to document: issued as postgres, a revoke
    // against a table owned by supabase_storage_admin is a SILENT no-op —
    // no error, no warning, privileges unchanged (proven live on
    // storage.objects). A migration written that way exits 0 and reads as a
    // closure while changing nothing, so the statements must stay empty of it.
    expect(statements).not.toMatch(/revoke[^;]*\son\s+storage\.\w+/i);
    expect(statements).not.toMatch(/revoke[^;]*\son\s+net\.\w+/i);
    expect(statements).not.toMatch(/revoke[^;]*\son\s+(cron|realtime)\.\w+/i);
  });

  it("touches only table default privileges, not sequences or functions", () => {
    expect(statements).not.toMatch(/on\s+sequences/i);
    expect(statements).not.toMatch(/on\s+functions/i);
    expect(statements).not.toMatch(/^\s*grant\s/im);
  });
});

describe("the vendor-schema sweep is wired and unbounded", () => {
  it("sweeps every non-system schema rather than a declared allow-list", () => {
    // If the sweep were filtered to vendor.schemas, a brand-new Supabase schema
    // carrying client grants would be invisible. The declared list is asserted
    // against what the sweep finds, never used to narrow it.
    expect(verifierSrc).toContain("where n.nspname not in ('public','pg_catalog','information_schema')");
    expect(verifierSrc).toContain("and n.nspname !~ '^pg_'");
    expect(verifierSrc).toContain("no client table grant outside the declared vendor schemas");
  });

  it("uses the regex schema filter, not a LIKE with an escaped underscore", () => {
    // In a JS template literal, a backslash-underscore collapses to a bare
    // underscore, which LIKE then treats as a single-character wildcard —
    // silently swallowing pgbouncer and pgsodium. The regex form has no such
    // escape hazard.
    const sweep = verifierSrc.slice(verifierSrc.indexOf("select * from ("));
    expect(sweep.slice(0, 900)).not.toMatch(/nspname\s+not\s+like/i);
  });

  it("covers partitioned tables and views, not just ordinary tables", () => {
    // realtime.messages is only visible as relkind 'p'; the extensions
    // pg_stat_statements entries only as 'v'.
    expect(verifierSrc).toContain("and c.relkind in ('r','p','v','m')");
  });

  it("asserts privileges, RLS and owner per recorded pair", () => {
    expect(verifierSrc).toContain("eq(`vendor grant ${label} privileges`");
    expect(verifierSrc).toContain("eq(`vendor grant ${label} RLS`");
    expect(verifierSrc).toContain("a change to postgres would make a revoke possible");
  });

  it("WARNs rather than FAILs on an unrecorded vendor pair", () => {
    // A NEW-key-fails ratchet would redden the lane on every Supabase platform
    // release with no fix available, because we cannot revoke these.
    expect(verifierSrc).toContain("WARN, not FAIL: we cannot revoke them");
  });
});

describe("vendor-schema contract entries", () => {
  it("records 30 pairs across the five declared schemas, with unique keys", () => {
    expect(vendor.entries).toHaveLength(30);
    expect(vendor.schemas).toEqual(["cron", "extensions", "net", "realtime", "storage"]);
    const keys = new Set(vendor.entries.map((e) => `${e.table}|${e.role}`));
    expect(keys.size, "a duplicate key would leave one entry silently unverified").toBe(30);
    for (const entry of vendor.entries) {
      expect(vendor.schemas).toContain(entry.table.split(".")[0]);
      expect(["anon", "authenticated"]).toContain(entry.role);
      expect(typeof entry.rls).toBe("boolean");
      expect(entry.owner, `${entry.table} owner`).toBeTruthy();
      for (const token of entry.privileges.split(",").map((t) => t.trim())) {
        expect(VOCAB, `${entry.table}/${entry.role} records unknown privilege "${token}"`).toContain(token);
      }
    }
  });

  it("keeps the two SSRF-shaped net pairs recorded with their full privilege set", () => {
    // net.http_request_queue grants INSERT to anon with RLS OFF, and
    // net.http_post is SECURITY INVOKER with EXECUTE to both client roles.
    // Unreachable ONLY because PostgREST exposes just public + graphql_public.
    const byKey = new Map(vendor.entries.map((e) => [`${e.table}|${e.role}`, e]));
    for (const role of ["anon", "authenticated"]) {
      const q = byKey.get(`net.http_request_queue|${role}`);
      expect(q, `net.http_request_queue/${role} must stay recorded`).toBeTruthy();
      expect(new Set(q.privileges.split(","))).toEqual(new Set(VOCAB));
      expect(q.rls, "RLS is OFF here — recorded as-is, not endorsed").toBe(false);
      expect(q.owner).toBe("supabase_admin");
    }
    expect(vendor.why).toContain("PGRST106");
    expect(vendor.why).toContain("server-side-request-forgery");
  });

  it("records the silent-no-op finding as the reason these are recorded not revoked", () => {
    expect(vendor.why).toContain("SILENT NO-OP");
    expect(vendor.why).toContain("byte-identical before and after");
    expect(vendor.outOfContract, "RLS/policies inside vendor schemas are explicitly out of contract").toContain("does not own");
  });
});

describe("schema USAGE is the control that keeps cron unreachable", () => {
  it("asserts USAGE for every schema/role pair, not just private", () => {
    // Widening this from 3 entries to the full matrix is what makes the cron
    // row below assertable at all.
    expect(contract.schemaUsage.length).toBeGreaterThanOrEqual(39);
    const schemas = new Set(contract.schemaUsage.map((e) => e.schema));
    for (const required of ["auth", "cron", "net", "storage", "realtime", "extensions", "public", "private", "vault"]) {
      expect(schemas, `schemaUsage must cover ${required}`).toContain(required);
    }
  });

  it("lists every schema/role pair once, and pins auth USAGE true for the three client-facing roles", () => {
    // A merge once replaced the three auth rows with duplicate
    // supabase_migrations rows; the verifier checks only listed pairs, so the
    // auth pins silently disappeared (PR #3415 review C4).
    const pairs = contract.schemaUsage.map((e) => `${e.schema}|${e.role}`);
    expect(new Set(pairs).size, "duplicate schemaUsage pair").toBe(pairs.length);
    const auth = contract.schemaUsage.filter((e) => e.schema === "auth");
    expect(auth.map((e) => e.role).sort()).toEqual(["anon", "authenticated", "service_role"]);
    for (const entry of auth) expect(entry.usage, `auth USAGE for ${entry.role}`).toBe(true);
    expect(contract._readme[0]).toBe("The database contract: what production ACTUALLY IS, read out of the catalog.");
  });

  it("pins cron USAGE false for all three client-facing roles", () => {
    // cron.job_run_details grants SELECT,DELETE to PUBLIC and cron.unschedule is
    // PUBLIC EXECUTE + SECURITY INVOKER. The ONLY thing holding that back is the
    // absence of schema USAGE, so these three booleans are load-bearing.
    const cron = contract.schemaUsage.filter((e) => e.schema === "cron");
    expect(cron).toHaveLength(3);
    for (const entry of cron) {
      expect(entry.usage, `cron USAGE for ${entry.role} must stay false`).toBe(false);
    }
    expect(cron.find((e) => e.role === "authenticated").note).toContain("Load-bearing false");
  });
});

describe("roleSettings pins the PostgREST exposed-schema lever", () => {
  it("pins authenticator's setconfig exactly, with no pgrst.* present", () => {
    const auth = contract.roleSettings.find((e) => e.role === "authenticator");
    expect(auth, "the authenticator pin is the whole point of this section").toBeTruthy();
    expect(auth.settings).toEqual([
      "lock_timeout=8s",
      "session_preload_libraries=supautils, safeupdate",
      "statement_timeout=8s",
    ]);
    for (const entry of contract.roleSettings) {
      for (const setting of entry.settings) {
        expect(setting, `${entry.role} already carries a pgrst.* setting`).not.toMatch(/^pgrst\./);
      }
    }
  });

  it("states the boundary it does not cover", () => {
    const auth = contract.roleSettings.find((e) => e.role === "authenticator");
    // An honest pin says what it cannot see. The dashboard's Exposed schemas
    // field leaves no catalog trace, so a change there keeps this green.
    expect(auth.note).toContain("BOUNDARY");
    expect(auth.note).toContain("dashboard");
    expect(auth.note).toContain("supautils");
  });

  it("compares settings with a delimiter that survives a comma inside a value", () => {
    // session_preload_libraries=supautils, safeupdate contains a comma;
    // sortedList would split it mid-value and compare garbage.
    expect(verifierSrc).toContain('entry.settings.join(" | "), row.settings.join(" | ")');
    expect(verifierSrc).toContain("a vanished role must not skip its pin");
  });
});
