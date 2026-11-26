import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileTopBar } from "../src/components/MobileTopBar.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OrganizationNameProvider } from "../src/lib/organizationName.js";

// UX-UG-ROLE-QUALIFIED-ORG-LINE-HARDCODED-IN-TWO-COMPONENTS-20260920.
// DesktopRail and MobileTopBar used to write `a fixed organization name · ${role}` straight into
// the markup whenever a role label existed, so that line never reached the
// catalogue next to shell.orgLine. Both now read shell.orgLineRole.
describe("role-qualified shell org line", () => {
  it("has shell org lines driven by the organization's own name in every locale", () => {
    for (const lang of Object.keys(catalogue)) {
      expect(catalogue[lang]["shell.orgLineRole"], lang).toContain("{role}");
      expect(catalogue[lang]["shell.orgLineRole"], lang).toContain("{organization}");
      expect(catalogue[lang]["shell.orgLine"], lang).toBe("{organization}");
      expect(catalogue[lang]["dialogs.profileEyebrow"], lang).toContain("{organization}");
    }
  });

  it.each(["src/components/DesktopRail.jsx", "src/components/MobileTopBar.jsx"])(
    "%s reads the org line from the catalogue",
    (file) => {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src).not.toMatch(/a fixed organization name ·/);
      expect(src).toContain('t("shell.orgLineRole"');
    },
  );

  it.each(["en", "es"])("renders the %s line with the member's organization name on the phone top bar", (lang) => {
    const { container } = render(
      <LanguageProvider lang={lang}>
        <OrganizationNameProvider value="Example Workers Local 1">
          <MobileTopBar initials="MR" roleLabel="Steward" />
        </OrganizationNameProvider>
      </LanguageProvider>,
    );
    expect(container.querySelector(".mobile-top__role").textContent).toBe("Example Workers Local 1 · Steward");
  });

  it("falls back to the product name when no organization name is known", () => {
    for (const value of [null, "", "   "]) {
      const { container, unmount } = render(
        <LanguageProvider lang="en">
          <OrganizationNameProvider value={value}>
            <MobileTopBar initials="MR" roleLabel="Steward" />
          </OrganizationNameProvider>
        </LanguageProvider>,
      );
      expect(container.querySelector(".mobile-top__role").textContent).toBe("Union Ground · Steward");
      unmount();
    }
  });
});
