// The static public demo's package and its guard (docs/contracts/demo-deploy.md).
//
// The demo at the hostnames in config/demo-deploy.json is a static build of
// the auth-free surface: fictional data, every write stubbed, no backend. It
// is packaged in Vercel's Build Output API v3 layout, byte for byte the
// package the hand recipe made (package-demo.py, October 19 to November 9,
// 2026): every file of dist/ under static/, one inert runtime-config script
// at /api/runtime-config, and three routes (that script's headers, the
// filesystem, a single-page fallback to /index.html). Nothing else may reach
// the demo's origin: no function, no cron, no rewrite to a server or another
// host, and no hosted database address in any served file.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DEMO_DEPLOY_CONFIG_URL = new URL("../../config/demo-deploy.json", import.meta.url);

export function readDemoDeployConfig() {
  return JSON.parse(readFileSync(DEMO_DEPLOY_CONFIG_URL, "utf8"));
}

// What /api/runtime-config answers on the demo: the demo surface, never
// configured, so the browser never looks for a backend. These are the exact
// bytes the hand recipe served; the product answers the same path from a
// function, which must never run on the demo's origin.
export const DEMO_RUNTIME_CONFIG = 'globalThis.__UNIONGROUND_RUNTIME_CONFIG__=Object.freeze({schema:1,surface:"demo",configured:false});\n';

export const DEMO_ROUTES = Object.freeze([
  { src: "/api/runtime-config", headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" } },
  { handle: "filesystem" },
  { src: "/.*", dest: "/index.html" },
]);

// The one file allowed under static/api/: the inert script above.
const STATIC_API_FILES = ["runtime-config"];
const TEXT_FILE = /\.(?:html?|m?js|css|json|map|webmanifest|txt|xml|svg)$/i;

// A hosted database address in a served file: a Supabase project host (a
// 20-character project ref under supabase.co, supabase.in or a Supabase
// pooler) or a Postgres connection string. A bare "supabase.co" suffix, as in
// a host-validation pattern, is not an address.
export const HOSTED_DATABASE_PATTERNS = Object.freeze([
  /\b[a-z0-9]{20}\.supabase\.(?:co|in)\b/i,
  /\bpooler\.supabase\.com\b/i,
  /\bpostgres(?:ql)?:\/\/[^\s"'`]+/i,
]);

const filesBelow = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? filesBelow(path) : [path];
});

const posix = (path) => path.split(sep).join("/");

// Copies dist/ into a fresh Build Output API package at outputDir.
export function packageDemoOutput({ distDir, outputDir }) {
  if (existsSync(outputDir)) throw new Error(`${outputDir} already exists; the package is only ever written fresh`);
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`${distDir} has no index.html; build the demo first`);
  if (existsSync(join(distDir, "api"))) throw new Error(`${distDir} has an api/ directory; the demo serves only its inert runtime-config script there`);
  const staticDir = join(outputDir, "static");
  mkdirSync(staticDir, { recursive: true });
  for (const entry of readdirSync(distDir)) {
    if (entry === ".vercel") continue;
    cpSync(join(distDir, entry), join(staticDir, entry), { recursive: true });
  }
  mkdirSync(join(staticDir, "api"));
  writeFileSync(join(staticDir, "api", "runtime-config"), DEMO_RUNTIME_CONFIG);
  writeFileSync(join(outputDir, "config.json"), `${JSON.stringify({ version: 3, routes: DEMO_ROUTES }, null, 2)}\n`);
  return { staticDir, files: filesBelow(staticDir).length };
}

const ROUTE_KEYS = new Set(["src", "dest", "headers", "handle", "status"]);
// `vercel build` (and Vercel's own build) finish the package: they add an
// empty crons list, an empty daemons map, a diagnostics directory and an
// error-phase route to the static 404.html. Those empty additions are
// accepted so the same check reads what Vercel deploys; a cron, daemon or
// function is not.
const VERCEL_PHASES = ["filesystem", "error"];

function routeProblems(route, index, staticDir) {
  const at = `config.json routes[${index}]`;
  const extra = Object.keys(route ?? {}).filter((key) => !ROUTE_KEYS.has(key));
  if (extra.length) return [`${at} has ${extra.join(", ")}; a static demo route has only src, dest, headers, status or handle`];
  if ("handle" in route) {
    return VERCEL_PHASES.includes(route.handle) && Object.keys(route).length === 1 ? [] : [`${at} handles ${JSON.stringify(route.handle)}; only ${VERCEL_PHASES.join(" and ")} are static`];
  }
  if (typeof route.src !== "string") return [`${at} has no src`];
  if (!("dest" in route)) return "headers" in route ? [] : [`${at} neither sets headers nor serves a file`];
  const dest = String(route.dest);
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(dest)) return [`${at} sends ${route.src} to another origin (${dest})`];
  if (/^\/api(?:\/|$)/.test(dest)) return [`${at} sends ${route.src} to ${dest}, a server path`];
  const file = dest.split("?", 1)[0].replace(/^\/+/, "");
  if (!file || !existsSync(join(staticDir, file)) || !statSync(join(staticDir, file)).isFile()) {
    return [`${at} sends ${route.src} to ${dest}, which is not a static file in the package`];
  }
  return [];
}

// Every reason the package at outputDir could put something other than
// static files on the demo's origin. Empty means static only.
export function staticDemoOutputProblems(outputDir, { commitSha } = {}) {
  const problems = [];
  const staticDir = join(outputDir, "static");
  if (!existsSync(staticDir)) return [`${outputDir} has no static/ directory`];
  for (const name of readdirSync(outputDir)) {
    if (!["static", "config.json", "diagnostics"].includes(name)) problems.push(`${name} beside static/ and config.json (functions, flags or other build output)`);
  }
  let config = null;
  try {
    config = JSON.parse(readFileSync(join(outputDir, "config.json"), "utf8"));
  } catch (error) {
    problems.push(`config.json is unreadable: ${error.message}`);
  }
  if (config) {
    const extra = Object.keys(config).filter((key) => !["version", "routes", "crons", "daemons"].includes(key));
    if (extra.length) problems.push(`config.json has ${extra.join(", ")}; a static demo has only version and routes (no overrides, images or flags)`);
    if ("crons" in config && !(Array.isArray(config.crons) && config.crons.length === 0)) problems.push(`config.json schedules crons: ${JSON.stringify(config.crons)}`);
    if ("daemons" in config && !(config.daemons && typeof config.daemons === "object" && Object.keys(config.daemons).length === 0)) problems.push(`config.json runs daemons: ${JSON.stringify(config.daemons)}`);
    if (config.version !== 3) problems.push(`config.json version ${JSON.stringify(config.version)} is not 3`);
    (Array.isArray(config.routes) ? config.routes : [null]).forEach((route, index) => problems.push(...routeProblems(route, index, staticDir)));
  }
  const files = filesBelow(staticDir).map((path) => posix(relative(staticDir, path)));
  for (const file of files) {
    if (/(?:^|\/)[^/]+\.func(?:\/|$)|(?:^|\/)\.vc-config\.json$|\.prerender-config\.json$/.test(file)) {
      problems.push(`static/${file} is function or prerender output`);
    }
    if (file.startsWith("api/") && !STATIC_API_FILES.includes(file.slice(4))) problems.push(`static/${file} is under api/`);
    if (TEXT_FILE.test(file) || file === "api/runtime-config") {
      const text = readFileSync(join(staticDir, file), "utf8");
      for (const pattern of HOSTED_DATABASE_PATTERNS) {
        const match = text.match(pattern);
        if (match) problems.push(`static/${file} names a hosted database address (${match[0].slice(0, 60)})`);
      }
    }
  }
  if (!files.includes("index.html")) problems.push("static/index.html is missing");
  const runtime = join(staticDir, "api", "runtime-config");
  if (!existsSync(runtime) || readFileSync(runtime, "utf8") !== DEMO_RUNTIME_CONFIG) {
    problems.push("static/api/runtime-config is not the inert demo script");
  }
  if (commitSha !== undefined) {
    let stamp = null;
    try {
      stamp = JSON.parse(readFileSync(join(staticDir, "build-info.json"), "utf8"));
    } catch {
      problems.push("static/build-info.json is missing or unreadable");
    }
    if (stamp && stamp.commitSha !== commitSha) problems.push(`static/build-info.json names ${stamp.commitSha}, not ${commitSha}`);
  }
  return problems;
}

// The demo's Vercel config (deploy/demo/vercel.json) may say how to install,
// build and when to deploy, and nothing that adds a function, cron, rewrite,
// redirect, header, middleware or region.
const VERCEL_CONFIG_KEYS = new Set(["$schema", "framework", "installCommand", "buildCommand", "ignoreCommand", "git"]);

export function demoVercelConfigProblems(config) {
  const problems = [];
  for (const key of Object.keys(config ?? {})) {
    if (!VERCEL_CONFIG_KEYS.has(key)) problems.push(`vercel.json sets ${key}; the demo's config may set only ${[...VERCEL_CONFIG_KEYS].join(", ")}`);
  }
  if (config?.framework !== null) problems.push("vercel.json must set framework to null (Other), so no framework adapter adds functions");
  for (const key of ["installCommand", "buildCommand", "ignoreCommand"]) {
    if (typeof config?.[key] !== "string" || !config[key]) problems.push(`vercel.json has no ${key}`);
  }
  if (!/build-demo-site\.mjs/.test(config?.buildCommand ?? "")) problems.push("vercel.json buildCommand does not run scripts/build-demo-site.mjs");
  const git = config?.git ?? {};
  const gitKeys = Object.keys(git);
  if (gitKeys.length !== 1 || gitKeys[0] !== "deploymentEnabled" || typeof git.deploymentEnabled !== "object") {
    problems.push("vercel.json git must hold only a deploymentEnabled branch map");
  } else if (git.deploymentEnabled["**"] !== false) {
    problems.push('vercel.json git.deploymentEnabled must turn every branch off ("**": false) before naming the ones that deploy');
  }
  return problems;
}

// Vercel's Ignored Build Step: exit 0 skips the build, any other exit builds.
// Production builds from main; previews only from demo-preview/ branches.
// A deployment with no Git branch (a CLI deploy by a person) builds.
export function demoBranchBuilds(ref) {
  if (!ref) return true;
  return ref === "main" || ref.startsWith("demo-preview/");
}
