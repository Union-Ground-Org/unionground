// #9458 web slice 4: W3b-5, the two-step sign-in recovery box drops spaces and
// says what a code looks like. (W3a-2, Sign in with PIN, is left out of Union
// Ground with the member PIN.)
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MfaChallenge } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";

const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) });
const described = node => (node.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)
  .map(id => document.getElementById(id)?.textContent || "").join(" ");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["en", "es"])("two-step sign-in recovery box (%s)", lang => {
  it("drops spaces as typed and says what a code looks like", () => {
    const client = { auth: { getSession: vi.fn(), signOut: vi.fn(), mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [] }, error: null }) } }, rpc: vi.fn() };
    const { container } = render(<LanguageProvider lang={lang}><MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} /></LanguageProvider>);
    const box = container.querySelector('input[name="recoveryCode"]');
    expect(described(box)).toBe(t(lang, "mfa.recoveryCodeHint"));
    fireEvent.change(box, { target: { value: "ABCD EFGH\tIJKL-MNOP QR" } });
    expect(box).toHaveValue("ABCDEFGHIJKL-MNOPQR");
    expect(box.checkValidity()).toBe(true);
  });
});
