import { useCallback, useEffect, useRef, useState } from "react";
import { useTransitionPresence } from "./useTransitionPresence.js";

// A detail surface is a full-context workspace: task details, case details,
// appointment flows, profile editing, and workstream management. Keep its
// lifecycle separate from quick popovers and confirmations so every detailed
// view can share the same deliberate exit without slowing small controls.
// The exit is the prototype modal's (an owner decision, core.js
// UG.modal): the scrim fades for 200 ms and the layer goes when it ends.
export const DETAIL_SURFACE_EXIT_MS = 200;

/** Retain an internally controlled detail surface until its exit completes. */
export function useDetailSurfaceClose(onClose, { blocked = false } = {}) {
  const [open, setOpen] = useState(true);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const presence = useTransitionPresence(open, {
    exitMs: DETAIL_SURFACE_EXIT_MS,
    onExited: () => onCloseRef.current?.(),
  });

  const requestClose = useCallback(() => {
    if (!blocked) setOpen(false);
  }, [blocked]);

  return { ...presence, requestClose };
}
