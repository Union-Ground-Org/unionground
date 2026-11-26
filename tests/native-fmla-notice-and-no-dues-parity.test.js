// REQ-UG-NATIVE-FMLA-FORMS-SHOW-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261113
// (#8694): the phone's live Forms screen shows the GINA notice, the
// no-diagnosis hint and the no-dues service request description in English and
// Spanish. Their native copies read word for word as the website's keys.
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { GINA_NOTICE_KEY, NO_DIAGNOSIS_HINT_KEY } from "../src/lib/formTemplates.js";
import { healthNoticeFor } from "../apps/mobile/src/lib/formHealthNotice.ts";
import { formTemplateBlurb } from "../apps/mobile/src/lib/featureCatalog.ts";

describe("phone FMLA notice and no-dues description match the website", () => {
  it("uses the website's GINA notice and no-diagnosis hint in both languages, for the FMLA forms only", () => {
    for (const key of ["fmla_self", "fmla_family"]) {
      expect(healthNoticeFor(key, "en")).toEqual([catalogue.en[GINA_NOTICE_KEY], catalogue.en[NO_DIAGNOSIS_HINT_KEY]]);
      expect(healthNoticeFor(key, "es")).toEqual([catalogue.es[GINA_NOTICE_KEY], catalogue.es[NO_DIAGNOSIS_HINT_KEY]]);
    }
    expect(healthNoticeFor("service_request", "es")).toEqual([]);
  });

  it("uses the website's no-dues description in both languages, replacing only the default description", () => {
    const english = { key: "service_request", blurb: catalogue.en["forms.blurb.service_request"] };
    const spanish = { key: "service_request", blurb: catalogue.es["forms.blurb.service_request"] };
    expect(formTemplateBlurb(english, false, "en")).toBe(catalogue.en["forms.blurb.service_request"]);
    expect(formTemplateBlurb(spanish, false, "es")).toBe(catalogue.es["forms.blurb.service_request"]);
    expect(formTemplateBlurb(english, true, "en")).toBe(english.blurb);
    expect(formTemplateBlurb(spanish, null, "es")).toBe(spanish.blurb);
    expect(formTemplateBlurb({ key: "service_request", blurb: "Our own words." }, false, "en")).toBe("Our own words.");
  });
});
