import { useLang } from "../../lib/LanguageContext.jsx";
import { formatCatalogDate } from "../unionCatalog/catalogSearch.js";
import { ROW_TYPES } from "./setupPayload.js";

export function setupRowDomId(rowId) {
  return `setup-row-${String(rowId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function typeLabel(t, type) {
  return t(`unions.setup.type.${ROW_TYPES.includes(type) ? type : "office"}`);
}

// A row's display name, in English markup when it came from the public record
// and the page is not in English. With `template`, the name is placed where
// the copy has `{name}`.
export function NameText({ row, template = null }) {
  const { t, lang } = useLang();
  const text = row.name.trim() || typeLabel(t, row.type);
  const name = row.origin === "catalog" && row.name.trim() && lang !== "en" ? <span lang="en">{text}</span> : text;
  if (!template) return name;
  const [before, after = ""] = t(template, { name: "\u0000" }).split("\u0000");
  return <>{before}{name}{after}</>;
}

// One editable row of the setup review: name, type, where it came from, and
// its remove action. Public-record names keep their source language.
export function SetupRowEditor({ row, issues = [], onChange, onRemove }) {
  const { t, lang } = useLang();
  const domId = setupRowDomId(row.id);
  const fromCatalog = row.origin === "catalog";
  const problem = issues[0] ?? null;
  // The name field shows its row by its value; the type select names its row
  // in its accessible name, so a list of rows is not a list of "Type" fields.
  const display = row.name.trim() || typeLabel(t, row.type);
  return <li className="xus-form">
    <label className="xus-field">{t("unions.setup.rowName")}
      <input
        id={domId}
        className="xus-input"
        value={row.name}
        lang={fromCatalog && lang !== "en" ? "en" : undefined}
        aria-invalid={problem ? "true" : undefined}
        aria-describedby={problem ? `${domId}-issue` : undefined}
        onChange={(event) => onChange({ ...row, name: event.target.value })}
      />
    </label>
    {problem && <p className="xus-note xus-note--error" id={`${domId}-issue`}>{t(`unions.setup.${problem}`)}</p>}
    <label className="xus-field">{t("unions.setup.rowType")}
      <select className="xus-input" aria-label={`${t("unions.setup.rowType")}: ${display}`} value={ROW_TYPES.includes(row.type) ? row.type : "office"} onChange={(event) => onChange({ ...row, type: event.target.value })}>
        {ROW_TYPES.map((type) => <option value={type} key={type}>{typeLabel(t, type)}</option>)}
      </select>
    </label>
    <p className="xus-meta">{fromCatalog
      ? t("unions.setup.rowSourcePublic", { date: formatCatalogDate(row.sourceAsOf, lang) || "—" })
      : t("unions.setup.rowSourceOwn")}</p>
    <button type="button" className="xus-btn xus-btn--danger" onClick={() => onRemove(row)}><NameText template="unions.setup.rowRemove" row={row} /></button>
  </li>;
}
