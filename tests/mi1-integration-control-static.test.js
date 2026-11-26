// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";
import { DONOR_BASELINE_SHA, DONOR_REF, DONOR_REJECTED, DONOR_REUSE } from "../src/features/integrations/provenance.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featureDir = join(root, "src/features/integrations");

function readTree(directory) {
  return readdirSync(directory).map((name) => ({
    name,
    text: readFileSync(join(directory, name), "utf8"),
  }));
}

describe("MI1 integration-control static contracts", () => {
  const feature = readTree(featureDir);
  const featureText = feature.map((file) => file.text).join("\n");

  it("records donor provenance and rejected legacy assumptions", () => {
    expect(DONOR_BASELINE_SHA).toBe("donor-baseline-20260721");
    expect(DONOR_REF).toBe("archive/pre-clean-room-main-20260721");
    expect(DONOR_REUSE.some((entry) => entry.donorPath.includes("control-plane.ts"))).toBe(true);
    expect(DONOR_REJECTED.join("\n")).toMatch(/0752_integration_registry/);
    expect(DONOR_REJECTED.join("\n")).toMatch(/branch_id/);
    expect(DONOR_REJECTED.join("\n")).toMatch(/SCIM/);
  });

  it("does not ship donor credentials, project refs, or Next.js actions", () => {
    expect(forbiddenSupabaseRefsIn(featureText)).toEqual([]);
    expect(featureText).not.toMatch(/SERVICE_ROLE/);
    expect(featureText).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(featureText).not.toContain("use server");
    expect(featureText).not.toContain("sg_live_");
    expect(featureText).not.toContain("sg_scim_");
    expect(featureText).not.toMatch(/Antigravity/i);
  });

  it("keeps chapter overrides on chapterId and SCIM behind its default-off organization switch", () => {
    const controlPlane = feature.find((file) => file.name === "controlPlane.js").text;
    const scim = feature.find((file) => file.name === "scim.js").text;
    const store = feature.find((file) => file.name === "store.js").text;
    expect(controlPlane).toContain("chapterId");
    expect(controlPlane).not.toContain("branch_id");
    expect(scim).toContain('SCIM_SWITCH_KEY = "features.integrations.scim"');
    expect(store).toContain("evaluateScimMutation");
  });

  it("does not add an unreserved supabase migration", () => {
    const migrations = readdirSync(join(root, "supabase/migrations"));
    expect(migrations.some((name) => name.includes("integration_control") && name.startsWith("20260822"))).toBe(false);
  });
});
