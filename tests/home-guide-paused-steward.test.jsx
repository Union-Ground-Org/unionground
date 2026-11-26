// BUG-UG-HOME-GUIDE-NAMES-PAUSED-STEWARD-20261103 (#6876): Home's
// guide told a new member to "Ask Ezra Lindqvist, your steward" when the
// chapter's only steward was paused (two-step sign-in unfinished), and the
// steward message box failed only after Start conversation. The app now reads
// the send path's own rule (get_member_steward_message_available): no steward
// is named and the box warns before the member writes. Fictional people.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memberFeatureGuides } from "../src/features/onboardingGuideEngine/memberLayers.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { getMemberStewardMessageAvailable } from "../src/lib/memberApi.js";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { guideSteward } from "../src/lib/stewardConversations.js";
import { MessagesView } from "../src/views/MessagesView.jsx";

const EZRA = { id: "u-ezra", name: "Ezra Lindqvist" };
const ME = { id: "u-me", name: "Grad Worker" };
const UPFRONT_EN = "No committee member in your campaign can receive messages right now, so a message here would not be sent. To reach someone now, contact your campaign's officers, such as the campaign lead or Admin.";
const UPFRONT_ES = "Ningún miembro del comité de tu campaña puede recibir mensajes ahora, así que un mensaje aquí no se enviaría. Para comunicarte con alguien ahora, contacta a los dirigentes de tu campaña, como el líder de la campaña o la administración de la campaña.";
const NAMED_EN = "No committee member in your campaign can receive messages right now, so a message here would wait unread until one can. To reach someone now, contact your campaign's officers, such as the campaign lead or Admin.";
const NAMED_ES = "Ningún miembro del comité de tu campaña puede recibir mensajes ahora, así que un mensaje aquí esperaría sin leerse hasta que alguno pueda. Para comunicarte con alguien ahora, contacta a los dirigentes de tu campaña, como el líder de la campaña o la administración de la campaña.";
const LEADERSHIP = {
  chapterId: "ash-local",
  chapterName: "Ashgrove Local",
  people: [{ id: "u-pres", name: "Priya Halvorsen", title: "President", president: true, administrator: false, organizationAdministrator: false, canMessage: true, contact: { email: null, phone: null } }],
};

describe("the steward the guide may name", () => {
  it("names the chapter's one steward only while a steward message could be read", () => {
    expect(guideSteward([EZRA], ME.id, true)).toBe(EZRA);
    // Unknown (a failed check, or a deployment before the RPC) keeps the name.
    expect(guideSteward([EZRA], ME.id, null)).toBe(EZRA);
    expect(guideSteward([EZRA], ME.id)).toBe(EZRA);
    // The paused-steward case: the server says nobody could read it.
    expect(guideSteward([EZRA], ME.id, false)).toBeNull();
    // Never the viewer, and only when there is exactly one.
    expect(guideSteward([ME], ME.id, true)).toBeNull();
    expect(guideSteward([EZRA, { id: "u-2", name: "Second Steward" }], ME.id, true)).toBeNull();
    expect(guideSteward([], ME.id, true)).toBeNull();
    expect(guideSteward(null, null, true)).toBeNull();
  });

  it("leaves the member guide with no 'your steward' line when no steward is named", () => {
    const named = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, stewardName: guideSteward([EZRA], ME.id, true)?.name ?? null }).view.items;
    expect(named.some((item) => item.askWho !== null && JSON.stringify(item.askWho).includes("Ezra Lindqvist"))).toBe(true);
    const paused = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, stewardName: guideSteward([EZRA], ME.id, false)?.name ?? null }).view.items;
    expect(paused.every((item) => item.askWho === null)).toBe(true);
    expect(JSON.stringify(paused)).not.toContain("Ezra Lindqvist");
  });
});

describe("getMemberStewardMessageAvailable", () => {
  const client = (answer) => ({ rpc: vi.fn(async () => answer) });

  it("returns the server's answer and calls the one RPC", async () => {
    const yes = client({ data: true, error: null });
    await expect(getMemberStewardMessageAvailable(yes)).resolves.toBe(true);
    expect(yes.rpc).toHaveBeenCalledWith("get_member_steward_message_available");
    await expect(getMemberStewardMessageAvailable(client({ data: false, error: null }))).resolves.toBe(false);
  });

  it("is unknown (null) on an error, an unexpected shape or a thrown call", async () => {
    await expect(getMemberStewardMessageAvailable(client({ data: null, error: { code: "PGRST202", message: "function not found" } }))).resolves.toBeNull();
    await expect(getMemberStewardMessageAvailable(client({ data: "false", error: null }))).resolves.toBeNull();
    await expect(getMemberStewardMessageAvailable({ rpc: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) })).resolves.toBeNull();
  });
});

function messages({ available, lang = "en", officers = true, onStartConversation = vi.fn(), focus = null } = {}) {
  render(
    <LanguageProvider lang={lang}>
      <MessagesView
        data={{ member: { id: ME.id }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] } }}
        focus={focus}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        onStartConversation={onStartConversation}
        onStartStewardConversation={vi.fn()}
        stewardMessageAvailable={available}
        officerDirectoryApi={officers ? { load: vi.fn(async () => LEADERSHIP) } : null}
        onStartOfficerConversation={officers ? vi.fn() : null}
      />
    </LanguageProvider>,
  );
  return { onStartConversation };
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("the steward message box when no steward can receive messages", () => {
  it("says so before the member writes and offers the chapter's officers", async () => {
    messages({ available: false });
    const form = document.querySelector(".inbox-first");
    const notice = form.querySelector(".inbox-first__unavailable");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent(UPFRONT_EN);
    // The warning comes before the box, not after Start conversation.
    const box = within(form).getByLabelText("First message to your committee contact");
    expect(notice.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The box is described by the warning as well as the visibility line.
    const describedBy = box.getAttribute("aria-describedby").split(" ");
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[0])).toHaveTextContent(UPFRONT_EN);
    expect(await within(notice).findByText("Priya Halvorsen")).toBeInTheDocument();
    // Nothing has been sent yet, so none of the refusal's wording.
    expect(notice).not.toHaveTextContent("was not sent");
    expect(notice).not.toHaveTextContent("No committee member is assigned to your campaign yet");
    fireEvent.click(within(notice).getByRole("button", { name: /Priya Halvorsen/ }));
    expect(await screen.findByRole("heading", { name: /Priya Halvorsen/ })).toBeInTheDocument();
  });

  it("warns on the named steward's start form that the message would wait unread, since that write is stored", () => {
    messages({ available: false, focus: { view: "messages", startStewardUserId: EZRA.id, stewardName: EZRA.name } });
    const section = screen.getByRole("heading", { name: "Start a conversation with Ezra Lindqvist" }).closest("section");
    const notice = section.querySelector(".inbox-first__unavailable");
    expect(notice).toHaveTextContent(NAMED_EN);
    expect(notice).not.toHaveTextContent("would not be sent");
    cleanup();
    messages({ available: false, lang: "es", officers: false, focus: { view: "messages", startStewardUserId: EZRA.id, stewardName: EZRA.name } });
    expect(screen.getByRole("heading", { name: "Inicia una conversación con Ezra Lindqvist" }).closest("section").querySelector(".inbox-first__unavailable")).toHaveTextContent(NAMED_ES);
  });

  it("says the same in Spanish, and still warns without an officer directory", () => {
    messages({ available: false, lang: "es", officers: false });
    expect(document.querySelector(".inbox-first .inbox-first__unavailable")).toHaveTextContent(UPFRONT_ES);
  });


  it.each([true, null])("shows no warning when availability is %s", (available) => {
    messages({ available });
    expect(screen.queryByText(UPFRONT_EN)).toBeNull();
  });
});
