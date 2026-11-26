import { BusyButton } from "../components/BusyControls.jsx";
import { useEffect, useRef, useState } from "react";
import { runBusyWrite } from "../lib/busyWrite.js";
import { ArrowLeft, LockKeyhole, Send, ShieldCheck } from "lucide-react";
import { BrandMark, BrandWordmark } from "../components/BrandMark.jsx";
import { LanguageProvider, useLang } from "../lib/LanguageContext.jsx";
import { preferredLanguage } from "../lib/preferredLanguage.js";

const initialForm = {
  firstName: "",
  contactMethod: "email",
  contact: "",
  region: "",
  language: "en",
  bestTime: "any",
  consent: false,
  safeToContact: false,
  voicemailAllowed: false,
  website: "",
};

// Idempotency key, not a secret: the server pairs a retry with the write it is
// retrying. crypto.randomUUID is used whenever it exists, but it is absent on
// http:// origins and in older WebViews, and throwing there meant a worker on
// exactly the kind of device this form exists for could not send at all. The
// fallback is still v4-shaped and unique enough that one visitor's two attempts
// cannot collide.
function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = (length) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const variant = "89ab"[Math.floor(Math.random() * 4)];
  return `${Date.now().toString(16).padStart(12, "0").slice(-8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

// The public intake form, served at /connect.
//
// It asks a prospective member which language they read in and then — before
// this change — showed them the privacy boundary, the consent checkbox and
// every failure message in English only. That consent sentence is the single
// string on this page a visitor most needs to understand, so the whole surface
// follows the saved language the way /reset and /verify do.
//
// IMPORTANT: api/connect.js validates the region, language and bestTime
// <option> VALUES server-side. Only the labels below are translated; the values
// are part of the wire contract and must stay exactly as they are.
export function ConnectView({
  enabled = import.meta.env.VITE_UNIONGROUND_CONNECT_ENABLED === "1",
}) {
  return (
    <LanguageProvider lang={preferredLanguage()}>
      <ConnectScreen enabled={enabled} />
    </LanguageProvider>
  );
}

function ConnectScreen({ enabled }) {
  const { t } = useLang();
  const [form, setForm] = useState(initialForm);
  const [state, setState] = useState("idle");
  const [message, setMessage] = useState("");
  const requestId = useRef(null);
  const busyWriteRef = useRef(new Set());
  const receiptHeading = useRef(null);
  const firstNameInput = useRef(null);
  const focusFormAfterRestart = useRef(false);

  useEffect(() => {
    if (state === "sent") receiptHeading.current?.focus({ preventScroll: true });
    if (state === "idle" && focusFormAfterRestart.current) {
      focusFormAfterRestart.current = false;
      firstNameInput.current?.focus({ preventScroll: true });
    }
  }, [state]);

  function update(event) {
    if (state === "sending") return;
    if (state === "error") {
      requestId.current = null;
      setState("idle");
      setMessage("");
    }
    const { name, type, checked, value } = event.target;
    setForm((current) => ({
      ...current,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function submit(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "connect", async () => {
      setState("sending");
      setMessage("");
      try {
        requestId.current ||= newRequestId();
        const response = await fetch("/api/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          cache: "no-store",
          body: JSON.stringify({ ...form, requestId: requestId.current }),
        });
        if (response.status === 429) {
          setState("error");
          setMessage(t("connect.statusRateLimited"));
          return;
        }
        if (!response.ok) throw new Error("connect request failed");
        const result = await response.json();
        if (!result?.accepted || result.requestId !== requestId.current) {
          throw new Error("invalid connect receipt");
        }
        setForm(initialForm);
        setState("sent");
        setMessage(t("connect.statusReceived"));
      } catch {
        setState("error");
        setMessage(t("connect.statusFailed"));
      }
    });
  }

  function restart() {
    requestId.current = null;
    focusFormAfterRestart.current = true;
    setForm(initialForm);
    setState("idle");
    setMessage("");
  }

  return (
    <div className="public-site connect-site">
      <a className="skip-link" href="#main-content">{t("app.skip")}</a>
      <header className="public-header">
        <a className="public-brand" href="/" aria-label={t("connect.brandAria")}><BrandMark size={30} /><span className="public-brand__name"><BrandWordmark /></span></a>
        <nav aria-label={t("connect.navLabel")}>
          <a href="/"><ArrowLeft size={15} aria-hidden="true" /> {t("connect.navHome")}</a>
          <a className="public-signin" href="/m">{t("connect.signIn")}</a>
        </nav>
      </header>

      <main id="main-content" className="connect-main">
        <section className="connect-intro">
          <span className="public-kicker">{t("connect.introKicker")}</span>
          <h1>{t("connect.introTitle")}</h1>
          <p>{t("connect.introBody")}</p>
          <div className="connect-boundary">
            <LockKeyhole size={22} aria-hidden="true" />
            <div>
              <strong>{t("connect.boundaryTitle")}</strong>
              <p>{t("connect.boundaryBody")}</p>
            </div>
          </div>
          <ul className="connect-facts">
            <li><ShieldCheck size={17} aria-hidden="true" /> {t("connect.factEncrypted")}</li>
            <li><ShieldCheck size={17} aria-hidden="true" /> {t("connect.factExpiry")}</li>
            <li><ShieldCheck size={17} aria-hidden="true" /> {t("connect.factNotLegal")}</li>
          </ul>
        </section>

        <section className="connect-card" aria-labelledby="connect-form-title">
          {!enabled ? (
            <div className="connect-success" role="status">
              <LockKeyhole size={42} aria-hidden="true" />
              <span className="public-kicker">{t("connect.disabledKicker")}</span>
              <h2 id="connect-form-title">{t("connect.disabledTitle")}</h2>
              <p>{t("connect.disabledBody")}</p>
              <a className="public-secondary" href="/m/organize?demo=1">{t("connect.demoLink")}</a>
            </div>
          ) : state === "sent" ? (
            <div className="connect-success" role="status">
              <ShieldCheck size={42} aria-hidden="true" />
              <span className="public-kicker">{t("connect.sentKicker")}</span>
              <h2 ref={receiptHeading} id="connect-form-title" tabIndex={-1}>{t("connect.sentTitle")}</h2>
              <p>{message} {t("connect.sentNote")}</p>
              <button type="button" className="public-secondary" onClick={restart}>{t("connect.sendAnother")}</button>
            </div>
          ) : (
            <>
              <header>
                <span className="public-kicker">{t("connect.formKicker")}</span>
                <h2 id="connect-form-title">{t("connect.formTitle")}</h2>
              </header>
              <form onSubmit={submit}>
                <label>
                  {t("connect.firstName")}
                  <input
                    ref={firstNameInput}
                    name="firstName"
                    value={form.firstName}
                    onChange={update}
                    autoComplete="given-name"
                    maxLength={80}
                    required
                  />
                </label>

                <div className="connect-form-row">
                  <label>
                    {t("connect.contactMethod")}
                    <select name="contactMethod" value={form.contactMethod} onChange={update}>
                      <option value="email">{t("connect.methodEmail")}</option>
                      <option value="phone">{t("connect.methodPhone")}</option>
                      <option value="text">{t("connect.methodText")}</option>
                    </select>
                  </label>
                  <label>
                    {form.contactMethod === "email" ? t("connect.emailAddress") : t("connect.phoneNumber")}
                    <input
                      name="contact"
                      type={form.contactMethod === "email" ? "email" : "tel"}
                      inputMode={form.contactMethod === "email" ? "email" : "tel"}
                      value={form.contact}
                      onChange={update}
                      autoComplete={form.contactMethod === "email" ? "email" : "tel"}
                      maxLength={form.contactMethod === "email" ? 254 : 32}
                      required
                    />
                  </label>
                </div>

                <label>
                  {t("connect.region")}
                  <span>{t("connect.regionHint")}</span>
                  <select name="region" value={form.region} onChange={update} required>
                    <option value="">{t("connect.regionPlaceholder")}</option>
                    <option value="northeast">{t("connect.regionNortheast")}</option>
                    <option value="south">{t("connect.regionSouth")}</option>
                    <option value="midwest">{t("connect.regionMidwest")}</option>
                    <option value="west">{t("connect.regionWest")}</option>
                    <option value="territories">{t("connect.regionTerritories")}</option>
                    <option value="outside-us">{t("connect.regionOutsideUs")}</option>
                  </select>
                </label>

                <div className="connect-form-row">
                  <label>
                    {t("connect.language")}
                    <select name="language" value={form.language} onChange={update}>
                      <option value="en">{t("connect.languageEnglish")}</option>
                      <option value="es">{t("connect.languageSpanish")}</option>
                      <option value="other">{t("connect.languageOther")}</option>
                    </select>
                  </label>
                  <label>
                    {t("connect.bestTime")}
                    <select name="bestTime" value={form.bestTime} onChange={update}>
                      <option value="any">{t("connect.timeAny")}</option>
                      <option value="morning">{t("connect.timeMorning")}</option>
                      <option value="afternoon">{t("connect.timeAfternoon")}</option>
                      <option value="evening">{t("connect.timeEvening")}</option>
                    </select>
                  </label>
                </div>

                <label className="connect-honeypot" aria-hidden="true">
                  {t("connect.website")}
                  <input
                    name="website"
                    value={form.website}
                    onChange={update}
                    autoComplete="off"
                    tabIndex={-1}
                  />
                </label>

                <label className="connect-consent">
                  <input
                    name="safeToContact"
                    type="checkbox"
                    checked={form.safeToContact}
                    onChange={update}
                    required
                  />
                  <span>{t("connect.safeToContact")}</span>
                </label>

                {form.contactMethod === "phone" && (
                  <label className="connect-consent">
                    <input
                      name="voicemailAllowed"
                      type="checkbox"
                      checked={form.voicemailAllowed}
                      onChange={update}
                    />
                    <span>{t("connect.voicemailAllowed")}</span>
                  </label>
                )}

                <label className="connect-consent">
                  <input
                    name="consent"
                    type="checkbox"
                    checked={form.consent}
                    onChange={update}
                    required
                  />
                  <span>{t("connect.consent")}</span>
                </label>

                <BusyButton type="submit" className="public-primary connect-submit" pending={state === "sending"}>
                  {state === "sending" ? t("connect.sending") : <>{t("connect.submit")} <Send size={17} aria-hidden="true" /></>}
                </BusyButton>
                {message && <p className="connect-message" role="alert">{message}</p>}
              </form>
            </>
          )}
        </section>
      </main>

      <footer className="public-footer">
        <a className="public-brand" href="/"><BrandMark size={30} /><span className="public-brand__name"><BrandWordmark /></span></a>
        <p>{t("connect.footerTagline")}</p>
        <a href="/m">{t("connect.footerWorkspace")}</a>
      </footer>
    </div>
  );
}
