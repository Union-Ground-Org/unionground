// REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: a form asks before it
// fills workplace fields from the member's profile, fills only on a yes (or the
// member's "always" answer), marks each filled field, records which fields the
// member accepted, and never proposes a detail the member has not shared.
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormAutofillSetting } from "../src/components/FormAutofillSetting.jsx";
import { OrganizationFormViewer } from "../src/components/OrganizationFormViewer.jsx";
import {
  AUTOFILL_KINDS, autofillKindOf, autofillProposal, autofillValue, createFormAutofillApi, loadFormAutofill, loadRecordedAutofill,
  acceptedFields, pendingAutofillRecord, recordFormProfileAutofill, rememberPendingAutofill, restoredProfileFilled, saveFormAutofillPreference,
  shapeFormAutofill, templateAutofillFields,
} from "../src/lib/formAutofill.js";
import { AdminFormTemplateEditor } from "../src/components/AdminFormTemplateEditor.jsx";
import { templateByKey, templateFromDbRow } from "../src/lib/formTemplates.js";
import { formAutofillCatalogue } from "../src/lib/i18n/formAutofill.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { applyDeviceParityState, clearDeviceParityState } from "../src/lib/deviceParity.js";
import { endFormDraftSession } from "../src/lib/formDraftSessions.js";
import { ORG_FORM_KIT_SOURCE } from "../src/lib/organizationFormKit.js";
import { FormsView } from "../src/views/FormsView.jsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  clearDeviceParityState();
  // Each test is its own sign-in: no draft lane carries over.
  endFormDraftSession();
});

const VALUES = { employer: "Metro Transit Authority", chapter: "Garage 4", jobTitle: "Bus operator", worksite: "North garage", shift: null, classification: null };

describe("matching a form's fields to the member's details", () => {
  it("reads an explicit hint, the key, the autocomplete token or the label, in English and Spanish", () => {
    expect(autofillKindOf({ key: "anything", autofill: "shift" })).toBe("shift");
    expect(autofillKindOf({ key: "x", autocomplete: "organization-title" })).toBe("jobTitle");
    expect(autofillKindOf({ key: "x", autocomplete: "organization" })).toBe("employer");
    expect(autofillKindOf({ key: "jobTitle" })).toBe("jobTitle");
    expect(autofillKindOf({ key: "employer_name" })).toBe("employer");
    expect(autofillKindOf({ key: "f1", label: "Lugar de trabajo" })).toBe("worksite");
    expect(autofillKindOf({ key: "f2", label: "Job classification" })).toBe("classification");
    expect(autofillKindOf({ key: "f3", label: "Bargaining unit" })).toBe("unit");
    expect(autofillKindOf({ key: "f4", label: "Capítulo" })).toBe("chapter");
    expect(autofillKindOf({ key: "f9", name: "job_title", label: "Position" })).toBe("jobTitle");
    expect(autofillKindOf({ key: "title" })).toBeNull();
    expect(autofillKindOf({ key: "summary", label: "What happened" })).toBeNull();
    expect(autofillKindOf()).toBeNull();
  });

  it("never fills a field about someone or something else: the appealed vacancy, a witness, a former employer", () => {
    // The built-in non-selection appeal asks for the vacancy being appealed.
    const appeal = templateByKey("non_selection");
    for (const label of ["Position / posting", "Puesto / vacante"]) {
      const fields = templateAutofillFields(appeal, (key) => (key === "forms.f.posting" ? label : key));
      expect(autofillProposal(fields, VALUES)).toEqual([]);
    }
    for (const field of [{ key: "previous_employer" }, { key: "witness_job_title" }, { key: "x", label: "Supervisor shift" }, { key: "x", label: "Puesto" }]) {
      expect(autofillKindOf(field), JSON.stringify(field)).toBeNull();
    }
    expect(autofillKindOf({ key: "x", label: "Puesto actual" })).toBe("jobTitle");
  });

  it("excludes a field about someone else before its autocomplete token, and never reads a time field as the shift", () => {
    for (const field of [
      { key: "f0", name: "previous_employer", autocomplete: "organization" },
      { key: "f1", name: "witness_job_title", autocomplete: "organization-title" },
      { key: "f2", label: "Vacancy title", autocomplete: "organization-title" },
      { key: "f3", label: "Shift end time" },
      { key: "f4", label: "Hours held over past shift end" },
      { key: "f5", label: "Hora de inicio del turno" },
    ]) {
      expect(autofillKindOf(field), JSON.stringify(field)).toBeNull();
    }
    expect(autofillKindOf({ key: "f6", name: "employer", autocomplete: "organization" })).toBe("employer");
    expect(autofillKindOf({ key: "f7", label: "Shift" })).toBe("shift");
    expect(autofillKindOf({ key: "f8", label: "Turno" })).toBe("shift");
    expect(autofillProposal([{ key: "f0", name: "previous_employer", autocomplete: "organization" }, { key: "f1", label: "Current employer" }], VALUES))
      .toEqual([{ fieldKey: "f1", kind: "employer", value: "Metro Transit Authority" }]);
  });

  it("proposes one value per kind for empty fields only, a unit from the worksite", () => {
    const fields = [
      { key: "employer" }, { key: "employer_again", label: "Employer" }, { key: "job_title" },
      { key: "unit" }, { key: "shift" }, { key: "chapter" }, { key: "notes" }, null,
    ];
    expect(autofillProposal(fields, VALUES, { chapter: "Typed already" })).toEqual([
      { fieldKey: "employer", kind: "employer", value: "Metro Transit Authority" },
      { fieldKey: "job_title", kind: "jobTitle", value: "Bus operator" },
      { fieldKey: "unit", kind: "unit", value: "North garage" },
    ]);
    expect(autofillValue(VALUES, "shift")).toBeNull();
    expect(autofillProposal(undefined, VALUES)).toEqual([]);
    expect(AUTOFILL_KINDS).toContain("unit");
  });

  it("lists a template's text fields with their visible labels", () => {
    const template = { steps: [{ fields: [{ key: "a", type: "text", labelKey: "k.a" }, { key: "b", type: "date", labelKey: "k.b" }, { key: "c", type: "textarea", labelKey: "k.c", autofill: "shift" }] }] };
    expect(templateAutofillFields(template, (key) => `label:${key}`)).toEqual([
      { key: "a", label: "label:k.a", autofill: null }, { key: "c", label: "label:k.c", autofill: "shift" },
    ]);
    expect(templateAutofillFields(null)).toEqual([]);
  });
});

describe("the autofill client", () => {
  const client = (data, error = null) => ({ rpc: vi.fn(async () => ({ data, error })) });
  it("shapes the server's answer and drops what it does not know", async () => {
    expect(shapeFormAutofill({ preference: "sometimes", values: { jobTitle: "  ", worksite: "Depot", phone: "555" } })).toEqual({
      preference: "ask", shared: false, values: { employer: null, chapter: null, jobTitle: null, worksite: "Depot", shift: null, classification: null },
    });
    const ok = client({ preference: "always", shared: true, values: VALUES });
    expect(await loadFormAutofill(ok)).toMatchObject({ preference: "always", shared: true, values: { jobTitle: "Bus operator" } });
    expect(ok.rpc).toHaveBeenCalledWith("get_my_form_autofill");
    await expect(loadFormAutofill(client(null, { code: "42501" }))).rejects.toMatchObject({ code: "42501" });
  });

  it("restores recorded kinds onto filled fields, and keeps a failed record on this device", async () => {
    const fields = [{ key: "employer" }, { key: "job_title" }, { key: "shift" }];
    expect(restoredProfileFilled(fields, { employer: "employer", job_title: "jobTitle", shift: "shift", gone: "chapter", phone: "phone" }, { employer: "Metro", job_title: " ", shift: "Nights", gone: "x" })).toEqual({ employer: "employer", shift: "shift" });
    expect(restoredProfileFilled(undefined, null)).toEqual({});
    expect(acceptedFields({ a: "chapter", b: "chapter", "bad key": "shift", c: "phone", d: "shift" })).toEqual({ a: "chapter", d: "shift" });
    expect(acceptedFields(["chapter"])).toEqual({});
    rememberPendingAutofill("form-1", { local: "chapter", phone: "phone" });
    expect(pendingAutofillRecord("form-1")).toEqual({ local: "chapter" });
    rememberPendingAutofill("form-1", {});
    expect(pendingAutofillRecord("form-1")).toEqual({});
    rememberPendingAutofill("form-1", null);
    expect(pendingAutofillRecord("form-1")).toBeNull();
    localStorage.setItem("ug.forms.profileAutofillPending.form-2", "{not json");
    expect(pendingAutofillRecord("form-2")).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(pendingAutofillRecord("form-3", broken)).toBeNull();
    expect(() => rememberPendingAutofill("form-3", { local: "chapter" }, broken)).not.toThrow();
    localStorage.setItem("ug.forms.profileAutofillPending.form-4", "[\"chapter\"]");
    expect(pendingAutofillRecord("form-4")).toBeNull();
    const row = (data, error = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
    expect(await loadRecordedAutofill(row({ profile_autofill: { job_title: "jobTitle", x: "phone" } }), "form-1")).toEqual({ job_title: "jobTitle" });
    expect(await loadRecordedAutofill(row({ profile_autofill: ["jobTitle"] }), "form-1")).toBeNull();
    expect(await loadRecordedAutofill(row(null, { code: "42703" }), "form-1")).toBeNull();
  });

  it("sends only a known preference and only known field kinds", async () => {
    const ok = client({ preference: "never" });
    await saveFormAutofillPreference(ok, "never");
    expect(ok.rpc).toHaveBeenCalledWith("set_my_form_autofill_preference", { p_preference: "never" });
    await expect(saveFormAutofillPreference(ok, "sometimes")).rejects.toThrow();
    await recordFormProfileAutofill(ok, "form-1", { job_title: "jobTitle", phone: "phone", title2: "jobTitle", local: "chapter" });
    expect(ok.rpc).toHaveBeenLastCalledWith("record_form_profile_autofill", { p_form_id: "form-1", p_fields: { job_title: "jobTitle", local: "chapter" } });
    await recordFormProfileAutofill(ok, "form-1", null);
    expect(ok.rpc).toHaveBeenLastCalledWith("record_form_profile_autofill", { p_form_id: "form-1", p_fields: {} });
    const api = createFormAutofillApi(client({ preference: "ask", values: {} }));
    expect(await api.load()).toMatchObject({ preference: "ask" });
    await api.savePreference("ask");
    await api.record("form-2", { shift: "shift" });
  });
});

// A form template an organization authored, with workplace fields.
const WORKPLACE_TEMPLATE = {
  key: "workplace_report",
  version: 1,
  icon: "🧾",
  titleKey: "Workplace report",
  blurbKey: "Tell us about your job",
  points: 0,
  source: "db",
  steps: [{
    titleKey: "Your job",
    fields: [
      { key: "employer", type: "text", labelKey: "Employer", required: false },
      { key: "job_title", type: "text", labelKey: "Job title", required: false },
      { key: "shift", type: "text", labelKey: "Shift", required: false },
      { key: "what_happened", type: "textarea", labelKey: "What happened", required: false },
    ],
  }],
};

function autofillApi(overrides = {}) {
  return {
    load: vi.fn(async () => ({ preference: "ask", shared: true, values: VALUES })),
    savePreference: vi.fn(async () => ({})),
    record: vi.fn(async () => ({})),
    ...overrides,
  };
}

function renderForms({ api = autofillApi(), forms = [], onSaveDraft = vi.fn(async () => "form-1"), onSubmit = vi.fn(async () => ({})), lang = "en" } = {}) {
  render(
    <LanguageProvider lang={lang}>
      <FormsView
        data={{ member: { id: "m1", initials: "MV" }, forms, formTemplates: [WORKPLACE_TEMPLATE] }}
        onSaveDraft={onSaveDraft}
        onSubmit={onSubmit}
        formAutofillApi={api}
      />
    </LanguageProvider>,
  );
  return { api, onSaveDraft, onSubmit };
}

const openTemplate = () => fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));

describe("a schema-driven form", () => {
  it("asks first, fills nothing until the member says yes, then marks each filled field and records the kinds", async () => {
    const { api, onSaveDraft } = renderForms();
    openTemplate();
    const offer = await screen.findByRole("region", { name: "Fill in your workplace details from your profile?" });
    expect(within(offer).getByText(/Metro Transit Authority/)).toBeInTheDocument();
    expect(within(offer).getByText(/Bus operator/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("");
    expect(onSaveDraft).not.toHaveBeenCalled();
    fireEvent.click(within(offer).getByRole("button", { name: "Yes, fill them in" }));
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("Metro Transit Authority");
    expect(screen.getByRole("textbox", { name: "Job title" })).toHaveValue("Bus operator");
    expect(screen.getByRole("textbox", { name: "Shift" })).toHaveValue("");
    expect(screen.getAllByText("From your profile")).toHaveLength(2);
    await screen.findByText("Filled 2 fields from your profile. You can change any of them.");
    await waitFor(() => expect(api.record).toHaveBeenCalledWith("form-1", { employer: "employer", job_title: "jobTitle" }));
    expect(onSaveDraft.mock.calls[0][0].answers).toMatchObject({ employer: "Metro Transit Authority", job_title: "Bus operator" });
    fireEvent.change(screen.getByRole("textbox", { name: "Job title" }), { target: { value: "Senior bus operator" } });
    expect(screen.getAllByText("From your profile")).toHaveLength(1);
  });

  it("leaves the fields blank on a no and records nothing", async () => {
    const { api } = renderForms();
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "No, leave them blank" }));
    expect(screen.queryByRole("region", { name: /Fill in your workplace details/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("");
    expect(api.record).not.toHaveBeenCalled();
  });

  it("fills at once when the member's answer is always, and never asks when it is never", async () => {
    const always = autofillApi({ load: vi.fn(async () => ({ preference: "always", shared: true, values: VALUES })) });
    renderForms({ api: always });
    openTemplate();
    await screen.findByText("Filled 2 fields from your profile, as your Settings ask. You can change any of them.");
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("Metro Transit Authority");
    await waitFor(() => expect(always.record).toHaveBeenCalled());
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    clearDeviceParityState();
    const never = autofillApi({ load: vi.fn(async () => ({ preference: "never", shared: true, values: VALUES })) });
    renderForms({ api: never });
    openTemplate();
    await waitFor(() => expect(never.load).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: /Fill in your workplace details/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("");
  });

  it("says where to share the work details when they are kept private, in Spanish too", async () => {
    const unshared = autofillApi({ load: vi.fn(async () => ({ preference: "ask", shared: false, values: { ...VALUES, jobTitle: null, worksite: null } })) });
    renderForms({ api: unshared, lang: "es" });
    openTemplate();
    const offer = await screen.findByRole("region", { name: "¿Llenar tus datos de trabajo con tu perfil?" });
    expect(within(offer).queryByText(/Bus operator/)).toBeNull();
    expect(within(offer).getByText(/no se comparten con tu organización/)).toBeInTheDocument();
  });

  it("says so when the record could not be written, and the form keeps its values", async () => {
    const failing = autofillApi({ record: vi.fn(async () => { throw new Error("down"); }) });
    renderForms({ api: failing });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your form could not note which fields came from your profile. Try again.");
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("Metro Transit Authority");
  });

  it("holds the submission while an accepted autofill is unrecorded, then records it and submits", async () => {
    rememberPendingAutofill("form-9", { employer: "employer" });
    const draft = { id: "form-9", templateKey: "workplace_report", status: "draft", step: 0, answers: { employer: "Metro Transit Authority", what_happened: "Shift swap refused" }, filerSignatureDigest: "digest", cosigners: [], files: [] };
    let down = true;
    const recorder = autofillApi({ record: vi.fn(async () => { if (down) throw new Error("down"); return {}; }) });
    const { onSubmit } = renderForms({ api: recorder, forms: [draft], onSaveDraft: vi.fn(async () => "form-9") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    await screen.findByText("From your profile");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const submit = await screen.findByRole("button", { name: "Submit for committee review" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(await screen.findByText("Your form could not note which fields came from your profile. Try again.")).toBeInTheDocument();
    await waitFor(() => expect(submit).not.toBeDisabled());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(pendingAutofillRecord("form-9")).toEqual({ employer: "employer" });
    down = false;
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("form-9", expect.objectContaining({ attachmentIds: expect.any(Array) })));
    expect(recorder.record).toHaveBeenLastCalledWith("form-9", { employer: "employer" });
    expect(pendingAutofillRecord("form-9")).toBeNull();
  });

  it("records an edit that makes a filled field the member's own with the next save", async () => {
    const { api } = renderForms();
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await waitFor(() => expect(api.record).toHaveBeenCalledWith("form-1", { employer: "employer", job_title: "jobTitle" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Job title" }), { target: { value: "Lead operator" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.record).toHaveBeenLastCalledWith("form-1", { employer: "employer" }));
  });

  it("records the fields a save carried, not an edit made while that save was in flight", async () => {
    let commit;
    const onSaveDraft = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { commit = resolve; }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("form-6");
    const { api } = renderForms({ onSaveDraft });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    // The member makes the employer their own before the first save commits.
    fireEvent.change(screen.getByRole("textbox", { name: "Employer" }), { target: { value: "City of Springfield" } });
    await act(async () => { commit("form-6"); });
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(2));
    // The committed answers still hold the profile employer, and so does the record.
    expect(api.record.mock.calls).toEqual([["form-6", { employer: "employer", job_title: "jobTitle" }]]);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.record).toHaveBeenLastCalledWith("form-6", { job_title: "jobTitle" }));
  });

  it("retries an unrecorded autofill on Close, and stays open while it cannot be written", async () => {
    let down = true;
    const recorder = autofillApi({ record: vi.fn(async () => { if (down) throw new Error("down"); return {}; }) });
    renderForms({ api: recorder });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your form could not note which fields came from your profile.");
    const close = screen.getByRole("button", { name: /Close form/ });
    fireEvent.click(close);
    await waitFor(() => expect(recorder.record).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(close).not.toBeDisabled());
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("Metro Transit Authority");
    down = false;
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Employer" })).toBeNull());
    expect(recorder.record).toHaveBeenLastCalledWith("form-1", { employer: "employer", job_title: "jobTitle" });
    expect(pendingAutofillRecord("form-1")).toBeNull();
  });

  it("records an accepted autofill once a later save succeeds, after the first save failed", async () => {
    const onSaveDraft = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("form-5");
    const { api } = renderForms({ onSaveDraft });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    expect(api.record).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.record).toHaveBeenCalledWith("form-5", { employer: "employer", job_title: "jobTitle" }));
  });

  it("keeps marks the device parity snapshot carries, and asks a draft it cannot check", async () => {
    // The phone and desktop layouts share the editor's state through device parity.
    applyDeviceParityState("forms.form-3.profileFilled", { employer: "employer" });
    const kept = { id: "form-3", templateKey: "workplace_report", status: "draft", step: 0, answers: { employer: "Metro Transit Authority" }, cosigners: [], files: [] };
    const api = autofillApi();
    renderForms({ api, forms: [kept], onSaveDraft: vi.fn(async () => "form-3") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    expect(await screen.findAllByText("From your profile")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /Fill in your workplace details/ })).toBeNull();
    cleanup();
    clearDeviceParityState();
    const draft = { id: "form-4", templateKey: "workplace_report", status: "draft", step: 0, answers: {}, cosigners: [], files: [] };
    renderForms({ api: autofillApi({ loadRecorded: undefined }), forms: [draft], onSaveDraft: vi.fn(async () => "form-4") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    expect(await screen.findByRole("region", { name: "Fill in your workplace details from your profile?" })).toBeInTheDocument();
  });

  it("keeps what the member typed before answering, and works without a record writer", async () => {
    const api = autofillApi({ record: undefined, load: vi.fn(async () => ({ preference: "ask", shared: true, values: { employer: "Metro Transit Authority" } })) });
    renderForms({ api });
    openTemplate();
    const offer = await screen.findByRole("region", { name: "Fill in your workplace details from your profile?" });
    fireEvent.change(screen.getByRole("textbox", { name: "Employer" }), { target: { value: "City of Springfield" } });
    fireEvent.click(within(offer).getByRole("button", { name: "Yes, fill them in" }));
    expect(screen.getByRole("textbox", { name: "Employer" })).toHaveValue("City of Springfield");
    expect(screen.queryByText("From your profile")).toBeNull();
  });

  it("restores a reopened draft's marks from what it recorded, and does not ask again", async () => {
    const draft = { id: "form-7", templateKey: "workplace_report", status: "draft", step: 0, answers: { employer: "Metro Transit Authority", job_title: "Bus operator" }, cosigners: [], files: [] };
    const api = autofillApi({ loadRecorded: vi.fn(async () => ({ employer: "employer" })) });
    renderForms({ api, forms: [draft], onSaveDraft: vi.fn(async () => "form-7") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    await screen.findByText("From your profile");
    expect(screen.getAllByText("From your profile")).toHaveLength(1);
    expect(api.loadRecorded).toHaveBeenCalledWith("form-7");
    expect(screen.queryByRole("region", { name: /Fill in your workplace details/ })).toBeNull();
  });

  it("retries a record that failed before, from this device, when the reopened draft is submitted", async () => {
    rememberPendingAutofill("form-8", { employer: "employer" });
    const draft = { id: "form-8", templateKey: "workplace_report", status: "draft", step: 0, answers: { employer: "Metro Transit Authority" }, filerSignatureDigest: "digest", cosigners: [], files: [] };
    const api = autofillApi({ loadRecorded: vi.fn(async () => ({})) });
    const { onSubmit } = renderForms({ api, forms: [draft], onSaveDraft: vi.fn(async () => "form-8") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    await screen.findByText("From your profile");
    expect(api.loadRecorded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const submit = await screen.findByRole("button", { name: "Submit for committee review" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("form-8", expect.objectContaining({ attachmentIds: expect.any(Array) })));
    expect(api.record).toHaveBeenCalledWith("form-8", { employer: "employer" });
    expect(pendingAutofillRecord("form-8")).toBeNull();
  });

  it("writes a pending empty record (the last mark was removed) before it submits", async () => {
    rememberPendingAutofill("form-2", {});
    const draft = { id: "form-2", templateKey: "workplace_report", status: "draft", step: 0, answers: { job_title: "Lead operator" }, filerSignatureDigest: "digest", cosigners: [], files: [] };
    const api = autofillApi({ loadRecorded: vi.fn(async () => ({ job_title: "jobTitle" })) });
    const { onSubmit } = renderForms({ api, forms: [draft], onSaveDraft: vi.fn(async () => "form-2") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    const submit = await screen.findByRole("button", { name: "Submit for committee review" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("form-2", expect.objectContaining({ attachmentIds: expect.any(Array) })));
    expect(api.record).toHaveBeenCalledWith("form-2", {});
    expect(api.loadRecorded).not.toHaveBeenCalled();
    expect(screen.queryByText("From your profile")).toBeNull();
  });

  it("records the autofill a save carries when it commits after the editor closed", async () => {
    let commit;
    const onSaveDraft = vi.fn(() => new Promise((resolve) => { commit = resolve; }));
    const { api } = renderForms({ onSaveDraft });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    cleanup();
    clearDeviceParityState();
    // Reopened while that save is still in flight: the lane's save carries the marks.
    renderForms({ api, onSaveDraft });
    openTemplate();
    expect(await screen.findAllByText("From your profile")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: /Fill in your workplace details/ })).toBeNull();
    cleanup();
    await act(async () => { commit("form-3"); });
    await waitFor(() => expect(api.record).toHaveBeenCalledWith("form-3", { employer: "employer", job_title: "jobTitle" }));
  });

  it("keeps an id-less autofill under the member and template until the outbox draft is reopened, then records it", async () => {
    const offline = vi.fn(async () => { throw new Error("offline, kept in the outbox"); });
    renderForms({ onSaveDraft: offline });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await waitFor(() => expect(offline).toHaveBeenCalled());
    expect(pendingAutofillRecord("member:m1:workplace_report")).toEqual({ employer: "employer", job_title: "jobTitle" });
    // A reload: the outbox replays the answers into a draft, without its autofill.
    cleanup();
    clearDeviceParityState();
    endFormDraftSession();
    const draft = { id: "form-11", templateKey: "workplace_report", status: "draft", step: 0, answers: { employer: "Metro Transit Authority", job_title: "Bus operator" }, filerSignatureDigest: "digest", cosigners: [], files: [] };
    const api = autofillApi({ loadRecorded: vi.fn(async () => ({})) });
    const { onSubmit } = renderForms({ api, forms: [draft], onSaveDraft: vi.fn(async () => "form-11") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    expect(await screen.findAllByText("From your profile")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const submit = await screen.findByRole("button", { name: "Submit for committee review" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("form-11", expect.objectContaining({ attachmentIds: expect.any(Array) })));
    expect(api.record).toHaveBeenCalledWith("form-11", { employer: "employer", job_title: "jobTitle" });
    expect(pendingAutofillRecord("member:m1:workplace_report")).toBeNull();
  });

  it("keeps a pending map whole when the editor opens before the outbox has replayed its answers", async () => {
    rememberPendingAutofill("member:m1:workplace_report", { employer: "employer", job_title: "jobTitle" });
    renderForms();
    openTemplate();
    await screen.findByRole("textbox", { name: "Employer" });
    await waitFor(() => expect(screen.queryByRole("region", { name: /Fill in your workplace details/ })).toBeNull());
    expect(screen.queryByText("From your profile")).toBeNull();
    expect(pendingAutofillRecord("member:m1:workplace_report")).toEqual({ employer: "employer", job_title: "jobTitle" });
  });

  it("keeps the pending record under the draft's id while its record is in flight", async () => {
    let finish;
    const api = autofillApi({ record: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    renderForms({ api });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await waitFor(() => expect(api.record).toHaveBeenCalled());
    expect(pendingAutofillRecord("form-1")).toEqual({ employer: "employer", job_title: "jobTitle" });
    expect(pendingAutofillRecord("member:m1:workplace_report")).toBeNull();
    await act(async () => { finish({}); });
    await waitFor(() => expect(pendingAutofillRecord("form-1")).toBeNull());
  });

  it("keeps a failed record pending, and asks a reopened draft whose record cannot be read", async () => {
    const failing = autofillApi({ record: vi.fn(async () => { throw new Error("down"); }) });
    renderForms({ api: failing });
    openTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await screen.findByRole("alert");
    expect(pendingAutofillRecord("form-1")).toEqual({ employer: "employer", job_title: "jobTitle" });
    cleanup();
    clearDeviceParityState();
    const draft = { id: "form-6", templateKey: "workplace_report", status: "draft", step: 0, answers: {}, cosigners: [], files: [] };
    const unreadable = autofillApi({ loadRecorded: vi.fn(async () => { throw new Error("down"); }) });
    renderForms({ api: unreadable, forms: [draft], onSaveDraft: vi.fn(async () => "form-6") });
    fireEvent.click(screen.getByRole("button", { name: /Workplace report/ }));
    expect(await screen.findByRole("region", { name: "Fill in your workplace details from your profile?" })).toBeInTheDocument();
  });

  it("keeps an organization's explicit hint through the template adapter and the editor's save", async () => {
    const row = { key: "role_form", version: 1, label_en: "Role form", label_es: "Formulario de puesto", blurb_en: "Tell us about your role.", blurb_es: "Cuéntanos sobre tu puesto.", icon: "📄", points: 5, active: true, sort: 1,
      field_schema: { steps: [{ title: { en: "Step", es: "Paso" }, fields: [{ key: "position", type: "text", label: { en: "Role", es: "Rol" }, required: false, maxLength: 120, autofill: "jobTitle" }, { key: "other", type: "text", label: { en: "Other", es: "Otro" }, required: false, maxLength: 120, autofill: "salary" }] }] } };
    const template = templateFromDbRow(row);
    expect(template.steps[0].fields.map((field) => field.autofill)).toEqual(["jobTitle", undefined]);
    expect(autofillProposal(templateAutofillFields(template), VALUES)).toEqual([{ fieldKey: "position", kind: "jobTitle", value: "Bus operator" }]);
    const api = { loadFormTemplates: vi.fn().mockResolvedValue([row]), upsertFormTemplate: vi.fn().mockResolvedValue({ key: "role_form", version: 2, active: true }), deactivateFormTemplate: vi.fn(), reactivateFormTemplate: vi.fn() };
    render(<LanguageProvider lang="en"><AdminFormTemplateEditor api={api} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit / new version" }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1));
    expect(api.upsertFormTemplate.mock.calls[0][0].fieldSchema.steps[0].fields.map((field) => field.autofill)).toEqual(["jobTitle", undefined]);
  });

  it("offers nothing when the form has no matching field or the read fails", async () => {
    const failing = autofillApi({ load: vi.fn(async () => { throw new Error("down"); }) });
    renderForms({ api: failing });
    openTemplate();
    await waitFor(() => expect(failing.load).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: /Fill in your workplace details/ })).toBeNull();
  });
});

function frameOf(container) {
  const frame = container.querySelector("iframe");
  const posted = [];
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: (message) => posted.push(message) }, configurable: true });
  const send = (data) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow })); });
  return { posted, send };
}

describe("an organization's own HTML form", () => {
  const html = "<!doctype html><html><head><title>Example form</title></head><body><input name='employer'></body></html>";

  it("lists the frame's empty fields, asks, and sends only the matching values after a yes", async () => {
    const api = autofillApi();
    const { container } = render(<LanguageProvider lang="en"><OrganizationFormViewer html={html} title="Example form" onClose={() => {}} autofillApi={api} /></LanguageProvider>);
    const { posted, send } = frameOf(container);
    send({ type: "ug-org-form:ready" });
    expect(posted.at(-1)).toEqual({ type: "ug-org-form:fields" });
    send({ type: "ug-org-form:fields-result", fields: [
      { ref: "f0", name: "employer", label: "Employer", autocomplete: "", filled: false },
      { ref: "f1", name: "job", label: "Job title", autocomplete: "", filled: true },
      { ref: "f2", name: "notes", label: "Notes", autocomplete: "", filled: false },
      { ref: "f3", name: "job_title", label: "Position", autocomplete: "", filled: false },
    ] });
    const offer = await screen.findByRole("region", { name: "Fill in your workplace details from your profile?" });
    expect(posted.some((message) => message.type === "ug-org-form:autofill")).toBe(false);
    fireEvent.click(within(offer).getByRole("button", { name: "Yes, fill them in" }));
    expect(posted.at(-1)).toEqual({ type: "ug-org-form:autofill", fills: [{ ref: "f0", kind: "employer", value: "Metro Transit Authority" }, { ref: "f3", kind: "jobTitle", value: "Bus operator" }] });
    send({ type: "ug-org-form:autofill-result", filled: ["f0", "f3"] });
    expect(await screen.findByText("Filled 2 fields from your profile. You can change any of them.")).toBeInTheDocument();
  });

  it("fills at once in the frame when the member's answer is always", async () => {
    const api = autofillApi({ load: vi.fn(async () => ({ preference: "always", shared: true, values: VALUES })) });
    const { container } = render(<LanguageProvider lang="en"><OrganizationFormViewer html={html} title="Example form" onClose={() => {}} autofillApi={api} /></LanguageProvider>);
    const { posted, send } = frameOf(container);
    send({ type: "ug-org-form:ready" });
    send({ type: "ug-org-form:fields-result", fields: [{ ref: "f0", name: "employer", label: "", autocomplete: "", filled: false }, { name: "no ref" }] });
    await waitFor(() => expect(posted.at(-1)).toEqual({ type: "ug-org-form:autofill", fills: [{ ref: "f0", kind: "employer", value: "Metro Transit Authority" }] }));
    send({ type: "ug-org-form:autofill-result", filled: "not a list" });
    expect(await screen.findByText(/as your Settings ask/)).toBeInTheDocument();
  });

  it("asks the frame nothing without the autofill API", () => {
    const { container } = render(<LanguageProvider lang="en"><OrganizationFormViewer html={html} title="Example form" onClose={() => {}} /></LanguageProvider>);
    const { posted, send } = frameOf(container);
    send({ type: "ug-org-form:ready" });
    expect(posted.some((message) => message.type === "ug-org-form:fields")).toBe(false);
  });

  it("fills and marks fields inside the frame, and drops a mark once the member edits the field", () => {
    document.documentElement.setAttribute("data-ug-form-frame", "embedded");
    document.body.innerHTML = "<label for='emp'>Employer</label><input id='emp' type='text'><textarea aria-label='Notes'>kept</textarea><input type='date' name='when'><input type='text' disabled>"
      + "<div class='phone' style='display:none'><input name='job' type='text' aria-label='Job title'></div><input name='job' type='text' aria-label='Job title' id='job-desk'><input hidden type='text' name='spare'>"
      + "<form id='witness' hidden><input name='job' type='text' aria-label='Witness job'></form>";
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(window, "parent", { value: parent, configurable: true });
    try {
      window.__ugOrgFormKit = false;
      // eslint-disable-next-line no-new-func
      new Function(ORG_FORM_KIT_SOURCE)();
      const send = (data) => window.dispatchEvent(new MessageEvent("message", { data, source: parent }));
      send({ type: "ug-org-form:fields" });
      const listed = parent.postMessage.mock.calls.map(([message]) => message).find((message) => message.type === "ug-org-form:fields-result");
      expect(listed.fields).toEqual([
        { ref: "f0", name: "emp", label: "Employer", autocomplete: "", filled: false },
        { ref: "f1", name: "", label: "Notes", autocomplete: "", filled: true },
        { ref: "f2", name: "job", label: "Job title", autocomplete: "", filled: false },
        { ref: "f3", name: "spare", label: "", autocomplete: "", filled: false },
        { ref: "f4", name: "job", label: "Witness job", autocomplete: "", filled: false },
      ]);
      send({ type: "ug-org-form:autofill", fills: [{ ref: "f0", kind: "employer", value: "Metro Transit Authority" }, { ref: "f1", kind: "shift", value: "Nights" }, { ref: "f2", kind: "jobTitle", value: "Bus operator" }, { ref: 7 }] });
      const result = parent.postMessage.mock.calls.map(([message]) => message).find((message) => message.type === "ug-org-form:autofill-result");
      expect(result.filled).toEqual(["f0", "f2"]);
      // The hidden phone-view mirror of the job field (same name) is filled with it.
      // The witness form's own job field is a different field, and stays empty.
      expect([...document.querySelectorAll("input[name='job']")].map((node) => node.value)).toEqual(["Bus operator", "Bus operator", ""]);
      const input = document.getElementById("emp");
      expect(input.value).toBe("Metro Transit Authority");
      expect(input.getAttribute("data-ug-profile-filled")).toBe("employer");
      expect(input.nextElementSibling.textContent).toBe("From your profile");
      expect(document.querySelector("textarea").value).toBe("kept");
      input.value = "Metro Transit";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.hasAttribute("data-ug-profile-filled")).toBe(false);
      expect(input.nextElementSibling?.classList.contains("ug-profile-filled")).not.toBe(true);
      expect(document.getElementById("job-desk").getAttribute("data-ug-profile-filled")).toBe("jobTitle");
      // #6752: editing the visible job field carries every keystroke to the hidden
      // mirror it filled, unmarks both, and leaves the witness field alone.
      const desk = document.getElementById("job-desk");
      for (const value of ["D", "Driver"]) {
        desk.value = value;
        desk.dispatchEvent(new Event("input", { bubbles: true }));
      }
      expect([...document.querySelectorAll("input[name='job']")].map((node) => node.value)).toEqual(["Driver", "Driver", ""]);
      expect(document.querySelectorAll("input[name='job'][data-ug-profile-filled]")).toHaveLength(0);
      expect(document.querySelectorAll(".ug-profile-filled")).toHaveLength(0);
      const saved = window.ugOrgFormSnapshot();
      expect(saved).not.toContain("Bus operator");
      expect(saved).toContain("Driver");
    } finally {
      delete window.parent;
      document.documentElement.removeAttribute("data-ug-form-frame");
      document.body.innerHTML = "";
    }
  });
});

describe("the Settings choice", () => {
  // The choice keeps focus while it saves, and two
  // choices in one tick save one (the change commits its pending state before
  // the next event, so the pending select refuses without a lock).
  const showSetting = (api) => render(<LanguageProvider lang="en"><FormAutofillSetting api={api} uid="u" t={(key) => formAutofillCatalogue.en[key] ?? key} /></LanguageProvider>);
  it("saves one answer when two are chosen in one tick", async () => {
    const api = autofillApi();
    showSetting(api);
    const select = await screen.findByRole("combobox", { name: "When a form has workplace fields" });
    await expectOneWriteFromOneTick(api.savePreference, [
      () => fireEvent.change(select, { target: { value: "always" } }),
      () => fireEvent.change(select, { target: { value: "never" } }),
    ]);
    await screen.findByText("Choice saved.");
    expect(api.savePreference.mock.calls).toEqual([["always"]]);
  });

  it("keeps the choice focused while it saves", async () => {
    const api = autofillApi();
    showSetting(api);
    const select = await screen.findByRole("combobox", { name: "When a form has workplace fields" });
    await expectHeldWriteFocus(api.savePreference, select, () => fireEvent.change(select, { target: { value: "always" } }));
  });

  it("shows what a form may fill and saves the member's answer", async () => {
    const api = autofillApi();
    render(<LanguageProvider lang="en"><FormAutofillSetting api={api} uid="u" t={(key) => formAutofillCatalogue.en[key] ?? key} /></LanguageProvider>);
    expect(screen.getByText(/only if you share them with administrators/)).toBeInTheDocument();
    const select = await screen.findByRole("combobox", { name: "When a form has workplace fields" });
    expect(select).toHaveValue("ask");
    fireEvent.change(select, { target: { value: "always" } });
    await screen.findByText("Choice saved.");
    expect(api.savePreference).toHaveBeenCalledWith("always");
  });

  it("puts the old answer back when the save fails, and says when it cannot load", async () => {
    const api = autofillApi({ savePreference: vi.fn(async () => { throw new Error("down"); }) });
    const t = (key) => formAutofillCatalogue.en[key] ?? key;
    render(<FormAutofillSetting api={api} uid="u" t={t} />);
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "never" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Your choice was not saved.");
    expect(select).toHaveValue("ask");
    cleanup();
    render(<FormAutofillSetting api={autofillApi({ load: vi.fn(async () => { throw new Error("down"); }) })} uid="u" t={t} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your choice could not be loaded.");
  });

  it("declares every key in both languages", () => {
    expect(Object.keys(formAutofillCatalogue.es).sort()).toEqual(Object.keys(formAutofillCatalogue.en).sort());
  });
});
