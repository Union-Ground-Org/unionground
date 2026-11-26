import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MESSAGE_WORKFLOW_DEFAULT,
  MESSAGE_WORKFLOW_KEYS,
  findStewardConversation,
  groupMessageItems,
  normalizeMessageWorkflow,
  useMessageWorkflowOnboarding,
  useMessageWorkflowPreference,
} from "../src/lib/messageWorkflow.js";

const items = [
  { key: "direct", type: "direct", unread: 0 },
  { key: "channel", type: "channel", unread: 2 },
  { key: "task", type: "task", unread: 0 },
  { key: "announcement", type: "announcement", unread: 0 },
  { key: "saved", type: "saved", unread: 0 },
  { key: "reminder", type: "reminder", unread: 0 },
];

describe("messaging workflow model", () => {
  it("uses workflow 2 whenever the stored value is absent or invalid", () => {
    expect(normalizeMessageWorkflow(null)).toBe(MESSAGE_WORKFLOW_DEFAULT);
    expect(normalizeMessageWorkflow("unknown")).toBe(MESSAGE_WORKFLOW_DEFAULT);
    expect(MESSAGE_WORKFLOW_DEFAULT).toBe("people-spaces-work");
  });

  it.each(MESSAGE_WORKFLOW_KEYS)("keeps every authorized item exactly once in %s", (workflow) => {
    const grouped = groupMessageItems(items, workflow).flatMap((group) => group.items.map((item) => item.key));
    expect(grouped).toHaveLength(items.length);
    expect(new Set(grouped)).toEqual(new Set(items.map((item) => item.key)));
  });

  it("does not let the steward action fall through to an unrelated first thread", () => {
    const conversations = [
      { id: "peer", sender: "Alex Rivera" },
      { id: "steward", counterpartRole: "steward", sender: "Maria Santos" },
    ];
    expect(findStewardConversation(conversations)?.id).toBe("steward");
    expect(findStewardConversation([{ id: "peer", sender: "Alex Rivera" }])).toBeNull();
  });
});

describe("messaging workflow preference storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps one account's choice and onboarding flag out of the next account on the same browser", () => {
    const first = renderHook(() => useMessageWorkflowPreference("member-a"));
    act(() => first.result.current[1]("attention"));
    expect(renderHook(() => useMessageWorkflowPreference("member-a")).result.current[0]).toBe("attention");
    expect(renderHook(() => useMessageWorkflowOnboarding("member-a")).result.current[0]).toBe(true);

    expect(renderHook(() => useMessageWorkflowPreference("member-b")).result.current[0]).toBe(MESSAGE_WORKFLOW_DEFAULT);
    expect(renderHook(() => useMessageWorkflowOnboarding("member-b")).result.current[0]).toBe(false);
  });

  it("delivers a workflow change event to every view mounted for the same account", () => {
    const first = renderHook(() => useMessageWorkflowPreference("member-a"));
    const mirror = renderHook(() => useMessageWorkflowPreference("member-a"));
    const onboarding = renderHook(() => useMessageWorkflowOnboarding("member-a"));

    act(() => first.result.current[1]("attention"));

    expect({
      workflow: mirror.result.current[0],
      onboarded: onboarding.result.current[0],
    }).toEqual({
      workflow: "attention",
      onboarded: true,
    });
  });

  it("delivers the first-use completion to a workflow view mounted for the same account", () => {
    const mirror = renderHook(() => useMessageWorkflowPreference("member-a"));
    const onboarding = renderHook(() => useMessageWorkflowOnboarding("member-a"));
    // A second tab signed in as the same account recorded a choice after this view mounted.
    window.localStorage.setItem("unionground:messaging-workflow:v1:member-a", "workstreams");

    act(() => onboarding.result.current[1]());

    expect({
      workflow: mirror.result.current[0],
      onboarded: onboarding.result.current[0],
    }).toEqual({
      workflow: "workstreams",
      onboarded: true,
    });
  });

  it("ignores workflow change events emitted for another mounted account", () => {
    const first = renderHook(() => useMessageWorkflowPreference("member-a"));
    const secondWorkflow = renderHook(() => useMessageWorkflowPreference("member-b"));
    const secondOnboarding = renderHook(() => useMessageWorkflowOnboarding("member-b"));

    act(() => first.result.current[1]("attention"));

    expect({
      workflow: secondWorkflow.result.current[0],
      onboarded: secondOnboarding.result.current[0],
    }).toEqual({
      workflow: MESSAGE_WORKFLOW_DEFAULT,
      onboarded: false,
    });
  });

  it("re-reads the stored choice when the signed-in identity changes under a mounted view", () => {
    const seed = renderHook(() => useMessageWorkflowPreference("member-a"));
    act(() => seed.result.current[1]("workstreams"));
    seed.unmount();
    const view = renderHook(({ memberId }) => useMessageWorkflowPreference(memberId), {
      initialProps: { memberId: "member-a" },
    });
    expect(view.result.current[0]).toBe("workstreams");
    view.rerender({ memberId: "member-b" });
    expect(view.result.current[0]).toBe(MESSAGE_WORKFLOW_DEFAULT);
  });

  it("ignores a pre-scoping unscoped choice and clears it", () => {
    window.localStorage.setItem("unionground:messaging-workflow:v1", "attention");
    window.localStorage.setItem("unionground:messaging-workflow-onboarded:v1", "complete");
    const { result } = renderHook(() => useMessageWorkflowPreference("member-a"));
    expect(result.current[0]).toBe(MESSAGE_WORKFLOW_DEFAULT);
    expect(renderHook(() => useMessageWorkflowOnboarding("member-a")).result.current[0]).toBe(false);
    expect(window.localStorage.getItem("unionground:messaging-workflow:v1")).toBeNull();
    expect(window.localStorage.getItem("unionground:messaging-workflow-onboarded:v1")).toBeNull();
  });

  it("holds the default and stores nothing until an identity is known", () => {
    const { result } = renderHook(() => useMessageWorkflowPreference(""));
    act(() => result.current[1]("attention"));
    expect(result.current[0]).toBe("attention");
    expect(window.localStorage.length).toBe(0);
  });
});
