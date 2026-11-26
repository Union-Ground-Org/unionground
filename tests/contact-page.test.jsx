import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactView } from "../src/views/ContactView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SUPPORT_EMAIL } from "./helpers/fictional-provider.js";
import { catalogue } from "../src/lib/i18n.js";
import { CONTACT_HELP, contactHelpFor } from "../src/lib/contactHelp.js";

async function renderContact() {
  const { ContactView } = await import("../src/views/ContactView.jsx");
  render(<LanguageProvider lang="en"><ContactView /></LanguageProvider>);
}

function expectSharedDocumentShell() {
  expect(screen.getByRole("heading", { name: "Contact Union Ground", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "On this page" })).toBeInTheDocument();

  // Shell-specific markers: the "On this page" index alone does not
  // distinguish PublicDocumentShell from a page-local table of contents.
  expect(screen.getByRole("banner")).toContainElement(screen.getByRole("link", { name: "Union Ground home" }));
  const documentLinks = screen.getByRole("navigation", { name: "Legal information" });
  for (const href of ["/about", "/contact", "/privacy", "/terms", "/accessibility", "/ai-disclosure", "/retention"]) {
    expect(documentLinks.querySelector(`a[href="${href}"]`)).not.toBeNull();
  }
  const footer = screen.getByRole("contentinfo");
  expect(footer).toHaveTextContent("Union Ground");
  // The site's shared footer (carried from upstream): its brand is a label,
  // and the header's brand is the page's one link home.
  expect(within(footer).getByRole("navigation", { name: "Site links" })).toBeInTheDocument();
  expect([...document.querySelectorAll('a[href="/"]')]).toEqual([screen.getByRole("link", { name: "Union Ground home" })]);
}

afterEach(() => {
  vi.doUnmock("../src/lib/publicContact.js");
  vi.resetModules();
});

describe("public contact page", () => {
  it("publishes distinct about, campaign, and support topics, and invents no mailbox while none is published", async () => {
    await renderContact();
    expectSharedDocumentShell();
    expect(screen.getByText(/has not published a contact address yet/)).toBeInTheDocument();
    for (const [heading, body] of [
      ["About Union Ground", "Questions about Union Ground and who runs it."],
      ["Using Union Ground for a campaign", "Questions about using Union Ground for a campaign or committee."],
      ["Product support", "Help with sign-in, accessibility, privacy, or an existing Union Ground workspace."],
    ]) {
      expect(screen.getByRole("heading", { name: heading, level: 2 })).toBeInTheDocument();
      expect(screen.getByText(`${body} No address is published yet. For account help, use the contact who provisioned your account.`)).toBeInTheDocument();
    }
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it("names a mailbox only on the topic whose role publishes one", async () => {
    vi.doMock("../src/lib/publicContact.js", async () => (await import("./helpers/fictional-provider.js")).publicContactModule());
    await renderContact();
    expectSharedDocumentShell();
    const support = screen.getByRole("heading", { name: "Product support", level: 2 }).closest("section");
    expect(within(support).getByRole("link", { name: SUPPORT_EMAIL })).toHaveAttribute("href", `mailto:${SUPPORT_EMAIL}`);
    expect(document.querySelectorAll('a[href^="mailto:"]')).toHaveLength(1);
    //  (WEB-PUB-05): product support asks for no worker or issue details.
    expect(screen.getByText("Please don't include worker or issue details in an email. Raise those with your committee member inside Union Ground.").closest("section"))
      .toContainElement(screen.getByRole("link", { name: SUPPORT_EMAIL }));
    expect(screen.getAllByText(/No address is published yet/)).toHaveLength(2);
  });

  // REQ-UG-PUBLIC-HELP-BEFORE-CONTACT-20261018
  it.each(["en", "es"])("leads with common problems and their self-service paths, then the addresses, and promises no reply time (%s)", (lang) => {
    const { container } = render(<LanguageProvider lang={lang}><ContactView /></LanguageProvider>);
    const help = CONTACT_HELP[lang];
    const section = container.querySelector("#contact-help");
    expect(section).not.toBeNull();
    expect(section).toHaveTextContent(help.title);
    const links = [...section.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/reset-password", "/request-invite"]);
    // Union Ground publishes no mailbox yet, so the help list stands alone.
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(container.querySelector('nav[aria-label] a[href="#contact-help"]')).not.toBeNull();
    // Recovery paths for people with no administrator to ask, and 48px targets.
    expect(section.textContent).toMatch(lang === "en" ? /only administrator/ : /única persona administradora/);
    expect(section.textContent).toMatch(lang === "en" ? /new campaign/ : /campaña nueva/);
    // BUG-UG-CONTACT-INLINE-HELP-LINK-LINEBOX-20261020: each link is its
    // own 48px block line under its sentence, not an inline box inside it.
    for (const link of section.querySelectorAll("a")) {
      expect(link).toHaveClass("contact-help__link");
      expect(link.getAttribute("style")).toBeNull();
    }
    const linkRule = /\.contact-help__link\s*\{([^}]*)\}/.exec(readFileSync("src/styles.css", "utf8"));
    expect(linkRule?.[1]).toMatch(/display:\s*flex/);
    expect(linkRule?.[1]).toMatch(/min-height:\s*48px/);
    expect(linkRule?.[1]).toMatch(/width:\s*fit-content/);
    // The help leads the page: its introduction comes before the address-first sentence.
    const text = container.textContent;
    expect(text.indexOf(help.intro)).toBeGreaterThan(-1);
    expect(text.indexOf(help.intro)).toBeLessThan(text.indexOf(catalogue[lang]["contact.intro"]));
    // The Terms disclaim a guaranteed response time, so no page text names one.
    expect(container.textContent).not.toMatch(/\b(within|dentro de)\b[^.]*\b(hour|day|business|hora|día|hábil)/i);
    expect(container.textContent).not.toMatch(/\b\d+\s*(hours?|business days?|horas?|días)\b/i);
  });

  it("falls back to the English problem list for an unsupported language", () => {
    expect(contactHelpFor("fr")).toBe(CONTACT_HELP.en);
    expect(contactHelpFor("es")).toBe(CONTACT_HELP.es);
  });
});
