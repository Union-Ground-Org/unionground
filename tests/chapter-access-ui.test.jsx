import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CHAPTER_SETUP_CHANGED_EVENT } from "../src/lib/onboardingGuide.js";
import { ChapterAccessPanel } from "../src/features/chapterAccess/ChapterAccessPanel.jsx";
import { ChapterOfficePanel } from "../src/features/chapterAccess/ChapterOfficePanel.jsx";
import { DraftSharingPanel } from "../src/features/chapterAccess/DraftSharingPanel.jsx";
import { StewardSharedAccessPanel } from "../src/features/chapterAccess/StewardSharedAccessPanel.jsx";
import { GrievanceIdentityControl } from "../src/features/chapterAccess/GrievanceIdentityControl.jsx";
import { FormAnswerReview } from "../src/components/FormAnswerReview.jsx";
vi.mock("../src/lib/chapterAccessApi.js", async (original) => ({ ...(await original()), createChapterAccessApi: (client) => client?.access || null }));
// Unit settings have their own suite (unit-settings-editor); these access clients carry none.
vi.mock("../src/lib/unitSettings.js", async (original) => ({ ...(await original()), createUnitSettingsApi: (client) => client?.unitSettings || null }));
vi.mock("../src/features/notices/OfficerNoticeDesk.jsx", () => ({ OfficerNoticeDesk: ({ api, canPostOrganization }) => <div><span>{String(canPostOrganization)}</span><button onClick={() => { void api.publish("Notice", "Text", "es"); void api.listMine(); void api.receipts("n"); void api.listDrafts(); void api.resolveDraft("n", "publish"); }}>Test notice</button></div> }));
vi.mock("../src/lib/memberApi.js", () => ({ listMyMemberNotices: vi.fn(), getMemberNoticeReceipts: vi.fn(), listAnnouncementDrafts: vi.fn(), resolveAnnouncementDraft: vi.fn() }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const wrap = (node, lang = "en") => <LanguageProvider lang={lang}>{node}</LanguageProvider>;
const baseWorkspace = () => ({
  policy: { steward_grievances: true, steward_breadth: "campaign" },
  members: [{ id: "m", name: "Fictional Mira" }], units: [{ id: "u", name: "Garage", members: ["m"] }],
  committees: [{ id: "c", name: "Safety", purpose: "Review safety", starts_on: "2026-10-01", ends_on: "", grievance_access: false }],
  grants: [{ userId: "m", role: "secretary" }, { userId: "old", role: "steward", unitId: "u", scopeName: "Garage" }, { userId: "m", role: "records", committeeId: "c", scopeName: "Safety" }],
  roles: [{ role: "secretary", capability: "records" }, { role: "records", capability: "documents" }], settings: [{ role: "secretary", capability: "records", enabled: false }],
  grantableRoles: ["secretary", "records", "steward", "admin", "vp"], hasMoreMembers: true, hasMoreUnits: true, hasMoreCommittees: true,
});
const leadership = (workspace = baseWorkspace()) => ({ load: vi.fn(async () => workspace), setPolicy: vi.fn(async () => {}), setRole: vi.fn(async () => {}), setMember: vi.fn(async () => {}), saveCommittee: vi.fn(async () => {}), setCapability: vi.fn(async () => {}) });
describe("chapter leadership access", () => {
  // REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109: placing a steward tells the
  // staff guide to read the units step's facts again, once the write lands.
  it.each(["en", "es"])("lets a campaign lead narrow an existing steward without offering a fresh steward grant (%s)", async (lang) => {
    const workspace = baseWorkspace();
    workspace.grantableRoles = ["secretary", "records"];
    workspace.grants = [{ userId: "m", role: "steward", unitId: "u", legacyChapterCoverage: true }];
    workspace.units.push({ id: "v", name: "Other unit", members: [] });
    const api = leadership(workspace);
    render(wrap(<ChapterAccessPanel client={{ access: api }} chapterId="ch" />, lang));
    const name = lang === "es" ? "Asignar una unidad de miembro del comité a Fictional Mira" : "Assign a committee member unit to Fictional Mira";
    const form = await screen.findByRole("form", { name });
    expect(within(form.closest("li")).getAllByRole("button")).toHaveLength(1);
    const select = within(form).getByRole("combobox");
    expect(select).toBeRequired(); expect(select).toHaveValue("");
    expect(within(form).getByRole("button")).toBeDisabled();
    const roles = screen.getByLabelText(lang === "es" ? "Rol de acceso" : "Access role");
    expect(within(roles).queryByRole("option", { name: lang === "es" ? "Miembro del comité" : "Committee member" })).not.toBeInTheDocument();
    fireEvent.submit(form); expect(api.setRole).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: "v" } }); fireEvent.submit(form);
    await waitFor(() => expect(api.setRole).toHaveBeenCalledExactlyOnceWith("ch", "m", "steward", { unitId: "v" }, true));
  });
  it("shows carried-over coverage and requires an explicit unit choice without a chapter or committee escape", async () => {
    const workspace = baseWorkspace();
    workspace.grants.push({ userId: "m", role: "steward", unitId: "u", legacyChapterCoverage: true });
    const api = leadership(workspace); render(wrap(<ChapterAccessPanel client={{ access: api }} chapterId="ch" />));
    expect(await screen.findByText(/All units, kept from before units were required/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Access role"), { target: { value: "steward" } });
    const form = screen.getByRole("button", { name: "Give access" }).closest("form");
    const scope = within(form).getByLabelText("Access scope");
    expect(scope).toBeRequired(); expect(scope).toHaveValue("");
    expect(within(scope).queryByText("Whole campaign")).not.toBeInTheDocument();
    expect(within(scope).queryByText(/Safety/)).not.toBeInTheDocument();
    fireEvent.submit(form); expect(api.setRole).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a campaign unit");
    fireEvent.change(scope, { target: { value: "unit:u" } }); fireEvent.submit(form);
    await waitFor(() => expect(api.setRole).toHaveBeenCalledWith("ch", "m", "steward", { unitId: "u" }, true));
  });
  it("grants Treasurer only at chapter scope and changes its financial capabilities", async () => {
    const workspace=baseWorkspace();workspace.grantableRoles.push("treasurer");workspace.roles.push({role:"treasurer",capability:"finance_records"});
    const api=leadership(workspace);render(wrap(<ChapterAccessPanel client={{access:api}} chapterId="ch"/>));
    await screen.findByLabelText("Access role");
    fireEvent.change(screen.getByLabelText("Access role"),{target:{value:"treasurer"}});
    const form=screen.getByRole("button",{name:"Give access"}).closest("form");
    expect(within(form).getByLabelText("Access scope")).toBeDisabled();
    await expectHeldWriteFocus(api.setRole, form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]'), () => fireEvent.submit(form));await waitFor(()=>expect(api.setRole).toHaveBeenCalledWith("ch","m","treasurer",{},true));
    await act(async()=>{});
    fireEvent.click(await screen.findByLabelText("Treasurer · Financial records and requests"));
    await waitFor(()=>expect(api.setCapability).toHaveBeenCalledWith("ch","treasurer","finance_records",false));
  });
  it("keeps a capability switch focused while its change is saved (#8435)", async () => {
    const api = leadership(); render(wrap(<ChapterAccessPanel client={{ access: api }} chapterId="ch" />));
    const toggle = await screen.findByLabelText("Secretary · Minutes and records");
    await expectHeldWriteFocus(api.setCapability, toggle);
    await waitFor(() => expect(api.setCapability).toHaveBeenCalledWith("ch", "secretary", "records", true));
    expect(api.setCapability).toHaveBeenCalledTimes(1);
  });

  it("saves one capability change when two land before the first one commits (#8435)", async () => {
    const api = leadership(); render(wrap(<ChapterAccessPanel client={{ access: api }} chapterId="ch" />));
    const toggle = await screen.findByLabelText("Secretary · Minutes and records");
    let finish;
    api.setCapability.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    // Both changes arrive in one React batch, before `busy` commits, so only
    // run()'s own lock can refuse the second.
    act(() => { fireEvent.click(toggle); fireEvent.click(toggle); });
    await waitFor(() => expect(api.setCapability).toHaveBeenCalledTimes(1));
    await act(async () => { finish(); });
    expect(api.setCapability).toHaveBeenCalledTimes(1);
  });

  it("paginates independently, searches, retries failures and renders Spanish empty states", async () => {
    const api = leadership(); api.load.mockRejectedValueOnce(Error("offline"));
    const view = render(wrap(<ChapterAccessPanel client={{ access: api }} chapterId="ch" />));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" })); await screen.findByRole("button", { name: "Give access" });
    for (const label of ["Workers", "Units and worksites", "Committees"]) {
      fireEvent.click(within(screen.getByRole("navigation", { name: label })).getByRole("button", { name: "Next" }));
      await waitFor(() => { expect(within(screen.getByRole("navigation", { name: label })).getByRole("button", { name: "Previous" })).not.toBeDisabled(); expect((within(screen.getByRole("navigation", { name: label })).getByRole("button", { name: "Previous" })).closest('[aria-disabled="true"]')).toBeNull(); });
      fireEvent.click(within(screen.getByRole("navigation", { name: label })).getByRole("button", { name: "Previous" }));
      await screen.findByRole("button", { name: "Give access" });
    }
    fireEvent.change(screen.getByLabelText("Find a worker"), { target: { value: "Mira" } }); fireEvent.submit(screen.getByLabelText("Find a worker").closest("form"));
    await waitFor(() => expect(api.load).toHaveBeenLastCalledWith("ch", { members: 0, units: 0, committees: 0 }, "Mira"));
    await act(async () => {});
    await screen.findByRole("button", { name: "Give access" }); api.setRole.mockRejectedValueOnce(Error("refused")); fireEvent.click(screen.getAllByRole("button", { name: "Remove access" })[0]);
    await screen.findByRole("alert"); view.unmount();
    const empty = baseWorkspace(); empty.members = []; empty.grants = []; empty.units = []; empty.committees = [];
    const spanish = render(wrap(<ChapterAccessPanel client={{ access: leadership(empty) }} chapterId="ch" />, "es"));
    await screen.findByText("No hay resultados en esta página."); expect(screen.getByRole("button", { name: "Dar acceso" })).toBeDisabled(); spanish.unmount();
    render(wrap(<ChapterAccessPanel client={null} chapterId="" />)); expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
  it("discards late reads and writes after changing chapters", async () => {
    const read = deferred(), write = deferred(); const api = leadership(); api.load.mockImplementationOnce(() => read.promise);
    const client = { access: api }; const view = render(wrap(<ChapterAccessPanel client={client} chapterId="old" />));
    view.rerender(wrap(<ChapterAccessPanel client={client} chapterId="new" />)); await screen.findByRole("button", { name: "Give access" });
    await act(async () => read.resolve({ ...baseWorkspace(), members: [{ id: "old", name: "Stale member" }] })); expect(screen.queryByText("Stale member")).not.toBeInTheDocument();
    api.setRole.mockImplementationOnce(() => write.promise); fireEvent.click(screen.getAllByRole("button", { name: "Remove access" })[0]);
    view.rerender(wrap(<ChapterAccessPanel client={client} chapterId="third" />)); await screen.findByRole("button", { name: "Give access" });
    await act(async () => write.resolve()); expect(screen.queryByText("Access updated.")).not.toBeInTheDocument();
  });
  it("does not report old chapter failures after moving to another chapter", async () => {
    const read = deferred(), write = deferred(); const api = leadership(); api.load.mockImplementationOnce(() => read.promise);
    const client = { access: api }; const view = render(wrap(<ChapterAccessPanel client={client} chapterId="old" />));
    view.rerender(wrap(<ChapterAccessPanel client={client} chapterId="new" />)); await screen.findByRole("button", { name: "Give access" });
    await act(async () => read.reject(Error())); api.setRole.mockImplementationOnce(() => write.promise); fireEvent.click(screen.getAllByRole("button", { name: "Remove access" })[0]);
    view.rerender(wrap(<ChapterAccessPanel client={client} chapterId="third" />)); await screen.findByRole("button", { name: "Give access" }); await act(async () => write.reject(Error())); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("explicit draft sharing", () => {
  it.each([
    ["en", "Could not load the committee members you can share this draft with.", "Try again"],
    ["es", "No se pudo cargar la lista de miembros del comité con quienes puedes compartir este borrador.", "Intentar de nuevo"],
  ])("describes a failed draft-sharing read and lets the member retry (%s)", async (lang, message, retry) => {
    const sharing = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue([]);
    render(wrap(<DraftSharingPanel api={{ sharing }} formId="f" />, lang));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    fireEvent.click(screen.getByRole("button", { name: retry }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(sharing.mock.calls).toEqual([["f"], ["f"]]);
  });
  // #9470 (W9-5): a member with no covering steward is told why the list is empty.
  it.each([["en", "No committee member is assigned to you yet, so there is no one to share this draft with. Your campaign can assign one."], ["es", "Aún no tienes un miembro del comité asignado, así que no hay con quién compartir este borrador. Tu campaña puede asignarte uno."]])("says no steward is assigned yet instead of an empty page (%s)", async (lang, noSteward) => {
    render(wrap(<DraftSharingPanel api={{ sharing: vi.fn().mockResolvedValue([]), share: vi.fn() }} formId="f" />, lang));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(noSteward));
    expect(screen.queryByText("None on this page.")).not.toBeInTheDocument();
  });
  it("shares and revokes only the selected steward, and recovers from errors", async () => {
    const api = { sharing: vi.fn().mockRejectedValueOnce(Error()).mockResolvedValue([{ id: "s", name: "Fictional Lee", shared: false }]), share: vi.fn().mockRejectedValueOnce(Error()).mockResolvedValue(undefined) };
    render(wrap(<DraftSharingPanel api={api} formId="f" />)); fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Share with Fictional Lee" })); await screen.findByText("That change could not be confirmed. The list was read again just now; check who this draft is shared with, and try again if it is not what you wanted.");
    api.sharing.mockResolvedValue([{ id: "s", name: "Fictional Lee", shared: true }]); fireEvent.click(screen.getByRole("button", { name: "Share with Fictional Lee" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop sharing with Fictional Lee" })); await waitFor(() => expect(api.share).toHaveBeenLastCalledWith("f", "s", false));
    await act(async () => {});
    expect(api.share).toHaveBeenCalledWith("f", "s", true);
  });
  it("clears old recipients and ignores late reads, failures and save results", async () => {
    const read = deferred(), write = deferred(); const api = { sharing: vi.fn().mockImplementationOnce(() => read.promise).mockResolvedValue([]), share: vi.fn(() => write.promise) };
    const view = render(wrap(<DraftSharingPanel api={api} formId="old" />)); view.rerender(wrap(<DraftSharingPanel api={api} formId="new" />));
    await screen.findByText("No committee member is assigned to you yet, so there is no one to share this draft with. Your campaign can assign one."); await act(async () => read.reject(Error())); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    api.sharing.mockResolvedValue([{ id: "s", name: "Fictional Lee", shared: false }]); view.rerender(wrap(<DraftSharingPanel api={api} formId="third" />)); fireEvent.click(await screen.findByRole("button", { name: "Share with Fictional Lee" }));
    view.rerender(wrap(<DraftSharingPanel api={api} formId="fourth" />)); await screen.findByRole("button", { name: "Share with Fictional Lee" }); await act(async () => write.reject(Error())); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Secretary document and notice workspace", () => {
  const office = { chapterId: "ch", documents: true, notices: true, unscopedDocuments: true, scopes: [{ role: "secretary", name: "Garage", unitId: "u", documents: true }, { role: "records", name: "Safety", committeeId: "c", documents: true }] };
  const makeApi = () => ({ office: vi.fn(async () => office), documents: vi.fn(async () => [{ id: "d", title: "Minutes", summary: "Decisions", body: "Meeting record", status: "draft" }]), saveDocument: vi.fn(async () => {}), publishNotice: vi.fn(async () => {}) });
  it("keeps notices out of the Records-only selected role even when the account also holds Secretary", async () => {
    render(wrap(<ChapterOfficePanel client={{access:makeApi()}} chapterId="ch" role="records"/>));
    await screen.findByRole("button",{name:"New document"});
    expect(screen.queryByRole("button",{name:"Test notice"})).toBeNull();
  });
  it("preserves the staff audience and original category when republishing an existing document", async () => {
    const api = makeApi();
    api.documents.mockResolvedValue([{ id: "d", title: "Staff minutes", summary: "Decisions", body: "Private meeting record", status: "published", visibility: "staff", document_type: "minutes" }]);
    render(wrap(<ChapterOfficePanel client={{ access: api }} chapterId="ch" />));
    fireEvent.click(await screen.findByRole("button", { name: "Edit document" }));
    await expectHeldWriteFocus(api.saveDocument, screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledWith("d", expect.objectContaining({ visibility: "staff", documentType: "minutes" }), "republish"));
  });
  it("creates scoped drafts, publishes and archives documents, and uses only chapter notice publication", async () => {
    const api = makeApi(), onNotice = vi.fn(); render(wrap(<ChapterOfficePanel client={{ access: api }} chapterId="ch" onNotice={onNotice} />));
    fireEvent.click(await screen.findByRole("button", { name: "New document" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New minutes" } }); fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "Recorded" } });
    fireEvent.change(screen.getByLabelText("Access scope"), { target: { value: "committee:c" } }); fireEvent.submit(screen.getByLabelText("Title").closest("form"));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledWith(undefined, expect.objectContaining({ chapterId: "ch", title: "New minutes", accessScope: "committee:c", status: "draft" }), "save"));
    await act(async () => {});
    await screen.findByRole("button", { name: "Edit document" }); fireEvent.click(screen.getByRole("button", { name: "Edit document" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenLastCalledWith("d", expect.objectContaining({ title: "Minutes", status: "published" }), "republish"));
    await act(async () => {});
    await screen.findByRole("button", { name: "Edit document" }); fireEvent.click(screen.getByRole("button", { name: "Edit document" })); fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenLastCalledWith("d", expect.any(Object), "archive"));
    await act(async () => {});
    await screen.findByRole("button", { name: "Test notice" }); fireEvent.click(screen.getByRole("button", { name: "Test notice" })); expect(api.publishNotice).toHaveBeenCalledWith("ch", "Notice", "Text", "es", "", undefined);
    expect(screen.getByText("false")).toBeInTheDocument(); expect(onNotice).toHaveBeenCalledWith("Access updated.");
  });
  it("shows scoped options, refuses invalid input and recovers from a document save failure", async () => {
    const api = makeApi(); api.office.mockResolvedValue({ ...office, unscopedDocuments: false }); api.documents.mockResolvedValue([]); api.saveDocument.mockRejectedValueOnce(Error());
    render(wrap(<ChapterOfficePanel client={{ access: api }} chapterId="ch" />)); await screen.findByText("None on this page."); fireEvent.click(screen.getByRole("button", { name: "New document" }));
    expect(screen.queryByRole("option", { name: "Whole campaign" })).not.toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Publish" })); expect(api.saveDocument).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Title" } }); fireEvent.change(screen.getByLabelText("Document text"), { target: { value: "Body" } }); fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByText("Changes could not be saved. Try again."); api.saveDocument.mockResolvedValue(undefined); fireEvent.click(screen.getByRole("button", { name: "Publish" })); await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New document" })); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
  });
  it("paginates, hides draft-save for published rows and retries rollout/context failures", async () => {
    const api = makeApi(); api.office.mockResolvedValueOnce({ ...office, chapterId: "old" });
    api.documents.mockResolvedValue(Array.from({ length: 21 }, (_, i) => ({ id: String(i), title: `Document ${i}`, body: "Body", summary: "Summary", status: "published" })));
    const client = { access: api }; const view = render(wrap(<ChapterOfficePanel client={client} chapterId="ch" />)); fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" })); await waitFor(() => expect(api.documents).toHaveBeenLastCalledWith("ch", 1));
    await act(async () => {});
    await screen.findByRole("button", { name: "Previous" }); fireEvent.click(screen.getByRole("button", { name: "Previous" })); await waitFor(() => expect(api.documents).toHaveBeenLastCalledWith("ch", 0));
    await act(async () => {});
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit document" }))[0]); expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    view.unmount(); render(wrap(<ChapterOfficePanel client={null} chapterId="" />)); expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
  it("does not load unauthorized documents or settle an old chapter's work", async () => {
    const read = deferred(), write = deferred(); const api = makeApi(); api.office.mockImplementationOnce(() => read.promise).mockResolvedValue({ ...office, documents: false, notices: false, unscopedNotices: false });
    const client = { access: api }; const view = render(wrap(<ChapterOfficePanel client={client} chapterId="old" />)); view.rerender(wrap(<ChapterOfficePanel client={client} chapterId="ch" />));
    await act(async () => read.reject(Error())); expect(api.documents).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    api.office.mockResolvedValue(office); view.rerender(wrap(<ChapterOfficePanel client={client} chapterId="ch" key="reset" />));
    fireEvent.click(await screen.findByRole("button", { name: "Edit document" })); api.saveDocument.mockImplementationOnce(() => write.promise); fireEvent.submit(screen.getByLabelText("Title").closest("form"));
    view.rerender(wrap(<ChapterOfficePanel client={client} chapterId="other" key="other" />)); await act(async () => write.resolve()); expect(screen.queryByText("Access updated.")).not.toBeInTheDocument();
  });
  it("publishes only to the selected office scope and clears the composer when it changes", async () => {
    const api = makeApi(); const scopes = [{ role: "secretary", unitId: "u", name: "Garage", notices: true }, { role: "secretary", committeeId: "c", name: "Safety", notices: true }];
    api.office.mockResolvedValue({ ...office, documents: false, unscopedNotices: false, scopes });
    const client = { access: api }; const view = render(wrap(<ChapterOfficePanel client={client} chapterId="ch" />));
    fireEvent.click(await screen.findByRole("button", { name: "Test notice" })); expect(api.publishNotice).toHaveBeenLastCalledWith("ch", "Notice", "Text", "es", "unit:u", undefined);
    expect(screen.queryByRole("option", { name: "Whole campaign" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Notice audience"), { target: { value: "committee:c" } }); fireEvent.click(screen.getByRole("button", { name: "Test notice" })); expect(api.publishNotice).toHaveBeenLastCalledWith("ch", "Notice", "Text", "es", "committee:c", undefined);
    view.unmount(); api.office.mockResolvedValue({ ...office, documents: false, unscopedNotices: true, scopes });
    render(wrap(<ChapterOfficePanel client={client} chapterId="ch" />)); await screen.findByRole("option", { name: "Whole campaign" });
    fireEvent.change(screen.getByLabelText("Notice audience"), { target: { value: "unit:u" } }); fireEvent.click(screen.getByRole("button", { name: "Test notice" })); expect(api.publishNotice).toHaveBeenLastCalledWith("ch", "Notice", "Text", "es", "unit:u", undefined);
    fireEvent.change(screen.getByLabelText("Notice audience"), { target: { value: "" } }); fireEvent.click(screen.getByRole("button", { name: "Test notice" })); expect(api.publishNotice).toHaveBeenLastCalledWith("ch", "Notice", "Text", "es", "", undefined);
  });
});

describe("private grievance controls and shared readers", () => {
  it("revalidates the assigned steward's identity toggle, handles errors, and offers no control without permission", async () => {
    const api = { loadIdentityVisibility: vi.fn(async () => ({ canChange: true, private: false })), setIdentityPrivate: vi.fn().mockRejectedValueOnce(Error()).mockResolvedValue(undefined) };
    const view = render(wrap(<GrievanceIdentityControl api={api} caseId="c" />)); fireEvent.click(await screen.findByRole("checkbox")); await screen.findByRole("alert");
    api.loadIdentityVisibility.mockResolvedValue({ canChange: true, private: true }); fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked()); expect(api.setIdentityPrivate).toHaveBeenLastCalledWith("c", true);
    view.rerender(wrap(<GrievanceIdentityControl api={{}} caseId="other" />)); expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("ignores a case's late toggle/read after leaving it", async () => {
    const read = deferred(), write = deferred(); const api = { loadIdentityVisibility: vi.fn().mockImplementationOnce(() => read.promise).mockResolvedValue({ canChange: true, private: false }), setIdentityPrivate: vi.fn(() => write.promise) };
    const view = render(wrap(<GrievanceIdentityControl api={api} caseId="old" />)); view.rerender(wrap(<GrievanceIdentityControl api={api} caseId="new" />));
    await screen.findByRole("checkbox"); await act(async () => read.reject(Error())); fireEvent.click(screen.getByRole("checkbox")); view.rerender(wrap(<GrievanceIdentityControl api={api} caseId="third" />));
    await screen.findByRole("checkbox"); await act(async () => write.resolve()); expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  it("discards a prior case's successful visibility read and failed toggle", async () => {
    const read = deferred(), write = deferred(); const api = { loadIdentityVisibility: vi.fn().mockImplementationOnce(() => read.promise).mockResolvedValue({ canChange: true, private: false }), setIdentityPrivate: vi.fn(() => write.promise) };
    const view = render(wrap(<GrievanceIdentityControl api={api} caseId="old" />)); view.rerender(wrap(<GrievanceIdentityControl api={api} caseId="new" />));
    fireEvent.click(await screen.findByRole("checkbox")); view.rerender(wrap(<GrievanceIdentityControl api={api} caseId="third" />)); await screen.findByRole("checkbox");
    await act(async () => { read.resolve({ canChange: true, private: true }); write.reject(Error()); }); expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("reads labeled pinned answers and only safe grievance summaries, with retry and stale-response protection", async () => {
    const read = deferred(); const draft = { id: "f", answers: { answer: "Shared answer" }, template: { key: "custom", version: 1, label_en: "Shared form", label_es: "Formulario compartido", field_schema: { steps: [{ fields: [{ key: "answer", type: "text", label: { en: "Question", es: "Pregunta" } }] }] } } };
    const api = { sharedDrafts: vi.fn().mockImplementationOnce(() => read.promise).mockResolvedValue([draft]), privateGrievances: vi.fn(async () => [{ id: "c", status: "active" }, { id: "done", status: "resolved" }]) };
    const view = render(wrap(<StewardSharedAccessPanel api={api} />)); view.unmount(); await act(async () => read.resolve([]));
    api.sharedDrafts.mockRejectedValueOnce(Error()); const ready = render(wrap(<StewardSharedAccessPanel api={api} />, "es"));
    fireEvent.click(await screen.findByRole("button", { name: "Intentar de nuevo" })); await screen.findByText("Formulario compartido"); expect(screen.getByText("Shared answer")).toBeInTheDocument(); expect(screen.getByText("Pregunta")).toBeInTheDocument(); expect(screen.getAllByText(/Queja privada/)).toHaveLength(2);
    ready.unmount(); api.sharedDrafts.mockResolvedValue([]); api.privateGrievances.mockResolvedValue([]); const empty = render(wrap(<StewardSharedAccessPanel api={api} />)); await waitFor(() => expect(api.privateGrievances).toHaveBeenCalledTimes(4)); await act(async () => {}); expect(empty.container).toBeEmptyDOMElement();
  });
  it("does not report a late shared-workspace failure after unmounting", async () => {
    const read = deferred(); const api = { sharedDrafts: () => read.promise, privateGrievances: async () => [] };
    const view = render(wrap(<StewardSharedAccessPanel api={api} />)); view.unmount(); await act(async () => read.reject(Error())); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("formats empty, scalar, check and translated option answers without showing internal keys", () => {
    const fields = [{ key: "a", type: "multiselect", options: [{ value: "x", labelKey: "Chosen" }] }, { key: "b", type: "multiselect" }, { key: "c", type: "select", options: [{ value: "x", labelKey: "Chosen" }] }, { key: "d", type: "radio" }, { key: "e", type: "checkbox" }, { key: "f", type: "text" }, { key: "g", type: "text" }, { key: "h", type: "select" }].map((field) => ({ ...field, labelKey: `Question ${field.key}` }));
    const template = { steps: [{ fields }] }; const t = (key) => key;
    const view = render(<FormAnswerReview template={template} answers={{ a: ["x", "legacy"], b: "invalid", c: "x", d: "free", e: true, f: "  ", h: "" }} t={t} />);
    expect(screen.getByText("Chosen, legacy")).toBeInTheDocument(); expect(screen.getByText("Chosen")).toBeInTheDocument(); expect(screen.getByText("free")).toBeInTheDocument(); expect(screen.getByText("✓")).toBeInTheDocument(); expect(screen.getAllByText("forms.notAnswered")).toHaveLength(4);
    view.rerender(<FormAnswerReview template={template} answers={{ a: [], b: ["raw"], c: null, d: null, e: false, f: " trimmed " }} t={t} lead={false} />);
    expect(screen.getByText("trimmed")).toBeInTheDocument(); expect(screen.queryByText("forms.reviewLead")).not.toBeInTheDocument();
  });
});
