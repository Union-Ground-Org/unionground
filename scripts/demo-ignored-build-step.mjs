#!/usr/bin/env node
// The demo project's Ignored Build Step (deploy/demo/vercel.json
// ignoreCommand; docs/contracts/demo-deploy.md). Vercel skips the build when
// this exits 0 and builds on any other exit. It repeats the branch rule in
// git.deploymentEnabled, so a branch that rule lets through by mistake still
// does not build: production from main, previews from demo-preview/ only.
import { demoBranchBuilds } from "./lib/demo-site.mjs";

const ref = process.env.VERCEL_GIT_COMMIT_REF ?? "";
if (demoBranchBuilds(ref)) {
  console.log(`Building the demo for ${ref || "a deployment with no Git branch"}.`);
  process.exit(1);
}
console.log(`Skipping the demo build for ${ref}: only main and demo-preview/ branches deploy.`);
process.exit(0);
