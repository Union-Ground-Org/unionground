import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MfaSettings } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// BUG-UG-TWO-STEP-SETUP-SECRET-REPLACED-AFTER-SCAN-20261103: a
// remount or factor re-read during setup showed "Off", and the next "Turn on"
// deleted the factor whose QR the member had already scanned, so no code from
// their app could ever verify.

const en = catalogue.en;

// A small stand-in for GoTrue's factor list: enroll() hands out a secret once,
// verify() accepts only a code made from the factor's own secret.
function factorBackend(prefix, seed = []) {
  let next = 0;
  const factors = seed.map((factor) => ({ factor_type: "totp", ...factor }));
  const mfa = {
    listFactors: vi.fn(async () => ({ data: { all: factors.map((factor) => ({ ...factor })) }, error: null })),
    enroll: vi.fn(async () => {
      next += 1;
      const factor = { id: `${prefix}-${next}`, factor_type: "totp", status: "unverified", secret: `SECRET-${prefix}-${next}` };
      factors.push(factor);
      return { data: { id: factor.id, totp: { qr_code: `data:image/svg+xml,${factor.id}`, secret: factor.secret } }, error: null };
    }),
    unenroll: vi.fn(async ({ factorId }) => {
      const at = factors.findIndex((factor) => factor.id === factorId);
      if (at >= 0) factors.splice(at, 1);
      return { error: null };
    }),
    challenge: vi.fn(async ({ factorId }) => ({ data: { id: `challenge-${factorId}` }, error: null })),
    verify: vi.fn(async ({ factorId, code }) => {
      const factor = factors.find((entry) => entry.id === factorId);
      if (!factor || code !== codeFor(factor.secret)) return { error: { message: "Invalid TOTP code entered" } };
      factor.status = "verified";
      return { error: null };
    }),
  };
  const client = () => ({ auth: { mfa }, rpc: vi.fn(async () => ({ data: null, error: null })) });
  return { mfa, client, factors };
}

const codeFor = (secret) => String([...secret].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 1_000_000).padStart(6, "0");

function view(client) {
  return <LanguageProvider lang="en"><MfaSettings client={client} /></LanguageProvider>;
}

async function turnOn() {
  fireEvent.click(await screen.findByRole("button", { name: en["mfa.enable"] }));
}

async function verifyWith(code) {
  fireEvent.change(screen.getByLabelText(en["mfa.codeLabel"]), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: en["mfa.verify"] }));
}

describe("two-step setup keeps the QR the member scanned", () => {
  it("resumes the same QR after a remount, and a code from it verifies", async () => {
    const backend = factorBackend("remount");
    const first = render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-remount-1")).toBeInTheDocument();
    // The authenticator app names the entry from this issuer.
    expect(backend.mfa.enroll).toHaveBeenCalledWith({ factorType: "totp", issuer: "Union Ground" });
    // The member scans now. The card then remounts (the step-up prompt and
    // back, or the shell re-rendering behind "Loading Union Ground...").
    first.unmount();
    render(view(backend.client()));

    expect(await screen.findByText("SECRET-remount-1")).toBeInTheDocument();
    expect(screen.getByAltText(en["mfa.qrAlt"])).toHaveAttribute("src", "data:image/svg+xml,remount-1");
    expect(screen.getByText(en["mfa.settingUpSub"])).toBeInTheDocument();
    expect(screen.queryByText(en["mfa.offSub"])).toBeNull();
    expect(screen.queryByRole("button", { name: en["mfa.enable"] })).toBeNull();

    await verifyWith(codeFor("SECRET-remount-1"));
    expect(await screen.findByText(en["mfa.onSub"])).toBeInTheDocument();
    expect(backend.mfa.enroll).toHaveBeenCalledTimes(1);
    expect(backend.mfa.unenroll).not.toHaveBeenCalled();
    expect(backend.factors).toEqual([expect.objectContaining({ id: "remount-1", status: "verified" })]);
  });

  it("resumes the same QR when the factor list is read again, and a code from it verifies", async () => {
    const backend = factorBackend("reread");
    const { rerender } = render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-reread-1")).toBeInTheDocument();
    // A new client object re-runs refresh() with the setup panel open.
    const reads = backend.mfa.listFactors.mock.calls.length;
    rerender(view(backend.client()));
    await waitFor(() => expect(backend.mfa.listFactors.mock.calls.length).toBeGreaterThan(reads));

    expect(await screen.findByText("SECRET-reread-1")).toBeInTheDocument();
    expect(screen.queryByText(en["mfa.offSub"])).toBeNull();
    await verifyWith(codeFor("SECRET-reread-1"));
    expect(await screen.findByText(en["mfa.onSub"])).toBeInTheDocument();
    expect(backend.mfa.enroll).toHaveBeenCalledTimes(1);
    expect(backend.mfa.unenroll).not.toHaveBeenCalled();
  });

  it("makes one factor when Turn on is clicked twice", async () => {
    const backend = factorBackend("double");
    render(view(backend.client()));
    const button = await screen.findByRole("button", { name: en["mfa.enable"] });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText("SECRET-double-1")).toBeInTheDocument();
    expect(backend.mfa.enroll).toHaveBeenCalledTimes(1);
    expect(backend.factors).toHaveLength(1);
  });

  it("replaces the QR only through Start over, which says the old entry stops working", async () => {
    const backend = factorBackend("restart");
    render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-restart-1")).toBeInTheDocument();
    expect(screen.getByText(en["mfa.restartWarning"])).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en["mfa.restart"] }));
    expect(await screen.findByText("SECRET-restart-2")).toBeInTheDocument();
    expect(backend.mfa.unenroll).toHaveBeenCalledWith({ factorId: "restart-1" });
    expect(backend.factors.map((factor) => factor.id)).toEqual(["restart-2"]);

    await verifyWith(codeFor("SECRET-restart-1"));
    expect(await screen.findByText(en["mfa.codeRejected"])).toBeInTheDocument();
    await verifyWith(codeFor("SECRET-restart-2"));
    expect(await screen.findByText(en["mfa.onSub"])).toBeInTheDocument();
  });

  it("warns about, then cleans up, an abandoned factor from an earlier visit", async () => {
    // Its QR was shown on an earlier page load and cannot be shown again.
    const backend = factorBackend("earlier", [{ id: "earlier-abandoned", status: "unverified", secret: "SECRET-gone" }]);
    render(view(backend.client()));

    // Told before anything is replaced.
    expect(await screen.findByText(en["mfa.earlierSetupReplaced"])).toBeInTheDocument();
    expect(screen.getByText(en["mfa.offSub"])).toBeInTheDocument();
    expect(backend.mfa.unenroll).not.toHaveBeenCalled();
    expect(backend.mfa.enroll).not.toHaveBeenCalled();

    await turnOn();
    expect(await screen.findByText("SECRET-earlier-1")).toBeInTheDocument();
    // The leftover still goes, so abandoned attempts never fill the 10-factor cap.
    expect(backend.mfa.unenroll).toHaveBeenCalledWith({ factorId: "earlier-abandoned" });
    expect(backend.factors.map((factor) => factor.id)).toEqual(["earlier-1"]);
    expect(screen.queryByText(en["mfa.earlierSetupReplaced"])).toBeNull();
  });

  it("forgets a cancelled setup, so a later visit starts fresh", async () => {
    const backend = factorBackend("cancel");
    const first = render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-cancel-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["mfa.cancel"] }));
    expect(await screen.findByRole("button", { name: en["mfa.enable"] })).toBeInTheDocument();
    expect(backend.factors).toEqual([]);
    first.unmount();

    render(view(backend.client()));
    expect(await screen.findByRole("button", { name: en["mfa.enable"] })).toBeInTheDocument();
    expect(screen.queryByText("SECRET-cancel-1")).toBeNull();
    expect(screen.queryByText(en["mfa.earlierSetupReplaced"])).toBeNull();
  });

  it("starts over from a resumed setup, removing the factor the member saw", async () => {
    const backend = factorBackend("resumed");
    const first = render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-resumed-1")).toBeInTheDocument();
    first.unmount();
    render(view(backend.client()));
    expect(await screen.findByText("SECRET-resumed-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en["mfa.restart"] }));
    expect(await screen.findByText("SECRET-resumed-2")).toBeInTheDocument();
    expect(backend.mfa.unenroll).toHaveBeenCalledTimes(1);
    expect(backend.mfa.unenroll).toHaveBeenCalledWith({ factorId: "resumed-1" });
    expect(backend.factors.map((factor) => factor.id)).toEqual(["resumed-2"]);
  });

  it("still shows the new QR when removing the old factor fails on Start over", async () => {
    const backend = factorBackend("restartfail");
    render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-restartfail-1")).toBeInTheDocument();
    backend.mfa.unenroll.mockRejectedValueOnce(new Error("offline"));

    fireEvent.click(screen.getByRole("button", { name: en["mfa.restart"] }));
    expect(await screen.findByText("SECRET-restartfail-2")).toBeInTheDocument();
    expect(screen.queryByText("SECRET-restartfail-1")).toBeNull();
    await verifyWith(codeFor("SECRET-restartfail-2"));
    expect(await screen.findByText(en["mfa.onSub"])).toBeInTheDocument();
  });

  it("returns to Off on Cancel even when removing the factor fails", async () => {
    const backend = factorBackend("cancelfail");
    render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-cancelfail-1")).toBeInTheDocument();
    backend.mfa.unenroll.mockRejectedValueOnce(new Error("offline"));

    fireEvent.click(screen.getByRole("button", { name: en["mfa.cancel"] }));
    // The factor is still there, but this page no longer holds its QR: the
    // member is told a new one replaces it rather than shown a stale panel.
    expect(await screen.findByText(en["mfa.earlierSetupReplaced"])).toBeInTheDocument();
    expect(screen.queryByText("SECRET-cancelfail-1")).toBeNull();
    expect(screen.getByRole("button", { name: en["mfa.enable"] })).toBeInTheDocument();
  });

  it("keeps the QR on screen when the verify challenge cannot be created", async () => {
    const backend = factorBackend("challengefail");
    render(view(backend.client()));
    await turnOn();
    expect(await screen.findByText("SECRET-challengefail-1")).toBeInTheDocument();
    backend.mfa.challenge.mockResolvedValueOnce({ data: null, error: { message: "Factor not found" } });

    await verifyWith(codeFor("SECRET-challengefail-1"));
    expect(await screen.findByText(en["mfa.codeRejected"])).toBeInTheDocument();
    expect(screen.getByText("SECRET-challengefail-1")).toBeInTheDocument();
    await verifyWith(codeFor("SECRET-challengefail-1"));
    expect(await screen.findByText(en["mfa.onSub"])).toBeInTheDocument();
  });

  it("ignores a factor list read before the enrolment started", async () => {
    const backend = factorBackend("stale");
    const { rerender } = render(view(backend.client()));
    const button = await screen.findByRole("button", { name: en["mfa.enable"] });
    // A re-read starts, and is still in flight when the member turns two-step on.
    let answer;
    backend.mfa.listFactors.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    rerender(view(backend.client()));
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    fireEvent.click(button);
    expect(await screen.findByText("SECRET-stale-1")).toBeInTheDocument();

    // It lands afterwards, without the new factor; it must not close the panel.
    answer({ data: { all: [] }, error: null });
    await waitFor(() => expect(backend.mfa.listFactors).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(screen.getByText("SECRET-stale-1")).toBeInTheDocument();
    expect(screen.queryByText(en["mfa.offSub"])).toBeNull();
    await verifyWith(codeFor("SECRET-stale-1"));
    expect(await screen.findByText(en["mfa.onSub"])).toBeInTheDocument();
  });

  it("resumes, not replaces, a QR another security card on the page is showing", async () => {
    const backend = factorBackend("twocards");
    const enroll = backend.mfa.enroll.getMockImplementation();
    let release;
    const answered = new Promise((resolve) => { release = resolve; });
    // The factor exists on the server before card A has its answer.
    backend.mfa.enroll.mockImplementationOnce(async () => { const result = await enroll(); await answered; return result; });
    const cardA = render(view(backend.client()));
    const cardB = render(view(backend.client()));
    fireEvent.click(await within(cardA.container).findByRole("button", { name: en["mfa.enable"] }));
    await waitFor(() => expect(backend.factors).toHaveLength(1));

    // Card B re-reads now: it sees an unverified factor whose QR it never had.
    cardB.rerender(view(backend.client()));
    expect(await within(cardB.container).findByText(en["mfa.earlierSetupReplaced"])).toBeInTheDocument();
    release();
    expect(await within(cardA.container).findByText("SECRET-twocards-1")).toBeInTheDocument();

    // Card A has shown that QR, so card B's Turn on resumes it.
    fireEvent.click(within(cardB.container).getByRole("button", { name: en["mfa.enable"] }));
    expect(await within(cardB.container).findByText("SECRET-twocards-1")).toBeInTheDocument();
    expect(backend.mfa.enroll).toHaveBeenCalledTimes(1);
    expect(backend.mfa.unenroll).not.toHaveBeenCalled();
    expect(backend.factors.map((factor) => factor.id)).toEqual(["twocards-1"]);
  });

  it("has the new setup lines in Spanish", () => {
    for (const key of ["mfa.settingUpSub", "mfa.restart", "mfa.restartWarning", "mfa.earlierSetupReplaced"]) {
      expect(catalogue.es[key]).toBeTruthy();
      expect(catalogue.es[key]).not.toBe(en[key]);
    }
  });
});
