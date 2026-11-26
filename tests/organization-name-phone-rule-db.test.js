// @vitest-environment node
//
// BUG-UG-ORGANIZATION-NAME-WITH-A-LOCAL-NUMBER-AND-A-DATE-REFUSED-AS-A-PHONE-NUMBER-20261118 (#9164)
//
// 20261118200200 restates the four functions that keep phone numbers out of
// organization names, each with only its name check changed: a calendar date,
// and a year right after a four or five digit local number, are read as their
// own number before separators are dropped (the migration header says the
// rule in plain words). src/lib/openSignup.js applies the same rule on the
// website. The static half holds each body to its live predecessor except at
// the name check. The live half evaluates the name check exactly as each live
// function carries it against every example, requires the website's answer to
// match, and drives each function end to end. Fictional names only; every
// live case rolls back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { organizationNameProblem } from "../src/lib/openSignup.js";
import { holdsPhoneNumber } from "../src/lib/organizationNamePhoneRule.js";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { ACCEPTED, EXAMPLES, PHONE } from "./helpers/organizationNamePhoneExamples.js";
import {
  account, as, CLAIM_ATTEST, createOrg, expectRefusal, sha256, svc, unverifiedOrg, withClient,
} from "./helpers/openSignupOrganization.js";

const MIGRATION = "20261118200200_organization_name_phone_rule_dates_and_years";
const sql = loadMigrationSql(MIGRATION);

// The SQL pieces of the rule. `u` spells a regular-expression \u escape, so no
// dash character sits in this source file.
const u = (hex) => `\\${"u"}${hex}`;
const SEP_CHARS = `[:space:]().+/_${u("2010")}-${u("2015")}${u("2212")}${u("FF0D")}-`;
const SEP = `[${SEP_CHARS}]`;
const DATE = "(^|[^0-9./-]|[^0-9][./-])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])"
  + "|(0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])[-/.]((19|20)[0-9]{2}|[0-9]{2}))(?![-/.]?[0-9])";
const YEAR = `(^|[^0-9${SEP_CHARS}])(${SEP}*[0-9]{4,5})([[:space:]]+|[[:space:]]*\\()(19|20)[0-9]{2}(?!${SEP}*[0-9])`;
const OLD = (name) => `pg_catalog.regexp_replace(${name}, '${SEP}', '', 'g') ~ '[[:digit:]]{7,}'`;
// The restated check, at any indentation.
const NEW = /pg_catalog\.regexp_replace\(pg_catalog\.regexp_replace\(pg_catalog\.regexp_replace\((\w+),\s+'([^']+)', '\\1\|', 'g'\),\s+'([^']+)', '\\1\\2\|', 'g'\),\s+'([^']+)', '', 'g'\) ~ '\[\[:digit:\]\]\{7,\}'/gu;

const SITES = [
  { fn: "public.create_organization_founder_invitation", names: ["clean_name"], from: "20261003010000_organization_founder_invitations" },
  { fn: "public.create_my_organization", names: ["clean_name"], from: "20261017024400_public_signup_intake_caps_final" },
  { fn: "public.submit_organization_claim", names: ["clean_unlisted_name", "clean_unlisted_city"], from: "20261113123500_bounded_cleanups_pick_rows_once" },
  { fn: "public.set_organization_catalog_placement", names: ["parent_name"], from: "20260930040000_union_catalog_claims_verification" },
];

// The examples are the shared table in tests/helpers/organizationNamePhoneExamples.js.
const body = (definition) => definition.slice(definition.indexOf("$function$") + 10, definition.lastIndexOf("$function$"));

// The new body with each restated check folded back to the old expression,
// and the founder invitation's separate phone branch folded back into its
// first check.
function foldBack(text) {
  const folded = text.replace(NEW, (_, name) => OLD(name));
  return folded.replace(
    "'://') > 0 then\n    raise exception 'invalid founder invitation' using errcode = '22023';\n  end if;\n"
      + "  -- #9164: a name holding a phone number is refused with a detail the\n"
      + "  -- operator command reads, so it can say why in plain words.\n"
      + `  if ${OLD("clean_name")} then\n`
      + "    raise exception 'invalid founder invitation' using errcode = '22023',\n"
      + "      detail = 'organization name holds a phone number';\n  end if;\n",
    `'://') > 0\n     or ${OLD("clean_name")} then\n    raise exception 'invalid founder invitation' using errcode = '22023';\n  end if;\n`,
  );
}

// The founder invitation's predecessor writes the same separator class with
// literal dash characters.
const literalClass = `[[:space:]().+/_${String.fromCodePoint(0x2010)}-${String.fromCodePoint(0x2015)}${String.fromCodePoint(0x2212)}${String.fromCodePoint(0xff0d)}-]`;

describe("organization name phone rule migration (static)", () => {
  it("is one guarded transaction that restates only the four functions", () => {
    expect(sourceTransactionProblem(sql)).toBeNull();
    expect(sql.match(/create\s+(?:or\s+replace\s+)?function\s+/giu)).toHaveLength(4);
    expect(sql).not.toMatch(/^\s*(?:grant|revoke|alter|drop|comment)\s/imu);
    for (const { fn } of SITES) {
      expect(sql).toContain(`raise exception 'unreviewed predecessor: ${fn}' using errcode = '55000';`);
      let expected = fnBody(sql, fn);
      if (fn === "public.create_organization_founder_invitation") {
        // #9273 moves the unchanged global time-expiry maintenance into its
        // private system helper. Keep the exact phone-rule definition pinned
        // apart from that reviewed extraction, including every name guard.
        const start = expected.indexOf("  for expired_row in\n");
        const end = expected.indexOf("  end loop;", start) + "  end loop;".length;
        expect(start).toBeGreaterThan(-1);
        expected = expected.slice(0, start) + "  perform private.expire_member_invitation_email(clean_email);" + expected.slice(end);
        expected = expected.replace("  expired_row public.member_invitations%rowtype;\n", "");
      }
      expect(latestFnBody(fn)).toBe(fnBody(stripComments(expected), fn));
    }
  });

  it("changes each function only at its name check, and every check is the same rule", () => {
    for (const { fn, names, from } of SITES) {
      const after = body(fnBody(sql, fn));
      const checks = [...after.matchAll(NEW)];
      expect(checks.map((match) => match[1]), fn).toEqual(names);
      for (const match of checks) expect([match[2], match[3], match[4]], `${fn} ${match[1]}`).toEqual([DATE, YEAR, SEP]);
      expect(after).not.toContain("~ '[[:digit:]]{7,}' then\n    raise exception 'invalid founder invitation' using errcode = '22023';\n");
      const before = body(fnBody(loadMigrationSql(from), fn)).replace(literalClass, SEP);
      expect(foldBack(after), fn).toBe(before);
    }
  });

  it("guards each predecessor by the md5 of its live definition", () => {
    const guards = [...sql.matchAll(/to_regprocedure\('([^']+)'\)\)\) is distinct from '([0-9a-f]{32})'/gu)].map((match) => match[1].split("(")[0]);
    expect(guards).toEqual(SITES.map(({ fn }) => fn));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

async function readOnly(run) {
  const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "organization-name-phone-rule-proof" });
  await c.connect();
  await c.query("begin read only");
  try {
    return await run(c);
  } finally {
    await c.query("rollback");
    await c.end();
  }
}

live("the organization name phone rule on a disposable database", () => {
  it("each live name check gives the website's answer for every example", async () => {
    const website = EXAMPLES.map(([name]) => holdsPhoneNumber(name));
    expect(website).toEqual(EXAMPLES.map(([, holds]) => holds));
    expect(EXAMPLES.map(([name]) => organizationNameProblem(name) === "characters")).toEqual(website);
    expect(EXAMPLES.map(([name]) => holdsPhoneNumber(name, { anyScriptDigits: true }))).toEqual(website);
    await readOnly(async (c) => {
      for (const { fn, names } of SITES) {
        const definition = (await c.query("select pg_catalog.pg_get_functiondef(pg_catalog.to_regproc($1)) as d", [fn])).rows[0].d;
        const checks = [...definition.matchAll(NEW)];
        expect(checks.map((match) => match[1]), fn).toEqual(names);
        for (const [expression, name] of checks) {
          const query = `select (${expression.replace(`regexp_replace(${name},`, "regexp_replace($1::text,")}) as v`;
          const answers = [];
          for (const [example] of EXAMPLES) answers.push((await c.query(query, [example])).rows[0].v);
          expect(answers, `${fn} ${name}`).toEqual(website);
        }
      }
    });
  });

  it("no live function keeps the old seven-digit check", async () => {
    await readOnly(async (c) => {
      const { rows } = await c.query(`select n.nspname || '.' || p.proname as fn, pg_catalog.pg_get_functiondef(p.oid) as d
        from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prokind = 'f'
          and pg_catalog.strpos(pg_catalog.pg_get_functiondef(p.oid), '[[:digit:]]{7,}') > 0`);
      const carriers = rows.map((row) => row.fn).sort();
      expect(carriers).toEqual(SITES.map(({ fn }) => fn).sort());
      for (const row of rows) {
        const all = row.d.split("[[:digit:]]{7,}").length - 1;
        expect([...row.d.matchAll(NEW)].length, row.fn).toBe(all);
      }
    });
  });

  it("the founder invitation accepts the record's names and says why it refuses a phone number", async () => {
    await withClient(async (c) => {
      const invite = (name) => svc(c, "public.create_organization_founder_invitation($1,$2,$3,$4,$5,$6)", [
        name, `founder-${randomUUID()}@example.invalid`, "Example Founder", "en", sha256(randomUUID()), randomUUID(),
      ]);
      for (const name of ACCEPTED) {
        expect(await invite(name), name).toMatchObject({ status: "invited" });
        expect((await c.query("select count(*)::int as n from public.organizations where name = $1", [name])).rows[0].n).toBe(1);
      }
      for (const name of PHONE) {
        const error = await expectRefusal(invite(name), "22023", "invalid founder invitation");
        expect(error.detail, name).toBe("organization name holds a phone number");
        expect((await c.query("select count(*)::int as n from public.organizations where name = $1", [name])).rows[0].n).toBe(0);
      }
      // Other malformed names keep the plain refusal with no phone detail.
      const other = await expectRefusal(invite("Example Union @ home"), "22023", "invalid founder invitation");
      expect(other.detail).toBeUndefined();
    });
  });

  it("the self-serve organization form accepts the record's names and refuses the phone numbers", async () => {
    for (const name of [...ACCEPTED, ...PHONE]) {
      await withClient(async (c) => {
        const who = await account(c);
        await as(c, who);
        if (ACCEPTED.includes(name)) expect(await createOrg(c, name), name).toMatchObject({ status: "created" });
        else await expectRefusal(createOrg(c, name), "22023", "invalid organization");
      });
    }
  });

  it("the catalog's unlisted organization name and city follow the same rule", async () => {
    for (const name of [...ACCEPTED, ...PHONE]) {
      await withClient(async (c) => {
        const shell = await unverifiedOrg(c);
        const submit = (unlisted) => svc(c, "public.submit_organization_claim($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10)", [
          sha256(`claim-net-${randomUUID()}`), sha256(`claim-email-${randomUUID()}`), null, JSON.stringify(unlisted),
          JSON.stringify({ name: "Alex Fixtureperson", title: "Secretary-Treasurer", email: `officer-${randomUUID()}@example.invalid`, statement: "" }),
          JSON.stringify(CLAIM_ATTEST), "en", sha256(`claim-token-${randomUUID()}`), shell.admin.user, shell.org,
        ]);
        if (ACCEPTED.includes(name)) {
          expect(await submit({ name, state: "OR" }), name).toEqual({ accepted: true, deliver: true });
        } else {
          await expectRefusal(submit({ name, state: "OR" }), "22023", "claim target invalid");
          await expectRefusal(submit({ name: "Example Unlisted Council", city: name, state: "OR" }), "22023", "claim target invalid");
        }
      });
    }
  });

  it("the catalog placement's unlisted parent name follows the same rule", async () => {
    for (const name of [...ACCEPTED, ...PHONE]) {
      await withClient(async (c) => {
        const shell = await unverifiedOrg(c);
        await as(c, shell.admin);
        const place = asCaller(c, "public.set_organization_catalog_placement($1,$2,$3,$4,$5,$6,$7)", ["admin", shell.org, null, name, "OR", false, randomUUID()]);
        if (ACCEPTED.includes(name)) expect(await place, name).toBeTruthy();
        else await expectRefusal(place, "22023", "placement name invalid");
      });
    }
  });
});

// One statement as the authenticated caller whose claims are already set,
// inside a savepoint.
async function asCaller(c, statement, params) {
  await c.query("savepoint placement_call");
  try {
    await c.query("set local role authenticated");
    const result = (await c.query(`select ${statement} as r`, params)).rows[0].r;
    await c.query("reset role");
    await c.query("release savepoint placement_call");
    return result;
  } catch (error) {
    await c.query("rollback to savepoint placement_call");
    await c.query("release savepoint placement_call");
    throw error;
  }
}
