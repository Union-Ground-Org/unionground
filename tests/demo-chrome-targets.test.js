// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nonDemoCovenantUrl } from "../scripts/lib/demo-chrome-covenant.mjs";
import { SAMPLE_BACKEND } from "../src/lib/sampleBackend.js";

const hostedSample = SAMPLE_BACKEND.samplePortalOrigin;

describe("non-demo covenant target", () => {
  it("refuses a hosted SAMPLE run that names no non-demo origin, since none is provisioned", () => {
    expect(() => nonDemoCovenantUrl(hostedSample)).toThrow(/No non-demo origin/);
  });
  it("uses an explicitly selected non-demo origin for a hosted SAMPLE run", () => {
    expect(nonDemoCovenantUrl(hostedSample, "https://app.example.test")).toBe("https://app.example.test/m");
  });
  it("keeps the isolated localhost test harness on loopback without the demo query", () => {
    expect(nonDemoCovenantUrl("http://127.0.0.1:4189/?demo=1"))
      .toBe("http://127.0.0.1:4189/m");
  });
  it("permits a separate explicitly selected local SaaS preview", () => {
    expect(nonDemoCovenantUrl("http://127.0.0.1:4189", "http://127.0.0.1:4190"))
      .toBe("http://127.0.0.1:4190/m");
  });
  it("refuses to call a hosted SAMPLE origin the SaaS isolation surface", () => {
    expect(() => nonDemoCovenantUrl(hostedSample, hostedSample)).toThrow(/SAMPLE/);
    expect(() => nonDemoCovenantUrl("https://preview.example.test", hostedSample)).toThrow(/SAMPLE/);
  });
});
