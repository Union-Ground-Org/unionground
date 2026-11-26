import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { templateByKey } from "../../lib/formTemplates.js";
import { dateTimeFormat } from "../../lib/i18n.js";
import "./chapterAccess.css";
import { BusyButton, BusyFieldset, BusySelect } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

const GROUPS = ["workload", "forms", "templates", "capabilities"];

export function UnitSettingsPanel({ api, chapterId, memberScope = false, scopeKey = chapterId }) {
  const { t, lang } = useLang();
  const [selection, setSelection] = useState({ scopeKey, unit: null });
  const unit = selection.scopeKey === scopeKey ? selection.unit : null;
  const [page, setPage] = useState({ scopeKey, offset: 0 });
  const offset = page.scopeKey === scopeKey ? page.offset : 0;
  const [state, setState] = useState({ phase: "loading", workspace: null, key: scopeKey });
  const [values, setValues] = useState({});
  const [allowed, setAllowed] = useState({});
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  // Nothing shows before the first answer: held, the server refuses the editor.
  const [shown, setShown] = useState(false);
  const generation = useRef(0);
  // Record 8435: a save is locked by its chapter and unit synchronously. A
  // scope change clears busy but never this lock, so returning to a unit
  // whose save still runs cannot start a second save for it.
  const busyWriteRef = useRef(new Set());
  const hydrate = (workspace) => {
    setShown(true);
    setValues(unit ? Object.fromEntries(Object.entries(workspace.overrides).filter(([key]) => workspace.allowed[key]))
      : workspace.chapterOverrides || {});
    setAllowed(workspace.allowed);
    setState({ phase: "ready", workspace, key: scopeKey });
  };
  useEffect(() => {
    if (!api || !chapterId) return undefined;
    const current = ++generation.current;
    setBusy(false); setNotice(null); setState({ phase: "loading", workspace: null, key: scopeKey });
    const load = async () => {
      if (memberScope) {
        const context = await api.load();
        if (!context?.canManage) return null;
      }
      return offset ? api.loadEditor(chapterId, unit, offset) : api.loadEditor(chapterId, unit);
    };
  // #9781: a first read that never answers ends in the panel's own
  // could-not-load line with its Try again after the shared deadline,
  // instead of "Loading access…" for as long as the page stays open.
    withLoadDeadline(load).then((workspace) => {
      if (current !== generation.current) return;
      if (!workspace) { setState({ phase: "hidden", workspace: null, key: scopeKey }); return; }
      if (!workspace.canSetChapter && !unit && (workspace.unitCount ?? workspace.units.length) === 1) { setSelection({ scopeKey, unit: workspace.units[0].id }); return; }
      hydrate(workspace);
    }).catch((error) => { if (current === generation.current) setState({ phase: error?.code === "42501" || (error?.code === "PGRST202" && error.message.includes("get_unit_settings_workspace")) ? "hidden" : "error", workspace: null, key: scopeKey }); });
    return () => { generation.current += 1; };
    // hydrate belongs to this request's unit and scope, not a later render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chapterId, scopeKey, memberScope, unit, offset, revision]);
  const workspace = state.key === scopeKey ? state.workspace : null;
  const choose = (value) => {
    generation.current += 1; setNotice(null);
    setState({ phase: "loading", workspace: null, key: scopeKey }); setSelection({ scopeKey, unit: value || null });
  };
  function save(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, `settings:${chapterId}:${unit || "chapter"}`, () => saveNow(), event);
  }
  async function saveNow() {
    const current = generation.current;
    setBusy(true); setNotice(null);
    try {
      const result = unit
        ? await api.saveUnit(chapterId, unit, values, workspace.unitVersion, workspace.actorId)
        : await api.saveChapter(chapterId, values, allowed, workspace.chapterVersion, workspace.actorId);
      if (current === generation.current && result) { hydrate(result); setNotice("unitSettings.saved"); }
    } catch { if (current === generation.current) setNotice("unitSettings.saveError"); }
    finally { if (current === generation.current) setBusy(false); }
  }
  if (!api || !chapterId || state.phase === "hidden" || (state.phase === "loading" && !shown)) return null;
  const canEdit = workspace && (unit || workspace.canSetChapter);
  const change = (group, value) => setValues((old) => ({ ...old, [group]: value }));
  return <section className="institutional-section chapter-access" aria-label={t("unitSettings.title")} aria-busy={busy}>
    <h3>{t("unitSettings.title")}</h3>
    <p>{t("unitSettings.help")}</p>
    {notice && <p role={notice === "unitSettings.saved" ? "status" : "alert"}>{t(notice)}</p>}
    {state.phase === "loading" && <p role="status">{t("access.loading")}</p>}
    {state.phase === "error" && <div role="alert"><p>{t("unitSettings.loadError")}</p><button type="button" onClick={() => { choose(null); setRevision((value) => value + 1); }}>{t("access.retry")}</button></div>}
    {workspace && <>
      <label>{t("unitSettings.editing")}<BusySelect aria-label={t("unitSettings.editing")} pending={busy} value={unit || ""} onChange={(event) => choose(event.target.value)}>
        <option value="">{workspace.canSetChapter ? t("unitSettings.chapter") : t("unitSettings.choose")}</option>
        {unit && !workspace.units.some((item) => item.id === unit) && <option value={unit}>{workspace.unitName}</option>}
        {workspace.units.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </BusySelect></label>
      {Boolean(offset || workspace.nextUnitOffset) && <div>
        <BusyButton type="button" pending={busy} disabled={!offset} onClick={() => setPage({ scopeKey, offset: Math.max(0, offset - 30) })}>{t("unitSettings.previous")}</BusyButton>
        <BusyButton type="button" pending={busy} disabled={workspace.nextUnitOffset == null} onClick={() => setPage({ scopeKey, offset: workspace.nextUnitOffset })}>{t("unitSettings.next")}</BusyButton>
      </div>}
      {canEdit && <form className="institutional-form" onSubmit={save}>
        {GROUPS.map((group) => {
          const editable = !unit || workspace.allowed[group] === true;
          const active = Object.hasOwn(values, group);
          const parentDefaults = unit ? workspace.defaults : (workspace.organizationDefaults || workspace.defaults);
          const value = values[group] ?? parentDefaults[group];
          return <BusyFieldset key={group} pending={busy}>
            <legend>{t(`unitSettings.${group}`)}</legend>
            {unit ? <label className="institutional-check"><input type="checkbox" checked={!active} disabled={!editable} onChange={(event) => {
              if (event.target.checked) setValues((old) => Object.fromEntries(Object.entries(old).filter(([key]) => key !== group)));
              else change(group, workspace.defaults[group]);
            }} />{t("unitSettings.inherit")}</label> : <label className="institutional-check"><input type="checkbox" checked={allowed[group] === true} onChange={(event) => setAllowed((old) => ({ ...old, [group]: event.target.checked }))} />{t("unitSettings.delegate")}</label>}
            {!unit && group !== "capabilities" && active && <button type="button" onClick={() => setValues((old) => Object.fromEntries(Object.entries(old).filter(([key]) => key !== group)))}>{t("unitSettings.organization")}</button>}
            {unit && !editable && <p>{t("unitSettings.locked")}</p>}
            <div aria-disabled={!editable || (unit && !active)}>
              {group === "workload" && value.map((category, index) => <div key={category.key}>
                <label>{t("unitSettings.category")}<input value={category.label.startsWith("workload.") ? t(category.label) : category.label} maxLength={80} disabled={!editable || (unit && !active)} onChange={(event) => change(group, value.map((item) => item.key === category.key ? { ...item, label: event.target.value } : item))} /></label>
                <label className="institutional-check"><input type="checkbox" checked={category.visible} disabled={!editable || (unit && !active)} onChange={(event) => change(group, value.map((item) => item.key === category.key ? { ...item, visible: event.target.checked } : item))} />{t("unitSettings.shown")}</label>
                <button type="button" disabled={!editable || (unit && !active) || index === 0} aria-label={t("unitSettings.moveUp", { name: category.label.startsWith("workload.") ? t(category.label) : category.label })} onClick={() => {
                  const next = [...value]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; change(group, next);
                }}>{t("unitSettings.up")}</button>
              </div>)}
              {["forms", "templates"].includes(group) && parentDefaults[group].map((key) => <label className="institutional-check" key={key}>
                <input type="checkbox" checked={value.includes(key)} disabled={!editable || (unit && !active)} onChange={(event) => change(group, event.target.checked ? [...value, key] : value.filter((item) => item !== key))} />
                {(() => {
                  const choice = workspace[group === "forms" ? "formChoices" : "templateChoices"]?.find((item) => item.key === key);
                  return (lang === "es" ? choice?.labelEs : choice?.labelEn)
                    || (group === "forms" && templateByKey(key) ? t(templateByKey(key).titleKey) : t(`unitSettings.${group}`));
                })()}
              </label>)}
              {group === "capabilities" && (unit ? Object.entries(workspace.defaults.capabilities).map(([key, enabled]) => <label className="institutional-check" key={key}>
                <input type="checkbox" checked={value[key] ?? enabled} disabled={!editable || !active || !enabled} onChange={(event) => change(group, { ...value, [key]: event.target.checked })} />
                {t(`access.role.${key.split(":")[0]}`)} · {t(`access.cap.${key.split(":")[1]}`)}
              </label>) : <p>{t("unitSettings.chapterCapabilities")}</p>)}
            </div>
          </BusyFieldset>;
        })}
        <BusyButton pending={busy}>{t("access.save")}</BusyButton>
      </form>}
      <h4>{t("unitSettings.audit")}</h4>
      <ul>{workspace.audit.map((entry) => <li key={entry.id}>{entry.unit_name || t("unitSettings.chapter")} · {dateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }).format(new Date(entry.created_at))} ET · {t("unitSettings.saved")}</li>)}</ul>
    </>}
  </section>;
}
