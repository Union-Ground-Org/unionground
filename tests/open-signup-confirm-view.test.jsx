import axe from "axe-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { SIGNUP_PASSWORD_MAX, SIGNUP_PASSWORD_MIN } from "../src/lib/openSignup.js";
import { OpenSignupConfirmView } from "../src/views/OpenSignupConfirmView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const TOKEN = `v1.${"a".repeat(16)}.${"b".repeat(40)}`;
const PASSWORD = "a-long-enough-password-for-policy";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

function reply(status, body) {
  return { status, ok: status >= 200 && status < 300, json: vi.fn().mockResolvedValue(body) };
}

function client(error = null) {
  return { auth: { setSession: vi.fn().mockResolvedValue({ error }) } };
}

function renderConfirm({ lang = "en", fetcher, readToken = () => TOKEN, supabase = client(), onSignedIn = vi.fn(), available = true } = {}) {
  const view = render(
    <LanguageProvider lang={lang}>
      <OpenSignupConfirmView available={available} client={supabase} fetcher={fetcher} readToken={readToken} onSignedIn={onSignedIn} />
    </LanguageProvider>,
  );
  return { ...view, supabase, onSignedIn };
}

function enterPasswords(container, first = PASSWORD, second = first) {
  fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: first } });
  fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: second } });
}

describe("/signup/confirm", () => {
  it("reads the fragment token once, even under Strict Mode, and scrubs the address bar", async () => {
    window.history.replaceState({}, "", `/signup/confirm#token=${TOKEN}`);
    const fetcher = vi.fn();
    render(
      <StrictMode>
        <LanguageProvider lang="en">
          <OpenSignupConfirmView available client={client()} fetcher={fetcher} />
        </LanguageProvider>
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "Finish creating your account" })).toBeInTheDocument();
    expect(document.querySelector('input[name="password"]')).not.toBeNull();
    expect(`${window.location.pathname}${window.location.hash}`).toBe("/signup/confirm");
  });

  it("creates the account, signs in through the password proxy and opens the app", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { accepted: true, email: "person@example.invalid" }))
      .mockResolvedValueOnce(reply(200, { accessToken: "access", refreshToken: "refresh" }));
    const { container, supabase, onSignedIn } = renderConfirm({ fetcher });
    await screen.findByRole("button", { name: "Create my account" });
    enterPasswords(container);
    expect(container.querySelector('input[name="password"]')).toHaveAttribute("autocomplete", "new-password");
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(fetcher.mock.calls[0][0]).toBe("/api/open-signup-confirm");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ token: TOKEN, password: PASSWORD, locale: "en" });
    expect(fetcher.mock.calls[1][0]).toBe("/api/auth-password-signin");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ email: "person@example.invalid", password: PASSWORD });
    expect(supabase.auth.setSession).toHaveBeenCalledWith({ access_token: "access", refresh_token: "refresh" });
    expect(screen.getByRole("status")).toHaveTextContent("Your account is ready.");
  });

  it("keeps submit disabled for a short password or a mismatch, with the visibility toggle", async () => {
    const { container } = renderConfirm({ fetcher: vi.fn() });
    const submit = await screen.findByRole("button", { name: "Create my account" });
    enterPasswords(container, "x".repeat(11));
    expect(submit).toHaveAttribute("aria-disabled", "true");
    enterPasswords(container, PASSWORD, `${PASSWORD}x`);
    expect(submit).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("The two passwords don't match.");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(container.querySelector('input[name="password"]')).toHaveAttribute("type", "text");
    enterPasswords(container);
    expect(submit).not.toHaveAttribute("aria-disabled");
  });

  // BUG-UG-NEW-PASSWORD-TOO-SHORT-GIVES-NO-REASON-20261122 (#9448): the
  // same silent greyed-out submit as /reset-password.
  it.each(["en", "es"])("says beside the field why Create my account stays unavailable while the password is too short or too long (%s)", async (lang) => {
    const { container } = renderConfirm({ lang, fetcher: vi.fn() });
    const submit = await screen.findByRole("button", { name: t(lang, "signup.confirmSubmit") });
    const field = container.querySelector('input[name="password"]');
    const lengthMessage = () => {
      const ids = (field.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
      expect(ids).toContain("signup-password-requirements");
      return ids.map((id) => document.getElementById(id)).find((node) => node?.id !== "signup-password-requirements") || null;
    };
    expect(lengthMessage()).toBeNull();
    const short = "x".repeat(SIGNUP_PASSWORD_MIN - 1);
    enterPasswords(container, short);
    expect(submit).toHaveAttribute("aria-disabled", "true");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(lengthMessage()).toHaveTextContent(t(lang, "auth.newPasswordTooShort", { count: short.length }));
    expect(lengthMessage().textContent).toContain(String(SIGNUP_PASSWORD_MIN));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
    enterPasswords(container);
    expect(lengthMessage()).toBeNull();
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(submit).not.toHaveAttribute("aria-disabled");
    const long = "x".repeat(SIGNUP_PASSWORD_MAX + 1);
    enterPasswords(container, long);
    expect(lengthMessage()).toHaveTextContent(t(lang, "auth.newPasswordTooLong", { count: long.length }));
    expect(submit).toHaveAttribute("aria-disabled", "true");
  });

  it("shows the used-link page for a missing token", async () => {
    renderConfirm({ fetcher: vi.fn(), readToken: () => null });
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/signup");
  });

  it("shows the used-link page when the server refuses the link", async () => {
    const { container } = renderConfirm({ fetcher: vi.fn().mockResolvedValue(reply(400, { error: "link-invalid" })) });
    await screen.findByRole("button", { name: "Create my account" });
    enterPasswords(container);
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeInTheDocument();
  });

  it.each([
    [400, { error: "password-rejected" }, "That password can't be used."],
    [429, { error: "rate-limited" }, "Too many attempts from this network."],
    [400, { error: "email-domain-blocked" }, "Use a personal email address. Government and employer email addresses can't be used for a Union Ground account."],
    [503, { error: "signup-unavailable" }, "Signup isn't available right now."],
    [500, {}, "Something went wrong."],
  ])("maps a %s answer to fixed copy", async (status, body, text) => {
    const { container } = renderConfirm({ fetcher: vi.fn().mockResolvedValue(reply(status, body)) });
    await screen.findByRole("button", { name: "Create my account" });
    enterPasswords(container);
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByText(new RegExp(text.replace(/[.?]/g, "\\$&")))).toBeInTheDocument();
    expect(container.querySelector('input[name="password"]')).not.toBeNull();
  });

  it("sends the person to sign in when the account exists but sign-in fails", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { accepted: true, email: "person@example.invalid" }))
      .mockResolvedValueOnce(reply(401, { error: "sign-in-failed" }));
    const { container, onSignedIn } = renderConfirm({ fetcher });
    await screen.findByRole("button", { name: "Create my account" });
    enterPasswords(container);
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByText(/Your account is ready, but signing in didn't work/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("scrubs the fragment at once but keeps the token until the owner's switch has been read", async () => {
    window.history.replaceState({}, "", `/signup/confirm#token=${TOKEN}`);
    const readToken = vi.fn(() => TOKEN);
    const fetcher = vi.fn().mockResolvedValue(reply(400, { error: "link-invalid" }));
    const confirm = (available) => (
      <StrictMode>
        <LanguageProvider lang="en">
          <OpenSignupConfirmView available={available} client={client()} fetcher={fetcher} readToken={readToken} />
        </LanguageProvider>
      </StrictMode>
    );
    const { container, rerender } = render(confirm(null));
    expect(screen.getByRole("heading", { name: "Finish creating your account" })).toBeInTheDocument();
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(readToken).toHaveBeenCalledTimes(1);
    rerender(confirm(true));
    await screen.findByRole("button", { name: "Create my account" });
    expect(readToken).toHaveBeenCalledTimes(1);
    enterPasswords(container);
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(JSON.parse(fetcher.mock.calls[0][1].body).token).toBe(TOKEN);
  });

  it("drops the held token when the switch read comes back off", async () => {
    const readToken = vi.fn(() => TOKEN);
    const fetcher = vi.fn();
    const confirm = (available) => (
      <LanguageProvider lang="en">
        <OpenSignupConfirmView available={available} client={client()} fetcher={fetcher} readToken={readToken} />
      </LanguageProvider>
    );
    const { container, rerender } = render(confirm(null));
    rerender(confirm(false));
    expect(await screen.findByRole("heading", { name: "Union Ground accounts are by invitation." })).toBeInTheDocument();
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows the not-available page but still scrubs the fragment when signup is off", async () => {
    window.history.replaceState({}, "", `/signup/confirm#token=${TOKEN}`);
    render(
      <LanguageProvider lang="en">
        <OpenSignupConfirmView available={false} client={client()} fetcher={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: "Union Ground accounts are by invitation." })).toBeInTheDocument();
    await waitFor(() => expect(`${window.location.pathname}${window.location.hash}`).toBe("/signup/confirm"));
    expect(document.querySelector('input[name="password"]')).toBeNull();
  });

  it("renders in Spanish and has no axe violations in either language", async () => {
    renderConfirm({ lang: "es", fetcher: vi.fn() });
    expect(await screen.findByRole("heading", { name: "Termina de crear tu cuenta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear mi cuenta" })).toBeInTheDocument();
    for (const lang of ["en", "es"]) {
      const { container, unmount } = renderConfirm({ lang, fetcher: vi.fn() });
      await waitFor(() => expect(container.querySelector('input[name="password"]')).not.toBeNull());
      const results = await axe.run(container, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results.violations.map((violation) => violation.id)).toEqual([]);
      unmount();
    }
  });
});

// Record 8435: the confirmation keeps its submit focused while it runs, and
// one tick sends one confirmation.
describe("/signup/confirm while the confirmation runs", () => {
  it("keeps the submit button focused and pending, and confirms once from one tick", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(500, {}));
    const { container } = renderConfirm({ fetcher });
    await waitFor(() => expect(container.querySelector('input[name="password"]')).not.toBeNull());
    enterPasswords(container);
    const submit = container.querySelector('form button[type="submit"]');
    await expectOneWriteFromOneTick(fetcher, [() => fireEvent.click(submit), () => fireEvent.click(submit)]);
    await expectHeldWriteFocus(fetcher, submit);
  });
});
