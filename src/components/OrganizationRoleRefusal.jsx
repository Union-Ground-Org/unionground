import { useLang } from "../lib/LanguageContext.jsx";

// REQ-UG-ROLE-WORKSPACE-REFUSALS-20261030: what an organization
// surface says instead of loading when the worn role cannot open it. It names
// the organization-wide role that does, offers to act in a role only when the
// account already holds one that opens the page, and offers no "Try again",
// because trying again cannot change a role.
const ROLE_LABEL_KEYS = Object.freeze({
  steward: "demo.hatSteward",
  coordinator: "demo.hatCoordinator",
  advisor: "demo.hatAdvisor",
  admin: "demo.hatAdmin",
  vp: "demo.hatVp",
});

function roleList(t, lang, roles) {
  const labels = roles.map((role) => t(ROLE_LABEL_KEYS[role]));
  try {
    return new Intl.ListFormat(lang, { style: "long", type: "disjunction" }).format(labels);
  } catch {
    return labels.join(" / ");
  }
}

// `compact` is for a card that already shows the page's own heading: the
// sentence alone, as the card's note.
export function OrganizationRoleRefusal({ pageKey, access, onWear = null, compact = false }) {
  const { t, lang } = useLang();
  const page = t(pageKey);
  const needed = roleList(t, lang, access.allowed || []);
  const offered = access.status === "switch" && typeof onWear === "function" ? access.hats : [];
  const sentence = access.status === "switch"
    ? t("orgRoleRefusal.switch", { page, roles: roleList(t, lang, access.hats) })
    : access.status === "chapterOnly"
      ? t("orgRoleRefusal.chapterOnly", { page, roles: needed, held: roleList(t, lang, access.chapterOnly) })
      : t("orgRoleRefusal.missing", { page, roles: needed });
  if (compact && offered.length === 0) {
    return <p className="xus-note" role="note" data-organization-role-refusal="">{sentence}</p>;
  }
  return (
    <section className="staff-authoring-hint" role="note" aria-label={t("orgRoleRefusal.label", { page })} data-organization-role-refusal="">
      <h2>{t("orgRoleRefusal.title", { page })}</h2>
      <p>{sentence}</p>
      {offered.length > 0 && <div className="staff-authoring-hint__actions" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        {offered.map((role) => <button key={role} type="button" onClick={() => onWear(role)}>
          {t("staffAuthoring.wearHat", { hat: t(ROLE_LABEL_KEYS[role]) })}
        </button>)}
      </div>}
    </section>
  );
}
