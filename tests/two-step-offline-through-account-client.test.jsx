// #9461 (gate r1s2 on #9479): two-step through the real account client. Its
// session seed passes GoTrue's no-answer error on, not "account changed".
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaChallenge, MfaSettings } from "../src/components/MfaSettings.jsx";
import { createAccountSessionClient } from "../src/lib/accountSessionClient.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { createSessionBoundWriter } from "../src/lib/sessionBoundWriter.js";

const { en } = catalogue;

describe("two-step through the production account client (r1s2)", () => {
  const A = "7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59";
  const encode = (value) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const aToken = `${encode({ alg: "HS256" })}.${encode({ sub: A, session_id: A, exp: 9999999999, role: "authenticated" })}.sig0`;
  const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  let mod, offline;
  beforeEach(async () => {
    vi.resetModules(); localStorage.clear(); offline = false;
    vi.stubGlobal("crypto", webcrypto);
    vi.stubEnv("VITE_APP_SURFACE", "saas");
    vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_localtestkey0123");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", ""); vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubGlobal("fetch", async (input, init) => {
      if (offline) throw new TypeError("Failed to fetch");
      const url = new URL(String(input));
      if (url.pathname.endsWith("/user")) return json({ id: A, aud: "authenticated", role: "authenticated", factors: [] });
      if (url.pathname.endsWith("/factors") && init?.method === "POST") {
        return json({ id: "n1", type: "totp", friendly_name: "", totp: { qr_code: "<svg/>", secret: "SECRET-N1", uri: "otpauth://totp/x" } });
      }
      throw new Error(`Unexpected test transport ${url.pathname}`);
    });
    mod = await import("../src/lib/supabase.js");
    expect((await mod.appSupabase.auth.setSession({ access_token: aToken, refresh_token: "a" })).error).toBeNull();
  });
  afterEach(async () => {
    cleanup();
    await mod?.appSupabase?.auth.dispose();
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear();
  });
  async function account() {
    const session = (await mod.appSupabase.auth.getSession()).data.session;
    const writer = createSessionBoundWriter({ session, sharedClient: mod.appSupabase, createSessionClient: (current) => mod.createCapturedAppSessionRpcClient(current, { boundedTransport: true }) });
    return createAccountSessionClient({ writer, session, sharedClient: mod.appSupabase, createAccountClient: mod.createCapturedAppAccountClient, clearCapturedSession: mod.clearCapturedAppSessionLocally });
  }
  const wrap = (ui) => render(<LanguageProvider lang="en">{ui}</LanguageProvider>);

  it("passes GoTrue's no-answer error on from the session seed, and keeps the refusal for anything else", async () => {
    const session = (await mod.appSupabase.auth.getSession()).data.session;
    offline = true;
    await expect(mod.createCapturedAppAccountClient(session)).rejects.toMatchObject({ name: "AuthRetryableFetchError", status: 0 });
    offline = false;
    await expect(mod.createCapturedAppAccountClient({ ...session, user: { ...session.user, id: "someone-else" } })).rejects.toThrow("account changed");
  });

  it("sign-in: a lost connection says to check it, not that the code was rejected", async () => {
    const auth = await account();
    offline = true;
    const { container } = wrap(<MfaChallenge client={{ auth }} onCleared={vi.fn()} onSignOut={vi.fn()} />);
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent(en["auth.passwordUnreachable"]);
    expect(screen.queryByText(en["mfa.codeRejected"])).toBeNull();
  });

  it("Settings: a lost connection on Verify says to check it, not that the code was rejected", async () => {
    const auth = await account();
    wrap(<MfaSettings client={{ auth, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }} />);
    fireEvent.click(await screen.findByRole("button", { name: en["mfa.enable"] }));
    await screen.findByText("SECRET-N1");
    offline = true;
    fireEvent.change(screen.getByLabelText(en["mfa.codeLabel"]), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: en["mfa.verify"] }));
    expect(await screen.findByText(en["auth.passwordUnreachable"])).toBeInTheDocument();
    expect(screen.queryByText(en["mfa.codeRejected"])).toBeNull();
  });
});
