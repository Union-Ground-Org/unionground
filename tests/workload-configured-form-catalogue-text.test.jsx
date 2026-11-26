// BUG-UG-WORKLOAD-CONFIGURED-FORM-RAW-CHOICES-ENGLISH-20261106:
// once an organization applies a workload configuration, the original choices,
// the default status, units, labels and checkbox answers show catalogue text in
// en and es, while stored codes, the CSV export and admin-written text stay as is.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadConfiguredEntry } from "../src/components/WorkloadConfiguredEntry.jsx";
import { WorkloadConfiguredHistory } from "../src/components/WorkloadConfiguredHistory.jsx";
import { configuredWorkloadCsv, defaultWorkloadDefinition } from "../src/lib/workloadConfiguration.js";

const RAW = /\b(full_time|part_time|sick_leave|annual_leave|lwop|fmla|admin_leave|comp_time|planned|unplanned|logged|true|false)\b/;
const ENGLISH_DEFAULTS = /\b(Workload log|Employment|Leave timing|Note|Leave|count|hours|Yes|Logged|Full-time|Sick|Planned)\b/;
const configuration = () => ({ organizationId: "fictional-tamarack", version: 1, definition: defaultWorkloadDefinition() });
const entry = () => ({
  id: "entry-one", receipt: "R-1", dateLabel: "Nov 3", createdAt: "2026-11-03T12:00:00Z", status: "logged",
  configurationSnapshot: configuration(),
  values: { priority: 3, employment: "full_time", ptHours: 0, onPlan: true, otWorked: false, otHours: 0, leaveType: "sick_leave", leaveTiming: "planned", hoursWorked: 4, note: "Tamarack shift" },
});
const mount = (lang, node) => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
const optionTexts = (select) => within(select).getAllByRole("option").map((o) => o.textContent);

describe("configured workload form uses catalogue text for original fields", () => {
  for (const lang of ["en", "es"]) {
    it(`entry form shows no raw codes in ${lang}`, () => {
      const { container } = mount(lang, <WorkloadConfiguredEntry configuration={configuration()} onSave={async () => true} />);
      expect(container.textContent).not.toMatch(RAW);
      const selects = container.querySelectorAll("select");
      const employment = container.querySelector("#workload-entry-employment");
      expect(optionTexts(employment).slice(1)).toEqual(lang === "en" ? ["Full-time", "Part-time"] : ["Tiempo completo", "Tiempo parcial"]);
      expect([...employment.options].slice(1).map((o) => o.value)).toEqual(["full_time", "part_time"]);
      expect(optionTexts(container.querySelector("#workload-entry-leaveType")).slice(1)).toEqual(lang === "en"
        ? ["Sick", "Annual", "LWOP", "FMLA", "Admin", "Comp"] : ["Enfermedad", "Anual", "Sin goce", "FMLA", "Administrativa", "Compensatoria"]);
      expect(optionTexts(container.querySelector("#workload-entry-leaveTiming")).slice(1)).toEqual(lang === "en" ? ["Planned", "Unplanned"] : ["Planificada", "No planificada"]);
      const status = selects[selects.length - 1];
      expect(status.value).toBe("logged");
      expect(optionTexts(status)).toEqual([lang === "en" ? "Logged" : "Registrado"]);
      if (lang === "es") {
        expect(container.textContent).not.toMatch(ENGLISH_DEFAULTS);
        for (const text of ["Registro de carga de trabajo", "Empleo", "Licencia", "Momento de la licencia", "Nota", "(cantidad)", "(horas)"]) expect(container.textContent).toContain(text);
      } else {
        for (const text of ["Workload log", "Employment", "Leave timing", "Note", "(count)", "(hours)"]) expect(container.textContent).toContain(text);
      }
    });

    it(`history and its edit form show no raw codes in ${lang}`, () => {
      const { container } = mount(lang, <WorkloadConfiguredHistory entries={[entry()]} onSave={async () => true} />);
      expect(container.textContent).not.toMatch(RAW);
      const row = container.querySelector(".mwl-histrow");
      const yes = lang === "en" ? "Yes" : "Sí";
      for (const text of lang === "en" ? ["Logged", "Full-time", "Sick", "Planned", "Yes", "No"] : ["Registrado", "Tiempo completo", "Enfermedad", "Planificada", yes, "No"]) expect(row.textContent).toContain(text);
      if (lang === "es") expect(row.textContent).not.toMatch(ENGLISH_DEFAULTS);
      fireEvent.click(within(row).getByRole("button"));
      const form = container.querySelector(".workload-configured-form");
      expect(form.textContent).not.toMatch(RAW);
      expect(form.querySelector("#entry-one-employment").value).toBe("full_time");
      if (lang === "es") expect(form.textContent).not.toMatch(ENGLISH_DEFAULTS);
    });
  }

  it("keeps stored codes in the CSV export", () => {
    const csv = configuredWorkloadCsv([entry()]);
    for (const code of ['"logged"', '"full_time"', '"sick_leave"', '"planned"', '"true"', '"Employment"', '"hours"']) expect(csv).toContain(code);
  });

  it("shows admin-written labels, choices and statuses exactly as typed", () => {
    const base = defaultWorkloadDefinition();
    const definition = {
      ...base, title: "Tamarack desk log", statuses: ["draft", "logged_by_hand"],
      fields: [
        { ...base.fields.find((f) => f.key === "employment"), label: "Job type" },
        { key: "shift", type: "select", label: "Shift", kind: "field", required: false, visible: true, retired: false, unit: "", summary: "none", options: ["full_time", "night"] },
        { key: "visits", type: "number", label: "Visits", kind: "field", required: false, visible: true, retired: false, unit: "hours", summary: "sum", options: [] },
      ],
    };
    const { container } = mount("es", <WorkloadConfiguredEntry configuration={{ organizationId: "fictional-tamarack", version: 2, definition }} onSave={async () => true} />);
    expect(screen.getByRole("heading").textContent).toContain("Tamarack desk log");
    expect(container.textContent).toContain("Job type");
    expect(container.textContent).toContain("Visits (hours)");
    expect(optionTexts(container.querySelector("#workload-entry-shift")).slice(1)).toEqual(["full_time", "night"]);
    expect(optionTexts(container.querySelector("#workload-entry-employment")).slice(1)).toEqual(["Tiempo completo", "Tiempo parcial"]);
    const selects = container.querySelectorAll("select");
    expect(optionTexts(selects[selects.length - 1])).toEqual(["draft", "logged_by_hand"]);
  });
});
