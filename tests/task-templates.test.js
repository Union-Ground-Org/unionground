// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEMO_TASK_TEMPLATES,
  TASK_TEMPLATE_KEYS,
  checklistDescription,
  recommendedStatusForStep,
  templateFieldsToPayload,
  taskTemplateValuesFromDetails,
  validateTaskTemplateValues,
} from "../src/lib/taskTemplates.js";

describe("shared specialized task template contract", () => {
  it("ships five complete bilingual demo twins", () => {
    expect(TASK_TEMPLATE_KEYS).toEqual([
      "meeting_event", "review_approval", "member_follow_up", "document_request", "issue_incident",
    ]);
    expect(DEMO_TASK_TEMPLATES.map((template) => template.key)).toEqual(TASK_TEMPLATE_KEYS);
    for (const template of DEMO_TASK_TEMPLATES) {
      expect(template.label.en).toBeTruthy();
      expect(template.label.es).toBeTruthy();
      expect(template.description.en).toBeTruthy();
      expect(template.description.es).toBeTruthy();
      expect(template.fields.length).toBeGreaterThan(0);
      expect(template.flow.length).toBeGreaterThan(1);
      expect(template.checklist.length).toBeGreaterThan(2);
    }
    expect(DEMO_TASK_TEMPLATES.find((template) => template.key === "review_approval")
      .fields.find((item) => item.key === "reviewer_id").help.en).toMatch(/staff reviewer/i);
  });

  it("rejects missing, malformed, enum, and unknown values", () => {
    expect(validateTaskTemplateValues("meeting_event", {
      scheduled_on: "2026-08-20", starts_at: "10:00", ends_at: "09:00", venue_mode: "hybrid",
    })).toEqual(expect.objectContaining({ valid: false, errors: expect.objectContaining({ ends_at: expect.any(String) }) }));
    expect(validateTaskTemplateValues("member_follow_up", {
      contact_method: "carrier_pigeon", follow_up_on: "soon", protected_note: "no",
    })).toEqual(expect.objectContaining({ valid: false, errors: expect.objectContaining({
      contact_method: expect.any(String), follow_up_on: expect.any(String), protected_note: expect.any(String),
    }) }));
    expect(validateTaskTemplateValues("meeting_event", {
      scheduled_on: "2026-08-20", starts_at: "9am", ends_at: "10:30", venue_mode: "hybrid",
    })).toEqual(expect.objectContaining({ valid: false, errors: expect.objectContaining({ starts_at: "Use HH:MM" }) }));
  });

  it("normalizes stored task-template time blocks before validation", () => {
    const values = taskTemplateValuesFromDetails({
      scheduledOn: "2026-08-20",
      startsAt: "09:00:00",
      endsAt: "10:30:00",
      venueMode: "hybrid",
    });

    expect(values).toEqual(expect.objectContaining({ starts_at: "09:00", ends_at: "10:30" }));
    expect(validateTaskTemplateValues(
      "meeting_event",
      templateFieldsToPayload("meeting_event", values),
    )).toEqual({ valid: true, errors: {} });

    const malformed = taskTemplateValuesFromDetails({
      scheduledOn: "2026-08-20", startsAt: "9am", venueMode: "hybrid",
    });
    expect(malformed.starts_at).toBe("9am");
    expect(validateTaskTemplateValues(
      "meeting_event",
      templateFieldsToPayload("meeting_event", malformed),
    )).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.objectContaining({ starts_at: "Use HH:MM" }),
    }));
  });

  it("emits only catalog fields in snake case", () => {
    expect(templateFieldsToPayload("member_follow_up", {
      contact_method: "phone", follow_up_on: "2026-08-20", member_name: "Never copy",
    })).toEqual({ contact_method: "phone", follow_up_on: "2026-08-20" });
  });

  it.each(["", null, "   "])("preserves an explicit optional-field removal (%j)", (cleared) => {
    const payload = templateFieldsToPayload("review_approval", {
      review_kind: "document", reviewer_id: cleared, protected_note: "Never copy",
    });
    expect(payload).toEqual({ review_kind: "document", reviewer_id: null });
    expect(validateTaskTemplateValues("review_approval", payload)).toEqual({ valid: true, errors: {} });
  });

  it("keeps omitted optional fields absent and required empty fields invalid", () => {
    expect(templateFieldsToPayload("review_approval", { review_kind: "document" }))
      .toEqual({ review_kind: "document" });
    expect(templateFieldsToPayload("review_approval", { review_kind: "document", reviewer_id: undefined }))
      .toEqual({ review_kind: "document" });
    const payload = templateFieldsToPayload("review_approval", { review_kind: "", reviewer_id: null });
    expect(validateTaskTemplateValues("review_approval", payload)).toEqual({ valid: false, errors: { review_kind: "Required" } });
  });

  it("renders localized checklists and catalog-derived statuses", () => {
    const template = DEMO_TASK_TEMPLATES.find((item) => item.key === "issue_incident");
    expect(checklistDescription(template, "en")).toMatch(/^- \[ \] Address immediate safety/m);
    expect(checklistDescription(template, "es")).toMatch(/^- \[ \] Atender la seguridad inmediata/m);
    expect(recommendedStatusForStep(template, "monitor")).toBe("needs_review");
    expect(recommendedStatusForStep(template, "unknown")).toBeNull();
  });
});
