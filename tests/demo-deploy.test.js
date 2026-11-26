// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEMO_ROUTES,
  DEMO_RUNTIME_CONFIG,
  demoBranchBuilds,
  demoVercelConfigProblems,
  packageDemoOutput,
  readDemoDeployConfig,
  staticDemoOutputProblems,
} from "../scripts/lib/demo-site.mjs";
import { decideFreshness, servedCommit } from "../scripts/demo-freshness-watch.mjs";
import {
  certificateProblem,
  landingProblem,
  productServerPaths,
  runtimeConfigProblem,
  serverPathProblem,
} from "../scripts/demo-uptime-watch.mjs";

// The static public demo's deploy guard (docs/contracts/demo-deploy.md): the
// product's functions, crons and server rewrites can never reach the demo's
// origin, the Vercel settings the cutover applies are pinned here, and the
// two watchers keep checking what the demo serves.

const repo = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(repo(path), "utf8");
const demoVercel = JSON.parse(read("deploy/demo/vercel.json"));
const productVercel = JSON.parse(read("vercel.json"));
const contract = read("docs/contracts/demo-deploy.md");
const settings = readDemoDeployConfig();
const SHA = "0123456789abcdef0123456789abcdef01234567";

const temporary = [];
afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

// A small dist/ shaped like `npm run build`'s.
function fixtureDist() {
  const root = mkdtempSync(join(tmpdir(), "demo-deploy-"));
  temporary.push(root);
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(join(dist, ".well-known"), { recursive: true });
  mkdirSync(join(dist, "about"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<meta name="union-ground-build-sha" content="${SHA}" /><title>Union Ground</title>`);
  writeFileSync(join(dist, "about", "index.html"), "<title>About</title>");
  writeFileSync(join(dist, "assets", "index-abc12345.js"), 'const hosts=["*.supabase.co","*.supabase.in"];');
  writeFileSync(join(dist, ".well-known", "tdmrep.json"), "[]");
  writeFileSync(join(dist, "build-info.json"), JSON.stringify({ commitSha: SHA, builtAt: "2026-11-12T03:00:00.000Z" }));
  return { dist, output: join(root, "output") };
}

function packaged() {
  const { dist, output } = fixtureDist();
  packageDemoOutput({ distDir: dist, outputDir: output });
  return output;
}

const editJson = (path, edit) => writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf8")))));

describe("the demo's Vercel Root Directory", () => {
  it("holds only its own vercel.json and package.json: no api/, no middleware, no product config", () => {
    const entries = readdirSync(repo("deploy/demo/")).filter((name) => name !== ".vercel").sort();
    expect(entries).toEqual(["package.json", "vercel.json"]);
    expect(JSON.parse(read("deploy/demo/package.json"))).toEqual({
      name: "unionground-demo-deploy",
      private: true,
      description: expect.stringContaining("docs/contracts/demo-deploy.md"),
      engines: { node: settings.vercel.nodeVersion },
    });
  });

  it("installs and builds from the repository root and deploys only main and demo-preview/ branches", () => {
    expect(demoVercel).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      framework: null,
      installCommand: settings.vercel.installCommand,
      buildCommand: settings.vercel.buildCommand,
      ignoreCommand: settings.vercel.ignoredBuildStep,
      git: { deploymentEnabled: { "**": false, main: true, "demo-preview/**": true } },
    });
    expect(demoVercelConfigProblems(demoVercel)).toEqual([]);
  });

  it("refuses a function, cron, rewrite, redirect, header, region or framework in the demo's config", () => {
    const additions = {
      functions: { "api/x.js": { maxDuration: 10 } },
      crons: [{ path: "/api/x", schedule: "0 * * * *" }],
      rewrites: [{ source: "/(.*)", destination: "/api/x" }],
      redirects: [{ source: "/a", destination: "https://example.com" }],
      routes: [{ src: "/.*", dest: "/api/x" }],
      headers: [],
      regions: ["iad1"],
      outputDirectory: "dist",
    };
    for (const [key, value] of Object.entries(additions)) {
      expect(demoVercelConfigProblems({ ...demoVercel, [key]: value }), key).not.toEqual([]);
    }
    expect(demoVercelConfigProblems({ ...demoVercel, framework: "vite" })).not.toEqual([]);
    expect(demoVercelConfigProblems({ ...demoVercel, buildCommand: "npm run check" })).not.toEqual([]);
    expect(demoVercelConfigProblems({ ...demoVercel, git: { deploymentEnabled: { main: true } } })).not.toEqual([]);
  });

  it("keeps everything the demo build reads out of .vercelignore", () => {
    const ignored = read(".vercelignore").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    for (const needed of ["deploy/", "scripts/", "src/", "public/", "config/", "api/", "index.html", "package.json", "package-lock.json", "vite.config.mjs"]) {
      expect(ignored, needed).not.toContain(needed);
    }
  });

  it("builds production from main, previews from demo-preview/, and skips every other branch", () => {
    expect(demoBranchBuilds("main")).toBe(true);
    expect(demoBranchBuilds("demo-preview/cutover-20261112")).toBe(true);
    expect(demoBranchBuilds("")).toBe(true);
    for (const ref of ["dependabot/npm_and_yarn/vite-7.4.0", "ops/vercel-demo-pipeline-20261111", "mainline", "demo-preview"]) {
      expect(demoBranchBuilds(ref), ref).toBe(false);
    }
  });

  it("names build-demo-site.mjs and the ignored build step as files that exist", () => {
    expect(existsSync(repo("scripts/build-demo-site.mjs"))).toBe(true);
    expect(existsSync(repo("scripts/demo-ignored-build-step.mjs"))).toBe(true);
    expect(JSON.parse(read("package.json")).scripts["build:demo"]).toBe("node scripts/build-demo-site.mjs");
  });
});

describe("the Vercel settings the cutover applies", () => {
  it("pins the demo project's settings", () => {
    expect(settings.vercel).toEqual({
      // A deployment's own Vercel team, project and id; never committed.
      team: "",
      project: "",
      projectId: "",
      rootDirectory: "deploy/demo",
      includeFilesOutsideRootDirectory: true,
      skipUnaffectedDeployments: false,
      frameworkPreset: "Other",
      buildCommand: "node ../../scripts/build-demo-site.mjs",
      installCommand: "cd ../.. && npm ci",
      outputDirectory: null,
      ignoredBuildStep: "node ../../scripts/demo-ignored-build-step.mjs",
      nodeVersion: "22.x",
      productionBranch: "main",
      previewBranchPrefix: "demo-preview/",
      environmentVariables: [],
    });
    expect(settings.hostnames).toEqual(["unionground.org"]);
    expect(["hand", "git"]).toContain(settings.deploySource);
    expect(settings.staleAfterMinutes).toBe(60);
    expect(settings.certificateMinimumDays).toBe(14);
  });

  it("states every setting in the contract, which docs/contracts/README.md indexes", () => {
    for (const value of [
      settings.vercel.project, settings.vercel.projectId, settings.vercel.team, settings.vercel.rootDirectory,
      settings.vercel.buildCommand, settings.vercel.installCommand, settings.vercel.ignoredBuildStep,
      settings.vercel.nodeVersion, settings.vercel.previewBranchPrefix, ...settings.hostnames,
    ]) {
      expect(contract, value).toContain(value);
    }
    for (const phrase of ["Production Branch", "Include files outside the Root Directory", "Skip deployments when there are no changes", "Framework Preset", "Output Directory", "vercel rollback", "vercel promote"]) {
      expect(contract, phrase).toContain(phrase);
    }
    expect(read("docs/contracts/README.md")).toContain("(demo-deploy.md)");
  });
});

describe("the demo's build output", () => {
  it("packages dist/ exactly as the hand recipe did: static files, one inert script, three routes", () => {
    const output = packaged();
    expect(readdirSync(output).sort()).toEqual(["config.json", "static"]);
    expect(JSON.parse(readFileSync(join(output, "config.json"), "utf8"))).toEqual({ version: 3, routes: DEMO_ROUTES });
    expect(readFileSync(join(output, "static", "api", "runtime-config"), "utf8")).toBe(DEMO_RUNTIME_CONFIG);
    expect(DEMO_RUNTIME_CONFIG).toBe('globalThis.__UNIONGROUND_RUNTIME_CONFIG__=Object.freeze({schema:1,surface:"demo",configured:false});\n');
    expect(existsSync(join(output, "static", ".well-known", "tdmrep.json"))).toBe(true);
    expect(staticDemoOutputProblems(output, { commitSha: SHA })).toEqual([]);
  });

  it("refuses to write over an existing package or package a dist/ with an api/ directory", () => {
    const { dist, output } = fixtureDist();
    mkdirSync(output);
    expect(() => packageDemoOutput({ distDir: dist, outputDir: output })).toThrow(/already exists/);
    rmSync(output, { recursive: true });
    mkdirSync(join(dist, "api"));
    expect(() => packageDemoOutput({ distDir: dist, outputDir: output })).toThrow(/api\//);
  });

  const breakages = {
    "a functions directory": (output) => mkdirSync(join(output, "functions", "api", "x.func"), { recursive: true }),
    "a function bundle among the static files": (output) => {
      mkdirSync(join(output, "static", "x.func"), { recursive: true });
      writeFileSync(join(output, "static", "x.func", ".vc-config.json"), "{}");
    },
    "a cron": (output) => editJson(join(output, "config.json"), (config) => ({ ...config, crons: [{ path: "/api/x", schedule: "0 * * * *" }] })),
    "a rewrite to a server path": (output) => editJson(join(output, "config.json"), (config) => ({ ...config, routes: [{ src: "/scim/v2", dest: "/api/scim" }, ...config.routes] })),
    "a rewrite to another origin": (output) => editJson(join(output, "config.json"), (config) => ({ ...config, routes: [{ src: "/rest/(.*)", dest: "https://abcdefghijklmnopqrst.supabase.co/rest/$1" }, ...config.routes] })),
    "a route to middleware": (output) => editJson(join(output, "config.json"), (config) => ({ ...config, routes: [{ src: "/.*", middlewarePath: "_middleware" }, ...config.routes] })),
    "a route to a file the package lacks": (output) => editJson(join(output, "config.json"), (config) => ({ ...config, routes: [{ src: "/x", dest: "/x.html" }, ...config.routes] })),
    "an override or image setting": (output) => editJson(join(output, "config.json"), (config) => ({ ...config, overrides: {} })),
    "a Supabase project host in a served file": (output) => writeFileSync(join(output, "static", "assets", "index-abc12345.js"), 'fetch("https://abcdefghijklmnopqrst.supabase.co/rest/v1/")'),
    "a Postgres connection string in a served file": (output) => writeFileSync(join(output, "static", "about", "index.html"), "postgresql://user:pass@db.example.com:5432/postgres"),
    "a second file under api/": (output) => writeFileSync(join(output, "static", "api", "guide"), "x"),
    "a live runtime config": (output) => writeFileSync(join(output, "static", "api", "runtime-config"), DEMO_RUNTIME_CONFIG.replace("configured:false", "configured:true")),
  };

  it.each(Object.keys(breakages))("fails on %s", (name) => {
    const output = packaged();
    breakages[name](output);
    expect(staticDemoOutputProblems(output)).not.toEqual([]);
  });

  it("accepts only the empty additions Vercel's own build makes", () => {
    const output = packaged();
    editJson(join(output, "config.json"), (config) => ({
      version: 3,
      daemons: {},
      routes: [config.routes[0], { handle: "error" }, { status: 404, src: "^(?!/api).*$", dest: "/about/index.html" }, ...config.routes.slice(1)],
      crons: [],
    }));
    mkdirSync(join(output, "diagnostics"));
    expect(staticDemoOutputProblems(output)).toEqual([]);
    editJson(join(output, "config.json"), (config) => ({ ...config, daemons: { worker: {} } }));
    expect(staticDemoOutputProblems(output)).not.toEqual([]);
  });

  it("fails when build-info.json names another commit than the one built", () => {
    expect(staticDemoOutputProblems(packaged(), { commitSha: "f".repeat(40) })).not.toEqual([]);
  });

  // After `npm run build:demo` the real package is checked too.
  const built = fileURLToPath(repo("deploy/demo/.vercel/output"));
  it.skipIf(!existsSync(built))("finds the last local `npm run build:demo` package static only", () => {
    expect(staticDemoOutputProblems(built)).toEqual([]);
  });
});

describe("demo watchers", () => {
  const minute = 60000;
  const now = Date.UTC(2026, 10, 12, 4, 0);

  it("enforces freshness only after the Git cutover", () => {
    const commits = [{ sha: "b".repeat(40), committedAt: now - 90 * minute }, { sha: "c".repeat(40), committedAt: now - 5 * minute }];
    expect(decideFreshness({ now, deploySource: "git", servedSha: SHA, commits, staleAfterMinutes: 60 }).stale).toBe(true);
    expect(decideFreshness({ now, deploySource: "git", servedSha: SHA, commits: commits.slice(1), staleAfterMinutes: 60 }).stale).toBe(false);
    expect(decideFreshness({ now, deploySource: "git", servedSha: SHA, commits: [], staleAfterMinutes: 60 })).toEqual({ stale: false, reason: `the demo serves main's tip ${SHA}` });
    const hand = decideFreshness({ now, deploySource: "hand", servedSha: SHA, commits, staleAfterMinutes: 60 });
    expect(hand.stale).toBe(false);
    expect(hand.reason).toMatch(/2 commits behind main.*deployed by hand/);
  });

  it("needs every hostname to serve the same exact commit", () => {
    expect(servedCommit([{ hostname: "a", commitSha: SHA }, { hostname: "b", commitSha: SHA }])).toEqual({ sha: SHA });
    expect(servedCommit([{ hostname: "a", commitSha: SHA }, { hostname: "b", commitSha: "f".repeat(40) }]).error).toMatch(/different commits/);
    expect(servedCommit([{ hostname: "a", commitSha: "unknown" }]).error).toMatch(/no exact commit/);
  });

  it("probes every product function and cron path except the static runtime config", () => {
    const paths = productServerPaths(productVercel, readdirSync(repo("api/")));
    expect(paths).toContain("/api/notifications-dispatch");
    expect(paths).toContain("/api/scim");
    expect(paths).toContain("/api/health");
    expect(paths).not.toContain("/api/runtime-config");
    expect(paths.some((path) => path.includes("_lib"))).toBe(false);
    for (const cron of productVercel.crons) expect(paths).toContain(cron.path);
  });

  it("reads a function's answer, a live runtime config or a failing landing as red", () => {
    const shell = { status: 200, contentType: "text/html; charset=utf-8", body: `<meta name="union-ground-build-sha" content="${SHA}" />` };
    expect(landingProblem("h", shell)).toBeNull();
    expect(landingProblem("h", { ...shell, status: 503 })).toMatch(/503/);
    expect(serverPathProblem("h", "/api/scim", shell)).toBeNull();
    expect(serverPathProblem("h", "/api/scim", { status: 401, contentType: "application/scim+json", body: "{}" })).toMatch(/function may be running/);
    expect(serverPathProblem("h", "/api/guide", { status: 200, contentType: "application/json", body: "{}" })).toMatch(/function may be running/);
    expect(runtimeConfigProblem("h", { status: 200, contentType: "", body: DEMO_RUNTIME_CONFIG })).toBeNull();
    expect(runtimeConfigProblem("h", { status: 200, contentType: "", body: DEMO_RUNTIME_CONFIG.replace("false", "true") })).toMatch(/not the inert/);
  });

  it("reads an untrusted or nearly expired certificate as red", () => {
    const days = (count) => new Date(now + count * 86400000).toUTCString();
    expect(certificateProblem("h", { authorized: true, validTo: days(60) }, { now, minimumDays: 14 })).toBeNull();
    expect(certificateProblem("h", { authorized: true, validTo: days(10) }, { now, minimumDays: 14 })).toMatch(/expires in 10 days/);
    expect(certificateProblem("h", { authorized: false, authorizationError: "CERT_HAS_EXPIRED", validTo: days(60) }, { now, minimumDays: 14 })).toMatch(/not trusted/);
  });
});

// Same shape as tests/ci-workflow.test.js "scheduled assurance": main only,
// a schedule or a dispatch, the standard runner, the run's own token, and
// red runs through the shared watcher-red action.
const RED_OR_GREEN = "${{ (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')) && 'failure' || contains(needs.*.result, 'success') && 'success' || 'skipped' }}";

describe.each(["demo-freshness-watch.yml", "demo-uptime-watch.yml"])("%s", (name) => {
  const source = read(`.github/workflows/${name}`);
  const workflow = parse(source);

  it("runs on a schedule or by hand, on main only, reading nothing but public pages and the repository", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(source).not.toMatch(/\bsecrets\.|\bvars\.|environment:|VERCEL_TOKEN|npm (?:ci|install)/);
    const [checkJobName] = Object.keys(workflow.jobs).filter((id) => id !== "watcher-red");
    const check = workflow.jobs[checkJobName];
    expect(check.if).toBe("github.ref == 'refs/heads/main'");
    expect(check.permissions).toEqual({ contents: "read" });
    expect(check["runs-on"]).toBe("ubuntu-24.04");
    expect(check.steps.at(-1).run).toBe(`node scripts/${name.replace(".yml", ".mjs")}`);
    for (const step of check.steps) if (step.uses?.startsWith("actions/checkout@")) expect(step.with["persist-credentials"]).toBe(false);
  });

  it("tracks its red runs through the shared watcher-red action", () => {
    const watcher = workflow.jobs["watcher-red"];
    expect(watcher.needs).toEqual(Object.keys(workflow.jobs).filter((id) => id !== "watcher-red"));
    expect(watcher.if).toBe("${{ !cancelled() && github.ref == 'refs/heads/main' }}");
    expect(watcher.permissions).toEqual({ contents: "read", issues: "write" });
    expect(watcher["runs-on"]).toBe("ubuntu-24.04");
    const [checkout, track] = watcher.steps;
    expect(checkout.with).toEqual({ "sparse-checkout": ".github/actions/watcher-red", "persist-credentials": false });
    expect(track).toEqual({ uses: "./.github/actions/watcher-red", with: {
      workflow: "${{ github.workflow }}", conclusion: RED_OR_GREEN, "github-token": "${{ github.token }}" } });
  });
});
