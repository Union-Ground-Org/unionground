import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { flushSync } from "react-dom";
const wrap = node => <LanguageProvider lang="en">{node}</LanguageProvider>;
const hub = title => ({ workspaces: [{ id: title, title, status: "planning", proposals: [], events: [] }], drafts: [], patterns: [] });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const panel = (api, chapterId = "chapter-a", onNotice = undefined) => wrap(<CaseworkHubPanel chapterId={chapterId} api={api} onNotice={onNotice} />);

it("recovers from a current read failure when the user retries", async () => {
  const api = { loadCaseworkHub: vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(hub("Recovered chapter")) };
  render(panel(api));
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await screen.findByText("Recovered chapter");
  expect(api.loadCaseworkHub).toHaveBeenCalledTimes(2);
});

it("deduplicates a second submitted action while the first write is pending", async () => {
  const save = deferred();
  const api = { loadCaseworkHub: vi.fn().mockResolvedValue(hub("Current chapter")), createBargainingWorkspace: vi.fn().mockReturnValue(save.promise) };
  render(panel(api));
  const name = await screen.findByLabelText("Workspace title");
  fireEvent.change(name, { target: { value: "New workspace" } });
  const form = name.closest("form");
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(api.createBargainingWorkspace).toHaveBeenCalledTimes(1);
  await act(async () => save.resolve({}));
});

it("does not reload a retired chapter when a successful form reset navigates away", async () => {
  const save = deferred(), onNotice = vi.fn();
  const api = { loadCaseworkHub: vi.fn(chapter => Promise.resolve(hub(chapter))), createBargainingWorkspace: vi.fn().mockReturnValue(save.promise) };
  const view = render(panel(api, "chapter-a", onNotice));
  const name = await screen.findByLabelText("Workspace title");
  fireEvent.change(name, { target: { value: "New workspace" } });
  const form = name.closest("form");
  form.addEventListener("reset", () => flushSync(() => view.rerender(panel(api, "chapter-b", onNotice))), { once: true });
  fireEvent.submit(form);
  await act(async () => save.resolve({}));
  await screen.findByText("chapter-b");
  expect(api.loadCaseworkHub.mock.calls).toEqual([["chapter-a"], ["chapter-b"]]);
  expect(onNotice).not.toHaveBeenCalled();
});

it.each(["chapter", "API"])("hides the previous rows and actions during a %s change", async change => {
  const pending = deferred();
  const api = { loadCaseworkHub: vi.fn().mockResolvedValueOnce(hub("Previous chapter")).mockReturnValueOnce(pending.promise) };
  const view = render(panel(api));
  await screen.findByText("Previous chapter");
  const nextApi = change === "API" ? { loadCaseworkHub: vi.fn().mockReturnValue(pending.promise) } : api;
  view.rerender(panel(nextApi, change === "chapter" ? "chapter-b" : "chapter-a"));
  expect(screen.queryByText("Previous chapter")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
  await act(async () => pending.resolve(hub("Current chapter")));
  expect(screen.getByText("Current chapter")).toBeInTheDocument();
});

it.each(["chapter", "API"])("ignores errors from a retired %s", async change => {
  const pending = deferred();
  const api = { loadCaseworkHub: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(hub("Current chapter")) };
  const view = render(panel(api));
  const nextApi = change === "API" ? { loadCaseworkHub: vi.fn().mockResolvedValue(hub("Current chapter")) } : api;
  view.rerender(panel(nextApi, change === "chapter" ? "chapter-b" : "chapter-a"));
  await screen.findByText("Current chapter");
  await act(async () => pending.reject(new Error("retired read")));
  expect(screen.getByText("Current chapter")).toBeInTheDocument();
});

it.each(["resolve", "reject"])("keeps the newest same-chapter refresh when an older refresh finishes: %s", async outcome => {
  const old = deferred(), latest = deferred();
  const api = { loadCaseworkHub: vi.fn().mockResolvedValueOnce(hub("Initial chapter")).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise) };
  render(panel(api));
  await screen.findByText("Initial chapter");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => latest.resolve(hub("Latest refresh")));
  await act(async () => old[outcome](outcome === "resolve" ? hub("Retired refresh") : new Error("retired failure")));
  expect(screen.getByText("Latest refresh")).toBeInTheDocument();
  expect(screen.queryByText("Retired refresh")).not.toBeInTheDocument();
});

it.each(["switch", "unmount"])("retires mutation refresh and notices on %s", async action => {
  const save = deferred(), onNotice = vi.fn();
  const api = { loadCaseworkHub: vi.fn().mockResolvedValue(hub("Initial chapter")), createBargainingWorkspace: vi.fn().mockReturnValue(save.promise) };
  const view = render(panel(api, "chapter-a", onNotice));
  fireEvent.change(await screen.findByLabelText("Workspace title"), { target: { value: "New workspace" } });
  fireEvent.submit(screen.getByRole("button", { name: "Create workspace" }).closest("form"));
  expect(api.createBargainingWorkspace).toHaveBeenCalledTimes(1);
  if (action === "switch") view.rerender(panel(api, "chapter-b", onNotice));
  else view.unmount();
  const reads = api.loadCaseworkHub.mock.calls.length;
  await act(async () => save.resolve({}));
  expect(api.loadCaseworkHub).toHaveBeenCalledTimes(reads);
  expect(onNotice).not.toHaveBeenCalled();
});

it('CaseworkHub keeps the newest chapter response when the retired request completes last', async () => {
  let oldReply;
  let newReply;
  const api = { loadCaseworkHub: vi.fn(chapter => new Promise(resolve => {
    if (chapter === 'chapter-a') oldReply = resolve;
    else newReply = resolve;
  })) };
  const view = render(wrap(<CaseworkHubPanel chapterId="chapter-a" api={api} />));
  await waitFor(() => expect(api.loadCaseworkHub).toHaveBeenCalledWith('chapter-a'));
  view.rerender(wrap(<CaseworkHubPanel chapterId="chapter-b" api={api} />));
  await waitFor(() => expect(api.loadCaseworkHub).toHaveBeenCalledWith('chapter-b'));
  await act(async () => newReply(hub('Chapter B current')));
  expect(screen.getByText('Chapter B current')).toBeInTheDocument();
  await act(async () => oldReply(hub('Chapter A retired')));
  expect(screen.queryByText('Chapter A retired')).not.toBeInTheDocument();
  expect(screen.getByText('Chapter B current')).toBeInTheDocument();
});

