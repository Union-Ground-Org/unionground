import { useLayoutEffect, useRef } from "react";
import { countKey } from "../../lib/i18n.js";

// The earlier-history controls a web thread shows when the member load cut
// its older rows off: a channel thread (ProductHubView.jsx, #8078) and a
// private conversation (MessagesView.jsx, #9526). The rows and the reads are
// features/messaging/earlierHistory.js; this is what the reader sees.

// The earlier-history rows order by (createdAt, id); a loaded row carries created_at.
export function withCreatedAt(row) {
  return row.createdAt ? row : { ...row, createdAt: row.created_at };
}

function scrollParent(node) {
  for (let element = node?.parentElement; element; element = element.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element;
  }
  return typeof document === "undefined" ? null : document.scrollingElement ?? document.documentElement;
}

// Opening earlier messages adds rows above the reader: the scroll position moves
// by the added height so the post on screen stays put. It follows the loading
// state's own height changes too, until the layout after the read (rows, an
// empty page or the failure). A new latest post is not above the reader and
// ends it. The native screens' anchor (apps/mobile/src/features/prependAnchor.ts).
export function usePrependAnchor(listRef, shownPosts, history) {
  const anchor = useRef(null);
  const newest = shownPosts[shownPosts.length - 1]?.id ?? null;
  useLayoutEffect(() => {
    const current = anchor.current;
    if (!current) return;
    if (newest !== current.newest) { anchor.current = null; return; }
    const height = current.scroller.scrollHeight;
    if (height !== current.height) current.scroller.scrollTop = Math.max(0, current.top + height - current.height);
    anchor.current = history.status === "loading" ? { ...current, top: current.scroller.scrollTop, height } : null;
  });
  return () => {
    const scroller = scrollParent(listRef.current);
    anchor.current = scroller ? { scroller, top: scroller.scrollTop, height: scroller.scrollHeight, newest } : null;
    history.loadEarlier();
  };
}

// The top of a thread whose messages the member load cut off: earlier ones to
// open, the loading and failure states, or the start of the thread. The
// button keeps one place through its busy state, so focus stays on it.
export function EarlierThreadHistory({ t, history, onShowEarlier }) {
  const { status, hasEarlier, started, lastLoaded } = history;
  return <div className="thread-history">
    {status === "error" && <p className="hub2-panel-head__sub" role="alert">{t("threadHistory.failed")}</p>}
    {hasEarlier
      ? <button type="button" className="hub2-btn hub2-btn--ghost" aria-busy={status === "loading" ? "true" : undefined} onClick={onShowEarlier}>
        {t(status === "error" ? "threadHistory.tryAgain" : status === "loading" ? "threadHistory.loadingEarlier" : "threadHistory.showEarlier")}
      </button>
      : <p className="hub2-panel-head__sub">{t("threadHistory.start")}</p>}
    {started && status === "idle" && lastLoaded > 0 && <p className="hub2-panel-head__sub" role="status">{t(countKey("threadHistory.loaded", lastLoaded), { count: lastLoaded })}</p>}
  </div>;
}
