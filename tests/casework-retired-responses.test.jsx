import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
const wrap = node => <LanguageProvider lang="en">{node}</LanguageProvider>;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const panels = [
  {
    name: "Case tools", Component: CaseworkOperationsPanel, read: "loadCaseworkCase", write: "scoreCase",
    data: score => ({ scope: { id: "case", step: "Intake", status: "active", is_restricted: false }, strength: [{ score, band: "strong" }], deadlines: [], checklists: [], transitions: [], alerts: [], management: [], retaliation: [], links: [], reminders: [] }),
    marker: score => new RegExp(`${score}/100`),
    mutate: () => fireEvent.submit(screen.getByRole("button", { name: "Save strength check" }).closest("form")),
    // A write that committed after its case was left (or the panel unmounted)
    // still records its access-history entry through onChanged, once; nothing
    // on screen changes.
    recordsLeftWrite: true,
  },
  // The ULP retaliation-flag panel is left out of Union Ground (legal deadlines).
];

it("keeps current management counts after a retired failure and clears them after a current failure", async () => {
  const old = deferred(), current = deferred(), refreshed = deferred();
  let currentReads = 0;
  const api = {
    loadCaseworkCase: vi.fn(id => Promise.resolve({
      ...panels[0].data(88),
      management: [{ id, summary: `${id} facts`, category: "other", occurred_at: "2026-10-20T12:00:00Z", casework_management_people: { id, display_name: id } }],
    })),
    loadManagementWindow: vi.fn(([id]) => id === "case-a" ? old.promise : (++currentReads === 1 ? current.promise : refreshed.promise)),
  };
  const view = render(wrap(<CaseworkOperationsPanel caseId="case-a" api={api} />));
  await waitFor(() => expect(api.loadManagementWindow).toHaveBeenCalledWith(["case-a"], expect.any(Number)));
  view.rerender(wrap(<CaseworkOperationsPanel caseId="case-b" api={api} />));
  await waitFor(() => expect(api.loadManagementWindow).toHaveBeenCalledWith(["case-b"], expect.any(Number)));
  await act(async () => current.resolve({ "case-b": 4 }));
  expect(view.container.querySelector(".cwk-management-window")).toHaveTextContent("case-b");
  const counts = view.container.querySelector(".cwk-management-window").textContent;
  await act(async () => old.reject(new Error("retired management failure")));
  expect(view.container.querySelector(".cwk-management-window")).toHaveTextContent(counts);
  fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await waitFor(() => expect(api.loadManagementWindow).toHaveBeenCalledTimes(3));
  await act(async () => refreshed.reject(new Error("current management failure")));
  expect(view.container.querySelector(".cwk-management-window")).toBeNull();
  expect(screen.getByText(/case-b facts/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
});

for (const panel of panels) {
  const { Component, read, write, data, marker } = panel;
  const mount = (api, extra = {}) => wrap(<Component caseId="case-a" api={api} {...extra} />);

  it(`${panel.name} clears actionable state while a replacement case loads`, async () => {
    const pending = deferred();
    const api = { [read]: vi.fn().mockResolvedValueOnce(data(11)).mockReturnValueOnce(pending.promise) };
    const ready = vi.fn();
    const view = render(mount(api, { onReadyChange: ready }));
    await screen.findByText(marker(11));
    view.rerender(wrap(<Component caseId="case-b" api={api} onReadyChange={ready} />));
    expect(screen.queryByText(marker(11))).not.toBeInTheDocument();
    await act(async () => pending.resolve(data(88)));
    expect(screen.getByText(marker(88))).toBeInTheDocument();
  });

  it.each(["resolve", "reject"])(`${panel.name} ignores a retired API response: %s`, async outcome => {
    const pending = deferred();
    const oldApi = { [read]: vi.fn().mockReturnValue(pending.promise) };
    const nextApi = { [read]: vi.fn().mockResolvedValue(data(88)) };
    const view = render(mount(oldApi));
    view.rerender(mount(nextApi));
    await screen.findByText(marker(88));
    await act(async () => pending[outcome](outcome === "resolve" ? data(11) : new Error("retired read")));
    expect(screen.getByText(marker(88))).toBeInTheDocument();
    expect(screen.queryByText(marker(11))).not.toBeInTheDocument();
  });

  it(`${panel.name} ignores a failed read from the previous case`, async () => {
    const pending = deferred();
    const api = { [read]: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(data(88)) };
    const ready = vi.fn();
    const view = render(mount(api, { onReadyChange: ready }));
    view.rerender(wrap(<Component caseId="case-b" api={api} onReadyChange={ready} />));
    await screen.findByText(marker(88));
    await act(async () => pending.reject(new Error("case A failed")));
    expect(screen.getByText(marker(88))).toBeInTheDocument();
  });

  it.each(["resolve", "reject"])(`${panel.name} retires a mutation when its case changes: %s`, async outcome => {
    const pending = deferred();
    const api = { [read]: vi.fn(id => Promise.resolve(data(id === "case-a" ? 11 : 88))), [write]: vi.fn().mockReturnValue(pending.promise) };
    const onChanged = vi.fn(), onNotice = vi.fn();
    const view = render(mount(api, { onChanged, onNotice }));
    await screen.findByText(marker(11));
    panel.mutate();
    expect(api[write]).toHaveBeenCalledTimes(1);
    view.rerender(wrap(<Component caseId="case-b" api={api} onChanged={onChanged} onNotice={onNotice} />));
    await screen.findByText(marker(88));
    await act(async () => pending[outcome](outcome === "resolve" ? {} : new Error("retired write")));
    expect(api[read]).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(panel.recordsLeftWrite && outcome === "resolve" ? 1 : 0);
    expect(onNotice).not.toHaveBeenCalled();
    expect(screen.getByText(marker(88))).toBeInTheDocument();
  });

  it(`${panel.name} ignores an old mutation refresh already in flight`, async () => {
    const refresh = deferred();
    const api = { [read]: vi.fn().mockResolvedValueOnce(data(11)).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(data(88)), [write]: vi.fn().mockResolvedValue({}) };
    const view = render(mount(api));
    await screen.findByText(marker(11));
    panel.mutate();
    await waitFor(() => expect(api[read]).toHaveBeenCalledTimes(2));
    view.rerender(wrap(<Component caseId="case-b" api={api} />));
    await screen.findByText(marker(88));
    await act(async () => refresh.resolve(data(12)));
    expect(screen.queryByText(marker(12))).not.toBeInTheDocument();
    expect(screen.getByText(marker(88))).toBeInTheDocument();
  });

  it(`${panel.name} does not refresh or notify after a pending mutation is unmounted`, async () => {
    const pending = deferred();
    const api = { [read]: vi.fn().mockResolvedValue(data(11)), [write]: vi.fn().mockReturnValue(pending.promise) };
    const onChanged = vi.fn(), onNotice = vi.fn();
    const view = render(mount(api, { onChanged, onNotice }));
    await screen.findByText(marker(11));
    panel.mutate();
    view.unmount();
    await act(async () => pending.resolve({}));
    expect(api[read]).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(panel.recordsLeftWrite ? 1 : 0);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it(`${panel.name} retains successful same-case mutation refresh`, async () => {
    const api = { [read]: vi.fn().mockResolvedValueOnce(data(11)).mockResolvedValueOnce(data(88)), [write]: vi.fn().mockResolvedValue({}) };
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(mount(api, { onChanged }));
    await screen.findByText(marker(11));
    panel.mutate();
    await screen.findByText(marker(88));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api[read]).toHaveBeenCalledTimes(2);
  });
}

it('CaseworkOperations keeps the selected case when an earlier case response finishes last', async () => {
  let oldReply;
  let newReply;
  const data = (id, score) => ({ scope: { id, step:'Intake', status:'active', is_restricted:false }, strength:[{score,band:'strong'}], deadlines:[], checklists:[], transitions:[], alerts:[], management:[], retaliation:[], links:[], reminders:[] });
  const api = { loadCaseworkCase: vi.fn(id => new Promise(resolve => { if (id === 'case-a') oldReply = resolve; else newReply = resolve; })) };
  const view = render(wrap(<CaseworkOperationsPanel caseId="case-a" api={api} />));
  await waitFor(() => expect(api.loadCaseworkCase).toHaveBeenCalledWith('case-a'));
  view.rerender(wrap(<CaseworkOperationsPanel caseId="case-b" api={api} />));
  await waitFor(() => expect(api.loadCaseworkCase).toHaveBeenCalledWith('case-b'));
  await act(async () => newReply(data('case-b',88)));
  expect(screen.getByText(/88\/100/)).toBeInTheDocument();
  await act(async () => oldReply(data('case-a',11)));
  expect(screen.queryByText(/11\/100/)).not.toBeInTheDocument();
  expect(screen.getByText(/88\/100/)).toBeInTheDocument();
});

