import { t } from "./i18n.js";
import { normalizeText } from "./searchIndex.js";

// Compass's demo brain. The live assistant is a Vercel function that a demo
// session can never reach (no access_token, and mutate() drops demo writes),
// so the demo answers locally — and it answers ONLY with the fictional,
// explicitly PREVIEW fixture
// text. Every contract sentence a demo visitor reads must exist verbatim in
// data.kbArticles or in the member's own seeded record; this module composes,
// it never authors. api/guide.js gives the live model the same instruction.
//
// Resolution order: exact chip match (both locales) → keyword score over the
// fixtures' own keyword lists → the telework record branch → honest no-match.

// The three suggested-question chips (FloatingControls compassChipKeys),
// mapped to the fixture slugs that actually ground them. The chips keep
// their original key names but ask organizing questions: what a
// supervisor may ask, employer pressure, and what a card majority means.
const CHIP_SLUGS = [
  { key: "compass.chipDiscipline", slugs: ["supervisor-questions", "section-7-concerted-activity"] },
  { key: "compass.chipGrievance", slugs: ["captive-meeting"] },
  { key: "compass.chipTelework", slugs: ["cards-and-recognition"] },
];

const TELEWORK_TOKENS = ["telework", "teletrabajo"];

// Question scaffolding carries no grounding: with these in the score,
// "How do I file for unemployment?" shares "how"/"do"/"file" with the
// grievance FAQ (its title starts "How long do I have…") and would be
// answered with a filing deadline that does not apply to it. Both locales'
// scaffold words are listed; content words never are.
const STOPWORDS = new Set([
  "about", "after", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but", "can",
  "could", "did", "do", "does", "for", "from", "get", "had", "has", "have", "he", "her", "his",
  "how", "if", "in", "into", "is", "it", "its", "many", "may", "me", "my", "no", "not", "of",
  "on", "or", "our", "she", "should", "so", "that", "the", "their", "them", "they", "this",
  "to", "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your",
  "al", "como", "con", "cual", "cuales", "cuando", "de", "del", "donde", "el", "ella", "ellos",
  "en", "es", "esta", "este", "hay", "la", "las", "lo", "los", "mi", "mis", "muy", "para",
  "pero", "por", "puedo", "que", "quien", "se", "ser", "si", "sin", "son", "su", "sus", "tu",
  "tus", "un", "una", "uno", "y", "yo",
]);

function tokensOf(value) {
  // One-letter tokens ("i", "a", "y") are pure noise for keyword scoring —
  // they made every English question containing "I" match the FAQ article.
  return normalizeText(value).split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

// A fixture article's searchable vocabulary: its own keywords and title, plus
// the tokens of its chip's text in BOTH locales so Spanish free-text
// ("disciplinaria", "queja") lands without this module inventing vocabulary.
function articleHaystack(article) {
  const chip = CHIP_SLUGS.find((entry) => entry.slugs.includes(article.slug));
  const chipTokens = chip
    ? [...tokensOf(t("en", chip.key)), ...tokensOf(t("es", chip.key))]
    : [];
  return new Set([...(article.keywords || []).flatMap(tokensOf), ...tokensOf(article.title), ...chipTokens]);
}

function previewRef(value) {
  return String(value || "").startsWith("PREVIEW · ") ? value : `PREVIEW · ${value}`;
}

function fixtureText(item, field, lang) {
  return (lang === "es" && item[`${field}_es`]) || item[field];
}

function sourceFor(article, lang) {
  return { id: article.slug, kind: article.kind, title: fixtureText(article, "title", lang), ref: previewRef(article.ref), preview: true };
}

// Quote the fixtures, then say plainly that this is the tour's canned answer.
function composeFromArticles(articles, lang) {
  return {
    answer: [t(lang, "compass.demoAnswerLead"), ...articles.map((article) => fixtureText(article, "body", lang)), t(lang, "compass.demoNotice")].join(" "),
    sources: articles.map((article) => sourceFor(article, lang)),
  };
}

function teleworkAnswer(data, lang) {
  const teleworkCase = (data.cases || []).find((item) => normalizeText(item.type || "") === "telework");
  const approvedRequest = (data.forms || []).find((item) => item.templateKey === "alt_work" && item.status === "approved");
  if (!teleworkCase || !approvedRequest?.answers?.requested) return null;
  return {
    answer: `${t(lang, "compass.demoAnswerLead")} ${t(lang, "compass.demoTelework", {
      reference: teleworkCase.reference,
      title: fixtureText(teleworkCase, "title", lang),
      articles: fixtureText(teleworkCase, "articles", lang),
      requested: (lang === "es" && approvedRequest.answers_es?.requested) || approvedRequest.answers.requested,
    })}`,
    sources: [{
      id: "resolved-telework",
      kind: "case",
      title: fixtureText(teleworkCase, "title", lang),
      ref: previewRef(`${teleworkCase.reference} · ${teleworkCase.articles}`),
      preview: true,
    }],
  };
}

export function demoCompassAnswer(question, data, lang = "en") {
  const articles = data?.kbArticles || [];
  const normalized = normalizeText(question);
  const bySlug = new Map(articles.map((article) => [article.slug, article]));

  // Titles are exact entry points, not fuzzy grounding. Spanish question
  // scaffolding ("cuánto tiempo tengo") must never ground a different subject.
  const exactTitle = normalized && articles.find((article) =>
    normalized === normalizeText(article.title) || (article.title_es && normalized === normalizeText(article.title_es)));
  if (exactTitle) return composeFromArticles([exactTitle], lang);

  // 1. Exact chip match, either locale.
  const chip = CHIP_SLUGS.find((entry) =>
    normalized === normalizeText(t("en", entry.key)) || normalized === normalizeText(t("es", entry.key)));
  if (chip) {
    const matched = chip.slugs.map((slug) => bySlug.get(slug)).filter(Boolean);
    if (matched.length) return composeFromArticles(matched, lang);
    const telework = teleworkAnswer(data, lang);
    if (telework) return telework;
  }

  // 2. Keyword score over the fixtures' own vocabularies. One shared content
  // word is not grounding — it makes "file for unemployment" quote the
  // grievance deadline. Two independent hits is the floor for claiming the
  // article actually covers the question.
  const questionTokens = tokensOf(question);
  let best = null;
  for (const article of articles) {
    const haystack = articleHaystack(article);
    const score = questionTokens.filter((token) => haystack.has(token)).length;
    if (score >= 2 && (!best || score > best.score)) best = { article, score };
  }
  if (best) return composeFromArticles([best.article], lang);

  // 3. Telework free-text with no KB coverage: answer from the member's record.
  if (questionTokens.some((token) => TELEWORK_TOKENS.includes(token))) {
    const telework = teleworkAnswer(data, lang);
    if (telework) return telework;
  }

  // 4. Honest no-match.
  return { answer: t(lang, "compass.demoNoMatch"), sources: [] };
}
