import { createContext, useContext } from "react";
import { useOrganizationTranslator } from "../lib/LanguageContext.jsx";

// BUG-UG-STAFF-CAN-ADD-EMPTY-STATES-WITHOUT-CONTROL-20261006: the
// library, space, coordination and collective-action writers render
// only under a worn staff hat, and the live product has no hat picker on a
// member page. An admin or president reading an empty page in the Member hat
// saw "staff can add" and no control. This note tells such a viewer which of
// their own hats adds here and wears it in place; anyone else reads who adds.
//
// App supplies the hats the account holds that may open the current view, and
// only while the Member hat is worn. Wearing one is a selection, not a grant:
// every writer and RPC still rechecks the role.
const NO_AUTHORING_HATS = Object.freeze({ hats: Object.freeze([]), wearHat: null });

export const StaffAuthoringContext = createContext(NO_AUTHORING_HATS);

// Clause and coordination writers authorize against organization_role_grants
// only, so App offers no chapter-only hat on these views (heldAuthoringHats).
// BUG-UG-STAFF-AUTHORING-HINT-OMITS-ORG-WIDE-REQUIREMENT-20261102:
// the plain note then told a chapter coordinator or advisor that they add
// here, so on these views it says the role must be organization-wide.
// Collective actions left this list with #9166: a hat granted for the
// selected chapter now writes that chapter's actions.
export const ORGANIZATION_GRANT_AUTHORING_VIEWS = new Set(["clauses", "coordination"]);

const HAT_LABEL_KEYS = Object.freeze({
  steward: "demo.hatSteward",
  coordinator: "demo.hatCoordinator",
  advisor: "demo.hatAdvisor",
  admin: "demo.hatAdmin",
  vp: "demo.hatVp",
});

// `wearableOnly` renders nothing unless the viewer holds a hat to wear: a page
// that already lists items shows the note only to the people it can help.
export function StaffAuthoringHint({ item, lang = null, className = "staff-authoring-hint", buttonClassName = "", buttonStyle = undefined, wearableOnly = false }) {
  const t = useOrganizationTranslator(lang);
  const { hats, wearHat } = useContext(StaffAuthoringContext);
  const noun = t(`staffAuthoring.item.${item}`);
  const offered = typeof wearHat === "function" ? hats.filter((hat) => HAT_LABEL_KEYS[hat]) : [];
  if (!offered.length) {
    if (wearableOnly) return null;
    const whoAdds = ORGANIZATION_GRANT_AUTHORING_VIEWS.has(item) ? "staffAuthoring.whoAddsOrganizationWide" : "staffAuthoring.whoAdds";
    return <p className={className} role="note">{t(whoAdds, { item: noun })}</p>;
  }
  return (
    <div className={className} role="note">
      <p>{t("staffAuthoring.wearToAdd", { item: noun })}</p>
      <div className="staff-authoring-hint__actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        {offered.map((hat) => (
          <button key={hat} type="button" className={buttonClassName || undefined} style={buttonStyle} onClick={() => wearHat(hat)}>
            {t("staffAuthoring.wearHat", { hat: t(HAT_LABEL_KEYS[hat]) })}
          </button>
        ))}
      </div>
    </div>
  );
}
