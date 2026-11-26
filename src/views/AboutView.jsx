import { PublicContactLine, PublicDocumentShell } from "../components/PublicDocumentShell.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { publicContact } from "../lib/publicContact.js";
import { usePageMetadata } from "../lib/pageMetadata.js";

// Union Ground publishes no company statement, website, or mailbox yet, so
// this page describes the product as built and says plainly what is not
// published (the same preview the native legal reader gives).
const SECTIONS = [
  ["about.product.title", "about.product.body"],
  ["about.serves.title", "about.serves.body"],
  ["about.company.title", "about.company.body"],
  ["about.independence.title", "about.independence.body"],
];

export function AboutView() {
  const { t } = useLang();
  usePageMetadata("/about");

  const sections = SECTIONS.map(([headingKey, bodyKey], index) => ({ id: `about-section-${index + 1}`, heading: t(headingKey), body: t(bodyKey) }));
  const contactSection = { id: "about-contact", heading: t("about.contact.title") };
  return (
    <PublicDocumentShell
      eyebrow={`Union Ground · ${t("legal.publicInformation")}`}
      title={t("about.title")}
      intro={t("about.intro")}
      notice={t("legal.summaryNotice")}
      sections={sections}
      indexSections={[...sections, contactSection]}
    >
      <dl className="company-page__identity">
        <div><dt>{t("about.productName")}</dt><dd>Union Ground</dd></div>
        <div><dt>{t("about.legalName")}</dt><dd>{t("about.notPublished")}</dd></div>
        <div><dt>{t("about.website")}</dt><dd>{t("about.notPublished")}</dd></div>
      </dl>
      {sections.map((section) => (
        <section id={section.id} key={section.id}>
          <h2>{section.heading}</h2>
          <p>{section.body}</p>
        </section>
      ))}
      <section id={contactSection.id} className="legal-page__contact" aria-labelledby="about-contact-title">
        <h2 id="about-contact-title">{contactSection.heading}</h2>
        <PublicContactLine body={t("about.contact.body")} contact={publicContact("owner")} />
      </section>
    </PublicDocumentShell>
  );
}
