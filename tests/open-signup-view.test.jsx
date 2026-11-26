import axe from "axe-core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  confirmOpenSignup, loadTurnstile, openSignupAvailable, openSignupEligible, readOpenSignupSwitch, requestOpenSignup,
  signInAfterSignup, takeSignupToken, TURNSTILE_SCRIPT_URL,
} from "../src/lib/openSignup.js";
import { OpenSignupView } from "../src/views/OpenSignupView.jsx";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

function fakeWidget() {
  const widget = { render: vi.fn(() => "widget-1"), reset: vi.fn(), remove: vi.fn(), options: null };
  widget.render.mockImplementation((_element, options) => { widget.options = options; return "widget-1"; });
  return widget;
}

function reply(status, body) {
  return { status, ok: status >= 200 && status < 300, json: vi.fn().mockResolvedValue(body) };
}

function renderView({ lang = "en", fetcher = vi.fn().mockResolvedValue(reply(200, { accepted: true })), widget = fakeWidget(), available = true, loadWidget } = {}) {
  const view = render(
    <LanguageProvider lang={lang}>
      <OpenSignupView available={available} siteKey="site-key" fetcher={fetcher} loadWidget={loadWidget || (() => Promise.resolve(widget))} />
    </LanguageProvider>,
  );
  return { ...view, fetcher, widget };
}

async function fillAndPass(container, widget) {
  fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: " person@example.invalid " } });
  fireEvent.click(container.querySelector('input[name="acceptedTerms"]'));
  fireEvent.change(container.querySelector('select[name="residenceState"]'), { target: { value: "CA" } });
  fireEvent.click(container.querySelector('input[name="ageAttested"]'));
  await waitFor(() => expect(widget.render).toHaveBeenCalled());
  act(() => widget.options.callback("turnstile-token"));
}

async function axeViolations(container) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map((violation) => violation.id);
}

describe("/signup request form", () => {
  it("renders Turnstile with the signup action and keeps submit disabled until every requirement is met", async () => {
    const { container, widget } = renderView();
    const submit = screen.getByRole("button", { name: "Email me a link" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(widget.render).toHaveBeenCalled());
    expect(widget.options).toMatchObject({ sitekey: "site-key", action: "open-signup", language: "en" });
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "person@example.invalid" } });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(container.querySelector('input[name="acceptedTerms"]'));
    expect(submit).toHaveAttribute("aria-disabled", "true");
    // A state, then the age statement it selects (the API refuses a signup
    // without both). The box cannot be checked before a state is chosen.
    expect(container.querySelector('input[name="ageAttested"]')).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "State where you live" }), { target: { value: "AL" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "I'm 18 or older." }));
    expect(submit).toHaveAttribute("aria-disabled", "true");
    act(() => widget.options.callback("turnstile-token"));
    expect(submit).not.toHaveAttribute("aria-disabled");
    act(() => widget.options["expired-callback"]());
    expect(submit).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  });

  it("posts the email, terms, token and honeypot and then shows the uniform answer", async () => {
    const { container, fetcher, widget } = renderView();
    await fillAndPass(container, widget);
    fireEvent.submit(container.querySelector("form"));
    await screen.findByRole("heading", { name: "Check your email" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe("/api/open-signup");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(JSON.parse(init.body)).toEqual({
      email: "person@example.invalid", locale: "en", turnstileToken: "turnstile-token", acceptedTerms: true, residenceState: "CA", ageAttested: true, website: "",
    });
    expect(screen.getByText("If this address can be used, a link to finish is on its way. It works for 30 minutes.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth");
  });

  it.each([
    [503, { error: "signup-unavailable" }, "Signup isn't available right now. Try again later."],
    [400, { error: "invalid-request" }, "Check your email address and agree to the Terms and the Privacy Policy, then try again."],
    [500, {}, "Something went wrong. Try again."],
  ])("maps a %s answer to fixed copy and resets the single-use token", async (status, body, text) => {
    const { container, widget } = renderView({ fetcher: vi.fn().mockResolvedValue(reply(status, body)) });
    await fillAndPass(container, widget);
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(widget.reset).toHaveBeenCalledWith("widget-1");
    expect(screen.getByRole("button", { name: "Email me a link" })).toHaveAttribute("aria-disabled", "true");
  });

  it("maps a network failure to fixed copy", async () => {
    const { container, widget } = renderView({ fetcher: vi.fn().mockRejectedValue(new Error("offline")) });
    await fillAndPass(container, widget);
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
  });

  it("reports a widget that cannot load or errors", async () => {
    renderView({ loadWidget: () => Promise.reject(new Error("blocked")) });
    expect(await screen.findByRole("alert")).toHaveTextContent("The security check couldn't load.");
    const { widget } = renderView();
    await waitFor(() => expect(widget.render).toHaveBeenCalled());
    act(() => widget.options["error-callback"]());
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
  });

  it("removes the widget on unmount", async () => {
    const { widget, unmount } = renderView();
    await waitFor(() => expect(widget.render).toHaveBeenCalled());
    unmount();
    expect(widget.remove).toHaveBeenCalledWith("widget-1");
  });

  it("shows the not-available page and loads nothing when signup is off", () => {
    const loadWidget = vi.fn();
    render(
      <LanguageProvider lang="en">
        <OpenSignupView available={false} loadWidget={loadWidget} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { name: "Union Ground accounts are by invitation." })).toBeInTheDocument();
    // Invitation-only while the owner's switch is off: the way in is an invitation.
    expect(screen.getByRole("link", { name: "Request an invite" })).toHaveAttribute("href", "/request-invite");
    expect(loadWidget).not.toHaveBeenCalled();
    expect(document.querySelector('input[name="email"]')).toBeNull();
  });

  it("renders in Spanish", async () => {
    const { widget } = renderView({ lang: "es" });
    expect(screen.getByRole("heading", { name: "Empieza con tu correo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Envíame un enlace" })).toBeInTheDocument();
    await waitFor(() => expect(widget.options?.language).toBe("es"));
  });

  it("has no axe violations in English or Spanish", async () => {
    for (const lang of ["en", "es"]) {
      const { container, widget, unmount } = renderView({ lang });
      await waitFor(() => expect(widget.render).toHaveBeenCalled());
      expect(await axeViolations(container)).toEqual([]);
      unmount();
    }
  });
});

describe("open signup browser helpers", () => {
  it("offers signup only on the SaaS host, surface and live backend with a site key", () => {
    const saas = { hostname: PORTAL_HOST, surface: "saas", backendKind: "live", siteKey: "key" };
    expect(openSignupEligible(saas)).toBe(true);
    expect(openSignupEligible({ ...saas, hostname: `www.${PORTAL_HOST}` })).toBe(false);
    expect(openSignupEligible({ ...saas, siteKey: " " })).toBe(false);
    expect(openSignupEligible({ ...saas, surface: "demo" })).toBe(false);
    expect(openSignupEligible()).toBe(false);
    expect(openSignupEligible({ ...saas, siteKey: "" })).toBe(false);
    expect(openSignupEligible({ ...saas, backendKind: "sample" })).toBe(false);
    expect(openSignupEligible({ ...saas, hostname: SAMPLE_HOST })).toBe(false);
  });

  // REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003: the owner's switch ships
  // off, so a qualifying surface still offers nothing until the server says on.
  it("offers signup only while the owner's switch is on", () => {
    const saas = { hostname: PORTAL_HOST, surface: "saas", backendKind: "live", siteKey: "key" };
    expect(openSignupAvailable(saas)).toBe(false);
    expect(openSignupAvailable({ ...saas, switchOpen: false })).toBe(false);
    expect(openSignupAvailable({ ...saas, switchOpen: "true" })).toBe(false);
    expect(openSignupAvailable({ ...saas, switchOpen: true })).toBe(true);
    expect(openSignupAvailable({ ...saas, switchOpen: true, hostname: SAMPLE_HOST })).toBe(false);
  });

  it("reads the switch as on only from a 200 that says open", async () => {
    const reply = (status, body) => vi.fn().mockResolvedValue({ status, json: async () => body });
    const open = reply(200, { open: true });
    expect(await readOpenSignupSwitch(open)).toBe(true);
    expect(open).toHaveBeenCalledWith("/api/open-signup", expect.objectContaining({ method: "GET", cache: "no-store", credentials: "omit" }));
    expect(await readOpenSignupSwitch(reply(404, { error: "not-found" }))).toBe(false);
    expect(await readOpenSignupSwitch(reply(200, { open: false }))).toBe(false);
    expect(await readOpenSignupSwitch(reply(200, { open: "yes" }))).toBe(false);
    expect(await readOpenSignupSwitch(vi.fn().mockResolvedValue({ status: 200, json: async () => { throw new Error("bad"); } }))).toBe(false);
    expect(await readOpenSignupSwitch(vi.fn().mockRejectedValue(new Error("offline")))).toBe(false);
  });

  it("loads the Turnstile script once it is needed", async () => {
    const win = {};
    const appended = [];
    const doc = {
      createElement: () => ({}),
      head: { appendChild: (script) => appended.push(script) },
    };
    const loading = loadTurnstile(doc, win);
    expect(appended[0].src).toBe(TURNSTILE_SCRIPT_URL);
    win.turnstile = { render() {} };
    appended[0].onload();
    await expect(loading).resolves.toBe(win.turnstile);
    await expect(loadTurnstile(doc, win)).resolves.toBe(win.turnstile);
    expect(appended).toHaveLength(1);

    const empty = {};
    const missing = loadTurnstile(doc, empty);
    appended[1].onload();
    await expect(missing).rejects.toThrow("turnstile-missing");
    const failed = loadTurnstile(doc, {});
    appended[2].onerror();
    await expect(failed).rejects.toThrow("turnstile-load-failed");
  });

  it("takes the token from the fragment and scrubs the address bar", () => {
    const token = `v1.${"a".repeat(16)}.${"b".repeat(40)}`;
    window.history.replaceState({}, "", `/signup/confirm#token=${token}`);
    expect(takeSignupToken()).toBe(token);
    expect(`${window.location.pathname}${window.location.hash}`).toBe("/signup/confirm");
    window.history.replaceState({}, "", "/signup/confirm#token=bogus");
    expect(takeSignupToken()).toBeNull();
    window.history.replaceState({}, "", "/signup/confirm");
    expect(takeSignupToken()).toBeNull();
  });

  it("maps request and confirm answers", async () => {
    const answer = (status, body) => vi.fn().mockResolvedValue(reply(status, body));
    expect(await requestOpenSignup(answer(200, { accepted: false }), {})).toBe("error");
    expect(await requestOpenSignup(answer(429, {}), {})).toBe("error");
    expect(await confirmOpenSignup(answer(200, { accepted: true, email: "person@example.invalid" }), {}))
      .toEqual({ status: "accepted", email: "person@example.invalid" });
    expect(await confirmOpenSignup(answer(400, { error: "link-invalid" }), {})).toEqual({ status: "link-invalid" });
    expect(await confirmOpenSignup(answer(429, { error: "rate-limited" }), {})).toEqual({ status: "rate-limited" });
    expect(await confirmOpenSignup(answer(503, { error: "signup-unavailable" }), {})).toEqual({ status: "unavailable" });
    expect(await confirmOpenSignup(answer(500, {}), {})).toEqual({ status: "error" });
    expect(await confirmOpenSignup(vi.fn().mockRejectedValue(new Error("x")), {})).toEqual({ status: "error" });
    const unreadable = vi.fn().mockResolvedValue({ status: 200, ok: true, json: vi.fn().mockRejectedValue(new Error("x")) });
    expect(await confirmOpenSignup(unreadable, {})).toEqual({ status: "error" });
  });

  it("signs in through the password proxy and hands the tokens to the client", async () => {
    const client = { auth: { setSession: vi.fn().mockResolvedValue({ error: null }) } };
    const fetcher = vi.fn().mockResolvedValue(reply(200, { accessToken: "a", refreshToken: "r" }));
    expect(await signInAfterSignup(fetcher, client, "person@example.invalid", "pw")).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe("/api/auth-password-signin");
    expect(client.auth.setSession).toHaveBeenCalledWith({ access_token: "a", refresh_token: "r" });
    expect(await signInAfterSignup(vi.fn().mockResolvedValue(reply(401, {})), client, "e", "p")).toBe(false);
    client.auth.setSession.mockResolvedValueOnce({ error: new Error("bad") });
    expect(await signInAfterSignup(fetcher, client, "e", "p")).toBe(false);
    expect(await signInAfterSignup(vi.fn().mockRejectedValue(new Error("x")), client, "e", "p")).toBe(false);
  });
});
