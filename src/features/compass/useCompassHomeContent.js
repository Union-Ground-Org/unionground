import { useCallback, useEffect, useRef, useState } from "react";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { loadCompassNudges, loadCompassPinnedAnswers } from "./actionOffers.js";

// Scope includes the authenticated session and loaded member context. A late
// response from an earlier identity must never populate the current Home.
export function useCompassHomeContent({ client, scopeKey, offersOn, nudgesOn }) {
  const scope = useRef(scopeKey);
  scope.current = scopeKey;
  const pinRequest = useRef(0);
  const [savedPins, setSavedPins] = useState({ scopeKey: null, pins: [], failed: false });
  const [savedNudges, setSavedNudges] = useState({ scopeKey: null, nudges: { staff: [], member: [] } });
  const refreshPins = useCallback(async () => {
    const request = ++pinRequest.current;
    if (!scopeKey || !offersOn) return;
    let pins = [];
    let failed = false;
    try { pins = await withLoadDeadline(loadCompassPinnedAnswers(client)); } catch { failed = true; }
    if (scope.current === scopeKey && request === pinRequest.current) setSavedPins({ scopeKey, pins, failed });
  }, [client, scopeKey, offersOn]);
  useEffect(() => {
    void refreshPins();
    return () => { pinRequest.current += 1; };
  }, [refreshPins]);
  useEffect(() => {
    let live = true;
    if (!scopeKey || !nudgesOn) return undefined;
    loadCompassNudges(client)
      .then((nudges) => { if (live && scope.current === scopeKey) setSavedNudges({ scopeKey, nudges }); })
      .catch(() => { if (live && scope.current === scopeKey) setSavedNudges({ scopeKey, nudges: { staff: [], member: [] } }); });
    return () => { live = false; };
  }, [client, scopeKey, nudgesOn]);
  const pinsCurrent = Boolean(scopeKey && offersOn && savedPins.scopeKey === scopeKey);
  return {
    pins: pinsCurrent ? savedPins.pins : [],
    pinsFailed: pinsCurrent && savedPins.failed,
    nudges: scopeKey && nudgesOn && savedNudges.scopeKey === scopeKey ? savedNudges.nudges : { staff: [], member: [] },
    refreshPins,
  };
}
