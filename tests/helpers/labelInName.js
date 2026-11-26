// BUG-UG-ACCESSIBLE-NAMES-CONTAIN-VISIBLE-LABELS-20261102: a jsdom
// stand-in for axe's label-content-name-mismatch (WCAG 2.5.3). jsdom has no
// layout, so "visible" means every text node outside screen-reader-only
// copy and closed tooltips; aria-hidden text still counts, because sighted
// users see it. Words are compared the way axe compares them: parentheticals
// dropped, punctuation folded to spaces, and the visible words must appear as
// one contiguous run inside the accessible name. Adjacent elements are joined
// without a separator, as axe 4.14 does, so a missing space is caught too.

const HIDDEN = ".sr-only, .visually-hidden, [role='tooltip'], [hidden]";

function words(text) {
  let value = text.normalize("NFKD").toLowerCase();
  let previous;
  do {
    previous = value;
    value = value.replace(/\([^()]*\)/g, "");
  } while (value !== previous);
  return value.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
}

export function visibleText(element) {
  let text = "";
  for (const child of element.childNodes) {
    if (child.nodeType === 3) text += child.nodeValue;
    else if (child.nodeType === 1 && !child.matches(HIDDEN)) text += visibleText(child);
  }
  return text;
}

export function labelInNameMismatch(element) {
  const label = words(visibleText(element));
  const name = words(element.getAttribute("aria-label") ?? visibleText(element));
  if (!label.length) return null;
  for (let start = 0; start + label.length <= name.length; start += 1) {
    if (label.every((word, index) => name[start + index] === word)) return null;
  }
  return { name: element.getAttribute("aria-label"), visible: visibleText(element) };
}

export function labelInNameMismatches(elements) {
  return [...elements].map(labelInNameMismatch).filter(Boolean);
}
