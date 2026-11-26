// FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022
//
// GINA Title II covers labor organizations (42 U.S.C. 2000ff(2)(D)). A request
// for medical information that carries the EEOC safe-harbor wording of 29 CFR
// 1635.8(b)(1)(i)(B) makes a disclosure received in reply inadvertent. Both
// FMLA forms show that notice and a no-diagnosis hint before their first field,
// on web and on mobile, in English and Spanish (one shared key on the web;
// tests/native-fmla-notice-and-no-dues-parity.test.js keeps the phone's copies);
// the reason field asks for the leave, not the condition; the family-member
// field takes initials or a relationship; and an organization's own copy of a
// template is never replaced by a newer platform seed.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  FORM_TEMPLATES, GINA_NOTICE_KEY, NO_DIAGNOSIS_HINT_KEY, compareTemplateRowPrecedence, currentFormTemplateRows,
  healthNoticeKeys, templateByKey,
} from "../src/lib/formTemplates.js";
import { FormsView } from "../src/views/FormsView.jsx";
import { GINA_NOTICE_TEXT, NO_DIAGNOSIS_HINT_TEXT, healthNoticeFor } from "../apps/mobile/src/lib/formHealthNotice.ts";

const REGULATION_TEXT = "The Genetic Information Nondiscrimination Act of 2008 (GINA) prohibits employers and other entities covered by GINA Title II from requesting or requiring genetic information of an individual or family member of the individual, except as specifically allowed by this law. To comply with this law, we are asking that you not provide any genetic information when responding to this request for medical information. 'Genetic information' as defined by GINA, includes an individual's family medical history, the results of an individual's or family member's genetic tests, the fact that an individual or an individual's family member sought or received genetic services, and genetic information of a fetus carried by an individual or an individual's family member or an embryo lawfully held by an individual or family member receiving assistive reproductive services.";

describe("FMLA GINA notice and no-diagnosis hint", () => {
  it("names the notice and hint for both FMLA templates only", () => {
    for (const key of ["fmla_self", "fmla_family"]) {
      expect(healthNoticeKeys(templateByKey(key))).toEqual([GINA_NOTICE_KEY, NO_DIAGNOSIS_HINT_KEY]);
      // An organization's own copy keeps the key, so it keeps the notice.
      expect(healthNoticeKeys({ key, steps: [] })).toHaveLength(2);
    }
    for (const template of FORM_TEMPLATES.filter((item) => !item.key.startsWith("fmla_"))) {
      expect(healthNoticeKeys(template), template.key).toEqual([]);
    }
  });

  it("uses the regulation's wording in English, one shared key in both languages, and the same text on mobile", () => {
    expect(catalogue.en[GINA_NOTICE_KEY]).toBe(REGULATION_TEXT);
    for (const key of [GINA_NOTICE_KEY, NO_DIAGNOSIS_HINT_KEY, "forms.f.leaveNeed", "forms.f.familyMemberInitials"]) {
      expect(catalogue.en[key], key).toBeTruthy();
      expect(catalogue.es[key], key).toBeTruthy();
      expect(catalogue.es[key], key).not.toBe(catalogue.en[key]);
    }
    expect(catalogue.es[GINA_NOTICE_KEY]).toContain("Título II de GINA");
    // The phone's English copy; its Spanish copy is pinned in
    // tests/native-fmla-notice-and-no-dues-parity.test.js (#8694).
    expect(GINA_NOTICE_TEXT).toBe(catalogue.en[GINA_NOTICE_KEY]);
    expect(NO_DIAGNOSIS_HINT_TEXT).toBe(catalogue.en[NO_DIAGNOSIS_HINT_KEY]);
    expect(healthNoticeFor("fmla_family")).toEqual([GINA_NOTICE_TEXT, NO_DIAGNOSIS_HINT_TEXT]);
    expect(healthNoticeFor("grievance")).toEqual([]);
  });

  it("asks for the leave, not the condition, and keeps the family member to initials or a relationship", () => {
    for (const key of ["fmla_self", "fmla_family"]) {
      const reason = templateByKey(key).steps.flatMap((step) => step.fields).find((field) => field.key === "reason");
      expect(reason.labelKey).toBe("forms.f.leaveNeed");
    }
    expect(catalogue.en["forms.f.leaveNeed"]).toMatch(/not the condition/u);
    const family = templateByKey("fmla_family").steps.flatMap((step) => step.fields).find((field) => field.key === "family_member");
    expect(family).toMatchObject({ labelKey: "forms.f.familyMemberInitials", maxLength: 40 });
  });

  it("shows the notice and hint before the first field of an FMLA form and not on other forms", () => {
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { initials: "MV" }, forms: [] }} onSaveDraft={vi.fn()} onSubmit={vi.fn().mockResolvedValue(null)} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /FMLA — my own health/u }));
    const note = document.querySelector('[data-health-notice="gina"]');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain(REGULATION_TEXT);
    expect(note.textContent).toContain(catalogue.en[NO_DIAGNOSIS_HINT_KEY]);
    const firstField = screen.getByLabelText(catalogue.en["forms.f.leaveNeed"], { exact: false });
    expect(note.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

});

describe("an organization's own template outranks a newer platform seed", () => {
  const seed = (version) => ({ key: "fmla_self", version, is_platform_seed: true, organization_id: null, active: true });
  const owned = (version, active = true) => ({ key: "fmla_self", version, is_platform_seed: false, organization_id: "org-1", active });

  it("keeps the organization's copy over a seed of a higher version", () => {
    expect(currentFormTemplateRows([seed(1), owned(2), seed(3)]).map((row) => row.version)).toEqual([2]);
    expect(currentFormTemplateRows([seed(3), owned(2)]).map((row) => row.version)).toEqual([2]);
    // A template the organization turned off stays off.
    expect(currentFormTemplateRows([owned(2, false), seed(3)]).filter((row) => row.active)).toEqual([]);
  });

  it("takes the newest seed when the organization has no copy, and the highest version among the organization's own", () => {
    expect(currentFormTemplateRows([seed(1), seed(3)]).map((row) => row.version)).toEqual([3]);
    expect(currentFormTemplateRows([owned(2), owned(4), seed(3)]).map((row) => row.version)).toEqual([4]);
    expect([seed(3), owned(2), seed(1)].sort(compareTemplateRowPrecedence).map((row) => row.version)).toEqual([1, 3, 2]);
  });

  it("falls back to the highest version for rows without ownership columns (demo data)", () => {
    expect(currentFormTemplateRows([{ key: "k", version: 1 }, { key: "k", version: 2 }]).map((row) => row.version)).toEqual([2]);
  });
});
