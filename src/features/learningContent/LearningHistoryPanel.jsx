import { useEffect, useId, useRef, useState } from "react";
import { LEARNING_HISTORY_ACTIONS, LEARNING_PAGE_SIZE, learningErrorKind } from "./model.js";
import { formatLearningInstant } from "./time.js";

const EMPTY = Object.freeze([]);
const SNAPSHOT_FIELDS = [
  ["title", "editor.title"], ["body", "editor.bodyLesson"], ["attribution", "editor.attribution"],
  ["source", "editor.source"], ["rights_note", "editor.rightsNote"], ["review_note", "editor.reviewNote"],
  ["learning_outcome", "editor.learningOutcome"], ["direction", "editor.direction"],
];

function SnapshotView({ snapshot, tr }) {
  const text = (value) => (typeof value === "string" ? value : "");
  const list = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
  const rows = [
    ...(typeof snapshot.kind === "string" ? [[tr("editor.kind"), tr(`kind.${snapshot.kind}`)]] : []),
    ...(typeof snapshot.status === "string" ? [[tr("publish.title"), tr(`status.${snapshot.status}`)]] : []),
    ...(typeof snapshot.locale === "string" ? [[tr("editor.locale"), tr(`locale.${snapshot.locale}`)]] : []),
    ...SNAPSHOT_FIELDS.filter(([field]) => text(snapshot[field])).map(([field, label]) => [tr(label), text(snapshot[field])]),
    ...(list(snapshot.bullets).length ? [[tr("editor.bullets"), list(snapshot.bullets).join(" · ")]] : []),
    ...(list(snapshot.topics).length ? [[tr("editor.topics"), list(snapshot.topics).join(" · ")]] : []),
  ];
  return (
    <dl className="lc-snapshot">
      {rows.map(([label, value]) => (
        <div key={label} className="lc-snapshot__row"><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

// The audited revisions of one item, 40 at a time, newest first. A version
// can be copied back into the editor; saving it is a new, audited revision.
export function LearningHistoryPanel({ api, scope, item, tr, onCopy }) {
  const titleId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ key: null, status: "idle", entries: EMPTY, hasMore: false, nextOffset: 0, loadingMore: false, error: null });
  const [copied, setCopied] = useState(false);
  const sequence = useRef(0);
  const key = open && item ? `${item.id}|${item.revision}` : null;

  useEffect(() => {
    if (!key) return undefined;
    const token = ++sequence.current;
    api.getHistory({ chapterId: scope.chapterId, id: item.id, offset: 0 })
      .then((page) => {
        if (token === sequence.current) setState({ key, status: "ready", entries: page.items, hasMore: page.hasMore, nextOffset: LEARNING_PAGE_SIZE.history, loadingMore: false, error: null });
      })
      .catch((error) => {
        if (token === sequence.current) setState({ key, status: "error", entries: EMPTY, hasMore: false, nextOffset: 0, loadingMore: false, error: learningErrorKind(error) });
      });
    return () => {
      sequence.current += 1;
    };
  }, [api, key, item?.id, scope.chapterId]);

  if (!item) return null;
  const current = state.key === key ? state : null;

  function loadMore() {
    if (!current || current.loadingMore) return;
    const token = sequence.current;
    const offset = current.nextOffset;
    setState((prior) => ({ ...prior, loadingMore: true }));
    api.getHistory({ chapterId: scope.chapterId, id: item.id, offset })
      .then((page) => {
        if (token !== sequence.current) return;
        setState((prior) => ({ ...prior, entries: [...prior.entries, ...page.items], hasMore: page.hasMore, nextOffset: offset + LEARNING_PAGE_SIZE.history, loadingMore: false }));
      })
      .catch((error) => {
        if (token === sequence.current) setState((prior) => ({ ...prior, loadingMore: false, error: learningErrorKind(error) }));
      });
  }

  const actionLabel = (action) => tr(LEARNING_HISTORY_ACTIONS.includes(action) ? `history.action_${action}` : "history.action_other");
  const author = (changedBy) => {
    if (!changedBy) return tr("history.byRemoved");
    return changedBy === scope.userId ? tr("history.byYou") : tr("history.byOther");
  };

  return (
    <section className="lc-panel" aria-labelledby={titleId}>
      <h3 className="lc-panel__title" id={titleId}>{tr("history.title")}</h3>
      <button type="button" className="lc-button lc-button--quiet" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        {open ? tr("history.hide") : tr("history.show")}
      </button>
      {copied ? <p className="lc-status" role="status">{tr("history.copied")}</p> : null}
      {open ? (
        <div id={listId}>
          {!current ? <p className="lc-status" role="status">{tr("history.loading")}</p> : null}
          {current?.status === "error" && current.entries.length === 0 ? <p className="lc-error" role="alert">{tr(`error.${current.error}`)}</p> : null}
          {current?.status === "ready" && current.entries.length === 0 ? <p className="lc-status">{tr("history.empty")}</p> : null}
          {current?.entries.length ? (
            <ol className="lc-history">
              {current.entries.map((entry) => (
                <li key={`${entry.revision}-${entry.action}-${entry.changedAt}`} className="lc-history__entry">
                  <p className="lc-history__line">
                    <strong>{tr("history.entry", { revision: entry.revision, action: actionLabel(entry.action) })}</strong>
                    {" · "}<time dateTime={entry.changedAt}>{formatLearningInstant(entry.changedAt, scope.locale)}</time>
                    {" · "}<span>{author(entry.changedBy)}</span>
                  </p>
                  {entry.snapshot ? (
                    <details className="lc-history__details">
                      <summary>{tr("history.view")}</summary>
                      <SnapshotView snapshot={entry.snapshot} tr={tr} />
                      <button type="button" className="lc-button lc-button--quiet" onClick={() => { onCopy(entry.snapshot); setCopied(true); }}>{tr("history.copy")}</button>
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          {current?.hasMore ? (
            <button type="button" className="lc-button lc-button--quiet" disabled={current.loadingMore} onClick={loadMore}>{tr("history.loadMore")}</button>
          ) : null}
          {current?.status === "ready" && current.error ? <p className="lc-error" role="alert">{tr(`error.${current.error}`)}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
