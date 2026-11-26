import { useLang } from "../lib/LanguageContext.jsx";

// UB-UG-UNKNOWN-APP-ADDRESS-LEAVES-SHELL-20261106: an address under
// /m that no page claims (a mistyped or stale link) keeps the signed-in shell,
// so the rail, the hat and the chapter stay put, and offers the way back to
// the current hat's home. Unknown public addresses keep the public 404.
export function AppNotFound({ homeLabel, onHome }) {
  const { t } = useLang();
  return (
    <section className="view-error" aria-labelledby="app-not-found-title" data-app-not-found="">
      <span className="eyebrow">404</span>
      <h1 id="app-not-found-title">{t("notFound.title")}</h1>
      <p>{t("notFound.appBody")}</p>
      <button className="dialog-primary" type="button" onClick={onHome}>{t("notFound.appHome", { page: homeLabel })}</button>
    </section>
  );
}
