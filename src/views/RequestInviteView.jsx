import { BusyButton } from "../components/BusyControls.jsx";
import { useEffect, useRef, useState } from "react";
import { runBusyWrite } from "../lib/busyWrite.js";
import { BrandMark } from "../components/BrandMark.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { publicContact } from "../lib/publicContact.js";

const EMPTY = Object.freeze({ name: "", email: "", organization: "", note: "", website: "" });

// Accounts are invitation-only, so a person without an invitation asks the
// Union Ground team here. api/invite-request.js emails the request to the
// support mailbox; nothing is sent to the address typed below.
// BUG-UG-INVITE-SENT-ADDRESS-READABILITY-20261020: the address sits
// inside a translated sentence; it is rendered bold and selectable as one unit
// so a long one that wraps over several lines can still be found and confirmed
// at a glance. The sentence itself comes from the catalogue unchanged.
const ADDRESS_SLOT = "\u0000";
function sentToSentence(t, email) {
  const [before, after = ""] = t("requestInvite.sentTo", { email: ADDRESS_SLOT }).split(ADDRESS_SLOT);
  return <>{before}<strong className="iac-sent-address">{email}</strong>{after}</>;
}

export function RequestInviteView({ fetcher = (...args) => fetch(...args) }) {
  const { t, lang } = useLang();
  const supportContact = publicContact("support");
  const [fields, setFields] = useState(EMPTY);
  const [state, setState] = useState("idle");
  // The address the reply will go to, shown once on the sent screen only. It is
  // normalized (trim + lower case) exactly as api/_lib/inviteRequest.js stores
  // it as reply_to, so the screen shows the address the team will write to.
  const [sentTo, setSentTo] = useState("");
  const messageRef = useRef(null);
  const busyWriteRef = useRef(new Set());

  useEffect(() => {
    if (["sent", "invalid", "unavailable", "error"].includes(state)) messageRef.current?.focus();
  }, [state]);

  const update = (name) => (event) => setFields((current) => ({ ...current, [name]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (state === "submitting") return;
    return runBusyWrite(busyWriteRef, "request-invite", async () => {
      setState("submitting");
      try {
        const response = await fetcher("/api/invite-request", {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...fields, locale: lang }),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload?.accepted === true) {
          setSentTo(fields.email.trim().toLowerCase());
          setFields(EMPTY);
          setState("sent");
        } else if (response.status === 400) {
          setState("invalid");
        } else if (response.status === 404 || response.status === 503) {
          setState("unavailable");
        } else {
          setState("error");
        }
      } catch {
        setState("error");
      }
    });
  }

  const failure = ["invalid", "unavailable", "error"].includes(state) ? state : null;
  return (
    <main className="auth-screen iac-screen">
      <section className="auth-card iac-card" aria-labelledby="request-invite-title">
        <span className="iac-brand"><BrandMark size={40} /></span>
        <span className="eyebrow">{t("requestInvite.eyebrow")}</span>
        <h1 id="request-invite-title" className="iac-title">{t("requestInvite.title")}</h1>
        {state === "sent" ? (
          <div ref={messageRef} className="iac-state" role="status" tabIndex="-1">
            <span className="iac-glyph" aria-hidden="true">✓</span>
            <h2>{t("requestInvite.sentTitle")}</h2>
            <p>{t("requestInvite.sentBody")}</p>
            {sentTo && <p className="iac-sent-to">{sentToSentence(t, sentTo)}</p>}
            <a className="iac-action" href="/">{t("requestInvite.back")}</a>
          </div>
        ) : (
          <>
            <div className="iac-state">
              <p>{t("requestInvite.intro")}</p>
            </div>
            <form className="rqi-form" onSubmit={submit}>
              <label>
                <span>{t("requestInvite.name")}</span>
                <input name="name" autoComplete="name" required minLength={2} maxLength={120} value={fields.name} onChange={update("name")} />
              </label>
              <label>
                <span>{t("requestInvite.email")}</span>
                <input name="email" type="email" autoComplete="email" required maxLength={254} value={fields.email} onChange={update("email")} />
              </label>
              <div className="rqi-field">
                <label>
                  <span>{t("requestInvite.organization")}</span>
                  <input name="organization" autoComplete="organization" required minLength={2} maxLength={160} aria-describedby="request-invite-organization-hint" value={fields.organization} onChange={update("organization")} />
                </label>
                <small id="request-invite-organization-hint">{t("requestInvite.organizationHint")}</small>
              </div>
              <label>
                <span>{t("requestInvite.note")}</span>
                <textarea name="note" rows={3} maxLength={1000} value={fields.note} onChange={update("note")} />
              </label>
              <label className="rqi-trap" hidden>
                Website
                <input name="website" autoComplete="off" tabIndex={-1} value={fields.website} onChange={update("website")} />
              </label>
              {failure && (
                <p ref={messageRef} className="rqi-error" role="alert" tabIndex="-1">
                  {t(`requestInvite.${failure}`)}
                  {failure === "unavailable" && supportContact && <> <a href={supportContact.href}>{supportContact.email}</a></>}
                </p>
              )}
              <BusyButton className="iac-action" type="submit" pending={state === "submitting"}>
                {t(state === "submitting" ? "requestInvite.submitting" : "requestInvite.submit")}
              </BusyButton>
              <p className="rqi-privacy">{t("requestInvite.privacy")} <a href="/privacy">{t("hub.privacy")}</a></p>
            </form>
          </>
        )}
        <p className="iac-legal">{t("requestInvite.haveInvitation")} <a href="/auth">{t("requestInvite.signIn")}</a></p>
      </section>
    </main>
  );
}
