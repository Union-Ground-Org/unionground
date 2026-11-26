import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BusyButton, BusyInput } from "./BusyControls.jsx";
import { prepareBusyWrite, runBusyWrite } from "../lib/busyWrite.js";
import { FileText } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import {
  ORG_FORM_MAX_BYTES,
  OrganizationFormError,
  prepareBlankOrganizationForm,
  sha256Hex,
} from "../lib/organizationHtmlForms.js";
import { OrganizationFormViewer } from "./OrganizationFormViewer.jsx";
import { TemplateKeyDetails } from "./AdminFormTemplateEditor.jsx";
import "../lib/i18n/features/organizationHtmlFormsStrings.js";

// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: the organization
// administrator's review and import of the organization's own fillable HTML
// forms. The browser blanks the chosen file first (entered values, choices,
// reset defaults and signatures removed; wording, layout, scripts and the
// organization's own PDF builder kept), shows what was removed by field name
// only, lets the administrator try the blank form, and stores it for this
// organization only after their attestation. Nothing here reaches another
// organization or any shared catalog.

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,49}$/u;

function titleFromFile(name) {
  return String(name || "").replace(/\.html?$/iu, "").replace(/[-_]+/gu, " ").trim();
}

export function AdminOrganizationHtmlForms({ api, demo = false }) {
  const { t } = useLang();
  const fileLimitId = useId();
  const acceptButton = useRef(null);
  const available = Boolean(api?.listOrganizationFormDocuments) && !demo;
  const [state, setState] = useState({ status: available ? "loading" : "idle", documents: [] });
  const [candidate, setCandidate] = useState(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState("");
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState("");

  const load = useCallback(async () => {
    if (!available) return;
    setState((current) => ({ ...current, status: "loading" }));
    try {
      const documents = await api.listOrganizationFormDocuments();
      setState({ status: "ready", documents: Array.isArray(documents) ? documents : [] });
    } catch {
      setState({ status: "unavailable", documents: [] });
    }
  }, [api, available]);

  useEffect(() => { void load(); }, [load]);

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setNotice("");
    setError("");
    setPreview(false);
    if (file.size > ORG_FORM_MAX_BYTES) { setError(t("orgForms.error.too_large")); return; }
    try {
      const source = await file.text();
      const blank = prepareBlankOrganizationForm(source);
      setCandidate({
        fileName: file.name,
        sourceSha256: await sha256Hex(source),
        blank,
        title: (blank.title || titleFromFile(file.name)).slice(0, 160),
        formKey: "",
        attested: false,
        attestationRefused: false,
      });
    } catch (caught) {
      setCandidate(null);
      setError(t(`orgForms.error.${caught instanceof OrganizationFormError ? caught.code : "not_html"}`));
    }
  }

  function accept(event) {
    event.preventDefault();
    return prepareBusyWrite(busyWriteRef, "html", () => {
      if (!candidate) return;
      const title = candidate.title.trim();
      const formKey = candidate.formKey.trim();
      if (!title) { setError(t("orgForms.admin.titleRequired")); return; }
      if (formKey && !KEY_PATTERN.test(formKey)) { setError(t("orgForms.admin.keyInvalid")); return; }
      if (!candidate.attested) {
        setError("");
        acceptButton.current?.click();
        return;
      }
      return () => acceptNow(title, formKey);
    }, event);
  }

  async function acceptNow(title, formKey) {
    setBusy("accept");
    setError("");
    try {
      const result = await api.acceptOrganizationFormDocument({
        title,
        formKey: formKey || null,
        html: candidate.blank.html,
        sourceSha256: candidate.sourceSha256,
        clearedFieldCount: candidate.blank.clearedFieldIds.length,
        attested: true,
      });
      setCandidate(null);
      setPreview(false);
      setNotice(t("orgForms.admin.accepted", { title, version: result?.version ?? 1 }));
      await load();
    } catch {
      setError(t("orgForms.admin.acceptFailed"));
    } finally {
      setBusy("");
    }
  }

  function retire(entry) {
    return runBusyWrite(busyWriteRef, "html", () => retireNow(entry));
  }

  async function retireNow(entry) {
    setBusy(`retire:${entry.id}`);
    setError("");
    try {
      await api.retireOrganizationFormDocument(entry.id);
      setConfirmId("");
      setNotice(t("orgForms.admin.retired", { title: entry.title }));
      await load();
    } catch {
      setError(t("orgForms.admin.retireFailed"));
    } finally {
      setBusy("");
    }
  }

  const update = (field, value) => setCandidate((current) => ({ ...current, [field]: value }));

  return (
    <section id="admin-organization-html-forms" className="ftm-section ohf-section" aria-labelledby="admin-organization-html-forms-title">
      <header className="ftm-section__head">
        <div>
          <p className="ftm-kicker">{t("orgForms.admin.kicker")}</p>
          <h2 id="admin-organization-html-forms-title">{t("orgForms.admin.title")}</h2>
          <p>{t("orgForms.admin.sub")}</p>
        </div>
      </header>
      {!available && <p className="ftm-demo-note">{t("orgForms.admin.demo")}</p>}
      {notice && <p className="ftm-feedback ftm-feedback--success" role="status">{notice}</p>}
      {error && <p className="ftm-feedback ftm-feedback--error" role="alert">{error}</p>}

      {available && <>
        <p className="ftm-help" id={fileLimitId}>{t("orgForms.admin.fileLimit", { max: ORG_FORM_MAX_BYTES / (1024 * 1024) })}</p>
        <label className="ftm-btn ohf-btn ohf-file">
          <span>{t("orgForms.admin.choose")}</span>
          <BusyInput type="file" accept=".html,.htm,text/html" aria-describedby={fileLimitId} onChange={chooseFile} pending={Boolean(busy)} />
        </label>
      </>}

      {candidate && (
        <form className="ftm-editor ohf-review" onSubmit={accept} aria-busy={busy === "accept"}>
          <h3 className="ftm-editor__title">{t("orgForms.admin.reviewTitle", { name: candidate.fileName })}</h3>
          <p className="ftm-help">{t("orgForms.admin.reviewFields", { fields: candidate.blank.fieldCount })}</p>
          <p className="ftm-help">{candidate.blank.clearedFieldIds.length === 0
            ? t("orgForms.admin.reviewNothingCleared")
            : t("orgForms.admin.reviewCleared", { count: candidate.blank.clearedFieldIds.length, fields: candidate.blank.clearedFieldIds.join(", ") })}</p>
          {(candidate.blank.removedSignatureImages > 0 || candidate.blank.removedExportControls > 0) && (
            <p className="ftm-help">{t("orgForms.admin.reviewRemoved", { signatures: candidate.blank.removedSignatureImages, controls: candidate.blank.removedExportControls })}</p>
          )}
          <label className="ftm-field">
            <span>{t("orgForms.admin.formTitle")}</span>
            <input value={candidate.title} maxLength="160" required onChange={(event) => update("title", event.target.value)} />
          </label>
          <label className="ftm-field">
            <span>{t("orgForms.admin.formKey")}</span>
            <input value={candidate.formKey} maxLength="50" pattern="[a-z][a-z0-9_]{2,49}" onChange={(event) => update("formKey", event.target.value)} />
            <small>{t("orgForms.admin.formKeyHelp")}</small>
          </label>
          <label className="ftm-check">
            <input type="checkbox" checked={candidate.attested} aria-invalid={candidate.attestationRefused || undefined}
              onChange={(event) => {
                const attested = event.target.checked;
                setCandidate((current) => ({ ...current, attested, attestationRefused: false }));
              }} />
            <span>{t("orgForms.admin.attest")}</span>
          </label>
          <div className="ftm-actions">
            <BusyButton ref={acceptButton} type="submit" className="ftm-btn ftm-btn--primary ohf-btn" pending={Boolean(busy)} disabled={!candidate.attested}
              disabledReason={t("orgForms.admin.attestRequired")} onBlockedPress={() => update("attestationRefused", true)}>{t(busy === "accept" ? "orgForms.admin.accepting" : "orgForms.admin.accept")}</BusyButton>
            <button type="button" className="ftm-btn ohf-btn" onClick={() => setPreview((value) => !value)} aria-expanded={preview}>{t(preview ? "orgForms.admin.hidePreview" : "orgForms.admin.preview")}</button>
            <BusyButton type="button" className="ftm-btn ftm-btn--quiet ohf-btn" onClick={() => { setCandidate(null); setPreview(false); }} pending={Boolean(busy)}>{t("admin.cancel")}</BusyButton>
          </div>
          {preview && <OrganizationFormViewer html={candidate.blank.html} title={candidate.title || candidate.fileName} onClose={() => setPreview(false)} />}
        </form>
      )}

      {state.status === "loading" && <div className="ftm-state" aria-live="polite"><span className="ftm-spinner" aria-hidden="true" />{t("orgForms.loading")}</div>}
      {state.status === "unavailable" && (
        <div className="ftm-state ftm-state--error" role="alert">
          <p>{t("orgForms.unavailable")}</p>
          <button type="button" className="ftm-btn ohf-btn" onClick={() => load()}>{t("app.tryAgain")}</button>
        </div>
      )}
      {state.status === "ready" && state.documents.length === 0 && <p className="ftm-state">{t("orgForms.admin.empty")}</p>}
      {state.status === "ready" && state.documents.length > 0 && (
        <div className="ftm-list" role="list" aria-label={t("orgForms.listLabel")}>
          {state.documents.map((entry) => (
            <article className="ftm-card" role="listitem" key={entry.id}>
              <div className="ftm-card__icon" aria-hidden="true"><FileText size={20} /></div>
              <div className="ftm-card__main">
                <div className="ftm-card__titleline"><h3>{entry.title}</h3></div>
                <p className="ftm-card__meta">{t("orgForms.admin.meta", { version: entry.version, count: entry.clearedFieldCount })}</p>
                {entry.formKey && <TemplateKeyDetails summary={t("admin.templates.technicalDetails")} name={t("admin.templates.technicalDetailsAria", { title: entry.title })} label={t("orgForms.admin.formKeyValue", { key: entry.formKey })} />}
              </div>
              <div className="ftm-card__actions">
                <BusyButton type="button" className="ftm-btn ftm-btn--danger-quiet ohf-btn" pending={Boolean(busy)} aria-label={t("orgForms.admin.retireAria", { title: entry.title })} onClick={() => setConfirmId(entry.id)}>{t("orgForms.admin.retire")}</BusyButton>
              </div>
              {confirmId === entry.id && (
                <div className="ftm-confirm" role="group" aria-label={t("orgForms.admin.retireAria", { title: entry.title })}>
                  <p>{t("orgForms.admin.retireConfirm", { title: entry.title })}</p>
                  <div>
                    <BusyButton type="button" className="ftm-btn ftm-btn--danger ohf-btn" pending={Boolean(busy)} onClick={() => retire(entry)}>{t(busy === `retire:${entry.id}` ? "orgForms.admin.retiring" : "orgForms.admin.confirmRetire")}</BusyButton>
                    <BusyButton type="button" className="ftm-btn ohf-btn" pending={Boolean(busy)} onClick={() => setConfirmId("")}>{t("admin.cancel")}</BusyButton>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
