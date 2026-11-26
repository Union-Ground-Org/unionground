import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, expect, it, vi } from "vitest";
import { backend, coverage, cover, flush, go, random } from "./helpers/member-boot-model-fixture.jsx";
import { App } from "../src/App.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

afterAll(() => {
  for (const name of ["compass", "palette", "retry", "reopen", "save-failure", "board-notification", "board-live", "route-return", "identity-reply", "identity-save", "identity-history", "identity-refresh"]) {
    expect(coverage.ui[name], name).toBe(16);
  }
  expect(coverage.successiveWrites).toBe(6);
  process.stdout.write(`B06 model coverage: ${JSON.stringify(coverage)}\n`);
});

// Independent UI oracle: expected content comes from synthetic server writes,
// never from registry projections. Every seed covers each required flow; route
// order and the overlapping board event vary independently from event choice.
it.each(Array.from({ length: 16 }, (_, index) => index + 101))("rendered recovery/mutation model, seed %i", async seed => {
  const choose = random(seed);
  const state = backend.state;
  const oracle = { question: `Saved model question ${seed}`, answer: "Saved model answer", task: `Reconciled task ${seed}` };
  vi.stubGlobal("matchMedia", query => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  state.rows["table:member_roles"] = [{ role: "steward" }];
  state.rows["table:chapter_workstreams"] = [{ id: "workstream", name: "General" }];
  state.rows["table:chapter_tasks"] = [{ id: "task", title: "Original model task", workstream: "General", status: "in_progress", assignee_id: "model-a", chapter_id: "chapter-model", created_at: "2026-09-06T12:00:00Z", updated_at: "2026-09-06T12:00:00Z" }];
  const attempts = resource => state.operations.filter(op => op.resource === resource).length;
  const navigate = async view => {
    await flush(() => go(view));
    await waitFor(() => expect(document.querySelector(".view-loading")).toBeNull());
  };
  const openCompass = async () => {
    // Use the actual global command to open Compass from any rendered route.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.click(within(palette).getByRole("option", { name: /Union Ground Guide/ }));
    // The chosen command runs at once; the palette's scrim fades for 200 ms.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    return screen.findByRole("dialog", { name: "Union Ground Guide" });
  };
  render(<App />);
  await screen.findByRole("heading", { name: /Model/ });
  state.fail = "table:member_guide_threads";
  let dialog = await openCompass(); cover("compass");
  await within(dialog).findByRole("alert");
  const failedCount = attempts(state.fail);
  await flush(); await flush();
  expect(attempts(state.fail)).toBe(failedCount);
  state.fail = null;
  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" })); cover("retry");
  await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
  fireEvent.click(within(dialog).getByRole("button", { name: /conversations/i }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Retained model conversation" }));
  expect(await within(dialog).findByText("Retained model answer")).toBeVisible();

  state.rows["rpc:save_member_guide_exchange"] = "saved-model";
  state.rows["table:member_guide_threads"] = [{ id: "saved-model", title: oracle.question }];
  state.rows["table:member_guide_messages"] = [{ id: "saved-answer", thread_id: "saved-model", role: "assistant", body: oracle.answer }];
  state.fail = "table:member_guide_threads";
  fireEvent.change(within(dialog).getByLabelText("Ask Union Ground Guide a question"), { target: { value: oracle.question } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  expect(await within(dialog).findByText(oracle.answer)).toBeVisible(); cover("save-failure");
  const routes = ["today", "rights", "messages", "events"];
  for (let i = routes.length - 1; i > 0; i -= 1) {
    const j = choose(i + 1); [routes[i], routes[j]] = [routes[j], routes[i]];
  }
  for (const route of routes) {
    await navigate(route);
    expect(within(dialog).getByText(oracle.answer)).toBeVisible();
  }
  cover("route-return");
  fireEvent.keyDown(window, { key: "Escape" });
  // Opening via the shell avoids conflating palette and Compass recovery.
  await navigate("today");
  const beforeReopen = attempts("table:member_guide_threads");
  fireEvent.click(screen.getByRole("button", { name: /^Union Ground Guide\b/ }));
  dialog = await screen.findByRole("dialog", { name: "Union Ground Guide" });
  await within(dialog).findByRole("alert");
  expect(attempts("table:member_guide_threads")).toBe(beforeReopen + 1); cover("reopen");
  expect(within(dialog).getByText(oracle.answer)).toBeVisible();
  state.fail = null;
  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
  expect(within(dialog).getAllByText(oracle.answer)).toHaveLength(1);
  fireEvent.keyDown(window, { key: "Escape" });

  // Search's additive failures must be visible as well as core failures.
  state.fail = "table:member_kb_articles";
  // A prior palette open has a successful snapshot. Explicit invalidation
  // models an external write; recovery itself is exclusively a UI gesture.
  await flush(() => state.loader.invalidateResources([state.fail]));
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  let palette = await screen.findByRole("dialog", { name: "Command palette" });
  await within(palette).findByRole("alert");
  const searchCount = attempts(state.fail);
  await flush(); await flush(); expect(attempts(state.fail)).toBe(searchCount);
  fireEvent.click(within(palette).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(attempts(state.fail)).toBe(searchCount + 1));
  await within(palette).findByRole("alert");
  fireEvent.keyDown(window, { key: "Escape" }); state.fail = null;
  // The palette fades its scrim for 200 ms before it unmounts.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  palette = await screen.findByRole("dialog", { name: "Command palette" });
  await waitFor(() => expect(attempts("table:member_kb_articles")).toBe(searchCount + 2));
  await waitFor(() => expect(within(palette).queryByRole("alert")).toBeNull());
  fireEvent.change(within(palette).getByRole("combobox"), { target: { value: oracle.question } });
  expect(await within(palette).findByRole("option", { name: new RegExp(oracle.question) })).toBeVisible();
  fireEvent.keyDown(window, { key: "Escape" }); cover("palette");

  const { applyDeviceParityState } = await import("../src/lib/deviceParity.js");
  await flush(() => applyDeviceParityState("app.selectedStaffHat", "steward"));
  await navigate("tasks");
  expect(await screen.findByText("Original model task")).toBeVisible();
  state.rows["table:chapter_tasks"][0].title = oracle.task;
  await flush(() => state.namedSubscribers["chapter-tasks:chapter-model"]("SUBSCRIBED"));
  expect(await screen.findByText(oracle.task)).toBeVisible();
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  expect(screen.queryByText("Original model task")).toBeNull();
  expect(screen.getByText(oracle.task)).toBeVisible(); cover("board-notification");

  state.holdResource = "table:chapter_tasks";
  await flush(() => state.namedSubscribers["chapter-tasks:chapter-model"]("SUBSCRIBED"));
  await waitFor(() => expect(state.pending.length).toBeGreaterThan(0));
  const live = { ...state.rows["table:chapter_tasks"][0], title: `Concurrent task ${seed}`, updated_at: "2026-09-06T13:00:00Z" };
  const feed = state.feeds.findLast(item => item.name === "chapter-tasks:chapter-model" && item.filter.event === "UPDATE");
  await flush(() => feed.callback({ payload: { table: "chapter_tasks", operation: "UPDATE", record: live } }));
  state.holdResource = null;
  while (state.pending.length) {
    const [request] = state.pending.splice(choose(state.pending.length), 1);
    await flush(() => request.resolve({ data: request.data, error: null }));
  }
  expect(await screen.findByText(live.title)).toBeVisible();
  await flush(() => state.namedSubscribers["member-notifications-model-a"]("SUBSCRIBED"));
  expect(screen.getByText(live.title)).toBeVisible();
  await navigate("steward"); await navigate("tasks");
  // Reopening subscribes but our inert transport emits SUBSCRIBED only when
  // commanded. Navigation therefore verifies the retained registry snapshot.
  expect(await screen.findByText(live.title)).toBeVisible(); cover("board-live");
});

// Cross real rendered continuations with auth replacement. The oracle uses
// identity-labelled backend content and the initiating question, never loader
// state. Every seed crosses all boundaries, with shuffled completion order,
// direct replacement, same-user re-login, and A/B/A histories.
it.each(Array.from({ length: 16 }, (_, index) => index + 201))("rendered identity/mutation crossings, seed %i", async seed => {
  const choose = random(seed);
  const state = backend.state;
  const phases = ["reply", "save", "history", "refresh"];
  for (let i = phases.length - 1; i > 0; i -= 1) {
    const j = choose(i + 1); [phases[i], phases[j]] = [phases[j], phases[i]];
  }
  for (const phase of phases) {
    localStorage.clear(); sessionStorage.clear();
    state.rows["table:member_guide_threads"] = [];
    state.rows["table:member_guide_messages"] = [];
    state.rows["rpc:save_member_guide_exchange"] = `private-${seed}-${phase}`;
    state.fail = null;
    render(<App />);
    await screen.findByRole("heading", { name: /Model|Identity/ });
    fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
    let dialog = await screen.findByRole("dialog", { name: "Union Ground Guide" });
    await waitFor(() => expect(within(dialog).queryByText("Loading conversations…")).toBeNull());
    await flush(); await flush();
    const privateQuestion = `Private ${state.session.user.id} ${seed} ${phase}`;
    const oldLoader = state.loader;
    const oldFeed = state.feeds.findLast(feed => feed.filter.table === "member_notifications");
    const oldSubscribed = state.namedSubscribers[`member-notifications-${state.session.user.id}`];
    state.holdReply = phase === "reply";
    state.holdResource = phase === "save" ? "rpc:save_member_guide_exchange" : phase === "history" ? "table:member_guide_threads" : null;
    if (phase === "refresh") {
      state.holdResource = "table:member_guide_threads";
      await flush(() => { void oldLoader.loadRoute("voice", { force: true }); });
    } else {
      fireEvent.change(within(dialog).getByLabelText("Ask Union Ground Guide a question"), { target: { value: privateQuestion } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    }
    await waitFor(() => expect(state.replyPending || state.pending.length).toBeTruthy());
    const pending = state.pending.splice(0);
    const reply = state.replyPending;
    state.holdReply = false; state.replyPending = null; state.holdResource = null;
    const previous = state.session.user.id;
    const next = choose(2) ? previous : `model-new-${seed}-${phase}`;
    await flush(() => {
      if (choose(2)) { state.session = null; state.auth("SIGNED_OUT", null); }
      else { state.session = { user: backend.user(`intermediate-${seed}`), access_token: "intermediate" }; state.auth("SIGNED_IN", state.session); }
      state.session = { user: backend.user(next), access_token: `new-${seed}-${phase}` };
      state.auth("SIGNED_IN", state.session);
    });
    await waitFor(() => expect(state.loader !== oldLoader && state.loader.stateForRoute("today").status === "loaded").toBe(true));
    await screen.findByRole("heading", { name: next === "model-a" ? /Model/ : new RegExp(`Identity ${next}`) });
    state.fail = "table:member_guide_threads";
    // The replacement session may already have warmed empty history before
    // failure injection. Invalidate it so reopening exercises the intended
    // failed read regardless of that earlier successful read's timing.
    await flush(() => state.loader.invalidateResources(["table:member_guide_threads"]));
    // Randomize late RPC/read, old live callback and old SUBSCRIBED delivery.
    const deliveries = [
      () => { reply?.({ answer: `Private answer ${seed}`, sources: [] }); pending.forEach(request => request.resolve({ data: request.data, error: phase === "history" ? { message: "old read failed" } : null })); },
      () => oldFeed?.callback({ new: { id: "private-notice", title: privateQuestion, created_at: "2026-09-07T01:00:00Z" } }),
      () => oldSubscribed?.("SUBSCRIBED"),
    ];
    while (deliveries.length) await flush(deliveries.splice(choose(deliveries.length), 1)[0]);
    await flush(); await flush();
    fireEvent.click([...document.querySelectorAll(".morehub-row")].find(row => row.textContent.includes("Union Ground Guide")));
    dialog = await screen.findByRole("dialog", { name: "Union Ground Guide" });
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: /conversations/i }));
    expect(document.body.textContent, `${seed}:${phase}:${previous}->${next}`).not.toContain(privateQuestion);
    expect(document.body.textContent).not.toContain(`Private answer ${seed}`);
    expect(oldLoader.inspect().size).toBe(0);
    cover(`identity-${phase}`);
    cleanup();
    state.pending = []; state.subscribers = []; state.namedSubscribers = {}; state.feeds = [];
    state.session = { user: backend.user("model-a"), access_token: "model-token" };
  }
});

it("successive writes on one confirmation key follow the independent row model until authority", async () => {
  const state = backend.state;
  render(<App />); await screen.findByRole("heading", { name: /Model/ });
  const loader = state.loader;
  const choose = random(509);
  const expected = new Map();
  state.fail = "table:chapter_tasks";
  for (const [index, operation] of ["insert", "update", "update", "delete", "insert", "update"].entries()) {
    const saved = { id: "composed-task", title: `Saved version ${index}` };
    if (operation === "delete") expected.delete(saved.id);
    else expected.set(saved.id, saved);
    await flush(() => loader.confirmProjection("task-composed-task", ["table:chapter_tasks"], current => ({
      ...current,
      tasks: operation === "delete" ? current.tasks.filter(row => row.id !== saved.id)
        : operation === "insert" ? [...current.tasks.filter(row => row.id !== saved.id), saved]
          : current.tasks.map(row => row.id === saved.id ? saved : row),
    })));
    const route = ["today", "rights", "messages", "events"][choose(4)];
    await flush(() => go(route));
    let projection;
    await act(async () => { projection = await loader.loadRoute("tasks"); });
    expect(projection.tasks).toEqual([...expected.values()]);
    coverage.successiveWrites += 1;
  }
  state.fail = null;
  state.rows["table:chapter_tasks"] = [{ id: "composed-task", title: "Authoritative version" }];
  let projection;
  await act(async () => { projection = await loader.loadRoute("tasks", { force: true }); });
  expect(projection.tasks).toEqual([expect.objectContaining({ title: "Authoritative version" })]);
  state.rows["table:chapter_tasks"] = [];
  await act(async () => { projection = await loader.loadRoute("tasks", { force: true }); });
  expect(projection.tasks).toEqual([]);
});
