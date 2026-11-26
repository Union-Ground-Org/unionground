import { describe, expect, it } from "vitest";
import { templateByKey, formProgress, FORM_TEMPLATES } from "../src/lib/formTemplates.js";

describe("formTemplates", () => {
  it("has all 7 templates with unique keys", () => {
    expect(FORM_TEMPLATES).toHaveLength(7);
    expect(new Set(FORM_TEMPLATES.map((t) => t.key)).size).toBe(7);
  });
  it("formProgress reports pct and the next unanswered required field", () => {
    const t = templateByKey("grievance");
    const required = t.steps.flatMap((s) => s.fields).filter((f) => f.required);
    const answers = { [required[0].key]: "x" };
    const p = formProgress(t, answers);
    expect(p.pct).toBe(Math.round(100 / required.length));
    expect(p.nextFieldKey).toBe(required[1].key);
  });
  it("formProgress is 100% and null next when all required answered", () => {
    const t = templateByKey("service_request");
    const answers = Object.fromEntries(t.steps.flatMap((s) => s.fields).filter((f) => f.required).map((f) => [f.key, "x"]));
    expect(formProgress(t, answers)).toEqual({ pct: 100, nextFieldKey: null });
  });
});
