// BUG-UG-SPANISH-CASE-STAGE-ARBITRATION-AND-MEDIATION-STAY-ENGLISH-20261110
// (#7982): Arbitration, Mediation and Closed are app-known stages named in the
// reader's language by one shared rule, like Step N and Intake; any other
// stored step stays exactly as stored. The coordinator queue reads it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseStepLabel, knownCaseStep } from "../src/lib/caseStepName.js";
import { formatHistoryValue } from "../src/lib/caseHistoryValue.js";
import { t as translate, catalogue } from "../src/lib/i18n.js";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { CaseDashboards } from "../src/components/CaseDashboards.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";

const STORED = ["Arbitration", "Mediation", "Closed", "Step 2", "Intake", "Loudermill", "Hearing prep"];
const EXPECTED = {
  en: ["Arbitration", "Mediation", "Closed", "Step 2", "Intake", "Loudermill", "Hearing prep"],
  es: ["Arbitraje", "Mediación", "Cerrado", "Paso 2", "Admisión", "Loudermill", "Hearing prep"],
};
const tFor = (lang) => (key, vars) => translate(lang, key, vars);

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:coordinator-file");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  clearDeviceParityState();
});

describe("the shared case stage rule", () => {

  it("matches only whole app-known values, whatever their case", () => {
    expect(knownCaseStep("arbitration")).toEqual({ key: "coordinator.stepArbitration" });
    expect(knownCaseStep("Arbitration referral")).toBeNull();
    expect(knownCaseStep("Pre-mediation")).toBeNull();
    expect(knownCaseStep(null)).toBeNull();
    expect(caseStepLabel("", tFor("es"))).toBe("");
  });


  it("has the new stage names in both catalogues", () => {
    for (const key of ["coordinator.stepArbitration", "coordinator.stepMediation", "coordinator.stepClosed"]) {
      expect(catalogue.en[key], key).toBeTruthy();
      expect(catalogue.es[key], key).toBeTruthy();
    }
  });
});

describe("the case history value formatter", () => {
  it("reads an empty structured value as nothing set", () => {
    expect(formatHistoryValue({}, { t: tFor("es"), lang: "es", key: "details", depth: 0 })).toBe(translate("es", "caseHistory.none"));
  });
});

