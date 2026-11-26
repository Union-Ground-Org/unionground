import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { t as translate } from "../src/lib/i18n.js";
import { LanguageProvider, ORGANIZATION_LABEL_KEYS, organizationTranslator, useLang } from "../src/lib/LanguageContext.jsx";

function Labels() {
  const { t } = useLang();
  return <>
    <span data-testid="home">{t("nav.home")}</span>
    <span data-testid="admin">{t("admin.title")}</span>
    <span data-testid="password">{t("auth.password")}</span>
  </>;
}

describe("organization label translation boundary", () => {
  it("applies allowlisted organization wording across shared navigation and staff surfaces", () => {
    render(
      <LanguageProvider lang="en" labelOverrides={{ "nav.home": "Start", "admin.title": "Operations" }}>
        <Labels />
      </LanguageProvider>,
    );
    expect(screen.getByTestId("home")).toHaveTextContent("Start");
    expect(screen.getByTestId("admin")).toHaveTextContent("Operations");
    expect(ORGANIZATION_LABEL_KEYS).toContain("staff.chapterWork");
  });

  it("cannot override unrelated copy or admit empty and oversized labels", () => {
    render(
      <LanguageProvider lang="en" labelOverrides={{
        "auth.password": "Secret phrase",
        "nav.home": " ",
        "admin.title": "x".repeat(41),
      }}>
        <Labels />
      </LanguageProvider>,
    );
    expect(screen.getByTestId("home")).toHaveTextContent("Home");
    expect(screen.getByTestId("admin")).toHaveTextContent("Campaign admin");
    expect(screen.getByTestId("password")).toHaveTextContent("Password");
  });

  // BUG-UG-ORG-LABEL-OVERRIDES-NOT-LOCALIZED-20261106: Tamarack's
  // English menu names showed as the only English items in the Spanish menu.
  it("shows menu and page name overrides in English only and keeps the product label in Spanish", () => {
    const overrides = {
      "nav.myCases": "My grievances",
      "nav.knowRights": "Contract & rights",
      "workload.cat.priority": "Hot files",
      "term.chapter": "shop",
    };
    const en = organizationTranslator("en", overrides);
    const es = organizationTranslator("es", overrides);

    expect(en("nav.myCases")).toBe("My grievances");
    expect(en("nav.knowRights")).toBe("Contract & rights");
    expect(es("nav.myCases")).toBe(translate("es", "nav.myCases"));
    expect(es("nav.knowRights")).toBe(translate("es", "nav.knowRights"));
    expect(es("nav.myCases")).not.toBe("My grievances");
    expect(es("nav.knowRights")).not.toBe("Contract & rights");

    // The organization's own category names and its word for "chapter" are
    // its names in either language, so they still apply in Spanish.
    expect(es("workload.cat.priority")).toBe("Hot files");
    expect(es("term.chapter")).toBe(translate("es", "term.chapter"));
    expect(es("nav.myChapter")).toMatch(/shop/i);
  });

  it("renders the Spanish menu label through the provider when an English override exists", () => {
    render(
      <LanguageProvider lang="es" labelOverrides={{ "nav.home": "Start", "admin.title": "Operations" }}>
        <Labels />
      </LanguageProvider>,
    );
    expect(screen.getByTestId("home")).toHaveTextContent(translate("es", "nav.home"));
    expect(screen.getByTestId("admin")).toHaveTextContent(translate("es", "admin.title"));
    expect(screen.getByTestId("home")).not.toHaveTextContent("Start");
  });
});
