import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SourceTaskAction } from "../src/components/SourceTaskAction.jsx";
import { App, explicitHatAllowsView } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { readFileSync } from "node:fs";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { resolve } from "node:path";

beforeEach(() => {
  primeDemoHat("member");
  window.history.replaceState({}, "", "/m/messages?demo=1");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

function renderAction(props = {}) {
  return render(
    <LanguageProvider lang="en">
      <SourceTaskAction
        sourceKind="message"
        sourceId="message-1"
        onCreate={vi.fn().mockResolvedValue({ task: { id: "task-1" }, created: true })}
        {...props}
      />
    </LanguageProvider>,
  );
}

describe("source task action", () => {
  it("locks duplicate submission and opens the returned quiet task", async () => {
    let resolve;
    const onCreate = vi.fn(() => new Promise((done) => { resolve = done; }));
    const onOpenTask = vi.fn();
    renderAction({ onCreate, onOpenTask });
    const button = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith("message", "message-1");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveTextContent("Creating task…");
    resolve({ task: { id: "task-1", taskNumber: 42 }, created: true });
    const open = await screen.findByRole("button", { name: "Open task" });
    fireEvent.click(open);
    expect(onOpenTask).toHaveBeenCalledWith({ id: "task-1", taskNumber: 42 });
  });

  // #9914 (carved from #8435): Open task was natively disabled while it
  // resolved the task, so a keyboard user who pressed it lost focus to the page.
  it("keeps focus on Open task while it resolves the task, and a second press opens nothing", async () => {
    const onResolve = vi.fn(async (_kind, _id, task) => ({ task }));
    const onOpenTask = vi.fn();
    renderAction({ onResolve, onOpenTask });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    const open = await screen.findByRole("button", { name: "Open task" });
    await expectHeldWriteFocus(onResolve, open);
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledTimes(1));
  });

  it("uses existing-task copy for an idempotent retry", async () => {
    renderAction({ onCreate: vi.fn().mockResolvedValue({ task: { id: "task-1" }, created: false }) });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Existing task ready")).toBeInTheDocument();
  });

  it("keeps a generic retryable error on the source surface", async () => {
    renderAction({ onCreate: vi.fn().mockRejectedValue(new Error("case secret 509")) });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This source could not be converted"));
    expect(screen.queryByText(/case secret 509/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
  });
});

describe("source task demo parity", () => {
  it("renders explicit unit fixtures through Strict Mode effect replay", async () => {
    primeDemoData(fallbackData);
    try {
      render(<StrictMode><App /></StrictMode>);
      // A cold member deep link is explicit Member intent. StrictMode replay
      // must preserve the requested Messages route rather than inventing a
      // Steward identity from the SAMPLE default.
      expect(await screen.findByRole(
        "heading",
        { name: "Messages" },
        { timeout: 8_000 },
      )).toBeInTheDocument();
    } finally {
      primeDemoData(fallbackData);
    }
  });

  it("does not expose staff task creation while the Member hat is worn", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Messages" });
    fireEvent.click(screen.getByRole("button", { name: /^Committee.*Write down what they asked/ }));
    const sensitivePreview = "PRIVATE worker follow-up 7731";
    fireEvent.change(await screen.findByLabelText("Write a message…"), { target: { value: sensitivePreview } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findAllByText(sensitivePreview)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Create task" })).toBeNull();
  });
});

describe("source task affordance coverage", () => {
  it("wires every supported source and keeps capability control in App", () => {
    const files = [
      "src/views/MessagesView.jsx",
      "src/components/Dialogs.jsx",
      "src/views/StewardView.jsx",
      "src/views/CoordinatorView.jsx",
    ].map((path) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8")).join("\n");
    for (const kind of ["message", "broadcast", "notification", "case"]) {
      expect(files).toContain(`sourceKind="${kind}"`);
    }
    const app = readFileSync(resolve(import.meta.dirname, "../src/App.jsx"), "utf8");
    expect(app).toContain("onCreateTaskFromSource={selectedStaffHatAuthorized ? handleCreateTaskFromSource : null}");
    expect(app).toContain("createChapterTaskFromSource(sessionDataClient, sourceKind, sourceId)");
    expect(app).toContain("demoSourceTaskOutcomesRef.current.get(requestKey)");
    expect(app).toContain("demoSourceTaskOutcomesRef.current.set(requestKey, { task, attachment })");
    const demoHandler = app.slice(
      app.indexOf("async function handleCreateTaskFromSource"),
      app.indexOf("async function handleUpdateTask"),
    );
    expect(demoHandler).not.toMatch(/title:\s*(source|item)\.(title|body|reference)/);
    expect(demoHandler).not.toMatch(/description:\s*(source|item)\.(title|body|reference)/);
  });
});

describe("source task wiring stays on staff-reachable views", () => {
  it("keeps the selected staff identity on an exact event return without opening the general member calendar", () => {
    expect(explicitHatAllowsView("steward", "events", false, ["steward"], false, "/m/events?event=meeting")).toBe(true);
    expect(explicitHatAllowsView("steward", "events", false, ["steward"], false, "/m/events")).toBe(false);
    expect(explicitHatAllowsView("member", "tasks", false, ["steward"], false, "/m/tasks?task=one")).toBe(false);
  });
  // A staff hat never renders the member Cases or Voting views: neither view
  // is in any STAFF_ROLE_NAVIGATION entry, so explicitHatAllowsView refuses it
  // and App falls back to the hat's plane. Handing them the staff-hat-gated
  // task props wired controls no one could ever see.
  const read = (path) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");

  it("does not pass staff task props to the member Cases or Voting views", () => {
    const app = read("src/App.jsx");
    for (const key of ["cases", "voting"]) {
      const line = app.split("\n").find((row) => row.trimStart().startsWith(`${key}: <`));
      expect(line, key).toBeDefined();
      expect(line).not.toContain("onCreateTaskFromSource");
      expect(line).not.toContain("onOpenTask=");
    }
    const messagesLine = app.split("\n").find((row) => row.trimStart().startsWith("messages: <"));
    expect(messagesLine).toContain("onCreateTaskFromSource={selectedStaffHatAuthorized ? handleCreateTaskFromSource : null}");
  });

  it("keeps no unreachable source task control inside the member Cases or Voting views", () => {
    for (const path of ["src/views/CasesView.jsx", "src/views/VotingView.jsx"]) {
      const source = read(path);
      expect(source, path).not.toContain("SourceTaskAction");
      expect(source, path).not.toContain("onCreateTaskFromSource");
    }
  });

  it("hands the task handlers only to views some authorized staff hat can open", () => {
    // Role-and-route proof, not a string scan: every App view that receives
    // onCreateTaskFromSource must pass the same guard App applies to the
    // selected hat (explicitHatAllowsView) for at least one staff hat whose
    // role the member actually holds.
    const app = read("src/App.jsx");
    const receivers = app.split("\n")
      // A view's fragment can also contain role-scoped tools before its View.
      .map((row) => row.match(/^\s+(?:views\.)?(\w+)\s*[:=]\s*.*<\w+View\b.*\bonCreateTaskFromSource=/)?.[1])
      .filter(Boolean);
    expect(receivers.sort()).toEqual(["coordinator", "messages", "steward"]);
    const hats = Object.keys(STAFF_ROLE_NAVIGATION);
    for (const view of receivers) {
      const reachable = hats.some((hat) => explicitHatAllowsView(hat, view, false, [hat]));
      expect(reachable, view).toBe(true);
    }
    for (const view of ["cases", "voting"]) {
      expect(hats.some((hat) => explicitHatAllowsView(hat, view, false, [hat])), view).toBe(false);
    }
  });

  it("keeps case conversion on the staff case desks", () => {
    const app = read("src/App.jsx");
    expect(app).toMatch(/<StewardView [^\n]*onCreateTaskFromSource=\{handleCreateTaskFromSource\}/);
    expect(app).toMatch(/<CoordinatorView [^\n]*onCreateTaskFromSource=\{handleCreateTaskFromSource\}/);
  });
});
