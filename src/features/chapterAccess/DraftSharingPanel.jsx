import { runBusyWrite } from "../../lib/busyWrite.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import "./chapterAccess.css";

export function DraftSharingPanel({ api, formId }) {
  const busyWriteRef = useRef(new Set());
  const { t, lang } = useLang();
  const [state, setState] = useState({ phase: "loading", stewards: [] });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The draft whose steward list the person opened. A share re-reads the list,
  // which clears it and so unmounts the fold; it comes back open, for this
  // draft only, so a second steward needs no second open.
  const [openFor, setOpenFor] = useState(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setState({ phase: "loading", stewards: [] }); setBusy(false); setError(null);
  // #9781: a first read that never answers ends in the panel's own
  // could-not-load line with its Try again after the shared deadline,
  // instead of "Loading access…" for as long as the page stays open.
    withLoadDeadline(() => api.sharing(formId)).then((stewards) => {
      if (current === generation.current) setState({ phase: "ready", stewards });
    }).catch(() => { if (current === generation.current) setState({ phase: "error", stewards: [] }); });
    return () => { generation.current += 1; };
  }, [api, formId, revision]);
  async function share(steward) {
    return runBusyWrite(busyWriteRef, "busy", async (releaseBusyWrite) => {
      const current = generation.current;
      setBusy(true); setError(null);
      try {
        await api.share(formId, steward.id, !steward.shared);
        if (current === generation.current) setRevision((value) => value + 1);
      } catch {
        // A failed save may still have reached the server
        // (only its reply was lost), so the list is read again and shows what
        // is shared now. If that read fails too, the old list is hidden behind
        // Try again rather than shown as if it were still true.
        if (current !== generation.current) return;
        let stewards = null;
        try { stewards = await api.sharing(formId); } catch { /* shown as unknown below */ }
        if (current !== generation.current) return;
        setState(stewards ? { phase: "ready", stewards } : { phase: "error", stewards: [] });
        setError(stewards ? "access.shareSaveError" : "access.shareSaveUnknown");
      }
      finally { if (current === generation.current) setBusy(false);
        releaseBusyWrite();
      }
    });
  }
  // #9555 (B-38, B-11): each steward is one row, the name inside its own
  // control ("Share with Dylan Kowalski"), so no name can read as the label of
  // the next row's button. The rows no longer use .institutional-actions, whose
  // phone layout (column-reverse) put each button above its own name. The list
  // folds under one control per draft, padded like the draft strip above it;
  // that control says who the draft is shared with, and loading, a failed read
  // with its Try again, "no steward" and a failed save stay outside the fold.
  const sharedWith = state.stewards.filter((steward) => steward.shared).map((steward) => steward.name);
  return <section className="chapter-access draft-share" aria-label={t("access.shareTitle")}>
    {state.phase === "loading" && <p role="status">{t("access.loading")}</p>}
    {state.phase === "error" && <p role="alert">{t("access.shareLoadError")} <button type="button" onClick={() => setRevision((value) => value + 1)}>{t("access.retry")}</button></p>}
    {state.phase === "ready" && state.stewards.length === 0 && <p role="status">{t("access.shareNoSteward")}</p>}
    {state.stewards.length > 0 && <details className="draft-share__details" open={openFor === formId} onToggle={(event) => setOpenFor(event.currentTarget.open ? formId : null)}>
      <summary>{t("access.shareTitle")}{sharedWith.length > 0 && <span className="draft-share__state">{t("access.sharedWith", { names: new Intl.ListFormat(lang, { type: "conjunction" }).format(sharedWith) })}</span>}</summary>
      <p>{t("access.shareHelp")}</p>
      <ul className="draft-share__list">
        {state.stewards.map((steward) => <li key={steward.id}><BusyButton type="button" pending={busy} onClick={() => void share(steward)}>{t(steward.shared ? "access.unshareWith" : "access.shareWith", { name: steward.name })}</BusyButton></li>)}
      </ul>
    </details>}
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}

// #9555 (B-11): a draft that can never be shared (a sealed health and leave
// form, which the server refuses to share) says so instead of showing no block.
export function DraftSharingUnavailable() {
  const { t } = useLang();
  return <p className="chapter-access draft-share draft-share--unavailable">{t("access.shareSealed")}</p>;
}
