import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";

afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mountDraft(existing = false) {
  vi.useFakeTimers();
  const requests = [];
  const onNotice = vi.fn();
  const api = {
    loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], patterns: [], drafts: existing
      ? [{ id: "draft-existing", revision: 4, payload: { title: "Existing", notes: "Notes" }, updated_at: "2026-09-07T10:00:00Z" }]
      : [] }),
    saveIntakeDraft: vi.fn((fields) => new Promise((resolve, reject) => requests.push({ fields, resolve, reject }))),
  };
  let view;
  await act(async () => { view = render(<CaseworkHubPanel chapterId="chapter-fixture" api={api} onNotice={onNotice} />); });
  const panel = within(screen.getByRole("heading", { name: "Intake draft autosave" }).closest("article"));
  const edit = async (title) => {
    fireEvent.change(panel.getByLabelText("Draft title"), { target: { value: title } });
    await act(async () => vi.advanceTimersByTimeAsync(700));
  };
  const complete = async (index, revision) => act(async () => requests[index].resolve({
    id: existing ? "draft-existing" : "draft-created", revision, updated_at: "2026-09-07T12:00:00Z",
  }));
  return { ...view, api, requests, onNotice, panel, edit, complete };
}

it.each([false, true])("serializes overlapping intake saves using the confirmed identity and revision (existing=%s)", async (existing) => {
  const draft = await mountDraft(existing);
  await draft.edit("First edit");
  await draft.edit("Latest edit");
  expect(draft.api.saveIntakeDraft).toHaveBeenCalledTimes(1);
  expect(draft.requests[0].fields).toMatchObject({ id: existing ? "draft-existing" : null, revision: existing ? 4 : 0 });
  await draft.complete(0, existing ? 5 : 1);
  expect(draft.api.saveIntakeDraft).toHaveBeenCalledTimes(2);
  expect(draft.requests[1].fields).toMatchObject({
    id: existing ? "draft-existing" : "draft-created", revision: existing ? 5 : 1,
    chapterId: "chapter-fixture", payload: { title: "Latest edit" },
  });
  expect(draft.panel.getByText(/^Saving/)).toBeInTheDocument();
  await draft.complete(1, existing ? 6 : 2);
  expect(draft.panel.queryByText(/^Saving/)).toBeNull();
  expect(draft.onNotice).not.toHaveBeenCalled();
});

it("coalesces pending edits and continues normally after a completed save", async () => {
  const draft = await mountDraft();
  await draft.edit("First");
  await draft.edit("Superseded pending edit");
  await draft.edit("Newest pending edit");
  expect(draft.requests).toHaveLength(1);
  await draft.complete(0, 1);
  expect(draft.requests).toHaveLength(2);
  expect(draft.requests[1].fields.payload.title).toBe("Newest pending edit");
  await draft.complete(1, 2);
  await draft.edit("Edit after completion");
  expect(draft.requests).toHaveLength(3);
  expect(draft.requests[2].fields).toMatchObject({ id: "draft-created", revision: 2, payload: { title: "Edit after completion" } });
  await draft.complete(2, 3);
});

it("keeps local edits and reports a failed save without retrying in a loop", async () => {
  const draft = await mountDraft(true);
  await draft.edit("First");
  await draft.edit("Still visible locally");
  expect(draft.requests).toHaveLength(1);
  const failure = Object.assign(new Error("Save intake draft: draft changed"), { code: "40001" });
  await act(async () => draft.requests[0].reject(failure));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  // BUG-UG-CASEWORK-PANELS-RAW-DRIVER-ERROR-TEXT-20260920: the raw server
  // sentence stays off the notice; the member reads catalogue copy instead.
  expect(draft.onNotice).toHaveBeenCalledExactlyOnceWith("That casework action could not be saved.");
  expect(draft.panel.getByLabelText("Draft title")).toHaveValue("Still visible locally");
  expect(draft.panel.queryByText(/^Saving/)).toBeNull();
  expect(draft.requests).toHaveLength(1);
  await draft.edit("Retry after another edit");
  expect(draft.requests).toHaveLength(2);
  expect(draft.requests[1].fields).toMatchObject({ id: "draft-existing", revision: 4 });
  await draft.complete(1, 5);
  expect(draft.panel.getByText(/^Saved/)).toBeInTheDocument();
});

// Lane T's deferred-save reproduction: type later notes, leave, then confirm
// the first save. Cover both a pending debounce and an already queued edit.
it.each([[false, 400], [false, 700], [true, 400], [true, 700]])(
  "flushes later edits after a successful in-flight save on navigation (existing=%s, debounce=%s)",
  async (existing, debounceMs) => {
    const draft = await mountDraft(existing);
    await draft.edit("First edit");
    fireEvent.change(draft.panel.getByLabelText("Intake notes"), { target: { value: "Later unsaved notes" } });
    await act(async () => vi.advanceTimersByTimeAsync(debounceMs));
    draft.unmount();
    expect(draft.requests).toHaveLength(1);
    await draft.complete(0, existing ? 5 : 1);
    expect(draft.requests).toHaveLength(2);
    expect(draft.requests[1].fields).toEqual({
      id: existing ? "draft-existing" : "draft-created", revision: existing ? 5 : 1,
      chapterId: "chapter-fixture", caseId: null,
      payload: { title: "First edit", notes: "Later unsaved notes" },
    });
    await draft.complete(1, existing ? 6 : 2);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(draft.requests).toHaveLength(2);
    expect(draft.onNotice).not.toHaveBeenCalled();
  },
);

it("does not repeat a successful in-flight save on navigation without later changes", async () => {
  const draft = await mountDraft();
  await draft.edit("First edit");
  draft.unmount();
  await draft.complete(0, 1);
  expect(draft.requests).toHaveLength(1);
});

it("reports a failed final navigation save without retrying it", async () => {
  const draft = await mountDraft();
  await draft.edit("First edit");
  fireEvent.change(draft.panel.getByLabelText("Intake notes"), { target: { value: "Later unsaved notes" } });
  draft.unmount();
  await draft.complete(0, 1);
  expect(draft.requests).toHaveLength(2);
  await act(async () => draft.requests[1].reject(new Error("Uncertain transport failure")));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(draft.requests).toHaveLength(2);
  expect(draft.onNotice).toHaveBeenCalledExactlyOnceWith("That casework action could not be saved.");
});

it("keeps a retired save bound to its original chapter and API after another hub mounts", async () => {
  const draft = await mountDraft();
  await draft.edit("First edit");
  fireEvent.change(draft.panel.getByLabelText("Intake notes"), { target: { value: "Original chapter notes" } });
  draft.unmount();
  const replacementApi = {
    loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], patterns: [], drafts: [] }),
    saveIntakeDraft: vi.fn(),
  };
  await act(async () => render(<CaseworkHubPanel chapterId="replacement-chapter" api={replacementApi} />));
  await draft.complete(0, 1);
  expect(draft.requests).toHaveLength(2);
  expect(draft.requests[1].fields).toMatchObject({
    id: "draft-created", revision: 1, chapterId: "chapter-fixture",
    payload: { title: "First edit", notes: "Original chapter notes" },
  });
  expect(replacementApi.saveIntakeDraft).not.toHaveBeenCalled();
  await draft.complete(1, 2);
});

it("still reports an in-flight write failure after the panel unmounts", async () => {
  const draft = await mountDraft();
  await draft.edit("Pending write");
  draft.unmount();
  await act(async () => draft.requests[0].reject(new Error("Save intake draft: draft changed")));
  expect(draft.onNotice).toHaveBeenCalledExactlyOnceWith("That casework action could not be saved.");
  expect(draft.requests).toHaveLength(1);
});

it.each([false, true])("flushes title and notes on unmount before the debounce expires (existing=%s)", async (existing) => {
  const draft = await mountDraft(existing);
  fireEvent.change(draft.panel.getByLabelText("Draft title"), { target: { value: "Kept title" } });
  fireEvent.change(draft.panel.getByLabelText("Intake notes"), { target: { value: "Kept notes" } });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(draft.api.saveIntakeDraft).not.toHaveBeenCalled();
  draft.unmount();
  expect(draft.api.saveIntakeDraft).toHaveBeenCalledTimes(1);
  expect(draft.requests[0].fields).toMatchObject({
    id: existing ? "draft-existing" : null,
    revision: existing ? 4 : 0,
    chapterId: "chapter-fixture",
    caseId: null,
    payload: { title: "Kept title", notes: "Kept notes" },
  });
});

it.each([false, true])("does not retry a failed save on unmount without another edit (existing=%s)", async (existing) => {
  const draft = await mountDraft(existing);
  await draft.edit("Failed payload");
  expect(draft.requests).toHaveLength(1);
  expect(draft.requests[0].fields).toMatchObject({
    id: existing ? "draft-existing" : null,
    revision: existing ? 4 : 0,
    payload: { title: "Failed payload" },
  });
  const failure = Object.assign(new Error("Save intake draft: draft changed"), { code: "40001" });
  await act(async () => draft.requests[0].reject(failure));
  expect(draft.onNotice).toHaveBeenCalledExactlyOnceWith("That casework action could not be saved.");
  draft.unmount();
  expect(draft.requests).toHaveLength(1);
});

it("flushes a later edit after a failed save when leaving before debounce", async () => {
  const draft = await mountDraft(true);
  await draft.edit("Failed payload");
  await act(async () => draft.requests[0].reject(new Error("Save intake draft: draft changed")));
  fireEvent.change(draft.panel.getByLabelText("Draft title"), { target: { value: "Retry title" } });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(draft.requests).toHaveLength(1);
  draft.unmount();
  expect(draft.requests).toHaveLength(2);
  expect(draft.requests[1].fields).toMatchObject({
    id: "draft-existing",
    revision: 4,
    payload: { title: "Retry title" },
  });
});

it("does not start a second save when unmounting during an in-flight write after later typing", async () => {
  const draft = await mountDraft();
  await draft.edit("First");
  expect(draft.requests).toHaveLength(1);
  fireEvent.change(draft.panel.getByLabelText("Draft title"), { target: { value: "More text" } });
  fireEvent.change(draft.panel.getByLabelText("Intake notes"), { target: { value: "Also notes" } });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  draft.unmount();
  await act(async () => draft.requests[0].reject(new Error("Save intake draft: draft changed")));
  expect(draft.onNotice).toHaveBeenCalledExactlyOnceWith("That casework action could not be saved.");
  expect(draft.requests).toHaveLength(1);
});
