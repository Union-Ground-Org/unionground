import { useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "./Button.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import "./pager.css";

/** Page mode for bounded lists, or more mode for keyset queues.
 *  `busy`: a fresh first page is loading. The pager stays mounted, its polite
 *  count says it is loading (no stale total) and then announces the new count,
 *  and its controls stay focusable but unavailable (aria-disabled), so a
 *  keyboard user's focus is never dropped (G9-8033 r2 finding). */
export function Pager({ total = 0, shown, page = 1, pageSize = 25, onPageChange, onShowMore, loading = false, busy = false, moreError = false, error = false, onRetry, labels = {}, className = "", onFocusWithinChange }) {
  const { t } = useLang();
  const focusNext = useRef(false);
  const nextRef = useRef(null);
  const previousRef = useRef(null);
  const moreRef = useRef(null);
  const countRef = useRef(null);
  const navRef = useRef(null);
  const retryRef = useRef(null);
  // The pager control that last held focus. When a render removes it while it
  // still had focus (Try again giving way to the loading count, a Load more
  // that is no longer needed), focus moves to the count instead of the body.
  const lastFocused = useRef(null);
  const count = shown ?? Math.min(total, page * pageSize);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const firstNumber = Math.max(1, Math.min(page - 2, pages - 4));
  const pageNumbers = Array.from({ length: Math.min(5, pages) }, (_, index) => firstNumber + index);
  const first = total === 0 ? 0 : onShowMore ? 1 : Math.min(total, (page - 1) * pageSize + 1);
  const last = onShowMore ? count : Math.min(total, page * pageSize);
  useEffect(() => {
    const cancelMovedFocus = (event) => {
      if (focusNext.current && event.target !== focusNext.current.initiator) focusNext.current = false;
    };
    document.addEventListener("focusin", cancelMovedFocus);
    return () => document.removeEventListener("focusin", cancelMovedFocus);
  }, []);
  useLayoutEffect(() => {
    const pending = focusNext.current;
    if (!pending) return;
    focusNext.current = false;
    const active = document.activeElement;
    // A removed/disabled initiator can leave focus on the document. A user
    // moving to another control cancels restoration, even if they then blur it.
    if (active !== pending.initiator && !(active === document.body && (!pending.initiator.isConnected || pending.initiator.disabled))) return;
    let target;
    if (pending.control === "more") target = moreRef.current || countRef.current;
    else if (pending.control === "previous") target = previousRef.current?.disabled ? nextRef.current : previousRef.current;
    else if (pending.control === "number") target = navRef.current?.querySelector(".sg-pager__number[aria-current=page]");
    else target = nextRef.current?.disabled ? previousRef.current : nextRef.current;
    target?.focus();
  }, [page, count]);
  useLayoutEffect(() => {
    const last = lastFocused.current;
    if (!last || last.isConnected) return;
    lastFocused.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (countRef.current || retryRef.current)?.focus();
  });
  const change = (target, control, event) => { focusNext.current = { control, initiator: event.currentTarget }; onPageChange?.(target); };
  // While busy, a control is announced unavailable but stays focusable:
  // `disabled` on the focused button would send focus to the document. Its
  // aria-disabled makes the pending button refuse every press, so Load more's
  // handler needs no busy check of its own.
  const busyControl = busy ? { "aria-disabled": "true", "aria-busy": "true" } : {};
  return <nav ref={navRef} className={`sg-pager ${className}`.trim()} data-busy={busy || undefined} aria-label={labels.navigation || t("pager.navigation")}
    onFocus={(event) => { if (event.target !== countRef.current) lastFocused.current = event.target; onFocusWithinChange?.(true); }}
    onBlur={(event) => {
      // Only a move to another element ends ownership; a removed control
      // blurs with no related target and is answered by the effect above.
      if (!event.relatedTarget || event.currentTarget.contains(event.relatedTarget)) return;
      lastFocused.current = null;
      onFocusWithinChange?.(false);
    }}>
    {error && <p role="alert" className="sg-pager__error">{labels.error || t("pager.loadFailed")} {onRetry && <Button ref={retryRef} variant="secondary" size="small" onClick={onRetry}>{labels.retry || t("app.tryAgain")}</Button>}</p>}
    {!error && <>
      <span ref={countRef} tabIndex={-1} className="sg-pager__count" aria-live="polite">{busy ? labels.busy || t("pager.loading") : labels.showing ? labels.showing({ first, last, total, shown: count }) : t("pager.showing", { first, last, total })}</span>
      {moreError && !busy && <span role="alert" className="sg-pager__error">{labels.error || t("pager.loadMoreFailed")}</span>}
      {onShowMore ? (count < total && <Button ref={moreRef} variant="secondary" size="small" pending={loading && !busy} {...busyControl} onClick={(event) => { focusNext.current = { control: "more", initiator: event.currentTarget }; onShowMore(); }}>{loading ? labels.loading || t("steward.loadingMore") : moreError ? labels.retry || t("app.tryAgain") : labels.more || t("pager.showMore")}</Button>) : onPageChange && pages > 1 && <div className="sg-pager__controls">
        <Button ref={previousRef} variant="secondary" size="small" disabled={page <= 1} onClick={(event) => change(page - 1, "previous", event)}>{labels.previous || t("workspace.previous")}</Button>
        <span className="sg-pager__numbers" aria-label={labels.pages || t("workspace.pages")}>{pageNumbers.map((number) => <button key={number} type="button" className="sg-pager__number" aria-label={labels.pageNumber ? labels.pageNumber(number) : t("pager.page", { number })} aria-current={number === page ? "page" : undefined} onClick={(event) => change(number, "number", event)}>{number}</button>)}</span>
        <Button ref={nextRef} variant="secondary" size="small" disabled={page >= pages} onClick={(event) => change(page + 1, "next", event)}>{labels.next || t("workspace.next")}</Button>
      </div>}
      {!onShowMore && !onPageChange && count < total && onRetry && <Button variant="secondary" size="small" {...busyControl} onClick={() => { if (!busy) onRetry(); }}>{labels.refresh || labels.retry || t("app.tryAgain")}</Button>}
    </>}
  </nav>;
}
