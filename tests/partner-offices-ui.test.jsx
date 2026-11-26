// REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031:
// the "offices not yet on Union Ground" panel on the suggestions and
// handshake screens. The adapter is faked; nothing leaves the process.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PartnerOffices } from "../src/features/connectionSuggestions/PartnerOffices.jsx";
import { ConnectionSuggestions } from "../src/features/connectionSuggestions/ConnectionSuggestions.jsx";
import { createConnectionPreview } from "../src/features/connectionSuggestions/preview.js";
import { DEFAULT_CONNECTION_SETTINGS } from "../src/features/connectionSuggestions/contract.js";
import { expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";

const CHAPTER = "standing-offer-proof";
const office = (overrides = {}) => ({
  unionOrgId: "office-1", name: "Riverside Transit Workers", affiliation: "ATU", designation: "LU", localNumber: "1001",
  city: "Springfield", state: "IL", sector: "public", sectorTags: ["transportation"], notOnPlatform: true,
  sameState: true, sharedSectors: 1, openOffer: null, invitationPending: false, ...overrides,
});
const ledger = (overrides = {}) => ({ offers: [], invitations: [], openLimit: 10, pendingInvitationLimit: 5, ...overrides });

function fakeAdapter({ rows = [office()], matchedOn = "state", own = ledger() } = {}) {
  return {
    listPartnerOffices: vi.fn().mockResolvedValue({ matchedOn, rows }),
    listPartnerOffers: vi.fn().mockResolvedValue(own),
    createPartnerOffer: vi.fn().mockResolvedValue({ id: "offer-1", status: "open" }),
    withdrawPartnerOffer: vi.fn().mockResolvedValue({ id: "offer-1", status: "withdrawn" }),
    requestPartnerInvitation: vi.fn().mockResolvedValue({ id: "request-1", status: "pending" }),
  };
}

const renderPanel = (adapter, props = {}) => render(<PartnerOffices adapter={adapter} chapterId={CHAPTER} selectedHat="admin" {...props} />);

describe("offices not yet on Union Ground", () => {
  it.each([
    ["en", "Ask Union Ground to invite them", "Send request", "Contact name", "Contact email",
      "Enter at least 2 characters for the contact name. Leading and trailing whitespace does not count. Some characters, such as emoji, can count as more than one.",
      "Enter an email address with an @ sign."],
    ["es", "Pedir a Union Ground que los invite", "Enviar solicitud", "Nombre del contacto", "Correo del contacto",
      "Escribe al menos 2 caracteres para el nombre del contacto. Los espacios en blanco al principio y al final no cuentan. Algunos caracteres, como los emojis, pueden contar como más de uno.",
      "Escribe una dirección de correo con una arroba (@)."],
  ])("explains why a partner invitation is blocked in %s", async (lang, invite, send, nameLabel, emailLabel, badName, badEmail) => {
    const adapter = fakeAdapter();
    const wrote = () => adapter.requestPartnerInvitation.mock.calls.length > 0;
    renderPanel(adapter, { lang });
    fireEvent.click(await screen.findByRole("button", { name: invite }));
    const dialog = within(screen.getByRole("dialog"));
    const button = dialog.getByRole("button", { name: send });
    fireEvent.change(dialog.getByLabelText(nameLabel), { target: { value: " D " } });
    expect(button).toHaveAccessibleDescription(badName);
    expect(button.nextElementSibling).toBeVisible();
    expectRefusedEveryWay(button, badName, wrote);
    const previousAlert = dialog.getByRole("alert");
    fireEvent.submit(button.form);
    const submitAlert = dialog.getByRole("alert");
    expect(submitAlert).not.toBe(previousAlert);
    expect(submitAlert).toHaveTextContent(badName);
    expect(adapter.requestPartnerInvitation).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText(nameLabel), { target: { value: " Dana Ruiz " } });
    fireEvent.change(dialog.getByLabelText(emailLabel), { target: { value: "dana" } });
    expectRefusedEveryWay(button, badEmail, wrote);
    fireEvent.change(dialog.getByLabelText(emailLabel), { target: { value: "dana@example.invalid" } });
    fireEvent.click(button);
    await waitFor(() => expect(adapter.requestPartnerInvitation).toHaveBeenCalledExactlyOnceWith(CHAPTER, "office-1", undefined,
      { name: "Dana Ruiz", email: "dana@example.invalid", locale: lang }, expect.any(String)));
  });
  it("lists catalogue offices with no campaign, marked not on the platform, with the matching signals", async () => {
    const adapter = fakeAdapter({ rows: [office(), office({ unionOrgId: "office-2", name: "Lakeside Clerks", sameState: false, sharedSectors: 0, designation: null, localNumber: null })] });
    renderPanel(adapter);
    const card = (await screen.findByText("Riverside Transit Workers")).closest("li");
    expect(within(card).getByText("Not yet on Union Ground")).toBeInTheDocument();
    expect(within(card).getByText("Same state")).toBeInTheDocument();
    expect(within(card).getByText("Shared sectors: 1")).toBeInTheDocument();
    expect(within(card).getByText("LU · 1001 · Springfield · IL")).toBeInTheDocument();
    const other = screen.getByText("Lakeside Clerks").closest("li");
    expect(within(other).queryByText("Same state")).not.toBeInTheDocument();
    expect(within(other).queryByText(/Shared sectors/)).not.toBeInTheDocument();
    expect(adapter.listPartnerOffices).toHaveBeenCalledWith(CHAPTER, "");
    expect(adapter.listPartnerOffers).toHaveBeenCalledWith(CHAPTER);
    expect(screen.getByText("No standing offers or invitation requests yet.")).toBeInTheDocument();
    expect(screen.getByText("Up to 10 open offers and 5 waiting invitation requests.")).toBeInTheDocument();
    // Nothing on the panel speaks for the requester's affiliation.
    expect(document.body.textContent).not.toMatch(/your union|tu sindicato/i);
  });

  it("scores offices with the suggestion dials where the catalogue has data", async () => {
    const adapter = fakeAdapter({ rows: [
      office({ unionOrgId: "office-far", name: "Lakeside Clerks", state: "WI", sectorTags: [], sameState: false, sharedSectors: 0 }),
      office({ unionOrgId: "office-near", name: "Riverside Transit Workers", state: "IL", sectorTags: ["transportation"] }),
      office({ unionOrgId: "office-none", name: "Nowhere Office", state: null, sectorTags: ["transportation"], sameState: false }),
    ] });
    const source = { id: "own-chapter", kind: "chapter", displayName: "Garage 7", location: { country: "US", state: "IL" }, sectorKeys: ["transportation"] };
    const settings = { ...DEFAULT_CONNECTION_SETTINGS, locationScale: "state", weights: { location: 50, sector: 50, issues: 0, expertise: 0, local: 0, union: 0 } };
    const view = renderPanel(adapter, { source, settings });
    await screen.findByText("Riverside Transit Workers");
    const names = () => screen.getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent).filter(Boolean);
    expect(names()).toEqual(["Riverside Transit Workers", "Nowhere Office", "Lakeside Clerks"]);
    expect(within(screen.getByText("Riverside Transit Workers").closest("li")).getByText("Match score 100")).toBeInTheDocument();
    expect(within(screen.getByText("Lakeside Clerks").closest("li")).getByText("Match score 13")).toBeInTheDocument();
    view.unmount();
    // Without dials (the handshake screen) the server's order and no score.
    renderPanel(fakeAdapter({ rows: [office({ name: "Lakeside Clerks" }), office({ unionOrgId: "office-2" })] }));
    await screen.findByText("Lakeside Clerks");
    expect(screen.queryByText(/Match score/)).not.toBeInTheDocument();
  });

  it("shows further pages of offices and keeps a failed page retryable", async () => {
    const adapter = fakeAdapter();
    adapter.listPartnerOffices.mockResolvedValueOnce({ matchedOn: "state", hasMore: true, rows: [office()] });
    renderPanel(adapter);
    const more = await screen.findByRole("button", { name: "Show more offices" });
    adapter.listPartnerOffices.mockRejectedValueOnce(new Error("down"));
    fireEvent.click(more);
    expect(await screen.findByRole("alert")).toHaveTextContent("Offices could not be loaded.");
    adapter.listPartnerOffices.mockResolvedValueOnce({ matchedOn: "state", hasMore: false, rows: [office(), office({ unionOrgId: "office-2", name: "Lakeside Clerks" })] });
    fireEvent.click(screen.getByRole("button", { name: "Show more offices" }));
    expect(await screen.findByText("Lakeside Clerks")).toBeInTheDocument();
    expect(screen.getAllByText("Riverside Transit Workers")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Show more offices" })).not.toBeInTheDocument();
    expect(adapter.listPartnerOffices).toHaveBeenLastCalledWith(CHAPTER, "", 1);
  });

  it("discards a later page that belongs to an earlier search", async () => {
    const adapter = fakeAdapter();
    adapter.listPartnerOffices.mockResolvedValueOnce({ matchedOn: "state", hasMore: true, rows: [office()] });
    renderPanel(adapter);
    await screen.findByRole("button", { name: "Show more offices" });
    let resolveStale;
    adapter.listPartnerOffices.mockReset();
    adapter.listPartnerOffices.mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }));
    adapter.listPartnerOffices.mockResolvedValue({ matchedOn: "name", hasMore: true, rows: [office({ unionOrgId: "office-l", name: "Lakeside Clerks" })] });
    fireEvent.click(screen.getByRole("button", { name: "Show more offices" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search offices" }), { target: { value: "Lakeside" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Lakeside Clerks")).toBeInTheDocument();
    resolveStale({ matchedOn: "state", hasMore: false, rows: [office({ unionOrgId: "office-old", name: "Stale Office" })] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Show more offices" })).toBeEnabled());
    expect(screen.queryByText("Stale Office")).not.toBeInTheDocument();
  });

  it("asks for a published state or a name search, and searches by name", async () => {
    const adapter = fakeAdapter({ rows: [], matchedOn: "none" });
    renderPanel(adapter);
    expect(await screen.findByText("Publish a state in your connection profile, or search by name, to see offices.")).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Search offices" });
    fireEvent.change(input, { target: { value: "R" } });
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    fireEvent.submit(input.closest("form"));
    expect(adapter.listPartnerOffices).toHaveBeenCalledTimes(1);
    adapter.listPartnerOffices.mockResolvedValue({ matchedOn: "name", rows: [] });
    fireEvent.change(input, { target: { value: " Riv " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No office without a campaign matches.")).toBeInTheDocument();
    expect(adapter.listPartnerOffices).toHaveBeenLastCalledWith(CHAPTER, "Riv");
  });

  it("leaves a standing offer with one key per request, and shows each refusal plainly", async () => {
    const adapter = fakeAdapter();
    renderPanel(adapter);
    fireEvent.click(await screen.findByRole("button", { name: "Leave a standing offer" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/The offer waits for Riverside Transit Workers/)).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Leave offer" });
    expectRefusedEveryWay(submit, "Enter a title for the offer.", () => adapter.createPartnerOffer.mock.calls.length > 0);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: " Shared training " } });
    expectRefusedEveryWay(submit, "Enter a purpose for the offer.", () => adapter.createPartnerOffer.mock.calls.length > 0);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Purpose" }), { target: { value: "Swap committee worker training" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Sharing boundary" }), { target: { value: "docs_only" } });
    const refusals = [
      [{ code: "23505" }, "Your campaign already has an open offer or a waiting invitation request for this office."],
      [{ code: "22023", message: "open offer limit reached" }, "Your campaign has reached its limit. Withdraw an offer, or wait for an invitation request to be handled."],
      [{ code: "22023", message: "office unavailable or already on the platform" }, "This office is already on Union Ground. Use the suggestions to request a handshake."],
      [{ code: "22023", message: "partner is not onboarded for two-sided requests" }, "Your organization must finish setup before it can make offers."],
      [{ code: "42501", message: "select the campaign before making an offer" }, "Select this campaign with an advisor, administrator or campaign lead role to continue."],
      [{ code: "22023", message: "invalid offer" }, "Check the fields and try again."],
      [new Error("network"), "The request could not be saved. Try again."],
    ];
    for (const [error, text] of refusals) {
      adapter.createPartnerOffer.mockRejectedValueOnce(error);
      fireEvent.click(submit);
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(text);
    }
    fireEvent.click(submit);
    expect(await screen.findByText("Standing offer saved. It waits until the office joins.")).toBeInTheDocument();
    const calls = adapter.createPartnerOffer.mock.calls;
    expect(calls).toHaveLength(refusals.length + 1);
    expect(calls.at(-1).slice(0, 3)).toEqual([CHAPTER, "office-1", { title: "Shared training", purpose: "Swap committee worker training", dataScope: "docs_only" }]);
    expect(new Set(calls.map((call) => call[3])).size).toBe(1);
    await waitFor(() => expect(adapter.listPartnerOffers).toHaveBeenCalledTimes(2));
  });


  it("closes a dialog without writing, and hides finished actions", async () => {
    const adapter = fakeAdapter({ rows: [office({ invitationPending: true })] });
    renderPanel(adapter);
    expect(await screen.findByText("Invitation request waiting for Union Ground")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask Union Ground to invite them" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave a standing offer" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(adapter.createPartnerOffer).not.toHaveBeenCalled();
  });

  it("lists the campaign's own offers and requests, and withdraws an open offer", async () => {
    const own = ledger({
      offers: [
        { id: "offer-1", officeName: "Riverside Transit Workers", title: "Shared training", status: "open", expiresAt: "2027-01-29T12:00:00Z" },
        { id: "offer-2", officeName: "Lakeside Clerks", title: "Mutual aid", status: "expired", expiresAt: "2026-10-01T12:00:00Z" },
        { id: "offer-3", officeName: "Hill Nurses", title: "Joint survey", status: "delivered", expiresAt: "bad" },
        { id: "offer-4", officeName: "Bay Teachers", title: "Docs", status: "withdrawn", expiresAt: null },
      ],
      invitations: ["pending", "sent", "declined", "cancelled"].map((status, index) => ({ id: `request-${index}`, officeName: `Office ${index}`, status })),
    });
    const adapter = fakeAdapter({ rows: [], own });
    renderPanel(adapter);
    const open = (await screen.findByText("Riverside Transit Workers")).closest("li");
    expect(within(open).getByText(/^Open · Expires /)).toBeInTheDocument();
    for (const text of ["Expired", "Delivered as a handshake request", "Withdrawn", "Waiting for Union Ground", "Invitation sent", "Not sent", "Cancelled"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button", { name: "Withdraw" })).toHaveLength(1);
    adapter.withdrawPartnerOffer.mockRejectedValueOnce({ code: "P0002", message: "offer unavailable" });
    fireEvent.click(within(open).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("The request could not be saved. Try again.")).toBeInTheDocument();
    fireEvent.click(within(open).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Standing offer withdrawn.")).toBeInTheDocument();
    expect(adapter.withdrawPartnerOffer).toHaveBeenLastCalledWith(CHAPTER, "offer-1");
  });

  // Ledger 354: the offer:<id> lock is the only refusal before the busy offer
  // commits, so two clicks on one Withdraw in one tick send one withdrawal.
  it("withdraws an offer once when its Withdraw is activated twice in one tick", async () => {
    const own = ledger({ offers: [{ id: "offer-1", officeName: "Riverside Transit Workers", title: "Shared training", status: "open", expiresAt: "2027-01-29T12:00:00Z" }] });
    const adapter = fakeAdapter({ rows: [], own });
    renderPanel(adapter);
    const open = (await screen.findByText("Riverside Transit Workers")).closest("li");
    const withdraw = within(open).getByRole("button", { name: "Withdraw" });
    await expectOneWriteFromOneTick(adapter.withdrawPartnerOffer, [() => fireEvent.click(withdraw), () => fireEvent.click(withdraw)]);
    expect(adapter.withdrawPartnerOffer).toHaveBeenCalledExactlyOnceWith(CHAPTER, "offer-1");
    expect(await screen.findByText("Standing offer withdrawn.")).toBeInTheDocument();
  });

  it("is read-only for roles that cannot make offers", async () => {
    const adapter = fakeAdapter({ own: ledger({ offers: [{ id: "offer-1", officeName: "Riverside Transit Workers", title: "Shared training", status: "open", expiresAt: "2027-01-29T12:00:00Z" }] }) });
    renderPanel(adapter, { selectedHat: "steward" });
    expect(await screen.findByText("Advisors, administrators and campaign leads can leave offers and ask for invitations for this campaign.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave a standing offer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
  });

  it("separates an absent backend, a refused role and a failed read, and writes nothing in preview", async () => {
    for (const [error, text] of [[{ code: "PGRST202" }, "Offices not yet on Union Ground are not available here yet."], [{ code: "42501" }, "Select this campaign with an advisor, administrator or campaign lead role to continue."], [new Error("down"), "Offices could not be loaded."]]) {
      const adapter = fakeAdapter();
      adapter.listPartnerOffices.mockRejectedValue(error);
      const view = renderPanel(adapter);
      expect(await screen.findByText(text)).toBeInTheDocument();
      view.unmount();
    }
    const adapter = fakeAdapter();
    renderPanel(adapter, { preview: true });
    expect(screen.getByText("Preview only: no office is listed or contacted.")).toBeInTheDocument();
    expect(adapter.listPartnerOffices).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "Offices could not be loaded.", "Try again", "Search offices", "Search"],
    ["es", "No se pudieron cargar las oficinas.", "Reintentar", "Buscar oficinas", "Buscar"],
  ])("retries the submitted first-page search and preserves the draft in %s", async (lang, warning, retry, field, submit) => {
    const adapter = fakeAdapter();
    renderPanel(adapter, { lang });
    await screen.findByText("Riverside Transit Workers");
    adapter.listPartnerOffers.mockRejectedValueOnce(new Error("offline"));
    const search = screen.getByRole("textbox", { name: field });
    fireEvent.change(search, { target: { value: "Riv" } });
    fireEvent.click(screen.getByRole("button", { name: submit }));
    expect(await screen.findByRole("alert")).toHaveTextContent(warning);
    fireEvent.change(search, { target: { value: "Unsubmitted draft" } });
    const retryButton = screen.getByRole("button", { name: retry });
    retryButton.focus();
    fireEvent.click(retryButton);
    expect(screen.getByRole("heading", { level: 3 })).toHaveFocus();
    await screen.findByText("Riverside Transit Workers");
    expect(screen.getByRole("heading", { level: 3 })).toHaveFocus();
    expect(adapter.listPartnerOffices).toHaveBeenLastCalledWith(CHAPTER, "Riv");
    expect(adapter.listPartnerOffers).toHaveBeenCalledTimes(3);
    expect(search).toHaveValue("Unsubmitted draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders Spanish copy", async () => {
    const adapter = fakeAdapter({ rows: [office({ openOffer: { id: "offer-9", title: "Formación", expiresAt: "2027-01-29T12:00:00Z" } })] });
    renderPanel(adapter, { lang: "es" });
    expect(await screen.findByText("Aún no está en Union Ground")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Oficinas que aún no están en Union Ground" })).toBeInTheDocument();
    expect(screen.getByText(/Oferta permanente abierta hasta el/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pedir a Union Ground que los invite" }));
    expect(within(screen.getByRole("dialog")).getByRole("combobox", { name: "Idioma de la invitación" })).toHaveValue("es");
  });

  it("explains missing standing-offer fields in Spanish", async () => {
    const adapter = fakeAdapter();
    const wrote = () => adapter.createPartnerOffer.mock.calls.length > 0;
    renderPanel(adapter, { lang: "es" });
    fireEvent.click(await screen.findByRole("button", { name: "Dejar una oferta permanente" }));
    const dialog = within(screen.getByRole("dialog"));
    const button = dialog.getByRole("button", { name: "Dejar oferta" });
    expectRefusedEveryWay(button, "Escribe un título para la oferta.", wrote);
    fireEvent.change(dialog.getByRole("textbox", { name: "Título" }), { target: { value: "Formación" } });
    expectRefusedEveryWay(button, "Escribe un propósito para la oferta.", wrote);
  });

  it("appears on the suggestions screen only when the adapter offers it", async () => {
    const fixtures = createConnectionPreview();
    const actor = { organizationId: "own-org", selectedHat: "admin" };
    const workspace = { ...fixtures.workspace, organizationId: actor.organizationId };
    const adapter = { ...fakeAdapter(), workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue({ profiles: fixtures.profiles }) };
    const view = render(<ConnectionSuggestions actor={actor} adapter={adapter} />);
    expect(await screen.findByText("Riverside Transit Workers")).toBeInTheDocument();
    expect(adapter.listPartnerOffices).toHaveBeenCalledWith(workspace.chapterId, "");
    view.unmount();
    const older = { workspace: vi.fn().mockResolvedValue(workspace), profiles: vi.fn().mockResolvedValue({ profiles: fixtures.profiles }) };
    render(<ConnectionSuggestions actor={actor} adapter={older} />);
    await screen.findByRole("heading", { name: "Harbor Care Campaign" });
    expect(screen.queryByText("Offices not yet on Union Ground")).not.toBeInTheDocument();
  });
});
