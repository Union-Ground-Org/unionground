import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { catalogue } from "../src/lib/i18n.js";

// Compass thread briefing i18n + decision guards
// (UX-UG-MESSAGES-COMPASS-BRIEFING-ENGLISH-UNGUARDED-DECISION-20260920):
// every string MessageBriefingAction renders resolves through the catalogue in
// EN and ES, no raw RPC state word is interpolated, and a rejected
// decideAction surfaces a staff-visible notice instead of an unhandled promise
// rejection.

const EN = catalogue.en;
const ES = catalogue.es;
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

function copy(lang) {
  const cat = lang === "es" ? ES : EN;
  return {
    pane: cat["inbox.detailRegion"],
    section: cat["inbox.compassBriefing"],
    idle: cat["inbox.compassBriefIdle"],
    busy: cat["inbox.compassBriefBusy"],
    prepare: cat["inbox.compassPrepareTask"],
    prompt: cat["inbox.compassDecisionPrompt"],
    create: cat["inbox.compassCreateTask"],
    dismiss: cat["inbox.compassDismiss"],
    decisionFailed: cat["inbox.compassDecisionFailed"],
    stateConfirmed: cat["inbox.compassStateConfirmed"],
  };
}

function attachRejectionProbe() {
  const rejections = [];
  const onWindow = (event) => {
    rejections.push(event.reason ?? event);
    event.preventDefault();
  };
  const onProcess = (reason) => {
    rejections.push(reason);
  };
  window.addEventListener("unhandledrejection", onWindow);
  process.on("unhandledRejection", onProcess);
  return {
    rejections,
    detach() {
      window.removeEventListener("unhandledrejection", onWindow);
      process.off("unhandledRejection", onProcess);
    },
  };
}

async function renderBriefing(lang, { onNotice = vi.fn(), decideBehavior } = {}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ briefing: { summary: SUMMARY, actionItems: [ACTION_TITLE] } }),
  });
  vi.spyOn(engagementApi, "proposeAction").mockResolvedValue({
    id: "action",
    title: ACTION_TITLE,
    state: "proposed",
  });
  const decide = vi.spyOn(engagementApi, "decideAction");
  if (decideBehavior === "reject") decide.mockRejectedValue(new Error(""));
  else {
    decide.mockResolvedValue({
      id: "action",
      title: ACTION_TITLE,
      state: "confirmed",
    });
  }
  const labels = copy(lang);
  render(
    <LanguageProvider lang={lang}>
      <MessagesView
        data={makeData()}
        desktop
        staffAccess
        engagementSession={{ access_token: "token" }}
        engagementClient={{ rpc: vi.fn() }}
        onNotice={onNotice}
        onSendMessage={vi.fn()}
        onReadConversation={vi.fn()}
        onReadBroadcast={vi.fn()}
        onOpenTopics={vi.fn()}
      />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByText(PREVIEW, { selector: ".inbox-row__preview" }));
  const pane = screen.getByRole("region", { name: labels.pane });
  fireEvent.click(within(pane).getByRole("button", { name: labels.idle }));
  await within(pane).findByText(SUMMARY);
  fireEvent.click(within(pane).getByRole("button", { name: labels.prepare }));
  await within(pane).findByText(new RegExp(labels.prompt.replace("?", "\\?")));
  return { pane, onNotice, decide, labels };
}

describe("Compass briefing i18n and decision guards", () => {
  let probe;

  beforeEach(() => {
    window.localStorage.clear();
    probe = attachRejectionProbe();
  });

  afterEach(() => {
    probe.detach();
    vi.restoreAllMocks();
  });

  it("renders the briefing control in Spanish with no English twin", async () => {
    const { pane, labels } = await renderBriefing("es");
    expect(within(pane).getByRole("region", { name: labels.section })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: labels.idle })).toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: EN["inbox.compassBriefIdle"] })).not.toBeInTheDocument();
    expect(within(pane).queryByText(EN["inbox.compassBriefing"], { selector: "strong" })).not.toBeInTheDocument();
    expect(labels.busy).toBe("Preparando briefing…");
    expect(labels.idle).toBe("Crear briefing de este hilo");
  });

  it("renders the post-decision sentence from the catalogue, never the raw RPC state word", async () => {
    const { pane, labels } = await renderBriefing("es");
    fireEvent.click(within(pane).getByRole("button", { name: labels.create }));
    expect(await within(pane).findByText(labels.stateConfirmed)).toBeInTheDocument();
    expect(pane.textContent).not.toMatch(/Action (confirmed|rejected)\./);
  });

  it("notices a failed Create task instead of raising an unhandled rejection", async () => {
    const onNotice = vi.fn();
    const { pane, labels } = await renderBriefing("es", { onNotice, decideBehavior: "reject" });
    fireEvent.click(within(pane).getByRole("button", { name: labels.create }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(labels.decisionFailed));
    expect(within(pane).getByText(new RegExp(labels.prompt.replace("?", "\\?")))).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe.rejections).toEqual([]);
  });

  it("notices a failed Dismiss instead of raising an unhandled rejection", async () => {
    const onNotice = vi.fn();
    const { pane, labels } = await renderBriefing("es", { onNotice, decideBehavior: "reject" });
    fireEvent.click(within(pane).getByRole("button", { name: labels.dismiss }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(labels.decisionFailed));
    expect(within(pane).getByText(new RegExp(labels.prompt.replace("?", "\\?")))).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probe.rejections).toEqual([]);
  });

  it("keeps the existing English wording byte-identical", async () => {
    const { pane, labels } = await renderBriefing("en");
    expect(within(pane).getByRole("button", { name: EN["inbox.compassBriefIdle"] })).toBeInTheDocument();
    expect(within(pane).getByText(EN["inbox.compassDecisionPrompt"])).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: labels.create }));
    expect(await within(pane).findByText("Action confirmed.")).toBeInTheDocument();
  });
});
