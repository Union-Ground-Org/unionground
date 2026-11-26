import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { advisorFindings, lintFindings, compareFindings, rejectBaselineExpansion, validateScanTarget, configuredApiSchemas } from "./lib/database-assurance-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "config/database-assurance-baseline.json";
const CLI = join(ROOT, "node_modules/.bin/supabase");

function childEnvironment() {
  // Local CLI commands need no hosted token, database URL, browser key or
  // application secret inherited from the caller.
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}
function command(executable, args, { env = childEnvironment(), timeout = 180000 } = {}) {
  const result = spawnSync(executable, args, { cwd: ROOT, env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    const keyProof = args[0] === "--test" && args[1] === "tests/pin-key-mfa-postgres.node-test.mjs";
    const marker = keyProof ? `${result.stdout || ""}\n${result.stderr || ""}`.match(/KEY_MFA_PROOF_FAILURE stage=(container-start|container-port|database-connect|schema-setup|candidate-migration|security-assertions) code=([0-9A-Z]{5}|none) exit=(-?\d+|none)/)?.[0] : null;
    const detail = marker ? `; ${marker}` : "";
    throw new Error(`Database assurance ${basename(executable)} command failed (exit ${result.status ?? "none"})${detail}; raw output withheld`);
  }
  return result.stdout;
}
function git(args) { return command("git", args).trim(); }
function cli(workdir, args) {
  return JSON.parse(command(CLI, ["--workdir", workdir, ...args, "--output-format", "json"]));
}
function migrationDigest(directory) {
  const hash = createHash("sha256");
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    hash.update(name).update("\0").update(readFileSync(join(directory, name))).update("\0");
  }
  return hash.digest("hex");
}

export async function prepareAdvisorTarget(databaseUrl, status, config) {
  validateScanTarget(databaseUrl, status);
  const schemas = configuredApiSchemas(config);
  // Local PostgREST gets schemas from config/env. CLI Advisors instead reads
  // this GUC; without it, exposed-table and definer-view checks silently vanish.
  // Only this owned disposable postgres database receives the matching setting.
  // Supabase reserves pgrst.* to its local administrator. Bind the immutable
  // container id to this project's label and published database port before
  // using that role; never use a hosted connection or change a role grant.
  const projectId = process.env.CI_DB_PROJECT_ID;
  if (!/^unionground-lab-ci-[a-f0-9]{12}$/.test(projectId ?? "")) throw new Error("Owned disposable project identity required");
  const inspected = JSON.parse(command("docker", ["inspect", "--format", '[{{json .Id}},{{json .NetworkSettings.Ports}},{{json .Config.Labels}}]', `supabase_db_${projectId}`]));
  const [containerId, ports, labels] = inspected;
  if (!/^[a-f0-9]{64}$/.test(containerId ?? "") || labels?.["com.supabase.cli.project"] !== projectId
      || !ports?.["5432/tcp"]?.length || ports["5432/tcp"].some((binding) => binding.HostPort !== new URL(databaseUrl).port)) {
    throw new Error("Disposable database container does not match the verified target");
  }
  command("docker", ["exec", containerId, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `alter database postgres set pgrst.db_schemas = '${schemas.join(",")}'`]);
  return schemas;
}

export async function main() {
  const workdirValue = process.env.CI_DB_WORKDIR;
  const tempRoot = realpathSync(process.env.RUNNER_TEMP || tmpdir());
  if (!workdirValue || !isAbsolute(workdirValue)) throw new Error("Owned disposable CI_DB_WORKDIR is required");
  const workdir = realpathSync(workdirValue);
  if (!workdir.startsWith(`${tempRoot}/unionground-lab-ci-`)
      || !/^unionground-lab-ci-[a-f0-9]{12}$/.test(process.env.CI_DB_PROJECT_ID ?? "")
      || existsSync(join(workdir, "supabase/.temp/project-ref"))) {
    throw new Error("Refusing a shared or hosted-linked database assurance workdir");
  }
  const config = readFileSync(join(workdir, "supabase/config.toml"), "utf8");
  const rootConfig = config.split(/^\[/m)[0];
  if (!rootConfig.split("\n").includes(`project_id = "${process.env.CI_DB_PROJECT_ID}"`)) throw new Error("Disposable project identity mismatch");
  // Independent pinned PostgreSQL fixture proves the security-critical key
  // session boundary without inheriting hosted credentials or database URLs.
  command(process.execPath, ["--test", "tests/pin-key-mfa-postgres.node-test.mjs"]);
  command(process.execPath, ["--test", "tests/event-notification-email.node-test.mjs"]);
  const migrationsSha256 = migrationDigest(join(ROOT, "supabase/migrations"));
  if (migrationsSha256 !== migrationDigest(join(workdir, "supabase/migrations"))) throw new Error("Disposable migration files differ from candidate source");
  const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8"));
  if (baseline.version !== 1 || !/^[a-f0-9]{40}$/.test(baseline.sourceSha ?? "")) throw new Error("Invalid database assurance baseline provenance");
  const version = command(CLI, ["--version"]).trim();
  if (version !== baseline.supabaseCliVersion) throw new Error("Database assurance CLI version differs from reviewed baseline");
  const sourceSha = git(["rev-parse", "--verify", `${process.env.ASSURANCE_HEAD_SHA || "HEAD"}^{commit}`]);
  const baseSha = git(["rev-parse", "--verify", `${process.env.ASSURANCE_BASE_REF || "origin/main"}^{commit}`]);
  // A synthetic PR checkout must still contain exactly the source named by CI.
  if (git(["show", `${sourceSha}:${BASELINE}`]) !== readFileSync(join(ROOT, BASELINE), "utf8").trim()
      || git(["diff", "--name-only", sourceSha, "--", "supabase/migrations", BASELINE, "scripts/verify-disposable-rls.mjs", "scripts/run-database-assurance.mjs", "scripts/lib/database-assurance-policy.mjs", "package.json"])) {
    throw new Error("Database assurance source differs from its declared SHA");
  }
  const baseHasBaseline = git(["ls-tree", "--name-only", baseSha, "--", BASELINE]) === BASELINE;
  if (baseHasBaseline) {
    const trusted = JSON.parse(git(["show", `${baseSha}:${BASELINE}`]));
    rejectBaselineExpansion(baseline.findings, trusted.findings);
  } else {
    git(["merge-base", "--is-ancestor", baseline.sourceSha, baseSha]);
    if (git(["diff", "--name-only", baseline.sourceSha, baseSha, "--", "supabase/migrations", "supabase/config.toml"])
        || git(["diff", "--name-only", baseSha, sourceSha, "--", "supabase/migrations", "supabase/config.toml"])) {
      throw new Error("Initial database baseline does not describe the trusted migration tree");
    }
  }

  const status = JSON.parse(command(CLI, ["--workdir", workdir, "status", "--output", "json"]));
  validateScanTarget(process.env.SUPABASE_DB_URL, status);
  const apiSchemas = await prepareAdvisorTarget(process.env.SUPABASE_DB_URL, status, config);
  const rls = JSON.parse(command(process.execPath, ["scripts/verify-disposable-rls.mjs"], { env: {
    ...childEnvironment(), SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, SUPABASE_DB_URL: status.DB_URL,
    RLS_DISPOSABLE_CONFIRM: "owned-ci-database",
  } }));
  if (rls.status !== "passed" || !Array.isArray(rls.checks) || rls.checks.length < 11) throw new Error("Incomplete RLS behavior proof");
  const advisors = cli(workdir, ["db", "advisors", "--local", "--type", "all", "--level", "info", "--fail-on", "none"]);
  // CLI lint enables plpgsql_check inside a transaction and rolls it back.
  // Independently prove that compiler detects a known error, also rolled back.
  const lint = cli(workdir, ["db", "lint", "--local", "--schema", "public,private", "--level", "warning", "--fail-on", "none"]);
  const client = new pg.Client({ connectionString: status.DB_URL, ssl: false });
  let compiler;
  try {
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout='15s'");
    await client.query("create extension if not exists plpgsql_check");
    compiler = (await client.query("select extversion from pg_extension where extname='plpgsql_check'")).rows[0]?.extversion;
    await client.query("create function pg_temp.db_assurance_compiler_probe() returns void language plpgsql as $$ begin perform db_assurance_nonexistent_column from pg_catalog.pg_class; end $$");
    const probe = await client.query("select count(*)::int as errors from plpgsql_check_function_tb('pg_temp.db_assurance_compiler_probe()'::regprocedure) where sqlstate='42703' and level='error'");
    if (probe.rows[0]?.errors !== 1) throw new Error("plpgsql_check did not detect the controlled compiler regression");
    await client.query("rollback");
  } finally { await client.end(); }
  if (!compiler) throw new Error("plpgsql_check compiler is unavailable");
  const findings = [...advisorFindings(advisors), ...lintFindings(lint)].sort((a, b) => a.id.localeCompare(b.id));
  const difference = compareFindings(findings, baseline.findings);
  const artifact = {
    version: 1, sourceSha, baseSha, migrationsSha256, apiSchemas, supabaseCliVersion: version, plpgsqlCheckVersion: compiler,
    baselineSha256: createHash("sha256").update(readFileSync(join(ROOT, BASELINE))).digest("hex"),
    rlsChecks: rls.checks.length, advisorInfoCount: advisors.results.filter((entry) => entry.level === "INFO").length,
    findings, ...difference, status: difference.added.length || difference.removed.length ? "failed" : "passed",
  };
  const artifactDir = process.env.DB_ASSURANCE_ARTIFACT_DIR || join(workdir, "assurance-artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "database-assurance.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  if (artifact.status !== "passed") throw new Error(`Database assurance ratchet failed: ${difference.added.length} new or increased, ${difference.removed.length} resolved or reduced findings`);
  console.log(`PASS: ${rls.checks.length} RLS checks, Advisor and plpgsql_check lint ratchets; ${findings.length} known finding identities, no regressions.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
