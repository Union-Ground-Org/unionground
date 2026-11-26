// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featureDir = join(root, "src/features/qa");

function readTree(dir) {
  return readdirSync(dir).map((name) => ({
    name,
    text: readFileSync(join(dir, name), "utf8"),
  }));
}

describe("CR-018 donor-safety gate", () => {
  // The donor provenance, integration request and evidence notes were private
  // working documents; the leak scrub removed them from the public edition
  // (4b25ff95), so the case that read them is cut.
  it("does not import Next.js actions, service-role clients, or donor credentials", () => {
    const files = readTree(featureDir);
    expect(files.map((file) => file.name)).toEqual(expect.arrayContaining([
      "authorization.js",
      "adapter.js",
      "MemberQaForum.jsx",
      "OfficerQaQueue.jsx",
    ]));
    const blob = files
      .filter((file) => file.name.endsWith(".js") || file.name.endsWith(".jsx"))
      .map((file) => file.text)
      .join("\n");
    expect(blob).not.toMatch(/use server/);
    expect(blob).not.toMatch(/next\/cache|next\/navigation/);
    expect(blob).not.toMatch(/createServiceClient|service_role|SERVICE_ROLE/);
    expect(blob).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(forbiddenSupabaseRefsIn(blob)).toEqual([]);
    expect(blob).not.toMatch(/branch_id IS NULL|members\.role/);
    expect(blob).not.toMatch(/rewards_enabled|create-thread/);
    expect(blob).not.toContain("organization_id:");
    expect(blob).toContain("donor-baseline-20260721");
    expect(blob).toContain("Only a steward or officer can post an official reply.");
  });
});
