#!/usr/bin/env node
// Builds the static public demo into Vercel's Build Output API layout
// (docs/contracts/demo-deploy.md). Vercel runs this from the demo project's
// Root Directory, deploy/demo, and serves deploy/demo/.vercel/output as is:
// the product's root vercel.json, its api/ functions and its crons are outside
// that directory and never read. Locally: `npm run build:demo`.
//
// The build is the hand recipe's: `npm run build` with the demo surface and
// local fixtures (VITE_APP_SURFACE=demo, VITE_VISUAL_AUDIT=1), the bundle
// identity scan, then the package. It inherits no other VITE_, SENTRY_ or
// SUPABASE_ variable and refuses a root .env file a production build would
// load, so no backend address or key can be bundled; and it fails unless the
// finished package is static only (scripts/lib/demo-site.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDemoOutput, staticDemoOutputProblems } from "./lib/demo-site.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(repoRoot, "dist");
const outputDir = join(repoRoot, "deploy", "demo", ".vercel", "output");
const ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];
const INHERITED = /^(?:VITE_|SENTRY_|SUPABASE_)/;

function fail(message) {
  console.error(`build-demo-site: ${message}`);
  process.exit(1);
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
}

const envFiles = ENV_FILES.filter((name) => existsSync(join(repoRoot, name)));
if (envFiles.length) fail(`refusing to build beside ${envFiles.join(", ")}: a production build would bundle its values`);

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.test(key)));
env.VITE_APP_SURFACE = "demo";
env.VITE_VISUAL_AUDIT = "1";

rmSync(distDir, { recursive: true, force: true });
rmSync(outputDir, { recursive: true, force: true });
run("npm", ["run", "build"], env);
run("node", ["scripts/verify-web-bundle-identity.mjs", "--dist-dir", "dist"], env);

const commitSha = process.env.VERCEL_GIT_COMMIT_SHA
  || spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
const { files } = packageDemoOutput({ distDir, outputDir });
const problems = staticDemoOutputProblems(outputDir, { commitSha });
if (problems.length) fail(`the package is not static only:\n- ${problems.join("\n- ")}`);
console.log(`build-demo-site: static-only package of ${files} files at ${outputDir} for ${commitSha}; no function, cron, server rewrite or hosted database address.`);
