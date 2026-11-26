// Limited chapter offices use the shared selected-hat state, without gaining
// the general staff tools or a casework desk. Leadership grants capabilities
// independently; the database remains authoritative for each operation.
export const CHAPTER_OFFICE_ROLES = ["secretary", "records", "treasurer"];

export function chapterOfficeRoles(roles = []) {
  return CHAPTER_OFFICE_ROLES.filter((role) => roles.includes(role));
}

export function selectedChapterOfficeRole(roles, hat) {
  return chapterOfficeRoles(roles).includes(hat) ? hat : null;
}

export function canSelectChapterOfficeRole(roles, unknown, role) {
  return !unknown && (role === "member" || Boolean(selectedChapterOfficeRole(roles, role)));
}
