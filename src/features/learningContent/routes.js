// Learn's editor is addressable on two surfaces: /m/rights?learning=manage
// for the Member hat's Learn page, and /m/settings?learning=manage, which every
// hat may already open (a shared account view), so staff reach the editor
// without changing hat. The server still decides who may manage anything.
// Kept apart from the components so App can route without loading them.
export const LEARNING_SECTION_PARAM = "learning";

const LEARNING_SECTION_BASES = Object.freeze({ rights: "/m/rights", settings: "/m/settings" });

// "manage" when the query addresses the editor, else null. With a surface,
// the path must also be exactly that surface's page (not a Settings subpage).
export function learningSectionFromLocation(location, surface = null) {
  const [beforeHash] = String(location || "").split("#");
  const [pathname, query = ""] = beforeHash.split("?");
  if (surface) {
    const base = LEARNING_SECTION_BASES[surface];
    if (!base || (pathname.replace(/\/+$/, "") || "/") !== base) return null;
  }
  return new URLSearchParams(query).get(LEARNING_SECTION_PARAM) === "manage" ? "manage" : null;
}

export function learningSectionPath(section, surface = "rights") {
  const base = LEARNING_SECTION_BASES[surface] ?? LEARNING_SECTION_BASES.rights;
  return section === "manage" ? `${base}?${LEARNING_SECTION_PARAM}=manage` : base;
}
