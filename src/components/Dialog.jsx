import { X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { useDetailSurfaceClose } from "../lib/useDetailSurface.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { registerEscapeLayer } from "../lib/escapeLayers.js";
import "./Dialog.css";

// `size`: "default" (480px), "wide" (620px) for short forms and confirmations,
// or "detail" for a record a person works in (a case, a form review, a
// private conversation): a full-height sheet on a phone and a page-sized
// surface over the content column on desktop. `wide` stays as the old spelling.
export function Dialog({ eyebrow, title, onClose, beforeClose = null, closeBlocked, closeOperationKey, children, wide = false, size = wide ? "wide" : "default", returnFocusRef: explicitReturnFocusRef, bodyLabel, bodyRef }) {
  const { t } = useLang();
  const backdropRef = useRef(null);
  const surfaceRef = useRef(null);
  const headingRef = useRef(null);
  const closeRef = useRef(null);
  // In both shells the dialog behaves as the prototype's modal: it opens on
  // its [autofocus] field or its close button, and keeps focus inside while
  // its scrim fades out, then hands it back to the opener.
  const returnFocusRef = useRef(typeof document === "undefined" ? null : document.activeElement);
  const headingId = useId();
  const closeStatusId = `${headingId}-close-status`;
  const closeGuardPendingRef = useRef(null);
  const [closeFeedback, setCloseFeedback] = useState(null);
  const vetoCleared = closeBlocked === false && closeFeedback === "dialogs.closeBlocked";
  const closeStatus = vetoCleared ? null : closeFeedback;
  const { mounted, phase, closing, onTransitionEnd, requestClose: requestSurfaceClose } = useDetailSurfaceClose(onClose);
  useModalIsolation(backdropRef, { active: mounted });

  useLayoutEffect(() => {
    closeGuardPendingRef.current = null;
    setCloseFeedback(null);
  }, [closeOperationKey]);
  useEffect(() => {
    if (vetoCleared) setCloseFeedback(null);
  }, [vetoCleared]);

  const requestClose = useCallback(() => {
    if (!beforeClose) {
      requestSurfaceClose();
      return;
    }
    if (closeGuardPendingRef.current) return;
    const check = {};
    closeGuardPendingRef.current = check;
    setCloseFeedback("dialogs.closeChecking");
    Promise.resolve()
      .then(() => beforeClose())
      .then((allowed) => {
        if (closeGuardPendingRef.current !== check) return;
        closeGuardPendingRef.current = null;
        if (allowed === false) {
          setCloseFeedback("dialogs.closeBlocked");
          return;
        }
        setCloseFeedback(null);
        try {
          requestSurfaceClose();
        } catch {
          setCloseFeedback("dialogs.closeFailed");
        }
      }, () => {
        if (closeGuardPendingRef.current !== check) return;
        closeGuardPendingRef.current = null;
        setCloseFeedback("dialogs.closeCheckFailed");
      });
  }, [beforeClose, requestSurfaceClose]);

  useEffect(() => {
    if (!mounted || closing) return;
    if (surfaceRef.current?.contains(document.activeElement)) return;
    (surfaceRef.current?.querySelector("[autofocus]") ?? closeRef.current)?.focus();
  }, [closing, mounted]);

  // Focus goes back to the opener as soon as the commit that removes the
  // dialog is complete: a microtask queued from the layout cleanup runs before
  // any later task, where a test resuming from a DOM observer or the page's own
  // next handler could otherwise find it on the body
  // (OPS-UG-ROOT-SHARD-FLAKES-ON-DEPOT-20261031). Not in the layout
  // cleanup itself: that runs before the commit has updated the rest of the
  // page, while an opener disabled by a pending save cannot take focus. The
  // passive cleanup still runs it, unchanged, for callers that flush effects.
  const restoreReturnFocus = useCallback(() => {
    const target = explicitReturnFocusRef?.current || returnFocusRef.current;
    if (target?.isConnected && typeof target.focus === "function") target.focus();
  }, [explicitReturnFocusRef]);
  useLayoutEffect(() => () => { queueMicrotask(restoreReturnFocus); }, [restoreReturnFocus]);
  useEffect(() => () => { restoreReturnFocus(); }, [restoreReturnFocus]);

  // The shared Escape stack arbitrates between overlapping layers: a dialog
  // is modal, so it alone answers Escape even when a non-modal layer (the
  // rail-shell Compass panel) sits beneath it. Mid-close the dialog declines
  // the key — exactly what the old bespoke listener did by not preventing.
  // The layer reads `closing` and `requestClose` through refs and registers
  // once per mount: an inline `beforeClose` (AdminView's MFA confirmation)
  // gives `requestClose` a new identity on every parent render, and
  // re-registering would move this dialog above a palette opened after it.
  const closingRef = useRef(closing);
  closingRef.current = closing;
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!mounted) return undefined;
    return registerEscapeLayer(() => {
      if (closingRef.current) return false;
      requestCloseRef.current();
      return undefined;
    }, { modal: true });
  }, [mounted]);

  if (!mounted) return null;

  function trapFocus(event) {
    if (event.key !== "Tab" || closing) return;
    const focusable = [...(surfaceRef.current?.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
    ) || [])].filter((element) => !element.hasAttribute("inert") && element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      headingRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (
      document.activeElement === first
      || document.activeElement === headingRef.current
      || !surfaceRef.current?.contains(document.activeElement)
    )) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !surfaceRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  // While the close fade runs the dialog keeps focus (as the reference does)
  // but nothing inside it may act: a click, a press, a submit or a key that
  // would activate a control (Enter, Space) is swallowed before it reaches a
  // child, so a choice cannot be made after the dialog was dismissed.
  function holdWhileClosing(event) {
    if (!closing) return;
    // Keys other than the activation keys (Tab, Escape for the layer below)
    // pass through.
    if (event.type.startsWith("key") && event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div
      ref={backdropRef}
      className={`dialog-backdrop sg-detail-layer ${size === "detail" ? "dialog-backdrop--detail" : ""}`}
      role="presentation"
      data-state={phase}
      onTransitionEnd={onTransitionEnd}
      onMouseDown={(event) => event.target === event.currentTarget && !closing && requestClose()}
    >
      <section ref={surfaceRef} className={`app-dialog sg-detail-surface ${size === "wide" ? "app-dialog--wide" : size === "detail" ? "app-dialog--detail" : ""}${beforeClose && closeStatus ? " app-dialog--close-feedback" : ""}`} role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={trapFocus} onClickCapture={holdWhileClosing} onPointerDownCapture={holdWhileClosing} onMouseDownCapture={holdWhileClosing} onKeyDownCapture={holdWhileClosing} onKeyUpCapture={holdWhileClosing} onSubmitCapture={holdWhileClosing}>
        <header>
          <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 ref={headingRef} id={headingId} tabIndex={-1}>{title}</h2></div>
          <button ref={closeRef} type="button" aria-label={t("dialogs.close")} aria-describedby={beforeClose && closeStatus ? closeStatusId : undefined} onClick={requestClose}><X size={20} /></button>
        </header>
        {beforeClose && <p id={closeStatusId} className="app-dialog__close-status" aria-live="polite" aria-atomic="true">{closeStatus ? t(closeStatus) : ""}</p>}
        <div ref={bodyRef} className="app-dialog__body" role={bodyLabel ? "region" : undefined} aria-label={bodyLabel} tabIndex={bodyLabel ? 0 : undefined}>{children}</div>
      </section>
    </div>
  );
}
