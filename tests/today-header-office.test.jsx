import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TodayView } from "../src/views/TodayView.jsx";
import { MobileTopBar } from "../src/components/MobileTopBar.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { highestOfficeKey } from "../src/lib/staffPlaneStyles.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// BUG-UG-HOME-AND-TOP-BAR-CALL-OFFICERS-MEMBER-20261006: a chapter
// President saw "Member" on Home and in the top bar while the leadership list
// said President. Both now name the highest office beside the worn hat.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const withRoles = (chapterRoles, organizationRoles = []) => ({
  ...fallbackData, member: { ...fallbackData.member, chapterRoles, organizationRoles },
});

describe("office beside the hat", () => {
  it("picks the highest office the person holds", () => {
    expect(highestOfficeKey({ chapterRoles: ["steward"], organizationRoles: ["admin", "vp"] })).toBe("demo.hatVp");
    expect(highestOfficeKey({ chapterRoles: ["steward"] })).toBe("demo.hatSteward");
    expect(highestOfficeKey({ chapterRoles: [], organizationRoles: [] })).toBeNull();
    expect(highestOfficeKey(null)).toBeNull();
    // No membership row flagged selected: data.roles still carries the office.
    expect(highestOfficeKey({ chapterRoles: [], organizationRoles: [] }, ["steward"])).toBe("demo.hatSteward");
    expect(highestOfficeKey({ organizationRoles: ["coordinator"] })).toBe("demo.hatCoordinator");
    expect(highestOfficeKey({ chapterRoles: ["advisor"] }, "vp")).toBe("demo.hatAdvisor");
    expect(highestOfficeKey(undefined, ["admin"])).toBe("demo.hatAdmin");
    expect(highestOfficeKey({ chapterRoles: ["secretary", "steward"] })).toBe("access.role.secretary");
    expect(highestOfficeKey({ chapterRoles: ["records"] })).toBe("access.role.records");
  });

  it.each([["en", "Campaign chair"], ["es", "Presidencia de campaña"]])("names the office on the %s Home identity line", (lang, office) => {
    const { container } = render(<LanguageProvider lang={lang}><TodayView data={withRoles(["steward"], ["vp"])} /></LanguageProvider>);
    const lines = [...container.querySelectorAll(".today-identity, .today-greet p, p")].map((node) => node.textContent);
    expect(lines.some((text) => text.includes(`${office} · ${fallbackData.member.roleLine}`))).toBe(true);
  });

  it("lets the phone top bar's role row wrap instead of clipping the office", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const rule = css.match(/\.mobile-top--with-menu \.mobile-top__role \{([^}]*)\}/)[1];
    expect(rule).toContain("white-space: normal");
    expect(rule).not.toContain("ellipsis");
  });

  it("adds nothing for a member with no office", () => {
    const { container } = render(<LanguageProvider lang="en"><TodayView data={withRoles([])} /></LanguageProvider>);
    const lines = [...container.querySelectorAll("p")].map((node) => node.textContent);
    expect(lines.some((text) => text.includes(` · ${fallbackData.member.roleLine}`))).toBe(true);
    expect(lines.some((text) => /(Campaign chair|Committee|Admin) · /.test(text) && text.includes(fallbackData.member.roleLine))).toBe(false);
  });

  it.each([
    ["en", true], ["es", true], ["en", false], ["es", false],
  ])("places separators only between identity labels (%s, desktop %s)", (lang, desktop) => {
    const date = new Date(2026, 5, 16, 12);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(date);

    const data = withRoles([]);
    const home = (profile = {}) => (
      <LanguageProvider lang={lang}>
        <TodayView
          data={{ ...data, roles: [], member: { ...data.member, roleLine: "", sinceYear: null, chapterId: null, ...profile } }}
          desktop={desktop}
        />
      </LanguageProvider>
    );
    const { container, rerender } = render(home());
    const caption = () => container.querySelector(desktop ? ".home-ph .today-identity" : ".home-greet > p").textContent;
    const lead = desktop
      ? new Intl.DateTimeFormat(lang === "es" ? "es" : "en-US", { weekday: "long", month: "long", day: "numeric" }).format(date)
      : catalogue[lang]["today.greetSub"];
    expect(caption()).toBe(lead);

    rerender(home({ roleLine: "  ", sinceYear: 2019 }));
    expect(caption()).toBe(lead);

    rerender(home({ organizationRoles: ["admin"], roleLine: null }));
    const office = catalogue[lang]["demo.hatAdmin"];
    expect(caption()).toBe(`${lead} · ${office}`);

    rerender(home({ organizationRoles: ["admin"], roleLine: "Member", sinceYear: 2019 }));
    const role = catalogue[lang]["seededLabels.roleLine.member"];
    expect(caption()).toBe(`${lead} · ${office} · ${role}`);
  });

  it.each([
    ["en", true, "Admin", "Your campaign: Larkspur Main Depot"],
    ["es", false, "Administrador", "Tu campaña: Larkspur Main Depot"],
  ])("shows chapter context and names the admin office once (%s)", (lang, desktop, office, chapter) => {
    const data = withRoles([], ["admin"]);
    const home = (roleLine) => (
      <LanguageProvider lang={lang}>
        <TodayView data={{ ...data, member: { ...data.member, roleLine, chapterId: "larkspur", chapterName: "Larkspur Main Depot" } }} desktop={desktop} />
      </LanguageProvider>
    );
    const { container, rerender } = render(home("Administrator · Larkspur Workers"));
    const caption = () => container.querySelector(desktop ? ".home-ph .today-identity" : ".home-greet > p").textContent;
    expect(caption()).toContain(`${office} · Larkspur Workers`);
    expect(caption()).toContain(chapter);
    rerender(home("Administrator of Repairs · Larkspur Workers"));
    expect(caption()).toContain(`${office} · Administrator of Repairs · Larkspur Workers`);
  });

  it("names the office beside the member hat in the top bar, and not over a staff hat", () => {
    const { container, rerender } = render(<LanguageProvider lang="en"><MobileTopBar initials="RH" officeLabel="Campaign chair" /></LanguageProvider>);
    expect(container.querySelector(".mobile-top__role").textContent).toBe("Union Ground · Worker · Campaign chair");
    rerender(<LanguageProvider lang="en"><MobileTopBar initials="RH" roleLabel="Committee" officeLabel="Campaign chair" /></LanguageProvider>);
    expect(container.querySelector(".mobile-top__role").textContent).toBe("Union Ground · Committee");
  });
});
