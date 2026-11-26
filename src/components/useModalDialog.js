import { useEffect, useRef } from "react";

const dialogFocusable = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

// Mark everything that is not the open overlay inert and hidden from assistive
// tech, walking up to <body> so ancestors' siblings are covered too. Returns
// the exact undo, because a caller that only remembers "I set inert" would
// clear an inert attribute a nested overlay had set for its own reasons.
function inertBackground(dialog) {
  const changed = [];
  let current = dialog;
  while (current?.parentElement) {
    const parent = current.parentElement;
    for (const sibling of parent.children) {
      if (sibling === current) continue;
      changed.push({
        element: sibling,
        inert: sibling.hasAttribute("inert"),
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    if (parent === document.body) break;
    current = parent;
  }
  return () => {
    for (const { element, inert, ariaHidden } of changed) {
      if (!inert) element.removeAttribute("inert");
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
    }
  };
}

// The modal contract every overlay in this app owes its user, in one place.
//
// `Dialog` (Dialogs.jsx) has honoured all five parts since it shipped — initial
// focus, Escape, a Tab trap, an inert and scroll-locked background, and focus
// restored to the opener — while the three overlays in FloatingControls.jsx
// announced themselves as `aria-modal` dialogs and implemented none of them. A
// screen-reader user opening Compass heard "dialog" and then tabbed straight
// out into the still-live page behind it. Sharing the behaviour is the only way
// the two surfaces stay in agreement as either one changes.
//
// `modal: false` is for panels that genuinely do not cover the page: the
// preview guide floats above it and the guided tour deliberately drives the
// view underneath. Those keep Escape, initial focus and focus restore, and skip
// the trap, the inert background and the scroll lock — trapping Tab inside a
// panel the user can still see past is its own accessibility bug, and those
// panels drop `aria-modal` to match what they actually do.
export function useModalDialog(dialogRef, { onClose, restoreFocusRef, closeLockedRef, modal = true } = {}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const opener = document.activeElement;
    const restoreBackground = modal ? inertBackground(dialog) : null;
    const priorHtmlOverflow = document.documentElement.style.overflow;
    const priorBodyOverflow = document.body.style.overflow;
    if (modal) {
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
    }
    dialog.focus({ preventScroll: true });

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closeLockedRef?.current) closeRef.current?.();
        return;
      }
      if (!modal || event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll(dialogFocusable))
        .filter((element) => (
          element.tabIndex >= 0
          && !element.matches(":disabled")
          && element.getAttribute("aria-hidden") !== "true"
        ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      const activeIsFocusable = focusable.includes(active);
      if (event.shiftKey && (active === first || !activeIsFocusable)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !activeIsFocusable)) {
        event.preventDefault();
        first.focus();
      }
    }

    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      restoreBackground?.();
      if (modal) {
        document.documentElement.style.overflow = priorHtmlOverflow;
        document.body.style.overflow = priorBodyOverflow;
      }
      // The opener is the honest restore target, but it can be gone by now (a
      // sign-out replaced the tree). restoreFocusRef is the caller's stated
      // second choice; focusing a detached node would silently drop focus to
      // <body> and lose the keyboard user's place entirely.
      const restoreTarget = opener?.isConnected ? opener : restoreFocusRef?.current;
      if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
    };
  }, [dialogRef, modal, restoreFocusRef, closeLockedRef]);
}
