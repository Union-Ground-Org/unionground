import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PROOF_FILES } from "./run-required-db-proofs.mjs";

// Decides whether ci.yml's `db` lane runs for a change. The lane starts two
// disposable Supabase labs from main's physical baseline (or replays every
// migration into each) and runs the required database proofs, the contract
// and the migration history: the slowest lane by far. The sibling repository selects it by the same kind of
// path list (scripts/classify-ci-worklist-change.mjs, isDatabase); these are
// the inputs that can change what the replay proves here.
//
// Dependency manifests are deliberately not inputs, as in the sibling
// repository: the one dependency that changes the replay is the pinned
// `supabase` CLI, and its version is held to config/database-assurance-baseline.json
// by the repository conventions check, so bumping it touches that file.
// Renaming a proof script inside package.json alone does not select the lane;
// the script files below do.
export function isDatabaseInput(path) {
  return path === ".github/workflows/ci.yml"
    || path === "supabase/config.toml"
    || path.startsWith("supabase/migrations/")
    || path === "scripts/db-contract.json"
    || path === "config/database-assurance-baseline.json"
    // The real ClamAV upload pipeline proof covers this code even though none
    // of it is SQL.
    || path === "api/private-files.js"
    || /^api\/_lib\/privateFile[A-Za-z]*\.js$/.test(path)
    || path === "api/_lib/memberInvitations.js"
    || path === "scripts/prepare-private-file-scanner-proof.mjs"
    // Every proof file and the helpers they share, including new ones and the
    // planned files not named *-db.test.js.
    || /^tests\/.+-db\.test\.[cm]?[jt]sx?$/u.test(path)
    || PROOF_FILES.includes(path)
    || path.startsWith("tests/helpers/")
    || /^scripts\/(?:ci-db-scope|prepare-ci-disposable-db|start-disposable-db-stack|start-sensitive-proof-stack|run-required-db-proofs|verify-db-contract|verify-migration-history|physical-db-baseline|fetch-physical-db-baseline)\.mjs$/.test(path)
    || /^scripts\/lib\/(?:assert-exact-target|required-db-proof-outcome|required-database-url|sql-text|physical-db-baseline)\.mjs$/.test(path)
    || /^tests\/(?:ci-db-scope|db-contract|migration-history-guard|required-db-proof-runner|start-sensitive-proof-stack|physical-db-baseline)\.test\.js$/.test(path);
}

// `paths` is git's NUL-separated name list. No list at all (an unreadable
// base, a first push) selects the lane: when the answer is unknown, prove.
export function databaseLaneSelected(paths) {
  if (paths === null) return true;
  return paths.split("\0").filter(Boolean).some(isDatabaseInput);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pathsFile] = process.argv.slice(2);
  let paths = null;
  try {
    if (pathsFile) paths = readFileSync(pathsFile, "utf8");
  } catch {
    paths = null;
  }
  const selected = databaseLaneSelected(paths);
  const line = `db_changed=${selected}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}
