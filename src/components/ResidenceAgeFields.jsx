import { useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { RESIDENCE_REGIONS, ageRuleFor, residenceRegionName } from "../lib/residenceRegions.js";

// Every account-creation path and every
// re-acceptance asks where the person lives, then shows the one age
// attestation that state selects: "I'm 18 or older" in the app-store age-law
// states, the D-03 B band everywhere else. The server derives the rule from
// the state again; this only decides what is shown.
//
// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the age box
// used to appear only after a state was chosen, so a first submit failed
// against a box nobody had seen, and every state pick cleared it. The box is
// now always shown: before a state is chosen it is disabled and says to
// choose the state first, so it is never checked against a sentence nobody
// has read. Changing the state still clears an answer when the sentence
// changes, and the form says why; a
// state with the same sentence keeps it. The reason for the state question
// is given up front, and the rule line names only the state the person chose.
export function ResidenceAgeFields({ idPrefix, residenceState, onResidenceState, ageAttested, onAgeAttested, selectLabelClassName, checkLabelClassName, disabled = false, agePolicy }) {
  const { t, lang } = useLang();
  const [recheck, setRecheck] = useState(false);
  // Invitation refresh supplies the validated policy and existing translations
  // from the same deployment as the newly displayed legal instruments; copy
  // a refreshed pack does not carry yet comes from this page's catalogue.
  const ruleOf = (code) => (agePolicy ? agePolicy.rules[code] : ageRuleFor(code)) ?? null;
  const copy = (key, vars) => {
    const published = agePolicy?.labels?.[key];
    return typeof published === "string" && !vars ? published : t(`ageRule.${key}`, vars);
  };
  const rule = ruleOf(residenceState);
  const selectId = `${idPrefix}-state`;
  const helpId = `${idPrefix}-state-help`;
  const ruleId = `${idPrefix}-age-rule`;
  const stateName = residenceState ? residenceRegionName(residenceState, lang) : "";
  return (
    <>
      <label className={selectLabelClassName} htmlFor={selectId}>
        <span>{copy("state")}</span>
        <select
          id={selectId}
          className="residence-select"
          name="residenceState"
          required
          disabled={disabled}
          aria-describedby={helpId}
          value={residenceState}
          onChange={(event) => {
            const next = event.target.value;
            const changed = ageAttested && ruleOf(next) !== rule;
            onResidenceState(next);
            if (changed) onAgeAttested(false);
            setRecheck(changed && Boolean(ruleOf(next)));
          }}
        >
          <option value="">{copy("choose")}</option>
          {RESIDENCE_REGIONS.map((region) => (
            <option key={region.code} value={region.code}>{residenceRegionName(region.code, lang)}</option>
          ))}
        </select>
      </label>
      <p id={helpId}>{copy("help")}</p>
      {rule && <p id={ruleId}>{copy(rule === "adult" ? "adultIn" : "bandIn", { state: stateName })}</p>}
      <label className={checkLabelClassName} htmlFor={`${idPrefix}-age`}>
        <input
          id={`${idPrefix}-age`}
          name="ageAttested"
          type="checkbox"
          required
          disabled={disabled || !rule}
          checked={Boolean(rule) && ageAttested}
          aria-describedby={rule ? ruleId : undefined}
          onChange={(event) => {
            setRecheck(false);
            onAgeAttested(event.target.checked);
          }}
        />
        <span>{rule ? copy(rule === "adult" ? "adult" : "band") : copy("pending")}</span>
      </label>
      {recheck && <p role="status">{copy("recheck", { state: stateName })}</p>}
    </>
  );
}
