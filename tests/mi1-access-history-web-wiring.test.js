import { describe, expect, it } from "vitest";
import { FEATURE_GROUPS } from "../src/lib/mobileNav.js";
import { MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { ACCESS_DATABASE_DEPENDENCIES, ACCESS_WEB_DONOR } from "../src/lib/mi1AccessHistoryWiring.js";

describe("MI1 access history web wiring", () => {
  it("rejects mixed own-activity donor feeds", () => {
    expect(ACCESS_WEB_DONOR.rejected).toEqual(expect.arrayContaining([
      "member-own votes, RSVPs, and questions presented as staff access",
      "actor email addresses",
    ]));
  });

  it("registers the member access-history destination", () => {
    expect(MEMBER_PATH_VIEWS["/m/access-history"]).toBe("accessHistory");
    expect(SPA_ROUTE_PATHS).toContain("/m/access-history");
    expect(FEATURE_GROUPS.find((group) => group.key === "account").items.map((item) => item.key)).toContain("accessHistory");
  });

  it("lists the landed session-scoped RPC contract", () => {
    expect(ACCESS_DATABASE_DEPENDENCIES.rpcs).toEqual([
      "list_my_access_history",
      "record_member_access_event",
    ]);
  });
});
