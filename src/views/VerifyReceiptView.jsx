import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ReceiptText } from "lucide-react";
import { verifyBallotReceipt } from "../lib/memberApi.js";
import { hasAppBackend, appSupabase as supabase } from "../lib/supabase.js";
import { LanguageProvider, useLang } from "../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../lib/i18n.js";
import { preferredLanguage } from "../lib/preferredLanguage.js";
import { captureSanitizedDiagnostic } from "../lib/deferredObservability.js";
import { BrandMark } from "../components/BrandMark.jsx";
import { BusyButton } from "../components/BusyControls.jsx";

// Standalone pre-auth route (/verify): a member checks that their ballot was
// counted without signing in. Translated in PR7 — and the issued-at timestamp
// now formats in the member's own locale instead of a hardcoded en-US, which is
// the one line that ignored language on this screen.
//
// It renders the SAME shell as /reset, sign-in, magic link and MFA:
// .auth-screen > .auth-card. It used to render .sg-app > .app-column with no
// card and .dialog-primary as its submit — two pre-auth screens with two
// looks, reached from the same kind of email, often on the same phone.
//
// Wave 2d rebuilds what sits INSIDE that card to the prototype's pg.verify
// screen (receipt glyph, format explainer with an inline sample, centred mono
// field, full-width green submit, and a circled check on the soft-green tint
// once a receipt resolves). The shell itself is not touched here.
//
// What the success copy may claim is bounded by what verify_ballot_receipt
// actually does. The RPC (20260721223851) returns only
// { found, ballotTitle, counted, issuedAt } and never an option — so the
// LOOKUP genuinely cannot reveal a choice, and that is what we say. As of
// migration 20260808230000 the strong claim is true of the SCHEMA too:
// choices live in member_ballot_choices as anonymous rows (no voter column,
// no timestamp) that no client role can read, and member_ballot_receipts
// stores (receipt_code, user_id) — proof of participation only. There is no
// table to join a receipt against, so even direct database access cannot
// link this code to a choice. The page copy itself is unchanged: the claim
// it has always made simply stopped being aspirational.
function VerifyReceiptScreen() {
  const { t, lang } = useLang();
  const [code, setCode] = useState("");
  // The code that was actually sent to the RPC, so the success panel echoes
  // what was verified rather than whatever the field happens to hold now.
  const [checkedCode, setCheckedCode] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const inputRef = useRef(null);
  const lookupRef = useRef(false);

  const found = Boolean(result && result.found);
  // `counted` is a real column on member_ballot_receipts. It defaults to true
  // and nothing in the product sets it false today, but a found receipt that
  // is not marked counted must not be announced as "Counted".
  const counted = found && result.counted !== false;

  // The field is unmounted while the success panel is up, so a reset cannot
  // focus it in the same tick — the focus happens on the render that brings it
  // back.
  useEffect(() => {
    if (!refocus) return;
    inputRef.current?.focus();
    setRefocus(false);
  }, [refocus]);

  async function check(event) {
    event.preventDefault();
    // #9914: Check stays focusable while the lookup runs, so Enter in the
    // field can still submit; a lookup in flight refuses a second one.
    if (lookupRef.current) return;
    setError("");
    setResult(null);
    if (!hasAppBackend) {
      setError(t("verify.notConnected"));
      return;
    }
    const submitted = code.trim();
    lookupRef.current = true;
    setChecking(true);
    try {
      setResult(await verifyBallotReceipt(supabase, submitted));
      setCheckedCode(submitted);
    } catch (verifyError) {
      captureSanitizedDiagnostic({
        kind: "verify_receipt_lookup_failed",
        code: verifyError?.code ?? null,
        name: verifyError?.name ?? null,
      });
      setError(t("verify.lookupFailed"));
    } finally {
      lookupRef.current = false;
      setChecking(false);
    }
  }

  function reset() {
    setCode("");
    setCheckedCode("");
    setResult(null);
    setError("");
    setRefocus(true);
  }

  return (
    <main className="auth-screen">
      <section
        className={`auth-card vrx-card${found ? " vrx-card--found" : ""}`}
        aria-labelledby="verify-title"
      >
        <span className="vrx-brand">
          <BrandMark size={40} />
        </span>
        <span className="eyebrow">{t("verify.eyebrow")}</span>
        <h1 id="verify-title" className="vrx-h1">{t("verify.title")}</h1>
        <p className="vrx-sub">{t("vrx.pageSub")}</p>

        {found ? (
          <div className="vrx-block" role="status">
            {counted ? (
              <span className="vrx-check" aria-hidden="true"><CheckCircle2 size={28} /></span>
            ) : (
              <span className="vrx-glyph" aria-hidden="true"><ReceiptText size={30} /></span>
            )}
            <h2 className="vrx-title">
              {counted ? t("verify.counted") : t("vrx.notCountedTitle")}
            </h2>
            <p className="vrx-code">{checkedCode}</p>
            <p className="vrx-body">
              {counted ? t("vrx.countedLead") : t("vrx.foundLead")}{" "}
              <b className="vrx-ballot">{result.ballotTitle}</b>
            </p>
            <p className="vrx-issued">
              {t("verify.issued", { date: formatDateTimeWithZone(result.issuedAt, lang) })}
            </p>
            {!counted && <p className="vrx-body">{t("vrx.notCountedBody")}</p>}
            <p className="vrx-privacy">{t("vrx.privacyNote")}</p>
            <button type="button" className="vrx-reset" onClick={reset}>
              {t("vrx.checkAnother")}
            </button>
          </div>
        ) : (
          <div className="vrx-block">
            <span className="vrx-glyph" aria-hidden="true"><ReceiptText size={30} /></span>
            <h2 className="vrx-title">{t("vrx.pendingTitle")}</h2>
            {/* The sample code is a FORMAT illustration, not a receipt anyone
                holds — it shows the shape the field expects (SG- plus two
                Crockford groups, which is exactly what the RPC's regex
                accepts) so a member can tell at a glance whether what they
                copied is the right string. */}
            <p className="vrx-body">
              {t("vrx.pendingBodyLead")}{" "}
              <span className="vrx-sample">{t("vrx.codeSample")}</span>{" "}
              {t("vrx.pendingBodyTail")}
            </p>
            <form className="vrx-form" onSubmit={check}>
              {/* Keep the field name visible as well as programmatic: receipt
                  codes are unfamiliar and a placeholder disappears on entry. */}
              <label className="vrx-label" htmlFor="receipt-code">{t("verify.codeLabel")}</label>
              {/* A receipt code is transcribed off another screen or a printout, so
                  the field keeps the phone's helpers out of the way: no
                  autocomplete history, no autocorrect, caps by default, and the
                  value is upper-cased on the way in rather than only on display —
                  otherwise the lookup and what the member can see disagree. */}
              <input
                ref={inputRef}
                id="receipt-code"
                name="receipt-code"
                className="vrx-input"
                placeholder={t("verify.codePlaceholder")}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
              <BusyButton className="vrx-submit" type="submit" pending={checking} disabled={!code.trim()}>
                {checking ? t("verify.checking") : t("verify.submit")}
              </BusyButton>
            </form>
            {error && <p className="vrx-error" role="alert">{error}</p>}
            {/* The prototype has no not-found card: it only draws the two
                happy states. A public lookup whose commonest outcome is a
                typo needs the third one, so ours stays — as a vrx- variant
                that keeps the form on screen, because retyping the code IS
                the recovery. */}
            {result && !result.found && (
              <div className="vrx-missing" role="status">
                <strong className="vrx-missing-title">{t("verify.notFound")}</strong>
                <p className="vrx-missing-body">{t("verify.notFoundBody")}</p>
              </div>
            )}
          </div>
        )}

        <div className="vrx-foot">
          <p className="vrx-note">{t("vrx.publicNote")}</p>
          <a className="vrx-back" href="/">{t("verify.back")}</a>
        </div>
      </section>
    </main>
  );
}

export function VerifyReceiptView() {
  return (
    <LanguageProvider lang={preferredLanguage()}>
      <VerifyReceiptScreen />
    </LanguageProvider>
  );
}
