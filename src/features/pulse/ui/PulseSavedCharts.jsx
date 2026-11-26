import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BusyButton } from "../../../components/BusyControls.jsx";
import { prepareBusyWrite, useBusyScope } from "../../../lib/busyWrite.js";
import { builderScopes, builderSpec, PULSE_CASE_TYPES, PULSE_FORMS, PULSE_PERIODS } from "../pulseCharts.js";
import { useLang } from "../../../lib/LanguageContext.jsx";
import { pulseCopy } from "../pulseCopy.js";
import { PulseChart } from "./PulseChart.jsx";

const NEW_DRAFT = Object.freeze({ title: "", measure: "", breakdown: "month", period: "12m", form: "bars", level: "chapter", unitID: "", caseType: "", scope: "personal", pinned: false });

function draftFrom(chart) {
  if (!chart?.spec) return { ...NEW_DRAFT };
  return { ...NEW_DRAFT, ...chart.spec, level: chart.spec.level || "chapter", unitID: chart.spec.unitID || "", caseType: chart.spec.caseType || "", title: chart.title, scope: chart.scope, pinned: chart.pinned, home: chart.home, id: chart.id };
}

// The builder of the custom-charts record (#6692) on the website: the same
// spec fields, the same server validation, a live preview from the server.
function PulseChartBuilder({ api, hat, options, chart = null, onSaved, onCancel }) {
  const { lang, t } = useLang();
  const copy = pulseCopy(t);
  const ids = useId();
  const [draft, setDraft] = useState(() => draftFrom(chart));
  const [figures, setFigures] = useState(null);
  const [previewing, setPreviewing] = useState(true);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  // Record 8435: the save's lock and busy state live for this builder's mount
  // (it is keyed by chart). Cancel waits for the save. onSaved is guarded by
  // the list's own scope and closes only the editor that saved.
  const busyWriteRef = useRef(new Set());
  const sequence = useRef(0);
  const spec = builderSpec(draft, { hat, options });
  const specKey = JSON.stringify(spec);
  const scopes = builderScopes(hat, spec.measure);
  const scope = scopes.includes(draft.scope) ? draft.scope : scopes[0];

  useEffect(() => {
    const request = ++sequence.current;
    setPreviewing(true);
    api.preview(hat, JSON.parse(specKey))
      .then((next) => { if (request === sequence.current) setFigures(next); })
      .catch(() => { if (request === sequence.current) setFigures(null); })
      .finally(() => { if (request === sequence.current) setPreviewing(false); });
  }, [api, hat, specKey]);

  const set = (field) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setDraft((current) => ({ ...current, [field]: value }));
  };

  function save(event) {
    return prepareBusyWrite(busyWriteRef, "chart", () => {
      event.preventDefault();
      if (saving) return undefined;
      const title = draft.title.trim();
      if (!title) { setStatus(copy.titleRequired); return undefined; }
      return () => saveNow(title);
    }, event);
  }

  async function saveNow(title) {
    setSaving(true);
    setStatus(copy.saving);
    try {
      await api.save(hat, { id: chart?.id, title, spec, scope, pinned: draft.pinned === true, home: draft.pinned === true && draft.home === true });
      setStatus(copy.saved);
      onSaved?.();
    } catch {
      setStatus(copy.saveError);
    } finally {
      setSaving(false);
    }
  }

  const field = (name) => `${ids}-${name}`;
  return (
    <form className="pulse-builder plane-card" aria-labelledby={field("title-heading")} onSubmit={(event) => void save(event)}>
      <div>
        <h3 id={field("title-heading")} className="pulse-card__title">{copy.builder}</h3>
        <p className="pulse-note">{copy.builderSub}</p>
      </div>
      <div className="pulse-builder__fields">
        <label htmlFor={field("name")}>{copy.chartTitle}</label>
        <input id={field("name")} value={draft.title} maxLength={100} onChange={set("title")} />
        <label htmlFor={field("measure")}>{copy.measure}</label>
        <select id={field("measure")} value={spec.measure} onChange={set("measure")}>
          {options.measures.map((measure) => <option key={measure} value={measure}>{copy.measures[measure]}</option>)}
        </select>
        <label htmlFor={field("breakdown")}>{copy.breakdown}</label>
        <select id={field("breakdown")} value={spec.breakdown} onChange={set("breakdown")}>
          <option value="month">{copy.breakdowns.month}</option>
          {spec.measure === "meeting_turnout" && <option value="meeting">{copy.breakdowns.meeting}</option>}
          {hat === "admin" && spec.measure !== "my_actions" && <option value="unit">{copy.breakdowns.unit}</option>}
        </select>
        <label htmlFor={field("period")}>{copy.period}</label>
        <select id={field("period")} value={spec.period} onChange={set("period")}>
          {PULSE_PERIODS.map((period) => <option key={period} value={period}>{copy.periods[period]}</option>)}
        </select>
        <label htmlFor={field("form")}>{copy.form}</label>
        <select id={field("form")} value={spec.form} onChange={set("form")}>
          {PULSE_FORMS.map((form) => <option key={form} value={form}>{copy.forms[form]}</option>)}
        </select>
        {spec.measure !== "my_actions" && options.levels.includes("local") && (
          <>
            <label htmlFor={field("level")}>{copy.level}</label>
            <select id={field("level")} value={spec.level || "chapter"} onChange={set("level")}>
              {options.levels.map((level) => <option key={level} value={level}>{copy.levels[level]}</option>)}
            </select>
          </>
        )}
        {spec.measure !== "my_actions" && hat === "admin" && options.units.length > 0 && (
          <>
            <label htmlFor={field("unit")}>{copy.unit}</label>
            <select id={field("unit")} value={spec.unitID || ""} onChange={set("unitID")}>
              <option value="">{copy.allUnits}</option>
              {options.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
            </select>
          </>
        )}
        {spec.measure === "visible_cases" && (
          <>
            <label htmlFor={field("case-type")}>{copy.caseType}</label>
            <select id={field("case-type")} value={spec.caseType || ""} onChange={set("caseType")}>
              <option value="">{copy.anyCaseType}</option>
              {PULSE_CASE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </>
        )}
        <label htmlFor={field("scope")}>{copy.scope}</label>
        <select id={field("scope")} value={scope} onChange={set("scope")}>
          {scopes.map((value) => <option key={value} value={value}>{copy.scopes[value]}</option>)}
        </select>
      </div>
      <label className="pulse-builder__check">
        <input type="checkbox" checked={draft.pinned === true} onChange={set("pinned")} />
        {copy.pin}
      </label>
      <section className="pulse-builder__preview" aria-label={copy.livePreview} aria-busy={previewing || undefined}>
        <p className="pulse-eyebrow">{copy.livePreview}</p>
        {previewing && !figures
          ? <p className="pulse-note" role="status">{copy.cardLoading}</p>
          : <PulseChart figures={figures} spec={spec} title={draft.title.trim() || copy.measures[spec.measure]} copy={copy} lang={lang} name="pulse:builder-preview" />}
      </section>
      <div className="pulse-actions">
        <BusyButton type="submit" className="pulse-button pulse-button--primary" pending={saving}>{copy.save}</BusyButton>
        {onCancel && <BusyButton type="button" className="pulse-button" pending={saving} onClick={onCancel}>{copy.cancel}</BusyButton>}
      </div>
      {status && <p className="pulse-note" role="status">{status}</p>}
    </form>
  );
}

// "Your charts": the owner's saved specs, pinned first, each re-read through
// the viewer-authorized server read. Remove takes one click and offers undo.
export function PulseSavedCharts({ api, hat, options, startBuilding = false }) {
  const { lang, t } = useLang();
  const copy = pulseCopy(t);
  const [charts, setCharts] = useState(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(startBuilding ? "new" : null);
  const [notice, setNotice] = useState(null);
  const sequence = useRef(0);
  // Record 8435: a builder's save that answers after the hat or client
  // changed must not reload this list for the earlier one; one from the same
  // list refreshes it, even when another chart's editor is open by then.
  const chartsKey = useMemo(() => ({ api, hat }), [api, hat]);
  const chartsScope = useBusyScope(chartsKey);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await api.list(hat);
      if (request !== sequence.current) return;
      setCharts(next);
      setFailed(false);
    } catch {
      if (request === sequence.current) setFailed(true);
    }
  }, [api, hat]);

  useEffect(() => { void load(); }, [load]);

  async function remove(chart) {
    try {
      await api.remove(chart.id);
      setNotice({ text: copy.removed(chart.title), undo: chart.id });
      await load();
    } catch {
      setNotice({ text: copy.removeError });
    }
  }

  async function undo(id) {
    try {
      await api.remove(id, true);
      setNotice({ text: copy.undone });
      await load();
    } catch {
      setNotice({ text: copy.undoError });
    }
  }

  return (
    <section className="pulse-saved" aria-labelledby="pulse-saved-title">
      <div className="pulse-saved__head">
        <div>
          <h2 id="pulse-saved-title" className="pulse-section__title">{copy.yourCharts}</h2>
          <p className="pulse-note">{copy.yourChartsSub}</p>
        </div>
        {editing === null && (
          <button type="button" className="pulse-button pulse-button--primary" onClick={() => setEditing("new")}>+ {copy.build}</button>
        )}
      </div>
      {editing !== null && (
        <PulseChartBuilder
          key={editing === "new" ? "new" : editing.id}
          api={api}
          hat={hat}
          options={options}
          chart={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={chartsScope.guard(((shown) => () => {
            setEditing((current) => (current === shown ? null : current));
            setNotice({ text: copy.saved });
            void load();
          })(editing))}
        />
      )}
      {notice && (
        <p className="pulse-note" role="status">
          {notice.text}
          {notice.undo && <> <button type="button" className="pulse-link" onClick={() => void undo(notice.undo)}>{copy.undo}</button></>}
        </p>
      )}
      {failed && <p className="pulse-note pulse-note--alert" role="status">{copy.unavailable}</p>}
      {!failed && charts === null && <p className="pulse-note" role="status">{copy.loading}</p>}
      {charts?.length === 0 && <p className="pulse-note">{copy.noCharts}</p>}
      {charts?.length > 0 && (
        <ul className="pulse-grid" aria-label={copy.yourCharts}>
          {charts.map((chart) => (
            <li key={chart.id} className="pulse-card plane-card">
              <div className="pulse-card__head">
                <h3 className="pulse-card__title">{chart.pinned ? <span className="pulse-pin"><span aria-hidden="true">★ </span><span className="pulse-sr">{copy.pinned}: </span></span> : null}{chart.title}</h3>
                {chart.spec && <p className="pulse-note">{copy.measures[chart.spec.measure]} · {copy.periods[chart.spec.period]} · {copy.scopes[chart.scope]}</p>}
              </div>
              {chart.spec
                ? <PulseChart figures={chart.figures} spec={chart.spec} title={chart.title} copy={copy} lang={lang} name={`pulse:saved:${chart.id}`} />
                : <p className="pulse-note" role="status">{copy.chartUnavailable}</p>}
              <div className="pulse-actions">
                {chart.owned && chart.spec && <button type="button" className="pulse-button" aria-label={`${copy.edit} ${chart.title}`} onClick={() => setEditing(chart)}>{copy.edit}</button>}
                {chart.owned && <button type="button" className="pulse-button" aria-label={`${copy.remove} ${chart.title}`} onClick={() => void remove(chart)}>{copy.remove}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// The analytics desk's chart view: the same builder and saved charts, so the
// website and the phone share one set of specs.
export function PulseChartStudio({ api, hat, onOpenPulse = null }) {
  const { t } = useLang();
  const copy = pulseCopy(t);
  const [options, setOptions] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    api.options(hat).then((next) => { if (current) setOptions(next); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [api, hat]);
  return (
    <div className="pulse-studio">
      {onOpenPulse && (
        <p className="pulse-note">
          <button type="button" className="pulse-link" onClick={onOpenPulse}>{copy.studioLink}</button> · {copy.studioLinkSub}
        </p>
      )}
      {failed && <p className="pulse-note pulse-note--alert" role="status">{copy.pageUnavailable}</p>}
      {!failed && !options && <p className="pulse-note" role="status">{copy.loading}</p>}
      {options && <PulseSavedCharts api={api} hat={hat} options={options} />}
    </div>
  );
}
