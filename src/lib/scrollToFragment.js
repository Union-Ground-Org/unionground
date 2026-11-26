// Scrolls to the element a URL fragment names ("#video") and says whether it
// did. A lazily loaded page calls this once it has drawn: the browser's own
// jump to the fragment ran before the element existed. No fragment, a
// malformed one or one that names nothing leaves the page where it is.
export function scrollToFragment(hash, doc) {
  let id;
  try {
    id = decodeURIComponent(String(hash).replace(/^#/, ""));
  } catch {
    // swallow-ok: a malformed fragment names no element, which is the answer.
    return false;
  }
  const target = id === "" ? null : doc.getElementById(id);
  if (!target || typeof target.scrollIntoView !== "function") return false;
  target.scrollIntoView();
  return true;
}
