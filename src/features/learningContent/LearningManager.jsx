import { useEffect, useId, useMemo, useRef, useState } from "react";
import { learningContentCopy } from "../../lib/i18n/learningContent.js";
import { LEARNING_LIMITS, LEARNING_MAX_OFFSET, LEARNING_PAGE_SIZE, learningErrorKind, learningPublicationState } from "./model.js";
import { LearningChoicePicker } from "./LearningChoicePicker.jsx";
import { LearningEditor } from "./LearningEditor.jsx";
import { formatLearningInstant } from "./time.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { prepareBusyWrite, useBusyScope } from "../../lib/busyWrite.js";

const EMPTY = Object.freeze([]);

function mergeById(existing, incoming) {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id) && seen.add(item.id))];
}

function settingsFrom(policy) {
  return policy ? {
    quotes: policy.quotesEnabled,
    lessons: policy.lessonsEnabled,
    mode: policy.selectedIds == null ? "all" : "some",
    selected: policy.selectedIds ? [...policy.selectedIds] : [],
  } : null;
}

function sameSettings(left, right) {
  if (!left || !right) return left === right;
  return left.quotes === right.quotes && left.lessons === right.lessons && left.mode === right.mode
    && (left.mode === "all" || (left.selected.length === right.selected.length && left.selected.every((id) => right.selected.includes(id))));
}

// The authorized editor behind /m/rights?learning=manage. The server decides
// who manages what: chapter and organization scopes are offered to a caller
// the policy reports as a manager (the organization workspace refuses a
// chapter-only administrator), and the platform library only to a
// provisioned platform owner. Nothing here grants a role.
export function LearningManager({ api, scope, policyState, onBack, backLabel = null }) {
  const tr = useMemo(() => learningContentCopy(scope.locale), [scope.locale]);
  const policy = policyState.status === "ready" ? policyState.policy : null;
  const scopes = useMemo(() => (policy ? [
    ...(policy.canManage ? ["chapter", "organization"] : []),
    ...(policy.isPlatformOwner ? ["platform"] : []),
  ] : EMPTY), [policy]);
  const [chosenScope, setChosenScope] = useState(null);
  const activeScope = scopes.includes(chosenScope) ? chosenScope : scopes[0] ?? null;
  const [reloadCount, setReloadCount] = useState(0);
  const workspaceKey = activeScope ? `${activeScope}|${reloadCount}` : null;
  const [workspace, setWorkspace] = useState({ key: null });
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [settingsStatus, setSettingsStatus] = useState({ kind: "idle" });
  const [editing, setEditing] = useState(null);
  const sequence = useRef(0);
  const editorCount = useRef(0);
  const titleId = useId();
  const scopeLabelId = useId();
  const itemsTitleId = useId();
  const settingsTitleId = useId();

  useEffect(() => {
    if (!workspaceKey) return undefined;
    const token = ++sequence.current;
    api.getWorkspace({ chapterId: scope.chapterId, scope: activeScope, offset: 0 })
      .then((page) => {
        if (token !== sequence.current) return;
        setWorkspace({ key: workspaceKey, status: "ready", items: page.items, hasMore: page.hasMore, nextOffset: LEARNING_PAGE_SIZE.workspace, policy: page.policy, dropped: page.dropped, loadingMore: false, moreError: null });
      })
      .catch((error) => {
        if (token !== sequence.current) return;
        setWorkspace({ key: workspaceKey, status: "error", error: learningErrorKind(error), items: EMPTY, hasMore: false, nextOffset: 0, policy: null, dropped: 0 });
      });
    return () => {
      sequence.current += 1;
    };
  }, [api, workspaceKey, activeScope, scope.chapterId]);

  // #8435: a settings save's own pending mark and lock, keyed by the
  // workspace activation. Editing a field resets `settingsStatus` while a
  // save runs, so Save keeps its pending state here until that save settles;
  // another scope (or a reload) is a new activation whose Save is ready, as
  // the earlier save's answer is already dropped there.
  const settingsScope = useBusyScope(workspaceKey);
  const [settingsSaving, setSettingsSaving] = useState(null);
  const savingSettings = settingsSaving === settingsScope.generation;
  const busyWriteRef = useRef(new Set());
  const current = workspace.key === workspaceKey ? workspace : null;
  const baseSettings = settingsFrom(current?.status === "ready" ? current.policy : null);
  const settings = settingsDraft?.key === workspaceKey ? settingsDraft.value : baseSettings;
  // The live draft, read when a save answers.
  const settingsDraftRef = useRef(settingsDraft);
  settingsDraftRef.current = settingsDraft;
  const settingsDirty = Boolean(settingsDraft?.key === workspaceKey && !sameSettings(settingsDraft.value, baseSettings));
  const editSettings = (changes) => {
    setSettingsStatus({ kind: "idle" });
    setSettingsDraft({ key: workspaceKey, value: { ...settings, ...changes } });
  };

  function chooseScope(next) {
    if (next === activeScope) return;
    if (settingsDirty && !window.confirm(tr("editor.leaveConfirm"))) return;
    setSettingsDraft(null);
    setSettingsStatus({ kind: "idle" });
    setChosenScope(next);
  }

  function loadMore() {
    if (!current || current.loadingMore || !current.hasMore || current.nextOffset > LEARNING_MAX_OFFSET) return;
    const token = sequence.current;
    const offset = current.nextOffset;
    setWorkspace((prior) => ({ ...prior, loadingMore: true, moreError: null }));
    api.getWorkspace({ chapterId: scope.chapterId, scope: activeScope, offset })
      .then((page) => {
        if (token !== sequence.current) return;
        setWorkspace((prior) => ({ ...prior, items: mergeById(prior.items, page.items), hasMore: page.hasMore, nextOffset: offset + LEARNING_PAGE_SIZE.workspace, dropped: prior.dropped + page.dropped, loadingMore: false }));
      })
      .catch((error) => {
        if (token === sequence.current) setWorkspace((prior) => ({ ...prior, loadingMore: false, moreError: learningErrorKind(error) }));
      });
  }

  // After a revision conflict: re-read the pages already on screen and hand
  // back the item's current server state (or null when it is gone).
  async function reloadItem(id) {
    const token = sequence.current;
    const loaded = Math.max(current?.nextOffset || 0, LEARNING_PAGE_SIZE.workspace);
    let items = [];
    let offset = 0;
    let hasMore = true;
    let latestPolicy = current?.policy ?? null;
    let dropped = 0;
    while (hasMore && offset < loaded) {
      const page = await api.getWorkspace({ chapterId: scope.chapterId, scope: activeScope, offset });
      items = mergeById(items, page.items);
      hasMore = page.hasMore;
      latestPolicy = page.policy;
      dropped += page.dropped;
      offset += LEARNING_PAGE_SIZE.workspace;
    }
    if (token !== sequence.current) return null;
    setWorkspace((prior) => ({ ...prior, items, hasMore, nextOffset: offset, policy: latestPolicy, dropped }));
    return items.find((item) => item.id === id) ?? null;
  }

  function adoptItem(item) {
    setWorkspace((prior) => {
      if (!prior.items) return prior;
      const exists = prior.items.some((row) => row.id === item.id);
      return { ...prior, items: exists ? prior.items.map((row) => (row.id === item.id ? item : row)) : [item, ...prior.items] };
    });
  }

  // The too-many check sends nothing and runs without the lock; the lock is
  // taken only when the save starts.
  function saveSettings(event) {
    event.preventDefault();
    const started = settingsScope.generation;
    return prepareBusyWrite(busyWriteRef, `settings:${started}`, () => {
      // The activation's lock is held for exactly as long as its save's mark,
      // so it alone refuses a press while that save runs.
      if (!settings) return undefined;
      const selectedIds = activeScope === "platform" || settings.mode === "all" ? null : settings.selected;
      if (selectedIds && selectedIds.length > LEARNING_LIMITS.selectedIds) {
        setSettingsStatus({ kind: "tooMany" });
        return undefined;
      }
      const sent = { key: workspaceKey, value: settings };
      return (unlock) => saveSettingsNow(started, selectedIds, sent, unlock);
    }, event);
  }

  async function saveSettingsNow(started, selectedIds, sent, unlock) {
    setSettingsSaving(started);
    setSettingsStatus({ kind: "saving" });
    const token = sequence.current;
    try {
      const saved = await api.savePolicy({ chapterId: scope.chapterId, scope: activeScope, quotesEnabled: settings.quotes, lessonsEnabled: settings.lessons, selectedIds, expectedRevision: current.policy.revision ?? 0 });
      if (token !== sequence.current) return;
      setWorkspace((prior) => ({ ...prior, policy: saved }));
      // Settings changed while this save ran are not what
      // it sent. They stay, the form stays unsaved, and the next press of
      // Save sends them; only a draft the save sent is cleared as saved.
      const live = settingsDraftRef.current;
      if (live?.key === sent.key && !sameSettings(live.value, sent.value)) {
        setSettingsStatus({ kind: "idle" });
      } else {
        setSettingsDraft(null);
        setSettingsStatus({ kind: "saved" });
      }
      policyState.refresh();
    } catch (error) {
      if (token === sequence.current) setSettingsStatus({ kind: "error", errorKind: learningErrorKind(error) });
    } finally {
      unlock();
      setSettingsSaving((value) => (value === started ? null : value));
    }
  }

  function toggleSelected(id, checked) {
    const selected = checked ? [...settings.selected.filter((entry) => entry !== id), id] : settings.selected.filter((entry) => entry !== id);
    editSettings({ selected });
  }

  const header = (
    <>
      {onBack ? <button type="button" className="learn-back" onClick={() => { if (!settingsDirty || window.confirm(tr("editor.leaveConfirm"))) onBack(); }}><span aria-hidden="true">‹</span>{backLabel || tr("manage.back")}</button> : null}
      <h1 className="lc-manage__title" id={titleId}>{tr("manage.title")}</h1>
    </>
  );

  if (policyState.status === "loading") {
    return <section className="lc-manage" aria-labelledby={titleId}>{header}<p className="lc-status" role="status">{tr("manage.checking")}</p></section>;
  }
  if (policyState.status === "error") {
    return (
      <section className="lc-manage" aria-labelledby={titleId}>
        {header}
        <div className="lc-error" role="alert">
          <p>{tr(`error.${learningErrorKind(policyState.error)}`)}</p>
          <button type="button" className="lc-button" onClick={() => policyState.refresh()}>{tr("library.retry")}</button>
        </div>
      </section>
    );
  }
  if (!scopes.length) {
    return <section className="lc-manage" aria-labelledby={titleId}>{header}<p className="lc-notice" role="status">{tr("manage.notAllowed")}</p></section>;
  }

  if (editing) {
    return (
      <section className="lc-manage" aria-labelledby={titleId}>
        <h1 className="lc-manage__title" id={titleId}>{tr("manage.title")}</h1>
        {api.preview ? <p className="lc-notice">{tr("manage.previewMode")}</p> : null}
        <LearningEditor key={editing.key} api={api} scope={scope} workspaceScope={activeScope} item={editing.item} initialKind={editing.kind}
          onSaved={adoptItem} onBack={() => setEditing(null)} onReload={reloadItem} />
      </section>
    );
  }

  const openEditor = (item, kind = item?.kind) => {
    editorCount.current += 1;
    setEditing({ key: editorCount.current, item, kind });
  };
  const nowMs = Date.now();

  return (
    <section className="lc-manage" aria-labelledby={titleId}>
      {header}
      <p className="lc-manage__intro">{tr("manage.intro")}</p>
      {api.preview ? <p className="lc-notice">{tr("manage.previewMode")}</p> : null}

      <div className="lc-panel">
        <p className="lc-field__label" id={scopeLabelId}>{tr("manage.scopeLabel")}</p>
        <div className="lc-segment" role="group" aria-labelledby={scopeLabelId}>
          {scopes.map((name) => (
            <button key={name} type="button" aria-pressed={name === activeScope} onClick={() => chooseScope(name)}>{tr(`scope.${name}`)}</button>
          ))}
        </div>
        <p className="lc-hint">{tr(`manage.scopeHint.${activeScope}`)}</p>
      </div>

      {!current ? <p className="lc-status" role="status">{tr("manage.loading")}</p> : null}
      {current?.status === "error" ? (
        <div className="lc-error" role="alert">
          <p>{tr(`error.${current.error}`)}</p>
          <button type="button" className="lc-button lc-button--quiet" onClick={() => setReloadCount((value) => value + 1)}>{tr("library.retry")}</button>
        </div>
      ) : null}

      {current?.status === "ready" && settings ? (
        <form className="lc-panel lc-settings" onSubmit={saveSettings} aria-labelledby={settingsTitleId}>
          <h2 className="lc-panel__title" id={settingsTitleId}>{tr("settings.title")}</h2>
          <p className="lc-hint">{tr(activeScope === "platform" ? "settings.hintPlatform" : "settings.hintTenant")}</p>
          <label className="lc-check">
            <input type="checkbox" checked={settings.quotes} onChange={(event) => editSettings({ quotes: event.target.checked })} />
            <span>{tr("settings.quotes")}</span>
          </label>
          <label className="lc-check">
            <input type="checkbox" checked={settings.lessons} onChange={(event) => editSettings({ lessons: event.target.checked })} />
            <span>{tr("settings.lessons")}</span>
          </label>
          {activeScope === "platform" ? <p className="lc-hint">{tr("settings.platformSelection")}</p> : (
            <fieldset className="lc-group lc-group--plain">
              <legend className="lc-field__label">{tr("settings.selection")}</legend>
              <label className="lc-check">
                <input type="radio" name={`${settingsTitleId}-mode`} checked={settings.mode === "all"} onChange={() => editSettings({ mode: "all" })} />
                <span>{tr("settings.selectionAll")}</span>
              </label>
              <label className="lc-check">
                <input type="radio" name={`${settingsTitleId}-mode`} checked={settings.mode === "some"} onChange={() => editSettings({ mode: "some" })} />
                <span>{tr("settings.selectionSome")}</span>
              </label>
              <p className="lc-hint">{tr("settings.selectionHelp")}</p>
              {settings.mode === "some" ? (
                <div className="lc-selection">
                  <p className="lc-status">{tr("settings.selectedCount", { count: settings.selected.length })}</p>
                  {settings.selected.length > 0 ? <button type="button" className="lc-button lc-button--quiet" onClick={() => editSettings({ selected: [] })}>{tr("settings.clearSelection")}</button> : null}
                  <LearningChoicePicker api={api} chapterId={scope.chapterId} scopeName={activeScope} locale={scope.locale}
                    selected={settings.selected} onToggle={toggleSelected} reloadKey={reloadCount} />
                </div>
              ) : null}
            </fieldset>
          )}
          <div className="lc-actions">
            <BusyButton type="submit" className="lc-button" pending={savingSettings} disabled={!settingsDirty}>
              {savingSettings ? tr("settings.saving") : tr("settings.save")}
            </BusyButton>
            {settingsDirty ? <span className="lc-status">{tr("editor.unsaved")}</span> : null}
          </div>
          {settingsStatus.kind === "saved" ? <p className="lc-status" role="status">{tr("settings.saved")}</p> : null}
          {settingsStatus.kind === "tooMany" ? <p className="lc-error" role="alert">{tr("settings.tooMany", { limit: LEARNING_LIMITS.selectedIds })}</p> : null}
          {settingsStatus.kind === "error" ? <div className="lc-error" role="alert"><p>{tr(`error.${settingsStatus.errorKind}`)}</p>
            {settingsStatus.errorKind === "conflict" ? <button type="button" className="lc-button" onClick={() => { setSettingsDraft(null); setSettingsStatus({ kind: "idle" }); setReloadCount((value) => value + 1); }}>{tr("settings.reload")}</button> : null}
          </div> : null}
        </form>
      ) : null}

      {current?.status === "ready" ? (
        <section className="lc-panel" aria-labelledby={itemsTitleId}>
          <h2 className="lc-panel__title" id={itemsTitleId}>{tr("items.title")}</h2>
          <div className="lc-actions">
            <button type="button" className="lc-button" onClick={() => openEditor(null, "quote")}>{tr("items.newQuote")}</button>
            <button type="button" className="lc-button" onClick={() => openEditor(null, "mini_lesson")}>{tr("items.newLesson")}</button>
          </div>
          {current.dropped > 0 ? <p className="lc-hint">{tr("manage.dropped", { count: current.dropped })}</p> : null}
          {current.items.length === 0 ? <p className="lc-status">{tr("items.empty")}</p> : (
            <ul className="lc-items">
              {current.items.map((item) => {
                const title = item.title || tr("items.untitled");
                const state = learningPublicationState(item, nowMs);
                const stateText = state === "upcoming"
                  ? tr("state.upcoming", { start: formatLearningInstant(item.starts_at, scope.locale) })
                  : state === "live" && item.ends_at ? tr("state.liveUntil", { end: formatLearningInstant(item.ends_at, scope.locale) }) : tr(`state.${state}`);
                return (
                  <li key={item.id} className="lc-item">
                    <div className="lc-item__copy">
                      <strong className="lc-item__title">{title}</strong>
                      <span className="lc-item__meta">
                        {[tr(`kind.${item.kind}`), tr(`locale.${item.locale}`), tr(`status.${item.status}`), stateText, tr("items.revision", { revision: item.revision })].join(" · ")}
                      </span>
                      <span className="lc-item__badges">
                        {item.is_default ? <span className="lc-chip">{tr("items.default")}</span> : null}
                        {item.provenance && Object.keys(item.provenance).length > 0 ? <span className="lc-chip lc-chip--muted">{tr("items.recovered")}</span> : null}
                      </span>
                    </div>
                    <div className="lc-item__controls">
                      <button type="button" className="lc-button lc-button--quiet" aria-label={tr("items.editNamed", { title })} onClick={() => openEditor(item)}>{tr("items.edit")}</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {current.hasMore ? <button type="button" className="lc-button lc-button--quiet" disabled={current.loadingMore} onClick={loadMore}>{tr("items.loadMore")}</button> : null}
          {current.moreError ? <p className="lc-error" role="alert">{tr(`error.${current.moreError}`)}</p> : null}
        </section>
      ) : null}
    </section>
  );
}
