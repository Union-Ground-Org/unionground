import { useEffect, useState } from "react";
import { BusySelect } from "./BusyControls.jsx";
import { AUTOFILL_PREFERENCES } from "../lib/formAutofill.js";
import "../lib/i18n/features/formAutofillStrings.js";

// REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: the member's standing
// answer to "fill this form from your profile?" (always ask, always fill,
// never fill), with the disclosure of what a form may fill and from where.
const OPTION_KEY = {
  ask: "formAutofill.prefAsk",
  always: "formAutofill.prefAlways",
  never: "formAutofill.prefNever",
};

export function FormAutofillSetting({ api, uid, t }) {
  const [preference, setPreference] = useState(null);
  const [state, setState] = useState("loading");
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.load())
      .then((loaded) => { if (live) { setPreference(loaded.preference); setState("ready"); } })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [api]);
  // Record 8435: the choice is pending, not disabled, while it saves. A select
  // change commits its busy state before the next event runs, so the pending
  // select refuses a second choice and no lock is added.
  const choose = async (next) => {
    const previous = preference;
    setPreference(next);
    setState("saving");
    try {
      await api.savePreference(next);
      setState("saved");
    } catch {
      setPreference(previous);
      setState("saveError");
    }
  };
  const id = `${uid}-form-autofill`;
  return (
    <section className="setin-card form-autofill-setting" aria-labelledby={`${id}-title`}>
      <div className="setin-card__head">
        <h3 id={`${id}-title`}>{t("formAutofill.settingTitle")}</h3>
        <p>{t("formAutofill.disclosure")}</p>
      </div>
      {state === "loading" && <p role="status">{t("formAutofill.settingLoading")}</p>}
      {state === "error" && <p role="alert">{t("formAutofill.settingError")}</p>}
      {preference && (
        <label htmlFor={id}>
          {t("formAutofill.settingLabel")}
          <BusySelect id={id} value={preference} pending={state === "saving"} onChange={(event) => { void choose(event.target.value); }}>
            {AUTOFILL_PREFERENCES.map((value) => <option key={value} value={value}>{t(OPTION_KEY[value])}</option>)}
          </BusySelect>
        </label>
      )}
      {state === "saved" && <p role="status">{t("formAutofill.settingSaved")}</p>}
      {state === "saveError" && <p role="alert">{t("formAutofill.settingSaveError")}</p>}
    </section>
  );
}
