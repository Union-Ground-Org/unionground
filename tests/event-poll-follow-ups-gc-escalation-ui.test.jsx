// REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001 and
// REQ-UG-GC-ESCALATION-FLAGS-20261001: the steward's draft announcements
// and the coordinator's deadline escalation badges.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnouncementDrafts } from "../src/components/AnnouncementDrafts.jsx";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import { loadCaseworkEscalationFlags } from "../src/lib/caseworkApi.js";
import { listAnnouncementDrafts, resolveAnnouncementDraft } from "../src/lib/memberApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const DRAFT = { id: "d1", title: "Upcoming: Contract town hall", body: "Contract town hall\n\nDate: Monday, October 5", eventId: "e1", createdAt: "2026-10-02T10:00:00Z" };

describe("announcement drafts", () => {
  it("omits the draft controls when the desk supplies no draft adapter", () => {
    const view = render(<LanguageProvider lang="en"><AnnouncementDrafts onUse={vi.fn()} /></LanguageProvider>);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows an initial draft-load failure and lets the Steward retry", async () => {
    const api = { listDrafts: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([DRAFT]) };
    render(<LanguageProvider lang="en"><AnnouncementDrafts api={api} onUse={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Drafts couldn’t be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("listitem")).toHaveTextContent(DRAFT.title);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears stale rows after an unconfirmed dismissal and a failed re-read, then retries only the read in Spanish", async () => {
    const api = {
      listDrafts: vi.fn().mockResolvedValueOnce([DRAFT]).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]),
      resolveDraft: vi.fn().mockRejectedValueOnce(new Error("offline")),
    };
    render(<LanguageProvider lang="es"><AnnouncementDrafts api={api} onUse={vi.fn()} /></LanguageProvider>);
    const dismiss = await screen.findByRole("button", { name: /Descartar borrador/ });
    fireEvent.click(dismiss);
    expect(await screen.findByText("No se pudieron cargar los borradores.")).toHaveAttribute("role", "alert");
    expect(screen.getByText(/^No se pudo confirmar si se descartó el borrador/)).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("listitem")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.resolveDraft).toHaveBeenCalledOnce();
    expect(api.listDrafts).toHaveBeenCalledTimes(3);
  });

  it("does not restore a dismissed draft from an older read when the replacement read fails", async () => {
    let finishOldRead, finishDismiss;
    const api = {
      listDrafts: vi.fn().mockResolvedValueOnce([DRAFT])
        .mockImplementationOnce(() => new Promise((resolve) => { finishOldRead = resolve; }))
        .mockRejectedValueOnce(new Error("offline")),
      resolveDraft: vi.fn(() => new Promise((resolve) => { finishDismiss = resolve; })),
    };
    const view = (refreshKey) => <LanguageProvider lang="en"><AnnouncementDrafts api={api} refreshKey={refreshKey} onUse={vi.fn()} /></LanguageProvider>;
    const { rerender } = render(view(0));
    const dismiss = await screen.findByRole("button", { name: /^Dismiss draft/ });
    rerender(view(1));
    fireEvent.click(dismiss);
    await act(async () => {
      finishDismiss({});
      await Promise.resolve();
      finishOldRead([DRAFT]);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Drafts couldn’t be loaded.");
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Dismiss draft/ })).toBeNull();
  });

  it("holds another dismissal until its unconfirmed result has been re-read", async () => {
    let reject, finish;
    const other = { ...DRAFT, id: "d2", title: "Steward training" };
    const api = {
      listDrafts: vi.fn().mockResolvedValueOnce([DRAFT, other]).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })),
      resolveDraft: vi.fn(() => new Promise((_, fail) => { reject = fail; })),
    };
    render(<LanguageProvider lang="en"><AnnouncementDrafts api={api} onUse={vi.fn()} /></LanguageProvider>);
    const button = await screen.findByRole("button", { name: `Dismiss draft: ${DRAFT.title}` });
    const otherButton = screen.getByRole("button", { name: `Dismiss draft: ${other.title}` });
    fireEvent.click(button);
    await act(async () => {
      reject(new Error("offline"));
      await Promise.resolve();
      fireEvent.click(otherButton);
    });
    await waitFor(() => expect(api.listDrafts).toHaveBeenCalledTimes(2));
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(api.resolveDraft).toHaveBeenCalledOnce();
    await act(async () => finish([DRAFT, other]));
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn’t confirm whether the draft was dismissed.");
  });

  it("clears previously shown drafts after an uncoded permission refusal", async () => {
    const api = { listDrafts: vi.fn().mockResolvedValueOnce([DRAFT]).mockRejectedValueOnce(new Error("chapter steward role required")) };
    const view = (refreshKey) => <LanguageProvider lang="en"><AnnouncementDrafts api={api} refreshKey={refreshKey} onUse={vi.fn()} /></LanguageProvider>;
    const { rerender } = render(view(0));
    await screen.findByRole("listitem");
    rerender(view(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Drafts couldn’t be loaded.");
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("does not carry a failed dismissal or reload into a replacement draft scope", async () => {
    let reject;
    const first = { listDrafts: vi.fn().mockResolvedValue([DRAFT]), resolveDraft: vi.fn(() => new Promise((_, fail) => { reject = fail; })) };
    const second = { listDrafts: vi.fn().mockResolvedValue([{ ...DRAFT, title: "Other chapter’s draft" }]) };
    const view = (api) => <LanguageProvider lang="en"><AnnouncementDrafts api={api} onUse={vi.fn()} /></LanguageProvider>;
    const { rerender } = render(view(first));
    fireEvent.click(await screen.findByRole("button", { name: /^Dismiss draft/ }));
    rerender(view(second));
    await screen.findByText("Other chapter’s draft");
    await act(async () => { reject(new Error("offline")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(first.listDrafts).toHaveBeenCalledOnce();
    expect(second.listDrafts).toHaveBeenCalledOnce();
  });

  it("lists drafts, loads one into the composer and dismisses another", async () => {
    const api = { listDrafts: vi.fn().mockResolvedValue([DRAFT]), resolveDraft: vi.fn().mockResolvedValue({}) };
    const onUse = vi.fn();
    render(<LanguageProvider lang="en"><AnnouncementDrafts api={api} onUse={onUse} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Draft announcements to review" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use draft: Upcoming: Contract town hall" }));
    expect(onUse).toHaveBeenCalledWith(DRAFT);
    expect(api.resolveDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss draft: Upcoming: Contract town hall" }));
    await waitFor(() => expect(api.resolveDraft).toHaveBeenCalledWith("d1", "dismissed"));
    await waitFor(() => expect(api.listDrafts).toHaveBeenCalledTimes(2));
  });

  it("renders nothing without drafts or for a viewer the server refuses", async () => {
    const empty = render(<LanguageProvider lang="es"><AnnouncementDrafts api={{ listDrafts: vi.fn().mockResolvedValue([]) }} onUse={vi.fn()} /></LanguageProvider>);
    await waitFor(() => expect(empty.container).toBeEmptyDOMElement());
    empty.unmount();
    const refusal = Object.assign(new Error("chapter steward role required"), { code: "42501" });
    const refused = render(<LanguageProvider lang="es"><AnnouncementDrafts api={{ listDrafts: vi.fn().mockRejectedValue(refusal) }} onUse={vi.fn()} /></LanguageProvider>);
    await waitFor(() => expect(refused.container).toBeEmptyDOMElement());
  });

  it("treats a malformed draft list as empty and ignores a load that settles after unmount", async () => {
    const odd = render(<LanguageProvider lang="en"><AnnouncementDrafts api={{ listDrafts: vi.fn().mockResolvedValue({ drafts: "not a list" }) }} onUse={vi.fn()} /></LanguageProvider>);
    await waitFor(() => expect(odd.container).toBeEmptyDOMElement());
    odd.unmount();
    let finish, fail;
    const late = render(<LanguageProvider lang="en"><AnnouncementDrafts api={{ listDrafts: vi.fn(() => new Promise((resolve) => { finish = resolve; })) }} onUse={vi.fn()} /></LanguageProvider>);
    late.unmount();
    await act(async () => { finish([DRAFT]); });
    const lateFail = render(<LanguageProvider lang="en"><AnnouncementDrafts api={{ listDrafts: vi.fn(() => new Promise((_, reject) => { fail = reject; })) }} onUse={vi.fn()} /></LanguageProvider>);
    lateFail.unmount();
    await act(async () => { fail(new Error("late")); });
  });

  it("reads and resolves drafts through the two RPCs only", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { organizationId: "o", drafts: [DRAFT, { id: 2 }] }, error: null })
      .mockResolvedValueOnce({ data: { state: "published" }, error: null });
    expect(await listAnnouncementDrafts({ rpc })).toEqual([DRAFT]);
    await resolveAnnouncementDraft({ rpc }, "d1", "published");
    expect(rpc).toHaveBeenLastCalledWith("resolve_announcement_draft", { p_draft_id: "d1", p_state: "published" });
    await expect(resolveAnnouncementDraft({ rpc }, "d1", "sent")).rejects.toThrow();
  });
});

describe("coordinator escalation badges", () => {
  it("normalizes the staff-only flag read and hides it when switched off or refused", async () => {
    const ok = { data: { caseId: "c1", enabled: true, dueHours: 48, flags: [{ deadlineId: "x", reason: "overdue" }, { deadlineId: "y", reason: "nope" }] }, error: null };
    expect(await loadCaseworkEscalationFlags({ rpc: vi.fn().mockResolvedValue(ok) }, "c1")).toEqual({ dueHours: 48, flags: [{ deadlineId: "x", reason: "overdue" }] });
    expect(await loadCaseworkEscalationFlags({ rpc: vi.fn().mockResolvedValue({ data: { ...ok.data, enabled: false }, error: null }) }, "c1")).toBeNull();
    expect(await loadCaseworkEscalationFlags({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) }, "c1")).toBeNull();
    expect(await loadCaseworkEscalationFlags({ rpc: vi.fn().mockRejectedValue(new Error("network")) }, "c1")).toBeNull();
  });

  it("shows the reason badge on a flagged deadline in both languages", async () => {
    const deadlines = [
      { id: "x", kind: "filing", label: "File step one", due_at: "2026-10-01T10:00:00Z", status: "active", extensions: [], escalation: { reason: "overdue", dueHours: 48 } },
      { id: "y", kind: "hearing", label: "Hearing", due_at: "2026-10-03T10:00:00Z", status: "active", extensions: [], escalation: { reason: "critical_deadline", dueHours: 48 } },
      { id: "z", kind: "follow_up", label: "Call back", due_at: "2026-10-09T10:00:00Z", status: "active", extensions: [], escalation: null },
    ];
    const data = { scope: { id: "case-1", organization_id: "org-1", chapter_id: "ch-1", step: "Intake", status: "active", is_restricted: false }, strength: [], deadlines, checklists: [], transitions: [], alerts: [], management: [], retaliation: [], links: [], reminders: [] };
    const api = { loadCaseworkCase: vi.fn().mockResolvedValue(data) };
    const english = render(<LanguageProvider lang="en"><CaseworkOperationsPanel caseId="case-1" api={api} onNotice={vi.fn()} onChanged={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByText("Escalated: overdue")).toBeVisible();
    expect(screen.getByText("Escalated: due within 48 hours")).toBeVisible();
    expect(screen.getAllByText(/^Escalated:/)).toHaveLength(2);
    english.unmount();
    render(<LanguageProvider lang="es"><CaseworkOperationsPanel caseId="case-1" api={api} onNotice={vi.fn()} onChanged={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByText("Escalado: vencido")).toBeVisible();
    expect(screen.getByText("Escalado: vence en menos de 48 horas")).toBeVisible();
  });
});

// Dismiss keeps focus while the draft is dismissed, and a second
// activation in the same tick dismisses nothing more.
describe("announcement drafts while one is dismissed", () => {
  const dismissButton = async (resolveDraft) => {
    render(<LanguageProvider lang="en"><AnnouncementDrafts api={{ listDrafts: vi.fn().mockResolvedValue([DRAFT]), resolveDraft }} onUse={vi.fn()} /></LanguageProvider>);
    return screen.findByRole("button", { name: "Dismiss draft: Upcoming: Contract town hall" });
  };

  it("keeps Dismiss focused while the draft is dismissed, and dismisses once", async () => {
    const resolveDraft = vi.fn(async () => ({}));
    await expectHeldWriteFocus(resolveDraft, await dismissButton(resolveDraft));
    expect(resolveDraft).toHaveBeenCalledExactlyOnceWith("d1", "dismissed");
  });

  it("dismisses once when Dismiss is activated twice in one tick", async () => {
    const resolveDraft = vi.fn(async () => ({}));
    const dismiss = await dismissButton(resolveDraft);
    await expectOneWriteFromOneTick(resolveDraft, [() => fireEvent.click(dismiss), () => fireEvent.click(dismiss)]);
  });
});

// #8973 review P1-1: the parent's publishing lock still holds both draft
// controls; a draft cannot be used or dismissed while a broadcast publishes.
describe("announcement drafts while their parent publishes", () => {
  it("refuses Dismiss and Use while the parent is publishing", async () => {
    const api = { listDrafts: vi.fn().mockResolvedValue([DRAFT]), resolveDraft: vi.fn().mockResolvedValue({}) };
    const onUse = vi.fn();
    render(<LanguageProvider lang="en"><AnnouncementDrafts api={api} busy onUse={onUse} /></LanguageProvider>);
    const dismiss = await screen.findByRole("button", { name: "Dismiss draft: Upcoming: Contract town hall" });
    const use = screen.getByRole("button", { name: "Use draft: Upcoming: Contract town hall" });
    expect(dismiss).toHaveAttribute("aria-disabled", "true");
    expect(use).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(dismiss);
    fireEvent.click(use);
    expect(api.resolveDraft).not.toHaveBeenCalled();
    expect(onUse).not.toHaveBeenCalled();
  });
});


// #8973 delta 2 (record 8435): each draft's dismissal clears only its own
// pending mark, so a draft whose lock still holds never reads as ready.
describe("announcement drafts dismissed together", () => {
  it("keeps the second draft's Dismiss pending when the first draft's dismissal settles", async () => {
    const OTHER = { ...DRAFT, id: "d2", title: "Upcoming: Steward training", eventId: "e2" };
    const releases = {};
    const api = {
      listDrafts: vi.fn().mockResolvedValue([DRAFT, OTHER]),
      resolveDraft: vi.fn((id) => new Promise((resolve) => { releases[id] = resolve; })),
    };
    render(<LanguageProvider lang="en"><AnnouncementDrafts api={api} onUse={vi.fn()} /></LanguageProvider>);
    const second = () => screen.getByRole("button", { name: "Dismiss draft: Upcoming: Steward training" });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss draft: Upcoming: Contract town hall" }));
    fireEvent.click(second());
    expect(api.resolveDraft).toHaveBeenCalledTimes(2);
    await act(async () => { releases.d1({}); });
    await waitFor(() => expect(api.listDrafts).toHaveBeenCalledTimes(2));
    expect(second()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(second());
    expect(api.resolveDraft).toHaveBeenCalledTimes(2);
    await act(async () => { releases.d2({}); });
    await waitFor(() => expect(second()).not.toHaveAttribute("aria-disabled", "true"));
  });
});
