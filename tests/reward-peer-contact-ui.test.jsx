import { expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";

const baseData = {
  member: { id: "member-1" },
  conversations: [],
  broadcasts: [],
  product: { spaces: [], documents: [] },
  peerContact: {
    available: true,
    canRequest: true,
    code: "PSG-0123456789ABCDEF0123",
    incoming: [{ id: "request-1", requesterName: "Alex Rivera", requesterInitials: "AR", createdAt: "2026-08-12T12:00:00Z" }],
    outgoing: [],
    conversations: [],
  },
};

function renderView({ lang = "en", data = baseData, api = {} } = {}) {
  const peerContactApi = {
    request: vi.fn().mockResolvedValue({ requested: true, id: "outgoing-1", createdAt: "2026-08-12T13:00:00Z" }),
    respond: vi.fn().mockResolvedValue({ accepted: false }),
    send: vi.fn().mockResolvedValue({ message: null }),
    ...api,
  };
  render(
    <LanguageProvider lang={lang}>
      <MessagesView data={data} desktop onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} peerContactApi={peerContactApi} />
    </LanguageProvider>,
  );
  if (data.peerContact) fireEvent.click(screen.getByRole("button", { name: /^(Contacts|Contactos)/ }));
  return peerContactApi;
}

describe("im-anyone consent UI", () => {
  it("shows only the worker's share code and never exposes a directory or profile fields", () => {
    renderView();
    expect(screen.getByRole("heading", { name: "Coworker contact" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your contact code")).toHaveValue("PSG-0123456789ABCDEF0123");
    expect(screen.getByLabelText("Another coworker's contact code")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/name|email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  // Record 8435, slice 9 review (F1): a request and an answer are independent
  // writes with their own locks and pending marks. A slow answer to one
  // person never holds back a request to another, and each settles only its
  // own control.
  it("sends a request to another member while an answer is still running, and each settles its own control", async () => {
    let finish;
    const api = renderView({ api: { respond: vi.fn(() => new Promise((resolve) => { finish = resolve; })) } });
    const code = screen.getByLabelText("Another coworker's contact code");
    fireEvent.change(code, { target: { value: "ug-abcdef0123456789abcd" } });
    const send = within(code.closest("form")).getByRole("button");
    const decline = screen.getByRole("button", { name: "Decline" });
    fireEvent.click(decline);
    expect(decline).toHaveAttribute("aria-disabled", "true");
    expect(send).not.toHaveAttribute("aria-disabled");
    fireEvent.click(send);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledWith("ug-abcdef0123456789abcd");
    await waitFor(() => expect(send).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByRole("button", { name: "Decline" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => { finish({ declined: true }); });
    expect(api.respond).toHaveBeenCalledTimes(1);
    // After both settle, a fresh Send with a valid code sends again.
    api.request.mockResolvedValueOnce({ requested: true, id: "outgoing-2", createdAt: "2026-08-12T14:00:00Z" });
    fireEvent.change(code, { target: { value: "ug-0123456789abcdef0123" } });
    await waitFor(() => expect(send).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(send);
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(api.request).toHaveBeenLastCalledWith("ug-0123456789abcdef0123");
    await act(async () => {});
  });

  it("sends both a request and an answer started in the same tick", async () => {
    let finish;
    const api = renderView({ api: { respond: vi.fn(() => new Promise((resolve) => { finish = resolve; })) } });
    const code = screen.getByLabelText("Another coworker's contact code");
    fireEvent.change(code, { target: { value: "ug-abcdef0123456789abcd" } });
    const send = within(code.closest("form")).getByRole("button");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Decline" })); fireEvent.click(send); });
    expect(api.respond).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ declined: true }); });
    // After both settle, a fresh Send with a valid code sends again.
    api.request.mockResolvedValueOnce({ requested: true, id: "outgoing-2", createdAt: "2026-08-12T14:00:00Z" });
    fireEvent.change(code, { target: { value: "ug-0123456789abcdef0123" } });
    await waitFor(() => expect(send).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(send);
    expect(api.request).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });

  // Ledger 422: the request and the answers keep their own notices, so a
  // request that succeeds does not replace a failed answer's alert.
  it("keeps a failed answer's alert when a request succeeds after it", async () => {
    const api = renderView({ api: { respond: vi.fn().mockRejectedValue(Object.assign(new Error("Member contact: authentication required"), { code: "42501" })) } });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your answer was not saved. Try again.");
    const code = screen.getByLabelText("Another coworker's contact code");
    fireEvent.change(code, { target: { value: "ug-abcdef0123456789abcd" } });
    fireEvent.click(within(code.closest("form")).getByRole("button"));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Contact request sent without revealing either profile.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your answer was not saved. Try again.");
  });

  it("in Spanish, says a refused answer and a failed answer apart, without the code sentence", async () => {
    renderView({ lang: "es", api: { respond: vi.fn().mockResolvedValue({ accepted: false }) } });
    fireEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Esa respuesta no se guardó.");
    cleanup();
    renderView({ lang: "es", api: { respond: vi.fn().mockRejectedValue(new Error("Failed to fetch")) } });
    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos confirmar que tu respuesta se guardó. Revisa si la solicitud sigue esperando antes de volver a responder.");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Revisa el código/);
  });

  //: a throw with no code may have saved; a throw after the server
  // confirmed the answer is not a failed answer.
  it("tells a lost reply as unconfirmed", async () => {
    renderView({ api: { respond: vi.fn().mockRejectedValue(new Error("Failed to fetch")) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn’t confirm that your answer was saved. Check whether the request is still waiting before you answer again.");
  });

  it("tells a throw after the server saved the answer as saved", async () => {
    let reads = 0;
    const conversation = { peerName: "Alex Rivera", peerInitials: "AR", messages: [], updatedAt: "2026-08-12T13:00:00Z", get id() { reads += 1; if (reads === 1) throw new Error("open failed"); return "peer-1"; } };
    renderView({ api: { respond: vi.fn().mockResolvedValue({ accepted: true, conversation }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your answer was saved, but this screen could not update. Reopen Contacts to see it.");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/not saved/);
  });

  it("answers again from an immediate press after an answer that throws at once", async () => {
    const api = renderView();
    await expectReadyRetryAfterThrowAtOnce(api.respond, screen.getByRole("button", { name: "Accept" }));
  });

  it("requests again from an immediate press after a request that throws at once", async () => {
    const api = renderView();
    const code = screen.getByLabelText("Another coworker's contact code");
    fireEvent.change(code, { target: { value: "ug-abcdef0123456789abcd" } });
    await expectReadyRetryAfterThrowAtOnce(api.request, within(code.closest("form")).getByRole("button"));
  });

  it("submits an exact code once and keeps every refusal uniform", async () => {
    const api = renderView({ api: { request: vi.fn().mockRejectedValue(new Error("contact request unavailable")) } });
    const code = screen.getByLabelText("Another coworker's contact code");
    fireEvent.change(code, { target: { value: "psg-abcdef0123456789abcd" } });
    fireEvent.submit(code.closest("form"));
    await waitFor(() => expect(api.request).toHaveBeenCalledWith("psg-abcdef0123456789abcd"));
    expect(await screen.findByRole("alert")).toHaveTextContent("That contact request is unavailable. Check the code or try again later.");
  });

  it("adds a successful request without identity and handles an explicit decline", async () => {
    const api = renderView({ api: {
      request: vi.fn().mockResolvedValue({ requested: true, id: "outgoing-2", createdAt: "2026-08-12T13:00:00Z" }),
      respond: vi.fn().mockResolvedValue({ accepted: false, declined: true }),
    } });
    const code = screen.getByLabelText("Another coworker's contact code");
    fireEvent.change(code, { target: { value: "PSG-ABCDEF0123456789ABCD" } });
    fireEvent.submit(code.closest("form"));
    expect(await screen.findByRole("status")).toHaveTextContent("Contact request sent without revealing either profile");
    expect(code).toHaveValue("");
    expect(screen.getByText(/^Pending ·/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith("request-1", false));
    expect(screen.queryByRole("group", { name: "Contact request from Alex Rivera" })).not.toBeInTheDocument();
  });

  //  W8-7: an answer the server refused said "Check the code", though the
  // member typed no code. Every server refusal still reads the same sentence.
  it("keeps failed acceptance and failed sends uniform in the UI", async () => {
    const refused = renderView({ api: { respond: vi.fn().mockResolvedValue({ accepted: false }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That answer was not saved.");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Check the code|can't be answered/);
    expect(refused.respond).toHaveBeenCalledWith("request-1", true);
    cleanup();

    const refusedDecline = renderView({ api: { respond: vi.fn().mockResolvedValue({ accepted: false, reason: "contact request unavailable" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That answer was not saved.");
    expect(screen.getByRole("group", { name: "Contact request from Alex Rivera" })).toBeInTheDocument();
    expect(refusedDecline.respond).toHaveBeenCalledWith("request-1", false);
    cleanup();

    const conversation = { id: "peer-failed-send", peerName: "Alex Rivera", peerInitials: "AR", messages: [], updatedAt: "2026-08-12T13:00:00Z" };
    const data = { ...baseData, peerContact: { ...baseData.peerContact, incoming: [], conversations: [conversation] } };
    const api = renderView({ data, api: {
      respond: vi.fn().mockResolvedValue({ accepted: false }),
      send: vi.fn().mockRejectedValue(Object.assign(new Error("uniform"), { code: "22023" })),
    } });
    fireEvent.click(screen.getByRole("button", { name: /Alex Rivera/ }));
    const composer = await screen.findByLabelText("Write a private message to a coworker…");
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass("inbox-send");
    fireEvent.change(composer, { target: { value: "Message that fails" } });
    fireEvent.submit(composer.closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("message could not be sent");
    expect(api.send).toHaveBeenCalledWith("peer-failed-send", "Message that fails", expect.any(String));
  });

  it("announces both native copy success and manual-copy fallback", async () => {
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Contact code copied");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(baseData.peerContact.code);
    cleanup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Select and copy your contact code");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: original });
  });

  it("requires explicit recipient acceptance before opening a peer composer", async () => {
    const conversation = { id: "peer-1", peerName: "Alex Rivera", peerInitials: "AR", messages: [], updatedAt: "2026-08-12T13:00:00Z" };
    const api = renderView({ api: { respond: vi.fn().mockResolvedValue({ accepted: true, conversation }) } });
    expect(screen.queryByLabelText("Write a private message to a coworker…")).not.toBeInTheDocument();
    const request = screen.getByRole("group", { name: "Contact request from Alex Rivera" });
    fireEvent.click(within(request).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(api.respond).toHaveBeenCalledWith("request-1", true));
    fireEvent.click(await screen.findByRole("button", { name: /Alex Rivera/ }));
    expect(await screen.findByLabelText("Write a private message to a coworker…")).toBeInTheDocument();
  });

  it("renders the whole consent flow in Spanish", () => {
    renderView({ lang: "es" });
    expect(screen.getByRole("heading", { name: "Contacto entre compañeros" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tu código de contacto")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aceptar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument();
  });

  it("keeps controls keyboard-native, named, and at least 44px by contract", () => {
    renderView();
    for (const button of [screen.getByRole("button", { name: "Send request" }), screen.getByRole("button", { name: "Accept" }), screen.getByRole("button", { name: "Decline" })]) {
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", expect.stringMatching(/button|submit/));
      expect(button.className).toContain("peer-contact__action");
    }
  });

  it("uses unique label targets when paired desktop and phone instances coexist", () => {
    const props = { data: baseData, onSendMessage: vi.fn(), onReadConversation: vi.fn(), onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(), peerContactApi: {} };
    render(<LanguageProvider lang="en"><><MessagesView {...props} desktop /><MessagesView {...props} /></></LanguageProvider>);
    for (const button of screen.getAllByRole("button", { name: /^Contacts/ })) fireEvent.click(button);
    const ownCodes = screen.getAllByLabelText("Your contact code");
    const requestCodes = screen.getAllByLabelText("Another coworker's contact code");
    expect(new Set(ownCodes.map((input) => input.id)).size).toBe(2);
    expect(new Set(requestCodes.map((input) => input.id)).size).toBe(2);
    for (const input of [...ownCodes, ...requestCodes]) {
      expect(input.id).not.toBe("");
      expect([...document.querySelectorAll("[id]")].filter((element) => element.id === input.id)).toHaveLength(1);
    }
  });

  // BUG-UG-TWO-PERSON-CONVERSATIONS-HAVE-NO-LEAVE-OR-BLOCK-RULE-20261118 .
  function openPeer(state, api = {}, lang = "en") {
    const conversation = { id: "peer-safety", peerName: "Alex Rivera", peerInitials: "AR", state, updatedAt: "2026-08-12T13:00:00Z",
      messages: [{ id: "m-1", sentByMe: false, body: "Earlier words stay readable", createdAt: "2026-08-12T12:59:00Z" }] };
    const data = { ...baseData, peerContact: { ...baseData.peerContact, incoming: [], conversations: [conversation] } };
    const mocks = renderView({ data, lang, api });
    fireEvent.click(screen.getByRole("button", { name: /Alex Rivera/ }));
    return mocks;
  }

  it("shows a closed conversation read-only, without saying why", async () => {
    openPeer("closed", { setBlock: vi.fn() });
    expect(await screen.findByText("Earlier words stay readable", { selector: ".inbox-msg p" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This conversation is closed. You can still read it.");
    expect(screen.queryByLabelText("Write a private message to a coworker…")).not.toBeInTheDocument();
    expect(screen.queryByText(/blocked|left/i)).not.toBeInTheDocument();
    // A closed conversation can still be blocked, so it stays closed if the person returns.
    expect(screen.getByRole("button", { name: "Block Alex Rivera" })).toBeInTheDocument();
  });

  it("blocks only after a confirm step, then offers Unblock, which reopens the composer", async () => {
    const api = openPeer("open", {
      setBlock: vi.fn().mockResolvedValueOnce({ id: "peer-safety", state: "blocked_by_viewer" }).mockResolvedValueOnce({ id: "peer-safety", state: "open" }),
    });
    await screen.findByLabelText("Write a private message to a coworker…");
    fireEvent.click(screen.getByRole("button", { name: "Block Alex Rivera" }));
    expect(api.setBlock).not.toHaveBeenCalled();
    expect(screen.getByText("Block Alex Rivera? Neither of you will be able to send messages here, and they will see the conversation as closed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Write a private message to a coworker…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Block Alex Rivera" }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(await screen.findByText("You blocked Alex Rivera. Neither of you can send messages here.")).toBeInTheDocument();
    expect(api.setBlock).toHaveBeenLastCalledWith("peer-safety", true);
    expect(screen.queryByLabelText("Write a private message to a coworker…")).not.toBeInTheDocument();
    expect(screen.getByText("Earlier words stay readable", { selector: ".inbox-msg p" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
    expect(await screen.findByLabelText("Write a private message to a coworker…")).toBeInTheDocument();
    expect(api.setBlock).toHaveBeenLastCalledWith("peer-safety", false);
  });

  it("switches to the closed note when a send meets a conversation that closed meanwhile, keeping no false error", async () => {
    const closed = Object.assign(new Error("Member contact message: message unavailable"), { code: "22023", details: "peer_conversation_closed" });
    const api = openPeer("open", { send: vi.fn().mockRejectedValue(closed), setBlock: vi.fn() });
    const composer = await screen.findByLabelText("Write a private message to a coworker…");
    fireEvent.change(composer, { target: { value: "Too late" } });
    fireEvent.submit(composer.closest("form"));
    expect(await screen.findByText("This conversation is closed. You can still read it.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.send).toHaveBeenCalledWith("peer-safety", "Too late", expect.any(String));
  });

  it("retries the same private draft with its original operation ID and retires it after confirmation", async () => {
    const body = "See you tomorrow";
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Lost reply"))
      .mockResolvedValue({ message: { id: "saved", sentByMe: true, body, createdAt: "2026-08-12T13:01:00Z" } });
    openPeer("open", { send });
    const composer = await screen.findByLabelText("Write a private message to a coworker…");
    const submit = () => fireEvent.submit(composer.closest("form"));
    fireEvent.change(composer, { target: { value: body } });
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not confirm that your message was sent.");
    expect(composer).toHaveValue(body);
    submit();
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(send.mock.calls[0][2]).toMatch(/^[\da-f-]{36}$/i);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    fireEvent.change(composer, { target: { value: body } });
    submit();
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(send.mock.calls[2][2]).not.toBe(send.mock.calls[0][2]);
    expect(screen.getAllByText(body, { selector: ".inbox-msg p" })).toHaveLength(1);
  });

  //  round 1 (r1s4): a send still in flight when the viewer blocks comes
  // back closed; it must not turn the viewer's own block into a plain closed
  // note (which would swap Unblock for Block).
  it("keeps the viewer's own block when a slow send comes back closed after it", async () => {
    let refuse;
    const closed = Object.assign(new Error("Member contact message: message unavailable"), { code: "22023", details: "peer_conversation_closed" });
    openPeer("open", {
      send: vi.fn(() => new Promise((_resolve, reject) => { refuse = () => reject(closed); })),
      setBlock: vi.fn().mockResolvedValue({ id: "peer-safety", state: "blocked_by_viewer" }),
    });
    const composer = await screen.findByLabelText("Write a private message to a coworker…");
    fireEvent.change(composer, { target: { value: "Slow one" } });
    fireEvent.submit(composer.closest("form"));
    fireEvent.click(screen.getByRole("button", { name: "Block Alex Rivera" }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(await screen.findByText("You blocked Alex Rivera. Neither of you can send messages here.")).toBeInTheDocument();
    await act(async () => { refuse(); });
    expect(screen.getByText("You blocked Alex Rivera. Neither of you can send messages here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unblock" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block Alex Rivera" })).not.toBeInTheDocument();
  });

  it("keeps a failed block in place with an alert", async () => {
    openPeer("open", { setBlock: vi.fn().mockRejectedValue(new Error("busy")) });
    fireEvent.click(await screen.findByRole("button", { name: "Block Alex Rivera" }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That did not go through. Try again.");
    expect(screen.getByLabelText("Write a private message to a coworker…")).toBeInTheDocument();
  });

  it("treats a conversation with no state from an older server as open, and offers no block without the API", async () => {
    openPeer(undefined);
    expect(await screen.findByLabelText("Write a private message to a coworker…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Block/ })).not.toBeInTheDocument();
  });

  it("shows the closed, blocked and confirm copy in Spanish", async () => {
    openPeer("blocked_by_viewer", { setBlock: vi.fn() }, "es");
    expect(await screen.findByText("Bloqueaste a Alex Rivera. Ninguno de los dos puede enviar mensajes aquí.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desbloquear" })).toBeInTheDocument();
    cleanup();
    openPeer("closed", { setBlock: vi.fn() }, "es");
    expect(await screen.findByText("Esta conversación está cerrada. Todavía puedes leerla.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bloquear a Alex Rivera" }));
    expect(screen.getByText(/¿Bloquear a Alex Rivera\? Ninguno de los dos podrá/)).toBeInTheDocument();
  });

  it("keeps accepted conversations and sent messages in sync across paired instances", async () => {
    const conversation = { id: "peer-synced", peerName: "Alex Rivera", peerInitials: "AR", messages: [], updatedAt: "2026-08-12T13:00:00Z" };
    const peerContactApi = {
      respond: vi.fn().mockResolvedValue({ accepted: true, conversation }),
      send: vi.fn().mockResolvedValue({ message: { id: "peer-message-synced", sentByMe: true, body: "Shared across both surfaces", createdAt: "2026-08-12T13:01:00Z" } }),
    };
    let durableData = baseData;
    const onPeerContactChange = (peerContact) => { durableData = { ...durableData, peerContact }; };
    const props = { data: baseData, onSendMessage: vi.fn(), onReadConversation: vi.fn(), onReadBroadcast: vi.fn(), onOpenTopics: vi.fn(), peerContactApi, onPeerContactChange };
    render(<LanguageProvider lang="en"><><MessagesView {...props} desktop /><MessagesView {...props} /></></LanguageProvider>);
    for (const button of screen.getAllByRole("button", { name: /^Contacts/ })) fireEvent.click(button);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept", hidden: true })[0]);
    const composers = await screen.findAllByLabelText("Write a private message to a coworker…", {}, { timeout: 1_000 });
    expect(composers).toHaveLength(2);
    fireEvent.change(composers[0], { target: { value: "Shared across both surfaces" } });
    fireEvent.submit(composers[0].closest("form"));
    await waitFor(() => expect([...document.querySelectorAll(".inbox-msg p")].filter((message) => message.textContent === "Shared across both surfaces")).toHaveLength(2));

    // Both lazy route instances can unmount; App's durable projection must
    // repopulate a later Messages mount without waiting for another full boot.
    cleanup();
    renderView({ data: durableData, api: peerContactApi });
    fireEvent.click(screen.getByRole("button", { name: /Alex Rivera/ }));
    expect(await screen.findByText("Shared across both surfaces", { selector: ".inbox-msg p" })).toBeInTheDocument();
  });

  it("shows an honest unavailable state when the caller projection fails", () => {
    renderView({ data: { ...baseData, peerContact: { available: false, unavailable: true, canRequest: false, code: "", incoming: [], outgoing: [], conversations: [] } } });
    expect(screen.getByRole("status")).toHaveTextContent("Coworker contact could not be loaded");
    expect(screen.queryByLabelText("Your contact code")).not.toBeInTheDocument();
  });

  it("fails closed when an active projection omits optional rollout arrays", () => {
    renderView({ data: { ...baseData, peerContact: { available: true, canRequest: false } } });
    expect(screen.getByLabelText("Your contact code")).toHaveValue("");
    expect(screen.getByText("Sending a new contact request is open to committee members and campaign leaders. Share your code with one of them so they can reach out to you.")).toBeInTheDocument();
    expect(screen.getByText("No incoming contact requests.")).toBeInTheDocument();
    expect(screen.getByText("Accepted coworker conversations appear here.")).toBeInTheDocument();
  });

  // Peer contact stays because it is
  // one-to-one organizing. Union Ground has no points economy, so none of
  // its copy may read as a reward, perk, benefit or points unlock.
  it("reads as organizing, with no points, perk or reward wording, in both languages", async () => {
    const { catalogue } = await import("../src/lib/i18n.js");
    for (const lang of ["en", "es"]) {
      const keys = Object.keys(catalogue[lang]).filter((key) => key.startsWith("inbox.peer") || key.startsWith("inbox.contacts"));
      expect(keys.length, lang).toBeGreaterThan(20);
      for (const key of keys) {
        expect(catalogue[lang][key], `${lang} ${key}`).not.toMatch(/reward|perk|points?\b|unlock|redeem|benefit|recompensa|beneficio|puntos?\b|canje/i);
      }
    }
    renderView({ data: { ...baseData, peerContact: { ...baseData.peerContact, canRequest: false } } });
    expect(document.body.textContent).not.toMatch(/reward|perk|points?\b|unlock/i);
    cleanup();
    renderView({ lang: "es", data: { ...baseData, peerContact: { ...baseData.peerContact, canRequest: false } } });
    expect(screen.getByText(/Comparte tu código con una de ellas para que te contacte/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/recompensa|beneficio|puntos?\b/i);
  });

  it("deduplicates an accepted conversation already present in the projection", async () => {
    const conversation = { id: "peer-existing", peerName: "Alex Rivera", peerInitials: "AR", messages: undefined, updatedAt: "2026-08-12T13:00:00Z" };
    const data = { ...baseData, peerContact: { ...baseData.peerContact, conversations: [conversation] } };
    renderView({ data, api: { respond: vi.fn().mockResolvedValue({ accepted: true, conversation }) } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Alex Rivera/ })).toHaveLength(1));
    expect(screen.getByLabelText("Write a private message to a coworker…")).toBeInTheDocument();
    expect(screen.getAllByText("Accepted — write the first message.")).toHaveLength(2);
  });

  it("sends from a task conversation and opens its task board", async () => {
    const onSendTaskMessage = vi.fn().mockResolvedValue({ id: "task-message-2", taskId: "task-1", senderId: "member-1", recipientId: "steward-1", body: "Task follow-up", createdAt: "2026-08-12T14:00:00Z" });
    const onOpenTasks = vi.fn();
    const data = {
      ...baseData,
      peerContact: null,
      tasks: [{ id: "task-1", title: "Safety follow-up", status: "in_progress" }],
      taskMessages: [{ id: "task-message-1", taskId: "task-1", senderId: "steward-1", recipientId: "member-1", body: "Initial update", createdAt: "2026-08-12T12:00:00Z" }],
    };
    render(<MessagesView data={data} onSendMessage={vi.fn()} onSendTaskMessage={onSendTaskMessage} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenTasks={onOpenTasks} />);
    fireEvent.click(screen.getByRole("button", { name: /Safety follow-up/ }));
    const composer = await screen.findByPlaceholderText("Write a private update about this task…");
    fireEvent.change(composer, { target: { value: "Task follow-up" } });
    fireEvent.submit(composer.closest("form"));
    expect(await screen.findByText("Task follow-up")).toBeInTheDocument();
    expect(composer).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open campaign task board" }));
    expect(onOpenTasks).toHaveBeenCalledWith("task-1");
  });

  it("shows an in-place alert when a task conversation send fails and keeps the draft", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const onSendTaskMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const data = {
      ...baseData,
      peerContact: null,
      tasks: [{ id: "task-1", title: "Safety follow-up", status: "in_progress" }],
      taskMessages: [{ id: "task-message-1", taskId: "task-1", senderId: "steward-1", recipientId: "member-1", body: "Initial update", createdAt: "2026-08-12T12:00:00Z" }],
    };
    try {
      render(<MessagesView data={data} onSendMessage={vi.fn()} onSendTaskMessage={onSendTaskMessage} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Safety follow-up/ }));
      const composer = await screen.findByPlaceholderText("Write a private update about this task…");
      fireEvent.change(composer, { target: { value: "Draft that should stay" } });
      fireEvent.submit(composer.closest("form"));
      expect(await screen.findByRole("alert")).toHaveTextContent("That message could not be sent. Your draft is still here.");
      expect(composer).toHaveValue("Draft that should stay");
      expect(onSendTaskMessage).toHaveBeenCalledWith("task-1", "Draft that should stay");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });

  it("honors authorized conversation/broadcast deep links and explicit search focus", async () => {
    const conversation = {
      id: "conversation-deep-link",
      sender: "Chapter Steward",
      initials: "CS",
      preview: "Private update",
      dateLabel: "Now",
      unread: 1,
      messages: [],
    };
    const broadcast = {
      id: "broadcast-deep-link",
      sender: "Chapter Office",
      title: "Chapter notice",
      body: "Authorized notice",
      publishedAt: "2026-08-12T12:00:00Z",
      locale: "es",
      unread: true,
    };
    const data = { ...baseData, product: undefined, conversations: [conversation], broadcasts: [broadcast] };
    const onReadConversation = vi.fn().mockRejectedValue(new Error("read marker is best effort"));
    const onReadBroadcast = vi.fn().mockResolvedValue(undefined);

    window.history.replaceState({}, "", "/m/messages?conversation=conversation-deep-link");
    render(<LanguageProvider lang="en"><MessagesView data={data} desktop focus={{}} onSendMessage={vi.fn()} onReadConversation={onReadConversation} onReadBroadcast={onReadBroadcast} onOpenTopics={vi.fn()} /></LanguageProvider>);
    await waitFor(() => expect(onReadConversation).toHaveBeenCalledWith("conversation-deep-link"));
    expect(screen.getByText("Private conversation", { selector: ".inbox-detail__head-sub" })).toBeInTheDocument();
    cleanup();

    window.history.replaceState({}, "", "/m/messages?broadcast=broadcast-deep-link");
    render(<LanguageProvider lang="en"><MessagesView data={data} desktop focus={{ conversationId: "conversation-deep-link", broadcastId: "broadcast-deep-link" }} onSendMessage={vi.fn()} onReadConversation={onReadConversation} onReadBroadcast={onReadBroadcast} onOpenTopics={vi.fn()} /></LanguageProvider>);
    await waitFor(() => expect(onReadBroadcast).toHaveBeenCalledWith("broadcast-deep-link"));
    expect(screen.getByText("Authorized notice")).toBeInTheDocument();
  });

  it("opens each authorized saved-activity target without copying source content", async () => {
    const onOpenTopics = vi.fn();
    const conversation = { id: "conversation-saved", sender: "Steward", initials: "S", preview: "Private", dateLabel: "Now", unread: 0, messages: [] };
    const data = {
      ...baseData,
      conversations: [conversation],
      savedMessages: [
        { id: "saved-private", sourceKind: "private", targetId: conversation.id, available: true, preview: "Open private" },
        { id: "saved-channel", sourceKind: "channel", targetId: "thread-1", available: true, preview: "Open channel" },
        { id: "saved-task", sourceKind: "task", targetId: "task-2", available: true, preview: "Open task" },
      ],
      tasks: [{ id: "task-2", title: "Follow-up task", status: "to_do" }],
      taskMessages: [],
    };
    render(<LanguageProvider lang="en"><MessagesView data={data} desktop onSendMessage={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={onOpenTopics} /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: /Open private/ }));
    expect(screen.getByText("Private conversation", { selector: ".inbox-detail__head-sub" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open channel/ }));
    expect(onOpenTopics).toHaveBeenCalledWith("thread-1");
    fireEvent.click(screen.getByRole("button", { name: /Open task/ }));
    expect(await screen.findByRole("dialog", { name: "Follow-up task" })).toBeInTheDocument();
  });
});
