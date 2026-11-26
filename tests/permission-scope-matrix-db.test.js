// @vitest-environment node
//
// TEST-UG-PERMISSION-SCOPE-MATRIX-20261110 (#8126): the role-by-scope
// matrix. Every security-definer function in scripts/db-contract.json is
// called as six identities against seeded target data that belongs to one
// member of one unit:
//
//   member              a peer member of the same unit
//   unitSteward         the steward of the target's unit
//   otherUnitSteward    the steward of another unit in the same chapter
//   chapterLead         the chapter president (role vp)
//   otherOrganization   an administrator of another organization
//   signedOut           a signed-out visitor (anon)
//
// Owner direction (Nov 9, 2026, #7663): member personal details stay inside
// the smallest group, the unit's steward and the chapter's leaders. A call is
// unexpected reach when an identity outside that group
//   - gets a private marker back (case title, case note, form answer, email),
//     in a result or in an error message ("private");
//   - gets the target's name back from outside the organization, or signed
//     out ("name");
//   - changes a row that references the target member, case or form
//     ("write");
//   - completes at all on a function its role holds no EXECUTE grant for
//     ("grant").
// Known gaps are listed in KNOWN_GAPS, each with its open record. A listed gap
// that no longer reproduces fails too, so the list only shrinks. The first
// version changes no function; it only measures.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { createScopeFixture } from "./helpers/permission-scope-fixture.mjs";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const securityDefiners = contract.functions.filter((entry) => entry.secdef);

export const IDENTITIES = Object.freeze(["member", "unitSteward", "otherUnitSteward", "chapterLead", "otherOrganization", "signedOut"]);
const MAY_REACH_PRIVATE = new Set(["unitSteward", "chapterLead"]);
const MAY_REACH_NAME = new Set(["member", "unitSteward", "otherUnitSteward", "chapterLead"]);
const MAY_WRITE = new Set(["unitSteward", "chapterLead"]);
const REACH_KINDS = Object.freeze(["private", "name", "write", "grant"]);

// Known gaps: { fn: contract signature, identity, reach, record: "#N" open
// record, note }. Sorted by function. Keep it shrinking.
export const KNOWN_GAPS = Object.freeze([]);

const gapKey = ({ fn, identity, reach }) => `${fn} | ${identity} | ${reach}`;

describe("permission-scope matrix allow-list", () => {
  it("names only contract security-definer functions, known identities and reach kinds, each with an open record", () => {
    const signatures = new Set(securityDefiners.map((entry) => entry.sig));
    expect(securityDefiners.length).toBeGreaterThan(1000);
    const keys = new Set();
    for (const gap of KNOWN_GAPS) {
      expect(signatures.has(gap.fn), gap.fn).toBe(true);
      expect(IDENTITIES, gap.fn).toContain(gap.identity);
      expect(REACH_KINDS, gap.fn).toContain(gap.reach);
      expect(gap.record, gap.fn).toMatch(/^#[1-9]\d*$/);
      expect(typeof gap.note === "string" && gap.note.trim().length > 0, gap.fn).toBe(true);
      expect(keys.has(gapKey(gap)), gapKey(gap)).toBe(false);
      keys.add(gapKey(gap));
    }
    expect(KNOWN_GAPS.map((gap) => gap.fn)).toEqual(KNOWN_GAPS.map((gap) => gap.fn).toSorted());
  });
});

// Argument binding by parameter name. A parameter that names one of the
// seeded objects gets it; any other id gets a fresh random value, and the
// function counts as not exercised with target arguments in the report.
// A caller or actor id parameter gets the target too: a function that trusts
// it would act as, or read for, the target member.
const TARGET_USER = /^(user|user_id|member|member_id|member_user_id|target|target_id|target_user|target_user_id|subject|subject_id|subject_user_id|expected_user_id|profile_id|owner_user_id|recipient|recipient_id|recipient_user_id|caller|caller_id|actor|actor_id|operator_user_id)$/;
const ORGANIZATION = /^(org|org_id|organization|organization_id|expected_org|expected_organization_id|union_org_id)$/;
const CHAPTER = /^(chapter|chapter_id|chapter_code|chapter_slug|expected_chapter)$/;
const CASE = /^(case|case_id|target_case_id|member_case_id)$/;
const FORM = /^(form|form_id)$/;
const UNIT = /^(unit|unit_id)$/;
const STEWARD = /^(steward|steward_id|steward_user_id|assigned_to|assignee|assignee_id)$/;

function bindArgument(fnName, name, type, seed) {
  const key = String(name ?? "").replace(/^p_/, "");
  const id = (value) => ({ value, seeded: true });
  const other = (value) => ({ value, seeded: !/(^|_)ids?$|^(case|form|unit|org|chapter)$/.test(key) });
  if (type === "uuid") {
    if (CASE.test(key) || (key === "id" && /case/.test(fnName))) return id(seed.caseId);
    if (FORM.test(key) || (key === "id" && /form/.test(fnName))) return id(seed.formId);
    if (TARGET_USER.test(key) || (key === "id" && /member|user|profile/.test(fnName))) return id(seed.target);
    if (ORGANIZATION.test(key)) return id(seed.organization);
    if (UNIT.test(key)) return id(seed.unit);
    if (STEWARD.test(key)) return id(seed.unitSteward);
    if (key === "idempotency_key") return other(randomUUID());
    return { value: randomUUID(), seeded: false };
  }
  if (type === "text") {
    if (CHAPTER.test(key)) return id(seed.chapter);
    if (ORGANIZATION.test(key)) return id(seed.organization);
    if (TARGET_USER.test(key)) return id(seed.target);
    if (CASE.test(key)) return id(seed.caseId);
    if (/(^|_)id$/.test(key)) return { value: randomUUID(), seeded: false };
    return other("scope-probe");
  }
  if (type === "uuid[]") {
    if (/^case_ids$/.test(key)) return id([seed.caseId]);
    if (/^(user_ids|member_ids|target_user_ids|recipient_ids|member_user_ids)$/.test(key)) return id([seed.target]);
    if (/^steward_ids$/.test(key)) return id([seed.unitSteward]);
    return other([]);
  }
  if (type === "text[]") return other(/chapter/.test(key) ? [seed.chapter] : []);
  if (["integer", "bigint", "smallint", "numeric"].includes(type)) return other(/limit|size|count|max/.test(key) ? 50 : 1);
  if (type === "integer[]") return other([]);
  if (type === "boolean") return other(false);
  if (type === "jsonb" || type === "json") return other("{}");
  return other(null);
}

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

live("permission-scope matrix on a live database", () => {
  let client;
  let seed;
  let become;
  const token = randomUUID().replaceAll("-", "").slice(0, 16);
  const privateMarker = `scopeprivate${token}`;
  const nameMarker = `Scopename${token}`;
  const q = (sql, params) => client.query(sql, params);

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "permission-scope-matrix-proof",
    });
    await client.connect();
    await q("begin");
    await q("set local statement_timeout = '60s'");
    await q("set local lock_timeout = '15s'");
    ({ seed, become } = await createScopeFixture(q, { privateMarker, nameMarker }));
    await q("set local statement_timeout = '5s'");
    await q("set local lock_timeout = '2s'");
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    try {
      await q("rollback");
    } finally {
      await client.end();
    }
  });

  it("finds no unexpected reach outside the known gaps, and every known gap still reproduces", async () => {
    // Resolve every contract security definer on the live catalog.
    const catalog = new Map((await q(`
      select n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig,
             p.oid::regprocedure::text as callable, p.proname as name,
             coalesce(p.proargnames, '{}') as argnames, coalesce(p.proargmodes::text[], '{}') as argmodes,
             array(select pg_catalog.format_type(t, null) from unnest(p.proargtypes) t) as argtypes,
             p.prorettype::regtype::text in ('trigger', 'event_trigger', 'internal', 'language_handler') as uncallable
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname in ('public', 'private')`)).rows.map((row) => [row.sig, row]));
    const unresolved = securityDefiners.filter((entry) => !catalog.has(entry.sig)).map((entry) => entry.sig);
    expect(unresolved).toEqual([]);

    const targetPattern = [seed.target, seed.caseId, seed.formId].join("|");
    const writtenTables = async () => new Map((await q(
      "select relid::regclass::text as rel, n_tup_ins + n_tup_upd + n_tup_del as n from pg_catalog.pg_stat_xact_user_tables")).rows
      .map((row) => [row.rel, Number(row.n)]));
    const targetRows = async (rel) => (await q(
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from ${rel} t where t::text ~ $1`, [targetPattern])).rows[0].h;

    const calls = [];
    const uncallable = [];
    const unseeded = {};
    for (const entry of securityDefiners) {
      const row = catalog.get(entry.sig);
      // Trigger and internal-type functions run only through their triggers.
      if (row.uncallable) {
        uncallable.push(entry.sig);
        continue;
      }
      const inputNames = row.argmodes.length
        ? row.argnames.filter((_, index) => ["i", "b", "v"].includes(row.argmodes[index]))
        : row.argnames;
      const args = row.argtypes.map((type, index) => ({ type, ...bindArgument(row.name, inputNames[index], type, seed) }));
      const fn = row.callable.slice(0, row.callable.indexOf("("));
      const text = `select coalesce(string_agg(v::text, E'\\n'), '') as v from (select ${fn}(${args.map((arg, index) => `$${index + 1}::${arg.type}`).join(", ")}) as v) s`;
      for (const [index, arg] of args.entries()) {
        if (!arg.seeded) unseeded[`${inputNames[index] ?? `$${index + 1}`} ${arg.type}`] = (unseeded[`${inputNames[index] ?? `$${index + 1}`} ${arg.type}`] ?? 0) + 1;
      }
      calls.push({ entry, text, values: args.map((arg) => arg.value), seeded: args.every((arg) => arg.seeded) });
    }

    // One savepoint per call, rolled back, so every call sees the same seed.
    // A completed call that wrote anything is checked for changed rows that
    // reference the target member, case or form: their hash after the call
    // against the hash once the savepoint is rolled back.
    const observed = [];
    const outcomes = {};
    const reached = {};
    const perCall = {};
    for (const identity of IDENTITIES) {
      const role = identity === "signedOut" ? "anon" : "authenticated";
      outcomes[identity] = { ok: 0, denied: 0, error: 0 };
      reached[identity] = { private: [], name: [], write: [] };
      await become(identity);
      let before = await writtenTables();
      for (const call of calls) {
        await q("savepoint scope_call");
        let result = "";
        let failure = null;
        try {
          result = (await q(call.text, call.values)).rows[0]?.v ?? "";
        } catch (error) {
          failure = error;
        }
        const seen = `${result}\n${failure?.message ?? ""}\n${failure?.detail ?? ""}\n${failure?.hint ?? ""}`;
        const kinds = new Set();
        if (seen.includes(privateMarker)) kinds.add("private");
        if (seen.includes(nameMarker)) kinds.add("name");
        const after = failure ? before : await writtenTables();
        const changed = [...after].filter(([rel, n]) => n !== (before.get(rel) ?? 0)).map(([rel]) => rel);
        if (changed.length) {
          await q("reset role");
          const hashes = [];
          for (const rel of changed) hashes.push(await targetRows(rel));
          await q("rollback to savepoint scope_call");
          await q("reset role");
          for (const [index, rel] of changed.entries()) {
            if ((await targetRows(rel)) !== hashes[index]) kinds.add("write");
          }
          await become(identity);
          before = await writtenTables();
        } else {
          await q("rollback to savepoint scope_call");
          before = after;
        }
        for (const kind of kinds) reached[identity][kind].push(call.entry.sig);
        const unexpected = new Set([...kinds].filter((kind) =>
          (kind === "private" && !MAY_REACH_PRIVATE.has(identity))
          || (kind === "name" && !MAY_REACH_NAME.has(identity))
          || (kind === "write" && !MAY_WRITE.has(identity))));
        if (!failure && !call.entry.exec.split(",").includes(role)) unexpected.add("grant");
        for (const kind of unexpected) observed.push({ fn: call.entry.sig, identity, reach: kind });
        outcomes[identity][failure ? (failure.code === "42501" ? "denied" : "error") : "ok"] += 1;
        perCall[call.entry.sig] ??= {};
        perCall[call.entry.sig][identity] = failure ? `${failure.code} ${failure.message}`.slice(0, 100) : `ok${kinds.size ? ` ${[...kinds].join("+")}` : ""}`;
      }
      await become("owner");
    }

    const report = {
      record: "TEST-UG-PERMISSION-SCOPE-MATRIX-20261110",
      functions: securityDefiners.length,
      called: calls.length,
      uncallable,
      exercisedWithTargetArguments: calls.filter((call) => call.seeded).length,
      unseededParameters: Object.fromEntries(Object.entries(unseeded).toSorted((a, b) => b[1] - a[1])),
      outcomes,
      reached,
      observed: observed.toSorted((a, b) => gapKey(a).localeCompare(gapKey(b))),
      perCall,
    };
    const directory = process.env.DB_ASSURANCE_ARTIFACT_DIR || join(tmpdir(), "permission-scope-matrix");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "permission-scope-matrix.json"), `${JSON.stringify(report, null, 2)}\n`);

    // Every contract security definer was either called six times or is a
    // trigger-only function.
    expect(report.called + uncallable.length).toBe(securityDefiners.length);
    // Positive controls: the detector sees what the unit steward may reach,
    // so a clean result is not a fixture that reaches nothing.
    expect(reached.unitSteward.private.length).toBeGreaterThan(0);
    expect(reached.unitSteward.write.length).toBeGreaterThan(0);
    expect(reached.member.name.length).toBeGreaterThan(0);
    const known = new Set(KNOWN_GAPS.map(gapKey));
    const seenKeys = new Set(observed.map(gapKey));
    expect(observed.filter((item) => !known.has(gapKey(item))).map(gapKey)).toEqual([]);
    expect(KNOWN_GAPS.filter((gap) => !seenKeys.has(gapKey(gap))).map(gapKey)).toEqual([]);
  }, 1_800_000);
});
