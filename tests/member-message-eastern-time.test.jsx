import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); window.history.replaceState({}, "", "/m"); });
const winter = "2026-01-15T17:05:00Z";
const summer = "2026-07-15T17:05:00Z";

it.each(["America/Los_Angeles", "Asia/Tokyo"].flatMap((zone) => ["en", "es"].map((lang) => [zone, lang])))(
  "keeps member inbox, direct, scheduled, peer and task times Eastern in %s / %s", async (zone, lang) => {
    vi.stubEnv("TZ", zone);
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function(locale, options) {
      return new NativeDateTimeFormat(locale, { timeZone: zone, ...options });
    });
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
    const expected = lang === "es" ? "15 ene 2026, 12:05 p. m. EST" : "Jan 15, 2026, 12:05 PM EST";
    const summerExpected = lang === "es" ? "15 jul 2026, 1:05 p. m. EDT" : "Jul 15, 2026, 1:05 PM EDT";
    const data = {
      member: { id: "tamarack-member" }, broadcasts: [], product: { spaces: [], documents: [] },
      conversations: [{ id: "direct", sender: "Tamarack steward", initials: "TS", unread: 0, dateLabel: "Jan 15",
        messages: [{ id: "winter", body: "Winter message", sender_kind: "steward", created_at: winter },
          { id: "summer", body: "Summer message", sender_kind: "member", created_at: summer }],
        scheduled: [{ id: "schedule", body: "Scheduled message", scheduled_for: winter, status: "pending" }],
      }],
      tasks: [{ id: "task", title: "Tamarack follow-up" }],
      taskMessages: [{ id: "task-message", taskId: "task", senderId: "tamarack-member", recipientId: "steward", body: "Task reply", createdAt: winter }],
      peerContact: { conversations: [{ id: "peer", peerName: "Tamarack peer", updatedAt: winter,
        messages: [{ id: "peer-message", body: "Peer reply", createdAt: summer }] }] },
    };
    const show = (focus) => render(<LanguageProvider lang={lang}><MessagesView data={data} desktop focus={focus}
      onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onSendMessage={vi.fn()} onOpenTopics={vi.fn()}
      peerContactApi={{ send: vi.fn() }} /></LanguageProvider>);
    show({ conversationId: "direct" });
    const direct = await screen.findByText("Winter message");
    expect(direct.closest("article").querySelector("time")).toHaveTextContent(expected);
    expect(screen.getByText("Summer message").closest("article").querySelector("time")).toHaveTextContent(summerExpected);
    expect(document.querySelector(".inbox-scheduled__row p")).toHaveTextContent(`${expected} · Scheduled message`);
    expect([...document.querySelectorAll(".inbox-row time")].map((node) => node.textContent)).toEqual(expect.arrayContaining([expected, summerExpected]));
    cleanup();
    show({ peerConversationId: "peer" });
    fireEvent.click(await screen.findByText("Tamarack peer", { selector: ".inbox-row__name" }));
    expect(screen.getByText("Peer reply", { selector: "article p" }).closest("article").querySelector("time")).toHaveTextContent(summerExpected);
    cleanup();
    window.history.replaceState({}, "", "/m/messages?taskThread=task");
    show();
    const task = await screen.findByRole("dialog", { name: "Tamarack follow-up" });
    expect(within(task).getByText("Task reply").closest("article").querySelector("time")).toHaveTextContent(expected);
  },
);
