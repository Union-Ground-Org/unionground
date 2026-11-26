// @vitest-environment node
//
// The deployment resolver (docs/contracts/demo-deploy.md, "Deployments and
// deploy notes"): which Vercel Production deployment of the demo serves a
// main commit, from GitHub's deployments and statuses and the hostnames'
// build-info.json, every call intercepted.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VERCEL_BOT,
  commitContains,
  deploymentOutcome,
  isVercelProductionDeployment,
  productionEnvironments,
  resolveDemoDeployment,
  resolveServingDeployment,
} from "../scripts/resolve-vercel-deployment.mjs";

const REPOSITORY = "Union-Ground-Org/unionground";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const OLD = "1".repeat(40);
const MID = "2".repeat(40);
const NEW = "3".repeat(40);
const OTHER = "4".repeat(40);
// The first-parent order of main: OLD, then MID, then NEW. OTHER is on no branch.
const ORDER = [OLD, MID, NEW];
const contains = (ancestor, descendant) => ORDER.includes(ancestor) && ORDER.includes(descendant) && ORDER.indexOf(ancestor) <= ORDER.indexOf(descendant);
const bot = { login: "vercel[bot]", id: 35613825, node_id: "MDM6Qm90MzU2MTM4MjU=", type: "Bot" };
const committedConfig = JSON.parse(readFileSync(new URL("../config/demo-deploy.json", import.meta.url), "utf8"));
// A deployment's own settings: the repository leaves the Vercel project empty
// and names one hostname; this one has a project and a second hostname.
const config = {
  ...committedConfig,
  hostnames: [...committedConfig.hostnames, "demo.example.org"],
  vercel: { ...committedConfig.vercel, team: "example-team", project: "example-demo" },
};

// Shaped like the GitHub REST answers Vercel's Git integration produces.
function deployment({ id, sha, environment = "Production", creator = bot, created = "2026-11-13T15:00:00Z" }) {
  return { id, sha, ref: "main", task: "deploy", environment, creator: { ...creator }, created_at: created, payload: {},
    repository_url: API, url: `${API}/deployments/${id}`, statuses_url: `${API}/deployments/${id}/statuses` };
}
function status({ id = 900, deploymentId, state, creator = bot, created = "2026-11-13T15:02:00Z" }) {
  const origin = "https://example-demo-abc123-example-team.vercel.app";
  return { id, state, environment: "Production", environment_url: origin, target_url: origin, log_url: origin,
    creator: { ...creator }, created_at: created, repository_url: API, deployment_url: `${API}/deployments/${deploymentId}`,
    url: `${API}/deployments/${deploymentId}/statuses/${id}`, description: state === "inactive" ? "Canceled from the Vercel Dashboard" : "" };
}
const outcomes = (entries) => new Map(entries);

describe("which deployments count", () => {
  it("names both of Vercel's Production environment names for the one demo project", () => {
    expect(productionEnvironments(config)).toEqual(["Production", "Production – example-demo"]);
    // The committed config names no project, so only the plain name counts.
    expect(productionEnvironments()).toEqual(["Production"]);
    expect(productionEnvironments(committedConfig)).toEqual(["Production"]);
  });

  it("accepts only Vercel's own Production deploy of an exact commit", () => {
    expect(isVercelProductionDeployment(deployment({ id: 1, sha: NEW }))).toBe(true);
    expect(isVercelProductionDeployment(deployment({ id: 1, sha: NEW, environment: "Production – example-demo" }), productionEnvironments(config))).toBe(true);
    expect(isVercelProductionDeployment(deployment({ id: 1, sha: NEW, environment: "Production – example-demo" }))).toBe(false);
    expect(isVercelProductionDeployment(deployment({ id: 1, sha: NEW, environment: "Preview" }))).toBe(false);
    expect(isVercelProductionDeployment(deployment({ id: 1, sha: NEW, creator: { login: "someone", id: 5, type: "User" } }))).toBe(false);
    expect(isVercelProductionDeployment(deployment({ id: 1, sha: NEW, creator: { ...bot, id: 1 } }))).toBe(false);
    expect(isVercelProductionDeployment({ ...deployment({ id: 1, sha: NEW }), task: "deploy:migrations" })).toBe(false);
    expect(isVercelProductionDeployment(deployment({ id: 1, sha: "main" }))).toBe(false);
    expect(isVercelProductionDeployment(deployment({ id: 0, sha: NEW }))).toBe(false);
    expect(isVercelProductionDeployment(null)).toBe(false);
    expect(VERCEL_BOT.login).toBe("vercel[bot]");
  });

  it("reads a deployment's statuses as succeeded, failed, skipped, pending or none", () => {
    const of = (...states) => states.map((state, index) => status({ id: index + 1, deploymentId: 1, state }));
    expect(deploymentOutcome(of("pending", "in_progress", "success"))).toBe("succeeded");
    expect(deploymentOutcome(of("success", "inactive"))).toBe("succeeded");
    expect(deploymentOutcome(of("pending", "failure"))).toBe("failed");
    expect(deploymentOutcome(of("error"))).toBe("failed");
    expect(deploymentOutcome(of("inactive"))).toBe("skipped");
    expect(deploymentOutcome(of("queued", "in_progress"))).toBe("pending");
    expect(deploymentOutcome([])).toBe("none");
    expect(deploymentOutcome(undefined)).toBe("none");
    // A status someone else wrote does not count.
    expect(deploymentOutcome([status({ deploymentId: 1, state: "success", creator: { login: "someone", id: 5, type: "User" } })])).toBe("none");
  });
});

describe("resolveServingDeployment", () => {
  const production = [
    deployment({ id: 10, sha: OLD, created: "2026-11-13T10:00:00Z" }),
    deployment({ id: 20, sha: MID, created: "2026-11-13T11:00:00Z" }),
    deployment({ id: 30, sha: NEW, created: "2026-11-13T12:00:00Z" }),
  ];

  it("serves a commit whose own deployment is the one the hostnames serve", () => {
    const result = resolveServingDeployment({ sha: NEW, production, outcomes: outcomes([[30, "succeeded"], [20, "succeeded"]]), servedSha: NEW, contains });
    expect(result).toMatchObject({ state: "served", servedSha: NEW, deployment: { id: 30 } });
    expect(result.reason).toMatch(/is live: the demo serves 3{40} \(Production deployment 30\), which contains it/u);
  });

  it("serves an older commit through a later deployment that contains it", () => {
    const result = resolveServingDeployment({ sha: OLD, production, outcomes: outcomes([[30, "succeeded"]]), servedSha: NEW, contains });
    expect(result).toMatchObject({ state: "served", servedSha: NEW, deployment: { id: 30 } });
  });

  it("falls back on the newest successful deployment when build-info.json could not be read", () => {
    const result = resolveServingDeployment({ sha: MID, production, outcomes: outcomes([[30, "failed"], [20, "succeeded"]]), contains });
    expect(result).toMatchObject({ state: "served", servedSha: MID, deployment: { id: 20 } });
  });

  it("serves a commit a hand deploy carries, with no deployment named", () => {
    const result = resolveServingDeployment({ sha: MID, production: [], outcomes: outcomes([]), servedSha: NEW, contains });
    expect(result).toMatchObject({ state: "served", servedSha: NEW, deployment: null });
    expect(result.reason).not.toMatch(/Production deployment/u);
  });

  it("says plainly that nothing serves a commit with no deployment yet", () => {
    const result = resolveServingDeployment({ sha: NEW, production: production.slice(0, 2), outcomes: outcomes([[20, "succeeded"]]), servedSha: MID, contains });
    expect(result).toMatchObject({ state: "not-served", servedSha: MID, deployment: null });
    expect(result.reason).toBe(`no Production deployment carries ${NEW} yet; the demo still serves ${MID}, which does not contain it`);
  });

  it("names a failed deployment, while the previous one still serves", () => {
    const result = resolveServingDeployment({ sha: NEW, production, outcomes: outcomes([[30, "failed"], [20, "succeeded"]]), servedSha: MID, contains });
    expect(result).toMatchObject({ state: "failed", servedSha: MID, deployment: { id: 30 } });
    expect(result.reason).toMatch(/^Production deployment 30 of 3{40} failed; the demo still serves 2{40}/u);
  });

  it("tells a build the Ignored Build Step skipped apart from a failure", () => {
    const result = resolveServingDeployment({ sha: NEW, production, outcomes: outcomes([[30, "skipped"], [20, "succeeded"]]), servedSha: MID, contains });
    expect(result).toMatchObject({ state: "skipped", servedSha: MID, deployment: { id: 30 } });
    expect(result.reason).toMatch(/Vercel skipped the build .*Ignored Build Step\), so an earlier deployment still serves/u);
    // A skipped commit is live once a later deployment carries it.
    const later = [...production.slice(0, 2), deployment({ id: 25, sha: MID, created: "2026-11-13T11:30:00Z" })];
    const skippedThenServed = resolveServingDeployment({ sha: MID, production: later, outcomes: outcomes([[20, "skipped"], [25, "succeeded"]]), servedSha: NEW, contains });
    expect(skippedThenServed.state).toBe("served");
  });

  it("reports a deployment still building, and one with no status yet, as pending", () => {
    expect(resolveServingDeployment({ sha: NEW, production, outcomes: outcomes([[30, "pending"], [20, "succeeded"]]), servedSha: MID, contains }).state).toBe("pending");
    expect(resolveServingDeployment({ sha: NEW, production, outcomes: outcomes([[20, "succeeded"]]), servedSha: MID, contains }).state).toBe("pending");
  });

  it("reports a successful deployment that no longer serves (a rollback) as not served", () => {
    const result = resolveServingDeployment({ sha: NEW, production, outcomes: outcomes([[30, "succeeded"], [20, "succeeded"]]), servedSha: MID, contains });
    expect(result).toMatchObject({ state: "not-served", deployment: { id: 30 } });
    expect(result.reason).toMatch(/no longer serves \(rolled back or replaced\)/u);
  });

  it("says when no successful deployment exists, and refuses a commit that is not exact", () => {
    const result = resolveServingDeployment({ sha: OTHER, production: [], outcomes: outcomes([]), contains });
    expect(result.reason).toBe(`no Production deployment carries ${OTHER} yet; no successful Production deployment was found`);
    expect(() => resolveServingDeployment({ sha: "main", production, outcomes: outcomes([]), contains })).toThrow(/exact 40-character SHA/u);
  });
});

describe("commitContains", () => {
  it("asks GitHub's compare and accepts only ahead or identical from that exact base", () => {
    const calls = [];
    const api = (method, path) => { calls.push(path); return { status: "ahead", merge_base_commit: { sha: OLD } }; };
    expect(commitContains({ api, ancestor: OLD, descendant: NEW })).toBe(true);
    expect(calls).toEqual([`repos/${REPOSITORY}/compare/${OLD}...${NEW}?per_page=1&page=2`]);
    expect(commitContains({ api: () => ({ status: "diverged", merge_base_commit: { sha: OLD } }), ancestor: OLD, descendant: NEW })).toBe(false);
    expect(commitContains({ api: () => ({ status: "ahead", merge_base_commit: { sha: MID } }), ancestor: OLD, descendant: NEW })).toBe(false);
    expect(commitContains({ api: () => { throw new Error("no call"); }, ancestor: NEW, descendant: NEW })).toBe(true);
  });
});

// A fake GitHub API (deployments, statuses, compare) and a fake fetch for the
// hostnames' build-info.json.
function fakeGitHub({ deployments = [], statuses = {}, order = ORDER }) {
  const calls = [];
  const api = (method, path) => {
    calls.push(path);
    const list = /\/deployments\?environment=([^&]+)&per_page=100$/u.exec(path);
    if (list) return deployments.filter((row) => row.environment === decodeURIComponent(list[1]));
    const statusPath = /\/deployments\/(\d+)\/statuses\?per_page=100$/u.exec(path);
    if (statusPath) return statuses[statusPath[1]] ?? [];
    const compare = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})\?/u.exec(path);
    if (compare) {
      const [, base, head] = compare;
      const ahead = order.includes(base) && order.includes(head) && order.indexOf(base) <= order.indexOf(head);
      return { status: ahead ? (base === head ? "identical" : "ahead") : "behind", merge_base_commit: { sha: ahead ? base : head } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls };
}
const stampFetch = (sha, seen = []) => async (url) => {
  seen.push(url);
  return { ok: true, status: 200, json: async () => ({ commitSha: sha }) };
};

describe("resolveDemoDeployment", () => {
  const deployments = [
    deployment({ id: 20, sha: MID, created: "2026-11-13T11:00:00Z" }),
    deployment({ id: 30, sha: NEW, environment: "Production – example-demo", created: "2026-11-13T12:00:00Z" }),
    deployment({ id: 40, sha: NEW, environment: "Preview", created: "2026-11-13T12:00:00Z" }),
  ];

  it("reads both Production names and the hostnames, and resolves the served deployment", async () => {
    const { api, calls } = fakeGitHub({ deployments, statuses: { 30: [status({ deploymentId: 30, state: "success" })] } });
    const seen = [];
    const result = await resolveDemoDeployment({ api, sha: MID, config, fetchImpl: stampFetch(NEW, seen) });
    expect(result).toMatchObject({ state: "served", servedSha: NEW, deployment: { id: 30 } });
    expect(seen.map((url) => new URL(url).hostname)).toEqual(config.hostnames);
    expect(calls).toContain(`repos/${REPOSITORY}/deployments?environment=Production&per_page=100`);
    expect(calls).toContain(`repos/${REPOSITORY}/deployments?environment=${encodeURIComponent("Production – example-demo")}&per_page=100`);
    // The preview deployment's statuses are never read.
    expect(calls).not.toContain(`repos/${REPOSITORY}/deployments/40/statuses?per_page=100`);
  });

  it("names a failed deployment when the hostnames still serve the one before", async () => {
    const { api } = fakeGitHub({ deployments, statuses: {
      30: [status({ deploymentId: 30, state: "failure" })], 20: [status({ id: 901, deploymentId: 20, state: "success" })] } });
    const result = await resolveDemoDeployment({ api, sha: NEW, config, fetchImpl: stampFetch(MID) });
    expect(result).toMatchObject({ state: "failed", servedSha: MID, deployment: { id: 30 } });
  });

  it("names a skipped build when the hostnames serve an earlier commit", async () => {
    const { api } = fakeGitHub({ deployments, statuses: {
      30: [status({ deploymentId: 30, state: "inactive" })], 20: [status({ id: 901, deploymentId: 20, state: "success" })] } });
    const result = await resolveDemoDeployment({ api, sha: NEW, config, fetchImpl: stampFetch(MID) });
    expect(result.state).toBe("skipped");
  });

  it("uses the newest successful deployment when the hostnames cannot be read or disagree", async () => {
    const statuses = { 30: [status({ deploymentId: 30, state: "failure" })], 20: [status({ id: 901, deploymentId: 20, state: "success" })] };
    const unreachable = async () => { throw new Error("ENOTFOUND"); };
    expect(await resolveDemoDeployment({ api: fakeGitHub({ deployments, statuses }).api, sha: MID, config, fetchImpl: unreachable }))
      .toMatchObject({ state: "served", servedSha: MID, deployment: { id: 20 } });
    let call = 0;
    const disagree = async () => ({ ok: true, json: async () => ({ commitSha: (call += 1) === 1 ? NEW : MID }) });
    expect(await resolveDemoDeployment({ api: fakeGitHub({ deployments, statuses }).api, sha: NEW, config, fetchImpl: disagree }))
      .toMatchObject({ state: "failed", servedSha: MID });
  });

  it("says nothing serves a commit before the project is connected to Git and the demo serves an older hand deploy", async () => {
    const { api } = fakeGitHub({});
    const result = await resolveDemoDeployment({ api, sha: NEW, config, fetchImpl: stampFetch(OLD) });
    expect(result).toMatchObject({ state: "not-served", servedSha: OLD, deployment: null });
  });

  it("fails when GitHub's answer is not a list, and refuses a commit that is not exact", async () => {
    await expect(resolveDemoDeployment({ api: () => ({ message: "Not Found" }), sha: NEW, config, fetchImpl: stampFetch(NEW) }))
      .rejects.toThrow(/did not read as a list/u);
    await expect(resolveDemoDeployment({ api: () => [], sha: "HEAD", config })).rejects.toThrow(/exact 40-character SHA/u);
    const statusFails = (method, path) => (path.includes("/statuses") ? { message: "Not Found" } : [deployment({ id: 20, sha: MID })]);
    await expect(resolveDemoDeployment({ api: statusFails, sha: MID, config, fetchImpl: stampFetch(MID) })).rejects.toThrow(/statuses of deployment 20/u);
  });
});
