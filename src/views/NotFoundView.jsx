import { PublicDocumentShell } from "../components/PublicDocumentShell.jsx";
import { useLang } from "../lib/LanguageContext.jsx";

export function NotFoundView() {
  const { t } = useLang();
  const sections = [{ id: "not-found-next", heading: t("notFound.nextTitle") }];
  return (
    <PublicDocumentShell
      eyebrow="404"
      title={t("notFound.title")}
      intro={t("notFound.intro")}
      sections={sections}
    >
      <section id="not-found-next">
        <h2>{t("notFound.nextTitle")}</h2>
        <p>{t("notFound.nextBody")}</p>
        <p><a href="/">{t("notFound.home")}</a> · <a href="/contact">{t("landing.contact")}</a></p>
      </section>
    </PublicDocumentShell>
  );
}
