// #9461: no answer at sign-in or reset is the connection, not a refusal.
import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MfaChallenge } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";

const { en, es } = catalogue;
const offline = () => new TypeError("Failed to fetch");
const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
const field = (container, name) => container.querySelector(`input[name="${name}"]`);
const type = (container, name, value) => fireEvent.change(field(container, name), { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("W1-4 sign-in", () => {
  // PIN sign-in is not in this edition (no PIN route or control), so its case is cut.
  it("two-step: an answered 5xx keeps the code line", async () => {
    const mfa = { listFactors: vi.fn().mockResolvedValue({ data: { all: [{ id: "f1", factor_type: "totp", status: "verified" }] }, error: null }),
      challenge: vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null }),
      verify: vi.fn().mockResolvedValue({ error: new AuthRetryableFetchError("Internal error", 500) }) };
    const { container } = wrap(<MfaChallenge client={{ auth: { mfa } }} onCleared={vi.fn()} onSignOut={vi.fn()} />, "es");
    type(container, "code", "123456");
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent(es["mfa.codeRejected"]);
  });
});

describe("W1-3 reset", () => {
  it("asking for a link: the connection line", async () => {
    const { container } = wrap(<PasswordResetView fetcher={vi.fn().mockRejectedValue(offline())} readToken={() => null} />, "es");
    type(container, "email", "member@example.com");
    fireEvent.submit(container.querySelector("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent(es["auth.passwordUnreachable"]);
  });

  it("emailed link with no answer: connection heading, new-link wording", async () => {
    wrap(<PasswordResetView fetcher={vi.fn().mockRejectedValue(offline())} readToken={() => "ticket-offline"} />);
    expect(await screen.findByRole("heading", { name: en["reset.linkOfflineTitle"] })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(en["reset.linkOfflineBody"]);
    expect(screen.queryByText(en["reset.linkFailedTitle"])).toBeNull();
  });
});
