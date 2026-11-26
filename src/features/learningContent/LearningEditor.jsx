import { useEffect, useId, useMemo, useRef, useState } from "react";
import { learningContentCopy } from "../../lib/i18n/learningContent.js";
import {
  LEARNING_AUDIENCES,
  LEARNING_KINDS,
  LEARNING_LIMITS,
  LEARNING_LOCALES,
  codePointLength,
  emptyLearningDraft,
  learningBodyLimit,
  learningDraftFromItem,
  learningDraftFromSnapshot,
  learningErrorKind,
  learningPayloadsEqual,
  validateLearningItem,
} from "./model.js";
import { LearningHistoryPanel } from "./LearningHistoryPanel.jsx";
import { LearningPreviewPanel } from "./LearningPreviewPanel.jsx";
import { LearningPublicationPanel } from "./LearningPublicationPanel.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { prepareBusyWrite } from "../../lib/busyWrite.js";

// Limit violations show while typing; "required" and other issues wait for
// the first save attempt so an empty new form is not a wall of errors.
const LIVE_CODES = new Set(["too_long", "too_many", "entry_too_long", "too_large"]);

function issueMessage(tr, issue) {
  return tr(`issue.${issue.code}`, { limit: issue.limit, min: issue.min, max: issue.max });
}

function TextField({ id, label, hint, value, onChange, limit, multiline = false, rows = 3, issues, tr, type = "text", inputMode }) {
  const trimmedCount = codePointLength(value.trim());
  const describedBy = [hint ? `${id}-hint` : null, limit ? `${id}-count` : null, issues.length ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id, value, className: multiline ? "lc-input lc-input--area" : "lc-input",
    "aria-invalid": issues.length > 0 || undefined, "aria-describedby": describedBy,
    onChange: (event) => onChange(event.target.value),
  };
  return (
    <div className="lc-field">
      <label className="lc-field__label" htmlFor={id}>{label}</label>
      {hint ? <p className="lc-field__hint" id={`${id}-hint`}>{hint}</p> : null}
      {multiline ? <textarea rows={rows} {...common} /> : <input type={type} inputMode={inputMode} {...common} />}
      {limit ? (
        <p className={`lc-field__count${trimmedCount > limit ? " lc-field__count--over" : ""}`} id={`${id}-count`}>
          {tr("editor.count", { count: trimmedCount, limit })}
        </p>
      ) : null}
      {issues.length ? <p className="lc-field__error" id={`${id}-error`}>{issues.map((issue) => issueMessage(tr, issue)).join(" ")}</p> : null}
    </div>
  );
}

function ListField({ idBase, legend, hint, values, onChange, countLimit, entryLimit, entryLabel, removeLabel, addLabel, issues, tr }) {
  const listIssues = issues.filter((issue) => issue.index == null);
  return (
    <fieldset className="lc-field lc-list">
      <legend className="lc-field__label">{legend}</legend>
      <p className="lc-field__hint" id={`${idBase}-hint`}>{hint}</p>
      {values.map((value, index) => {
        const id = `${idBase}-${index}`;
        const rowIssues = issues.filter((issue) => issue.index === index);
        const count = codePointLength(value.trim());
        return (
          <div className="lc-list__row" key={id}>
            <label className="lc-field__label" htmlFor={id}>{entryLabel(index + 1)}</label>
            <div className="lc-list__control">
              <input id={id} className="lc-input" value={value} aria-invalid={rowIssues.length > 0 || undefined}
                aria-describedby={[`${id}-count`, rowIssues.length ? `${id}-error` : null].filter(Boolean).join(" ")}
                onChange={(event) => onChange(values.map((entry, position) => (position === index ? event.target.value : entry)))} />
              <button type="button" className="lc-button lc-button--quiet" aria-label={removeLabel(index + 1)}
                onClick={() => onChange(values.filter((_, position) => position !== index))}>{tr("editor.remove")}</button>
            </div>
            <p className={`lc-field__count${count > entryLimit ? " lc-field__count--over" : ""}`} id={`${id}-count`}>{tr("editor.count", { count, limit: entryLimit })}</p>
            {rowIssues.length ? <p className="lc-field__error" id={`${id}-error`}>{rowIssues.map((issue) => issueMessage(tr, issue)).join(" ")}</p> : null}
          </div>
        );
      })}
      <button type="button" className="lc-button lc-button--quiet" disabled={values.length >= countLimit} onClick={() => onChange([...values, ""])}>{addLabel}</button>
      {listIssues.length ? <p className="lc-field__error">{listIssues.map((issue) => issueMessage(tr, issue)).join(" ")}</p> : null}
    </fieldset>
  );
}

// One item's editor: the bounded form, the member-facing preview, the
// publication controls for the saved revision, and its audited history.
export function LearningEditor({ api, scope, workspaceScope, item, initialKind = "quote", onSaved, onBack, onReload }) {
  const tr = useMemo(() => learningContentCopy(scope.locale), [scope.locale]);
  const [initial] = useState(() => (item ? learningDraftFromItem(item) : emptyLearningDraft({ kind: initialKind, locale: scope.locale })));
  const [saved, setSaved] = useState(item);
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState({ kind: "idle" });
  // The save's own pending mark and lock (#8435). A publication change or a
  // reload resets `status`, so Save's pending state cannot read from it.
  const [saving, setSaving] = useState(false);
  const busyWriteRef = useRef(new Set());
  const [focusRequest, setFocusRequest] = useState(0);
  const formRef = useRef(null);
  const headingId = useId();
  const ids = useId();
  const fieldId = (name) => `${ids}-${name}`;

  const dirty = !learningPayloadsEqual(draft, baseline);
  // The live draft, read when a save answers.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const issues = validateLearningItem(draft, { mode: "save", scope: workspaceScope });
  const shown = attempted ? issues : issues.filter((issue) => LIVE_CODES.has(issue.code));
  const issuesFor = (field) => shown.filter((issue) => issue.field === field);
  const set = (field) => (value) => setDraft((prior) => ({ ...prior, [field]: value }));

  // Leaving with unsaved edits asks first, for in-app navigation and reloads.
  useEffect(() => {
    if (!dirty) return undefined;
    const beforeUnload = (event) => { event.preventDefault(); event.returnValue = ""; };
    const beforeNavigate = (event) => {
      if (!window.confirm(tr("editor.leaveConfirm"))) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("sg:before-navigate", beforeNavigate);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("sg:before-navigate", beforeNavigate);
    };
  }, [dirty, tr]);

  useEffect(() => {
    if (!focusRequest) return;
    formRef.current?.querySelector('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  function adopt(next) {
    const nextDraft = learningDraftFromItem(next);
    setSaved(next);
    setBaseline(nextDraft);
    setDraft(nextDraft);
  }

  // Validation sends nothing and runs without the lock, so a corrected
  // press goes out at once; the lock is taken only when the save starts.
  function save(event) {
    event.preventDefault();
    // The lock is held for exactly as long as `saving` is set, so it alone
    // refuses a press while a save runs.
    return prepareBusyWrite(busyWriteRef, "save", () => {
      if (issues.length) {
        setAttempted(true);
        setStatus({ kind: "invalid" });
        setFocusRequest((value) => value + 1);
        return undefined;
      }
      return saveNow;
    }, event);
  }

  async function saveNow(unlock) {
    const sent = draft;
    setSaving(true);
    setStatus({ kind: "saving" });
    try {
      const next = await api.saveContent({ chapterId: scope.chapterId, scope: workspaceScope, draft: sent, expectedRevision: saved ? saved.revision : null });
      setAttempted(false);
      if (learningPayloadsEqual(draftRef.current, sent)) {
        adopt(next);
        setStatus({ kind: "saved", revision: next.revision });
      } else {
        // Edits made while this save ran are not what it
        // sent. The saved revision becomes the baseline, the newer draft stays
        // and reads unsaved, and the next press of Save sends it. A new item's
        // kept draft takes the id the server assigned (its only server-assigned
        // value), so that press updates the item instead of conflicting; every
        // editable value stays as typed.
        const answered = learningDraftFromItem(next);
        setSaved(next);
        setBaseline(answered);
        setDraft((current) => (current.id === answered.id ? current : { ...current, id: answered.id }));
        setStatus({ kind: "idle" });
      }
      onSaved(next);
    } catch (error) {
      setStatus({ kind: "error", errorKind: learningErrorKind(error) });
    } finally {
      unlock();
      setSaving(false);
    }
  }

  async function reload() {
    if (!saved || !onReload) return;
    if (dirty && !window.confirm(tr("editor.leaveConfirm"))) return;
    try {
      const fresh = await onReload(saved.id);
      if (!fresh) {
        setStatus({ kind: "error", errorKind: "not_found" });
        return;
      }
      adopt(fresh);
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", errorKind: learningErrorKind(error) });
    }
  }

  function back() {
    if (dirty && !window.confirm(tr("editor.leaveConfirm"))) return;
    onBack();
  }

  const heading = saved
    ? tr(saved.kind === "quote" ? "editor.editQuote" : "editor.editLesson")
    : tr(draft.kind === "quote" ? "editor.newQuote" : "editor.newLesson");
  const visibleToMembers = saved && (saved.status === "published" || saved.status === "scheduled");
  const recovered = saved?.provenance && Object.keys(saved.provenance).length > 0;
  const bodyLimit = learningBodyLimit(draft.kind) ?? LEARNING_LIMITS.body.quote;

  return (
    <div className="lc-editor">
      <button type="button" className="learn-back" onClick={back}><span aria-hidden="true">‹</span>{tr("editor.backToList")}</button>
      <div className="lc-editor__head">
        <h2 className="lc-editor__title" id={headingId}>{heading}</h2>
        {saved ? <span className="lc-chip">{tr(`status.${saved.status}`)}</span> : null}
        {saved ? <span className="lc-editor__meta">{tr("items.revision", { revision: saved.revision })}</span> : null}
      </div>
      {recovered ? <p className="lc-notice">{tr("editor.recovered")}</p> : null}
      {recovered ? (
        // Editors only: the recovered original and where it came from, so a
        // reviewer can check source and rights. Delivery never includes it.
        <details className="lc-provenance">
          <summary>{tr("editor.provenance")}</summary>
          <dl className="lc-snapshot">
            {Object.entries(saved.provenance).filter(([, value]) => typeof value === "string" || typeof value === "number").slice(0, 24).map(([key, value]) => (
              <div key={key} className="lc-snapshot__row"><dt><code>{key}</code></dt><dd>{String(value)}</dd></div>
            ))}
          </dl>
        </details>
      ) : null}

      <div className="lc-editor__layout">
        <form className="lc-editor__form" ref={formRef} onSubmit={save} noValidate aria-labelledby={headingId}>
          <fieldset className="lc-group">
            <legend className="lc-group__legend">{tr("editor.contentGroup")}</legend>
            <div className="lc-field">
              <label className="lc-field__label" htmlFor={fieldId("kind")}>{tr("editor.kind")}</label>
              <select id={fieldId("kind")} className="lc-input" value={draft.kind} onChange={(event) => set("kind")(event.target.value)}>
                {LEARNING_KINDS.map((kind) => <option key={kind} value={kind}>{tr(`kind.${kind}`)}</option>)}
              </select>
            </div>
            <TextField id={fieldId("title")} label={tr("editor.title")} value={draft.title} onChange={set("title")} limit={LEARNING_LIMITS.title} issues={issuesFor("title")} tr={tr} />
            <TextField id={fieldId("body")} label={tr(draft.kind === "quote" ? "editor.bodyQuote" : "editor.bodyLesson")} value={draft.body} onChange={set("body")}
              limit={bodyLimit} multiline rows={draft.kind === "quote" ? 4 : 8} issues={issuesFor("body")} tr={tr} />
            <TextField id={fieldId("attribution")} label={tr("editor.attribution")} value={draft.attribution} onChange={set("attribution")} limit={LEARNING_LIMITS.attribution} issues={issuesFor("attribution")} tr={tr} />
            <ListField idBase={fieldId("bullets")} legend={tr("editor.bullets")} hint={tr("editor.bulletsHint", { limit: LEARNING_LIMITS.bulletCount, length: LEARNING_LIMITS.bullet })}
              values={draft.bullets} onChange={set("bullets")} countLimit={LEARNING_LIMITS.bulletCount} entryLimit={LEARNING_LIMITS.bullet}
              entryLabel={(number) => tr("editor.bullet", { number })} removeLabel={(number) => tr("editor.removeBullet", { number })} addLabel={tr("editor.addBullet")}
              issues={issuesFor("bullets")} tr={tr} />
            <TextField id={fieldId("outcome")} label={tr("editor.learningOutcome")} value={draft.learning_outcome} onChange={set("learning_outcome")} limit={LEARNING_LIMITS.learning_outcome} multiline rows={2} issues={issuesFor("learning_outcome")} tr={tr} />
            <ListField idBase={fieldId("topics")} legend={tr("editor.topics")} hint={tr("editor.topicsHint", { limit: LEARNING_LIMITS.topicCount, length: LEARNING_LIMITS.topic })}
              values={draft.topics} onChange={set("topics")} countLimit={LEARNING_LIMITS.topicCount} entryLimit={LEARNING_LIMITS.topic}
              entryLabel={(number) => tr("editor.topic", { number })} removeLabel={(number) => tr("editor.removeTopic", { number })} addLabel={tr("editor.addTopic")}
              issues={issuesFor("topics")} tr={tr} />
          </fieldset>

          <fieldset className="lc-group">
            <legend className="lc-group__legend">{tr("editor.deliveryGroup")}</legend>
            <div className="lc-field">
              <label className="lc-field__label" htmlFor={fieldId("locale")}>{tr("editor.locale")}</label>
              <p className="lc-field__hint" id={`${fieldId("locale")}-hint`}>{tr("editor.localeHint")}</p>
              <select id={fieldId("locale")} className="lc-input" value={draft.locale} aria-describedby={`${fieldId("locale")}-hint`} onChange={(event) => set("locale")(event.target.value)}>
                {LEARNING_LOCALES.map((locale) => <option key={locale} value={locale}>{tr(`locale.${locale}`)}</option>)}
              </select>
            </div>
            <label className="lc-check">
              <input type="checkbox" checked={draft.locale_state === "reviewed"} onChange={(event) => set("locale_state")(event.target.checked ? "reviewed" : "draft")} />
              <span>{tr("editor.localeReviewed")}</span>
            </label>
            <div className="lc-field">
              <label className="lc-field__label" htmlFor={fieldId("audience")}>{tr("editor.audience")}</label>
              <select id={fieldId("audience")} className="lc-input" value={draft.audience} onChange={(event) => set("audience")(event.target.value)}>
                {LEARNING_AUDIENCES.map((audience) => <option key={audience} value={audience}>{tr(`audience.${audience}`)}</option>)}
              </select>
            </div>
            <TextField id={fieldId("tone")} label={tr("editor.tone")} value={draft.tone} onChange={set("tone")} limit={LEARNING_LIMITS.tone} issues={issuesFor("tone")} tr={tr} />
            <TextField id={fieldId("priority")} label={tr("editor.priority")} hint={tr("editor.priorityHint")} value={String(draft.priority)} onChange={set("priority")}
              type="number" inputMode="numeric" issues={issuesFor("priority")} tr={tr} />
            {workspaceScope === "platform" ? (
              <label className="lc-check">
                <input type="checkbox" checked={draft.is_default} onChange={(event) => set("is_default")(event.target.checked)} />
                <span>{tr("editor.isDefault")}</span>
              </label>
            ) : null}
            {issuesFor("is_default").length ? <p className="lc-field__error">{issuesFor("is_default").map((issue) => issueMessage(tr, issue)).join(" ")}</p> : null}
          </fieldset>

          <fieldset className="lc-group">
            <legend className="lc-group__legend">{tr("editor.reviewGroup")}</legend>
            <label className="lc-check">
              <input type="checkbox" checked={draft.factual_claims} aria-describedby={`${fieldId("factual")}-hint`} onChange={(event) => set("factual_claims")(event.target.checked)} />
              <span>{tr("editor.factualClaims")}</span>
            </label>
            <p className="lc-field__hint" id={`${fieldId("factual")}-hint`}>{tr("editor.factualHint")}</p>
            <TextField id={fieldId("source")} label={tr("editor.source")} hint={tr("editor.sourceHint")} value={draft.source} onChange={set("source")} limit={LEARNING_LIMITS.source} multiline rows={2} issues={issuesFor("source")} tr={tr} />
            <TextField id={fieldId("rights")} label={tr("editor.rightsNote")} hint={tr("editor.rightsHint")} value={draft.rights_note} onChange={set("rights_note")} limit={LEARNING_LIMITS.rights_note} multiline rows={2} issues={issuesFor("rights_note")} tr={tr} />
            <TextField id={fieldId("review")} label={tr("editor.reviewNote")} hint={tr("editor.reviewHint")} value={draft.review_note} onChange={set("review_note")} limit={LEARNING_LIMITS.review_note} multiline rows={2} issues={issuesFor("review_note")} tr={tr} />
            <TextField id={fieldId("direction")} label={tr("editor.direction")} hint={tr("editor.directionHint")} value={draft.direction} onChange={set("direction")} limit={LEARNING_LIMITS.direction} multiline rows={2} issues={issuesFor("direction")} tr={tr} />
          </fieldset>

          {issuesFor("payload").length ? <p className="lc-field__error">{issuesFor("payload").map((issue) => issueMessage(tr, issue)).join(" ")}</p> : null}
          {visibleToMembers && dirty ? <p className="lc-notice">{tr("editor.visibleWarning")}</p> : null}
          <div className="lc-actions">
            <BusyButton type="submit" className="lc-button" pending={saving} disabled={!dirty && Boolean(saved)}>
              {saving ? tr("editor.saving") : tr("editor.save")}
            </BusyButton>
            {dirty ? <span className="lc-status">{tr("editor.unsaved")}</span> : null}
          </div>
          {status.kind === "invalid" ? <p className="lc-error" role="alert">{tr("editor.fixErrors")}</p> : null}
          {status.kind === "saved" ? <p className="lc-status" role="status">{tr("editor.saved", { revision: status.revision })}</p> : null}
          {status.kind === "error" ? (
            <div className="lc-error" role="alert">
              <p>{tr(`error.${status.errorKind}`)}</p>
              {status.errorKind === "conflict" && saved ? <button type="button" className="lc-button lc-button--quiet" onClick={reload}>{tr("error.reload")}</button> : null}
            </div>
          ) : null}
        </form>

        <div className="lc-editor__side">
          <LearningPreviewPanel draft={draft} tr={tr} />
          <LearningPublicationPanel api={api} scope={scope} item={saved} dirty={dirty} tr={tr} onReload={reload}
            onChanged={(next) => { setSaved(next); setBaseline(learningDraftFromItem(next)); setStatus({ kind: "idle" }); onSaved(next); }} />
          <LearningHistoryPanel api={api} scope={scope} item={saved} tr={tr}
            onCopy={(snapshot) => setDraft(learningDraftFromSnapshot(snapshot, saved))} />
        </div>
      </div>
    </div>
  );
}
