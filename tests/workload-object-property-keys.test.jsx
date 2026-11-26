// BUG-UG-WORKLOAD-EMPTY-CUSTOM-FIELD-NAMED-LIKE-AN-OBJECT-PROPERTY-BLOCKS-THE-SAVE-20261118
// (#9123): an organization may key a workload field constructor, valueOf or
// toString (workloadDefinitionError admits ^[a-z][a-zA-Z0-9_]{0,39}$). Left
// empty, such an optional field was read through Object.prototype, counted as
// answered and refused, so the website form could not save; its input also
// showed the inherited function's text. Only own answers are read now.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadConfiguredEntry } from "../src/components/WorkloadConfiguredEntry.jsx";
import { defaultWorkloadDefinition, workloadDefinitionError, workloadValuesError } from "../src/lib/workloadConfiguration.js";

const field = (key, type, label) => ({ key, label, type, kind: "field", required: false, visible: true, retired: false, unit: "", summary: "none", options: [] });
const custom = { title: "Tamarack visits", period: "week", statuses: ["logged"], fields: [
  field("constructor", "text", "Task details"), field("valueOf", "number", "Visit hours"), field("toString", "text", "Site"), field("visits", "number", "Visits"),
] };

describe("the shared workload check reads only own answers (#9123)", () => {
  it("is a definition an organization may apply", () => {
    expect(workloadDefinitionError(custom)).toBeFalsy();
  });
  it("treats empty constructor, valueOf and toString fields as empty", () => {
    expect(workloadValuesError(custom, { visits: 3 }, "logged")).toBeNull();
    expect(workloadValuesError(custom, {}, "logged")).toBeNull();
  });
  it("still checks them when answered", () => {
    expect(workloadValuesError(custom, { constructor: "case review", valueOf: 7.5, toString: "North site", visits: 3 }, "logged")).toBeNull();
    expect(workloadValuesError(custom, { constructor: "x".repeat(501) }, "logged")).toBe("constructor");
    expect(workloadValuesError(custom, { valueOf: -1 }, "logged")).toBe("valueOf");
    expect(workloadValuesError({ ...custom, fields: custom.fields.map((f) => (f.key === "toString" ? { ...f, required: true } : f)) }, { visits: 3 }, "logged")).toBe("toString");
  });
  it("keeps the default form's answers as they were", () => {
    const definition = defaultWorkloadDefinition();
    expect(workloadValuesError(definition, {}, "logged")).toBeNull();
    expect(workloadValuesError(definition, { hoursWorked: 46 }, "logged")).toBe("hoursWorked");
    expect(workloadValuesError(definition, { otWorked: true }, "logged")).toBe("otHours");
    expect(workloadValuesError(definition, { pending: 2, otWorked: false }, "logged")).toBeNull();
  });
});

describe("the website workload form with such keys (#9123)", () => {
  it("shows the fields empty and saves an entry that leaves them empty", async () => {
    const onSave = vi.fn().mockResolvedValue({ id: "saved" });
    const view = render(<LanguageProvider lang="en"><WorkloadConfiguredEntry configuration={{ organizationId: "fictional-tamarack", version: 2, definition: custom }} onSave={onSave} /></LanguageProvider>);
    for (const key of ["constructor", "valueOf", "toString"]) {
      expect(document.querySelector(`#workload-entry-${key}`).value).toBe("");
    }
    expect(view.container.textContent).not.toContain("native code");
    fireEvent.change(document.querySelector("#workload-entry-visits"), { target: { value: "3" } });
    fireEvent.submit(view.container.querySelector("form"));
    await screen.findByText("Workload entry saved.");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ values: { visits: 3 } }));
  });
});
