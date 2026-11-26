import { useEffect, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { autofillKindOf, autofillProposal } from "../lib/formAutofill.js";
import "../lib/i18n/features/formAutofillStrings.js";

// The kinds a member keeps private until they share their work details.
const SHARED_KINDS = new Set(["jobTitle", "worksite", "unit", "shift", "classification"]);

// REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: the question a form
// asks before it fills anything from the member's profile. Nothing is filled
// until the member says yes; no leaves those fields blank for this form. The
// member's standing answer in Settings ("always" or "never") answers it for
// them, and the note says so.

const KIND_KEY = {
  employer: "formAutofill.kind.employer",
  worksite: "formAutofill.kind.worksite",
  unit: "formAutofill.kind.unit",
  jobTitle: "formAutofill.kind.jobTitle",
  shift: "formAutofill.kind.shift",
  classification: "formAutofill.kind.classification",
  chapter: "formAutofill.kind.chapter",
};

function kindLabel(kind, t) {
  return t(KIND_KEY[kind] ?? "formAutofill.kind.worksite");
}

// The offer's state for one opened form. `fields` are the form's fillable
// fields ({ key, label, autofill, autocomplete }); `current` the values they
// hold now. Loads the member's values once; resolves to "none" when nothing
// on the form matches something the member keeps and shares.
export function useFormAutofill(api, fields, current, { enabled = true } = {}) {
  const [state, setState] = useState(() => ({ status: api?.load && enabled ? "loading" : "none", proposal: [], preference: "ask", unshared: false }));
  const fieldsKey = (fields || []).map((field) => `${field.key}:${field.label ?? ""}`).join("|");
  const inputs = useRef({ fields, current });
  inputs.current = { fields, current };
  useEffect(() => {
    if (!api?.load || !enabled || !fieldsKey) {
      setState((previous) => (previous.status === "loading" ? { ...previous, status: "none" } : previous));
      return undefined;
    }
    let live = true;
    Promise.resolve()
      .then(() => api.load())
      .then((autofill) => {
        if (!live) return;
        const proposal = autofillProposal(inputs.current.fields, autofill.values, inputs.current.current);
        const status = !proposal.length || autofill.preference === "never" ? "none" : autofill.preference === "always" ? "always" : "ask";
        // A work-detail field the member could fill once they share their
        // work details: the form says where that choice lives.
        const unshared = !autofill.shared && autofill.preference !== "never"
          && (inputs.current.fields || []).some((field) => SHARED_KINDS.has(autofillKindOf(field)));
        setState({ status, proposal, preference: autofill.preference, unshared });
      })
      .catch(() => { if (live) setState((previous) => ({ ...previous, status: "none" })); });
    return () => { live = false; };
  }, [api, enabled, fieldsKey]);
  const answer = (accepted) => setState((previous) => ({ ...previous, status: accepted ? "filled" : "declined" }));
  return { ...state, answer };
}

export function FormAutofillOffer({ offer, onAccept, onDecline, filledCount = 0 }) {
  const { t } = useLang();
  const hint = offer.unshared ? <p className="form-autofill__note" data-form-autofill="unshared">{t("formAutofill.unsharedHint")}</p> : null;
  if (offer.status === "ask") {
    return (
      <section className="form-autofill" role="region" aria-labelledby="form-autofill-q" data-form-autofill="ask">
        <p id="form-autofill-q" className="form-autofill__q">{t("formAutofill.question")}</p>
        <ul className="form-autofill__list">
          {offer.proposal.map((item) => <li key={item.fieldKey}><b>{kindLabel(item.kind, t)}</b>{": "}{item.value}</li>)}
        </ul>
        <div className="form-autofill__actions">
          <button type="button" className="ftm-btn ftm-btn--primary" onClick={onAccept}>{t("formAutofill.yes")}</button>
          <button type="button" className="ftm-btn" onClick={onDecline}>{t("formAutofill.no")}</button>
        </div>
        <p className="form-autofill__note">{t("formAutofill.note")}</p>
        {hint}
      </section>
    );
  }
  // "always" is answered by the form itself on its next effect; the note
  // appears once the fields are filled.
  if (offer.status === "filled") {
    return (
      <p className="form-autofill form-autofill--done" role="status" data-form-autofill="filled">
        {t(offer.preference === "always" ? "formAutofill.filledAlways" : "formAutofill.filled", { n: filledCount || offer.proposal.length })}
      </p>
    );
  }
  return offer.status === "none" ? hint : null;
}

// The small mark beside a field filled from the profile.
export function ProfileFilledMark() {
  const { t } = useLang();
  return <span className="form-autofill__mark" data-profile-filled="true">{t("formAutofill.mark")}</span>;
}
