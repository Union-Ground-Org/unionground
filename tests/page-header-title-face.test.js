import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// UX-UG-STAFF-DESK-TITLES-SERIF-OFF-SYSTEM-20261108: staff desk page
// titles ("Casework desk", "Case queue", "Union office") rendered in Georgia
// while every other heading in the product uses the display face (Archivo),
// so the staff desks looked like a different product.
describe("page header title face", () => {
  const css = readFileSync("src/components/pageHeader.css", "utf8");
  const title = css.match(/\.sg-page-header \.phead__title\{([^}]*)\}/)?.[1] ?? "";

  it("uses the display face, like the member home and section headings", () => {
    expect(title).toContain("font-family:var(--display)");
    expect(title).not.toMatch(/Georgia|serif/);
  });
});
