import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NEW_PASSWORD_MIN, NEW_PASSWORD_MAX, newPasswordLengthIssue } from "../src/lib/passwordPolicy.js";
import { RESET_PASSWORD_MIN, RESET_PASSWORD_MAX } from "../src/lib/passwordReset.js";
import { RESET_PASSWORD_MIN as API_MIN, RESET_PASSWORD_MAX as API_MAX } from "../api/_lib/passwordReset.js";
import { SIGNUP_PASSWORD_MIN, SIGNUP_PASSWORD_MAX } from "../src/lib/openSignup.js";
import { PASSWORD_MIN as SIGNUP_API_MIN, PASSWORD_MAX as SIGNUP_API_MAX } from "../api/_lib/openSignup.js";
import { PasswordChangeForm } from "../src/views/SettingsView.jsx";
import { catalogue, loadLanguage } from "../src/lib/i18n.js";

describe("one new-password policy across web and native", () => {
  it("keeps the stricter owner minimum and shares it with the reset API", () => {
    expect(NEW_PASSWORD_MIN).toBe(24);
    expect(NEW_PASSWORD_MAX).toBe(256);
    expect([RESET_PASSWORD_MIN, API_MIN]).toEqual([NEW_PASSWORD_MIN, NEW_PASSWORD_MIN]);
    expect([RESET_PASSWORD_MAX, API_MAX]).toEqual([NEW_PASSWORD_MAX, NEW_PASSWORD_MAX]);
    expect([SIGNUP_PASSWORD_MIN, SIGNUP_API_MIN]).toEqual([NEW_PASSWORD_MIN, NEW_PASSWORD_MIN]);
    expect([SIGNUP_PASSWORD_MAX, SIGNUP_API_MAX]).toEqual([NEW_PASSWORD_MAX, NEW_PASSWORD_MAX]);
  });

  it.each([
    ["src/views/SettingsView.jsx", /minLength=\{NEW_PASSWORD_MIN\}/g, 2],
    ["apps/mobile/src/components/EmailAuthScreen.tsx", /password\.length >= NEW_PASSWORD_MIN/g, 1],
    ["apps/mobile/src/features/PasswordChangeCard.tsx", /(?:newPassword|confirmPassword)\.length < NEW_PASSWORD_MIN/g, 2],
    ["apps/mobile/src/services/supabase.ts", /password\.length < NEW_PASSWORD_MIN/g, 1],
  ])("binds %s to the shared source rather than a local length", (path, guard, count) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    expect(source).toMatch(/import \{[^}]*\bNEW_PASSWORD_MIN\b[^}]*\} from ["'][^"']*passwordPolicy\.js["']/);
    expect([...source.matchAll(guard)]).toHaveLength(count);
    expect(source).not.toMatch(/(?:newPassword|confirmPassword|password)\.length\s*[<>]=?\s*\d+/);
    expect(source).not.toMatch(/minLength=["']\d+["']/);
    if (path.endsWith("EmailAuthScreen.tsx")) expect(source).toContain("NEW_PASSWORD_RULE.es");
    if (path.endsWith("PasswordChangeCard.tsx")) expect(source).toContain("NEW_PASSWORD_RULE.en");
  });

  it("describes the same minimum in every web locale and never in sign-in copy", async () => {
    await loadLanguage("es");
    for (const locale of Object.keys(catalogue)) {
      for (const key of ["reset.passwordRequirements", "reset.passwordRejected", "auth.passwordRule", "signup.passwordRequirements", "signup.passwordRejected"]) {
        expect(catalogue[locale][key]).toContain(String(NEW_PASSWORD_MIN));
        expect(catalogue[locale][key]).not.toMatch(/\b12\b/);
      }
      // Sign-in copy never states the new-password policy. This edition's web
      // sign-in keeps its own 10-character gate (src/components/AuthScreen.jsx),
      // and the hint names that gate so a disabled button is never unexplained.
      expect(catalogue[locale]["auth.submitRequirements"]).not.toContain(String(NEW_PASSWORD_MIN));
      expect(catalogue[locale]["auth.submitRequirements"]).toMatch(/\b10\b/);
      // #9448: the live length reasons name the policy numbers and the current count.
      expect(catalogue[locale]["auth.newPasswordTooShort"]).toContain(String(NEW_PASSWORD_MIN));
      expect(catalogue[locale]["auth.newPasswordTooShort"]).toContain("{count}");
      expect(catalogue[locale]["auth.newPasswordTooLong"]).toContain(String(NEW_PASSWORD_MAX));
      expect(catalogue[locale]["auth.newPasswordTooLong"]).toContain("{count}");
    }
  });

  it("names which side of the length rule a new password misses, and nothing for an empty field", () => {
    expect(newPasswordLengthIssue("")).toBe("");
    expect(newPasswordLengthIssue(undefined)).toBe("");
    expect(newPasswordLengthIssue("a")).toBe("short");
    expect(newPasswordLengthIssue("a".repeat(NEW_PASSWORD_MIN - 1))).toBe("short");
    expect(newPasswordLengthIssue("a".repeat(NEW_PASSWORD_MIN))).toBe("");
    expect(newPasswordLengthIssue("a".repeat(NEW_PASSWORD_MAX))).toBe("");
    expect(newPasswordLengthIssue("a".repeat(NEW_PASSWORD_MAX + 1))).toBe("long");
  });

  it("refuses a short password even when native form validation is bypassed", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    const { container } = render(<PasswordChangeForm client={{ auth: { updateUser } }} t={(key) => catalogue.en[key]} />);
    const password = container.querySelector('input[name="password"]');
    const confirm = container.querySelector('input[name="confirm"]');
    fireEvent.change(container.querySelector('input[name="currentPassword"]'), { target: { value: "old123" } });
    for (const field of [password, confirm]) fireEvent.change(field, { target: { value: "a".repeat(NEW_PASSWORD_MIN - 1) } });
    expect(password).toHaveAttribute("minlength", String(NEW_PASSWORD_MIN));
    fireEvent.submit(container.querySelector("form"));
    expect(updateUser).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(catalogue.en["auth.passwordRule"]);
    for (const field of [password, confirm]) fireEvent.change(field, { target: { value: "a".repeat(NEW_PASSWORD_MIN) } });
    fireEvent.submit(container.querySelector("form"));
    expect(updateUser).toHaveBeenNthCalledWith(1, { password: "a".repeat(NEW_PASSWORD_MIN), current_password: "old123" });
    await screen.findByRole("status");
    await waitFor(() => expect(updateUser).toHaveBeenNthCalledWith(2, { data: { union_ground_password_issued_at: null } }));
  });

  it("keeps a changed password changed when clearing the emailed-password stamp fails afterwards", async () => {
    const updateUser = vi.fn().mockResolvedValueOnce({ error: null }).mockRejectedValueOnce(new Error("lock timeout"));
    const { container } = render(<PasswordChangeForm client={{ auth: { updateUser } }} t={(key) => catalogue.en[key]} />);
    for (const field of [container.querySelector('input[name="password"]'), container.querySelector('input[name="confirm"]')]) fireEvent.change(field, { target: { value: "a".repeat(NEW_PASSWORD_MIN) } });
    fireEvent.change(container.querySelector('input[name="currentPassword"]'), { target: { value: "old123" } });
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("status")).toHaveTextContent(catalogue.en["auth.passwordChanged"]);
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(2));
  });
});
