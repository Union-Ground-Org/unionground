import { describe, expect, it, vi } from "vitest";
import { adminSetupPathFromSearch, safeAdminSetupPath, setupReviewReturnPath, setupSecurityPath } from "../src/lib/setupSecurityReturn.js";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const target = "/m/admin/setup-review?union=olms-900000077&build=chapter";

describe("setup-security return destinations", () => {
  it.each([
    "/m/admin", "/m/admin/setup-review", target,
    "/m/admin/setup-review?build=chapter", "/m/admin/setup-review?union=ug-0123456789",
    "/m/admin/setup-review?union=example-union",
  ])("preserves the supported local destination %s", (path) => {
    expect(safeAdminSetupPath(path)).toBe(path);
  });

  it.each([
    null, undefined, 12, "", "/m/admin/other", "/m/settings/security",
    "https://other.example/m/admin/setup-review", `${PORTAL_ORIGIN}/m/admin`,
    "//other.example/m/admin", "javascript:alert(1)", "/\\other.example/m/admin",
    "/m/admin/../admin/setup-review", "/m/admin/%2e%2e/admin/setup-review",
    "/m/admin%2fsetup-review", "/m/admin/setup-review#private",
    "/m/admin/setup-review?union=bad%0Aidentity", "/m/admin/setup-review?union=",
    "/m/admin/setup-review?union=one&union=two", "/m/admin/setup-review?build=chapter&build=other",
    "/m/admin/setup-review?build=other", "/m/admin?union=olms-77",
    "/m/admin/setup-review?token=private", "/m/admin/setup-review?setupReturnTo=%2Fm%2Fadmin",
    "/m/admin/setup-review?union=bad%ZZidentity", "/m/admin/setup-review?union=" + "a".repeat(129),
    "/m/admin/setup-review?build=chapter?union=olms-77",
    "/m/admin/setup-review?" + "a".repeat(2048), "/m/admin/setup-review\n",
  ])("refuses unsafe, unsupported or ambiguous input %j", (path) => {
    expect(safeAdminSetupPath(path)).toBeNull();
  });

  it("captures only public setup context from the current review page", () => {
    expect(setupReviewReturnPath("/m/admin/setup-review", "?union=olms-900000077&build=chapter&shell=classic&token=private")).toBe(target);
    expect(setupReviewReturnPath("/m/admin/setup-review/", "?build=chapter")).toBe("/m/admin/setup-review?build=chapter");
    expect(setupReviewReturnPath("/m/admin/setup-review", "")).toBe("/m/admin/setup-review");
    expect(setupReviewReturnPath("/m", "?union=olms-77&build=chapter")).toBeNull();
    expect(setupReviewReturnPath(null, "")).toBeNull();
    expect(setupReviewReturnPath("/m/admin/setup-review", null)).toBeNull();
    expect(setupReviewReturnPath("/m/admin/setup-review", "?" + "a".repeat(2048))).toBeNull();
    expect(setupReviewReturnPath("/m/admin/setup-review", "?union=one&union=two")).toBeNull();
  });

  it("carries an explicit review return and leaves generic notices unchanged", () => {
    const href = setupSecurityPath(target);
    expect(href.split("?")[0]).toBe("/m/settings/security");
    expect(new URLSearchParams(href.split("?")[1]).get("setupReturnTo")).toBe(target);
    expect(setupSecurityPath()).toBe("/m/settings/security");
    expect(setupSecurityPath("/m/admin")).toBe("/m/settings/security");
    expect(setupSecurityPath("https://other.example/m/admin/setup-review")).toBe("/m/settings/security");
  });

  it("reads a single validated return without trusting other security-page query data", () => {
    expect(adminSetupPathFromSearch(`?${new URLSearchParams({ setupReturnTo: target, shell: "classic" })}`)).toBe(target);
    expect(adminSetupPathFromSearch("")).toBe("/m/admin");
    expect(adminSetupPathFromSearch(null)).toBe("/m/admin");
    expect(adminSetupPathFromSearch("?" + "a".repeat(4096))).toBe("/m/admin");
    expect(adminSetupPathFromSearch("?setupReturnTo=%2Fm%2Fadmin&setupReturnTo=%2Fm%2Fadmin%2Fsetup-review")).toBe("/m/admin");
    expect(adminSetupPathFromSearch(`?${new URLSearchParams({ setupReturnTo: "https://other.example/m/admin" })}`)).toBe("/m/admin");
  });
});
