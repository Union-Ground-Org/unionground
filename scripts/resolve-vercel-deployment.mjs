#!/usr/bin/env node
// Which Production deployment of the public demo serves a main commit
// (docs/contracts/demo-deploy.md, "Deployments and deploy notes"). Ported on
// November 13, 2026 from the sibling repository's resolver, adapted to this
// repository's one Vercel project (config/demo-deploy.json). The sibling's
// resolver picks the deployment built from one exact commit; here a commit
// with no deployment of its own is still live once a later deployment of main
// contains it, so the question is ancestry, not equality. It reads only what a
// workflow gets for free: GitHub's deployments and their statuses (Vercel's
// GitHub integration writes them once the project is connected to Git) through
// the run's own token, and build-info.json on the demo's hostnames. No Vercel
// token, no secret.
//
//   node scripts/resolve-vercel-deployment.mjs <commit>
//
// prints one line saying whether the commit is served, by which deployment,
// and if not, why: its deployment failed, Vercel skipped its build (an
// earlier deployment still serves), it is still building, or nothing carries
// it yet. Exit 0 when served, 2 when not, 1 when it cannot tell. With
// GITHUB_OUTPUT set it also writes state=, deployment= and served=.
// GH_TOKEN (or the gh session) reads the GitHub API through the gh CLI.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDemoDeployConfig } from "./lib/demo-site.mjs";
import { readStamp, servedCommit } from "./demo-freshness-watch.mjs";

// The repository whose deployments are read; REPOSITORY overrides it.
export const REPOSITORY = "Union-Ground-Org/unionground";

// One GitHub REST call through the gh CLI (GH_TOKEN or the gh session).
export function ghApi(method, path, body, { paginate = false } = {}) {
  const args = ["api", "--method", method, path];
  if (paginate) args.push("--paginate", "--slurp");
  if (body !== undefined) args.push("--input", "-");
  const output = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    input: body === undefined ? undefined : JSON.stringify(body) });
  const parsed = output ? JSON.parse(output) : null;
  return paginate ? parsed.flat() : parsed;
}

const EXACT_SHA = /^[0-9a-f]{40}$/u;

// The GitHub App identity Vercel's Git integration creates deployments and
// statuses as. Anything else in the Production environment is not Vercel's.
export const VERCEL_BOT = Object.freeze({ login: "vercel[bot]", id: 35613825, type: "Bot" });

// Vercel names the GitHub environment "Production" for a repository with one
// connected project, and "Production – <project>" when several share it. The
// project name is the deployment's own (config/demo-deploy.json, empty in the
// repository), so the second name exists only once one is set.
export function productionEnvironments(config = readDemoDeployConfig()) {
  const project = String(config.vercel?.project ?? "").trim();
  return Object.freeze(project ? ["Production", `Production – ${project}`] : ["Production"]);
}

const byVercel = (actor) => actor?.login === VERCEL_BOT.login && actor?.id === VERCEL_BOT.id && actor?.type === VERCEL_BOT.type;

// A Production deployment that Vercel created for an exact commit.
export function isVercelProductionDeployment(deployment, environments = productionEnvironments()) {
  return Boolean(deployment) && environments.includes(deployment.environment) && deployment.task === "deploy"
    && EXACT_SHA.test(deployment.sha ?? "") && byVercel(deployment.creator)
    && Number.isSafeInteger(deployment.id) && deployment.id > 0;
}

// What a deployment's statuses (any order) say happened to it:
//   succeeded  a success status by Vercel (a later inactive one only means a
//              newer deployment replaced it);
//   failed     a failure or error and never a success;
//   skipped    only inactive: Vercel cancelled it because the Ignored Build
//              Step said there was nothing to build, so an earlier deployment
//              still serves;
//   pending    queued, pending or in progress so far;
//   none       no status Vercel wrote.
export function deploymentOutcome(statuses) {
  const states = new Set((Array.isArray(statuses) ? statuses : []).filter((status) => byVercel(status?.creator)).map((status) => status.state));
  if (states.has("success")) return "succeeded";
  if (states.has("failure") || states.has("error")) return "failed";
  if (states.size === 0) return "none";
  if ([...states].every((state) => state === "inactive")) return "skipped";
  return "pending";
}

const newestFirst = (left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "") || right.id - left.id;

// Whether `ancestor` is `descendant` or behind it, by GitHub's compare. Page 2
// of one-per-page carries the status and merge base without the patch body.
export function commitContains({ api, repository = REPOSITORY, ancestor, descendant }) {
  if (ancestor === descendant) return true;
  const compare = api("GET", `repos/${repository}/compare/${ancestor}...${descendant}?per_page=1&page=2`);
  return (compare?.status === "ahead" || compare?.status === "identical") && compare?.merge_base_commit?.sha === ancestor;
}

// The decision, from data already read. `production` is the Vercel Production
// deployments, `outcomes` maps a deployment id to deploymentOutcome, `servedSha`
// is what the hostnames serve (null when it could not be read) and
// `contains(ancestor, descendant)` answers ancestry.
export function resolveServingDeployment({ sha, production, outcomes, servedSha = null, contains }) {
  if (!EXACT_SHA.test(sha ?? "")) throw new Error("the commit must be an exact 40-character SHA");
  const deployments = [...production].sort(newestFirst);
  const outcome = (deployment) => outcomes.get(deployment.id) ?? "none";
  const current = deployments.find((deployment) => outcome(deployment) === "succeeded") ?? null;
  // What serves now: the hostnames' build-info.json when it was read, else the
  // newest successful Production deployment.
  const servingSha = servedSha ?? current?.sha ?? null;
  const serving = servingSha ? deployments.find((deployment) => deployment.sha === servingSha && outcome(deployment) === "succeeded") ?? null : null;
  if (servingSha && contains(sha, servingSha)) {
    return { state: "served", sha, servedSha: servingSha, deployment: serving,
      reason: `${sha} is live: the demo serves ${servingSha}${serving ? ` (Production deployment ${serving.id})` : ""}, which contains it` };
  }
  const still = servingSha ? `; the demo still serves ${servingSha}, which does not contain it` : "; no successful Production deployment was found";
  const own = deployments.find((deployment) => deployment.sha === sha) ?? null;
  const state = own ? outcome(own) : "none";
  if (state === "failed") return { state: "failed", sha, servedSha: servingSha, deployment: own, reason: `Production deployment ${own.id} of ${sha} failed${still}` };
  if (state === "skipped") {
    return { state: "skipped", sha, servedSha: servingSha, deployment: own,
      reason: `Vercel skipped the build of ${sha} (Production deployment ${own.id}, the Ignored Build Step), so an earlier deployment still serves${still}` };
  }
  if (own && (state === "pending" || state === "none")) {
    return { state: "pending", sha, servedSha: servingSha, deployment: own, reason: `Production deployment ${own.id} of ${sha} has not finished${still}` };
  }
  if (state === "succeeded") {
    // Its own deployment succeeded but something newer that lacks it serves:
    // a rollback or a promotion of an older deployment.
    return { state: "not-served", sha, servedSha: servingSha, deployment: own,
      reason: `Production deployment ${own.id} of ${sha} succeeded but no longer serves (rolled back or replaced)${still}` };
  }
  return { state: "not-served", sha, servedSha: servingSha, deployment: null, reason: `no Production deployment carries ${sha} yet${still}` };
}

// The Vercel Production deployments, newest first, from each Production
// environment name (one page of 100 each: a deployment older than that is not
// what serves now).
export function readProductionDeployments({ api, repository = REPOSITORY, environments = productionEnvironments() }) {
  const rows = environments.flatMap((environment) => {
    const page = api("GET", `repos/${repository}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`);
    if (!Array.isArray(page)) throw new Error(`the deployments of ${environment} did not read as a list`);
    return page;
  });
  return rows.filter((deployment) => isVercelProductionDeployment(deployment, environments)).sort(newestFirst);
}

export function readOutcome({ api, repository = REPOSITORY, deploymentId }) {
  const statuses = api("GET", `repos/${repository}/deployments/${deploymentId}/statuses?per_page=100`);
  if (!Array.isArray(statuses)) throw new Error(`the statuses of deployment ${deploymentId} did not read as a list`);
  return deploymentOutcome(statuses);
}

// Reads what the decision needs, and no more statuses than it needs: the
// commit's own deployments, the ones at the served commit, and the newest
// deployments down to the first that succeeded.
export async function resolveDemoDeployment({ api, sha, repository = REPOSITORY, config = readDemoDeployConfig(), fetchImpl = fetch }) {
  if (!EXACT_SHA.test(sha ?? "")) throw new Error("the commit must be an exact 40-character SHA");
  const production = readProductionDeployments({ api, repository, environments: productionEnvironments(config) });
  let servedSha = null;
  try {
    const served = servedCommit(await Promise.all(config.hostnames.map((hostname) => readStamp(hostname, fetchImpl))));
    if (!served.error) servedSha = served.sha;
  } catch {
    // An unreachable hostname leaves the newest successful deployment to decide.
  }
  const outcomes = new Map();
  const read = (deployment) => {
    if (!outcomes.has(deployment.id)) outcomes.set(deployment.id, readOutcome({ api, repository, deploymentId: deployment.id }));
    return outcomes.get(deployment.id);
  };
  for (const deployment of production) {
    if (deployment.sha === sha || deployment.sha === servedSha) read(deployment);
  }
  for (const deployment of production.slice(0, 20)) {
    if (read(deployment) === "succeeded") break;
  }
  return resolveServingDeployment({ sha, production, outcomes, servedSha,
    contains: (ancestor, descendant) => commitContains({ api, repository, ancestor, descendant }) });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const sha = process.argv[2] ?? process.env.DEPLOYMENT_SHA ?? "";
  try {
    const result = await resolveDemoDeployment({ api: ghApi, sha, repository: process.env.REPOSITORY || REPOSITORY });
    console.log(`${result.state}: ${result.reason}.`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `state=${result.state}\ndeployment=${result.deployment?.id ?? ""}\nserved=${result.servedSha ?? ""}\n`);
    }
    process.exitCode = result.state === "served" ? 0 : 2;
  } catch (error) {
    console.error(`Cannot tell which deployment serves ${sha || "the commit"}: ${error.message}.`);
    process.exitCode = 1;
  }
}
