import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { MfaChallenge, MfaSettings } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const PASSKEY = {
  id: "passkey-1",
  friendly_name: "Work laptop",
  created_at: "2026-08-28T12:00:00.000Z",
};

function renderEnglish(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

function authClient(overrides = {}) {
  return {
    auth: {
      setSession: vi.fn().mockResolvedValue({ error: null }),
      signInWithPasskey: vi.fn().mockResolvedValue({ error: null }),
      ...overrides,
    },
  };
}

function securityClient(overrides = {}) {
  const passkey = {
    list: vi.fn().mockResolvedValue({ data: [PASSKEY], error: null }),
    update: vi.fn().mockResolvedValue({ data: PASSKEY, error: null }),
    delete: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides.passkey,
  };
  const mfa = {
    listFactors: vi.fn().mockResolvedValue({
      data: { all: [{ id: "totp-1", factor_type: "totp", status: "verified" }] },
      error: null,
    }),
    ...overrides.mfa,
  };
  const rpc = overrides.rpc ?? vi.fn(async (name) => {
    if (name === "get_mfa_recovery_code_status") {
      return { data: { generation: 1, unusedCount: 6, usedCount: 2 }, error: null };
    }
    if (name === "generate_mfa_recovery_codes") {
      return { data: { generation: 2, codes: ["RC-1111-2222-3333-4444", "RC-AAAA-BBBB-CCCC-DDDD"] }, error: null };
    }
    throw new Error(`unexpected RPC ${name}`);
  });
  return {
    auth: {
      mfa,
      passkey,
      registerPasskey: overrides.registerPasskey ?? vi.fn().mockResolvedValue({ data: PASSKEY, error: null }),
      getSession: overrides.getSession ?? vi.fn().mockResolvedValue({ data: { session: { access_token: "aal1-token" } } }),
      signOut: overrides.signOut ?? vi.fn().mockResolvedValue({ error: null }),
    },
    rpc,
  };
}

let secureContextDescriptor;
let credentialDescriptor;
let clipboardDescriptor;

beforeEach(() => {
  secureContextDescriptor = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  credentialDescriptor = Object.getOwnPropertyDescriptor(window, "PublicKeyCredential");
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: class PublicKeyCredential {} });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (secureContextDescriptor) Object.defineProperty(window, "isSecureContext", secureContextDescriptor);
  else delete window.isSecureContext;
  if (credentialDescriptor) Object.defineProperty(window, "PublicKeyCredential", credentialDescriptor);
  else delete window.PublicKeyCredential;
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else delete navigator.clipboard;
});

// Union Ground left out passkey, security-key, SSO and store-account sign-in:
// the provisioned email and password is the only way in.
describe("password-only sign-in", () => {
  it("offers no passkey, security-key, SSO, store-account or PIN sign-in", () => {
    const client = authClient();
    renderEnglish(<AuthScreen client={client} />);
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    for (const name of [/passkey/i, /security key/i, /single sign-on|\bSSO\b/i, /apple|google|microsoft/i, /\bPIN\b/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(client.auth.signInWithPasskey).not.toHaveBeenCalled();
  });

  it("treats an unusable proxy payload or session as the same neutral failure, not a refused password", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error("invalid json")) });
    const client = authClient();
    const { container, unmount } = renderEnglish(<AuthScreen client={client} />);
    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Union Ground");
    unmount();

    fetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ accessToken: "access", refreshToken: "refresh" }),
    });
    const sessionRejected = authClient({ setSession: vi.fn().mockResolvedValue({ error: new Error("session detail") }) });
    const second = renderEnglish(<AuthScreen client={sessionRejected} />);
    fireEvent.change(second.container.querySelector('input[name="email"]'), { target: { value: "member@example.com" } });
    fireEvent.change(second.container.querySelector('input[name="password"]'), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.submit(second.container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Union Ground");
  });
});

describe("recovery-code settings", () => {
  it("offers no passkey management and never asks the provider for passkeys", async () => {
    const client = securityClient();
    renderEnglish(<MfaSettings client={client} />);
    await screen.findByText("Recovery codes");
    expect(screen.queryByText("Work laptop")).toBeNull();
    for (const name of [/passkey/i, /security key/i, "Rename"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(client.auth.passkey.list).not.toHaveBeenCalled();
    expect(client.auth.registerPasskey).not.toHaveBeenCalled();
  });

  it("runs rotate, copy, and one-time dismissal workflows", async () => {
    const client = securityClient();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderEnglish(<MfaSettings client={client} />);

    const recoverySection = (await screen.findByText("Recovery codes")).closest("section");
    fireEvent.click(await within(recoverySection).findByRole("button", { name: "Replace recovery codes" }));
    expect(await within(recoverySection).findByText("RC-1111-2222-3333-4444")).toBeInTheDocument();
    fireEvent.click(within(recoverySection).getByRole("button", { name: "Copy codes" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "RC-1111-2222-3333-4444\nRC-AAAA-BBBB-CCCC-DDDD",
    ));
    expect(await screen.findByText("Recovery codes copied.")).toBeInTheDocument();
    fireEvent.click(within(recoverySection).getByRole("button", { name: "I saved them" }));
    expect(within(recoverySection).queryByText("RC-1111-2222-3333-4444")).toBeNull();
  });

  it("reports a bounded generation failure and honors a cancelled rotation", async () => {
    const client = securityClient({
      rpc: vi.fn(async (name) => {
        if (name === "get_mfa_recovery_code_status") return { data: { generation: 1, unusedCount: 4 }, error: null };
        return { data: { generation: 2, codes: null }, error: null };
      }),
    });
    const confirm = vi.spyOn(window, "confirm");
    renderEnglish(<MfaSettings client={client} />);

    const recoverySection = (await screen.findByText("Recovery codes")).closest("section");
    const rotate = await within(recoverySection).findByRole("button", { name: "Replace recovery codes" });
    confirm.mockReturnValueOnce(false);
    fireEvent.click(rotate);
    expect(client.rpc).not.toHaveBeenCalledWith("generate_mfa_recovery_codes");
    confirm.mockReturnValueOnce(true);
    fireEvent.click(rotate);
    expect(await screen.findByText(
      "Recovery codes could not be generated. Verify two-step sign-in and try again.",
      {},
      { timeout: 8_000 },
    )).toBeInTheDocument();
  });

  it("explains when the organization turned recovery-code enrollment off", async () => {
    const client = securityClient({
      mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [] }, error: null }) },
    });
    renderEnglish(<MfaSettings client={client} recoveryCodeEnrollmentEnabled={false} />);
    expect(await screen.findByText(/recovery code enrollment is turned off/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate recovery codes" })).toBeDisabled();
  });

  it("shows clipboard failure without discarding newly generated codes", async () => {
    navigator.clipboard.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    const client = securityClient();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderEnglish(<MfaSettings client={client} />);
    const recoverySection = (await screen.findByText("Recovery codes")).closest("section");
    fireEvent.click(await within(recoverySection).findByRole("button", { name: "Replace recovery codes" }));
    await within(recoverySection).findByText("RC-1111-2222-3333-4444");
    fireEvent.click(within(recoverySection).getByRole("button", { name: "Copy codes" }));
    expect(await screen.findByText(/Could not copy automatically/i)).toBeInTheDocument();
    expect(within(recoverySection).getByText("RC-1111-2222-3333-4444")).toBeInTheDocument();
  });
});

describe("MFA recovery challenge", () => {
  function renderChallenge(client, onSignOut = vi.fn()) {
    renderEnglish(<MfaChallenge client={client} onCleared={vi.fn()} onSignOut={onSignOut} />);
    const input = screen.getByLabelText("One-time recovery code");
    fireEvent.change(input, { target: { value: "RC-1111-2222-3333-4444" } });
    fireEvent.submit(input.closest("form"));
    return onSignOut;
  }

  it("sends the AAL1 bearer token, signs out locally, and returns to authentication", async () => {
    fetch.mockResolvedValueOnce({ ok: true });
    const client = securityClient();
    const onSignOut = renderChallenge(client);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/mfa-recovery", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer aal1-token" }),
      body: JSON.stringify({ code: "RC-1111-2222-3333-4444" }),
    })));
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("keeps missing-session and server rejection details generic", async () => {
    const missing = securityClient({ getSession: vi.fn().mockResolvedValue({ data: { session: null } }) });
    const { unmount } = renderEnglish(<MfaChallenge client={missing} onCleared={vi.fn()} onSignOut={vi.fn()} />);
    let input = screen.getByLabelText("One-time recovery code");
    fireEvent.change(input, { target: { value: "RC-1111-2222-3333-4444" } });
    fireEvent.submit(input.closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be completed");
    expect(fetch).not.toHaveBeenCalled();
    unmount();

    fetch.mockResolvedValueOnce({ ok: false, status: 502 });
    const rejected = securityClient();
    renderChallenge(rejected);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be completed");
    expect(rejected.auth.signOut).not.toHaveBeenCalled();
  });

  // A worker whose authenticator code was merely rejected used a recovery code and
  // lost the authenticator. The way in says it is for a lost authenticator, the
  // press names what it does, and the trade-off is read before the code is used.
  it("says before use that a recovery code is for a lost authenticator and removes it", () => {
    renderEnglish(<MfaChallenge client={securityClient()} onCleared={vi.fn()} onSignOut={vi.fn()} />);
    const disclosure = screen.getByText("Lost your authenticator? Use a recovery code").closest("details");
    expect(within(disclosure).getByText(/Only for a lost authenticator\. A recovery code removes your current authenticator and signs out every session\./)).toBeInTheDocument();
    expect(within(disclosure).getByText(/try the newest code first/)).toBeInTheDocument();
    const press = within(disclosure).getByRole("button", { name: "Remove my authenticator and sign in" });
    const blurb = within(disclosure).getByText(/Only for a lost authenticator/);
    expect(blurb.compareDocumentPosition(press) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
