import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { dateTimeFormat } from "../../lib/i18n.js";
import { BusyButton, BusyFieldset, BusyInput } from "../../components/BusyControls.jsx";

const PROVIDER = "ai_connector_fireworks";
// No Meta contributor model (it trains on what it receives; owner instruction October 2, 2026).
const MODEL_PATTERN = /^accounts\/fireworks\/models\/(?![a-z0-9.-]*contributor)[a-z0-9.-]{1,80}$/;
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
const RENEWAL_DAYS = 90;

// The attestation line the operator reads: a date in the viewer's language,
// a warning inside the last week, and a refusal note once expired. The
// server decides whether failover is authorized; this only explains it.
export function attestationState(expiresAt, now = Date.now()) {
  const at = expiresAt ? new Date(expiresAt) : null;
  if (!at || Number.isNaN(at.getTime())) return { kind: "missing", at: null };
  const remaining = at.getTime() - now;
  return { kind: remaining <= 0 ? "expired" : remaining < EXPIRY_WARNING_MS ? "expiring" : "valid", at };
}

function formatDate(at, lang) {
  return dateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(at);
}

// A key replacement offers Muse Spark Open in place of gpt-oss-120b, which
// leaves Fireworks serverless on November 7, 2026; any other configured model
// is kept as it is.
export function replacementModel(current) {
  return current === "accounts/fireworks/models/gpt-oss-120b" ? "accounts/fireworks/models/muse-spark-open" : current;
}

// Platform configuration: tenant roles never grant provider-management rights.
// Keys go directly from the password field to the
// Vault-backed RPC, never into a snapshot, persisted draft or browser storage.
export function FireworksConnector({ store, actor, connectors, onRefresh }) {
  const { t, lang } = useLang();
  const keyInput = useRef(null);
  const submitting = useRef(false);
  // Muse Spark Open replaces gpt-oss-120b, which leaves Fireworks serverless on
  // November 7, 2026 (OPS-UG-FIREWORKS-FAILOVER-GPT-OSS-120B-SERVERLESS-RETIRED-20261022).
  const [model, setModel] = useState("accounts/fireworks/models/muse-spark-open");
  const [platform, setPlatform] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const available = store.persistenceKind === "supabase" && platform !== null;
  const canManage = available && platform.canManage === true;
  // `enabled` is the server's answer to "is failover authorized right now"
  // and folds the attestation's validity in. `configured` is "the key is on
  // record and failover is switched on", which is what decides whether the
  // card offers renewal, key replacement and disable: an expired attestation
  // must keep the renewal control, not demand the key again. Authorized
  // implies configured, so an older status read without the field still
  // renders the enabled card.
  const configured = available && (platform.configured === true || platform.enabled === true);
  const enabled = configured && platform.enabled === true;
  const legacyConnector = connectors?.find((row) => row.provider === PROVIDER && row.status === "connected");
  // The key form is the whole card until failover is configured; afterwards
  // the status is the card and the form opens only behind "Replace key".
  const showForm = canManage && (!configured || replacing);
  useEffect(() => {
    let current = true;
    setPlatform(null);
    if (store.persistenceKind === "supabase") {
      Promise.resolve(store.getCompassPlatformAi?.()).then((result) => {
        if (current && result?.ok && typeof result.data?.enabled === "boolean") {
          setPlatform(result.data);
          setModel(replacementModel(result.data.model));
        }
      }).catch(() => { /* Unavailable configuration never grants management. */ });
    }
    return () => { current = false; };
  }, [store]);

  async function submit(event) {
    event.preventDefault();
    if (!canManage || submitting.current) return;
    const apiKey = keyInput.current?.value || "";
    if (!acknowledged || !MODEL_PATTERN.test(model.trim()) || !/^[!-~]{16,512}$/.test(apiKey)) {
      setError(t("integrations.fireworksInvalid"));
      return;
    }
    keyInput.current.value = "";
    await change(() => store.enableFireworksConnector(actor, { model: model.trim(), apiKey, termsAcknowledged: true }), "integrations.fireworksEnabled");
  }

  async function change(action, successKey) {
    if (!canManage || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (!result?.ok) {
        setError(t(result?.reason === "mfa_required" ? "integrations.fireworksMfa" : "integrations.fireworksFailed"));
        return;
      }
      setAcknowledged(false);
      setReplacing(false);
      setNotice(t(successKey));
      if (typeof result.data?.enabled === "boolean") setPlatform(result.data);
      await onRefresh();
    } catch {
      setError(t("integrations.fireworksFailed"));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function renderAttestation() {
    const state = attestationState(platform.attestationExpiresAt);
    if (state.kind === "missing") return <p className="xus-note">{t("integrations.fireworksAttestationMissing")}</p>;
    const date = formatDate(state.at, lang);
    if (state.kind === "valid") return <p className="xus-note">{t("integrations.fireworksAttestedUntil", { date })}</p>;
    return <p className="xus-note xus-note--error" role="alert">{t(state.kind === "expired" ? "integrations.fireworksAttestationExpired" : "integrations.fireworksAttestationExpiring", { date })}</p>;
  }

  return (
    <section aria-labelledby="integration-fireworks-title">
      <h3 id="integration-fireworks-title" className="xus-cardttl">{t("integrations.fireworksTitle")}</h3>
      <p className="xus-note">{t("integrations.fireworksPrivacy")}</p>
      <p className="xus-note"><a href="https://docs.fireworks.ai/guides/security_compliance/data_handling" target="_blank" rel="noopener noreferrer">{t("integrations.fireworksTerms")}</a></p>
      {!available ? <p className="xus-note" role="status">{t("integrations.fireworksUnavailable")}</p> : <>
        <dl className="xus-note" data-testid="fireworks-status">
          <dt>{t("integrations.fireworksStatusLabel")}</dt>
          <dd><strong>{enabled ? t("integrations.fireworksStatusEnabled") : t("integrations.fireworksStatusDisabled")}</strong></dd>
        </dl>
        <p className="xus-note" role="status">{enabled ? t("integrations.fireworksConnected", { model: platform.model }) : t("integrations.fireworksInactive")}</p>
        {/* Configured but not authorized (lapsed attestation): the renewal
            confirmation names "this model", so the model stays on the card
            even though the enabled line above does not carry it. */}
        {configured && !enabled ? <p className="xus-note">{t("integrations.fireworksConfiguredModel", { model: platform.model })}</p> : null}
        {configured ? renderAttestation() : null}
        {notice ? <p className="xus-note" role="status">{notice}</p> : null}
        {error ? <p className="xus-note xus-note--error" role="alert">{error}</p> : null}
        {canManage ? <>
          {configured && !replacing ? <>
            {/* Renewal records a fresh verified attestation, so the operator
                re-confirms both provider controls here; the card never sends
                those confirmations on its own. The box clears after a change. */}
            <label className="xus-checkline"><BusyInput type="checkbox" checked={acknowledged} pending={busy} onChange={(event) => setAcknowledged(event.target.checked)} /> {t("integrations.fireworksRenewConfirm")}</label>
            <p className="xus-actions">
              <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy} disabled={!acknowledged} onClick={() => change(() => store.renewFireworksAttestation(actor, { days: RENEWAL_DAYS, termsAcknowledged: acknowledged }), "integrations.fireworksRenewed")}>{busy ? t("integrations.fireworksSaving") : t("integrations.fireworksRenew")}</BusyButton>
              <BusyButton className="xus-btn" type="button" pending={busy} onClick={() => { setAcknowledged(false); setModel(replacementModel(platform.model)); setReplacing(true); }}>{t("integrations.fireworksReplaceKey")}</BusyButton>
              <BusyButton className="xus-btn" type="button" pending={busy} onClick={() => change(() => store.disableFireworksConnector(actor), "integrations.fireworksDisabled")}>{t("integrations.fireworksDisable")}</BusyButton>
            </p>
          </> : null}
          {showForm ? <><form className="xus-form" onSubmit={submit}>
            <BusyFieldset pending={busy}>
              <legend>{t("integrations.fireworksSetup")}</legend>
              <label className="xus-field">{t("integrations.fireworksModel")}
                <input className="xus-input" value={model} onChange={(event) => setModel(event.target.value)} required maxLength={105} autoComplete="off" spellCheck={false} />
              </label>
              <label className="xus-field">{t("integrations.fireworksKey")}
                <input className="xus-input" ref={keyInput} type="password" required minLength={16} maxLength={512} autoComplete="off" spellCheck={false} />
              </label>
              <label className="xus-checkline"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} required /> {t("integrations.fireworksAcknowledge")}</label>
              <button className="xus-btn xus-btn--go" type="submit" disabled={!acknowledged || !MODEL_PATTERN.test(model.trim())}>{busy ? t("integrations.fireworksSaving") : t("integrations.fireworksEnable")}</button>
              {/* A cancelled edit must not survive into the next Replace key or
                  the post-Disable setup form: restore the configured model. */}
              {replacing ? <button className="xus-btn" type="button" onClick={() => { setReplacing(false); setAcknowledged(false); setModel(replacementModel(platform.model)); }}>{t("integrations.fireworksCancelReplace")}</button> : null}
            </BusyFieldset>
          </form>
          {legacyConnector ? <BusyButton className="xus-btn" type="button" pending={busy} disabled={!acknowledged} onClick={() => change(() => store.adoptFireworksConnector(actor, { termsAcknowledged: true }), "integrations.fireworksEnabled")}>{t("integrations.fireworksReplace")}</BusyButton> : null}</> : null}
        </> : <p className="xus-note">{t("integrations.fireworksSub")}</p>}
      </>}
    </section>
  );
}
