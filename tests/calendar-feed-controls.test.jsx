import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { getCalendarFeedStatus } from "../src/lib/memberApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { EventsView } from "../src/views/EventsView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";

const data = {
  member: { id: "member-a" },
  events: [{ id: "event-a", title: "Chapter meeting", startsAt: "2026-12-01T15:00:00Z" }],
};

const cases = [
  ["en", "Get calendar link", "Get live calendar link", "Get a new calendar link", "Turn off calendar link", "Calendar link status couldn’t be checked.", "Try again", "Your current link will stop working. Update any calendar apps that use it with the new link."],
  ["es", "Obtener enlace de calendario", "Obtener enlace de calendario en vivo", "Obtener un enlace de calendario nuevo", "Desactivar enlace de calendario", "No se pudo comprobar el estado del enlace de calendario.", "Volver a intentar", "El enlace actual dejará de funcionar. Actualiza con el nuevo enlace las aplicaciones de calendario que lo usen."],
];

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe.each([SettingsView, EventsView])("%s calendar feed", (View) => {
  it.each(cases)("shows whether a feed exists on a fresh visit in %s", async (lang, settingsMint, eventsMint, replaceLabel, revokeLabel, statusError, retryLabel, replaceWarning) => {
    const mintLabel = View === SettingsView ? settingsMint : eventsMint;
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "offline" } })
      .mockResolvedValue({ data: true, error: null });
    const read = () => getCalendarFeedStatus({ rpc });
    const rotate = vi.fn().mockResolvedValue({ token: "fresh-token" });
    const revoke = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ revoked: true });
    const page = () => (
      <LanguageProvider lang={lang}>
        <View data={data} lang={lang} onCalendarRotate={rotate} onCalendarRevoke={revoke} loadCalendarFeedStatus={read} />
      </LanguageProvider>
    );

    const firstVisit = render(page());
    const mint = await screen.findByRole("button", { name: mintLabel });
    expect(screen.queryByRole("button", { name: revokeLabel })).not.toBeInTheDocument();
    expect(screen.queryByText(replaceWarning)).not.toBeInTheDocument();
    fireEvent.click(mint);
    const url = `${window.location.origin}/api/calendar?token=fresh-token`;
    expect(await screen.findByDisplayValue(url)).toBeInTheDocument();
    firstVisit.unmount();

    const freshVisit = render(page());
    expect(await screen.findByRole("button", { name: revokeLabel })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(url)).not.toBeInTheDocument();
    const replace = screen.getByRole("button", { name: replaceLabel });
    const warning = screen.getByText(replaceWarning);
    expect(warning).toBeVisible();
    expect(replace.getAttribute("aria-describedby").split(" ")).toContain(warning.id);
    fireEvent.click(replace);
    expect(await screen.findByDisplayValue(url)).toBeInTheDocument();
    if (View === EventsView) expect(screen.queryByText(replaceWarning)).not.toBeInTheDocument();
    freshVisit.unmount();

    render(page());
    expect(screen.queryByRole("button", { name: revokeLabel })).not.toBeInTheDocument();
    expect(await screen.findByText(statusError)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: mintLabel })).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: retryLabel });
    retry.focus();
    fireEvent.click(retry);
    const off = await screen.findByRole("button", { name: revokeLabel });
    // The focus effect runs after the replacement control mounts.
    await waitFor(() => expect(off).toHaveFocus());
    expect(screen.queryByDisplayValue(url)).not.toBeInTheDocument();
    expect(rpc.mock.calls).toEqual(Array.from({ length: 4 }, () => ["get_calendar_feed_status"]));
    expect(rotate).toHaveBeenCalledTimes(2);

    await act(async () => { fireEvent.click(off); });
    expect(off).toBeInTheDocument();
    expect(off).not.toHaveAttribute("aria-disabled");
    fireEvent.click(off);
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: mintLabel })).toHaveFocus());
    expect(screen.queryByRole("button", { name: revokeLabel })).not.toBeInTheDocument();
    expect(screen.queryByText(replaceWarning)).not.toBeInTheDocument();
  });

  it("discards a late active read after switching members", async () => {
    let finishRead;
    const oldRead = () => new Promise((resolve) => { finishRead = resolve; });
    const readInactive = vi.fn().mockResolvedValue(false);
    const rotate = vi.fn();
    const revoke = vi.fn();
    const page = (scope, read) => (
      <View data={data} lang="en" calendarFeedScope={scope} loadCalendarFeedStatus={read} onCalendarRotate={rotate} onCalendarRevoke={revoke} />
    );

    const first = render(page("member-a", oldRead));
    expect(screen.getByText("Checking calendar link status…")).toBeInTheDocument();
    first.rerender(page("member-b", readInactive));
    await screen.findByRole("button", { name: /get (live )?calendar link/i });
    await act(async () => { finishRead(true); });
    expect(screen.queryByRole("button", { name: "Turn off calendar link" })).not.toBeInTheDocument();
  });
});

// Restricted (PIN) sessions and their step-up prompt are left out of Union
// Ground with the member PIN, so no calendar control offers that recovery.
