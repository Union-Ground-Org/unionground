import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { LEGAL_CONTENT_LAST_REVIEWED, PRIVACY_EFFECTIVE_DATE } from "../src/lib/legalContent.js";
import { LEGAL_CHANGELOG_PATH, LEGAL_INSTRUMENTS, currentLegalVersions, legalChangelog, legalChangeNotice } from "../src/lib/legalInstruments.js";
import { LegalView, LegalInstrumentView, LegalChangelogView } from "../src/views/LegalView.jsx";
import { LegalChangeNotice } from "../src/components/LegalChangeNotice.jsx";
import { SUPPORT_EMAIL } from "./helpers/fictional-provider.js";

// Union Ground publishes no mailbox, so the shipped pages say so. The
// contact-link assertions run against a fictional published owner and support
// mailbox; the no-address behaviour is asserted separately against the real
// (empty) contact module.
const OWNER_EMAIL = "owner@unionground.test";
const CONTACTS = Object.freeze({
  owner: Object.freeze({ email: OWNER_EMAIL, href: `mailto:${OWNER_EMAIL}` }),
  support: Object.freeze({ email: SUPPORT_EMAIL, href: `mailto:${SUPPORT_EMAIL}` }),
});
vi.mock("../src/lib/publicContact.js", () => {
  const contacts = {
    owner: { email: "owner@unionground.test", href: "mailto:owner@unionground.test" },
    support: { email: "support@unionground.test", href: "mailto:support@unionground.test" },
  };
  return {
    PUBLIC_CONTACTS: contacts,
    PUBLIC_POSTAL_ADDRESS: null,
    publicContact: (role) => (Object.hasOwn(contacts, role) ? contacts[role] : null),
  };
});

// Supply future publications at the registry boundary, keeping the real version
// comparison, changelog ordering and acceptance rules in the rendering tests.
// No future effective date or operative policy is added to the product registry.
const registry = vi.hoisted(() => ({ instruments: null }));
vi.mock("../src/lib/legalInstruments.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    legalInstrument: (key) => (registry.instruments ?? actual.LEGAL_INSTRUMENTS).find((entry) => entry.key === key) ?? null,
    legalChangelog: () => actual.legalChangelog(registry.instruments ?? actual.LEGAL_INSTRUMENTS),
    legalChangeNotice: (accepted) => actual.legalChangeNotice(accepted, registry.instruments ?? actual.LEGAL_INSTRUMENTS),
  };
});

beforeEach(() => { registry.instruments = null; });

function localized(ui, lang) {
  return <LanguageProvider lang={lang}>{ui}</LanguageProvider>;
}

// An instrument as it stood at its first registration: 0.1.0, not material,
// not operative, no effective date. Fixtures build later versions on it.
function registered(entry) {
  return { ...entry, version: "0.1.0", effectiveDate: null, status: "pending-review", changelog: [entry.changelog[0]] };
}

function publication(entry, version, material) {
  return {
    ...entry,
    version,
    effectiveDate: "2026-11-20",
    changelog: [
      ...entry.changelog,
      { version, date: "2026-11-20", material, noteKey: "legal.changelog.note.registered" },
    ],
  };
}

describe.each(["en", "es"])("layered legal pages in %s", (lang) => {
  it("carries the free invitation-only organization pilot through the summary, and the terms route publishes no text yet", () => {
    const promise = lang === "en"
      ? "Union Ground is free for pilot organizations, by invitation."
      : "Union Ground es gratuito para las organizaciones piloto, por invitación.";
    const summary = render(localized(<LegalView page="terms" />, lang));
    expect(screen.getByText(t(lang, "legal.terms.fees.body"))).toHaveTextContent(promise);
    summary.unmount();
    // This edition publishes no operative terms text: the instrument route
    // says the text is not published yet.
    render(localized(<LegalInstrumentView instrumentKey="terms-of-use" />, lang));
    expect(screen.getByText(t(lang, "legal.instrument.text.body"))).toBeInTheDocument();
  });

  it("publishes the pilot clarification as a nonmaterial revision", () => {
    const terms = LEGAL_INSTRUMENTS.find((entry) => entry.key === "terms-of-use");
    expect(terms.changelog.find((change) => change.version === "1.0.1")).toEqual({
      version: "1.0.1", date: "2026-10-23", material: false,
      noteKey: "legal.changelog.note.freePilotClarification",
    });
    // 1.0.1 re-prompts no one; the later material 1.1.0 (Compass training)
    // is what asks a 1.0.0 or 1.0.1 acceptance again.
    expect(terms.changelog.filter((change) => change.material).at(-1).version).toBe("1.1.0");
    expect(legalChangeNotice({ ...currentLegalVersions(), "terms-of-use": "1.0.1" }).reacceptanceRequired).toBe(true);
    render(localized(<LegalChangelogView />, lang));
    expect(screen.getByText(t(lang, "legal.changelog.note.freePilotClarification"), { exact: false })).toBeInTheDocument();
  });

  it.each(LEGAL_INSTRUMENTS)("links the $summaryPath summary to $path at its published version", (instrument) => {
    render(localized(<LegalView page={instrument.summaryPage} />, lang));
    expect(screen.getByRole("heading", { level: 1, name: t(lang, instrument.summaryTitleKey) })).toBeInTheDocument();
    const section = screen.getByRole("region", { name: t(lang, "legal.summary.instrument.title") });
    expect(within(section).getByRole("link", {
      name: t(lang, "legal.summary.instrument.link", { name: t(lang, instrument.summaryTitleKey), version: instrument.version }),
    })).toHaveAttribute("href", instrument.path);
    const index = screen.getByRole("navigation", { name: t(lang, "legal.contents") });
    expect(within(index).getByRole("link", { name: t(lang, "legal.summary.instrument.title") })).toHaveAttribute("href", "#legal-instrument");
    expect(screen.getByText((_, element) => element?.className === "legal-page__notice"))
      .toHaveTextContent(t(lang, "legal.lastReviewed", { date: LEGAL_CONTENT_LAST_REVIEWED }));
  });

  it.each(LEGAL_INSTRUMENTS)("renders $path with its version, pending status, the unpublished-text section and return links", (instrument) => {
    render(localized(<LegalInstrumentView instrumentKey={instrument.key} />, lang));
    expect(screen.getByRole("heading", {
      level: 1, name: t(lang, "legal.instrument.title", { name: t(lang, instrument.summaryTitleKey) }),
    })).toBeInTheDocument();
    const notice = screen.getByText((_, element) => element?.className === "legal-page__notice");
    expect(notice).toHaveTextContent(t(lang, "legal.instrument.version", { version: instrument.version }));
    expect(notice).toHaveTextContent(t(lang, "legal.instrument.pendingEffective"));
    expect(notice).toHaveTextContent(t(lang, "legal.instrument.notOperative"));
    // The route carries the sections the shared source lists (here the
    // statement that the text is not published yet), in the reader's locale.
    const main = screen.getByRole("main");
    const headings = [...main.querySelectorAll("section[id^='legal-section-'] > h2")].map((node) => node.textContent);
    expect(headings).toEqual([...instrument.sections.map(([headingKey]) => t(lang, headingKey)), t(lang, "legal.instrument.acceptance.title")]);
    for (const [, bodyKey] of instrument.sections) expect(main).toHaveTextContent(t(lang, bodyKey));
    expect(screen.getByText(t(lang, "legal.instrument.acceptance.body"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t(lang, "legal.instrument.links.summary") })).toHaveAttribute("href", instrument.summaryPath);
    expect(screen.getByRole("link", { name: t(lang, "legal.instrument.links.changelog") })).toHaveAttribute("href", LEGAL_CHANGELOG_PATH);
    const contact = ["terms", "accessibility"].includes(instrument.summaryPage) ? CONTACTS.support : CONTACTS.owner;
    expect(screen.getByRole("link", { name: contact.email })).toHaveAttribute("href", contact.href);
  });

  it("renders every published change with date, materiality and an instrument link", () => {
    render(localized(<LegalChangelogView />, lang));
    expect(screen.getByRole("heading", { level: 1, name: t(lang, "legal.changelog.title") })).toBeInTheDocument();
    for (const change of legalChangelog()) {
      const heading = screen.getByRole("heading", {
        level: 2,
        name: `${t(lang, change.instrument.summaryTitleKey)} · ${t(lang, "legal.changelog.entry", { version: change.version, date: change.date })}`,
      });
      const section = within(heading.closest("section"));
      const materiality = t(lang, change.material ? "legal.changelog.material" : "legal.changelog.notMaterial");
      expect(section.getByText(`${t(lang, change.noteKey)} ${materiality}`)).toBeInTheDocument();
      expect(section.getByRole("link")).toHaveAttribute("href", change.instrument.path);
    }
  });

  it("selects a different instrument and displays an effective date supplied by the registry", () => {
    registry.instruments = LEGAL_INSTRUMENTS.map((entry) => publication(entry, "2.0.0", true));
    const view = render(localized(<LegalInstrumentView instrumentKey={LEGAL_INSTRUMENTS[0].key} />, lang));
    expect(screen.getByText((_, element) => element?.className === "legal-page__notice"))
      .toHaveTextContent(t(lang, "legal.privacy.effective", { date: "2026-11-20" }));
    view.rerender(localized(<LegalInstrumentView instrumentKey={LEGAL_INSTRUMENTS[1].key} />, lang));
    expect(screen.getByRole("heading", {
      level: 1, name: t(lang, "legal.instrument.title", { name: t(lang, LEGAL_INSTRUMENTS[1].summaryTitleKey) }),
    })).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.className === "legal-page__notice"))
      .toHaveTextContent(t(lang, "legal.instrument.version", { version: "2.0.0" }));
    expect(screen.getByRole("link", { name: t(lang, "legal.instrument.links.summary") })).toHaveAttribute("href", "/terms");
  });

  it("says plainly that a version which is not operative has no effective date", () => {
    registry.instruments = [registered(LEGAL_INSTRUMENTS[0])];
    render(localized(<LegalInstrumentView instrumentKey={LEGAL_INSTRUMENTS[0].key} />, lang));
    const notice = screen.getByText((_, element) => element?.className === "legal-page__notice");
    expect(notice).toHaveTextContent(t(lang, "legal.instrument.pendingEffective"));
    expect(notice).toHaveTextContent(t(lang, "legal.instrument.notOperative"));
  });

  it("labels a later material publication before earlier nonmaterial entries", () => {
    registry.instruments = [publication(registered(LEGAL_INSTRUMENTS[0]), "2.0.0", true)];
    render(localized(<LegalChangelogView />, lang));
    const main = screen.getByRole("main");
    const entries = main.querySelectorAll("section[id^='legal-section-']");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent(t(lang, "legal.changelog.entry", { version: "2.0.0", date: "2026-11-20" }));
    expect(entries[0]).toHaveTextContent(t(lang, "legal.changelog.material"));
    expect(entries[1]).toHaveTextContent(t(lang, "legal.changelog.notMaterial"));
    // The route serves the current version only, so the older entry's link
    // names the version it actually opens, not the 0.1.0 it sits under.
    const olderLink = within(entries[1]).getByRole("link");
    expect(olderLink).toHaveAttribute("href", LEGAL_INSTRUMENTS[0].path);
    expect(olderLink).toHaveTextContent(t(lang, "legal.summary.instrument.link", { name: t(lang, LEGAL_INSTRUMENTS[0].summaryTitleKey), version: "2.0.0" }));
  });

  it("names only unaccepted material changes and removes the notice after acceptance", () => {
    registry.instruments = [
      publication(registered(LEGAL_INSTRUMENTS[0]), "2.0.0", true),
      publication(registered(LEGAL_INSTRUMENTS[1]), "3.0.0", true),
      publication(registered(LEGAL_INSTRUMENTS[2]), "4.0.0", false),
    ];
    const accepted = { [LEGAL_INSTRUMENTS[0].key]: "0.1.0", [LEGAL_INSTRUMENTS[2].key]: "0.1.0" };
    const view = render(localized(<LegalChangeNotice accepted={accepted} />, lang));
    const notice = screen.getByRole("complementary", { name: t(lang, "legal.changeNotice.label") });
    expect(within(notice).getByRole("heading", { name: t(lang, "legal.changeNotice.title") })).toBeInTheDocument();
    expect(notice).toHaveTextContent(t(lang, "legal.changeNotice.body", {
      instruments: [LEGAL_INSTRUMENTS[0], LEGAL_INSTRUMENTS[1]].map((entry) => t(lang, entry.summaryTitleKey)).join(", "),
    }));
    expect(notice).not.toHaveTextContent(t(lang, LEGAL_INSTRUMENTS[2].summaryTitleKey));
    expect(within(notice).getByRole("link", { name: t(lang, "legal.changeNotice.changelog") })).toHaveAttribute("href", LEGAL_CHANGELOG_PATH);
    view.rerender(localized(<LegalChangeNotice accepted={currentLegalVersions(registry.instruments)} />, lang));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("legal route edge states", () => {
  it("keeps the deletion page's related links and effective date without an instrument", () => {
    render(localized(<LegalView page="deletionRequest" />, "en"));
    expect(screen.getByRole("heading", { level: 1, name: t("en", "legal.deletionRequest.title") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("en", "legal.deletionRequest.links.privacy") })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: t("en", "legal.deletionRequest.links.retention") })).toHaveAttribute("href", "/retention");
    expect(screen.queryByRole("region", { name: t("en", "legal.summary.instrument.title") })).not.toBeInTheDocument();
    // Union Ground's privacy summary is not in force yet (no effective
    // date), so the page states the review date and claims no effective date.
    expect(PRIVACY_EFFECTIVE_DATE).toBeNull();
    const notice = screen.getByText((_, element) => element?.className === "legal-page__notice");
    expect(notice).toHaveTextContent(t("en", "legal.lastReviewed", { date: LEGAL_CONTENT_LAST_REVIEWED }));
    expect(notice).not.toHaveTextContent(t("en", "legal.privacy.effective", { date: "" }).replace(/\s*\.$/, ""));
  });

  it("falls back to privacy summary content for an unknown page", () => {
    render(localized(<LegalView page="unknown" />, "en"));
    expect(screen.getByRole("heading", { level: 1, name: t("en", "legal.privacy.title") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: CONTACTS.owner.email })).toHaveAttribute("href", CONTACTS.owner.href);
  });

  it("says no address is published when Union Ground has no mailbox", async () => {
    vi.doUnmock("../src/lib/publicContact.js");
    vi.resetModules();
    try {
      const rtl = await import("@testing-library/react");
      const { LegalView: FreshLegalView, LegalInstrumentView: FreshInstrumentView } = await import("../src/views/LegalView.jsx");
      const { LanguageProvider: FreshProvider } = await import("../src/lib/LanguageContext.jsx");
      const { t: freshT } = await import("../src/lib/i18n.js");
      const { LEGAL_INSTRUMENTS: freshInstruments } = await import("../src/lib/legalInstruments.js");
      for (const ui of [
        <FreshProvider lang="en"><FreshLegalView page="privacy" /></FreshProvider>,
        <FreshProvider lang="en"><FreshLegalView page="terms" /></FreshProvider>,
        <FreshProvider lang="en"><FreshInstrumentView instrumentKey={freshInstruments[0].key} /></FreshProvider>,
      ]) {
        const view = rtl.render(ui);
        const section = view.container.querySelector(".legal-page__contact");
        expect(section).toHaveTextContent(freshT("en", "legal.contact.none"));
        expect(section.querySelector("a")).toBeNull();
        view.unmount();
      }
    } finally {
      vi.resetModules();
    }
  });

  it("does not render an unknown instrument", () => {
    const { container } = render(localized(<LegalInstrumentView instrumentKey="unknown" />, "en"));
    expect(container).toBeEmptyDOMElement();
  });

  it("uses the privacy contact for an instrument without a mapped contact", () => {
    registry.instruments = [{ ...LEGAL_INSTRUMENTS[0], summaryPage: "unknown" }];
    render(localized(<LegalInstrumentView instrumentKey={LEGAL_INSTRUMENTS[0].key} />, "en"));
    expect(screen.getByRole("link", { name: CONTACTS.owner.email })).toHaveAttribute("href", CONTACTS.owner.href);
  });

  it("stays silent before acceptance is known or once the material versions are held", () => {
    const view = render(localized(<LegalChangeNotice />, "en"));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(localized(<LegalChangeNotice accepted={null} />, "en"));
    expect(view.container).toBeEmptyDOMElement();
    // Terms of use 0.2.0 (adults-only) is material, so a reader who holds it
    // is told nothing and a reader who holds nothing is told.
    view.rerender(localized(<LegalChangeNotice accepted={currentLegalVersions()} />, "en"));
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(localized(<LegalChangeNotice accepted={{}} />, "en"));
    expect(view.container).not.toBeEmptyDOMElement();
  });
});
