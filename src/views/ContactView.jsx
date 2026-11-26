import { PublicContactLine, PublicDocumentShell } from "../components/PublicDocumentShell.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { contactHelpFor } from "../lib/contactHelp.js";
import { publicContact } from "../lib/publicContact.js";
import { usePageMetadata } from "../lib/pageMetadata.js";

// Each topic names the published mailbox for it once Union Ground has one
// (src/lib/publicContact.js); until then each says none is published yet.
const CONTACTS = [
  ["contact.owner.title", "contact.owner.body", "owner"],
  ["contact.sales.title", "contact.sales.body", "sales"],
  ["contact.support.title", "contact.support.body", "support"],
];

// BUG-UG-CONTACT-INLINE-HELP-LINK-LINEBOX-20261020: the two
// self-service links are their own 48 px block line under the sentence
// (.contact-help__link in styles.css), so the target size never stretches the
// line box of the sentence that introduces them.

export function ContactView() {
  const { t, lang } = useLang();
  const help = contactHelpFor(lang);
  usePageMetadata("/contact");
  const sections = CONTACTS.map(([headingKey, bodyKey, role], index) => ({
    id: `contact-${index + 1}`,
    heading: t(headingKey),
    body: t(bodyKey),
    contact: publicContact(role),
    role,
  }));

  return (
    <PublicDocumentShell
      eyebrow={`Union Ground · ${t("legal.publicInformation")}`}
      title={t("contact.title")}
      intro={help.intro}
      sections={sections}
      indexSections={[{ id: "contact-help", heading: help.title }, ...sections]}
    >
      <section id="contact-help" aria-labelledby="contact-help-title">
        <h2 id="contact-help-title">{help.title}</h2>
        <ul>
          {help.items.map((item) => (
            <li key={item.key}>
              {item.text}{item.href ? <a className="contact-help__link" href={item.href} hrefLang={item.hrefLang}>{item.action}</a> : null}
            </li>
          ))}
        </ul>
        <p>{t("contact.intro")}</p>
      </section>
      {sections.map((section) => (
        <section id={section.id} key={section.id}>
          <h2>{section.heading}</h2>
          <PublicContactLine body={section.body} contact={section.contact} />
          {/* WEB-PUB-05: product support asks for no worker or issue details by email. */}
          {section.role === "support" && <p>{t("contact.support.sensitive")}</p>}
        </section>
      ))}
    </PublicDocumentShell>
  );
}
