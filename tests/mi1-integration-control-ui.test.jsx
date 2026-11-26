import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createActor } from "../src/features/integrations/authorization.js";
import { IntegrationControlPlane } from "../src/features/integrations/IntegrationControlPlane.jsx";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../src/lib/i18n/zonedDates.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const JORDAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function admin() {
  return createActor({
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    selectedOrganizationId: ORG_A,
    roles: ["admin"],
    membershipStatus: "active",
    mfaSatisfied: true,
  });
}

function twilioConnectedStore({ sendSms, searchSmsRecipients } = {}) {
  const baseStore = createIntegrationControlStore();
  const data = baseStore.getSnapshot(admin()).data;
  return {
    ...baseStore,
    getSnapshot: () => ({
      ok: true,
      data: {
        ...data,
        providers: data.providers.map((row) => row.provider === "twilio"
          ? { ...row, status: "connected", effective: { ...row.effective, enabled: true } }
          : row),
      },
    }),
    sendSms: sendSms || vi.fn(async () => ({ ok: true, deliveryId: "delivery-1", status: "queued" })),
    searchSmsRecipients: searchSmsRecipients || vi.fn(async () => ({
      ok: true,
      data: [{ userId: JORDAN_ID, fullName: "Jordan Lee", phoneLast4: "0123" }],
    })),
  };
}

async function draftSmsToJordan() {
  fireEvent.change(screen.getByLabelText("Find a worker"), { target: { value: "Jordan" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("option", { name: /Jordan Lee/ });
  fireEvent.change(screen.getByLabelText("Choose a consented worker"), { target: { value: JORDAN_ID } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Meeting moved to 6 PM." } });
}

describe("integration control plane UI", () => {
  it("shows unset providers, webhook and API-key setup, and an honest SCIM setup that is switched off", async () => {
    const store = createIntegrationControlStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);

    expect(await screen.findByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getAllByText(/Not set up ·/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open SCIM setup" })).toHaveAttribute("href", expect.stringContaining("/m/integrations/scim"));
    expect(await screen.findByText(/SCIM directory provisioning is off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue SCIM token" })).toBeDisabled();
    expect(screen.getByText(/nobody gets an account until they accept it/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Operations export" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue key" }));

    expect(await screen.findByDisplayValue(/ug_live_/)).toBeInTheDocument();
    expect(screen.getByText("Copy this secret now")).toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("API key"));
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByText("Copy this secret now")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Rotate / }));
    expect(await screen.findByText("Copy this secret now")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    fireEvent.click(screen.getByRole("button", { name: /^Revoke / }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Rotate / })).not.toBeInTheDocument());
  });

  it("runs provider, job, and webhook controls through the bounded harness", async () => {
    const store = createIntegrationControlStore();
    render(<IntegrationControlPlane store={store} actor={admin()} notice="No live credentials are configured." />);
    expect(await screen.findByText("No live credentials are configured.")).toBeInTheDocument();

    const twilioRow = screen.getByText("SMS (Twilio)").closest("li");
    fireEvent.click(within(twilioRow).getByRole("button", { name: "Request setup SMS (Twilio)" }));
    await waitFor(() => expect(within(twilioRow).getByText(/Setup requested ·/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByText(/Readiness check · Waiting to run/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run next job" }));
    expect(await screen.findByText(/Readiness check · Done/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("https://hooks.example.com/union-ground"), {
      target: { value: "https://hooks.example.com/control-plane" },
    });
    const eventCheckbox = screen.getByRole("checkbox", { name: "case.opened" });
    fireEvent.click(eventCheckbox);
    fireEvent.click(eventCheckbox);
    fireEvent.click(eventCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Add test endpoint" }));
    expect(await screen.findByLabelText("Webhook signing secret")).toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("Webhook signing secret"));
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));

    fireEvent.click(screen.getByRole("button", { name: /^Rotate signing secret / }));
    expect(await screen.findByLabelText("Webhook signing secret")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));

    fireEvent.click(screen.getByRole("button", { name: /^Send test event / }));
    expect(await screen.findByText(/case\.opened · ok · hooks\.example\.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Pause / }));
    expect(await screen.findByRole("button", { name: /^Resume / })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Resume / }));
    expect(await screen.findByRole("button", { name: /^Pause / })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Remove / }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument());
  });

  it("submits a connected Twilio message through the shipped operator action", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    expect(screen.getByLabelText("Find a worker")).toHaveClass("xus-input");
    expect(screen.getByLabelText("Purpose")).toHaveClass("xus-input");
    expect(screen.getByLabelText("Message")).toHaveClass("xus-input--area");
    await draftSmsToJordan();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.sendSms).toHaveBeenCalledWith(admin(), expect.objectContaining({
      memberId: JORDAN_ID,
      purpose: "urgent_alert",
      body: "Meeting moved to 6 PM.",
    })));
    expect(await screen.findByText("Message accepted for delivery.")).toBeInTheDocument();
    const firstKey = store.sendSms.mock.calls[0][1].idempotencyKey;
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Meeting moved to 7 PM." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.sendSms).toHaveBeenCalledTimes(2));
    expect(store.sendSms.mock.calls[1][1].idempotencyKey).not.toBe(firstKey);
  });

  it("keeps Send message focused while the message is queued, and sends it once", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    await draftSmsToJordan();
    await expectHeldWriteFocus(store.sendSms, screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Message accepted for delivery.")).toBeInTheDocument();
    expect(store.sendSms).toHaveBeenCalledTimes(1);
  });

  it("refuses a second SMS send submitted before the first one commits", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    await draftSmsToJordan();
    const form = screen.getByRole("button", { name: "Send message" }).closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(await screen.findByText("Message accepted for delivery.")).toBeInTheDocument();
    expect(store.sendSms).toHaveBeenCalledTimes(1);
  });

  it("keeps the worker Search focused while recipients load", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    fireEvent.change(screen.getByLabelText("Find a worker"), { target: { value: "Jordan" } });
    await expectHeldWriteFocus(store.searchSmsRecipients, screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("option", { name: /Jordan Lee/ })).toBeInTheDocument();
    expect(store.searchSmsRecipients).toHaveBeenCalledTimes(1);
  });

  it("keeps Run next job focused while the job runs", async () => {
    const store = createIntegrationControlStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    const twilioRow = (await screen.findByText("SMS (Twilio)")).closest("li");
    fireEvent.click(within(twilioRow).getByRole("button", { name: "Request setup SMS (Twilio)" }));
    await waitFor(() => expect(within(twilioRow).getByText(/Setup requested ·/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByText(/Readiness check · Waiting to run/)).toBeInTheDocument();
    const original = store.runNextJob.bind(store);
    const runNextJob = vi.spyOn(store, "runNextJob").mockImplementation(original);
    await expectHeldWriteFocus(runNextJob, screen.getByRole("button", { name: "Run next job" }));
    expect(await screen.findByText(/Readiness check · Done/)).toBeInTheDocument();
    expect(runNextJob).toHaveBeenCalledTimes(1);
  });

  it("submitting Find a worker searches again and does not send the drafted SMS", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    await draftSmsToJordan();
    expect(store.searchSmsRecipients).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Find a worker"), { target: { value: "Lee" } });
    fireEvent.submit(screen.getByLabelText("Find a worker").closest("form"));

    await waitFor(() => expect(store.searchSmsRecipients).toHaveBeenCalledTimes(2));
    expect(store.searchSmsRecipients).toHaveBeenLastCalledWith(admin(), "Lee");
    expect(store.sendSms).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message")).toHaveValue("Meeting moved to 6 PM.");
    expect(screen.getByLabelText("Choose a consented worker")).toHaveValue(JORDAN_ID);
    expect(screen.queryByText("Message accepted for delivery.")).not.toBeInTheDocument();
  });

  it("dispatches sendSms only from an explicit Send message activation", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    await draftSmsToJordan();
    expect(store.sendSms).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.sendSms).toHaveBeenCalledTimes(1));
    expect(store.sendSms).toHaveBeenCalledWith(admin(), expect.objectContaining({
      memberId: JORDAN_ID,
      body: "Meeting moved to 6 PM.",
    }));
  });

  it("reaches the Search control from the keyboard and runs search without sending", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    await draftSmsToJordan();

    const searchField = screen.getByLabelText("Find a worker");
    const searchButton = screen.getByRole("button", { name: "Search" });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(searchButton).toHaveAttribute("type", "submit");
    expect(searchField.closest("form")).not.toBe(sendButton.closest("form"));
    expect(searchButton.closest("form")).toBe(searchField.closest("form"));

    fireEvent.change(searchField, { target: { value: "Lee" } });
    searchButton.focus();
    expect(searchButton).toHaveFocus();
    fireEvent.submit(searchButton.closest("form"));

    await waitFor(() => expect(store.searchSmsRecipients).toHaveBeenCalledTimes(2));
    expect(store.searchSmsRecipients).toHaveBeenLastCalledWith(admin(), "Lee");
    expect(store.sendSms).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message")).toHaveValue("Meeting moved to 6 PM.");
    expect(screen.getByLabelText("Choose a consented worker")).toHaveValue(JORDAN_ID);
  });

  it("keeps the chosen worker in the option set when a later search omits them", async () => {
    const caseyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const searchSmsRecipients = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: [{ userId: JORDAN_ID, fullName: "Jordan Lee", phoneLast4: "0123" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [{ userId: caseyId, fullName: "Casey Ng", phoneLast4: "4567" }],
      });
    const store = twilioConnectedStore({ searchSmsRecipients });
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    await draftSmsToJordan();

    fireEvent.change(screen.getByLabelText("Find a worker"), { target: { value: "Casey" } });
    fireEvent.submit(screen.getByLabelText("Find a worker").closest("form"));

    await waitFor(() => expect(store.searchSmsRecipients).toHaveBeenCalledTimes(2));
    // Wait for the second search's results before reading the kept selection.
    await screen.findByRole("option", { name: /Casey Ng/ });
    const recipient = screen.getByLabelText("Choose a consented worker");
    expect(recipient).toHaveValue(JORDAN_ID);
    expect(screen.getByRole("option", { name: /Jordan Lee/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Casey Ng/ })).toBeInTheDocument();
    expect(store.sendSms).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.sendSms).toHaveBeenCalledWith(admin(), expect.objectContaining({
      memberId: JORDAN_ID,
      body: "Meeting moved to 6 PM.",
    })));
  });

  it("keeps the recipient chosen while a later search is still in flight", async () => {
    const caseyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const taylorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let resolveLater;
    const laterSearch = new Promise((resolve) => {
      resolveLater = resolve;
    });
    const searchSmsRecipients = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: [
          { userId: JORDAN_ID, fullName: "Jordan Lee", phoneLast4: "0123" },
          { userId: caseyId, fullName: "Casey Ng", phoneLast4: "4567" },
        ],
      })
      .mockImplementationOnce(() => laterSearch);
    const store = twilioConnectedStore({ searchSmsRecipients });
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });

    fireEvent.change(screen.getByLabelText("Find a worker"), { target: { value: "Jordan" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("option", { name: /Casey Ng/ });
    fireEvent.change(screen.getByLabelText("Choose a consented worker"), { target: { value: JORDAN_ID } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Meeting moved to 6 PM." } });

    fireEvent.change(screen.getByLabelText("Find a worker"), { target: { value: "Taylor" } });
    fireEvent.submit(screen.getByLabelText("Find a worker").closest("form"));
    await waitFor(() => expect(store.searchSmsRecipients).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText("Choose a consented worker"), { target: { value: caseyId } });
    expect(screen.getByLabelText("Choose a consented worker")).toHaveValue(caseyId);

    resolveLater({
      ok: true,
      data: [{ userId: taylorId, fullName: "Taylor Ruiz", phoneLast4: "8901" }],
    });

    await waitFor(() => expect(screen.getByRole("option", { name: /Taylor Ruiz/ })).toBeInTheDocument());
    const recipient = screen.getByLabelText("Choose a consented worker");
    expect(recipient).toHaveValue(caseyId);
    expect(screen.getByRole("option", { name: /Casey Ng/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Jordan Lee/ })).not.toBeInTheDocument();
    expect(store.sendSms).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(store.sendSms).toHaveBeenCalledWith(admin(), expect.objectContaining({
      memberId: caseyId,
      body: "Meeting moved to 6 PM.",
    })));
  });

  it("stacks the split SMS search and send forms with the same xus-form gap", async () => {
    const store = twilioConnectedStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Send an SMS" });
    const searchForm = screen.getByLabelText("Find a worker").closest("form");
    const sendForm = screen.getByRole("button", { name: "Send message" }).closest("form");
    expect(searchForm.nextElementSibling).toBe(sendForm);
    expect(searchForm.parentElement).toHaveClass("xus-form");
    expect(searchForm.parentElement).toBe(sendForm.parentElement);
    expect(searchForm.parentElement.tagName).toBe("DIV");
  });

  it("does not offer SMS dispatch before Twilio is connected", async () => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const store = {
      ...baseStore,
      getSnapshot: () => ({
        ok: true,
        data: { ...data, providers: data.providers.map((row) => row.provider === "twilio"
          ? { ...row, status: "configured", effective: { ...row.effective, enabled: true } }
          : row) },
      }),
    };
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Connections" });
    expect(screen.queryByRole("heading", { name: "Send an SMS" })).not.toBeInTheDocument();
  });

  it("shows bounded Constant Contact analytics and invokes only explicit sync and disconnect controls", async () => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const syncConstantContact = vi.fn().mockResolvedValue({ ok: true });
    const disconnectConstantContact = vi.fn().mockResolvedValue({ ok: true });
    const store = {
      ...baseStore,
      getSnapshot: () => ({
        ok: true,
        data: {
          ...data,
          providers: data.providers.map((row) => row.provider === "constant_contact"
            ? { ...row, status: "connected" }
            : row),
          constantContact: {
            available: true,
            connected: true,
            accountLabel: "Connected account",
            lastSyncAt: "2026-08-30T12:00:00Z",
            memberCount: 1,
            activeContactCount: 1,
            sendCount: 8,
            openCount: 5,
            clickCount: 2,
            syncRuns: [{
              id: "run-1",
              status: "success",
              processedCount: 1,
              matchedCount: 1,
              finishedAt: "2026-08-30T12:00:00Z",
            }],
            analytics: [{
              memberId: "member-1",
              memberName: "Alex Rivera",
              sendsCount: 8,
              opensCount: 5,
              clicksCount: 2,
              lastActivityAt: "2026-08-29T12:00:00Z",
            }],
          },
        },
      }),
      syncConstantContact,
      disconnectConstantContact,
    };
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    expect(await screen.findByText("Alex Rivera")).toBeInTheDocument();
    expect(screen.getAllByText(/8 sends · 5 opens · 2 clicks/)).toHaveLength(2);
    expect(screen.getByText(/most recent 300 provider activities/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync up to 25 workers" }));
    await waitFor(() => expect(syncConstantContact).toHaveBeenCalledWith(admin(), { limit: 25 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectConstantContact).toHaveBeenCalledWith(admin()));
  });

  // #6277 (#5813 round 10, finding 3): the control read returns null totals
  // for a platform organization; the card must say they are withheld, not
  // render a measured zero, and an ordinary union's zero stays zero.
  it("shows withheld Constant Contact totals as withheld and keeps a measured zero", async () => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const storeWith = (totals) => ({
      ...baseStore,
      getSnapshot: () => ({ ok: true, data: { ...data,
        providers: data.providers.map((row) => row.provider === "constant_contact" ? { ...row, status: "connected" } : row),
        constantContact: { available: true, connected: true, accountLabel: "Connected account", lastSyncAt: null,
          syncRuns: [], analytics: [], ...totals } } }),
    });
    const withheld = render(<IntegrationControlPlane store={storeWith({ memberCount: null, activeContactCount: null,
      sendCount: null, openCount: null, clickCount: null })} actor={admin()} />);
    expect(await screen.findByText("Totals are withheld for this organization.")).toBeInTheDocument();
    expect(screen.queryByText(/0 sends · 0 opens · 0 clicks/)).toBeNull();
    expect(screen.queryByText(/0 matched workers · 0 active contacts/)).toBeNull();
    withheld.unmount();
    render(<IntegrationControlPlane store={storeWith({ memberCount: 0, activeContactCount: 0, sendCount: 0, openCount: 0, clickCount: 0 })} actor={admin()} />);
    expect(await screen.findByText(/0 sends · 0 opens · 0 clicks/)).toBeInTheDocument();
    expect(screen.getByText(/0 matched workers · 0 active contacts/)).toBeInTheDocument();
    expect(screen.queryByText("Totals are withheld for this organization.")).toBeNull();
  });

  // UX-UG-CONSTANT-CONTACT-RAW-ISO-TIMESTAMPS-AND-STATUS-20260920. The card
  // used to interpolate the store's ISO instants and the provider's own status
  // token straight into the DOM, so a Spanish administrator read machine UTC
  // stamps and English words beside translated labels. Expected values come from
  // the shared formatter rather than literal strings: the runner's time zone is
  // not pinned, and the point of the record is that the card agrees with that one
  // locale source rather than inventing its own.
  it("localizes Constant Contact stamps and sync statuses instead of printing provider ISO and tokens", async () => {
    const LAST_SYNC = "2026-08-30T12:00:00Z";
    const RUN_FINISHED = "2026-08-30T11:59:00Z";
    const LAST_ACTIVITY = "2026-08-29T12:00:00Z";
    const LAST_DELIVERY = "2026-08-28T09:15:00Z";
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const store = {
      ...baseStore,
      getSnapshot: () => ({
        ok: true,
        data: {
          ...data,
          providers: data.providers.map((row) => row.provider === "constant_contact"
            ? { ...row, status: "connected" }
            : row),
          webhooks: [{
            id: "hook-1",
            url: "https://hooks.example.com/control-plane",
            events: ["case.opened"],
            active: true,
            lastDeliveryStatus: "ok",
            lastDeliveryAt: LAST_DELIVERY,
          }],
          constantContact: {
            available: true,
            connected: true,
            accountLabel: "Connected account",
            lastSyncAt: LAST_SYNC,
            memberCount: 1,
            activeContactCount: 1,
            sendCount: 8,
            openCount: 5,
            clickCount: 2,
            syncRuns: [
              { id: "run-1", status: "success", processedCount: 1, matchedCount: 1, finishedAt: RUN_FINISHED },
              { id: "run-2", status: "partial_unknown", processedCount: 2, matchedCount: 0, finishedAt: RUN_FINISHED },
            ],
            analytics: [{
              memberId: "member-1",
              memberName: "Alex Rivera",
              sendsCount: 8,
              opensCount: 5,
              clicksCount: 2,
              lastActivityAt: LAST_ACTIVITY,
            }],
          },
        },
      }),
    };

    const spanish = render(
      <LanguageProvider lang="es"><IntegrationControlPlane store={store} actor={admin()} /></LanguageProvider>,
    );
    expect(await screen.findByText("Alex Rivera")).toBeInTheDocument();

    for (const [value, label] of [
      [LAST_SYNC, "Última sincronización"],
      [RUN_FINISHED, "sync run"],
      [LAST_ACTIVITY, "last activity"],
      [LAST_DELIVERY, "webhook delivery"],
    ]) {
      const formatted = formatDateTimeWithZone(value, "es");
      expect(formatted).not.toBe("");
      expect(document.body.textContent, label).toContain(formatted);
      expect(document.body.textContent, label).not.toContain(value);
    }

    expect(screen.getByText("Correcta")).toBeInTheDocument();
    expect(screen.getByText("Desconocida")).toBeInTheDocument();
    expect(screen.queryByText("success")).not.toBeInTheDocument();
    expect(screen.queryByText("partial_unknown")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    spanish.unmount();

    render(<LanguageProvider lang="en"><IntegrationControlPlane store={store} actor={admin()} /></LanguageProvider>);
    expect(await screen.findByText("Success")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(document.body.textContent).toContain(formatDateTimeWithZone(LAST_SYNC, "en"));
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it("reports a bounded Constant Contact OAuth start failure without navigating", async () => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const beginConstantContactOAuth = vi.fn().mockResolvedValue({
      ok: false,
      reason: "activation_unset",
    });
    const store = {
      ...baseStore,
      getSnapshot: () => ({
        ok: true,
        data: {
          ...data,
          providers: data.providers.map((row) => row.provider === "constant_contact"
            ? { ...row, status: "requested" }
            : row),
          constantContact: {
            available: true,
            connected: false,
            syncRuns: [],
            analytics: [],
          },
        },
      }),
      beginConstantContactOAuth,
    };
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect organization account" }));
    await waitFor(() => expect(beginConstantContactOAuth).toHaveBeenCalledWith(admin()));
    expect(await screen.findByRole("alert")).toHaveTextContent("Request setup above before connecting");
  });

  it("opts into campaign controls before applying a campaign status", async () => {
    const actor = { ...admin(), chapterId: "chapter-a" };
    const store = createIntegrationControlStore({
      chapterBelongsToOrganization: (chapterId, organizationId) => chapterId === "chapter-a" && organizationId === ORG_A,
    });
    render(<IntegrationControlPlane store={store} actor={actor} />);
    const twilioRow = (await screen.findByText("SMS (Twilio)")).closest("li");
    fireEvent.click(within(twilioRow).getByRole("button", { name: "Enable campaign controls" }));
    expect(await within(twilioRow).findByRole("button", { name: "Disable for this campaign" })).toBeEnabled();
    fireEvent.click(within(twilioRow).getByRole("button", { name: "Disable for this campaign" }));
    await waitFor(() => expect(within(twilioRow).getByRole("button", { name: "Disable for this campaign" })).toBeDisabled());
  });

  it("saves a Twilio campaign sending number and keeps it across campaign status changes", async () => {
    const actor = { ...admin(), chapterId: "chapter-a" };
    const baseStore = createIntegrationControlStore({
      chapterBelongsToOrganization: (chapterId, organizationId) => chapterId === "chapter-a" && organizationId === ORG_A,
    });
    const store = { ...baseStore, setChapterOverride: vi.fn(baseStore.setChapterOverride) };
    render(<IntegrationControlPlane store={store} actor={actor} />);
    const twilioRow = (await screen.findByText("SMS (Twilio)")).closest("li");
    fireEvent.click(within(twilioRow).getByRole("button", { name: "Enable campaign controls" }));
    fireEvent.click(await within(twilioRow).findByRole("button", { name: "Enable for this campaign" }));

    const fromNumber = await within(twilioRow).findByLabelText("Campaign sending number");
    fireEvent.change(fromNumber, { target: { value: "555-0100" } });
    fireEvent.click(within(twilioRow).getByRole("button", { name: "Save campaign number" }));
    expect(screen.getByRole("alert")).toHaveTextContent("E.164 format");
    expect(store.setChapterOverride).toHaveBeenCalledTimes(1);

    fireEvent.change(fromNumber, { target: { value: "+15551230100" } });
    fireEvent.click(within(twilioRow).getByRole("button", { name: "Save campaign number" }));
    await waitFor(() => expect(store.setChapterOverride).toHaveBeenLastCalledWith(actor, {
      provider: "twilio",
      chapterId: "chapter-a",
      status: "enabled",
      overrideSettings: { fromNumber: "+15551230100" },
    }));
    await waitFor(() => expect(within(twilioRow).getByLabelText("Campaign sending number")).toHaveValue("+15551230100"));

    fireEvent.click(within(twilioRow).getByRole("button", { name: "Disable for this campaign" }));
    await waitFor(() => expect(store.setChapterOverride).toHaveBeenLastCalledWith(actor, {
      provider: "twilio",
      chapterId: "chapter-a",
      status: "disabled",
      overrideSettings: { fromNumber: "+15551230100" },
    }));
    await waitFor(() => expect(within(twilioRow).queryByLabelText("Campaign sending number")).not.toBeInTheDocument());
    fireEvent.click(await within(twilioRow).findByRole("button", { name: "Enable for this campaign" }));
    expect(await within(twilioRow).findByLabelText("Campaign sending number")).toHaveValue("+15551230100");
  });

  it("offers campaign controls only for providers that carry an override catalog", async () => {
    const actor = { ...admin(), chapterId: "chapter-a" };
    const store = createIntegrationControlStore({
      chapterBelongsToOrganization: (chapterId, organizationId) => chapterId === "chapter-a" && organizationId === ORG_A,
    });
    render(<IntegrationControlPlane store={store} actor={actor} />);

    const providers = (await screen.findByRole("heading", { name: "Connections" })).closest("article");
    const twilioRow = within(providers).getByText("SMS (Twilio)").closest("li");
    expect(within(twilioRow).getByRole("button", { name: "Enable campaign controls" })).toBeEnabled();

    for (const label of ["Google Drive", "Webhooks", "API keys"]) {
      const row = within(providers).getByText(label).closest("li");
      expect(within(row).queryByRole("button", { name: "Enable campaign controls" })).toBeNull();
      expect(within(row).queryByLabelText(`${label} campaign controls`)).toBeNull();
    }
  });

  it("loads an older bounded webhook-delivery page", async () => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const store = {
      ...baseStore,
      getSnapshot: () => ({
        ok: true,
        data: {
          ...data,
          deliveries: [{ id: "delivery-new", eventName: "case.opened", status: "ok", destinationHost: "new.example" }],
          deliveryCursor: { beforeCreatedAt: "2026-08-24T00:00:00.000Z", beforeId: "delivery-new" },
        },
      }),
      listWebhookDeliveries: async (_actor, cursor) => ({
        ok: true,
        data: {
          items: [{ id: "delivery-old", eventName: "case.updated", status: "failed", destinationHost: "old.example" }],
          nextBeforeCreatedAt: null,
          nextBeforeId: null,
          receivedCursor: cursor,
        },
      }),
    };
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older deliveries" }));
    expect(await screen.findByText(/case\.updated · failed · old\.example/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older deliveries" })).not.toBeInTheDocument();
  });

  it("loads a second bounded provider-operation page", async () => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const listIntegrationJobs = vi.fn(async (_actor, cursor) => ({
      ok: true,
      data: {
        items: [{ id: "job-old", provider: "twilio", jobKind: "sms_status", status: "success", providerStatus: "delivered" }],
        nextBeforeCreatedAt: null,
        nextBeforeId: null,
        receivedCursor: cursor,
      },
    }));
    const store = {
      ...baseStore,
      getSnapshot: () => ({
        ok: true,
        data: {
          ...data,
          jobs: [{ id: "job-new", provider: "twilio", kind: "sms_send", status: "success", providerStatus: "sent" }],
          jobCursor: { beforeCreatedAt: "2026-08-24T00:00:00.000Z", beforeId: "job-new" },
        },
      }),
      listIntegrationJobs,
    };
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older jobs" }));
    expect(await screen.findByText(/SMS delivery update · Delivered/)).toBeInTheDocument();
    expect(listIntegrationJobs).toHaveBeenCalledWith(admin(), {
      beforeCreatedAt: "2026-08-24T00:00:00.000Z",
      beforeId: "job-new",
    });
    expect(screen.queryByRole("button", { name: "Load older jobs" })).not.toBeInTheDocument();
  });

  it("renders every status label and reports bounded public errors", async () => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const statuses = ["unset", "requested", "configured", "connected", "degraded", "revoked", "disabled", "custom", "other"];
    const snapshot = {
      ...data,
      providers: data.providers.map((row, index) => ({ ...row, status: statuses[index] ?? "other" })),
      jobs: [
        { id: "failed-job", provider: "twilio", kind: "provider_health", status: "failed", errorCode: "provider_rejected", attemptCount: 1 },
        { id: "webhook-job", provider: "customer_webhooks", kind: "webhook_deliver", status: "failed", attemptCount: 1 },
        { id: "exhausted-job", provider: "calendar", kind: "connection_probe", status: "failed", attemptCount: 5 },
      ],
    };
    const fakeStore = {
      ...baseStore,
      getSnapshot: () => ({ ok: true, data: snapshot }),
      retryJob: () => ({ ok: false, reason: "job_not_found" }),
    };
    const { rerender, unmount } = render(<IntegrationControlPlane store={fakeStore} actor={admin()} />);
    const labels = ["Not set up", "Setup requested", "Configured", "Connected", "Needs attention", "Revoked", "Disabled", "custom", "other"];
    // The catalogue lists fewer providers than there are statuses to show (the
    // CBA ingest entry is gone), so the statuses that found no row the first
    // time are shown on a second pass over the same rows.
    const shown = labels.slice(0, data.providers.length);
    for (const label of shown) {
      expect(await screen.findByText(new RegExp(`${label} ·`))).toBeInTheDocument();
    }
    const remaining = statuses.slice(data.providers.length);
    expect(remaining.length + shown.length).toBe(labels.length);
    if (remaining.length) {
      const second = { ...snapshot, providers: data.providers.map((row, index) => ({ ...row, status: remaining[index] ?? "unset" })) };
      rerender(<IntegrationControlPlane store={{ ...fakeStore, getSnapshot: () => ({ ok: true, data: second }) }} actor={admin()} />);
      for (const label of labels.slice(data.providers.length)) {
        expect(await screen.findByText(new RegExp(`${label} ·`))).toBeInTheDocument();
      }
    }
    expect(screen.getAllByRole("button", { name: "Retry SMS (Twilio) Readiness check" })).toHaveLength(1);
    expect(screen.getByText("provider_rejected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry SMS (Twilio) Readiness check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be completed");
    unmount();

    render(<IntegrationControlPlane store={baseStore} actor={admin()} />);
    await screen.findByRole("heading", { name: "Connections" });
    fireEvent.click(screen.getByRole("button", { name: "Run next job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be completed");
    fireEvent.change(screen.getByPlaceholderText("https://hooks.example.com/union-ground"), {
      target: { value: "http://hooks.example.com/unsafe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add test endpoint" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("public HTTPS URLs");
  });

  it("hides the plane from unauthorized actors", async () => {
    const store = createIntegrationControlStore();
    const steward = createActor({
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      selectedOrganizationId: ORG_A,
      roles: ["committee worker"],
      membershipStatus: "active",
      mfaSatisfied: true,
    });
    render(<IntegrationControlPlane store={store} actor={steward} />);
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/administrator or president/i);
    });
    expect(screen.queryByRole("button", { name: "Issue key" })).not.toBeInTheDocument();
  });

  it("keeps a one-time secret visible when the post-write refresh fails", async () => {
    const base = createIntegrationControlStore();
    const initial = base.getSnapshot(admin());
    let reads = 0;
    const store = {
      ...base,
      getSnapshot: () => {
        reads += 1;
        return reads === 1 ? initial : { ok: false, reason: "persistence_unavailable" };
      },
      issueApiKey: async () => ({
        ok: true,
        secret: { plaintext: "ug_live_" + "a".repeat(48) },
      }),
    };
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    await screen.findByRole("heading", { name: "Connections" });
    expect(screen.getByLabelText("Key name")).toHaveAttribute("maxlength", "80");
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Operations" } });
    fireEvent.click(screen.getByRole("button", { name: "Issue key" }));
    expect(await screen.findByLabelText("API key")).toHaveValue("ug_live_" + "a".repeat(48));
    expect(screen.getByText(/Integrations are unavailable right now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // #9936 (W7-10 of #9470): these actions finished with nothing on screen,
  // and the one confirmation line lived inside the job queue only.
  function confirmingStore() {
    const base = createIntegrationControlStore();
    const data = base.getSnapshot(admin()).data;
    return {
      ...base,
      getSnapshot: () => ({ ok: true, data: {
        ...data,
        constantContact: { available: true, connected: true, accountLabel: "Fictional mailing list", lastSyncAt: null, memberCount: 3, activeContactCount: 2 },
        jobs: [{ id: "job-1", provider: "twilio", kind: "provider_health", status: "failed", attemptCount: 1, errorCode: "timeout" }],
      } }),
      requestActivation: vi.fn(async () => ({ ok: true })),
      syncConstantContact: vi.fn(async () => ({ ok: true, synced: 3, failed: 0 })),
      retryJob: vi.fn(async () => ({ ok: true })),
      runNextJob: vi.fn(async () => ({ ok: true })),
    };
  }

  function expectTopConfirmation(text) {
    const line = screen.getByText(text);
    expect(line).toHaveAttribute("role", "status");
    expect(line.closest("#integration-jobs")).toBeNull();
    const providers = document.getElementById("integration-providers");
    expect(line.compareDocumentPosition(providers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }

  it("confirms Request setup, Sync, Retry and Run next job at the top of the page", async () => {
    const store = confirmingStore();
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    const line = await waitFor(() => { const node = document.querySelector(".xus-note--live"); expect(node).not.toBeNull(); return node; });
    // Mounted, empty, before any action: its text changes, the node stays.
    expect(line).toHaveAttribute("role", "status");
    expect(line).toHaveTextContent("");
    fireEvent.click(await screen.findByRole("button", { name: "Request setup SMS (Twilio)" }));
    await screen.findByText("Setup requested.");
    expect(document.querySelector(".xus-note--live")).toBe(line);
    expectTopConfirmation("Setup requested.");
    fireEvent.click(screen.getByRole("button", { name: "Sync up to 25 workers" }));
    await screen.findByText("Sync finished.");
    expectTopConfirmation("Sync finished.");
    expect(screen.queryByText("Setup requested.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry SMS (Twilio) Readiness check" }));
    await screen.findByText("The job was queued again.");
    expectTopConfirmation("The job was queued again.");
    fireEvent.click(screen.getByRole("button", { name: "Run next job" }));
    await screen.findByText("The next queued job was processed.");
    expectTopConfirmation("The next queued job was processed.");
    expect(document.querySelector(".xus-note--live")).toBe(line);
    expect(store.requestActivation).toHaveBeenCalledTimes(1);
    expect(store.syncConstantContact).toHaveBeenCalledTimes(1);
    expect(store.retryJob).toHaveBeenCalledWith(expect.anything(), { jobId: "job-1" });
    expect(store.runNextJob).toHaveBeenCalledTimes(1);
  });

  it("confirms an added test endpoint and clears its form, keeps the form after a failure, and confirms a test meeting", async () => {
    const base = createIntegrationControlStore();
    const createWebhook = vi.fn(base.createWebhook.bind(base));
    createWebhook.mockResolvedValueOnce({ ok: false, reason: "invalid_url" });
    const store = { ...base, createWebhook };
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    const url = await screen.findByPlaceholderText("https://hooks.example.com/union-ground");
    fireEvent.change(url, { target: { value: "https://hooks.example.com/fictional" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "case.opened" }));
    fireEvent.click(screen.getByRole("button", { name: "Add test endpoint" }));
    await waitFor(() => expect(createWebhook).toHaveBeenCalledTimes(1));
    await screen.findByRole("alert");
    expect(url).toHaveValue("https://hooks.example.com/fictional");
    expect(screen.getByRole("checkbox", { name: "case.opened" })).toBeChecked();
    expect(screen.queryByText("Test endpoint added.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add test endpoint" }));
    await screen.findByText("Test endpoint added.");
    expectTopConfirmation("Test endpoint added.");
    expect(url).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "case.opened" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "I have copied it" }));
    fireEvent.click(screen.getByRole("button", { name: /^Send test event / }));
    await screen.findByText("Test event queued.");
    expectTopConfirmation("Test event queued.");
  });

  it("confirms in Spanish", async () => {
    render(<LanguageProvider lang="es"><IntegrationControlPlane store={confirmingStore()} actor={admin()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Solicitar alta SMS (Twilio)" }));
    expect(await screen.findByText("Alta solicitada.")).toHaveAttribute("role", "status");
  });

  // #9936 amend: the route answers after the sync, so ok means it finished;
  // a skipped answer (nothing set up or nothing queued) says nothing was synced.
  it("says nothing was synced when the sync answers skipped", async () => {
    const store = confirmingStore();
    store.syncConstantContact.mockResolvedValueOnce({ ok: true, skipped: "no_queued_job" });
    render(<IntegrationControlPlane store={store} actor={admin()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync up to 25 workers" }));
    expect(await screen.findByText("Nothing was synced.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Sync finished.")).toBeNull();
  });

  it("clears only the endpoint fields that still hold what was sent", async () => {
    const base = createIntegrationControlStore();
    let finish;
    const createWebhook = vi.fn((...args) => new Promise((resolve) => { finish = () => resolve(base.createWebhook(...args)); }));
    render(<IntegrationControlPlane store={{ ...base, createWebhook }} actor={admin()} />);
    const url = await screen.findByPlaceholderText("https://hooks.example.com/union-ground");
    fireEvent.change(url, { target: { value: "https://hooks.example.com/first" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "case.opened" }));
    fireEvent.click(screen.getByRole("button", { name: "Add test endpoint" }));
    await waitFor(() => expect(createWebhook).toHaveBeenCalledTimes(1));
    // The address is edited while the add is still running; the events are not.
    fireEvent.change(url, { target: { value: "https://hooks.example.com/second" } });
    await act(async () => { finish(); });
    await screen.findByText("Test endpoint added.");
    expect(url).toHaveValue("https://hooks.example.com/second");
    expect(screen.getByRole("checkbox", { name: "case.opened" })).not.toBeChecked();
  });

  it("scrolls the confirmation into view only when it is set off screen", async () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<IntegrationControlPlane store={confirmingStore()} actor={admin()} />);
      const line = await waitFor(() => { const node = document.querySelector(".xus-note--live"); expect(node).not.toBeNull(); return node; });
      line.getBoundingClientRect = () => ({ top: -120, bottom: -100, left: 0, right: 0, width: 0, height: 20 });
      fireEvent.click(await screen.findByRole("button", { name: "Request setup SMS (Twilio)" }));
      await screen.findByText("Setup requested.");
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
      expect(scroll.mock.contexts.every((node) => node === line)).toBe(true);
      scroll.mockClear();
      line.getBoundingClientRect = () => ({ top: 10, bottom: 30, left: 0, right: 0, width: 0, height: 20 });
      fireEvent.click(screen.getByRole("button", { name: "Run next job" }));
      await screen.findByText("The next queued job was processed.");
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

// UX-UG-INTEGRATIONS-PAGE-SPEAKS-ENGINEER-20261125 (#9942, B-56 of
// #9529): the page read "Provider control plane", "Requested · Effective off"
// and "the scheduled dispatcher" to a union president. Fictional store only.
describe("integrations page in plain words (#9942)", () => {
  it.each([
    ["en", { tab: "Connections", unset: "Not set up · Not in use", request: "Request setup SMS (Twilio)", requested: "Setup requested · Not in use",
      webhooks: "Webhooks", apiKeys: "API keys", summary: "Webhooks send test events to HTTPS addresses this organization chooses",
      banned: /control plane|Effective|Degraded|dispatcher|Customer (webhooks|API keys)|\bUnset\b/ }],
    ["es", { tab: "Conexiones", unset: "Sin configurar · Sin uso", request: "Solicitar alta SMS (Twilio)", requested: "Alta solicitada · Sin uso",
      webhooks: "Webhooks", apiKeys: "Claves de API", summary: "Los webhooks envían eventos de prueba a las direcciones HTTPS elegidas por esta organización",
      banned: /Panel de|Efectivo|Degradado|proceso programado|(Webhooks|Claves de API) del cliente|Effective|control plane/ }],
  ])("names the connections tab, statuses and webhooks plainly (%s)", async (lang, expected) => {
    const store = createIntegrationControlStore();
    const { container } = render(<LanguageProvider lang={lang}><IntegrationControlPlane store={store} actor={admin()} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: expected.tab })).toBeInTheDocument();
    expect(screen.getAllByText(expected.unset).length).toBeGreaterThan(0);
    expect(screen.getAllByText(expected.webhooks).length).toBeGreaterThan(0);
    expect(screen.getAllByText(expected.apiKeys).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(expected.summary))).toBeInTheDocument();
    const twilioRow = screen.getByText("SMS (Twilio)").closest("li");
    fireEvent.click(within(twilioRow).getByRole("button", { name: expected.request }));
    await waitFor(() => expect(within(twilioRow).getByText(expected.requested)).toBeInTheDocument());
    expect(container.textContent).not.toMatch(expected.banned);
  });
});

// UX-UG-INTEGRATIONS-JOBS-TAB-PRINTS-RAW-JOB-KINDS-AND-STATUSES-20261125
// (#10033, B-56 of #9529): the Jobs tab read "twilio provider_health · queued",
// "privacy-minimized provider operations" and "the organization worker".
// Fictional store only.
describe("integrations Jobs tab in plain words (#10033)", () => {
  const jobs = [
    { id: "job-ready", provider: "twilio", kind: "provider_health", status: "queued", attemptCount: 0 },
    { id: "job-sync", provider: "constant_contact", kind: "constant_contact_sync", status: "dead", attemptCount: 5 },
    { id: "job-sms", provider: "twilio", kind: "sms_send", status: "success", providerStatus: "undelivered", attemptCount: 1 },
    { id: "job-probe", provider: "google_calendar", kind: "connection_probe", status: "failed", attemptCount: 1 },
    { id: "job-consent", provider: "twilio", kind: "sms_consent", status: "success", providerStatus: "opt_out", attemptCount: 1 },
  ];
  it.each([
    ["en", {
      rows: ["Readiness check · Waiting to run", "Contact sync · Stopped retrying", "SMS send · Not delivered", "Connection test · Failed", "SMS consent update · Opted out"],
      retry: "Retry Google Calendar Connection test",
      sub: "Readiness checks, messages and syncs for your connected services.",
      permission: "Admins and Campaign chairs can queue readiness checks with an active organization account and two-step sign-in turned on.",
      worker: "Jobs cannot be added or run from this page on this site. It shows only results that were already saved.",
      banned: /provider_health|constant_contact_sync|connection_probe|sms_send|\b(queued|undelivered|dead)\b|privacy-minimized|organization worker|persisted health|\bMFA\b|operations/ }],
    ["es", {
      rows: ["Comprobación de preparación · En espera", "Sincronización de contactos · Sin más reintentos", "Envío SMS · No entregado", "Prueba de conexión · Falló", "Cambio de consentimiento SMS · Retiró su consentimiento para recibir SMS"],
      retry: "Reintentar Google Calendar Prueba de conexión",
      sub: "Comprobaciones, mensajes y sincronizaciones de tus servicios conectados.",
      permission: "Los administradores y la presidencia de campaña pueden agregar comprobaciones con una cuenta activa en la organización y el inicio de sesión en dos pasos activado.",
      worker: "En este sitio no se pueden agregar ni ejecutar tareas desde esta página. Solo muestra los resultados ya guardados.",
      banned: /provider_health|constant_contact_sync|connection_probe|sms_send|\b(queued|undelivered|dead|success)\b|datos minimizados|proceso de la organización|estado persistido|multifactor|operaciones/ }],
  ])("names each job's service, kind and status and explains the tab plainly (%s)", async (lang, expected) => {
    const baseStore = createIntegrationControlStore();
    const data = baseStore.getSnapshot(admin()).data;
    const snapshotWith = (capabilities) => ({ ...baseStore, getSnapshot: () => ({ ok: true, data: { ...data, jobs, capabilities: { ...data.capabilities, ...capabilities } } }) });
    const first = render(<LanguageProvider lang={lang}><IntegrationControlPlane store={snapshotWith({})} actor={admin()} /></LanguageProvider>);
    const jobsCard = (await screen.findByText(expected.rows[0])).closest("article");
    for (const row of expected.rows) expect(within(jobsCard).getByText(row)).toBeInTheDocument();
    expect(within(jobsCard).getAllByText("SMS (Twilio)")).toHaveLength(3);
    expect(within(jobsCard).getByText("Constant Contact")).toBeInTheDocument();
    expect(within(jobsCard).getByRole("button", { name: expected.retry })).toBeInTheDocument();
    expect(within(jobsCard).getByText(new RegExp(expected.sub))).toBeInTheDocument();
    expect(within(jobsCard).getByText(expected.permission)).toBeInTheDocument();
    expect(jobsCard.textContent).not.toMatch(expected.banned);
    first.unmount();

    render(<LanguageProvider lang={lang}><IntegrationControlPlane store={snapshotWith({ jobsWrite: false })} actor={admin()} /></LanguageProvider>);
    const readOnlyCard = (await screen.findByText(expected.rows[0])).closest("article");
    expect(within(readOnlyCard).getByText(expected.worker)).toBeInTheDocument();
    expect(readOnlyCard.textContent).not.toMatch(expected.banned);
  });
});
