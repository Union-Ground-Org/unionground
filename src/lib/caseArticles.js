// BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
// finding B-50. The Coordinator's "By article cited" printed one row per way a
// case's articles were typed ("Articles 9 and 18", "Article 18, Article 16",
// "Article 9.2; Article 7"), so the same article sat in several rows and no
// per-article count could be read. get_coordinator_kpis returns every active
// case's article text grouped as typed, with no limit, so the page can regroup
// exactly: one row per article, a case citing two articles counted under
// each, a case citing one article twice counted once.
//
// A section counts under its article ("Article 9.2" and "Art. 21 §3" are
// Articles 9 and 21): the row is about the article, and the case itself keeps
// its full citation. Text with no article number ("Seniority") keeps a row of
// its own, as typed.

// An article word ("Article", "Articles", "Art", "Art.", Spanish "Artículo(s)")
// followed by a number starts a citation. The first number after the word is
// the article; a section (9.2), a letter (12a) or a section mark after it
// (21 §3) stay with it. A further number joins the citation only when it is
// read with certainty: after a separator (",", ";", "&", "/", "and", "y") it
// is a whole number, optionally with its section, letter or section mark,
// and it is followed by another separator, the end of the text (closing
// punctuation before white space or the end counts as the end) or another
// article word. Anything else ("3rd step", "2024 agreement", "500 dollars")
// ends the citation, and nothing is guessed from it (#9533 B-50, Sol read).
const ARTICLE_WORD = /\bart(?:[ií]culos?|icles?)?\.?(?=\s*\d)/giu;
const ITEM = /^\s*(\d+)(?:\.\d+)*[a-z]?(?![\p{L}\p{N}])(?:\s*§+\s*\d+(?:\.\d+)*[a-z]?(?![\p{L}\p{N}]))?/iu;
const SEPARATOR = /^\s*(?:,|;|&|\/|and\b|y\b)/iu;
const ARTICLE_AHEAD = /^\s*art(?:[ií]culos?|icles?)?\.?\s*\d/iu;
const ENDS = /^\s*$/u;
// Closing punctuation after a complete item ends the citation like the end of
// the text does, when white space or the end follows it: "Articles 9 and 18."
// and "(Articles 4, 7 and 9)". A period directly before a digit is a section,
// which ITEM has already read (18.5).
const CLOSES = /^\s*[.)\]:]+(?=\s|$)/u;

// The article numbers of the one citation that starts at `from`.
function citationNumbers(text, from) {
  let rest = text.slice(from);
  const first = ITEM.exec(rest);
  if (!first) return [];
  const numbers = [first[1]];
  rest = rest.slice(first[0].length);
  for (;;) {
    const separator = SEPARATOR.exec(rest);
    if (!separator) break;
    const after = rest.slice(separator[0].length);
    if (ARTICLE_AHEAD.test(after)) break; // the next citation reads itself
    const item = ITEM.exec(after);
    if (!item) break;
    const tail = after.slice(item[0].length);
    if (!(ENDS.test(tail) || CLOSES.test(tail) || SEPARATOR.test(tail) || ARTICLE_AHEAD.test(tail))) break;
    numbers.push(item[1]);
    rest = tail;
  }
  return numbers;
}

/** The articles one case's article text cites, each once, in the order typed. */
export function articleCitations(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return [];
  const seen = new Map();
  for (const word of raw.matchAll(ARTICLE_WORD)) {
    for (const number of citationNumbers(raw, word.index + word[0].length)) {
      const article = Number.parseInt(number, 10);
      const key = `article:${article}`;
      if (!seen.has(key)) seen.set(key, { key, number: article, text: null });
    }
  }
  if (seen.size) return [...seen.values()];
  return [{ key: `text:${raw.replace(/\s+/gu, " ").toLowerCase()}`, number: null, text: raw.replace(/\s+/gu, " ") }];
}

/**
 * get_coordinator_kpis byArticle rows ({ articles, count }, one per distinct
 * text) regrouped as one row per article: { key, number, text, count }. Most
 * cases first, then article order; text rows after numbered ones.
 */
export function groupCasesByArticle(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const count = row?.count;
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
    for (const citation of articleCitations(row?.articles)) {
      const group = groups.get(citation.key) ?? { ...citation, count: 0 };
      group.count += count;
      groups.set(citation.key, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count
    || (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY)
    || String(a.text ?? "").localeCompare(String(b.text ?? "")));
}
