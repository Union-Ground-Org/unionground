// #9458 web slice 3: W1-2, the reset page's recovery-code box says what a code looks like.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { RECOVERY_CODE_MAX as MAX, RECOVERY_CODE_MIN as MIN } from "../src/lib/authenticatorCode.js";
import { RECOVERY_CODE_PATTERN } from "../src/lib/passwordReset.js";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";

const PASSWORD = "p".repeat(30);
const described = node => (node.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)
  .map(id => document.getElementById(id)?.textContent || "").join(" ");
const type = (name, value) => fireEvent.change(document.querySelector(`[name="${name}"]`), { target: { value } });

describe("recovery-code length", () => {
  it("is the range RECOVERY_CODE_PATTERN accepts", () => {
    expect(RECOVERY_CODE_PATTERN.test("A".repeat(MIN))).toBe(true);
    expect(RECOVERY_CODE_PATTERN.test("A".repeat(MAX))).toBe(true);
    expect(RECOVERY_CODE_PATTERN.test("A".repeat(MIN - 1))).toBe(false);
    expect(RECOVERY_CODE_PATTERN.test("A".repeat(MAX + 1))).toBe(false);
  });
});

describe.each(["en", "es"])("/reset-password recovery-code box (%s)", lang => {
  const T = (key, params) => t(lang, key, params);

  it("states the code's shape and length under the box, and names the length when Save is pressed short", async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, ok: true, json: vi.fn().mockResolvedValue({ mode: "challenge", state: "s" }) });
    render(<LanguageProvider lang={lang}><PasswordResetView fetcher={fetcher} readToken={() => `t1.${"A".repeat(16)}.${"b".repeat(120)}`} /></LanguageProvider>);
    const save = await screen.findByRole("button", { name: T("reset.finishSubmit") });
    // The authenticator box keeps its own hint.
    expect(described(document.querySelector('[name="code"]'))).toBe(T("mfa.codeHint"));
    fireEvent.click(screen.getByRole("button", { name: T("reset.useRecoveryCode") }));
    const box = document.querySelector('[name="code"]');
    const hint = T("reset.recoveryCodeHint", { min: MIN, max: MAX });
    expect(described(box)).toBe(hint);
    expect(hint).toContain(`${MIN}`);
    expect(hint).toContain(`${MAX}`);
    type("code", "A".repeat(MIN - 1));
    type("password", PASSWORD);
    type("passwordConfirm", PASSWORD);
    expect(described(save)).toContain(T("reset.blockedRecoveryCode", { min: MIN, max: MAX }));
    fireEvent.click(save);
    expect(screen.getByRole("alert")).toHaveTextContent(`${MIN}`);
    expect(fetcher.mock.calls.filter(([, init]) => init?.body?.includes('"finish"'))).toEqual([]);
  });
});
