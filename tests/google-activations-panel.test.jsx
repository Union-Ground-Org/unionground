// REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001: the administrator's honest setup
// surface. Each state names what is missing; no control is offered that cannot
// complete. Union Ground has no membership card, so the panel offers no
// Google Wallet pass even when a status payload still carries a wallet flag.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleActivationsPanel } from "../src/features/integrations/GoogleActivationsPanel.jsx";
import { loadGoogleActivations, saveOrganizationCalendarId } from "../src/features/integrations/googleActivations.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { PORTAL_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

function client(rpcResult = { data: {}, error: null }) {
  return {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "admin-token" } }, error: null }) },
    rpc: vi.fn().mockResolvedValue(rpcResult),
  };
}
function status(calendar, wallet = { configured: false }) {
  return { ok: true, status: 200, json: async () => ({ wallet, calendar }) };
}
const unsetCalendar = { configured: false, enabled: true, scope: "public_events", connection: null, copiedEvents: 0, failingEvents: 0 };
const connectedCalendar = {
  configured: true, enabled: true, scope: "all_events", copiedEvents: 4, failingEvents: 1,
  connection: { status: "connected", accountEmail: "office@example.org", calendarId: "primary", lastRunAt: "2026-10-02T20:00:00Z", lastErrorCode: null },
};

let assign;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, search: "", assign });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("GoogleActivationsPanel", () => {
  // An activation that is not set up shows its title and summary only; the
  // operator's notes and the repository path of the setup guide never reach
  // the organization administrator. Google Wallet passes (the membership
  // card) are left out of Union Ground.
  it("shows the calendar activation that is not set up as off, with no operator notes, file path or connect control", async () => {
    fetch.mockResolvedValueOnce(status(unsetCalendar));
    const { container } = render(<GoogleActivationsPanel client={client()} />);
    expect(await screen.findByText("Organization calendar")).toBeVisible();
    expect(screen.queryByText(/Google Wallet/)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/operator|docs\/|\.md\b/);
    expect(screen.queryByRole("button", { name: "Connect Google Calendar" })).not.toBeInTheDocument();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("/api/google-activations?action=status");
    expect(options.headers.Authorization).toBe("Bearer admin-token");
  });

  it("starts the Google consent when configured but not connected", async () => {
    fetch.mockResolvedValueOnce(status({ ...unsetCalendar, configured: true }, { configured: true }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }) })
      .mockResolvedValueOnce(status({ ...unsetCalendar, configured: true }, { configured: true }));
    render(<GoogleActivationsPanel client={client()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    // A configured wallet flag from an older server never surfaces a wallet row.
    expect(screen.queryByText(/Google Wallet|membership card/i)).not.toBeInTheDocument();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
    expect(fetch.mock.calls[1][0]).toBe("/api/google-activations?action=calendar-start");
  });

  it("opens the calendar connect on the site address when started from another host (#9557)", async () => {
    fetch.mockResolvedValueOnce(status({ ...unsetCalendar, configured: true }, { configured: true }))
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "use-site-address", siteAddress: PORTAL_ORIGIN }) })
      .mockResolvedValueOnce(status({ ...unsetCalendar, configured: true }, { configured: true }));
    render(<GoogleActivationsPanel client={client()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`${PORTAL_ORIGIN}/m/integrations`));
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a refused start, a site address that is not a bare https origin, or a consent address off Google", async () => {
    const configured = () => status({ ...unsetCalendar, configured: true }, { configured: true });
    fetch.mockResolvedValueOnce(configured())
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "not-authorized" }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "use-site-address", siteAddress: "https://evil.example/path" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ authorizationUrl: "https://evil.example/consent" }) })
      .mockResolvedValue(configured());
    render(<GoogleActivationsPanel client={client()} />);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fireEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
      await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith("calendar-start"))).toHaveLength(attempt));
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows the live connection, saves a calendar id and disconnects after confirmation", async () => {
    const rpcClient = client();
    fetch.mockResolvedValue(status(connectedCalendar));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<GoogleActivationsPanel client={rpcClient} />);
    expect(await screen.findByText("Connected as office@example.org.")).toBeVisible();
    expect(screen.getByText(/Copies: all campaign meetings · 4 meetings copied · 1 waiting to retry · last run/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Calendar ID" }), { target: { value: "team@group.calendar.google.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save calendar" }));
    await waitFor(() => expect(rpcClient.rpc).toHaveBeenCalledWith("set_organization_calendar_push_calendar", { p_calendar_id: "team@group.calendar.google.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(rpcClient.rpc).toHaveBeenCalledWith("disconnect_organization_calendar_push", {}));
  });

  it("asks for a reconnect after Google access was revoked and reports a switched-off push", async () => {
    fetch.mockResolvedValueOnce(status({ ...connectedCalendar, enabled: false, connection: { ...connectedCalendar.connection, status: "error", lastErrorCode: "grant_revoked", accountEmail: null } }));
    render(<GoogleActivationsPanel client={client()} />);
    expect(await screen.findByText(/Connect again to resume copies/)).toBeVisible();
    expect(screen.getByText("Copies are turned off in Feature switches & limits.")).toBeVisible();
    expect(screen.getByText(/the organization's Google account, but the last copy run had a problem/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect Google Calendar" })).toBeVisible();
  });

  it("renders nothing for a non-administrator and offers a retry on a load failure", async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "not-authorized" }) });
    const { container, unmount } = render(<GoogleActivationsPanel client={client()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    unmount();
    fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) }).mockResolvedValueOnce(status(unsetCalendar));
    render(<GoogleActivationsPanel client={client()} />);
    expect(await screen.findByText("Google activation status could not be loaded.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(await screen.findByText("Organization calendar")).toBeVisible();
    expect(screen.queryByText("Google activation status could not be loaded.")).toBeNull();
  });

  it("shows the OAuth callback outcome and reports a failed action", async () => {
    vi.stubGlobal("location", { ...window.location, search: "?calendar_push=failed", assign });
    fetch.mockResolvedValueOnce(status(connectedCalendar));
    const rpcClient = client({ data: null, error: { message: "denied", status: 403 } });
    render(<GoogleActivationsPanel client={rpcClient} />);
    expect(await screen.findByText(/Google Calendar was not connected/)).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Save calendar" }));
    expect(await screen.findByText("That change did not go through. Try again.")).toBeVisible();
  });
});

// The calendar controls share one busy state and one lock.
describe("GoogleActivationsPanel while a calendar change runs", () => {
  it("keeps Save calendar focused and pending while the save runs, with Disconnect pending too", async () => {
    const rpcClient = client();
    fetch.mockResolvedValue(status(connectedCalendar));
    render(<GoogleActivationsPanel client={rpcClient} />);
    const save = await screen.findByRole("button", { name: "Save calendar" });
    await expectHeldWriteFocus(rpcClient.rpc, save, () => {
      fireEvent.click(save);
      const disconnect = screen.getByRole("button", { name: "Disconnect" });
      expect(disconnect).toBeEnabled();
      expect(disconnect).toHaveAttribute("aria-disabled", "true");
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).not.toHaveAttribute("aria-disabled"));
  });

  it("sends one calendar change when Save calendar and Disconnect are pressed in the same tick", async () => {
    const rpcClient = client();
    fetch.mockResolvedValue(status(connectedCalendar));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<GoogleActivationsPanel client={rpcClient} />);
    const save = await screen.findByRole("button", { name: "Save calendar" });
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    await expectOneWriteFromOneTick(rpcClient.rpc, [() => fireEvent.click(save), () => fireEvent.click(disconnect)]);
    // The lock ends with the change: Disconnect sends from the next press.
    await waitFor(() => expect(disconnect).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(disconnect);
    await waitFor(() => expect(rpcClient.rpc).toHaveBeenCalledWith("disconnect_organization_calendar_push", {}));
  });
});

describe("client helpers", () => {
  it("normalizes the status payload and refuses an invalid calendar id locally", async () => {
    fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ calendar: { scope: "weird", connection: "x" } }) });
    expect(await loadGoogleActivations(client())).toEqual({
      calendar: { configured: false, enabled: false, scope: "public_events", connection: null, copiedEvents: 0, failingEvents: 0 },
    });
    await expect(saveOrganizationCalendarId(client(), "bad id!")).rejects.toThrow(/Invalid calendar id/);
    const noSession = { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) } };
    await expect(loadGoogleActivations(noSession)).rejects.toMatchObject({ status: 401 });
  });
});
