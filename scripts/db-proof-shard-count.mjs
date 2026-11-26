import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dbProofShardCount } from "./run-required-db-proofs.mjs";

// The scope job runs this from the trusted base checkout to size the db job's
// matrix: usage `node db-proof-shard-count.mjs <NUL-separated changed paths>`,
// with GITHUB_EVENT_NAME set. It prints the matrix's shard indexes as JSON,
// [0] for one job or [0,1,2,3] for four.
//
// Since rollout stage 2 (record #8089 follow-up) every whole plan gets
// DB_PROOF_SHARDS_FOR_WHOLE_PLAN jobs and a related pull-request plan one;
// stage 2's own pull-request run proved the four-job lane before Main took it.
export function dbProofShardMatrix(event, changed) {
  return JSON.stringify(Array.from({ length: dbProofShardCount(event, changed) }, (_, index) => index));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pathsFile] = process.argv.slice(2);
  const event = (process.env.GITHUB_EVENT_NAME ?? "").trim();
  if (!pathsFile || !event) throw new Error("usage: GITHUB_EVENT_NAME=<event> node scripts/db-proof-shard-count.mjs <NUL-separated changed paths>");
  process.stdout.write(`${dbProofShardMatrix(event, readFileSync(pathsFile, "utf8").split("\0").filter(Boolean))}\n`);
}
