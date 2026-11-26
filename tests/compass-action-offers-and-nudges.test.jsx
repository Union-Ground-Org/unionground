// REQ-UG-COMPASS-ACTION-OFFERS-20261001 (CR-099) and
// REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildGuideMessages } from "../api/_lib/compassPrompts.js";
import { Assistant } from "../src/components/FloatingControls.jsx";
import {
  actionOffersEnabled,
  contextualNudgesEnabled,
  inferForwardTarget,
  loadCompassNudges,
  loadCompassPinnedAnswers,
  presentNudges,
  setCompassAnswerPinned,
  taskTitleFromAnswer,
} from "../src/features/compass/actionOffers.js";
import { CompassAnswerActions } from "../src/features/compass/CompassAnswerActions.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { CompassCaseHelp } from "../src/features/compass/CompassCaseHelp.jsx";
import { CompassPinnedAnswers } from "../src/features/compass/CompassPinnedAnswers.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { compassAssistantCatalogue } from "../src/lib/i18n/compassAssistant.js";

const ANSWER_ID = "51002500-0000-4000-8000-000000000001";
const answer = { id: ANSWER_ID, role: "assistant", body: "File the grievance within 14 days. Ask your steward to review it." };
const en = (key, vars) => t("en", key, vars);
const wrap = (node) => <LanguageProvider lang="en">{node}</LanguageProvider>;

describe("offer and nudge helpers", () => {
  it("follow both organization switches", () => {
    expect(actionOffersEnabled({ switches: { "features.ai_assistant.action_offers": true } })).toBe(true);
    expect(actionOffersEnabled({ switches: { "features.ai_assistant.action_offers": true, "features.ai_assistant.enabled": false } })).toBe(false);
    expect(contextualNudgesEnabled({ switches: {} })).toBe(false);
    expect(contextualNudgesEnabled(null)).toBe(false);
  });

  it("preselect a forward target like the old picker and bound the task title", () => {
    expect(inferForwardTarget("Meet on Tuesday at 3pm")).toBe("event");
    expect(inferForwardTarget("Send the form to HR.")).toBe("task");
    expect(inferForwardTarget("Send the form to HR.", ["message", "event"])).toBe("message");
    expect(inferForwardTarget("Article 12 covers it.")).toBe("message");
    expect(taskTitleFromAnswer(answer.body)).toBe("File the grievance within 14 days.");
    expect(taskTitleFromAnswer(`${"x".repeat(200)}.`)).toHaveLength(118);
  });

  it("keep only the server's nudge ids for the right audience and map pin refusals", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { enabled: true, staff: [{ id: "overdue-cases", count: 3, urgent: true }, { id: "retaliation-flag", count: 1 }, { id: "x", count: 1 }], member: [{ id: "retaliation-flag", count: 1, urgent: true }] }, error: null }) };
    const nudges = await loadCompassNudges(client);
    expect(nudges).toEqual({ staff: [{ id: "overdue-cases", count: 3, urgent: true }], member: [{ id: "retaliation-flag", count: 1, urgent: true }] });
    expect(presentNudges(nudges.staff, en)).toEqual([{ id: "overdue-cases", urgent: true, label: en("compass.nudge.overdueCases", { count: 3 }), prompt: en("compass.nudge.prompt.overdueCases") }]);
    await expect(loadCompassNudges({ rpc: vi.fn().mockResolvedValue({ data: { enabled: false }, error: null }) })).resolves.toEqual({ staff: [], member: [] });
    await expect(setCompassAnswerPinned({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "54000" } }) }, ANSWER_ID, true)).rejects.toMatchObject({ code: "pin_limit" });
  });

  it("read pins defensively and map every pin outcome", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [
      { id: ANSWER_ID, threadId: "t-1", question: "How do I file?", answer: "Within 14 days.", pinnedAt: "2026-10-02T12:00:00Z" },
      { id: 7, answer: "bad id" },
      { id: "x", answer: "No thread", threadId: 5, question: null, pinnedAt: 3 },
    ], error: null });
    expect(await loadCompassPinnedAnswers({ rpc })).toEqual([
      { id: ANSWER_ID, threadId: "t-1", question: "How do I file?", answer: "Within 14 days.", pinnedAt: "2026-10-02T12:00:00Z" },
      { id: "x", threadId: null, question: "", answer: "No thread", pinnedAt: null },
    ]);
    expect(rpc).toHaveBeenCalledWith("list_compass_pinned_answers");
    await expect(loadCompassPinnedAnswers({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) })).rejects.toBeTruthy();
    await expect(loadCompassPinnedAnswers({ rpc: vi.fn().mockResolvedValue({ data: { not: "a list" }, error: null }) })).resolves.toEqual([]);
    const ok = vi.fn().mockResolvedValue({ data: { id: ANSWER_ID, pinnedAt: null }, error: null });
    await expect(setCompassAnswerPinned({ rpc: ok }, ANSWER_ID, 0)).resolves.toEqual({ id: ANSWER_ID, pinnedAt: null });
    expect(ok).toHaveBeenCalledWith("set_compass_answer_pinned", { p_message_id: ANSWER_ID, p_pinned: false });
    await expect(setCompassAnswerPinned({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "55000" } }) }, ANSWER_ID, true)).rejects.toMatchObject({ code: "feature_disabled" });
    await expect(setCompassAnswerPinned({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "P0002" } }) }, ANSWER_ID, true)).rejects.toMatchObject({ code: "pin_failed" });
  });

  it("drop malformed nudge payloads and tolerate odd inputs", async () => {
    await expect(loadCompassNudges({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) })).rejects.toBeTruthy();
    await expect(loadCompassNudges({ rpc: vi.fn().mockResolvedValue({ data: { enabled: true, staff: "x", member: [{ id: "retaliation-flag", count: 0 }, null] }, error: null }) })).resolves.toEqual({ staff: [], member: [] });
    expect(presentNudges(null, en)).toEqual([]);
    expect(presentNudges([{ id: "unknown", count: 1 }, { id: "retaliation-patterns", count: 2 }], en)).toEqual([
      { id: "retaliation-patterns", urgent: false, label: en("compass.nudge.retaliationPatterns", { count: 2 }), prompt: en("compass.nudge.prompt.retaliationPatterns") },
    ]);
    expect(inferForwardTarget(null)).toBe("message");
    expect(taskTitleFromAnswer(null)).toBe("");
    expect(taskTitleFromAnswer("No ending punctuation")).toBe("No ending punctuation");
  });

  it("lets every nudge prompt reach the model as a product-authored starter", () => {
    for (const lang of ["en", "es"]) {
      for (const [key, prompt] of Object.entries(compassAssistantCatalogue[lang])) {
        if (!key.startsWith("compass.nudge.prompt.")) continue;
        expect(buildGuideMessages(prompt, {}, [], [{ source_id: "kb:1", kind: "kb", title: "Rights", ref: "Article 1", snippet: "Use this when a public employer may discipline you without first letting you respond." }]).at(-1).content).toBe(prompt);
      }
    }
  });
});

describe("answer offers", () => {
  it("pins only on request and reports the result", async () => {
    const pin = vi.fn().mockResolvedValue(undefined);
    render(wrap(<CompassAnswerActions message={answer} actions={{ pin, pinnedIds: new Set(), forward: vi.fn() }} />));
    expect(screen.queryByRole("button", { name: en("compass.actions.makeTask") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.pin") }));
    expect(pin).toHaveBeenCalledWith(ANSWER_ID, true);
    expect(await screen.findByRole("status")).toHaveTextContent(en("compass.actions.pinned"));
  });

  it("explains the pin limit", async () => {
    const pin = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "pin_limit" }));
    render(wrap(<CompassAnswerActions message={answer} actions={{ pin, pinnedIds: new Set(), forward: vi.fn() }} />));
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.pin") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en("compass.actions.pinLimit"));
  });

  it("forwards only after choosing a target and confirming", async () => {
    const forward = vi.fn().mockResolvedValue(undefined);
    render(wrap(<CompassAnswerActions message={answer} actions={{ pin: null, forward, forwardTargets: ["message", "event"] }} />));
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.forward") }));
    const group = screen.getByRole("group", { name: en("compass.actions.forwardLegend") });
    expect(within(group).getByRole("radio", { name: en("compass.actions.forwardTo.message") })).toBeChecked();
    expect(within(group).queryByRole("radio", { name: en("compass.actions.forwardTo.task") })).toBeNull();
    fireEvent.click(within(group).getByRole("radio", { name: en("compass.actions.forwardTo.event") }));
    expect(forward).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.forwardConfirm") }));
    await waitFor(() => expect(forward).toHaveBeenCalledWith("event", answer.body));
  });

  it("keeps AI form-fill out and writes only person-authored confirmed tasks and announcements", async () => {
    const createTask = vi.fn().mockResolvedValue(undefined);
    const publishBroadcast = vi.fn().mockResolvedValue(undefined);
    render(wrap(<CompassAnswerActions message={answer} actions={{ pin: null, forward: vi.fn(), forwardTargets: ["message", "task", "event"], createTask, publishBroadcast }} />));
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.makeTask") }));
    const taskForm = screen.getByRole("form", { name: en("compass.actions.taskLegend") });
    expect(within(taskForm).getByLabelText(en("compass.actions.titleField"))).toHaveValue("");
    expect(within(taskForm).getByLabelText(en("compass.actions.descriptionField"))).toHaveValue("");
    expect(within(taskForm).getByRole("button", { name: en("compass.actions.taskConfirm") })).toBeDisabled();
    fireEvent.change(within(taskForm).getByLabelText(en("compass.actions.titleField")), { target: { value: "Person-written task" } });
    fireEvent.change(within(taskForm).getByLabelText(en("compass.actions.descriptionField")), { target: { value: "Person-written details" } });
    expect(createTask).not.toHaveBeenCalled();
    fireEvent.click(within(taskForm).getByRole("button", { name: en("compass.actions.taskConfirm") }));
    await waitFor(() => expect(createTask).toHaveBeenCalledWith({ title: "Person-written task", description: "Person-written details" }));
    expect(await screen.findByRole("status")).toHaveTextContent(en("compass.actions.taskCreated"));
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.draftAnnouncement") }));
    const broadcastForm = screen.getByRole("form", { name: en("compass.actions.broadcastLegend") });
    expect(within(broadcastForm).getByLabelText(en("compass.actions.titleField"))).toHaveValue("");
    expect(within(broadcastForm).getByLabelText(en("compass.actions.messageField"))).toHaveValue("");
    fireEvent.change(within(broadcastForm).getByLabelText(en("compass.actions.messageField")), { target: { value: "Person-written announcement" } });
    fireEvent.change(within(broadcastForm).getByLabelText(en("compass.actions.titleField")), { target: { value: "Grievance deadline reminder" } });
    expect(publishBroadcast).not.toHaveBeenCalled();
    fireEvent.click(within(broadcastForm).getByRole("button", { name: en("compass.actions.broadcastConfirm") }));
    await waitFor(() => expect(publishBroadcast).toHaveBeenCalledWith({ title: "Grievance deadline reminder", body: "Person-written announcement", operationKey: expect.any(String) }));
  });
  // The answer:<id> lock refuses a second write on the same answer
  // in the same tick, before busy commits. A double publish would reach every
  // member, so a second announcement submit must send nothing.
  it("publishes one announcement when it is submitted twice in one tick", async () => {
    const publishBroadcast = vi.fn(async () => undefined);
    render(wrap(<CompassAnswerActions message={answer} actions={{ pin: null, forward: vi.fn(), forwardTargets: ["message"], publishBroadcast }} />));
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.draftAnnouncement") }));
    const broadcastForm = screen.getByRole("form", { name: en("compass.actions.broadcastLegend") });
    fireEvent.change(within(broadcastForm).getByLabelText(en("compass.actions.messageField")), { target: { value: "Person-written announcement" } });
    fireEvent.change(within(broadcastForm).getByLabelText(en("compass.actions.titleField")), { target: { value: "Grievance deadline reminder" } });
    const publish = within(broadcastForm).getByRole("button", { name: en("compass.actions.broadcastConfirm") });
    await expectOneWriteFromOneTick(publishBroadcast, [() => fireEvent.click(publish), () => fireEvent.click(publish)]);
    expect(publishBroadcast).toHaveBeenCalledExactlyOnceWith({ title: "Grievance deadline reminder", body: "Person-written announcement", operationKey: expect.any(String) });
  });

  it("pins once when Pin is activated twice in one tick", async () => {
    const pin = vi.fn(async () => undefined);
    render(wrap(<CompassAnswerActions message={answer} actions={{ pin, pinnedIds: new Set(), forward: vi.fn() }} />));
    const button = screen.getByRole("button", { name: en("compass.actions.pin") });
    await expectOneWriteFromOneTick(pin, [() => fireEvent.click(button), () => fireEvent.click(button)]);
    expect(pin).toHaveBeenCalledExactlyOnceWith(ANSWER_ID, true);
  });
});

describe("Compass panel offers and nudges", () => {
  const thread = { id: "thread-1", title: "Grievance", messages: [{ id: "q-1", role: "user", body: "How do I file?" }, answer, { id: "local-answer", role: "assistant", body: "Unsaved answer." }] };

  it("offers actions on answers only, and pinning only on a saved answer", () => {
    render(wrap(<Assistant threads={[thread]} onClose={vi.fn()} onSend={vi.fn()} answerActions={{ pin: vi.fn(), pinnedIds: new Set([ANSWER_ID]), forward: vi.fn() }} />));
    const groups = screen.getAllByRole("group", { name: en("compass.actions.groupLabel") });
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByRole("button", { name: en("compass.actions.unpin") })).toHaveAttribute("aria-pressed", "true");
    expect(within(groups[1]).queryByRole("button", { name: en("compass.actions.pin") })).toBeNull();
  });

  it("shows nudges that only fill the composer", () => {
    const onSend = vi.fn();
    render(wrap(<Assistant threads={[]} onClose={vi.fn()} onSend={onSend} nudges={[{ id: "retaliation-flag", urgent: true, label: en("compass.nudge.retaliationFlag"), prompt: en("compass.nudge.prompt.retaliationFlag") }]} />));
    const group = screen.getByRole("group", { name: en("compass.nudge.groupLabel") });
    fireEvent.click(within(group).getByRole("button", { name: en("compass.nudge.retaliationFlag") }));
    expect(screen.getByRole("textbox", { name: en("compass.askAria") })).toHaveValue(en("compass.nudge.prompt.retaliationFlag"));
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("Home pins and case notes", () => {
  // Unpin keeps focus while the answer is unpinned, and a second
  // activation in the same tick unpins nothing more.
  const pinsPanel = (onUnpin) => {
    render(wrap(<CompassPinnedAnswers pins={[{ id: ANSWER_ID, question: "How do I file?", answer: answer.body }]} onUnpin={onUnpin} onAsk={vi.fn()} />));
    return screen.getByRole("button", { name: en("compass.pins.unpinLabel", { question: "How do I file?" }) });
  };

  it("keeps Unpin focused while the answer is unpinned, and unpins once", async () => {
    const onUnpin = vi.fn(async () => undefined);
    await expectHeldWriteFocus(onUnpin, pinsPanel(onUnpin));
    expect(onUnpin).toHaveBeenCalledExactlyOnceWith(ANSWER_ID);
  });

  it("unpins once when Unpin is activated twice in one tick", async () => {
    const onUnpin = vi.fn(async () => undefined);
    const unpin = pinsPanel(onUnpin);
    await expectOneWriteFromOneTick(onUnpin, [() => fireEvent.click(unpin), () => fireEvent.click(unpin)]);
  });

  // #8973 delta (record 8435): one unpin runs at a time, as on Main, so every
  // Unpin reads unavailable while any unpin runs, not only the clicked one.
  it("holds every pin's Unpin while one answer is unpinned", async () => {
    let release;
    const onUnpin = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    render(wrap(<CompassPinnedAnswers pins={[
      { id: ANSWER_ID, question: "How do I file?", answer: answer.body },
      { id: "51002500-0000-4000-8000-000000000002", question: "Who is my steward?", answer: answer.body },
    ]} onUnpin={onUnpin} onAsk={vi.fn()} />));
    fireEvent.click(screen.getByRole("button", { name: en("compass.pins.unpinLabel", { question: "How do I file?" }) }));
    const other = screen.getByRole("button", { name: en("compass.pins.unpinLabel", { question: "Who is my steward?" }) });
    try {
      expect(other).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(other);
      expect(onUnpin).toHaveBeenCalledExactlyOnceWith(ANSWER_ID);
    } finally {
      await act(async () => { release(); });
    }
    expect(other).not.toHaveAttribute("aria-disabled", "true");
  });

  it("lists pinned answers with unpin and follow-up", async () => {
    const onUnpin = vi.fn().mockResolvedValue(undefined);
    const onAsk = vi.fn();
    render(wrap(<CompassPinnedAnswers pins={[{ id: ANSWER_ID, question: "How do I file?", answer: answer.body }]} onUnpin={onUnpin} onAsk={onAsk} />));
    expect(screen.getByRole("heading", { name: en("compass.pins.title") })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en("compass.pins.followUp") }));
    expect(onAsk).toHaveBeenCalledWith("How do I file?");
    fireEvent.click(screen.getByRole("button", { name: en("compass.pins.unpinLabel", { question: "How do I file?" }) }));
    await waitFor(() => expect(onUnpin).toHaveBeenCalledWith(ANSWER_ID));
  });

  it("renders nothing without pins", () => {
    const { container } = render(wrap(<CompassPinnedAnswers pins={[]} onUnpin={vi.fn()} />));
    expect(container).toBeEmptyDOMElement();
  });

  it("adds a case-help answer to the case notes only after confirmation", async () => {
    const onAddNote = vi.fn().mockResolvedValue(undefined);
    render(wrap(<CompassCaseHelp caseId="case-1" ask={vi.fn().mockResolvedValue({ answer: "Prepare your timeline.", sources: [] })} onAddNote={onAddNote} />));
    fireEvent.click(screen.getByRole("button", { name: en("compass.caseHelp.q.prepare") }));
    fireEvent.click(await screen.findByRole("button", { name: en("compass.actions.addCaseNote") }));
    expect(onAddNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en("compass.actions.caseNoteConfirm") }));
    await waitFor(() => expect(onAddNote).toHaveBeenCalledWith("case-1", "Prepare your timeline."));
    expect(await screen.findByText(en("compass.actions.caseNoteSaved"))).toBeInTheDocument();
  });
});

// An answer action stays focusable while its write runs.
describe("answer actions keep focus while they run", () => {
  it("keeps Pin focused while the answer is pinned, and pins it once", async () => {
    const pin = vi.fn().mockResolvedValue(undefined);
    render(wrap(<CompassAnswerActions message={answer} actions={{ pin, pinnedIds: new Set(), forward: vi.fn() }} />));
    await expectHeldWriteFocus(pin, screen.getByRole("button", { name: en("compass.actions.pin") }));
    expect(pin).toHaveBeenCalledTimes(1);
  });
});
