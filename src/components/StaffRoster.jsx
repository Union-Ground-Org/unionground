import { EmptyState } from "./Primitives.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { ROLE_LABEL_KEYS, PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";

// The staff roster list shared by the VP, advisor and admin planes. All three
// carried the same rows byte-for-byte; the only real difference is that the
// admin plane hangs a revoke control off each role chip, which is what
// `renderRoleChip` is for. Everything else — the card surface, the avatar, the
// row rhythm — stays in one place so a plane cannot drift into looking like a
// different product.
//
// Wave 2e restyles the list to the prototype's roster grid: a flush card whose
// rows reflow at repeat(auto-fit, minmax(212px, 1fr)) instead of one row per
// line. The card header the prototype draws above the grid is NOT rendered
// here — each plane titles this list differently ("Leadership team" on the VP
// and advisor planes, "Staff roles" on the admin plane), so the header stays
// with the caller (the advisor plane wraps the card in .ach-roster-wrap to sit
// its header flush on top). Props stay exactly `roster` + `renderRoleChip`.
//
// `t` is read from the language context rather than passed in: the role labels
// must follow the reader's language like every other staff-plane string.
function defaultRoleChip(role, label) {
  return <span key={role} className="reward-chip reward-chip--tier">{label}</span>;
}

export function StaffRoster({ roster, renderRoleChip = defaultRoleChip }) {
  const { t } = useLang();
  const people = roster || [];
  return (
    <div className={PLANE_CARD_CLASS + " plane-card--flush ach-roster"}>
      {people.length === 0 && <EmptyState><p>{t("vp.rosterEmpty")}</p></EmptyState>}
      <div className="ach-roster__grid">
        {people.map((person) => (
          <div key={person.userId} className="ach-roster__row">
            <span className="ach-roster__avatar" aria-hidden="true">{person.initials}</span>
            <div className="ach-roster__copy">
              <strong className="ach-roster__name">{person.fullName}</strong>
              {person.memberSince ? <small className="ach-roster__role">{t("today.memberSince", { year: person.memberSince })}</small> : null}
            </div>
            <span className="ach-roster__chips">
              {(person.roles || []).map((role) => renderRoleChip(role, ROLE_LABEL_KEYS[role] ? t(ROLE_LABEL_KEYS[role]) : role, person))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
