// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// UX-UG-CARDS-WITH-NO-PADDING-TEXT-TOUCHES-THE-EDGE-20261122 (#9517),
// first unit: four demo pages where a card's text or a card sat off the edge
// its neighbours share. jsdom does no layout, so each check compares the
// declared inset with the inset of the thing it must line up with, in the
// same stylesheets the app loads, at desktop width and at the 900px step. The
// fixes were measured in the fixture app (see the record's review file).

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const styles = read("src/styles.css");
const network = read("src/features/unionCatalog/unionNetwork.css");
const staffGuides = read("src/features/onboardingGuideEngine/StaffGuides.css");
const orgStart = read("src/features/onboardingGuideEngine/OrgStartGuide.css");

// Top-level rules and the rules of every @media block, comments removed.
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const walk = (body, media) => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf("{", i);
      if (open < 0) break;
      const prelude = body.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < body.length && depth) {
        if (body[j] === "{") depth += 1;
        else if (body[j] === "}") depth -= 1;
        j += 1;
      }
      const inner = body.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) walk(inner, prelude);
      else out.push({ media, selectors: prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")), inner });
      i = j;
    }
  };
  walk(text, null);
  return out;
}

// The last value of `property` for `selector` (the cascade order inside one
// file), outside any @media block or inside the one named.
function declared(css, selector, property, media = null) {
  let value;
  for (const rule of rules(css)) {
    if (rule.media !== media || !rule.selectors.includes(selector)) continue;
    for (const declaration of rule.inner.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      if (declaration.slice(0, colon).trim() === property) value = declaration.slice(colon + 1).trim();
    }
  }
  return value;
}

// [left, right] of a padding or margin shorthand (1 to 4 values), so a
// mismatched right side cannot hide behind a matching left one.
function sides(shorthand) {
  const parts = String(shorthand).split(/\s+/);
  if (parts.length === 1) return [parts[0], parts[0]];
  if (parts.length === 4) return [parts[3], parts[1]];
  return [parts[1], parts[1]];
}

// [start, end] of a padding-inline or margin-inline value (1 or 2 values).
function inlineSides(value) {
  const parts = String(value).split(/\s+/);
  return parts.length === 1 ? [parts[0], parts[0]] : [parts[0], parts[1]];
}

const NARROW = "@media (max-width: 900px)";

describe("cards whose text touched the edge (#9517)", () => {

  it("A-9 Chapter partnerships: the Union network strip at the top of the card is inset like the card's head and body", () => {
    expect(inlineSides(declared(network, ".xus-card > .union-network-nav", "padding-inline")))
      .toEqual(sides(declared(styles, ".xus-cardbody", "padding")));
    expect(inlineSides(declared(network, ".xus-card > .union-network-nav", "padding-inline", NARROW)))
      .toEqual([declared(styles, ".xus-cardbody", "padding-left", NARROW), declared(styles, ".xus-cardbody", "padding-right", NARROW)]);
    expect(declared(network, ".xus-card > .union-network-nav", "margin")).toBe("0");
    expect(read("src/components/ChapterLifecycleAdmin.jsx")).toMatch(/className=\{`\$\{PLANE_CARD_CLASS\} xus-card role-section-target`\}[^>]*>\s*<UnionNetworkNav staff admin \/>/);
  });

  it("A-11 staff guides: the guide card, the guide list and the org-start guide beside a staff desk share its body's left edge", () => {
    const body = sides(declared(styles, ".xus-body", "padding"));
    const bodyNarrow = sides(declared(styles, ".xus-body", "padding", NARROW));
    expect(body).toEqual(["28px", "28px"]);
    for (const selector of [".member-guide-card.staff-guide-card", ".member-guide-list.staff-guide-list"]) {
      expect(inlineSides(declared(staffGuides, selector, "margin-inline")), selector).toEqual(body);
      expect(inlineSides(declared(staffGuides, selector, "margin-inline", NARROW)), selector).toEqual(bodyNarrow);
    }
    expect(inlineSides(declared(orgStart, ".org-start", "margin-inline"))).toEqual(body);
    expect(inlineSides(declared(orgStart, ".org-start", "margin-inline", NARROW))).toEqual(bodyNarrow);
    // They render beside the desk, not inside its padded body.
    expect(read("src/App.jsx")).toContain("return deskFirst ? <>{desk}{guides}</> : <>{guides}{desk}</>;");
  });

  it("B-14 Be heard: the title shares the body's column and the Compass workspace cards keep the column's edge", () => {
    expect(declared(styles, ".bevoice-screen--desktop .bevoice-ph", "width"))
      .toBe(declared(styles, ".bevoice-screen--desktop .bevoice-body", "width"));
    expect(declared(styles, ".bevoice-screen--desktop .bevoice-ph", "margin-inline")).toBe("auto");
    expect(declared(styles, ".bevoice-screen--desktop .bevoice-ph", "box-sizing")).toBe("border-box");
    expect(sides(declared(styles, ".bevoice-ph", "padding"))).toEqual(sides(declared(styles, ".bevoice-body", "padding")));
    expect(declared(styles, ".bevoice-body > .eng-root", "margin-inline")).toBe("0");
    // The engagement root is mounted straight inside the Be heard body.
    expect(read("src/features/engagement/MemberEngagement.jsx")).toContain('return <section className="eng-root" data-testid="member-engagement">');
    expect(read("src/views/VoiceView.jsx")).toMatch(/<div className="bevoice-body">[\s\S]*?<MemberEngagement [^\n]*\/>\}\n[\s\S]*?<\/div>/);
  });
});
