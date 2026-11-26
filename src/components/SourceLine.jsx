import { useLang } from "../lib/LanguageContext.jsx";
import { sourceLineT } from "../lib/i18n/sourceLine.js";
import { sourceLineModel } from "../lib/sourceLine.js";
import "./SourceLine.css";
import "../lib/i18n/features/sourceLineStrings.js";

// REQ-UG-PROVENANCE-CONTRACT-20261012: "Source: <publisher>,
// retrieved <date ET>" under every sourced figure or document, with the
// publisher linked to the captured URL and, for a computed or authored item,
// an expandable list of its inputs. A record that cannot be shown says so; it
// never renders as if it were sourced. See docs/conventions/provenance.md.
function SourceEntry({ entry, t }) {
  return <>
    <a href={entry.href} target="_blank" rel="noopener noreferrer" aria-label={t("sourceLine.opensNewTab", { publisher: entry.publisher })}>{entry.publisher}</a>
    {entry.title ? <> · <cite>{entry.title}</cite></> : null}
    {", "}{t("sourceLine.retrieved", { date: entry.retrieved })}
  </>;
}

export function SourceLine({ provenance, inputs = [], className = "" }) {
  const { lang } = useLang();
  const t = (key, vars) => sourceLineT(lang, key, vars);
  const model = sourceLineModel(provenance, { lang, inputs });
  const classes = ["source-line", className].filter(Boolean).join(" ");
  if (!model) return <p className={`${classes} source-line--missing`} role="note">{t("sourceLine.unavailable")}</p>;
  return (
    <div className={classes}>
      <p className="source-line__text">{t("sourceLine.label")} <SourceEntry entry={model} t={t} /></p>
      {model.inputs.length ? (
        <details className="source-line__inputs">
          <summary>{t("sourceLine.inputs", { count: model.inputs.length })}</summary>
          <ul>
            {model.inputs.map((input) => (
              <li key={input.key}>
                {input.reference ? t("sourceLine.inputReference", { reference: input.reference }) : <SourceEntry entry={input} t={t} />}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
