// One step of the public-table grant probe on the disposable stack
// (scripts/lib/public-table-grant-probe.mjs; docs/conventions/public-table-grants.md).
//
//   node scripts/grant-probe-step.mjs revoke|restore|hosted [migration.sql]
//
// revoke saves postgres's default table privileges in public for the three
// Data API roles to $CI_DB_WORKDIR/grant-probe-defaults.json, revokes them and
// records the OID boundary; restore puts the saved defaults back. The hosted
// step rehearses a held file and rolls it back before the CLI apply. All connect
// to $SUPABASE_DB_URL, which must be a disposable proof URL.
import pg from "pg";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { HELD_BACK_DIRECTORY, restoreDefaultTableGrants, revokeDefaultTableGrants } from "./lib/public-table-grant-probe.mjs";
import { probeHostedMigration } from "./lib/hosted-migration-probe.mjs";

export async function grantProbeStep(step, env = process.env, file) {
  if (!["revoke", "restore", "hosted"].includes(step)) throw new Error("usage: node scripts/grant-probe-step.mjs revoke|restore|hosted [migration.sql]");
  const workdir = env.CI_DB_WORKDIR;
  if (!workdir || !isAbsolute(workdir)) throw new Error("CI_DB_WORKDIR must be an absolute disposable workdir");
  const savedPath = join(workdir, "grant-probe-defaults.json");
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(env.SUPABASE_DB_URL) });
  await client.connect();
  try {
    if (step === "revoke") {
      if (existsSync(savedPath)) throw new Error("grant probe: defaults already revoked in this workdir");
      writeFileSync(savedPath, `${JSON.stringify(await revokeDefaultTableGrants(client))}\n`, { flag: "wx" });
    } else if (step === "hosted") {
      if (!/^\d{14}_[a-z0-9_]+\.sql$/u.test(file ?? "") || !(env.CI_DB_GRANT_PROBE_ADDED ?? "").split(",").includes(file)) {
        throw new Error("hosted probe requires one added migration filename");
      }
      const source = readFileSync(join(workdir, HELD_BACK_DIRECTORY, file), "utf8");
      try {
        const elapsedMs = await probeHostedMigration(client, source, file);
        console.log(`Hosted migration probe ${file}: PASS (${elapsedMs} ms, rolled back)`);
      } catch (error) {
        throw new Error(`Hosted migration probe ${file}: ${error.code ?? ""} ${error.message}`, { cause: error });
      }
    } else {
      await restoreDefaultTableGrants(client, JSON.parse(readFileSync(savedPath, "utf8")));
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await grantProbeStep(process.argv[2], process.env, process.argv[3]); } catch (error) { console.error(`grant-probe-step: ${error.code ? `${error.code} ` : ""}${error.message}`); process.exitCode = 1; }
}
