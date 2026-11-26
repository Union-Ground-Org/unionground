// BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003: the President
// plane's invitation card invites plain members into the chapters the database
// lists for this President, never offers starting access, and hides itself when
// the reader refuses.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresidentInvitations, presidentInvitationChapterId } from "../src/components/PresidentInvitations.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

afterEach(cleanup);

const hhs = { id: "hb-hhs", name: "HHS Chapter", grantsAccess: false };
const transit = { id: "hb-transit", name: "Transit Chapter", grantsAccess: false };

function renderCard(invitations, overrides = {}) {
  const api = {
    load: vi.fn().mockResolvedValue(invitations),
    inviteMember: vi.fn().mockResolvedValue({ accepted: true }),
    resendInvitation: vi.fn().mockResolvedValue({ accepted: true }),
    revokeInvitation: vi.fn().mockResolvedValue({ accepted: true }),
    ...overrides,
  };
  const view = render(<LanguageProvider lang="en"><PresidentInvitations api={api} /></LanguageProvider>);
  return { api, view };
}

describe("President invitation card", () => {
  it("shows nothing when the database does not list a chapter for this President", async () => {
    const refused = renderCard(null, { load: vi.fn().mockRejectedValue(new Error("admin role required")) });
    // Only the card's empty, visually hidden status line stays in the page
    // (BUG-UG-PRESIDENT-INVITATIONS-LIST-HOLDS-OTHER-CHAPTERS-20261125).
    const onlyEmptyStatus = (container) => {
      expect(container.children).toHaveLength(1);
      expect(container.firstChild).toHaveAttribute("role", "status");
      expect(container.firstChild).toHaveTextContent(/^$/);
    };
    await waitFor(() => expect(refused.api.load).toHaveBeenCalled());
    onlyEmptyStatus(refused.view.container);
    cleanup();
    const empty = renderCard({ chapter: hhs, chapters: [], items: [] });
    await waitFor(() => expect(empty.api.load).toHaveBeenCalled());
    onlyEmptyStatus(empty.view.container);
  });

  it("invites a plain member into the President's only chapter, with no starting access offered", async () => {
    const { api } = renderCard({ chapter: hhs, chapters: [hhs], items: [] });
    const card = await screen.findByRole("region", { name: "Invite a worker" });
    expect(within(card).queryByLabelText("Starting access")).not.toBeInTheDocument();
    expect(within(card).getByLabelText("Campaign")).toBeDisabled();
    expect(within(card).getByLabelText("Campaign")).toHaveValue("HHS Chapter");
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Nadia Okafor" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "nadia@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith({
      fullName: "Nadia Okafor", email: "nadia@example.org", chapterId: "hb-hhs", initialRole: null, locale: "en", formerMember: false,
    }));
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));
  });

  it("lets a President of two chapters choose, and resend an invitation", async () => {
    const invitation = { id: "11111111-1111-4111-8111-111111111111", fullName: "Tomás Reyes", normalizedEmail: "tomas@example.org", chapterId: transit.id, chapterName: transit.name, status: "pending", expiresLabel: "Oct 4 · 9:00 PM" };
    const { api } = renderCard({ chapter: hhs, chapters: [hhs, transit], items: [invitation] });
    const card = await screen.findByRole("region", { name: "Invite a worker" });
    const picker = within(card).getByLabelText("Campaign");
    expect(picker.tagName).toBe("SELECT");
    fireEvent.change(picker, { target: { value: transit.id } });
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Ana Ruiz" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "ana@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith(expect.objectContaining({ chapterId: transit.id, initialRole: null })));
    expect(within(card).getByText(/9:00 PM · Transit Chapter/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(api.resendInvitation).toHaveBeenCalledWith(invitation.id));
  });

  it("revokes only after confirmation, can cancel, sends the chosen language, and reports a failed action", async () => {
    const invitation = { id: "22222222-2222-4222-8222-222222222222", fullName: "Lena Park", normalizedEmail: "lena@example.org", chapterId: hhs.id, chapterName: hhs.name, status: "pending", expiresLabel: "Oct 5 · 9:00 PM" };
    const { api } = renderCard({ chapter: hhs, chapters: [hhs], items: [invitation] }, {
      resendInvitation: vi.fn().mockRejectedValue(new Error("invitation not permitted")),
    });
    const card = await screen.findByRole("region", { name: "Invite a worker" });

    fireEvent.click(within(card).getByRole("button", { name: "Revoke invitation" }));
    const confirm = within(card).getByRole("group", { name: /Lena Park/ });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("group", { name: /Lena Park/ })).not.toBeInTheDocument();
    expect(api.revokeInvitation).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: "Revoke invitation" }));
    fireEvent.click(within(within(card).getByRole("group", { name: /Lena Park/ })).getByRole("button", { name: "Yes, revoke" }));
    await waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith(invitation.id));
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));

    fireEvent.click(within(card).getByRole("button", { name: "Resend" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("The invitation could not be processed.");

    fireEvent.change(within(card).getByLabelText("Invitation language"), { target: { value: "es" } });
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Lena Park" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "lena@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith(expect.objectContaining({ locale: "es", initialRole: null })));
  });

  // BUG-UG-ACCEPTED-INVITATIONS-SHOW-EXPIRY-20261102: the expiry shows
  // only while pending; accepted and revoked rows show when that happened, and
  // only when the list returned the time.
  it("shows the expiry only while pending and the accepted or revoked time otherwise, with its zone", async () => {
    const row = (id, status, fields = {}) => ({
      id, fullName: `Invitee ${id}`, normalizedEmail: `${id}@example.org`, chapterId: hhs.id, chapterName: hhs.name, status,
      expiresAt: "2099-01-01T00:00:00Z", expiresLabel: "Thu, Jan 1 · 12:00 AM UTC", acceptedLabel: "", revokedLabel: "", ...fields,
    });
    const rows = [
      row("pending", "pending"),
      row("accepted", "accepted", { expiresAt: "2026-11-02T16:23:00Z", expiresLabel: "Mon, Nov 2 · 4:23 PM UTC", acceptedLabel: "Mon, Nov 2 · 4:14 PM UTC" }),
      row("revoked", "revoked", { expiresAt: "2026-11-02T16:23:00Z", expiresLabel: "Mon, Nov 2 · 4:23 PM UTC", revokedLabel: "Mon, Nov 2 · 4:20 PM UTC" }),
      row("untimed", "revoked", { expiresAt: "2026-11-02T16:23:00Z", expiresLabel: "Mon, Nov 2 · 4:23 PM UTC" }),
      row("expired", "expired", { expiresAt: "2026-10-01T00:00:00Z", expiresLabel: "Wed, Oct 1 · 12:00 AM UTC" }),
      row("lapsed", "pending", { expiresAt: "2026-10-01T00:00:00Z", expiresLabel: "Wed, Oct 1 · 12:00 AM UTC" }),
    ];
    renderCard({ chapter: hhs, chapters: [hhs, transit], items: rows });
    const card = await screen.findByRole("region", { name: "Invite a worker" });
    const line = (id) => within(card).getByText(`${id}@example.org`).closest(".xus-rowmain").querySelectorAll(".xus-meta")[1].textContent;
    expect(line("pending")).toBe("Pending · Expires Thu, Jan 1 · 12:00 AM UTC · HHS Chapter");
    expect(line("accepted")).toBe("Accepted Mon, Nov 2 · 4:14 PM UTC · HHS Chapter");
    expect(line("revoked")).toBe("Revoked Mon, Nov 2 · 4:20 PM UTC · HHS Chapter");
    expect(line("untimed")).toBe("Revoked · HHS Chapter");
    expect(line("expired")).toBe("Expired · HHS Chapter");
    expect(line("lapsed")).toBe("Expired · HHS Chapter");
    // Expired links stay resendable; accepted and revoked rows offer nothing.
    expect(within(card).getAllByRole("button", { name: "Resend" })).toHaveLength(3);
  });

  // REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171): a member-sent
  // invitation names the member who sent it; others say nothing about a sender.
  it("names the member who sent a member-sent invitation", async () => {
    const row = (id, fields = {}) => ({ id, fullName: `Invitee ${id}`, normalizedEmail: `${id}@example.org`, chapterId: hhs.id, chapterName: hhs.name, status: "pending",
      expiresAt: "2099-01-01T00:00:00Z", expiresLabel: "Thu, Jan 1 · 12:00 AM ET", ...fields });
    renderCard({ chapter: hhs, chapters: [hhs], items: [row("sent", { source: "member", sentByMemberName: "Sam Okafor" }), row("unnamed", { source: "member" }), row("admin", { source: "adhoc" })] });
    const card = await screen.findByRole("region", { name: "Invite a worker" });
    const metas = (id) => [...within(card).getByText(`${id}@example.org`).closest(".xus-rowmain").querySelectorAll(".xus-meta")].map((node) => node.textContent);
    expect(metas("sent")).toContain("Sent by worker Sam Okafor");
    expect(metas("unnamed")).toContain("Sent by a worker");
    expect(metas("admin").join(" ")).not.toMatch(/Sent by/u);
  });

  it("only ever targets a chapter the database listed", () => {
    expect(presidentInvitationChapterId({ chapters: [hhs, transit] }, transit.id)).toBe(transit.id);
    expect(presidentInvitationChapterId({ chapters: [hhs, transit] }, "other-org-chapter")).toBe(hhs.id);
    expect(presidentInvitationChapterId({ chapters: [] }, hhs.id)).toBeNull();
  });
});

describe("President invitations keep focus while they are sent (record 8435)", () => {
  it("keeps Send invitation focused while the invitation is sent, and sends it once", async () => {
    const { api } = renderCard({ chapter: hhs, chapters: [hhs], items: [] });
    const card = await screen.findByRole("region", { name: "Invite a worker" });
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Nadia Okafor" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "nadia@example.org" } });
    await expectHeldWriteFocus(api.inviteMember, within(card).getByRole("button", { name: "Send invitation" }));
    expect(api.inviteMember).toHaveBeenCalledTimes(1);
  });
});

// Record 8435: Resend and the confirmed revoke keep focus
// while their write runs and run once.
describe("President invitation actions keep focus while they run", () => {
  const invitation = { id: "33333333-3333-4333-8333-333333333333", fullName: "Tomás Reyes", normalizedEmail: "tomas@example.org", chapterId: hhs.id, chapterName: hhs.name, status: "pending", expiresLabel: "Oct 4 · 9:00 PM" };
  it("keeps Resend focused while the invitation is resent, and resends it once", async () => {
    const { api } = renderCard({ chapter: hhs, chapters: [hhs], items: [invitation] });
    const card = await screen.findByRole("region", { name: "Invite a worker" });
    await expectHeldWriteFocus(api.resendInvitation, within(card).getByRole("button", { name: "Resend" }));
    expect(api.resendInvitation).toHaveBeenCalledTimes(1);
  });
  // Confirming closes its own group, so focus leaves with it by design; while the
  // revoke runs, the card's pending Revoke refuses to open another confirm.
  it("revokes once and refuses another revoke while it runs", async () => {
    let release;
    const { api } = renderCard({ chapter: hhs, chapters: [hhs], items: [invitation] }, {
      revokeInvitation: vi.fn(() => new Promise((resolve) => { release = resolve; })),
    });
    const card = await screen.findByRole("region", { name: "Invite a worker" });
    fireEvent.click(within(card).getByRole("button", { name: "Revoke invitation" }));
    fireEvent.click(within(within(card).getByRole("group", { name: /Tomás Reyes/ })).getByRole("button", { name: "Yes, revoke" }));
    const revoke = within(card).getByRole("button", { name: "Revoke invitation" });
    expect(revoke).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(revoke);
    expect(within(card).queryByRole("group", { name: /Tomás Reyes/ })).not.toBeInTheDocument();
    expect(api.revokeInvitation).toHaveBeenCalledTimes(1);
    await act(async () => { release({ accepted: true }); });
  });
});
