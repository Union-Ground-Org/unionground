import { useCallback, useEffect, useRef, useState } from "react";
import { selectStewardConversation } from "./stewardConversations.js";

export const MESSAGE_WORKFLOW_DEFAULT = "people-spaces-work";
export const MESSAGE_WORKFLOW_KEYS = ["attention", MESSAGE_WORKFLOW_DEFAULT, "workstreams"];

const WORKFLOW_KEY = "unionground:messaging-workflow:v1";
const ONBOARDING_KEY = "unionground:messaging-workflow-onboarded:v1";
const CHANGE_EVENT = "union-ground-messaging-workflow-change";

export const MESSAGE_WORKFLOWS = [
  {
    key: "attention",
    number: 1,
    labelKey: "inbox.workflow.attention.title",
    summaryKey: "inbox.workflow.attention.summary",
    proKey: "inbox.workflow.attention.pro",
    conKey: "inbox.workflow.attention.con",
  },
  {
    key: MESSAGE_WORKFLOW_DEFAULT,
    number: 2,
    labelKey: "inbox.workflow.people.title",
    summaryKey: "inbox.workflow.people.summary",
    proKey: "inbox.workflow.people.pro",
    conKey: "inbox.workflow.people.con",
    recommended: true,
  },
  {
    key: "workstreams",
    number: 3,
    labelKey: "inbox.workflow.workstreams.title",
    summaryKey: "inbox.workflow.workstreams.summary",
    proKey: "inbox.workflow.workstreams.pro",
    conKey: "inbox.workflow.workstreams.con",
  },
];

export function normalizeMessageWorkflow(value) {
  return MESSAGE_WORKFLOW_KEYS.includes(value) ? value : MESSAGE_WORKFLOW_DEFAULT;
}

// The web twin of apps/mobile findNativeStewardConversation. With a selected
// steward it must reach THAT steward's thread and nothing else; without one it
// keeps the historical canonical-thread answer. The rule itself lives in
// stewardConversations.js so both surfaces read one definition.
export function findStewardConversation(conversations = [], stewardUserId = null) {
  return selectStewardConversation(conversations, stewardUserId);
}

// The choice and the onboarding flag are per-account, not per-browser: an
// unscoped key let the next account signed in on a shared machine inherit the
// previous one's arrangement and skip the first-use chooser.
function scopedKey(base, memberId) {
  return memberId ? `${base}:${memberId}` : null;
}

function readStorage(key) {
  if (!key || typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  if (!key || typeof window === "undefined") return false;
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}

function purgeUnscopedStorage() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(WORKFLOW_KEY);
    window.localStorage.removeItem(ONBOARDING_KEY);
  } catch { /* Nothing reads the unscoped keys any more. */ }
}

function announceChange(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail }));
}

export function useMessageWorkflowPreference(memberId = "") {
  const workflowKey = scopedKey(WORKFLOW_KEY, memberId);
  const [workflow, setWorkflowState] = useState(() => normalizeMessageWorkflow(readStorage(workflowKey)));

  useEffect(() => {
    purgeUnscopedStorage();
    setWorkflowState(normalizeMessageWorkflow(readStorage(workflowKey)));
  }, [workflowKey]);

  useEffect(() => {
    const onChange = (event) => {
      if (event.detail?.memberId !== memberId) return;
      setWorkflowState(normalizeMessageWorkflow(event.detail?.workflow));
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [memberId]);

  const setWorkflow = useCallback((next) => {
    const normalized = normalizeMessageWorkflow(next);
    setWorkflowState(normalized);
    const workflowSaved = writeStorage(workflowKey, normalized);
    writeStorage(scopedKey(ONBOARDING_KEY, memberId), "complete");
    announceChange({ memberId, workflow: normalized, workflowSaved, onboarded: true });
  }, [memberId, workflowKey]);

  return [workflow, setWorkflow];
}

export function useMessageWorkflowOnboarding(memberId = "") {
  const onboardingKey = scopedKey(ONBOARDING_KEY, memberId);
  const [onboarded, setOnboardedState] = useState(() => readStorage(onboardingKey) === "complete");
  const unstoredWorkflow = useRef(null);

  useEffect(() => {
    purgeUnscopedStorage();
    setOnboardedState(readStorage(onboardingKey) === "complete");
  }, [onboardingKey]);

  useEffect(() => {
    const onChange = (event) => {
      if (event.detail?.memberId !== memberId) return;
      unstoredWorkflow.current = event.detail.workflowSaved === false
        ? { memberId, workflow: normalizeMessageWorkflow(event.detail.workflow) }
        : null;
      if (event.detail?.onboarded) setOnboardedState(true);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, [memberId]);

  const complete = useCallback(() => {
    const workflowKey = scopedKey(WORKFLOW_KEY, memberId);
    setOnboardedState(true);
    writeStorage(onboardingKey, "complete");
    // Choosing and completing run in one handler. A refused storage write
    // must not replace the choice just announced with an older saved mode.
    const stored = readStorage(workflowKey);
    const workflow = unstoredWorkflow.current?.memberId === memberId
      ? unstoredWorkflow.current.workflow
      : normalizeMessageWorkflow(stored);
    const workflowSaved = stored === workflow || writeStorage(workflowKey, workflow);
    announceChange({ memberId, workflow, workflowSaved, onboarded: true });
  }, [memberId, onboardingKey]);

  return [onboarded, complete];
}

function groupsFor(workflow) {
  if (workflow === "attention") {
    return [
      ["needsYou", (item) => item.unread > 0 || item.type === "reminder"],
      ["waiting", (item) => item.type === "direct" || item.type === "task"],
      ["later", () => true],
    ];
  }
  if (workflow === "workstreams") {
    return [
      ["inbox", (item) => item.type === "direct"],
      ["casesTasks", (item) => item.type === "task" || item.type === "reminder"],
      ["campaignsMeetings", (item) => item.type === "channel" || item.type === "announcement"],
      ["resources", () => true],
    ];
  }
  return [
    ["people", (item) => item.type === "direct"],
    ["spaces", (item) => item.type === "channel" || item.type === "announcement"],
    ["work", () => true],
  ];
}

export function groupMessageItems(items, workflow) {
  const unassigned = [...items];
  return groupsFor(normalizeMessageWorkflow(workflow)).map(([key, accepts]) => {
    const groupItems = unassigned.filter(accepts);
    for (const item of groupItems) unassigned.splice(unassigned.indexOf(item), 1);
    return { key, items: groupItems };
  }).filter((group) => group.items.length > 0);
}

// The first `count` items of the grouped list, in display order, keeping each
// group's heading with the items it still shows
// (BUG-UG-MESSAGES-INBOX-RENDERS-ALL-ITEMS-NARROW-20261106).
export function limitMessageGroups(groups, count, offset = 0) {
  let left = Math.max(0, count);
  let skip = Math.max(0, offset);
  return groups.map((group) => {
    const start = Math.min(skip, group.items.length);
    skip -= start;
    const items = group.items.slice(start, start + left);
    left -= items.length;
    return { ...group, items };
  }).filter((group) => group.items.length > 0);
}
