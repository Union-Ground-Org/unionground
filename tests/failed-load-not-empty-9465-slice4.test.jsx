// #9465 slice 4: a failed website read says so, with Try again, never "none" or 0.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { PersonalReminders } from "../src/features/personalReminders/PersonalReminders.jsx";
import { AnnouncementReaderSession } from "../src/features/platformAnnouncements/PlatformAnnouncements.jsx";
import { announcementCopy } from "../src/features/platformAnnouncements/copy.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const wrap = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
const rpcClient = (handlers) => ({ rpc: vi.fn(async (name, args) => {
  try { return { data: await handlers[name](args), error: null }; } catch { return { data: null, error: { code: "P0001", message: "offline" } }; }
}) });

describe("personal reminders", () => {
  const failed = t("en", "personalReminders.loadFailed");
  const none = t("en", "personalReminders.empty");
  const reminder = { id: "r1", title: "Friday tally", remindAt: "2099-11-06T14:00:00Z", repeat: "none" };
  const offline = () => { throw new Error("offline"); };

  it("a failed first read says so with Try again, not \"No reminders yet\"", async () => {
    const list = vi.fn().mockImplementationOnce(offline).mockImplementation(() => ({ items: [], nextCursor: null }));
    wrap(<PersonalReminders client={rpcClient({ list_personal_reminders: list })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(failed);
    expect(screen.queryByText(none)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(none)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps the list on screen when a reread after a cancel fails", async () => {
    const list = vi.fn().mockImplementationOnce(() => ({ items: [reminder], nextCursor: null })).mockImplementation(offline);
    wrap(<PersonalReminders client={rpcClient({ list_personal_reminders: list, cancel_personal_reminder: () => ({ id: "r1" }) })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the reminder Friday tally" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failed);
    expect(screen.getByText("Friday tally")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("two quick Try again presses start one read, pending until it answers", async () => {
    let answer;
    const list = vi.fn().mockImplementationOnce(offline).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    wrap(<PersonalReminders client={rpcClient({ list_personal_reminders: list })} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(list).toHaveBeenCalledTimes(2);
    expect(retry).toHaveAttribute("aria-busy", "true");
    await act(async () => { answer({ items: [], nextCursor: null }); });
    expect(await screen.findByText(none)).toBeInTheDocument();
  });

  it("a late failure of an older read does not bring the notice back after a newer read worked", async () => {
    let fail;
    const list = vi.fn().mockImplementationOnce(offline)
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockImplementation(() => ({ items: [], nextCursor: null }));
    wrap(<PersonalReminders client={rpcClient({ list_personal_reminders: list, save_personal_reminder: () => ({ id: "r2" }) })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    fireEvent.change(screen.getByLabelText(t("en", "personalReminders.what")), { target: { value: "Shift" } });
    fireEvent.submit(screen.getByLabelText(t("en", "personalReminders.what")).closest("form"));
    expect(await screen.findByText(none)).toBeInTheDocument();
    await act(async () => { fail(new Error("late")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(none)).toBeInTheDocument();
  });

  it("a failed reread after a save is not \"No reminders yet\" (Spanish)", async () => {
    const es = (key) => t("es", `personalReminders.${key}`);
    const list = vi.fn().mockImplementationOnce(() => ({ items: [], nextCursor: null })).mockImplementation(offline);
    wrap(<PersonalReminders client={rpcClient({ list_personal_reminders: list, save_personal_reminder: () => ({ id: "r2" }) })} />, "es");
    expect(await screen.findByText(es("empty"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(es("what")), { target: { value: "Turno" } });
    fireEvent.submit(screen.getByLabelText(es("what")).closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent(es("loadFailed"));
    expect(screen.queryByText(es("empty"))).toBeNull();
    expect(screen.getByRole("button", { name: es("retry") })).toBeInTheDocument();
  });
});

describe("Union Ground updates, hide for this organization", () => {
  it("reads as loading while the hide runs, not \"No product updates\"", async () => {
    const c = announcementCopy("en");
    let release;
    const item = { id: "p1", title: "Faster", body: "B.", publishedAt: "2026-11-01", expiresAt: "2099-01-01" };
    const api = {
      feed: vi.fn().mockResolvedValue({ items: [item], generation: 1, hidden: false }),
      settings: vi.fn().mockResolvedValue({ enabled: true, generation: 0 }),
      preference: vi.fn(),
      hideLocal: vi.fn(() => new Promise((resolve) => { release = resolve; })),
    };
    render(<AnnouncementReaderSession api={api} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: c.hideLocal }));
    expect(screen.getByRole("status")).toHaveTextContent(c.loading);
    expect(screen.queryByText(c.empty)).toBeNull();
    await act(async () => { release(); });
    expect(api.feed).toHaveBeenCalledTimes(2);
  });
});

// Contract clauses and their linked grievance counts are left out of Union Ground.
