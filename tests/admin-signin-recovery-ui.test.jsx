import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { expectOneWriteFromOneTick, expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";
import { t } from "../src/lib/i18n.js";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

// The identity-proof checkbox label is catalogue copy that still names the
// sibling product; the wave-2 copy pass rewords it, so it is read from the
// catalogue rather than pinned here.
const VERIFIED = t("en", "admin.recoveryVerified");

const target = {
  userId: "10000000-0000-4000-8000-000000000001",
  fullName: "Maria Fonseca",
  initials: "MF",
  memberSince: 2024,
  roles: [],
};
const targetActionName = "Maria Fonseca — With the campaign since 2024 — Worker ID ending 000001";

function renderAdmin(overrides = {}, lang = "en", deskOverride = null) {
  const api = {
    loadDesk: vi.fn().mockResolvedValue(deskOverride || JSON.parse(JSON.stringify(fallbackData.adminDesk))),
    grantRole: vi.fn(), revokeRole: vi.fn(), searchMembers: vi.fn(),
    createEvent: vi.fn(), updateEvent: vi.fn(), resetMfa: vi.fn(),
    inviteMember: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn(),
    searchRecoveryMembers: vi.fn().mockResolvedValue([target]),
    recoverSigninAddress: vi.fn().mockResolvedValue({ completed: true }),
    reissuePassword: vi.fn().mockResolvedValue({ completed: true }),
    ...overrides,
  };
  const onNotice = vi.fn();
  render(
    <LanguageProvider lang={lang}>
      <AdminView data={{ member: { initials: "AR" } }} api={api} onNotice={onNotice} />
    </LanguageProvider>,
  );
  return { api, onNotice };
}

async function recoveryCard() {
  return (await screen.findByRole("heading", { name: "Sign-in help: new password or address" })).closest("article");
}

async function pickTarget(card) {
  fireEvent.change(within(card).getByRole("searchbox", { name: "Search campaign workers by name" }), { target: { value: "Maria" } });
  fireEvent.click(within(card).getByRole("button", { name: "Search workers" }));
  fireEvent.click(await within(card).findByRole("button", { name: `Choose ${targetActionName}` }));
}

describe("admin sign-in address recovery", () => {
  it("selects by name, confirms out-of-product identity proof, and clears the sensitive draft", async () => {
    const { api, onNotice } = renderAdmin();
    const card = await recoveryCard();
    expect(within(card).queryByText(/current.*email/i)).not.toBeInTheDocument();
    await pickTarget(card);
    expect(api.searchRecoveryMembers).toHaveBeenCalledWith("Maria");
    expect(within(card).getByText("With the campaign since 2024")).toBeInTheDocument();

    const submit = within(card).getByRole("button", { name: `Review address change for ${targetActionName}` });
    expect(submit).toBeDisabled();
    fireEvent.change(within(card).getByLabelText("New sign-in address"), { target: { value: "maria.new@example.org" } });
    fireEvent.change(within(card).getByLabelText("Recovery reason"), { target: { value: "address_retired" } });
    fireEvent.click(within(card).getByLabelText(VERIFIED));
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    const confirmation = within(card).getByRole("group", { name: `Change the sign-in address for ${targetActionName}?` });
    fireEvent.click(within(confirmation).getByRole("button", { name: `Change the sign-in address for ${targetActionName} and end sessions` }));
    await waitFor(() => expect(api.recoverSigninAddress).toHaveBeenCalledWith({
      userId: target.userId,
      newEmail: "maria.new@example.org",
      reason: "address_retired",
      identityVerified: true,
    }));
    const status = await within(card).findByRole("status");
    expect(onNotice).toHaveBeenCalledWith("Sign-in address changed and prior sessions ended.");
    expect(status).toHaveTextContent("Reissue an emailed password if the worker also needs new credentials");
    expect(within(card).queryByDisplayValue("maria.new@example.org")).not.toBeInTheDocument();
  });

  it("shows a stable generic error without provider or address detail", async () => {
    const recoverSigninAddress = vi.fn().mockRejectedValue(new Error("private@example.org already registered"));
    renderAdmin({ recoverSigninAddress });
    const card = await recoveryCard();
    await pickTarget(card);
    fireEvent.change(within(card).getByLabelText("New sign-in address"), { target: { value: "private@example.org" } });
    fireEvent.click(within(card).getByLabelText(VERIFIED));
    fireEvent.click(within(card).getByRole("button", { name: `Review address change for ${targetActionName}` }));
    fireEvent.click(within(card).getByRole("button", { name: `Change the sign-in address for ${targetActionName} and end sessions` }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("The address change could not be completed");
    expect(within(card).queryByText(/already registered/)).not.toBeInTheDocument();
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102.
  it("asks for a personal address when the new address is a government or employer one", async () => {
    const recoverSigninAddress = vi.fn().mockRejectedValue(Object.assign(new Error("email-domain-blocked"), { code: "email-domain-blocked" }));
    renderAdmin({ recoverSigninAddress });
    const card = await recoveryCard();
    await pickTarget(card);
    fireEvent.change(within(card).getByLabelText("New sign-in address"), { target: { value: "member@agency.gov" } });
    fireEvent.click(within(card).getByLabelText("I verified this worker's identity outside Union Ground."));
    fireEvent.click(within(card).getByRole("button", { name: `Review address change for ${targetActionName}` }));
    fireEvent.click(within(card).getByRole("button", { name: `Change the sign-in address for ${targetActionName} and end sessions` }));
    expect(await within(card).findByRole("alert"))
      .toHaveTextContent("Use a personal email address. Government and employer email addresses can't be used for a Union Ground account.");
  });

  it("confirms a password reissue without claiming the address changed", async () => {
    const { api, onNotice } = renderAdmin();
    const card = await recoveryCard();
    await pickTarget(card);
    fireEvent.click(within(card).getByLabelText(VERIFIED));
    fireEvent.click(within(card).getByRole("button", { name: `Reissue emailed password for ${targetActionName}` }));
    await waitFor(() => expect(api.reissuePassword).toHaveBeenCalledWith({
      userId: target.userId,
      identityVerified: true,
    }));
    expect(onNotice).toHaveBeenCalledWith("A new password was emailed and prior sessions were ended.");
    expect(within(card).getByRole("status")).toHaveTextContent("A new password was emailed and prior sessions were ended");
    expect(within(card).getByRole("status")).not.toHaveTextContent("sign-in address changed");
  });

  it("describes password-reissue unavailability without exposing or inventing a provider cause", async () => {
    const unavailable = Object.assign(new Error("private provider detail"), { code: "reissue-unavailable" });
    renderAdmin({ reissuePassword: vi.fn().mockRejectedValue(unavailable) });
    const card = await recoveryCard();
    await pickTarget(card);
    fireEvent.click(within(card).getByLabelText(VERIFIED));
    fireEvent.click(within(card).getByRole("button", { name: `Reissue emailed password for ${targetActionName}` }));

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "This password reissue can't start right now. Another attempt may still be running, or the reissue limit was reached. Try again later.",
    );
    expect(within(card).queryByText(/private provider detail/i)).not.toBeInTheDocument();
  });

  // BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003: every reissue
  // failure used to read as a failed address change.
  it.each([
    ["reissue-incomplete", "The reissue did not finish, and the worker's new password may not work yet. Wait 15 minutes, then try again; the worker should use the newest password email."],
    ["not-permitted", "Only the Admin role can reissue a password. Choose Admin for the campaign this worker belongs to, check that your two-step sign-in is on, and try again."],
    // Union Ground has no provisioned support mailbox, so the copy names
    // no address at all.
    ["service-unavailable", "The password could not be reissued. Try again in a moment."],
  ])("names a %s reissue failure and never calls it an address change", async (code, text) => {
    const failure = Object.assign(new Error("private provider detail"), { code });
    renderAdmin({ reissuePassword: vi.fn().mockRejectedValue(failure) });
    const card = await recoveryCard();
    await pickTarget(card);
    fireEvent.click(within(card).getByLabelText(VERIFIED));
    fireEvent.click(within(card).getByRole("button", { name: `Reissue emailed password for ${targetActionName}` }));

    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent("address change");
    expect(alert.textContent).not.toMatch(/@|unionground\.net/i);
    expect(siblingIdentityIn(alert.textContent)).toEqual([]);
    expect(within(card).queryByText(/private provider detail/i)).not.toBeInTheDocument();
  });

  it("keeps duplicate same-name members visibly and accessibly distinct through password reissue", async () => {
    const duplicate = { ...target, userId: "20000000-0000-4000-8000-000000000002" };
    const searchRecoveryMembers = vi.fn().mockResolvedValue([target, duplicate]);
    const { api } = renderAdmin({ searchRecoveryMembers });
    const card = await recoveryCard();
    fireEvent.change(within(card).getByRole("searchbox", { name: "Search campaign workers by name" }), { target: { value: "Maria" } });
    fireEvent.click(within(card).getByRole("button", { name: "Search workers" }));

    expect(await within(card).findByText("Worker ID ending 000001")).toBeInTheDocument();
    expect(within(card).getByText("Worker ID ending 000002")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Choose Maria Fonseca — With the campaign since 2024 — Worker ID ending 000002" }));
    expect(within(card).getByText("Worker ID ending 000002")).toBeInTheDocument();
    fireEvent.click(within(card).getByLabelText(VERIFIED));
    fireEvent.click(within(card).getByRole("button", { name: "Reissue emailed password for Maria Fonseca — With the campaign since 2024 — Worker ID ending 000002" }));

    await waitFor(() => expect(api.reissuePassword).toHaveBeenCalledWith({
      userId: duplicate.userId,
      identityVerified: true,
    }));
  });

  it("renders success and audit meaning without putting an address in the trail", async () => {
    const desk = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    desk.audit.unshift({
      id: "audit-recovery", action: "recover_signin_address", actorName: "Alex Rivera",
      targetName: "Maria Fonseca", detail: { reason: "lost_inbox", sessionsRevoked: true }, createdLabel: "Aug 12",
    });
    renderAdmin({}, "en", desk);
    await recoveryCard();
    const auditCard = screen.getByRole("heading", { name: "Recent admin activity" }).closest("article");
    expect(within(auditCard).getByText("Alex Rivera changed the sign-in address for Maria Fonseca and ended prior sessions")).toBeInTheDocument();
    expect(within(auditCard).queryByText(/@/)).not.toBeInTheDocument();
  });

  it("provides the complete workflow in Spanish", async () => {
    renderAdmin({}, "es");
    const card = (await screen.findByRole("heading", { name: "Ayuda para iniciar sesión: contraseña o dirección nueva" })).closest("article");
    expect(within(card).getByRole("searchbox", { name: "Buscar trabajadores de la campaña por nombre" })).toBeInTheDocument();
    expect(within(card).getByText(/Nunca se muestra la dirección de acceso actual/)).toBeInTheDocument();
  });

  // BUG-UG-PASSWORD-REISSUE-HAT-AND-DISCOVERY-20261003: the reissue
  // lived in a card titled as an address change, and nothing said it needs the
  // Admin hat until a press was refused.
  it("names the password reissue in the card title and states the Admin hat before the press", async () => {
    renderAdmin();
    const card = await recoveryCard();
    expect(within(card).getByText(/Send a worker a new password/)).toBeInTheDocument();
    const notice = within(card).getByText(/Sending a new password needs the Admin desk/);
    await pickTarget(card);
    const press = within(card).getByRole("button", { name: `Reissue emailed password for ${targetActionName}` });
    expect(notice.compareDocumentPosition(press) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says Sending… while a reissue runs, not the address-change Changing…", async () => {
    let finish;
    const reissuePassword = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    renderAdmin({ reissuePassword });
    const card = await recoveryCard();
    await pickTarget(card);
    fireEvent.click(within(card).getByLabelText(VERIFIED));
    fireEvent.click(within(card).getByRole("button", { name: `Reissue emailed password for ${targetActionName}` }));
    expect(await within(card).findByText("Sending…")).toBeInTheDocument();
    expect(within(card).queryByText("Changing…")).toBeNull();
    finish({ completed: true });
    expect(await within(card).findByRole("status")).toHaveTextContent("A new password was emailed");
  });

  it("states the Admin hat in Spanish too", async () => {
    renderAdmin({}, "es");
    const card = (await screen.findByRole("heading", { name: "Ayuda para iniciar sesión: contraseña o dirección nueva" })).closest("article");
    expect(within(card).getByText(/necesitas el escritorio de Admin/)).toBeInTheDocument();
  });
});

// The address recovery and the password reissue share one lock
// and one pending state; each keeps its control focused while it runs.
describe("account recovery while a recovery write runs", () => {
  const CHOOSE_AGAIN = "Cancel";
  async function verified() {
    const rendered = renderAdmin();
    const card = await recoveryCard();
    await pickTarget(card);
    fireEvent.click(within(card).getByLabelText("I verified this worker's identity outside Union Ground."));
    return { ...rendered, card };
  }
  const reissueButton = (card) => within(card).getByRole("button", { name: `Reissue emailed password for ${targetActionName}` });

  it("sends one recovery write when Reissue and the confirmed address change are pressed in the same tick", async () => {
    const { api, card } = await verified();
    fireEvent.change(within(card).getByLabelText("New sign-in address"), { target: { value: "maria.new@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: `Review address change for ${targetActionName}` }));
    const confirmation = within(card).getByRole("group", { name: `Change the sign-in address for ${targetActionName}?` });
    const change = within(confirmation).getByRole("button", { name: `Change the sign-in address for ${targetActionName} and end sessions` });
    const reissue = reissueButton(card);
    await expectOneWriteFromOneTick([api.recoverSigninAddress, api.reissuePassword], [() => fireEvent.click(change), () => fireEvent.click(reissue)]);
  });

  it("reissues again from an immediate press after a reissue that throws at once", async () => {
    const { api, card } = await verified();
    await expectReadyRetryAfterThrowAtOnce(api.reissuePassword, reissueButton(card));
  });
});
