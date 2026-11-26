import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deskWithGuides } from "../src/App.jsx";

// UB-UG-DEMO-STAFF-HATS-OPEN-ON-DESK-20261107: the live audit found
// every staff hat on the SAMPLE demo opening on a feature-guide checklist,
// with the desk half a screen down. On the shared demo personas the desk now
// leads and the guides follow it; real staff keep the guides first.
describe("staff desk and its guides", () => {
  const order = (deskFirst) => {
    const { container } = render(deskWithGuides(<section data-testid="desk">desk</section>, <aside data-testid="guides">guides</aside>, deskFirst));
    return [...container.children].map((node) => node.dataset.testid);
  };

  it("leads with the desk on the shared demo personas", () => {
    expect(order(true)).toEqual(["desk", "guides"]);
  });

  it("keeps the guides first for real staff", () => {
    expect(order(false)).toEqual(["guides", "desk"]);
  });

  it("tolerates a page with no guides", () => {
    const { container } = render(deskWithGuides(<section>desk</section>, null, true));
    expect(container.textContent).toBe("desk");
  });

  it("routes every staff desk and the guide card through it, keyed to the shared persona session", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    expect(source).toContain("const withPlaneGuides = (desk) => deskWithGuides(desk, planeGuideSlot, sharedPersonaSession);");
    for (const key of ["steward", "coordinator", "vp", "advisor", "admin"]) {
      expect(source, key).toContain(`views.${key} = withPlaneGuides(<>`);
      expect(source, key).not.toContain(`views.${key} = <>{planeGuideSlot}`);
    }
    expect(source).toContain("views[view] = deskWithGuides(staffGuidePage, staffGuideCard, sharedPersonaSession);");
  });
});
