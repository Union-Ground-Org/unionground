import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Mounts real stylesheets in the jsdom document so getComputedStyle runs the
// actual cascade. jsdom applies selector specificity and source order, but it
// skips @media and @container blocks, so only base rules show up in computed
// styles; read media-scoped rules with mediaRule() instead.
export function mountStylesheets(...paths) {
  const styles = (paths.length ? paths : ["src/styles.css"]).map((path) => {
    const style = document.createElement("style");
    style.textContent = readFileSync(join(root, path), "utf8");
    document.head.appendChild(style);
    return style;
  });
  return () => styles.forEach((style) => style.remove());
}

// The declaration block of the first top-level rule whose selector list
// contains `selector` exactly.
export function styleRule(selector) {
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule.selectorText && rule.selectorText.split(/\s*,\s*/).includes(selector)) return rule.style;
    }
  }
  return null;
}

// The declaration block for `selector` inside an @media rule whose condition
// contains `condition`, e.g. mediaRule("(max-width: 720px)", ".cam-filters").
export function mediaRule(condition, selector) {
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (!rule.media?.mediaText?.includes(condition)) continue;
      for (const inner of rule.cssRules) {
        if (inner.selectorText && inner.selectorText.split(/\s*,\s*/).includes(selector)) return inner.style;
      }
    }
  }
  return null;
}

// Every top-level declaration block whose selector list contains `selector`
// exactly, joined in source order. jsdom does not compute logical properties
// (padding-inline, border-block), so read those as declared text.
export function declaredFor(selector) {
  const blocks = [];
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule.selectorText && rule.selectorText.split(/\s*,\s*/).includes(selector)) blocks.push(rule.style.cssText);
    }
  }
  return blocks.join(" ");
}
