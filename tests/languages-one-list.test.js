// @vitest-environment node
// REQ-UG-LANGUAGES-ARE-A-PAIR-NOT-A-LIST-20261122, slice 1: one list of
// languages, read by roster import, single sign-on and
// the filing copy. The shipped list stays English and Spanish (owner, November
// 22, 2026); a stub third language exists only inside this test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LANGUAGE, SHIPPED_LANGUAGES, isShippedLanguage, languageFromTag } from "../src/lib/languages.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const ORG_ID = "a1000000-0000-4000-8000-000000000001";
const FORM_ID = "f2010001-1111-4111-8111-111111111111";
const STUB = "xx";

const rosterCsv = (locale) => `email,full_name,locale\ncasey@example.invalid,Casey Fixtureperson,${locale}\n`;
const scimUser = (preferredLanguage) => ({ userName: "casey@example.invalid", name: { givenName: "Casey", familyName: "Fixtureperson" }, preferredLanguage });

async function readers() {
  const [{ parseRosterInvitations }, { normalizeUser }, { default: filing }] = await Promise.all([
    import("../src/features/memberOperations/rosterInvitations.js"),
    import("../api/_lib/scim.js"),
    import("../api/form-filing.js"),
  ]);
  const filingStatus = async (lang) => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" })));
    const out = { status: 0 };
    await filing(
      { method: "GET", headers: { authorization: "Bearer member-token" }, query: { formId: FORM_ID, lang } },
      { status(code) { out.status = code; return this; }, setHeader() {}, end() {} },
    );
    return out.status;
  };
  return {
    roster: (locale) => parseRosterInvitations(rosterCsv(locale))[0],
    scimLocale: (tag) => normalizeUser(scimUser(tag)).locale,
    filingStatus,
  };
}

afterEach(() => {
  vi.doUnmock("../src/lib/languages.js");
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the one language list", () => {
  it("ships exactly English and Spanish, English first and the default", () => {
    expect(SHIPPED_LANGUAGES).toEqual(["en", "es"]);
    expect(Object.isFrozen(SHIPPED_LANGUAGES)).toBe(true);
    expect(DEFAULT_LANGUAGE).toBe("en");
  });

  it("accepts only shipped codes, exactly as written", () => {
    for (const code of ["en", "es"]) expect(isShippedLanguage(code)).toBe(true);
    for (const code of ["fr", "ES", " es", "", null, undefined, 1, ["es"]]) expect(isShippedLanguage(code)).toBe(false);
  });

  it("reads an outside tag the way single sign-on always has", () => {
    expect(languageFromTag("es")).toBe("es");
    expect(languageFromTag(" ES-mx ")).toBe("es");
    expect(languageFromTag("es_US")).toBe("es");
    expect(languageFromTag("en-US")).toBe("en");
    expect(languageFromTag("fr-CA")).toBe("en");
    expect(languageFromTag("")).toBe("en");
    expect(languageFromTag(undefined)).toBe("en");
    expect(languageFromTag(42)).toBe("en");
  });

  it("takes another list when a caller passes one", () => {
    expect(isShippedLanguage(STUB, [...SHIPPED_LANGUAGES, STUB])).toBe(true);
    expect(languageFromTag("xx-YY", [...SHIPPED_LANGUAGES, STUB])).toBe(STUB);
  });
});

describe("readers on the shipped list behave as before", () => {
  it("roster import, single sign-on and the filing copy take en and es and nothing else", async () => {
    const read = await readers();
    expect(read.roster("es")).toMatchObject({ locale: "es", state: "ready" });
    expect(read.roster("")).toMatchObject({ locale: "en", state: "ready" });
    expect(read.roster("fr")).toMatchObject({ locale: "fr", state: "invalid" });
    expect(read.roster(STUB).state).toBe("invalid");
    expect(read.scimLocale("es-MX")).toBe("es");
    expect(read.scimLocale(`${STUB}-YY`)).toBe("en");
    expect(await read.filingStatus(STUB)).toBe(400);
    expect(await read.filingStatus("es")).toBe(401);
  });
});

describe("a stub third language added to the list in this test only", () => {
  it("is accepted by every reader, and English and Spanish still are", async () => {
    vi.resetModules();
    vi.doMock("../src/lib/languages.js", async (importOriginal) => {
      const actual = await importOriginal();
      const languages = Object.freeze([...actual.SHIPPED_LANGUAGES, STUB]);
      return {
        ...actual,
        SHIPPED_LANGUAGES: languages,
        isShippedLanguage: (code) => actual.isShippedLanguage(code, languages),
        languageFromTag: (tag) => actual.languageFromTag(tag, languages),
      };
    });
    const read = await readers();
    expect(read.roster(STUB)).toMatchObject({ locale: STUB, state: "ready" });
    expect(read.scimLocale(`${STUB}-YY`)).toBe(STUB);
    expect(await read.filingStatus(STUB)).toBe(401);
    expect(read.roster("es").state).toBe("ready");
    expect(read.scimLocale("es")).toBe("es");
    expect(read.roster("fr").state).toBe("invalid");
  });
});
