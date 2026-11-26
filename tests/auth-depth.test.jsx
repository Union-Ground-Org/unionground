import { existsSync, readFileSync } from "node:fs";
import { readAppSource } from "./helpers/app-source.js";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { MfaSettings, MfaChallenge } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { LockedOutRemedies } from "../src/components/LockedOutRemedies.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { openSignupAvailable } from "../src/lib/openSignup.js";
import { PRODUCT_NAME } from "../src/lib/productIdentity.js";

function authClient(overrides = {}) {
  return {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
      setSession: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ accessToken: "access-token", refreshToken: "refresh-token" }),
  }));
});

afterEach(() => vi.unstubAllGlobals());

function renderAuth(client, lang = "en") {
  return render(
    <LanguageProvider lang={lang}>
      <AuthScreen client={client} lang={lang} />
    </LanguageProvider>,
  );
}

// Query by form field name rather than label text: several controls on this
// screen legitimately mention "email", so a text match is ambiguous.
function submitCredentials(container, email = "member@example.com", password = "correct-horse-battery-staple") {
  const input = container.querySelector('input[name="email"]');
  fireEvent.change(input, { target: { value: email } });
  fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: password } });
  fireEvent.submit(container.querySelector("form"));
}

describe("provisioned email and password sign-in", () => {
  // Union Ground's sign-in card keeps its own header (the brand link home)
  // and a product footer; it does not carry Union Ground's legal link rows.
  it("starts disabled and frames the form with the Union Ground header and footer", () => {
    renderAuth(authClient());
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription("Enter your account email and at least 10 password characters to enable sign in.");
    const banner = screen.getByRole("banner");
    const footer = screen.getByRole("contentinfo");
    const home = banner.querySelector("a.sgauth-brand");
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAccessibleName(catalogue.en["landing.homeLabel"]);
    expect(banner).toHaveTextContent(PRODUCT_NAME);
    expect(footer).toHaveTextContent(PRODUCT_NAME);
    expect(PRODUCT_NAME).toBe("Union Ground");
  });

  it("explains that a cold protected link will resume after sign-in", () => {
    render(
      <LanguageProvider lang="en">
        <AuthScreen client={authClient()} returnToRequestedPage />
      </LanguageProvider>,
    );
    expect(screen.getByText("Your requested page is waiting. Sign in and you’ll return there automatically."))
      .toBeInTheDocument();
  });

  it("submits only an email and password to the audited grant proxy", async () => {
    const client = authClient();
    const { container } = renderAuth(client);
    submitCredentials(container);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth-password-signin", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "member@example.com", password: "correct-horse-battery-staple" }),
    })));
    expect(client.auth.setSession).toHaveBeenCalledWith({ access_token: "access-token", refresh_token: "refresh-token" });
  });

  it("shows one generic failure for an unknown address or a wrong password", async () => {
    async function messageFor(email) {
      fetch.mockResolvedValueOnce({ ok: false, status: 401, json: vi.fn().mockResolvedValue({ error: "sign-in-failed" }) });
      const client = authClient();
      const { container, unmount } = renderAuth(client);
      submitCredentials(container, email);
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const text = await waitFor(() => {
        const el = container.querySelector(".auth-message");
        expect(el).toBeTruthy();
        return el.textContent;
      });
      unmount();
      return text;
    }

    const wrong = await messageFor("known@example.com");
    const unknown = await messageFor("ghost@example.com");
    expect(unknown).toBe(wrong);
  });

  // SEC-UG-PASSWORD-SIGNIN-THROTTLE-20261001: the route's 429 uses limits
  // that are the same for every address, so the screen says to wait instead of
  // blaming the password, and still says the same thing for any address.
  it("tells the person to wait when sign-in is throttled, whatever the address", async () => {
    async function throttledMessageFor(email) {
      fetch.mockResolvedValueOnce({ ok: false, status: 429, json: vi.fn().mockResolvedValue({ error: "try-later" }) });
      const client = authClient();
      const { container, unmount } = renderAuth(client);
      submitCredentials(container, email);
      const text = await waitFor(() => {
        const el = container.querySelector(".auth-message");
        expect(el).toBeTruthy();
        return el.textContent;
      });
      expect(client.auth.setSession).not.toHaveBeenCalled();
      unmount();
      return text;
    }
    const known = await throttledMessageFor("known@example.com");
    expect(known).toBe(catalogue.en["auth.passwordRateLimited"]);
    expect(await throttledMessageFor("ghost@example.com")).toBe(known);
    expect(catalogue.es["auth.passwordRateLimited"]).toBeTruthy();
  });

  // BUG-UNIONGROUND-WEB-SIGNIN-OUTAGE-SHOWN-AS-WRONG-PASSWORD-20261018: an outage
  // is the same for every address, so the screen says it could not reach the
  // service; a refused credential keeps the flat message.
  it("says Union Ground could not be reached for a dropped connection or a 503, and keeps the flat credential message for a 401", async () => {
    async function messageAfter(arrange, setSessionError = false) {
      arrange();
      const client = authClient();
      if (setSessionError) client.auth.setSession.mockResolvedValueOnce({ error: new Error("session storage failed") });
      const { container, unmount } = renderAuth(client);
      submitCredentials(container);
      const text = await waitFor(() => {
        const el = container.querySelector(".auth-message");
        expect(el).toBeTruthy();
        return el.textContent;
      });
      if (!setSessionError) expect(client.auth.setSession).not.toHaveBeenCalled();
      unmount();
      return text;
    }
    const dropped = await messageAfter(() => fetch.mockRejectedValueOnce(new TypeError("Failed to fetch")));
    const unavailable = await messageAfter(() => fetch.mockResolvedValueOnce({
      ok: false, status: 503, json: vi.fn().mockResolvedValue({ error: "sign-in-unavailable" }),
    }));
    const gatewayPage = await messageAfter(() => fetch.mockResolvedValueOnce({
      ok: false, status: 502, json: vi.fn().mockRejectedValue(new SyntaxError("not json")),
    }));
    // Not the password either: an answer with no session in it, and a session
    // the SDK would not take.
    const malformed = await messageAfter(() => fetch.mockResolvedValueOnce({
      ok: true, status: 200, json: vi.fn().mockResolvedValue({ accessToken: "a" }),
    }));
    const sessionRefused = await messageAfter(() => fetch.mockResolvedValueOnce({
      ok: true, status: 200, json: vi.fn().mockResolvedValue({ accessToken: "a", refreshToken: "r" }),
    }), true);
    const refused = await messageAfter(() => fetch.mockResolvedValueOnce({
      ok: false, status: 401, json: vi.fn().mockResolvedValue({ error: "sign-in-failed" }),
    }));
    expect(dropped).toBe(catalogue.en["auth.passwordUnreachable"]);
    expect(unavailable).toBe(dropped);
    expect(gatewayPage).toBe(dropped);
    expect(malformed).toBe(dropped);
    expect(sessionRefused).toBe(dropped);
    expect(dropped).toMatch(/could not reach Union Ground/i);
    expect(refused).toBe(catalogue.en["auth.passwordFailed"]);
    expect(refused).not.toBe(dropped);
    expect(catalogue.es["auth.passwordUnreachable"]).toBeTruthy();
  });
});

describe("locked-out recovery copy", () => {
  it("never sends anyone to a local office, in either language", () => {
    for (const lang of ["en", "es"]) {
      for (const [key, value] of Object.entries(catalogue[lang])) {
        expect(String(value), `${lang} ${key}`).not.toMatch(/local office|oficina local/i);
      }
    }
  });

  // BUG-UG-LOCKED-OUT-REMEDIES-SCANNABILITY-20261020: three losses,
  // each on its own line with its remedy, rendered once for the sign-in card
  // and the reset screens. The reset form takes only a six-digit authenticator
  // code, so its list cannot tell a member to use a recovery code there; the
  // sign-in screen can.
  it.each(["en", "es"])("lists the three remedies separately, and no inbox-loss line promises an email (%s)", (lang) => {
    const copy = catalogue[lang];
    const { unmount } = render(<LanguageProvider lang={lang}><LockedOutRemedies /></LanguageProvider>);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const [index, key] of ["password", "authenticator", "inbox"].entries()) {
      expect(items[index].querySelector("strong")).toHaveTextContent(`${copy[`lockedOut.${key}`]}:`);
      expect(items[index]).toHaveTextContent(copy[`lockedOut.${key}Remedy`]);
    }
    expect(copy["lockedOut.inboxRemedy"]).not.toMatch(/email you a new temporary password|contraseña temporal/);
    expect(items[1]).toHaveTextContent(/recovery code|código de recuperación/i);
    unmount();
    render(<LanguageProvider lang={lang}><LockedOutRemedies recoveryCodes={false} /></LanguageProvider>);
    const resetItems = screen.getAllByRole("listitem");
    expect(resetItems).toHaveLength(3);
    expect(resetItems[1]).not.toHaveTextContent(/recovery code|código de recuperación/i);
    expect(resetItems[1]).toHaveTextContent(copy["lockedOut.authenticatorRemedyAdminOnly"]);
  });
});

describe("account creation stays off the sign-in form", () => {
  // Owner ruling 2026-08-18; invitation-only since 2026-10-01: the browser
  // never calls signUp, and nothing on the site creates an account itself.
  it("the sign-in form never creates an account", () => {
    const client = authClient();
    const { container } = renderAuth(client);
    expect(container.textContent).not.toMatch(/create (an )?account/i);
    expect(container.querySelector('input[name="fullName"]')).toBeNull();
    expect(container.querySelector('input[autocomplete="new-password"]')).toBeNull();
    expect(client.auth.signUp).toBeUndefined();
  });

  it("offers no signup link, only the invitation-only note and a request link", () => {
    const { container } = renderAuth(authClient());
    expect(container.querySelector('a[href^="/signup"]')).toBeNull();
    expect(container).toHaveTextContent(catalogue.en["auth.inviteOnly"]);
    expect(screen.getByRole("link", { name: "Request an invite" })).toHaveAttribute("href", "/request-invite");
    expect(catalogue.es["auth.inviteOnly"]).toBeTruthy();
  });

  // The entry exists only while the owner's switch is on, on the SaaS live
  // surface of a product host. Union Ground has no product host yet, so no
  // host it runs on qualifies; the card links once only when told to.
  it("links to /signup exactly once only when signup is available, and no Union Ground host offers it", () => {
    const { container, unmount } = render(
      <LanguageProvider lang="en">
        <AuthScreen client={authClient()} signupAvailable />
      </LanguageProvider>,
    );
    const links = [...container.querySelectorAll('a[href="/signup"]')];
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent("Create an organization");
    expect(container).not.toHaveTextContent(catalogue.en["auth.inviteOnly"]);
    unmount();

    const open = { surface: "saas", backendKind: "live", siteKey: "site-key", switchOpen: true };
    for (const surface of [
      { ...open, hostname: "localhost" },
      { ...open, hostname: "127.0.0.1" },
      { ...open, hostname: "feature-git-branch.vercel.app" },
      { ...open, hostname: "unionground.invalid" },
      { ...open, hostname: "localhost", switchOpen: false },
      { ...open, hostname: "localhost", backendKind: "sample" },
      { ...open, hostname: "localhost", surface: "demo", backendKind: "sample" },
      { ...open, hostname: "localhost", siteKey: "" },
    ]) {
      const available = openSignupAvailable(surface);
      expect(available, JSON.stringify(surface)).toBe(false);
      const view = render(
        <LanguageProvider lang="en">
          <AuthScreen client={authClient()} signupAvailable={available} />
        </LanguageProvider>,
      );
      expect(view.container.querySelector('a[href="/signup"]')).toBeNull();
      expect(view.container).toHaveTextContent(catalogue.en["auth.inviteOnly"]);
      view.unmount();
    }
  });

  // Union Ground's signed-out browser proof (scripts/stagehand-public-proof.mjs)
  // is operations tooling that was not imported; the sign-in source itself
  // is checked here instead so the same "never creates an account" claim
  // still has a guard.
  it("keeps Supabase self-signup disabled and the sign-in form signed out", () => {
    const config = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8");
    expect(config.match(/enable_signup = false/g)).toHaveLength(2);
    expect(config).toMatch(/\[auth\.email\][\s\S]*?enable_signup = true/);
    const signIn = readFileSync(resolve(process.cwd(), "src/components/AuthScreen.jsx"), "utf8");
    expect(signIn).not.toMatch(/auth\/v1\/signup|signUp\(|\/auth\/v1\/admin\/users|\/auth\/v1\/admin\/generate_link/);
  });
});

describe("first-ship password path", () => {
  it("renders a current-password field and no longer claims there is no sign-up", () => {
    const { container } = renderAuth(authClient());
    expect(container.querySelector('input[name="password"]')).toHaveAttribute("autocomplete", "current-password");
    expect(container.textContent).not.toMatch(/no public sign-up/i);
    expect(container.textContent).toContain("Sign in with your account email and password.");
  });

  it("surfaces a stable safe error instead of provider detail", async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 401, json: vi.fn().mockResolvedValue({ error: "smtp private detail" }) });
    const client = authClient();
    const { container } = renderAuth(client);
    submitCredentials(container);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not sign in");
    expect(container.textContent).not.toContain("smtp private detail");
  });

  // The error and the page give one path: the emailed reset first, an
  // administrator's reissue as the stated fallback. Union Ground has no
  // provisioned support mailbox, so the help line names no address at all.
  it("gives one path for a forgotten password in the error and on the page", async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 401, json: vi.fn().mockResolvedValue({ error: "sign-in-failed" }) });
    const { container } = renderAuth(authClient());
    submitCredentials(container);
    expect(await screen.findByRole("alert")).toHaveTextContent("Forgot your password? Reset it by email from the link below.");
    const [reset, help] = container.querySelectorAll(".sgauth-recovery");
    expect(reset.querySelector("a")).toHaveAttribute("href", "/reset-password");
    expect(reset).toHaveTextContent("Forgot your password?");
    expect(help).toHaveTextContent(catalogue.en["auth.recoveryHelp"]);
    expect(help.querySelector("a")).toBeNull();
    expect(help.textContent).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(container.textContent).not.toMatch(/safe reissue|Need a password reissued/);
  });

  it("keeps language controls and the landing return operable without changing auth state", () => {
    const onLanguageChange = vi.fn();
    const onBackToLanding = vi.fn();
    render(
      <LanguageProvider lang="en">
        <AuthScreen
          client={authClient()}
          lang="en"
          onLanguageChange={onLanguageChange}
          onBackToLanding={onBackToLanding}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Español" }));
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    fireEvent.click(screen.getByRole("button", { name: /Back to the public site/i }));
    expect(onLanguageChange.mock.calls).toEqual([["es"], ["en"]]);
    expect(onBackToLanding).toHaveBeenCalledOnce();
  });
});

describe("TOTP enrolment", () => {
  function mfaClient(overrides = {}) {
    return {
      auth: {
        mfa: {
          listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }),
          enroll: vi.fn().mockResolvedValue({ data: { id: "f1", totp: { qr_code: "data:image/svg+xml;base64,x", secret: "SECRET123" } }, error: null }),
          challenge: vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null }),
          verify: vi.fn().mockResolvedValue({ data: {}, error: null }),
          unenroll: vi.fn().mockResolvedValue({ error: null }),
          ...overrides,
        },
      },
    };
  }

  const renderMfa = (client) => render(
    <LanguageProvider lang="en"><MfaSettings client={client} /></LanguageProvider>,
  );

  it("offers enrolment when no factor exists", async () => {
    renderMfa(mfaClient());
    expect(await screen.findByRole("button", { name: /turn on two-step/i })).toBeInTheDocument();
  });

  // An abandoned enrolment leaves an unverified factor behind, and the next
  // enroll() can then fail with an error the member cannot act on.
  it("clears an abandoned unverified factor before enrolling again", async () => {
    const client = mfaClient({
      listFactors: vi.fn().mockResolvedValue({ data: { all: [{ id: "stale", factor_type: "totp", status: "unverified" }], totp: [] }, error: null }),
    });
    renderMfa(client);
    fireEvent.click(await screen.findByRole("button", { name: /turn on two-step/i }));
    await waitFor(() => expect(client.auth.mfa.enroll).toHaveBeenCalled());
    expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: "stale" });
  });

  it("shows both the QR and a typed secret, so a member who cannot scan is not stuck", async () => {
    renderMfa(mfaClient());
    fireEvent.click(await screen.findByRole("button", { name: /turn on two-step/i }));
    expect(await screen.findByAltText(/qr code/i)).toBeInTheDocument();
    expect(screen.getByText("SECRET123")).toBeInTheDocument();
  });

  it("reports a verified factor as on", async () => {
    renderMfa(mfaClient({
      listFactors: vi.fn().mockResolvedValue({ data: { all: [{ id: "f1", factor_type: "totp", status: "verified" }], totp: [{ id: "f1", status: "verified" }] }, error: null }),
    }));
    expect(await screen.findByRole("button", { name: /turn off two-step/i })).toBeInTheDocument();
  });

  // A read failure must not render "off" — that invites a member to enable
  // something that is already on.
  it("does not claim MFA is off when the factor list cannot be read", async () => {
    const client = mfaClient({ listFactors: vi.fn().mockRejectedValue(new Error("offline")) });
    const { container } = renderMfa(client);
    await waitFor(() => expect(client.auth.mfa.listFactors).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".mfa-settings")).toBeTruthy());
  });

  it("keeps the member on the same screen when the code is wrong", async () => {
    const client = mfaClient({
      verify: vi.fn().mockResolvedValue({ error: { message: "Invalid TOTP code" } }),
    });
    renderMfa(client);
    fireEvent.click(await screen.findByRole("button", { name: /turn on two-step/i }));
    await screen.findByAltText(/qr code/i);
    fireEvent.change(screen.getByLabelText(/code from your app/i), { target: { value: "000000" } });
    fireEvent.submit(screen.getByRole("button", { name: /^verify$/i }).closest("form"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Still enrolling: the secret is on screen so no re-scan is needed.
    expect(screen.getByText("SECRET123")).toBeInTheDocument();
  });

  it("removes the half-made factor when enrolment is cancelled", async () => {
    const client = mfaClient();
    renderMfa(client);
    fireEvent.click(await screen.findByRole("button", { name: /turn on two-step/i }));
    await screen.findByAltText(/qr code/i);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: "f1" }));
  });
});

describe("sign-in challenge", () => {
  it("verifies against the member's verified factor and clears the gate", async () => {
    const onCleared = vi.fn();
    const client = {
      auth: {
        mfa: {
          listFactors: vi.fn().mockResolvedValue({ data: { all: [{ id: "f9", factor_type: "totp", status: "verified" }], totp: [{ id: "f9", status: "verified" }] }, error: null }),
          challenge: vi.fn().mockResolvedValue({ data: { id: "c9" }, error: null }),
          verify: vi.fn().mockResolvedValue({ error: null }),
        },
      },
    };
    render(<LanguageProvider lang="en"><MfaChallenge client={client} onCleared={onCleared} onSignOut={vi.fn()} /></LanguageProvider>);
    fireEvent.change(screen.getByLabelText(/code from your app/i), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("button", { name: /^verify$/i }).closest("form"));
    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(client.auth.mfa.verify).toHaveBeenCalledWith({ factorId: "f9", challengeId: "c9", code: "123456" });
  });

  it("always offers a way out, so a lost authenticator is not a locked door", () => {
    render(<LanguageProvider lang="en"><MfaChallenge client={{ auth: { mfa: {} } }} onCleared={vi.fn()} onSignOut={vi.fn()} /></LanguageProvider>);
    expect(screen.getByRole("button", { name: /sign out instead/i })).toBeInTheDocument();
  });

  // GoTrue's rate limit surfaced as a raw English message that told a locked
  // out member nothing. The lockout copy names the way out: the local office,
  // where an admin can reset two-step sign-in.
  it("tells a rate-limited member to contact their campaign administrator", async () => {
    const client = {
      auth: {
        mfa: {
          listFactors: vi.fn().mockResolvedValue({ data: { all: [{ id: "f9", factor_type: "totp", status: "verified" }], totp: [{ id: "f9", status: "verified" }] }, error: null }),
          challenge: vi.fn().mockResolvedValue({ data: { id: "c9" }, error: null }),
          verify: vi.fn().mockRejectedValue(Object.assign(new Error("over_request_rate_limit"), { status: 429 })),
        },
      },
    };
    render(<LanguageProvider lang="en"><MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} /></LanguageProvider>);
    fireEvent.change(screen.getByLabelText(/code from your app/i), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("button", { name: /^verify$/i }).closest("form"));
    expect(await screen.findByText(/contact your campaign administrator/i)).toBeInTheDocument();
  });
});

describe("recovery-code sign-in failure classification", () => {
  const rejected = catalogue.en["mfa.recoveryRejected"];
  const unavailable = catalogue.en["mfa.recoveryUnavailable"];
  const lockout = catalogue.en["mfa.tooManyAttempts"];

  function recoveryClient(overrides = {}) {
    return {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "aal1-token" } } }),
        signOut: vi.fn().mockResolvedValue({ error: null }),
        mfa: {},
        ...overrides,
      },
    };
  }

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn().mockResolvedValue(body),
    };
  }

  async function submitRecovery(client, onSignOut = vi.fn()) {
    render(
      <LanguageProvider lang="en">
        <MfaChallenge client={client} onCleared={vi.fn()} onSignOut={onSignOut} />
      </LanguageProvider>,
    );
    const input = screen.getByLabelText(/one-time recovery code/i);
    fireEvent.change(input, { target: { value: "PSG-1111-2222-3333-4444" } });
    fireEvent.submit(input.closest("form"));
    return onSignOut;
  }

  it("keeps the code-rejected copy for HTTP 400 code-not-accepted", async () => {
    fetch.mockResolvedValueOnce(jsonResponse(400, { error: "code-not-accepted" }));
    const client = recoveryClient();
    await submitRecovery(client);
    expect(await screen.findByRole("alert")).toHaveTextContent(rejected);
    expect(screen.queryByText(unavailable)).not.toBeInTheDocument();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    [502, { error: "recovery-unavailable" }],
    [502, { error: "partial-recovery" }],
    [503, { error: "not-configured" }],
    [401, { error: "unauthenticated" }],
    [403, { error: "untrusted-origin" }],
  ])("shows unavailable copy for HTTP %s %j, never the rejected sentence", async (status, body) => {
    fetch.mockResolvedValueOnce(jsonResponse(status, body));
    const client = recoveryClient();
    await submitRecovery(client);
    expect(await screen.findByRole("alert")).toHaveTextContent(unavailable);
    expect(screen.queryByText(rejected)).not.toBeInTheDocument();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("shows unavailable copy when fetch throws, never the rejected sentence", async () => {
    fetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const client = recoveryClient();
    await submitRecovery(client);
    expect(await screen.findByRole("alert")).toHaveTextContent(unavailable);
    expect(screen.queryByText(rejected)).not.toBeInTheDocument();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("shows the TOTP lockout copy for HTTP 429", async () => {
    fetch.mockResolvedValueOnce(jsonResponse(429, { error: "over_request_rate_limit" }));
    const client = recoveryClient();
    await submitRecovery(client);
    expect(await screen.findByRole("alert")).toHaveTextContent(lockout);
    expect(screen.queryByText(rejected)).not.toBeInTheDocument();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("shows the TOTP lockout copy for a 200 over_request_rate_limit body", async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { error: "over_request_rate_limit" }));
    const client = recoveryClient();
    await submitRecovery(client);
    expect(await screen.findByRole("alert")).toHaveTextContent(lockout);
    expect(screen.queryByText(rejected)).not.toBeInTheDocument();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("signs out locally and calls onSignOut after a successful recovery", async () => {
    fetch.mockResolvedValueOnce(jsonResponse(200, { recovered: true }));
    const client = recoveryClient();
    const onSignOut = vi.fn();
    await submitRecovery(client, onSignOut);
    await waitFor(() => expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" }));
    expect(client.auth.signOut).toHaveBeenCalledOnce();
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resolves the new unavailable key in both catalogues", () => {
    expect(catalogue.en["mfa.recoveryUnavailable"]).toBe(unavailable);
    expect(catalogue.es["mfa.recoveryUnavailable"]).toBeTruthy();
    expect(catalogue.es["mfa.recoveryUnavailable"]).not.toBe(catalogue.en["mfa.recoveryUnavailable"]);
    expect(catalogue.en["mfa.tooManyAttempts"]).toBe(lockout);
    expect(catalogue.es["mfa.tooManyAttempts"]).toBeTruthy();
  });
});

// SEC-UG-WEB-AUTH-PKCE-20260817. supabase-js defaults a browser client to
// the IMPLICIT flow, which hands the access and refresh tokens back in the URL
// fragment — address bar, tab-restore state, history entry, and anything on the
// origin that reads document.location. PKCE returns a single-use `?code=`
// redeemed against a verifier that never leaves this browser. These assertions
// read the flow off the CONSTRUCTED GoTrue client rather than the source, so
// deleting the option (which silently restores implicit) fails here.
describe("web auth flow", () => {
  function withLocation(hostname, run) {
    const previous = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...previous, hostname, search: "", pathname: "/m" },
    });
    return Promise.resolve()
      .then(run)
      .finally(() => {
        Object.defineProperty(window, "location", { configurable: true, value: previous });
      });
  }

  beforeEach(() => vi.resetModules());

  // Union Ground's live client exists only for the one project the build
  // pins (VITE_UNIONGROUND_SUPABASE_REF). The ref below is a test fixture,
  // not a provisioned project.
  it("pins PKCE, never implicit, for the live client on the SaaS surface", async () => {
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", "psgfixtureproject");
    vi.stubEnv("VITE_SUPABASE_URL", "https://psgfixtureproject.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixturekey0001");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
    try {
      await withLocation("localhost", async () => {
        const mod = await import("../src/lib/supabase.js");
        const client = mod.supabase;
        expect(client).not.toBeNull();
        // Live/demo isolation is unchanged by the flow switch: the surface
        // still resolves exactly one client and it is still the right one.
        expect(mod.sampleSupabase).toBeNull();
        expect(mod.appSupabase).toBe(client);
        expect(client.auth.flowType).toBe("pkce");
        expect(client.auth.flowType).not.toBe("implicit");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // No SAMPLE project is pinned (config/sample-backend.json), so the demo
  // surface builds no SAMPLE client and never falls back to a live one.
  it("builds no SAMPLE client on the demo surface while no SAMPLE project is pinned", async () => {
    vi.stubEnv("VITE_APP_SURFACE", "demo");
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", "psgfixtureproject");
    vi.stubEnv("VITE_SUPABASE_URL", "https://psgfixtureproject.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixturekey0001");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "https://psgfixturesample.supabase.co");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixturekey0002");
    try {
      await withLocation("localhost", async () => {
        const mod = await import("../src/lib/supabase.js");
        expect(mod.sampleSupabase).toBeNull();
        expect(mod.supabase).toBeNull();
        expect(mod.appSupabase).toBeNull();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("has no browser callback that depends on an implicit access-token hash", () => {
    const auth = readFileSync(resolve(process.cwd(), "src/components/AuthScreen.jsx"), "utf8");
    const app = readAppSource();
    const invite = readFileSync(resolve(process.cwd(), "src/views/InvitationAcceptView.jsx"), "utf8");
    for (const source of [auth, app, invite]) {
      expect(source).not.toMatch(/location\.hash[\s\S]{0,200}access_token/);
      expect(source).not.toMatch(/["'#]?access_token["']?\s*[:=]\s*(params|hash|fragment)/);
    }
    // No browser token bootstrap: the SAMPLE persona entry is signed in
    // server-side and adopts the session the endpoint returns, never a link,
    // a token hash or a URL fragment.
    expect(app).not.toMatch(/verifyOtp\(/);
    expect(app.match(/auth\.setSession\(/g)).toHaveLength(1);
    expect(app).toContain('client.auth.setSession({ access_token: String(accessToken || ""), refresh_token: String(refreshToken || "") })');
    // /invite reads its OWN fragment parameter, not a GoTrue token.
    expect(invite).toContain('params.has("invite")');
    // The public union catalog and its emailed claim confirmation were left
    // out of Union Ground, so that fragment-reading page is gone.
    expect(existsSync(resolve(process.cwd(), "src/views/OrganizationClaimConfirmView.jsx"))).toBe(false);
    expect(app).not.toContain("OrganizationClaimConfirmView");
  });
});

describe("App wiring and locale parity", () => {
  const app = readAppSource().replace(/\r\n/g, "\n");

  // The standalone routes are a table now, not inline
  // `["/x", "/x/"].includes(pathname)` checks, so pin the table and the
  // trailing-slash-tolerant lookup instead of one route's literal. They stay
  // OFF pathViews on purpose: pathViews defaults to "today", which would put a
  // signed-out visitor following a receipt link on the sign-in screen instead.
  it("routes the pre-auth pages before the member shell", () => {
    const standaloneTable = app.match(/const standaloneViews = \{([\s\S]*?)\n\};/)?.[1]
      .trim()
      .split("\n")
      .map((line) => line.trim())
      // The table's own explanatory comments are not routes.
      .filter((line) => !line.startsWith("//"));
    expect(standaloneTable).toEqual([
      // Union Ground's public front door is the Learn page; workers enter at /m.
      '"/": LearnView,',
      '"/learn": LearnView,',
      '"/connect": ConnectView,',
      // Retired legacy addresses render an explanation rather than a 404.
      '"/contractsurvey": RetiredLegacyView,',
      '"/design": RetiredLegacyView,',
      '"/invite": InvitationAcceptView,',
      '[EMAIL_AUTH_PATHS.invitation]: InvitationAcceptView,',
      '"/signup": OpenSignupRoute,',
      '"/signup/confirm": OpenSignupConfirmRoute,',
      '"/reset-password": PasswordResetView,',
      '[EMAIL_AUTH_PATHS.passwordReset]: PasswordResetView,',
      '"/get-app": GetAppView,',
      '"/request-invite": RequestInviteView,',
      // The emailed single-use stop confirmation is a pre-auth fragment-only page.
      '"/stop-updates": PublicInterestStopConfirmView,',
      // The ballot-receipt check. There is no membership-card verifier.
      '"/verify": VerifyReceiptView,',
      '"/subprocessors": SubprocessorRegisterView,',
      '"/telemetry": TelemetryDisclosureView,',
      '"/privacy": PrivacyView,',
      '"/terms": TermsView,',
      '"/accessibility": AccessibilityView,',
      '"/about": AboutView,',
      '"/contact": ContactView,',
      // Who runs this server: every copy names its operator.
      '"/operator": OperatorView,',
      '"/ai-disclosure": AiDisclosureView,',
      '"/retention": RetentionView,',
      '"/privacy/deletion-request": DeletionRequestView,',
      // The formal statement is a public document route behind the
      // accessibility summary.
      '"/accessibility/statement": AccessibilityStatementView,',
      // The operative-instrument route behind each legal summary and the
      // public version history are pre-auth pages for the same reason the
      // summaries are. They are registered from src/lib/legalInstruments.js,
      // so the table ends in two computed lines; the paths themselves are
      // pinned against that source in tests/site-discovery.test.js.
      "[LEGAL_CHANGELOG_PATH]: LegalChangelogRoute,",
      "...legalInstrumentRoutes,",
    ]);
    // The public union catalog, its claim confirmation and the public chapter
    // directory were left out of Union Ground: none is a pre-auth route.
    expect(app).not.toContain('"/unions"');
    expect(app).not.toContain('"/unions/claim/confirm"');
    for (const removed of ["FindYourUnionView", "OrganizationClaimConfirmView", "PublicLanding", "OrganizationLandingView"]) {
      expect(app).not.toMatch(new RegExp(`import[^;]*\\b${removed}\\b|<${removed}\\b|${removed}\\.jsx`));
    }
    expect(app).toContain('"/invite": InvitationAcceptView');
    expect(app).toContain('"/verify": VerifyReceiptView');
    // /contractsurvey died with the sub-app's removal: it may only resolve to
    // the retirement explanation, never to a live view.
    expect(app.match(/contractsurvey/g)).toHaveLength(1);
    // A sign-out resuming at "/" shows no standalone page; every other path
    // resolves its standalone view from the address.
    expect(app).toContain('const Standalone = resumingSignOut && normalizeAppPath(pathname) === "/" ? null : standaloneViewFromPath();');
    // The trailing-slash form must resolve to the same view.
    expect(app).toContain('window.location.pathname.replace(/\\/+$/, "")');
    // /reset died with the password path: a stale emailed reset link now lands
    // on the magic-link sign-in screen, which is the correct destination.
    expect(app).not.toContain("ResetPasswordView");
  });

  it("holds the shell closed while a second factor is owed", () => {
    expect(app).toContain("if (mfaRequired) {");
    // The assurance-level conjunction, kept. I removed it once, on the theory
    // that scoping the predicate to TOTP had broken the literal — it had not,
    // and an adversarial review showed the removal cost real coverage: with only
    // the two terms pinned SEPARATELY elsewhere, rewriting them as `||` passed
    // everything while re-challenging every TOTP member forever.
    //
    // The factor-type scope this pairs with is asserted in
    // tests/mfa-boundary.test.jsx, next to the migration it has to agree with,
    // and as a behavioural truth table rather than only as text.
    expect(app).toContain('assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2"');
  });

  it("keeps account security live for SAMPLE and disables it only for fixture demo", () => {
    expect(app).toContain("authClient={fixtureDemo ? null : sessionAccountClient}");
    expect(app).toContain("sessionDemo={fixtureDemo}");
  });

  it("translates every new key in both locales", () => {
    const added = Object.keys(catalogue.en).filter((k) => /^(mfa\.|auth\.magicLink)/.test(k));
    expect(added.length).toBeGreaterThan(20);
    for (const key of added) {
      expect(catalogue.es[key], `missing es for ${key}`).toBeTruthy();
      expect(catalogue.es[key]).not.toBe(catalogue.en[key]);
    }
  });
});
