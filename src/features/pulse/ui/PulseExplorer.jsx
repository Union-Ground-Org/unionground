import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  explorerSpec,
  latestRow,
  PULSE_CATEGORIES,
  PULSE_FLOOR,
  PULSE_MEASURE_CATEGORY,
  PULSE_PERIODS,
  pulseCsv,
  pulseCsvFilename,
  pulseRowLabel,
  pulseUpdated,
} from "../pulseCharts.js";
import { useLang } from "../../../lib/LanguageContext.jsx";
import { pulseCopy, pulseCountedFrom } from "../pulseCopy.js";
import { PulseChart, PulseFigureState, PulseHero, PulseTable, pulseArrivalName } from "./PulseChart.jsx";
import { PulseSavedCharts } from "./PulseSavedCharts.jsx";
import "../pulse.css";

const systemNow = () => new Date();

function downloadCsv(body, filename) {
  if (typeof document === "undefined" || typeof Blob === "undefined" || typeof globalThis.URL?.createObjectURL !== "function") return false;
  const href = globalThis.URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(href), 0);
  return true;
}

function PulseCardDetail({ card, copy, lang, now, onClose }) {
  const [table, setTable] = useState(false);
  const [notice, setNotice] = useState("");
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, [card.measure]);
  const title = copy.measures[card.measure];
  const csv = pulseCsv(card.figures, { labelHeader: copy.labelHeader, valueHeader: copy.valueHeader });
  function download() {
    const ok = csv !== null && downloadCsv(csv, pulseCsvFilename(title, now()));
    setNotice(ok ? copy.downloaded : copy.downloadError);
  }
  return (
    <section className="pulse-detail plane-card" aria-labelledby="pulse-detail-title">
      <div className="pulse-detail__head">
        <div>
          <p className="pulse-eyebrow">{copy.detail} · {copy.periods[card.spec.period]}</p>
          <h2 id="pulse-detail-title" ref={heading} tabIndex="-1" className="pulse-section__title">{title}</h2>
        </div>
        <button type="button" className="pulse-button" onClick={onClose}>{copy.close}</button>
      </div>
      <p className="pulse-note">{pulseCountedFrom(copy, lang, card.measure, card.figures?.countedFrom)}</p>
      {card.figures?.person && <p className="pulse-note">{copy.personNote}</p>}
      {table && card.figures && !card.figures.unavailable && !card.figures.locked && !card.figures.withheld && card.figures.rows.length > 0
        ? <PulseTable figures={card.figures} copy={copy} lang={lang} caption={title} />
        : <PulseChart figures={card.figures} spec={card.spec} title={title} copy={copy} lang={lang} large />}
      <div className="pulse-actions">
        <button type="button" className="pulse-button" aria-pressed={table} onClick={() => setTable((value) => !value)}>
          {table ? copy.chartView : copy.tableView}
        </button>
        {csv !== null
          ? <button type="button" className="pulse-button pulse-button--primary" onClick={download}>{copy.download}</button>
          : <p className="pulse-note">{copy.noDownload}</p>}
      </div>
      {notice && <p className="pulse-note" role="status">{notice}</p>}
    </section>
  );
}

function PulseCard({ card, index, copy, lang, expanded, onToggle }) {
  const title = copy.measures[card.measure];
  const latest = latestRow(card.figures);
  return (
    <li className="pulse-card plane-card" data-category={PULSE_MEASURE_CATEGORY[card.measure]}>
      <div className="pulse-card__head">
        <p className="pulse-eyebrow">{String(index + 1).padStart(2, "0")} · {copy.categories[PULSE_MEASURE_CATEGORY[card.measure]]}</p>
        <h3 className="pulse-card__title">{title}</h3>
        <p className="pulse-note">{copy.periods[card.spec.period]}</p>
      </div>
      {card.loading
        ? <PulseFigureState loading copy={copy} />
        : (
          <>
            {latest && card.spec.breakdown === "month" && (
              <PulseHero name={`${pulseArrivalName(card.spec, "card")}:latest`} value={latest.value}><span>{pulseRowLabel(latest.label, lang)} · {copy.latest}</span></PulseHero>
            )}
            <PulseChart figures={card.figures} spec={card.spec} title={title} copy={copy} lang={lang} />
          </>
        )}
      <button type="button" className="pulse-button" aria-expanded={expanded} aria-label={`${expanded ? copy.close : copy.open} · ${title}`} onClick={onToggle}>
        {expanded ? copy.close : copy.open}
      </button>
    </li>
  );
}

// REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031 (Mock E): the cards
// the app shows for the signed-in hat, filtered by period, level and unit,
// each with a table view and a CSV of exactly the rows the server cleared.
export function PulseExplorer({ api, hat = "member", organizationName = "", now = systemNow }) {
  const { lang, t } = useLang();
  const copy = pulseCopy(t);
  const ids = useId();
  const [options, setOptions] = useState(null);
  const [failed, setFailed] = useState(false);
  const [filters, setFilters] = useState({ period: "12m", level: "chapter", unitID: "" });
  const [category, setCategory] = useState("all");
  const [cards, setCards] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const sequence = useRef(0);

  const loadOptions = useCallback(async () => {
    setFailed(false);
    setOptions(null);
    try {
      setOptions(await api.options(hat));
    } catch {
      setFailed(true);
    }
  }, [api, hat]);

  useEffect(() => { void loadOptions(); }, [loadOptions]);

  useEffect(() => {
    if (!options) return;
    const request = ++sequence.current;
    const specs = options.measures.map((measure) => ({ measure, spec: explorerSpec(measure, filters) }));
    setCards(specs.map((card) => ({ ...card, loading: true, figures: null })));
    void Promise.all(specs.map(async (card) => {
      try {
        return { ...card, loading: false, figures: await api.preview(hat, card.spec) };
      } catch {
        return { ...card, loading: false, figures: null };
      }
    })).then((next) => {
      if (request !== sequence.current) return;
      setCards(next);
      setUpdatedAt(now());
    });
  }, [api, hat, options, filters, now]);

  const setFilter = (name) => (event) => setFilters((current) => ({ ...current, [name]: event.target.value }));
  const categories = ["all", ...PULSE_CATEGORIES.filter((id) => cards.some((card) => PULSE_MEASURE_CATEGORY[card.measure] === id))];
  const shown = cards.filter((card) => category === "all" || PULSE_MEASURE_CATEGORY[card.measure] === category);
  const open = cards.find((card) => card.measure === expanded) || null;
  const updated = pulseUpdated(updatedAt, lang);
  const hatLabel = copy.hats[hat] || hat;

  return (
    <div className="screen pulse" data-pulse-hat={hat}>
      <header className="phead">
        <div className="phead__copy">
          {/* #9981: the heading (and so the browser tab) is named as the rail
              names it; the organization is named in the line below it. */}
          <h1 className="phead__title">{copy.title}</h1>
          <p className="phead__sub">{copy.sub}</p>
          <p className="pulse-note">{[organizationName, hatLabel, updated ? copy.updated(updated) : ""].filter(Boolean).join(" · ")}</p>
        </div>
      </header>
      {api.isPreview && <p className="pulse-note">{copy.preview}</p>}
      {failed && (
        <div className="pulse-note pulse-note--alert" role="status">
          {copy.pageUnavailable} <button type="button" className="pulse-link" onClick={() => void loadOptions()}>{copy.retry}</button>
        </div>
      )}
      {!failed && !options && <p className="pulse-note" role="status">{copy.loading}</p>}
      {options && (
        <>
          <div className="pulse-filters" role="group" aria-label={copy.filters}>
            <label htmlFor={`${ids}-period`}>{copy.period}</label>
            <select id={`${ids}-period`} value={filters.period} onChange={setFilter("period")}>
              {PULSE_PERIODS.map((period) => <option key={period} value={period}>{copy.periods[period]}</option>)}
            </select>
            {options.levels.length > 1 && (
              <>
                <label htmlFor={`${ids}-level`}>{copy.level}</label>
                <select id={`${ids}-level`} value={filters.level} onChange={setFilter("level")}>
                  {options.levels.map((level) => <option key={level} value={level}>{copy.levels[level]}</option>)}
                </select>
              </>
            )}
            {options.units.length > 0 && (
              <>
                <label htmlFor={`${ids}-unit`}>{copy.unit}</label>
                <select id={`${ids}-unit`} value={filters.unitID} onChange={setFilter("unitID")}>
                  <option value="">{copy.allUnits}</option>
                  {options.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </select>
              </>
            )}
            <p className="pulse-floor">{copy.floor(PULSE_FLOOR)}</p>
          </div>
          <nav className="pulse-chips" aria-label={copy.categoriesLabel}>
            {categories.map((id) => (
              <button key={id} type="button" className="pulse-chip" aria-pressed={category === id} onClick={() => setCategory(id)}>
                {copy.categories[id]}
              </button>
            ))}
          </nav>
          {open && <PulseCardDetail key={`${open.measure}-${open.spec.period}`} card={open} copy={copy} lang={lang} now={now} onClose={() => setExpanded(null)} />}
          <ul className="pulse-grid" aria-label={copy.title}>
            {shown.map((card) => (
              <PulseCard
                key={card.measure}
                card={card}
                index={cards.indexOf(card)}
                copy={copy}
                lang={lang}
                expanded={expanded === card.measure}
                onToggle={() => setExpanded((current) => (current === card.measure ? null : card.measure))}
              />
            ))}
          </ul>
          <PulseSavedCharts api={api} hat={hat} options={options} />
        </>
      )}
    </div>
  );
}
