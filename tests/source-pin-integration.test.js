// @vitest-environment node
import { execFileSync } from "node:child_process";
import { it } from "vitest";

it("integrates all three pin families in both Git merge orders and refuses corrupt or stale pins", () => {
  execFileSync(process.execPath, ["--test", "tests/source-pin-integration.node-test.mjs"], {
    cwd: process.cwd(), encoding: "utf8", stdio: "pipe", maxBuffer: 2 * 1024 * 1024,
  });
}, 90_000);
