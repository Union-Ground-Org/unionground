// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cancelMemberMessageReminder,
  cancelScheduledMemberMessage,
  createEventFromMemberMessage,
  createMemberContactNote,
  createMemberMessageReminder,
  listMemberContactNotes,
  listStewardEmailIntakes,
  reviewStewardEmailIntake,
  scheduleMemberMessage,
  sendMemberResource,
  toggleMemberMessageReaction,
  toggleMemberSavedMessage,
} from "../src/lib/memberApi.js";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const messages = read("src/views/MessagesView.jsx");
const messageActions = read("src/components/MessageActions.jsx");
const steward = read("src/views/StewardView.jsx");

// A fake Supabase client that records every RPC call instead of asserting an
// RPC name still appears as source text somewhere — a grep that stays green
// even if the call is dead code or unreachable.
function recordingClient() {
  const calls = [];
  return {
    calls,
    client: {
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: {}, error: null };
      },
    },
  };
}

describe("messaging restoration UI", () => {
  it("keeps resource titles in the authorized renderer instead of copied message bodies", () => {
    expect(messages).toContain('t("inbox.sharedResource")');
    expect(messages).not.toContain('t("inbox.sharedResource", { title:');
  });

  it("binds private-message utilities to bounded server RPCs with the expected arguments", async () => {
    const { calls, client } = recordingClient();
    await toggleMemberMessageReaction(client, "task", "msg-1", "solidarity");
    await toggleMemberSavedMessage(client, "task", "msg-1");
    await scheduleMemberMessage(client, "conv-1", "  Bring the posted schedules.  ", "2026-09-21T10:00:00.000Z");
    await cancelScheduledMemberMessage(client, "sched-1");
    await createMemberMessageReminder(client, "task", "msg-1", "2026-09-22T10:00:00.000Z", "follow up");
    await cancelMemberMessageReminder(client, "reminder-1");
    await sendMemberResource(client, "conv-1", "doc-1", "  see this  ");

    expect(calls.map((call) => call.name)).toEqual([
      "toggle_member_message_reaction",
      "toggle_member_saved_message",
      "schedule_member_message",
      "cancel_scheduled_member_message",
      "create_member_message_reminder",
      "cancel_member_message_reminder",
      "send_member_resource",
    ]);
    expect(calls[0].args).toEqual({ p_source_kind: "task", p_message_id: "msg-1", p_reaction: "solidarity" });
    expect(calls[1].args).toEqual({ p_source_kind: "task", p_message_id: "msg-1" });
    expect(calls[2].args).toEqual({ p_conversation_id: "conv-1", p_body: "Bring the posted schedules.", p_scheduled_for: "2026-09-21T10:00:00.000Z" });
    expect(calls[3].args).toEqual({ p_scheduled_message_id: "sched-1" });
    expect(calls[4].args).toEqual({ p_source_kind: "task", p_message_id: "msg-1", p_remind_at: "2026-09-22T10:00:00.000Z", p_note: "follow up" });
    expect(calls[5].args).toEqual({ p_reminder_id: "reminder-1" });
    expect(calls[6].args).toEqual({ p_conversation_id: "conv-1", p_document_id: "doc-1", p_body: "see this" });

    expect(messageActions).toContain("inbox.messageActions");
    expect(messages).toContain("inbox.scheduleFor");
    expect(messages).toContain("inbox.shareResource");
  });

  it("bridges channel, private, and task conversations from Messages", () => {
    expect(messages).toContain("inbox.channels");
    expect(messages).toContain('"direct", "channel", "task", "announcement", "saved", "reminder"');
    expect(messages).toContain("inbox.taskConversation");
    expect(messages).toContain("onOpenTasks");
  });

  it("wires MFA steward UI's hidden notes and email review to bounded RPCs", async () => {
    const { calls, client } = recordingClient();
    await listMemberContactNotes(client, "conv-1");
    await createMemberContactNote(client, "conv-1", "  called employer  ", "msg-1");
    await listStewardEmailIntakes(client, "pending", 25);
    await reviewStewardEmailIntake(client, "intake-1", "approve");

    expect(calls.map((call) => call.name)).toEqual([
      "list_member_contact_notes",
      "create_member_contact_note",
      "list_steward_email_intakes",
      "review_steward_email_intake",
    ]);
    expect(calls[0].args).toEqual({ p_conversation_id: "conv-1" });
    expect(calls[1].args).toEqual({ p_conversation_id: "conv-1", p_note: "called employer", p_source_message_id: "msg-1" });
    expect(calls[2].args).toEqual({ p_status: "pending", p_limit: 25 });
    expect(calls[3].args).toEqual({ p_intake_id: "intake-1", p_action: "approve" });

    expect(steward).toContain("steward.contactNotesTitle");
    expect(steward).toContain("steward.emailIntakeTitle");
  });

  it("offers explicit-field message-to-event only to admin-capable stewards, bound to its RPC", async () => {
    const { calls, client } = recordingClient();
    await createEventFromMemberMessage(client, "msg-1", {
      id: " ev-1 ",
      title: " Step 2 meeting ",
      startsAt: "2026-09-25T18:00:00.000Z",
      location: " Union hall ",
      summary: " Discuss the grievance. ",
      checkInCode: " ab12 ",
    });
    expect(calls).toEqual([{
      name: "create_event_from_member_message",
      args: {
        p_message_id: "msg-1",
        p_event_id: "ev-1",
        p_title: "Step 2 meeting",
        p_starts_at: "2026-09-25T18:00:00.000Z",
        p_location: "Union hall",
        p_summary: "Discuss the grievance.",
        p_check_in_code: "AB12",
      },
    }]);

    expect(steward).toContain("canCreateEvent");
    expect(steward).toContain("steward.messageEventTitle");
  });
});
