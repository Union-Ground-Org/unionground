import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StewardView } from "../src/views/StewardView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });
const row = { id: "request-1", userId: "member-1", memberName: "Fictional Worker", memberInitials: "FM", status: "requested", createdAt: "2026-11-01T15:00:00Z", lessonLabel: "Support" };
const desk = { caseload: [], queue: [row], queueTotal: 418, threads: [], broadcasts: [], formsInbox: [], formTemplateVersions: [], kpis: { openRequests: 12, membersCovered: 1001, awaitingReply: 0, broadcasts30d: 0 } };

function start(lang, loadRequests, queueTotal = 418, queueCursor = null, kpis = desk.kpis) {
  window.history.replaceState({}, "", "/m/steward/requests");
  const api = { loadDesk: vi.fn().mockResolvedValue({ ...desk, queueTotal, queueCursor, kpis }), loadRequests };
  render(<LanguageProvider lang={lang}><WorkspacePages view="steward" hat="steward" location="/m/steward/requests" navigate={vi.fn()} menu={false}><StewardView data={{ member: { id: "steward-1", initials: "FS" } }} api={api} onNotice={vi.fn()} /></WorkspacePages></LanguageProvider>);
}

it.each([
  ["en", "418 in all", "12 open", "406 closed", "Open", "Closed", "All"],
  ["es", "418 en total", "12 abiertas", "406 cerradas", "Abiertas", "Cerradas", "Todos"],
])("names each filtered server total beside the open-only header in %s", async (lang, all, open, closed, openFilter, closedFilter, allFilter) => {
  const load = vi.fn(async ({ status }) => ({ rows: [{ ...row, status: status === "closed" ? "closed" : "requested" }], total: status === "open" ? 12 : status === "closed" ? 406 : 1001, nextCursor: null }));
  start(lang, load);
  expect(await screen.findByText(all)).toBeVisible();
  const section = document.getElementById("steward-requests");
  expect(screen.getByText(lang === "en" ? "12 open requests · 1,001 worker profiles you can see" : "12 solicitudes abiertas · 1.001 perfiles de trabajadores que puedes ver")).toBeVisible();
  fireEvent.click(within(section).getByRole("button", { name: openFilter, exact: true }));
  expect(await within(section).findByText(open)).toBeVisible();
  fireEvent.click(within(section).getByRole("button", { name: closedFilter, exact: true }));
  expect(await within(section).findByText(closed)).toBeVisible();
  fireEvent.click(within(section).getByRole("button", { name: allFilter, exact: true }));
  expect(await within(section).findByText(all)).toBeVisible();
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
});

it.each([
  ["en", "12 open requests · Estimated worker profiles: 1,002", "12 open requests · Worker profile count unavailable"],
  ["es", "12 solicitudes abiertas · Estimación de perfiles de trabajadores: 1.002", "12 solicitudes abiertas · Conteo de perfiles de trabajadores no disponible"],
])("keeps a profile estimate and an unavailable count distinct in %s", async (lang, estimate, unavailable) => {
  start(lang, vi.fn(), 418, null, { ...desk.kpis, membersCovered: 1002, membersCoveredIsEstimate: true });
  expect(await screen.findByText(estimate)).toBeVisible();
  cleanup();
  start(lang, vi.fn(), 418, null, { ...desk.kpis, membersCovered: null });
  expect(await screen.findByText(unavailable)).toBeVisible();
});

it.each([
  ["en", false, "12 open requests · 1 worker profile you can see"],
  ["es", false, "12 solicitudes abiertas · 1 perfil de trabajador que puedes ver"],
  ["en", true, "12 open requests · Estimated worker profile: 1"],
  ["es", true, "12 solicitudes abiertas · Estimación: 1 perfil de trabajador"],
])("uses the singular profile count in %s (estimate: %s)", async (lang, membersCoveredIsEstimate, summary) => {
  start(lang, vi.fn(), 418, null, { ...desk.kpis, membersCovered: 1, membersCoveredIsEstimate });
  expect(await screen.findByText(summary)).toBeVisible();
});

it.each([["en", "1,001 in all"], ["es", "1.001 en total"]])("groups the list's total consistently with the header in %s", async (lang, label) => {
  start(lang, vi.fn(), 1001);
  expect(await screen.findByText(label)).toBeVisible();
  expect(screen.getByText(lang === "en" ? "Showing 1 of 1,001" : "Mostrando 1 de 1.001")).toBeVisible();
});

it.each([
  ["en", "Open", "open", "12 open", 12],
  ["en", "Closed", "closed", "406 closed", 406],
  ["es", "Abiertas", "open", "12 abiertas", 12],
  ["es", "Cerradas", "closed", "406 cerradas", 406],
])("hides both previous totals while %s %s is pending, then shows the filtered answer", async (lang, filter, status, label, total) => {
  let answer;
  const load = vi.fn(() => new Promise(resolve => { answer = resolve; }));
  start(lang, load);
  await screen.findByText(lang === "en" ? "418 in all" : "418 en total");
  const section = document.getElementById("steward-requests");
  expect(within(section).getByText(lang === "en" ? "Showing 1 of 418" : "Mostrando 1 de 418")).toBeVisible();
  const selected = within(section).getByRole("button", { name: filter, exact: true });
  fireEvent.click(selected);
  await waitFor(() => expect(answer).toBeTypeOf("function"));
  expect(selected).toHaveAttribute("aria-pressed", "true");
  expect(load).toHaveBeenCalledWith(expect.objectContaining({ status, cursor: null }));
  expect(section).toHaveAttribute("data-load-state", "loading");
  expect(section.querySelector(".cwk-count")).toBeNull();
  // The pager stays mounted for focus and its polite count, which says it is
  // loading instead of the previous total.
  expect(section.querySelector(".sg-pager__count")).toHaveTextContent(lang === "en" ? "Loading…" : "Cargando…");
  expect(section).not.toHaveTextContent("418");
  await act(async () => { answer({ rows: [{ ...row, status: status === "closed" ? "closed" : "requested" }], total, nextCursor: null }); });
  expect(await within(section).findByText(label)).toBeVisible();
  expect(within(section).getByText(lang === "en" ? `Showing 1 of ${total}` : `Mostrando 1 de ${total}`)).toBeVisible();
});

it.each(["en", "es"])("keeps the current pager and busy control while loading another page in %s", async (lang) => {
  let answer;
  const cursor = { id: row.id, createdAt: row.createdAt };
  start(lang, vi.fn(() => new Promise(resolve => { answer = resolve; })), 418, cursor);
  await screen.findByText(lang === "en" ? "418 in all" : "418 en total");
  const section = document.getElementById("steward-requests");
  const more = within(section).getByRole("button", { name: lang === "en" ? "Load more" : "Cargar más" });
  more.focus();
  fireEvent.click(more);
  await waitFor(() => expect(answer).toBeTypeOf("function"));
  expect(within(section).getByText(lang === "en" ? "Showing 1 of 418" : "Mostrando 1 de 418")).toBeVisible();
  // Pending, not natively disabled: Load more keeps focus while its page loads (record 8435).
  expect(more).toBeEnabled();
  expect(more).toHaveAttribute("aria-disabled", "true");
  expect(more).toHaveFocus();
  await act(async () => { answer({ rows: [{ ...row, id: "request-2" }], total: 418, nextCursor: null }); });
  const caption = within(section).getByText(lang === "en" ? "Showing 2 of 418" : "Mostrando 2 de 418");
  expect(caption).toBeVisible();
  expect(caption).toHaveFocus();
});

// G9-8033 r2: a first-page fetch must not unmount a focused pager control.
it.each(["en", "es"])("keeps focus on the pager and announces loading, then the new count, after its own Try again in %s", async (lang) => {
  let answer;
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  start(lang, load);
  await screen.findByText(lang === "en" ? "418 in all" : "418 en total");
  const section = document.getElementById("steward-requests");
  fireEvent.click(within(section).getByRole("button", { name: lang === "en" ? "Open" : "Abiertas", exact: true }));
  await within(section).findByRole("alert");
  const retry = within(section.querySelector(".sg-pager")).getByRole("button", { name: lang === "en" ? "Try again" : "Reintentar" });
  retry.focus();
  fireEvent.click(retry);
  await waitFor(() => expect(answer).toBeTypeOf("function"));
  const count = section.querySelector(".sg-pager__count");
  expect(count).toHaveAttribute("aria-live", "polite");
  expect(count).toHaveTextContent(lang === "en" ? "Loading…" : "Cargando…");
  expect(count).toHaveFocus();
  expect(document.activeElement).not.toBe(document.body);
  await act(async () => { answer({ rows: [row], total: 12, nextCursor: null }); });
  expect(count.isConnected).toBe(true);
  expect(count).toHaveTextContent(lang === "en" ? "Showing 1 of 12" : "Mostrando 1 de 12");
  expect(count).toHaveFocus();
});

it.each(["en", "es"])("keeps a focused Load more through a search refetch, then hands focus to the count in %s", async (lang) => {
  let answer;
  const cursor = { id: row.id, createdAt: row.createdAt };
  const load = vi.fn(() => new Promise(resolve => { answer = resolve; }));
  start(lang, load, 418, cursor);
  await screen.findByText(lang === "en" ? "418 in all" : "418 en total");
  const section = document.getElementById("steward-requests");
  fireEvent.change(within(section).getByRole("searchbox"), { target: { value: "Fictional" } });
  const more = within(section).getByRole("button", { name: lang === "en" ? "Load more" : "Cargar más" });
  more.focus();
  // The toolbar's debounce fires while focus is on the pager control.
  await waitFor(() => expect(load).toHaveBeenCalledWith(expect.objectContaining({ search: "Fictional", cursor: null })));
  expect(more.isConnected).toBe(true);
  expect(more).toHaveFocus();
  expect(more).toHaveAttribute("aria-disabled", "true");
  expect(more).toHaveAttribute("aria-busy", "true");
  expect(more).not.toBeDisabled();
  fireEvent.click(more);
  expect(load).toHaveBeenCalledTimes(1);
  const count = section.querySelector(".sg-pager__count");
  expect(count).toHaveTextContent(lang === "en" ? "Loading…" : "Cargando…");
  // The answer fits on one page, so Load more leaves; focus goes to the count.
  await act(async () => { answer({ rows: [row], total: 1, nextCursor: null }); });
  expect(more.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(document.body);
  // The same polite region now holds the new count, and focus rests on it.
  expect(count.isConnected).toBe(true);
  expect(count).toHaveFocus();
  expect(count).toHaveTextContent(lang === "en" ? "Showing 1 of 1" : "Mostrando 1 de 1");
  // Tabbing away lets the one-page list drop its pager as before.
  fireEvent.blur(count, { relatedTarget: within(section).getByRole("searchbox") });
  expect(section.querySelector(".sg-pager")).toBeNull();
});
