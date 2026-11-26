// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featureRoot = join(root, "src/features/analytics");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function read(path) {
  return readFileSync(path, "utf8");
}

describe("analytics core static contract", () => {
  it("stays inside the W1-ANALYTICS write allowlist and rejects donor hazards", () => {
    const files = walk(featureRoot);
    expect(files.some((path) => path.endsWith("contract.js"))).toBe(true);
    const blob = files.map(read).join("\n");
    expect(blob).not.toMatch(/service_role|SERVICE_ROLE|createServiceClient/);
    expect(forbiddenSupabaseRefsIn(blob)).toEqual([]);
    expect(blob).not.toMatch(/use server|next\/link|createServiceClient/);
    expect(blob).not.toMatch(/Antigravity/i);
    expect(blob).toContain("donor-baseline-20260721");
    expect(blob).toContain("get_organization_analytics_snapshot");
    expect(blob).toContain("private.has_organization_role");
  });
});
