import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import {
  INBOX_TYPES,
  INBOX_TYPES_WITH_COUNTS,
  countUnreadInboxItems,
  inboxUnreadCount,
  isAnnouncementUnread,
  isInboxItemUnread,
  isRedactedMessage,
  isTaskMessageUnread,
  messageTimestamp,
  projectMessageBody,
  projectMessagePreview,
  readCursor,
  reactionKindForGlyph,
  redactionReasonOf,
  taskUnreadCount,
} from "../src/features/messaging/index.js";
import { runUnreadConformance } from "../src/features/messaging/unreadFixtures.js";

// SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904: the client half. A removed body
// arrives as an empty string plus a tombstone, and every surface that used to
// render text has to render the reason instead — in the reader's language,
// because the server sends a reason code and never prose.

const REDACTED_AT = "2026-09-05T18:00:00.000Z";

function makeData() {
  return {
    member: { id: "member-1" },
    conversations: [{
      id: "conv-1",
      counterpartRole: "steward",
      sender: "Chapter steward",
      initials: "CS",
      preview: "Now the employer owes a written Step 2 answer.",
      dateLabel: "Jul 12",
      unread: 1,
      messages: [
        {
          id: "m1",
          sender_kind: "member",
          sender_name: "Darnell Foster",
          // A stale/cached body next to a tombstone: the projection must win
          // over whatever body text a caller still has lying around.
          body: "They wrote me up again",
          created_at: "2026-07-11T10:00:00.000Z",
          read_at: "2026-07-11T10:05:00.000Z",
          redacted_at: REDACTED_AT,
          redaction_reason: "sender_removed",
        },
        {
          id: "m2",
          sender_kind: "steward",
          sender_name: "Chapter steward",
          body: "Now the employer owes a written Step 2 answer.",
          created_at: "2026-07-12T10:00:00.000Z",
          read_at: null,
        },
      ],
    }],
    broadcasts: [{
      id: "b-1",
      title: "July chapter meeting",
      sender: "Harborview Care United",
      body: "Thursday 6pm at the hall.",
      unread: true,
      publishedAt: "2026-07-10T18:00:00.000Z",
    }],
    savedMessages: [{
      id: "saved-1",
      sourceKind: "private",
      available: true,
      preview: "",
      redacted: true,
      noticeKey: "inbox.redacted.short",
      targetId: "conv-1",
      savedAt: "2026-07-11T11:00:00.000Z",
    }],
    messageReminders: [{
      id: "reminder-1",
      sourceKind: "private",
      available: true,
      preview: "",
      redacted: true,
      noticeKey: "inbox.redacted.short",
      targetId: "conv-1",
      remindAt: "2026-07-13T11:00:00.000Z",
    }],
    product: { spaces: [], documents: [] },
  };
}

function renderView(data = makeData()) {
  return render(
    <MessagesView
      data={data}
      desktop
      onSendMessage={vi.fn().mockResolvedValue({})}
      onReadConversation={vi.fn().mockResolvedValue(null)}
      onReadBroadcast={vi.fn().mockResolvedValue(null)}
      onOpenTopics={vi.fn()}
    />,
  );
}

describe("a removed message in the web inbox", () => {
  it("renders the reason in the conversation instead of the removed text", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Message your committee contact" }));
    const pane = screen.getByRole("region", { name: "Message detail" });
    expect(within(pane).getByText("The sender removed this message.")).toBeInTheDocument();
    // The removed text is not anywhere on the page, in any element.
    expect(screen.queryByText("They wrote me up again")).not.toBeInTheDocument();
  });

  it("shows saved messages and reminders pointing at it as removed, not as a stale preview", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(screen.getAllByText("Message removed").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    expect(screen.getAllByText("Message removed").length).toBeGreaterThan(0);
  });

  it("keeps saved and reminder rows out of the unread count", () => {
    renderView();
    // Two unread rows exist: the steward reply and the announcement. The saved
    // and reminder rows are bookmarks, not deliveries.
    expect(screen.getByRole("button", { name: /^Unread/ }).textContent).toContain("2");
  });

  it("falls back to the short notice when a source carries no reason key", () => {
    const data = makeData();
    data.savedMessages[0].noticeKey = null;
    data.messageReminders[0].noticeKey = null;
    renderView(data);
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(screen.getAllByText("Message removed").length).toBeGreaterThan(0);
  });

  it("still renders a live saved preview when the source was not removed", () => {
    const data = makeData();
    data.savedMessages[0] = { ...data.savedMessages[0], redacted: false, noticeKey: null, preview: "Bring the posted schedules." };
    renderView(data);
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(screen.getByText("Bring the posted schedules.")).toBeInTheDocument();
  });

  it("marks an unavailable source rather than inventing a preview", () => {
    const data = makeData();
    data.savedMessages[0] = { ...data.savedMessages[0], available: false };
    renderView(data);
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(screen.getAllByText("Message unavailable").length).toBeGreaterThan(0);
  });
});

describe("the shared projection and unread helpers", () => {
  it("passes the conformance matrix from the browser side too", () => {
    expect(runUnreadConformance()).toEqual([]);
  });

  it("reports a failure when an implementation diverges", () => {
    // A conformance runner that cannot report a failure proves nothing.
    const failures = runUnreadConformance([
      { name: "deliberately wrong", op: "normalize", input: { type: "saved", value: 3 }, expected: 3 },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("deliberately wrong");
  });

  it("reports an unknown operation rather than silently passing", () => {
    const failures = runUnreadConformance([{ name: "bogus", op: "nope", input: null, expected: true }]);
    expect(failures).toEqual(["bogus: unknown operation nope"]);
  });

  it("treats a missing row as neither redacted nor unread", () => {
    expect(isRedactedMessage(null)).toBe(false);
    expect(isRedactedMessage(undefined)).toBe(false);
    expect(redactionReasonOf(null)).toBeNull();
    expect(isTaskMessageUnread(null, "me")).toBe(false);
    expect(isAnnouncementUnread(null, [])).toBe(false);
  });

  it("projects a live row unchanged and a redacted row to nothing", () => {
    expect(projectMessageBody({ body: "hello" })).toEqual({
      redacted: false, body: "hello", noticeKey: null, reason: null,
    });
    expect(projectMessageBody(null)).toEqual({
      redacted: false, body: "", noticeKey: null, reason: null,
    });
    expect(projectMessageBody({ body: "", redacted_at: REDACTED_AT, redaction_reason: "retention_expired" }))
      .toEqual({ redacted: true, body: "", reason: "retention_expired", noticeKey: "inbox.redacted.retention_expired" });
    // An unrecognised reason must not reach a translation lookup as-is.
    expect(projectMessageBody({ body: "", redacted_at: REDACTED_AT, redaction_reason: "mystery" }).reason)
      .toBe("sender_removed");
  });

  it("blanks a preview for a redacted source and passes a live one through", () => {
    expect(projectMessagePreview({ body: "live" })).toEqual({ redacted: false, preview: "live", noticeKey: null });
    expect(projectMessagePreview({ body: "", redacted_at: REDACTED_AT, redaction_reason: "staff_removed" }))
      .toEqual({ redacted: true, preview: "", noticeKey: "inbox.redacted.short" });
    expect(projectMessagePreview({ body: "", redacted_at: REDACTED_AT, redaction_reason: "staff_removed" }, "inbox.redacted.staff_removed").noticeKey)
      .toBe("inbox.redacted.staff_removed");
  });

  it("parses timestamps and cursors the way the contract documents", () => {
    expect(messageTimestamp(null)).toBeNull();
    expect(messageTimestamp(1700000000000)).toBe(1700000000000);
    expect(messageTimestamp("not-a-date")).toBeNull();
    expect(readCursor(null)).toBe(Number.NEGATIVE_INFINITY);
    expect(readCursor("")).toBe(Number.NEGATIVE_INFINITY);
    expect(readCursor("2026-09-01T12:00:00.000Z")).toBe(Date.parse("2026-09-01T12:00:00.000Z"));
  });

  it("counts and normalizes defensively", () => {
    expect(taskUnreadCount(null, "me")).toBe(0);
    expect(countUnreadInboxItems(null)).toBe(0);
    expect(inboxUnreadCount("direct", null)).toBe(0);
    expect(isInboxItemUnread(null)).toBe(false);
    expect(isInboxItemUnread({ type: "announcement", unread: false })).toBe(false);
  });

  it("enumerates the inbox types the messaging IA contract names", () => {
    expect(INBOX_TYPES).toEqual(["direct", "channel", "task", "announcement", "saved", "reminder"]);
    expect(INBOX_TYPES_WITH_COUNTS).toEqual(["direct", "channel", "task"]);
  });

  it("maps a glyph back to its contract kind, and refuses an unknown one", () => {
    expect(reactionKindForGlyph("✊")).toBe("solidarity");
    expect(reactionKindForGlyph("🦄")).toBeNull();
  });
});
