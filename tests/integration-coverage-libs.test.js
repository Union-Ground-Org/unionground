// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { createDemoCampaignApi } from "./fixtures/retired-pre-bot/src/lib/demoCampaigns.js";
import { rpcErrorText, rpcErrorTextStrict, TRANSLATED_RPC_TOKENS } from "../src/lib/rpcErrorText.js";
import { MemberApiError } from "../src/lib/memberApi.js";

afterEach(() => {
  // An assertion throw skips any restore later in the test, and the next
  // case would inherit the fake clock or a stubbed global.
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("integrated library behavior coverage", () => {
  it("runs the complete demo campaign lifecycle for inserts and updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
    const api = createDemoCampaignApi();
    const initial = await api.load();
    expect(initial.campaigns).toHaveLength(1);
    initial.campaigns[0].titleEn = "mutated outside";
    expect((await api.load()).campaigns[0].titleEn).not.toBe("mutated outside");

    const fields = {
      kind: "survey", scope: "union", titleEn: "Pulse", titleEs: "Pulso",
      bodyEn: "Body", bodyEs: "Cuerpo", closesAt: null, quorumTarget: null,
      options: [{ labelEn: "Yes", labelEs: "Sí" }],
    };
    const created = await api.saveDraft(fields);
    expect(created).toMatchObject({ kind: "survey", state: "draft" });
    let row = (await api.load()).campaigns.find((campaign) => campaign.id === created.id);
    expect(row).toMatchObject({ chapterId: null, active: false });
    expect(row.options[0]).toMatchObject({ orderIndex: 1 });

    await api.saveDraft({ ...fields, id: created.id, titleEn: "Updated", scope: "chapter" });
    row = (await api.load()).campaigns.find((campaign) => campaign.id === created.id);
    expect(row).toMatchObject({ titleEn: "Updated", chapterId: "wor" });
    await api.publish("survey", created.id);
    expect((await api.load()).campaigns.find((campaign) => campaign.id === created.id))
      .toMatchObject({ state: "open", active: true });
    await api.close("survey", created.id);
    expect((await api.load()).campaigns.find((campaign) => campaign.id === created.id))
      .toMatchObject({ state: "closed", active: false });
  });

  it("maps only allowlisted RPC details and preserves safe fallbacks", () => {
    const t = vi.fn((key) => `translated:${key}`);
    expect(TRANSLATED_RPC_TOKENS.has("scan_code_used")).toBe(true);
    expect(rpcErrorText(t, { details: " scan_code_used ", message: "raw" }, "fallback"))
      .toBe("translated:rpcError.scan_code_used");
    expect(rpcErrorText(t, { details: "unknown", message: "safe message" }, "fallback"))
      .toBe("safe message");
    expect(rpcErrorText(t, { name: "TimeoutError", message: "Request timed out" }, "fallback"))
      .toBe("translated:error.requestTimedOut");
    expect(rpcErrorText(t, new MemberApiError("Profile", {
      message: "TimeoutError: Request timed out",
    }), "fallback")).toBe("translated:error.requestTimedOut");
    expect(rpcErrorText(t, {}, "fallback")).toBe("translated:fallback");
    expect(rpcErrorText(t, {}, "")).toBe("");
    expect(rpcErrorTextStrict(t, { details: " scan_code_used ", message: "raw" }, "catalogue"))
      .toBe("translated:rpcError.scan_code_used");
    expect(rpcErrorTextStrict(t, { details: "unknown", message: "safe message" }, "catalogue"))
      .toBe("catalogue");
    expect(rpcErrorTextStrict(t, new MemberApiError("Update coordinator case", {
      message: "deadline may only be extended",
    }), "catalogue")).toBe("catalogue");
    expect(rpcErrorTextStrict(t, { name: "TimeoutError", message: "Request timed out" }, "catalogue"))
      .toBe("translated:error.requestTimedOut");
  });

  it("never returns driver text from rpcErrorTextStrict", () => {
    const t = vi.fn((key) => `translated:${key}`);
    expect(rpcErrorTextStrict(t, { details: " scan_code_used ", message: "raw" }, "fallback copy"))
      .toBe("translated:rpcError.scan_code_used");
    expect(rpcErrorTextStrict(t, {
      details: "unknown",
      message: 'new row violates row-level security policy for table "chapter_spaces"',
    }, "fallback copy")).toBe("fallback copy");
    expect(rpcErrorTextStrict(t, { name: "TimeoutError", message: "Request timed out" }, "fallback copy"))
      .toBe("translated:error.requestTimedOut");
    expect(rpcErrorTextStrict(t, {}, "fallback copy")).toBe("fallback copy");
    expect(rpcErrorTextStrict(t, {}, "")).toBe("");
    expect(rpcErrorTextStrict(t, {})).toBe("");
  });

  // BUG-UG-WEB-EVENT-CHECKIN-REFUSALS-ENGLISH-ONLY-20261003.
  it("translates the event check-in refusal tokens in English and Spanish", async () => {
    const { t } = await import("../src/lib/i18n.js");
    for (const token of ["checkin_not_open", "checkin_code_invalid"]) {
      expect(TRANSLATED_RPC_TOKENS.has(token)).toBe(true);
      for (const lang of ["en", "es"]) {
        const text = rpcErrorText((key) => t(lang, key), { details: token, message: "Check in: raw server text" }, "fallback");
        expect(text).toBe(t(lang, `rpcError.${token}`));
        expect(text).not.toContain("raw server text");
        expect(text).not.toContain("rpcError.");
      }
    }
    expect(t("es", "rpcError.checkin_not_open")).toMatch(/^El registro está abierto/);
  });
});
