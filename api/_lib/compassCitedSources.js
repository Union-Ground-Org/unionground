// UX-UG-COMPASS-NON-ANSWER-LISTS-OFF-TOPIC-SOURCES-20261108
// and BUG-UG-COMPASS-SNIPPET-ONLY-CITATION-SOURCE-DROPPED-20261108
//
// The sources listed under a Compass answer are the ones the answer relies on,
// not every source retrieval handed the model. The model ends its answer with
// one line naming the source tags it relied on ("Used: S1, S3" or "Used:
// none"); the server removes that line and, when every tag names a source that
// was sent, lists exactly those sources, in any language and for any source,
// generic chapter-library documents included ( rounds 3
// and 4 on d71bbcd: word overlap and a shared article number are not
// attribution). Without a valid line it falls back to what the answer itself
// names: a source's title, or the article its title or reference names.
// Product-guide sources come only with a how-to question that names a guide
// topic, so the fallback keeps them. A generic source whose title and
// reference name no article is never listed on its excerpt alone.
//
// A citation is a head and its number. A singular head (Article, Art.,
// Artículo, Section, Sección, §) takes exactly one number, with an optional
// decimal section ("Article 9.2", "§9.2"), so whatever follows it ("Article 9,
// 14-day notice") is never read as another article (
// rounds 5 and 6 on ac91069). Only a plural head (Articles, Arts., Artículos,
// Sections, Secciones, §§) takes a list joined by commas or and/y/or/o, or a
// range by a dash touching both numbers or a range word ("Articles 9, 12 and
// 14", "Sections 9.2–9.4", "Artículos 9 a 12"). A plural list still stops at
// a number followed by a unit or quantity word ("Articles 9, 14 days" or
// "14-day"). Only the article number matters for matching. "work" and
// "full" count as quantities only before "day(s)", so "Articles 9 and 14 work
// together" keeps both.
const NUMBER = "[1-9][0-9]?(?:\\.[0-9]{1,2})?";
const QUANTITY = "(?![0-9.]*[\\s\\-–]*(?:%|\\$|percent\\b|por\\s+ciento\\b|(?:calendar|business|working|consecutive)\\b|(?:work|full)[\\s\\-]*days?\\b|days?\\b|d[íi]as?\\b|hours?\\b|hrs?\\b|horas?\\b|weeks?\\b|semanas?\\b|months?\\b|mes(?:es)?\\b|years?\\b|a[ñn]os?\\b|minutes?\\b|minutos?\\b|dollars?\\b|d[óo]lares\\b|cents?\\b|times?\\b|veces\\b|shifts?\\b|turnos?\\b|mandates?\\b|naturales\\b|h[áa]biles\\b|people\\b|members?\\b|employees?\\b|per\\b|more\\b))";
const JOIN = "(?:\\s*[,;&]\\s*(?:and\\s+|y\\s+|or\\s+|o\\s+)?|\\s+(?:and|y|or|o|e|u)\\s+|[-–—]|\\s+(?:through|thru|to|a|al|hasta)\\s+)";
const SINGULAR = new RegExp(`(?:(?<![\\p{L}\\p{N}])(?:Article|Art[íi]culo|Section|Secci[óo]n|Art\\.)\\s*|(?<!§)§(?!§)\\s*)(${NUMBER})(?![0-9])`, "giu");
const PLURAL = new RegExp(`(?:(?<![\\p{L}\\p{N}])(?:Articles|Art[íi]culos|Sections|Secciones|Arts\\.)\\s*|§§\\s*)(${NUMBER}(?:${JOIN}${NUMBER}${QUANTITY})*)(?![0-9])`, "giu");
const RANGE = /^(?:[-–—]|\s+(?:through|thru|to|a|al|hasta)\s+)$/iu;
const MAX_RANGE = 20;

function articlesIn(text) {
  const articles = new Set();
  for (const [, single] of String(text || "").matchAll(SINGULAR)) articles.add(String(Number.parseInt(single, 10)));
  for (const [, list] of String(text || "").matchAll(PLURAL)) {
    const parts = list.split(new RegExp(`(${NUMBER})`, "u"));
    // parts alternates separator, number, separator, number, ...
    let previous = null;
    for (let index = 1; index < parts.length; index += 2) {
      const article = Number.parseInt(parts[index], 10);
      if (previous !== null && RANGE.test(parts[index - 1]) && article > previous && article - previous <= MAX_RANGE) {
        for (let between = previous + 1; between < article; between += 1) articles.add(String(between));
      }
      articles.add(String(article));
      previous = article;
    }
  }
  return articles;
}

function titleCores(title) {
  const full = String(title || "").trim();
  const core = full.replace(/^(?:Know Your Contract|Conoce tu contrato):\s*/iu, "").replace(/\s*\([^)]*\)\s*$/u, "").trim();
  return [...new Set([full, core])].filter(Boolean);
}

// A title of six characters or more counts in any case; a shorter one ("Dues")
// only as written, as a whole word, so an ordinary lowercase word cannot match.
function namesTitle(text, title) {
  return titleCores(title).some((core) => {
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, core.length >= 6 ? "iu" : "u").test(text);
  });
}

// The attribution line: the last non-empty line of the model's text, or, as
// the model sometimes writes it, the end of the last line after a sentence
// ("…30 calendar days. Used: S3"), including a sentence's closing quote.
// An inline form counts only with well-formed tags, so prose that happens to
// end in "used: …" is never cut.
const USED_LINE = /^\s*used\s*:\s*(.*?)\s*\.?\s*$/iu;
const USED_INLINE = /(?<=[.!?]["'”’»]?)\s+used\s*:\s*(none|s[1-9][0-9]?(?:\s*,\s*s[1-9][0-9]?)*)\s*\.?\s*$/iu;
const USED_TAGS = /^(?:none|s[1-9][0-9]?(?:\s*,\s*s[1-9][0-9]?)*)$/iu;

function usedTags(list) {
  return /^none$/iu.test(list) ? [] : list.split(",").map((tag) => Number.parseInt(tag.trim().slice(1), 10));
}

// Splits the model's text into the answer the reader sees and the source tags
// it reported. `used` is null when the line is missing or malformed.
export function splitCompassAnswerSources(content) {
  const text = String(content || "").trim();
  const lines = text.split("\n");
  const own = USED_LINE.exec(lines.at(-1) || "");
  if (own) {
    const answer = lines.slice(0, -1).join("\n").trim();
    return { answer, used: USED_TAGS.test(own[1]) ? usedTags(own[1]) : null };
  }
  const inline = USED_INLINE.exec(text);
  if (inline) return { answer: text.slice(0, inline.index).trim(), used: usedTags(inline[1]) };
  return { answer: text, used: null };
}

// `sources` carry the prompt index each was sent under ([S${index + 1}]).
export function compassCitedSources(answer, sources, used = null) {
  if (!String(answer || "").trim() || !Array.isArray(sources)) return [];
  const sent = new Set(sources.map((source) => Number(source?.index) + 1));
  if (Array.isArray(used) && used.every((tag) => sent.has(tag))) {
    const relied = new Set(used);
    return sources.filter((source) => relied.has(Number(source?.index) + 1));
  }
  const text = String(answer || "");
  const cited = articlesIn(text);
  return sources.filter((source) => {
    if (source?.kind === "product_guide") return true;
    if (namesTitle(text, source?.title)) return true;
    return [...articlesIn(`${source?.title || ""} ${source?.ref || ""}`)].some((article) => cited.has(article));
  });
}
