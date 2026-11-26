// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: an organization's own
// fillable HTML forms (owner direction, October 30, 2026).
//
// An organization administrator imports the organization's form file. Before
// it is stored, prepareBlankOrganizationForm() makes it a reusable blank
// template: entered values, chosen answers, text area contents, reset defaults
// (data-default), saved signatures and earlier export controls are removed,
// while the official wording, labels, choices, scripts, stylesheets and the
// organization's own print/PDF builder stay byte-for-byte. Parsing never runs
// the file's scripts.
//
// Members fill the form inside /org-form-frame.html (an opaque-origin sandbox
// with its own Content-Security-Policy), with organizationFormKit.js added by
// buildOrganizationFormFrameDocument(). A completed form is the member's own:
// it is saved to their device as one self-contained HTML file, reopened from
// that file, and never uploaded or turned back into a template.

import {
  ORG_FORM_ACTIONS_ID,
  ORG_FORM_FRAME_ATTRIBUTE,
  ORG_FORM_INSTANCE_ATTRIBUTE,
  ORG_FORM_KIT_COPY_ID,
  ORG_FORM_KIT_ID,
  ORG_FORM_KIT_SOURCE,
  ORG_FORM_KIT_STYLE,
  ORG_FORM_KIT_STYLE_ID,
  ORG_FORM_SIGNATURES_ID,
} from "./organizationFormKit.js";

export const ORG_FORM_MAX_BYTES = 4 * 1024 * 1024;
// A completed file is the template plus the kit, the entered answers and the
// signature data, so it may grow past the template limit. Saved files are
// read with this separate, larger allowance (the picker checks it too).
export const ORG_FORM_SAVED_MAX_BYTES = 16 * 1024 * 1024;
export const ORG_FORM_FRAME_PATH = "/org-form-frame.html";
// No same-origin: the form's own scripts run in an opaque origin and can read
// nothing of the app. Downloads (Save, the form's PDF) and modals (print) stay
// available inside the frame. No popups and no top navigation: a new top-level
// window would leave these limits, and the app's own Save and Email HTML
// actions replace the form's email links. A frame can still navigate itself,
// which no sandbox or CSP setting blocks, so only forms an organization
// administrator imported under attestation run here and the parent sends the
// frame nothing but that form document.
export const ORG_FORM_FRAME_SANDBOX = "allow-scripts allow-downloads allow-forms allow-modals";

export class OrganizationFormError extends Error {
  constructor(code) {
    super(code);
    this.name = "OrganizationFormError";
    this.code = code;
  }
}

const VALUE_FREE_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file"]);
// One id or class token that names a signature: "sig", "m-sig-grievant",
// "sig2", "signature", "esignature-box"; never a word such as "design".
const SIGNATURE_TOKEN = /(^|[-_])sigs?($|[-_\d])|signature/i;
// Editable answer areas a form fills like a field; "false" opts a node out.
const EDITABLE_ANSWER_SELECTOR = "[contenteditable]:not([contenteditable=false])";
// Kit nodes, and the export controls an earlier standalone conversion added.
const SUPERSEDED_SELECTORS = [
  `#${ORG_FORM_KIT_ID}`, `#${ORG_FORM_KIT_STYLE_ID}`, `#${ORG_FORM_KIT_COPY_ID}`, `#${ORG_FORM_ACTIONS_ID}`,
  `#${ORG_FORM_SIGNATURES_ID}`, "#ug-html-export", "#ug-html-actions-style", ".ug-html-actions", ".ug-html-toolbar-button",
];

export function htmlByteLength(html) {
  return new TextEncoder().encode(String(html ?? "")).length;
}

function parse(html, DOMParserImpl, maxBytes = ORG_FORM_MAX_BYTES) {
  if (typeof html !== "string" || html.trim() === "") throw new OrganizationFormError("not_html");
  if (htmlByteLength(html) > maxBytes) throw new OrganizationFormError(maxBytes === ORG_FORM_MAX_BYTES ? "too_large" : "saved_too_large");
  const Parser = DOMParserImpl || globalThis.DOMParser;
  const doc = new Parser().parseFromString(html, "text/html");
  if (!doc?.documentElement || !doc.body) throw new OrganizationFormError("not_html");
  return doc;
}

function serialize(doc) {
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function removeSuperseded(doc) {
  let removed = 0;
  for (const selector of SUPERSEDED_SELECTORS) {
    for (const node of doc.querySelectorAll(selector)) {
      node.remove();
      removed += 1;
    }
  }
  return removed;
}

function namesSignature(node) {
  return ["id", "class"].some((attribute) => (node.getAttribute(attribute) || "").split(/\s+/).some((token) => SIGNATURE_TOKEN.test(token)));
}

// The image itself or any ancestor up to the document element.
function inSignatureArea(image) {
  for (let node = image; node && node.nodeType === 1; node = node.parentElement) {
    if (namesSignature(node)) return true;
  }
  return false;
}

function fieldName(element, index) {
  return element.getAttribute("id") || element.getAttribute("name") || `${element.tagName.toLowerCase()}-${index + 1}`;
}

export function isCompletedOrganizationForm(html, DOMParserImpl) {
  const doc = parse(html, DOMParserImpl, ORG_FORM_SAVED_MAX_BYTES);
  return doc.documentElement.hasAttribute(ORG_FORM_INSTANCE_ATTRIBUTE) || Boolean(doc.getElementById(ORG_FORM_SIGNATURES_ID));
}

// Returns the blank template and what was removed. The report names fields by
// id or name only; it never repeats a removed value.
export function prepareBlankOrganizationForm(html, { DOMParserImpl } = {}) {
  const doc = parse(html, DOMParserImpl);
  const root = doc.documentElement;
  // A saved file in the earlier format carries only its signature data, not
  // the root marker; it is a member's completed form all the same
  // (PR 6599).
  if (root.hasAttribute(ORG_FORM_INSTANCE_ATTRIBUTE) || doc.getElementById(ORG_FORM_SIGNATURES_ID)) throw new OrganizationFormError("completed_instance");
  const fields = [...doc.querySelectorAll("input, textarea, select")];
  if (fields.length === 0) throw new OrganizationFormError("no_fields");

  const removedExportControls = removeSuperseded(doc);
  root.removeAttribute(ORG_FORM_FRAME_ATTRIBUTE);
  const cleared = new Set();
  fields.forEach((element, index) => {
    let changed = false;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (!VALUE_FREE_INPUTS.has(type) && element.hasAttribute("value")) {
        changed = element.getAttribute("value") !== "";
        element.setAttribute("value", "");
      }
      if (element.hasAttribute("checked")) {
        changed = true;
        element.removeAttribute("checked");
      }
    } else if (tag === "textarea") {
      changed = element.textContent.trim() !== "";
      element.textContent = "";
    } else {
      const options = [...element.querySelectorAll("option")];
      const chosen = options.filter((option) => option.hasAttribute("selected"));
      let empty = options.find((option) => (option.getAttribute("value") ?? option.textContent) === "");
      if (chosen.some((option) => option !== empty)) changed = true;
      for (const option of chosen) option.removeAttribute("selected");
      if (!element.hasAttribute("multiple")) {
        if (!empty) {
          empty = doc.createElement("option");
          empty.setAttribute("value", "");
          empty.textContent = "Select an option";
          element.insertBefore(empty, element.firstChild);
        }
        empty.setAttribute("selected", "selected");
      }
    }
    if (element.hasAttribute("data-default")) {
      changed = changed || element.getAttribute("data-default") !== "";
      element.removeAttribute("data-default");
    }
    if (changed) {
      cleared.add(fieldName(element, index));
      // A formerly fixed value (an employer, a unit) must now be fillable,
      // whether it was locked readonly, disabled or by a disabled fieldset.
      element.removeAttribute("readonly");
      element.removeAttribute("disabled");
      element.closest("fieldset[disabled]")?.removeAttribute("disabled");
    }
  });
  // An editable answer area (contenteditable) is an answer like a field: the
  // kit saves its contents, so a template must start with it empty.
  const editables = [...doc.querySelectorAll(EDITABLE_ANSWER_SELECTOR)].filter((node) => !node.parentElement?.closest(EDITABLE_ANSWER_SELECTOR));
  editables.forEach((node, index) => {
    if (node.textContent.trim() !== "" || node.querySelector("img, svg, canvas")) cleared.add(fieldName(node, index));
    node.replaceChildren();
  });
  for (const node of doc.querySelectorAll("[data-default]")) {
    if (node.getAttribute("data-default") !== "") cleared.add(fieldName(node, 0));
    node.removeAttribute("data-default");
  }
  let removedSignatureImages = 0;
  for (const image of doc.querySelectorAll("img[src^='data:image']")) {
    if (inSignatureArea(image)) {
      image.removeAttribute("src");
      removedSignatureImages += 1;
    }
  }
  return {
    html: serialize(doc),
    title: (doc.title || "").trim(),
    fieldCount: fields.length + editables.length,
    clearedFieldIds: [...cleared],
    removedExportControls,
    removedSignatureImages,
  };
}

// The document a frame loads: the blank template or a member's saved file,
// with the kit (and its copy) in place of any earlier copy of it.
export function buildOrganizationFormFrameDocument(html, { copy = {}, embedded = true, DOMParserImpl } = {}) {
  const doc = parse(html, DOMParserImpl, ORG_FORM_SAVED_MAX_BYTES);
  for (const selector of [`#${ORG_FORM_KIT_ID}`, `#${ORG_FORM_KIT_STYLE_ID}`, `#${ORG_FORM_KIT_COPY_ID}`, `#${ORG_FORM_ACTIONS_ID}`]) {
    for (const node of doc.querySelectorAll(selector)) node.remove();
  }
  if (embedded) doc.documentElement.setAttribute(ORG_FORM_FRAME_ATTRIBUTE, "embedded");
  else doc.documentElement.removeAttribute(ORG_FORM_FRAME_ATTRIBUTE);
  const style = doc.createElement("style");
  style.id = ORG_FORM_KIT_STYLE_ID;
  style.textContent = ORG_FORM_KIT_STYLE;
  (doc.head || doc.documentElement).appendChild(style);
  const copyNode = doc.createElement("script");
  copyNode.setAttribute("type", "application/json");
  copyNode.id = ORG_FORM_KIT_COPY_ID;
  copyNode.textContent = JSON.stringify(copy).replace(/</g, "\\u003c");
  doc.body.appendChild(copyNode);
  const kit = doc.createElement("script");
  kit.id = ORG_FORM_KIT_ID;
  kit.textContent = ORG_FORM_KIT_SOURCE;
  doc.body.appendChild(kit);
  return serialize(doc);
}

// A file a member chose to continue: only a completed organization form.
export function readSavedOrganizationForm(html, { DOMParserImpl } = {}) {
  const doc = parse(html, DOMParserImpl, ORG_FORM_SAVED_MAX_BYTES);
  const completed = doc.documentElement.hasAttribute(ORG_FORM_INSTANCE_ATTRIBUTE) || Boolean(doc.getElementById(ORG_FORM_SIGNATURES_ID));
  if (!completed) throw new OrganizationFormError("not_saved_form");
  if (!doc.querySelector("input, textarea, select")) throw new OrganizationFormError("no_fields");
  return { html, title: (doc.title || "").trim() };
}

export function organizationFormFileName(title) {
  const base = String(title ?? "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${base || "form"}.html`;
}

export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function downloadOrganizationFormHtml(html, title, { doc = globalThis.document, urls = globalThis.URL } = {}) {
  const name = organizationFormFileName(title);
  const file = new File([html], name, { type: "text/html" });
  const url = urls.createObjectURL(file);
  const link = doc.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => urls.revokeObjectURL(url), 60_000);
  return { file, name };
}

// Email/share as HTML. Where the browser can share files, the system share
// sheet gets the HTML file; sending stays the member's own action there.
// Otherwise (or when that share is refused) the file downloads and an email
// draft opens, and the outcome says the member must attach the file: it never
// claims an attachment or a send.
export async function shareOrganizationFormHtml(html, title, {
  nav = globalThis.navigator,
  doc = globalThis.document,
  urls = globalThis.URL,
  draftBody = "Attach the downloaded file before sending:",
} = {}) {
  const name = organizationFormFileName(title);
  const file = new File([html], name, { type: "text/html" });
  if (nav?.canShare && nav?.share && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: title || name });
      return { outcome: "shared", name };
    } catch (error) {
      if (error?.name === "AbortError") return { outcome: "cancelled", name };
      // A refused share (for example, no user activation left) falls through
      // to the download and draft below.
    }
  }
  downloadOrganizationFormHtml(html, title, { doc, urls });
  const link = doc.createElement("a");
  link.href = `mailto:?subject=${encodeURIComponent(title || name)}&body=${encodeURIComponent(`${draftBody} ${name}`)}`;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  return { outcome: "downloaded_with_draft", name };
}
