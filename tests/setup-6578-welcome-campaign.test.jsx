// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 74: the
// Welcome campaign form has its own message field. The server keeps a message
// as a campaign step with a subject, so a typed message is saved as the first
// step (day 0, the page language) under a default subject. All values are
// fictional.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberOperations } from "../src/features/memberOperations/MemberOperations.jsx";
import { MEMBER_OPERATIONS_RPCS } from "../src/features/memberOperations/contract.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const NEW_CAMPAIGN = "88888888-8888-4888-8888-888888888888";
const actor = {
  userId: "11111111-1111-4111-8111-111111111111",
  selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
  membershipStatus: "active",
  selectedHat: "admin",
  organizationRoles: ["admin"],
  mfaSatisfied: true,
};
const workspace = {
  state: "ready",
  organizationId: actor.selectedOrganizationId,
  deliveryConfigured: false,
  directory: { items: [], nextCursor: null },
  campaigns: [],
  imports: [],
};

function renderOperations(lang = "en", failStep = false) {
  const client = {
    rpc: vi.fn(async (name) => {
      if (name === "get_member_operations_workspace") return { data: workspace, error: null };
      if (name === MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign) return { data: { id: NEW_CAMPAIGN, state: "draft" }, error: null };
      if (name === MEMBER_OPERATIONS_RPCS.saveWelcomeStep && failStep) return { data: null, error: { code: "22023", message: "invalid welcome campaign step" } };
      return { data: { updated: true }, error: null };
    }),
  };
  const onNotice = vi.fn();
  render(<LanguageProvider lang={lang}><MemberOperations actor={actor} client={client} onNotice={onNotice} /></LanguageProvider>);
  return { client, onNotice };
}

const calls = (client, name) => client.rpc.mock.calls.filter(([called]) => called === name);

async function openWelcome(tab = "Welcome") {
  fireEvent.click(await screen.findByRole("button", { name: tab }));
}

beforeEach(() => { vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("welcome campaign message field", () => {
  it("saves the typed message as the campaign's first step under the default subject", async () => {
    const { client, onNotice } = renderOperations();
    await openWelcome();
    const message = screen.getByLabelText("Welcome message (optional)");
    expect(message.tagName).toBe("TEXTAREA");
    expect(message).toHaveAccessibleDescription('Sent the day a worker is enrolled, with the subject "Welcome". You can change it or add more steps under Manage campaign.');
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Pilot welcome" } });
    fireEvent.change(message, { target: { value: "  Welcome! The office is open 9 to 5.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeStep)).toHaveLength(1));
    expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign)[0][1]).toMatchObject({ p_campaign_id: null, p_name: "Pilot welcome", p_state: "draft" });
    expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeStep)[0][1]).toMatchObject({
      p_campaign_id: NEW_CAMPAIGN, p_step_id: null, p_position: 0, p_delay_days: 0, p_locale: "en",
      p_subject: "Welcome", p_body: "Welcome! The office is open 9 to 5.", p_active: true,
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Welcome campaign saved."));
    await waitFor(() => expect(screen.getByLabelText("Welcome message (optional)")).toHaveValue(""));
  });

  it("creates only the campaign when no message is typed", async () => {
    const { client, onNotice } = renderOperations();
    await openWelcome();
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Pilot welcome" } });
    fireEvent.change(screen.getByLabelText("Welcome message (optional)"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Welcome campaign saved."));
    expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign)).toHaveLength(1);
    expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeStep)).toHaveLength(0);
  });

  it("reports a failed message save instead of claiming success, and keeps the typed message", async () => {
    const { onNotice } = renderOperations("en", true);
    await openWelcome();
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Pilot welcome" } });
    fireEvent.change(screen.getByLabelText("Welcome message (optional)"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(onNotice).not.toHaveBeenCalledWith("Welcome campaign saved.");
    expect(screen.getByLabelText("Welcome message (optional)")).toHaveValue("Hello");
  });

  // Codex review on #6640: a retry after a failed message save must not make
  // a second campaign; it saves only the message on the campaign already made.
  it("retries only the message on the campaign already created, then clears the form", async () => {
    let failStep = true;
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_member_operations_workspace") return { data: workspace, error: null };
        if (name === MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign) return { data: { id: NEW_CAMPAIGN, state: "active" }, error: null };
        if (name === MEMBER_OPERATIONS_RPCS.saveWelcomeStep && failStep) return { data: null, error: { code: "57014", message: "timeout" } };
        return { data: { updated: true }, error: null };
      }),
    };
    const onNotice = vi.fn();
    render(<LanguageProvider lang="en"><MemberOperations actor={actor} client={client} onNotice={onNotice} /></LanguageProvider>);
    await openWelcome();
    const workspaceReads = () => calls(client, "get_member_operations_workspace").length;
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "Pilot welcome" } });
    fireEvent.change(screen.getByLabelText("Welcome message (optional)"), { target: { value: "Hello" } });
    const readsBefore = workspaceReads();
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(await screen.findByText("The campaign is saved, but its message is not. Create campaign again saves only the message.")).toBeInTheDocument();
    await waitFor(() => expect(workspaceReads()).toBeGreaterThan(readsBefore));
    expect(screen.getByLabelText("Campaign name")).toHaveAttribute("readonly");
    failStep = false;
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Welcome campaign saved."));
    expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign)).toHaveLength(1);
    expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeStep)).toHaveLength(2);
    expect(calls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeStep)[1][1]).toMatchObject({ p_campaign_id: NEW_CAMPAIGN, p_body: "Hello" });
    await waitFor(() => expect(screen.getByLabelText("Campaign name")).toHaveValue(""));
    expect(screen.queryByText(/its message is not/)).toBeNull();
  });

});
