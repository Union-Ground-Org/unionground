// REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006: one
// line naming a leader's title and roles, shared by the Who runs this chapter
// card and Search. A title that repeats a role label ("President") is said once.
// REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030 (, findings 69
// and 76): an officer title is a display title and grants no access. A title
// that is a role's own name ("President", "Administrator") on someone without
// that role must not read as the role, in either language.

// Fixed words, not the loaded catalogues: Spanish loads on demand, so an
// English session cannot ask it for "Presidente/a" ( on
//). tests/officer-title-access.test.jsx keeps every catalogue label of
// both roles, in both languages, in these lists.
export const ROLE_TITLE_WORDS = Object.freeze({
  // The edition's own leadership labels (settings.leadershipPresident and
  // settings.leadershipAdministrator, en and es) are listed too.
  president: Object.freeze(["president", "chapter president", "presidente", "presidenta", "presidente/a", "chapter lead", "líder del capítulo", "líder de la campaña"]),
  administrator: Object.freeze([
    "administrator", "admin", "chapter administrator", "chapter admin", "campaign administrator", "campaign admin",
    "administrador", "administradora", "administrador/a", "administrador/a del capítulo", "administrador/a de la campaña",
  ]),
});
// toLowerCase, not toLocaleLowerCase: under Turkish casing "PRESIDENT" would
// become "presıdent" and miss the list.
const normalized = (text) => text.trim().toLowerCase();

// The role a title names but the person does not hold, or null.
export function titleOnlyRole(person) {
  const title = typeof person?.title === "string" ? normalized(person.title) : "";
  if (!title) return null;
  const holds = { president: person.president === true, administrator: person.administrator === true || person.organizationAdministrator === true };
  return Object.keys(ROLE_TITLE_WORDS).find((role) => !holds[role] && ROLE_TITLE_WORDS[role].includes(title)) ?? null;
}

// The title (or its title-only form), then each held role, each said once.
export function leadershipRoleLine(person, t) {
  const title = typeof person?.title === "string" ? person.title.trim() : "";
  const parts = [
    titleOnlyRole(person) ? t("settings.leadershipTitleOnly", { title }) : title,
    person?.treasurer ? t("access.role.treasurer") : null,
    person?.president && !title ? t("settings.leadershipPresident") : null,
    person?.administrator ? t("settings.leadershipAdministrator") : null,
    person?.organizationAdministrator ? t("settings.leadershipOrganizationAdministrator") : null,
  ].filter((part) => typeof part === "string" && part.trim());
  const seen = new Set();
  return parts.filter((part) => {
    const key = part.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(" · ");
}
