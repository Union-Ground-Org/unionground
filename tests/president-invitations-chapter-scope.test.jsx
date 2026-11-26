// BUG-UG-PRESIDENT-INVITATIONS-LIST-HOLDS-OTHER-CHAPTERS-20261125:
// get_member_invitations returns every chapter a President presides over (an
// organization-wide President presides over all of them), and the card listed
// all of their invitations under "Invite people into your campaign". The list
// now shows the open chapter (or the chapter picked in the form), and on the
// demo, where nothing can be resent or revoked, it keeps the read's
// newest-first order instead of ranking expired and failed rows first.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresidentInvitations } from "../src/components/PresidentInvitations.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";

const transport = { id: "tv-transport", name: "Transportation & Facilities", grantsAccess: false };
const alder = { id: "tv-alder-falls", name: "Alder Falls Residential", grantsAccess: false };
const brightwater = { id: "tv-brightwater", name: "Brightwater Health", grantsAccess: false };
const row = (id, chapter, status) => ({
  id, fullName: `Invitee ${id}`, normalizedEmail: `${id}@example.test`, chapterId: chapter.id, chapterName: chapter.name,
  status, expiresLabel: "Nov 30 · 9:00 PM", acceptedLabel: status === "accepted" ? "Nov 24 · 10:00 AM" : "",
});
// Newest first, as the read returns them.
const items = [
  row("t-new", transport, "expired"),
  row("a-accepted", alder, "accepted"),
  row("b-failed", brightwater, "delivery_failed"),
  row("a-pending", alder, "pending"),
  row("a-expired", alder, "expired"),
  row("t-old", transport, "delivery_failed"),
];

beforeEach(() => { window.history.replaceState({}, "", "/m/vp/invitations"); });
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

function renderPage(api, lang) {
  return render(<LanguageProvider lang={lang}>
    <WorkspacePages view="vp" hat="vp" location="/m/vp/invitations" navigate={vi.fn()} menu={false}>
      <PresidentInvitations api={api} />
    </WorkspacePages>
  </LanguageProvider>);
}

const shown = (region) => [...region.querySelectorAll(".xus-row .xus-name")].map((node) => node.textContent);

describe("the Campaign chair's invitation list holds only one campaign", () => {
  for (const lang of ["en", "es"]) {
    it(`lists only the open campaign's invitations, newest first, on the demo (${lang})`, async () => {
      const api = { load: vi.fn().mockResolvedValue({ chapter: alder, chapters: [transport, alder, brightwater], items }), sendingUnavailable: true };
      renderPage(api, lang);
      const region = await screen.findByRole("region", { name: translate(lang, "admin.inviteTitle") });
      await within(region).findByText("Invitee a-accepted");
      expect(shown(region)).toEqual(["Invitee a-accepted", "Invitee a-pending", "Invitee a-expired"]);
      expect(within(region).queryByText(/Transportation & Facilities/)).not.toBeInTheDocument();
      expect(within(region).queryByText(/Brightwater Health/)).not.toBeInTheDocument();
    });

    it(`lists the campaign picked for the next invitation, with its actions first, when sending works (${lang})`, async () => {
      const api = {
        load: vi.fn().mockResolvedValue({ chapter: alder, chapters: [transport, alder, brightwater], items }),
        inviteMember: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn(),
      };
      renderPage(api, lang);
      const region = await screen.findByRole("region", { name: translate(lang, "admin.inviteTitle") });
      const picker = await within(region).findByLabelText(translate(lang, "admin.inviteChapter"));
      expect(picker).toHaveValue(alder.id);
      expect(shown(region)).toEqual(["Invitee a-pending", "Invitee a-expired", "Invitee a-accepted"]);
      fireEvent.change(picker, { target: { value: transport.id } });
      expect(shown(region)).toEqual(["Invitee t-new", "Invitee t-old"]);
      expect(within(region).queryByText("Invitee a-accepted")).not.toBeInTheDocument();
    });

  }

  // The status line is derived from the list each render shows (ruling of
  // 8:44 AM ET Nov 25, 2026): nothing is remembered from a pick.
  for (const lang of ["en", "es"]) {
    const chapterStatus = () => document.getElementById("vp-invitations-status");
    const said = (count, chapter, language = lang) => translate(language, count === 1 ? "vp.invitationsChapterShown.one" : "vp.invitationsChapterShown", { count, chapter });
    const sending = (load) => ({ load, inviteMember: vi.fn(), resendInvitation: vi.fn().mockResolvedValue({ accepted: true }), revokeInvitation: vi.fn() });
    const cedar = { id: "tv-cedar", name: "Cedar Ridge", grantsAccess: false };
    const listed = { chapter: alder, chapters: [transport, alder, brightwater, cedar], items };

    it(`says the shown campaign and its count once the read settles, and follows each pick, one and none included (${lang})`, async () => {
      renderPage(sending(vi.fn().mockResolvedValue(listed)), lang);
      const region = await screen.findByRole("region", { name: translate(lang, "admin.inviteTitle") });
      await within(region).findByText("Invitee a-accepted");
      expect(chapterStatus(region)).toHaveTextContent(said(3, alder.name));
      const picker = within(region).getByLabelText(translate(lang, "admin.inviteChapter"));
      fireEvent.change(picker, { target: { value: transport.id } });
      expect(chapterStatus(region)).toHaveTextContent(said(2, transport.name));
      fireEvent.change(picker, { target: { value: brightwater.id } });
      expect(chapterStatus(region)).toHaveTextContent(said(1, brightwater.name));
      fireEvent.change(picker, { target: { value: cedar.id } });
      expect(chapterStatus(region)).toHaveTextContent(said(0, cedar.name));
      expect(within(region).getByText(translate(lang, "admin.invitationsEmpty"))).toBeVisible();
    });

    it(`is empty while a read is in flight and follows a reload that changes the count (${lang})`, async () => {
      let answer;
      const load = vi.fn().mockResolvedValueOnce(listed).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
      renderPage(sending(load), lang);
      const region = await screen.findByRole("region", { name: translate(lang, "admin.inviteTitle") });
      fireEvent.change(await within(region).findByLabelText(translate(lang, "admin.inviteChapter")), { target: { value: transport.id } });
      expect(chapterStatus(region)).toHaveTextContent(said(2, transport.name));
      fireEvent.click(within(within(region).getByText("Invitee t-new").closest(".xus-row")).getByRole("button", { name: translate(lang, "admin.invitationResend") }));
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      expect(chapterStatus(region)).toHaveTextContent(/^$/);
      await act(async () => { answer({ ...listed, items: [row("t-newest", transport, "pending"), ...items] }); });
      await within(region).findByText("Invitee t-newest");
      expect(chapterStatus(region)).toHaveTextContent(said(3, transport.name));
    });
  }

  it("speaks the current language after a round trip from English to Spanish and back", async () => {
    const api = { load: vi.fn().mockResolvedValue({ chapter: alder, chapters: [transport, alder], items }), sendingUnavailable: true };
    const tree = (language) => <LanguageProvider lang={language}>
      <WorkspacePages view="vp" hat="vp" location="/m/vp/invitations" navigate={vi.fn()} menu={false}>
        <PresidentInvitations api={api} />
      </WorkspacePages>
    </LanguageProvider>;
    const view = render(tree("en"));
    const status = () => document.getElementById("vp-invitations-status");
    await screen.findByText("Invitee a-accepted");
    expect(status()).toHaveTextContent(translate("en", "vp.invitationsChapterShown", { count: 3, chapter: alder.name }));
    view.rerender(tree("es"));
    expect(status()).toHaveTextContent(translate("es", "vp.invitationsChapterShown", { count: 3, chapter: alder.name }));
    view.rerender(tree("en"));
    expect(status()).toHaveTextContent(translate("en", "vp.invitationsChapterShown", { count: 3, chapter: alder.name }));
  });

  it("says nothing when the read lists one campaign", async () => {
    renderPage({ load: vi.fn().mockResolvedValue({ chapter: alder, chapters: [alder], items: items.filter((item) => item.chapterId === alder.id) }), sendingUnavailable: true }, "en");
    const region = await screen.findByRole("region", { name: "Invite a worker" });
    await within(region).findByText("Invitee a-accepted");
    expect(document.getElementById("vp-invitations-status")).toHaveTextContent(/^$/);
  });

  it("remounts the pager when the campaign shown changes, and Next and Previous still change it", async () => {
    const many = (chapter, count, prefix) => Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`, chapter, "accepted"));
    const api = { load: vi.fn().mockResolvedValue({ chapter: alder, chapters: [transport, alder], items: [...many(alder, 8, "a"), ...many(transport, 13, "t")] }),
      inviteMember: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn() };
    renderPage(api, "en");
    const region = await screen.findByRole("region", { name: "Invite a worker" });
    const pagerStatus = () => region.querySelector("nav span[role=status]");
    await within(region).findByText("Invitee a-0");
    fireEvent.click(within(region).getByRole("button", { name: "Next" }));
    const before = pagerStatus();
    expect(before).toHaveTextContent("Page 2 of 2");
    fireEvent.change(within(region).getByLabelText("Campaign"), { target: { value: transport.id } });
    const after = pagerStatus();
    expect(after).toHaveTextContent("Page 1 of 3");
    expect(after).not.toBe(before);
    expect(before.isConnected).toBe(false);
    fireEvent.click(within(region).getByRole("button", { name: "Next" }));
    expect(pagerStatus()).toBe(after);
    expect(after).toHaveTextContent("Page 2 of 3");
    fireEvent.click(within(region).getByRole("button", { name: "Previous" }));
    expect(pagerStatus()).toBe(after);
    expect(after).toHaveTextContent("Page 1 of 3");
  });

  it("keeps the empty status line in the page through the first read, so the settled count changes an element already there", async () => {
    let answer;
    renderPage({ load: vi.fn(() => new Promise((resolve) => { answer = resolve; })), inviteMember: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn() }, "en");
    const line = document.getElementById("vp-invitations-status");
    expect(line).toHaveAttribute("role", "status");
    expect(line).toHaveTextContent(/^$/);
    await act(async () => { answer({ chapter: alder, chapters: [transport, alder], items }); });
    await screen.findByText("Invitee a-accepted");
    expect(document.getElementById("vp-invitations-status")).toBe(line);
    expect(line).toHaveTextContent(translate("en", "vp.invitationsChapterShown", { count: 3, chapter: alder.name }));
  });

  it("keeps the empty status line in the page when the read fails", async () => {
    renderPage({ load: vi.fn().mockRejectedValue(new Error("admin role required")), inviteMember: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn() }, "en");
    await screen.findByRole("alert");
    expect(document.getElementById("vp-invitations-status")).toHaveTextContent(/^$/);
  });

  for (const [label, chapter] of [["no open campaign", null], ["an open campaign that is not listed", { id: "tv-elsewhere", name: "Elsewhere" }]]) {
    it(`uses the first listed campaign for the form and the list when the read names ${label}`, async () => {
      const api = {
        load: vi.fn().mockResolvedValue({ chapter, chapters: [transport, alder, brightwater], items }),
        inviteMember: vi.fn().mockResolvedValue({ accepted: true }), resendInvitation: vi.fn(), revokeInvitation: vi.fn(),
      };
      renderPage(api, "en");
      const region = await screen.findByRole("region", { name: "Invite a worker" });
      expect(await within(region).findByLabelText("Campaign")).toHaveValue(transport.id);
      expect(shown(region)).toEqual(["Invitee t-new", "Invitee t-old"]);
      fireEvent.change(within(region).getByLabelText("Full name"), { target: { value: "Ana Ruiz" } });
      fireEvent.change(within(region).getByLabelText("Email address"), { target: { value: "ana@example.org" } });
      fireEvent.click(within(region).getByRole("button", { name: "Send invitation" }));
      await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith(expect.objectContaining({ chapterId: transport.id })));
    });
  }
});
