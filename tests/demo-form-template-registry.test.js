// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setDemoFormTemplateActive, upsertDemoFormTemplate } from "../src/lib/demoFormTemplateRegistry.js";

const seed = () => [{
  key: "grievance",
  version: 1,
  label_en: "Grievance",
  label_es: "Queja",
  active: true,
  sort: 1,
  field_schema: { steps: [{ title: { en: "Issue", es: "Asunto" }, fields: [] }] },
}];

describe("demo form-template registry twin", () => {
  it.each(["", "   ", null, undefined, "x".repeat(121), "x".repeat(62) + "😀".repeat(59)])("rejects invalid English label %j without changing existing versions", (labelEn) => {
    const rows = seed();
    const before = structuredClone(rows);
    expect(() => upsertDemoFormTemplate(rows, { key: "grievance", labelEn, active: true }))
      .toThrow("English label must contain 1–120 characters.");
    expect(rows).toEqual(before);
  });

  it.each(["x", "x".repeat(120), "x".repeat(62) + "😀".repeat(58)])("accepts trimmed English labels at the length boundaries (%s)", (labelEn) => {
    const { rows } = upsertDemoFormTemplate([], {
      key: "intake", labelEn: `  ${labelEn}  `, labelEs: labelEn,
      points: 0, active: true, sort: 0, fieldSchema: { steps: [] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].label_en).toBe(labelEn);
  });

  it("inserts an isolated new version and retires the prior active version", () => {
    const rows = seed();
    const fields = {
      key: "grievance", labelEn: "Grievance report", labelEs: "Reporte de queja",
      blurbEn: "Report an issue", blurbEs: "Reporta un asunto", icon: "⚖",
      points: 25, sort: 1, active: true,
      fieldSchema: { steps: [{ title: { en: "Details", es: "Detalles" }, fields: [] }] },
    };
    const { rows: next, result } = upsertDemoFormTemplate(rows, fields, "2026-08-12T14:00:00Z");

    expect(result).toEqual({ key: "grievance", version: 2, active: true });
    expect(next).toHaveLength(2);
    expect(next[0].active).toBe(false);
    expect(next[1]).toMatchObject({ key: "grievance", version: 2, label_en: "Grievance report", label_es: "Reporte de queja", updated_at: "2026-08-12T14:00:00Z" });
    expect(rows[0].active).toBe(true);
    // Mirrors the safe-recognition constraint: Union Ground has no points
    // economy, so a stored template carries 0 whatever the caller passed.
    expect(next[1].points).toBe(0);
    fields.fieldSchema.steps[0].title.en = "Changed after save";
    expect(next[1].field_schema.steps[0].title.en).toBe("Details");
  });

  it("changes only the latest version and rejects unknown keys like the RPC", () => {
    const rows = [seed()[0], { ...seed()[0], version: 2, active: true }];
    const deactivated = setDemoFormTemplateActive(rows, "grievance", false);
    expect(deactivated.result).toEqual({ key: "grievance", active: false });
    expect(deactivated.rows.map((row) => row.active)).toEqual([true, false]);
    expect(rows.map((row) => row.active)).toEqual([true, true]);
    expect(() => setDemoFormTemplateActive(rows, "missing", true)).toThrow("template not found");
  });

  it("normalizes optional values and nonnumeric versions from an empty registry", () => {
    const fields = {
      key: "intake", labelEn: "Intake", labelEs: "Ingreso", points: 0,
      active: false, sort: 2, fieldSchema: { steps: [] },
    };
    const inserted = upsertDemoFormTemplate(undefined, fields, "2026-08-13T00:00:00Z");
    expect(inserted.rows[0]).toMatchObject({
      version: 1, blurb_en: null, blurb_es: null, icon: null, active: false,
    });

    const rows = [inserted.rows[0], { ...inserted.rows[0], version: "unknown", active: true }];
    const active = setDemoFormTemplateActive(rows, "intake", true);
    expect(active.rows).toHaveLength(2);
    expect(active.result).toEqual({ key: "intake", active: true });
  });
});
