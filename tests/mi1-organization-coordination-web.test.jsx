// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationCoordinationAdapter } from "../src/features/coordination/adapter.js";
import {
  canManageCoordination,
  canPerformCoordinationIntent,
  coordinationScopeIsAuthoritative,
  normalizeCoordinationActor,
  normalizeCoordinationMessagePage,
  normalizeCoordinationSnapshot,
  visibleCoordinationTabs,
} from "../src/features/coordination/authorization.js";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue, dateTimeFormat, t as translate } from "../src/lib/i18n.js";
import { OrganizationCoordinationView } from "../src/views/OrganizationCoordinationView.jsx";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { CoordinationWorkflowPanels } from "../src/features/coordination/ui/CoordinationWorkflowPanels.jsx";
import { mountStylesheets } from "./helpers/appStylesheet.js";
import { BusyTestHost, expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";
import {
  COORDINATION_EXPORT_FORMATS,
  COORDINATION_EXTENSION_FIELDS,
  COORDINATION_EXTENSIONS_RETRYABLE_STATES,
  COORDINATION_MUTATION_EXTENSION_TOUCH,
  COORDINATION_RPCS,
  EMPTY_COORDINATION_EXTENSIONS,
  EMPTY_COORDINATION_SNAPSHOT,
} from "../src/features/coordination/contract.js";
import {
  buildCoordinationActor,
  coordinationExtensionsScope,
  createWiredCoordinationAdapter,
  loadCoordinationSessionScope,
  mergeCoordinationScope,
  MI1_COORDINATION_DATABASE_DEPENDENCIES,
  useCoordinationActor,
  useCoordinationDirectoryExtensions,
} from "../src/lib/mi1CoordinationWiring.js";

// The page-level loading and unavailable states a ready page must not show.
const READY_UNAVAILABLE_SURFACES = "div.oi-state, .coord-state, .coord-state-copy:not(.coord-desk .coord-state-copy), .member-support-state";

// A member of an organization the SERVER has confirmed for this session:
// sessionScope "resolved" is what mergeCoordinationScope stamps once
// get_my_chapter_memberships has answered, and the deferred directory request —
// whose RPC resolves its own organization server-side and writes a
// 'directory_viewed' row for it — is reachable in that state only.
const member = buildCoordinationActor({
  userId: "user-1",
  organizationId: "org-1",
  membershipStatus: "active",
  selectedHat: "member",
  mfaSatisfied: true,
  sessionScope: "resolved",
});

const staff = buildCoordinationActor({
  ...member,
  selectedHat: "coordinator",
  organizationRoles: ["coordinator"],
});

const chapterStaff = buildCoordinationActor({
  ...staff,
  chapterId: "wor",
});

const snapshot = {
  state: "ready",
  organizationId: "org-1",
  staff: true,
  records: [{ id: "mission-1", kind: "mission", title: "Shared mission", status: "active", visibility: "members" }],
  // The inert database projection may still carry per-mission points rows.
  // Union Ground ranks no one, so nothing below may ever render them.
  leaderboards: [{ missionId: "mission-1", title: "Shared mission", rows: [{ alias: "Member A13F", points: 20, status: "active" }] }],
  messages: [],
  resources: [],
  exportRuns: [],
  outreach: [],
};

describe("coordination form feedback (#9466)", () => {
  const model = {
    ...snapshot,
    records: [...snapshot.records,
      { id: "network-1", kind: "network_link", title: "Partner network", organizationId: "org-1", partnerOrganizationId: "org-2", status: "active" },
      { id: "conversation-1", kind: "network_conversation", title: "Planning", status: "active" },
      { id: "campaign-1", kind: "mobilization_campaign", title: "Outreach", status: "active" },
    ],
  };
  const cases = [
    { action: "create", button: "creatorCreate", field: "creatorTitleField", success: "noticeCreated", failure: "rpcError.notPermitted", error: { code: "42501" } },
    { action: "message", tab: "network", button: "messageSend", field: "messageBody", selection: ["messageConversation", "conversation-1"], success: "noticeMessageSent", failure: "coordination.noticeRecordUnavailable", error: { code: "22023", message: "coordination conversation unavailable" } },
    { action: "outreach", tab: "mobilize", button: "outreachRecord", field: "outreachMember", selection: ["outreachCampaign", "campaign-1"], success: "noticeOutreachRecorded", failure: "coordination.noticeRecordUnavailable", error: { code: "22023", message: "member unavailable" } },
    { action: "setPermission", tab: "network", button: "panel.grantPermission", field: "panel.partnerOrganizationId", selection: ["panel.acceptedNetwork", "network-1"], success: "noticePermissionSaved", failure: "coordination.noticeRecordUnavailable", error: { code: "22023", message: "active organization network unavailable" }, keepDraft: true },
    { action: "resource", tab: "network", button: "panel.submitResource", field: "panel.title", selection: ["panel.network", "network-1"], success: "noticeResourceSubmitted", failure: "coordination.noticeMfaRequired", error: { code: "42501", message: "mfa required" }, keepDraft: true },
  ];

  async function waitForMountReload(load, button) {
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
      // Page forms can still be disabled for validation until a page is selected.
      expect(button).not.toHaveAttribute("aria-busy", "true");
    });
  }

  async function submitWhenReady(button) {
    // The same-scope mount reload keeps the form mounted while it blocks presses.
    await waitFor(() => {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("aria-disabled", "true");
    });
    fireEvent.click(button);
  }

  it.each(["en", "es"].flatMap((lang) => cases.map((entry) => ({ ...entry, lang }))))(
    "keeps the $lang $action save result in its own form", async (entry) => {
      const { lang } = entry;
      const t = (key) => translate(lang, "coordination." + key);
      const write = vi.fn().mockRejectedValueOnce(entry.error).mockResolvedValueOnce({ ok: true });
      const api = { load: vi.fn(async () => model), [entry.action]: write };
      render(<LanguageProvider lang={lang}><OrganizationCoordinationView actor={staff} api={api} /></LanguageProvider>);
      if (entry.tab) fireEvent.click(await screen.findByRole("tab", { name: t("tab." + entry.tab) }));
      const button = await screen.findByRole("button", { name: t(entry.button), exact: true });
      await waitForMountReload(api.load, button);
      const form = within(button.closest("form"));
      if (entry.selection) fireEvent.change(form.getByLabelText(t(entry.selection[0])), { target: { value: entry.selection[1] } });
      const field = form.getByLabelText(t(entry.field));
      fireEvent.change(field, { target: { value: "Fictional draft" } });
      await submitWhenReady(button);
      const failure = await form.findByText(translate(lang, entry.failure));
      expect(failure.closest('[role="status"]')).toBeInTheDocument();
      expect(field).toHaveValue("Fictional draft");
      expect(screen.getAllByText(failure.textContent)).toHaveLength(1);
      fireEvent.change(field, { target: { value: "Corrected draft" } });
      expect(failure).not.toBeInTheDocument();
      await submitWhenReady(button);
      const success = await form.findByText(t(entry.success));
      expect(success.closest('[role="status"]')).toBeInTheDocument();
      expect(screen.getAllByText(success.textContent)).toHaveLength(1);
      expect(field).toHaveValue(entry.keepDraft ? "Corrected draft" : "");
      expect(write).toHaveBeenCalledTimes(2);
    },
  );

  it("confirms a created record while its desk refresh is pending", async () => {
    let finishRefresh;
    const load = vi.fn(async () => model);
    const api = { load, create: vi.fn(async () => {
      load.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
      return { ok: true };
    }) };
    render(<OrganizationCoordinationView actor={staff} api={api} />);
    const button = await screen.findByRole("button", { name: "Create", exact: true });
    const form = within(button.closest("form"));
    fireEvent.change(form.getByLabelText("Title"), { target: { value: "Fictional draft" } });
    await submitWhenReady(button);
    expect(await form.findByText("Coordination record created.")).toBeInTheDocument();
    expect(button).toHaveTextContent("Create");
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => { finishRefresh(model); });
    expect(button).not.toHaveAttribute("aria-disabled", "true");
  });


  it("keeps the messages on screen when loading older messages fails", async () => {
    const api = {
      load: async () => ({
        ...model,
        messages: [{ id: "message-1", conversationId: "conversation-1", body: "Current partner update", senderOrganizationId: "org-2", createdAt: "2026-08-01T12:00:00Z" }],
        nextMessagesCursor: { createdAt: "2026-08-01T12:00:00Z", id: "message-1" },
      }),
      loadMoreMessages: async () => { throw new Error("Message history unavailable"); },
    };
    render(<OrganizationCoordinationView actor={staff} api={api} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Network" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older messages" }));
    expect(await screen.findByText("Older partner messages could not be loaded.")).toBeVisible();
    expect(screen.getByText("Current partner update")).toBeVisible();
    expect(screen.getByRole("button", { name: "Load older messages" })).toBeEnabled();
  });

  it.each([
    ["Attach document", "Take over page", "attachPublicPageDocument", "noticePublicDocumentAttached"],
    ["Take over page", "Attach document", "takeOverPublicPage", "noticePublicPageOwnershipUpdated"],
  ])("keeps the page for %s independent while the write and refresh run", async (buttonLabel, otherLabel, action, confirmationKey) => {
    const confirmation = translate("en", `coordination.${confirmationKey}`);
    const admin = buildCoordinationActor({ ...chapterStaff, selectedHat: "admin", organizationRoles: ["admin"] });
    const chapter = {
      ...model,
      micrositeEditor: {
        state: "ready",
        chapterCode: "wor",
        sections: [{ slug: "help", titleEn: "Help" }],
        pages: [
          { sectionSlug: "help", slug: "hours", titleEn: "Office hours" },
          { sectionSlug: "help", slug: "contact", titleEn: "Contact" },
        ],
      },
    };
    let finishWrite;
    let finishRefresh;
    const write = vi.fn(() => new Promise((resolve) => { finishWrite = resolve; }));
    const load = vi.fn(async () => chapter);
    render(<OrganizationCoordinationView actor={admin} api={{ load, [action]: write }} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Campaign" }));
    const button = screen.getByRole("button", { name: buttonLabel });
    await waitForMountReload(load, button);
    const form = button.closest("form");
    const otherForm = screen.getByRole("button", { name: otherLabel }).closest("form");
    const page = within(form).getByLabelText("Page");
    const otherPage = within(otherForm).getByLabelText("Page");
    fireEvent.change(page, { target: { value: "help/hours" } });
    fireEvent.change(otherPage, { target: { value: "help/hours" } });
    fireEvent.change(screen.getByLabelText("Published document ID"), { target: { value: "document-1" } });
    fireEvent.change(screen.getByLabelText("Public label"), { target: { value: "Office guide" } });
    fireEvent.change(screen.getByLabelText("Audited reason"), { target: { value: "Ownership handoff" } });
    await submitWhenReady(button);
    expect(write).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sectionSlug: "help", pageSlug: "hours" }));

    fireEvent.change(otherPage, { target: { value: "help/contact" } });
    expect(page).toHaveValue("help/hours");
    expect(otherPage).toHaveValue("help/contact");

    load.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    await act(async () => { finishWrite({ ok: true }); });
    expect(within(form).getByText(confirmation)).toBeInTheDocument();
    expect(within(otherForm).queryByText(confirmation)).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      finishRefresh({
        ...chapter,
        micrositeEditor: {
          ...chapter.micrositeEditor,
          pages: chapter.micrositeEditor.pages.map((entry) => ({ ...entry, updatedAt: "2026-11-24T15:00:00Z" })),
        },
      });
    });
    expect(screen.getByRole("button", { name: buttonLabel }).closest("form")).toBe(form);
    expect(screen.getByRole("button", { name: otherLabel }).closest("form")).toBe(otherForm);
    expect(within(form).getByText(confirmation)).toBeInTheDocument();
  });
});

// The deferred projection as the adapter returns it once a member asks for it.
// Panels read these 11 fields from `extensions`, never from the mount model,
// so a test that puts directory or badge rows on `model` alone proves nothing.
function readyExtensions(overrides = {}) {
  return { ...EMPTY_COORDINATION_EXTENSIONS, state: "ready", organizationId: "org-1", ...overrides };
}

// The staff actor the route controller receives as a prop, before
// get_my_chapter_memberships has answered. The desk mounts and is usable from it.
const VIEW_ACTOR = Object.freeze({
  userId: "user-1",
  organizationId: "org-1",
  membershipStatus: "active",
  selectedHat: "coordinator",
  organizationRoles: Object.freeze(["coordinator"]),
  mfaSatisfied: true,
});

const SHOW_DIRECTORY = "Show partner directory and activity";

// The membership answer the desk needs before it may issue the writing projection.
function membershipsFor(organizationId, chapterId = null) {
  return { data: [{ selected: true, organizationId, chapterId, organizationRoles: ["coordinator"], chapterRoles: [] }], error: null };
}

// The reviewed passive reads of the coordination desk: none of them writes a
// row. Anything else a mount issues (a write, or the extensions projection,
// which records a directory_viewed access event) is refused.
const REVIEWED_READ_RPCS = new Set([
  "get_my_chapter_memberships",
  "get_member_organization_configuration",
  COORDINATION_RPCS.snapshot,
  COORDINATION_RPCS.recordsPage,
  COORDINATION_RPCS.messagesPage,
  COORDINATION_RPCS.networkAccessEvents,
  COORDINATION_RPCS.coalitionDecisions,
  COORDINATION_RPCS.micrositeEditor,
  COORDINATION_RPCS.sharedDocument,
  COORDINATION_RPCS.exportPayload,
]);
function classifyRpc(name) {
  return REVIEWED_READ_RPCS.has(name) ? "read" : "block";
}

describe("MI1 organization coordination web boundary", () => {
  it("requires an explicitly selected authorized staff hat plus MFA for management", () => {
    expect(canManageCoordination(member)).toBe(false);
    expect(canManageCoordination({ ...staff, selectedHat: "member" })).toBe(false);
    expect(canManageCoordination({ ...staff, mfaSatisfied: false })).toBe(false);
    expect(canManageCoordination(staff)).toBe(true);
    expect(visibleCoordinationTabs(member).map((tab) => tab.id)).toEqual(["missions", "network", "chapter"]);
    expect(visibleCoordinationTabs(staff).map((tab) => tab.id)).toEqual(["missions", "network", "coalitions", "operations", "chapter", "mobilize"]);
  });

  it("rejects a snapshot for a different selected organization", () => {
    expect(normalizeCoordinationSnapshot({ ...snapshot, organizationId: "org-2" }, member).state).toBe("unauthorized");
  });

  it("normalizes empty actors and derives a bounded message cursor", () => {
    expect(normalizeCoordinationActor()).toMatchObject({
      userId: null,
      selectedOrganizationId: null,
      selectedHat: "member",
      chapterRoles: [],
    });
    expect(normalizeCoordinationSnapshot(null, member)).toMatchObject({ state: "empty" });
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `message-${index}`,
      createdAt: `2026-08-${String(30 - index).padStart(2, "0")}T12:00:00Z`,
    }));
    expect(normalizeCoordinationMessagePage({ messages })).toMatchObject({
      nextMessagesCursor: { id: "message-29", createdAt: "2026-08-01T12:00:00Z" },
    });
    expect(normalizeCoordinationMessagePage({ messages: [], nextCursor: { id: "message-x", createdAt: "2026-07-01T12:00:00Z" } })).toMatchObject({
      nextMessagesCursor: { id: "message-x", createdAt: "2026-07-01T12:00:00Z" },
    });
  });

  it("never sends a caller-selected organization id to backed RPCs", async () => {
    const rpc = vi.fn(async (name, args) => ({
      data: name === "get_organization_coordination_snapshot"
        ? snapshot
        : name === "get_organization_coordination_extensions"
          ? { state: "ready", organizationId: "org-1", directory: [], badges: [] }
          : { ok: true, args },
      error: null,
    }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await expect(adapter.load(member)).resolves.toMatchObject({ state: "ready", organizationId: "org-1" });
    await adapter.loadDirectoryExtensions(member);
    await adapter.create(staff, { kind: "mission", title: "A mission" });
    expect(rpc).toHaveBeenNthCalledWith(1, "get_organization_coordination_snapshot", undefined);
    // RPC #2 used to be get_organization_coordination_extensions. The mount now
    // stops at the read-only message page; the extensions projection is reached
    // only through loadDirectoryExtensions, called above on its own.
    expect(rpc).toHaveBeenNthCalledWith(2, "list_organization_coordination_messages", {
      p_before_created_at: null,
      p_before_id: null,
      p_limit: 30,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "get_organization_coordination_extensions", undefined);
    const createCall = rpc.mock.calls.find(([name]) => name === "create_organization_coordination_record");
    expect(createCall).toBeTruthy();
    expect(createCall[1]).not.toHaveProperty("p_organization_id");
    expect(createCall[1]).not.toHaveProperty("organizationId");
  });

  it("uses the selected membership RPC as the authoritative session scope", async () => {
    const rpc = vi.fn(async () => ({ data: [{ selected: true, organizationId: "org-2", chapterId: "chapter-2", organizationRoles: ["admin"], chapterRoles: [] }], error: null }));
    const scope = await loadCoordinationSessionScope({ rpc });
    expect(scope).toEqual({ unavailable: false, organizationId: "org-2", chapterId: "chapter-2", organizationRoles: ["admin"], chapterRoles: [] });
    expect(mergeCoordinationScope(member, scope)).toMatchObject({ selectedOrganizationId: "org-2", membershipStatus: "active" });
  });

  it("keeps session-scope discovery fail closed across unavailable client paths", async () => {
    await expect(loadCoordinationSessionScope(null)).resolves.toEqual({ unavailable: true });
    await expect(loadCoordinationSessionScope({ rpc: vi.fn(async () => ({ data: null, error: new Error("denied") })) })).resolves.toEqual({ unavailable: true });
    await expect(loadCoordinationSessionScope({ rpc: vi.fn(async () => { throw new Error("offline"); }) })).resolves.toEqual({ unavailable: true });
    await expect(loadCoordinationSessionScope({ rpc: vi.fn(async () => ({ data: {}, error: null })) })).resolves.toEqual({
      unavailable: false,
      organizationId: null,
      chapterId: null,
      organizationRoles: [],
      chapterRoles: [],
    });
    // Authority is never inherited, and never invented. With no scope the actor is
    // the one the route mounted with, so it is "pending"; with a discovery that
    // could not answer it is "unconfirmed", NOT a fall back to the prop — a fall
    // back is exactly the unverified organization the deferred directory RPC would
    // have written its 'directory_viewed' row against. Only the server's own answer
    // is "resolved", and only that state may reach the writing projection.
    expect(mergeCoordinationScope(member)).toEqual({ ...member, sessionScope: "pending" });
    expect(mergeCoordinationScope(member, { unavailable: true })).toEqual({ ...member, sessionScope: "unconfirmed" });
    expect(coordinationScopeIsAuthoritative(mergeCoordinationScope(member))).toBe(false);
    expect(coordinationScopeIsAuthoritative(mergeCoordinationScope(member, { unavailable: true }))).toBe(false);
    expect(coordinationScopeIsAuthoritative(mergeCoordinationScope(member, {
      unavailable: false, organizationId: "org-1", chapterId: null, organizationRoles: [], chapterRoles: [],
    }))).toBe(true);
    expect(mergeCoordinationScope(member, { unavailable: false, organizationId: null })).toMatchObject({ membershipStatus: "inactive" });
    expect(createWiredCoordinationAdapter({ rpc: vi.fn() }).requestedRpcs).toBeTruthy();
  });

  it("loads staff completion surfaces in parallel without accepting organization scope", async () => {
    const rpc = vi.fn(async (name, args) => ({
      data: name === "get_organization_coordination_snapshot"
        ? snapshot
        : name === "get_public_chapter_microsite_editor"
          ? { state: "ready", chapterCode: "wor", sections: [], pages: [], attachments: [], takeovers: [] }
          : name === "list_organization_coordination_messages"
            ? { messages: [], nextCursor: null }
            : name === "list_organization_network_access_events" || name === "get_organization_coalition_decisions"
            ? []
            : { state: "ready", organizationId: "org-1" },
      error: null,
      args,
    }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await expect(adapter.load(chapterStaff)).resolves.toMatchObject({
      state: "ready",
      organizationId: "org-1",
      micrositeEditor: { state: "ready", chapterCode: "wor" },
    });
    // Five, not six: the writing extensions projection left the mount.
    expect(rpc).toHaveBeenCalledTimes(5);
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain(COORDINATION_RPCS.extensions);
    expect(rpc).toHaveBeenCalledWith("list_organization_coordination_messages", {
      p_before_created_at: null,
      p_before_id: null,
      p_limit: 30,
    });
    expect(rpc).toHaveBeenCalledWith("list_organization_network_access_events", { p_limit: 50 });
    expect(rpc).toHaveBeenCalledWith("get_public_chapter_microsite_editor", { p_chapter_code: "wor" });
    for (const [, args] of rpc.mock.calls) {
      expect(args || {}).not.toHaveProperty("p_organization_id");
    }
  });

  it("loads older coordination work with an opaque keyset cursor", async () => {
    const rpc = vi.fn(async (name, args) => ({
      data: name === "list_organization_coordination_records"
        ? {
            records: [{ id: "mission-older", kind: "mission", title: "Older mission", status: "completed", visibility: "members", updatedAt: "2026-01-01T00:00:00Z" }],
            nextCursor: null,
          }
        : null,
      error: null,
      args,
    }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await expect(adapter.loadMore(member, { updatedAt: "2026-02-01T00:00:00Z", id: "mission-1" })).resolves.toEqual({
      records: [expect.objectContaining({ id: "mission-older" })],
      nextRecordsCursor: null,
    });
    expect(rpc).toHaveBeenCalledWith("list_organization_coordination_records", {
      p_before_updated_at: "2026-02-01T00:00:00Z",
      p_before_id: "mission-1",
      p_limit: 50,
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_organization_id");
  });

  it("pages message history independently and loads only bounded export payloads", async () => {
    const rpc = vi.fn(async (name, args) => ({
      data: name === "list_organization_coordination_messages"
        ? {
            messages: [{ id: "message-older", conversationId: "conversation-1", body: "Older update", createdAt: "2026-01-01T00:00:00Z" }],
            nextCursor: null,
          }
        : { fileName: "coordination.csv", mimeType: "text/csv", content: "id,title\nrecord-1,Mission" },
      error: null,
      args,
    }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await expect(adapter.loadMoreMessages(member, { createdAt: "2026-02-01T00:00:00Z", id: "message-1" })).resolves.toEqual({
      messages: [expect.objectContaining({ id: "message-older" })],
      nextMessagesCursor: null,
    });
    await expect(adapter.loadExportPayload(staff, "run-1")).resolves.toMatchObject({ fileName: "coordination.csv" });
    expect(rpc).toHaveBeenNthCalledWith(1, "list_organization_coordination_messages", {
      p_before_created_at: "2026-02-01T00:00:00Z",
      p_before_id: "message-1",
      p_limit: 30,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_organization_coordination_export_payload", { p_run_id: "run-1" });
  });

  it("maps every backed coordination intent to its bounded RPC contract", async () => {
    const rpc = vi.fn(async (name, args) => ({ data: { ok: true, name, args }, error: null }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    const intents = [
      ["create", [staff, { kind: "mission", title: "Mission", summary: "Brief", visibility: "members", partnerOrganizationId: "org-2", parentId: "parent-1", chapterId: "wor", config: { targetPoints: 100 }, idempotencyKey: "intent-1" }], "create_organization_coordination_record"],
      ["join", [member, "record-1", "captain", { source: "test" }], "join_organization_coordination_record"],
      ["transition", [member, "record-1", "complete_objective", { config: { note: "done" }, points: 20 }], "transition_organization_coordination_record"],
      ["respond", [staff, "record-1", true], "respond_organization_coordination_invitation"],
      ["message", [member, "conversation-1", "Bounded update"], "send_organization_coordination_message"],
      ["resource", [staff, { recordId: "network-1", kind: "share", title: "Guide", documentId: "document-1" }], "share_organization_coordination_resource"],
      ["runExport", [staff, "schedule-1", "json"], "run_organization_coordination_export"],
      ["loadExportPayload", [staff, "run-1"], "get_organization_coordination_export_payload"],
      ["outreach", [staff, { campaignId: "campaign-1", targetUserId: "member-1", disposition: "reached", note: "Follow up" }], "record_organization_coordination_outreach"],
      ["saveProfile", [staff, { displayName: "Network", summary: "Neighbor", visibility: "directory", contactMode: "coordinator_routed", parentOrganizationId: "org-parent" }], "upsert_organization_network_profile"],
      ["setPermission", [staff, { networkRecordId: "network-1", granteeOrganizationId: "org-2", capability: "message", enabled: true }], "set_organization_network_permission"],
      ["inviteOrganization", [staff, { recordId: "coalition-1", organizationId: "org-2", role: "approver" }], "invite_organization_coordination_participant"],
      ["respondParticipant", [staff, "coalition-1", false], "respond_organization_coordination_participant"],
      ["respondResource", [staff, "resource-1", true], "respond_organization_coordination_resource"],
      ["loadSharedDocument", [staff, "resource-1"], "get_organization_coordination_shared_document"],
      ["assignParticipant", [staff, { recordId: "committee-1", userId: "member-1", role: "committee_member", active: false }], "assign_organization_coordination_participant"],
      ["proposeCoalitionDecision", [staff, { campaignId: "campaign-1", subjectRecordId: "work-1", title: "Approve", rationale: "Quorum", action: "pause_work", requiredApprovals: 2 }], "propose_organization_coalition_decision"],
      ["voteCoalitionDecision", [staff, { decisionId: "decision-1", vote: "approve", comment: "Ready" }], "vote_organization_coalition_decision"],
      ["reviewMergeMatch", [staff, { planId: "plan-1", sourceUserId: "member-1", targetUserId: "member-2", decision: "approved" }], "review_organization_merge_match"],
      ["executeMerge", [staff, { planId: "plan-1", sourceOrganizationId: "org-1", targetOrganizationId: "org-2" }], "execute_organization_merge_plan"],
      ["saveChapterProfile", [staff, { chapterCode: "wor", titleEn: "Worcester", titleEs: "Worcester", bodyEn: "English profile", bodyEs: "Perfil español", published: true }], "upsert_public_chapter_profile"],
      ["saveMicrositeSection", [staff, { chapterCode: "wor", slug: "help", titleEn: "Help", titleEs: "Ayuda", bodyEn: "English", bodyEs: "Español", sortOrder: 2, published: true }], "upsert_public_chapter_microsite_section"],
      ["saveMicrositePage", [staff, { chapterCode: "wor", sectionSlug: "help", slug: "hours", titleEn: "Hours", titleEs: "Horario", bodyEn: "English", bodyEs: "Español", sortOrder: 3, published: true }], "upsert_public_chapter_microsite_page"],
      ["attachPublicPageDocument", [staff, { chapterCode: "wor", sectionSlug: "help", pageSlug: "hours", documentId: "document-1", label: "Guide" }], "attach_public_chapter_page_document"],
      ["takeOverPublicPage", [staff, { chapterCode: "wor", sectionSlug: "help", pageSlug: "hours", reason: "Ownership change" }], "take_over_public_chapter_page"],
      ["recommendCoverage", [member, "wor", "2026-08-28T12:00:00.000Z"], "recommend_organization_coverage"],
    ];
    for (const [method, args, expectedRpc] of intents) {
      await expect(adapter[method](...args)).resolves.toMatchObject({ ok: true, name: expectedRpc });
    }
    expect(rpc).toHaveBeenCalledTimes(intents.length);
    for (const [, args] of rpc.mock.calls) expect(args || {}).not.toHaveProperty("organizationId");
  });

  it("normalizes adapter failures and rejects unauthorized local intents before RPC", async () => {
    for (const [error, state] of [
      [{ code: "PGRST202", message: "missing" }, "unavailable"],
      [{ code: "42883", message: "missing" }, "unavailable"],
      [{ code: "42501", message: "mfa required" }, "mfa_required"],
      [{ code: "42501", message: "denied" }, "unauthorized"],
      [new Error("network"), "error"],
    ]) {
      const adapter = createOrganizationCoordinationAdapter({ rpc: vi.fn(async () => ({ data: null, error })) });
      await expect(adapter.load(member)).resolves.toMatchObject({ state });
    }
    await expect(createOrganizationCoordinationAdapter(null).load(member)).resolves.toMatchObject({ state: "unavailable" });
    const adapter = createOrganizationCoordinationAdapter({ rpc: vi.fn() });
    await expect(adapter.loadMore({}, { id: "x", updatedAt: "now" })).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.loadMore(member, null)).resolves.toEqual({ records: [], nextRecordsCursor: null });
    await expect(adapter.create(member, {})).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.join({}, "x")).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.transition({}, "x", "activate")).rejects.toMatchObject({ code: "42501" });
    await expect(adapter.load({})).resolves.toMatchObject({ state: "empty" });
    for (const [method, args] of [
      ["respond", ["record-1", true]], ["resource", [{}]], ["runExport", ["schedule-1"]],
      ["loadExportPayload", ["run-1"]],
      ["outreach", [{}]], ["saveProfile", [{}]], ["setPermission", [{}]],
      ["inviteOrganization", [{}]], ["respondParticipant", ["record-1", true]],
      ["respondResource", ["resource-1", true]], ["loadSharedDocument", ["resource-1"]],
      ["assignParticipant", [{}]], ["proposeCoalitionDecision", [{}]],
      ["voteCoalitionDecision", [{}]], ["reviewMergeMatch", [{}]], ["executeMerge", [{}]],
      ["saveChapterProfile", [{}]],
      ["saveMicrositeSection", [{}]],
      ["saveMicrositePage", [{}]], ["attachPublicPageDocument", [{}]], ["takeOverPublicPage", [{}]],
    ]) await expect(adapter[method](member, ...args)).rejects.toMatchObject({ code: "42501" });
  });

  it("applies safe defaults for optional adapter payloads", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await adapter.create(staff, { kind: "mission", title: "Mission" });
    await adapter.join(member, "record-1");
    await adapter.transition(member, "record-1", "activate");
    await adapter.respond(staff, "record-1", 0);
    await adapter.resource(staff, { recordId: "network-1", kind: "request", title: "Guide" });
    await adapter.runExport(staff, "schedule-1");
    await adapter.outreach(staff, { campaignId: "campaign-1", targetUserId: "member-1", disposition: "attempted" });
    await adapter.saveProfile(staff, { displayName: "Network" });
    await adapter.setPermission(staff, {});
    await adapter.inviteOrganization(staff, {});
    await adapter.respondParticipant(staff, "record-1", 0);
    await adapter.respondResource(staff, "resource-1", 0);
    await adapter.assignParticipant(staff, {});
    await adapter.proposeCoalitionDecision(staff, {});
    await adapter.voteCoalitionDecision(staff, {});
    await adapter.saveChapterProfile(staff, {});
    await adapter.saveMicrositeSection(staff, {});
    await adapter.saveMicrositePage(staff, {});
    await adapter.recommendCoverage(member, "wor");
    expect(rpc).toHaveBeenCalledTimes(19);
    expect(rpc.mock.calls.at(-1)[1].p_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("mounts read-only: every RPC the desk issues on view is one the acceptance ledger reads", async () => {
    const rpc = vi.fn(async (name, args) => ({
      data: name === COORDINATION_RPCS.snapshot
        ? snapshot
        : name === COORDINATION_RPCS.messagesPage
          ? { messages: [], nextCursor: null }
          : name === COORDINATION_RPCS.micrositeEditor
            ? { state: "ready", chapterCode: "wor", sections: [], pages: [], attachments: [], takeovers: [] }
            : [],
      error: null,
      args,
    }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await expect(adapter.load(chapterStaff)).resolves.toMatchObject({ state: "ready", organizationId: "org-1" });
    const issued = rpc.mock.calls.map(([name]) => name);
    // The mount surface is exactly the read snapshot set it always had, minus the
    // one projection whose SQL INSERTs a 'directory_viewed' access-event row.
    expect(issued).toEqual([...MI1_COORDINATION_DATABASE_DEPENDENCIES.mountRpcs]);
    expect(issued).not.toContain(COORDINATION_RPCS.extensions);
    for (const [name, args] of rpc.mock.calls) expect(classifyRpc(name, args), name).toBe("read");
    // And the deferred one is still the request the runner refuses, which is why
    // it may never be reached by a mount.
    expect(MI1_COORDINATION_DATABASE_DEPENDENCIES.explicitRpcs).toEqual([COORDINATION_RPCS.extensions]);
    expect(classifyRpc(COORDINATION_RPCS.extensions, {})).toBe("block");
  });

  it("loads the deferred projection once per explicit request and normalizes its 11 fields", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        state: "ready",
        organizationId: "org-1",
        directory: [{ organizationId: "org-2", displayName: "Harbor Network", contactMode: "coordinator_routed" }],
        badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }],
        permissions: null,
      },
      error: null,
    }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    const extensions = await adapter.loadDirectoryExtensions(member);
    expect(rpc).toHaveBeenCalledExactlyOnceWith(COORDINATION_RPCS.extensions, undefined);
    expect(extensions.state).toBe("ready");
    expect(extensions.directory).toHaveLength(1);
    for (const field of COORDINATION_EXTENSION_FIELDS) expect(Array.isArray(extensions[field]), field).toBe(true);
    // A projection for another organization, an unreadable actor and a refused
    // call are all answered without merging anything into the desk. An actor who
    // cannot read this organization is refused rather than reported as "empty":
    // no call was made, so claiming the projection loaded would be a lie.
    await expect(adapter.loadDirectoryExtensions({})).resolves.toMatchObject({ state: "unauthorized", directory: [] });
    const foreign = createOrganizationCoordinationAdapter({ rpc: vi.fn(async () => ({ data: { state: "ready", organizationId: "org-2" }, error: null })) });
    await expect(foreign.loadDirectoryExtensions(member)).resolves.toMatchObject({ state: "unauthorized" });
    const denied = createOrganizationCoordinationAdapter({ rpc: vi.fn(async () => ({ data: null, error: Object.assign(new Error("mfa required"), { code: "42501" }) })) });
    await expect(denied.loadDirectoryExtensions(member)).resolves.toMatchObject({ state: "mfa_required" });
  });

  it("keeps the idle request control inside the ready desk body on every tab, in English and Spanish", () => {
    const { container, rerender } = render(<OrganizationCoordinationDesk actor={staff} model={snapshot} status="ready" onShowDirectoryExtensions={() => {}} />);
    for (const tab of visibleCoordinationTabs(staff)) {
      fireEvent.click(screen.getByRole("tab", { name: tab.id === "chapter" ? "Campaign" : tab.label }));
      const control = screen.getByRole("button", { name: "Show partner directory and activity" });
      // Inside the ready .coord-desk body, so the runner's whole-page
      // unavailable selectors cannot match it, and the page keeps its own h1.
      expect(container.querySelector(".coord-desk")).toContainElement(control);
      expect(control.closest("[data-coordination-extensions='idle']")).toBeTruthy();
      expect(container.querySelectorAll(".coord-state, .coord-state-copy:not(.coord-desk .coord-state-copy)")).toHaveLength(0);
      expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["Coordination"]);
      expect(screen.getAllByRole("tab")).toHaveLength(visibleCoordinationTabs(staff).length);
      // It is the idle state, never the "nobody opted in" empty state.
      expect(screen.queryByText(/opted into directory visibility/)).not.toBeInTheDocument();
    }
    rerender(<LanguageProvider lang="es"><OrganizationCoordinationDesk actor={staff} model={snapshot} status="ready" onShowDirectoryExtensions={() => {}} /></LanguageProvider>);
    expect(screen.getByRole("button", { name: "Mostrar el directorio de organizaciones aliadas y la actividad" })).toBeVisible();
  });

  it("loads the partner directory on one explicit click and keeps it across tab switches", async () => {
    const calls = [];
    const rpc = vi.fn(async (name, args) => {
      calls.push({ name, args });
      if (name === "get_my_chapter_memberships") {
        return { data: [{ selected: true, organizationId: "org-1", chapterId: null, organizationRoles: ["coordinator"], chapterRoles: [] }], error: null };
      }
      if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.extensions) {
        return { data: {
          state: "ready",
          organizationId: "org-1",
          directory: [{ organizationId: "org-2", displayName: "Harbor Network", summary: "Neighbor", contactMode: "coordinator_routed" }],
          badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }],
        }, error: null };
      }
      return { data: [], error: null };
    });
    const extensionCalls = () => calls.filter((call) => call.name === COORDINATION_RPCS.extensions).length;
    render(<OrganizationCoordinationView actor={{
      userId: "user-1", organizationId: "org-1", membershipStatus: "active",
      selectedHat: "coordinator", organizationRoles: ["coordinator"], mfaSatisfied: true,
    }} client={{ rpc }} />);
    const showDirectory = await screen.findByRole("button", { name: "Show partner directory and activity" });
    expect(screen.getByRole("heading", { level: 1, name: "Coordination" })).toBeVisible();
    expect(extensionCalls()).toBe(0);
    for (const { name, args } of calls) expect(classifyRpc(name, args), name).toBe("read");

    fireEvent.click(showDirectory);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Mission badges" })).toBeVisible());
    expect(extensionCalls()).toBe(1);

    fireEvent.click(screen.getByRole("tab", { name: "Network" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Organization directory" })).toBeVisible());
    expect(screen.getByText("Harbor Network")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    fireEvent.click(screen.getByRole("tab", { name: "Missions" }));
    expect(screen.getByRole("heading", { name: "Mission badges" })).toBeVisible();
    // One click, one audit row: no tab switch asks the writing projection again.
    expect(extensionCalls()).toBe(1);
    expect(screen.queryByRole("button", { name: "Show partner directory and activity" })).not.toBeInTheDocument();
  });

  it("reopens the explicit request only for a failure that provably never executed", async () => {
    // PGRST202 is PostgREST answering from its schema cache: the function is never
    // called, so no 'directory_viewed' row can exist and one more press is honest.
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return membershipsFor("org-1");
      if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.extensions) {
        return { data: null, error: Object.assign(new Error("could not find the function"), { code: "PGRST202" }) };
      }
      return { data: [], error: null };
    });
    render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    expect(screen.getByRole("heading", { level: 1, name: "Coordination" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(screen.getByText(/temporarily unavailable\. Nothing was recorded/)).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(rpc.mock.calls.filter(([name]) => name === COORDINATION_RPCS.extensions)).toHaveLength(2));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("keeps an ambiguous deferred directory failure latched with no second activation", async () => {
    // The audit insert may already have committed when a generic failure comes
    // back — a dropped connection, a 5xx, a fault raised inside the function body.
    // The RPC carries no idempotency key, so a retry would write a SECOND
    // 'directory_viewed' row for one visit while the copy claimed nothing was
    // recorded. The latch therefore stays closed and the desk asks for a reload.
    expect(COORDINATION_EXTENSIONS_RETRYABLE_STATES).toEqual(["unavailable"]);
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return membershipsFor("org-1");
      if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.extensions) return { data: null, error: Object.assign(new Error("fetch failed"), { code: "500" }) };
      return { data: [], error: null };
    });
    const extensionCalls = () => rpc.mock.calls.filter(([name]) => name === COORDINATION_RPCS.extensions).length;
    const { container } = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(screen.getByText("We could not confirm the result; reload the page to try again.")).toBeVisible());
    expect(screen.getByRole("heading", { level: 3, name: "Partner directory result not confirmed" })).toBeVisible();
    // No control to press, and nothing can re-issue it programmatically either:
    // the panel and the wiring latch read the same contract list.
    expect(screen.queryByRole("button", { name: SHOW_DIRECTORY })).not.toBeInTheDocument();
    expect(extensionCalls()).toBe(1);
    // Still a body panel inside the desk, never a refused whole-page surface.
    expect(container.querySelectorAll(".coord-state, .coord-state-copy")).toHaveLength(0);
    // A tab switch re-renders the whole surface and still offers no second press.
    fireEvent.click(screen.getByRole("tab", { name: "Network" }));
    expect(screen.queryByRole("button", { name: SHOW_DIRECTORY })).not.toBeInTheDocument();
    expect(extensionCalls()).toBe(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("gives each deferred-load failure its own copy and a retry only where one can succeed", async () => {
    // adapter.loadDirectoryExtensions routes every rejection through errorState(),
    // which yields four distinct states — so a surface that only special-cased
    // "error" showed the idle invitation for three real failures and re-offered a
    // control whose next press re-issues the RPC that writes the audit row.
    const reachable = [
      // Pre-execution by construction: PostgREST answers PGRST202 from its schema
      // cache without calling the function, so the audit row cannot exist.
      { error: Object.assign(new Error("could not find the function"), { code: "PGRST202" }), state: "unavailable" },
      { error: Object.assign(new Error("mfa required"), { code: "42501" }), state: "mfa_required" },
      { error: Object.assign(new Error("organization membership required"), { code: "42501" }), state: "unauthorized" },
      { error: Object.assign(new Error("unexpected"), { code: "XX000" }), state: "error" },
      // Ambiguous, and deliberately NOT "unavailable": 42883 and a "does not
      // exist" message can be raised by something the function body itself called,
      // after the 'directory_viewed' insert committed. Only the code PostgREST
      // decides before execution may be treated as provably-not-run.
      { error: Object.assign(new Error("function private.missing() does not exist"), { code: "42883" }), state: "error" },
      { error: Object.assign(new Error("network request failed"), {}), state: "error" },
    ];
    for (const { error, state } of reachable) {
      const adapter = createOrganizationCoordinationAdapter({ rpc: vi.fn(async () => ({ data: null, error })) });
      await expect(adapter.loadDirectoryExtensions(member)).resolves.toMatchObject({ state, directory: [] });
    }

    const onShow = vi.fn();
    const surfaces = [
      // The generic failure is ambiguous, so it states that and keeps no retry.
      { state: "error", title: "Partner directory result not confirmed", body: /could not confirm the result; reload the page/, retry: false },
      { state: "unavailable", title: "Partner directory temporarily unavailable", body: /temporarily unavailable\. Nothing was recorded/, retry: true },
      { state: "mfa_required", title: "Complete two-step sign-in", body: /security check/, retry: false },
      { state: "unauthorized", title: "Directory access stays scoped", body: /not available to the current session/, retry: false },
    ];
    for (const surface of surfaces) {
      const { container, unmount } = render(<CoordinationWorkflowPanels
        tab="missions"
        actor={staff}
        model={snapshot}
        extensions={{ ...EMPTY_COORDINATION_EXTENSIONS, state: surface.state }}
        busy={false}
        onShowDirectoryExtensions={onShow}
        actions={{}}
      />);
      const panel = container.querySelector(`[data-coordination-extensions='${surface.state}']`);
      expect(panel, surface.state).toBeTruthy();
      expect(within(panel).getByRole("heading", { level: 3 }), surface.state).toHaveTextContent(surface.title);
      expect(within(panel).getByText(surface.body), surface.state).toBeVisible();
      // The idle invitation may never stand in for a failure.
      expect(within(panel).queryByText(/load when you ask for them/), surface.state).not.toBeInTheDocument();
      expect(Boolean(within(panel).queryByRole("button", { name: SHOW_DIRECTORY })), surface.state).toBe(surface.retry);
      // Still a body panel inside the desk, never a refused whole-page surface.
      expect(container.querySelectorAll(".coord-state, .coord-state-copy"), surface.state).toHaveLength(0);
      unmount();
    }
    expect(onShow).not.toHaveBeenCalled();

    const staleSurface = render(<CoordinationWorkflowPanels
      tab="missions"
      actor={staff}
      model={snapshot}
      extensions={readyExtensions({ stale: true, badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }] })}
      busy={false}
      onShowDirectoryExtensions={onShow}
      actions={{}}
    />);
    expect(screen.getByText(/Directory may be out of date; reload to refresh/)).toBeVisible();
    expect(screen.queryByRole("button", { name: SHOW_DIRECTORY })).not.toBeInTheDocument();
    expect(staleSurface.container.querySelector("[data-coordination-extensions='ready']").querySelector("button")).toBeNull();
    staleSurface.unmount();
  });

  it("announces the request in place and keeps focus in the panel when a refusal removes the control", () => {
    // The refusals are the only outcomes that delete the control, and the press
    // that earned one left focus on it. Without a focus anchor the browser drops
    // focus to <body>: a keyboard or screen-reader operator is thrown out of the
    // desk at the exact moment the panel is explaining why their request failed.
    for (const [state, title] of [
      ["mfa_required", "Complete two-step sign-in"],
      ["unauthorized", "Directory access stays scoped"],
    ]) {
      const panels = (extensionsState) => <CoordinationWorkflowPanels
        tab="missions"
        actor={staff}
        model={snapshot}
        extensions={{ ...EMPTY_COORDINATION_EXTENSIONS, state: extensionsState }}
        busy={false}
        onShowDirectoryExtensions={() => {}}
        actions={{}}
      />;
      const { container, rerender, unmount } = render(panels("idle"));
      const panel = () => container.querySelector("[data-coordination-extensions]");
      // One panel carries idle, loading and the outcome, so it has to be a live
      // region: the state changes in place and never replaces the page.
      expect(panel(), state).toHaveAttribute("role", "status");
      const idleAnnouncement = panel().textContent;
      const control = screen.getByRole("button", { name: SHOW_DIRECTORY });
      control.focus();
      expect(document.activeElement, state).toBe(control);

      rerender(panels("loading"));
      const loadingControl = screen.getByRole("button", { name: /Loading the partner directory/ });
      // Inert, never `disabled`: a real browser blurs a focused element the moment
      // it is disabled, so the operator who just pressed this would be dropped on
      // <body> mid-load. It stays the same focused node and says why it will not
      // act, which is what aria-disabled plus aria-busy are for.
      expect(loadingControl, state).toBe(control);
      expect(loadingControl, state).not.toBeDisabled();
      expect(loadingControl, state).not.toHaveAttribute("disabled");
      expect(loadingControl, state).toHaveAttribute("aria-disabled", "true");
      expect(loadingControl, state).toHaveAttribute("aria-busy", "true");
      expect(document.activeElement, state).toBe(loadingControl);
      expect(panel().textContent, state).not.toBe(idleAnnouncement);

      rerender(panels(state));
      expect(screen.queryByRole("button", { name: SHOW_DIRECTORY }), state).not.toBeInTheDocument();
      expect(document.activeElement, state).not.toBe(document.body);
      expect(panel(), state).toContainElement(document.activeElement);
      // The anchor is the heading that states the outcome, and it stays out of
      // the tab order so it is a landing place and not a new stop.
      const heading = within(panel()).getByRole("heading", { level: 3 });
      expect(document.activeElement, state).toBe(heading);
      expect(heading, state).toHaveTextContent(title);
      expect(heading, state).toHaveAttribute("tabindex", "-1");
      expect(panel().textContent, state).not.toBe(idleAnnouncement);
      unmount();
    }
  });

  it("keeps the request control focusable and focused across a load outcome, the way a browser runs it", async () => {
    // The browser sequence the component test above cannot stage: jsdom does not
    // blur a focused element when it becomes disabled, but every real browser
    // does. `disabled` on the in-flight control therefore dropped the operator who
    // had just pressed it onto <body>, and for the outcome that KEEPS the control —
    // unavailable — nothing brought them back: the heading anchor only fires on the
    // transition that REMOVES the control, and `offersControl` never changes on
    // that path. The control is inert in place instead, so the focused node is the
    // same node from press to outcome; where the outcome removes the control, focus
    // lands on the anchor in the same panel.
    for (const { outcome, error, title, body, keepsControl } of [
      {
        outcome: "unavailable",
        error: Object.assign(new Error("could not find the function"), { code: "PGRST202" }),
        title: "Partner directory temporarily unavailable",
        body: /temporarily unavailable\. Nothing was recorded/,
        keepsControl: true,
      },
      {
        outcome: "error",
        error: Object.assign(new Error("unexpected"), { code: "XX000" }),
        title: "Partner directory result not confirmed",
        body: /could not confirm the result; reload the page/,
        keepsControl: false,
      },
    ]) {
      let releaseDirectory;
      const held = new Promise((resolve) => { releaseDirectory = resolve; });
      const calls = [];
      const client = {
        rpc: vi.fn(async (name) => {
          calls.push(name);
          if (name === "get_my_chapter_memberships") {
            return { data: [{ selected: true, organizationId: "org-1", chapterId: null, organizationRoles: ["coordinator"], chapterRoles: [] }], error: null };
          }
          if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
          if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
          if (name === COORDINATION_RPCS.extensions) return held;
          return { data: [], error: null };
        }),
      };
      const countOf = (name) => calls.filter((call) => call === name).length;
      const { container, unmount } = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={client} />);
      // Not activatable until get_my_chapter_memberships has answered.
      await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).not.toHaveAttribute("aria-disabled"));
      const panel = () => container.querySelector("[data-coordination-extensions]");
      const control = screen.getByRole("button", { name: SHOW_DIRECTORY });
      control.focus();
      expect(document.activeElement, outcome).toBe(control);

      fireEvent.click(control);
      await waitFor(() => expect(countOf(COORDINATION_RPCS.extensions)).toBe(1));

      // Same node, still in the tab order, still focused, and honest about why it
      // will not act. `disabled` is the attribute that would have moved focus, so
      // its absence is the assertion that matters.
      const loading = screen.getByRole("button", { name: /Loading the partner directory/ });
      expect(loading, outcome).toBe(control);
      expect(loading, outcome).not.toHaveAttribute("disabled");
      expect(loading, outcome).not.toBeDisabled();
      expect(loading, outcome).toHaveAttribute("aria-disabled", "true");
      expect(loading, outcome).toHaveAttribute("aria-busy", "true");
      expect(loading.tabIndex, outcome).toBe(0);
      expect(document.activeElement, outcome).toBe(loading);

      // Focusable is not pressable: a second activation while the RPC is open must
      // issue no second get_organization_coordination_extensions, because that RPC
      // writes a 'directory_viewed' audit row.
      fireEvent.click(loading);
      expect(countOf(COORDINATION_RPCS.extensions), outcome).toBe(1);

      await act(async () => {
        releaseDirectory({ data: null, error });
        await held;
      });

      // The outcome is stated and focus never left the panel at any point in the
      // sequence, whether the outcome kept the control or removed it.
      await waitFor(() => expect(within(panel()).getByRole("heading", { level: 3 })).toHaveTextContent(title));
      expect(within(panel()).getByText(body), outcome).toBeVisible();
      expect(panel(), outcome).toHaveAttribute("data-coordination-extensions", outcome);
      expect(document.activeElement, outcome).not.toBe(document.body);
      expect(panel(), outcome).toContainElement(document.activeElement);
      const retry = screen.queryByRole("button", { name: SHOW_DIRECTORY });
      expect(Boolean(retry), outcome).toBe(keepsControl);
      if (keepsControl) {
        // The same node, pressable again, because this failure provably never ran.
        expect(retry, outcome).toBe(control);
        expect(document.activeElement, outcome).toBe(retry);
        expect(retry, outcome).not.toHaveAttribute("aria-disabled");
        expect(retry, outcome).not.toHaveAttribute("aria-busy");
      } else {
        // The ambiguous outcome removes the control, so the focused node left the
        // document: focus lands on the heading that explains why.
        expect(document.activeElement, outcome).toBe(within(panel()).getByRole("heading", { level: 3 }));
        expect(document.activeElement, outcome).toHaveAttribute("tabindex", "-1");
      }
      expect(countOf(COORDINATION_RPCS.extensions), outcome).toBe(1);
      unmount();
    }
  });

  it("keeps the desk and the focused request control mounted, and says a write is in flight, when session-scope discovery answers under them", async () => {
    // The CI failure behind
    // BUG-UG-MI1-ORGANIZATION-COORDINATION-WEB-CI-LOAD-FLAKE-20260915, staged
    // deterministically instead of raced. The desk mounts and is usable from the
    // actor the route was mounted with, so an operator can already be reading it —
    // and standing on its request control — while get_my_chapter_memberships is
    // still open. useCoordinationActor replaces the scoped actor with that answer,
    // which rebuilds OrganizationCoordinationView's load callback and re-invokes
    // it; when the reload re-entered the page-level "loading" status it took
    // OrganizationCoordinationDesk's `status === "loading"` early return and
    // unmounted the entire ready desk under the operator — the focused control
    // left the document and the browser dropped focus on <body>. A refresh for the
    // scope already on screen must keep it there, and must still say a write is in
    // flight, because suppressing the loading card also suppressed the only answer
    // a press of an in-desk retry used to get.
    let releaseMemberships;
    const held = new Promise((resolve) => { releaseMemberships = resolve; });
    let releaseRefresh;
    const heldRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
    let answered = false;
    const calls = [];
    const client = {
      rpc: vi.fn(async (name) => {
        calls.push(name);
        if (name === "get_my_chapter_memberships") return held;
        // The mount loads answer at once; the reload the discovery answer triggers
        // is held open so the refresh window itself can be asserted.
        if (name === COORDINATION_RPCS.snapshot) return answered ? heldRefresh : { data: snapshot, error: null };
        if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
        return { data: [], error: null };
      }),
    };
    const countOf = (name) => calls.filter((call) => call === name).length;
    const { container } = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={client} />);
    const control = await screen.findByRole("button", { name: SHOW_DIRECTORY });
    const desk = container.querySelector(".coord-desk");
    const title = screen.getByRole("heading", { level: 1 });
    const scopePanel = () => container.querySelector("[data-coordination-scope]");
    // Inert until the discovery answers, focusable the whole time — the operator
    // can be standing on it before the answer lands.
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(scopePanel()).toHaveAttribute("data-coordination-scope", "pending");
    control.focus();
    expect(document.activeElement).toBe(control);
    const loadsBeforeAnswer = countOf(COORDINATION_RPCS.snapshot);

    answered = true;
    await act(async () => {
      releaseMemberships(membershipsFor("org-1"));
      await held;
    });
    // The answer really does reload the desk under the authority it just earned —
    // a repair that kept the control by not reloading at all would fail here.
    await waitFor(() => expect(countOf(COORDINATION_RPCS.snapshot)).toBeGreaterThan(loadsBeforeAnswer));
    await act(async () => {});

    // Mid-refresh: nothing was torn down. The focused node is the same node, in
    // the same desk, and it still holds focus while the reload is open.
    expect(control.isConnected, "the desk must not unmount under the operator").toBe(true);
    expect(container.querySelector(".coord-desk"), "same desk section").toBe(desk);
    expect(screen.getByRole("button", { name: SHOW_DIRECTORY }), "same control node").toBe(control);
    expect(document.activeElement, "focus never leaves the control").toBe(control);
    // The session scope is resolved, so the control is inert for exactly one
    // reason — the desk-wide write this refresh raised. Inert, never `disabled`:
    // the attribute that would move focus in a real browser stays absent.
    expect(scopePanel()).toHaveAttribute("data-coordination-scope", "resolved");
    expect(control, "a suppressed refresh still says a write is in flight").toHaveAttribute("aria-disabled", "true");
    expect(control).not.toHaveAttribute("disabled");
    expect(control).not.toBeDisabled();

    await act(async () => {
      releaseRefresh({ data: snapshot, error: null });
      await heldRefresh;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).not.toHaveAttribute("aria-disabled"));

    // Settled: the write flag is down, the control is pressable, and it is still
    // the same node in the same desk, still focused. Nothing moved.
    expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).toBe(control);
    expect(control.isConnected).toBe(true);
    expect(document.activeElement).toBe(control);
    expect(container.querySelector(".coord-desk")).toBe(desk);
    expect(screen.getByRole("heading", { level: 1 })).toBe(title);
  });

  it("blanks the desk instead of painting one organization's records under another organization's actor", async () => {
    // The other half of the rule above, and the reason the kept desk is keyed on
    // the scope rather than on readiness. mergeCoordinationScope replaces the
    // actor's organizationId with the row get_my_chapter_memberships names as
    // selected, so the very same replacement that resolves the session can also be
    // an organization switch — a member of more than one organization, a stale
    // member projection, a re-authentication in the same tab. The desk derives its
    // tabs and its staff rights from the actor it is given while rendering
    // whatever model is in state, so keeping the previous organization's records
    // on screen for the round trip would render one tenant's data under another
    // tenant's authority. The page-level loading state is what makes that
    // impossible, and a reload for a different scope still takes it.
    const snapshotFor = (organizationId, recordTitle) => ({
      ...snapshot,
      organizationId,
      records: [{ id: `mission-${organizationId}`, kind: "mission", title: recordTitle, status: "active", visibility: "members" }],
      leaderboards: [],
    });
    let releaseMemberships;
    const held = new Promise((resolve) => { releaseMemberships = resolve; });
    let releaseSecondSnapshot;
    const heldSecondSnapshot = new Promise((resolve) => { releaseSecondSnapshot = resolve; });
    let answered = false;
    const calls = [];
    const client = {
      rpc: vi.fn(async (name) => {
        calls.push(name);
        if (name === "get_my_chapter_memberships") return held;
        if (name === COORDINATION_RPCS.snapshot) return answered ? heldSecondSnapshot : { data: snapshotFor("org-1", "Org one mission"), error: null };
        if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
        return { data: [], error: null };
      }),
    };
    const countOf = (name) => calls.filter((call) => call === name).length;
    const { container } = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={client} />);
    await screen.findByText("Org one mission");
    expect(container.querySelector(".coord-desk")).not.toBeNull();
    const loadsBeforeAnswer = countOf(COORDINATION_RPCS.snapshot);

    // The server's answer names a DIFFERENT organization than the prop carried.
    answered = true;
    await act(async () => {
      releaseMemberships(membershipsFor("org-2"));
      await held;
    });
    await waitFor(() => expect(countOf(COORDINATION_RPCS.snapshot)).toBeGreaterThan(loadsBeforeAnswer));
    await act(async () => {});

    // For the whole org-2 round trip there is no desk and no org-1 record — only
    // the loading card, exactly as before this repair.
    expect(container.querySelector(".coord-desk")).toBeNull();
    expect(screen.queryByText("Org one mission")).not.toBeInTheDocument();
    expect(container.querySelector(".coord-state")).toHaveTextContent("Loading organization coordination");

    await act(async () => {
      releaseSecondSnapshot({ data: snapshotFor("org-2", "Org two mission"), error: null });
      await heldSecondSnapshot;
    });
    await waitFor(() => expect(screen.getByText("Org two mission")).toBeVisible());
    expect(screen.queryByText("Org one mission")).not.toBeInTheDocument();
  });

  it("coalesces the mount lifecycle and keeps a ready routed desk through a same-scope refresh failure", async () => {
    // BUG-UG-COORDINATION-READY-ROUTES-COLLAPSE-UNDER-REPEATED-MOUNT-REFRESHES-20260920.
    // A fresh mount used to fan out into three full read sets (pending, an equal
    // pending, resolved), and a same-scope refresh that timed out or failed
    // replaced a ready desk with the whole-page unavailable state, taking the
    // routed tab links with it. Mounted inside the routed coordination shell with
    // membership pending -> resolved, delayed required responses, an optional
    // staff projection failure, and then same-scope refresh failures.
    const priorUrl = window.location.href;
    window.history.replaceState({}, "", "/m/coordination/operations");
    let releaseMemberships;
    const memberships = new Promise((resolve) => { releaseMemberships = resolve; });
    const heldSnapshots = [];
    // "hold" delays the answer until the test releases it, "hang" never answers
    // (so the view's load deadline fires), "error" is a generic RPC failure,
    // "denied" is the server refusing this session.
    let snapshotMode = "hold";
    let failStaffProjection = true;
    const calls = [];
    const client = {
      rpc: vi.fn((name) => {
        calls.push(name);
        if (name === "get_my_chapter_memberships") return memberships;
        if (name === COORDINATION_RPCS.snapshot) {
          if (snapshotMode === "hang") return new Promise(() => {});
          if (snapshotMode === "error") return Promise.resolve({ data: null, error: { code: "XX000", message: "transient" } });
          if (snapshotMode === "denied") return Promise.resolve({ data: null, error: { code: "42501", message: "not a member" } });
          if (snapshotMode === "hold") return new Promise((resolve) => { heldSnapshots.push(() => resolve({ data: snapshot, error: null })); });
          return Promise.resolve({ data: snapshot, error: null });
        }
        if (name === COORDINATION_RPCS.messagesPage) return Promise.resolve({ data: { messages: [], nextCursor: null }, error: null });
        if (name === COORDINATION_RPCS.networkAccessEvents && failStaffProjection) {
          return Promise.resolve({ data: null, error: { code: "XX000", message: "projection down" } });
        }
        return Promise.resolve({ data: [], error: null });
      }),
    };
    const countOf = (name) => calls.filter((call) => call === name).length;
    function Shell() {
      const [location, setLocation] = useState(() => window.location.href);
      return <WorkspacePages view="coordination" hat="admin" location={location} navigate={(_view, path, _state, options = {}) => {
        window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
        setLocation(window.location.href);
      }}>
        <OrganizationCoordinationView actor={VIEW_ACTOR} client={client} loadDeadlineMs={200} />
      </WorkspacePages>;
    }
    const expectReadyRoutedDesk = (container) => {
      expect(container.querySelector(".coord-desk"), "the ready desk stays mounted").not.toBeNull();
      expect(container.querySelectorAll(READY_UNAVAILABLE_SURFACES), "no whole-page loading/unavailable state").toHaveLength(0);
      const tabHrefs = [...container.querySelectorAll('.coord-tabs a[role="tab"]')].map((link) => link.getAttribute("href"));
      expect(tabHrefs).toEqual(expect.arrayContaining([
        "/m/coordination/missions",
        "/m/coordination/coalitions",
        "/m/coordination/operations",
      ]));
      expect(screen.getByRole("tab", { name: "Operations" })).toHaveAttribute("aria-selected", "true");
    };
    try {
      const { container } = render(<Shell />);
      // Mount window: exactly one read set while membership is still pending.
      await waitFor(() => expect(heldSnapshots).toHaveLength(1));
      await act(async () => {});
      expect(countOf(COORDINATION_RPCS.snapshot)).toBe(1);
      expect(countOf(COORDINATION_RPCS.messagesPage)).toBe(1);
      await act(async () => { heldSnapshots.shift()(); });
      await waitFor(() => expect(container.querySelector(".coord-desk")).not.toBeNull());
      // The optional staff projection failure is only the in-desk degraded notice.
      expect(container.querySelector(".coord-notice--degraded")).not.toBeNull();
      expectReadyRoutedDesk(container);

      // Authoritative resolution reloads exactly once, and the desk stays up
      // while that delayed reload is open.
      await act(async () => { releaseMemberships(membershipsFor("org-1")); });
      await waitFor(() => expect(heldSnapshots).toHaveLength(1));
      await act(async () => {});
      expect(countOf(COORDINATION_RPCS.snapshot)).toBe(2);
      expect(countOf(COORDINATION_RPCS.messagesPage)).toBe(2);
      expectReadyRoutedDesk(container);
      await act(async () => { heldSnapshots.shift()(); });
      await act(async () => {});
      expectReadyRoutedDesk(container);

      // Tab navigation is routing, not a reload.
      fireEvent.click(screen.getByRole("tab", { name: "Missions" }));
      await waitFor(() => expect(window.location.pathname).toBe("/m/coordination/missions"));
      fireEvent.click(screen.getByRole("tab", { name: "Operations" }));
      await waitFor(() => expect(window.location.pathname).toBe("/m/coordination/operations"));
      expect(countOf(COORDINATION_RPCS.snapshot)).toBe(2);

      // A later same-scope refresh (the shipped retry on the degraded notice)
      // whose required snapshot never answers hits the load deadline: the desk,
      // its tabs and its links stay, marked stale with a retry.
      snapshotMode = "hang";
      fireEvent.click(screen.getByRole("button", { name: "Load the staff additions again" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh the desk" })).toBeVisible());
      expect(screen.getByText(/could not be refreshed just now/)).toBeVisible();
      expect(countOf(COORDINATION_RPCS.snapshot)).toBe(3);
      expectReadyRoutedDesk(container);

      // A generic failure on the retry is still transient for the same scope.
      snapshotMode = "error";
      fireEvent.click(screen.getByRole("button", { name: "Refresh the desk" }));
      await waitFor(() => expect(countOf(COORDINATION_RPCS.snapshot)).toBe(4));
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Refresh the desk" })).toBeVisible();
      expectReadyRoutedDesk(container);

      // A successful refresh clears the stale state.
      snapshotMode = "ok";
      fireEvent.click(screen.getByRole("button", { name: "Refresh the desk" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh the desk" })).not.toBeInTheDocument());
      expectReadyRoutedDesk(container);

      // The server refusing this session is not transient: it still fails closed.
      snapshotMode = "denied";
      fireEvent.click(screen.getByRole("button", { name: "Load the staff additions again" }));
      await waitFor(() => expect(container.querySelector(".coord-desk")).toBeNull());
      expect(screen.getByText("Coordination stays scoped")).toBeVisible();
    } finally { window.history.replaceState({}, "", priorUrl); }
  });

  it("moves focus to the acknowledgement when a successful response removes the control", () => {
    // The two SUCCESSFUL outcomes replace the request component instead of keeping
    // it, so its own focus-transfer effect cannot run: the focused control left the
    // document and the browser dropped focus on <body>, stranding a keyboard or
    // screen-reader operator at the exact moment their request succeeded. The
    // acknowledgement line is the anchor for both, and it stays a live region.
    for (const { state, extensions, copy } of [
      {
        state: "ready",
        extensions: readyExtensions({ badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }] }),
        copy: "The partner directory and activity loaded.",
      },
      { state: "empty", extensions: { ...EMPTY_COORDINATION_EXTENSIONS, state: "empty" }, copy: /Nothing to show yet/ },
    ]) {
      const panels = (value) => <CoordinationWorkflowPanels
        tab="missions"
        actor={staff}
        model={snapshot}
        extensions={value}
        busy={false}
        onShowDirectoryExtensions={() => {}}
        actions={{}}
      />;
      const { container, rerender, unmount } = render(panels({ ...EMPTY_COORDINATION_EXTENSIONS, state: "idle" }));
      const control = screen.getByRole("button", { name: SHOW_DIRECTORY });
      control.focus();
      rerender(panels({ ...EMPTY_COORDINATION_EXTENSIONS, state: "loading" }));
      // Inert in place, so the press keeps its focus while the RPC is open.
      expect(document.activeElement, state).toBe(control);

      rerender(panels(extensions));
      expect(screen.queryByRole("button", { name: SHOW_DIRECTORY }), state).not.toBeInTheDocument();
      const line = container.querySelector(`[data-coordination-extensions='${state}']`);
      expect(line, state).toHaveAttribute("role", "status");
      expect(line, state).toHaveAttribute("tabindex", "-1");
      expect(line, state).toHaveTextContent(copy);
      expect(document.activeElement, state).not.toBe(document.body);
      expect(document.activeElement, state).toBe(line);
      expect(line.className, state).toContain("coord-muted");
      unmount();
    }

    // And it is an anchor, not a focus thief: an operator who had already moved on
    // keeps their place, because focus is only taken when it is stranded.
    function Surface({ extensions }) {
      return <div>
        <button type="button">Elsewhere</button>
        <CoordinationWorkflowPanels tab="missions" actor={staff} model={snapshot} extensions={extensions} busy={false} onShowDirectoryExtensions={() => {}} actions={{}} />
      </div>;
    }
    const { rerender } = render(<Surface extensions={{ ...EMPTY_COORDINATION_EXTENSIONS, state: "loading" }} />);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(<Surface extensions={readyExtensions()} />);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("acknowledges a ready projection that has nothing for the open tab", () => {
    const { container, rerender } = render(<CoordinationWorkflowPanels tab="chapter" actor={staff} model={snapshot} extensions={readyExtensions()} busy={false} onShowDirectoryExtensions={() => {}} actions={{}} />);
    // Proved on the chapter tab, which renders none of the projection's fields: a
    // ready load used to unmount the request panel and leave nothing behind, so
    // the operator could not tell whether their request had loaded at all.
    const line = container.querySelector("[data-coordination-extensions='ready']");
    expect(line).toHaveTextContent("Nothing to show yet");
    expect(line.className).toContain("coord-muted");
    expect(container.querySelectorAll(".coord-state, .coord-state-copy")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: SHOW_DIRECTORY })).not.toBeInTheDocument();

    // A tab that does render a field of the projection says nothing extra.
    rerender(<CoordinationWorkflowPanels tab="missions" actor={staff} model={snapshot} extensions={readyExtensions({ badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }] })} busy={false} onShowDirectoryExtensions={() => {}} actions={{}} />);
    expect(screen.getByRole("heading", { name: "Mission badges" })).toBeVisible();
    expect(screen.queryByText(/Nothing to show yet/)).not.toBeInTheDocument();

    // An empty one acknowledges itself.
    rerender(<CoordinationWorkflowPanels tab="missions" actor={staff} model={snapshot} extensions={readyExtensions()} busy={false} onShowDirectoryExtensions={() => {}} actions={{}} />);
    expect(screen.getByText(/Nothing to show yet/)).toBeVisible();

    // The network tab's directory panel already states its own emptiness on a
    // ready load, so the acknowledgement must not double it.
    rerender(<CoordinationWorkflowPanels tab="network" actor={staff} model={snapshot} extensions={readyExtensions()} busy={false} onShowDirectoryExtensions={() => {}} actions={{}} />);
    expect(screen.getByText("No organizations have opted into directory visibility.")).toBeVisible();
    expect(screen.queryByText(/Nothing to show yet/)).not.toBeInTheDocument();

    // An answered-but-empty projection is an answer too: it acknowledges itself
    // and does not re-offer the writing request.
    rerender(<CoordinationWorkflowPanels tab="chapter" actor={staff} model={snapshot} extensions={{ ...EMPTY_COORDINATION_EXTENSIONS, state: "empty" }} busy={false} onShowDirectoryExtensions={() => {}} actions={{}} />);
    expect(container.querySelector("[data-coordination-extensions='empty']")).toHaveTextContent("Nothing to show yet");
    expect(screen.queryByRole("button", { name: SHOW_DIRECTORY })).not.toBeInTheDocument();
  });

  it("covers every coordination mutation intent with an explicit refresh decision", () => {
    const source = readFileSync(resolve(process.cwd(), "src/views/OrganizationCoordinationView.jsx"), "utf8");
    const callSites = [...source.matchAll(/\brun\("([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(callSites.sort()).toEqual(Object.keys(COORDINATION_MUTATION_EXTENSION_TOUCH).sort());
    expect(new Set(callSites).size).toBe(callSites.length);
    for (const [intent, fields] of Object.entries(COORDINATION_MUTATION_EXTENSION_TOUCH)) {
      expect(Array.isArray(fields), intent).toBe(true);
      for (const field of fields) {
        expect(COORDINATION_EXTENSION_FIELDS, `${intent} -> ${field}`).toContain(field);
      }
    }
    // Outreach writes organization_coordination_outreach_events; the extensions
    // projection derives mobilizationProgress by counting those rows.
    expect(COORDINATION_MUTATION_EXTENSION_TOUCH.outreach).toEqual(["mobilizationProgress"]);
  });

  // DEBT-UG-COORDINATION-PAGE-ATTACHMENT-DEAD-WIRING-20260920. The desk used
  // to hand CoordinationWorkflowPanels an `onAttachPageDocument` and an
  // `onTakeOverPage` callback that no panel destructured and no rest spread
  // forwarded, so two adapter mutations, two contract RPCs and the
  // `pageAttachments` extension field they declared they touched were carried,
  // authorized and tested while no product surface could reach them. A rendering
  // test cannot see that: a prop nothing reads renders nothing either way, and a
  // panel that never receives it never throws. Only the source says whether the
  // wiring lands, so both ends are read and matched here.
  it("gives every panel callback a consuming panel and refuses an extension field no tab renders", () => {
    const deskSource = readFileSync(resolve(process.cwd(), "src/features/coordination/ui/OrganizationCoordinationDesk.jsx"), "utf8");
    const panelsSource = readFileSync(resolve(process.cwd(), "src/features/coordination/ui/CoordinationWorkflowPanels.jsx"), "utf8");

    const actionsBlock = deskSource.match(/actions=\{\{([\s\S]*?)\n\s*\}\}/);
    expect(actionsBlock, "actions object literal in OrganizationCoordinationDesk").not.toBeNull();
    const actionLines = actionsBlock[1].split("\n").map((line) => line.trim()).filter(Boolean);
    // Shorthand only, so this parse cannot silently miss a key a future edit adds.
    for (const line of actionLines) expect(line, "actions entry").toMatch(/^on[A-Za-z]+,$/);
    const actionKeys = actionLines.map((line) => line.slice(0, -1));
    expect(actionKeys.length).toBeGreaterThan(0);
    expect(new Set(actionKeys).size).toBe(actionKeys.length);

    // Every callback any panel component destructures out of its own props. The
    // panels take explicit prop lists and no rest spread, so a name missing here
    // is a name the `{...actions}` spread drops on the floor.
    const consumed = new Set();
    for (const [, params] of panelsSource.matchAll(/function\s+[A-Za-z]+\(\{([^}]*)\}\)\s*\{/g)) {
      for (const [, name] of params.matchAll(/(?:^|[\s,])(on[A-Za-z]+)\s*(?=[,=]|$)/gm)) consumed.add(name);
    }
    expect(consumed.size).toBeGreaterThan(0);
    for (const key of actionKeys) {
      expect([...consumed], `${key} reaches no panel`).toContain(key);
    }

    // The per-tab map of what the projection actually renders, read from the same
    // file, so "rendered by a tab" is the file's own answer and not a copy.
    const tabFieldsBlock = panelsSource.match(/const TAB_EXTENSION_FIELDS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
    expect(tabFieldsBlock, "TAB_EXTENSION_FIELDS in CoordinationWorkflowPanels").not.toBeNull();
    const renderedFields = new Set([...tabFieldsBlock[1].matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]));
    for (const field of renderedFields) expect(COORDINATION_EXTENSION_FIELDS, field).toContain(field);

    // pageAttachments is either rendered by a tab or declared nowhere: in the
    // field list, in any intent's touch list, in the empty projection the desk
    // merges, in the RPC map or on the adapter. Building the chapter surface
    // later satisfies the first branch and this test stops asking for the second.
    if (!renderedFields.has("pageAttachments")) {
      const adapter = createOrganizationCoordinationAdapter({ rpc: vi.fn() });
      expect(COORDINATION_EXTENSION_FIELDS).not.toContain("pageAttachments");
      expect(Object.values(COORDINATION_MUTATION_EXTENSION_TOUCH).flat()).not.toContain("pageAttachments");
      expect(EMPTY_COORDINATION_EXTENSIONS).not.toHaveProperty("pageAttachments");
      expect(Object.keys(COORDINATION_RPCS)).not.toContain("attachPageDocument");
      expect(Object.keys(COORDINATION_RPCS)).not.toContain("takeOverPage");
      expect(adapter.attachPageDocument).toBeUndefined();
      expect(adapter.takeOverPage).toBeUndefined();
    }
  });

  it("recovers an unconfirmed session scope from an in-app retry without writing an audit row", async () => {
    let memberships = 0;
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") {
        memberships += 1;
        if (memberships === 1) return { data: null, error: new Error("offline") };
        return membershipsFor("org-1");
      }
      if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.extensions) {
        return { data: { state: "ready", organizationId: "org-1", badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }] }, error: null };
      }
      return { data: [], error: null };
    });
    const countOf = (name) => rpc.mock.calls.filter((call) => call[0] === name).length;
    const { container } = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    await waitFor(() => expect(container.querySelector("[data-coordination-scope]")).toHaveAttribute("data-coordination-scope", "unconfirmed"));
    const directory = screen.getByRole("button", { name: SHOW_DIRECTORY });
    expect(directory).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/Confirm the organization again, or reload the page/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm the organization again" }));
    await waitFor(() => expect(container.querySelector("[data-coordination-scope]")).toHaveAttribute("data-coordination-scope", "resolved"));
    expect(countOf("get_my_chapter_memberships")).toBe(2);
    expect(countOf(COORDINATION_RPCS.extensions)).toBe(0);
    await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByRole("button", { name: "Confirm the organization again" })).not.toBeInTheDocument();
  });

  it("keeps the scope retry fail closed when discovery fails again", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: null, error: new Error("offline") };
      if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.extensions) return { data: { state: "ready", organizationId: "org-1" }, error: null };
      return { data: [], error: null };
    });
    const countOf = (name) => rpc.mock.calls.filter((call) => call[0] === name).length;
    const { container } = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    await waitFor(() => expect(container.querySelector("[data-coordination-scope]")).toHaveAttribute("data-coordination-scope", "unconfirmed"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm the organization again" }));
    await waitFor(() => expect(countOf("get_my_chapter_memberships")).toBe(2));
    // The retry answers by REPLACING the scoped actor object, and the view's
    // load() is a useCallback over that actor: a scope change therefore re-runs
    // it, and its first statement is setStatus("loading"), which takes the
    // desk's early return. The panel carrying [data-coordination-scope] is
    // absent from the container for that window, which is exactly what this
    // line read on Main run 35035618936 (job 104605690671): `received value
    // must be an HTMLElement`, `Received has value: null`. The preceding wait
    // had already cleared, so its deadline was never the problem.
    //
    // Bounded at five seconds on the assertion that actually failed. It cannot
    // mask a scope that wrongly resolves: this client refuses
    // get_my_chapter_memberships on every call, so "unconfirmed" is the only
    // value the attribute can ever hold — and the two fail-closed assertions
    // below stay synchronous.
    await waitFor(() => expect(container.querySelector("[data-coordination-scope]"))
      .toHaveAttribute("data-coordination-scope", "unconfirmed"), { timeout: 5_000 });
    expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).toHaveAttribute("aria-disabled", "true");
    expect(countOf(COORDINATION_RPCS.extensions)).toBe(0);
  });

  it("discards a scope retry whose actor was superseded while it was in flight", async () => {
    // retryScope used to complete with the actor captured at the press, with no
    // check that the actor or client was still the current run. A later
    // organization switch whose own discovery finished first was then overwritten,
    // which re-enabled the directory control under the obsolete organization.
    const seen = [];
    let api = null;
    function ActorProbe({ client: nextClient, actor }) {
      const hook = useCoordinationActor(nextClient, actor);
      seen.push({
        organizationId: hook.actor.selectedOrganizationId,
        sessionScope: hook.actor.sessionScope,
      });
      api = hook;
      return null;
    }
    const pending = [];
    let memberships = 0;
    const scopedClient = {
      rpc: vi.fn(async (name) => {
        if (name !== "get_my_chapter_memberships") return { data: null, error: null };
        memberships += 1;
        if (memberships === 1) return { data: null, error: new Error("offline") };
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        pending.push({ held, release });
        return held;
      }),
    };
    const actorFor = (organizationId) => ({
      userId: "user-1",
      organizationId,
      membershipStatus: "active",
      selectedHat: "coordinator",
      organizationRoles: ["coordinator"],
      mfaSatisfied: true,
    });

    const { rerender } = render(<ActorProbe client={scopedClient} actor={actorFor("org-1")} />);
    await waitFor(() => expect(seen.at(-1).sessionScope).toBe("unconfirmed"));

    act(() => { void api.retryScope(); });
    await waitFor(() => expect(pending).toHaveLength(1));

    // Phase 1 — the newer discovery finishes first, then the stale retry lands.
    rerender(<ActorProbe client={scopedClient} actor={actorFor("org-2")} />);
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1].release(membershipsFor("org-2"));
      await pending[1].held;
    });
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ organizationId: "org-2", sessionScope: "resolved" }));

    await act(async () => {
      pending[0].release(membershipsFor("org-1"));
      await pending[0].held;
    });
    expect(seen.at(-1)).toMatchObject({ organizationId: "org-2", sessionScope: "resolved" });
    expect(seen.filter((entry) => entry.sessionScope === "resolved" && entry.organizationId === "org-1")).toHaveLength(0);

    // Phase 2 — the tight turn. A new retry is held, then org-3 is committed and
    // the stale answer is released on the next statement. The run identity is
    // established during render so this window cannot write the superseded
    // organization's resolved scope onto org-3.
    act(() => { void api.retryScope(); });
    await waitFor(() => expect(pending).toHaveLength(3));
    const afterOrgTwo = seen.length;
    flushSync(() => { rerender(<ActorProbe client={scopedClient} actor={actorFor("org-3")} />); });
    pending[2].release(membershipsFor("org-1"));
    await act(async () => { await pending[2].held; });
    expect(seen.slice(afterOrgTwo).some((entry) => entry.organizationId === "org-1")).toBe(false);
    expect(seen.filter((entry) => entry.sessionScope === "resolved" && entry.organizationId === "org-1")).toHaveLength(0);
  });

  it("speaks the unconfirmed scope retry in Spanish", () => {
    render(<LanguageProvider lang="es"><CoordinationWorkflowPanels
      tab="missions"
      actor={{ ...staff, sessionScope: "unconfirmed" }}
      model={snapshot}
      extensions={EMPTY_COORDINATION_EXTENSIONS}
      busy={false}
      onShowDirectoryExtensions={() => {}}
      onRetryScope={() => {}}
      actions={{}}
    /></LanguageProvider>);
    expect(screen.getByText(/Confirma la organización de nuevo, o vuelve a cargar la página/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirmar la organización de nuevo" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mostrar el directorio de organizaciones aliadas y la actividad" })).toHaveAttribute("aria-disabled", "true");
  });

  it("speaks the directory staleness line in Spanish", () => {
    render(<LanguageProvider lang="es"><CoordinationWorkflowPanels
      tab="chapter"
      actor={staff}
      model={snapshot}
      extensions={readyExtensions({ stale: true })}
      busy={false}
      onShowDirectoryExtensions={() => {}}
      actions={{}}
    /></LanguageProvider>);
    expect(screen.getByText(/El directorio puede no estar actualizado/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Mostrar el directorio/ })).not.toBeInTheDocument();
  });

  it("speaks every deferred-projection outcome in Spanish", () => {
    for (const [state, text] of [
      ["idle", /se cargan cuando tú lo solicitas/],
      ["loading", /Cargando el directorio de organizaciones aliadas/],
      ["error", /No pudimos confirmar el resultado/],
      ["unavailable", /no están disponibles temporalmente/],
      ["mfa_required", /Completa el inicio de sesión en dos pasos/],
      ["unauthorized", /El acceso al directorio permanece limitado/],
      ["ready", /Todavía no hay nada que mostrar/],
      ["empty", /Todavía no hay nada que mostrar/],
    ]) {
      const { unmount } = render(<LanguageProvider lang="es"><CoordinationWorkflowPanels
        tab="chapter"
        actor={staff}
        model={snapshot}
        extensions={{ ...EMPTY_COORDINATION_EXTENSIONS, state }}
        busy={false}
        onShowDirectoryExtensions={() => {}}
        actions={{}}
      /></LanguageProvider>);
      expect(screen.getByText(text), state).toBeVisible();
      unmount();
    }
  });

  it("does not re-offer the deferred request when the backend refused it", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") {
        return { data: [{ selected: true, organizationId: "org-1", chapterId: null, organizationRoles: ["coordinator"], chapterRoles: [] }], error: null };
      }
      if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.extensions) return { data: null, error: Object.assign(new Error("mfa required"), { code: "42501" }) };
      return { data: [], error: null };
    });
    render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Complete two-step sign-in" })).toBeVisible());
    // A refusal the same request would earn again: no retry control, and the
    // latch in the wiring stays closed, so nothing writes a second audit row.
    expect(screen.queryByRole("button", { name: SHOW_DIRECTORY })).not.toBeInTheDocument();
    expect(rpc.mock.calls.filter(([name]) => name === COORDINATION_RPCS.extensions)).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["Coordination"]);
  });

  it("scopes the one-request latch to the organization and user, not the actor object", () => {
    const mounted = coordinationExtensionsScope(buildCoordinationActor(VIEW_ACTOR));
    // Session scope resolving a chapter is the same projection for the same user.
    expect(coordinationExtensionsScope(buildCoordinationActor({ ...VIEW_ACTOR, chapterId: "wor" }))).toBe(mounted);
    expect(coordinationExtensionsScope(mergeCoordinationScope(VIEW_ACTOR, {
      unavailable: false, organizationId: "org-1", chapterId: "wor", organizationRoles: ["coordinator"], chapterRoles: [],
    }))).toBe(mounted);
    // A different organization or a different user is not, and must reset.
    expect(coordinationExtensionsScope(buildCoordinationActor({ ...VIEW_ACTOR, organizationId: "org-2" }))).not.toBe(mounted);
    expect(coordinationExtensionsScope(buildCoordinationActor({ ...VIEW_ACTOR, userId: "user-2" }))).not.toBe(mounted);
  });

  it("refuses the deferred request until session scope is authoritative, then latches it across re-resolution", async () => {
    // get_organization_coordination_extensions takes no organization argument: it
    // resolves one from private.current_member_organization() and INSERTs a
    // 'directory_viewed' row for THAT organization before the answer can be
    // compared with the actor. So a press made while the desk still holds the
    // organization the route was MOUNTED with could record an audit row for a
    // different organization and only then be told "unauthorized". Until
    // get_my_chapter_memberships answers, the control is therefore explained and
    // inert, and the load path refuses: zero calls, nothing recorded.
    let resolveMemberships;
    const memberships = new Promise((resolve) => { resolveMemberships = resolve; });
    const calls = [];
    const rpc = vi.fn(async (name, args) => {
      calls.push({ name, args });
      // useCoordinationActor replaces the scoped actor object when this answers,
      // which is the second identity the latch used to reset on.
      if (name === "get_my_chapter_memberships") return memberships;
      if (name === COORDINATION_RPCS.snapshot) return { data: snapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.extensions) {
        return { data: { state: "ready", organizationId: "org-1", badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }] }, error: null };
      }
      return { data: [], error: null };
    });
    const countOf = (name) => calls.filter((call) => call.name === name).length;
    // One client object for both renders: a new client is a new adapter, which is a
    // different projection and is entitled to its own request.
    const client = { rpc };
    const { container, rerender } = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={client} />);
    // The desk mounts read-only from the actor prop, before memberships answered.
    await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).toBeVisible());
    const pending = screen.getByRole("button", { name: SHOW_DIRECTORY });
    // Still focusable and still in the tab order — a disabled attribute would blur
    // the operator who reached it — but announced as unavailable, explained in the
    // same live-region panel, and it does not act.
    expect(pending).not.toHaveAttribute("disabled");
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending.tabIndex).toBe(0);
    expect(container.querySelector("[data-coordination-scope]")).toHaveAttribute("data-coordination-scope", "pending");
    expect(screen.getByText(/Confirming which organization this session belongs to/)).toBeVisible();
    pending.focus();
    fireEvent.click(pending);
    fireEvent.click(pending);
    // One mount read set: the mount window's equal pending actor is coalesced
    // instead of issuing a second, identical load.
    await waitFor(() => expect(countOf(COORDINATION_RPCS.snapshot)).toBe(1));
    // The press wrote nothing and asked nothing: no audit row exists for an
    // organization this session has not been told it belongs to.
    expect(countOf(COORDINATION_RPCS.extensions)).toBe(0);
    expect(document.activeElement).toBe(pending);
    expect(countOf(COORDINATION_RPCS.micrositeEditor)).toBe(0);

    // Session scope lands. The control becomes pressable in place, and one press
    // issues exactly one call.
    await act(async () => { resolveMemberships(membershipsFor("org-1")); });
    await waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByText(/load when you ask for them/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Mission badges" })).toBeVisible());
    expect(countOf(COORDINATION_RPCS.extensions)).toBe(1);

    // A new actor prop re-runs discovery: the scoped actor object is replaced twice
    // more and the whole read-only snapshot reloads for the resolved chapter — the
    // microsite-editor read is the proof it took effect, since it is only issued
    // once a chapter is known. Same organization, same user: the same projection,
    // so the one-request-per-visit latch must hold and the control must not return.
    rerender(<OrganizationCoordinationView actor={{ ...VIEW_ACTOR, chapterId: "wor" }} client={client} />);
    await waitFor(() => expect(countOf(COORDINATION_RPCS.micrositeEditor)).toBe(1));
    expect(screen.queryByRole("button", { name: SHOW_DIRECTORY })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mission badges" })).toBeVisible();
    expect(countOf(COORDINATION_RPCS.extensions)).toBe(1);
  });

  it("drops a deferred directory response whose organization changed while it was in flight", async () => {
    // The latch's guard used to be "still mounted", and a scope change does not
    // unmount this desk. A get_organization_coordination_extensions call issued
    // for org-1 therefore resolved after the actor prop had already become org-2
    // and wrote org-1's directory rows onto org-2's desk, then latched them there
    // so org-2 was never offered its own request. The run identity is the fix.
    //
    // That identity is also established during render rather than in the reset
    // effect, so the comparison is synchronous with the scope change it guards.
    // Phase 2 below drives the switch and the stale answer as close together as
    // this harness can put them. It is an invariant pin, not a reproduction: React
    // flushes the new scope's passive effects ahead of the awaited promise's
    // continuation in every sequence available here, so phase 2 is also green
    // against an effect-maintained guard. Both phases do fail if the guard is
    // removed, which is what they are here to prevent.
    const pending = [];
    let organizationId = "org-1";
    const calls = [];
    const client = {
      rpc: vi.fn(async (name) => {
        calls.push(name);
        // Discovery confirms whatever organization the prop currently names, so the
        // prop is still the only scope this test moves — and every press below is
        // made against an authoritative scope, which is the only state the deferred
        // request is offered in at all.
        if (name === "get_my_chapter_memberships") return membershipsFor(organizationId);
        if (name === COORDINATION_RPCS.snapshot) return { data: { ...snapshot, organizationId }, error: null };
        if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
        if (name === COORDINATION_RPCS.extensions) {
          let release;
          const held = new Promise((resolve) => { release = resolve; });
          pending.push({ held, release });
          return held;
        }
        return { data: [], error: null };
      }),
    };
    // The answer the superseded run would have written, tagged with the scope it
    // was actually issued for.
    const answerFor = (org) => ({
      data: {
        state: "ready",
        organizationId: org,
        badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }],
        directory: [{ organizationId: "org-9", displayName: "Harbor Network", contactMode: "coordinator_routed" }],
      },
      error: null,
    });
    const countOf = (name) => calls.filter((call) => call === name).length;
    const deskFor = (org) => <OrganizationCoordinationView actor={{ ...VIEW_ACTOR, organizationId: org }} client={client} />;
    const idlePanel = () => container.querySelector("[data-coordination-extensions='idle']");
    // Pressable only once discovery has confirmed the organization; aria-disabled
    // dropping is that confirmation landing.
    const activatable = () => waitFor(() => expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).not.toHaveAttribute("aria-disabled"));
    const { container, rerender } = render(deskFor("org-1"));
    await activatable();
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(countOf(COORDINATION_RPCS.extensions)).toBe(1));

    // Phase 1 — the loose window. The operator switches organizations while that
    // call is still open and the answer lands turns later. Same client, so the
    // adapter is untouched: only the scope moved.
    organizationId = "org-2";
    rerender(deskFor("org-2"));
    await activatable();
    await waitFor(() => expect(idlePanel()).toBeTruthy());

    await act(async () => {
      pending[0].release(answerFor("org-1"));
      await pending[0].held;
    });

    // org-1's rows never reach org-2's desk, and org-2 still owns its own request:
    // the latch the stale answer would have closed was not org-1's to close.
    expect(screen.queryByRole("heading", { name: "Mission badges" })).not.toBeInTheDocument();
    expect(screen.queryByText("Harbor Network")).not.toBeInTheDocument();
    expect(idlePanel()).toBeTruthy();
    expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).toBeVisible();
    // And no second writing RPC was issued behind the operator's back.
    expect(countOf(COORDINATION_RPCS.extensions)).toBe(1);

    // Phase 2 — the tight turn. org-2's own press is honoured, and then the switch
    // to org-3 and org-2's answer are put in the same turn: the org-3 render is
    // committed and the held RPC is released on the very next statement, so the
    // response resolves in the microtask immediately behind that commit.
    await activatable();
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(countOf(COORDINATION_RPCS.extensions)).toBe(2));
    organizationId = "org-3";
    // flushSync commits the org-3 render immediately but leaves its passive effects
    // queued, so releasing the held RPC on the next line puts org-2's answer in the
    // microtask right after that commit — before any effect for org-3 has run. This
    // is the window a macrotask guard cannot close.
    flushSync(() => { rerender(deskFor("org-3")); });
    pending[1].release(answerFor("org-2"));
    await act(async () => { await pending[1].held; });

    expect(screen.queryByRole("heading", { name: "Mission badges" })).not.toBeInTheDocument();
    expect(screen.queryByText("Harbor Network")).not.toBeInTheDocument();
    await waitFor(() => expect(idlePanel()).toBeTruthy());
    expect(screen.getByRole("button", { name: SHOW_DIRECTORY })).toBeVisible();
    expect(countOf(COORDINATION_RPCS.extensions)).toBe(2);

    // org-3's own press is honoured and is the only one the latch now holds.
    await activatable();
    fireEvent.click(screen.getByRole("button", { name: SHOW_DIRECTORY }));
    await waitFor(() => expect(countOf(COORDINATION_RPCS.extensions)).toBe(3));
  });

  it("evaluates the deferred-response guard synchronously with the scope change, not one effect later", async () => {
    // The desk's DOM cannot show a superseded write at all: the reset effect for the
    // new scope lands right behind it and clears it, so the leak would be a flash
    // rather than a residue. What IS observable is every value the hook returned,
    // render by render, which is what this probe records from the render phase. The
    // assertion is the invariant the guard owes: no answer issued for org-1's scope
    // is ever rendered into org-2's projection, not even for the one render a reset
    // would have overwritten a tick later. The guard is evaluated synchronously in
    // the source so the invariant does not depend on effect-versus-microtask
    // ordering; this test cannot distinguish the two orderings, but it does fail if
    // the guard goes away.
    const seen = [];
    let api = null;
    function DirectoryProbe({ adapter, actor }) {
      const hook = useCoordinationDirectoryExtensions(adapter, actor);
      // Recorded in the render phase on purpose: an effect would only see the value
      // that survived, and the defect is about the one that did not.
      seen.push(hook.extensions);
      api = hook;
      return null;
    }

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const adapter = { loadDirectoryExtensions: vi.fn(() => held) };
    // Both authoritative: this test is about the response guard, not the scope gate.
    const orgOne = buildCoordinationActor({ ...VIEW_ACTOR, sessionScope: "resolved" });
    const orgTwo = buildCoordinationActor({ ...VIEW_ACTOR, organizationId: "org-2", sessionScope: "resolved" });
    expect(coordinationExtensionsScope(orgOne)).not.toBe(coordinationExtensionsScope(orgTwo));

    const { rerender } = render(<DirectoryProbe adapter={adapter} actor={orgOne} />);
    await act(async () => { api.loadExtensions(); });
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(1);
    expect(seen.at(-1).state).toBe("loading");

    // flushSync commits the org-2 render but leaves its passive effects queued, so
    // the release on the next line lands in the microtask immediately after that
    // commit — the window an effect-maintained guard is still one turn behind in.
    flushSync(() => { rerender(<DirectoryProbe adapter={adapter} actor={orgTwo} />); });
    release({
      ...EMPTY_COORDINATION_EXTENSIONS,
      state: "ready",
      organizationId: "org-1",
      badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }],
    });
    await act(async () => { await held; });

    // org-1's answer was never rendered onto org-2's projection, not even for the
    // render that a reset effect would have overwritten a tick later.
    expect(seen.filter((value) => value.state === "ready")).toHaveLength(0);
    expect(seen.some((value) => (value.badges || []).length > 0)).toBe(false);
    expect(seen.at(-1)).toEqual({ ...EMPTY_COORDINATION_EXTENSIONS });
    // And org-2's own request is still open to it: the stale answer closed no latch.
    await act(async () => { api.loadExtensions(); });
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(2);
  });

  it("returns the idle projection on the very first render under a new tenant scope", async () => {
    // The reset used to live in a passive effect, so a projection that had already
    // RESOLVED for org-1 was still in state when the actor became org-2: React
    // rendered and committed org-1's directory, invitations, badges and activity
    // under org-2's actor for at least one render — another tenant's data on screen
    // — and that render also reported state "ready", which suppressed org-2's own
    // request control. The stored projection now carries the scope it was loaded
    // for and the returned value is derived from it during render, so there is no
    // window to be one render behind in. This probe records the value render by
    // render, which is the only place the defect was ever observable.
    const seen = [];
    let api = null;
    function DirectoryProbe({ adapter, actor }) {
      const hook = useCoordinationDirectoryExtensions(adapter, actor);
      seen.push({ scope: coordinationExtensionsScope(actor), value: hook.extensions });
      api = hook;
      return null;
    }
    const loaded = {
      ...EMPTY_COORDINATION_EXTENSIONS,
      state: "ready",
      organizationId: "org-1",
      badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }],
      invitations: [{ recordId: "coalition-1", title: "Regional coalition" }],
    };
    const adapter = { loadDirectoryExtensions: vi.fn(async () => loaded) };
    const orgOne = buildCoordinationActor({ ...VIEW_ACTOR, sessionScope: "resolved" });
    const orgTwo = buildCoordinationActor({ ...VIEW_ACTOR, organizationId: "org-2", sessionScope: "resolved" });

    const { rerender } = render(<DirectoryProbe adapter={adapter} actor={orgOne} />);
    await act(async () => { await api.loadExtensions(); });
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(1);
    expect(seen.at(-1).value.state).toBe("ready");
    expect(seen.at(-1).value.badges).toHaveLength(1);

    const firstUnderOrgTwo = seen.length;
    rerender(<DirectoryProbe adapter={adapter} actor={orgTwo} />);
    // The FIRST render under org-2 — before any effect of that render has run.
    expect(seen[firstUnderOrgTwo].scope).toBe(coordinationExtensionsScope(orgTwo));
    expect(seen[firstUnderOrgTwo].value).toEqual({ ...EMPTY_COORDINATION_EXTENSIONS });
    // And every render under org-2 after it: org-1's rows never appear once, and
    // no render claims "ready", which is what re-offers org-2 its own request.
    for (const entry of seen.slice(firstUnderOrgTwo)) {
      expect(entry.scope).toBe(coordinationExtensionsScope(orgTwo));
      expect(entry.value.state).toBe("idle");
      expect(entry.value.badges).toHaveLength(0);
      expect(entry.value.invitations).toHaveLength(0);
    }
    // org-2's own request is open to it: nothing was latched on its behalf.
    await act(async () => { await api.loadExtensions(); });
    expect(adapter.loadDirectoryExtensions).toHaveBeenCalledTimes(2);
  });

  it("tells staff a coalition vote governs draft campaign work", () => {
    // A coalition_work_item card suppresses Activate and Complete on purpose
    // (record.kind === "coalition_work_item"), which used to leave the action
    // row empty with nothing said: staff read a draft campaign work item as
    // stalled or as a missing permission. The card now carries the reason, and
    // it must carry it on its own — the panel that explains the vote mounts
    // only when the organization already has an active or paused campaign.
    const records = [
      { id: "coalition-1", kind: "coalition", title: "Statewide coalition", status: "active", visibility: "participants", organizationId: "org-1" },
      { id: "campaign-1", parentId: "coalition-1", kind: "coalition_campaign", title: "Joint campaign", status: "active", visibility: "participants", organizationId: "org-1" },
      { id: "work-draft", parentId: "campaign-1", kind: "coalition_work_item", title: "Draft field action", status: "draft", visibility: "participants", organizationId: "org-1" },
      { id: "work-paused", parentId: "campaign-1", kind: "coalition_work_item", title: "Paused field action", status: "paused", visibility: "participants", organizationId: "org-1" },
      { id: "work-active", parentId: "campaign-1", kind: "coalition_work_item", title: "Active field action", status: "active", visibility: "participants", organizationId: "org-1" },
    ];
    render(<OrganizationCoordinationDesk actor={staff} model={{ ...snapshot, records, leaderboards: [] }} status="ready" />);
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    const panel = within(screen.getByRole("tabpanel"));
    const cardFor = (title) => panel.getByRole("heading", { level: 3, name: title }).closest("article");
    const explanation = /approval decision governs this campaign work/i;

    for (const title of ["Draft field action", "Paused field action"]) {
      const card = within(cardFor(title));
      expect(card.queryByRole("button", { name: "Activate" }), title).not.toBeInTheDocument();
      expect(card.queryByRole("button", { name: "Publish" }), title).not.toBeInTheDocument();
      expect(card.queryByRole("button", { name: "Complete" }), title).not.toBeInTheDocument();
      // and the card names where the decision is taken, not the form's fields.
      expect(card.getByText(explanation), title).toBeVisible();
    }
    // An active work item keeps the same rule: still no unilateral control.
    const activeCard = within(cardFor("Active field action"));
    expect(activeCard.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    // The campaign card of the same tab still offers its own staff control, so
    // the suppression above is the coalition-vote rule and not a dead action row.
    expect(within(cardFor("Joint campaign")).getByRole("button", { name: "Complete" })).toBeInTheDocument();
    // and the decision path the copy names is the one this tab mounts.
    expect(panel.getByRole("heading", { name: "Open an approval decision" })).toBeVisible();
  });

  it("keeps partner-owned transition controls hidden as a client-only honesty boundary", () => {
    // Coalition membership makes a partner org's coalition and coalition_campaign
    // readable to this org's staff (private.organization_coordination_can_read),
    // but this client-side guard is not the server authorization boundary. The
    // missing transition RPC ownership predicate is tracked by the separate SEC
    // record and its hosted-window repair; until then, the UI must stay honest.
    const partnerOwnedCoalition = { id: "coalition-a", kind: "coalition", title: "Partner coalition", status: "active", visibility: "participants", organizationId: "org-2" };
    const partnerOwnedCampaign = { id: "campaign-a", kind: "coalition_campaign", parentId: "coalition-a", title: "Partner campaign draft", status: "draft", visibility: "participants", organizationId: "org-2" };
    const ownCoalition = { id: "coalition-b", kind: "coalition", title: "Own coalition", status: "active", visibility: "participants", organizationId: "org-1" };
    const model = { ...snapshot, records: [partnerOwnedCoalition, partnerOwnedCampaign, ownCoalition] };
    render(<OrganizationCoordinationDesk actor={staff} model={model} status="ready" />);
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    const panel = within(screen.getByRole("tabpanel"));
    const partnerCoalitionCard = panel.getByRole("heading", { level: 3, name: "Partner coalition" }).closest("article");
    const partnerCampaignCard = panel.getByRole("heading", { level: 3, name: "Partner campaign draft" }).closest("article");
    const ownCard = panel.getByRole("heading", { level: 3, name: "Own coalition" }).closest("article");
    expect(within(partnerCoalitionCard).queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    expect(within(partnerCampaignCard).queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
    expect(within(ownCard).getByRole("button", { name: "Complete" })).toBeInTheDocument();
    // invite_organization_coordination_participant requires owner/approver on the
    // coalition, so the Invite picker lists only this org's own coalitions.
    const inviteSelect = within(panel.getByRole("heading", { name: "Invite an organization" }).closest("section")).getByRole("combobox", { name: "Coalition" });
    expect(within(inviteSelect).queryByRole("option", { name: "Partner coalition" })).not.toBeInTheDocument();
    expect(within(inviteSelect).getByRole("option", { name: "Own coalition" })).toBeInTheDocument();
  });

  it("hides Invite an organization when only a partner-owned coalition is readable", () => {
    const partnerOwnedCoalition = { id: "coalition-a", kind: "coalition", title: "Partner coalition", status: "active", visibility: "participants", organizationId: "org-2" };
    render(<OrganizationCoordinationDesk actor={staff} model={{ ...snapshot, records: [partnerOwnedCoalition] }} status="ready" />);
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    const panel = within(screen.getByRole("tabpanel"));
    expect(panel.getByRole("heading", { level: 3, name: "Partner coalition" })).toBeInTheDocument();
    expect(panel.queryByRole("heading", { name: "Invite an organization" })).not.toBeInTheDocument();
  });

  it("offers Join only while a joinable record is active or invited", () => {
    // join_organization_coordination_record selects `where r.status in
    // ('active', 'invited')` and refuses every other status with "coordination
    // record unavailable" — a completed/closed/draft record must not offer Join.
    const records = [
      { id: "mission-draft", kind: "mission", title: "Draft drive", status: "draft", visibility: "members", organizationId: "org-1" },
      { id: "mission-active", kind: "mission", title: "Active drive", status: "active", visibility: "members", organizationId: "org-1" },
      { id: "mission-completed", kind: "mission", title: "Completed drive", status: "completed", visibility: "members", organizationId: "org-1" },
      { id: "mission-closed", kind: "mission", title: "Closed drive", status: "closed", visibility: "members", organizationId: "org-1" },
    ];
    render(<OrganizationCoordinationDesk actor={member} model={{ ...snapshot, records, leaderboards: [] }} status="ready" />);
    const cardFor = (title) => screen.getByRole("heading", { level: 3, name: title }).closest("article");
    expect(within(cardFor("Draft drive")).queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
    expect(within(cardFor("Active drive")).getByRole("button", { name: "Join" })).toBeInTheDocument();
    expect(within(cardFor("Completed drive")).queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
    expect(within(cardFor("Closed drive")).queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
  });

  it("offers a network parent only while the link is active and its capability is granted", () => {
    // validate_organization_coordination_record_shape refuses a network child
    // whose parent link is not 'active' ("network work requires an active
    // network link"), and then refuses it again with 42501 unless the two
    // organizations hold the capability the kind needs — 'message' for a
    // conversation, 'resource_request' for a request. Both refusals land after
    // the operator has filled the whole form in, so neither parent is offered.
    const link = (id, title, status) => ({ id, kind: "network_link", title, status, visibility: "participants", organizationId: "org-1", partnerOrganizationId: "org-2" });
    const records = [
      link("link-message", "Message link", "active"),
      link("link-request", "Request link", "active"),
      link("link-revoked", "Revoked link", "active"),
      link("link-pending", "Pending link", "requested"),
    ];
    const extensions = readyExtensions({
      permissions: [
        { id: "grant-1", networkRecordId: "link-message", capability: "message", status: "active" },
        { id: "grant-2", networkRecordId: "link-request", capability: "resource_request", status: "active" },
        { id: "grant-3", networkRecordId: "link-revoked", capability: "message", status: "revoked" },
        { id: "grant-4", networkRecordId: "link-pending", capability: "message", status: "active" },
      ],
    });
    const model = { ...snapshot, records, leaderboards: [] };
    const creator = () => within(screen.getByLabelText("Create coordination work"));
    const parentOptions = () => within(creator().getByLabelText("Parent workspace")).getAllByRole("option").map((option) => option.textContent);
    const { rerender } = render(<OrganizationCoordinationDesk actor={staff} model={model} extensions={extensions} status="ready" />);
    fireEvent.click(screen.getByRole("tab", { name: "Network" }));

    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "network_conversation" } });
    expect(parentOptions()).toEqual(["Choose a parent", "Message link"]);
    fireEvent.change(creator().getByLabelText("Parent workspace"), { target: { value: "link-message" } });
    // Changing the workflow strands that choice: the request kind needs its own
    // grant, so the conversation's parent is neither offered nor carried over.
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "network_request" } });
    expect(parentOptions()).toEqual(["Choose a parent", "Request link"]);
    expect(creator().getByLabelText("Parent workspace")).toHaveValue("");

    // Grants arrive only with the deferred projection, so an idle load is
    // unknown, not "no grants": every ACTIVE link stays offered, and the status
    // half of the guard — which the mount snapshot does answer — still holds.
    rerender(<OrganizationCoordinationDesk actor={staff} model={model} status="ready" />);
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "network_conversation" } });
    expect(parentOptions()).toEqual(["Choose a parent", "Message link", "Request link", "Revoked link"]);

    // A known answer with no eligible link says so instead of an empty required
    // select, in the reader's language.
    rerender(<OrganizationCoordinationDesk actor={staff} model={model} extensions={readyExtensions({ permissions: [] })} status="ready" />);
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "network_conversation" } });
    expect(creator().queryByLabelText("Parent workspace")).not.toBeInTheDocument();
    expect(creator().getByText(translate("en", "coordination.creatorNoNetworkParent"))).toBeVisible();
    expect(translate("es", "coordination.creatorNoNetworkParent")).not.toBe(translate("en", "coordination.creatorNoNetworkParent"));
  });

  it("renders an honest zero-organization state", () => {
    render(<OrganizationCoordinationDesk actor={{}} model={null} status="empty" />);
    expect(screen.getByRole("heading", { name: "No organization yet" })).toBeVisible();
    expect(screen.getByText(/starts empty/i)).toBeVisible();
  });

  it("keeps staff-only areas out of the member surface and exposes mission participation", () => {
    const onJoin = vi.fn();
    render(<OrganizationCoordinationDesk actor={member} model={snapshot} status="ready" onJoin={onJoin} />);
    expect(screen.queryByRole("tab", { name: "Coalitions" })).not.toBeInTheDocument();
    expect(screen.queryByText("Create backed coordination work")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ id: "mission-1" }));
    // Mission participation is shown; a ranking of participants is not.
    expect(screen.queryByText("Member A13F")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /leaderboard/i })).toBeNull();
  });

  // Union Ground has no mission
  // leaderboards. It has no points economy, and ranking workers by activity
  // would show management who the most active organizers are. The inert
  // snapshot RPC may still return per-mission rows; the client drops them and
  // no hat, tab or language renders a ranking.
  describe("no mission leaderboards", () => {
    const missionRows = (missionIndex, count) => Array.from({ length: count }, (_, index) => ({
      alias: `M${missionIndex}-${String(index + 1).padStart(3, "0")}`,
      points: 1000 - index,
      status: "active",
    }));
    const boards = Array.from({ length: 15 }, (_, index) => ({
      missionId: `mission-${index + 1}`,
      title: `Mission ${index + 1}`,
      status: index < 10 ? "active" : "completed",
      participantCount: index === 0 ? 340 : 12,
      rows: missionRows(index + 1, index === 0 ? 100 : 12),
    }));
    const model = { ...snapshot, leaderboards: boards };

    it.each([["staff", staff], ["member", member]])("renders no ranking on the Missions tab for a %s hat", (_label, actor) => {
      for (const lang of ["en", "es"]) {
        const { unmount } = render(<LanguageProvider lang={lang}><OrganizationCoordinationDesk actor={actor} model={model} status="ready" /></LanguageProvider>);
        expect(screen.getByText(lang === "es" ? "1 registro" : "1 record")).toBeVisible();
        expect(screen.queryByRole("region", { name: /Mission leaderboards|Clasificaciones de las misiones/ })).toBeNull();
        expect(screen.queryAllByRole("heading").filter((heading) => /leaderboard|Clasificaci[oó]n/i.test(heading.textContent))).toEqual([]);
        expect(screen.queryByRole("columnheader", { name: /Points|Puntos|Participant|Participante/ })).toBeNull();
        expect(screen.queryByText(/Completed missions|Misiones terminadas/)).toBeNull();
        expect(screen.queryByText("M1-001")).not.toBeInTheDocument();
        expect(document.querySelector(".coord-board, .coord-leaderboards, details.coord-board")).toBeNull();
        unmount();
      }
    });

    it("drops the projection's points rows from the client model", () => {
      const normalized = normalizeCoordinationSnapshot(model, staff);
      expect(normalized.state).toBe("ready");
      expect(normalized).not.toHaveProperty("leaderboards");
      expect(JSON.stringify(normalized)).not.toContain("M1-001");
      expect(EMPTY_COORDINATION_SNAPSHOT).not.toHaveProperty("leaderboards");
    });

    it("ships no leaderboard component, styles or copy", () => {
      expect(existsSync(resolve(process.cwd(), "src/features/coordination/ui/MissionLeaderboards.jsx"))).toBe(false);
      const desk = readFileSync(resolve(process.cwd(), "src/features/coordination/ui/OrganizationCoordinationDesk.jsx"), "utf8");
      expect(desk).not.toMatch(/MissionLeaderboards|leaderboards/);
      const css = readFileSync(resolve(process.cwd(), "src/features/coordination/ui/organizationCoordination.css"), "utf8");
      expect(css).not.toMatch(/coord-leaderboards|coord-board\b/);
      for (const lang of ["en", "es"]) {
        expect(Object.keys(catalogue[lang]).filter((key) => /leaderboard/i.test(key)), lang).toEqual([]);
      }
    });
  });

  it("keeps a member hat on the coordination desk from the /m/network alias", async () => {
    const priorUrl = window.location.href;
    window.history.replaceState({}, "", "/m/network?demo=1");
    function MemberDesk() {
      const [location, setLocation] = useState(() => window.location.href);
      return <WorkspacePages view="coordination" hat="member" location={location} navigate={(nextView, path, _, options = {}) => {
        expect(nextView).toBe("coordination");
        window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
        setLocation(window.location.href);
      }}>
        <OrganizationCoordinationDesk actor={member} model={snapshot} status="ready" />
      </WorkspacePages>;
    }
    try {
      render(<MemberDesk />);
      await waitFor(() => expect(window.location.pathname).toBe("/m/network"));
      expect(window.location.search).toBe("?demo=1");
      expect(screen.getByText("Worker view")).toBeVisible();
      expect(screen.getByRole("tab", { name: "Network" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByRole("tab", { name: "Coalitions" })).not.toBeInTheDocument();
    } finally { window.history.replaceState({}, "", priorUrl); }
  });

  it("keeps one page heading when a focused coordination tab has no records", () => {
    const priorUrl = window.location.href;
    window.history.replaceState({}, "", "/m/coordination/missions");
    try {
      render(<WorkspacePages view="coordination" location="/m/coordination/missions" navigate={() => {}}>
        <OrganizationCoordinationDesk actor={staff} model={{ ...snapshot, records: [], leaderboards: [] }} status="ready" />
      </WorkspacePages>);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByRole("heading", { name: "Nothing in Missions yet", level: 2 })).toBeVisible();
    } finally { window.history.replaceState({}, "", priorUrl); }
  });

  it("exposes all explicit loading, recovery, security, and empty states", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<OrganizationCoordinationDesk actor={staff} model={null} status="loading" />);
    const heading = screen.getByRole("heading", { level: 1, name: "Coordination" });
    const expectPageHeading = () => expect(screen.getAllByRole("heading", { level: 1 })).toEqual([heading]);
    expectPageHeading();
    expect(screen.getByRole("status")).toHaveTextContent("Loading organization coordination");
    rerender(<OrganizationCoordinationDesk actor={staff} model={null} status="error" onRetry={onRetry} />);
    expectPageHeading();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<OrganizationCoordinationDesk actor={staff} model={null} status="unavailable" />);
    expectPageHeading();
    expect(screen.getByRole("heading", { name: "Coordination is unavailable", level: 2 })).toBeVisible();
    rerender(<OrganizationCoordinationDesk actor={staff} model={null} status="mfa_required" />);
    expectPageHeading();
    expect(screen.getByRole("heading", { name: "Complete two-step sign-in", level: 2 })).toBeVisible();
    rerender(<OrganizationCoordinationDesk actor={staff} model={null} status="unauthorized" />);
    expectPageHeading();
    expect(screen.getByRole("heading", { name: "Coordination stays scoped", level: 2 })).toBeVisible();
    rerender(<OrganizationCoordinationDesk actor={staff} model={null} status="empty" />);
    expectPageHeading();
    expect(screen.getByRole("heading", { name: "No organization yet", level: 2 })).toBeVisible();
    rerender(<OrganizationCoordinationDesk actor={staff} model={{ state: "ready" }} status="ready" />);
    expectPageHeading();
    expect(screen.getByRole("heading", { name: "No organization yet", level: 2 })).toBeVisible();
    rerender(<OrganizationCoordinationDesk actor={staff} model={snapshot} status="ready" />);
    expectPageHeading();
  });

  it("speaks the whole desk header — loading line, eyebrow, title, intro and scope badge — in Spanish", () => {
    // Every string in the header block was an English literal on every
    // language, while the desk body around it was already translated
    // (UX-UG-WEB-COORDINATION-DESK-CHROME-ENGLISH-ONLY). The record's
    // verification line is "rendering the desk in Spanish shows no English
    // chrome literals", so each assertion below has an absence twin.
    const { rerender, unmount } = render(<LanguageProvider lang="es"><OrganizationCoordinationDesk actor={staff} model={null} status="loading" /></LanguageProvider>);
    const heading = screen.getByRole("heading", { level: 1, name: "Coordinación" });
    expect(screen.getByRole("status")).toHaveTextContent("Cargando la coordinación de la organización");
    rerender(<LanguageProvider lang="es"><OrganizationCoordinationDesk actor={staff} model={snapshot} status="ready" /></LanguageProvider>);
    expect(screen.getByText("Coordina el trabajo colectivo")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Coordinación" })).toBe(heading);
    expect(screen.getByText(/Las misiones, el trabajo con organizaciones aliadas/)).toBeVisible();
    expect(screen.getByText("Controles del personal")).toBeVisible();
    expect(screen.queryByText("Organization network")).not.toBeInTheDocument();
    expect(screen.queryByText("Coordinate collective work")).not.toBeInTheDocument();
    expect(screen.queryByText(/share one authorized history/)).not.toBeInTheDocument();
    expect(screen.queryByText("Staff controls")).not.toBeInTheDocument();
    unmount();
    render(<LanguageProvider lang="es"><OrganizationCoordinationDesk actor={member} model={snapshot} status="ready" /></LanguageProvider>);
    expect(screen.getByRole("heading", { level: 1, name: "Red de la organización" })).toBeVisible();
    expect(screen.getByText("Vista de trabajador")).toBeVisible();
    expect(screen.queryByText("Worker view")).not.toBeInTheDocument();
  });

  it("keeps the desk header out of hard-coded English", () => {
    // OrganizationCoordinationDesk.jsx is not in tests/i18n-coverage.test.jsx's
    // TRANSLATED_VIEWS, so nothing else in the repository stops the five header
    // strings from being written back as literals. Comments are stripped first,
    // the way that file does it, so a comment naming a retired literal is not
    // mistaken for one.
    const source = readFileSync(resolve(process.cwd(), "src/features/coordination/ui/OrganizationCoordinationDesk.jsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const literal of [
      "Loading organization coordination",
      "Organization network",
      "Coordinate collective work",
      "share one authorized history",
      "Staff controls",
      "Worker view",
    ]) {
      expect(source, literal).not.toContain(literal);
    }
  });

  // UX-UG-COORDINATION-DESK-BODY-ENGLISH-ONLY-20260920: below the Spanish
  // header the tabs, kind badges, card actions, creator and composers, record
  // count, empty-tab copy, paging, leaderboard and whole-page states were all
  // English literals. The workflow panels are a separate surface and are not
  // read here.
  describe("the desk body in Spanish", () => {
    const FORBIDDEN = [
      /\bMissions\b/, /\bNetwork\b/, /\bChapter\b/, /\bJoin\b/, /\bActivate\b/, /\bComplete\b/,
      /Nothing in Missions yet/, /\brecords\b/, /Load older work/, /Coordination areas/, /Try again/,
      /Create backed coordination work/, /Send a participant message/, /Record outreach/, /leaderboard/,
    ];
    const esRecords = [
      { id: "mission-1", kind: "mission", title: "Misión compartida", status: "active", visibility: "members", organizationId: "org-1" },
      { id: "objective-1", parentId: "mission-1", kind: "mission_objective", title: "Meta", status: "draft", visibility: "members", organizationId: "org-1" },
      { id: "link-1", kind: "network_link", title: "Enlace", status: "active", visibility: "participants", organizationId: "org-1" },
      { id: "invite-1", kind: "network_link", title: "Invitación", status: "requested", visibility: "participants", organizationId: "org-2", partnerOrganizationId: "org-1" },
      { id: "conversation-1", parentId: "link-1", kind: "network_conversation", title: "Charla", status: "active", visibility: "participants" },
      { id: "export-1", kind: "network_export_schedule", title: "Exportación", status: "active", visibility: "staff", organizationId: "org-1" },
      { id: "page-1", kind: "microsite_page", title: "Página", status: "draft", visibility: "staff", organizationId: "org-1" },
      { id: "mobilize-1", kind: "mobilization_campaign", title: "Movilización", status: "paused", visibility: "staff", organizationId: "org-1" },
    ];
    const esModel = { ...snapshot, records: esRecords, leaderboards: [{ missionId: "mission-1", title: "Misión compartida", rows: [{ alias: "Miembro A13F", points: 20, status: "active" }] }], directory: [], resources: [], micrositeEditor: { state: "missing" }, nextRecordsCursor: { updatedAt: "2026-08-01", id: "mission-1" } };
    const deskText = () => [
      ...document.querySelectorAll(".coord-tabs, .coord-section-head, .coord-card, .coord-aside, .coord-form--compact, .coord-table-card, .coord-page-actions, .coord-state-copy"),
    ].map((node) => node.textContent).join(" | ");

    it("renders tabs, cards, creator, composers, count and paging in Spanish on every tab, and no leaderboard", () => {
      render(<LanguageProvider lang="es"><OrganizationCoordinationDesk actor={chapterStaff} model={esModel} status="ready" onLoadMore={vi.fn()} onOutreach={vi.fn(async () => true)} onMessage={vi.fn(async () => true)} /></LanguageProvider>);
      expect(screen.getByRole("tablist", { name: "Áreas de coordinación" })).toBeVisible();
      expect(screen.getByRole("complementary", { name: "Crear trabajo de coordinación" })).toBeVisible();
      expect(screen.getByText("2 registros")).toBeVisible();
      expect(screen.getByRole("button", { name: "Unirme" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Cargar trabajo anterior" })).toBeVisible();
      // The model still carries a points row; no ranking renders in Spanish either.
      expect(screen.queryByRole("heading", { name: "Clasificación de Misión compartida" })).toBeNull();
      expect(screen.queryByRole("columnheader", { name: "Participante" })).toBeNull();
      expect(screen.queryByText("Miembro A13F")).not.toBeInTheDocument();
      expect(screen.getByText("Misión", { selector: ".coord-badge" })).toBeVisible();
      expect(screen.getByText("activo", { selector: ".coord-status" })).toBeVisible();
      for (const [tab, check] of [
        ["Misiones", () => expect(screen.getByRole("button", { name: "Activar" })).toBeVisible()],
        ["Red", () => {
          expect(screen.getByRole("button", { name: "Aceptar" })).toBeVisible();
          expect(screen.getByRole("heading", { name: "Envía un mensaje a participantes" })).toBeVisible();
        }],
        ["Operaciones", () => expect(screen.getByRole("button", { name: "Ejecutar exportación" })).toBeVisible()],
        ["Campaña", () => expect(screen.getByRole("button", { name: "Publicar" })).toBeVisible()],
        ["Movilizar", () => {
          expect(screen.getByRole("heading", { name: "Registrar contacto" })).toBeVisible();
          expect(screen.getByRole("option", { name: "seguimiento" })).toBeInTheDocument();
        }],
        ["Coaliciones", () => expect(screen.getByRole("heading", { name: "Todavía no hay contenido en Coaliciones", level: 2 })).toBeVisible()],
      ]) {
        fireEvent.click(screen.getByRole("tab", { name: tab }));
        check();
        expect(screen.getByRole("heading", { name: "Crea trabajo de coordinación registrado" })).toBeVisible();
        const text = deskText();
        for (const pattern of FORBIDDEN) expect(text, `${tab}: ${pattern}`).not.toMatch(pattern);
      }
      expect(screen.getByLabelText("Flujo de trabajo")).toBeVisible();
      expect(screen.getByText("Todavía no hay contenido en Coaliciones").closest(".coord-state-copy")).toHaveTextContent("Aquí se puede crear el primer registro.");
    });

    it("renders every whole-page state in Spanish, with a Spanish retry", () => {
      const onRetry = vi.fn();
      const esDesk = (props) => <LanguageProvider lang="es"><OrganizationCoordinationDesk actor={staff} model={null} {...props} /></LanguageProvider>;
      const { rerender } = render(esDesk({ status: "error", onRetry }));
      expect(screen.getByRole("heading", { name: "La coordinación no está disponible" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(onRetry).toHaveBeenCalledOnce();
      expect(deskText()).not.toMatch(/Try again|unavailable/);
      rerender(esDesk({ status: "unavailable" }));
      expect(screen.getByText("No se pudo cargar la información registrada de la organización.")).toBeVisible();
      rerender(esDesk({ status: "mfa_required" }));
      expect(screen.getByRole("heading", { name: "Completa el inicio de sesión en dos pasos" })).toBeVisible();
      expect(deskText()).not.toMatch(/two-step|security check/);
      rerender(esDesk({ status: "unauthorized" }));
      expect(screen.getByRole("heading", { name: "La coordinación tiene un alcance limitado" })).toBeVisible();
      expect(deskText()).not.toMatch(/stays scoped|current session/);
      rerender(esDesk({ status: "ready", model: { state: "ready" } }));
      expect(screen.getByRole("heading", { name: "Todavía no hay organización" })).toBeVisible();
      expect(deskText()).not.toMatch(/No organization yet|starts empty/);
    });

    it("keeps the English wording it rendered before the catalogue move", () => {
      render(<OrganizationCoordinationDesk actor={chapterStaff} model={esModel} status="ready" onLoadMore={vi.fn()} />);
      expect(screen.getByRole("tablist", { name: "Coordination areas" })).toBeVisible();
      expect(screen.getByRole("complementary", { name: "Create coordination work" })).toBeVisible();
      expect(screen.getByText("2 records")).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Misión compartida leaderboard" })).toBeNull();
      expect(screen.getByText("Mission", { selector: ".coord-badge" })).toBeVisible();
      expect(screen.getByText("active", { selector: ".coord-status" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Load older work" })).toBeVisible();
      fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
      expect(screen.getByRole("heading", { name: "Nothing in Coalitions yet", level: 2 })).toBeVisible();
      fireEvent.click(screen.getByRole("tab", { name: "Mobilize" }));
      expect(screen.getByRole("option", { name: "follow up" })).toBeInTheDocument();
    });

    // BUG-UG-WEB-COORDINATION-STATUS-PILLS-OVERFLOW-CARDS-20261002:
    // in the two-up card grid the kind and status pills did not fit one line,
    // and the head did not wrap, so the kind pill folded inside itself and the
    // status pill ran past (or was clipped by) the card border on the network
    // and operations tabs.
    it("lets a card head wrap so each kind and status pill stays one line inside its card", () => {
      const unmountStyles = mountStylesheets("src/styles.css", "src/features/coordination/ui/organizationCoordination.css");
      try {
        render(<OrganizationCoordinationDesk actor={chapterStaff} model={esModel} status="ready" onLoadMore={vi.fn()} />);
        for (const tab of ["Missions", "Network", "Operations"]) {
          fireEvent.click(screen.getByRole("tab", { name: tab }));
          const heads = [...document.querySelectorAll(".coord-card__head")];
          expect(heads.length, tab).toBeGreaterThan(0);
          for (const head of heads) {
            expect(getComputedStyle(head).flexWrap, tab).toBe("wrap");
            const pills = [...head.querySelectorAll(":scope > .coord-badge, :scope > .coord-status")];
            expect(pills, tab).toHaveLength(2);
            for (const pill of pills) {
              expect(getComputedStyle(pill).whiteSpace).toBe("nowrap");
              expect(getComputedStyle(pill).maxWidth).toBe("100%");
            }
          }
        }
      } finally {
        unmountStyles();
      }
    });

    it("keeps the desk body out of hard-coded English", () => {
      const source = readFileSync(resolve(process.cwd(), "src/features/coordination/ui/OrganizationCoordinationDesk.jsx"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const literal of [
        "const LABELS", "Coordination is unavailable", "Complete two-step sign-in", "Coordination stays scoped",
        "No organization yet", "Coordination areas", "Create coordination work", "Create backed coordination work",
        "Load older work", " records<", "leaderboard<", "Send a participant message", "Record outreach",
        "Choose a parent", ">Join<", ">Complete<", ">Accept<", ">Decline<", "\"Try again\"", ">Try again<",
      ]) {
        expect(source, literal).not.toContain(literal);
      }
    });
  });

  // UX-UG-WEB-COORDINATION-WORKFLOW-PANELS-ENGLISH-ONLY-20260920: the working
  // body of every tab reads the catalogue, so a Spanish session sees no English
  // panel copy, and English copy may not come back as JSX literals.
  describe("the workflow panels in Spanish", () => {
    const admin = buildCoordinationActor({ ...staff, selectedHat: "admin", organizationRoles: ["admin"], chapterId: "wor" });
    const panelModel = {
      ...snapshot,
      records: [
        { id: "link-1", kind: "network_link", title: "Enlace", status: "active", visibility: "participants", organizationId: "org-1" },
        { id: "coalition-1", kind: "coalition", title: "Coalición norte", status: "active", visibility: "participants", organizationId: "org-1" },
        { id: "campaign-1", parentId: "coalition-1", kind: "coalition_campaign", title: "Campaña", status: "active", visibility: "participants", organizationId: "org-1" },
        { id: "plan-1", kind: "merger_plan", title: "Plan de fusión", status: "active", visibility: "staff", organizationId: "org-2", partnerOrganizationId: "org-1" },
      ],
      resources: [{ id: "resource-1", title: "Guía", kind: "share", status: "accepted", toOrganizationId: "org-2" }],
      messages: [{ id: "message-1", conversationId: "missing", body: "Hola", senderOrganizationId: "org-2", createdAt: "2026-08-01T12:00:00Z" }],
      nextMessagesCursor: { id: "message-1" },
      networkAccessEvents: [{ id: "event-1", action: null, outcome: "allowed", actorOrganizationId: "org-1", createdAt: "2026-08-01T12:00:00Z" }],
      coalitionDecisions: [{ id: "decision-1", title: "Decisión", status: "open", approvals: 1, requiredApprovals: 2, action: "authorize_work" }],
      exportRuns: [{ id: "run-1", format: "csv", status: "ready", rowCount: 4, deliveryMode: "internal_download" }],
      micrositeEditor: {
        state: "ready",
        chapterCode: "wor",
        profile: { titleEn: "Worcester", titleEs: "Worcester", bodyEn: "Hi", bodyEs: "Hola", published: false, updatedAt: "2026-08-01T12:00:00Z" },
        sections: [{ slug: "news", titleEn: "News" }],
        pages: [{ sectionSlug: "news", slug: "update", titleEn: "Update" }],
      },
    };
    const panelExtensions = readyExtensions({
      directory: [{ organizationId: "org-2", displayName: "Aliada", summary: "", contactMode: "disabled", parentOrganizationId: "org-9" }],
      permissions: ["resource_request", "resource_share"].map((capability) => ({ networkRecordId: "link-1", capability, status: "active" })),
      invitations: [{ recordId: "invite-1", title: "Invitación", kind: "coalition", role: "member" }],
      badges: [{ missionId: "mission-1", alias: "Miembro A", badge: "bronce" }],
      recentActivity: [{ recordId: "mission-1", createdAt: "2026-08-01", type: "joined", pointsDelta: 5 }, { recordId: "mission-1", createdAt: "2026-08-02", type: "noted" }],
      mergeJobs: [{ id: "job-1", status: "done", approvedMatchCount: 3 }],
      mobilizationProgress: [{ campaignId: "mob-1", title: "Marcha", reached: 5, committed: 3, attended: 2 }],
    });
    const renderTab = (tab, lang) => render(<LanguageProvider lang={lang}><CoordinationWorkflowPanels
      tab={tab}
      actor={admin}
      model={panelModel}
      extensions={panelExtensions}
      busy={false}
      pagingMessages={false}
      onShowDirectoryExtensions={() => {}}
      actions={{ onLoadMoreMessages: vi.fn(), onRecommendCoverage: vi.fn(async () => ({ state: "none" })) }}
    /></LanguageProvider>);
    // Panel titles, labels, options, placeholders and buttons named by the record.
    const ENGLISH = [
      "Organization directory", "No public summary", "parent org-9", "Directory profile", "Display name", "Contact routing",
      "Campaign lead routed", "Save profile", "Network permissions", "Grant permission", "resource request", "Resource request or share",
      "Share authorized document", "Submit resource", "Resource inbox", "Open shared document", "Search messages",
      "Authorized conversation", "Load older messages", "initiated here", "Invitations", "Invite an organization", "Send invitation",
      "Select a worker", "Add worker", "Open an approval decision", "Authorize work", "Approval threshold", "Majority",
      "Coalition decisions", "approvals", "Approve Decisión", "Review an identity match", "Source worker ID", "Target worker ID",
      "Approve mapping", "Execute Plan de fusión", "Execute exact mapping plan", "Mapping jobs", "approved mappings", "Export runs",
      "rows", "Download export", "Current coverage", "Find available committee contact", "No committee member is covered at this time.",
      "Public campaign profile", "Section slug", "Publish page", "Public page attachments", "Administrative page takeover",
      "Audited reason", "Take over page", "Mission badges", "Recent mission activity", "points", "Recorded", "Mobilization progress",
      "reached", "attended",
    ];
    const pageText = (container) => [
      container.textContent,
      ...[...container.querySelectorAll("[placeholder]")].map((node) => node.getAttribute("placeholder")),
    ].join(" | ");

    // Every tab in turn, with the Chapter tab's coverage lookup answered.
    const renderAllTabs = async (lang) => {
      let text = "";
      for (const tab of ["missions", "network", "coalitions", "operations", "chapter", "mobilize"]) {
        const { container, unmount } = renderTab(tab, lang);
        if (tab === "chapter") {
          fireEvent.click(screen.getByRole("button", { name: translate(lang, "coordination.panel.findSteward") }));
          expect(await screen.findByText(translate(lang, "coordination.panel.coverageNone"))).toBeVisible();
        }
        text += pageText(container);
        unmount();
      }
      return text;
    };

    it("renders every tab's panel copy in Spanish and none of the English originals", async () => {
      const text = await renderAllTabs("es");
      for (const phrase of [
        "Directorio de organizaciones", "organización principal org-9", "Nombre visible", "Enrutamiento de contacto",
        "solicitud de recursos", "Compartir documento autorizado", "Conversación autorizada", "Cargar mensajes anteriores",
        "Invita a una organización", "Abre una decisión de aprobación", "Mayoría", "1/2 aprobaciones", "Aprobar Decisión",
        "Revisa una coincidencia de identidad", "ID del trabajador de origen", "Ejecutar Plan de fusión", "3 correspondencias aprobadas",
        "4 filas", "Cobertura actual", "Identificador del apartado", "Publicar la página", "Toma administrativa de la página",
        "Motivo auditado", "Insignias de misiones", "5 puntos", "Registrado", "5 contactados · 3 comprometidos · 2 asistieron",
      ]) expect(text).toContain(phrase);
      for (const phrase of ENGLISH) expect(text).not.toContain(phrase);
      expect(text).not.toMatch(/coordination\.panel\./);
    });

    it("keeps the English render of the same panels", async () => {
      const text = await renderAllTabs("en");
      for (const phrase of ENGLISH) expect(text).toContain(phrase);
      expect(text).toContain("4 rows · internal download");
    });

    it("keeps hard-coded English copy out of CoordinationWorkflowPanels.jsx", () => {
      const source = readFileSync(resolve(process.cwd(), "src/features/coordination/ui/CoordinationWorkflowPanels.jsx"), "utf8")
        .split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
      const offenders = [
        ...source.matchAll(/>\s*[A-Z][A-Za-z]+(?: [A-Za-z]+)*[.…]?\s*</g),
        ...source.matchAll(/\b(?:title|placeholder|aria-label)="[^"]*[A-Za-z]{2}[^"]*"/g),
        ...source.matchAll(/(?:\?|\|\||:)\s*"[A-Z][a-z]+ [a-z][^"]*"/g),
      ].map((match) => match[0]);
      expect(offenders).toEqual([]);
    });
  });

  it("runs record actions, composers, and every specialized creator field", async () => {
    const asyncAction = () => vi.fn(async () => true);
    const actions = {
      onCreate: asyncAction(), onJoin: vi.fn(), onTransition: vi.fn(), onRespond: vi.fn(),
      onMessage: asyncAction(), onRunExport: vi.fn(), onOutreach: asyncAction(),
      onSaveProfile: vi.fn(), onSetPermission: vi.fn(), onResource: vi.fn(),
      onRespondResource: vi.fn(), onOpenSharedDocument: asyncAction(),
      onInviteOrganization: vi.fn(), onRespondParticipant: vi.fn(), onAssignParticipant: vi.fn(),
      onProposeCoalitionDecision: vi.fn(), onVoteCoalitionDecision: vi.fn(),
      onReviewMergeMatch: vi.fn(), onExecuteMerge: vi.fn(),
      onSaveMicrositeSection: vi.fn(), onSaveMicrositePage: vi.fn(),
      onAttachPublicPageDocument: vi.fn(), onTakeOverPublicPage: vi.fn(), onRecommendCoverage: asyncAction(),
      onDownloadExport: vi.fn(), onLoadMoreMessages: vi.fn(),
    };
    const records = [
      { id: "mission-1", kind: "mission", title: "Mission", summary: "Shared work", status: "active", visibility: "members", organizationId: "org-1" },
      { id: "objective-1", parentId: "mission-1", kind: "mission_objective", title: "Objective", status: "draft", visibility: "members", config: { points: 15 } },
      { id: "network-1", kind: "network_link", title: "Network", status: "active", visibility: "participants" },
      { id: "network-invite", kind: "network_link", title: "Invitation", status: "requested", visibility: "participants", organizationId: "org-2", partnerOrganizationId: "org-1" },
      { id: "conversation-1", parentId: "network-1", kind: "network_conversation", title: "Conversation", status: "active", visibility: "participants" },
      { id: "request-1", parentId: "network-1", kind: "network_request", title: "Request", status: "draft", visibility: "participants" },
      { id: "export-1", kind: "network_export_schedule", title: "Export", status: "active", visibility: "staff" },
      { id: "coalition-1", kind: "coalition", title: "Coalition", status: "active", visibility: "participants" },
      { id: "campaign-1", parentId: "coalition-1", kind: "coalition_campaign", title: "Campaign", status: "active", visibility: "participants" },
      { id: "work-1", parentId: "campaign-1", kind: "coalition_work_item", title: "Joint work", status: "draft", visibility: "participants" },
      { id: "plan-1", kind: "merger_plan", title: "Mapping plan", status: "active", visibility: "staff", organizationId: "org-1", partnerOrganizationId: "org-2" },
      { id: "handshake-1", kind: "handshake_workspace_item", title: "Handshake", status: "draft", visibility: "staff" },
      { id: "coverage-1", kind: "coverage_schedule", title: "Coverage", status: "active", visibility: "staff" },
      { id: "override-1", kind: "coverage_override", title: "Override", status: "active", visibility: "staff" },
      { id: "committee-1", kind: "committee", title: "Committee", status: "active", visibility: "members" },
      { id: "mobilize-1", kind: "mobilization_campaign", title: "Turnout", status: "paused", visibility: "staff" },
      { id: "cohort-1", parentId: "mobilize-1", kind: "mobilization_cohort", title: "Cohort", status: "active", visibility: "staff" },
    ];
    const model = { ...snapshot, records, directory: [], resources: [], micrositeEditor: { state: "missing" }, nextRecordsCursor: { updatedAt: "2026-08-01", id: "mission-1" } };
    render(<OrganizationCoordinationDesk actor={chapterStaff} model={model} status="ready" notice="Saved" {...actions} />);
    expect(screen.getByText("Saved")).toBeVisible();
    const creator = () => within(screen.getByLabelText("Create coordination work"));

    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "mission_objective" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "New objective" } });
    fireEvent.change(creator().getByLabelText("Details"), { target: { value: "Reach ten members" } });
    fireEvent.change(creator().getByLabelText("Parent workspace"), { target: { value: "mission-1" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));

    fireEvent.click(screen.getByRole("tab", { name: "Network" }));
    const networkPanel = within(screen.getByRole("tabpanel"));
    fireEvent.click(networkPanel.getByRole("button", { name: "Accept" }));
    fireEvent.click(networkPanel.getByRole("button", { name: "Decline" }));
    fireEvent.change(networkPanel.getByLabelText("Conversation"), { target: { value: "conversation-1" } });
    fireEvent.change(networkPanel.getByLabelText("Message"), { target: { value: "Planning update" } });
    fireEvent.click(networkPanel.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(actions.onMessage).toHaveBeenCalledWith("conversation-1", "Planning update", expect.any(Function)));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "network_conversation" } });
    fireEvent.change(creator().getByLabelText("Parent workspace"), { target: { value: "network-1" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "New conversation" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));

    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "coalition_campaign" } });
    fireEvent.change(creator().getByLabelText("Parent workspace"), { target: { value: "coalition-1" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "New campaign" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));

    fireEvent.click(screen.getByRole("tab", { name: "Operations" }));
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Run export" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "network_export_schedule" } });
    fireEvent.change(creator().getByLabelText("Cadence"), { target: { value: "monthly" } });
    fireEvent.change(creator().getByLabelText("Format"), { target: { value: "json" } });
    fireEvent.change(creator().getByLabelText("First run"), { target: { value: "2026-08-29T09:00" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Monthly export" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "handshake_workspace_item" } });
    fireEvent.change(creator().getByLabelText("Campaign ID"), { target: { value: "wor" } });
    fireEvent.change(creator().getByLabelText("Active handshake ID"), { target: { value: "handshake-record" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Handshake step" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "merger_plan" } });
    fireEvent.change(creator().getByLabelText("Partner organization ID"), { target: { value: "org-2" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Mapping plan" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));

    fireEvent.click(screen.getByRole("tab", { name: "Campaign" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "coverage_schedule" } });
    fireEvent.change(creator().getByLabelText("Committee member ID"), { target: { value: "member-1" } });
    fireEvent.change(creator().getByLabelText("Day (0–6)"), { target: { value: "2" } });
    fireEvent.change(creator().getByLabelText("Start time"), { target: { value: "10:00" } });
    fireEvent.change(creator().getByLabelText("End time"), { target: { value: "18:20" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Tuesday coverage" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "coverage_override" } });
    fireEvent.change(creator().getByLabelText("Starts"), { target: { value: "2026-08-29T09:00" } });
    fireEvent.change(creator().getByLabelText("Ends"), { target: { value: "2026-08-29T13:00" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Coverage exception" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));

    fireEvent.click(screen.getByRole("tab", { name: "Mobilize" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "mobilization_cohort" } });
    fireEvent.change(creator().getByLabelText("Parent workspace"), { target: { value: "mobilize-1" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "New cohort" } });
    fireEvent.click(await creator().findByRole("button", { name: "Create" }));
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "mobilize-1" } });
    fireEvent.change(screen.getByLabelText("Worker ID"), { target: { value: "member-2" } });
    fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "committed" } });
    fireEvent.change(screen.getByLabelText("Private follow-up note"), { target: { value: "Confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(actions.onOutreach).toHaveBeenCalledWith(expect.objectContaining({ disposition: "committed" }), expect.any(Function)));
    expect(actions.onCreate.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(actions.onRunExport).toHaveBeenCalledWith(expect.objectContaining({ id: "export-1" }));
  });

  it("lets a member complete an objective with its bounded point value", () => {
    const onTransition = vi.fn();
    render(<OrganizationCoordinationDesk
      actor={member}
      model={{
        ...snapshot,
        staff: false,
        records: [{
          id: "objective-1",
          kind: "mission_objective",
          title: "Objective",
          status: "active",
          visibility: "members",
          config: { points: 25 },
        }],
        leaderboards: [],
      }}
      status="ready"
      onTransition={onTransition}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Complete objective" }));
    expect(onTransition).toHaveBeenCalledWith(expect.objectContaining({ id: "objective-1" }), "complete_objective", { points: 25 });
  });

  it("regression: every staff hat completes only its own mission objective and keeps activation controls", () => {
    for (const hat of ["steward", "coordinator", "advisor", "admin", "vp"]) {
      const onTransition = vi.fn();
      const actor = buildCoordinationActor({
        ...member,
        selectedHat: hat,
        organizationRoles: [hat],
      });
      const records = [
        { id: "objective-active", kind: "mission_objective", title: "Active objective", status: "active", visibility: "members", organizationId: "org-1", config: { points: 40 } },
        { id: "objective-draft", kind: "mission_objective", title: "Draft objective", status: "draft", visibility: "members", organizationId: "org-1" },
        { id: "objective-paused", kind: "mission_objective", title: "Paused objective", status: "paused", visibility: "members", organizationId: "org-1" },
        { id: "mission-active", kind: "mission", title: "Active mission", status: "active", visibility: "members", organizationId: "org-1" },
      ];
      const { unmount } = render(<OrganizationCoordinationDesk
        actor={actor}
        model={{ ...snapshot, records, leaderboards: [] }}
        status="ready"
        onTransition={onTransition}
      />);
      const cardFor = (title) => screen.getByRole("heading", { level: 3, name: title }).closest("article");
      const activeObjective = within(cardFor("Active objective"));

      expect(activeObjective.queryByRole("button", { name: "Complete", exact: true }), hat).not.toBeInTheDocument();
      fireEvent.click(activeObjective.getByRole("button", { name: "Complete objective" }));
      expect(onTransition, hat).toHaveBeenCalledWith(
        expect.objectContaining({ id: "objective-active", status: "active" }),
        "complete_objective",
        { points: 40 },
      );
      expect(within(cardFor("Draft objective")).getByRole("button", { name: "Activate" }), hat).toBeVisible();
      expect(within(cardFor("Paused objective")).getByRole("button", { name: "Activate" }), hat).toBeVisible();
      expect(within(cardFor("Active mission")).getByRole("button", { name: "Complete", exact: true }), hat).toBeVisible();
      unmount();
    }
  });

  it("regression: a denied staff objective completion uses the existing notice", async () => {
    const objectiveSnapshot = {
      ...snapshot,
      records: [{
        id: "objective-1",
        parentId: "mission-1",
        kind: "mission_objective",
        title: "Objective",
        status: "active",
        visibility: "members",
        organizationId: "org-1",
        config: { points: 25 },
      }],
      leaderboards: [],
    };
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return membershipsFor("org-1");
      if (name === COORDINATION_RPCS.snapshot) return { data: objectiveSnapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.transition) {
        return { data: null, error: Object.assign(new Error("mission participation required"), { code: "42501" }) };
      }
      return { data: [], error: null };
    });
    render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    const control = await screen.findByRole("button", { name: "Complete objective" });
    fireEvent.click(control);
    await waitFor(() => expect(screen.getByText("That coordination change could not be saved.")).toHaveAttribute("role", "status"));
    expect(rpc.mock.calls.filter(([name]) => name === COORDINATION_RPCS.transition)).toHaveLength(1);
  });

  it("keeps a completed staff objective replaced after reload and a fresh mount", async () => {
    let completedByCaller = false;
    const objectiveSnapshot = () => ({
      ...snapshot,
      records: [{
        id: "objective-1",
        parentId: "mission-1",
        kind: "mission_objective",
        title: "Objective",
        status: "active",
        visibility: "members",
        organizationId: "org-1",
        config: { points: 25 },
        completedByCaller,
      }],
      leaderboards: [],
    });
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return membershipsFor("org-1");
      if (name === COORDINATION_RPCS.snapshot) return { data: objectiveSnapshot(), error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.transition) {
        completedByCaller = true;
        return { data: { transitioned: true, recordId: "objective-1", status: "active", pointsAwarded: 25 }, error: null };
      }
      return { data: [], error: null };
    });
    const first = render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete objective" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Objective completed" })).toBeDisabled());
    expect(screen.getByText("Objective completed.")).toHaveAttribute("role", "status");
    expect(rpc.mock.calls.filter(([name]) => name === COORDINATION_RPCS.transition)).toHaveLength(1);
    expect(screen.queryByText("Coordination status updated.")).not.toBeInTheDocument();

    first.unmount();
    render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    expect(await screen.findByRole("button", { name: "Objective completed" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Complete objective" })).not.toBeInTheDocument();
    expect(rpc.mock.calls.filter(([name]) => name === COORDINATION_RPCS.transition)).toHaveLength(1);
  });

  it("handles an already-completed objective response without announcing a status update", async () => {
    const objectiveSnapshot = {
      ...snapshot,
      records: [{
        id: "objective-1",
        parentId: "mission-1",
        kind: "mission_objective",
        title: "Objective",
        status: "active",
        visibility: "members",
        organizationId: "org-1",
        config: { points: 25 },
      }],
      leaderboards: [],
    };
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return membershipsFor("org-1");
      if (name === COORDINATION_RPCS.snapshot) return { data: objectiveSnapshot, error: null };
      if (name === COORDINATION_RPCS.messagesPage) return { data: { messages: [], nextCursor: null }, error: null };
      if (name === COORDINATION_RPCS.transition) {
        return { data: { transitioned: false, alreadyCompleted: true, recordId: "objective-1", status: "active", pointsAwarded: 0 }, error: null };
      }
      return { data: [], error: null };
    });
    render(<OrganizationCoordinationView actor={VIEW_ACTOR} client={{ rpc }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete objective" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Objective completed" })).toBeDisabled());
    expect(screen.getByText("Objective was already completed.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Coordination status updated.")).not.toBeInTheDocument();
  });

  it("localizes the objective completion control in Spanish", () => {
    render(<LanguageProvider lang="es"><OrganizationCoordinationDesk
      actor={staff}
      model={{
        ...snapshot,
        records: [{ id: "objective-1", kind: "mission_objective", title: "Objetivo", status: "active", visibility: "members", organizationId: "org-1", config: { points: 25 } }],
        leaderboards: [],
      }}
      status="ready"
      onTransition={vi.fn()}
    /></LanguageProvider>);
    expect(screen.getByRole("button", { name: "Completar objetivo" })).toBeVisible();
  });

  it("provides the complete keyboard model promised by its tab roles", () => {
    render(<OrganizationCoordinationDesk actor={staff} model={snapshot} status="ready" />);
    const missions = screen.getByRole("tab", { name: "Missions" });
    const network = screen.getByRole("tab", { name: "Network" });
    missions.focus();
    fireEvent.keyDown(missions, { key: "ArrowRight" });
    expect(network).toHaveFocus();
    expect(network).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(network, { key: "End" });
    expect(screen.getByRole("tab", { name: "Mobilize" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Mobilize");
  });

  it("offers a stable load-more control only while a records cursor remains", () => {
    const onLoadMore = vi.fn();
    render(<OrganizationCoordinationDesk actor={staff} model={{ ...snapshot, nextRecordsCursor: { updatedAt: "2026-01-01T00:00:00Z", id: "mission-1" } }} status="ready" onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older work" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("collects the partner organization for a staff coalition invitation", () => {
    const onCreate = vi.fn(async () => null);
    render(<OrganizationCoordinationDesk actor={staff} model={snapshot} status="ready" onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "coalition" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Statewide coalition" } });
    fireEvent.change(screen.getByLabelText("Partner organization ID"), { target: { value: "org-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      kind: "coalition",
      partnerOrganizationId: "org-2",
    }), expect.any(Function));
  });

  it("keeps an invitation unsent when its selected coalition is no longer available", () => {
    const onInviteOrganization = vi.fn();
    const actions = { onInviteOrganization };
    const coalitions = [
      { id: "local-1", kind: "coalition", organizationId: "org-1", status: "active", title: "First coalition" },
      { id: "local-2", kind: "coalition", organizationId: "org-1", status: "active", title: "Second coalition" },
    ];
    const view = render(<CoordinationWorkflowPanels tab="coalitions" actor={staff} model={{ ...snapshot, records: coalitions }} actions={actions} />);
    const button = screen.getByRole("button", { name: "Send invitation" });
    const form = within(button.closest("form"));
    fireEvent.change(form.getByLabelText("Coalition"), { target: { value: "local-1" } });
    fireEvent.change(form.getByLabelText("Organization ID"), { target: { value: "org-2" } });
    view.rerender(<CoordinationWorkflowPanels tab="coalitions" actor={staff} model={{ ...snapshot, records: [coalitions[1]] }} actions={actions} />);
    expect(form.getByLabelText("Coalition")).toHaveValue("");
    fireEvent.submit(button.closest("form"));
    expect(form.getByLabelText("Organization ID")).toHaveValue("org-2");
    expect(form.getByRole("status")).toBeEmptyDOMElement();
    expect(onInviteOrganization).not.toHaveBeenCalled();
  });

  it("opens an explicit coalition approval decision for a campaign work item", () => {
    const onProposeCoalitionDecision = vi.fn();
    const model = {
      ...snapshot,
      records: [
        { id: "campaign-1", kind: "coalition_campaign", title: "Shared campaign", status: "active", visibility: "participants" },
        { id: "work-1", parentId: "campaign-1", kind: "coalition_work_item", title: "Joint field action", status: "draft", visibility: "participants" },
      ],
      coalitionDecisions: [],
    };
    render(<OrganizationCoordinationDesk actor={staff} model={model} status="ready" onProposeCoalitionDecision={onProposeCoalitionDecision} />);
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    fireEvent.change(screen.getByLabelText("Decision campaign"), { target: { value: "campaign-1" } });
    fireEvent.change(screen.getByLabelText("Work item"), { target: { value: "work-1" } });
    fireEvent.change(screen.getByLabelText("Decision title"), { target: { value: "Authorize field action" } });
    fireEvent.change(screen.getByLabelText("Approval threshold"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Open decision" }));
    expect(onProposeCoalitionDecision).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "campaign-1",
      subjectRecordId: "work-1",
      title: "Authorize field action",
      requiredApprovals: 2,
    }), expect.any(Function));
  });

  //  W7-21: Open decision names what it waits for.
  it.each(["en", "es"])("names why Open decision is held (%s)", (lang) => {
    const tr = (key) => translate(lang, `coordination.${key}`);
    const onPropose = vi.fn();
    const model = { ...snapshot, records: [{ id: "c-1", kind: "coalition_campaign", title: "Shared", status: "active" }], coalitionDecisions: [] };
    render(<LanguageProvider lang={lang}><OrganizationCoordinationDesk actor={staff} model={model} status="ready" onProposeCoalitionDecision={onPropose} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("tab", { name: tr("tab.coalitions") }));
    const open = screen.getByRole("button", { name: tr("panel.openDecision") });
    const reason = () => open.getAttribute("aria-describedby").split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");
    expect(open).toHaveAttribute("aria-disabled", "true");
    expect(reason()).toContain(tr("panel.openDecisionNeedsCampaign"));
    fireEvent.change(screen.getByLabelText(tr("panel.decisionCampaign")), { target: { value: "c-1" } });
    expectRefusedEveryWay(open, tr("panel.openDecisionNeedsWork"), () => onPropose.mock.calls.length > 0);
    cleanup();
    const ready = { ...model, records: [...model.records, { id: "w-1", parentId: "c-1", kind: "coalition_work_item", title: "Field action", status: "draft" }] };
    render(<LanguageProvider lang={lang}><OrganizationCoordinationDesk actor={staff} model={ready} status="ready" onProposeCoalitionDecision={onPropose} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("tab", { name: tr("tab.coalitions") }));
    fireEvent.change(screen.getByLabelText(tr("panel.decisionCampaign")), { target: { value: "c-1" } });
    const free = screen.getByRole("button", { name: tr("panel.openDecision") });
    expect(free).not.toHaveAttribute("aria-disabled");
    expect(free.getAttribute("aria-describedby")).toBeNull();
  });

  it("edits the real public chapter hierarchy and exposes public attachment controls", () => {
    const onSaveMicrositeSection = vi.fn();
    const onAttachPublicPageDocument = vi.fn();
    const model = {
      ...snapshot,
      micrositeEditor: {
        state: "ready",
        chapterCode: "wor",
        sections: [{ slug: "member-help", titleEn: "Member help" }],
        pages: [{ sectionSlug: "member-help", slug: "office-hours", titleEn: "Office hours" }],
        attachments: [],
        takeovers: [],
      },
    };
    render(<OrganizationCoordinationDesk actor={chapterStaff} model={model} status="ready" onSaveMicrositeSection={onSaveMicrositeSection} onAttachPublicPageDocument={onAttachPublicPageDocument} />);
    fireEvent.click(screen.getByRole("tab", { name: "Campaign" }));
    fireEvent.click(screen.getByText("Manage sections and pages"));
    fireEvent.change(screen.getAllByLabelText("Section slug")[0], { target: { value: "new-section" } });
    fireEvent.change(screen.getAllByLabelText("English title")[0], { target: { value: "New section" } });
    fireEvent.change(screen.getAllByLabelText("Spanish title")[0], { target: { value: "Nueva sección" } });
    fireEvent.change(screen.getByLabelText("English summary"), { target: { value: "Public information" } });
    fireEvent.change(screen.getByLabelText("Spanish summary"), { target: { value: "Información pública" } });
    fireEvent.click(screen.getByRole("button", { name: "Save section" }));
    expect(onSaveMicrositeSection).toHaveBeenCalledWith(expect.objectContaining({ chapterCode: "wor", slug: "new-section" }), expect.any(Function));
    expect(screen.getByRole("heading", { name: "Public page attachments" })).toBeVisible();
  });

  it("operates the directory, permission, and resource panels end to end", async () => {
    const actions = Object.fromEntries([
      "onSaveProfile", "onSetPermission", "onResource", "onRespondResource",
      "onLoadMoreMessages",
    ].map((name) => [name, vi.fn()]));
    actions.onOpenSharedDocument = vi.fn()
      .mockResolvedValueOnce({ title: "Shared guide", summary: "Public summary", body: "Authorized body" })
      .mockRejectedValueOnce(new Error("The share is no longer available"));
    const extensions = readyExtensions({
      directory: [{ organizationId: "org-2", displayName: "Harbor Network", summary: "Neighbor", contactMode: "coordinator_routed", parentOrganizationId: "org-parent" }],
      // The share this form submits is refused without the grant behind it, so
      // the loaded projection carries the one the panel offers it for.
      permissions: [{ id: "grant-1", networkRecordId: "network-1", grantorOrganizationId: "org-1", granteeOrganizationId: "org-2", capability: "resource_share", status: "active" }],
    });
    const model = {
      ...snapshot,
      records: [
        { id: "network-1", kind: "network_link", title: "Accepted link", status: "active" },
        { id: "conversation-1", kind: "network_conversation", title: "Partner planning", status: "active" },
      ],
      messages: [
        { id: "message-2", conversationId: "conversation-1", body: "Second planning update", senderOrganizationId: "org-1", createdAt: "2026-08-02T12:00:00Z" },
        { id: "message-1", conversationId: "conversation-1", body: "First planning update", senderOrganizationId: "org-2", createdAt: "2026-08-01T12:00:00Z" },
      ],
      nextMessagesCursor: { createdAt: "2026-08-01T12:00:00Z", id: "message-1" },
      networkAccessEvents: [{ id: "event-1", action: "permission_granted", outcome: "success", actorOrganizationId: "org-2", createdAt: "2026-08-01T11:00:00Z" }],
      resources: [
        { id: "request-1", title: "Training request", kind: "request", status: "requested", toOrganizationId: "org-1" },
        { id: "share-1", title: "Shared guide", kind: "share", status: "accepted", toOrganizationId: "org-1" },
      ],
    };
    render(<CoordinationWorkflowPanels tab="network" actor={staff} model={model} extensions={extensions} busy={false} actions={actions} />);
    // The loaded projection replaces the request control; the directory panel is
    // present because the projection answered, not because the page mounted.
    expect(screen.queryByRole("button", { name: "Show partner directory and activity" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Organization directory" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Regional Network" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Shared support" } });
    fireEvent.change(screen.getByLabelText("Visibility"), { target: { value: "directory" } });
    fireEvent.change(screen.getByLabelText("Contact routing"), { target: { value: "coordinator_routed" } });
    fireEvent.change(screen.getByLabelText("Accepted parent organization ID"), { target: { value: "org-parent" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    fireEvent.change(screen.getByLabelText("Accepted network"), { target: { value: "network-1" } });
    fireEvent.change(screen.getByLabelText("Partner organization ID"), { target: { value: "org-2" } });
    fireEvent.change(screen.getByLabelText("Capability"), { target: { value: "resource_share" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant permission" }));
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "network-1" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "share" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Safety guide" } });
    fireEvent.change(screen.getByLabelText("Campaign document ID"), { target: { value: "document-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit resource" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Open shared document" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Shared guide" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Open shared document" }));
    await waitFor(() => expect(screen.queryByText("Authorized body")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open shared document" })).toBeEnabled();
    expect(screen.getByText(/parent org-parent/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Network oversight activity" })).toBeVisible();
    expect(screen.getByText("First planning update")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search messages"), { target: { value: "second" } });
    expect(screen.queryByText("First planning update")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(actions.onLoadMoreMessages).toHaveBeenCalledOnce();
    expect(actions.onSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ visibility: "directory", parentOrganizationId: "org-parent" }));
    expect(actions.onSetPermission).toHaveBeenCalledWith(expect.objectContaining({ capability: "resource_share" }), expect.any(Function));
    expect(actions.onResource).toHaveBeenCalledWith(expect.objectContaining({ kind: "share", documentId: "document-1" }), expect.any(Function));
    expect(actions.onRespondResource).toHaveBeenCalledTimes(2);
  });

  // BUG-UG-WEB-DIRECTORY-PROFILE-FORM-OVERWRITES-SAVED-20261003. The
  // profile form opened blank, Private and Disabled, and the save sends every
  // field, so changing one field silently reset the rest of the saved profile.
  it("opens the directory profile form on the saved profile and keeps untouched fields on save", () => {
    const onSaveProfile = vi.fn();
    const saved = { organizationId: "org-1", displayName: "Tamarack Local", summary: "Hospital workers", visibility: "directory", contactMode: "coordinator_routed", parentOrganizationId: "org-parent", updatedAt: "2026-10-02T12:00:00Z" };
    const actions = { onSaveProfile };
    const { rerender } = render(<CoordinationWorkflowPanels tab="network" actor={staff} model={snapshot} onShowDirectoryExtensions={vi.fn()} busy={false} actions={actions} />);
    // Before the projection answers there is nothing to seed from, so no form
    // is offered that could overwrite the saved profile; the hint points at the
    // request control that is on screen.
    expect(screen.queryByRole("button", { name: "Save profile" })).not.toBeInTheDocument();
    expect(screen.getByText(/open your saved profile for editing/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Show partner directory and activity" })).toBeVisible();
    // A refused or unconfirmed load removes that control, so the hint must not
    // point at it.
    for (const state of ["mfa_required", "unauthorized", "error"]) {
      rerender(<CoordinationWorkflowPanels tab="network" actor={staff} model={snapshot} extensions={{ ...EMPTY_COORDINATION_EXTENSIONS, state }} onShowDirectoryExtensions={vi.fn()} busy={false} actions={actions} />);
      expect(screen.queryByRole("button", { name: "Show partner directory and activity" })).not.toBeInTheDocument();
      expect(screen.queryByText(/open your saved profile for editing/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save profile" })).not.toBeInTheDocument();
    }
    rerender(<CoordinationWorkflowPanels tab="network" actor={staff} model={snapshot} extensions={readyExtensions({ directory: [saved, { organizationId: "org-2", displayName: "Harbor Network", contactMode: "disabled" }] })} busy={false} actions={actions} />);
    expect(screen.getByLabelText("Display name")).toHaveValue("Tamarack Local");
    expect(screen.getByLabelText("Summary")).toHaveValue("Hospital workers");
    expect(screen.getByLabelText("Visibility")).toHaveValue("directory");
    expect(screen.getByLabelText("Contact routing")).toHaveValue("coordinator_routed");
    expect(screen.getByLabelText("Accepted parent organization ID")).toHaveValue("org-parent");
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Hospital and clinic workers" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(onSaveProfile).toHaveBeenCalledWith({ displayName: "Tamarack Local", summary: "Hospital and clinic workers", visibility: "directory", contactMode: "coordinator_routed", parentOrganizationId: "org-parent" });
    // A refreshed projection after the save re-seeds the form from the new row.
    rerender(<CoordinationWorkflowPanels tab="network" actor={staff} model={snapshot} extensions={readyExtensions({ directory: [{ ...saved, visibility: "partners", updatedAt: "2026-10-02T13:00:00Z" }] })} busy={false} actions={actions} />);
    expect(screen.getByLabelText("Visibility")).toHaveValue("partners");
  });

  // UX-UG-COORDINATION-PARTNER-TIMESTAMPS-RAW-ISO-AND-UNTRANSLATED-20260920.
  // The Network tab interpolated the stored ISO-8601 createdAt straight into the
  // partner message and oversight rows, and picked the sender label and both
  // panel titles from English literals, so a Spanish reader got English copy and
  // every reader got a machine timestamp.
  it("formats Network tab stamps and reads its message and oversight copy from the catalogue", () => {
    const createdAt = "2026-08-01T12:00:00Z";
    const model = {
      ...snapshot,
      records: [{ id: "conversation-1", kind: "network_conversation", title: "Partner planning", status: "active" }],
      messages: [
        { id: "message-1", conversationId: "conversation-1", body: "Planning update", senderOrganizationId: "org-1", createdAt },
        { id: "message-2", conversationId: "conversation-1", body: "Partner reply", senderOrganizationId: "org-2", createdAt },
      ],
      networkAccessEvents: [{ id: "event-1", action: "permission_granted", outcome: "success", actorOrganizationId: "org-2", createdAt }],
    };
    for (const lang of ["es", "en"]) {
      const stamp = dateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(createdAt));
      const view = render(
        <LanguageProvider lang={lang}>
          <CoordinationWorkflowPanels tab="network" actor={staff} model={model} extensions={readyExtensions()} busy={false} actions={{}} />
        </LanguageProvider>,
      );
      const rendered = view.container.textContent;
      expect(screen.getByRole("heading", { name: translate(lang, "coordination.networkMessagesTitle") }), lang).toBeVisible();
      expect(screen.getByRole("heading", { name: translate(lang, "coordination.networkOversightTitle") }), lang).toBeVisible();
      expect(rendered, lang).toContain(`${translate(lang, "coordination.networkMessageSenderSelf")} · ${stamp}`);
      expect(rendered, lang).toContain(`${translate(lang, "coordination.networkMessageSenderPartner")} · ${stamp}`);
      // Two messages and one oversight event, each stamped; and nothing on the
      // page still reads as ISO-8601.
      expect(rendered.split(stamp).length - 1, lang).toBe(3);
      expect(rendered, lang).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      view.unmount();
    }
    // The Spanish render is genuinely Spanish, and the English wording is the
    // wording the panel shipped with.
    for (const key of [
      "coordination.networkMessagesTitle", "coordination.networkOversightTitle",
      "coordination.networkMessageSenderSelf", "coordination.networkMessageSenderPartner",
    ]) {
      expect(translate("es", key), key).not.toBe(translate("en", key));
    }
    expect(translate("en", "coordination.networkMessagesTitle")).toBe("Partner message history");
    expect(translate("en", "coordination.networkOversightTitle")).toBe("Network oversight activity");
    expect(translate("en", "coordination.networkMessageSenderSelf")).toBe("Your organization");
    expect(translate("en", "coordination.networkMessageSenderPartner")).toBe("Partner organization");
  });

  it("offers a resource type only for the links whose grant admits it", () => {
    // validate_organization_coordination_resource_permission demands
    // 'resource_share' for a share and 'resource_request' for a request, so a
    // link that carries one does not carry the other, and a link that carries
    // neither cannot take a resource row at all.
    const onResource = vi.fn();
    const records = [
      { id: "link-request", kind: "network_link", title: "Request link", status: "active" },
      { id: "link-share", kind: "network_link", title: "Share link", status: "active" },
      { id: "link-message", kind: "network_link", title: "Message link", status: "active" },
    ];
    const model = { ...snapshot, records };
    const permissions = [
      { id: "grant-1", networkRecordId: "link-request", capability: "resource_request", status: "active" },
      { id: "grant-2", networkRecordId: "link-share", capability: "resource_share", status: "active" },
      { id: "grant-3", networkRecordId: "link-message", capability: "message", status: "active" },
    ];
    const panels = (extensions) => <CoordinationWorkflowPanels tab="network" actor={staff} model={model} extensions={extensions} busy={false} actions={{ onResource }} />;
    const optionsOf = (label) => within(screen.getByLabelText(label)).getAllByRole("option").map((option) => option.textContent);
    const { rerender } = render(panels(readyExtensions({ permissions })));
    expect(optionsOf("Type")).toEqual(["Request", "Share authorized document"]);
    expect(optionsOf("Network")).toEqual(["Choose a link", "Request link"]);
    fireEvent.change(screen.getByLabelText("Network"), { target: { value: "link-request" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "share" } });
    expect(optionsOf("Network")).toEqual(["Choose a link", "Share link"]);
    // The request link is not carried into the share write it cannot take.
    expect(screen.getByLabelText("Network")).toHaveValue("");

    // A network with no resource grant at all is not offered the form, while
    // the panel that grants the capability stays.
    rerender(panels(readyExtensions({ permissions: [permissions[2]] })));
    expect(screen.queryByRole("heading", { name: "Resource request or share" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Network permissions" })).toBeVisible();

    // Unknown grants never hide a link: until the deferred projection answers,
    // every active link stays offered for both types.
    rerender(panels(EMPTY_COORDINATION_EXTENSIONS));
    expect(optionsOf("Type")).toEqual(["Request", "Share authorized document"]);
    expect(optionsOf("Network")).toEqual(["Choose a link", "Request link", "Share link", "Message link"]);
    expect(onResource).not.toHaveBeenCalled();
  });

  it("offers coalition invitations and outreach only to the hats their RPCs admit", async () => {
    const invitations = [{ recordId: "coalition-1", title: "Statewide coalition", kind: "coalition", role: "approver" }];
    const model = {
      ...snapshot,
      staff: true,
      records: [
        { id: "coalition-1", kind: "coalition", title: "Statewide coalition", status: "active", organizationId: "org-1" },
        { id: "campaign-1", kind: "mobilization_campaign", title: "Door knock", status: "active" },
      ],
    };
    const hats = { steward: [false, true], advisor: [false, false], coordinator: [true, true], admin: [true, true], vp: [true, true] };
    for (const [hat, [invite, outreach]] of Object.entries(hats)) {
      const actor = buildCoordinationActor({ ...member, selectedHat: hat, organizationRoles: [hat] });
      expect(canPerformCoordinationIntent(actor, "inviteOrganization"), hat).toBe(invite);
      expect(canPerformCoordinationIntent(actor, "respondParticipant"), hat).toBe(invite);
      expect(canPerformCoordinationIntent(actor, "outreach"), hat).toBe(outreach);
      const { unmount } = render(<CoordinationWorkflowPanels tab="coalitions" actor={actor} model={model} extensions={readyExtensions({ invitations })} busy={false} actions={{}} />);
      const invitationPanel = screen.getByRole("heading", { name: "Invitations" }).closest("section");
      expect(invitationPanel, hat).toBeVisible();
      expect(within(invitationPanel).getByText("Statewide coalition"), hat).toBeVisible();
      expect(within(invitationPanel).getByText("coalition · approver"), hat).toBeVisible();
      expect(screen.queryByRole("button", { name: "Accept" }) !== null, hat).toBe(invite);
      expect(screen.queryByRole("button", { name: "Decline" }) !== null, hat).toBe(invite);
      expect(screen.queryByRole("button", { name: "Send invitation" }) !== null, hat).toBe(invite);
      unmount();
      const desk = render(<OrganizationCoordinationDesk actor={actor} model={model} status="ready" />);
      fireEvent.click(screen.getByRole("tab", { name: "Mobilize" }));
      expect(screen.queryByRole("button", { name: "Record" }) !== null, hat).toBe(outreach);
      desk.unmount();
      const adapter = createOrganizationCoordinationAdapter({ rpc: vi.fn().mockResolvedValue({ data: {}, error: null }) });
      const calls = [["inviteOrganization", [{}], invite], ["respondParticipant", ["coalition-1", true], invite], ["outreach", [{}], outreach]];
      for (const [method, args, allowed] of calls) {
        const result = adapter[method](actor, ...args);
        if (allowed) await expect(result).resolves.toBeDefined();
        else await expect(result).rejects.toMatchObject({ code: "42501" });
      }
    }
  });

  it("offers export, profile, and permission controls only to the hats their RPCs admit", async () => {
    // canManageCoordination admits steward and advisor, but run_organization_coordination_export,
    // get_organization_coordination_export_payload, upsert_organization_network_profile and
    // set_organization_network_permission each narrow to coordinator/admin/vp. The desk must not
    // render those four controls to a hat the server always refuses, and the adapter must refuse a
    // hand-built call the same way. (BUG-UG-COORDINATION-STEWARD-ADVISOR-WRITE-ACCESS-20260920)
    const schedule = { id: "export-1", kind: "network_export_schedule", title: "Weekly export", status: "active", visibility: "staff", config: { format: "json" } };
    const model = {
      ...snapshot,
      staff: true,
      records: [
        schedule,
        { id: "network-1", kind: "network_link", title: "Accepted link", status: "active" },
        { id: "campaign-1", kind: "mobilization_campaign", title: "Door knock", status: "active" },
      ],
      exportRuns: [{ id: "run-1", format: "json", status: "ready", rowCount: 4, deliveryMode: "internal_download" }],
    };
    const CONTROL = /^(Run export|Download export|Save profile|Grant permission)$/;
    const hats = { steward: false, advisor: false, coordinator: true, admin: true, vp: true };
    for (const [hat, admitted] of Object.entries(hats)) {
      const actor = buildCoordinationActor({ ...member, selectedHat: hat, organizationRoles: [hat] });
      for (const intent of ["runExport", "downloadExport", "saveProfile", "setPermission"]) {
        expect(canPerformCoordinationIntent(actor, intent), `${hat}:${intent}`).toBe(admitted);
      }
      const { unmount } = render(<OrganizationCoordinationDesk actor={actor} model={model} status="ready" />);
      fireEvent.click(screen.getByRole("tab", { name: "Operations" }));
      const panel = within(screen.getByRole("tabpanel"));
      // The schedule card itself stays on the desk for every staff hat; only the
      // export control on it narrows.
      expect(panel.getByRole("heading", { name: "Weekly export" }), hat).toBeVisible();
      expect(panel.queryAllByRole("button", { name: CONTROL }).length > 0, hat).toBe(admitted);
      if (admitted) expect(panel.getByRole("button", { name: "Run export" }), hat).toBeVisible();
      fireEvent.click(screen.getByRole("tab", { name: "Network" }));
      expect(screen.queryAllByRole("button", { name: CONTROL }).length > 0, hat).toBe(admitted);
      fireEvent.click(screen.getByRole("tab", { name: "Mobilize" }));
      // The outreach composer is the control a steward hat keeps, proving the rest
      // of the desk authorized for the hat is unchanged.
      if (hat === "steward") expect(screen.getByRole("button", { name: "Record" })).toBeVisible();
      unmount();
      const adapter = createOrganizationCoordinationAdapter({ rpc: vi.fn().mockResolvedValue({ data: {}, error: null }) });
      const calls = [
        ["runExport", ["export-1", "json"]],
        ["loadExportPayload", ["run-1"]],
        ["saveProfile", [{ displayName: "Network" }]],
        ["setPermission", [{ networkRecordId: "network-1" }]],
      ];
      for (const [method, args] of calls) {
        const result = adapter[method](actor, ...args);
        if (admitted) await expect(result).resolves.toBeDefined();
        else await expect(result).rejects.toMatchObject({ code: "42501" });
      }
    }
    // The coordinator's Run export press sends the schedule's stored json format,
    // not the csv default, and an unknown format never leaves the client.
    const rpc = vi.fn(async (name, args) => ({ data: { ok: true, name, args }, error: null }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await adapter.runExport(staff, "export-1", "json");
    expect(rpc).toHaveBeenCalledWith("run_organization_coordination_export", expect.objectContaining({ p_format: "json" }));
    await expect(adapter.runExport(staff, "export-1", "xml")).rejects.toMatchObject({ code: "22023" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(COORDINATION_EXPORT_FORMATS).toEqual(["csv", "json"]);
  });

  it("operates coalition membership, decisions, merger reviews, and execution", () => {
    const actions = Object.fromEntries([
      "onInviteOrganization", "onRespondParticipant", "onAssignParticipant",
      "onProposeCoalitionDecision", "onVoteCoalitionDecision", "onReviewMergeMatch", "onExecuteMerge",
      "onDownloadExport",
    ].map((name) => [name, vi.fn()]));
    const extensions = readyExtensions({
      invitations: [{ recordId: "coalition-1", title: "Statewide coalition", kind: "coalition", role: "approver" }],
    });
    const model = {
      ...snapshot,
      records: [
        { id: "coalition-1", kind: "coalition", title: "Statewide coalition", status: "active", organizationId: "org-1" },
        { id: "campaign-1", kind: "coalition_campaign", title: "Joint campaign", status: "active" },
        { id: "work-1", parentId: "campaign-1", kind: "coalition_work_item", title: "Field action", status: "draft" },
        { id: "committee-1", kind: "committee", title: "Safety committee", status: "active" },
      ],
      coalitionDecisions: [{ id: "decision-1", title: "Authorize field action", rationale: "Shared scope", action: "authorize_work", status: "open", approvals: 1, requiredApprovals: 2 }],
    };
    const { rerender } = render(<CoordinationWorkflowPanels tab="coalitions" actor={staff} model={model} extensions={extensions} busy={false} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.change(screen.getByLabelText("Coalition"), { target: { value: "coalition-1" } });
    fireEvent.change(screen.getByLabelText("Organization ID"), { target: { value: "org-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    fireEvent.change(screen.getByLabelText("Work record"), { target: { value: "committee-1" } });
    fireEvent.change(screen.getByLabelText("Worker ID"), { target: { value: "member-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add worker" }));
    fireEvent.change(screen.getByLabelText("Decision campaign"), { target: { value: "campaign-1" } });
    fireEvent.change(screen.getByLabelText("Work item"), { target: { value: "work-1" } });
    fireEvent.change(screen.getByLabelText("Decision title"), { target: { value: "Authorize work" } });
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "pause_work" } });
    fireEvent.change(screen.getByLabelText("Approval threshold"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "Two partners must approve" } });
    fireEvent.click(screen.getByRole("button", { name: "Open decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve Authorize field action" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject Authorize field action" }));
    expect(actions.onAssignParticipant).toHaveBeenCalledWith(expect.objectContaining({ role: "committee_member" }), expect.any(Function));
    expect(actions.onVoteCoalitionDecision).toHaveBeenCalledTimes(2);

    const operations = {
      ...model,
      records: [{ id: "plan-1", kind: "merger_plan", title: "Reviewed plan", status: "active", organizationId: "org-2", partnerOrganizationId: "org-1" }],
      exportRuns: [{ id: "run-1", format: "csv", status: "ready", rowCount: 20, deliveryMode: "internal_download" }],
    };
    const operationsExtensions = readyExtensions({ mergeJobs: [{ id: "job-1", status: "queued", approvedMatchCount: 3 }] });
    const admin = buildCoordinationActor({ ...staff, selectedHat: "admin", organizationRoles: ["admin"] });
    rerender(<CoordinationWorkflowPanels tab="operations" actor={admin} model={operations} extensions={operationsExtensions} busy={false} actions={actions} />);
    fireEvent.change(screen.getByLabelText("Accepted plan"), { target: { value: "plan-1" } });
    fireEvent.change(screen.getByLabelText("Source worker ID"), { target: { value: "member-1" } });
    fireEvent.change(screen.getByLabelText("Target worker ID"), { target: { value: "member-2" } });
    fireEvent.change(screen.getByLabelText("Decision"), { target: { value: "rejected" } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    fireEvent.click(screen.getByRole("button", { name: "Execute exact mapping plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Download export" }));
    expect(actions.onReviewMergeMatch).toHaveBeenCalledWith(expect.objectContaining({ decision: "rejected" }), expect.any(Function));
    expect(actions.onExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ sourceOrganizationId: "org-2", targetOrganizationId: "org-1" }));
    expect(actions.onDownloadExport).toHaveBeenCalledWith("run-1");
  });

  it("operates chapter hierarchy, attachments, takeover, and coverage states", async () => {
    const actions = Object.fromEntries([
      "onSaveChapterProfile", "onSaveMicrositeSection", "onSaveMicrositePage", "onAttachPublicPageDocument", "onTakeOverPublicPage",
    ].map((name) => [name, vi.fn()]));
    actions.onRecommendCoverage = vi.fn()
      .mockResolvedValueOnce({ state: "covered", recommendedUserId: "member-1" })
      .mockResolvedValueOnce({ state: "uncovered" });
    const admin = buildCoordinationActor({ ...chapterStaff, selectedHat: "admin", organizationRoles: ["admin"] });
    const model = {
      ...snapshot,
      micrositeEditor: {
        state: "ready", chapterCode: "wor",
        sections: [{ slug: "help", titleEn: "Help" }],
        pages: [{ sectionSlug: "help", slug: "hours", titleEn: "Hours" }],
        attachments: [{ id: "attachment-1", label: "Guide", sectionSlug: "help", pageSlug: "hours" }],
      },
    };
    const { rerender } = render(<CoordinationWorkflowPanels tab="chapter" actor={admin} model={model} busy={false} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Find available committee contact" }));
    await waitFor(() => expect(screen.getByText("A committee member is covered at this time.")).toBeVisible());
    expect(document.body.innerHTML).not.toContain("member-1");
    fireEvent.click(screen.getByText("Manage sections and pages"));
    for (const [label, value] of [
      ["Section slug", "new-section"], ["English title", "Help"], ["Spanish title", "Ayuda"],
      ["English summary", "Public help"], ["Spanish summary", "Ayuda pública"],
    ]) fireEvent.change(screen.getAllByLabelText(label)[0], { target: { value } });
    fireEvent.click(screen.getByLabelText("Publish section"));
    fireEvent.click(screen.getByRole("button", { name: "Save section" }));
    fireEvent.change(screen.getByLabelText("Section", { selector: "select" }), { target: { value: "help" } });
    fireEvent.change(screen.getByLabelText("Page slug"), { target: { value: "new-page" } });
    const englishTitles = screen.getAllByLabelText("English title");
    const spanishTitles = screen.getAllByLabelText("Spanish title");
    fireEvent.change(englishTitles[1], { target: { value: "New page" } });
    fireEvent.change(spanishTitles[1], { target: { value: "Nueva página" } });
    fireEvent.change(screen.getByLabelText("English body"), { target: { value: "English body" } });
    fireEvent.change(screen.getByLabelText("Spanish body"), { target: { value: "Texto español" } });
    fireEvent.click(screen.getByLabelText("Publish page"));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    // A guard, not a regression test: with no page chosen, a
    // submitted attachment or takeover form sends nothing, on Main and here; it
    // keeps the forms' own no-page return covered.
    fireEvent.submit(screen.getByRole("button", { name: "Attach document" }).closest("form"));
    fireEvent.submit(screen.getByRole("button", { name: "Take over page" }).closest("form"));
    expect(actions.onAttachPublicPageDocument).not.toHaveBeenCalled();
    expect(actions.onTakeOverPublicPage).not.toHaveBeenCalled();
    const pageSelects = screen.getAllByLabelText("Page", { selector: "select" });
    fireEvent.change(pageSelects[0], { target: { value: "help/hours" } });
    fireEvent.change(screen.getByLabelText("Published document ID"), { target: { value: "document-1" } });
    fireEvent.change(screen.getByLabelText("Public label"), { target: { value: "Office guide" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach document" }));
    fireEvent.change(pageSelects[1], { target: { value: "help/hours" } });
    fireEvent.change(screen.getByLabelText("Audited reason"), { target: { value: "Ownership handoff" } });
    fireEvent.click(screen.getByRole("button", { name: "Take over page" }));
    expect(actions.onSaveMicrositePage).toHaveBeenCalledWith(expect.objectContaining({ published: true }), expect.any(Function));
    expect(actions.onAttachPublicPageDocument).toHaveBeenCalledWith(expect.objectContaining({ pageSlug: "hours" }), expect.any(Function));
    expect(actions.onTakeOverPublicPage).toHaveBeenCalledWith(expect.objectContaining({ reason: "Ownership handoff" }), expect.any(Function));

    rerender(<CoordinationWorkflowPanels tab="chapter" actor={admin} model={{ ...model, micrositeEditor: { state: "missing" } }} busy={false} actions={actions} />);
    // The editor no longer dead-ends on the missing profile: the panel now carries
    // the working create-and-publish control itself, bound to the caller's chapter.
    expect(screen.getByRole("heading", { name: "Public campaign profile" })).toBeVisible();
    expect(screen.queryByText(/Create and publish the chapter/)).not.toBeInTheDocument();
    for (const [label, value] of [
      ["English title", "Harborview Care United"], ["Spanish title", "Harborview Care United"],
      ["English summary", "Public chapter profile."], ["Spanish summary", "Perfil público del capítulo."],
    ]) fireEvent.change(screen.getAllByLabelText(label)[0], { target: { value } });
    fireEvent.click(screen.getByLabelText("Publish campaign profile"));
    fireEvent.click(screen.getByRole("button", { name: "Save campaign profile" }));
    expect(actions.onSaveChapterProfile).toHaveBeenCalledWith(expect.objectContaining({ chapterCode: "wor", published: true }));
    fireEvent.click(screen.getByRole("button", { name: "Find available committee contact" }));
    await waitFor(() => expect(screen.getByText("No committee member is covered at this time.")).toBeVisible());
  });

  it("reports a coverage refusal on the Chapter tab without a raw identifier or an unhandled rejection", async () => {
    const recommendedUserId = "7f3c2a91-6b0e-4d54-9c18-2e0a1b4d8f33";
    const unhandled = [];
    const onProcess = (reason) => { unhandled.push(reason); };
    process.on("unhandledRejection", onProcess);
    try {
      const memberWithChapter = buildCoordinationActor({ ...member, chapterId: "wor" });
      const actions = {
        onRecommendCoverage: vi.fn()
          .mockRejectedValueOnce(new Error("chapter coverage unavailable"))
          .mockResolvedValueOnce({ state: "covered", recommendedUserId }),
      };
      render(<CoordinationWorkflowPanels tab="chapter" actor={memberWithChapter} model={snapshot} busy={false} actions={actions} />);
      fireEvent.click(screen.getByRole("button", { name: "Find available committee contact" }));
      await waitFor(() => expect(screen.getByText("Coverage could not be checked. Try again.")).toHaveAttribute("role", "status"));
      expect(document.body.innerHTML).not.toContain("chapter coverage unavailable");
      fireEvent.click(screen.getByRole("button", { name: "Find available committee contact" }));
      await waitFor(() => expect(screen.getByText("A committee member is covered at this time.")).toBeVisible());
      expect(document.body.innerHTML).not.toContain(recommendedUserId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onProcess);
    }
  });

  it("shows no create-profile control or instruction to a hat that cannot publish", () => {
    // UX-UG-HALF-DONE-THE-MICROSITE-HIERARCHY-EDITOR-DEAD-ENDS-AT-PUBLIC-CHAPTER-PROFILE-20260921
    // regression: no role sees a 'Create and publish…' instruction without an
    // adjacent working control. A member hat mounts the same missing editor and
    // must see neither the sentence nor the staff-only form.
    const actions = { onSaveChapterProfile: vi.fn() };
    const model = { ...snapshot, staff: false, micrositeEditor: { state: "missing" } };
    render(<CoordinationWorkflowPanels tab="chapter" actor={member} model={model} busy={false} actions={actions} />);
    expect(screen.queryByRole("button", { name: "Save campaign profile" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Create and publish the chapter/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Public campaign profile" })).not.toBeInTheDocument();
    expect(actions.onSaveChapterProfile).not.toHaveBeenCalled();
  });

  it("keeps the profile editable and publishable after a draft save in the ready state", () => {
    // UX-UG-HALF-DONE-THE-MICROSITE-HIERARCHY-EDITOR-DEAD-ENDS-AT-PUBLIC-CHAPTER-PROFILE-20260921
    // Codex round 4 regression: saving the create form with the publish
    // checkbox unchecked saved a draft and flipped the editor to ready, where no
    // edit/publish control existed — the profile was stuck unpublished. The ready
    // state must carry the same form, prefilled from the projection's profile.
    // Label queries use [0] because the ready hierarchy panel still mounts the
    // empty section form with the same English/Spanish title and summary labels.
    const onSaveChapterProfile = vi.fn();
    const profile = {
      titleEn: "Harborview Care United", titleEs: "Harborview Care United",
      bodyEn: "Draft profile body", bodyEs: "Cuerpo del borrador",
      published: false, updatedAt: "2026-09-21T12:00:00.000Z",
    };
    const model = {
      ...snapshot,
      staff: true,
      micrositeEditor: { state: "ready", chapterCode: "wor", profile, sections: [], pages: [], attachments: [], takeovers: [] },
    };
    render(<CoordinationWorkflowPanels tab="chapter" actor={chapterStaff} model={model} busy={false} actions={{ onSaveChapterProfile }} />);
    expect(screen.getByText(/unpublished draft/)).toBeVisible();
    expect(screen.getAllByLabelText("English title")[0]).toHaveValue("Harborview Care United");
    expect(screen.getAllByLabelText("Spanish title")[0]).toHaveValue("Harborview Care United");
    expect(screen.getAllByLabelText("English summary")[0]).toHaveValue("Draft profile body");
    expect(screen.getAllByLabelText("Spanish summary")[0]).toHaveValue("Cuerpo del borrador");
    const publish = screen.getByLabelText("Publish campaign profile");
    expect(publish).not.toBeChecked();
    fireEvent.click(publish);
    fireEvent.click(screen.getByRole("button", { name: "Save campaign profile" }));
    expect(onSaveChapterProfile).toHaveBeenCalledWith(expect.objectContaining({
      chapterCode: "wor", titleEn: "Harborview Care United", bodyEn: "Draft profile body", published: true,
      expectedUpdatedAt: "2026-09-21T12:00:00.000Z", expectedMissing: false,
    }));
  });

  it("arms the expected profile version on edits so a stale second-editor save is refused", async () => {
    // Codex P2 ( round 13): two staff load the same profile at T0; the
    // first save must not be silently overwritten by the second editor's stale
    // T0 form. The ready-state form must submit the updatedAt the editor
    // projected at load, and the adapter must forward it as the RPC's
    // p_expected_updated_at guard; the create (missing) state has no projected
    // profile and therefore expects no version.
    const onSaveChapterProfile = vi.fn();
    const profile = {
      titleEn: "Harborview Care United", titleEs: "Harborview Care United",
      bodyEn: "Published body", bodyEs: "Cuerpo publicado",
      published: true, updatedAt: "2026-09-21T13:00:00.000Z",
    };
    const model = {
      ...snapshot,
      staff: true,
      micrositeEditor: { state: "ready", chapterCode: "wor", profile, sections: [], pages: [], attachments: [], takeovers: [] },
    };
    render(<CoordinationWorkflowPanels tab="chapter" actor={chapterStaff} model={model} busy={false} actions={{ onSaveChapterProfile }} />);
    fireEvent.click(screen.getByRole("button", { name: "Save campaign profile" }));
    expect(onSaveChapterProfile).toHaveBeenCalledWith(expect.objectContaining({
      chapterCode: "wor", expectedUpdatedAt: "2026-09-21T13:00:00.000Z",
    }));
    const rpc = vi.fn(async (name, args) => ({ data: { ok: true, name, args }, error: null }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    await adapter.saveChapterProfile(chapterStaff, {
      chapterCode: "wor", titleEn: "Harborview Care United", titleEs: "Harborview Care United",
      bodyEn: "New copy", bodyEs: "Nuevo texto", published: true,
      expectedUpdatedAt: "2026-09-21T13:00:00.000Z",
    });
    expect(rpc).toHaveBeenCalledWith("upsert_public_chapter_profile", expect.objectContaining({
      p_chapter_code: "wor", p_expected_updated_at: "2026-09-21T13:00:00.000Z", p_expected_missing: false,
    }));
    await adapter.saveChapterProfile(chapterStaff, {
      chapterCode: "wor", titleEn: "Harborview Care United", titleEs: "Harborview Care United",
      bodyEn: "First create", bodyEs: "Primera creación", published: false,
      expectedMissing: true,
    });
    expect(rpc).toHaveBeenLastCalledWith("upsert_public_chapter_profile", expect.objectContaining({
      p_expected_updated_at: null, p_expected_missing: true,
    }));
  });

  it("offers the create form with no expected version while the profile is missing", () => {
    const onSaveChapterProfile = vi.fn();
    const model = {
      ...snapshot,
      staff: true,
      micrositeEditor: { state: "missing", chapterCode: "wor", sections: [], pages: [], attachments: [], takeovers: [] },
    };
    render(<CoordinationWorkflowPanels tab="chapter" actor={chapterStaff} model={model} busy={false} actions={{ onSaveChapterProfile }} />);
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Worcester" } });
    fireEvent.change(screen.getByLabelText("Spanish title"), { target: { value: "Worcester" } });
    fireEvent.change(screen.getByLabelText("English summary"), { target: { value: "English profile" } });
    fireEvent.change(screen.getByLabelText("Spanish summary"), { target: { value: "Perfil español" } });
    fireEvent.click(screen.getByRole("button", { name: "Save campaign profile" }));
    expect(onSaveChapterProfile).toHaveBeenCalledWith(expect.objectContaining({
      chapterCode: "wor", published: false, expectedUpdatedAt: null, expectedMissing: true,
    }));
  });

  it("keeps the ready editor profile through adapter snapshot normalization", async () => {
    // Codex P1 ( round 7): get_public_chapter_microsite_editor returns
    // profile, but normalizeCoordinationSnapshot dropped it, so the ready-state
    // edit/publish panel never rendered after a draft save.
    const profile = {
      titleEn: "Harborview Care United", titleEs: "Harborview Care United",
      bodyEn: "Draft profile body", bodyEs: "Cuerpo del borrador",
      published: false, updatedAt: "2026-09-21T12:00:00.000Z",
    };
    const rpc = vi.fn(async (name) => ({
      data: name === "get_organization_coordination_snapshot"
        ? snapshot
        : name === "get_public_chapter_microsite_editor"
          ? { state: "ready", chapterCode: "wor", profile, sections: [], pages: [], attachments: [], takeovers: [] }
          : name === "list_organization_coordination_messages"
            ? { messages: [], nextCursor: null }
            : name === "list_organization_network_access_events" || name === "get_organization_coalition_decisions"
              ? []
              : { state: "ready", organizationId: "org-1" },
      error: null,
    }));
    const adapter = createOrganizationCoordinationAdapter({ rpc });
    const loaded = await adapter.load(chapterStaff);
    expect(loaded.micrositeEditor.profile).toEqual(profile);
    const onSaveChapterProfile = vi.fn();
    render(<CoordinationWorkflowPanels tab="chapter" actor={chapterStaff} model={loaded} busy={false} actions={{ onSaveChapterProfile }} />);
    expect(screen.getByText(/unpublished draft/)).toBeVisible();
    expect(screen.getAllByLabelText("English title")[0]).toHaveValue("Harborview Care United");
  });

  it("does not offer profile save when organization staff have no chapter assignment", () => {
    const onSaveChapterProfile = vi.fn();
    const model = { ...snapshot, staff: true, micrositeEditor: { state: "missing" } };
    render(<CoordinationWorkflowPanels tab="chapter" actor={staff} model={model} busy={false} actions={{ onSaveChapterProfile }} />);
    expect(screen.getByText(/Select or assign a campaign/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save campaign profile" })).not.toBeInTheDocument();
    expect(onSaveChapterProfile).not.toHaveBeenCalled();
  });

  it("resets unsaved profile copy when staff switch from one missing chapter to another", () => {
    const onSaveChapterProfile = vi.fn();
    const missing = (chapterCode) => ({
      ...snapshot,
      staff: true,
      micrositeEditor: { state: "missing", chapterCode, sections: [], pages: [], attachments: [], takeovers: [] },
    });
    const actorA = buildCoordinationActor({ ...chapterStaff, chapterId: "wor" });
    const actorB = buildCoordinationActor({ ...chapterStaff, chapterId: "bos" });
    const { rerender } = render(
      <CoordinationWorkflowPanels tab="chapter" actor={actorA} model={missing("wor")} busy={false} actions={{ onSaveChapterProfile }} />,
    );
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Worcester draft" } });
    expect(screen.getByLabelText("English title")).toHaveValue("Worcester draft");
    rerender(
      <CoordinationWorkflowPanels tab="chapter" actor={actorB} model={missing("bos")} busy={false} actions={{ onSaveChapterProfile }} />,
    );
    expect(screen.getByLabelText("English title")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("English title"), { target: { value: "Boston draft" } });
    fireEvent.change(screen.getByLabelText("Spanish title"), { target: { value: "Boston draft" } });
    fireEvent.change(screen.getByLabelText("English summary"), { target: { value: "Summary" } });
    fireEvent.change(screen.getByLabelText("Spanish summary"), { target: { value: "Resumen" } });
    fireEvent.click(screen.getByRole("button", { name: "Save campaign profile" }));
    expect(onSaveChapterProfile).toHaveBeenCalledWith(expect.objectContaining({
      chapterCode: "bos", titleEn: "Boston draft",
    }));
  });

  it("offers no profile write while the microsite editor projection is degraded", () => {
    // Codex P1 ( round 11): when get_public_chapter_microsite_editor
    // fails, adapter.load() substitutes the empty 'missing' editor, which is
    // indistinguishable from a real missing profile except through
    // degradedProjections. The blank create form then let a submit overwrite an
    // existing profile whose copy could not be read, so a degraded editor must
    // render retry-only copy with no profile write control.
    const onSaveChapterProfile = vi.fn();
    const model = {
      ...snapshot,
      staff: true,
      degradedProjections: ["micrositeEditor"],
      micrositeEditor: { state: "missing", chapterCode: "wor", sections: [], pages: [], attachments: [], takeovers: [] },
    };
    render(<CoordinationWorkflowPanels tab="chapter" actor={chapterStaff} model={model} busy={false} actions={{ onSaveChapterProfile }} />);
    expect(screen.getByText(/could not be loaded/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save campaign profile" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Publish campaign profile")).not.toBeInTheDocument();
    expect(onSaveChapterProfile).not.toHaveBeenCalled();
  });

  it("shows the published profile status and prefilled publish checkbox in the ready state", () => {
    const onSaveChapterProfile = vi.fn();
    const model = {
      ...snapshot,
      staff: true,
      micrositeEditor: {
        state: "ready", chapterCode: "wor",
        profile: {
          titleEn: "Harborview Care United", titleEs: "Harborview Care United",
          bodyEn: "Published body", bodyEs: "Cuerpo publicado",
          published: true, updatedAt: "2026-09-21T13:00:00.000Z",
        },
        sections: [], pages: [], attachments: [], takeovers: [],
      },
    };
    render(<CoordinationWorkflowPanels tab="chapter" actor={chapterStaff} model={model} busy={false} actions={{ onSaveChapterProfile }} />);
    expect(screen.getByText(/is published on the public microsite/)).toBeVisible();
    expect(screen.getByLabelText("Publish campaign profile")).toBeChecked();
    expect(screen.getAllByLabelText("English summary")[0]).toHaveValue("Published body");
  });

  it("renders mission activity, mobilization progress, and unsupported panel states", () => {
    const model = { ...snapshot };
    const extensions = readyExtensions({
      badges: [{ missionId: "mission-1", alias: "Member A", badge: "bronze" }],
      recentActivity: [{ recordId: "mission-1", createdAt: "2026-08-28", type: "points_awarded", pointsDelta: 10 }, { recordId: "mission-2", createdAt: "2026-08-27", type: "status_changed", toStatus: "active" }],
      mobilizationProgress: [{ campaignId: "campaign-1", title: "Turnout", reached: 8, committed: 4, attended: 2 }],
    });
    const { rerender } = render(<CoordinationWorkflowPanels tab="missions" actor={staff} model={model} extensions={extensions} busy={false} actions={{}} />);
    expect(screen.getByRole("heading", { name: "Mission badges" })).toBeVisible();
    rerender(<CoordinationWorkflowPanels tab="mobilize" actor={staff} model={model} extensions={extensions} busy={false} actions={{}} />);
    expect(screen.getByText(/8 reached/)).toBeVisible();
    rerender(<CoordinationWorkflowPanels tab="unknown" actor={staff} model={model} extensions={extensions} busy={false} actions={{}} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("enters coverage windows as clock times with the storage timezone named on screen", async () => {
    const onCreate = vi.fn(async () => true);
    const model = { ...snapshot, records: [], directory: [], resources: [], micrositeEditor: { state: "missing" } };
    render(<OrganizationCoordinationDesk actor={chapterStaff} model={model} status="ready" onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("tab", { name: "Campaign" }));
    const creator = within(screen.getByLabelText("Create coordination work"));
    fireEvent.change(creator.getByLabelText("Workflow"), { target: { value: "coverage_schedule" } });

    // (a) the window is entered as a time of day, not a count of minutes.
    const start = creator.getByLabelText("Start time");
    const end = creator.getByLabelText("End time");
    expect(start).toHaveAttribute("type", "time");
    expect(end).toHaveAttribute("type", "time");
    expect(creator.queryByLabelText("Start minute")).not.toBeInTheDocument();
    expect(creator.queryByLabelText("End minute")).not.toBeInTheDocument();

    // (b) the form names, on screen, the zone the submit will stamp.
    const timezoneLabel = "Timezone the window is stored and evaluated in";
    expect(creator.getByLabelText(timezoneLabel)).toHaveValue("America/New_York");
    expect(screen.getByText(/stored and evaluated in America\/New_York/)).toBeVisible();

    fireEvent.change(creator.getByLabelText("Committee member ID"), { target: { value: "member-1" } });
    fireEvent.change(creator.getByLabelText("Day (0–6)"), { target: { value: "2" } });
    fireEvent.change(start, { target: { value: "10:00" } });
    fireEvent.change(end, { target: { value: "18:20" } });
    fireEvent.change(creator.getByLabelText("Title"), { target: { value: "Tuesday coverage" } });
    fireEvent.click(creator.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    // (c) 10:00–18:20 stores startMinute 600 / endMinute 1100 in the named zone.
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "coverage_schedule",
      config: expect.objectContaining({
        stewardUserId: "member-1",
        dayOfWeek: 2,
        startMinute: 600,
        endMinute: 1100,
        timezone: "America/New_York",
      }),
    }), expect.any(Function));

    // (d) an end-of-day window still submits as endMinute 1440.
    fireEvent.click(creator.getByLabelText("Window ends at the end of the day (24:00)"));
    expect(end).toBeDisabled();
    fireEvent.change(creator.getByLabelText("Title"), { target: { value: "Tuesday coverage" } });
    fireEvent.click(creator.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ startMinute: 600, endMinute: 1440, timezone: "America/New_York" }),
    }), expect.any(Function));

    fireEvent.click(creator.getByLabelText("Window ends at the end of the day (24:00)"));
    expect(end).not.toBeDisabled();
    fireEvent.change(end, { target: { value: "00:00" } });
    fireEvent.change(creator.getByLabelText("Title"), { target: { value: "Tuesday coverage" } });
    fireEvent.click(creator.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(3));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ startMinute: 600, endMinute: 1440, timezone: "America/New_York" }),
    }), expect.any(Function));

    // (e) changing the timezone field changes the stamped config.timezone.
    fireEvent.change(creator.getByLabelText(timezoneLabel), { target: { value: "America/Chicago" } });
    fireEvent.change(creator.getByLabelText("Title"), { target: { value: "Tuesday coverage" } });
    fireEvent.click(creator.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(4));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ startMinute: 600, endMinute: 1440, timezone: "America/Chicago" }),
    }), expect.any(Function));
    expect(screen.getByText(/stored and evaluated in America\/Chicago/)).toBeVisible();
  });
});

// The desk's write controls stay focusable while the desk-wide
// write runs (the browser focus fixup would otherwise send focus to the page),
// read as unavailable, and refuse a second activation.
describe("coordination controls keep focus while the desk's write runs", () => {
  const ownCoalition = { id: "coalition-b", kind: "coalition", title: "Own coalition", status: "active", visibility: "participants", organizationId: "org-1" };

  it("keeps a record card's Complete focused while its transition runs, and runs it once", async () => {
    const write = vi.fn(async () => true);
    render(<BusyTestHost>{(pending, run) => (
      <OrganizationCoordinationDesk actor={staff} model={{ ...snapshot, records: [ownCoalition] }} status="ready" busy={pending}
        onTransition={(...args) => run(() => write(...args))} />
    )}</BusyTestHost>);
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    const card = screen.getByRole("heading", { level: 3, name: "Own coalition" }).closest("article");
    await expectHeldWriteFocus(write, within(card).getByRole("button", { name: "Complete" }));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps Send invitation focused while the invitation is sent, and sends it once", async () => {
    const write = vi.fn(async () => true);
    render(<BusyTestHost>{(pending, run) => (
      <OrganizationCoordinationDesk actor={staff} model={{ ...snapshot, records: [ownCoalition] }} status="ready" busy={pending}
        onInviteOrganization={(input) => run(() => write(input))} />
    )}</BusyTestHost>);
    fireEvent.click(screen.getByRole("tab", { name: "Coalitions" }));
    const invite = screen.getByRole("heading", { name: "Invite an organization" }).closest("section");
    fireEvent.change(within(invite).getByRole("combobox", { name: "Coalition" }), { target: { value: "coalition-b" } });
    fireEvent.change(within(invite).getByLabelText("Organization ID"), { target: { value: "org-2" } });
    await expectHeldWriteFocus(write, within(invite).getByRole("button", { name: "Send invitation" }));
    expect(write).toHaveBeenCalledTimes(1);
  });
});

//  (carved from): Load older work and Load older messages were natively
// disabled while their own page read ran, so a keyboard user who pressed one
// lost focus to the page. Both are pending buttons now.
describe("coordination load-more buttons keep focus while their own read runs", () => {
  it("keeps focus on Load older work while the next page loads, and a second press loads nothing", async () => {
    const loadMore = vi.fn(async () => {});
    render(<LanguageProvider lang="en"><BusyTestHost>{(pending, run) => (
      <OrganizationCoordinationDesk actor={staff} model={{ ...snapshot, nextRecordsCursor: { id: "mission-1", createdAt: "2026-08-01T12:00:00Z" } }} status="ready" paging={pending} onLoadMore={() => run(loadMore)} />
    )}</BusyTestHost></LanguageProvider>);
    await expectHeldWriteFocus(loadMore, await screen.findByRole("button", { name: translate("en", "coordination.loadOlder") }));
  });

  it("keeps focus on Load older messages while the next page loads, and a second press loads nothing", async () => {
    const loadMoreMessages = vi.fn(async () => {});
    const model = {
      ...snapshot,
      messages: [{ id: "message-1", conversationId: "mission-1", body: "A fictional coordination note.", createdAt: "2026-08-02T12:00:00Z" }],
      nextMessagesCursor: { id: "message-1", createdAt: "2026-08-02T12:00:00Z" },
    };
    render(<LanguageProvider lang="en"><BusyTestHost>{(pending, run) => (
      <OrganizationCoordinationDesk actor={staff} model={model} status="ready" pagingMessages={pending} onLoadMore={vi.fn()} onLoadMoreMessages={() => run(loadMoreMessages)} />
    )}</BusyTestHost></LanguageProvider>);
    fireEvent.click(await screen.findByRole("tab", { name: "Network" }));
    await expectHeldWriteFocus(loadMoreMessages, await screen.findByRole("button", { name: translate("en", "coordination.panel.loadOlderMessages") }));
  });
});
