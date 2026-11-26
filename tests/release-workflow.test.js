// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const workflow = parseDocument(source).toJS();
const steps = workflow.jobs.release.steps;
const run = (index) => String(steps[index].run ?? "");

// Signed releases (docs/RELEASES.md): a v* tag builds, packs, inventories,
// attests and publishes, with the least permission that can do it.
describe("release workflow", () => {
  it("runs on a pushed v* tag, in the upstream repository only", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
    expect(workflow.jobs.release.if).toBe("github.repository == 'Union-Ground-Org/unionground'");
  });

  it("asks for contents, id-token and attestations write, and nothing else", () => {
    expect(workflow.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
    expect(workflow.jobs.release.permissions).toBeUndefined();
  });

  it("builds, packs dist, generates the SBOMs, attests and publishes, in that order", () => {
    const names = steps.map((step) => step.uses?.split("@")[0] ?? step.name);
    expect(names).toEqual([
      "actions/checkout", "actions/setup-node", "Install", "Build the official web app",
      "Pack dist", "Generate the SBOMs", "actions/attest-build-provenance", "Publish the release",
    ]);
    expect(run(2)).toBe("npm ci");
    expect(run(3)).toBe("npm run build");
    expect(steps[3].env).toEqual({ VITE_OFFICIAL_BRANDING: "1" });
    expect(run(4)).toMatch(/tar --sort=name .* -czf "release\/unionground-\$\{GITHUB_REF_NAME\}-web\.tar\.gz" -C dist \./s);
    expect(run(5)).toContain("node scripts/generate-sbom.mjs --out release/sbom");
    expect(steps[6].with["subject-path"]).toContain("release/*.tar.gz");
    expect(steps[6].with["subject-path"]).toContain("release/*.cdx.json");
    expect(run(7)).toContain('gh release create "${GITHUB_REF_NAME}" release/*');
    expect(steps[7].env).toEqual({ GH_TOKEN: "${{ github.token }}" });
  });

  it("pins the attestation action to a full commit", () => {
    expect(steps[6].uses).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
    expect(source).toContain("# actions/attest-build-provenance v3.2.0.");
  });

  it("documents how to verify a release", () => {
    const doc = readFileSync(new URL("../docs/RELEASES.md", import.meta.url), "utf8");
    expect(doc).toContain("gh attestation verify unionground-v1.0.0-web.tar.gz --repo Union-Ground-Org/unionground");
  });
});
