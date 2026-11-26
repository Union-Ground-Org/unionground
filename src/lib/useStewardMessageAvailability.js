// BUG-UG-HOME-GUIDE-NAMES-PAUSED-STEWARD-20261103 (#6876): whether
// anyone could read this member's Chapter steward message. false when the
// chapter's stewards are all paused or absent, so Home names no steward and
// Messages warns before the member writes; null is unknown.
//
// - The answer belongs to one member in one chapter of one organization. A
//   chapter switch replaces the chapter's data without remounting the app, so
//   a change of scope clears the answer at once and drops a read still
//   running for the old scope.
// - It is read only while something needs it (the guide could name a steward,
//   or Messages is open), so it never joins the cold boot's reads.
// - Within a scope it is read again when member data refreshes (focus,
//   reconnect, the 30-second reconcile) once the refresh window has passed,
//   and at once when the session's token changes (aal1 to aal2 issues a new
//   one). Opening Messages again does not re-read on its own.
// - The last settled answer stays while a re-read runs. A failed read keeps
//   it too and settles nothing, so a later refresh retries.
import { useEffect, useRef, useState } from "react";

export const STEWARD_AVAILABILITY_REFRESH_MS = 30_000;

export function useStewardMessageAvailability({
  skip = false,
  needed = true,
  sessionUserId = null,
  memberId = null,
  chapterId = null,
  organizationId = null,
  refreshKey = 0,
  assuranceKey = null,
  read,
  capture,
  now = () => Date.now(),
}) {
  const scope = skip || !sessionUserId || memberId !== sessionUserId ? null : `${sessionUserId}|${chapterId}|${organizationId}`;
  const [settled, setSettled] = useState({ scope: null, value: null });
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const lastRef = useRef({ scope: null, at: -Infinity, assurance: null, refreshKey: null });
  const inFlightRef = useRef(null);

  useEffect(() => {
    if (!scope || !needed || inFlightRef.current === scope) return;
    const last = lastRef.current;
    const due = last.scope !== scope
      || last.assurance !== assuranceKey
      || (last.refreshKey !== refreshKey && now() - last.at >= STEWARD_AVAILABILITY_REFRESH_MS);
    if (!due) return;
    // Recorded at the start, so a failed read waits for the window like any other.
    lastRef.current = { scope, at: now(), assurance: assuranceKey, refreshKey };
    inFlightRef.current = scope;
    const operation = capture(sessionUserId);
    const release = () => { if (inFlightRef.current === scope) inFlightRef.current = null; };
    void Promise.resolve(operation.run(() => read())).then((answer) => {
      release();
      if (scopeRef.current !== scope || !operation.isCurrent() || typeof answer !== "boolean") return;
      setSettled({ scope, value: answer });
    }, release);
  }, [scope, needed, refreshKey, assuranceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return settled.scope === scope ? settled.value : null;
}
