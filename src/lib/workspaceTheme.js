// One Union Ground identity for every hat (design Step 2; October 2 design
// direction, decision 2, and the owner's rulings of October 3, 2026 1:40 PM
// ET). This replaces the 2026-08-25 per-role rule ("all hats are using the
// same theme" — they must not), the desktop Union Ground Evergreen forcing and
// the five selectable app palettes: every hat renders `union-ground`. The site
// renders light only (owner order of November 5, 2026,
// REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105): the system colour
// scheme is never read, and the identity has no dark form (deleted by tooling
// ledgers 616 and 636).
//
// The owner's ruling of November 3, 2026, 8:48 PM ET made Union green the only
// theme and the default for every account, so the steward's Harbor Ledger pin
// (owner direction 2026-08-22) is gone: the steward hat renders the identity
// like every other hat.
//
// Chapter work (/m/tasks) is a shared staff tool whose capability hat may
// resolve to coordinator even when a steward navigated there, so the theme
// follows the last hat worn outside the tool; a cold entry falls back to the
// capability hat.
export const IDENTITY_WORKSPACE_THEME = "union-ground";

export const HAT_WORKSPACE_THEMES = {
  member: IDENTITY_WORKSPACE_THEME,
  steward: IDENTITY_WORKSPACE_THEME,
  coordinator: IDENTITY_WORKSPACE_THEME,
  advisor: IDENTITY_WORKSPACE_THEME,
  admin: IDENTITY_WORKSPACE_THEME,
  vp: IDENTITY_WORKSPACE_THEME,
};

export function deriveWorkspaceTheme(view, activeHat, previousHat) {
  const hat = (view === "tasks" || view === "campaigns") && previousHat ? previousHat : activeHat;
  return HAT_WORKSPACE_THEMES[hat] ?? null;
}

// The rendered theme depends on neither the shell width nor the system colour
// scheme: the light identity is the desktop, tablet and phone theme alike.
export function resolveRenderedWorkspaceTheme(workspaceTheme) {
  return workspaceTheme;
}
