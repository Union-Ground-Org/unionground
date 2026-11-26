// BUG-UG-DEMO-PRESIDENT-INVITE-PAGE-BLANK-20261124 (#9775): on the
// demo, President > Invite a worker showed its heading and nothing else,
// because the app gave the card no api on SAMPLE and the card then rendered
// nothing. The demo now reads the chapter's invitations and shows the notice
// Admin shows; its own page says when the read fails instead of going blank.
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresidentInvitations } from "../src/components/PresidentInvitations.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";

const alder = { id: "tv-alder-falls", name: "Alder Falls Residential", grantsAccess: false };
const pendingRow = { id: "33333333-3333-4333-8333-333333333333", fullName: "Rosa Delgado", normalizedEmail: "rosa.delgado@example.test", chapterId: alder.id, chapterName: alder.name, status: "pending", expiresLabel: "Nov 25 · 9:00 PM" };

beforeEach(() => { window.history.replaceState({}, "", "/m/vp/invitations"); });
afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

function renderPage(api, { lang = "en", location = "/m/vp/invitations" } = {}) {
  window.history.replaceState({}, "", location);
  return render(<LanguageProvider lang={lang}>
    <WorkspacePages view="vp" hat="vp" location={location} navigate={vi.fn()} menu={false}>
      <PresidentInvitations api={api} />
    </WorkspacePages>
  </LanguageProvider>);
}

describe("the President's invitation page on the demo", () => {
  for (const lang of ["en", "es"]) {
    it(`shows the demo notice and the chapter's invitations, with no send, resend or revoke (${lang})`, async () => {
      const api = { load: vi.fn().mockResolvedValue({ chapter: alder, chapters: [alder], items: [pendingRow] }), sendingUnavailable: true };
      renderPage(api, { lang });
      const region = await screen.findByRole("region", { name: translate(lang, "admin.inviteTitle") });
      expect(within(region).getByText(translate(lang, "vp.invitationsDemo"))).toBeVisible();
      expect(within(region).getByText("Rosa Delgado")).toBeVisible();
      expect(within(region).queryByRole("button", { name: translate(lang, "admin.invitationSend") })).not.toBeInTheDocument();
      expect(within(region).queryByRole("button", { name: translate(lang, "admin.invitationResend") })).not.toBeInTheDocument();
      expect(within(region).queryByRole("button", { name: translate(lang, "admin.invitationRevoke") })).not.toBeInTheDocument();
      expect(within(region).queryByLabelText(translate(lang, "admin.inviteEmail"))).not.toBeInTheDocument();
    });
  }

  it("says at once that the demo does not send invitations, before the read answers and when it lists no chapter", async () => {
    let answer;
    const load = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    renderPage({ load, sendingUnavailable: true });
    const region = screen.getByRole("region", { name: "Invite a worker" });
    expect(within(region).getByText("This demo does not send invitations.")).toBeVisible();
    await act(async () => { answer({ chapter: null, chapters: [], items: [] }); });
    expect(within(screen.getByRole("region", { name: "Invite a worker" })).getByText("This demo does not send invitations.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send invitation" })).not.toBeInTheDocument();
  });

  it("keeps the demo sentence above a failed read and its Try again", async () => {
    renderPage({ load: vi.fn().mockRejectedValue(new Error("network")), sendingUnavailable: true }, { lang: "es" });
    const region = await screen.findByRole("region", { name: "Invitar a un trabajador" });
    expect(within(region).getByText("En esta demostración no se pueden enviar invitaciones.")).toBeVisible();
    expect(await within(region).findByRole("alert")).toHaveTextContent(translate("es", "admin.invitationsUnavailable"));
    expect(within(region).getByRole("button", { name: translate("es", "app.tryAgain") })).toBeInTheDocument();
  });

  it("is given a read-only invitation api on SAMPLE, not none", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const start = app.indexOf("const presidentInvitationApi = useMemo(");
    const wiring = app.slice(start, app.indexOf("}), [fixtureDemo, sampleLive, lang]);", start));
    expect(wiring).not.toMatch(/fixtureDemo \|\| sampleLive \? null|fixtureDemo \? null/);
    expect(wiring).toMatch(/sampleLive \? \{\s*load: \(\) => loadMemberInvitations\(supabase, lang\),\s*sendingUnavailable: true,\s*\}/);
  });
});

describe("the President's invitation page when the read fails", () => {
  it("says the invitations could not be loaded and tries again, instead of a blank page", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ chapter: alder, chapters: [alder], items: [] });
    renderPage({ load, inviteMember: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn() });
    const region = await screen.findByRole("region", { name: "Invite a worker" });
    expect(within(region).getByRole("alert")).toHaveTextContent("Invitations could not be loaded.");
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await within(screen.getByRole("region", { name: "Invite a worker" })).findByRole("button", { name: "Send invitation" })).toBeVisible();
  });

  it("holds Try again while its read runs, so two presses start one read", async () => {
    const pending = [];
    const load = vi.fn(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    renderPage({ load, inviteMember: vi.fn(), resendInvitation: vi.fn(), revokeInvitation: vi.fn() });
    await act(async () => { pending[0].reject(new Error("network")); });
    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(load).toHaveBeenCalledTimes(2);
    expect(retry).toHaveAttribute("aria-busy", "true");
    await act(async () => { pending[1].resolve({ chapter: alder, chapters: [alder], items: [pendingRow] }); });
    expect(await screen.findByRole("button", { name: "Send invitation" })).toBeVisible();
    expect(screen.getByText("Rosa Delgado")).toBeVisible();
  });

  it("lets only the newest read set the page: an older read answering late, as a list or a failure, is ignored", async () => {
    const reads = [];
    const makeApi = () => ({ load: vi.fn(() => new Promise((resolve, reject) => { reads.push({ resolve, reject }); })), sendingUnavailable: true });
    const view = renderPage(makeApi());
    const wrapPage = (api) => <LanguageProvider lang="en">
      <WorkspacePages view="vp" hat="vp" location="/m/vp/invitations" navigate={vi.fn()} menu={false}><PresidentInvitations api={api} /></WorkspacePages>
    </LanguageProvider>;
    view.rerender(wrapPage(makeApi()));
    view.rerender(wrapPage(makeApi()));
    expect(reads).toHaveLength(3);
    await act(async () => { reads[2].resolve({ chapter: alder, chapters: [alder], items: [pendingRow] }); });
    expect(await screen.findByText("Rosa Delgado")).toBeVisible();
    await act(async () => { reads[0].reject(new Error("late failure")); reads[1].resolve({ chapter: alder, chapters: [alder], items: [] }); });
    expect(screen.getByText("Rosa Delgado")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing without an api, on its own page too", () => {
    const view = renderPage(null);
    expect(view.container.querySelector("#vp-invitations")).toBeNull();
  });

  it("still hides the card on the President overview when the read is refused", async () => {
    const load = vi.fn().mockRejectedValue(new Error("admin role required"));
    renderPage({ load }, { location: "/m/vp" });
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Invite a worker" })).not.toBeInTheDocument();
  });
});
