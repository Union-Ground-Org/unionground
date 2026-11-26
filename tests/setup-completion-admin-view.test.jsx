// Ledger 423 (record 8435, slice 10): with the real AdminView, a setup create
// that settles after a hat switch (the same member and organization; App
// renders only the selected view, so the admin desk unmounts) still shows the
// success notice through the app's member and organization scope. A member or
// organization departure still shows nothing.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { useBusyScope } from "../src/lib/busyWrite.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const catalog = vi.hoisted(() => ({ rpc: async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) }));
vi.mock("../src/lib/supabase.js", async (original) => ({ ...await original(), supabase: catalog }));

function makeApi(overrides = {}) {
  return {
    loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.adminDesk))),
    grantRole: vi.fn().mockResolvedValue({ granted: true }),
    revokeRole: vi.fn().mockResolvedValue({ revoked: true }),
    searchMembers: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockResolvedValue({ created: true }),
    updateEvent: vi.fn().mockResolvedValue({ updated: true }),
    closeGovernance: vi.fn().mockResolvedValue({ updated: true }),
    loadFormTemplates: vi.fn().mockResolvedValue([]),
    upsertFormTemplate: vi.fn().mockResolvedValue({ key: "demo", version: 1, active: true }),
    deactivateFormTemplate: vi.fn().mockResolvedValue({ key: "demo", active: false }),
    reactivateFormTemplate: vi.fn().mockResolvedValue({ key: "demo", active: true }),
    updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    updateOrganizationLabel: vi.fn().mockResolvedValue({ updated: true }),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
    dispositionFailedLoginAttempt: vi.fn().mockResolvedValue({ updated: true }),
    loadAdministrativeEvidence: vi.fn().mockResolvedValue({
      fieldNoteBlocks: [], packets: [], actions: [], history: [],
    }),
    addFieldNoteEvidence: vi.fn().mockResolvedValue({ created: true }),
    draftFieldNotePacket: vi.fn().mockResolvedValue({ created: true }),
    executeAdministrativeObjectAction: vi.fn().mockResolvedValue({ created: true }),
    ...overrides,
  };
}

const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const SUCCESS = "Your structure is set up. Invite members next.";

function Owner({ member, children }) {
  const scope = useBusyScope(JSON.stringify([member.id, member.organizationId]));
  return children(scope.guard);
}

async function heldCreateInAdminView(change) {
  let finish;
  const api = makeApi({
    getOrganizationCatalogPlacement: vi.fn().mockResolvedValue(null),
    setOrganizationCatalogPlacement: vi.fn().mockResolvedValue(null),
    clearOrganizationCatalogPlacement: vi.fn().mockResolvedValue(null),
    importOrganizationStructure: vi.fn((hat, payload, dryRun) => dryRun
      ? Promise.resolve({ dryRun: true, committed: false, errors: [], warnings: [], counts: {} })
      : new Promise((resolve) => { finish = () => resolve({ dryRun: false, committed: true, errors: [], warnings: [], counts: {} }); })),
  });
  const onNotice = vi.fn();
  const tree = ({ memberId = "admin-1", organizationId = ORG, hat = "admin" } = {}) => (
    <LanguageProvider lang="en">
      <Owner member={{ id: memberId, organizationId }}>{(guard) => hat !== "admin" ? <p>Steward desk</p> : (
        <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
          <AdminView data={{ member: { id: memberId, initials: "AR", fullName: "Example Admin", chapterName: "Cedar Ridge Care Services", organizationRoles: ["admin"], organizationId } }} api={api} onNotice={onNotice} setupCompletionGuard={guard} />
        </WorkspacePages>
      )}</Owner>
    </LanguageProvider>
  );
  window.history.replaceState({}, "", "/m/admin/setup-review");
  const view = render(tree());
  fireEvent.click(await screen.findByRole("radio", { name: "Build my own" }));
  fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "Example Workers Local 1" } });
  fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "The members elected me president at the March meeting" } });
  fireEvent.click(screen.getByRole("button", { name: "Add a campaign or office" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Harbor Chapter" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Check 1 items" }));
  await screen.findByText("Ready: 1 items will be created.");
  fireEvent.click(screen.getByRole("button", { name: "Create 1" }));
  await waitFor(() => expect(api.importOrganizationStructure.mock.calls.filter((call) => call[2] === false)).toHaveLength(1));
  for (const next of [].concat(change)) {
    view.rerender(tree(next));
    if ((next.hat ?? "admin") === "admin") await screen.findByRole("heading", { name: "Set up your organization", level: 1 });
  }
  const reads = api.loadDesk.mock.calls.length;
  await act(async () => { finish(); });
  return { onNotice, api, reads };
}

describe("setup completion through the real admin desk", () => {
  afterEach(() => { window.history.replaceState({}, "", "/"); window.localStorage.clear(); });

  it("shows the success notice for a create that settles after a hat switch", async () => {
    const { onNotice } = await heldCreateInAdminView({ hat: "steward" });
    expect(screen.getByText("Steward desk")).toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith(SUCCESS);
  });

  // Slice 10 review (second reader, F2): back on the admin desk before the
  // create settles, the desk now shown reads again beside the notice.
  it("refreshes the desk shown again after a hat switch and back, beside the success notice", async () => {
    const { onNotice, api, reads } = await heldCreateInAdminView([{ hat: "steward" }, { hat: "admin" }]);
    expect(onNotice).toHaveBeenCalledWith(SUCCESS);
    await waitFor(() => expect(api.loadDesk.mock.calls.length).toBe(reads + 1));
  });

  it.each([
    ["the organization", { organizationId: "a1b2c3d4-0000-4000-8000-000000000002", hat: "steward" }],
    ["the member", { memberId: "admin-2", hat: "steward" }],
  ])("shows nothing for a create that settles after %s changed", async (_name, change) => {
    const { onNotice } = await heldCreateInAdminView(change);
    expect(onNotice).not.toHaveBeenCalledWith(SUCCESS);
  });
});
