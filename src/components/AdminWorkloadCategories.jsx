import { WorkspaceSection } from "../components/WorkspacePages.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { ArrowDown, ArrowUp, ListOrdered } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { t as translate } from "../lib/i18n.js";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { workloadCategoryLayout } from "../lib/workloadCategories.js";

// REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103 (#6910):
// an organization admin names, shows or hides, and orders the eight workload
// categories of the member Workload log. One Save writes the order and
// visibility (save_organization_workload_categories) and then every changed
// name (update_organization_label). Hidden categories keep their history.
// The card sits on the Labels page, under the organization's other labels.

const LABEL_LIMIT = 40;
const sameLayout = (a, b) => a.length === b.length && a.every((item, index) => item.key === b[index].key && item.visible === b[index].visible);

export function WorkloadCategoriesCard({ configuration, chapterScoped = false, api, reload, onNotice }) {
  const { t, lang } = useLang();
  const [server, setServer] = useState(null);
  const [layout, setLayout] = useState(null);
  const [names, setNames] = useState({});
  const [loadFailed, setLoadFailed] = useState(false);
  const [failed, setFailed] = useState(null);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [moved, setMoved] = useState("");
  const savedNames = useMemo(() => Object.fromEntries(workloadCategoryLayout(null).map(({ key }) => [
    key, configuration?.labelOverrides?.[`workload.cat.${key}`] ?? "",
  ])), [configuration]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // A settings reload (the Labels card's own Save triggers one) keeps every
  // unsaved edit here: a draft that differs from what the server last said
  // stays, and only untouched names and an untouched layout follow the
  // server, the way the Labels card keeps its drafts.
  const serverRef = useRef(null);
  const canLoad = !chapterScoped && configuration != null && typeof api?.loadWorkloadCategories === "function";
  useEffect(() => {
    if (!canLoad) return;
    let live = true;
    api.loadWorkloadCategories().then((payload) => {
      if (!live) return;
      const next = workloadCategoryLayout(payload);
      const previous = serverRef.current;
      serverRef.current = next;
      setServer(next);
      setLayout((current) => (current && previous && !sameLayout(current, previous) ? current : next));
    }).catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [api, canLoad]);
  const previousSavedNames = useRef({});
  useEffect(() => {
    setNames((current) => Object.fromEntries(Object.entries(savedNames).map(([key, value]) => [
      key,
      current[key] !== undefined && current[key] !== (previousSavedNames.current[key] ?? "") ? current[key] : value,
    ])));
    previousSavedNames.current = savedNames;
  }, [savedNames]);

  const nameOf = (key) => t(`workload.cat.${key}`);
  // The catalogue name, never the organization's own one.
  const defaultName = (key) => translate(lang, `workload.cat.${key}`);
  const draftName = (key) => (names[key] ?? "").trim().replace(/\s+/gu, " ");
  const invalidName = (key) => /[<>\p{Cc}]/u.test(names[key] ?? "");
  const changedNames = layout ? layout.map(({ key }) => key).filter((key) => draftName(key) !== (savedNames[key] ?? "").trim()) : [];
  const layoutChanged = Boolean(layout && server && !sameLayout(layout, server));
  const noneShown = Boolean(layout && !layout.some((item) => item.visible));
  const anyInvalid = Boolean(layout?.some(({ key }) => invalidName(key)));
  const canSave = !busy && !noneShown && !anyInvalid && (layoutChanged || changedNames.length > 0);

  function move(index, step) {
    const target = index + step;
    if (!layout || target < 0 || target >= layout.length) return;
    const next = [...layout];
    [next[index], next[target]] = [next[target], next[index]];
    setLayout(next);
    setFailed(null);
    setMoved(t("admin.workloadCategories.moved", { label: nameOf(next[target].key), position: target + 1, total: next.length }));
  }

  function toggle(key, visible) {
    setLayout((current) => current.map((item) => (item.key === key ? { ...item, visible } : item)));
    setFailed(null);
  }

  function save() {
    return runBusyWrite(busyWriteRef, "categories", () => saveNow());
  }

  async function saveNow() {
    if (!canSave) return;
    setBusy(true); setFailed(null);
    try {
      if (layoutChanged) {
        const result = await api.saveWorkloadCategories(layout);
        if (!mounted.current || !result || typeof result !== "object") return;
        const next = workloadCategoryLayout(result);
        serverRef.current = next;
        setServer(next);
        setLayout(next);
      }
      for (const key of changedNames) {
        const result = await api.updateOrganizationLabel(`workload.cat.${key}`, draftName(key));
        if (!mounted.current || !result || typeof result !== "object") return;
      }
      onNotice(t("admin.workloadCategories.saved"));
      reload();
    } catch { if (mounted.current) setFailed(t("admin.workloadCategories.failed")); } finally { if (mounted.current) setBusy(false); }
  }

  // A chapter-only Admin already reads the page's one refusal on the Labels card.
  if (chapterScoped) return null;
  let body;
  if (configuration == null || typeof api?.loadWorkloadCategories !== "function" || loadFailed) body = <p className="xus-note">{t("admin.config.unavailable")}</p>;
  else if (!layout) body = <p className="xus-note" role="status">{t("admin.workloadCategories.loading")}</p>;
  else body = <>
    {failed && <p className="xus-note xus-note--error" role="alert">{failed}</p>}
    <p className="xus-note" id="admin-workload-categories-rule">{t("admin.workloadCategories.rule")}</p>
    <ol className="xus-workload-list">
      {layout.map((item, index) => {
        const label = nameOf(item.key);
        const inputId = `admin-workload-category-${item.key}`;
        return <li className="xus-workload-row" key={item.key} data-testid={`admin-workload-category-${item.key}`}>
          <label className="xus-field" htmlFor={inputId}>
            <span>{t("admin.workloadCategories.position", { position: index + 1, total: layout.length })} · {t("admin.workloadCategories.nameFor", { label: defaultName(item.key) })}</span>
            <input id={inputId} className="xus-input" maxLength={LABEL_LIMIT} value={names[item.key] ?? ""}
              aria-invalid={invalidName(item.key) || undefined} aria-describedby="admin-workload-categories-rule"
              placeholder={t("admin.labels.default", { label: defaultName(item.key) })}
              onChange={(event) => { const value = event.target.value; setNames((current) => ({ ...current, [item.key]: value })); setFailed(null); }} />
          </label>
          <div className="xus-workload-row__controls">
            <label className="xus-field xus-field--check">
              <input type="checkbox" checked={item.visible} aria-label={t("admin.workloadCategories.showName", { label })}
                onChange={(event) => toggle(item.key, event.target.checked)} />
              <span aria-hidden="true">{t("admin.workloadCategories.show")}</span>
            </label>
            <BusyButton className="xus-btn xus-btn--icon" type="button" pending={busy} disabled={index === 0}
              aria-label={t("admin.workloadCategories.moveUp", { label })} onClick={() => move(index, -1)}><ArrowUp size={16} aria-hidden="true" /></BusyButton>
            <BusyButton className="xus-btn xus-btn--icon" type="button" pending={busy} disabled={index === layout.length - 1}
              aria-label={t("admin.workloadCategories.moveDown", { label })} onClick={() => move(index, 1)}><ArrowDown size={16} aria-hidden="true" /></BusyButton>
          </div>
        </li>;
      })}
    </ol>
    <p className="sr-only" role="status" aria-live="polite">{moved}</p>
    {noneShown && <p className="xus-note xus-note--error" role="alert">{t("admin.workloadCategories.noneShown")}</p>}
    <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy} disabled={noneShown || anyInvalid || !(layoutChanged || changedNames.length > 0)}
      aria-label={busy ? t("admin.workloadCategories.saving") : t("admin.workloadCategories.save")} onClick={save}>{busy ? t("auth.working") : t("admin.workloadCategories.save")}</BusyButton>
  </>;

  return <WorkspaceSection name="admin-labels"><article id="admin-workload-categories" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><ListOrdered size={18} /></span>
      <div className="xus-cardhead__copy"><h2 className="xus-cardttl">{t("admin.workloadCategories.title")}</h2><p className="xus-cardsub">{t("admin.workloadCategories.sub")}</p></div>
    </header>
    <div className="xus-cardbody xus-form">{body}</div>
  </article></WorkspaceSection>;
}
