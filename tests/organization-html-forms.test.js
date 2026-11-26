// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: blank templates, the kit a
// filled form carries, saved-file reopening and the honest email fallback.
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  ORG_FORM_FRAME_SANDBOX,
  ORG_FORM_MAX_BYTES,
  ORG_FORM_SAVED_MAX_BYTES,
  OrganizationFormError,
  buildOrganizationFormFrameDocument,
  downloadOrganizationFormHtml,
  htmlByteLength,
  isCompletedOrganizationForm,
  organizationFormFileName,
  prepareBlankOrganizationForm,
  readSavedOrganizationForm,
  sha256Hex,
  shareOrganizationFormHtml,
} from "../src/lib/organizationHtmlForms.js";
import { ORG_FORM_KIT_SOURCE } from "../src/lib/organizationFormKit.js";
import { FILLED_SAMPLE_FORM, OFFICIAL_BUILDER } from "./fixtures/organization-html-form.js";

const parse = (html) => new DOMParser().parseFromString(html, "text/html");
const codeOf = (fn) => {
  try { fn(); } catch (error) { return error instanceof OrganizationFormError ? error.code : error.message; }
  return null;
};

function runDocument(html, setup = () => {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => { if (!/navigation/i.test(error.message)) errors.push(error); });
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole, url: "https://example.invalid/form.html" });
  setup(dom.window);
  const loaded = new Promise((resolve) => dom.window.addEventListener("load", resolve));
  return { dom, window: dom.window, errors, loaded };
}

describe("prepareBlankOrganizationForm", () => {
  const result = prepareBlankOrganizationForm(FILLED_SAMPLE_FORM);
  const doc = parse(result.html);

  it("makes a formerly fixed answer fillable however it was locked", () => {
    // PR 6599 (r1s3): a disabled field or fieldset stayed locked after its value was cleared.
    const locked = prepareBlankOrganizationForm('<form><input id="employer" value="Example agency" disabled><fieldset disabled><input id="unit" value="Unit 9"></fieldset><input id="blank" disabled></form>');
    const out = parse(locked.html);
    expect(out.getElementById("employer").getAttribute("value")).toBe("");
    expect(out.getElementById("employer").hasAttribute("disabled")).toBe(false);
    expect(out.querySelector("fieldset").hasAttribute("disabled")).toBe(false);
    // A field the form disabled on purpose and that held nothing stays as the organization made it.
    expect(out.getElementById("blank").hasAttribute("disabled")).toBe(true);
  });

  it("removes entered values, choices, reset defaults and saved signatures in the markup", () => {
    expect(doc.getElementById("name").getAttribute("value")).toBe("");
    expect(doc.getElementById("name").hasAttribute("data-default")).toBe(false);
    expect(doc.getElementById("unit").getAttribute("value")).toBe("");
    expect(doc.getElementById("unit").hasAttribute("readonly")).toBe(false);
    expect(doc.getElementById("phone").getAttribute("value")).toBe("");
    expect(doc.getElementById("agree").hasAttribute("checked")).toBe(false);
    expect(doc.querySelectorAll("input[name=step][checked]")).toHaveLength(0);
    expect(doc.getElementById("statement").textContent).toBe("");
    expect(doc.getElementById("mirror").getAttribute("value")).toBe("");
    const select = doc.getElementById("dept");
    expect(select.options[0].value).toBe("");
    expect(select.options[0].hasAttribute("selected")).toBe(true);
    expect([...select.options].filter((option) => option.hasAttribute("selected"))).toHaveLength(1);
    expect(doc.getElementById("sig-image").hasAttribute("src")).toBe(false);
    expect(result.html).not.toMatch(/Pat Example|Unit 9|555-0100|An earlier statement|SIGNATURE/);
  });

  it("keeps the official wording, choices, other images and the organization's own scripts", () => {
    expect(doc.querySelector("label[for=name]").textContent).toBe("Grievant name");
    expect([...doc.querySelectorAll("input[name=step]")].map((input) => input.value)).toEqual(["one", "two"]);
    expect(doc.getElementById("emblem").getAttribute("src")).toBe("data:image/png;base64,EMBLEM");
    expect(result.html).toContain(OFFICIAL_BUILDER);
    expect(result.html).toContain("window._sigPads = {");
    expect(result.title).toBe("Example Step One Grievance");
  });

  it("drops earlier export controls and reports cleared fields by name only", () => {
    expect(doc.querySelector(".ug-html-actions")).toBeNull();
    expect(doc.getElementById("ug-html-export")).toBeNull();
    expect(result.removedExportControls).toBe(2);
    expect(result.removedSignatureImages).toBe(1);
    expect(result.fieldCount).toBe(9);
    expect(result.clearedFieldIds).toEqual(["name", "unit", "phone", "agree", "step", "statement", "dept", "mirror"]);
    expect(JSON.stringify(result)).not.toMatch(/"Pat Example"|clearedValues/);
  });

  it("is idempotent and leaves a blank template blank", () => {
    const again = prepareBlankOrganizationForm(result.html);
    expect(again.clearedFieldIds).toEqual([]);
    expect(again.html).toBe(result.html);
  });

  it("refuses files that are not forms, too large, or already completed", () => {
    expect(codeOf(() => prepareBlankOrganizationForm(""))).toBe("not_html");
    expect(codeOf(() => prepareBlankOrganizationForm(null))).toBe("not_html");
    expect(codeOf(() => prepareBlankOrganizationForm("<p>No fields here</p>"))).toBe("no_fields");
    expect(codeOf(() => prepareBlankOrganizationForm(`<input>${"x".repeat(ORG_FORM_MAX_BYTES)}`))).toBe("too_large");
    const completed = FILLED_SAMPLE_FORM.replace('<html lang="en">', '<html lang="en" data-ug-form-instance="completed">');
    expect(codeOf(() => prepareBlankOrganizationForm(completed))).toBe("completed_instance");
    expect(isCompletedOrganizationForm(completed)).toBe(true);
    expect(isCompletedOrganizationForm(FILLED_SAMPLE_FORM)).toBe(false);
    // PR 6599 (r1s4): an earlier-format saved file carries only its signature data.
    const legacy = FILLED_SAMPLE_FORM.replace("</body>", '<script type="application/json" id="ug-saved-signatures">{"padA":{"w":5,"strokes":[]}}</script></body>');
    expect(isCompletedOrganizationForm(legacy)).toBe(true);
    expect(codeOf(() => prepareBlankOrganizationForm(legacy))).toBe("completed_instance");
  });

  // PR 6599 review r4428121064: an answered contenteditable region is an
  // answer like a field and must not survive into the template.
  it("clears and reports editable answer regions, keeping non-editable text", () => {
    const blank = prepareBlankOrganizationForm(`<label for="a">Name</label><input id="a">
      <div id="statement" contenteditable="true"><p>Earlier answer by Pat Example</p></div>
      <div class="notes" contenteditable=""><img src="data:image/png;base64,AAAA"></div>
      <div id="plain" contenteditable="plaintext-only">Old note</div>
      <div id="empty" contenteditable>   </div>
      <div id="fixed" contenteditable="false">Official wording</div>
      <div id="outer" contenteditable="true">Outer <span contenteditable="true">inner answer</span></div>`);
    const doc = parse(blank.html);
    for (const id of ["statement", "plain", "empty", "outer"]) expect(doc.getElementById(id).innerHTML).toBe("");
    expect(doc.querySelector(".notes").innerHTML).toBe("");
    expect(doc.getElementById("fixed").textContent).toBe("Official wording");
    expect(blank.html).not.toMatch(/Pat Example|Old note|inner answer|base64,AAAA/);
    expect(blank.clearedFieldIds).toEqual(["statement", "div-2", "plain", "outer"]);
    expect(blank.fieldCount).toBe(6);
  });

  // PR 6599 review r4428121071: an image with its own id inside a signature
  // container is a signature; the container's name must be inspected.
  it("removes data images inside any signature-named ancestor and keeps other images", () => {
    const blank = prepareBlankOrganizationForm(`<input id="a">
      <div class="signature"><img id="preview" src="data:image/png;base64,SIGNED"></div>
      <section id="m-sig-grievant"><div class="frame"><span><img id="deep" src="data:image/png;base64,DEEP"></span></div></section>
      <div class="box sig2"><img class="pic" src="data:image/png;base64,TOKEN"></div>
      <div class="design-header"><img id="logo" src="data:image/png;base64,LOGO"></div>
      <img id="signature-image" src="data:image/png;base64,OWN">`);
    const doc = parse(blank.html);
    for (const id of ["preview", "deep", "signature-image"]) expect(doc.getElementById(id).hasAttribute("src")).toBe(false);
    expect(doc.querySelector(".pic").hasAttribute("src")).toBe(false);
    expect(doc.getElementById("logo").getAttribute("src")).toBe("data:image/png;base64,LOGO");
    expect(blank.removedSignatureImages).toBe(4);
  });

  it("clears a stray reset default outside a field and keeps multiple selects without a placeholder", () => {
    const blank = prepareBlankOrganizationForm('<div id="box" data-default="Old"></div><select id="multi" multiple><option selected value="a">A</option></select>');
    const blankDoc = parse(blank.html);
    expect(blankDoc.getElementById("box").hasAttribute("data-default")).toBe(false);
    expect(blankDoc.getElementById("multi").options).toHaveLength(1);
    expect(blankDoc.getElementById("multi").options[0].hasAttribute("selected")).toBe(false);
    expect(blank.clearedFieldIds).toEqual(["multi", "box"]);
  });
});

describe("the frame document and the kit", () => {
  const blank = prepareBlankOrganizationForm(FILLED_SAMPLE_FORM).html;

  it("adds the kit once, with its copy, marking the in-app frame", () => {
    const framed = buildOrganizationFormFrameDocument(blank, { copy: { save: "Guardar </script>" } });
    const twice = buildOrganizationFormFrameDocument(framed, { copy: { save: "Save" } });
    const doc = parse(twice);
    expect(doc.documentElement.getAttribute("data-ug-form-frame")).toBe("embedded");
    expect(doc.querySelectorAll("#ug-org-form-kit")).toHaveLength(1);
    expect(doc.querySelectorAll("#ug-org-form-kit-style")).toHaveLength(1);
    expect(JSON.parse(doc.getElementById("ug-org-form-kit-copy").textContent)).toEqual({ save: "Save" });
    expect(framed).not.toContain("Guardar </script>");
    expect(doc.getElementById("ug-org-form-kit").textContent).toBe(ORG_FORM_KIT_SOURCE);
    const standalone = parse(buildOrganizationFormFrameDocument(twice, { embedded: false }));
    expect(standalone.documentElement.hasAttribute("data-ug-form-frame")).toBe(false);
  });

  it("keeps the kit free of template substitutions so its bytes travel unchanged", () => {
    expect(ORG_FORM_KIT_SOURCE).not.toMatch(/`|\$\{/);
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    expect(() => new Function(ORG_FORM_KIT_SOURCE)).not.toThrow();
  });

  it("saves a completed, self-contained file that reopens with values and signatures", async () => {
    const first = runDocument(buildOrganizationFormFrameDocument(blank, { embedded: false }));
    await first.loaded;
    const { window } = first;
    window.document.getElementById("name").value = "Sam Sample";
    window.document.getElementById("agree").checked = true;
    window.document.querySelector("input[name=step][value=two]").checked = true;
    window.document.getElementById("statement").value = "What happened <today>";
    window.document.getElementById("dept").value = "review";
    window.__padData = { w: 120, strokes: [[[1, 2], [3, 4]]] };
    window.syncMobileToDesktop = vi.fn();
    const saved = window.ugOrgFormSnapshot();
    expect(window.syncMobileToDesktop).toHaveBeenCalledOnce();
    const savedDoc = parse(saved);
    expect(savedDoc.documentElement.getAttribute("data-ug-form-instance")).toBe("completed");
    expect(savedDoc.getElementById("ug-org-form-actions")).toBeNull();
    expect(savedDoc.getElementById("name").getAttribute("value")).toBe("Sam Sample");
    expect(savedDoc.getElementById("agree").hasAttribute("checked")).toBe(true);
    expect(savedDoc.querySelector("input[name=step][value=two]").hasAttribute("checked")).toBe(true);
    expect(savedDoc.getElementById("statement").textContent).toBe("What happened <today>");
    expect(savedDoc.querySelector("#dept option[value=review]").hasAttribute("selected")).toBe(true);
    expect(saved).toContain(OFFICIAL_BUILDER);
    expect(savedDoc.getElementById("ug-saved-signatures").textContent).not.toContain("<");
    expect(JSON.parse(savedDoc.getElementById("ug-saved-signatures").textContent)).toEqual({
      version: 1, pads: { padA: { w: 120, strokes: [[[1, 2], [3, 4]]] } }, canvases: {},
    });
    expect(readSavedOrganizationForm(saved).title).toBe("Example Step One Grievance");
    expect(codeOf(() => prepareBlankOrganizationForm(saved))).toBe("completed_instance");
    expect(first.errors).toEqual([]);

    const reopened = runDocument(saved);
    await reopened.loaded;
    expect(reopened.window.__restored).toEqual({ w: 120, strokes: [[[1, 2], [3, 4]]] });
    expect(reopened.window.document.getElementById("name").value).toBe("Sam Sample");
    expect(reopened.window.document.getElementById("statement").value).toBe("What happened <today>");
    expect(reopened.window.document.querySelectorAll("#ug-org-form-actions button")).toHaveLength(3);
    expect(reopened.errors).toEqual([]);
  });

  it("uses the form's own snapshot builder when it has one and restores plain signature canvases", async () => {
    const own = blank.replace("</body>", '<canvas id="sig-canvas" width="10" height="10"></canvas><script>window._buildSnapshotHTML = function () { return "<!doctype html>\\n" + document.documentElement.outerHTML.replace("Grievant name", "Grievant name (own)"); };</script></body>');
    const run = runDocument(buildOrganizationFormFrameDocument(own, { embedded: false }), (window) => {
      window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,DRAWN";
      window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect: vi.fn(), drawImage: vi.fn() });
    });
    await run.loaded;
    const saved = run.window.ugOrgFormSnapshot();
    expect(saved).toContain("Grievant name (own)");
    expect(JSON.parse(parse(saved).getElementById("ug-saved-signatures").textContent).canvases).toEqual({ "sig-canvas": "data:image/png;base64,DRAWN" });
  });

  it("saves and restores signature canvases that have no id", async () => {
    // PR 6599 (P1): a marked or classed canvas without an id was dropped.
    const unnamed = blank.replace("</body>", '<canvas width="10" height="10"></canvas><canvas data-ug-signature width="10" height="10"></canvas><canvas class="signature-pad" width="10" height="10"></canvas></body>');
    const drawn = [];
    const setup = (window) => {
      window.HTMLCanvasElement.prototype.toDataURL = function () { return "data:image/png;base64," + (this.className || "MARKED"); };
      window.HTMLCanvasElement.prototype.getContext = function () { const canvas = this; return { clearRect: vi.fn(), drawImage: () => drawn.push(canvas) }; };
      window.Image = class { set src(value) { this.value = value; queueMicrotask(() => this.onload && this.onload()); } };
    };
    const run = runDocument(buildOrganizationFormFrameDocument(unnamed, { embedded: false }), setup);
    await run.loaded;
    const saved = run.window.ugOrgFormSnapshot();
    expect(JSON.parse(parse(saved).getElementById("ug-saved-signatures").textContent).canvases).toEqual({
      "canvas 1": "data:image/png;base64,MARKED", "canvas 2": "data:image/png;base64,signature-pad",
    });
    const reopened = runDocument(saved, setup);
    await reopened.loaded;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const canvases = [...reopened.window.document.querySelectorAll("canvas")];
    expect(drawn).toEqual([canvases[1], canvases[2]]);
    expect(reopened.errors).toEqual([]);
  });

  it("restores a canvas whose literal id looks like a position key to that canvas", async () => {
    // Refs, comment 6539828891: "canvas 1" was read as the second canvas.
    const literal = blank.replace("</body>", '<canvas id="canvas 1" data-ug-signature width="10" height="10"></canvas><canvas width="10" height="10"></canvas></body>');
    const drawn = [];
    const setup = (window) => {
      window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,LITERAL";
      window.HTMLCanvasElement.prototype.getContext = function () { const canvas = this; return { clearRect: vi.fn(), drawImage: () => drawn.push(canvas) }; };
      window.Image = class { set src(value) { this.value = value; queueMicrotask(() => this.onload && this.onload()); } };
    };
    const run = runDocument(buildOrganizationFormFrameDocument(literal, { embedded: false }), setup);
    await run.loaded;
    const saved = run.window.ugOrgFormSnapshot();
    expect(JSON.parse(parse(saved).getElementById("ug-saved-signatures").textContent).canvases).toEqual({ "canvas 1": "data:image/png;base64,LITERAL" });
    const reopened = runDocument(saved, setup);
    await reopened.loaded;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawn).toEqual([reopened.window.document.getElementById("canvas 1")]);
    expect(reopened.errors).toEqual([]);
  });

  it("reads the earlier standalone signature format and reports an unreadable one", async () => {
    const legacy = blank.replace("</body>", '<script type="application/json" id="ug-saved-signatures">{"padA":{"w":5,"strokes":[]}}</script></body>');
    const run = runDocument(buildOrganizationFormFrameDocument(legacy, { embedded: false }));
    await run.loaded;
    expect(run.window.__restored).toEqual({ w: 5, strokes: [] });
    const broken = blank.replace("</body>", '<script type="application/json" id="ug-saved-signatures">{not json</script></body>');
    const brokenRun = runDocument(buildOrganizationFormFrameDocument(broken, { embedded: false, copy: { restoreFailed: "Check signatures" } }));
    await brokenRun.loaded;
    expect(brokenRun.window.document.getElementById("ug-org-form-status").textContent).toBe("Check signatures");
  });

  it("standalone Save downloads and Email falls back to a download plus an honest draft", async () => {
    const run = runDocument(buildOrganizationFormFrameDocument(blank, { embedded: false }), (window) => {
      window.URL.createObjectURL = vi.fn(() => "blob:form");
      window.URL.revokeObjectURL = vi.fn();
    });
    await run.loaded;
    const { window } = run;
    const clicks = [];
    window.HTMLAnchorElement.prototype.click = function click() { clicks.push(this.download); };
    const [save, email] = window.document.querySelectorAll("#ug-org-form-actions button");
    save.click();
    expect(clicks).toEqual(["Example-Step-One-Grievance.html"]);
    expect(window.document.getElementById("ug-org-form-status").textContent).toMatch(/^Saved/);
    email.click();
    expect(clicks).toHaveLength(2);
    expect(window.document.getElementById("ug-org-form-status").textContent).toMatch(/Attach the file yourself before sending; nothing was attached or sent/);
  });

  it("standalone Email shares the file where the browser can", async () => {
    const share = vi.fn(() => Promise.resolve());
    const run = runDocument(buildOrganizationFormFrameDocument(blank, { embedded: false }), (window) => {
      Object.defineProperty(window.navigator, "canShare", { value: () => true, configurable: true });
      Object.defineProperty(window.navigator, "share", { value: share, configurable: true });
    });
    await run.loaded;
    run.window.document.querySelectorAll("#ug-org-form-actions button")[1].click();
    await Promise.resolve();
    await Promise.resolve();
    expect(share).toHaveBeenCalledOnce();
    expect(share.mock.calls[0][0].files[0].name).toBe("Example-Step-One-Grievance.html");
    expect(run.window.document.getElementById("ug-org-form-status").textContent).toMatch(/^Shared/);
  });
});

describe("saved files and sharing in the app", () => {
  // PR 6599 review r4428121073: a completed file may be larger than any
  // template; it reopens under its own allowance.
  it("reopens a saved form larger than the template limit and stops at the saved allowance", () => {
    const blank = prepareBlankOrganizationForm(`<title>Big</title><input id="a"><!-- ${"x".repeat(ORG_FORM_MAX_BYTES - 200)} -->`).html;
    expect(htmlByteLength(blank)).toBeLessThanOrEqual(ORG_FORM_MAX_BYTES);
    const framed = buildOrganizationFormFrameDocument(blank, { embedded: false });
    const saved = framed.replace("<html", '<html data-ug-form-instance="completed"').replace("</body>", '<script type="application/json" id="ug-saved-signatures">{"version":1,"pads":{},"canvases":{}}</script></body>');
    expect(htmlByteLength(saved)).toBeGreaterThan(ORG_FORM_MAX_BYTES);
    expect(readSavedOrganizationForm(saved).title).toBe("Big");
    expect(isCompletedOrganizationForm(saved)).toBe(true);
    expect(() => buildOrganizationFormFrameDocument(saved)).not.toThrow();
    expect(codeOf(() => readSavedOrganizationForm(`<html data-ug-form-instance="completed"><input>${"x".repeat(ORG_FORM_SAVED_MAX_BYTES)}</html>`))).toBe("saved_too_large");
  });

  it("only continues completed organization forms", () => {
    expect(codeOf(() => readSavedOrganizationForm(FILLED_SAMPLE_FORM))).toBe("not_saved_form");
    expect(codeOf(() => readSavedOrganizationForm('<html data-ug-form-instance="completed"><p>x</p></html>'))).toBe("no_fields");
  });

  it("names files safely and measures bytes", async () => {
    expect(organizationFormFileName("Step 1: Grievance / Report")).toBe("Step-1-Grievance-Report.html");
    expect(organizationFormFileName("")).toBe("form.html");
    expect(htmlByteLength("é")).toBe(2);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("abc", null)).toBeNull();
  });

  function fakeDocument() {
    const links = [];
    const doc = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => {
        const link = { click: vi.fn(), remove: vi.fn() };
        links.push(link);
        return link;
      }),
    };
    return { doc, links, urls: { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() } };
  }

  it("downloads the HTML file", () => {
    const { doc, links, urls } = fakeDocument();
    const { name, file } = downloadOrganizationFormHtml("<html></html>", "My Form", { doc, urls });
    expect(name).toBe("My-Form.html");
    expect(file.type).toBe("text/html");
    expect(links[0]).toMatchObject({ download: "My-Form.html", href: "blob:x" });
    expect(links[0].click).toHaveBeenCalledOnce();
  });

  it("shares, reports a cancel, and falls back without claiming a send", async () => {
    const { doc, links, urls } = fakeDocument();
    const shared = await shareOrganizationFormHtml("<html></html>", "My Form", { doc, urls, nav: { canShare: () => true, share: vi.fn(() => Promise.resolve()) } });
    expect(shared).toEqual({ outcome: "shared", name: "My-Form.html" });
    const abort = Object.assign(new Error("cancel"), { name: "AbortError" });
    const cancelled = await shareOrganizationFormHtml("<html></html>", "My Form", { doc, urls, nav: { canShare: () => true, share: vi.fn(() => Promise.reject(abort)) } });
    expect(cancelled.outcome).toBe("cancelled");
    expect(links).toHaveLength(0);
    const refused = Object.assign(new Error("no activation"), { name: "NotAllowedError" });
    const fallback = await shareOrganizationFormHtml("<html></html>", "My Form", { doc, urls, draftBody: "Attach:", nav: { canShare: () => true, share: vi.fn(() => Promise.reject(refused)) } });
    expect(fallback.outcome).toBe("downloaded_with_draft");
    expect(links[0].download).toBe("My-Form.html");
    expect(links[1].href).toBe("mailto:?subject=My%20Form&body=Attach%3A%20My-Form.html");
    const noShare = await shareOrganizationFormHtml("<html></html>", "", { doc, urls, nav: {} });
    expect(noShare).toEqual({ outcome: "downloaded_with_draft", name: "form.html" });
  });

  it("frames forms without same-origin access", () => {
    expect(ORG_FORM_FRAME_SANDBOX.split(" ")).not.toContain("allow-same-origin");
    expect(ORG_FORM_FRAME_SANDBOX.split(" ")).not.toContain("allow-top-navigation");
    // PR 6599 (P0): a popup is a new top-level window outside the frame's limits.
    expect(ORG_FORM_FRAME_SANDBOX.split(" ")).not.toContain("allow-popups");
    expect(ORG_FORM_FRAME_SANDBOX.split(" ")).not.toContain("allow-popups-to-escape-sandbox");
  });
});
