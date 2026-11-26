// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: the viewer's frame
// handshake and toolbar, the member list and the administrator import.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { OrganizationFormViewer } from "../src/components/OrganizationFormViewer.jsx";
import { OrganizationHtmlForms } from "../src/components/OrganizationHtmlForms.jsx";
import { AdminOrganizationHtmlForms } from "../src/components/AdminOrganizationHtmlForms.jsx";
import { createOrganizationFormDocumentsApi } from "../src/lib/organizationFormDocumentsApi.js";
import { prepareBlankOrganizationForm } from "../src/lib/organizationHtmlForms.js";
import { FILLED_SAMPLE_FORM } from "./fixtures/organization-html-form.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";

const BLANK = prepareBlankOrganizationForm(FILLED_SAMPLE_FORM).html;
const SAVED = BLANK.replace('<html lang="en">', '<html lang="en" data-ug-form-instance="completed">');
const withLang = (node, lang = "en") => <LanguageProvider lang={lang}>{node}</LanguageProvider>;

function frameOf(container) {
  const frame = container.querySelector("iframe");
  const posted = [];
  frame.contentWindow.postMessage = vi.fn((message) => posted.push(message));
  const send = (data, source = frame.contentWindow) => act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
  return { frame, posted, send };
}

describe("OrganizationFormViewer", () => {
  it("loads the form into an opaque-origin frame and keeps the toolbar off until it is ready", () => {
    const { container } = render(withLang(<OrganizationFormViewer html={BLANK} title="Example form" onClose={() => {}} />));
    const { frame, posted, send } = frameOf(container);
    expect(frame.getAttribute("src")).toBe("/org-form-frame.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-downloads allow-forms allow-modals");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Example form form");
    expect(screen.getByRole("button", { name: "Save HTML" }).disabled).toBe(true);
    send({ type: "ug-org-form:frame-ready" }, window);
    expect(posted).toEqual([]);
    send({ type: "ug-org-form:frame-ready" });
    expect(posted[0].type).toBe("ug-org-form:load");
    expect(posted[0].html).toContain('data-ug-form-frame="embedded"');
    expect(posted[0].html).toContain('id="ug-org-form-kit"');
    send({ type: "ug-org-form:ready" });
    expect(screen.getByRole("button", { name: "Save HTML" }).disabled).toBe(false);
  });

  it("saves, emails and prints the worker's own snapshot", async () => {
    const download = vi.fn(() => ({ name: "Example-form.html" }));
    const share = vi.fn(async () => ({ outcome: "downloaded_with_draft", name: "Example-form.html" }));
    const onClose = vi.fn();
    const { container } = render(withLang(<OrganizationFormViewer html={BLANK} title="Example form" onClose={onClose} download={download} share={share} />));
    const { posted, send } = frameOf(container);
    send({ type: "ug-org-form:ready" });

    fireEvent.click(screen.getByRole("button", { name: "Save HTML" }));
    const saveRequest = posted.find((message) => message.type === "ug-org-form:snapshot");
    send({ type: "ug-org-form:snapshot-result", requestId: "unknown", html: "<x>" });
    send({ type: "ug-org-form:snapshot-result", requestId: saveRequest.requestId, html: SAVED });
    await waitFor(() => expect(download).toHaveBeenCalledWith(SAVED, "Example form"));
    expect(screen.getByRole("status").textContent).toMatch(/^Saved Example-form\.html/);

    fireEvent.click(screen.getByRole("button", { name: "Email HTML" }));
    const emailRequest = posted.filter((message) => message.type === "ug-org-form:snapshot")[1];
    send({ type: "ug-org-form:snapshot-result", requestId: emailRequest.requestId, html: SAVED });
    await waitFor(() => expect(share).toHaveBeenCalledWith(SAVED, "Example form", { draftBody: "Attach the downloaded file before sending:" }));
    expect(screen.getByRole("status").textContent).toMatch(/Attach the file to the email yourself before sending; nothing was attached or sent/);

    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(posted.at(-1)).toEqual({ type: "ug-org-form:print" });
    fireEvent.click(screen.getByRole("button", { name: "Close form" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("points to Print or the saved file when the form's own page-capture PDF cannot run in the frame", () => {
    const { container } = render(withLang(<OrganizationFormViewer html={BLANK} title="Example form" onClose={() => {}} />));
    const { send } = frameOf(container);
    send({ type: "ug-org-form:ready" });
    send({ type: "ug-org-form:pdf-unavailable" });
    expect(screen.getByRole("status").textContent).toBe("The form's own PDF button works in the saved file. Choose Save HTML, open that file, and use its PDF button there. Or choose Print and then Save as PDF.");
  });

  it("says so when the frame cannot produce a snapshot", async () => {
    const download = vi.fn();
    const { container } = render(withLang(<OrganizationFormViewer html={BLANK} title="Example form" onClose={() => {}} download={download} />));
    const { posted, send } = frameOf(container);
    send({ type: "ug-org-form:ready" });
    fireEvent.click(screen.getByRole("button", { name: "Save HTML" }));
    send({ type: "ug-org-form:snapshot-result", requestId: posted[0].requestId, error: "snapshot_failed" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The form couldn't be saved. Nothing was lost; try again."));
    expect(download).not.toHaveBeenCalled();
  });

  // #9890 (W3b-16 of #9459): a frame that never reported ready left
  // "Loading the form…" and greyed buttons on screen forever.
  it("says the form could not load after 15 seconds and offers Try again with a fresh frame", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(withLang(<OrganizationFormViewer html={BLANK} title="Example form" onClose={() => {}} />));
      const first = container.querySelector("iframe");
      expect(screen.getByRole("status").textContent).toBe("Loading the form…");
      await act(async () => { vi.advanceTimersByTime(14_999); });
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { vi.advanceTimersByTime(2); });
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("This form could not load.");
      expect(screen.getByRole("status").textContent).toBe("");
      for (const name of ["Save HTML", "Email HTML", "Print"]) expect(screen.getByRole("button", { name }).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Loading the form…");
      expect(container.querySelector("iframe")).not.toBe(first);
      const { posted, send } = frameOf(container);
      send({ type: "ug-org-form:frame-ready" });
      expect(posted[0].type).toBe("ug-org-form:load");
      send({ type: "ug-org-form:ready" });
      await act(async () => { vi.advanceTimersByTime(20_000); });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Save HTML" }).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // #9890: the kit can take typing before it posts ready, and Try again
  // replaces the frame; until ready the frame takes no input or focus.
  it("keeps the frame inert until the form reports ready", () => {
    const { container } = render(withLang(<OrganizationFormViewer html={BLANK} title="Example form" onClose={() => {}} />));
    const { frame, send } = frameOf(container);
    expect(frame.hasAttribute("inert")).toBe(true);
    send({ type: "ug-org-form:frame-ready" });
    expect(frame.hasAttribute("inert")).toBe(true);
    send({ type: "ug-org-form:ready" });
    expect(frame.hasAttribute("inert")).toBe(false);
  });

  it("says the form could not load in Spanish", async () => {
    vi.useFakeTimers();
    try {
      render(withLang(<OrganizationFormViewer html={BLANK} title="Ejemplo" onClose={() => {}} />, "es"));
      await act(async () => { vi.advanceTimersByTime(15_001); });
      expect(screen.getByRole("alert")).toHaveTextContent("No se pudo cargar este formulario.");
      expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a snapshot the frame never answers", async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(withLang(<OrganizationFormViewer html={BLANK} title="Example form" onClose={() => {}} />));
      const { send } = frameOf(container);
      send({ type: "ug-org-form:ready" });
      fireEvent.click(screen.getByRole("button", { name: "Save HTML" }));
      await act(async () => { vi.advanceTimersByTime(15_001); });
      expect(screen.getByRole("status").textContent).toBe("The form couldn't be saved. Nothing was lost; try again.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OrganizationHtmlForms (worker)", () => {
  it("lists the organization's forms and opens one blank", async () => {
    const api = {
      listOrganizationFormDocuments: vi.fn(async () => [{ id: "doc-1", title: "Example form", version: 2 }]),
      getOrganizationFormDocument: vi.fn(async () => ({ id: "doc-1", title: "Example form", html: BLANK })),
    };
    const { container } = render(withLang(<OrganizationHtmlForms api={api} />));
    expect(await screen.findByText("Version 2")).toBeTruthy();
    expect(screen.getByText(/Filled-in forms stay on your device/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open a blank Example form" }));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(api.getOrganizationFormDocument).toHaveBeenCalledWith("doc-1");
    expect(screen.getByText(/This form starts blank/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close form" }));
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("shows the empty and unavailable states honestly", async () => {
    const empty = { listOrganizationFormDocuments: vi.fn(async () => []), getOrganizationFormDocument: vi.fn() };
    const { unmount } = render(withLang(<OrganizationHtmlForms api={empty} />));
    expect(await screen.findByText("Your organization hasn't added any forms yet.")).toBeTruthy();
    unmount();
    const failing = { listOrganizationFormDocuments: vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce([]), getOrganizationFormDocument: vi.fn() };
    render(withLang(<OrganizationHtmlForms api={failing} />));
    expect(await screen.findByText("Your organization's forms can't be loaded right now.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Your organization hasn't added any forms yet.")).toBeTruthy();
  });

  it("reports a form that fails to open", async () => {
    const api = {
      listOrganizationFormDocuments: vi.fn(async () => [{ id: "doc-1", title: "Example form", version: 1 }]),
      getOrganizationFormDocument: vi.fn(async () => { throw new Error("gone"); }),
    };
    render(withLang(<OrganizationHtmlForms api={api} />));
    fireEvent.click(await screen.findByRole("button", { name: "Open a blank Example form" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That form couldn't be opened. Try again.");
  });

  it("continues a saved form from the worker's device and refuses other files", async () => {
    const api = { listOrganizationFormDocuments: vi.fn(async () => []), getOrganizationFormDocument: vi.fn() };
    const { container } = render(withLang(<OrganizationHtmlForms api={api} />));
    await screen.findByText("Your organization hasn't added any forms yet.");
    const input = container.querySelector("input[type=file]");
    fireEvent.change(input, { target: { files: [new File([FILLED_SAMPLE_FORM], "blank.html", { type: "text/html" })] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That file isn't a form saved from Union Ground. Open your organization's form from the list instead.");
    fireEvent.change(input, { target: { files: [new File([SAVED], "saved.html", { type: "text/html" })] } });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(screen.getByText(/You're continuing a saved form/)).toBeTruthy();
    expect(api.getOrganizationFormDocument).not.toHaveBeenCalled();
  });

  it("refuses an oversized saved file before reading it", async () => {
    const api = { listOrganizationFormDocuments: vi.fn(async () => []), getOrganizationFormDocument: vi.fn() };
    const { container } = render(withLang(<OrganizationHtmlForms api={api} />));
    await screen.findByText("Your organization hasn't added any forms yet.");
    const big = new File(["x"], "big.html", { type: "text/html" });
    Object.defineProperty(big, "size", { value: 17 * 1024 * 1024 });
    fireEvent.change(container.querySelector("input[type=file]"), { target: { files: [big] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That saved form is larger than 16 MB.");
  });

  // PR 6599 review r4428121073: a saved file is the template plus the kit,
  // answers and signatures, so it may exceed the 4 MiB template limit.
  it("continues a saved form larger than the template limit", async () => {
    const api = { listOrganizationFormDocuments: vi.fn(async () => []), getOrganizationFormDocument: vi.fn() };
    const { container } = render(withLang(<OrganizationHtmlForms api={api} />));
    await screen.findByText("Your organization hasn't added any forms yet.");
    const large = SAVED.replace("</body>", `<!-- ${"x".repeat(4 * 1024 * 1024 + 1024)} --></body>`);
    fireEvent.change(container.querySelector("input[type=file]"), { target: { files: [new File([large], "large.html", { type: "text/html" })] } });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AdminOrganizationHtmlForms", () => {
  function adminApi(overrides = {}) {
    return {
      listOrganizationFormDocuments: vi.fn(async () => []),
      acceptOrganizationFormDocument: vi.fn(async () => ({ id: "doc-9", version: 1 })),
      retireOrganizationFormDocument: vi.fn(async () => ({ active: false })),
      ...overrides,
    };
  }

  it("offers no import in the demo", () => {
    const { container } = render(withLang(<AdminOrganizationHtmlForms api={adminApi()} demo />));
    expect(screen.getByText("Organization HTML forms are added in a live organization.")).toBeTruthy();
    expect(container.querySelector("input[type=file]")).toBeNull();
  });

  it.each([
    ["en", "Choose an HTML form", "Add for workers", "HTML file, up to 4 MB.", "Confirm the statement before adding the form."],
    ["es", "Elegir un formulario HTML", "Agregar para los trabajadores", "Archivo HTML de hasta 4 MB.", "Confirma la declaración antes de agregar el formulario."],
  ])("explains the upload limit and missing attestation in %s", async (lang, chooseLabel, addLabel, sizeHint, reason) => {
    const api = adminApi();
    render(withLang(<AdminOrganizationHtmlForms api={api} />, lang));
    const file = screen.getByLabelText(chooseLabel);
    expect(file).toHaveAccessibleDescription(sizeHint);
    expect(screen.getByText(sizeHint)).toBeVisible();
    fireEvent.change(file, { target: { files: [new File([FILLED_SAMPLE_FORM], "step-one.html", { type: "text/html" })] } });
    const button = await screen.findByRole("button", { name: addLabel });
    const attestation = screen.getByRole("checkbox");
    expect(attestation).not.toHaveAttribute("aria-invalid");
    expect(button).toHaveAccessibleDescription(reason);
    expect(button.nextElementSibling).toBeVisible();
    expectRefusedEveryWay(button, reason, () => api.acceptOrganizationFormDocument.mock.calls.length > 0);
    expect(attestation).toHaveAttribute("aria-invalid", "true");
    const previous = button.nextElementSibling;
    fireEvent.submit(button.form);
    expect(button.nextElementSibling).not.toBe(previous);
    expect(button.nextElementSibling).toHaveAttribute("role", "alert");
    expect(api.acceptOrganizationFormDocument).not.toHaveBeenCalled();
    fireEvent.click(attestation);
    expect(attestation).not.toHaveAttribute("aria-invalid");
    fireEvent.click(button);
    await waitFor(() => expect(api.acceptOrganizationFormDocument).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attested: true, html: BLANK })));
  });

  it("blanks the chosen file, shows what was removed and imports it only after attestation", async () => {
    const api = adminApi();
    const { container } = render(withLang(<AdminOrganizationHtmlForms api={api} />));
    await screen.findByText("No HTML forms yet. Workers see only the forms you add here.");
    fireEvent.change(container.querySelector("input[type=file]"), { target: { files: [new File([FILLED_SAMPLE_FORM], "step-one.html", { type: "text/html" })] } });
    expect(await screen.findByText(/Removed filled-in values from 8 fields/)).toBeTruthy();
    expect(screen.getByText(/name, unit, phone, agree, step, statement, dept, mirror/)).toBeTruthy();
    expect(screen.queryByText(/Pat Example/)).toBeNull();
    expect(screen.getByDisplayValue("Example Step One Grievance")).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add for workers" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Try the blank form" }));
    expect(container.querySelector("iframe")).not.toBeNull();
    fireEvent.change(screen.getByLabelText(/^Matching form key/), { target: { value: "Bad Key" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(add.closest("form"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Use lowercase letters, numbers and underscores for the form key.");
    fireEvent.change(screen.getByLabelText(/^Matching form key/), { target: { value: "grievance" } });
    api.listOrganizationFormDocuments.mockResolvedValueOnce([{ id: "doc-9", title: "Example Step One Grievance", version: 1, formKey: "grievance", clearedFieldCount: 8 }]);
    fireEvent.click(add);
    await waitFor(() => expect(api.acceptOrganizationFormDocument).toHaveBeenCalledOnce());
    const fields = api.acceptOrganizationFormDocument.mock.calls[0][0];
    expect(fields).toMatchObject({ title: "Example Step One Grievance", formKey: "grievance", clearedFieldCount: 8, attested: true });
    expect(fields.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fields.html).toBe(BLANK);
    expect(await screen.findByText("Added Example Step One Grievance (version 1). Workers can open it now.")).toBeTruthy();
    expect(await screen.findByText("Version 1 · 8 values removed on import")).toBeTruthy();
    // UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122: the key sits behind a details control.
    const card = screen.getByRole("heading", { name: "Example Step One Grievance" }).closest("article");
    expect(card.querySelector(".ftm-card__key").tagName).toBe("DETAILS");
    const key = screen.getByText("Matching form key: grievance");
    expect(key).not.toBeVisible();
    const control = screen.getByText("Technical details");
    expect(control).toHaveAttribute("aria-label", "Technical details for Example Step One Grievance");
    fireEvent.click(control);
    expect(key).toBeVisible();
  });

  it("refuses a completed form and reports a failed import", async () => {
    const api = adminApi({ acceptOrganizationFormDocument: vi.fn(async () => { throw new Error("denied"); }) });
    const { container } = render(withLang(<AdminOrganizationHtmlForms api={api} />));
    await screen.findByText("No HTML forms yet. Workers see only the forms you add here.");
    const input = container.querySelector("input[type=file]");
    fireEvent.change(input, { target: { files: [new File([SAVED], "filled.html", { type: "text/html" })] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That file is a filled-in form. Import your organization's blank form instead.");
    fireEvent.change(input, { target: { files: [new File([BLANK], "blank.html", { type: "text/html" })] } });
    expect(await screen.findByText("No filled-in values were found. The form is already blank.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Form title workers see"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("button", { name: "Add for workers" }).closest("form"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Give the form a title.");
    fireEvent.change(screen.getByLabelText("Form title workers see"), { target: { value: "Blank" } });
    fireEvent.click(screen.getByRole("button", { name: "Add for workers" }));
    expect(await screen.findByText(/The form couldn't be added/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Add for workers" })).toBeNull();
  });


  it("shows Spanish copy", async () => {
    render(withLang(<AdminOrganizationHtmlForms api={adminApi()} />, "es"));
    expect(await screen.findByText("Formularios HTML de tu organización")).toBeTruthy();
  });
});

describe("createOrganizationFormDocumentsApi", () => {
  it("calls only the four role-gated functions and surfaces their errors", async () => {
    expect(createOrganizationFormDocumentsApi(null)).toBeNull();
    const rpc = vi.fn(async (name) => (name === "retire_organization_form_document" ? { data: null, error: { message: "nope", code: "42501" } } : { data: [name], error: null }));
    const api = createOrganizationFormDocumentsApi({ rpc });
    expect(await api.listOrganizationFormDocuments()).toEqual(["list_organization_form_documents"]);
    await api.getOrganizationFormDocument("doc-1");
    await api.acceptOrganizationFormDocument({ title: "T", html: "<input>", attested: true });
    await expect(api.retireOrganizationFormDocument("doc-1")).rejects.toMatchObject({ code: "42501" });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      "list_organization_form_documents", "get_organization_form_document",
      "accept_organization_form_document", "retire_organization_form_document",
    ]);
    expect(rpc.mock.calls[2][1]).toEqual({ p_title: "T", p_form_key: null, p_document_html: "<input>", p_source_sha256: null, p_cleared_field_count: 0, p_attested: true });
  });
});

describe("organization form controls keep focus while their writes run (#8435)", () => {
  it("keeps Open a blank form focused while the form is fetched, and fetches it once", async () => {
    const api = {
      listOrganizationFormDocuments: vi.fn(async () => [{ id: "doc-1", title: "Example form", version: 2 }]),
      getOrganizationFormDocument: vi.fn(async () => ({ id: "doc-1", title: "Example form", html: BLANK })),
    };
    render(withLang(<OrganizationHtmlForms api={api} />));
    await expectHeldWriteFocus(api.getOrganizationFormDocument, await screen.findByRole("button", { name: "Open a blank Example form" }));
    expect(api.getOrganizationFormDocument).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirming Stop offering focused while the form is retired, and retires it once", async () => {
    const api = {
      listOrganizationFormDocuments: vi.fn(async () => [{ id: "doc-1", title: "Example form", version: 3, clearedFieldCount: 0 }]),
      acceptOrganizationFormDocument: vi.fn(async () => ({ id: "doc-9", version: 1 })),
      retireOrganizationFormDocument: vi.fn(async () => ({ active: false })),
    };
    render(withLang(<AdminOrganizationHtmlForms api={api} />));
    fireEvent.click(await screen.findByRole("button", { name: "Stop offering Example form" }));
    await expectHeldWriteFocus(api.retireOrganizationFormDocument, screen.getAllByRole("button", { name: "Stop offering" }).at(-1));
    expect(api.retireOrganizationFormDocument).toHaveBeenCalledTimes(1);
  });
});
