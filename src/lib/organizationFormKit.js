// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: the small script and style
// every organization HTML form carries while a member fills it, and inside the
// self-contained HTML file a member saves. It never changes the organization's
// own scripts, print layout or PDF builder; it only adds what the owner asked
// for on top of them:
//
//   * snapshot(): the whole document with the entered values written into the
//     markup (inputs, choices, text areas, editable text) and the signatures
//     saved as data, marked data-ug-form-instance="completed" so it can never
//     be imported back as a blank template.
//   * on load, the saved signatures are drawn again (the form's own signature
//     pads through their getData/setData, or plain signature canvases).
//   * inside the app (data-ug-form-frame="embedded"), the parent page asks for
//     the snapshot and for printing over postMessage; the app owns Save,
//     Email and Print there. A page-capture PDF builder (html2canvas) cannot
//     run in the opaque-origin sandbox, so in the app it reports that and
//     points to Print or the saved file, where the builder runs unchanged.
//   * opened on its own (a saved file), it shows Save HTML, Email HTML and
//     Print. Email shares the file where the browser can; otherwise it
//     downloads the file, opens an email draft and says plainly that the file
//     must be attached by hand. Nothing is ever sent automatically.
//
// The source is a plain string (no template substitutions) so the exact bytes
// travel into the saved file. Keep it ES2017 and free of backticks.

export const ORG_FORM_KIT_ID = "ug-org-form-kit";
export const ORG_FORM_KIT_STYLE_ID = "ug-org-form-kit-style";
export const ORG_FORM_KIT_COPY_ID = "ug-org-form-kit-copy";
export const ORG_FORM_ACTIONS_ID = "ug-org-form-actions";
export const ORG_FORM_SIGNATURES_ID = "ug-saved-signatures";
export const ORG_FORM_INSTANCE_ATTRIBUTE = "data-ug-form-instance";
export const ORG_FORM_FRAME_ATTRIBUTE = "data-ug-form-frame";

// Contrast pairs measured for the standalone controls (16.42:1 text, 4.76:1
// border, 7.56:1 focus). Light only (REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105).
export const ORG_FORM_KIT_STYLE = [
  "#ug-org-form-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0;padding:8px 12px;background:#ffffff;color:#18202a;border-bottom:1px solid #64748b;font:14px/1.4 system-ui,sans-serif;box-sizing:border-box;max-width:100%}",
  "#ug-org-form-actions button{min-height:48px;min-width:48px;padding:10px 14px;border:1px solid #64748b;border-radius:8px;background:#ffffff;color:#18202a;font:600 14px/1.4 system-ui,sans-serif;cursor:pointer}",
  "#ug-org-form-actions button:focus-visible{outline:3px solid #075985;outline-offset:2px}",
  "#ug-org-form-actions p{flex-basis:100%;margin:0;min-height:1.4em}",
  "@media print{#ug-org-form-actions{display:none!important}}",
  // REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: the mark beside a
  // field filled from the member's profile (9.65:1).
  ".ug-profile-filled{display:inline-block;margin:2px 0 0 6px;padding:1px 6px;border-radius:6px;background:#e7f4ec;color:#14532d;font:600 12px/1.4 system-ui,sans-serif}",
  "@media print{.ug-profile-filled{display:none!important}}",
  // The frame loads no remote icon font, so an icon ligature would show its
  // name; the phone step navigation keeps its text labels instead.
  ".mobile-ui nav .material-symbols-outlined{display:none!important}",
  ".mobile-ui nav button{min-width:0;min-height:48px;padding-left:8px!important;padding-right:8px!important}",
].join("\n");

export const ORG_FORM_KIT_SOURCE = String.raw`(function () {
  "use strict";
  if (window.__ugOrgFormKit) return;
  window.__ugOrgFormKit = true;
  var root = document.documentElement;
  var embedded = root.getAttribute("data-ug-form-frame") === "embedded" && window.parent !== window;
  var copy = {};
  try {
    var copyNode = document.getElementById("ug-org-form-kit-copy");
    if (copyNode) copy = JSON.parse(copyNode.textContent || "{}") || {};
  } catch (error) { copy = {}; }
  function text(key, fallback) { return typeof copy[key] === "string" && copy[key] ? copy[key] : fallback; }
  function setStatus(message) {
    var node = document.getElementById("ug-org-form-status");
    if (node) node.textContent = message;
  }
  var SIGNATURE_NAME = /sig/i;
  function pads() { return window._sigPads && typeof window._sigPads === "object" ? window._sigPads : {}; }
  // A canvas is saved under its id, or, without one, under its position among
  // the document's canvases ("canvas 3"). A conforming HTML id never contains
  // a space, but an imported form may still carry a literal "canvas 3" id, so
  // a canvas with that exact id wins and the position is only the fallback.
  function canvasKey(canvas, index) { return canvas.id ? canvas.id : "canvas " + index; }
  function canvasFor(key) {
    var exact = document.getElementById(key);
    if (exact && exact.tagName === "CANVAS") return exact;
    var position = /^canvas (\d+)$/.exec(key);
    return position ? document.querySelectorAll("canvas")[Number(position[1])] || null : exact;
  }
  function signatureCanvases() {
    var live = pads();
    var found = [];
    Array.prototype.forEach.call(document.querySelectorAll("canvas"), function (canvas, index) {
      if (canvas.id && live[canvas.id]) return;
      if (canvas.hasAttribute("data-ug-signature") || SIGNATURE_NAME.test(canvas.id || "")
        || SIGNATURE_NAME.test(String(canvas.className || ""))) found.push({ key: canvasKey(canvas, index), canvas: canvas });
    });
    return found;
  }
  function collectSignatures() {
    var saved = { version: 1, pads: {}, canvases: {} };
    var live = pads();
    Object.keys(live).forEach(function (id) {
      var pad = live[id];
      try { if (pad && typeof pad.getData === "function") saved.pads[id] = pad.getData(); } catch (error) { /* keep the rest */ }
    });
    signatureCanvases().forEach(function (entry) {
      try { saved.canvases[entry.key] = entry.canvas.toDataURL("image/png"); } catch (error) { /* keep the rest */ }
    });
    return saved;
  }
  var SKIPPED_INPUTS = { file: true, button: true, submit: true, reset: true, image: true };
  function bakeValues(clone) {
    var live = document.querySelectorAll("input,select,textarea");
    var copies = clone.querySelectorAll("input,select,textarea");
    for (var i = 0; i < live.length; i += 1) {
      var source = live[i];
      var target = copies[i];
      if (!target || target.tagName !== source.tagName) continue;
      if (source.tagName === "INPUT") {
        var type = String(source.type || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          if (source.checked) target.setAttribute("checked", "checked");
          else target.removeAttribute("checked");
        } else if (!SKIPPED_INPUTS[type]) {
          target.setAttribute("value", source.value || "");
        }
      } else if (source.tagName === "TEXTAREA") {
        target.textContent = source.value || "";
      } else {
        var options = target.querySelectorAll("option");
        for (var j = 0; j < options.length; j += 1) {
          if (source.options[j] && source.options[j].selected) options[j].setAttribute("selected", "selected");
          else options[j].removeAttribute("selected");
        }
      }
    }
    var liveEditable = document.querySelectorAll("[contenteditable]:not([contenteditable=false])");
    var copyEditable = clone.querySelectorAll("[contenteditable]:not([contenteditable=false])");
    for (var k = 0; k < liveEditable.length; k += 1) {
      if (copyEditable[k]) copyEditable[k].innerHTML = liveEditable[k].innerHTML;
    }
  }
  function snapshot() {
    if (typeof window.syncMobileToDesktop === "function") {
      try { window.syncMobileToDesktop(); } catch (error) { /* the form's own sync is best effort */ }
    }
    var raw;
    if (typeof window._buildSnapshotHTML === "function") {
      raw = String(window._buildSnapshotHTML());
    } else {
      var clone = root.cloneNode(true);
      bakeValues(clone);
      raw = "<!doctype html>\n" + clone.outerHTML;
    }
    var doc = new DOMParser().parseFromString(raw, "text/html");
    var html = doc.documentElement;
    html.removeAttribute("data-ug-form-frame");
    html.setAttribute("data-ug-form-instance", "completed");
    var actions = doc.getElementById("ug-org-form-actions");
    if (actions) actions.parentNode.removeChild(actions);
    var data = doc.getElementById("ug-saved-signatures");
    if (!data) {
      data = doc.createElement("script");
      data.setAttribute("type", "application/json");
      data.id = "ug-saved-signatures";
      doc.body.appendChild(data);
    }
    data.textContent = JSON.stringify(collectSignatures()).replace(/</g, "\\u003c");
    return "<!doctype html>\n" + html.outerHTML;
  }
  function restoreSignatures() {
    var node = document.getElementById("ug-saved-signatures");
    if (!node) return;
    var saved;
    try { saved = JSON.parse(node.textContent || "{}") || {}; } catch (error) {
      setStatus(text("restoreFailed", "A saved signature could not be restored. Check the signature boxes."));
      return;
    }
    var savedPads = saved.version === 1 ? saved.pads || {} : saved;
    var savedCanvases = saved.version === 1 ? saved.canvases || {} : {};
    var live = pads();
    Object.keys(savedPads).forEach(function (id) {
      var pad = live[id];
      if (pad && typeof pad.setData === "function") {
        try { pad.setData(savedPads[id]); } catch (error) {
          setStatus(text("restoreFailed", "A saved signature could not be restored. Check the signature boxes."));
        }
      }
    });
    Object.keys(savedCanvases).forEach(function (id) {
      var canvas = canvasFor(id);
      var source = savedCanvases[id];
      if (!canvas || !canvas.getContext || typeof source !== "string" || source.indexOf("data:image/") !== 0) return;
      var image = new Image();
      image.onload = function () {
        var context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      };
      image.src = source;
    });
  }
  function fileName() {
    var base = String(document.title || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return (base || "form") + ".html";
  }
  function download(file) {
    var url = URL.createObjectURL(file);
    var link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function currentFile() { return new File([snapshot()], fileName(), { type: "text/html" }); }
  function saveHtml() {
    download(currentFile());
    setStatus(text("saved", "Saved. Open the HTML file to keep editing, print or send it."));
  }
  function emailHtml() {
    var file = currentFile();
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: document.title || file.name }).then(function () {
        setStatus(text("shared", "Shared the HTML file. Sending it is up to the app you chose."));
      }, function (error) {
        if (error && error.name === "AbortError") setStatus(text("shareCancelled", "Sharing was cancelled. Nothing was sent."));
        else setStatus(text("shareFailed", "Sharing could not finish. Use Save HTML and attach the file to an email yourself."));
      });
    }
    download(file);
    var body = text("draftBody", "Attach the downloaded file before sending:") + " " + file.name;
    window.location.href = "mailto:?subject=" + encodeURIComponent(document.title || file.name) + "&body=" + encodeURIComponent(body);
    setStatus(text("drafted", "Downloaded the HTML file and opened an email draft. Attach the file yourself before sending; nothing was attached or sent."));
    return Promise.resolve();
  }
  function button(label, action) {
    var node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.addEventListener("click", action);
    return node;
  }
  function mountActions() {
    if (embedded || !document.body || document.getElementById("ug-org-form-actions")) return;
    var bar = document.createElement("div");
    bar.id = "ug-org-form-actions";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", text("region", "Save or send this form"));
    bar.appendChild(button(text("save", "Save HTML"), saveHtml));
    bar.appendChild(button(text("email", "Email HTML"), emailHtml));
    bar.appendChild(button(text("print", "Print"), function () { window.print(); }));
    var status = document.createElement("p");
    status.id = "ug-org-form-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    bar.appendChild(status);
    document.body.insertBefore(bar, document.body.firstChild);
  }
  function post(message) { try { window.parent.postMessage(message, "*"); } catch (error) { /* parent gone */ } }
  // Profile autofill (REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030):
  // list the empty text fields, fill only the ones the app sends after the
  // member's yes, mark each, and drop a mark once the member edits its field.
  var FILLED = "data-ug-profile-filled";
  var filling = false;
  function fieldLabel(node) {
    var label = node.id ? document.querySelector("label[for=\"" + node.id.replace(/["\\]/g, "\\$&") + "\"]") : null;
    if (!label && node.closest) label = node.closest("label");
    var named = node.getAttribute("aria-label") || (label ? label.textContent : "") || node.getAttribute("placeholder") || node.getAttribute("title") || "";
    return String(named).replace(/\s+/g, " ").trim().slice(0, 200);
  }
  function isText(node) {
    if (node.disabled || node.readOnly) return false;
    if (node.tagName === "TEXTAREA") return true;
    var type = String(node.getAttribute("type") || "text").toLowerCase();
    return type === "text" || type === "search";
  }
  // A form with phone and desktop views keeps a hidden mirror of each field.
  // Fields that share a name are listed once (the one the member can see,
  // else the first) and their hidden mirrors are filled with it; a field in a
  // later, still-hidden step is listed too, so it fills with the rest. Visible
  // controls are listed before hidden ones.
  function isShown(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.hidden) return false;
      var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    }
    return true;
  }
  // Mirrors share a name and an owner form; a same-name control of another
  // form (a witness's section, say) is a different field.
  function ownerOf(node) { return Array.prototype.indexOf.call(document.forms, node.form); }
  function mirrorKey(node) {
    var name = node.getAttribute("name");
    return name ? name + "\u0000" + ownerOf(node) : "";
  }
  function textFields() {
    var all = Array.prototype.filter.call(document.querySelectorAll("input,textarea"), isText);
    var byKey = {};
    var picked = [];
    all.forEach(function (node) {
      var key = mirrorKey(node);
      if (!key) { picked.push(node); return; }
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) { byKey[key] = picked.length; picked.push(node); return; }
      if (!isShown(picked[byKey[key]]) && isShown(node)) picked[byKey[key]] = node;
    });
    return picked.filter(isShown).concat(picked.filter(function (node) { return !isShown(node); }));
  }
  function mirrorsOf(node) {
    var key = mirrorKey(node);
    if (!key) return [];
    return Array.prototype.filter.call(document.querySelectorAll("input,textarea"), function (other) {
      return other !== node && mirrorKey(other) === key && isText(other) && !isShown(other) && String(other.value || "") === "";
    });
  }
  function unmark(node) {
    node.removeAttribute(FILLED);
    var note = node.nextElementSibling;
    if (note && note.classList && note.classList.contains("ug-profile-filled")) note.parentNode.removeChild(note);
  }
  // The hidden mirrors this kit filled alongside a control, still marked.
  function filledMirrors(node) {
    var key = mirrorKey(node);
    if (!key) return [];
    return Array.prototype.filter.call(document.querySelectorAll("[" + FILLED + "]"), function (other) {
      return other !== node && mirrorKey(other) === key && !isShown(other);
    });
  }
  // An edit drops the mark, and the hidden mirrors filled with the profile
  // value follow the member's value from then on, so a saved file never keeps
  // a detail the member replaced.
  function watchFilled(node) {
    node.addEventListener("input", function onEdit() {
      if (filling) return;
      var mirrors = filledMirrors(node);
      unmark(node);
      mirrors.forEach(unmark);
      node.removeEventListener("input", onEdit);
      if (!mirrors.length) return;
      function follow() {
        mirrors.forEach(function (mirror) {
          if (String(mirror.value || "") === String(node.value || "")) return;
          filling = true;
          try {
            mirror.value = node.value;
            mirror.dispatchEvent(new Event("input", { bubbles: true }));
            mirror.dispatchEvent(new Event("change", { bubbles: true }));
          } finally { filling = false; }
        });
      }
      node.addEventListener("input", follow);
      node.addEventListener("change", follow);
      follow();
    });
  }
  function listFields() {
    return textFields().map(function (node, index) {
      node.setAttribute("data-ug-af", "f" + index);
      return { ref: "f" + index, name: String(node.getAttribute("name") || node.id || ""), label: fieldLabel(node), autocomplete: String(node.getAttribute("autocomplete") || ""), filled: String(node.value || "") !== "" };
    });
  }
  function fillFields(fills) {
    var filled = [];
    (Array.isArray(fills) ? fills : []).forEach(function (fill) {
      if (!fill || typeof fill.ref !== "string" || typeof fill.value !== "string") return;
      var node = document.querySelector("[data-ug-af=\"" + fill.ref.replace(/[^a-z0-9]/gi, "") + "\"]");
      if (!node || String(node.value || "") !== "") return;
      [node].concat(mirrorsOf(node)).forEach(function (target) {
        filling = true;
        try {
          target.value = fill.value.slice(0, 500);
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        } finally { filling = false; }
        target.setAttribute(FILLED, String(fill.kind || "profile").replace(/[^A-Za-z]/g, ""));
        var note = document.createElement("span");
        note.className = "ug-profile-filled";
        note.textContent = text("profileFilled", "From your profile");
        if (target.parentNode) target.parentNode.insertBefore(note, target.nextSibling);
        watchFilled(target);
      });
      filled.push(fill.ref);
    });
    return filled;
  }
  window.ugOrgFormSnapshot = snapshot;
  if (embedded && typeof window.html2canvas === "function") {
    // A page-capture PDF builder clones the page into a nested frame, which
    // the opaque-origin sandbox cannot read. Say so instead of failing
    // silently; the saved file runs the organization's builder unchanged.
    window.html2canvas = function () {
      post({ type: "ug-org-form:pdf-unavailable" });
      return Promise.reject(new Error(text("pdfInApp", "Use Print and choose Save as PDF, or save the HTML file and use this button there.")));
    };
  }
  if (embedded) {
    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      var data = event.data || {};
      if (data.type === "ug-org-form:snapshot") {
        var result = { type: "ug-org-form:snapshot-result", requestId: data.requestId, title: String(document.title || "") };
        try { result.html = snapshot(); } catch (error) { result.error = "snapshot_failed"; }
        post(result);
      } else if (data.type === "ug-org-form:print") {
        window.print();
      } else if (data.type === "ug-org-form:fields") {
        post({ type: "ug-org-form:fields-result", fields: listFields() });
      } else if (data.type === "ug-org-form:autofill") {
        post({ type: "ug-org-form:autofill-result", filled: fillFields(data.fills) });
      }
    });
  }
  function ready() {
    mountActions();
    restoreSignatures();
    Array.prototype.forEach.call(document.querySelectorAll("[" + FILLED + "]"), watchFilled);
    if (embedded) post({ type: "ug-org-form:ready", title: String(document.title || "") });
  }
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready, { once: true });
})();`;
