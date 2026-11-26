// REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001 and
// REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001: the web halves. The member's
// claim card renders only what get_chapter_leadership_recovery returns, the
// admin panel reviews and rejects claims, and the staff registry drafts
// officer removal ballots and records their result.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterLeadershipRecoveryCard } from "../src/features/governance/ChapterLeadershipRecoveryCard.jsx";
import { LeadershipClaimsPanel } from "../src/features/governance/LeadershipClaimsPanel.jsx";
import { OfficerRemovalEditor, OfficerRemovalSummary, defaultRemovalTitles, emptyRemovalDraft, removalDraftFromCampaign } from "../src/features/governance/OfficerRemovalEditor.jsx";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import {
  claimChapterLeadership, leadershipFailureReason, listChapterLeadershipClaims, listOfficerRemovalTargets,
  loadChapterLeadershipRecovery, loadOfficerRemovalDetails, recordOfficerRemovalOutcome, rejectChapterLeadershipClaim,
  saveOfficerRemovalDraft, withdrawChapterLeadershipClaim,
} from "../src/lib/governanceApi.js";
import { useState } from "react";

afterEach(cleanup);

function wrap(ui, lang = "en") {
  return render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
}

const ELIGIBLE = {
  available: true, eligible: true, reason: "eligible", chapterId: "north", chapterName: "North Chapter",
  inactiveLeaderCount: 2, inactivityMonths: 6, coolingOffHours: 72, mfaAssured: true, claim: null,
};

describe("governance copy", () => {
  it("declares every governance key in English and Spanish", () => {
    const keys = Object.keys(catalogue.en).filter((key) => /^(leadership|leadershipClaims|officerRemoval)\.|\.governance\./.test(key));
    expect(keys.length).toBeGreaterThan(80);
    for (const key of keys) expect(catalogue.es[key], key).toBeTruthy();
  });

  it("maps server refusals to stable reasons", () => {
    expect(leadershipFailureReason({ message: "Claim chapter leadership: leadership claim unavailable: claim_pending" })).toBe("claim_pending");
    expect(leadershipFailureReason({ message: "x: two-step sign-in required" })).toBe("mfa_required");
    expect(leadershipFailureReason({ message: "x: chapter unavailable" })).toBe("chapter_unavailable");
    expect(leadershipFailureReason(new Error("network"))).toBe("failed");
  });

  it("loads removal details softly", async () => {
    const ok = { rpc: vi.fn(async () => ({ data: { enabled: true, items: [{ ballotId: "b1", targetName: "Ana" }] }, error: null })) };
    const details = await loadOfficerRemovalDetails(ok, ["b1", "b1", "", null]);
    expect(ok.rpc).toHaveBeenCalledWith("get_officer_removal_ballot_details", { p_ballot_ids: ["b1"] });
    expect(details.enabled).toBe(true);
    expect(details.byId.get("b1")).toMatchObject({ targetName: "Ana" });
    const missing = { rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "not found" } })) };
    expect(await loadOfficerRemovalDetails(missing, ["b1"])).toEqual({ enabled: false, byId: new Map() });
    const thrown = { rpc: vi.fn(async () => { throw new Error("offline"); }) };
    expect((await loadOfficerRemovalDetails(thrown, ["b1"])).byId.size).toBe(0);
  });

  it("builds bilingual default titles for a chosen officer", () => {
    expect(defaultRemovalTitles({ name: "Ana Ruiz", role: "steward" })).toEqual({
      titleEn: "Remove Ana Ruiz as committee member?", titleEs: "¿Destituir a Ana Ruiz como miembro del comité?",
    });
  });
});

describe("ChapterLeadershipRecoveryCard", () => {
  it("renders nothing unless the server offers the claim or reports one", async () => {
    for (const state of [
      { ...ELIGIBLE, eligible: false, reason: "active_leader_present" },
      { ...ELIGIBLE, available: false, reason: "disabled" },
    ]) {
      const api = { load: vi.fn(async () => state) };
      const view = wrap(<ChapterLeadershipRecoveryCard api={api} />);
      await waitFor(() => expect(api.load).toHaveBeenCalled());
      expect(view.container.querySelector("[data-testid='chapter-leadership-recovery']")).toBeNull();
      cleanup();
    }
    const failing = { load: vi.fn(async () => { throw new Error("offline"); }) };
    const view = wrap(<ChapterLeadershipRecoveryCard api={failing} />);
    await waitFor(() => expect(failing.load).toHaveBeenCalled());
    expect(view.container.querySelector("[data-testid='chapter-leadership-recovery']")).toBeNull();
  });

  it("asks for two-step sign-in before offering the claim button", async () => {
    const onOpenSettings = vi.fn();
    const api = { load: vi.fn(async () => ({ ...ELIGIBLE, mfaAssured: false })), claim: vi.fn() };
    wrap(<ChapterLeadershipRecoveryCard api={api} onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/Claiming needs two-step sign-in/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim campaign admin" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("confirms, claims through the server and shows the pending window", async () => {
    let state = ELIGIBLE;
    const api = {
      load: vi.fn(async () => state),
      claim: vi.fn(async () => {
        state = { ...ELIGIBLE, eligible: false, reason: "claim_pending", claim: { id: "c1", status: "pending", effectiveAt: "2026-10-05T12:00:00.000Z" } };
      }),
      withdraw: vi.fn(async () => { state = { ...ELIGIBLE, claim: { id: "c1", status: "withdrawn" } }; }),
    };
    wrap(<ChapterLeadershipRecoveryCard api={api} />);
    expect(await screen.findByText("Campaign leadership is available")).toBeInTheDocument();
    expect(screen.getByText(/no activity for 6 months/)).toBeInTheDocument();
    expect(screen.getByText(/have 72 hours to reject/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Claim campaign admin" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/admin of North Chapter in 72 hours/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Claim campaign admin" }));
    await waitFor(() => expect(api.claim).toHaveBeenCalledWith("north"));
    expect(await screen.findByText("Your campaign leadership claim is pending")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw claim" }));
    await waitFor(() => expect(api.withdraw).toHaveBeenCalledWith("c1"));
  });

  it("explains a refusal in the member's language", async () => {
    const error = Object.assign(new Error("Claim chapter leadership: leadership claim unavailable: active_leader_present"), {});
    const api = { load: vi.fn(async () => ELIGIBLE), claim: vi.fn(async () => { throw error; }) };
    wrap(<ChapterLeadershipRecoveryCard api={api} />, "es");
    fireEvent.click(await screen.findByRole("button", { name: "Solicitar ser administrador" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Solicitar ser administrador" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Un administrador o miembro del comité de la campaña ha estado activo hace poco");
  });

  it("reports a rejection with the admin's note", async () => {
    const api = { load: vi.fn(async () => ({ ...ELIGIBLE, eligible: false, reason: "recently_rejected", claim: { id: "c1", status: "rejected", decisionNote: "Elections next month." } })) };
    wrap(<ChapterLeadershipRecoveryCard api={api} />);
    expect(await screen.findByText("Your campaign leadership claim was not approved")).toBeInTheDocument();
    expect(screen.getByText("Their note: Elections next month.")).toBeInTheDocument();
  });
});

describe("LeadershipClaimsPanel", () => {
  it("lists claims for review and rejects one with a note", async () => {
    let items = [{
      id: "c1", status: "pending", chapterId: "north", chapterName: "North Chapter", claimantName: "Casey Claimant",
      claimedAt: "2026-10-02T12:00:00.000Z", effectiveAt: "2026-10-05T12:00:00.000Z", inactiveLeaderCount: 2,
    }];
    const api = {
      listLeadershipClaims: vi.fn(async () => ({ enabled: true, inactivityMonths: 6, coolingOffHours: 72, items })),
      rejectLeadershipClaim: vi.fn(async () => { items = [{ ...items[0], status: "rejected", decidedByName: "Ada Admin", decisionNote: "Not yet." }]; }),
    };
    const onNotice = vi.fn();
    wrap(<LeadershipClaimsPanel api={api} onNotice={onNotice} />);
    expect(await screen.findByText("Casey Claimant claimed North Chapter")).toBeInTheDocument();
    expect(screen.getByText(/You have 72 hours to reject a claim/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Note to the worker (optional)"), { target: { value: "Not yet." } });
    fireEvent.click(screen.getByRole("button", { name: "Reject Casey Claimant's claim for North Chapter" }));
    await waitFor(() => expect(api.rejectLeadershipClaim).toHaveBeenCalledWith("c1", "Not yet."));
    expect(onNotice).toHaveBeenCalledWith("Claim rejected.");
    expect(await screen.findByText("Decided by Ada Admin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reject Casey/ })).not.toBeInTheDocument();
  });

  it("says when the organization switch is off", async () => {
    const api = { listLeadershipClaims: vi.fn(async () => ({ enabled: false, inactivityMonths: 6, coolingOffHours: 72, items: [] })) };
    wrap(<LeadershipClaimsPanel api={api} />);
    expect(await screen.findByText(/Campaign leadership recovery is off for this organization/)).toBeInTheDocument();
  });
});

describe("officer removal ballots", () => {
  const DETAIL = { ballotId: "ballot-r", targetUserId: "u-olivia", targetName: "Olivia Officer", targetRole: "steward", reason: "Missed every meeting.", outcome: null, canRecordOutcome: false };

  it("shows the officer, reason and recorded result to voters", () => {
    wrap(<OfficerRemovalSummary detail={{ ...DETAIL, outcome: "retained" }} />);
    expect(screen.getByText("Officer removal")).toBeInTheDocument();
    expect(screen.getByText("Officer: Olivia Officer (committee member)")).toBeInTheDocument();
    expect(screen.getByText("Reason: Missed every meeting.")).toBeInTheDocument();
    expect(screen.getByText("Result recorded: retained")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  function registryApi(overrides = {}) {
    const campaigns = [{
      id: "ballot-r", kind: "ballot", scope: "chapter", chapterId: "north", titleEn: "Remove Olivia Officer as committee member?",
      titleEs: "¿Destituir a Olivia Officer como miembro del comité?", bodyEn: "", bodyEs: "", closesAt: "2026-09-01T16:00:00.000Z",
      quorumTarget: 5, state: "closed", active: false,
      options: [{ id: "ballot-r-option-remove", labelEn: "Remove from office", labelEs: "Destituir del cargo", orderIndex: 1 }, { id: "ballot-r-option-retain", labelEn: "Do not remove", labelEs: "No destituir", orderIndex: 2 }],
    }];
    return {
      load: vi.fn(async () => ({ campaigns, canManageUnion: false, chapterId: "north" })),
      saveDraft: vi.fn(), publish: vi.fn(), close: vi.fn(),
      removalDetails: vi.fn(async () => ({ enabled: true, byId: new Map([["ballot-r", { ...DETAIL, canRecordOutcome: true }]]) })),
      removalTargets: vi.fn(async () => ({ items: [{ userId: "u-olivia", name: "Olivia Officer", role: "steward" }] })),
      saveRemovalDraft: vi.fn(async () => ({ id: "ballot-new" })),
      recordRemovalOutcome: vi.fn(async () => ({ id: "ballot-r", outcome: "removed" })),
      ...overrides,
    };
  }

  it("lets staff record the result of a closed removal ballot", async () => {
    const api = registryApi();
    wrap(<CampaignsView api={api} />);
    expect(await screen.findByText("Officer: Olivia Officer (committee member)")).toBeInTheDocument();
    expect(screen.getByText(/does not change anyone's role/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record Removed from office for Olivia Officer" }));
    await waitFor(() => expect(api.recordRemovalOutcome).toHaveBeenCalledWith("ballot-r", "removed"));
    expect(api.load).toHaveBeenCalledTimes(2);
  });

  it("drafts a removal ballot with an in-scope officer, a reason and prefilled titles", async () => {
    const api = registryApi();
    wrap(<CampaignsView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "New officer removal ballot" }));
    const editor = await screen.findByTestId("officer-removal-editor");
    await waitFor(() => expect(api.removalTargets).toHaveBeenCalledWith("chapter"));
    const select = within(editor).getByLabelText("Officer");
    await waitFor(() => expect(within(select).getByRole("option", { name: "Olivia Officer · committee member" })).toBeInTheDocument());
    fireEvent.change(select, { target: { value: "u-olivia" } });
    expect(within(editor).getByLabelText("English title")).toHaveValue("Remove Olivia Officer as committee member?");
    expect(within(editor).getByLabelText("Spanish title")).toHaveValue("¿Destituir a Olivia Officer como miembro del comité?");
    fireEvent.change(within(editor).getByLabelText("Reason (at least 10 characters)"), { target: { value: "Missed every meeting." } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.saveRemovalDraft).toHaveBeenCalledWith(expect.objectContaining({
      scope: "chapter", targetUserId: "u-olivia", reason: "Missed every meeting.", titleEn: "Remove Olivia Officer as committee member?",
    })));
  });

  it("hides the removal action while the organization switch is off", async () => {
    const api = registryApi({ removalDetails: vi.fn(async () => ({ enabled: false, byId: new Map() })) });
    wrap(<CampaignsView api={api} />);
    expect(await screen.findByRole("button", { name: "New campaign" })).toBeInTheDocument();
    await waitFor(() => expect(api.removalDetails).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "New officer removal ballot" })).not.toBeInTheDocument();
  });
});

describe("governance RPC wrappers", () => {
  const ok = (data) => ({ rpc: vi.fn(async () => ({ data, error: null })) });

  it("calls each governance RPC with its exact arguments", async () => {
    let client = ok({ eligible: true });
    expect(await loadChapterLeadershipRecovery(client)).toEqual({ eligible: true });
    expect(client.rpc).toHaveBeenCalledWith("get_chapter_leadership_recovery");
    client = ok({ id: "c1" });
    await claimChapterLeadership(client, "north");
    expect(client.rpc).toHaveBeenCalledWith("claim_chapter_leadership", { p_chapter_id: "north" });
    await withdrawChapterLeadershipClaim(client, "c1");
    expect(client.rpc).toHaveBeenCalledWith("withdraw_chapter_leadership_claim", { p_claim_id: "c1" });
    await listChapterLeadershipClaims(client);
    expect(client.rpc).toHaveBeenCalledWith("list_chapter_leadership_claims", { p_limit: 50 });
    await rejectChapterLeadershipClaim(client, "c1", "  ");
    expect(client.rpc).toHaveBeenCalledWith("reject_chapter_leadership_claim", { p_claim_id: "c1", p_note: null });
    await rejectChapterLeadershipClaim(client, "c1", " Not yet. ");
    expect(client.rpc).toHaveBeenLastCalledWith("reject_chapter_leadership_claim", { p_claim_id: "c1", p_note: "Not yet." });
    await listOfficerRemovalTargets(client, "union");
    expect(client.rpc).toHaveBeenCalledWith("list_officer_removal_targets", { p_scope: "union" });
    await saveOfficerRemovalDraft(client, {
      id: " ", scope: "chapter", targetUserId: "u1", reason: " Missed meetings. ", titleEn: " Remove? ", titleEs: " ¿Destituir? ",
      bodyEn: null, bodyEs: "", closesAt: "2026-10-09T00:00:00.000Z", quorumTarget: "3",
    });
    expect(client.rpc).toHaveBeenCalledWith("save_officer_removal_ballot_draft", {
      p_campaign_id: null, p_scope: "chapter", p_target_user_id: "u1", p_reason: "Missed meetings.", p_title_en: "Remove?",
      p_title_es: "¿Destituir?", p_body_en: "", p_body_es: "", p_closes_at: "2026-10-09T00:00:00.000Z", p_quorum_target: 3,
    });
    await recordOfficerRemovalOutcome(client, "b1", "retained");
    expect(client.rpc).toHaveBeenCalledWith("record_officer_removal_outcome", { p_campaign_id: "b1", p_outcome: "retained" });
  });

  it("throws the server's refusal with its code", async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { code: "22023", message: "leadership claim unavailable: claim_pending" } })) };
    await expect(claimChapterLeadership(client, "north")).rejects.toMatchObject({ code: "22023" });
    await expect(claimChapterLeadership(client, "north")).rejects.toThrow(/claim_pending/);
  });

  it("skips the details call without ballots and keeps only identified items", async () => {
    const client = { rpc: vi.fn(async () => ({ data: { enabled: true, items: [{ ballotId: "b1" }, { targetName: "no id" }] }, error: null })) };
    const details = await loadOfficerRemovalDetails(client, undefined);
    expect(client.rpc).toHaveBeenCalledWith("get_officer_removal_ballot_details", { p_ballot_ids: [] });
    expect([...details.byId.keys()]).toEqual(["b1"]);
  });
});

describe("OfficerRemovalEditor", () => {
  function Harness({ initial, loadTargets, onSave = vi.fn(), onCancel = vi.fn(), canManageUnion = true, error = "" }) {
    const [draft, setDraft] = useState(initial);
    return <OfficerRemovalEditor draft={draft} setDraft={setDraft} canManageUnion={canManageUnion} busy={false} error={error} loadTargets={loadTargets} onCancel={onCancel} onSave={onSave} />;
  }

  it("rebuilds an existing draft, keeps its titles, and reloads officers for the union scope", async () => {
    const campaign = { id: "b1", scope: "chapter", titleEn: "Kept title", titleEs: "Título", bodyEn: "", bodyEs: "", closesAt: "2026-10-09T16:00:00.000Z", quorumTarget: 4 };
    const draft = removalDraftFromCampaign(campaign, { targetUserId: "u1", reason: "Missed every meeting." });
    expect(draft).toMatchObject({ id: "b1", targetUserId: "u1", reason: "Missed every meeting.", quorumTarget: 4, titlesTouched: true });
    expect(removalDraftFromCampaign({ ...campaign, quorumTarget: null }, null)).toMatchObject({ targetUserId: "", reason: "", quorumTarget: 1 });
    const loadTargets = vi.fn(async (scope) => ({ items: scope === "chapter" ? [{ userId: "u1", name: "Ana", role: "steward" }, { userId: "u2", name: "Bo", role: "vp" }] : [] }));
    const onSave = vi.fn();
    wrap(<Harness initial={draft} loadTargets={loadTargets} onSave={onSave} />);
    const editor = screen.getByTestId("officer-removal-editor");
    await waitFor(() => expect(within(editor).getByRole("option", { name: "Bo · campaign lead" })).toBeInTheDocument());
    fireEvent.change(within(editor).getByLabelText("Officer"), { target: { value: "u2" } });
    expect(within(editor).getByLabelText("English title")).toHaveValue("Kept title");
    fireEvent.change(within(editor).getByLabelText("English title"), { target: { value: "New title" } });
    fireEvent.change(within(editor).getByLabelText("Spanish title"), { target: { value: "Nuevo título" } });
    fireEvent.change(within(editor).getByLabelText("English details"), { target: { value: "Details" } });
    fireEvent.change(within(editor).getByLabelText("Spanish details"), { target: { value: "Detalles" } });
    fireEvent.change(within(editor).getByLabelText("Required quorum"), { target: { value: "6" } });
    fireEvent.change(within(editor).getByLabelText("Closes at"), { target: { value: "2026-10-10T09:30" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save draft" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: "b1", targetUserId: "u2", titleEn: "New title", bodyEs: "Detalles", quorumTarget: "6" }));
  });

  it("switches scope, says when no officer qualifies or officers cannot load, and cancels", async () => {
    const onCancel = vi.fn();
    const loadTargets = vi.fn(async (scope) => {
      if (scope === "union") throw new Error("offline");
      return { items: [] };
    });
    wrap(<Harness initial={emptyRemovalDraft()} loadTargets={loadTargets} onCancel={onCancel} error="The ballot could not be saved." />);
    expect(await screen.findByText("No one holds a staff role in this scope.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Organization-wide"));
    expect(await screen.findByText("Officers could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("My campaign"));
    await waitFor(() => expect(loadTargets).toHaveBeenLastCalledWith("chapter"));
    expect(screen.getByText("The ballot could not be saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("tells staff when a result is not recorded yet", () => {
    wrap(<OfficerRemovalSummary detail={{ ballotId: "b1", targetName: "Ana", targetRole: "admin", reason: "", outcome: null, canRecordOutcome: false }} canRecord />);
    expect(screen.getByText("Result not recorded yet.")).toBeInTheDocument();
    cleanup();
    const view = wrap(<OfficerRemovalSummary detail={null} />);
    expect(view.container.innerHTML).toBe("");
  });

  it("lets a member cancel the claim confirmation", async () => {
    const api = { load: vi.fn(async () => ELIGIBLE), claim: vi.fn() };
    wrap(<ChapterLeadershipRecoveryCard api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Claim campaign admin" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.claim).not.toHaveBeenCalled();
  });
});
