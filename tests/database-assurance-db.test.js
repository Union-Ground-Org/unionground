// @vitest-environment node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { advisorFindings, lintFindings, compareFindings, validateScanTarget } from "../scripts/lib/database-assurance-policy.mjs";
import { prepareAdvisorTarget } from "../scripts/run-database-assurance.mjs";

const enabled = process.env.RUN_DATABASE_ASSURANCE_DB_TESTS === "1";
describe.skipIf(!enabled)("real disposable database assurance regression probes", () => {
  const prefix = `assurance_probe_${randomBytes(6).toString("hex")}`;
  let client;
  let status;
  const cli = (args) => {
    const result = spawnSync(resolve("node_modules/.bin/supabase"), ["--workdir", process.env.CI_DB_WORKDIR, ...args], {
      encoding: "utf8", timeout: 90000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    if (result.status !== 0) throw new Error("Disposable scanner probe command failed; raw output withheld");
    return JSON.parse(result.stdout);
  };
  const scan = () => {
    const advisors = cli(["db", "advisors", "--local", "--type", "all", "--level", "info", "--fail-on", "none", "--output-format", "json"]);
    const lint = cli(["db", "lint", "--local", "--schema", "public,private", "--level", "warning", "--fail-on", "none", "--output-format", "json"]);
    return { advisors, findings: [...advisorFindings(advisors), ...lintFindings(lint)] };
  };
  beforeAll(async () => {
    const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    if (!process.env.CI_DB_WORKDIR) throw new Error("Owned disposable CI_DB_WORKDIR required");
    status = cli(["status", "--output", "json"]);
    validateScanTarget(databaseUrl, status);
    await prepareAdvisorTarget(databaseUrl, status, readFileSync("supabase/config.toml", "utf8"));
    client = new pg.Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
  });
  afterAll(async () => { if (client) await client.end(); });

  const fixtureCounts = async () => (await client.query(`select
    (select count(*)::int from auth.users) as users,
    (select count(*)::int from public.organizations where slug like 'rls-%') as organizations,
    (select count(*)::int from public.chapters where id like 'rls-%') as chapters,
    (select count(*)::int from public.dues_member_subjects s join public.organizations o on o.id=s.organization_id where o.slug like 'rls-%') as dues_subjects
  `)).rows[0];

  it("passes all real RLS assertions and removes its tenant, detached dues subjects and identities", async () => {
    const before = await fixtureCounts();
    const result = spawnSync(process.execPath, ["scripts/verify-disposable-rls.mjs"], {
      encoding: "utf8", timeout: 90000,
      env: { PATH: process.env.PATH, SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, SUPABASE_DB_URL: status.DB_URL,
        RLS_DISPOSABLE_CONFIRM: "owned-ci-database" },
    });
    expect(result.status, "normal RLS proof must complete including fixture cleanup").toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("passed");
    expect(report.checks.length).toBeGreaterThanOrEqual(11);
    expect((await client.query("select count(*)::int as count from public.member_ai_requests")).rows[0].count).toBe(0);
    expect(await fixtureCounts()).toEqual(before);
  }, 100000);

  it("fails the real RLS runner on an injected cross-user read policy and cleans its identities", async () => {
    const before = await fixtureCounts();
    await client.query(`create policy ${prefix} on public.member_guide_threads for select to authenticated using (true)`);
    try {
      const result = spawnSync(process.execPath, ["scripts/verify-disposable-rls.mjs"], {
        encoding: "utf8", timeout: 90000,
        env: { PATH: process.env.PATH, SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, SUPABASE_DB_URL: status.DB_URL,
          RLS_DISPOSABLE_CONFIRM: "owned-ci-database" },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cross-user guide thread read was allowed");
      expect((await client.query("select count(*)::int as count from public.member_ai_requests")).rows[0].count).toBe(0);
      expect(await fixtureCounts()).toEqual(before);
    } finally {
      await client.query(`drop policy ${prefix} on public.member_guide_threads`);
    }
  }, 100000);

  it("detects real RLS, definer-view, search-path and compiler regressions, then returns to baseline", async () => {
    const baseline = JSON.parse(readFileSync("config/database-assurance-baseline.json", "utf8")).findings;
    await client.query(`
      create table public.${prefix} (id bigint);
      grant select on public.${prefix} to anon, authenticated;
      create view public.${prefix}_view as select id from public.${prefix};
      grant select on public.${prefix}_view to anon, authenticated;
      create function public.${prefix}_function() returns integer language plpgsql security definer
      as $$ begin return (select missing from public.${prefix}_absent); end $$;
    `);
    try {
      const { advisors, findings } = scan();
      const rules = advisors.results.filter((row) => JSON.stringify(row).includes(prefix)).map((row) => row.name);
      expect(rules).toEqual(expect.arrayContaining(["rls_disabled_in_public", "security_definer_view", "function_search_path_mutable"]));
      const difference = compareFindings(findings, baseline);
      expect(difference.added.length).toBeGreaterThanOrEqual(4);
      expect(findings.some((row) => row.kind === "lint" && difference.added.includes(row.id))).toBe(true);
    } finally {
      await client.query(`drop view public.${prefix}_view; drop function public.${prefix}_function(); drop table public.${prefix};`);
    }
    expect(compareFindings(scan().findings, baseline)).toEqual({ added: [], removed: [] });
  }, 180000);
});
