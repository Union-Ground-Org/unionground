// REQ-UG-REMIND-HERE-20261001 and REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001:
// the web surfaces. The server decides; these pin that the clients never post
// a /remind draft as chat, say why a reminder was refused, show the reminders
// that reached a reader, and show what automatic routing did.
import { expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { CaseStewardEmails } from "../src/components/CaseStewardEmails.jsx";
import { connectedReminderActions } from "../src/features/connectedWorkflows/actions.js";
import { remindHereRefusal } from "../src/features/messaging/remindHere.js";

const thread = {
  id: "thread-1",
  space_id: "space-1",
  title: "Overtime scheduling",
  kind: "issue",
  status: "open",
  posts: [{ id: "post-1", body: "Initial report", created_at: "2026-07-27T12:00:00Z" }],
};
const product = {
  spaces: [{ id: "space-1", name: "Workplace issues", description: "", visibility: "chapter", threads: [thread] }],
  documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [],
};
const data = {
  member: { id: "user-1", initials: "SA", fullName: "Steward A" },
  roles: ["steward"],
  conversations: [],
  broadcasts: [],
  product,
};
const en = catalogue.en;
const wrap = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);

function openThread({ roles = ["steward"], messagingApi, organizationConfiguration, onSendPost = vi.fn(), onNotice = vi.fn() } = {}) {
  wrap(<ProductHubView
    data={{ ...data, roles, organizationConfiguration }}
    onSendPost={onSendPost}
    onNotice={onNotice}
    messagingApi={messagingApi}
    onCreateSpace={vi.fn()}
    onCreateThread={vi.fn()}
  />);
  fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
  const box = screen.getByRole("textbox");
  return {
    onSendPost,
    onNotice,
    submit: (value) => {
      fireEvent.change(box, { target: { value } });
      fireEvent.submit(box.closest("form"));
    },
  };
}

describe("/remind here in a channel thread (web)", () => {
  // Record 8435, slice 9: a reminder that throws at once leaves a ready Reply
  // whose next press sets it again.
  it("sets the reminder again from an immediate press after one that throws at once", async () => {
    const messagingApi = { remindHere: vi.fn() };
    openThread({ messagingApi });
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/remind here in 2h bring the overtime binder" } });
    const reply = within(box.closest("form")).getByRole("button", { name: "Reply" });
    await expectReadyRetryAfterThrowAtOnce(messagingApi.remindHere, reply);
  });

  it("sets a channel staff reminder instead of posting the draft", async () => {
    const messagingApi = { remindHere: vi.fn().mockResolvedValue({ id: "r-1", coalesced: false }) };
    const view = openThread({ messagingApi });
    expect(screen.getByText(en["remindHere.hint"])).toBeInTheDocument();
    const before = Date.now();
    view.submit("/remind here in 2h bring the overtime binder");
    await waitFor(() => expect(messagingApi.remindHere).toHaveBeenCalledTimes(1));
    const [spaceId, at, note] = messagingApi.remindHere.mock.calls[0];
    expect(spaceId).toBe("space-1");
    expect(note).toBe("bring the overtime binder");
    expect(Date.parse(at) - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1_000);
    expect(view.onSendPost).not.toHaveBeenCalled();
    await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith(expect.stringContaining("bring the overtime binder")));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("keeps a malformed or personal command out of the channel and explains it", async () => {
    const messagingApi = { remindHere: vi.fn() };
    const view = openThread({ messagingApi });
    view.submit("/remind here sometime");
    expect(await screen.findByRole("alert")).toHaveTextContent(en["remindHere.error.missing_time"]);
    view.submit("/remind me in 5m call Ana");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Remind me…/);
    view.submit("/remind help");
    expect(await screen.findByText(en["remindHere.usage"])).toBeInTheDocument();
    expect(messagingApi.remindHere).not.toHaveBeenCalled();
    expect(view.onSendPost).not.toHaveBeenCalled();
  });

  it("says why the server refused, by reason", async () => {
    for (const [error, key] of [
      [{ code: "42501", details: "feature-disabled" }, "remindHere.refusal.off"],
      [{ code: "42501", details: "staff-required" }, "remindHere.refusal.staff"],
      [{ code: "54000" }, "remindHere.refusal.limit"],
    ]) {
      const messagingApi = { remindHere: vi.fn().mockRejectedValue(error) };
      const view = openThread({ messagingApi });
      view.submit("/remind here tomorrow 9am agenda");
      expect(await screen.findByRole("alert")).toHaveTextContent(en[key]);
      cleanup();
    }
    expect(remindHereRefusal({ code: "22023" })).toBe("invalid");
    expect(remindHereRefusal(new Error("network"))).toBe("failed");
  });

  it("shows the staff tip only to staff, with the switch on and a live client", () => {
    openThread({ messagingApi: { remindHere: vi.fn() }, organizationConfiguration: { switches: { "features.messaging.remind_here": false } } });
    expect(screen.queryByText(en["remindHere.hint"])).toBeNull();
    cleanup();
    openThread({ roles: [], messagingApi: { remindHere: vi.fn() } });
    expect(screen.queryByText(en["remindHere.hint"])).toBeNull();
    cleanup();
    openThread({ messagingApi: {} });
    expect(screen.queryByText(en["remindHere.hint"])).toBeNull();
  });

  it("offers only complete and cancel on the owner's channel reminder", () => {
    expect(connectedReminderActions({ id: "r", kind: "channel_here", status: "scheduled" }).map((a) => a.id)).toEqual(["complete", "cancel"]);
    expect(connectedReminderActions({ id: "r", kind: "channel_here", status: "cancelled" })).toEqual([]);
    expect(connectedReminderActions({ id: "r", kind: "task", status: "scheduled" }).map((a) => a.id)).toContain("snooze");
  });
});

describe("channel staff reminders in the Messages inbox", () => {
  it("lists reminders that reached the reader, with the note, and no cancel control", async () => {
    const messagingApi = { cancelReminder: vi.fn() };
    const channelReminders = [{
      id: "r-1", note: "Bring the overtime binder", remindAt: "2026-10-02T13:00:00Z", deliveredAt: "2026-10-02T13:00:30Z",
      spaceId: "space-1", spaceName: "Workplace issues", authorName: "Ana Steward", mine: false,
    }];
    const onOpenTopics = vi.fn();
    wrap(<MessagesView data={{ ...data, messageReminders: [], channelReminders }} messagingApi={messagingApi} onOpenTopics={onOpenTopics} onNotice={vi.fn()} />);
    const row = await screen.findByRole("button", { name: /Reminder from Ana Steward · #Workplace issues/ });
    expect(within(row).getByText("Bring the overtime binder")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en["inbox.cancelReminder"] })).toBeNull();
    fireEvent.click(row);
    expect(onOpenTopics).toHaveBeenCalledTimes(1);
  });
});

describe("steward email routing in the review queue", () => {
  function api(rows) {
    return {
      loadDesk: vi.fn().mockResolvedValue({ queue: [], threads: [], broadcasts: [], formsInbox: [], kpis: {} }),
      listScheduled: vi.fn().mockResolvedValue([]),
      listEmailIntakes: vi.fn().mockResolvedValue(rows),
      reviewEmailIntake: vi.fn(),
    };
  }

  it("says which case an email was attached to, that a draft was made, or why it was held", async () => {
    render(<StewardView data={{ member: { initials: "SO" } }} onNotice={() => {}} api={api([
      { id: "e-1", status: "accepted", subject: "Evidence", from: "steward@example.test", text: "Evidence for GR-2026-40917", receivedAt: "2026-10-02T12:00:00Z",
        autoRoutedAt: "2026-10-02T12:00:01Z", routedCase: { id: "c-1", reference: "GR-2026-40917" }, caseAttached: true, knowledgeDraft: true, routeHold: null },
      { id: "e-2", status: "pending", subject: "Two cases", from: "steward@example.test", text: "Evidence", receivedAt: "2026-10-02T11:00:00Z",
        autoRoutedAt: null, routedCase: null, caseAttached: false, knowledgeDraft: false, routeHold: "case_ambiguous" },
      { id: "e-3", status: "accepted", subject: "Restricted", from: "steward@example.test", text: "Evidence", receivedAt: "2026-10-02T10:00:00Z",
        autoRoutedAt: "2026-10-02T10:00:01Z", routedCase: null, caseAttached: true, knowledgeDraft: false, routeHold: null },
      { id: "e-4", status: "pending", subject: "Plain", from: "member@example.test", text: "Hello", receivedAt: "2026-10-02T09:00:00Z",
        autoRoutedAt: null, routedCase: null, caseAttached: false, knowledgeDraft: false, routeHold: null },
    ])} />);
    const notes = await screen.findAllByTestId("email-intake-route");
    expect(notes.map((node) => node.textContent)).toEqual([
      `${en["steward.emailRouteAuto"]} · Attached to issue GR-2026-40917 · ${en["steward.emailRouteKnowledge"]}`,
      en["steward.emailRouteHold.case_ambiguous"],
      `${en["steward.emailRouteAuto"]} · ${en["steward.emailRouteCaseHidden"]}`,
    ]);
  });
});

describe("steward email on the staff case tools", () => {
  it("shows attached email to staff and nothing when there is none", async () => {
    const load = vi.fn().mockResolvedValue([{ id: "e-1", from: "steward@example.test", subject: "Discipline letter", text: "Attached as evidence.", receivedAt: "2026-10-02T12:00:00Z", autoRoutedAt: "2026-10-02T12:00:01Z" }]);
    wrap(<CaseStewardEmails caseId="c-1" api={{ loadCaseStewardEmails: load }} />);
    expect(await screen.findByRole("heading", { name: en["caseEmails.title"] })).toBeInTheDocument();
    expect(screen.getByText("Attached as evidence.")).toBeInTheDocument();
    expect(screen.getByText("From steward@example.test")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith("c-1");
    cleanup();
    const empty = vi.fn().mockResolvedValue([]);
    const { container } = wrap(<CaseStewardEmails caseId="c-2" api={{ loadCaseStewardEmails: empty }} />);
    await waitFor(() => expect(empty).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("offers a retry when the read fails", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    wrap(<CaseStewardEmails caseId="c-1" api={{ loadCaseStewardEmails: load }} />, "es");
    fireEvent.click(await screen.findByRole("button", { name: catalogue.es["caseEmails.retry"] }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
