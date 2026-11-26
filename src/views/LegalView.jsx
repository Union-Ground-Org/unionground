import { PublicContactLine, PublicDocumentShell } from "../components/PublicDocumentShell.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { publicContact } from "../lib/publicContact.js";
import { LEGAL_CONTENT_LAST_REVIEWED, PRIVACY_EFFECTIVE_DATE } from "../lib/legalContent.js";
import { LEGAL_CHANGELOG_PATH, legalChangelog, legalInstrument, legalInstrumentForSummary } from "../lib/legalInstruments.js";
import "../lib/i18n/features/subprocessorsStrings.js";
import "../lib/i18n/features/telemetryStrings.js";

const PAGES = {
  privacy: ["legal.privacy.title", "legal.privacy.intro", [
    ["legal.privacy.hold.title", "legal.privacy.hold.body"],
    ["legal.privacy.use.title", "legal.privacy.use.body"],
    ["legal.privacy.platformUpdates.title", "legal.privacy.platformUpdates.body"],
    ["legal.privacy.control.title", "legal.privacy.control.body"],
    ["legal.privacy.mobile.title", "legal.privacy.mobile.body"],
    ["legal.privacy.ai.title", "legal.privacy.ai.body"],
    ["legal.privacy.sharing.title", "legal.privacy.sharing.body"],
    ["legal.privacy.inviteRequests.title", "legal.privacy.inviteRequests.body"],
    // REQ-UG-REQUEST-TO-JOIN-PAGE-20261017: /join stores what it
    // collects, unlike /request-invite, so it has its own disclosure.
    ["legal.privacy.joinRequests.title", "legal.privacy.joinRequests.body"],
    // REQ-UG-UNION-DOCUMENT-INTAKE-PAGE-20261022: /contribute stores
    // contact details and uploaded files, so it has its own disclosure.
    ["legal.privacy.documentContributions.title", "legal.privacy.documentContributions.body"],
  ]],
  terms: ["legal.terms.title", "legal.terms.intro", [
    ["legal.terms.eligibility.title", "legal.terms.eligibility.body"],
    ["legal.terms.fees.title", "legal.terms.fees.body"],
    ["legal.terms.responsibility.title", "legal.terms.responsibility.body"],
    ["legal.terms.records.title", "legal.terms.records.body"],
    ["legal.terms.availability.title", "legal.terms.availability.body"],
    ["legal.terms.support.title", "legal.terms.support.body"],
    ["legal.terms.automated.title", "legal.terms.automated.body"],
    ["legal.terms.aiProviders.title", "legal.terms.aiProviders.body"],
  ]],
  accessibility: ["legal.accessibility.title", "legal.accessibility.intro", [
    ["legal.accessibility.standards.title", "legal.accessibility.standards.body"],
    ["legal.accessibility.supported.title", "legal.accessibility.supported.body"],
    ["legal.accessibility.report.title", "legal.accessibility.report.body"],
    ["legal.accessibility.alternative.title", "legal.accessibility.alternative.body"],
  ]],
  // REQ-UG-FORMAL-ACCESSIBILITY-STATEMENT-20261010 (owner decision
  // D-10, 2026-10-10): the formal statement is its own route behind the
  // summary. Every sentence comes from the retained 2026-09-13 VoiceOver
  // evaluation and the records it opened; nothing here claims conformance,
  // an external audit, or an appearance mode.
  accessibilityStatement: ["legal.accessibilityStatement.title", "legal.accessibilityStatement.intro", [
    ["legal.accessibilityStatement.status.title", "legal.accessibilityStatement.status.body"],
    ["legal.accessibilityStatement.scope.title", "legal.accessibilityStatement.scope.body"],
    ["legal.accessibilityStatement.evaluation.title", "legal.accessibilityStatement.evaluation.body"],
    ["legal.accessibilityStatement.exceptions.title", "legal.accessibilityStatement.exceptions.body"],
    ["legal.accessibilityStatement.unexercised.title", "legal.accessibilityStatement.unexercised.body"],
    ["legal.accessibilityStatement.feedback.title", "legal.accessibilityStatement.feedback.body"],
    ["legal.accessibilityStatement.alternative.title", "legal.accessibilityStatement.alternative.body"],
  ]],
  aiDisclosure: ["legal.aiDisclosure.title", "legal.aiDisclosure.intro", [
    ["legal.aiDisclosure.route.title", "legal.aiDisclosure.route.body"],
    ["legal.aiDisclosure.sent.title", "legal.aiDisclosure.sent.body"],
    ["legal.aiDisclosure.controls.title", "legal.aiDisclosure.controls.body"],
    ["legal.aiDisclosure.connector.title", "legal.aiDisclosure.connector.body"],
    ["legal.aiDisclosure.chapter.title", "legal.aiDisclosure.chapter.body"],
    ["legal.aiDisclosure.sensitive.title", "legal.aiDisclosure.sensitive.body"],
  ]],
  retention: ["legal.retention.title", "legal.retention.intro", [
    ["legal.retention.live.title", "legal.retention.live.body"],
    ["legal.retention.chapter.title", "legal.retention.chapter.body"],
    ["legal.retention.tasks.title", "legal.retention.tasks.body"],
    ["legal.retention.compass.title", "legal.retention.compass.body"],
    ["legal.retention.aiAggregate.title", "legal.retention.aiAggregate.body"],
    ["legal.retention.ballot.title", "legal.retention.ballot.body"],
    ["legal.retention.interest.title", "legal.retention.interest.body"],
    ["legal.retention.rsvp.title", "legal.retention.rsvp.body"],
    ["legal.retention.audit.title", "legal.retention.audit.body"],
    ["legal.retention.backups.title", "legal.retention.backups.body"],
  ]],
  deletionRequest: ["legal.deletionRequest.title", "legal.deletionRequest.intro", [
    ["legal.deletionRequest.inApp.title", "legal.deletionRequest.inApp.body"],
    ["legal.deletionRequest.email.title", "legal.deletionRequest.email.body"],
    ["legal.deletionRequest.verify.title", "legal.deletionRequest.verify.body"],
    ["legal.deletionRequest.timing.title", "legal.deletionRequest.timing.body"],
    ["legal.deletionRequest.record.title", "legal.deletionRequest.record.body"],
    ["legal.deletionRequest.scope.title", "legal.deletionRequest.scope.body"],
  ]],
};

// Destinations a reader of these two pages has to be able to reach, rendered as
// real anchors rather than prose: the privacy summary now has to point at the
// retention schedule and at the public deletion-request route, and the
// deletion-request page has to point back at both.
const RELATED_LINKS = {
  privacy: ["legal.privacy.links.title", [
    ["/retention", "legal.privacy.links.retention"],
    ["/privacy/deletion-request", "legal.privacy.links.deletion"],
  ]],
  deletionRequest: ["legal.deletionRequest.links.title", [
    ["/privacy", "legal.deletionRequest.links.privacy"],
    ["/retention", "legal.deletionRequest.links.retention"],
  ]],
  // The summary is where a reader looks for accessibility, so it carries the
  // only published link to the formal statement, and the statement links back.
  accessibility: ["legal.accessibility.links.title", [
    ["/accessibility/statement", "legal.accessibility.links.statement"],
  ]],
  accessibilityStatement: ["legal.accessibility.links.title", [
    ["/accessibility", "legal.accessibilityStatement.links.summary"],
  ]],
};

const CONTACT_BY_PAGE = {
  privacy: ["legal.contact.ownerBody", publicContact("owner")],
  terms: ["legal.contact.supportBody", publicContact("support")],
  accessibility: ["legal.contact.supportBody", publicContact("support")],
  accessibilityStatement: ["legal.contact.supportBody", publicContact("support")],
  aiDisclosure: ["legal.contact.ownerBody", publicContact("owner")],
  retention: ["legal.contact.ownerBody", publicContact("owner")],
  // The deletion-request page deliberately reuses the privacy page's published
  // address and its existing sentence. A deletion mailbox invented here would
  // be a second published contact with no operator behind it.
  deletionRequest: ["legal.contact.ownerBody", publicContact("owner")],
};

// Pages that are neither the terms nor a plain-language summary name their own
// notice. The formal accessibility statement is the first of them.
const NOTICE_BY_PAGE = {
  accessibilityStatement: "legal.accessibilityStatement.notice",
};

export function LegalView({ page }) {
  const { t } = useLang();
  const [titleKey, introKey, sections] = PAGES[page] || PAGES.privacy;
  const [contactBodyKey, contact] = CONTACT_BY_PAGE[page] || CONTACT_BY_PAGE.privacy;
  const [relatedTitleKey, relatedLinks] = RELATED_LINKS[page] || [null, []];
  const documentSections = sections.map(([headingKey, bodyKey, params], index) => ({
    id: `legal-section-${index + 1}`,
    heading: t(headingKey),
    body: t(bodyKey, params),
  }));
  const relatedSection = relatedTitleKey
    ? { id: "legal-related", heading: t(relatedTitleKey) }
    : null;
  // D-13: the summary stays the reading surface and links the instrument that
  // governs. The version in the link is the shared source's, never copy.
  const instrument = legalInstrumentForSummary(page);
  const instrumentSection = instrument
    ? { id: "legal-instrument", heading: t("legal.summary.instrument.title") }
    : null;
  const contactSection = { id: "legal-contact", heading: t("legal.contact.title") };
  // The privacy summary and the deletion route it publishes both carry an
  // effective date: "content last reviewed" describes the maintainers' pass
  // over the copy, not the date the terms of the policy took effect.
  const effectiveDated = (page === "privacy" || page === "deletionRequest") && Boolean(PRIVACY_EFFECTIVE_DATE);
  const notice = [
    t(NOTICE_BY_PAGE[page] ?? (page === "terms" ? "legal.termsNotice" : "legal.summaryNotice")),
    t("legal.lastReviewed", { date: LEGAL_CONTENT_LAST_REVIEWED }),
    effectiveDated ? t("legal.privacy.effective", { date: PRIVACY_EFFECTIVE_DATE }) : null,
  ].filter(Boolean).join(" ");
  return (
    <PublicDocumentShell
      eyebrow={`Union Ground · ${t("legal.publicInformation")}`}
      title={t(titleKey)}
      intro={t(introKey)}
      notice={notice}
      sections={documentSections}
      indexSections={[...documentSections, ...(instrumentSection ? [instrumentSection] : []), ...(relatedSection ? [relatedSection] : []), contactSection]}
    >
      {documentSections.map((section) => <section id={section.id} key={section.id}><h2>{section.heading}</h2><p>{section.body}</p></section>)}
      {instrumentSection ? (
        <section id={instrumentSection.id} aria-labelledby="legal-instrument-title">
          <h2 id="legal-instrument-title">{instrumentSection.heading}</h2>
          <p>
            <a href={instrument.path}>
              {t("legal.summary.instrument.link", { name: t(instrument.summaryTitleKey), version: instrument.version })}
            </a>
          </p>
        </section>
      ) : null}
      {relatedSection ? (
        <section id={relatedSection.id} aria-labelledby="legal-related-title">
          <h2 id="legal-related-title">{relatedSection.heading}</h2>
          <ul>
            {relatedLinks.map(([href, labelKey]) => <li key={href}><a href={href}>{t(labelKey)}</a></li>)}
          </ul>
        </section>
      ) : null}
      {page === "privacy" || page === "aiDisclosure" ? <p><a href="/subprocessors">{t("subprocessors.title")}</a></p> : null}
      {page === "privacy" || page === "aiDisclosure" ? <p><a href="/telemetry">{t("telemetry.title")}</a></p> : null}
      {page === "aiDisclosure" ? <p>{t("telemetry.attribution")}</p> : null}
      <section id={contactSection.id} className="legal-page__contact" aria-labelledby="legal-contact-title">
        <h2 id="legal-contact-title">{contactSection.heading}</h2>
        <PublicContactLine body={t(contactBodyKey)} contact={contact} />
      </section>
    </PublicDocumentShell>
  );
}

// D-13 and D-14: the instrument route behind a summary. It publishes the
// instrument's full text, its version, its effective date (or, for a version
// that is not operative, the plain statement that it has none and is not in
// effect), how acceptance is recorded, and the links back to the summary and
// to the version history. Version and date come from src/lib/legalInstruments.js, the
// one source web and native share, so they cannot drift apart.
export function LegalInstrumentView({ instrumentKey }) {
  const { t } = useLang();
  const instrument = legalInstrument(instrumentKey);
  if (!instrument) return null;
  const name = t(instrument.summaryTitleKey);
  const [contactBodyKey, contact] = CONTACT_BY_PAGE[instrument.summaryPage] || CONTACT_BY_PAGE.privacy;
  // The instrument's own text in the reader's locale, in the order the shared
  // source lists it, then how agreement to it is recorded.
  const documentSections = [
    ...instrument.sections,
    ["legal.instrument.acceptance.title", "legal.instrument.acceptance.body"],
  ].map(([headingKey, bodyKey], index) => ({ id: `legal-section-${index + 1}`, heading: t(headingKey), body: t(bodyKey) }));
  const relatedSection = { id: "legal-related", heading: t("legal.privacy.links.title") };
  const contactSection = { id: "legal-contact", heading: t("legal.contact.title") };
  const operative = instrument.status === "operative";
  const notice = [
    t("legal.instrument.version", { version: instrument.version }),
    instrument.effectiveDate
      ? t("legal.privacy.effective", { date: instrument.effectiveDate })
      : t("legal.instrument.pendingEffective"),
    operative ? null : t("legal.instrument.notOperative"),
  ].filter(Boolean).join(" ");
  return (
    <PublicDocumentShell
      eyebrow={`Union Ground · ${t("legal.publicInformation")}`}
      title={t("legal.instrument.title", { name })}
      intro={t("legal.instrument.intro")}
      notice={notice}
      sections={documentSections}
      indexSections={[...documentSections, relatedSection, contactSection]}
    >
      {documentSections.map((section) => <section id={section.id} key={section.id}><h2>{section.heading}</h2><p>{section.body}</p></section>)}
      <section id={relatedSection.id} aria-labelledby="legal-related-title">
        <h2 id="legal-related-title">{relatedSection.heading}</h2>
        <ul>
          <li><a href={instrument.summaryPath}>{t("legal.instrument.links.summary")}</a></li>
          <li><a href={LEGAL_CHANGELOG_PATH}>{t("legal.instrument.links.changelog")}</a></li>
        </ul>
      </section>
      <section id={contactSection.id} className="legal-page__contact" aria-labelledby="legal-contact-title">
        <h2 id="legal-contact-title">{t("legal.contact.title")}</h2>
        <PublicContactLine body={t(contactBodyKey)} contact={contact} />
      </section>
    </PublicDocumentShell>
  );
}

// D-14's public changelog. It is generated from the instrument source, so a
// version can never be published without appearing here, and every entry says
// whether the change was material — the same flag the re-acceptance prompt of
// REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 reads.
export function LegalChangelogView() {
  const { t } = useLang();
  const changes = legalChangelog();
  const documentSections = changes.map((change, index) => ({
    id: `legal-section-${index + 1}`,
    heading: `${t(change.instrument.summaryTitleKey)} · ${t("legal.changelog.entry", { version: change.version, date: change.date })}`,
    body: `${t(change.noteKey)} ${change.material ? t("legal.changelog.material") : t("legal.changelog.notMaterial")}`,
  }));
  const contactSection = { id: "legal-contact", heading: t("legal.contact.title") };
  return (
    <PublicDocumentShell
      eyebrow={`Union Ground · ${t("legal.publicInformation")}`}
      title={t("legal.changelog.title")}
      intro={t("legal.changelog.intro")}
      notice={t("legal.lastReviewed", { date: LEGAL_CONTENT_LAST_REVIEWED })}
      sections={documentSections}
      indexSections={[...documentSections, contactSection]}
    >
      {changes.map((change, index) => {
        const section = documentSections[index];
        return (
          <section id={section.id} key={section.id}>
            <h2>{section.heading}</h2>
            <p>{section.body}</p>
            <p>
              <a href={change.instrument.path}>
                {t("legal.summary.instrument.link", { name: t(change.instrument.summaryTitleKey), version: change.instrument.version })}
              </a>
            </p>
          </section>
        );
      })}
      <section id={contactSection.id} className="legal-page__contact" aria-labelledby="legal-contact-title">
        <h2 id="legal-contact-title">{t("legal.contact.title")}</h2>
        <PublicContactLine body={t("legal.contact.ownerBody")} contact={publicContact("owner")} />
      </section>
    </PublicDocumentShell>
  );
}
