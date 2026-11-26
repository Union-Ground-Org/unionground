import { useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite, useBusyScope } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";

// REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001: a new event prepares a DRAFT
// announcement (old de7df4b57c^:lib/handoffs/event-handoffs.ts). Nothing is
// sent until a steward uses a draft in the composer and publishes it through
// the existing broadcast authority, or dismisses it. The server decides who
// may see and resolve drafts (the event chapter's stewards).
export function AnnouncementDrafts({ api, onUse, refreshKey = 0, busy = false }) {
  const { t } = useLang();
  const { generation, isCurrent } = useBusyScope(api);
  const [state, setState] = useState(null);
  const [reload, setReload] = useState(0);
  // Record 8435: each draft's dismissal has its own lock and its own pending
  // mark, and a settling dismissal clears only its own, so one draft's answer
  // never shows another draft ready while that draft's lock still holds.
  const [dismissing, setDismissing] = useState(() => new Set());
  const [dismissalErrors, setDismissalErrors] = useState({});
  const busyWriteRef = useRef(new Set());
  const readVersion = useRef(0);
  const readPending = useRef(false);
  useEffect(() => {
    if (!api?.listDrafts) return undefined;
    const version = ++readVersion.current;
    const current = () => version === readVersion.current && isCurrent(generation);
    async function read() {
      try {
        const drafts = await api.listDrafts();
        if (current()) setState({ generation, status: "ready", drafts: Array.isArray(drafts) ? drafts : [] });
      } catch (error) {
        if (current()) setState({ generation, status: error?.code === "42501" ? "ready" : "failed", drafts: [] });
      } finally {
        if (current()) readPending.current = false;
      }
    }
    void read();
    return () => { readVersion.current += 1; };
  }, [api, generation, isCurrent, refreshKey, reload]);
  if (state?.generation !== generation || (state.status === "ready" && state.drafts.length === 0)) return null;
  const draftKey = (draft) => `${generation}:${draft.id}`;
  function dismiss(draft) {
    if (readPending.current) return;
    const key = draftKey(draft);
    return runBusyWrite(busyWriteRef, key, () => dismissNow(draft, key));
  }

  async function dismissNow(draft, key) {
    setDismissing((ids) => new Set(ids).add(key));
    setDismissalErrors((errors) => ({ ...errors, [key]: false }));
    try {
      await api.resolveDraft(draft.id, "dismissed");
    } catch {
      if (isCurrent(generation)) setDismissalErrors((errors) => ({ ...errors, [key]: true }));
    } finally {
      setDismissing((ids) => { const next = new Set(ids); next.delete(key); return next; });
      if (isCurrent(generation)) requestRead("checking");
    }
  }

  function requestRead(status) {
    // A read begun before the write settled cannot confirm its outcome.
    readVersion.current += 1;
    readPending.current = true;
    setState((previous) => ({ ...previous, status }));
    setReload((value) => value + 1);
  }

  return <div className="cwk-card__note" role="region" aria-labelledby="steward-announcement-drafts-title">
    <h3 id="steward-announcement-drafts-title">{t("steward.draftsTitle")}</h3>
    {(state.status === "failed" || state.status === "retrying") && <div>
      {Object.entries(dismissalErrors).some(([key, failed]) => failed && key.startsWith(`${generation}:`)) &&
        <p role="alert">{t("steward.draftDismissUnconfirmed")}</p>}
      <p role="alert">{t("steward.draftsLoadFailed")}</p>
      <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={state.status === "retrying"} onClick={() => requestRead("retrying")}>{t("app.tryAgain")}</BusyButton>
    </div>}
    {state.drafts.length > 0 && <>
      <p>{t("steward.draftsSub")}</p>
      <ul>
        {state.drafts.map((draft) => {
          const key = draftKey(draft);
          const pending = busy || state.status === "checking" || dismissing.has(key);
          return <li key={draft.id}>
            <strong>{draft.title}</strong>
            <div className="xus-btnrow">
              <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={pending} onClick={() => { if (!readPending.current) onUse(draft); }}>{t("steward.draftUse")}: {draft.title}</BusyButton>
              <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={pending} onClick={() => void dismiss(draft)}>{t("steward.draftDismiss")}: {draft.title}</BusyButton>
            </div>
            {dismissalErrors[key] && <p role="alert">{t("steward.draftDismissUnconfirmed")}</p>}
          </li>;
        })}
      </ul>
    </>}
  </div>;
}
