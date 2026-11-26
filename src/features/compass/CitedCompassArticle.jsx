import { useId } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";

function localized(article, field, lang) {
  return (lang === "es" && article[`${field}_es`]) || article[field] || "";
}

// The record a Compass citation opened. Title and body are the article the
// viewer already holds; nothing here is fetched or invented.
export function CitedCompassArticle({ article = null }) {
  const { lang } = useLang();
  const titleId = useId();
  if (!article) return null;
  const title = localized(article, "title", lang);
  const body = localized(article, "body", lang);
  if (!title && !body) return null;
  return (
    <article className="compass-cited-article" aria-labelledby={title ? titleId : undefined}>
      {article.ref ? <p className="compass-cited-article__ref">{article.ref}</p> : null}
      {title ? <h2 id={titleId}>{title}</h2> : null}
      {body ? <p>{body}</p> : null}
    </article>
  );
}
