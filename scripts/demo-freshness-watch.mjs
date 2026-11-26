#!/usr/bin/env node
// Demo freshness watch (.github/workflows/demo-freshness-watch.yml;
// docs/contracts/demo-deploy.md). Adapted from the sibling repository's
// production freshness watch without its Vercel deployment lookup: that needs
// a Vercel token or Vercel's GitHub deployments, and this repository has
// neither, so it reads what the demo serves publicly instead. Every hostname
// in config/demo-deploy.json must serve the same build-info.json commit, and
// that commit must be on main's first-parent history in the fetched window.
// After the Git cutover (deploySource "git") every main commit deploys, so the
// run fails when the oldest main commit the demo does not serve yet has been
// on main for more than staleAfterMinutes. While the demo is deployed by hand
// it only reports how far behind it is. Anything it cannot prove fails.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDemoDeployConfig } from "./lib/demo-site.mjs";

const EXACT_SHA = /^[0-9a-f]{40}$/;

// commits: main's first-parent commits after the served one, oldest first,
// as { sha, committedAt } in epoch milliseconds.
export function decideFreshness({ now, deploySource, servedSha, commits, staleAfterMinutes }) {
  if (commits.length === 0) return { stale: false, reason: `the demo serves main's tip ${servedSha}` };
  const oldest = commits[0];
  const minutes = Math.floor((now - oldest.committedAt) / 60000);
  const behind = `the demo serves ${servedSha}, ${commits.length} commits behind main; the oldest it lacks, ${oldest.sha}, has been on main for ${minutes} minutes`;
  if (deploySource !== "git") return { stale: false, reason: `${behind}. It is deployed by hand until the Git cutover, so this is reported, not enforced` };
  return minutes > staleAfterMinutes
    ? { stale: true, reason: `${behind}, more than the ${staleAfterMinutes} allowed` }
    : { stale: false, reason: `${behind}, within the ${staleAfterMinutes} allowed` };
}

// stamps: [{ hostname, commitSha }] read from each hostname's build-info.json.
export function servedCommit(stamps) {
  const shas = [...new Set(stamps.map((stamp) => stamp.commitSha))];
  for (const stamp of stamps) {
    if (!EXACT_SHA.test(stamp.commitSha ?? "")) return { error: `${stamp.hostname} serves no exact commit in build-info.json` };
  }
  if (shas.length !== 1) return { error: `the hostnames serve different commits: ${stamps.map((stamp) => `${stamp.hostname} ${stamp.commitSha}`).join(", ")}` };
  return { sha: shas[0] };
}

export async function readStamp(hostname, fetchImpl = fetch) {
  const response = await fetchImpl(`https://${hostname}/build-info.json?watch=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${hostname}/build-info.json answered ${response.status}`);
  const { commitSha } = await response.json();
  return { hostname, commitSha };
}

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commitsAfter(servedSha) {
  try {
    git(["cat-file", "-e", `${servedSha}^{commit}`]);
  } catch {
    throw new Error(`${servedSha} is not in main's fetched history: it is older than the window or not a main commit`);
  }
  try {
    git(["merge-base", "--is-ancestor", servedSha, "HEAD"]);
  } catch {
    throw new Error(`${servedSha} is not on main: the demo serves a commit main does not contain`);
  }
  const lines = git(["log", "--first-parent", "--reverse", "--format=%H %ct", `${servedSha}..HEAD`]);
  return lines ? lines.split("\n").map((line) => {
    const [sha, seconds] = line.split(" ");
    return { sha, committedAt: Number(seconds) * 1000 };
  }) : [];
}

async function main() {
  const config = readDemoDeployConfig();
  const stamps = await Promise.all(config.hostnames.map(readStamp));
  const served = servedCommit(stamps);
  if (served.error) throw new Error(served.error);
  const decision = decideFreshness({
    now: Date.now(),
    deploySource: config.deploySource,
    servedSha: served.sha,
    commits: commitsAfter(served.sha),
    staleAfterMinutes: config.staleAfterMinutes,
  });
  return decision;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let line;
  let failed;
  try {
    const decision = await main();
    failed = decision.stale;
    line = `${decision.stale ? "Stale" : "OK"}: ${decision.reason}.`;
  } catch (error) {
    failed = true;
    line = `Cannot prove the demo is fresh: ${error.message}.`;
  }
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  process.exitCode = failed ? 1 : 0;
}
