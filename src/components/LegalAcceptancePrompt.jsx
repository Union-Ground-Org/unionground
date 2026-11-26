import { useCallback, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { prepareBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { CARD_CLASS } from "./Surfaces.jsx";
import { ResidenceAgeFields } from "./ResidenceAgeFields.jsx";
import {
  LEGAL_CHANGELOG_PATH,
  LEGAL_INSTRUMENTS,
  legalInstrument,
} from "../lib/legalInstruments.js";
import { recordLegalAcceptanceOutcome } from "../lib/legalAcceptance.js";
import { loadPublishedWebVersions } from "../lib/legalReleaseBundle.js";
import { isResidenceRegion } from "../lib/residenceRegions.js";

const TERMS_INSTRUMENT = "terms-of-use";

// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: a reload while
// the gate was up made the person fill it in twice. The chosen state (never
// either agreement) is kept for this tab for at most 15 minutes, bound to the
// signed-in account so another account in the same tab never inherits it,
// and removed once the acceptance is recorded.
export const LEGAL_ACCEPTANCE_DRAFT_KEY = "union-ground.legal-acceptance-draft";
const DRAFT_LIFETIME_MS = 15 * 60 * 1000;

function tabStorage() {
  try { return window.sessionStorage; } catch { return null; }
}

export function readAcceptanceDraftState(userId, now = Date.now()) {
  let stored;
  try { stored = JSON.parse(tabStorage()?.getItem(LEGAL_ACCEPTANCE_DRAFT_KEY) ?? "null"); } catch { stored = null; }
  const expiresAt = Number(stored?.expiresAt);
  if (typeof userId === "string" && userId && stored?.userId === userId
      && isResidenceRegion(stored?.residenceState) && expiresAt > now && expiresAt <= now + DRAFT_LIFETIME_MS) return stored.residenceState;
  try { tabStorage()?.removeItem(LEGAL_ACCEPTANCE_DRAFT_KEY); } catch { /* storage may be unavailable */ }
  return "";
}

function keepAcceptanceDraftState(userId, residenceState, now = Date.now()) {
  try {
    if (typeof userId === "string" && userId && isResidenceRegion(residenceState)) {
      tabStorage()?.setItem(LEGAL_ACCEPTANCE_DRAFT_KEY, JSON.stringify({ userId, residenceState, expiresAt: now + DRAFT_LIFETIME_MS }));
    } else tabStorage()?.removeItem(LEGAL_ACCEPTANCE_DRAFT_KEY);
  } catch { /* storage may be unavailable: the choice stays in memory only */ }
}

function forgetAcceptanceDraftState() {
  try { tabStorage()?.removeItem(LEGAL_ACCEPTANCE_DRAFT_KEY); } catch { /* storage may be unavailable */ }
}
const DOCUMENT_LINK_STYLE = {
  color: "var(--primary)",
  display: "inline-flex",
  alignItems: "center",
  minHeight: 48,
};

// At the first sign-in after a material change, the
// person is asked once, and the acceptance is recorded with its version, the
// time, the person and the organization. The caller decides whether to show
// this at all (src/lib/legalAcceptance.js legalAcceptanceRequirement), so a
// person who already holds the current version never sees it, and one
// acceptance clears it for good.
//
// BUG-UG-TERMS-REACCEPTANCE-GATE-LOCKOUT-20261030: when the database
// refuses the versions this site shows (a deployment whose migration is not
// applied yet, or the reverse), the member cannot be the one to fix it, so the
// prompt says so and onUnavailable lets the caller stop withholding the views.
// The card stays, and accepting again records once the versions agree.
// One sentence per control still missing, so the alert never names a box the
// person has already checked or one that is not on the page.
export function missingSentences(t, prefix, agreed, residenceState, ageAttested) {
  return [
    !agreed && t(`${prefix}.missing.agree`),
    !isResidenceRegion(residenceState) && t(`${prefix}.missing.state`),
    // Until a state is chosen the age box is disabled and the state sentence
    // already says what to do first.
    isResidenceRegion(residenceState) && !ageAttested && t(`${prefix}.missing.age`),
  ].filter(Boolean).join(" ");
}

export function LegalAcceptancePrompt({ instruments = [], client, onAccepted, onUnavailable = null, onProfile = null, userId = null }) {
  const { t } = useLang();
  const [agreed, setAgreed] = useState(false);
  // Every acceptance carries the state
  // the person lives in and the age attestation it selects, and the database
  // refuses one without them.
  const [residenceState, setResidenceStateValue] = useState(() => readAcceptanceDraftState(userId));
  const setResidenceState = useCallback((value) => {
    setResidenceStateValue(value);
    keepAcceptanceDraftState(userId, value);
  }, [userId]);
  const [ageAttested, setAgeAttested] = useState(false);
  const [missingAgreement, setMissingAgreement] = useState(false);
  const [state, setState] = useState("idle");
  const cardRef = useRef(null);
  const changed = new Set(instruments);
  const names = instruments
    .map((key) => legalInstrument(key))
    .filter(Boolean)
    .map((entry) => t(entry.summaryTitleKey))
    .join(", ");
  const termsVersion = legalInstrument(TERMS_INSTRUMENT)?.version ?? "";

  const complete = agreed && ageAttested && isResidenceRegion(residenceState);
  // Record 8435: the acceptance is checked first, then written under a
  // synchronous lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const accept = useCallback(() => prepareBusyWrite(busyWriteRef, "accept", () => {
    if (!complete) {
      setMissingAgreement(true);
      // Focus the first control still missing so the person and assistive
      // technology land on it; the alert names each one that is missing.
      const missing = !agreed ? "agree" : !isResidenceRegion(residenceState) ? "state" : "age";
      cardRef.current?.querySelector(`#legal-acceptance-${missing}`)?.focus();
      return undefined;
    }
    return async (unlock) => {
      // The lock ends where the saving state does, so a step that settles at
      // once (a publication read that throws) leaves a ready button that sends.
      try {
        setMissingAgreement(false);
        setState("saving");
        // The versions come from the shared source and the database checks them
        // again, so nothing is recorded that the prompt did not show. A closed
        // legal-release gate publishes nothing.
        let versions;
        try {
          versions = await loadPublishedWebVersions();
        } catch {
          setState("unavailable");
          onUnavailable?.();
          return;
        }
        const outcome = await recordLegalAcceptanceOutcome(client, versions, residenceState, ageAttested);
        if (outcome === "unavailable") {
          setState("unavailable");
          onUnavailable?.();
          return;
        }
        if (outcome !== "recorded") {
          setState("error");
          return;
        }
        forgetAcceptanceDraftState();
        setState("idle");
        onAccepted?.();
      } finally {
        unlock();
      }
    };
  }), [ageAttested, agreed, client, complete, onAccepted, onUnavailable, residenceState]);

  return (
    <aside ref={cardRef} className={`${CARD_CLASS} legal-acceptance`} aria-label={t("legalAcceptance.label")}>
      <h2>{t("legalAcceptance.title")}</h2>
      <p>{t("legalAcceptance.body", { instruments: names })}</p>
      <p>{t(changed.size < LEGAL_INSTRUMENTS.length ? "legalAcceptance.whyAll" : "legalAcceptance.whyAllChanged", { count: LEGAL_INSTRUMENTS.length })}</p>
      <p>{t("legalAcceptance.version", { version: termsVersion })}</p>
      <ul>
        {LEGAL_INSTRUMENTS.map((entry) => (
          <li key={entry.key}>
            <a href={entry.path} target="_blank" rel="noopener noreferrer" style={DOCUMENT_LINK_STYLE}>
              {t(entry.summaryTitleKey)} — {entry.version}
            </a>
            {" "}{t(changed.has(entry.key) ? "legalAcceptance.changedMark" : "legalAcceptance.unchangedMark")}
          </li>
        ))}
      </ul>
      <p><a href={LEGAL_CHANGELOG_PATH} style={DOCUMENT_LINK_STYLE}>{t("legalAcceptance.changelog")}</a></p>
      <label htmlFor="legal-acceptance-agree">
        <input
          id="legal-acceptance-agree"
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        {t("legalAcceptance.consent")}
      </label>
      <ResidenceAgeFields
        idPrefix="legal-acceptance"
        residenceState={residenceState}
        onResidenceState={setResidenceState}
        ageAttested={ageAttested}
        onAgeAttested={setAgeAttested}
      />
      {missingAgreement && !complete && <p role="alert">{missingSentences(t, "legalAcceptance", agreed, residenceState, ageAttested)}</p>}
      {state === "error" && <p role="alert">{t("legalAcceptance.error")}</p>}
      {state === "unavailable" && <p role="alert">{t("legalAcceptance.unavailable")}</p>}
      {/* BUG-UG-LEGAL-ACCEPTANCE-ACTION-HIERARCHY-20261020: the card
          stands alone in the workspace column, so its two controls use the
          application's dialog button family: accept is the primary pill, the
          profile (sign-out) control the secondary one. Behaviour is unchanged. */}
      <BusyButton className="dialog-primary" type="button" onClick={accept} pending={state === "saving"}>
        {t("legalAcceptance.action")}
      </BusyButton>
      {/* The profile dialog holds Sign out; the phone Home route has no top
          bar while this card stands in for the views. */}
      {onProfile && <button className="dialog-secondary" type="button" onClick={onProfile}>{t("topbar.profile")}</button>}
    </aside>
  );
}
