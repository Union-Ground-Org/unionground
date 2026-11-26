// REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006: the sign-in screen
// offers the emailed reset, /reset-password asks for an address and answers
// every address the same way, and the emailed link requires an authenticator
// code (or an enrolment) before the new password is saved. English and Spanish.
import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue, t } from "../src/lib/i18n.js";
import {
  loadPendingReset, PENDING_RESET_KEY, RESET_PASSWORD_MAX, RESET_PASSWORD_MIN, RESET_STATE_LIFETIME_MS, savePendingReset, takeResetToken,
} from "../src/lib/passwordReset.js";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";
import { resetEnrollmentFixture } from "./helpers/resetEnrollmentFixture.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

// The deployment publishes a support mailbox (src/lib/publicContact.js); these suites use the fictional one.
vi.mock("../src/lib/publicContact.js", async () => (await import("./helpers/fictional-provider.js")).publicContactModule());
// The reset fixture stubs the fictional project ref, so the trusted backend list
// is the fictional provider's, as in the API tests.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// The shape of the server's sealed ticket that the emailed link carries.
const TOKEN = `t1.${"A".repeat(16)}.${"b".repeat(120)}`;
const PASSWORD = "a-brand-new-password-long-enough";
// Opaque account tags as api/_lib/passwordReset.js resetAccountTag writes them.
const ACCOUNT_A = `a1.${"A".repeat(22)}`;
const ACCOUNT_B = `a1.${"B".repeat(22)}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

function reply(status, body) {
  return { status, ok: status >= 200 && status < 300, json: vi.fn().mockResolvedValue(body) };
}

function renderReset({ lang = "en", fetcher = vi.fn(), readToken = () => null } = {}) {
  const view = render(
    <LanguageProvider lang={lang}>
      <PasswordResetView fetcher={fetcher} readToken={readToken} />
    </LanguageProvider>,
  );
  return { ...view, fetcher };
}

function sentBody(fetcher, index) {
  return JSON.parse(fetcher.mock.calls[index][1].body);
}

describe("sign-in screen", () => {
  it("links to the emailed reset and names a remedy for each loss, without saying staff see passwords", () => {
    // This edition's card gives one recovery-help paragraph (auth.recoveryHelp)
    // instead of upstream's list of three losses.
    for (const [lang, link] of [
      ["en", "Forgot your password?"],
      ["es", "¿Olvidaste tu contraseña?"],
    ]) {
      const { unmount } = render(
        <LanguageProvider lang={lang}>
          <AuthScreen client={{ auth: {} }} lang={lang} />
        </LanguageProvider>,
      );
      // This edition's sign-in card has no "Sign in with other options"
      // disclosure: the form and the reset link show directly.
      expect(screen.getByRole("link", { name: link })).toHaveAttribute("href", "/reset-password");
      expect(screen.getByText(t(lang, "auth.recoveryHelp"))).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/see your password|ven tu contraseña/i);
      unmount();
    }
  });
});

describe("/reset-password request", () => {
  it("sends only one email request while a previous submission is pending", async () => {
    let finishRequest;
    const fetcher = vi.fn(() => new Promise((resolve) => { finishRequest = resolve; }));
    const { container } = renderReset({ fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    const form = container.querySelector("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Pending, not natively disabled (record 8435): it keeps focus.
    expect(screen.getByRole("button", { name: "Working…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Working…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("heading", { name: "Check your email" })).not.toBeInTheDocument();
    finishRequest(reply(200, { accepted: true }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // A network failure says to check the connection (#9461, offline-reported-plainly.test.jsx).
  it.each([
    ["an unreadable response", async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("private gateway response"); } })],
  ])("does not claim an email was sent after %s and allows a retry", async (_label, failure) => {
    const fetcher = vi.fn().mockImplementationOnce(failure).mockResolvedValueOnce(reply(200, { accepted: true }));
    const { container } = renderReset({ fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    const send = screen.getByRole("button", { name: "Email me a reset link" });
    fireEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["reset.unavailable"]);
    expect(screen.queryByRole("heading", { name: "Check your email" })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/private transport detail|private gateway response/);
    // CONTENT-UG-WEB-LOCKED-OUT-RECOVERY-COPY-20261018: the fallback names a reachable contact.
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks for an address in Spanish and shows the same answer whatever the server knows", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { accepted: true }));
    const { container } = renderReset({ lang: "es", fetcher });
    expect(screen.getByRole("heading", { name: "Restablece tu contraseña" })).toBeInTheDocument();
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: " persona@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Enviarme un enlace" }));
    expect(await screen.findByRole("heading", { name: "Revisa tu correo" })).toBeInTheDocument();
    expect(screen.getByText(/Si una cuenta usa ese correo, enviamos un enlace a esa dirección/)).toBeInTheDocument();
    expect(sentBody(fetcher, 0)).toEqual({ action: "request", email: "persona@example.com", locale: "es" });
  });

  // UX-UG-RESET-SENT-NO-SEND-AGAIN-20261018 and
  // BUG-UG-RESET-SEND-ANOTHER-LINK-COPY-MATCHES-ACTION-20261020: the
  // send-another control sends (same address, same request, no reload) and
  // says so; a different address returns to the form.
  it.each([
    ["en", "Send another link to this address", "Use a different email address", "Email me a reset link"],
    ["es", "Enviar otro enlace a este correo", "Usar otro correo electrónico", "Enviarme un enlace"],
  ])("sends another link to the kept address, or reopens the form for another address (%s)", async (lang, again, different, submit) => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { accepted: true }));
    const { container } = renderReset({ lang, fetcher });
    const field = () => container.querySelector('input[name="email"]');
    fireEvent.change(field(), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: submit }));
    await screen.findByRole("heading", { name: t(lang, "reset.sentTitle") });
    // Finish the initial sent-screen focus before testing focus during a resend.
    await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());

    const again1 = screen.getByRole("button", { name: again });
    again1.focus();
    fireEvent.click(again1);
    expect(await screen.findByText(t(lang, "reset.sentAgain"))).toHaveAttribute("role", "status");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sentBody(fetcher, 1)).toEqual({ action: "request", email: "member@example.com", locale: lang });
    expect(screen.getByRole("heading", { name: t(lang, "reset.sentTitle") })).toBeInTheDocument();
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: again }));

    fireEvent.click(screen.getByRole("button", { name: different }));
    expect(field()).toHaveValue("");
    expect(screen.queryByRole("heading", { name: t(lang, "reset.sentTitle") })).toBeNull();
    expect(screen.queryByText(t(lang, "reset.sentAgain"))).toBeNull();
    fireEvent.change(field(), { target: { value: "other@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: submit }));
    await screen.findByRole("heading", { name: t(lang, "reset.sentTitle") });
    expect(sentBody(fetcher, 2)).toMatchObject({ email: "other@example.com" });
  });

  it("moves focus to the reopened email field after Use a different email address", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { accepted: true }));
    const { container } = renderReset({ fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    await screen.findByRole("heading", { name: "Check your email" });
    const button = screen.getByRole("button", { name: "Use a different email address" });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(document.activeElement).toBe(container.querySelector('input[name="email"]')));
  });

  it("keeps the server's limit in charge when sending again, and keeps the sent screen", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { accepted: true }))
      .mockResolvedValueOnce(reply(429, { error: "try-later" }));
    const { container } = renderReset({ fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    await screen.findByRole("heading", { name: "Check your email" });
    fireEvent.click(screen.getByRole("button", { name: "Send another link to this address" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["reset.rateLimited"]);
    expect(screen.getByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.queryByText(catalogue.en["reset.sentAgain"])).toBeNull();
    expect(screen.getByRole("button", { name: "Send another link to this address" })).toBeEnabled();
    // Grok R1 P1 on #5529: the refusal is announced and focused where it shows,
    // not on the success status block above it.
    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    // Pressing again clears the alert and starts a resend; focus stays on the
    // busy control, nothing jumps to the status block (Sol R1 P2).
    const again = screen.getByRole("button", { name: "Send another link to this address" });
    again.focus();
    fireEvent.click(again);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(again).toHaveFocus();
  });

  it("sends one request when Send another link is pressed again while the first resend is in flight", async () => {
    let release;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { accepted: true }))
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(reply(200, { accepted: true })); }));
    const { container } = renderReset({ lang: "en", fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    await screen.findByRole("heading", { name: catalogue.en["reset.sentTitle"] });
    const again = screen.getByRole("button", { name: "Send another link to this address" });
    fireEvent.click(again);
    fireEvent.click(again);
    fireEvent.click(again);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(again).toHaveAttribute("aria-busy", "true");
    expect(again).toBeEnabled();
    release();
    expect(await screen.findByText(catalogue.en["reset.sentAgain"])).toBeInTheDocument();
    expect(again).not.toHaveAttribute("aria-busy");
    expect(again).not.toHaveAttribute("aria-disabled");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows the generic unavailable answer when a resend is refused with a code the sent screen does not know", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { accepted: true }))
      .mockResolvedValueOnce(reply(409, { error: "two-step-unavailable" }));
    const { container } = renderReset({ lang: "en", fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    await screen.findByRole("heading", { name: catalogue.en["reset.sentTitle"] });
    fireEvent.click(screen.getByRole("button", { name: "Send another link to this address" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["reset.unavailable"]);
    expect(screen.getByRole("heading", { name: catalogue.en["reset.sentTitle"] })).toBeInTheDocument();
    expect(screen.queryByText(catalogue.en["reset.sentAgain"])).toBeNull();
  });

  it("sends one request when the form is submitted again while the first is in flight, and shows the generic answer for an unknown refusal", async () => {
    let release;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(reply(409, { error: "two-step-unavailable" })); }));
    const { container } = renderReset({ lang: "en", fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    const submit = screen.getByRole("button", { name: "Email me a reset link" });
    fireEvent.click(submit);
    fireEvent.submit(container.querySelector("form"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["reset.unavailable"]);
    expect(screen.queryByRole("heading", { name: catalogue.en["reset.sentTitle"] })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resends to the address the accepted request went to, not a draft edited while it was pending", async () => {
    // Sol R1 P2 on #5529: the form stays editable while the first request is in
    // flight, so a resend must post the submitted address.
    let release;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(reply(200, { accepted: true })); }))
      .mockResolvedValueOnce(reply(200, { accepted: true }));
    const { container } = renderReset({ lang: "en", fetcher });
    const field = () => container.querySelector('input[name="email"]');
    fireEvent.change(field(), { target: { value: "first@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    fireEvent.change(field(), { target: { value: "" } });
    release();
    await screen.findByRole("heading", { name: catalogue.en["reset.sentTitle"] });
    fireEvent.click(screen.getByRole("button", { name: "Send another link to this address" }));
    await screen.findByText(catalogue.en["reset.sentAgain"]);
    expect(sentBody(fetcher, 1)).toMatchObject({ email: "first@example.com" });
  });

  it("says to wait when the limit is reached", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(429, { error: "try-later" }));
    const { container } = renderReset({ fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts.");
  });
});

describe("/reset-password default transport", () => {
  it("posts to the reset route with the browser fetch when no fetcher is given", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { accepted: true }));
    vi.stubGlobal("fetch", fetch);
    const { container } = render(
      <LanguageProvider lang="en">
        <PasswordResetView readToken={() => null} />
      </LanguageProvider>,
    );
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/password-reset", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });
});

describe("/reset-password link", () => {
  it("submits the recovery code only once while the password change is pending", async () => {
    let finishRecovery;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRecovery = resolve; }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    const save = await screen.findByRole("button", { name: "Save new password" });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    const form = save.closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(loadPendingReset()).toMatchObject({ state: "sealed" });
    expect(sentBody(fetcher, 1)).toEqual({ action: "finish", state: "sealed", code: "123456", password: PASSWORD });
    finishRecovery(reply(200, { completed: true, sessionsEnded: true }));
    expect(await screen.findByRole("heading", { name: "Your password is changed" })).toBeInTheDocument();
    expect(loadPendingReset()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["en", true], ["en", false], ["es", true], ["es", false],
  ])("explains enrollment and offers recovery codes in %s (sessions ended: %s)", async (lang, sessionsEnded) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "enroll", state: "sealed", secret: "JBSWY3DPEHPK3PXP" }))
      .mockResolvedValueOnce(reply(200, { completed: true, sessionsEnded }));
    const { container } = renderReset({ lang, fetcher, readToken: () => TOKEN });
    const intro = await screen.findByText(t(lang, "reset.enrollIntro"));
    expect(intro).toHaveTextContent("Google Authenticator");
    expect(intro).toHaveTextContent("Microsoft Authenticator");
    for (const text of lang === "en"
      ? ["free options", "protect your account", "about a minute", "six-digit code", "only after the code is accepted"]
      : ["opciones gratuitas", "proteger tu cuenta", "aproximadamente un minuto", "seis dígitos", "solo después de que se acepte el código"]) {
      expect(intro).toHaveTextContent(text);
    }
    const caution = container.querySelector(".mfa-caution");
    expect(caution).toHaveTextContent(t(lang, "reset.enrollCaution"));
    expect(caution).toHaveTextContent(lang === "en" ? "No phone" : "No tienes teléfono");
    expect(caution).toHaveTextContent(lang === "en" ? "unable to use an authenticator app" : "no puedes usar una app de autenticación");
    expect(caution).toHaveTextContent(lang === "en" ? "chapter administrator" : "administración de tu capítulo");
    expect(caution).toHaveTextContent(lang === "en" ? "password has not changed yet" : "contraseña todavía no ha cambiado");
    expect(screen.getByRole("button", { name: t(lang, "reset.finishSubmit") })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "reset.finishSubmit") }));
    const completionKey = sessionsEnded ? "reset.completedBody" : "reset.completedSessionsOpen";
    const completed = await screen.findByText(t(lang, completionKey));
    expect(completed).toHaveTextContent(lang === "en" ? "Settings > Security > Recovery codes" : "Configuración > Seguridad > Códigos de recuperación");
    expect(completed).toHaveTextContent(lang === "en" ? "if your organization allows it" : "si tu organización lo permite");
    for (const key of ["reset.enrollIntro", "reset.enrollCaution", completionKey]) {
      expect(catalogue[lang][key]).toBe(t(lang, key));
    }
    expect(screen.getByRole("link", { name: t(lang, "reset.signIn") })).toHaveAttribute("href", "/auth");
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).toBeNull();
    expect(sentBody(fetcher, 1)).toEqual({ action: "finish", state: "sealed", code: "123456", password: PASSWORD });
  });

  // BUG-UG-RESET-RECOVERY-FOOTER-CONTRADICTION-20261021: the help under
  // the challenge step must not say only an administrator can help while the
  // same screen offers "Use a recovery code"; enrolment has no codes and keeps
  // the administrator-only line.
  it.each(["en", "es"])("matches the locked-out help to the step's recovery-code offer in %s", async (lang) => {
    // The administrator-only remedy is a suffix of the recovery-code one, so
    // compare the authenticator line exactly.
    const authenticatorLine = () => [...document.querySelectorAll(".locked-out__list li")]
      .map((item) => item.textContent)
      .filter((text) => text.startsWith(`${t(lang, "lockedOut.authenticator")}:`));
    const line = (key) => [`${t(lang, "lockedOut.authenticator")}: ${t(lang, key)}`];

    const challenge = renderReset({ lang, fetcher: vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "sealed" })), readToken: () => TOKEN });
    const offer = await screen.findByRole("button", { name: t(lang, "reset.useRecoveryCode") });
    expect(authenticatorLine()).toEqual(line("lockedOut.authenticatorRemedy"));
    fireEvent.click(offer);
    expect(screen.getByRole("button", { name: t(lang, "reset.useAuthenticatorCode") })).toBeInTheDocument();
    expect(authenticatorLine()).toEqual(line("lockedOut.authenticatorRemedy"));
    challenge.unmount();
    window.sessionStorage.clear();

    renderReset({ lang, fetcher: vi.fn().mockResolvedValue(reply(200, { mode: "enroll", state: "sealed", secret: "JBSWY3DPEHPK3PXP" })), readToken: () => TOKEN });
    await screen.findByText(t(lang, "reset.enrollIntro"));
    expect(screen.queryByRole("button", { name: t(lang, "reset.useRecoveryCode") })).toBeNull();
    expect(authenticatorLine()).toEqual(line("lockedOut.authenticatorRemedyAdminOnly"));
  });

  it("reads and scrubs the fragment token once, even under Strict Mode", async () => {
    window.history.replaceState({}, "", `/reset-password#token=${TOKEN}`);
    const fetcher = vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "sealed" }));
    render(
      <StrictMode>
        <LanguageProvider lang="en">
          <PasswordResetView fetcher={fetcher} />
        </LanguageProvider>
      </StrictMode>,
    );
    expect(await screen.findByText(/Your password changes only after the code is accepted/)).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sentBody(fetcher, 0)).toEqual({ action: "begin", token: TOKEN });
  });

  it("requires enrolment for an account without two-step, then saves only with a code", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "enroll", state: "sealed", qr: "data:image/svg+xml;utf-8,<svg/>", secret: "JBSWY3DPEHPK3PXP" }))
      .mockResolvedValueOnce(reply(400, { error: "code-not-accepted" }))
      .mockResolvedValueOnce(reply(200, { completed: true }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    expect(await screen.findByText(/does not have two-step sign-in yet/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /QR/i })).toBeInTheDocument();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save new password" });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "000000" } });
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your password has not changed.");

    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("heading", { name: "Your password is changed" })).toBeInTheDocument();
    expect(sentBody(fetcher, 2)).toEqual({ action: "finish", state: "sealed", code: "123456", password: PASSWORD });
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth");
  });

  it("says in Spanish when other devices could not be signed out, and points to Settings", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(200, { completed: true, sessionsEnded: false, audited: true }));
    const { container } = renderReset({ lang: "es", fetcher, readToken: () => TOKEN });
    const save = await screen.findByRole("button", { name: "Guardar la contraseña nueva" });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(save);
    expect(await screen.findByText(/No pudimos cerrar tu sesión en tus otros dispositivos/)).toBeInTheDocument();
    expect(screen.getByText(/Cerrar sesión en todas partes/)).toBeInTheDocument();
    expect(screen.queryByText(/Cerramos tu sesión en todos los dispositivos/)).toBeNull();
  });

  it("explains in Spanish that the password was not changed when two-step cannot be set up", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(409, { error: "two-step-unavailable" }));
    renderReset({ lang: "es", fetcher, readToken: () => TOKEN });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("tu contraseña no cambió");
    expect(alert).toHaveTextContent("lo restablezca o lo quite");
  });

  // A new password does not remove a verified factor this flow cannot
  // challenge (a phone factor), so the member needs two-step reset or removal,
  // never a temporary password, and a support link when no one is reachable.
  // Both remedies, each tied to its case: a factor already on the account needs
  // a two-step reset or removal (a new password would not remove it); a setup
  // that only failed (enrollment off, no factor) needs a temporary password.
  it.each([
    ["en", /already on the account, a new password would not remove it: ask your campaign administrator to reset or remove it/, /If it only could not be set up, ask your campaign administrator to have Union Ground email you a new temporary password/],
    ["es", /ya tiene el inicio de sesión en dos pasos, una contraseña nueva no lo quitaría: pide a la administración de tu campaña que lo restablezca o lo quite/, /Si solo no se pudo configurar, pide a la administración de tu campaña que Union Ground te mande por correo una contraseña temporal nueva/],
  ])("tells each two-step-unavailable case its own remedy and links support (%s)", async (lang, factorOnAccount, setupOnly) => {
    const fetcher = vi.fn().mockResolvedValue(reply(409, { error: "two-step-unavailable" }));
    renderReset({ lang, fetcher, readToken: () => TOKEN });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(factorOnAccount);
    expect(alert).toHaveTextContent(setupOnly);
  });

  it.each([
    [502, "reset-unavailable", /not available right now/],
    [429, "try-later", /Too many attempts/],
  ])("offers a new link after a temporary begin failure (%s)", async (status, error, message) => {
    const fetcher = vi.fn().mockResolvedValue(reply(status, { error }));
    renderReset({ fetcher, readToken: () => TOKEN });
    expect(await screen.findByRole("heading", { name: "Your reset link could not be opened" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("link", { name: "Email me a new link" })).toHaveAttribute("href", "/reset-password");
    // The unavailable sentence names support, and that address is a mailto here too
    // (the staff fallback under it is the second one).
  });

  it("offers a new link for a used or expired one", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(400, { error: "link-invalid" }));
    renderReset({ fetcher, readToken: () => TOKEN });
    expect(await screen.findByRole("heading", { name: "This reset link no longer works" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Email me a new link" })).toHaveAttribute("href", "/reset-password");
  });

  it("shows both passwords together, flags a mismatch and keeps save off until they agree", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "sealed" }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    const toggle = await screen.findByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('input[name="password"]')).toHaveAttribute("type", "text");
    expect(container.querySelector('input[name="passwordConfirm"]')).toHaveAttribute("type", "text");
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: `${PASSWORD}x` } });
    expect(screen.getByRole("alert")).toHaveTextContent("The two passwords do not match.");
    expect(screen.getByRole("button", { name: "Save new password" })).toHaveAttribute("aria-disabled", "true");
  });

  // BUG-UG-NEW-PASSWORD-TOO-SHORT-GIVES-NO-REASON-20261122 (#9448): Save
  // stayed greyed out under the minimum with nothing beside the field saying why.
  it.each(["en", "es"])("says beside the field why Save stays unavailable while the new password is too short or too long (%s)", async (lang) => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "sealed" }));
    const { container } = renderReset({ lang, fetcher, readToken: () => TOKEN });
    const save = await screen.findByRole("button", { name: t(lang, "reset.finishSubmit") });
    const field = container.querySelector('input[name="password"]');
    const lengthMessage = () => {
      const ids = (field.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
      expect(ids).toContain("reset-password-requirements");
      return ids.map((id) => document.getElementById(id)).find((node) => node?.id !== "reset-password-requirements") || null;
    };
    expect(lengthMessage()).toBeNull();
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    const short = "a".repeat(RESET_PASSWORD_MIN - 4);
    fireEvent.change(field, { target: { value: short } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: short } });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(field).toHaveAttribute("aria-invalid", "true");
    const message = lengthMessage();
    expect(message).toHaveTextContent(t(lang, "auth.newPasswordTooShort", { count: short.length }));
    expect(message.textContent).toContain(String(short.length));
    expect(message.textContent).toContain(String(RESET_PASSWORD_MIN));
    // One description, not an alert re-announced on every keystroke.
    expect(screen.queryByRole("alert")).toBeNull();
    expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
    fireEvent.change(field, { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    expect(lengthMessage()).toBeNull();
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(save).not.toHaveAttribute("aria-disabled");
    // The input's maxLength stops typing past the maximum; a value set around it still gets a reason.
    const long = "a".repeat(RESET_PASSWORD_MAX + 1);
    fireEvent.change(field, { target: { value: long } });
    expect(lengthMessage()).toHaveTextContent(t(lang, "auth.newPasswordTooLong", { count: long.length }));
    expect(lengthMessage().textContent).toContain(String(RESET_PASSWORD_MAX));
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(field, { target: { value: "" } });
    expect(lengthMessage()).toBeNull();
  });

  it("says to wait, not that the link is bad, when the link cannot be checked right now", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(429, { error: "try-later" }));
    renderReset({ fetcher, readToken: () => TOKEN });
    expect(await screen.findByRole("heading", { name: "Your reset link could not be opened" })).toBeInTheDocument();
    expect(screen.getByText(/Too many attempts\./)).toBeInTheDocument();
  });

  it("moves to the expired-link answer when the link lapses before the code is entered", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(400, { error: "link-invalid" }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    await screen.findByRole("button", { name: "Save new password" });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("heading", { name: "This reset link no longer works" })).toBeInTheDocument();
  });

  it("has no axe violations on the challenge form", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "sealed" }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    await screen.findByRole("button", { name: "Save new password" });
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});

describe("/reset-password with a saved recovery code (BUG-UG-RESET-REFUSES-RECOVERY-CODE-20261018)", () => {
  const CODE = "UG-ABCD-1234-ABCD-1234";

  async function openRecovery({ lang = "en", fetcher }) {
    const view = renderReset({ lang, fetcher, readToken: () => TOKEN });
    fireEvent.click(await screen.findByRole("button", { name: t(lang, "reset.useRecoveryCode") }));
    return view;
  }

  it.each([
    ["recovery-unfinished", "reset.recoveryUnfinished"],
    ["recovery-held", "reset.recoveryHeld"],
  ])("clears the saved reset after %s so a reload cannot resume it", async (status, messageKey) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(502, { error: status }));
    const view = await openRecovery({ fetcher });
    expect(loadPendingReset()).toMatchObject({ state: "sealed" });
    fireEvent.change(view.container.querySelector('input[name="code"]'), { target: { value: CODE } });
    fireEvent.change(view.container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(view.container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", messageKey));
    expect(loadPendingReset()).toBeNull();
    view.unmount();
    const reloaded = vi.fn();
    renderReset({ fetcher: reloaded, readToken: () => null });
    expect(await screen.findByRole("button", { name: "Email me a reset link" })).toBeInTheDocument();
    expect(reloaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save new password" })).toBeNull();
  });

  it.each(["en", "es"])("sends the recovery code, then says the lost authenticator is gone and a new one is next (%s)", async (lang) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(200, { completed: true, sessionsEnded: true, recoveryCodeUsed: true }));
    const { container } = await openRecovery({ lang, fetcher });
    expect(screen.getByText(t(lang, "reset.recoveryIntro"))).toBeInTheDocument();
    const save = screen.getByRole("button", { name: t(lang, "reset.finishSubmit") });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: CODE } });
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.click(save);
    expect(await screen.findByText(t(lang, "reset.completedRecovery"))).toBeInTheDocument();
    expect(sentBody(fetcher, 1)).toEqual({ action: "finish", state: "sealed", code: CODE, password: PASSWORD });
    expect(container).not.toHaveTextContent(CODE);
  });

  // Round 3 on #5052: a held recovery (the lock stays, the password outcome is
  // unknown) is its own terminal state with nothing left to type.
  it.each([
    [400, "code-not-accepted", "reset.recoveryRejected"],
    [409, "recovery-held", "reset.recoveryHeld"],
    [502, "recovery-unfinished", "reset.recoveryUnfinished"],
  ])("focuses the recovery message after %s %s", async (status, error, messageKey) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(status, { error }));
    const { container } = await openRecovery({ fetcher });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: CODE } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    const save = screen.getByRole("button", { name: "Save new password" });
    save.focus();
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("en", messageKey));
    await waitFor(() => expect(alert).toHaveFocus());
    expect(container.querySelector("form") !== null).toBe(error === "code-not-accepted");
  });

  it.each(["en", "es"])("says the recovery is held with the password outcome unknown, and clears the form (%s)", async (lang) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(409, { error: "recovery-held" }));
    const { container } = renderReset({ lang, fetcher, readToken: () => TOKEN });
    await screen.findByRole("button", { name: t(lang, "reset.useRecoveryCode") });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "reset.useRecoveryCode") }));
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "UG-ABCD-1234-ABCD-1234" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "reset.finishSubmit") }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t(lang, "reset.recoveryHeld"));
    await waitFor(() => expect(alert).toHaveFocus());
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('input[name="code"]')).toBeNull();
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(screen.getByRole("link", { name: t(lang, "reset.backToSignIn") })).toHaveAttribute("href", "/auth");
  });

  it.each(["en", "es"])("says the password changed but the recovery is unfinished, and closes the form (%s)", async (lang) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(502, { error: "recovery-unfinished" }));
    const { container } = await openRecovery({ lang, fetcher });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "reset.finishSubmit") }));
    expect(await screen.findByText(t(lang, "reset.recoveryUnfinished"))).toBeInTheDocument();
    expect(container.querySelector('input[name="code"]')).toBeNull();
    expect(screen.getByRole("link", { name: t(lang, "reset.backToSignIn") })).toHaveAttribute("href", "/auth");
    expect(container).not.toHaveTextContent(CODE);
  });

  it("explains a rejected recovery code differently from a rejected authenticator code", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(400, { error: "code-not-accepted" }));
    const { container } = await openRecovery({ fetcher });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["reset.recoveryRejected"]);
  });

  it.each(["en", "es"])("closes a held recovery instead of offering an ineffective retry (%s)", async (lang) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(502, { error: "recovery-held" }));
    const { container } = await openRecovery({ lang, fetcher });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: t(lang, "reset.finishSubmit") }));
    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent(t(lang, "reset.recoveryHeld"));
    await waitFor(() => expect(message).toHaveFocus());
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(screen.queryByRole("button", { name: t(lang, "reset.finishSubmit") })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(CODE);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("tells the member to ask for a new link when the recovery could not be finished", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(502, { error: "recovery-incomplete" }));
    const { container } = await openRecovery({ fetcher });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["reset.recoveryIncomplete"]);
  });

  it("switches back to the authenticator code, clearing what was typed, and offers no recovery code during enrolment", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "sealed" }));
    const { container } = await openRecovery({ fetcher });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Use the code from my authenticator app instead" }));
    expect(container.querySelector('input[name="code"]')).toHaveValue("");
    expect(container.querySelector('input[name="code"]')).toHaveAttribute("inputmode", "numeric");
    cleanup();
    window.sessionStorage.clear();

    const enrolling = vi.fn().mockResolvedValue(reply(200, { mode: "enroll", state: "sealed", secret: "JBSWY3DPEHPK3PXP" }));
    renderReset({ fetcher: enrolling, readToken: () => TOKEN });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    expect(screen.queryByRole("button", { name: /recovery code/i })).toBeNull();
  });

  it("says in the settings enrolment caution that a saved recovery code gets the member back in", () => {
    for (const lang of ["en", "es"]) {
      expect(t(lang, "mfa.enrollCaution")).toMatch(lang === "en" ? /recovery code/i : /código de recuperación/i);
    }
  });

  // Owner decision, November 12, 2026 (step 4, answer b): a founder locked out
  // alone is not recovered, so enrolment and the one-time code display tell an
  // only administrator that support cannot help and to add a second one.
  it("tells an only administrator at enrolment and code display that nobody, support included, can recover them", () => {
    const expected = {
      en: [/only administrator/, /not even Union Ground support/, /add a second administrator/i],
      es: [/único administrador/, /ni siquiera el soporte de Union Ground/, /agrega un segundo administrador/i],
    };
    for (const lang of ["en", "es"]) {
      for (const key of ["mfa.enrollCaution", "mfa.recoveryDisplayOnce"]) {
        for (const pattern of expected[lang]) expect(t(lang, key)).toMatch(pattern);
      }
    }
  });
});

describe("/reset-password resume (BUG-UG-RESET-LINK-SPENT-ON-PAGE-OPEN-20261018)", () => {
  const ENROLL = { mode: "enroll", state: "sealed", qr: "data:image/svg+xml;utf-8,<svg/>", secret: "JBSWY3DPEHPK3PXP" };

  it("resumes the enrolment step after a reload without spending the link again", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(200, ENROLL));
    const first = renderReset({ fetcher, readToken: () => TOKEN });
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    first.unmount();

    // A reload: the fragment is already scrubbed, so no token is read.
    const reloaded = vi.fn();
    const { container } = renderReset({ fetcher: reloaded, readToken: () => null });
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /QR/i })).toHaveAttribute("src", ENROLL.qr);
    expect(reloaded).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");

    reloaded.mockResolvedValue(reply(200, { completed: true }));
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("heading", { name: "Your password is changed" })).toBeInTheDocument();
    expect(sentBody(reloaded, 0)).toEqual({ action: "finish", state: "sealed", code: "123456", password: PASSWORD });
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  it("resumes the code step when the same link is opened again, and starts over for a newer link", async () => {
    const challenge = vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "sealed" }));
    const opened = renderReset({ fetcher: challenge, readToken: () => TOKEN });
    await screen.findByRole("button", { name: "Save new password" });
    opened.unmount();

    const again = vi.fn();
    const second = renderReset({ fetcher: again, readToken: () => TOKEN });
    await screen.findByRole("button", { name: "Save new password" });
    expect(again).not.toHaveBeenCalled();
    second.unmount();

    const newer = `t1.${"C".repeat(16)}.${"d".repeat(120)}`;
    const fresh = vi.fn().mockResolvedValue(reply(200, { mode: "challenge", state: "newer-state" }));
    renderReset({ fetcher: fresh, readToken: () => newer });
    await screen.findByRole("button", { name: "Save new password" });
    expect(sentBody(fresh, 0)).toEqual({ action: "begin", token: newer });
    expect(JSON.parse(window.sessionStorage.getItem(PENDING_RESET_KEY))).toMatchObject({ ticket: newer, state: "newer-state" });
  });

  it("keeps the usable saved reset when a different link turns out to be expired or used", async () => {
    const first = renderReset({ fetcher: vi.fn().mockResolvedValue(reply(200, ENROLL)), readToken: () => TOKEN });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    first.unmount();

    const older = `t1.${"E".repeat(16)}.${"f".repeat(120)}`;
    const stale = vi.fn().mockResolvedValue(reply(400, { error: "link-invalid" }));
    const second = renderReset({ fetcher: stale, readToken: () => older });
    await screen.findByRole("heading", { name: "This reset link no longer works" });
    second.unmount();

    const reload = vi.fn();
    renderReset({ fetcher: reload, readToken: () => null });
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("clears a retained pre-tag enrollment when finish finds its factor gone", async () => {
    // A record saved before resets carried an account tag survives a newer begin;
    // the server now answers its finish link-invalid, and that clears it.
    savePendingReset({ ticket: TOKEN, startedAt: Date.now(), recovery: { ...ENROLL, status: "enroll" } });
    const fetcher = vi.fn().mockResolvedValue(reply(400, { error: "link-invalid" }));
    const { container } = renderReset({ fetcher, readToken: () => null });
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(await screen.findByRole("heading", { name: "This reset link no longer works" })).toBeInTheDocument();
    expect(sentBody(fetcher, 0)).toEqual({ action: "finish", state: "sealed", code: "123456", password: PASSWORD });
    expect(loadPendingReset()).toBeNull();
  });

  it.each([429, 502, 503])("forgets an invalidated enrollment and cannot resume it after a %s begin failure", async (status) => {
    savePendingReset({ ticket: TOKEN, startedAt: Date.now(), recovery: { ...ENROLL, status: "enroll", account: ACCOUNT_A } });
    const view = renderReset({ fetcher: vi.fn().mockResolvedValue(reply(status, { error: "reset-invalidated", reason: "try-later", account: ACCOUNT_A })), readToken: () => `t1.${"E".repeat(16)}.${"f".repeat(120)}` });
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(loadPendingReset()).toBeNull();
    view.unmount();
    renderReset();
    expect(screen.getByRole("button", { name: "Email me a reset link" })).toBeInTheDocument();
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).not.toBeInTheDocument();
  });

  it("runs Auth deletion and failed enrollment through the real web component and transport", async () => {
    const backend = resetEnrollmentFixture(vi);
    const first = renderReset({ fetcher: backend.fetcher, readToken: () => backend.ticketA });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    expect(backend.factorCount()).toBe(1);
    first.unmount();
    backend.failEnrollment(429);
    const second = renderReset({ fetcher: backend.fetcher, readToken: () => backend.ticketB });
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(backend.factorCount()).toBe(0);
    expect(loadPendingReset() === null).toBe(true);
    second.unmount();
    renderReset();
    expect(screen.getByRole("button", { name: "Email me a reset link" })).toBeInTheDocument();
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).not.toBeInTheDocument();
  });

  it.each(["delete-throttled", "other-account-enroll-failed"])("keeps the real prior enrollment after %s without factor deletion", async (failure) => {
    const backend = resetEnrollmentFixture(vi);
    const first = renderReset({ fetcher: backend.fetcher, readToken: () => backend.ticketA });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    const saved = loadPendingReset();
    first.unmount();
    if (failure === "delete-throttled") backend.failDeletion(429);
    else { backend.useOtherAccount(); backend.failEnrollment(500); }
    const second = renderReset({ fetcher: backend.fetcher, readToken: () => backend.ticketB });
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(backend.factorCount()).toBe(1);
    expect(loadPendingReset()?.state === saved.state).toBe(true);
    second.unmount();
    renderReset({ fetcher: backend.fetcher, readToken: () => null });
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
  });

  it("keeps a newer saved reset when an older begin reports invalidation", async () => {
    savePendingReset({ ticket: TOKEN, startedAt: Date.now(), recovery: { ...ENROLL, status: "enroll" } });
    let finish;
    renderReset({ fetcher: vi.fn(() => new Promise((resolve) => { finish = resolve; })), readToken: () => "different-ticket" });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    savePendingReset({ ticket: "ticket-c", startedAt: Date.now(), recovery: { ...ENROLL, status: "enroll", state: "state-c" } });
    finish(reply(502, { error: "reset-invalidated", reason: "reset-unavailable" }));
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(loadPendingReset()).toMatchObject({ ticket: "ticket-c", state: "state-c" });
  });

  it("captures an earlier queued enrollment after its save and clears it on invalidation", async () => {
    let finish;
    const first = renderReset({ fetcher: vi.fn(() => new Promise((resolve) => { finish = resolve; })), readToken: () => TOKEN });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    first.unmount();
    const newer = vi.fn().mockResolvedValue(reply(429, { error: "reset-invalidated", reason: "try-later", account: ACCOUNT_A }));
    renderReset({ fetcher: newer, readToken: () => "ticket-b" });
    expect(newer).not.toHaveBeenCalled();
    finish(reply(200, { ...ENROLL, account: ACCOUNT_A }));
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(loadPendingReset()).toBeNull();
  });

  // BUG-UG-RESET-PENDING-RECORD-ACCOUNT-BINDING-20261021 (Grok R6 on
  // #5030): B's begin deletes B's own unverified factor, then B's enrolment
  // fails; A's saved enrollment is live and must stay.
  it.each([429, 404, 500, "transport"])("keeps another account's live enrollment when this account's factor is deleted and enrollment fails (%s)", async (failure) => {
    const backend = resetEnrollmentFixture(vi);
    const first = renderReset({ fetcher: backend.fetcher, readToken: () => backend.ticketA });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    const saved = loadPendingReset();
    expect(saved.account).toMatch(/^a1\./u);
    first.unmount();
    backend.useOtherAccount();
    backend.seedFactor();
    backend.failEnrollment(failure);
    const second = renderReset({ fetcher: backend.fetcher, readToken: () => backend.ticketB });
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(backend.factorCount()).toBe(1);
    expect(loadPendingReset()).toEqual(saved);
    second.unmount();
    renderReset({ fetcher: backend.fetcher, readToken: () => null });
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
  });

  it.each([
    ["another account", ACCOUNT_B], ["an untagged answer", undefined],
  ])("keeps a saved enrollment when the invalidation names %s", async (_label, account) => {
    savePendingReset({ ticket: TOKEN, startedAt: Date.now(), recovery: { ...ENROLL, status: "enroll", account: ACCOUNT_A } });
    renderReset({ fetcher: vi.fn().mockResolvedValue(reply(429, { error: "reset-invalidated", reason: "try-later", ...(account ? { account } : {}) })), readToken: () => "ticket-b" });
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(loadPendingReset()).toMatchObject({ state: ENROLL.state, account: ACCOUNT_A });
  });

  it("keeps a saved enrollment written before records carried an account", async () => {
    savePendingReset({ ticket: TOKEN, startedAt: Date.now(), recovery: { ...ENROLL, status: "enroll" } });
    expect(loadPendingReset()).not.toHaveProperty("account");
    renderReset({ fetcher: vi.fn().mockResolvedValue(reply(502, { error: "reset-invalidated", reason: "reset-unavailable", account: ACCOUNT_A })), readToken: () => "ticket-b" });
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(loadPendingReset()).toMatchObject({ state: ENROLL.state });
  });

  it("does not clear an unrelated valid challenge on enrollment invalidation", async () => {
    savePendingReset({ ticket: TOKEN, startedAt: Date.now(), recovery: { status: "challenge", state: "verified-factor", qr: "", secret: "" } });
    renderReset({ fetcher: vi.fn().mockResolvedValue(reply(502, { error: "reset-invalidated" })), readToken: () => "ticket-b" });
    await screen.findByRole("link", { name: "Email me a new link" });
    expect(loadPendingReset()).toMatchObject({ status: "challenge", state: "verified-factor" });
  });

  it.each([
    [400, "link-invalid"], [429, "try-later"], [502, "reset-unavailable"],
  ])("opens the email request when another link fails (%s) and the member asks for a new one", async (status, error) => {
    const first = renderReset({ fetcher: vi.fn().mockResolvedValue(reply(200, ENROLL)), readToken: () => TOKEN });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    first.unmount();
    const other = `t1.${"E".repeat(16)}.${"f".repeat(120)}`;
    const fetcher = vi.fn().mockResolvedValueOnce(reply(status, { error }))
      .mockResolvedValueOnce(reply(200, { accepted: true }));
    const { container } = renderReset({ fetcher, readToken: () => other });
    const request = await screen.findByRole("link", { name: "Email me a new link" });
    expect(loadPendingReset()).toMatchObject({ ticket: TOKEN });
    fireEvent.click(request);
    expect(container.querySelector('input[name="email"]')).not.toBeNull();
    expect(loadPendingReset()).toBeNull();
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).not.toBeInTheDocument();
    expect(container.querySelector('input[name="code"]')).toBeNull();
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "other@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(sentBody(fetcher, 1)).toEqual({ action: "request", email: "other@example.com", locale: "en" });
  });

  it("spends the link once when the page mounts twice while begin is still in flight", async () => {
    let answer;
    const fetcher = vi.fn(() => new Promise((resolve) => { answer = () => resolve(reply(200, ENROLL)); }));
    const a = renderReset({ fetcher, readToken: () => TOKEN });
    const b = renderReset({ fetcher, readToken: () => TOKEN });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    answer();
    await screen.findAllByText("JBSWY3DPEHPK3PXP");
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it("lets a member leave a resumed reset for a fresh request", async () => {
    const opened = renderReset({ fetcher: vi.fn().mockResolvedValue(reply(200, ENROLL)), readToken: () => TOKEN });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    opened.unmount();
    const view = renderReset({ fetcher: vi.fn(), readToken: () => null });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    fireEvent.click(screen.getByRole("button", { name: "Start a new reset instead" }));
    expect(await screen.findByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).toBeNull();
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).toBeNull();
    view.unmount();
  });

  it("cannot start another reset while a finish request is pending", async () => {
    let finish;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    await screen.findByRole("button", { name: "Save new password" });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    const startOver = screen.getByRole("button", { name: "Start a new reset instead" });
    expect(startOver).toBeEnabled();
    expect(startOver).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(startOver);
    expect(container.querySelector('input[name="email"]')).toBeNull();
    finish(reply(200, { completed: true, sessionsEnded: true }));
    await screen.findByRole("heading", { name: catalogue.en["reset.completedTitle"] });
  });

  it("forgets the saved reset when two-step cannot be completed, so a reload does not repeat the refusal", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(409, { error: "two-step-unavailable" }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    await screen.findByRole("button", { name: "Save new password" });
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    await screen.findByRole("alert");
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  it("asks for a new link once the sealed state has lapsed, and forgets it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
    const fetcher = vi.fn().mockResolvedValue(reply(200, ENROLL));
    const opened = renderReset({ fetcher, readToken: () => TOKEN });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    opened.unmount();
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).not.toBeNull();

    vi.setSystemTime(new Date("2026-10-20T15:15:00.001Z"));
    renderReset({ fetcher: vi.fn(), readToken: () => null });
    expect(await screen.findByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  it("forgets the saved state when the server says the link no longer works", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply(200, { mode: "challenge", state: "sealed" }))
      .mockResolvedValueOnce(reply(400, { error: "link-invalid" }));
    const { container } = renderReset({ fetcher, readToken: () => TOKEN });
    await screen.findByRole("button", { name: "Save new password" });
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).not.toBeNull();
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: PASSWORD } });
    fireEvent.change(container.querySelector('input[name="passwordConfirm"]'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Save new password" }));
    await screen.findByRole("heading", { name: "This reset link no longer works" });
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  it("keeps the record out of localStorage and the address bar", async () => {
    window.history.replaceState({}, "", `/reset-password#token=${TOKEN}`);
    const fetcher = vi.fn().mockResolvedValue(reply(200, ENROLL));
    renderReset({ fetcher, readToken: takeResetToken });
    await screen.findByText("JBSWY3DPEHPK3PXP");
    expect(window.localStorage.length).toBe(0);
    expect(window.location.href).toMatch(/\/reset-password$/);
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).not.toContain("#token");
  });
});

describe("pending reset record", () => {
  const recovery = { status: "challenge", state: "sealed", qr: "", secret: "" };

  it("rejects damaged, foreign or over-long records and removes them", () => {
    const now = Date.parse("2026-10-20T15:00:00Z");
    const good = { ticket: TOKEN, expiresAt: now + 1000, ...recovery };
    window.sessionStorage.setItem(PENDING_RESET_KEY, JSON.stringify(good));
    expect(loadPendingReset(window, now)).toMatchObject({ ticket: TOKEN, state: "sealed" });
    for (const bad of [
      "not json", "null", JSON.stringify({ ...good, status: "completed" }), JSON.stringify({ ...good, state: "" }),
      JSON.stringify({ ...good, expiresAt: now }), JSON.stringify({ ...good, state: "x".repeat(16_385) }),
      JSON.stringify({ ...good, qr: "x".repeat(100_001) }), JSON.stringify({ ...good, secret: "x".repeat(257) }),
      JSON.stringify({ ...good, secret: 5 }),
    ]) {
      window.sessionStorage.setItem(PENDING_RESET_KEY, bad);
      expect(loadPendingReset(window, now)).toBeNull();
      expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).toBeNull();
    }
  });

  it("keeps a record whose clock was stepped backwards instead of treating it as forged", () => {
    const now = Date.parse("2026-10-20T15:00:00Z");
    const record = { ticket: TOKEN, expiresAt: now + RESET_STATE_LIFETIME_MS + 600_000, ...recovery };
    window.sessionStorage.setItem(PENDING_RESET_KEY, JSON.stringify(record));
    expect(loadPendingReset(window, now)).toMatchObject({ state: "sealed" });
    expect(window.sessionStorage.getItem(PENDING_RESET_KEY)).not.toBeNull();
  });

  it("lives no longer than the server's 15 minutes from when begin was sent", () => {
    const startedAt = Date.parse("2026-10-20T15:00:00Z");
    savePendingReset({ ticket: TOKEN, startedAt, recovery });
    expect(loadPendingReset(window, startedAt + RESET_STATE_LIFETIME_MS - 1)).not.toBeNull();
    savePendingReset({ ticket: TOKEN, startedAt, recovery });
    expect(loadPendingReset(window, startedAt + RESET_STATE_LIFETIME_MS)).toBeNull();
  });

  it("does nothing when storage is unavailable", () => {
    const blocked = { get sessionStorage() { throw new Error("denied"); } };
    expect(() => savePendingReset({ ticket: TOKEN, startedAt: 0, recovery }, blocked)).not.toThrow();
    expect(loadPendingReset(blocked)).toBeNull();
  });
});

describe("takeResetToken", () => {
  it("accepts only the server's sealed ticket and leaves no fragment behind", () => {
    window.history.replaceState({}, "", `/reset-password#token=${TOKEN}`);
    expect(takeResetToken()).toBe(TOKEN);
    expect(window.location.href).toMatch(/\/reset-password$/);
    window.history.replaceState({}, "", `/reset-password#token=${"a1".repeat(28)}`);
    expect(takeResetToken()).toBeNull();
    window.history.replaceState({}, "", "/reset-password#token=<script>");
    expect(takeResetToken()).toBeNull();
  });
});

// Record 8435: the reset request keeps its button focused while it runs, and
// one tick sends one request.
describe("/reset-password while a request runs", () => {
  it("keeps Send reset link focused and pending, and requests once from one tick", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(429, {}));
    const { container } = renderReset({ fetcher });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    const submit = container.querySelector('form button[type="submit"]');
    await expectOneWriteFromOneTick(fetcher, [() => fireEvent.click(submit), () => fireEvent.click(submit)]);
    await expectHeldWriteFocus(fetcher, submit);
  });
});
