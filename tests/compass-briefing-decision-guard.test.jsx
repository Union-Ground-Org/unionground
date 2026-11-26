import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { engagementApi } from "../src/features/engagement/api.js";

// Compass briefing decision in-flight guard
// (BUG-UG-MESSAGES-COMPASS-DECISION-NO-INFLIGHT-GUARD-20260920):
// Create task and Dismiss share one latch so a second tap cannot issue a
// second decideAction call while the first is still pending.

const PREVIEW = "Now the employer owes a written Step 2 answer.";
const SUMMARY = "The member needs a written response.";
const ACTION_TITLE = "Track the Step 2 response";

function makeData() {
  return {
    member: { id: "member-1" },
    conversations: [{
      id: "conv-1",
      counterpartRole: "steward",
      sender: "Chapter steward",
      initials: "CS",
      preview: PREVIEW,
      dateLabel: "Jul 12",
      unread: 1,
      messages: [{
        id: "m1",
        sender_kind: "steward",
        sender_name: "Chapter steward",
        body: PREVIEW,
        created_at: "2026-07-12T10:00:00.000Z",
        read_at: null,
      }, {
        id: "member-source",
        sender_kind: "member",
        sender_name: "Member",
        body: "Please follow up on the written answer.",
        created_at: "2026-07-12T11:00:00.000Z",
        read_at: null,
      }],
    }],
    broadcasts: [],
    product: { spaces: [], documents: [] },
  };
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderProposedAction() {
  const onNotice = vi.fn();
  const engagementClient = { rpc: vi.fn() };
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ briefing: { summary: SUMMARY, actionItems: [ACTION_TITLE] } }),
  });
  vi.spyOn(engagementApi, "proposeAction").mockResolvedValue({
    id: "action",
    title: ACTION_TITLE,
    state: "proposed",
  });
  const pending = defer();
  const decide = vi.spyOn(engagementApi, "decideAction").mockImplementation(() => pending.promise);
  render(
    <MessagesView
      data={makeData()}
      desktop
      staffAccess
      engagementSession={{ access_token: "token" }}
      engagementClient={engagementClient}
      onNotice={onNotice}
      onSendMessage={vi.fn()}
      onReadConversation={vi.fn()}
      onReadBroadcast={vi.fn()}
      onOpenTopics={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText(PREVIEW, { selector: ".inbox-row__preview" }));
  const pane = screen.getByRole("region", { name: "Message detail" });
  fireEvent.click(within(pane).getByRole("button", { name: "Brief this thread" }));
  await within(pane).findByText(SUMMARY);
  fireEvent.click(within(pane).getByRole("button", { name: "Prepare linked task" }));
  await within(pane).findByText(/Approve task creation/);
  return { pane, onNotice, decide, pending, engagementClient };
}

describe("Compass briefing decision in-flight guard", () => {
  beforeEach(() => window.localStorage.clear());

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables Create task and Dismiss while a decision is pending and issues only one call", async () => {
    const { pane, decide, pending, engagementClient, onNotice } = await renderProposedAction();
    const create = within(pane).getByRole("button", { name: "Create task" });
    const dismiss = within(pane).getByRole("button", { name: "Dismiss" });

    fireEvent.click(create);
    expect(create).toHaveAttribute("aria-disabled", "true");
    expect(dismiss).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(create);
    fireEvent.click(dismiss);
    fireEvent.click(create);
    fireEvent.click(dismiss);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(engagementClient, "action", "confirm");

    pending.resolve({ id: "action", title: ACTION_TITLE, state: "confirmed" });
    expect(await within(pane).findByText("Action confirmed.")).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith("Linked task created.");
  });

  // Create task keeps focus while its decision runs,
  // and Create task and Dismiss in one tick send one decision.
  it("keeps Create task focused while its decision runs, and sends one decision from one tick", async () => {
    const { pane, decide, pending } = await renderProposedAction();
    const create = within(pane).getByRole("button", { name: "Create task" });
    const dismiss = within(pane).getByRole("button", { name: "Dismiss" });
    create.focus();
    await act(async () => { fireEvent.click(create); fireEvent.click(dismiss); });
    expect(decide).toHaveBeenCalledTimes(1);
    await expectPendingFocus(create);
    await act(async () => { pending.resolve({ id: "action", title: ACTION_TITLE, state: "confirmed" }); });
    expect(await within(pane).findByText("Action confirmed.")).toBeInTheDocument();
  });

  it("re-enables both buttons after a rejected decision so a later click can retry", async () => {
    const { pane, decide, pending, engagementClient } = await renderProposedAction();
    const create = within(pane).getByRole("button", { name: "Create task" });
    const dismiss = within(pane).getByRole("button", { name: "Dismiss" });

    fireEvent.click(create);
    expect(create).toHaveAttribute("aria-disabled", "true");
    expect(dismiss).toHaveAttribute("aria-disabled", "true");
    expect(decide).toHaveBeenCalledTimes(1);

    pending.reject(new Error("action is not pending"));
    await waitFor(() => {
      expect(within(pane).getByRole("button", { name: "Create task" })).toBeEnabled();
      expect(within(pane).getByRole("button", { name: "Dismiss" })).toBeEnabled();
    });

    const retry = defer();
    decide.mockImplementation(() => retry.promise);
    fireEvent.click(within(pane).getByRole("button", { name: "Create task" }));
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenNthCalledWith(2, engagementClient, "action", "confirm");
    retry.resolve({ id: "action", title: ACTION_TITLE, state: "confirmed" });
    expect(await within(pane).findByText("Action confirmed.")).toBeInTheDocument();
  });
});
