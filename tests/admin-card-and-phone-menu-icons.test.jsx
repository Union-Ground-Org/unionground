import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { NavGlyph } from "../src/components/NavGlyphs.jsx";

// UX-UG-FOLDED-RAIL-AND-COMMAND-PALETTE-ICONS-REPEAT-20261122 (#9565).

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.jsx?$/.test(name) ? [path] : [];
  });
}

// A-18: six Admin card headers drew a text symbol (✉ ⇪ ↻ ◈ ⚙ ⌘) where every
// other Admin card draws a line icon. A card header's glyph is an icon element.
it("gives every card header glyph a line icon, never a text symbol", () => {
  const textGlyphs = sourceFiles("src").flatMap((file) => [...readFileSync(file, "utf8")
    .matchAll(/className="xus-glyph" aria-hidden="true">([^<{\s][^<]*)</g)]
    .map((match) => `${file}: ${match[1]}`));
  expect(textGlyphs).toEqual([]);
});

const glyph = (name) => render(<NavGlyph name={name} />).container.querySelector("svg").innerHTML;

// B-36: Pulse and Find my steward had no glyph of their own and both drew the
// default page glyph in the phone menu and the shortcut editor. Each now draws
// its promo package icon (kit/brand/theme/icons.json "pulse" and "chapters").
it("draws Pulse and Find my steward with their own package icons, apart from each other and the default", () => {
  const pulse = glyph("pulse");
  const findSteward = glyph("find-steward");
  const fallback = glyph("default");
  expect(new Set([pulse, findSteward, fallback]).size).toBe(3);
  expect(pulse).toBe('<path d="M3.4 12.4h3.7l2.3-6.2 4.3 12 2.4-5.8h4.5"></path>');
  expect(findSteward).toBe('<circle cx="9" cy="8.6" r="3.2"></circle><path d="M3.4 19.6c.4-3.3 2.6-5.3 5.6-5.3s5.2 2 5.6 5.3"></path><path d="M15.4 5.7a3.2 3.2 0 0 1 0 5.9M17.2 14.6c1.9.7 3.1 2.4 3.4 5"></path>');
});
