import { prepareBusyWrite } from "../../lib/busyWrite.js";
import { BusyButton, BusyTextarea } from "../../components/BusyControls.jsx";
import { useEffect, useId, useState, useRef } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { rpcErrorKeyStrict, rpcErrorTextAtRender } from "../../lib/rpcErrorText.js";
import { CaseTextLimit } from "./CaseTextLimit.jsx";

const ARTICLES_MAX = 500;
const REASON_MAX = 1000;

// Mounted only on the staff case dialog when its adapter supplies the writer.
// The RPC rechecks scope and permits non-coordinators to change articles only.
export function CaseArticlesEditor({ item, onUpdate, onSaved }) {
  const busyWriteRef = useRef(new Set());
  const { t } = useLang();
  const help = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reasonLength, setReasonLength] = useState(0);
  const incomingArticles = item.articles || "";
  const [editor, setEditor] = useState({ articles: incomingArticles, baseline: incomingArticles });
  useEffect(() => {
    setEditor((current) => ({
      articles: current.articles === current.baseline ? incomingArticles : current.articles,
      baseline: incomingArticles,
    }));
  }, [incomingArticles]);
  const { articles, baseline } = editor;
  const dirty = articles !== baseline;
  function resetCount({ currentTarget: form }) {
    // The articles draft is controlled. Read the reason after native reset.
    const { reason } = form.elements;
    queueMicrotask(() => setReasonLength(reason.value.length));
  }
  async function save(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      if (busy || !dirty) return;
      const form = new FormData(event.currentTarget);
      return async (releaseBusyWrite) => {
        setBusy(true); setError(""); setSaved(false);
        try {
          const result = await onUpdate(item.id, { articles, reason: String(form.get("reason")) });
          const stored = result?.articles ?? articles.trim();
          setEditor({ articles: stored, baseline: stored });
          setSaved(true);
          await onSaved?.();
        } catch (cause) { setError(rpcErrorKeyStrict(cause, "toast.saveFailed")); }
        finally { setBusy(false);
          releaseBusyWrite();
        }
      };
    }, event);
  }
  return <form className="stack-form" onSubmit={save} onReset={resetCount}>
    <label>{t("cases.contractArticles")}<BusyTextarea name="articles" value={articles} maxLength={ARTICLES_MAX} pending={busy} aria-describedby={help} onChange={(event) => { const value = event.target.value; setEditor((current) => ({ ...current, articles: value })); setSaved(false); }} /></label>
    <CaseTextLimit id={help} count={articles.length} max={ARTICLES_MAX}>{t("cases.articlesEditHelp")}</CaseTextLimit>
    <label>{t("coordinator.changeReason")}<BusyTextarea name="reason" maxLength={REASON_MAX} required pending={busy} aria-describedby={`${help}-reason`} onInput={(event) => setReasonLength(event.currentTarget.value.length)} /></label>
    <CaseTextLimit id={`${help}-reason`} count={reasonLength} max={REASON_MAX} />
    {error && <p role="alert">{rpcErrorTextAtRender(t, error)}</p>}
    <BusyButton className="dialog-primary" pending={busy} disabled={!dirty}>{busy ? t("cases.saving") : t("cases.saveArticles")}</BusyButton>
    {saved && <p role="status">{t("cases.articlesSaved")}</p>}
  </form>;
}
