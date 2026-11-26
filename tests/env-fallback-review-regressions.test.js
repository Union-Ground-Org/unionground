// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scanSource, scanWorkflow } from "../scripts/lib/env-fallback-scan.mjs";

describe("presence and workflow secret boundaries", () => {
  it.each([
    'Boolean(process.env.API_TOKEN || "dev")',
    'Boolean(process.env.API_TOKEN || process.env.LEGACY_TOKEN)',
    'if (process.env.API_TOKEN || "dev") {}',
    '!(process.env.API_TOKEN || process.env.VITE_PUBLIC_TOKEN)',
    'Boolean(process.env.API_TOKEN || process.env.NODE_ENV)',
    'Boolean(process.env.API_TOKEN || unknownValue())',
    'Boolean(process.env.API_TOKEN || "dev" || process.env.LEGACY_TOKEN)',
  ])("rejects unsafe presence operand %s", source => {
    expect(scanSource({ path: "api/probe.js", source }).length).toBeGreaterThan(0);
  });
  it("keeps explicitly reviewed alias presence probes safe", () => {
    expect(scanSource({ path: "api/probe.js", source: "Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)" })).toEqual([]);
  });
  it.each(["${{ secrets.API_TOKEN || secrets.LEGACY_TOKEN }}", "${{ 'committed-value' }}", "${{ vars.PUBLIC_TOKEN }}", "${{ 'secrets.API_TOKEN' }}", "prefix${{ secrets.API_TOKEN }}", "${{ secrets.API_TOKEN || vars.PUBLIC_TOKEN }}"])("rejects unsafe workflow value %s", value => {
    expect(scanWorkflow({ path: ".github/workflows/test.yml", source: `env:\n  API_TOKEN: ${value}\n` }).length).toBeGreaterThan(0);
  });
  it.each(["${{ secrets.API_TOKEN }}", "${{ secrets['API_TOKEN'] }}", "${{ secrets.GH_TOKEN || secrets.GITHUB_TOKEN }}"])("accepts actual secret references %s", value => {
    expect(scanWorkflow({ path: ".github/workflows/test.yml", source: `env:\n  API_TOKEN: ${value}\n` })).toEqual([]);
  });
});
