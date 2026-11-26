import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OfficerNoticeDesk } from "../src/features/notices/OfficerNoticeDesk.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { loadNoticeAudiences, publishNoticeForAudience } from "../src/lib/noticeAudience.js";
import { ChapterOfficePanel } from "../src/features/chapterAccess/ChapterOfficePanel.jsx";
import { CompassAnswerActions } from "../src/features/compass/CompassAnswerActions.jsx";
import { t } from "../src/lib/i18n.js";

vi.mock("../src/lib/chapterAccessApi.js", () => ({ createChapterAccessApi: (client) => client.access }));
vi.mock("../src/lib/memberApi.js", () => ({
  listMyMemberNotices: async () => ({ notices: [], hasMore: false }),
  listAnnouncementDrafts: async () => [], getMemberNoticeReceipts: vi.fn(), resolveAnnouncementDraft: vi.fn(),
}));

afterEach(cleanup);
const unit = { value: "unit:11111111-1111-4111-8111-111111111111", kind: "unit", chapterId: "chapter-a", unitId: "11111111-1111-4111-8111-111111111111", name: "Unit A" };

it.each([
  ["en", "Unit: Unit A", "The whole organization", "Title", "Notice", "Post notice"],
  ["es", "Unidad: Unit A", "Toda la organización", "Título", "Aviso", "Publicar aviso"],
])("offers the granted unit instead of a broad audience for an organization steward (%s)", async (lang, label, organization, title, body, post) => {
  const context = { chapterId: unit.chapterId, role: "steward", canPostOrganization: true };
  const client = { rpc: vi.fn(async (name) => ({ data: name === "get_chapter_office_access" ? {
    chapterId: unit.chapterId, notices: true, unscopedNotices: false,
    scopes: [{ role: "steward", notices: true, unitId: unit.unitId, name: unit.name }], organizationRoles: ["steward"],
  } : { broadcastId: "notice-a" }, error: null })) };
  const api = {
    loadAudiences: () => loadNoticeAudiences(client, context),
    publish: vi.fn((title, body, locale, audience, operationKey) => publishNoticeForAudience(client, title, body, locale, audience, context, operationKey)),
    listMine: vi.fn().mockResolvedValue({ notices: [], hasMore: false }),
    listDrafts: vi.fn().mockResolvedValue([]),
  };
  render(<LanguageProvider lang={lang}><OfficerNoticeDesk api={api} canPostOrganization /></LanguageProvider>);
  await waitFor(() => expect(screen.queryByLabelText(organization)).not.toBeInTheDocument());
  expect(await screen.findByLabelText(label)).toBeChecked();
  fireEvent.change(screen.getByLabelText(title), { target: { value: "Unit meeting" } });
  fireEvent.change(screen.getByLabelText(body), { target: { value: "For Unit A only" } });
  fireEvent.click(screen.getByRole("button", { name: post }));
  await waitFor(() => expect(api.publish).toHaveBeenCalledWith("Unit meeting", "For Unit A only", lang, unit.value, expect.any(String)));
  expect(client.rpc).toHaveBeenLastCalledWith("publish_chapter_office_notice", {
    p_chapter: unit.chapterId, p_unit: unit.unitId, p_committee: null,
    p_title: "Unit meeting", p_body: "For Unit A only", p_locale: lang, p_idempotency_key: expect.any(String),
  });
  expect(client.rpc).not.toHaveBeenCalledWith("publish_member_broadcast", expect.anything());
});

it.each(["en", "es"])("keeps drafts while an audience is pending, unavailable or revoked (%s)", async (lang) => {
  let resolve;
  const api = {
    loadAudiences: vi.fn().mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue([unit]),
    publish: vi.fn().mockRejectedValueOnce(Object.assign(new Error("Revoked"), { code: "notice_audience_unavailable" })).mockResolvedValue({}),
    listMine: vi.fn().mockResolvedValue({ notices: [], hasMore: false }), listDrafts: vi.fn().mockResolvedValue([]),
  };
  const post = lang === "en" ? "Post notice" : "Publicar aviso";
  const titleLabel = lang === "en" ? "Title" : "Título";
  render(<LanguageProvider lang={lang}><OfficerNoticeDesk api={api} /></LanguageProvider>);
  fireEvent.change(screen.getByLabelText(titleLabel), { target: { value: "Keep this draft" } });
  fireEvent.change(screen.getByLabelText(lang === "en" ? "Notice" : "Aviso"), { target: { value: "Our unit" } });
  expect(screen.getByRole("button", { name: post })).toBeDisabled();
  await act(async () => resolve([]));
  expect(screen.getByRole("button", { name: post })).toBeDisabled();
  const reload = lang === "en" ? "Reload audiences" : "Volver a cargar destinatarios";
  fireEvent.click(screen.getByRole("button", { name: reload }));
  // A pending control stays enabled (record 8435): wait for its busy state to clear.
  await waitFor(() => { const control = screen.getByRole("button", { name: post }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
  fireEvent.click(screen.getByRole("button", { name: post }));
  await waitFor(() => expect(screen.getByRole("button", { name: post })).toBeDisabled());
  expect(screen.getByLabelText(titleLabel)).toHaveValue("Keep this draft");
  expect(api.publish).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: reload }));
  // A pending control stays enabled (record 8435): wait for its busy state to clear.
  await waitFor(() => { const control = screen.getByRole("button", { name: post }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
});

it.each([null, "unit"])("keeps the existing chapter-office composer bound to its confirmed scope (%s)", async (scope) => {
  const office = { chapterId: unit.chapterId, documents: false, notices: true, unscopedNotices: !scope,
    scopes: scope ? [{ notices: true, unitId: unit.unitId, name: unit.name }] : [] };
  const access = { office: vi.fn().mockResolvedValue(office), publishNotice: vi.fn().mockResolvedValue({}) };
  render(<LanguageProvider lang="en"><ChapterOfficePanel client={{ access }} chapterId={unit.chapterId} role={scope ? "steward" : "vp"} /></LanguageProvider>);
  // A pending control stays enabled (record 8435): wait for its busy state to clear.
  await waitFor(() => { const control = screen.getByRole("button", { name: "Post notice" }); expect(control).toBeEnabled(); expect(control).not.toHaveAttribute("aria-disabled"); });
  expect(access.office).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Meeting" } });
  fireEvent.change(screen.getByLabelText("Notice"), { target: { value: "For this audience" } });
  fireEvent.click(screen.getByRole("button", { name: "Post notice" }));
  await waitFor(() => expect(access.publishNotice).toHaveBeenCalledWith(unit.chapterId, "Meeting", "For this audience", "en", scope ? unit.value : "", expect.any(String)));
});

it.each(["en", "es"])("gives an actionable Compass audience refusal without losing the written notice (%s)", async (lang) => {
  const publishBroadcast = vi.fn().mockRejectedValue(Object.assign(new Error("Unavailable"), { code: "notice_audience_unavailable" }));
  render(<LanguageProvider lang={lang}><CompassAnswerActions message={{ id: "answer", body: "Answer" }} actions={{ publishBroadcast }} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: t(lang, "compass.actions.draftAnnouncement") }));
  fireEvent.change(screen.getByLabelText(t(lang, "compass.actions.titleField")), { target: { value: "Meeting" } });
  fireEvent.change(screen.getByLabelText(t(lang, "compass.actions.messageField")), { target: { value: "Our unit" } });
  fireEvent.click(screen.getByRole("button", { name: t(lang, "compass.actions.broadcastConfirm") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(t(lang, "notices.audienceUnavailable"));
  expect(screen.getByLabelText(t(lang, "compass.actions.titleField"))).toHaveValue("Meeting");
});
