import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const hub = (drafts = []) => ({ workspaces: [], patterns: [], drafts });
const row = (id, title, revision = 4) => ({ id, revision, payload: { title, notes: `${title} notes` }, case_id: null });
const tick = (ms = 700) => act(async () => vi.advanceTimersByTimeAsync(ms));
const titleInput = () => screen.getByLabelText("Draft title");
const notesInput = () => screen.getByLabelText("Intake notes");

async function mountScope(existing = false) {
  vi.useFakeTimers();
  const loads = [];
  const saves = [];
  const onNotice = vi.fn();
  const api = {
    loadCaseworkHub: vi.fn((chapterId) => new Promise((resolve, reject) => loads.push({ chapterId, resolve, reject }))),
    saveIntakeDraft: vi.fn((fields) => new Promise((resolve, reject) => saves.push({ fields, resolve, reject }))),
  };
  let view;
  await act(async () => { view = render(<CaseworkHubPanel chapterId="chapter-a" api={api} onNotice={onNotice} />); });
  await act(async () => loads[0].resolve(hub(existing ? [row("draft-a", "Saved A")] : [])));
  const switchTo = async (chapterId, replacement = api) => act(async () => {
    view.rerender(<CaseworkHubPanel chapterId={chapterId} api={replacement} onNotice={onNotice} />);
  });
  const complete = async (index, id, revision) => act(async () => saves[index].resolve({ id, revision, updated_at: "2026-10-20T20:00:00Z" }));
  return { view, api, loads, saves, onNotice, switchTo, complete };
}

it("never autosaves unsaved A text under B after B's empty load resolves", async () => {
  const draft = await mountScope();
  fireEvent.change(titleInput(), { target: { value: "Private chapter A intake" } });
  await draft.switchTo("chapter-b");
  await act(async () => draft.loads[1].resolve(hub()));
  await tick();
  expect(draft.api.saveIntakeDraft).not.toHaveBeenCalledWith(expect.objectContaining({
    chapterId: "chapter-b", payload: expect.objectContaining({ title: "Private chapter A intake" }),
  }));
});

it.each([false, true])("never writes A's pending text or identity to B before autosave (existing=%s)", async (existing) => {
  const draft = await mountScope(existing);
  fireEvent.change(titleInput(), { target: { value: "Private chapter A intake" } });
  await tick(400);
  await draft.switchTo("chapter-b");
  // B's load is still pending. A's editor must retire immediately instead of
  // exposing stale fields or using A's loaded row as B's initial draft.
  expect(screen.queryByLabelText("Draft title")).toBeNull();
  await act(async () => draft.loads[1].resolve(hub([row("draft-b", "Saved B", 9)])));
  expect(titleInput()).toHaveValue("Saved B");
  expect(notesInput()).toHaveValue("Saved B notes");
  await tick();
  expect(draft.saves).toHaveLength(1);
  expect(draft.saves[0].fields).toMatchObject({
    id: existing ? "draft-a" : null, revision: existing ? 4 : 0,
    chapterId: "chapter-a", payload: { title: "Private chapter A intake" },
  });
  await draft.complete(0, "draft-a", existing ? 5 : 1);
  fireEvent.change(titleInput(), { target: { value: "Only chapter B" } });
  await tick();
  expect(draft.saves[1].fields).toMatchObject({ id: "draft-b", revision: 9, chapterId: "chapter-b", payload: { title: "Only chapter B" } });
  await draft.complete(1, "draft-b", 10);
});

it.each([[false, 400], [false, 700], [true, 400], [true, 700]])(
  "finishes A's in-flight save and latest edit only in A while B saves independently (existing=%s, delay=%s)",
  async (existing, delay) => {
    const draft = await mountScope(existing);
    fireEvent.change(titleInput(), { target: { value: "First A edit" } });
    await tick();
    fireEvent.change(notesInput(), { target: { value: "Latest private A notes" } });
    await tick(delay);
    await draft.switchTo("chapter-b");
    await act(async () => draft.loads[1].resolve(hub([row("draft-b", "Saved B", 9)])));
    expect(titleInput()).toHaveValue("Saved B");
    fireEvent.change(titleInput(), { target: { value: "Independent B edit" } });
    await tick();
    expect(draft.saves).toHaveLength(2);
    expect(draft.saves[1].fields).toMatchObject({ id: "draft-b", revision: 9, chapterId: "chapter-b", payload: { title: "Independent B edit" } });
    await draft.complete(0, "draft-a", existing ? 5 : 1);
    expect(draft.saves).toHaveLength(3);
    expect(draft.saves[2].fields).toMatchObject({
      id: "draft-a", revision: existing ? 5 : 1, chapterId: "chapter-a",
      payload: { title: "First A edit", notes: "Latest private A notes" },
    });
    await draft.complete(2, "draft-a", existing ? 6 : 2);
    await draft.complete(1, "draft-b", 10);
    expect(titleInput()).toHaveValue("Independent B edit");
    expect(notesInput()).toHaveValue("Saved B notes");
    expect(draft.onNotice).not.toHaveBeenCalled();
  },
);

it.each([false, true])("keeps a replacement API's draft separate (inFlight=%s)", async (inFlight) => {
  const draft = await mountScope(true);
  fireEvent.change(titleInput(), { target: { value: "Original API private edit" } });
  await tick(inFlight ? 700 : 400);
  if (inFlight) fireEvent.change(notesInput(), { target: { value: "Later original notes" } });
  const replacement = {
    loadCaseworkHub: vi.fn().mockResolvedValue(hub([row("replacement-draft", "Replacement", 12)])),
    saveIntakeDraft: vi.fn().mockResolvedValue({ id: "replacement-draft", revision: 13 }),
  };
  await draft.switchTo("chapter-a", replacement);
  expect(titleInput()).toHaveValue("Replacement");
  await draft.complete(0, "draft-a", 5);
  if (inFlight) {
    expect(draft.saves[1].fields).toMatchObject({ id: "draft-a", revision: 5, chapterId: "chapter-a", payload: { notes: "Later original notes" } });
    await draft.complete(1, "draft-a", 6);
  }
  expect(replacement.saveIntakeDraft).not.toHaveBeenCalled();
  fireEvent.change(titleInput(), { target: { value: "Replacement edit" } });
  await tick();
  expect(replacement.saveIntakeDraft).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    id: "replacement-draft", revision: 12, chapterId: "chapter-a", payload: { title: "Replacement edit", notes: "Replacement notes" },
  }));
});

it("does not duplicate an uncertain create after switching chapters", async () => {
  const draft = await mountScope();
  fireEvent.change(titleInput(), { target: { value: "Uncertain A create" } });
  await tick();
  fireEvent.change(notesInput(), { target: { value: "More A text" } });
  await draft.switchTo("chapter-b");
  await act(async () => draft.loads[1].resolve(hub()));
  await act(async () => draft.saves[0].reject(new Error("Uncertain transport failure")));
  await tick(2000);
  expect(draft.saves).toHaveLength(1);
  expect(titleInput()).toHaveValue("");
  expect(draft.onNotice).toHaveBeenCalledExactlyOnceWith("That casework action could not be saved.");
});

it("never initializes the current intake from a retired asynchronous load", async () => {
  const draft = await mountScope(true);
  // A refresh remains outstanding while B loads and the user starts editing.
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await draft.switchTo("chapter-b");
  await act(async () => draft.loads[2].resolve(hub([row("draft-b", "Saved B", 9)])));
  fireEvent.change(titleInput(), { target: { value: "Current B edit" } });
  await act(async () => draft.loads[1].resolve(hub([row("late-a", "Retired A", 15)])));
  expect(titleInput()).toHaveValue("Current B edit");
  await tick();
  expect(draft.saves).toHaveLength(1);
  expect(draft.saves[0].fields).toMatchObject({ id: "draft-b", revision: 9, chapterId: "chapter-b", payload: { title: "Current B edit", notes: "Saved B notes" } });
  await draft.complete(0, "draft-b", 10);
});

it("keeps the current editor and save queue during a refresh within the same scope", async () => {
  const draft = await mountScope(true);
  fireEvent.change(titleInput(), { target: { value: "Current local edit" } });
  await tick();
  await draft.switchTo("chapter-a");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => draft.loads[1].resolve(hub([row("draft-a", "Older server snapshot", 4)])));
  expect(titleInput()).toHaveValue("Current local edit");
  expect(draft.saves).toHaveLength(1);
  await draft.complete(0, "draft-a", 5);
  fireEvent.change(notesInput(), { target: { value: "Later current notes" } });
  await tick();
  expect(draft.saves[1].fields).toMatchObject({ id: "draft-a", revision: 5, chapterId: "chapter-a", payload: { title: "Current local edit", notes: "Later current notes" } });
  await draft.complete(1, "draft-a", 6);
});

it.each(["success", "failure"])("ignores a retired initial load's %s before an editor ever mounted", async (outcome) => {
  vi.useFakeTimers();
  const loads = [];
  const api = {
    loadCaseworkHub: vi.fn(() => new Promise((resolve, reject) => loads.push({ resolve, reject }))),
    saveIntakeDraft: vi.fn(),
  };
  let view;
  await act(async () => { view = render(<CaseworkHubPanel chapterId="chapter-a" api={api} />); });
  await act(async () => view.rerender(<CaseworkHubPanel chapterId="chapter-b" api={api} />));
  await act(async () => {
    if (outcome === "success") loads[0].resolve(hub([row("draft-a", "Private A")]));
    else loads[0].reject(new Error("Retired A load failed"));
  });
  expect(screen.queryByLabelText("Draft title")).toBeNull();
  await act(async () => loads[1].resolve(hub([row("draft-b", "Saved B", 9)])));
  expect(titleInput()).toHaveValue("Saved B");
  await tick();
  expect(api.saveIntakeDraft).not.toHaveBeenCalled();
});

it.each([[false, false], [false, true], [true, false], [true, true]])(
  "reloads A with its confirmed identity and revision after A-to-B-to-A navigation (existing=%s, finalEdit=%s)",
  async (existing, finalEdit) => {
    vi.useFakeTimers();
    let stored = existing ? row("draft-a", "Saved A", 4) : null;
    const saves = [];
    const api = {
      loadCaseworkHub: vi.fn(async (chapterId) => hub(chapterId === "chapter-a" && stored ? [structuredClone(stored)] : [])),
      saveIntakeDraft: vi.fn((fields) => new Promise((resolve) => saves.push({ fields, resolve }))),
    };
    let view;
    const show = async (chapterId) => act(async () => view.rerender(<CaseworkHubPanel chapterId={chapterId} api={api} />));
    const finish = async (index) => act(async () => {
      const save = saves[index];
      stored = { id: "draft-a", revision: (stored?.revision || 0) + 1, payload: save.fields.payload };
      save.resolve(stored);
    });
    await act(async () => { view = render(<CaseworkHubPanel chapterId="chapter-a" api={api} />); });
    fireEvent.change(titleInput(), { target: { value: "First A edit" } });
    await tick();
    if (finalEdit) fireEvent.change(notesInput(), { target: { value: "Latest retired A notes" } });
    await show("chapter-b");
    await show("chapter-a");
    await finish(0);
    if (finalEdit) {
      expect(saves).toHaveLength(2);
      await finish(1);
    }
    expect(titleInput()).toHaveValue("First A edit");
    fireEvent.change(titleInput(), { target: { value: "New edit after returning to A" } });
    await tick();
    expect(saves.at(-1).fields).toMatchObject({
      id: "draft-a", revision: (existing ? 4 : 0) + (finalEdit ? 2 : 1), chapterId: "chapter-a",
      payload: { title: "New edit after returning to A", notes: finalEdit ? "Latest retired A notes" : existing ? "Saved A notes" : "" },
    });
    await finish(saves.length - 1);
  },
);

it.each([false, true])("recovers the confirmed row after an uncertain retired create on re-entry (inFlight=%s)", async (inFlight) => {
  vi.useFakeTimers();
  let stored = null;
  const saves = [];
  const onNotice = vi.fn();
  const api = {
    loadCaseworkHub: vi.fn(async (chapterId) => hub(chapterId === "chapter-a" && stored ? [stored] : [])),
    saveIntakeDraft: vi.fn((fields) => new Promise((resolve, reject) => saves.push({ fields, resolve, reject }))),
  };
  let view;
  const show = async (chapterId) => act(async () => view.rerender(<CaseworkHubPanel chapterId={chapterId} api={api} onNotice={onNotice} />));
  await act(async () => { view = render(<CaseworkHubPanel chapterId="chapter-a" api={api} onNotice={onNotice} />); });
  fireEvent.change(titleInput(), { target: { value: "Transport-uncertain A create" } });
  await tick(inFlight ? 700 : 400);
  await show("chapter-b");
  await show("chapter-a");
  expect(saves).toHaveLength(1);
  // The server committed the create, but the client never got its response.
  // A fresh load, after the failed queue settles, is the source of identity.
  stored = row("server-committed-a", "Transport-uncertain A create", 1);
  await act(async () => saves[0].reject(new Error("Response lost after commit")));
  expect(titleInput()).toHaveValue("Transport-uncertain A create");
  expect(onNotice).toHaveBeenCalledExactlyOnceWith("That casework action could not be saved.");
  fireEvent.change(titleInput(), { target: { value: "Edit after recovery" } });
  await tick();
  expect(saves).toHaveLength(2);
  expect(saves[1].fields).toMatchObject({ id: "server-committed-a", revision: 1, chapterId: "chapter-a", payload: { title: "Edit after recovery" } });
  await act(async () => saves[1].resolve({ id: "server-committed-a", revision: 2 }));
});

it("keeps B active when a waiting return to A is retired before its write settles", async () => {
  const draft = await mountScope(true);
  fireEvent.change(titleInput(), { target: { value: "Still saving A" } });
  await tick();
  await draft.switchTo("chapter-b");
  await act(async () => draft.loads[1].resolve(hub([row("draft-b", "Saved B", 9)])));
  await draft.switchTo("chapter-a");
  expect(screen.queryByLabelText("Draft title")).toBeNull();
  await draft.switchTo("chapter-b");
  await act(async () => draft.loads[2].resolve(hub([row("draft-b", "Saved B", 9)])));
  await draft.complete(0, "draft-a", 5);
  expect(titleInput()).toHaveValue("Saved B");
  expect(draft.loads.filter((load) => load.chapterId === "chapter-a")).toHaveLength(1);
});
