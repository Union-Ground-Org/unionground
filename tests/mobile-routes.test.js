// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseAppRoute, routerPath } from "../apps/mobile/src/lib/routes.ts";

describe("Union Ground mobile routes", () => {
  it("parses organizing tabs and rejects Union Ground schemes", () => {
    expect(parseAppRoute("unionground://campaign")).toEqual({ kind: "tab", tab: "campaign" });
    // Rights is reachable from All tools; the earlier deep link still opens it.
    expect(parseAppRoute("unionground://rights")).toEqual({ kind: "feature", key: "rights" });
    expect(parseAppRoute("unionground://recognition")).toEqual({ kind: "recognition" });
    expect(routerPath({ kind: "recognition" })).toBe("/recognition");
    expect(parseAppRoute("unionbase://home")).toBeNull();
    expect(routerPath({ kind: "tab", tab: "home" })).toBe("/(tabs)/home");
  });

  it("maps a preview issue deep link to the issue screen", () => {
    expect(parseAppRoute("unionground://issue/33333333-3333-4333-8333-333333333333")).toEqual({
      kind: "issue",
      id: "33333333-3333-4333-8333-333333333333",
    });
    expect(routerPath({ kind: "issue", id: "33333333-3333-4333-8333-333333333333" })).toBe(
      "/issue/33333333-3333-4333-8333-333333333333",
    );
  });
});
