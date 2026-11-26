// @vitest-environment node
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps build-only stylesheet transforms out of the related-test config dependencies", () => {
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { loadConfigFromFile } = await import("vite");
    const result = await loadConfigFromFile({ command: "serve", mode: "test" });
    console.log(JSON.stringify({ dependencies: result.dependencies,
      plugins: result.config.plugins.map(plugin => plugin.name) }));
  `], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, VITEST: "true" } }));
  expect(result.dependencies.some(path => path.endsWith("/scripts/lib/route-styles.mjs"))).toBe(false);
  expect(result.dependencies.some(path => path.endsWith("/scripts/lib/critical-full-styles.mjs"))).toBe(false);
  expect(result.plugins).not.toContain("route-styles");
  expect(result.plugins).not.toContain("critical-full-styles");
});
