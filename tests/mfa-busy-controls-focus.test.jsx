// Record 8435 (BUG-UG-BUSY-CONTROLS-DROP-FOCUS-ACROSS-THE-APP-20261112):
// the two-step sign-in challenge, the passkey and recovery code panel and the
// two-step factor screen keep each control that starts a request focusable
// while the request runs. The control reads pending (aria-disabled), refuses
// another activation, and its write takes a synchronous lock. Every test turns
// the browser's focus fixup on through tests/helpers/busyWriteFocus.js.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaChallenge, MfaSettings } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const verified = (id) => ({ id, factor_type: "totp", status: "verified" });

function mfaClient({ factors = [], ...overrides } = {}) {
  let current = factors;
  return {
    auth: {
      mfa: {
        listFactors: vi.fn(async () => ({ data: { all: current, totp: current }, error: null })),
        enroll: vi.fn(async () => ({ data: { id: "f-new", totp: { qr_code: "", secret: "SETUP-SECRET" } }, error: null })),
        challenge: vi.fn(async () => ({ data: { id: "c1" }, error: null })),
        verify: vi.fn(async () => ({ error: null })),
        unenroll: vi.fn(async ({ factorId }) => { current = current.filter((factor) => factor.id !== factorId); return { error: null }; }),
        ...overrides,
      },
    },
  };
}

const show = (ui) => render(<LanguageProvider lang="en">{ui}</LanguageProvider>);
let secureContext;

beforeEach(() => {
  secureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (secureContext) Object.defineProperty(window, "isSecureContext", secureContext);
  else delete window.isSecureContext;
});

describe("the two-step sign-in challenge", () => {
  it("keeps Verify focused while the code is checked, and Sign out instead refuses until it settles", async () => {
    const client = mfaClient({ factors: [verified("f1")] });
    client.auth.signOut = vi.fn(async () => ({ error: null }));
    const onSignOut = vi.fn();
    const onCleared = vi.fn();
    show(<MfaChallenge client={client} onCleared={onCleared} onSignOut={onSignOut} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Code from your app" }), { target: { value: "123456" } });
    const verify = screen.getByRole("button", { name: "Verify" });
    const signOut = screen.getByRole("button", { name: "Sign out instead" });
    await expectHeldWriteFocus(client.auth.mfa.listFactors, verify, () => {
      fireEvent.click(verify);
      if (client.auth.mfa.listFactors.mock.calls.length === 1) {
        // The aal2 write-back race (MfaSettings.jsx): sign-out must not run
        // while a verification is in flight.
        expect(signOut).toHaveAttribute("aria-disabled", "true");
        expect(signOut).toBeEnabled();
        fireEvent.click(signOut);
        fireEvent.keyDown(signOut, { key: "Enter" });
        expect(onSignOut).not.toHaveBeenCalled();
      }
    });
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(onSignOut).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("checks a code once when it is submitted twice in one tick", async () => {
    const client = mfaClient({ factors: [verified("f1")] });
    const { container } = show(<MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Code from your app" }), { target: { value: "123456" } });
    const form = container.querySelector("form");
    await expectOneWriteFromOneTick(client.auth.mfa.listFactors, [() => fireEvent.submit(form), () => fireEvent.submit(form)]);
  });

  it("keeps the recovery button focused while the recovery request runs", async () => {
    const client = mfaClient({ factors: [verified("f1")] });
    client.auth.getSession = vi.fn(async () => ({ data: { session: { access_token: "fixture-access" } } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "code-not-accepted" }), { status: 400 })));
    const { container } = show(<MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} />);
    container.querySelector("details").open = true;
    fireEvent.change(container.querySelector('input[name="recoveryCode"]'), { target: { value: "ABCD-EFGH-IJKL-MNOP" } });
    const recover = screen.getByRole("button", { name: "Remove my authenticator and sign in" });
    await expectHeldWriteFocus(client.auth.getSession, recover);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("passkeys and recovery codes on Security", () => {
  function extensionClient(overrides = {}) {
    const client = mfaClient({ factors: [verified("f1")] });
    client.auth.passkey = {
      list: vi.fn(async () => ({ data: [{ id: "pk-1", friendly_name: "Work laptop", created_at: "2026-11-01T12:00:00Z" }], error: null })),
      update: vi.fn(async () => ({ error: null })),
      delete: vi.fn(async () => ({ error: null })),
    };
    client.auth.registerPasskey = vi.fn(async () => ({ error: null }));
    client.rpc = vi.fn(async (name) => (name === "generate_mfa_recovery_codes"
      ? { data: { generation: 1, codes: ["code-one", "code-two"] }, error: null }
      : { data: { generation: 0, unusedCount: 0, usedCount: 0 }, error: null }));
    return Object.assign(client, overrides);
  }

  // The two passkey cases are cut: this edition leaves out passkey sign-in,
  // so the panel offers only recovery codes.

  it("keeps Generate recovery codes focused while the codes are made", async () => {
    const client = extensionClient();
    show(<MfaSettings client={client} />);
    const generate = await screen.findByRole("button", { name: "Generate recovery codes" });
    await waitFor(() => expect(generate).toBeEnabled());
    const before = client.rpc.mock.calls.length;
    await expectHeldWriteFocus(client.rpc, generate);
    expect(client.rpc.mock.calls.slice(before).map(([name]) => name)).toEqual(["generate_mfa_recovery_codes"]);
  });
});

describe("the two-step factor screen", () => {
  it("keeps Turn on two-step sign-in focused while the factor is created", async () => {
    const client = mfaClient();
    show(<MfaSettings client={client} />);
    const enable = await screen.findByRole("button", { name: "Turn on two-step sign-in" });
    await expectHeldWriteFocus(client.auth.mfa.enroll, enable);
    expect(client.auth.mfa.enroll).toHaveBeenCalledTimes(1);
  });

  it("keeps the setup Verify focused, with Cancel and Start over held, while the code is checked", async () => {
    const client = mfaClient();
    show(<MfaSettings client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on two-step sign-in" }));
    const form = await screen.findByRole("form", { name: "Turn on two-step sign-in" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Code from your app" }), { target: { value: "123456" } });
    const verify = within(form).getByRole("button", { name: "Verify" });
    const cancel = within(form).getByRole("button", { name: "Cancel" });
    const restart = within(form).getByRole("button", { name: "Start over with a new QR" });
    await expectHeldWriteFocus(client.auth.mfa.challenge, verify, () => {
      fireEvent.click(verify);
      if (client.auth.mfa.challenge.mock.calls.length === 1) {
        expect(cancel).toHaveAttribute("aria-disabled", "true");
        expect(restart).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(cancel);
        fireEvent.click(restart);
        expect(client.auth.mfa.unenroll).not.toHaveBeenCalled();
        expect(client.auth.mfa.enroll).toHaveBeenCalledTimes(1);
      }
    });
    expect(client.auth.mfa.verify).toHaveBeenCalledExactlyOnceWith({ factorId: "f-new", challengeId: "c1", code: "123456" });
  });

  it("keeps Turn it off focused, with Keep it on held, while the factors are removed", async () => {
    const client = mfaClient({ factors: [verified("f1")] });
    show(<MfaSettings client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    const group = screen.getByRole("group", { name: "Turn off two-step sign-in?" });
    const go = within(group).getByRole("button", { name: "Turn it off" });
    const keep = within(group).getByRole("button", { name: "Keep it on" });
    await expectHeldWriteFocus(client.auth.mfa.unenroll, go, () => {
      fireEvent.click(go);
      if (client.auth.mfa.unenroll.mock.calls.length === 1) {
        expect(keep).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(keep);
        expect(screen.getByRole("group", { name: "Turn off two-step sign-in?" })).toBeInTheDocument();
      }
    });
    await act(async () => {});
    expect(client.auth.mfa.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: "f1" });
  });
});
