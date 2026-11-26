import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChapterAppointmentsPanel } from "../src/components/ChapterAppointmentsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
const wrap = node => <LanguageProvider lang="en">{node}</LanguageProvider>;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const appointment = id => ({ id, memberName: `Member ${id}`, appointmentType: "office_hours", durationMinutes: 30,
  startsAt: "2030-08-20T14:00:00Z", endsAt: "2030-08-20T14:30:00Z", status: "confirmed", stewardName: "Current steward" });
const apiWith = loader => ({
  loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [appointment("A"), appointment("B")], nextCursor: null, total: 2 }),
  loadChapterAppointmentCandidates: loader,
});
const panel = api => wrap(<ChapterAppointmentsPanel api={api} />);
async function open(id) {
  fireEvent.click(within(await screen.findByRole("article", { name: `Member ${id}` })).getByRole("button", { name: "Reassign" }));
}
const cancel = () => fireEvent.click(screen.getByRole("button", { name: "Cancel reassignment" }));

it("ignores a queued retry after the reassignment has been closed", async () => {
  const api = apiWith(vi.fn().mockRejectedValue(new Error("candidate read failed")));
  render(panel(api));
  await open("A");
  const retry = await screen.findByRole("button", { name: t("en", "appointmentSupervision.candidateRetry") });
  act(() => {
    cancel();
    fireEvent.click(retry);
  });
  expect(api.loadChapterAppointmentCandidates).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});

it.each(["resolve", "reject"])("ignores a closed request when the same appointment is reopened: %s", async outcome => {
  const old = deferred(), current = deferred();
  const api = apiWith(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
  render(panel(api));
  await open("A");
  cancel();
  await open("A");
  await act(async () => current.resolve([{ id: "current", name: "Current candidate" }]));
  await act(async () => old[outcome](outcome === "resolve" ? [{ id: "old", name: "Retired candidate" }] : new Error("old failure")));
  expect(screen.getByRole("option", { name: "Current candidate" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Retired candidate" })).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["resolve", "reject"])("retires pending candidates on API replacement: %s", async outcome => {
  const old = deferred(), current = deferred();
  const api = apiWith(vi.fn().mockReturnValue(old.promise));
  const nextApi = apiWith(vi.fn().mockReturnValue(current.promise));
  const view = render(panel(api));
  await open("A");
  view.rerender(panel(nextApi));
  await waitFor(() => expect(nextApi.loadChapterAppointmentCandidates).toHaveBeenCalledWith("A"));
  await act(async () => current.resolve([{ id: "current", name: "Current candidate" }]));
  await act(async () => old[outcome](outcome === "resolve" ? [{ id: "old", name: "Retired candidate" }] : new Error("old API failure")));
  expect(screen.getByRole("option", { name: "Current candidate" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("hides loaded candidates and clears consent when the API changes", async () => {
  const current = deferred();
  const api = apiWith(vi.fn().mockResolvedValue([{ id: "old", name: "Previous candidate" }]));
  const nextApi = apiWith(vi.fn().mockReturnValue(current.promise));
  const view = render(panel(api));
  await open("A");
  await screen.findByRole("option", { name: "Previous candidate" });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "old" } });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Save reassignment" })).toBeEnabled();
  view.rerender(panel(nextApi));
  expect(screen.queryByRole("option", { name: "Previous candidate" })).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Save reassignment" })).toBeDisabled();
  await act(async () => current.resolve([{ id: "new", name: "New candidate" }]));
  expect(screen.getByRole("combobox")).toHaveValue("");
});

it("retires unmounted requests without affecting a later panel", async () => {
  const old = deferred();
  const view = render(panel(apiWith(vi.fn().mockReturnValue(old.promise))));
  await open("A");
  view.unmount();
  render(panel(apiWith(vi.fn().mockResolvedValue([{ id: "new", name: "Mounted candidate" }]))));
  await open("B");
  await screen.findByRole("option", { name: "Mounted candidate" });
  await act(async () => old.reject(new Error("unmounted request")));
  expect(screen.getByRole("option", { name: "Mounted candidate" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it('ChapterAppointments ignores candidates returned for a previously closed appointment', async () => {
  let oldReply;
  let newReply;
  const appointment = (id, memberName) => ({ id, memberName, appointmentType: 'office_hours', durationMinutes: 30,
    startsAt: '2030-08-20T14:00:00Z', endsAt: '2030-08-20T14:30:00Z', status: 'confirmed', stewardName: 'Current steward' });
  const api = {
    loadChapterAppointments: vi.fn().mockResolvedValue({ rows: [appointment('a','Member A'),appointment('b','Member B')], nextCursor: null, total: 2 }),
    loadChapterAppointmentCandidates: vi.fn(id => new Promise(resolve => { if (id === 'a') oldReply = resolve; else newReply = resolve; })),
  };
  render(wrap(<ChapterAppointmentsPanel api={api} />));
  fireEvent.click(within(await screen.findByRole('article', { name: 'Member A' })).getByRole('button', { name: 'Reassign' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel reassignment' }));
  fireEvent.click(within(screen.getByRole('article', { name: 'Member B' })).getByRole('button', { name: 'Reassign' }));
  await act(async () => newReply([{ id:'b-only', name:'Candidate B' }]));
  expect(screen.getByRole('option', { name:'Candidate B' })).toBeInTheDocument();
  await act(async () => oldReply([{ id:'a-only', name:'Candidate A' }]));
  expect(screen.queryByRole('option', { name:'Candidate A' })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name:'Candidate B' })).toBeInTheDocument();
});

