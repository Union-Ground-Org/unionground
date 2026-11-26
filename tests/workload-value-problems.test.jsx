// BUG-UG-NATIVE-WORKLOAD-LOG-SAVE-REFUSAL-NAMES-NO-FIELD-20261118:
// a refused workload save named no field. The shared rules now list every
// refused field and the rule it broke (workloadValueProblems); the first one is
// still exactly what workloadValuesError answered, so the database and the
// earlier callers see no change. The website form shows each note beside its
// field, as the phone does.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadConfiguredEntry } from "../src/components/WorkloadConfiguredEntry.jsx";
import { defaultWorkloadDefinition, workloadDefinitionError, workloadValueProblems, workloadValuesError } from "../src/lib/workloadConfiguration.js";

const definition = defaultWorkloadDefinition();
const required = { ...definition, fields: definition.fields.map((f) => (f.key === "workedOn" ? { ...f, required: true } : f)) };

describe("workloadValueProblems", () => {
  const cases = [
    [{}, []],
    [{ hoursWorked: 46 }, [["hoursWorked", "dayHours", 24]]],
    [{ hoursWorked: 7.3 }, [["hoursWorked", "dayHours", 24]]],
    [{ hoursWorked: -1 }, [["hoursWorked", "dayHours", 24]]],
    [{ pending: 2.5, weeklyAssigned: 301 }, [["pending", "wholeNumber", 300], ["weeklyAssigned", "wholeNumber", 300]]],
    [{ otWorked: true }, [["otHours", "overtimeHoursNeeded", undefined]]],
    [{ otWorked: false, otHours: 3 }, [["otHours", "overtimeNotMarked", undefined]]],
    [{ otWorked: true, otHours: 100 }, [["otHours", "wholeNumber", 99]]],
    [{ employment: "part_time" }, [["ptHours", "partTimeHoursNeeded", undefined]]],
    [{ leaveType: "fmla" }, [["leaveTiming", "leaveTimingNeeded", undefined]]],
    [{ workedOn: "2026-02-30" }, [["workedOn", "date", undefined]]],
    [{ workedOn: "2999-01-01" }, [["workedOn", "futureDate", undefined]]],
    [{ note: "x".repeat(501) }, [["note", "textLength", 500]]],
    [{ employment: "contract" }, [["employment", "choice", undefined]]],
    [{ priority: 1_000_001 }, [["priority", "wholeNumber", 300]]],
  ];
  it.each(cases)("lists every refused field for %j, and the first is workloadValuesError", (values, expected) => {
    const result = workloadValueProblems(definition, values, "logged");
    expect(result.form).toBeNull();
    expect(result.fields.map((p) => [p.key, p.rule, p.limit])).toEqual(expected);
    expect(workloadValuesError(definition, values, "logged")).toBe(expected[0]?.[0] ?? null);
  });
  it("names an empty required field and keeps the form-level answers", () => {
    expect(workloadValueProblems(required, { hoursWorked: 46 }, "logged").fields.map((p) => [p.key, p.rule]))
      .toEqual([["workedOn", "required"], ["hoursWorked", "dayHours"]]);
    expect(workloadValueProblems(definition, {}, "draft")).toEqual({ form: "status", fields: [] });
    expect(workloadValueProblems(definition, { invented: 1 }, "logged")).toEqual({ form: "unknown", fields: [] });
    // Eight full text answers pass each field's limit but not the entry's 3,500 bytes.
    const texts = { ...definition, fields: Array.from({ length: 8 }, (_, index) => ({ ...definition.fields.find((f) => f.key === "note"), key: `text${index}`, label: `Text ${index}` })) };
    const long = Object.fromEntries(texts.fields.map((f) => [f.key, "x".repeat(500)]));
    expect(workloadValueProblems(texts, long, "logged")).toEqual({ form: "size", fields: [] });
    for (const [form, values, status] of [[definition, {}, "draft"], [definition, { invented: 1 }, "logged"], [texts, long, "logged"]]) {
      expect(workloadValuesError(form, values, status)).toBe(workloadValueProblems(form, values, status).form);
    }
  });
});

// A configured key that names an Object.prototype property
// (constructor, toString) must keep a valid answer valid; no limit or note is
// read through the prototype. __proto__ is no configurable key at all.
const customField = (key, type, label) => ({ key, label, type, kind: "field", required: false, visible: true, retired: false, unit: "", summary: "none", options: [] });
const custom = { title: "Tamarack visits", period: "week", statuses: ["logged"], fields: [customField("constructor", "text", "Task details"), customField("toString", "number", "Visit hours"), customField("valueOf", "number", "Visits")] };

describe("custom keys that name Object.prototype properties", () => {
  it("accepts valid text and decimal answers for constructor, toString and valueOf", () => {
    const values = { constructor: "case review", toString: 7.5, valueOf: 3 };
    expect(workloadValueProblems(custom, values, "logged")).toEqual({ form: null, fields: [] });
    expect(workloadValuesError(custom, values, "logged")).toBeNull();
  });
  it("still names a refused custom key with its own rule, not an inherited one", () => {
    // Every custom field is answered: an empty one keyed constructor or valueOf is
    // still read through the prototype on Main, a separate finding.
    expect(workloadValueProblems(custom, { constructor: "x".repeat(501), toString: -1, valueOf: 3 }, "logged").fields)
      .toEqual([{ key: "constructor", rule: "textLength", limit: 500 }, { key: "toString", rule: "number", limit: 1000000 }]);
  });
  it("refuses a __proto__ answer as an unknown field and allows no __proto__ key in a definition", () => {
    const values = JSON.parse('{"__proto__": 4, "constructor": "case review"}');
    expect(Object.hasOwn(values, "__proto__")).toBe(true);
    expect(workloadValueProblems(custom, values, "logged")).toEqual({ form: "unknown", fields: [] });
    expect(workloadDefinitionError({ ...custom, fields: [...custom.fields, customField("__proto__", "number", "Proto")] })).toBeTruthy();
  });
});

describe("the website workload form names each refused field (#9101)", () => {
  const configuration = { organizationId: "fictional-tamarack", version: 1, definition: required };
  const mount = (lang, onSave) => render(<LanguageProvider lang={lang}><WorkloadConfiguredEntry configuration={configuration} onSave={onSave} /></LanguageProvider>);
  const input = (key) => document.querySelector(`#workload-entry-${key}`);

  it("says beside each field what to change, in Spanish, keeps what was typed, then saves the corrected week", async () => {
    const onSave = vi.fn().mockResolvedValue({ id: "saved" });
    const view = mount("es", onSave);
    fireEvent.change(input("hoursWorked"), { target: { value: "46" } });
    fireEvent.click(input("otWorked"));
    fireEvent.change(input("otHours"), { target: { value: "6" } });
    fireEvent.change(input("note"), { target: { value: "Semana del 14 al 20 de septiembre" } });
    fireEvent.submit(view.container.querySelector("form"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Revisa los campos marcados: Día trabajado, Horas trabajadas.");
    expect(input("hoursWorked")).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(input("hoursWorked").getAttribute("aria-describedby"))).toHaveTextContent("Escribe las horas de este único día: 24 o menos");
    expect(document.getElementById(input("workedOn").getAttribute("aria-describedby"))).toHaveTextContent("Obligatorio: escribe una fecha.");
    expect(input("otHours")).not.toHaveAttribute("aria-invalid");
    expect(input("hoursWorked").value).toBe("46");
    fireEvent.change(input("hoursWorked"), { target: { value: "7.5" } });
    expect(input("hoursWorked")).not.toHaveAttribute("aria-invalid");
    fireEvent.change(input("workedOn"), { target: { value: "2026-11-16" } });
    fireEvent.submit(view.container.querySelector("form"));
    await screen.findByText("Registro guardado.");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ values: expect.objectContaining({ hoursWorked: 7.5, workedOn: "2026-11-16", otWorked: true, otHours: 6 }) }));
  });

  it("states the limit in English", () => {
    const view = mount("en", vi.fn());
    fireEvent.change(input("workedOn"), { target: { value: "2026-11-16" } });
    fireEvent.change(input("weeklyAssigned"), { target: { value: "301" } });
    fireEvent.submit(view.container.querySelector("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("Check the marked fields: New issues this week.");
    expect(view.container.textContent).toContain("Enter a whole number from 0 to 300.");
  });

  it("translates an existing refusal and notes after the language changes, retaining the draft", () => {
    const onSave = vi.fn();
    const view = mount("en", onSave);
    fireEvent.change(input("hoursWorked"), { target: { value: "46" } });
    fireEvent.submit(view.container.querySelector("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("Check the marked fields: Day worked, Hours worked.");
    view.rerender(<LanguageProvider lang="es"><WorkloadConfiguredEntry configuration={configuration} onSave={onSave} /></LanguageProvider>);
    expect(screen.getByRole("alert")).toHaveTextContent("Revisa los campos marcados: Día trabajado, Horas trabajadas.");
    expect(view.container.textContent).not.toContain("Check the marked fields");
    expect(input("hoursWorked").value).toBe("46");
    expect(document.getElementById(input("hoursWorked").getAttribute("aria-describedby"))).toHaveTextContent("Escribe las horas de este único día: 24 o menos");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves valid answers for constructor and toString keys and draws no note beside them", async () => {
    const onSave = vi.fn().mockResolvedValue({ id: "saved" });
    const view = render(<LanguageProvider lang="en"><WorkloadConfiguredEntry configuration={{ organizationId: "fictional-tamarack", version: 2, definition: custom }} onSave={onSave} /></LanguageProvider>);
    fireEvent.change(input("constructor"), { target: { value: "case review" } });
    fireEvent.change(input("toString"), { target: { value: "7.5" } });
    fireEvent.change(input("valueOf"), { target: { value: "-1" } });
    fireEvent.submit(view.container.querySelector("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("Check the marked fields: Visits.");
    expect(input("constructor")).not.toHaveAttribute("aria-invalid");
    expect(input("toString")).not.toHaveAttribute("aria-invalid");
    expect(input("constructor").value).toBe("case review");
    fireEvent.change(input("valueOf"), { target: { value: "3" } });
    fireEvent.submit(view.container.querySelector("form"));
    await screen.findByText("Workload entry saved.");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ values: { constructor: "case review", toString: 7.5, valueOf: 3 } }));
  });
});
