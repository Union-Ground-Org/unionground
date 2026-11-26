// UX-UG-COMPASS-CITATIONS-CANNOT-BE-OPENED-20261109 (#7701).
// A Compass source opens only when its id and kind already name a record
// this viewer can read. The answer payload's id and kind are enough; a
// source with no in-app home stays plain text.

const OPEN_KINDS = {
  rights: "rights",
  faq: "rights",
  knowledge: "rights",
  "knowledge-article": "rights",
  resource: "rights",
  article: "rights",
};

function sourceSlug(id) {
  return id.startsWith("kb:") ? id.slice(3) : id;
}

function compassArticleMatch(articles, id) {
  const slug = sourceSlug(id);
  const list = Array.isArray(articles) ? articles : [];
  return list.find((item) => item && (item.slug === slug || item.id === id || item.slug === id)) || null;
}

export function compassSourceTarget(source, articles = []) {
  const id = String(source?.id || "").trim();
  const kind = String(source?.kind || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  const view = OPEN_KINDS[kind];
  if (!id || !view) return null;
  const article = compassArticleMatch(articles, id);
  if (!article) return null;
  const slug = article.slug || sourceSlug(id);
  return {
    view,
    path: "/m/rights",
    focus: { view, compassSource: true, sourceId: id, slug },
    article,
  };
}

export function compassArticleForFocus(articles, focus) {
  if (!focus?.compassSource) return null;
  const id = String(focus.sourceId || focus.slug || "").trim();
  if (!id) return null;
  return compassArticleMatch(articles, id);
}
