// BUG-UG-MFA-CODE-FIELD-ACCEPTS-LETTERS-AND-OVERLENGTH-20261104
// (#7052): every six-digit authenticator code field takes digits only, stops
// at six, cleans a pasted "123 456", keeps its submit off until six digits are
// present and says so in the app's own words (English and Spanish) instead of
// the browser's "Please match the requested format" bubble. Recovery-code
// fields keep their own pattern.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MfaChallenge, MfaEnrollment } from "../src/components/MfaSettings.jsx";
import { AUTHENTICATOR_CODE_LENGTH, cleanAuthenticatorCode, isAuthenticatorCode } from "../src/lib/authenticatorCode.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";

const TOKEN = `t1.${"A".repeat(16)}.${"b".repeat(120)}`;
const PASSWORD = "a-brand-new-password-long-enough";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

function wrap(ui, lang) {
  return render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
}

function mfaClient(overrides = {}) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      signOut: vi.fn().mockResolvedValue({}),
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { all: [{ id: "f1", factor_type: "totp", status: "verified" }] }, error: null }),
        enroll: vi.fn().mockResolvedValue({ data: { id: "f1", totp: { qr_code: "data:image/svg+xml,qr", secret: "SETUP-SECRET" } }, error: null }),
        challenge: vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null }),
        verify: vi.fn().mockResolvedValue({ error: { message: "Invalid TOTP code" } }),
        unenroll: vi.fn().mockResolvedValue({ error: null }),
        ...overrides,
      },
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: vi.fn().mockResolvedValue(body) });

// Each field is opened the way a member reaches it and handed back with its
// submit control, so one set of assertions covers all three.
const FIELDS = [
  ["two-factor check", async (lang) => {
    const copy = catalogue[lang];
    wrap(<MfaChallenge client={mfaClient()} onCleared={vi.fn()} onSignOut={vi.fn()} />, lang);
    const input = screen.getByRole("textbox", { name: copy["mfa.codeLabel"] });
    return { input, submit: () => screen.getByRole("button", { name: copy["mfa.verify"] }), form: input.closest("form") };
  }],
  ["two-step setup", async (lang) => {
    const copy = catalogue[lang];
    wrap(<MfaEnrollment client={mfaClient({ listFactors: vi.fn().mockResolvedValue({ data: { all: [] }, error: null }) })} onCleared={vi.fn()} onSignOut={vi.fn()} />, lang);
    fireEvent.click(await screen.findByRole("button", { name: copy["mfa.enable"] }));
    const form = await screen.findByRole("form", { name: copy["mfa.enable"] });
    const input = within(form).getByRole("textbox", { name: copy["mfa.codeLabel"] });
    return { input, submit: () => within(form).getByRole("button", { name: copy["mfa.verify"] }), form };
  }],
  ["password reset", async (lang) => {
    const copy = catalogue[lang];
    const fetcher = vi.fn().mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }));
    const { container } = wrap(<PasswordResetView fetcher={fetcher} readToken={() => TOKEN} />, lang);
    const save = await screen.findByRole("button", { name: copy["reset.finishSubmit"] });
    // Everything else on the form is valid, so only the code holds save off.
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    const input = screen.getByRole("textbox", { name: copy["mfa.codeLabel"] });
    return { input, submit: () => save, form: input.closest("form") };
  }],
];

describe("cleanAuthenticatorCode", () => {
  it("keeps the first six ASCII digits and drops everything else", () => {
    expect(AUTHENTICATOR_CODE_LENGTH).toBe(6);
    expect(cleanAuthenticatorCode("5555jmkjm")).toBe("5555");
    expect(cleanAuthenticatorCode("123 456")).toBe("123456");
    expect(cleanAuthenticatorCode(" 123-456 7")).toBe("123456");
    expect(cleanAuthenticatorCode("١٢٣٤٥٦")).toBe("");
    expect(cleanAuthenticatorCode(undefined)).toBe("");
    expect(isAuthenticatorCode("123456")).toBe(true);
    expect(isAuthenticatorCode("12345")).toBe(false);
    expect(isAuthenticatorCode("1234567")).toBe(false);
    expect(isAuthenticatorCode("12345a")).toBe(false);
  });
});

describe.each(FIELDS)("the %s code field", (_name, open) => {
  it.each(["en", "es"])("takes digits only, stops at six and cleans a pasted code (%s)", async (lang) => {
    const { input } = await open(lang);
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    // A six-character maxLength would cut a pasted "123 456" to "123 45"
    // before the cleaner saw it, so the cap lives in the change handler.
    expect(input).not.toHaveAttribute("maxlength");
    expect(input).not.toHaveAttribute("pattern");

    fireEvent.change(input, { target: { value: "5555jmkjm" } });
    expect(input).toHaveValue("5555");
    fireEvent.change(input, { target: { value: "55556" } });
    fireEvent.change(input, { target: { value: "555567" } });
    expect(input).toHaveValue("555567");
    fireEvent.change(input, { target: { value: "5555678" } });
    expect(input).toHaveValue("555567");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "123 456" } });
    expect(input).toHaveValue("123456");
  });

  it.each(["en", "es"])("keeps submit off until six digits are present and explains why in the app's words (%s)", async (lang) => {
    const copy = catalogue[lang];
    const { input, submit, form } = await open(lang);
    // The form never hands the member the browser's own validation bubble.
    expect(form).toHaveAttribute("novalidate");
    const hint = document.getElementById(input.getAttribute("aria-describedby"));
    expect(hint).toHaveTextContent(copy["mfa.codeHint"]);

    expect(submit()).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(input, { target: { value: "12345" } });
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(input, { target: { value: "12345x" } });
    expect(input).toHaveValue("12345");
    expect(submit()).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(input, { target: { value: "123456" } });
    expect(submit()).not.toHaveAttribute("aria-disabled");
    fireEvent.change(input, { target: { value: "12345" } });
    expect(submit()).toHaveAttribute("aria-disabled", "true");
  });
});

describe("the two-factor code hint copy", () => {
  it("is written in both languages and names six digits", () => {
    expect(catalogue.en["mfa.codeHint"]).toMatch(/six digits/i);
    expect(catalogue.es["mfa.codeHint"]).toMatch(/seis d[ií]gitos/i);
  });
});

describe("recovery-code fields", () => {
  it("keep their own longer pattern on the reset form", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }));
    const { container } = wrap(<PasswordResetView fetcher={fetcher} readToken={() => TOKEN} />, "en");
    await screen.findByRole("button", { name: catalogue.en["reset.finishSubmit"] });
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["reset.useRecoveryCode"] }));
    const input = container.querySelector('input[name="code"]');
    expect(input).toHaveAttribute("pattern", "[A-Za-z0-9\\-]{18,32}");
    fireEvent.change(input, { target: { value: "UG-ABCD-1234-ABCD-1234" } });
    expect(input).toHaveValue("UG-ABCD-1234-ABCD-1234");
  });

  it("keep their own longer pattern on the two-factor check", () => {
    const { container } = wrap(<MfaChallenge client={mfaClient()} onCleared={vi.fn()} onSignOut={vi.fn()} />, "en");
    expect(container.querySelector('input[name="recoveryCode"]')).toHaveAttribute("pattern", "[A-Za-z0-9\\-]{18,32}");
  });
});
