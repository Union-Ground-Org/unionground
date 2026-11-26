import { useId } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { compassSourceTarget } from "./compassSourceTarget.js";

// UX-UG-COMPASS-WEB-SOURCES-ONE-CLUTTERED-LINE-20261108 (#7462): the
// sources under a Compass answer used to print as one uppercase run of refs
// ("SOURCES · ARTICLE 12, COUNTY CBA 2025-2028 · ARTICLE 16, ..."). They are a
// short labelled list now, like the native app's sources card: one row per
// source, its title and the article or section it cites. Which sources show,
// and their order, is unchanged.
const PREVIEW_PREFIX = "PREVIEW · ";
const CITATION = /^(?:Article|Section|Art[íi]culo|Secci[óo]n)\b/u;

export function compassSourceRows(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  return sources.flatMap((source) => {
    const title = String(source?.title || "").trim();
    const ref = String(source?.ref || "").trim();
    // The demo's fictional fixtures keep their PREVIEW marker on every row.
    const preview = ref.startsWith(PREVIEW_PREFIX);
    const body = preview ? ref.slice(PREVIEW_PREFIX.length) : ref;
    // The citation is the ref's article or section part; a ref without one
    // (a knowledge-base answer, a guide page) is shown whole.
    const citation = body.split(" · ").find((part) => CITATION.test(part)) || body;
    const name = title || body;
    const reference = name === body || name.includes(citation) ? "" : citation;
    if (!name) return [];
    const row = {
      name,
      reference: preview ? ["PREVIEW", reference].filter(Boolean).join(" · ") : reference,
      source,
    };
    const key = `${row.name}\u0000${row.reference}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...row, key }];
  });
}

export function CompassSourceList({ sources, articles = [], onOpen = null }) {
  const { t } = useLang();
  const labelId = useId();
  const rows = compassSourceRows(sources);
  if (!rows.length) return null;
  return (
    <div className="guide2-msg__sources">
      <p className="guide2-msg__sources-label" id={labelId}>{t("compass.sourcesLabel")}</p>
      <ul aria-labelledby={labelId}>
        {rows.map((row) => {
          const target = onOpen ? compassSourceTarget(row.source, articles) : null;
          const name = <span className="guide2-msg__source-name">{row.name}</span>;
          const reference = row.reference ? <span className="guide2-msg__source-ref">{row.reference}</span> : null;
          return (
            <li key={row.key}>
              {target
                ? <button type="button" className="guide2-msg__source-open" onClick={() => onOpen(target)}>{name}{reference}</button>
                : <>{name}{reference}</>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
