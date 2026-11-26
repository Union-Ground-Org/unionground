import { PublicContactLine, PublicDocumentShell } from "../components/PublicDocumentShell.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { register, withoutReviewNote } from "../lib/subprocessorRegister.js";
import { publicContact } from "../lib/publicContact.js";
import "../lib/i18n/features/subprocessorsStrings.js";

export function SubprocessorRegisterView() {
  const { t, lang } = useLang();
  const templateNotice = (register.copy[lang] ?? register.copy.en).notOperative;
  const sections = [
    { id: "providers", heading: t("subprocessors.providers") },
    { id: "internal-ai", heading: t("subprocessors.internal") },
    { id: "changes", heading: t("subprocessors.history") },
    { id: "objections", heading: t("subprocessors.contact") },
  ];
  return <PublicDocumentShell eyebrow="Union Ground" title={t("subprocessors.title")} intro={t("subprocessors.intro")}
    notice={`${templateNotice} ${t("subprocessors.date")}: ${register.reviewed}.`} sections={sections}>
    <section id="providers"><h2>{t("subprocessors.providers")}</h2>
      {register.providers.map((provider) => <section key={provider.id} id={`provider-${provider.id}`}>
        <h3>{provider.name}</h3><p>{t("subprocessors.country")}: {withoutReviewNote(t(`subprocessors.provider.${provider.id}.country`))}</p>
        <p>{t("subprocessors.scope")}: {t(`subprocessors.provider.${provider.id}.scope`)}</p>
        {provider.sources?.map((source, index) => <p key={source.url}>
          <a href={source.url}>{t(`subprocessors.provider.${provider.id}.source.${index}`)}</a>{" — "}{t("subprocessors.sourceRead")}: <time dateTime={source.read}>{source.read}</time>
        </p>)}
        {provider.starts ? <p>{t("subprocessors.starts")}: {provider.starts}</p> : null}
      </section>)}
      <p>{t("subprocessors.pending")}</p>
    </section>
    <section id="internal-ai"><h2>{t("subprocessors.internal")}</h2><p>{t("subprocessors.mesh")}</p></section>
    <section id="changes"><h2>{t("subprocessors.history")}</h2><p>{t("subprocessors.notice")}</p>
      <ul>{register.history.map((event, index) => <li key={`${event.announced}-${index}`}>
        <time dateTime={event.announced}>{event.announced}</time>{": "}
        {event.providers.map((id) => register.providers.find((provider) => provider.id === id)?.name || id).join(", ")}
        {". "}{event.kind === "baseline" ? t("subprocessors.baseline")
          : event.kind === "amendment"
            ? `${t("subprocessors.amended")}: ${event.summary[lang] ?? event.summary.en} ${t("subprocessors.previousScope")}: ${event.previous[lang]?.scope ?? event.previous.en.scope}`
            : `${t("subprocessors.starts")}: ${event.starts}.`}
      </li>)}</ul>
    </section>
    <section id="objections"><h2>{t("subprocessors.contact")}</h2><p>{t("subprocessors.remedy")}</p><p>{t("subprocessors.refund")}</p>
      <PublicContactLine body="" contact={publicContact("owner")} />
    </section>
  </PublicDocumentShell>;
}
