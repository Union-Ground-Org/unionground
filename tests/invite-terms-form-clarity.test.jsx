import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegalAcceptancePrompt, LEGAL_ACCEPTANCE_DRAFT_KEY, readAcceptanceDraftState } from "../src/components/LegalAcceptancePrompt.jsx";
import { ResidenceAgeFields } from "../src/components/ResidenceAgeFields.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { LEGAL_INSTRUMENTS } from "../src/lib/legalInstruments.js";
import { InvitationAcceptView } from "../src/views/InvitationAcceptView.jsx";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030 (findings 1,
// 10, 37, 67 and 115 of the Oct 29-30 role-play run): the age box appeared
// only after a failed submit or a state pick, the alert named a box nobody
// could see, the age text listed five other states as if they were the rule,
// a reload made the gate be filled twice, the invitation pages never named
// the organization, role or address, the recovery step pointed to a "chapter
// administrator", and the terms gate asked for five documents when one had
// changed.

// A fixed, low-entropy 43-character token: the shape the page accepts, and
// nothing the committed-secret scan reads as a key.
const TOKEN = "A".repeat(43);
const BAND = "I'm 13 or older, and if I'm under 18, my organization authorized this account.";
const reply = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) });

function Fields({ lang = "en", initialState = "" }) {
  const [residenceState, setResidenceState] = useState(initialState);
  const [ageAttested, setAgeAttested] = useState(false);
  return <LanguageProvider lang={lang}>
    <ResidenceAgeFields idPrefix="t" residenceState={residenceState} onResidenceState={setResidenceState} ageAttested={ageAttested} onAgeAttested={setAgeAttested} />
  </LanguageProvider>;
}

const stateBox = () => screen.getByRole("combobox");
const ageBox = () => screen.getByRole("checkbox");
const choose = (code) => fireEvent.change(stateBox(), { target: { value: code } });

afterEach(() => vi.unstubAllGlobals());

describe("the state and age fields", () => {
  it("shows the age box before any state, explains why the state is asked, and names no other states", () => {
    render(<Fields />);
    expect(ageBox()).toBeDisabled();
    expect(ageBox()).toHaveAccessibleName("Choose your state above to see the age statement for it.");
    const help = screen.getByText("We ask where you live because state law sets the minimum age. Adults 18 and over can join from any state.");
    expect(help).toBeVisible();
    // The state list names every state; no sentence names other states as if
    // they were the rule.
    for (const paragraph of document.querySelectorAll("p")) expect(paragraph.textContent).not.toMatch(/Texas|California|Alabama|Utah|Louisiana/u);
  });

  it.each([
    ["MA", "Massachusetts", "In Massachusetts, adults 18 and over can join. A person 13 to 17 can join only through an account their organization authorized.", BAND],
    ["WA", "Washington", "In Washington, adults 18 and over can join. A person 13 to 17 can join only through an account their organization authorized.", BAND],
    ["TX", "Texas", "In Texas, Union Ground is for adults 18 and over.", "I'm 18 or older."],
  ])("tells a person in %s the rule for their own state", (code, _name, line, statement) => {
    render(<Fields />);
    choose(code);
    expect(screen.getByText(line)).toBeVisible();
    expect(ageBox()).toBeEnabled();
    expect(ageBox()).toHaveAccessibleName(statement);
  });

  it("keeps the answer when the statement is the same, and asks again with a reason when it changes", () => {
    render(<Fields />);
    choose("MA");
    fireEvent.click(ageBox());
    choose("WA");
    expect(ageBox()).toBeChecked();
    expect(screen.queryByRole("status")).toBeNull();
    choose("TX");
    expect(ageBox()).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("The age statement for Texas is different, so check it again.");
    fireEvent.click(ageBox());
    expect(screen.queryByRole("status")).toBeNull();
    // Unsetting the state never leaves a checked box behind a sentence.
    choose("");
    expect(ageBox()).not.toBeChecked();
    expect(ageBox()).toBeDisabled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("speaks Spanish", () => {
    render(<Fields lang="es" />);
    expect(ageBox()).toHaveAccessibleName("Elige tu estado arriba para ver su declaración de edad.");
    choose("MA");
    expect(screen.getByText(/^En Massachusetts, las personas adultas de 18 años o más pueden unirse\./u)).toBeVisible();
  });
});

function renderGate(props = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><LegalAcceptancePrompt instruments={["privacy-policy"]} client={{ rpc: vi.fn() }} userId="member-a" {...props} /></LanguageProvider>);
}

// The paragraph whose whole text is `text`, across the address element.
const paragraph = (text) => screen.getByText((_, element) => element?.tagName === "P" && element.textContent === text);
const findParagraph = (text) => screen.findByText((_, element) => element?.tagName === "P" && element.textContent === text);

describe("the terms gate", () => {
  it("names the document that changed and says why the others are asked too", () => {
    renderGate();
    expect(screen.getByText(`Union Ground asks you to accept the current version of all ${LEGAL_INSTRUMENTS.length} documents together, so your acceptance records the full set. Documents marked unchanged are the same as before.`)).toBeVisible();
    const items = [...document.querySelectorAll(".legal-acceptance li")].map((item) => item.textContent);
    expect(items.filter((text) => text.endsWith("(changed)"))).toHaveLength(1);
    expect(items.filter((text) => text.endsWith("(unchanged)"))).toHaveLength(LEGAL_INSTRUMENTS.length - 1);
  });

  it("asks for every document plainly when all of them changed", () => {
    renderGate({ instruments: LEGAL_INSTRUMENTS.map((entry) => entry.key) });
    expect(screen.getByText(`Read the current version of all ${LEGAL_INSTRUMENTS.length} documents below and accept them to go on.`)).toBeVisible();
    expect(document.body.textContent).not.toContain("(unchanged)");
  });

  it("keeps the chosen state through a reload, and forgets it once the acceptance is recorded", async () => {
    const rpc = vi.fn(async () => ({ data: { recorded: true }, error: null }));
    const first = renderGate({ client: { rpc } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "MA" } });
    first.unmount();

    const onAccepted = vi.fn();
    renderGate({ client: { rpc }, onAccepted });
    expect(screen.getByRole("combobox")).toHaveValue("MA");
    // The agreements are never kept: they are given on the page in front of
    // the person.
    expect(screen.getAllByRole("checkbox").every((box) => !box.checked)).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Accept and continue" }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalled());
    expect(window.sessionStorage.getItem(LEGAL_ACCEPTANCE_DRAFT_KEY)).toBeNull();
  });

  // Another account in the same tab never inherits the
  // kept state.
  it("never hands one account's kept state to another account, or to no account", () => {
    const first = renderGate({ userId: "member-a" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "MA" } });
    first.unmount();
    const second = renderGate({ userId: "member-b" });
    expect(screen.getByRole("combobox")).toHaveValue("");
    second.unmount();
    renderGate({ userId: null });
    expect(screen.getByRole("combobox")).toHaveValue("");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "TX" } });
    expect(window.sessionStorage.getItem(LEGAL_ACCEPTANCE_DRAFT_KEY)).toBeNull();
  });

  it("drops a kept state that is expired, too far ahead, unlisted, someone else's or unreadable", () => {
    const now = 1_000_000;
    const keep = (value) => window.sessionStorage.setItem(LEGAL_ACCEPTANCE_DRAFT_KEY, typeof value === "string" ? value : JSON.stringify(value));
    keep({ userId: "member-a", residenceState: "MA", expiresAt: now + 1000 });
    expect(readAcceptanceDraftState("member-a", now)).toBe("MA");
    for (const value of [
      { userId: "member-a", residenceState: "MA", expiresAt: now - 1 },
      { userId: "member-a", residenceState: "MA", expiresAt: now + 16 * 60 * 1000 },
      { userId: "member-a", residenceState: "ZZ", expiresAt: now + 1000 },
      { userId: "member-b", residenceState: "MA", expiresAt: now + 1000 },
      { residenceState: "MA", expiresAt: now + 1000 },
      "{",
    ]) {
      keep(value);
      expect(readAcceptanceDraftState("member-a", now)).toBe("");
      expect(window.sessionStorage.getItem(LEGAL_ACCEPTANCE_DRAFT_KEY)).toBeNull();
    }
  });

  it("forgets the kept state when the choice is cleared", () => {
    renderGate();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "WA" } });
    expect(window.sessionStorage.getItem(LEGAL_ACCEPTANCE_DRAFT_KEY)).toContain("WA");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(window.sessionStorage.getItem(LEGAL_ACCEPTANCE_DRAFT_KEY)).toBeNull();
  });

  it("names only what is still missing, in Spanish too", () => {
    renderGate({}, "es");
    fireEvent.click(screen.getByRole("button", { name: "Aceptar y continuar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Marca “He leído la versión vigente y la acepto.” Elige el estado donde vives.");
  });
});

function renderInvite({ previewFetcher, fetcher = vi.fn().mockResolvedValue(reply({ accepted: true })), lang = "en" } = {}) {
  window.history.replaceState({}, "", `/invite#invite=${TOKEN}`);
  render(<LanguageProvider lang={lang}><InvitationAcceptView fetcher={fetcher} previewFetcher={previewFetcher} /></LanguageProvider>);
  return fetcher;
}

const PREVIEW = { organization: "Thornbury Nurses United", chapter: "Emergency", role: "steward", email: "nurse@example.com", inviter: "Rosa Diaz" };

async function acceptInvitation() {
  fireEvent.click(await screen.findByRole("checkbox", { name: /I have read the terms of use/u }));
  fireEvent.change(screen.getByRole("combobox", { name: "State where you live" }), { target: { value: "MA" } });
  fireEvent.click(screen.getByRole("checkbox", { name: BAND }));
  fireEvent.click(screen.getByRole("button", { name: "Agree and accept the invitation" }));
}

describe("the invitation pages", () => {
  it("name the organization, role, campaign, inviter and sign-in address before acceptance", async () => {
    const previewFetcher = vi.fn().mockResolvedValue(reply(PREVIEW));
    renderInvite({ previewFetcher });
    expect(await screen.findByText("Thornbury Nurses United invited you to join as Committee.")).toBeVisible();
    expect(screen.getByText("Campaign: Emergency.")).toBeVisible();
    expect(screen.getByText("Invited by Rosa Diaz.")).toBeVisible();
    expect(paragraph("You'll sign in with nurse@example.com.")).toBeVisible();
    // The address is one wrapping, selectable unit.
    expect(screen.getByText("nurse@example.com", { selector: "strong.iac-sent-address" })).toBeVisible();
    expect(previewFetcher).toHaveBeenCalledWith("/api/invitation-preview", expect.objectContaining({
      method: "POST", credentials: "omit", cache: "no-store", body: JSON.stringify({ token: TOKEN }),
    }));
  });

  it("names the sign-in address after acceptance", async () => {
    renderInvite({ previewFetcher: vi.fn().mockResolvedValue(reply(PREVIEW)) });
    await findParagraph("You'll sign in with nurse@example.com.");
    await acceptInvitation();
    expect(await findParagraph("Sign in with nurse@example.com.")).toBeVisible();
    expect(screen.getByText("Thornbury Nurses United invited you to join as Committee.")).toBeInTheDocument();
  });

  it("points a spent invitation to the person who sent it", async () => {
    renderInvite({
      previewFetcher: vi.fn().mockResolvedValue(reply(PREVIEW)),
      fetcher: vi.fn().mockResolvedValue(reply({ error: "invitation-unavailable" }, 410)),
    });
    await screen.findByText("Invited by Rosa Diaz.");
    await acceptInvitation();
    expect(await screen.findByText("It may have expired, been revoked, or already been used. Ask Rosa Diaz to send you a new invitation.")).toBeVisible();
  });

  it("asks the person who invited them when no inviter is known, in Spanish too", async () => {
    renderInvite({
      lang: "es",
      previewFetcher: vi.fn().mockResolvedValue(reply({ error: "invitation-unavailable" }, 410)),
      fetcher: vi.fn().mockResolvedValue(reply({ error: "invitation-unavailable" }, 410)),
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: /He leído|términos/u }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "MA" } });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(await screen.findByText("Puede haber vencido, haber sido revocada o ya haberse usado. Pide una nueva invitación a la persona que te invitó.")).toBeVisible();
  });

  it("shows nothing about the invitation when the preview fails or is malformed", async () => {
    renderInvite({ previewFetcher: vi.fn().mockRejectedValue(new Error("offline")) });
    await screen.findByRole("combobox");
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".iac-preview")).toBeNull();
    document.body.innerHTML = "";
    renderInvite({ previewFetcher: vi.fn().mockResolvedValue(reply({ organization: "  ", email: "a@b.c" })) });
    await screen.findByRole("combobox");
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector(".iac-preview")).toBeNull();
  });

  it("names an unknown role as Worker and leaves out what the server did not give", async () => {
    renderInvite({ previewFetcher: vi.fn().mockResolvedValue(reply({ organization: "Copperline Library Workers", email: "a@example.com", role: "owner" })) });
    expect(await screen.findByText("Copperline Library Workers invited you to join as Worker.")).toBeVisible();
    expect(screen.queryByText(/^Campaign:/u)).toBeNull();
    expect(screen.queryByText(/^Invited by/u)).toBeNull();
  });
});
