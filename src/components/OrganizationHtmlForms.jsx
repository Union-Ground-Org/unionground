import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { FileText } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { ORG_FORM_SAVED_MAX_BYTES, OrganizationFormError, readSavedOrganizationForm } from "../lib/organizationHtmlForms.js";
import { OrganizationFormViewer } from "./OrganizationFormViewer.jsx";
import "../lib/i18n/features/organizationHtmlFormsStrings.js";

// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: the member's list of their
// organization's own HTML forms. Each opens blank; a saved form is continued
// from the file on the member's device, which is read locally and never
// uploaded. A new organization has none until its administrator adds them.

// The saved-file limit in MB, for the hint and the refusal (#9467 W3b-17).
const SAVED_MAX_MB = ORG_FORM_SAVED_MAX_BYTES / (1024 * 1024);

export function OrganizationHtmlForms({ api, autofillApi = null }) {
  const { t } = useLang();
  const [state, setState] = useState({ status: "loading", documents: [] });
  const [open, setOpen] = useState(null);
  const [message, setMessage] = useState("");
  // #9467 W3b-17: a refused saved file is said right under the file button,
  // where the person chose it.
  const [fileMessage, setFileMessage] = useState("");
  const fileHintId = useId();
  const [busyId, setBusyId] = useState("");
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: "loading" }));
    try {
      const documents = await api.listOrganizationFormDocuments();
      setState({ status: "ready", documents: Array.isArray(documents) ? documents : [] });
    } catch {
      setState({ status: "unavailable", documents: [] });
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  function openDocument(entry) {
    return runBusyWrite(busyWriteRef, "open", () => openDocumentNow(entry));
  }

  async function openDocumentNow(entry) {
    setBusyId(entry.id);
    setMessage("");
    try {
      const full = await api.getOrganizationFormDocument(entry.id);
      setOpen({ key: `${full.id}:${Date.now()}`, html: full.html, title: full.title || entry.title, saved: false });
    } catch {
      setMessage(t("orgForms.openFailed"));
    } finally {
      setBusyId("");
    }
  }

  async function continueSaved(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setMessage("");
    setFileMessage("");
    if (file.size > ORG_FORM_SAVED_MAX_BYTES) { setFileMessage(t("orgForms.error.saved_too_large", { size: SAVED_MAX_MB })); return; }
    try {
      const saved = readSavedOrganizationForm(await file.text());
      setOpen({ key: `saved:${file.name}:${Date.now()}`, html: saved.html, title: saved.title || file.name, saved: true });
    } catch (error) {
      const code = error instanceof OrganizationFormError ? error.code : "not_html";
      setFileMessage(t(`orgForms.error.${code}`, { size: SAVED_MAX_MB }));
    }
  }

  if (open) {
    return (
      <section className="ftm-section ohf-section" aria-labelledby="org-html-forms-open-title">
        <header className="ftm-section__head">
          <div>
            <p className="ftm-kicker">{t("orgForms.kicker")}</p>
            <h2 id="org-html-forms-open-title">{open.title}</h2>
          </div>
        </header>
        <OrganizationFormViewer key={open.key} html={open.html} title={open.title} saved={open.saved} autofillApi={autofillApi} onClose={() => setOpen(null)} />
      </section>
    );
  }

  return (
    <section className="ftm-section ohf-section" aria-labelledby="org-html-forms-title">
      <header className="ftm-section__head">
        <div>
          <p className="ftm-kicker">{t("orgForms.kicker")}</p>
          <h2 id="org-html-forms-title">{t("orgForms.title")}</h2>
          <p>{t("orgForms.intro")}</p>
        </div>
      </header>
      {message && <p className="ftm-feedback ftm-feedback--error" role="alert">{message}</p>}
      {state.status === "loading" && <div className="ftm-state" aria-live="polite"><span className="ftm-spinner" aria-hidden="true" />{t("orgForms.loading")}</div>}
      {state.status === "unavailable" && (
        <div className="ftm-state ftm-state--error" role="alert">
          <p>{t("orgForms.unavailable")}</p>
          <button type="button" className="ftm-btn ohf-btn" onClick={() => load()}>{t("app.tryAgain")}</button>
        </div>
      )}
      {state.status === "ready" && state.documents.length === 0 && <p className="ftm-state">{t("orgForms.empty")}</p>}
      {state.status === "ready" && state.documents.length > 0 && (
        <div className="ftm-list" role="list" aria-label={t("orgForms.listLabel")}>
          {state.documents.map((entry) => (
            <article className="ftm-card" role="listitem" key={entry.id}>
              <div className="ftm-card__icon" aria-hidden="true"><FileText size={20} /></div>
              <div className="ftm-card__main">
                <div className="ftm-card__titleline"><h3>{entry.title}</h3></div>
                <p className="ftm-card__meta">{t("orgForms.versionMeta", { version: entry.version })}</p>
              </div>
              <div className="ftm-card__actions">
                <BusyButton type="button" className="ftm-btn ftm-btn--primary ohf-btn" pending={Boolean(busyId)} aria-label={t("orgForms.openAria", { title: entry.title })} onClick={() => openDocument(entry)}>
                  {t(busyId === entry.id ? "orgForms.opening" : "orgForms.open")}
                </BusyButton>
              </div>
            </article>
          ))}
        </div>
      )}
      <label className="ftm-btn ohf-btn ohf-file">
        <span>{t("orgForms.continueSaved")}</span>
        <input type="file" accept=".html,.htm,text/html" aria-describedby={fileHintId} onChange={continueSaved} />
      </label>
      <p id={fileHintId} className="ohf-help">{t("orgForms.continueSavedHint", { size: SAVED_MAX_MB })}</p>
      {fileMessage && <p className="ftm-feedback ftm-feedback--error" role="alert">{fileMessage}</p>}
      <p className="ohf-help">{t("orgForms.privacy")}</p>
    </section>
  );
}
