import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberOperations } from "../src/features/memberOperations/MemberOperations.jsx";
import { MEMBER_OPERATIONS_RPCS } from "../src/features/memberOperations/contract.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

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
  directory: {
    items: [{
      userId: "33333333-3333-4333-8333-333333333333",
      fullName: "Avery Brooks",
      initials: "AB",
      chapterId: "bos",
      chapterName: "Boston",
      version: 2,
      profile: { department: "Nursing" },
    }],
    nextCursor: null,
  },
  campaigns: [{
    id: "44444444-4444-4444-8444-444444444444",
    name: "First week",
    state: "active",
    steps: [{ id: "55555555-5555-4555-8555-555555555555", position: 0, delayDays: 0, locale: "en", subject: "Welcome", body: "Welcome aboard", active: true }],
    enrollments: [{
      id: "66666666-6666-4666-8666-666666666666",
      memberUserId: "33333333-3333-4333-8333-333333333333",
      memberName: "Avery Brooks",
      state: "active",
      nextStepPosition: 1,
      deliveries: [{ id: "77777777-7777-4777-8777-777777777777", state: "failed", attemptCount: 1, errorCode: "provider_unset" }],
    }],
  }],
  imports: [],
};

// TEST-UG-MEMBER-OPERATIONS-FIRST-PAGE-CI-FOLLOWUP-20260909: CI run 34385276623
// lost the first next-page assertion with only the retained DOM (first row and an
// enabled "Load next page" button) as evidence. The timeline below records every
// directory RPC (exact cursor arguments, settlement time and outcome), every
// workspace load and every notice, so a future failure names its boundary
// (RPC never issued, RPC rejected and caught, RPC resolved but the appended page
// never rendered) instead of leaving it to inference. It changes no timeout.
function pagingTimeline(rpcOverride) {
  const origin = performance.now();
  const at = () => Math.round((performance.now() - origin) * 10) / 10;
  const timeline = { rpc: [], notices: [], marks: {} };
  const rpc = async (name, args) => {
    const entry = { name, calledAt: at(), settledAt: null, outcome: "pending" };
    if (name === "get_member_operations_directory") {
      entry.cursor = { p_query: args?.p_query ?? null, p_after_name: args?.p_after_name ?? null, p_after_id: args?.p_after_id ?? null, p_limit: args?.p_limit ?? null };
    }
    timeline.rpc.push(entry);
    try {
      const result = await rpcOverride(name, args);
      entry.settledAt = at();
      entry.outcome = result?.error ? `error:${result.error.message}` : "resolved";
      return result;
    } catch (error) {
      entry.settledAt = at();
      entry.outcome = `rejected:${error?.message || error}`;
      throw error;
    }
  };
  const onNotice = vi.fn((message) => { timeline.notices.push({ message: String(message), at: at() }); });
  const mark = (label) => { timeline.marks[label] = at(); };
  const snapshot = () => ({
    ...timeline,
    now: at(),
    directoryRows: document.querySelectorAll(".member-operations-row").length,
    nextPageButton: Boolean(screen.queryByRole("button", { name: "Load next page" })),
    workspaceLoads: timeline.rpc.filter((entry) => entry.name === "get_member_operations_workspace").length,
    directoryCalls: timeline.rpc.filter((entry) => entry.name === "get_member_operations_directory"),
  });
  return { rpc, onNotice, mark, snapshot };
}

// Runs an unchanged Testing Library lookup; on failure it rethrows with the
// paging timeline attached so the retained CI log distinguishes the boundary.
async function findWithPagingDiagnostics(lookup, recorder, label) {
  try {
    return await lookup();
  } catch (error) {
    const diagnosis = recorder.snapshot();
    const detail = [
      `${label}: paging diagnostics`,
      `workspace loads: ${diagnosis.workspaceLoads}`,
      `directory RPC calls: ${JSON.stringify(diagnosis.directoryCalls)}`,
      `notices: ${JSON.stringify(diagnosis.notices)}`,
      `marks: ${JSON.stringify(diagnosis.marks)} now: ${diagnosis.now}ms`,
      `rendered directory rows: ${diagnosis.directoryRows}; Load next page button present: ${diagnosis.nextPageButton}`,
    ].join("\n");
    const wrapped = new Error(`${error.message}\n\n${detail}`);
    wrapped.cause = error;
    wrapped.pagingDiagnosis = diagnosis;
    throw wrapped;
  }
}

// BUG-UG-CI-MEMBER-OPERATIONS-TEST-READS-THE-EDITOR-BEFORE-IT-OPENS-20261125
// (#10015): since #9972 the directory row reads "Version 2" too, so a wait for
// that text is met before the member editor has opened, and the next read of
// an editor field fails by timing. Open the editor and wait for the opened
// editor itself (its Job title field); read the version inside it.
const EDITOR_EMPTY = "Select a worker to review or update the operational record.";
async function openEditor(name) {
  fireEvent.click(screen.getByRole("button", { name }));
  const editor = (await screen.findByLabelText("Job title")).closest("form");
  expect(within(editor).getByText("Selected worker")).toBeInTheDocument();
  return editor;
}

function rpcCalls(client, name) {
  return client.rpc.mock.calls.filter((call) => call[0] === name);
}

function renderOperations(overrides = {}, snapshot = workspace, rpcOverride = null, session = null, onNotice = vi.fn()) {
  const client = {
    rpc: vi.fn(rpcOverride || (async (name) => ({
      data: name === "get_member_operations_workspace" ? snapshot : { updated: true },
      error: null,
    }))),
  };
  const rendered = render(<MemberOperations actor={{ ...actor, ...overrides }} client={client} session={session} onNotice={onNotice} />);
  return { ...rendered, client, onNotice };
}

describe("member operations UI", () => {
  it.each([
    ["en", "Welcome", "Manage campaign", "Enroll", "Enroll worker", "Activate this campaign to enroll workers.", "Choose a worker to enroll.", "Archived campaigns cannot enroll workers."],
    ["es", "Bienvenida", "Administrar campaña", "Inscribir", "Inscribir trabajador", "Activa esta campaña para inscribir a trabajadores.", "Elige a un trabajador para inscribirlo.", "Las campañas archivadas no pueden inscribir a trabajadores."],
  ])("explains blocked welcome enrollment in %s", async (lang, tab, manage, enroll, memberLabel, inactive, missing, archivedReason) => {
    const active = workspace.campaigns[0];
    const archived = { ...active, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Earlier campaign", state: "archived" };
    const firstMember = workspace.directory.items[0];
    const selectedMember = { ...firstMember, userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fullName: "Jordan Lee" };
    const snapshot = { ...workspace, campaigns: [archived, { ...active, state: "draft" }], directory: { ...workspace.directory, items: [firstMember, selectedMember] } };
    const client = { rpc: vi.fn(async (name) => ({
      data: name === "get_member_operations_workspace" ? snapshot : { updated: true },
      error: null,
    })) };
    const writes = () => rpcCalls(client, MEMBER_OPERATIONS_RPCS.enrollWelcome);
    render(<LanguageProvider lang={lang}><MemberOperations actor={actor} client={client} onNotice={vi.fn()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: tab, exact: true }));
    const archivedCard = within((await screen.findByRole("heading", { name: archived.name })).closest("article"));
    fireEvent.click(archivedCard.getByRole("button", { name: manage }));
    fireEvent.change(archivedCard.getByLabelText(memberLabel), { target: { value: selectedMember.userId } });
    const archivedEnroll = archivedCard.getByRole("button", { name: enroll, exact: true });
    expect(archivedEnroll).toHaveAccessibleDescription(archivedReason);
    expectRefusedEveryWay(archivedEnroll, archivedReason, () => writes().length > 0);

    const draftCard = within(screen.getByRole("heading", { name: active.name }).closest("article"));
    fireEvent.click(draftCard.getByRole("button", { name: manage }));
    const button = draftCard.getByRole("button", { name: enroll, exact: true });
    fireEvent.change(draftCard.getByLabelText(memberLabel), { target: { value: selectedMember.userId } });
    expect(button).toHaveAccessibleDescription(inactive);
    expect(button.nextElementSibling).toBeVisible();
    expectRefusedEveryWay(button, inactive, () => writes().length > 0);

    snapshot.campaigns = [archived, active];
    fireEvent.click(draftCard.getByRole("button", { name: lang === "es" ? "Activar campaña" : "Activate campaign", exact: true }));
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
    fireEvent.change(draftCard.getByLabelText(memberLabel), { target: { value: "" } });
    expect(button).toHaveAccessibleDescription(missing);
    expectRefusedEveryWay(button, missing, () => writes().length > 0);
    fireEvent.change(draftCard.getByLabelText(memberLabel), { target: { value: selectedMember.userId } });
    fireEvent.click(button);
    await waitFor(() => expect(writes()).toEqual([[MEMBER_OPERATIONS_RPCS.enrollWelcome, {
      p_campaign_id: active.id,
      p_member_user_id: selectedMember.userId,
      p_idempotency_key: expect.any(String),
    }]]));
  });

  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("keeps the entire surface behind the explicit Admin plus MFA boundary", async () => {
    const { client } = renderOperations({ mfaSatisfied: false });
    expect(await screen.findByText("Complete two-step sign-in to open protected worker records.")).toBeInTheDocument();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Welcome" })).not.toBeInTheDocument();
  });

  it("operates campaign lifecycle, enrollment state, and bounded outbox history", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const { client } = renderOperations();
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Welcome" }));
    expect(screen.getByText(/Sending email is optional; it is currently not set up/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage campaign" }));
    expect(within(screen.getByRole("list", { name: "Delivery history for Avery Brooks" })).getByText("provider_unset", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause campaign" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_welcome_campaign", expect.objectContaining({
      p_campaign_id: workspace.campaigns[0].id,
      p_name: "First week",
      p_state: "paused",
      p_idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("transition_member_welcome_enrollment", expect.objectContaining({
      p_enrollment_id: workspace.campaigns[0].enrollments[0].id,
      p_state: "cancelled",
    })));
  });

  it("explains incomplete CSV mappings and prevents staging them", async () => {
    const { container } = renderOperations();
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Imports" }));
    const input = container.querySelector('input[type="file"]');
    const file = new File(["department,location\nNursing,Boston"], "members.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("department,location\nNursing,Boston") });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText(/map either member id or email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload 1 row for checking" })).toBeDisabled();
  });

  it("refuses an over-wide CSV before any member data can be staged", async () => {
    const { container, client } = renderOperations();
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Imports" }));
    const source = "email,department\nmember@example.test,Finance,Payroll";
    const file = new File([source], "members.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(source) });
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
    expect(await screen.findByText("Every CSV column needs a header")).toBeInTheDocument();
    const stage = screen.getByRole("button", { name: "Upload rows for checking" });
    expect(stage).toBeDisabled();
    fireEvent.click(stage);
    expect(client.rpc.mock.calls.some(([name]) => name === "stage_member_operations_import")).toBe(false);
  });

  it("searches, pages, edits, cancels, and bulk-updates member records", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const paged = {
      ...workspace,
      directory: { ...workspace.directory, nextCursor: { name: "Avery Brooks", id: workspace.directory.items[0].userId } },
    };
    const second = { ...workspace.directory.items[0], userId: "88888888-8888-4888-8888-888888888888", fullName: "Jordan Lee", version: 0 };
    const recorder = pagingTimeline(async (name, args) => {
      if (name === "get_member_operations_workspace") return { data: paged, error: null };
      if (name === "get_member_operations_directory") return { data: args.p_after_id ? { items: [second], nextCursor: null } : workspace.directory, error: null };
      if (name === "get_member_operational_profile") return { data: { ...workspace.directory.items[0], profile: { department: "Nursing", preferredLanguage: "en", administrativeNotes: "Initial" } }, error: null };
      return { data: { updated: true }, error: null };
    });
    const { client } = renderOperations({}, paged, recorder.rpc, null, recorder.onNotice);
    await screen.findByRole("heading", { name: "Worker directory" });
    recorder.mark("heading-visible");
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    recorder.mark("next-page-clicked");
    // Unchanged lookup and 1000 ms budget; only the failure message gains the timeline.
    expect(await findWithPagingDiagnostics(() => screen.findByText("Jordan Lee"), recorder, "first next page")).toBeInTheDocument();
    const nextPageCall = recorder.snapshot().directoryCalls.at(-1);
    expect(nextPageCall.cursor).toEqual({ p_query: null, p_after_name: "Avery Brooks", p_after_id: workspace.directory.items[0].userId, p_limit: 25 });
    expect(nextPageCall.outcome).toBe("resolved");
    expect(recorder.snapshot().workspaceLoads).toBe(1);
    expect(recorder.onNotice).not.toHaveBeenCalled();

    const search = screen.getByPlaceholderText("Search by worker name");
    fireEvent.change(search, { target: { value: "A" } });
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    fireEvent.change(search, { target: { value: "Avery" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("get_member_operations_directory", expect.objectContaining({ p_query: "Avery" })));

    const editor = await openEditor(/Avery Brooks/);
    expect(within(editor).getByText("Version 2")).toBeInTheDocument();
    expect(within(editor).getByLabelText("Job title")).toHaveAttribute("maxlength", "160");
    expect(screen.getByLabelText("Department")).toHaveAttribute("maxlength", "160");
    expect(screen.getByLabelText("Participation classification")).toHaveAttribute("maxlength", "120");
    fireEvent.change(screen.getByLabelText("Worker number"), { target: { value: "M-42" } });
    fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Nurse" } });
    fireEvent.change(screen.getByLabelText("Department"), { target: { value: "Care" } });
    fireEvent.change(screen.getByLabelText("Work location"), { target: { value: "Boston" } });
    fireEvent.change(screen.getByLabelText("Hire date"), { target: { value: "2024-01-02" } });
    fireEvent.change(screen.getByLabelText("Participation classification"), { target: { value: "Active" } });
    fireEvent.change(screen.getByLabelText("Preferred language"), { target: { value: "es" } });
    fireEvent.change(screen.getByLabelText("Administrative notes"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save worker record" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_member_operational_profile", expect.objectContaining({
      p_member_user_id: workspace.directory.items[0].userId,
      p_expected_version: 2,
      p_fields: expect.objectContaining({ memberNumber: "M-42", preferredLanguage: "es", administrativeNotes: "Updated" }),
    })));

    // A saved record closes the editor; wait for that before opening it again,
    // so the next wait cannot be met by the editor that is about to close.
    expect(await screen.findByText(EDITOR_EMPTY)).toBeInTheDocument();
    const reopened = await openEditor(/Avery Brooks/);
    expect(within(reopened).getByText("Version 2")).toBeInTheDocument();
    fireEvent.click(within(reopened).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(EDITOR_EMPTY)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select Avery Brooks"));
    const bulk = screen.getByText("Bulk update selected workers").closest("form");
    fireEvent.change(within(bulk).getByLabelText("Field"), { target: { value: "workLocation" } });
    fireEvent.change(within(bulk).getByLabelText("New value"), { target: { value: "Cambridge" } });
    fireEvent.click(within(bulk).getByRole("button", { name: "Update 1" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("bulk_update_member_operational_profiles", expect.objectContaining({
      p_member_user_ids: [workspace.directory.items[0].userId], p_field: "workLocation", p_value: "Cambridge",
    })));
    fireEvent.change(within(bulk).getByLabelText("Field"), { target: { value: "preferredLanguage" } });
    expect(within(bulk).getByLabelText("New value").tagName).toBe("SELECT");
    expect(within(bulk).getByRole("option", { name: "English" })).toHaveValue("en");
  });

  it("names the next-page boundary when the directory RPC is rejected and caught", async () => {
    const paged = {
      ...workspace,
      directory: { ...workspace.directory, nextCursor: { name: "Avery Brooks", id: workspace.directory.items[0].userId } },
    };
    const recorder = pagingTimeline(async (name) => {
      if (name === "get_member_operations_workspace") return { data: paged, error: null };
      if (name === "get_member_operations_directory") return { data: null, error: new Error("Directory offline") };
      return { data: { updated: true }, error: null };
    });
    renderOperations({}, paged, recorder.rpc, null, recorder.onNotice);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    await waitFor(() => expect(recorder.onNotice).toHaveBeenCalledWith("Directory offline"));
    expect(document.querySelectorAll(".member-operations-directory .member-operations-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Load next page" })).toBeInTheDocument();
    // The lookup runs on the suite's normal asynchronous budget, not a 50ms window, so a
    // second directory row appended a few hundred milliseconds after the notice still fails.
    const failure = await findWithPagingDiagnostics(() => screen.findByText("Jordan Lee"), recorder, "rejected next page").catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.cause).toBeDefined();
    expect(failure.message).toContain("Unable to find an element with the text: Jordan Lee");
    // Only the serialised timeline values are asserted here; the helper's prose labels are
    // free to change, and the rows and the retry button are read from the DOM instead.
    expect(failure.message).toContain('"outcome":"error:Directory offline"');
    expect(failure.message).toContain('"p_after_name":"Avery Brooks"');
    expect(failure.message).toContain('"message":"Directory offline"');
    expect(failure.pagingDiagnosis.workspaceLoads).toBe(1);
    expect(screen.queryByText("Jordan Lee")).toBeNull();
    expect(document.querySelectorAll(".member-operations-directory .member-operations-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Load next page" })).toBeInTheDocument();
  });

  it("names the next-page boundary when the directory RPC never settles", async () => {
    const paged = {
      ...workspace,
      directory: { ...workspace.directory, nextCursor: { name: "Avery Brooks", id: workspace.directory.items[0].userId } },
    };
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const recorder = pagingTimeline(async (name) => {
      if (name === "get_member_operations_workspace") return { data: paged, error: null };
      if (name === "get_member_operations_directory") return pending;
      return { data: { updated: true }, error: null };
    });
    renderOperations({}, paged, recorder.rpc, null, recorder.onNotice);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    const failure = await findWithPagingDiagnostics(() => screen.findByText("Jordan Lee", {}, { timeout: 50 }), recorder, "pending next page").catch((error) => error);
    expect(failure.message).toContain('"outcome":"pending"');
    expect(failure.message).toContain('"settledAt":null');
    expect(failure.message).toContain("notices: []");
    expect(recorder.onNotice).not.toHaveBeenCalled();
    release({ data: { items: [{ ...workspace.directory.items[0], userId: "88888888-8888-4888-8888-888888888888", fullName: "Jordan Lee", version: 0 }], nextCursor: null }, error: null });
    expect(await screen.findByText("Jordan Lee")).toBeInTheDocument();
    expect(recorder.snapshot().directoryCalls.at(-1).outcome).toBe("resolved");
    expect(recorder.snapshot().directoryRows).toBe(2);
    expect(recorder.snapshot().nextPageButton).toBe(false);
  });

  it("reports directory search, profile, and pagination failures without losing the workspace", async () => {
    const paged = {
      ...workspace,
      directory: { ...workspace.directory, nextCursor: { name: "Avery Brooks", id: workspace.directory.items[0].userId } },
    };
    const { onNotice } = renderOperations({}, paged, async (name) => {
      if (name === "get_member_operations_workspace") return { data: paged, error: null };
      if (name === "get_member_operations_directory") return { data: null, error: new Error("Directory offline") };
      if (name === "get_member_operational_profile") return { data: null, error: new Error("Profile offline") };
      return { data: { updated: true }, error: null };
    });
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.change(screen.getByPlaceholderText("Search by worker name"), { target: { value: "Avery" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Directory offline"));
    onNotice.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Avery Brooks/ }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Profile offline"));
    onNotice.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Directory offline"));
    expect(screen.getByRole("heading", { name: "Worker directory" })).toBeInTheDocument();
  });

  it("creates and manages campaign steps, enrollments, queue state, and lifecycle actions", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const expanded = {
      ...workspace,
      deliveryConfigured: true,
      campaigns: [
        { ...workspace.campaigns[0], enrollments: [
          ...workspace.campaigns[0].enrollments,
          { ...workspace.campaigns[0].enrollments[0], id: "99999999-9999-4999-8999-999999999999", memberName: "Jordan Lee", state: "paused", deliveries: [] },
        ] },
        { ...workspace.campaigns[0], id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", name: "Second week", state: "paused", steps: [], enrollments: [] },
      ],
    };
    const { client } = renderOperations({}, expanded);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Welcome" }));
    expect(screen.getByText(/Sending email is optional; it is currently configured/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Campaign name"), { target: { value: "New member sequence" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_welcome_campaign", expect.objectContaining({ p_campaign_id: null, p_name: "New member sequence", p_state: "active" })));
    fireEvent.click(screen.getByRole("button", { name: "Queue due messages" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("queue_due_welcome_messages", expect.any(Object)));

    fireEvent.click(screen.getAllByRole("button", { name: "Manage campaign" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Subject")).toHaveValue("Welcome");
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Updated welcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_welcome_campaign_step", expect.objectContaining({
      p_step_id: workspace.campaigns[0].steps[0].id,
      p_subject: "Updated welcome",
      p_active: true,
    })));
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_welcome_campaign_step", expect.objectContaining({
      p_step_id: workspace.campaigns[0].steps[0].id,
      p_active: false,
    })));
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Delay in days"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "es" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Follow up" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "How is everything going?" } });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_welcome_campaign_step", expect.objectContaining({ p_position: 3, p_delay_days: 14, p_locale: "es" })));
    fireEvent.change(screen.getByLabelText("Enroll worker"), { target: { value: workspace.directory.items[0].userId } });
    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("enroll_member_in_welcome_campaign", expect.objectContaining({ p_member_user_id: workspace.directory.items[0].userId })));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("transition_member_welcome_enrollment", expect.objectContaining({ p_state: "active" })));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("transition_member_welcome_enrollment", expect.objectContaining({ p_state: "paused" })));
    fireEvent.click(screen.getAllByRole("button", { name: "Activate campaign" })[0]);
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_welcome_campaign", expect.objectContaining({ p_state: "active" })));
    fireEvent.click(screen.getAllByRole("button", { name: "Archive campaign" })[0]);
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_welcome_campaign", expect.objectContaining({ p_state: "archived" })));
  });

  it("stages valid CSV data and operates every import batch state", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const imports = [
      { id: "batch-uploaded", kind: "member", state: "uploaded", filename: "uploaded.csv", validCount: 0, errorCount: 0, errors: [] },
      { id: "batch-validated", kind: "member", state: "validated", filename: "validated.csv", validCount: 1, errorCount: 0, errors: [] },
      { id: "batch-failed", kind: "grievance", state: "failed", filename: "failed.csv", validCount: 0, errorCount: 1, errors: [{ rowNumber: 2, field: "email", code: "missing", message: "Member was not found" }] },
      { id: "batch-committed", kind: "member", state: "committed", filename: "committed.csv", validCount: 1, errorCount: 0, errors: [] },
    ];
    const { container, client } = renderOperations({}, { ...workspace, imports });
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Imports" }));
    const input = container.querySelector('input[type="file"]');
    const file = new File(["email,department\navery@example.test,Nursing"], "members.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("email,department\navery@example.test,Nursing") });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("1 row ready to upload and check.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("department"), { target: { value: "work_location" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload 1 row for checking" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("stage_member_operations_import", expect.objectContaining({
      p_kind: "member", p_filename: "members.csv", p_rows: [{ email: "avery@example.test", work_location: "Nursing" }],
    })));
    fireEvent.click(screen.getAllByRole("button", { name: "Validate" })[0]);
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("validate_member_operations_import", expect.objectContaining({ p_batch_id: "batch-uploaded" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit all rows" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Commit all rows" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("commit_member_operations_import", expect.objectContaining({ p_batch_id: "batch-validated" })));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Discard" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]);
    await waitFor(() => {
      expect(client.rpc).toHaveBeenCalledWith("discard_member_operations_import", expect.objectContaining({ p_batch_id: "batch-uploaded" }));
    });
    expect(screen.getByText(/Row 2, email: Member was not found/)).toBeInTheDocument();
  });

  it("reloads revalidation errors before reporting a rejected import commit", async () => {
    const validated = { id: "batch-revalidated", kind: "member", state: "validated", filename: "members.csv", validCount: 1, errorCount: 0, errors: [] };
    const rejected = { ...validated, state: "failed", validCount: 0, errorCount: 1, errors: [{ rowNumber: 2, field: "member_id", code: "inactive", message: "Member is no longer active" }] };
    let workspaceLoads = 0;
    const rpc = async (name) => {
      if (name === "get_member_operations_workspace") {
        workspaceLoads += 1;
        return { data: { ...workspace, imports: workspaceLoads === 1 ? [validated] : [rejected] }, error: null };
      }
      if (name === "commit_member_operations_import") {
        return { data: { state: "validated", committed: false, reason: "revalidation_failed" }, error: null };
      }
      return { data: { updated: true }, error: null };
    };
    const { client, onNotice } = renderOperations({}, { ...workspace, imports: [validated] }, rpc);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Imports" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit all rows" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/Row 2, member_id: Member is no longer active/)).toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith("Revalidation found changes. Review the row errors before committing.");
    expect(onNotice).not.toHaveBeenCalledWith("All rows imported.");
  });

  it("keeps paged directory results across an unrelated re-render with an equal actor", async () => {
    const paged = {
      ...workspace,
      directory: { ...workspace.directory, nextCursor: { name: "Avery Brooks", id: workspace.directory.items[0].userId } },
    };
    const second = { ...workspace.directory.items[0], userId: "88888888-8888-4888-8888-888888888888", fullName: "Jordan Lee", version: 0 };
    const recorder = pagingTimeline(async (name, args) => {
      if (name === "get_member_operations_workspace") return { data: paged, error: null };
      if (name === "get_member_operations_directory") return { data: args.p_after_id ? { items: [second], nextCursor: null } : workspace.directory, error: null };
      if (name === "get_member_operational_profile") return { data: { ...workspace.directory.items[0], profile: { department: "Nursing" } }, error: null };
      return { data: { updated: true }, error: null };
    });
    const client = { rpc: vi.fn(recorder.rpc) };
    const { rerender } = render(
      <MemberOperations actor={{ ...actor }} client={client} session={null} onNotice={recorder.onNotice} />,
    );
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Load next page" }));
    expect(await screen.findByText("Jordan Lee")).toBeInTheDocument();
    const editor = await openEditor(/Avery Brooks/);
    expect(within(editor).getByText("Version 2")).toBeInTheDocument();
    expect(recorder.snapshot().workspaceLoads).toBe(1);

    rerender(
      <MemberOperations
        actor={{ ...actor, organizationRoles: [...actor.organizationRoles] }}
        client={client}
        session={{}}
        onNotice={recorder.onNotice}
      />,
    );
    await Promise.resolve();
    expect(recorder.snapshot().workspaceLoads).toBe(1);
    expect(screen.getByText("Jordan Lee")).toBeInTheDocument();
    // #9966: the list chip reads "Version 2" too, so the check is scoped to
    // the selected-member detail, which the list chip cannot satisfy.
    expect(within(screen.getByText("Selected worker").closest(".member-operations-heading")).getByText("Version 2")).toBeInTheDocument();

    rerender(
      <MemberOperations
        actor={{ ...actor, userId: "99999999-9999-4999-8999-999999999999" }}
        client={client}
        session={null}
        onNotice={recorder.onNotice}
      />,
    );
    await waitFor(() => expect(recorder.snapshot().workspaceLoads).toBe(2));
  });

  it("surfaces unavailable and mutation failures without reporting success", async () => {
    const unavailable = renderOperations({}, workspace, async (name) => name === "get_member_operations_workspace"
      ? { data: null, error: { code: "PGRST202", message: "missing" } }
      : { data: null, error: null });
    expect(await screen.findByText("Worker operations is not connected in this environment.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(unavailable.client.rpc).toHaveBeenCalledTimes(2));
    unavailable.unmount();

    const failed = renderOperations({}, workspace, async (name) => name === "get_member_operations_workspace"
      ? { data: workspace, error: null }
      : { data: null, error: { message: "Write refused" } });
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Welcome" }));
    fireEvent.click(screen.getByRole("button", { name: "Queue due messages" }));
    await waitFor(() => expect(failed.onNotice).toHaveBeenCalledWith("Write refused"));
  });

  it("reports configured and temporarily unavailable delivery status from the authenticated endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ configured: true }),
    }));
    const configured = renderOperations({}, workspace, null, { access_token: "test-access-token" });
    fireEvent.click(await screen.findByRole("button", { name: "Welcome" }));
    expect(await screen.findByText(/Sending email is optional; it is currently configured/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/engagement-delivery?status=1", {
      headers: { Authorization: "Bearer test-access-token" },
    });
    configured.unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderOperations({}, workspace, null, { access_token: "test-access-token" });
    fireEvent.click(await screen.findByRole("button", { name: "Welcome" }));
    expect(await screen.findByText(/Sending email is optional; it is currently not confirmed/i)).toBeInTheDocument();
  });
});

// UX-UG-MEMBER-OPERATIONS-SHOWS-RAW-STATES-AND-ENGINEER-NOTES-20261125
// (#9966, A-21 of #9529): "v2" chips, "Post-provisioning communication",
// "Campaign state remains truthful without a provider.", lowercase states and
// "1 errors". Fictional workspace only.
describe("member operations in plain words (#9966)", () => {
  it.each([
    ["en", { directory: "Worker directory", version: "Version 2", welcome: "Welcome", eyebrow: "Messages to new workers", note: /Without an email service, each campaign still shows what happened to each message/,
      manage: "Manage campaign", active: "Active", stepMeta: /· Position 0 · Active$/, failed: "Failed", imports: "Imports",
      batchLine: "Grievances · 0 valid · 1 error", imported: "Imported", option: "Work location",
      banned: /\bv2\b|Post-provisioning|remains truthful|\b1 errors\b|\bleased\b|\bsuppressed\b/ }],
    ["es", { directory: "Directorio de trabajadores", version: "Versión 2", welcome: "Bienvenida", eyebrow: "Mensajes a nuevos trabajadores", note: /Sin un servicio de correo, cada campaña sigue mostrando lo que pasó con cada mensaje/,
      manage: "Administrar campaña", active: "Activa", stepMeta: /· Posición 0 · Activo$/, failed: "Fallido", imports: "Importaciones",
      batchLine: "Quejas · 0 válidas · 1 error", imported: "Importado", option: "Lugar de trabajo",
      banned: /\bv2\b|aprovisionamiento|sigue siendo veraz|\bsuprimido\b|\b1 errores\b/ }],
  ])("names versions, states, counts and the welcome notes plainly (%s)", async (lang, expected) => {
    const imports = [
      { id: "batch-failed", kind: "grievance", state: "failed", filename: "failed.csv", validCount: 0, errorCount: 1, errors: [] },
      { id: "batch-committed", kind: "member", state: "committed", filename: "committed.csv", validCount: 1, errorCount: 0, errors: [] },
    ];
    const client = { rpc: vi.fn(async (name) => ({ data: name === "get_member_operations_workspace" ? { ...workspace, imports } : { updated: true }, error: null })) };
    const { container } = render(<LanguageProvider lang={lang}><MemberOperations actor={actor} client={client} onNotice={vi.fn()} /></LanguageProvider>);
    await screen.findByRole("heading", { name: expected.directory });
    // The list chip itself (a status pill), not the selected-member detail.
    expect([...container.querySelectorAll(".member-operations-status")].map((node) => node.textContent)).toContain(expected.version);
    expect(container.textContent).not.toMatch(expected.banned);

    fireEvent.click(screen.getByRole("button", { name: expected.welcome }));
    expect(screen.getByText(expected.eyebrow)).toBeInTheDocument();
    expect(screen.getByText(expected.note)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: expected.manage }));
    expect(screen.getAllByText(expected.active).length).toBeGreaterThan(0);
    expect(screen.getByText(expected.stepMeta)).toBeInTheDocument();
    expect(screen.getAllByText(expected.failed).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(expected.banned);

    fireEvent.click(screen.getByRole("button", { name: expected.imports }));
    expect(screen.getByText(expected.batchLine)).toBeInTheDocument();
    expect(screen.getByText(expected.imported)).toBeInTheDocument();
    const input = container.querySelector('input[type="file"]');
    const file = new File(["email,department\navery@example.test,Nursing"], "members.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("email,department\navery@example.test,Nursing") });
    fireEvent.change(input, { target: { files: [file] } });
    const mapping = await screen.findByLabelText("department");
    expect(Array.from(mapping.options, (option) => option.textContent)).toContain(expected.option);
    expect(container.textContent).not.toMatch(expected.banned);
    // Every status pill starts with a capital letter, never a raw key.
    const pills = [...container.querySelectorAll(".member-operations-status")].map((node) => node.textContent);
    expect(pills.length).toBeGreaterThan(0);
    expect(pills.filter((text) => !/^\p{Lu}/u.test(text))).toEqual([]);
  });
});

describe("member operations destructive confirm gates", () => {
  const discardBatch = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind: "member",
    state: "validated",
    filename: "members.csv",
    validCount: 1,
    errorCount: 0,
    errors: [],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openWelcome(snapshot = workspace) {
    const rendered = renderOperations({}, snapshot);
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Welcome" }));
    return rendered;
  }

  async function openImports() {
    const rendered = renderOperations({}, { ...workspace, imports: [discardBatch] });
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Imports" }));
    return rendered;
  }

  it("does not archive a campaign when confirm is declined", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { client } = await openWelcome();
    fireEvent.click(screen.getByRole("button", { name: "Archive campaign" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(rpcCalls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign)).toHaveLength(0);
  });

  it("does not cancel an enrollment when confirm is declined", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { client } = await openWelcome();
    fireEvent.click(screen.getByRole("button", { name: "Manage campaign" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(rpcCalls(client, MEMBER_OPERATIONS_RPCS.transitionWelcome)).toHaveLength(0);
  });

  it("does not discard an import when confirm is declined", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const { client } = await openImports();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(rpcCalls(client, MEMBER_OPERATIONS_RPCS.discardImport)).toHaveLength(0);
  });

  it("archives a campaign after confirm is accepted with the expected message", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const { client } = await openWelcome();
    fireEvent.click(screen.getByRole("button", { name: "Archive campaign" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(`Archive ${workspace.campaigns[0].name}? Existing delivery history remains available.`);
    await waitFor(() => {
      expect(rpcCalls(client, MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign)).toHaveLength(1);
    });
    expect(client.rpc).toHaveBeenCalledWith(MEMBER_OPERATIONS_RPCS.saveWelcomeCampaign, expect.objectContaining({
      p_campaign_id: workspace.campaigns[0].id,
      p_name: workspace.campaigns[0].name,
      p_state: "archived",
      p_idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
  });

  it("cancels an enrollment after confirm is accepted with the expected message", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const { client } = await openWelcome();
    fireEvent.click(screen.getByRole("button", { name: "Manage campaign" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(`Cancel the welcome enrollment for ${workspace.campaigns[0].enrollments[0].memberName}?`);
    await waitFor(() => {
      expect(rpcCalls(client, MEMBER_OPERATIONS_RPCS.transitionWelcome)).toHaveLength(1);
    });
    expect(client.rpc).toHaveBeenCalledWith(MEMBER_OPERATIONS_RPCS.transitionWelcome, expect.objectContaining({
      p_enrollment_id: workspace.campaigns[0].enrollments[0].id,
      p_state: "cancelled",
      p_idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
  });

  it("discards an import after confirm is accepted with the expected message", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const { client } = await openImports();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("Discard members.csv? The staged rows will be removed.");
    await waitFor(() => {
      expect(rpcCalls(client, MEMBER_OPERATIONS_RPCS.discardImport)).toHaveLength(1);
    });
    expect(client.rpc).toHaveBeenCalledWith(MEMBER_OPERATIONS_RPCS.discardImport, expect.objectContaining({
      p_batch_id: discardBatch.id,
      p_idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
  });
});

describe("member operations controls keep focus while their writes run (#8435)", () => {
  const queueCalls = (client) => client.rpc.mock.calls.filter(([name]) => name === "queue_due_welcome_messages");

  it("keeps Queue due messages focused while the queue is written", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const { client } = renderOperations();
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Welcome" }));
    await expectHeldWriteFocus(client.rpc, screen.getByRole("button", { name: "Queue due messages" }));
    await waitFor(() => expect(queueCalls(client)).toHaveLength(1));
    vi.unstubAllGlobals();
  });

  it("queues once when two activations land before the first one commits", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const { client } = renderOperations();
    await screen.findByRole("heading", { name: "Worker directory" });
    fireEvent.click(screen.getByRole("button", { name: "Welcome" }));
    const queue = screen.getByRole("button", { name: "Queue due messages" });
    // Both clicks arrive in one React batch, before `busy` commits, so only
    // commit()'s own lock can refuse the second.
    act(() => {
      queue.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      queue.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(queueCalls(client)).toHaveLength(1));
    await waitFor(() => expect(queue).not.toHaveAttribute("aria-disabled"));
    expect(queueCalls(client)).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
