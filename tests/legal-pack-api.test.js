import { describe, expect, it, vi } from "vitest";
import handler from "../api/legal-pack.js";
import { currentLegalVersions, LEGAL_INSTRUMENTS } from "../src/lib/legalInstruments.js";
import { t } from "../src/lib/i18n/allLanguages.js";
import { RESIDENCE_REGIONS, ageRuleFor } from "../src/lib/residenceRegions.js";
import * as legalReleaseGate from "../api/_lib/legalReleaseGate.js";

function request(method = "GET", lang = "en") {
  let body;
  const headers = {};
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { headers[name] = value; },
    end(value) { body = JSON.parse(value); },
  };
  handler({ method, query: { lang } }, response);
  return { status: response.statusCode, body, headers };
}

describe("public current legal pack", () => {
  it.each(["en", "es"])("binds every published version to its current text without account access (%s)", (lang) => {
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const result = request("GET", lang);
      expect(result.status).toBe(200);
      expect(result.headers).toMatchObject({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      expect(result.body.language).toBe(lang);
      expect(result.body.acceptance.consent).toBe(t(lang, "inviteAccept.terms.consent"));
      expect(result.body.acceptance.residenceAge.rules).toEqual(
        Object.fromEntries(RESIDENCE_REGIONS.map(({ code }) => [code, ageRuleFor(code)])),
      );
      for (const key of ["state", "choose", "help", "adult", "band"]) {
        expect(result.body.acceptance.residenceAge.labels[key]).toBe(t(lang, `ageRule.${key}`));
      }
      expect(Object.fromEntries(result.body.instruments.map((entry) => [entry.key, entry.version]))).toEqual(currentLegalVersions());
      for (const entry of LEGAL_INSTRUMENTS) {
        const document = result.body.instruments.find((value) => value.key === entry.key);
        expect(document.name).toBe(t(lang, entry.summaryTitleKey));
        expect(document.notice).toContain(entry.version);
        expect(document.sections).toEqual([...entry.sections, ["legal.instrument.acceptance.title", "legal.instrument.acceptance.body"]]
          .map(([heading, body]) => ({ heading: t(lang, heading), body: t(lang, body) })));
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("refuses mutations", () => {
    expect(request("POST")).toMatchObject({ status: 405, body: { error: "method-not-allowed" } });
  });

  it("serves publication proof only through the live-output and database gate", async () => {
    const gate = vi.spyOn(legalReleaseGate, "verifiedLegalDeployment");
    try {
      for (const proof of [null, { stampJson: "bound-content", liveReleaseIds: ["fixture"], verifiedPackReleaseIds: ["fixture"] }]) {
        gate.mockResolvedValueOnce(proof);
        let body;
        const response = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, end(text) { body = JSON.parse(text); } };
        await handler({ method: "GET", query: { publication: "1" }, headers: { host: "unionground.net" } }, response);
        expect(response.statusCode).toBe(proof ? 200 : 503);
        expect(body).toEqual(proof || { error: "legal-release-unavailable" });
      }
    } finally { gate.mockRestore(); }
  });
});
