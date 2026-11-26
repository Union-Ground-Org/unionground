// REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030 (#6634,
// split from #6561; Oct 29-30 findings 26 and 38): a Steward or Member
// suggests an invitation or asks for a staff role; the deciders approve or
// decline; nothing is sent until approved.
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AltAccountPage } from "../src/alt/help/AltAccountPage.jsx";
import { MemberRequestsPanel, memberSendNoticeKey } from "../src/features/requests/MemberRequestsPanel.jsx";
import { AdminInvitationError } from "../src/lib/adminInvitationApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CHAPTER_SETUP_CHANGED_EVENT } from "../src/lib/onboardingGuide.js";
import { decideMemberRequest, listMemberRequests, listMyMemberRequests, submitMemberRequest } from "../src/lib/memberApi.js";
import { notificationDestination } from "../src/lib/notificationDestinations.js";
import { buildSearchIndex } from "../src/lib/searchIndex.js";
import { t as translate } from "../src/lib/i18n.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const SUGGESTION = { id: "r1", kind: "invitation_suggestion", chapterId: "harbor", chapterName: "Harbor", requesterName: "Gwen Ward", inviteeName: "Yuqing Li", inviteeEmail: "yuqing@example.com", requestedRole: null, note: "Night shift", status: "pending", createdAt: "2026-10-30T20:00:00Z" };
const ACCESS = { id: "r2", kind: "access_request", chapterId: "harbor", chapterName: "Harbor", requesterName: "Ana Ruiz", inviteeName: "", inviteeEmail: "", requestedRole: "coordinator", note: "", status: "pending", createdAt: "2026-10-30T19:00:00Z" };
const page = (items, hasMore = false) => ({ items, hasMore });

function panelApi(overrides = {}) {
  return {
    submit: vi.fn().mockResolvedValue({ accepted: true }),
    listMine: vi.fn().mockResolvedValue(page([{ ...SUGGESTION, status: "approved" }])),
    listToDecide: vi.fn().mockResolvedValue(page([SUGGESTION, ACCESS])),
    decide: vi.fn().mockResolvedValue({}),
    invite: vi.fn().mockResolvedValue({ accepted: true }),
    ...overrides,
  };
}

function renderPanel(props = {}, lang = "en") {
  const onNotice = vi.fn();
  render(<LanguageProvider lang={lang}><MemberRequestsPanel api={panelApi()} lang={lang} onNotice={onNotice} {...props} /></LanguageProvider>);
  return onNotice;
}

describe("asking", () => {
  it("suggests an invitation, says nothing is sent until approved, and shows the requester's own state", async () => {
    const api = panelApi();
    const onNotice = renderPanel({ api });
    expect(await screen.findByText("Invite Yuqing Li to Harbor")).toBeVisible();
    expect(screen.getByText("Approved")).toBeVisible();
    const form = screen.getByRole("form", { name: "Suggest an invitation" });
    fireEvent.change(within(form).getByLabelText("Their name"), { target: { value: "Ana Ruiz" } });
    fireEvent.change(within(form).getByLabelText("Their email address"), { target: { value: "ana@example.com" } });
    fireEvent.change(within(form).getByLabelText("Note (optional)"), { target: { value: "Weekend crew" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send suggestion" }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({ kind: "invitation_suggestion", inviteeName: "Ana Ruiz", inviteeEmail: "ana@example.com", note: "Weekend crew" }));
    expect(onNotice).toHaveBeenCalledWith("Suggestion sent for approval. Nothing goes to that address until it is approved.");
    expect(api.invite).not.toHaveBeenCalled();
    expect(api.listMine).toHaveBeenCalledTimes(2);
  });

  // REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171), owner option A:
  // with the organization's switch on, the same place sends the invitation;
  // off, it stays a suggestion (the test above).
  it("sends the worker's own invitation when the organization lets workers invite, in either language", async () => {
    for (const lang of ["en", "es"]) {
      const api = panelApi();
      const onNotice = vi.fn();
      const { unmount } = render(<LanguageProvider lang={lang}><MemberRequestsPanel api={api} lang={lang} onNotice={onNotice} memberSendEnabled /></LanguageProvider>);
      const t = (key) => translate(lang, key);
      const form = screen.getByRole("form", { name: t("requests.send.title") });
      fireEvent.change(within(form).getByLabelText(t("requests.suggest.name")), { target: { value: "Dana Wu" } });
      fireEvent.change(within(form).getByLabelText(t("requests.suggest.email")), { target: { value: "dana@example.com" } });
      expect(within(form).getByLabelText(t("requests.send.language")).value).toBe(lang);
      fireEvent.click(within(form).getByRole("button", { name: t("requests.send.action") }));
      await waitFor(() => expect(api.invite).toHaveBeenCalledWith({ memberSent: true, fullName: "Dana Wu", email: "dana@example.com", locale: lang }));
      expect(onNotice).toHaveBeenCalledWith(t("requests.send.sent"));
      expect(api.submit).not.toHaveBeenCalled();
      unmount();
    }
  });

  // Sol gate round 1, r1s1: with member sending on, a member the server
  // refuses (here an account under a week old) still reaches the suggestion
  // an administrator approves, mounted end to end through the panel.
  it("keeps the suggestion an administrator approves reachable when the worker's own send is refused", async () => {
    const api = panelApi({ invite: vi.fn().mockRejectedValue(new AdminInvitationError("not-permitted", 403)) });
    const onNotice = renderPanel({ api, memberSendEnabled: true });
    const sendForm = screen.getByRole("form", { name: "Invite someone to your campaign" });
    fireEvent.change(within(sendForm).getByLabelText("Their name"), { target: { value: "Dana Wu" } });
    fireEvent.change(within(sendForm).getByLabelText("Their email address"), { target: { value: "dana@example.com" } });
    fireEvent.click(within(sendForm).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(translate("en", "requests.send.notPermitted")));
    const suggestForm = screen.getByRole("form", { name: "Suggest an invitation" });
    fireEvent.change(within(suggestForm).getByLabelText("Their name"), { target: { value: "Dana Wu" } });
    fireEvent.change(within(suggestForm).getByLabelText("Their email address"), { target: { value: "dana@example.com" } });
    fireEvent.click(within(suggestForm).getByRole("button", { name: "Send suggestion" }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith({ kind: "invitation_suggestion", inviteeName: "Dana Wu", inviteeEmail: "dana@example.com", note: null }));
    expect(onNotice).toHaveBeenLastCalledWith("Suggestion sent for approval. Nothing goes to that address until it is approved.");
  });

  it("names a worker's limit with its Eastern time, and every other refusal plainly", async () => {
    const retryAt = "2026-11-12T15:00:00.000Z";
    const api = panelApi({ invite: vi.fn().mockRejectedValue(new AdminInvitationError("rate-limited", 429, { limit: "limits.security.invitation_member_daily", retryAt })) });
    const onNotice = renderPanel({ api, memberSendEnabled: true });
    const form = screen.getByRole("form", { name: "Invite someone to your campaign" });
    fireEvent.change(within(form).getByLabelText("Their name"), { target: { value: "Dana Wu" } });
    fireEvent.change(within(form).getByLabelText("Their email address"), { target: { value: "dana@example.com" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/^You have sent as many invitations as you can for now\. You can send more after Nov 12, 2026, 10:00\sAM ET\.$/u)));
    expect(memberSendNoticeKey(new AdminInvitationError("not-permitted", 403))).toBe("requests.send.notPermitted");
    expect(memberSendNoticeKey(new AdminInvitationError("email-domain-blocked", 400))).toBe("admin.emailDomainBlocked");
    expect(memberSendNoticeKey(new TypeError("offline"))).toBe("requests.send.failed");
  });

  it("asks for a staff role, and explains a role already held or the request limit", async () => {
    const api = panelApi({ submit: vi.fn().mockResolvedValueOnce({ accepted: true }).mockRejectedValueOnce(new Error("role already held")).mockRejectedValueOnce(new Error("request limit reached")) });
    const onNotice = renderPanel({ api });
    const form = screen.getByRole("form", { name: "Ask for a staff role" });
    const send = async (expected) => {
      fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "coordinator" } });
      fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
      await waitFor(() => expect(onNotice).toHaveBeenLastCalledWith(expected));
    };
    await send("Request sent for approval.");
    expect(api.submit).toHaveBeenCalledWith({ kind: "access_request", requestedRole: "coordinator", note: null });
    await send("You already have that role in this campaign.");
    await send("You have reached the limit of open requests. Try again tomorrow.");
  });

  it("shows no decision list to someone who cannot decide, and never asks for one", async () => {
    const api = panelApi();
    renderPanel({ api, canDecide: false });
    await screen.findByText("Your requests");
    expect(screen.queryByText("Requests to decide")).toBeNull();
    expect(api.listToDecide).not.toHaveBeenCalled();
  });
});

describe("deciding", () => {
  it.each([
    ["en", "Campaign units could not be loaded.", "Try again", "Approve"],
    ["es", "No se pudieron cargar las unidades de la campaña.", "Reintentar", "Aprobar"],
  ])("explains a failed unit read next to a committee worker approval and retries in %s", async (lang, failure, retry, approve) => {
    const steward = { ...ACCESS, id: "r3", requestedRole: "steward" };
    const api = panelApi({
      listToDecide: vi.fn().mockResolvedValue(page([steward])),
      listChapterUnits: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce([{ id: "u-nights", chapterId: "harbor", name: "Night crew" }]),
    });
    renderPanel({ api, canDecide: true }, lang);
    const request = (await screen.findByText(failure)).closest("li");
    expect(within(request).getByRole("button", { name: approve })).toBeDisabled();
    fireEvent.click(within(request).getByRole("button", { name: retry }));
    const choose = (await within(request).findByRole("option", { name: "Night crew" })).closest("select");
    fireEvent.change(choose, { target: { value: "u-nights" } });
    fireEvent.click(within(request).getByRole("button", { name: approve }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("r3", "approved", "u-nights"));
  });

  it("names the missing prerequisite after a successful read with no units in the request's campaign", async () => {
    const steward = { ...ACCESS, id: "r3", requestedRole: "steward" };
    const api = panelApi({
      listToDecide: vi.fn().mockResolvedValue(page([steward])),
      listChapterUnits: vi.fn().mockResolvedValue([{ id: "u-ridge", chapterId: "ridge", name: "Ridge crew" }]),
    });
    renderPanel({ api, canDecide: true });
    const request = (await screen.findByText("This campaign has no units yet. Ask an administrator to add one.")).closest("li");
    expect(within(request).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(request).getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(within(request).queryByRole("option", { name: "Ridge crew" })).not.toBeInTheDocument();
  });


  // REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109 (#7674, final review
  // r4s1): an approved steward request places a steward in a unit, so the
  // staff guide's units step reads its facts again; a refused one does not.

  it("approves a suggestion through the invitation route, which records the approval with the invitation", async () => {
    const api = panelApi();
    const onNotice = renderPanel({ api, canDecide: true });
    const decide = await screen.findByText("Requests to decide");
    expect(decide).toBeVisible();
    const row = (await screen.findAllByText("Invite Yuqing Li to Harbor")).map((node) => node.closest("li")).find((li) => within(li).queryByRole("button", { name: "Approve" }));
    expect(within(row).getByText("From Gwen Ward")).toBeVisible();
    expect(within(row).getByText("yuqing@example.com")).toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Approved."));
    await waitFor(() => expect(api.listMine).toHaveBeenCalledTimes(2));
    expect(api.invite).toHaveBeenCalledWith({ requestId: "r1", email: "yuqing@example.com", fullName: "Yuqing Li", chapterId: "harbor", initialRole: null, locale: "en" });
    expect(api.decide).not.toHaveBeenCalled();
    await waitFor(() => expect(api.listToDecide).toHaveBeenCalledTimes(2));
  });

  // REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118: a
  // person's invite request the platform operator passed on says it came from
  // Union Ground, not from a member, and is approved the same way.
  it("says a suggestion passed on from Union Ground's invite requests came from Union Ground, in either language", async () => {
    const intake = { ...SUGGESTION, id: "r3", requesterName: "Former worker", fromIntake: true, note: "North site" };
    const api = panelApi({ listToDecide: vi.fn().mockResolvedValue(page([intake])) });
    renderPanel({ api, canDecide: true });
    const row = (await screen.findByText("North site")).closest("li");
    expect(within(row).getByText("Passed on by Union Ground: this person asked Union Ground for an invitation.")).toBeVisible();
    expect(within(row).queryByText("From Former worker")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.invite).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r3", email: "yuqing@example.com" })));
    cleanup();
    renderPanel({ api: panelApi({ listToDecide: vi.fn().mockResolvedValue(page([intake])) }), canDecide: true }, "es");
    expect(await screen.findByText("Enviada por Union Ground: esta persona pidió una invitación a Union Ground.")).toBeVisible();
  });

  it("says what happened when the approval or its email fails, and shows where the request stands", async () => {
    const cases = [
      [Object.assign(new Error("request-unavailable"), { code: "request-unavailable" }), "That decision could not be saved. Nothing changed. Try again."],
      [Object.assign(new Error("delivery-status-unavailable"), { code: "delivery-status-unavailable" }), "Approved, and the invitation was created, but its email could not be confirmed. Check it on the invitations page and resend it there if needed."],
      [Object.assign(new Error("delivery-unavailable"), { code: "delivery-unavailable" }), "Approved, and the invitation was created, but its email could not be confirmed. Check it on the invitations page and resend it there if needed."],
      [new TypeError("Failed to fetch"), "That decision could not be confirmed. If the request is no longer waiting below, it was saved; for an approved suggestion, check its invitation on the invitations page and resend it there if needed."],
      [Object.assign(new Error("service-unavailable"), { code: "service-unavailable" }), "That decision could not be confirmed. If the request is no longer waiting below, it was saved; for an approved suggestion, check its invitation on the invitations page and resend it there if needed."],
      [Object.assign(new Error("rate-limited"), { code: "rate-limited" }), "That decision could not be saved. Nothing changed. Try again."],
    ];
    for (const [failure, notice] of cases) {
      const api = panelApi({ invite: vi.fn().mockRejectedValue(failure) });
      const onNotice = vi.fn();
      const { unmount } = render(<LanguageProvider lang="en"><MemberRequestsPanel api={api} lang="en" onNotice={onNotice} canDecide /></LanguageProvider>);
      const row = (await screen.findAllByText("Invite Yuqing Li to Harbor")).map((node) => node.closest("li")).find((li) => within(li).queryByRole("button", { name: "Approve" }));
      fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith(notice));
      expect(api.decide).not.toHaveBeenCalled();
      await waitFor(() => expect(api.listToDecide).toHaveBeenCalledTimes(2));
      unmount();
    }
  });

  it("explains a decline refused because an invitation to that address is already out", async () => {
    const api = panelApi({ decide: vi.fn().mockRejectedValue(new Error("invitation already sent")) });
    const onNotice = renderPanel({ api, canDecide: true });
    const row = (await screen.findAllByText("Invite Yuqing Li to Harbor")).map((node) => node.closest("li")).find((li) => within(li).queryByRole("button", { name: "Decline" }));
    fireEvent.click(within(row).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("An invitation to this address is already out. Approve the suggestion, or revoke that invitation first."));
    expect(api.decide).toHaveBeenCalledWith("r1", "declined");
    expect(api.invite).not.toHaveBeenCalled();
  });

  it("reloads both lists when a request notification opens the page it is already on", async () => {
    const api = panelApi();
    const view = (refreshKey) => <LanguageProvider lang="en"><MemberRequestsPanel api={api} lang="en" canDecide refreshKey={refreshKey} /></LanguageProvider>;
    const { rerender } = render(view(0));
    await screen.findByText("Requests to decide");
    await waitFor(() => expect(api.listToDecide).toHaveBeenCalledTimes(1));
    rerender(view(0));
    expect(api.listMine).toHaveBeenCalledTimes(1);
    rerender(view(4));
    await waitFor(() => expect(api.listMine).toHaveBeenCalledTimes(2));
    expect(api.listToDecide).toHaveBeenCalledTimes(2);
  });

  it("approves or declines a role request without sending anything", async () => {
    const api = panelApi();
    renderPanel({ api, canDecide: true });
    const row = (await screen.findByText("Campaign lead role in Harbor")).closest("li");
    fireEvent.click(within(row).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("r2", "declined"));
    expect(api.invite).not.toHaveBeenCalled();
  });

  it("pages to older requests, and says when the list cannot load or is empty", async () => {
    const api = panelApi({
      listToDecide: vi.fn().mockResolvedValueOnce(page([SUGGESTION], true)).mockResolvedValueOnce(page([ACCESS])),
      listMine: vi.fn().mockRejectedValue(new Error("offline")),
    });
    renderPanel({ api, canDecide: true });
    expect(await screen.findByText("Requests could not be loaded.")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Campaign lead role in Harbor")).toBeVisible();
    expect(api.listToDecide).toHaveBeenLastCalledWith("pending", { createdAt: SUGGESTION.createdAt, id: "r1" });
  });

  // #9463 (W4-19): a failed Show more said nothing.
  it.each(["en", "es"])("says a failed Show more beside the button and keeps the list (%s)", async (lang) => {
    const listToDecide = vi.fn()
      .mockResolvedValueOnce(page([SUGGESTION], true))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(page([ACCESS]));
    const api = panelApi({ listToDecide });
    renderPanel({ api, canDecide: true }, lang);
    const more = await screen.findByRole("button", { name: translate(lang, "requests.more") });
    fireEvent.click(more);
    expect(await screen.findByRole("alert")).toHaveTextContent(translate(lang, "requests.moreFailed"));
    expect(screen.getByRole("button", { name: translate(lang, "requests.more") })).toBeInTheDocument();
    expect(screen.getAllByText(translate(lang, "requests.summary.suggestion", { name: "Yuqing Li", chapter: "Harbor" })).length).toBe(2);
    fireEvent.click(more);
    expect(await screen.findByText(translate(lang, "requests.summary.access", {
      role: translate(lang, "demo.hatCoordinator"), chapter: "Harbor",
    }))).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(listToDecide.mock.calls.slice(1)).toEqual(Array(2).fill(["pending", { createdAt: SUGGESTION.createdAt, id: "r1" }]));
  });

  it("speaks Spanish", async () => {
    renderPanel({ api: panelApi({ listToDecide: vi.fn().mockResolvedValue(page([])) }), canDecide: true }, "es");
    expect(await screen.findByRole("heading", { name: "Solicitudes" })).toBeVisible();
    expect(await screen.findByText("No hay solicitudes esperando tu decisión.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Enviar sugerencia" })).toBeVisible();
  });
});

describe("the request reads and links", () => {
  it("maps pages, drops malformed rows and sends cursors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { items: [SUGGESTION, { id: 5 }, { ...ACCESS, requestedRole: "admin", status: "weird" }], hasMore: true }, error: null });
    const result = await listMemberRequests({ rpc }, "decided", { createdAt: "2026-10-30T20:00:00Z", id: "r9" });
    expect(result.hasMore).toBe(true);
    expect(result.items.map((item) => [item.id, item.requestedRole, item.status])).toEqual([["r1", null, "pending"], ["r2", null, "pending"]]);
    expect(result.items.map((item) => item.fromIntake)).toEqual([false, false]);
    expect((await listMemberRequests({ rpc: vi.fn().mockResolvedValue({ data: { items: [{ ...SUGGESTION, fromIntake: true }], hasMore: false }, error: null }) })).items[0].fromIntake).toBe(true);
    expect(rpc).toHaveBeenCalledWith("list_member_requests", { p_status: "decided", p_limit: 20, p_before_created: "2026-10-30T20:00:00Z", p_before_id: "r9" });
    await listMyMemberRequests({ rpc });
    expect(rpc).toHaveBeenLastCalledWith("list_my_member_requests", { p_limit: 20, p_before_created: null, p_before_id: null });
    await submitMemberRequest({ rpc }, { kind: "access_request", requestedRole: "steward" });
    expect(rpc).toHaveBeenLastCalledWith("submit_member_request", { p_kind: "access_request", p_invitee_name: null, p_invitee_email: null, p_requested_role: "steward", p_note: null });
    await decideMemberRequest({ rpc }, "r1", "approved");
    expect(rpc).toHaveBeenLastCalledWith("decide_member_request", { p_request_id: "r1", p_decision: "approved" });
    await expect(decideMemberRequest({ rpc }, "r1", "maybe")).rejects.toThrow(/invalid decision/u);
    await expect(decideMemberRequest({ rpc }, "r1", "approving")).rejects.toThrow(/invalid decision/u);
    expect(await listMemberRequests({ rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })).toEqual({ items: [], hasMore: false });
  });

  it("shows the requests page in the alternate shell too", () => {
    const t = (key, vars) => translate("en", key, vars);
    const props = { t, data: {}, member: { initials: "GW", fullName: "Gwen Ward" }, roleLine: "Worker", pageTitle: "Requests", go: vi.fn(), navTarget: () => ({ refused: true }), topics: [], prefs: {} };
    const blocks = { requestsCard: <p>Requests panel</p>, profileDetails: <p>Profile details</p> };
    const { unmount } = render(<LanguageProvider lang="en"><AltAccountPage {...props} workspace={{ section: "settings-requests" }} blocks={blocks} /></LanguageProvider>);
    expect(screen.getByText("Requests panel")).toBeVisible();
    expect(screen.queryByText("Profile details")).toBeNull();
    unmount();
    render(<LanguageProvider lang="en"><AltAccountPage {...props} workspace={{ section: "settings-profile" }} blocks={blocks} /></LanguageProvider>);
    expect(screen.queryByText("Requests panel")).toBeNull();
  });

  it("offers the panel to every signed-in account, SAMPLE included, and hides it only in the fixture demo", () => {
    // On the SAMPLE origin demo is true for real accounts; fixtureDemo is the
    // test-only fixture mode with no server (Codex P1 on #6638).
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toContain("const requestsPanel = fixtureDemo || !session?.user?.id ? null : <MemberRequestsPanel");
    expect(app).not.toMatch(/const requestsPanel = demo\b/u);
  });

  it("opens the requests page from every request notification", () => {
    for (const key of ["requests.invitation_suggested", "requests.access_requested", "requests.suggestion.approved", "requests.suggestion.declined", "requests.access.approved", "requests.access.declined"]) {
      expect(notificationDestination({ copy_key: key })).toEqual({ view: "settings", path: "/m/settings/requests" });
    }
  });

  it("finds the requests page for a signed-in worker under invite and role", () => {
    const t = (key, vars) => translate("en", key, vars);
    // Not offered where the page is not drawn (fixture demo, SAMPLE, a restricted session).
    expect(buildSearchIndex({ member: { id: "m1" }, roles: [] }, t).some((item) => item.id === "tool:member-requests")).toBe(false);
    const entries = buildSearchIndex({ member: { id: "m1" }, roles: [] }, t, { memberRequests: true });
    const entry = entries.find((item) => item.id === "tool:member-requests");
    expect(entry).toMatchObject({ title: "Requests", focus: { view: "settings", path: "/m/settings/requests" } });
    expect(entry.haystack).toContain("invite");
    expect(entry.haystack).toContain("role");
  });
});

// BUG-UG-INVITATION-SUGGESTIONS-HIDDEN-FROM-ADMIN-DESK-20261102
describe("where deciders find requests, and what approving does", () => {
  it("puts Requests, the name the request notifications use, in the Admin and Campaign chair navigation", () => {
    const migration = readFileSync("supabase/migrations/20261030235900_member_requests.sql", "utf8");
    expect(migration).toContain("Approve or decline it under Requests.");
    expect(migration).toContain("recházala en Solicitudes.");
    expect([translate("en", "requests.title"), translate("es", "requests.title")]).toEqual(["Requests", "Solicitudes"]);
    for (const hat of ["admin", "vp"]) {
      expect(STAFF_ROLE_NAVIGATION[hat].find((item) => item.key === "requests"), hat)
        .toMatchObject({ viewKey: "settings", labelKey: "requests.title", path: "/m/settings/requests" });
    }
    // Stewards, coordinators and advisors cannot decide requests, so they get no entry.
    for (const hat of ["steward", "coordinator", "advisor"]) expect(STAFF_ROLE_NAVIGATION[hat].some((item) => item.key === "requests"), hat).toBe(false);
  });


});

// Send suggestion and Decline keep focus while their write runs,
// and a second activation in the same tick sends nothing more.
describe("request writes while one runs", () => {
  const fillSuggestion = () => {
    const form = screen.getByRole("form", { name: "Suggest an invitation" });
    fireEvent.change(within(form).getByLabelText("Their name"), { target: { value: "Ana Ruiz" } });
    fireEvent.change(within(form).getByLabelText("Their email address"), { target: { value: "ana@example.com" } });
    return within(form).getByRole("button", { name: "Send suggestion" });
  };

  it("keeps Send suggestion focused while it is sent, and sends it once", async () => {
    const api = panelApi({ submit: vi.fn(async () => ({ accepted: true })) });
    renderPanel({ api });
    await screen.findByText("Invite Yuqing Li to Harbor");
    await expectHeldWriteFocus(api.submit, fillSuggestion());
    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  it("sends one suggestion when Send suggestion is activated twice in one tick", async () => {
    const api = panelApi({ submit: vi.fn(async () => ({ accepted: true })) });
    renderPanel({ api });
    await screen.findByText("Invite Yuqing Li to Harbor");
    const send = fillSuggestion();
    await expectOneWriteFromOneTick(api.submit, [() => fireEvent.click(send), () => fireEvent.click(send)]);
  });

  it("sends one worker invitation when it is activated twice in one tick", async () => {
    const api = panelApi({ invite: vi.fn(async () => ({ accepted: true })) });
    render(<LanguageProvider lang="en"><MemberRequestsPanel api={api} lang="en" onNotice={vi.fn()} memberSendEnabled /></LanguageProvider>);
    const form = screen.getByRole("form", { name: translate("en", "requests.send.title") });
    fireEvent.change(within(form).getByLabelText(translate("en", "requests.suggest.name")), { target: { value: "Dana Wu" } });
    fireEvent.change(within(form).getByLabelText(translate("en", "requests.suggest.email")), { target: { value: "dana@example.com" } });
    const send = within(form).getByRole("button", { name: translate("en", "requests.send.action") });
    await expectOneWriteFromOneTick(api.invite, [() => fireEvent.click(send), () => fireEvent.click(send)]);
  });

  const declineRow = async () => (await screen.findAllByText("Invite Yuqing Li to Harbor")).map((node) => node.closest("li")).find((li) => within(li).queryByRole("button", { name: "Decline" }));

  it("keeps Decline focused while the decision is saved, and decides once", async () => {
    const api = panelApi({ decide: vi.fn(async () => ({})) });
    renderPanel({ api, canDecide: true });
    await expectHeldWriteFocus(api.decide, within(await declineRow()).getByRole("button", { name: "Decline" }));
    expect(api.decide).toHaveBeenCalledExactlyOnceWith("r1", "declined");
  });

  it("saves one decision when Decline is activated twice in one tick", async () => {
    const api = panelApi({ decide: vi.fn(async () => ({})) });
    renderPanel({ api, canDecide: true });
    const decline = within(await declineRow()).getByRole("button", { name: "Decline" });
    await expectOneWriteFromOneTick(api.decide, [() => fireEvent.click(decline), () => fireEvent.click(decline)]);
  });
});

