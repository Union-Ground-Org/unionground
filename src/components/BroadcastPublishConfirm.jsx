import { useId, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { Dialog } from "./Dialog.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import "./confirmAction.css";

const LANGUAGE_KEYS = Object.freeze({ en: "broadcastConfirm.english", es: "broadcastConfirm.spanish" });

const OTHER_LOCALE = Object.freeze({ en: "es", es: "en" });

export const otherBroadcastLocale = (locale) => OTHER_LOCALE[locale] || "es";
export const broadcastLanguageKey = (locale) => LANGUAGE_KEYS[locale] || LANGUAGE_KEYS.en;

// The steward broadcast's confirmation (Lovable audit Batch A pattern 9,
// APP-STEWARD-11; REQ-UG-LOVABLE-AUDIT-WEBAPP-FIXES-20261103). It
// states what publishing does and who sees it, then makes the bilingual step
// explicit: a broadcast row carries one language, so before it goes out the
// steward chooses to stop and add the other language first, or to publish now
// and write the other language next. Publish stays unavailable until one is
// chosen. `onPublish(followUp)` receives true for "write the other one next";
// "add it first" closes the dialog with the draft untouched. `pairedTitle`
// names the broadcast already published in the other language: this one then
// completes the pair, so there is no step to choose and onPublish(false, true)
// asks for no further version (gate r1s1). "This is a different announcement"
// sets the pair aside and asks the bilingual step as usual (gate r2).
export function BroadcastPublishConfirm({ title, locale, pairedTitle = null, busy = false, onPublish, onClose }) {
  const { t } = useLang();
  const [step, setStep] = useState(null);
  const name = useId();
  const language = t(broadcastLanguageKey(locale));
  const other = t(broadcastLanguageKey(otherBroadcastLocale(locale)));
  const [separate, setSeparate] = useState(false);
  const completesPair = Boolean(pairedTitle) && !separate;
  const confirm = () => {
    if (completesPair) { onPublish(false, true); return; }
    if (step === "first") { onClose(); return; }
    if (step === "next") onPublish(true);
  };
  return (
    <Dialog eyebrow={t("broadcastConfirm.eyebrow")} title={t("broadcastConfirm.title", { title })} onClose={onClose} wide>
      <div className="confirm-action" data-testid="broadcast-publish-confirm">
        <h3 className="confirm-action__label">{t("broadcastConfirm.whatHappens")}</h3>
        <ul className="confirm-action__effects">
          <li>{t("broadcastConfirm.audience")}</li>
          <li>{t("broadcastConfirm.language", { language, other })}</li>
          <li>{t("broadcastConfirm.undo")}</li>
        </ul>
        {completesPair && <>
          <p className="confirm-action__hint">{t("broadcastConfirm.completesPair", { other, paired: pairedTitle })}</p>
          <button type="button" className="dialog-secondary" onClick={() => setSeparate(true)}>{t("broadcastConfirm.notThePair")}</button>
        </>}
        {!completesPair && <fieldset className="confirm-action__step">
          <legend className="confirm-action__label">{t("broadcastConfirm.stepLegend", { other })}</legend>
          <label><input type="radio" name={name} value="first" checked={step === "first"} onChange={() => setStep("first")} /> {t("broadcastConfirm.addFirst", { other })}</label>
          <label><input type="radio" name={name} value="next" checked={step === "next"} onChange={() => setStep("next")} /> {t("broadcastConfirm.publishThenAdd", { language, other })}</label>
        </fieldset>}
        {!completesPair && !step && <p className="confirm-action__hint" id={`${name}-hint`}>{t("broadcastConfirm.chooseStep", { other })}</p>}
        <div className="confirm-action__actions">
          <BusyButton type="button" className="dialog-secondary" onClick={onClose} pending={busy}>{t("broadcastConfirm.cancel")}</BusyButton>
          <BusyButton type="button" className="dialog-primary" onClick={confirm} pending={busy} disabled={!completesPair && !step} aria-describedby={!completesPair && !step ? `${name}-hint` : undefined}>
            {step === "first" ? t("broadcastConfirm.backToDraft") : busy ? t("steward.publishing") : t("broadcastConfirm.publish", { language })}
          </BusyButton>
        </div>
      </div>
    </Dialog>
  );
}
