import { useEffect, useId, useMemo, useRef, useState } from "react";
import { learningContentCopy } from "../../lib/i18n/learningContent.js";
import { LEARNING_MAX_OFFSET, LEARNING_PAGE_SIZE, learningErrorKind } from "./model.js";

const EMPTY = Object.freeze([]);

// The items a manager may pick for a selection, from list_learning_choices:
// reviewed, published or scheduled rows of the platform library (including
// non-default ones), the organization and, for a chapter, that chapter. 40 per
// page. Checking a row only edits the unsaved selection.
export function LearningChoicePicker({ api, chapterId, scopeName, locale, selected, onToggle, reloadKey = 0 }) {
  const tr = useMemo(() => learningContentCopy(locale), [locale]);
  const titleId = useId();
  const key = `${scopeName}|${reloadKey}`;
  const [state, setState] = useState({ key: null });
  const sequence = useRef(0);

  useEffect(() => {
    const token = ++sequence.current;
    api.listChoices({ chapterId, scope: scopeName, offset: 0 })
      .then((page) => {
        if (token === sequence.current) setState({ key, status: "ready", items: page.items, hasMore: page.hasMore, nextOffset: LEARNING_PAGE_SIZE.workspace, loadingMore: false, moreError: null });
      })
      .catch((error) => {
        if (token === sequence.current) setState({ key, status: "error", error: learningErrorKind(error), items: EMPTY, hasMore: false, nextOffset: 0 });
      });
    return () => {
      sequence.current += 1;
    };
  }, [api, chapterId, scopeName, key]);

  const current = state.key === key ? state : null;

  function loadMore() {
    if (!current || current.loadingMore || !current.hasMore || current.nextOffset > LEARNING_MAX_OFFSET) return;
    const token = sequence.current;
    const offset = current.nextOffset;
    setState((prior) => ({ ...prior, loadingMore: true, moreError: null }));
    api.listChoices({ chapterId, scope: scopeName, offset })
      .then((page) => {
        if (token !== sequence.current) return;
        setState((prior) => {
          const seen = new Set(prior.items.map((item) => item.id));
          return { ...prior, items: [...prior.items, ...page.items.filter((item) => !seen.has(item.id))], hasMore: page.hasMore, nextOffset: offset + LEARNING_PAGE_SIZE.workspace, loadingMore: false };
        });
      })
      .catch((error) => {
        if (token === sequence.current) setState((prior) => ({ ...prior, loadingMore: false, moreError: learningErrorKind(error) }));
      });
  }

  const loadedIds = new Set((current?.items || EMPTY).map((item) => item.id));
  const elsewhere = current?.status === "ready" ? selected.filter((id) => !loadedIds.has(id)).length : 0;
  const meta = (item) => [tr(`kind.${item.kind}`), tr(`locale.${item.locale}`), tr(`scope.${item.scope}`), item.is_default ? tr("items.default") : null]
    .filter(Boolean).join(" · ");

  return (
    <div className="lc-choices" role="group" aria-labelledby={titleId}>
      <p className="lc-field__label" id={titleId}>{tr("settings.choicesTitle")}</p>
      <p className="lc-hint">{tr("settings.choicesHint")}</p>
      {!current ? <p className="lc-status" role="status">{tr("manage.loading")}</p> : null}
      {current?.status === "error" ? <p className="lc-error" role="alert">{tr(`error.${current.error}`)}</p> : null}
      {current?.status === "ready" && current.items.length === 0 ? <p className="lc-status">{tr("settings.choicesEmpty")}</p> : null}
      {current?.items.length ? (
        <ul className="lc-choices__list">
          {current.items.map((item) => (
            <li key={item.id}>
              <label className="lc-check lc-choice">
                <input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => onToggle(item.id, event.target.checked)} />
                <span className="lc-choice__copy">
                  <span className="lc-choice__title">{item.title}</span>
                  <span className="lc-choice__meta">{meta(item)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {elsewhere > 0 ? <p className="lc-hint">{tr("settings.selectedElsewhere", { count: elsewhere })}</p> : null}
      {current?.hasMore ? (
        <button type="button" className="lc-button lc-button--quiet" disabled={current.loadingMore} onClick={loadMore}>{tr("settings.choicesMore")}</button>
      ) : null}
      {current?.moreError ? <p className="lc-error" role="alert">{tr(`error.${current.moreError}`)}</p> : null}
    </div>
  );
}
