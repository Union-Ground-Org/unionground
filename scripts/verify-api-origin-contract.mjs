#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanApiOriginDirectory } from "./lib/api-origin-contract.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const violations = await scanApiOriginDirectory(resolve(repository, "api"));

if (violations.length) {
  for (const violation of violations) {
    console.error(`FAIL: ${violation.path}: ${violation.code}`);
  }
  process.exitCode = 1;
} else {
  console.log("PASS: every browser-authenticated API mutation uses the shared Origin boundary.");
}
