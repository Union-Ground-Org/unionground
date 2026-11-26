import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FORM_TEMPLATES } from "../src/lib/formTemplates.js";

// REQ-UG-FORMS-SIGNATURE-ONLY-ON-SIGNED-STATEMENTS-20261115 (#8957):
// the website's editor drops the filer's signature, and lets Submit go
// without it, only for a template that is not a signed statement AND only
// once the server's filing status for the saved form says signatureRequired
// is false. The site can deploy before the migration is applied (#8965
// r1s2/r2s2); until then the old submit_form wants every signature, so a
// status without the field, a failed read or no status at all keeps it.

// A draft with every required answer given, opened on its review step.
function completeDraft(templateKey) {
  const template = FORM_TEMPLATES.find((item) => item.key === templateKey);
  const answers = {};
  for (const field of template.steps.flatMap((step) => step.fields)) {
    if (!field.required) continue;
    if (field.options?.length) answers[field.key] = field.type === "multiselect" ? [field.options[0].value] : field.options[0].value;
    else if (field.type === "date") answers[field.key] = "2026-11-02";
    else if (field.type === "checkbox") answers[field.key] = true;
    else answers[field.key] = "Fictional answer";
  }
  return { id: `${templateKey}-draft`, templateKey, status: "draft", step: template.steps.length, answers, cosigners: [], files: [] };
}

function openReview(templateKey, onFormFilingStatus) {
  const form = completeDraft(templateKey);
  render(
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: `sig-${templateKey}-${Math.random()}` }, forms: [form] }} focus={{ templateKey, formId: form.id }}
        onSaveDraft={vi.fn().mockResolvedValue(form.id)} onSubmit={vi.fn()} onSignForm={vi.fn()} onFormFilingStatus={onFormFilingStatus} />
    </LanguageProvider>,
  );
  return form;
}
const submitButton = () => screen.getByRole("button", { name: /Submit for committee review/ });
const signatureHint = () => screen.queryByText("Sign by drawing or by typing your name, and save it before submitting.");

describe("the filer signature follows the server's rule (website)", () => {
  it("lets a service request submit with no signature once the server says it may", async () => {
    const status = vi.fn().mockResolvedValue({ filerSigned: false, signatureRequired: false });
    const form = openReview("service_request", status);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(status).toHaveBeenCalledWith(form.id);
  });

  it.each([
    ["the server is older and sends no signatureRequired", () => vi.fn().mockResolvedValue({ filerSigned: false })],
    ["the server says a signature is required", () => vi.fn().mockResolvedValue({ filerSigned: false, signatureRequired: true })],
    ["the status read fails", () => vi.fn().mockRejectedValue(new Error("Filing status: unavailable"))],
    ["no status reader is wired", () => null],
  ])("keeps a service request's signature and Submit gate when %s", async (_case, makeStatus) => {
    const status = makeStatus();
    openReview("service_request", status);
    expect(await screen.findByRole("button", { name: /Submit for committee review/ })).toBeInTheDocument();
    if (status) await waitFor(() => expect(status).toHaveBeenCalled());
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(submitButton()).toBeDisabled();
    expect(signatureHint()).not.toBeNull();
  });

  it("holds a grievance's Submit until the filer signs, and never asks the server", async () => {
    const status = vi.fn().mockResolvedValue({ filerSigned: false, signatureRequired: false });
    openReview("grievance", status);
    expect(await screen.findByRole("button", { name: /Submit for committee review/ })).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(status).not.toHaveBeenCalled();
  });
});
