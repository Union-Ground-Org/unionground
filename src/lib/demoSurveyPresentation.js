import { t } from "./i18n.js";
import { bundledLegalReleaseFiles } from "./legalReleaseBundle.js";
import { fetchLegalDeployment, legalReleaseContextFromFiles, runLegalOperation } from "./legalReleaseGate.js";
import "./demoSurveyPresentation.css";

const OFFERED_KEY = "ug:demo-survey-offered:v1";
const MAIN = "main#main-content";
// The shell names the page it shows on main (data-view); Home is "today".
const HOME_VIEW = "today";
const shellOnHome = (doc) => doc?.querySelector(MAIN)?.dataset?.view === HOME_VIEW;

// A voluntary, normal-flow offer. The SDK still owns questions and responses;
// no automatic popover is allowed to cover the workspace. It sits on Home only
// (#9776): on any other page it waits off screen, so it never stands above
// that page's heading, and comes back when the visitor returns Home.
export async function loadDemoSurveyPresentation(options, files = bundledLegalReleaseFiles(), fetcher = globalThis.fetch) {
  const deployment = await fetchLegalDeployment(files, fetcher);
  return presentDemoSurvey({ ...options, files: { ...files, deployment } });
}

export function presentDemoSurvey({ display, onDismiss, doc = globalThis.document, files = bundledLegalReleaseFiles(), isEnabled = () => true, onHome = () => shellOnHome(doc) }) {
  const main = doc?.querySelector(MAIN);
  if (!main || doc.getElementById("ug-demo-survey-slot") || !isEnabled()) return null;
  try {
    const context = legalReleaseContextFromFiles(files);
    const path = "demo-survey-offer";
    if (!context.gatedPaths.some((entry) => entry.id === path)) return null;
    const publication = runLegalOperation("web", path, context, () => {
      const storage = window.sessionStorage;
      if (storage.getItem(OFFERED_KEY)) return false;
      storage.setItem(OFFERED_KEY, "1");
      return true;
    });
    if (!publication.result) return null;
  } catch { return null; }

  const lang = doc.documentElement.lang || "en";
  const section = doc.createElement("section");
  section.className = "demo-survey-slot";
  section.setAttribute("aria-label", t(lang, "demo.feedback"));
  const open = doc.createElement("button");
  open.type = "button";
  open.className = "dialog-secondary";
  open.textContent = t(lang, "demo.feedback");
  open.setAttribute("aria-controls", "ug-demo-survey-slot");
  open.setAttribute("aria-expanded", "false");
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "dialog-secondary demo-survey-close";
  close.textContent = t(lang, "dialogs.close");
  const slot = doc.createElement("div");
  slot.id = "ug-demo-survey-slot";
  slot.hidden = true;
  section.append(open, close, slot);
  let removed = false;
  let opened = false;
  const remove = () => { removed = true; section.remove(); };
  const place = () => {
    if (removed) return;
    if (!onHome()) {
      section.remove();
      return;
    }
    const target = doc.querySelector(MAIN);
    if (target && section.parentElement !== target) target.prepend(section);
  };
  const dismiss = () => {
    if (removed) return;
    const restoreFocus = section.contains(doc.activeElement);
    remove();
    if (restoreFocus) doc.querySelector(MAIN)?.focus({ preventScroll: true });
    onDismiss();
  };
  close.addEventListener("click", dismiss);
  section.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  open.addEventListener("click", () => {
    if (removed || opened) return;
    opened = true;
    open.setAttribute("aria-expanded", "true");
    slot.hidden = false;
    open.hidden = true;
    try { display("#ug-demo-survey-slot"); } catch { remove(); }
  });
  place();
  return { remove, place };
}
