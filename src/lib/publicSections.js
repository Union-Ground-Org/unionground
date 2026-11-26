import { useEffect, useState } from "react";

// REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117
// (#9038): public-page sections held for a later release, each carried by a
// platform definition features.public_pages.<section> and released by hand
// (docs/contracts/staged-feature-releases.md, "Sections of the public pages").
// A section is drawn only when /api/public-sections names it. Until the answer
// arrives, and after a failed read, every section reads held.
export const PUBLIC_SECTIONS = Object.freeze(["sign_in_design_2", "sign_in_design_3", "sign_in_design_4", "unions_map_3d"]);

export async function loadReleasedPublicSections(signal) {
  const response = await fetch("/api/public-sections", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("public-sections-unavailable");
  const data = await response.json();
  const named = Array.isArray(data?.released) ? data.released : [];
  return PUBLIC_SECTIONS.filter((section) => named.includes(section));
}

// One read per page load, shared by every section on the page. A failed read
// is forgotten, so the next page that asks reads again.
let pending = null;
function releasedPublicSections() {
  pending ??= loadReleasedPublicSections().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

export function forgetReleasedPublicSections() {
  pending = null;
}

// Whether one section is released. False while the read runs and after it
// fails, so a held section never flashes onto the page. No section (a caller
// that does not need one now) or an unknown name reads held and is never asked
// for. The answer belongs to the section it was read for:
// when the caller passes another section, the hook reads false at once, in
// the same render, until that section's own answer arrives.
export function usePublicSectionReleased(section) {
  const [answer, setAnswer] = useState({ section: null, released: false });
  useEffect(() => {
    if (!PUBLIC_SECTIONS.includes(section)) return undefined;
    let current = true;
    releasedPublicSections().then(
      (sections) => { if (current) setAnswer({ section, released: sections.includes(section) }); },
      () => { if (current) setAnswer({ section, released: false }); },
    );
    return () => { current = false; };
  }, [section]);
  return answer.section === section && answer.released;
}
