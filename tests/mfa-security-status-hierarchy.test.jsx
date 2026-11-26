import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MfaSettings } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// REQ-UG-SECURITY-STATUS-HIERARCHY-20261102: Security said two-step
// was on three or four times (the status line, "is on and your staff roles are
// back", and a "Two-step sign-in is on." strip) and offered turning it off as a
// full-width button above passkeys and recovery codes, with no confirmation.
// The status line is now the one statement of state; turning off sits last and
// asks first, naming the staff-access consequence where it applies.

afterEach(cleanup);

const verified = (id) => ({ id, factor_type: "totp", status: "verified" });

function client({ factors = [verified("f1")], ...overrides } = {}) {
  let current = factors;
  return {
    auth: {
      mfa: {
        listFactors: vi.fn(async () => ({ data: { all: current, totp: current }, error: null })),
        enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(),
        unenroll: vi.fn(async ({ factorId }) => { current = current.filter((factor) => factor.id !== factorId); return { error: null }; }),
        ...overrides,
      },
    },
  };
}

const staff = { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] };
const show = (props, lang = "en") => render(<LanguageProvider lang={lang}><MfaSettings {...props} /></LanguageProvider>);

describe("two-step status on Security", () => {
  it("states the state once, in the announced status line", async () => {
    show({ client: client(), staffMfa: staff });
    const status = (await screen.findByText(/^On — /)).closest("[role=status]");
    expect(status).toHaveTextContent("On — you'll be asked for a code from your authenticator app.");
    expect(screen.queryByText(/Two-step sign-in is on/)).toBeNull();
    expect(screen.getAllByText(/Turning it off will pause your staff access/)).toHaveLength(1);
  });

  it("offers turning off last, after the routine setup and recovery tasks, as a quiet action", async () => {
    const { container } = show({ client: client(), staffMfa: staff });
    const open = await screen.findByRole("button", { name: "Turn off two-step sign-in" });
    expect(open).toHaveClass("mfa-turn-off__open");
    expect(open).not.toHaveClass("dialog-secondary");
    const settings = container.querySelector(".mfa-settings");
    expect(settings.lastElementChild).toContainElement(open);
  });

  it("asks before turning off, names the staff consequence, and keeps it on when asked", async () => {
    const mfa = client();
    show({ client: mfa, staffMfa: staff });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    const confirm = screen.getByRole("group", { name: "Turn off two-step sign-in?" });
    expect(confirm).toHaveAccessibleDescription("Signing in will no longer ask for a code from your authenticator app. Your staff access pauses until you turn it back on.");
    const keep = within(confirm).getByRole("button", { name: "Keep it on" });
    await waitFor(() => expect(keep).toHaveFocus());
    fireEvent.click(keep);
    expect(screen.queryByRole("group", { name: "Turn off two-step sign-in?" })).toBeNull();
    expect(mfa.auth.mfa.unenroll).not.toHaveBeenCalled();
  });

  it("turns off after confirming and the status line follows", async () => {
    const mfa = client();
    show({ client: mfa });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    const confirm = screen.getByRole("group", { name: "Turn off two-step sign-in?" });
    expect(confirm).toHaveAccessibleDescription("Signing in will no longer ask for a code from your authenticator app.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Turn it off" }));
    await waitFor(() => expect(mfa.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: "f1" }));
    await waitFor(() => expect(screen.queryByText(/^On — /)).toBeNull());
    expect(screen.queryByText("Two-step sign-in is off.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn off two-step sign-in" })).toBeNull();
  });

  //  on #6897: a failure said in the slot above the passkeys landed
  // out of view of the control at the end of the card.
  it("keeps the confirmation open on a failed turn-off and says why there, with focus on it", async () => {
    const mfa = client({ factors: [verified("works"), verified("dead")], unenroll: vi.fn().mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "nope" } }) });
    show({ client: mfa });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    const confirm = screen.getByRole("group", { name: "Turn off two-step sign-in?" });
    const alert = await within(confirm).findByRole("alert");
    expect(alert).toHaveTextContent(/could not be removed/i);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(within(confirm).getByRole("button", { name: "Turn it off" })).toBeEnabled();
  });

  //  /: a failed unenroll followed by an unreadable factor
  // list put the alert back in the top slot, and the same words did not
  // refocus.
  it("keeps the alert in the confirmation when the factor list then fails, and refocuses every failure", async () => {
    let reads = 0;
    const mfa = client({
      listFactors: vi.fn(async () => (++reads === 1 ? { data: { all: [verified("f1")], totp: [verified("f1")] }, error: null } : { data: null, error: { message: "offline" } })),
      unenroll: vi.fn(async () => ({ error: { message: "nope" } })),
    });
    show({ client: mfa });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    const confirm = await screen.findByRole("group", { name: "Turn off two-step sign-in?" });
    const alert = await within(confirm).findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(confirm).getByRole("button", { name: "Turn it off" })).toBeDisabled();
  });

  it("refocuses a repeated failure with the same words", async () => {
    const mfa = client({ unenroll: vi.fn(async () => ({ error: { message: "nope" } })) });
    show({ client: mfa });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    const go = screen.getByRole("button", { name: "Turn it off" });
    fireEvent.click(go);
    const confirm = screen.getByRole("group", { name: "Turn off two-step sign-in?" });
    await waitFor(() => expect(within(confirm).getByRole("alert")).toHaveFocus());
    const words = within(confirm).getByRole("alert").textContent;
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Turn it off" })).toBeEnabled());
    within(confirm).getByRole("button", { name: "Turn it off" }).focus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Turn it off" }));
    await waitFor(() => expect(mfa.auth.mfa.unenroll).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(confirm).getByRole("alert")).toHaveFocus());
    expect(within(confirm).getByRole("alert").textContent).toBe(words);
  });

  // : setting two-step up again must not bring back an open
  // confirmation or an old failure.
  it("starts a re-enrolment with the turn-off control closed and no old error", async () => {
    let factors = [verified("f1")];
    const mfa = client({
      listFactors: vi.fn(async () => ({ data: { all: factors, totp: factors.filter((factor) => factor.status === "verified") }, error: null })),
      unenroll: vi.fn(async () => { factors = []; return { error: { message: "nope" } }; }),
      enroll: vi.fn(async () => { factors = [{ id: "f2", factor_type: "totp", status: "unverified" }]; return { data: { id: "f2", totp: { qr_code: "", secret: "S" } }, error: null }; }),
      challenge: vi.fn(async () => ({ data: { id: "c1" }, error: null })),
      verify: vi.fn(async () => { factors = [verified("f2")]; return { error: null }; }),
    });
    show({ client: mfa });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on two-step sign-in" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.change(await screen.findByLabelText("Code from your app"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("button", { name: "Turn off two-step sign-in" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Turn off two-step sign-in?" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  //  /: Keep it on returned focus nowhere.
  it("returns focus to the turn-off control when the member keeps two-step on", async () => {
    show({ client: client() });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it on" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn off two-step sign-in" })).toHaveFocus());
  });

  it("moves focus to the status line once two-step is off", async () => {
    show({ client: client() });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off two-step sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Turn off two-step sign-in" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toHaveClass("mfa-status"));
  });

  //  /: the turn-off control and the confirm actions meet the 48px floor.
  it("sizes the turn-off control and both confirm actions to 48px", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.mfa-turn-off__open \{ min-height: 48px;/);
    expect(css).toMatch(/\.mfa-turn-off__confirm \.mfa-actions > \* \{ flex: 0 1 auto; min-height: 48px; \}/);
  });

  it("offers a retry and no turn-off while the factor list cannot be read", async () => {
    show({ client: client({ listFactors: vi.fn(async () => ({ data: null, error: { message: "offline" } })) }) });
    expect(await screen.findByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off two-step sign-in" })).toBeNull();
  });

  it("asks in Spanish", async () => {
    show({ client: client(), staffMfa: staff }, "es");
    fireEvent.click(await screen.findByRole("button", { name: "Desactivar el inicio de sesión en dos pasos" }));
    const confirm = screen.getByRole("group", { name: "¿Desactivar el inicio en dos pasos?" });
    expect(within(confirm).getByRole("button", { name: "Mantenerlo activado" })).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: "Desactivarlo" })).toBeInTheDocument();
  });
});
