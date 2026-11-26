// UX-UG-PUBLIC-SITE-HEADER-FOOTER-AND-LANGUAGE-SWITCH-DIFFER-PAGE-TO-PAGE-20261122
// (#9539, C-1 and C-3): a visitor who chose Spanish reached /contact, /about
// and every legal page in Spanish with no control to go back. Every page that
// wears the site header now carries the EN ES toggle inside that one header,
// through the real router.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/AppRouter.jsx";
import { registerLanguage } from "../src/lib/i18n.js";
import { spanishCatalogue } from "../src/lib/i18n/es.js";
import { BOOT_LANGUAGE_STANDALONE_PATHS, LANGUAGE_SWITCH_STANDALONE_PATHS, StandaloneLanguageShell } from "../src/components/StandaloneLanguageShell.jsx";
import { SiteHeader } from "../src/components/SiteHeader.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { LegalView } from "../src/views/LegalView.jsx";

const HEADER_PAGES = [
  "/about", "/contact",
  "/privacy", "/terms", "/subprocessors", "/telemetry", "/accessibility", "/ai-disclosure", "/retention",
  "/privacy/deletion-request",
];

const realFetch = global.fetch;
beforeAll(() => { registerLanguage("es", spanishCatalogue.es); });
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sg-lang", "es");
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});
afterEach(() => {
  global.fetch = realFetch;
  localStorage.clear();
  document.documentElement.lang = "";
  window.history.replaceState({}, "", "/");
});

async function siteHeader() {
  await waitFor(() => expect(document.querySelector("header.site-head")).not.toBeNull(), { timeout: 5000 });
  return document.querySelector("header.site-head");
}

describe("the language switch on every signed-out page with the site header", () => {
  it.each(HEADER_PAGES)("%s: one header bar, the toggle inside it, and Spanish switches back to English", async (path) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    const header = await siteHeader();
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    // One banner: no separate language strip above the site header (C-3).
    expect(screen.getAllByRole("banner")).toEqual([header]);
    expect(document.querySelector(".standalone-language-bar")).toBeNull();
    // On a Spanish page the toggle names the language it switches to, English.
    const toEnglish = within(header).getByRole("button", { name: /^EN\s*ES\s*English$/ });
    expect(within(toEnglish).getByText("ES")).toHaveAttribute("data-current", "true");
    fireEvent.click(toEnglish);
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(localStorage.getItem("sg-lang")).toBe("en");
    const toSpanish = within(await siteHeader()).getByRole("button", { name: /^EN\s*ES\s*Español$/ });
    expect(within(toSpanish).getByText("EN")).toHaveAttribute("data-current", "true");
    expect(within(toSpanish).getByText("ES")).not.toHaveAttribute("data-current");
    // And back: the filled half follows every click.
    fireEvent.click(toSpanish);
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    const again = within(await siteHeader()).getByRole("button", { name: /^EN\s*ES\s*English$/ });
    expect(within(again).getByText("ES")).toHaveAttribute("data-current", "true");
    expect(localStorage.getItem("sg-lang")).toBe("es");
  });

  it("changes the header's own links with the language", async () => {
    window.history.replaceState({}, "", "/about");
    render(<App />);
    const header = await siteHeader();
    expect(within(header).getByRole("link", { name: "Iniciar sesión" })).toHaveAttribute("href", "/auth");
    fireEvent.click(within(header).getByRole("button", { name: /English$/ }));
    expect(await within(header).findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth");
  });

  it("shows no toggle on a header outside the signed-out page shell that was given no handler", () => {
    render(<LanguageProvider lang="es"><SiteHeader /></LanguageProvider>);
    expect(screen.queryByRole("button", { name: /^EN\s*ES/ })).toBeNull();
  });

  it("keeps the separate bar only on the pages that have no site header yet", () => {
    expect([...LANGUAGE_SWITCH_STANDALONE_PATHS]).toEqual(["/invite", "/app/invite", "/reset-password", "/app/reset-password", "/get-app", "/request-invite"]);
    for (const path of HEADER_PAGES) expect(LANGUAGE_SWITCH_STANDALONE_PATHS).not.toContain(path);
    // The pages that load the boot language are exactly those standalone pages.
    expect([...BOOT_LANGUAGE_STANDALONE_PATHS]).toEqual([...LANGUAGE_SWITCH_STANDALONE_PATHS]);
  });

  // With Spanish chosen, a legal page's body is the same text Main showed: the
  // shell only changes who owns the language, not what the page says.
  it.each(["privacy", "terms", "accessibility", "aiDisclosure", "retention", "deletionRequest"])("renders the %s page body exactly as Main did in Spanish", (page) => {
    const before = render(<LanguageProvider lang="es"><LegalView page={page} /></LanguageProvider>);
    const mainText = before.container.querySelector("main").textContent;
    before.unmount();
    render(<StandaloneLanguageShell><LegalView page={page} /></StandaloneLanguageShell>);
    expect(document.documentElement.lang).toBe("es");
    expect(document.querySelector("main").textContent).toBe(mainText);
  });

  it("does not add a second toggle on Home, which passes its own handler", async () => {
    const onLanguageChange = vi.fn();
    render(
      <StandaloneLanguageShell>
        <SiteHeader lang="en" onLanguageChange={onLanguageChange} />
      </StandaloneLanguageShell>,
    );
    const toggles = screen.getAllByRole("button", { name: /^EN\s*ES/ });
    expect(toggles).toHaveLength(1);
    await act(async () => { fireEvent.click(toggles[0]); });
    expect(onLanguageChange).toHaveBeenCalledWith("es");
  });
});

// Sol read of the held commit, answer 1: the first paint with a cold Spanish
// catalogue (the remembered choice is Spanish but its chunk is not loaded).
// Each case imports a fresh router so the catalogue registry starts with
// English only, and counts imports of the Spanish chunk.
describe("first paint with a cold Spanish catalogue", () => {
  const spanishChunk = { calls: 0 };

  async function coldRouter(path) {
    spanishChunk.calls = 0;
    vi.resetModules();
    vi.doMock("../src/lib/i18n/es.js", async (importOriginal) => {
      spanishChunk.calls += 1;
      return importOriginal();
    });
    window.history.replaceState({}, "", path);
    const { App: FreshApp } = await import("../src/AppRouter.jsx");
    const { languageLoaded } = await import("../src/lib/i18n.js");
    return { FreshApp, languageLoaded };
  }

  afterEach(() => { vi.doUnmock("../src/lib/i18n/es.js"); });

  it.each(["/about", "/privacy", "/contact"])("%s keeps Main's English first paint and fetches nothing until the toggle is used", async (path) => {
    const { FreshApp, languageLoaded } = await coldRouter(path);
    render(<FreshApp />);
    const header = await siteHeader();
    // Long enough for a load that had started to land.
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(document.documentElement.lang).toBe("en");
    expect(spanishChunk.calls).toBe(0);
    expect(languageLoaded("es")).toBe(false);
    fireEvent.click(within(header).getByRole("button", { name: /^EN\s*ES\s*Español$/ }));
    await waitFor(() => expect(document.documentElement.lang).toBe("es"), { timeout: 5000 });
    expect(spanishChunk.calls).toBe(1);
    expect(localStorage.getItem("sg-lang")).toBe("es");
  });
});
