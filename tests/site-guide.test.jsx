import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
// REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: the real-account Site Guide
// ("How to use this site"): sections follow the person's own navigation, the
// organization admin can replace the words, and the shell offers the entry
// unless the organization switched it off.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { MobileCardNav } from "../src/components/MobileCardNav.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MEMBER_PATH_VIEWS, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { catalogue, t as translate } from "../src/lib/i18n.js";
import {
  SITE_GUIDE_SWITCH_KEY,
  buildSiteGuide,
  normalizeSiteGuide,
  siteGuideEnabled,
  siteGuideSaveArgs,
  siteGuideSectionSkeletons,
} from "../src/lib/siteGuide.js";
import { SiteGuideView } from "../src/views/SiteGuideView.jsx";
import { App } from "../src/App.jsx";

const en = (key, vars) => translate("en", key, vars);

function clientFor(payload, saveResult = { data: { saved: true }, error: null }) {
  return { rpc: vi.fn(async (name) => (name === "get_site_guide" ? { data: payload, error: null } : saveResult)) };
}

function renderGuide(props) {
  return render(<LanguageProvider lang={props.lang ?? "en"}><SiteGuideView {...props} /></LanguageProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe("site guide model", () => {
  it("is on unless the organization explicitly turned it off (old 0612 default)", () => {
    expect(siteGuideEnabled(null)).toBe(true);
    expect(siteGuideEnabled({ switches: {} })).toBe(true);
    expect(siteGuideEnabled({ switches: { [SITE_GUIDE_SWITCH_KEY]: false } })).toBe(false);
  });

  it("builds member sections for everyone and a desk section only for roles the account holds", () => {
    expect(siteGuideSectionSkeletons([]).map((section) => section.key)).toEqual(["me", "union", "account"]);
    const staff = siteGuideSectionSkeletons(["admin", "steward", "not-a-role"]);
    expect(staff.map((section) => section.key)).toEqual(["me", "union", "account", "steward", "admin"]);
    const account = staff.find((section) => section.key === "account");
    expect(account.destinations.map((item) => item.key)).toEqual(["accessHistory", "settings"]);
    expect(staff.find((section) => section.key === "steward").destinations.length).toBeGreaterThan(0);
  });

  it("uses the organization's words where saved and the translated defaults elsewhere", () => {
    const copy = normalizeSiteGuide({ state: "ready", enabled: true, canEdit: false, copy: {
      title: "Using our site", intro: null, helpTitle: null, helpBody: null,
      sections: { me: { body: "Your work.", steps: ["One", "", "Two"] }, "Bad Key": { body: "x" } },
    } }).copy;
    const guide = buildSiteGuide({ t: en, copy, roles: [] });
    expect(guide.title).toBe("Using our site");
    expect(guide.intro).toBe(en("siteGuide.intro"));
    expect(guide.sections[0]).toMatchObject({ key: "me", body: "Your work.", steps: ["One", "Two"], customized: true });
    expect(guide.sections[1]).toMatchObject({ key: "union", body: en("siteGuide.section.union.body"), customized: false });
    expect(Object.keys(copy.sections)).toEqual(["me"]);
  });

  it("turns the editor draft into bounded save arguments", () => {
    expect(siteGuideSaveArgs({
      title: "  ", intro: "Hello", helpTitle: "", helpBody: "",
      sections: { me: { body: "", steps: "a\n\n b \nc\nd\ne\nf\ng" }, union: { body: "", steps: "" } },
    }, () => "key-1")).toEqual({
      p_title: null, p_intro: "Hello", p_help_title: null, p_help_body: null,
      p_sections: { me: { steps: ["a", "b", "c", "d", "e", "f"] } },
      p_idempotency_key: "key-1",
    });
  });

  it("ships every Site Guide string in English and Spanish", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("siteGuide.") || key === "nav.siteGuide" || key.startsWith("settings.def.features.guidance_onboarding.site_guide."));
    expect(keys.length).toBeGreaterThanOrEqual(54);
    for (const key of keys) expect(catalogue.es[key], key).toEqual(expect.any(String));
  });
});

describe("site guide page", () => {
  it("renders the member's sections, destinations and help card from the defaults", async () => {
    const onNavigate = vi.fn();
    renderGuide({ client: clientFor({ state: "ready", enabled: true, canEdit: false, copy: null }), roles: [], onNavigate });
    const heading = screen.getByRole("heading", { level: 1, name: "Site guide" });
    expect(await screen.findByText("How to use this site")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Site guide" })).toBe(heading);
    for (const name of ["Me", "Campaign", "Account", "Need help right now?"]) expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit this guide" })).toBeNull();
    const union = screen.getByRole("article", { name: "Campaign" });
    fireEvent.click(within(union).getByRole("button", { name: "Worker support" }));
    expect(onNavigate).toHaveBeenCalledWith("memberSupport", "/m/support", "");
  });

  it.each([
    ["en", "Site guide"],
    ["es", "Guía del sitio"],
  ])("names the page while it loads in %s", (lang, name) => {
    renderGuide({ lang, client: { rpc: vi.fn(() => new Promise(() => {})) } });
    const guide = screen.getByRole("region", { name });
    const heading = within(guide).getByRole("heading", { level: 1, name });
    const status = within(guide).getByRole("status");
    expect(status.parentElement).toHaveAttribute("aria-busy", "true");
    expect(heading).toBeVisible();
    expect(heading.closest('[aria-busy="true"]')).toBeNull();
    expect(status).toHaveTextContent(translate(lang, "siteGuide.loading"));
  });

  it("keeps an organization's title and introduction beneath the page name", async () => {
    renderGuide({ client: clientFor({
      state: "ready", enabled: true, copy: { title: "A guide for Alder Falls", intro: "Start with the chapter calendar." },
    }) });
    expect(await screen.findByText("A guide for Alder Falls")).toBeVisible();
    expect(screen.getByText("Start with the chapter calendar.")).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([screen.getByRole("heading", { level: 1, name: "Site guide" })]);
  });

  it("shows the page name once when the saved guide title matches it", async () => {
    renderGuide({ client: clientFor({ state: "ready", enabled: true, copy: { title: "Site guide" } }) });
    await screen.findByRole("searchbox", { name: "Search the guide" });
    expect(screen.getAllByText("Site guide", { exact: true })).toEqual([screen.getByRole("heading", { level: 1, name: "Site guide" })]);
  });

  it("adds a desk section for a staff role the account holds", async () => {
    renderGuide({ client: clientFor({ state: "ready", enabled: true, canEdit: true, copy: null }), roles: ["steward"] });
    expect(await screen.findByRole("article", { name: "Committee" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Admin" })).toBeNull();
  });

  it("lets an admin save the organization's words and restore the defaults", async () => {
    const client = clientFor({ state: "ready", enabled: true, canEdit: true, copy: null });
    renderGuide({ client, roles: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Edit this guide" }));
    const form = screen.getByRole("form", { name: "Edit the site guide" });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Using Union Ground" } });
    const me = within(form).getByRole("group", { name: "Me" });
    fireEvent.change(within(me).getByLabelText("Tips, one per line (up to 6)"), { target: { value: "Check counts\nOpen cases" } });
    await expectHeldWriteFocus(client.rpc, within(form).getByRole("button", { name: "Save guide" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_site_guide", expect.objectContaining({
      p_title: "Using Union Ground",
      p_sections: { me: { steps: ["Check counts", "Open cases"] } },
    })));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Site guide saved."));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit this guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    await waitFor(() => expect(client.rpc).toHaveBeenLastCalledWith("save_site_guide", expect.objectContaining({
      p_title: null, p_intro: null, p_help_title: null, p_help_body: null, p_sections: {},
    })));
  });

  it("says plainly when the organization turned the guide off", async () => {
    renderGuide({ client: clientFor({ state: "ready", enabled: false, canEdit: true }), roles: [] });
    expect(await screen.findByText("The site guide is turned off for your organization.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Site guide" })).toBeVisible();
    expect(screen.getByText("Admins can turn it back on in Feature switches & limits.")).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("speaks Spanish", async () => {
    renderGuide({ lang: "es", client: null, roles: [] });
    expect(await screen.findByRole("heading", { level: 1, name: "Guía del sitio" })).toBeVisible();
    expect(screen.getByText("Cómo usar este sitio")).toBeVisible();
  });
});

describe("site guide entry points", () => {
  it("opens at /m/guide inside the app shell", async () => {
    window.history.replaceState({}, "", "/m/guide");
    window.scrollTo = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Site guide" }, { timeout: 5000 })).toBeVisible();
    await waitFor(() => expect(document.title).toMatch(/^Site guide · /));
    window.history.replaceState({}, "", "/m");
  });

  it("is a real SPA route served by the shell", () => {
    expect(MEMBER_PATH_VIEWS["/m/guide"]).toBe("siteGuide");
    expect(SPA_ROUTE_PATHS).toContain("/m/guide");
    expect(readFileSync("vercel.json", "utf8")).toContain('{ "source": "/m/guide", "destination": "/index.html" }');
  });

  it("appears in the rail and the phone All features card, and disappears when switched off", () => {
    const rail = (siteGuide) => render(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}} renderMode="desktop" siteGuide={siteGuide} />
      </LanguageProvider>,
    );
    const on = rail(true);
    expect(screen.getByRole("link", { name: "Site guide" })).toHaveAttribute("href", "/m/guide");
    on.unmount();
    const off = rail(false);
    expect(screen.queryByRole("link", { name: "Site guide" })).toBeNull();
    off.unmount();
    render(
      <LanguageProvider lang="en">
        <MobileCardNav onNavigate={() => {}} onAsk={() => {}} siteGuide><p>feed</p></MobileCardNav>
      </LanguageProvider>,
    );
    expect(within(document.querySelector("#card-nav-panel-features")).getByRole("link", { name: "Site guide" })).toBeInTheDocument();
  });
});
