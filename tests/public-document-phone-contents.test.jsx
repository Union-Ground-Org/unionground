import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { LegalView } from "../src/views/LegalView.jsx";

// REQ-UG-LOVABLE-PUBLIC-SITE-BATCH-B-PORT-20261103 (WEB-PUB-04, -15,
// -24): on a phone the public document pages open with one closed "On this
// page · N sections" control listing every section; wide screens keep the
// open side index.
function stubWidth(phone) {
  vi.stubGlobal("matchMedia", (query) => ({
    matches: phone && query === "(max-width: 760px)",
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public document contents", () => {
  it.each([["en", "On this page", "sections"], ["es", "En esta página", "secciones"]])("folds every section into one closed control on a phone (%s)", (lang, label, unit) => {
    stubWidth(true);
    render(<LanguageProvider lang={lang}><LegalView page="privacy" /></LanguageProvider>);
    const contents = document.querySelector("details.public-document-contents");
    expect(contents).not.toBeNull();
    expect(contents.open).toBe(false);
    const links = [...contents.querySelectorAll("nav a")];
    const sections = [...document.querySelectorAll("main.legal-page section[id]")].filter((section) => links.some((link) => link.getAttribute("href") === `#${section.id}`));
    expect(links.length).toBeGreaterThan(3);
    expect(sections.length).toBe(links.length);
    expect(contents.querySelector("summary")).toHaveTextContent(`${label} · ${links.length} ${unit}`);
    expect(screen.getByRole("navigation", { name: label })).toBe(contents.querySelector("nav"));
    expect(document.querySelector("aside.public-document-index")).toBeNull();

    contents.open = true;
    fireEvent.click(contents.querySelector("nav"));
    expect(contents.open).toBe(true);
    fireEvent.click(links[1]);
    expect(contents.open).toBe(false);
  });

  // r3g4: a page with one section says "1 section", not "1 sections".
  it.each([["en", "On this page · 1 section"], ["es", "En esta página · 1 sección"]])("uses the singular for one section (%s)", async (lang, label) => {
    stubWidth(true);
    const { PublicDocumentShell } = await import("../src/components/PublicDocumentShell.jsx");
    render(<LanguageProvider lang={lang}><PublicDocumentShell eyebrow="E" title="T" intro="I" sections={[{ id: "only", heading: "Only" }]}><section id="only"><h2>Only</h2></section></PublicDocumentShell></LanguageProvider>);
    expect(document.querySelector("details.public-document-contents summary")).toHaveTextContent(label);
  });

  it("renders the side index when rendered on the server", () => {
    stubWidth(true);
    const html = renderToStaticMarkup(<LanguageProvider lang="en"><LegalView page="terms" /></LanguageProvider>);
    expect(html).toContain('class="public-document-index"');
    expect(html).not.toContain("public-document-contents");
  });

  it("keeps the open side index on a wide screen", () => {
    stubWidth(false);
    render(<LanguageProvider lang="en"><LegalView page="terms" /></LanguageProvider>);
    expect(document.querySelector("details.public-document-contents")).toBeNull();
    expect(document.querySelector("aside.public-document-index nav")).toBe(screen.getByRole("navigation", { name: "On this page" }));
  });
});
