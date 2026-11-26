// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030 (#6573).
//
// The October 29-30, 2026 role-play run (findings 49, 82 and 94): no
// nominations with a seconder or an export for the election committee; minutes
// without a location or an approved status, with attendance typed by hand; a
// "Suggest a poll" that reached no reviewer; and staff who could not find the
// secret-ballot tools from Voting.
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BallotNominations } from "../src/features/elections/BallotNominations.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { nominationsCsv, nominateForBallot, secondedNominees } from "../src/features/elections/nominationsApi.js";
import { InstitutionalRecordsPanel } from "../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { memberResourcesForRoute } from "../src/lib/memberSessionLoader.js";
import { t } from "../src/lib/i18n.js";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { VotingView } from "../src/views/VotingView.jsx";
import { setDisclosureOpen } from "./helpers/disclosure.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

// The committee's nominations buttons stay disabled while a read is running,
// and a click on a disabled button does nothing (#6875). Panels open through
// setDisclosureOpen, which waits for jsdom's one toggle event instead of firing
// a second one that started a second read (#8628).
async function clickWhenEnabled(button) {
  // A pending control stays enabled (record 8435): wait for its busy state to clear.
  await waitFor(() => { const control = button; expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
  fireEvent.click(button);
}

function rpcClient(handlers) {
  return {
    rpc: vi.fn(async (name, args) => {
      const handler = handlers[name];
      if (!handler) return { data: null, error: { code: "PGRST202", message: `no ${name}` } };
      try { return { data: await handler(args), error: null }; }
      catch (error) { return { data: null, error: { code: error.code || "P0001", message: error.message } }; }
    }),
  };
}

const openBallot = () => ({
  ballotId: "ballot-officers", title: "Officer election", titleEs: "Elección de directiva",
  nominationsCloseAt: "2099-12-01T23:00:00.000Z",
  nominations: [
    { id: "n-1", nomineeName: "Lorraine Whitaker", statement: "Chair of the committee", seconded: true, mine: false },
    { id: "n-2", nomineeName: "Devon Achterberg", statement: null, seconded: false, mine: true },
    { id: "n-3", nomineeName: "Bea Okonkwo", statement: null, seconded: false, mine: false },
  ],
});

describe("nominations: members", () => {
  it("lists nominees without nominators, seconds someone else's, and nominates", async () => {
    const client = rpcClient({
      get_open_ballot_nominations: () => [openBallot()],
      second_ballot_nomination: () => ({ id: "n-3", seconded: true }),
      nominate_for_ballot: () => ({ id: "n-4" }),
    });
    wrap(<BallotNominations client={client} />);
    const card = await screen.findByRole("region", { name: "Nominations" });
    expect(within(card).getByText("Officer election")).toBeInTheDocument();
    expect(within(card).getByText("Seconded")).toBeInTheDocument();
    expect(within(card).getByText("Waiting for a second")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Second the nomination of Devon Achterberg" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Second the nomination of Bea Okonkwo" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("second_ballot_nomination", { p_nomination_id: "n-3" }));
    expect(await screen.findByText("Nomination seconded.")).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Person you nominate"), { target: { value: "  Margo Ellison " } });
    fireEvent.change(within(card).getByLabelText("Why (optional)"), { target: { value: "Chief steward" } });
    fireEvent.click(within(card).getByRole("button", { name: "Nominate" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("nominate_for_ballot", { p_ballot_id: "ballot-officers", p_nominee_name: "Margo Ellison", p_statement: "Chief steward" }));
    expect(await screen.findByText("Nomination sent.")).toBeInTheDocument();
  });

  // The second was saved, so its notice stays when
  // the reload after it fails, beside the reload failure and its Retry.
  it("keeps the saved notice when the reload after a second fails", async () => {
    let reads = 0;
    const client = rpcClient({
      get_open_ballot_nominations: () => { reads += 1; if (reads > 1) throw new Error("offline"); return [openBallot()]; },
      second_ballot_nomination: () => ({ id: "n-3", seconded: true }),
    });
    wrap(<BallotNominations client={client} />);
    const card = await screen.findByRole("region", { name: "Nominations" });
    fireEvent.click(within(card).getByRole("button", { name: "Second the nomination of Bea Okonkwo" }));
    const region = await screen.findByRole("region", { name: "Nominations" });
    expect(await within(region).findByRole("alert")).toHaveTextContent(t("en", "nominations.loadFailed"));
    expect(within(region).getByText("Nomination seconded.")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: t("en", "nominations.retry") })).toBeInTheDocument();
  });

  it("shows the limit reason, and renders nothing when no ballot takes nominations", async () => {
    const limited = rpcClient({
      get_open_ballot_nominations: () => [openBallot()],
      nominate_for_ballot: () => { throw Object.assign(new Error("nomination limit reached"), { code: "54000" }); },
    });
    wrap(<BallotNominations client={limited} />);
    const card = await screen.findByRole("region", { name: "Nominations" });
    fireEvent.change(within(card).getByLabelText("Person you nominate"), { target: { value: "Margo Ellison" } });
    fireEvent.click(within(card).getByRole("button", { name: "Nominate" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("You have made the most nominations allowed for this ballot: 10.");
    cleanup();
    const empty = rpcClient({ get_open_ballot_nominations: () => [] });
    const view = wrap(<BallotNominations client={empty} />);
    await waitFor(() => expect(empty.rpc).toHaveBeenCalled());
    expect(view.container.querySelector(".voting-nominations")).toBeNull();
  });

  it("sends a trimmed name and no empty statement", async () => {
    const client = rpcClient({ nominate_for_ballot: () => ({ id: "n" }) });
    await nominateForBallot(client, "b", "  Ann Lee ", "   ");
    expect(client.rpc).toHaveBeenCalledWith("nominate_for_ballot", { p_ballot_id: "b", p_nominee_name: "Ann Lee", p_statement: null });
  });
});

describe("nominations: the election committee", () => {
  const exported = {
    ballotId: "ballot-officers", title: "Officer election", nominationsCloseAt: "2099-12-01T23:00:00.000Z",
    nominations: [
      { id: "n-1", nomineeName: "Lorraine Whitaker", statement: "=HYPERLINK(\"x\")", nominatedBy: "Margo Ellison", nominatedAt: "2026-11-02T14:00:00Z", secondedBy: "Bea Okonkwo", secondedAt: "2026-11-03T14:00:00Z" },
      { id: "n-2", nomineeName: "Devon Achterberg", statement: null, nominatedBy: null, nominatedAt: "2026-11-02T15:00:00Z", secondedBy: null, secondedAt: null },
      { id: "n-3", nomineeName: "Bea Okonkwo", statement: null, nominatedBy: "Devon Achterberg", nominatedAt: "2026-11-02T16:00:00Z", secondedBy: "Margo Ellison", secondedAt: "2026-11-04T14:00:00Z" },
      { id: "n-4", nomineeName: "lorraine whitaker", statement: null, nominatedBy: "Ann Lee", nominatedAt: "2026-11-05T16:00:00Z", secondedBy: "Ann Lee 2", secondedAt: "2026-11-05T17:00:00Z" },
    ],
  };

  it("exports CSV with formula text neutralized and offers each seconded nominee once", () => {
    const csv = nominationsCsv(exported, ["Nominee", "Statement", "Nominated by", "Nominated at", "Seconded by", "Seconded at"]);
    expect(csv.split("\r\n")[0]).toBe('"Nominee","Statement","Nominated by","Nominated at","Seconded by","Seconded at"');
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(secondedNominees(exported)).toEqual(["Lorraine Whitaker", "Bea Okonkwo"]);
  });


  it("downloads the CSV, stops taking nominations, and reports failures", async () => {
    const draft = {
      id: "ballot-officers", kind: "ballot", scope: "chapter", titleEn: "Officer election", titleEs: "Elección",
      bodyEn: "", bodyEs: "", closesAt: "2099-12-10T16:00:00.000Z", quorumTarget: 10, state: "draft", active: false, options: [],
    };
    const createObjectURL = vi.fn(() => "blob:nominations");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let failPeriod = false;
    const nominationsClient = rpcClient({
      get_ballot_nominations: () => exported, export_ballot_nominations: () => exported,
      set_ballot_nominations_period: () => { if (failPeriod) throw new Error("refused"); return { id: "ballot-officers" }; },
    });
    wrap(<CampaignsView api={{ load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), nominationsClient }} />);
    const details = (await screen.findByText("Nominations")).closest("details");
    await setDisclosureOpen(details, true);
    const exportButton = await screen.findByRole("button", { name: "Download nominations (CSV)" });
    expect(nominationsClient.rpc.mock.calls.filter(([name]) => name === "export_ballot_nominations")).toHaveLength(0);
    await clickWhenEnabled(exportButton);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(click).toHaveBeenCalled();
    expect(nominationsClient.rpc.mock.calls.filter(([name]) => name === "export_ballot_nominations")).toHaveLength(1);
    expect(await screen.findByText(/Taking nominations until/)).toBeInTheDocument();
    await clickWhenEnabled(screen.getByRole("button", { name: "Stop taking nominations" }));
    await waitFor(() => expect(nominationsClient.rpc).toHaveBeenCalledWith("set_ballot_nominations_period", { p_ballot_id: "ballot-officers", p_close_at: null }));
    expect(await screen.findByText("This ballot no longer takes nominations.")).toBeInTheDocument();
    failPeriod = true;
    fireEvent.change(screen.getByLabelText("Nominations close"), { target: { value: "2099-12-02T18:00" } });
    await clickWhenEnabled(screen.getByRole("button", { name: "Save nominations period" }));
    expect(await screen.findByText("The nominations period could not be saved.")).toBeInTheDocument();
  });

  it("says when nominations cannot be loaded, and when a ballot takes none", async () => {
    const draft = { id: "ballot-x", kind: "ballot", scope: "chapter", titleEn: "Vote X", titleEs: "Voto X", bodyEn: "", bodyEs: "", closesAt: "2099-12-10T16:00:00.000Z", quorumTarget: 10, state: "draft", active: false, options: [] };
    const failing = rpcClient({ get_ballot_nominations: () => { throw new Error("refused"); } });
    wrap(<CampaignsView api={{ load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), nominationsClient: failing }} />);
    let details = (await screen.findByText("Nominations")).closest("details");
    await setDisclosureOpen(details, true);
    expect(await screen.findByText("Nominations could not be loaded.")).toBeInTheDocument();
    cleanup();
    const none = rpcClient({ get_ballot_nominations: () => ({ ballotId: "ballot-x", nominationsCloseAt: null, nominations: [] }) });
    wrap(<CampaignsView api={{ load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), nominationsClient: none }} />);
    details = (await screen.findByText("Nominations")).closest("details");
    await setDisclosureOpen(details, true);
    expect(await screen.findByText("This ballot is not taking nominations.")).toBeInTheDocument();
    expect(screen.getByText("No nominations yet.")).toBeInTheDocument();
  });

  it("r1s6: reads nominations again on reopen and before export or hand-off", async () => {
    const draft = { id: "ballot-officers", kind: "ballot", scope: "chapter", titleEn: "Officer election", titleEs: "Elección", bodyEn: "", bodyEs: "", closesAt: "2099-12-10T16:00:00.000Z", quorumTarget: 10, state: "draft", active: false, options: [] };
    const nominee = (id, name) => ({ id, nomineeName: name, statement: null, nominatedBy: "Bea Okonkwo", nominatedAt: "2026-11-06T10:00:00Z", secondedBy: "Margo Ellison", secondedAt: "2026-11-06T11:00:00Z" });
    let current = exported;
    const nominationsClient = rpcClient({ get_ballot_nominations: () => current, export_ballot_nominations: () => current });
    const blobs = [];
    Object.assign(URL, { createObjectURL: vi.fn((blob) => { blobs.push(blob); return "blob:x"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    wrap(<CampaignsView api={{ load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), nominationsClient, saveDraft: vi.fn() }} />);
    const details = (await screen.findByText("Nominations")).closest("details");
    await setDisclosureOpen(details, true);
    await screen.findByText(/nominated by Margo Ellison/);
    // A nomination made while the panel was closed shows on reopen.
    current = { ...exported, nominations: [...exported.nominations, nominee("n-5", "Ann Lee")] };
    await setDisclosureOpen(details, false);
    await setDisclosureOpen(details, true);
    expect(await screen.findByText("Ann Lee")).toBeInTheDocument();
    // One seconded while the panel stayed open reaches the CSV and the choices.
    current = { ...current, nominations: [...current.nominations, nominee("n-6", "Kim Park")] };
    const download = screen.getByRole("button", { name: "Download nominations (CSV)" });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = download; expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(download);
    await waitFor(() => expect(blobs).toHaveLength(1));
    expect(await blobs[0].text()).toContain("Kim Park");
    const use = screen.getByRole("button", { name: /Use the seconded nominees as choices/ });
    // A pending control stays enabled (record 8435): wait for its busy state to clear.
    await waitFor(() => { const control = use; expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(use);
    expect(await screen.findByLabelText("Option 4 in English")).toHaveValue("Kim Park");
  });

  it("r2s3: never hands off more seconded nominees than a ballot can hold", async () => {
    const draft = {
      id: "ballot-officers", kind: "ballot", scope: "chapter", chapterId: "wor", titleEn: "Officer election", titleEs: "Elección",
      bodyEn: "", bodyEs: "", closesAt: "2099-12-10T16:00:00.000Z", quorumTarget: 10, state: "draft", active: false,
      options: [{ id: "a", labelEn: "A", labelEs: "A" }, { id: "b", labelEn: "B", labelEs: "B" }],
    };
    const many = { ...exported, nominations: Array.from({ length: 21 }, (_, index) => ({
      id: `n-${index}`, nomineeName: `Nominee ${index + 1}`, statement: null, nominatedBy: "Margo Ellison",
      nominatedAt: "2026-11-02T14:00:00Z", secondedBy: "Bea Okonkwo", secondedAt: "2026-11-03T14:00:00Z",
    })) };
    const nominationsClient = rpcClient({ get_ballot_nominations: () => many, export_ballot_nominations: () => many });
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), nominationsClient, saveDraft: vi.fn() };
    wrap(<CampaignsView api={api} />);
    await setDisclosureOpen((await screen.findByText("Nominations")).closest("details"), true);
    expect(await screen.findByText(/A ballot holds at most 20 choices and 21 nominees are seconded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use the seconded nominees as choices (21)" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByLabelText("Option 21 in English")).toBeNull();
  });

  it("offers no nominations panel on a published ballot", async () => {
    const open = { id: "ballot-open", kind: "ballot", scope: "chapter", titleEn: "Open vote", titleEs: "Voto", bodyEn: "", bodyEs: "", closesAt: "2099-12-10T16:00:00.000Z", quorumTarget: 10, state: "open", active: true, options: [] };
    wrap(<CampaignsView api={{ load: vi.fn().mockResolvedValue({ campaigns: [open], canManageUnion: false, chapterId: "wor" }), nominationsClient: rpcClient({}) }} />);
    await screen.findByText("Open vote");
    expect(screen.queryByText("Nominations")).toBeNull();
  });
});

describe("Voting: the way to secret ballots, and poll suggestions to stewards", () => {
  const data = { planItems: [], member: { id: "m" } };

  it("r2s1: a cold Voting load reads the member's conversations, so a suggestion finds the existing direct one", () => {
    expect(memberResourcesForRoute("voting")).toContain("table:member_conversations");
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain('const direct = (data.conversations || []).find((item) => item.counterpartRole === "steward" && !item.stewardUserId);');
    expect(app).toContain("return direct ? handleSendMemberMessage(direct.id, text) : handleStartMemberConversation(text);");
  });

  it("shows staff where ballots are run, and members the nominations card", async () => {
    const onOpenCampaigns = vi.fn();
    const nominationsClient = rpcClient({ get_open_ballot_nominations: () => [openBallot()] });
    wrap(<VotingView data={data} onPlanAction={() => {}} onOpenCampaigns={onOpenCampaigns} nominationsClient={nominationsClient} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Campaigns" }));
    expect(onOpenCampaigns).toHaveBeenCalled();
    expect(await screen.findByRole("region", { name: "Nominations" })).toBeInTheDocument();
    cleanup();
    wrap(<VotingView data={data} onPlanAction={() => {}} />);
    expect(screen.queryByRole("button", { name: "Open Campaigns" })).toBeNull();
  });

  it("r1s1/r1s3: offers the switch to a staff hat from Member, and renders the cards in the alternate shell", async () => {
    const onSwitch = vi.fn();
    wrap(<VotingView data={data} onPlanAction={() => {}} campaignsSwitch={{ label: "Steward", onSwitch }} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to Steward to open Campaigns" }));
    expect(onSwitch).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open Campaigns" })).toBeNull();
    cleanup();
    const nominationsClient = rpcClient({ get_open_ballot_nominations: () => [openBallot()] });
    wrap(<VotingView alt data={data} onPlanAction={() => {}} onOpenCampaigns={() => {}} nominationsClient={nominationsClient} />);
    expect(await screen.findByRole("region", { name: "Nominations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Campaigns" })).toBeInTheDocument();
  });

  it("tells the member the suggestion went to the stewards", () => {
    expect(t("en", "voting.pollSent")).toMatch(/committee members as a message/);
    expect(t("es", "voting.pollSent")).toMatch(/miembros del comité/);
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain("onSuggestPoll={(text, scope) => handlePollSuggestion(");
    expect(app).toContain('onOpenCampaigns={campaignsAllowed ? () => navigateStaff("campaigns", "/m/campaigns") : null}');
    expect(app).toContain("onSwitch: () => switchHat(campaignsHat.key)");
    expect(app).toContain('explicitHatAllowsView(selectedStaffHat, "campaigns", fixtureDemo, data?.roles || [], !railShell, "/m/campaigns")');
  });
});

function minutesWorkspace(record) {
  return {
    canManage: true, canExport: false, contacts: [], exportRuns: [],
    roster: [{ userId: "u-paula", name: "Paula Reyes" }, { userId: "u-tamsin", name: "Tamsin Hart" }, { userId: "u-marcus", name: "Marcus Lee" }],
    records: [record],
  };
}

function recordsClient(record, extra = {}) {
  return rpcClient({
    get_institutional_records_workspace: () => minutesWorkspace(record),
    get_minutes_pre_event_notices: () => ({ enabled: false, notices: [] }),
    get_admin_events: () => [],
    ...extra,
  });
}

const minutes = (overrides = {}) => ({
  id: "minutes-1", record_type: "minutes", lifecycle_status: "published", version: 2,
  title: "October 21 minutes", body: "Motions and decisions.", occurred_at: "2026-10-21T12:00:00Z",
  event_id: "event-8am", location: null, approved_at: null, approved_by: null, approved_version: null, attendance: [],
  ...overrides,
});

describe("minutes: location, approval and attendance from check-ins", () => {
  it("marks published minutes approved and shows who approved which version", async () => {
    const approve = vi.fn(() => ({ id: "minutes-1" }));
    wrap(<InstitutionalRecordsPanel client={recordsClient(minutes({ location: "Union hall" }), { set_chapter_minutes_approval: approve })} canStaff />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark approved" }));
    // r1s4: the version shown is sent, and the location is never written.
    await waitFor(() => expect(approve).toHaveBeenCalledWith({ p_record_id: "minutes-1", p_expected_version: 2, p_approved: true }));
    cleanup();
    wrap(<InstitutionalRecordsPanel client={recordsClient(minutes({ location: "Union hall", approved_at: "2026-11-12T23:00:00Z", approved_by: "u-paula", approved_version: 2 }))} canStaff />);
    expect(await screen.findByText(/Approved .* by Paula Reyes/)).toBeInTheDocument();
    expect(screen.getByText("At Union hall")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove approval" })).toBeInTheDocument();
    cleanup();
    wrap(<InstitutionalRecordsPanel client={recordsClient(minutes({ approved_at: "2026-11-12T23:00:00Z", approved_by: "u-paula", approved_version: 1 }))} canStaff />);
    expect(await screen.findByText("Version 1 was approved; this version is not approved yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark approved" })).toBeInTheDocument();
  });


  it("r2s2: a refused save writes no location and nothing else is called", async () => {
    const stale = Object.assign(new Error("Record changed"), { code: "PT409" });
    const combined = vi.fn(() => { throw stale; });
    const save = vi.fn(() => ({ id: "minutes-1", version: 3 }));
    const client = recordsClient(minutes(), { save_institutional_record: save, save_chapter_minutes: combined });
    wrap(<InstitutionalRecordsPanel client={client} canStaff />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Room A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(combined).toHaveBeenCalledTimes(1));
    expect(save).not.toHaveBeenCalled();
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("set_chapter_minutes_location");
  });

  it("saves minutes whose location did not change through the ordinary record save", async () => {
    const save = vi.fn(() => ({ id: "minutes-1", version: 3 }));
    const combined = vi.fn(() => ({ id: "minutes-1", version: 3 }));
    wrap(<InstitutionalRecordsPanel client={recordsClient(minutes(), { save_institutional_record: save, save_chapter_minutes: combined })} canStaff />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(combined).not.toHaveBeenCalled();
  });

  it("creates a new record with its location in the same call", async () => {
    const save = vi.fn(() => ({ id: "minutes-new", version: 1 }));
    const location = vi.fn(() => ({ id: "minutes-new", version: 1, location: "Union hall" }));
    const client = recordsClient(minutes(), { save_institutional_record: save, save_chapter_minutes: location });
    wrap(<InstitutionalRecordsPanel client={client} canStaff />);
    fireEvent.click(await screen.findByRole("button", { name: "New minutes" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "November minutes" } });
    fireEvent.change(screen.getByLabelText("Record"), { target: { value: "Motions." } });
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: "2026-11-04T18:00" } });
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Union hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(location).toHaveBeenCalledWith(expect.objectContaining({ p_record_id: null, p_title: "November minutes", p_location: "Union hall" })));
    expect(save).not.toHaveBeenCalled();
  });

  it("r1s4: refuses to approve a version the approver was not shown, and reloads", async () => {
    const stale = Object.assign(new Error("minutes changed since they were opened"), { code: "PT409" });
    const client = recordsClient(minutes(), { set_chapter_minutes_approval: () => { throw stale; } });
    const onNotice = vi.fn();
    wrap(<InstitutionalRecordsPanel client={client} canStaff onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark approved" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(t("en", "records.approvalStaleRefused"), true));
    await waitFor(() => expect(client.rpc.mock.calls.filter(([name]) => name === "get_institutional_records_workspace").length).toBeGreaterThan(1));
  });

  it("r1s5: archiving minutes never writes the location afterwards", async () => {
    const save = vi.fn(() => ({ id: "minutes-1", version: 3, lifecycle_status: "archived" }));
    const location = vi.fn(() => ({ id: "minutes-1" }));
    wrap(<InstitutionalRecordsPanel client={recordsClient(minutes(), { save_institutional_record: save, save_chapter_minutes: location })} canStaff />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Union hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ p_action: "archive" })));
    expect(location).not.toHaveBeenCalled();
  });
});

describe("the migration", () => {
  const sql = readFileSync("supabase/migrations/20261030214501_ballot_nominations_and_minutes_approval.sql", "utf8");

  it("keeps who nominated and seconded away from members, and votes untouched", () => {
    const members = sql.slice(sql.indexOf("create function public.get_open_ballot_nominations"), sql.indexOf("create function public.nominate_for_ballot"));
    expect(members).not.toMatch(/full_name|nominatedBy|secondedBy/);
    expect(sql).not.toMatch(/member_ballot_votes|ballot_tally|submit_ballot_vote/);
    expect(sql).toContain("a nominator cannot second their own nomination");
    expect(sql).toContain("private.can_manage_vote_campaign(b.organization_id, b.chapter_id)");
    expect(sql).toContain("private.can_read_vote_campaign(b.organization_id, b.chapter_id)");
  });

  it("approves a version, not a record, and gates every function", () => {
    expect(sql).toContain("approved_version = case");
    expect(sql).toContain("only published minutes can be approved");
    expect(sql).toContain("p_expected_version is distinct from target.version");
    // r1s7: a type change keeps the approval metadata valid.
    const shape = sql.slice(sql.indexOf("chapter_records_approval_shape"), sql.indexOf("comment on column public.chapter_records.location"));
    expect(shape).not.toContain("record_type");
    const location = sql.slice(sql.indexOf("create function public.save_chapter_minutes"), sql.indexOf("create function public.set_chapter_minutes_approval"));
    expect(location).not.toMatch(/approved_(at|by|version)/);
    // r2s2: the location is written only after save_institutional_record (and
    // its expected-version check) succeeds, in the same function call.
    expect(location.indexOf("saved := public.save_institutional_record(")).toBeGreaterThan(0);
    expect(location.indexOf("set location = clean")).toBeGreaterThan(location.indexOf("saved := public.save_institutional_record("));
    expect(sql).not.toContain("set_chapter_minutes_location");
    // r3s1: both branches of the returned location are text (a jsonb branch
    // raises 42804 on the first save).
    expect(location).toContain("then clean else saved ->> 'location' end");
    expect(sql).toContain("lock_case_graph_row_keys('{approved_by},{created_by}', '{case_id}')");
    for (const fn of [
      "save_chapter_minutes(uuid, text, text, timestamptz, text, text, text, boolean, text, integer, jsonb)", "set_chapter_minutes_approval(uuid, integer, boolean)", "get_minutes_meeting_checkins(uuid)",
      "set_ballot_nominations_period(text, timestamptz)", "get_open_ballot_nominations()",
      "nominate_for_ballot(text, text, text)", "second_ballot_nomination(uuid)", "export_ballot_nominations(text)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant execute on function public.${fn} to authenticated;`);
    }
    expect(sql).toContain("revoke all on table public.ballot_nominations from public, anon, authenticated, service_role;");
  });
});

// Nomination writes keep focus while they run, and a second
// activation in the same tick sends nothing more.
describe("nomination writes while one runs", () => {
  // The committee's nominations read, as in the committee tests above.
  const exported = {
    ballotId: "ballot-officers", title: "Officer election", nominationsCloseAt: "2099-12-01T23:00:00.000Z",
    nominations: [
      { id: "n-1", nomineeName: "Lorraine Whitaker", statement: "=HYPERLINK(\"x\")", nominatedBy: "Margo Ellison", nominatedAt: "2026-11-02T14:00:00Z", secondedBy: "Bea Okonkwo", secondedAt: "2026-11-03T14:00:00Z" },
      { id: "n-2", nomineeName: "Devon Achterberg", statement: null, nominatedBy: null, nominatedAt: "2026-11-02T15:00:00Z", secondedBy: null, secondedAt: null },
      { id: "n-3", nomineeName: "Bea Okonkwo", statement: null, nominatedBy: "Devon Achterberg", nominatedAt: "2026-11-02T16:00:00Z", secondedBy: "Margo Ellison", secondedAt: "2026-11-04T14:00:00Z" },
      { id: "n-4", nomineeName: "lorraine whitaker", statement: null, nominatedBy: "Ann Lee", nominatedAt: "2026-11-05T16:00:00Z", secondedBy: "Ann Lee 2", secondedAt: "2026-11-05T17:00:00Z" },
    ],
  };
  const memberClient = () => rpcClient({
    get_open_ballot_nominations: () => [openBallot()],
    second_ballot_nomination: () => ({ id: "n-3", seconded: true }),
    nominate_for_ballot: () => ({ id: "n-4" }),
  });
  const secondButton = async () => within(await screen.findByRole("region", { name: "Nominations" })).getByRole("button", { name: "Second the nomination of Bea Okonkwo" });
  const nominateButton = async () => {
    const card = await screen.findByRole("region", { name: "Nominations" });
    fireEvent.change(within(card).getByLabelText("Person you nominate"), { target: { value: "Margo Ellison" } });
    return within(card).getByRole("button", { name: "Nominate" });
  };

  it("keeps Second focused while the second is saved, and seconds once", async () => {
    const client = memberClient();
    wrap(<BallotNominations client={client} />);
    await expectHeldWriteFocus(client.rpc, await secondButton());
    expect(client.rpc.mock.calls.filter(([name]) => name === "second_ballot_nomination")).toHaveLength(1);
  });

  it("seconds once when Second is activated twice in one tick", async () => {
    const client = memberClient();
    wrap(<BallotNominations client={client} />);
    const second = await secondButton();
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(second), () => fireEvent.click(second)]);
  });

  it("keeps Nominate focused while the nomination is sent, and nominates once", async () => {
    const client = memberClient();
    wrap(<BallotNominations client={client} />);
    await expectHeldWriteFocus(client.rpc, await nominateButton());
    expect(client.rpc.mock.calls.filter(([name]) => name === "nominate_for_ballot")).toHaveLength(1);
  });

  it("nominates once when Nominate is activated twice in one tick", async () => {
    const client = memberClient();
    wrap(<BallotNominations client={client} />);
    const nominate = await nominateButton();
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(nominate), () => fireEvent.click(nominate)]);
  });

  const openPeriod = async () => {
    const draft = {
      id: "ballot-officers", kind: "ballot", scope: "chapter", chapterId: "wor", titleEn: "Officer election", titleEs: "Elección",
      bodyEn: "", bodyEs: "", closesAt: "2099-12-10T16:00:00.000Z", quorumTarget: 10, state: "draft", active: false,
      options: [{ id: "a", labelEn: "A", labelEs: "A" }, { id: "b", labelEn: "B", labelEs: "B" }],
    };
    const nominationsClient = rpcClient({ get_ballot_nominations: () => exported, export_ballot_nominations: () => exported, set_ballot_nominations_period: () => ({ id: "ballot-officers" }) });
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), nominationsClient, saveDraft: vi.fn() };
    wrap(<CampaignsView api={api} />);
    await setDisclosureOpen((await screen.findByText("Nominations")).closest("details"), true);
    await screen.findByText(/nominated by Margo Ellison/);
    fireEvent.change(screen.getByLabelText("Nominations close"), { target: { value: "2099-12-02T18:00" } });
    const save = screen.getByRole("button", { name: "Save nominations period" });
    await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
    return { nominationsClient, save };
  };

  it("keeps Save nominations period focused while it saves, and saves once", async () => {
    const { nominationsClient, save } = await openPeriod();
    await expectHeldWriteFocus(nominationsClient.rpc, save);
    expect(nominationsClient.rpc.mock.calls.filter(([name]) => name === "set_ballot_nominations_period")).toHaveLength(1);
  });

  it("hands the seconded nominees over once when Use is activated twice in one tick", async () => {
    const { nominationsClient } = await openPeriod();
    const use = await screen.findByRole("button", { name: "Use the seconded nominees as choices (2)" });
    await waitFor(() => expect(use).not.toHaveAttribute("aria-disabled"));
    await expectOneWriteFromOneTick(nominationsClient.rpc, [() => fireEvent.click(use), () => fireEvent.click(use)]);
    expect(await screen.findByLabelText("Option 1 in English")).toHaveValue("Lorraine Whitaker");
  });

  it("saves the nominations period once when Save is activated twice in one tick", async () => {
    const { nominationsClient, save } = await openPeriod();
    await expectOneWriteFromOneTick(nominationsClient.rpc, [() => fireEvent.click(save), () => fireEvent.click(save)]);
  });
});

