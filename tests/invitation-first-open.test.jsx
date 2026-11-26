import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_INVITATION_KEY,
  ACCEPTED_INVITATION_LIFETIME_MS,
  InvitationAcceptView,
  PENDING_INVITATION_KEY,
  PENDING_INVITATION_LIFETIME_MS,
} from "../src/views/InvitationAcceptView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import * as legalReleaseBundle from "../src/lib/legalReleaseBundle.js";
import { publishedVersionsWithProof } from "./helpers/legal-publication.js";

// The bundled legal release is published only with the deployment's proof
// (tests/helpers/legal-publication.js); this file renders acceptance against it.
let legalProofSpy;
beforeEach(() => {
  legalProofSpy = vi.spyOn(legalReleaseBundle, "loadPublishedWebVersions").mockImplementation(publishedVersionsWithProof);
});
afterEach(() => legalProofSpy?.mockRestore());


// BUG-UG-INVITATION-FIRST-OPEN-SHOWS-UNAVAILABLE-20261030. In
// Production, 6 of 16 first opens of a fresh /app/invite#invite=... link showed
// "This invitation is no longer available" while the invitation was pending
// with zero accept attempts, and the address bar read a bare /invite. The page
// scrubs the fragment on its first load; a second load of the same tab (a
// reload, an automation tool opening the current address again, a restored
// tab) found no token and declared the invitation gone without asking the
// server. Each `openTab` below is one document load of the same browser tab:
// the address bar and session storage carry over, component memory does not.

// Obviously fake, low-entropy fixtures in the 43-character token shape.
const TOKEN = "invite-token-test-0001-aaaaaaaaaaaaaaaaaaaa";
const OTHER = "invite-token-test-0002-bbbbbbbbbbbbbbbbbbbb";
const en = catalogue.en;

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) };
}

function openTab({ url, fetcher = vi.fn() } = {}) {
  cleanup();
  if (url) window.history.replaceState(null, "", url);
  render(<LanguageProvider lang="en"><InvitationAcceptView fetcher={fetcher} /></LanguageProvider>);
  return fetcher;
}

function agree() {
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "TX" } });
  screen.getAllByRole("checkbox").forEach((box) => fireEvent.click(box));
  fireEvent.click(screen.getByRole("button", { name: en["inviteAccept.terms.action"] }));
}

const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

describe("an invitation link on its first open", () => {
  it("resumes the clickwrap when the tab loads its scrubbed address again, and sends the original token", async () => {
    openTab({ url: `/app/invite#invite=${TOKEN}` });
    expect(await screen.findByRole("heading", { name: en["inviteAccept.terms.title"] })).toBeInTheDocument();
    expect(address()).toBe("/invite");

    // The cold-load failure: the same tab opens what is now in its address bar.
    const fetcher = openTab({ fetcher: vi.fn().mockResolvedValue(response({ accepted: true })) });
    expect(await screen.findByRole("heading", { name: en["inviteAccept.terms.title"] })).toBeInTheDocument();
    expect(screen.queryByText(en["inviteAccept.unavailable"])).toBeNull();
    expect(address()).toBe("/invite");
    expect(document.body.textContent).not.toContain(TOKEN);

    agree();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(en["inviteAccept.continuing"]));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      token: TOKEN, acceptedVersions: currentLegalVersions(), residenceState: "TX", ageAttested: true,
    });
    // Accepted: nothing is kept for a later load of this tab.
    expect(window.sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull();
  });

  it("keeps the invitation through a transient failure and a reload", async () => {
    openTab({ url: `/app/invite#invite=${TOKEN}`, fetcher: vi.fn().mockResolvedValue(response({ error: "acceptance-unavailable" }, 503)) });
    agree();
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.serverTitle"]);

    openTab();
    expect(await screen.findByRole("heading", { name: en["inviteAccept.terms.title"] })).toBeInTheDocument();
  });

  it("says no longer available only after the server's final answer, and then forgets the token", async () => {
    const fetcher = openTab({ url: `/app/invite#invite=${TOKEN}`, fetcher: vi.fn().mockResolvedValue(response({ error: "invitation-unavailable" }, 410)) });
    agree();
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.unavailable"]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull();

    // A later load of the tab has nothing to resume and asks nothing.
    const later = openTab();
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.incompleteTitle"]);
    expect(later).not.toHaveBeenCalled();
  });

  it.each([
    ["no fragment", "/app/invite"],
    ["an altered token", "/app/invite#invite=too-short"],
    ["a query string", `/app/invite?invite=${TOKEN}`],
  ])("calls a link with %s incomplete, never unavailable, without asking the server", async (_label, url) => {
    const fetcher = openTab({ url });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en["inviteAccept.incompleteTitle"]);
    expect(alert).toHaveTextContent(en["inviteAccept.incompleteBody"]);
    expect(alert).not.toHaveTextContent(en["inviteAccept.unavailable"]);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(fetcher).not.toHaveBeenCalled();
    expect(address()).toBe("/invite");
  });

  it("keeps the token for this tab only, bounded, and drops an expired or malformed entry", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    openTab({ url: `/app/invite#invite=${TOKEN}` });
    await screen.findByRole("heading", { name: en["inviteAccept.terms.title"] });
    expect(window.localStorage.getItem(PENDING_INVITATION_KEY)).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem(PENDING_INVITATION_KEY)))
      .toEqual({ token: TOKEN, expiresAt: now + PENDING_INVITATION_LIFETIME_MS });

    // #6994 (WEB-PUB-22): a tab whose 15 minutes passed says it timed out,
    // which is its own state, not "didn't open completely".
    Date.now.mockReturnValue(now + PENDING_INVITATION_LIFETIME_MS);
    openTab();
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.timedOutTitle"]);
    // r2s2: local expiry says nothing about what the server did with an
    // acceptance whose answer may have been lost.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/nothing was accepted/i);
    expect(window.sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull();
    // Said once: the next load of the tab has nothing left to time out.
    openTab();
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.incompleteTitle"]);

    Date.now.mockReturnValue(now);
    for (const stored of ["not json", JSON.stringify({ token: "short", expiresAt: now + 1000 }),
      JSON.stringify({ token: TOKEN, expiresAt: now + PENDING_INVITATION_LIFETIME_MS + 1 })]) {
      window.sessionStorage.setItem(PENDING_INVITATION_KEY, stored);
      openTab();
      expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.incompleteTitle"]);
      expect(window.sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull();
    }
  });

  it("lets a newly opened link replace the one the tab held, and a refused link clear it", async () => {
    openTab({ url: `/app/invite#invite=${TOKEN}` });
    await screen.findByRole("heading", { name: en["inviteAccept.terms.title"] });
    const fetcher = openTab({ url: `/app/invite#invite=${OTHER}`, fetcher: vi.fn().mockResolvedValue(response({ accepted: true })) });
    agree();
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(JSON.parse(fetcher.mock.calls[0][1].body).token).toBe(OTHER);

    openTab({ url: `/app/invite#invite=${TOKEN}` });
    await screen.findByRole("heading", { name: en["inviteAccept.terms.title"] });
    openTab({ url: `/invite?invite=${TOKEN}` });
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.incompleteTitle"]);
    expect(window.sessionStorage.getItem(PENDING_INVITATION_KEY)).toBeNull();
  });

  // REQ-UG-LOVABLE-PUBLIC-SITE-BATCH-B-PORT-20261103 (WEB-PUB-22): a
  // missing, a used and a timed-out link each have their own state and next
  // step. "Used" is said only when this tab accepted the invitation.
  it("tells a tab that accepted its invitation that it was used, and sends it to sign in", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    openTab({ url: `/app/invite#invite=${TOKEN}`, fetcher: vi.fn().mockResolvedValue(response({ accepted: true })) });
    agree();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(en["inviteAccept.continuing"]));
    expect(window.sessionStorage.getItem(ACCEPTED_INVITATION_KEY)).toBe(String(now));
    expect(window.sessionStorage.getItem(ACCEPTED_INVITATION_KEY)).not.toContain(TOKEN);

    const later = openTab();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(en["inviteAccept.usedTitle"]);
    expect(status).toHaveTextContent(en["inviteAccept.usedBody"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: en["inviteAccept.signIn"] })).toHaveAttribute("href", "/m");
    expect(later).not.toHaveBeenCalled();

    // A day later the tab no longer claims it; a new link clears it at once.
    Date.now.mockReturnValue(now + ACCEPTED_INVITATION_LIFETIME_MS);
    openTab();
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inviteAccept.incompleteTitle"]);
    window.sessionStorage.setItem(ACCEPTED_INVITATION_KEY, String(now + ACCEPTED_INVITATION_LIFETIME_MS));
    openTab({ url: `/app/invite#invite=${OTHER}` });
    await screen.findByRole("heading", { name: en["inviteAccept.terms.title"] });
    expect(window.sessionStorage.getItem(ACCEPTED_INVITATION_KEY)).toBeNull();
  });

  it.each([
    ["missing", "/app/invite", null, "inviteAccept.incompleteTitle"],
    ["refused by the server", `/app/invite#invite=${TOKEN}`, 410, "inviteAccept.unavailable"],
  ])("names the next steps for a %s invitation", async (_label, url, status, title) => {
    openTab({ url, fetcher: vi.fn().mockResolvedValue(response({ error: "invitation-unavailable" }, status ?? 410)) });
    if (status) agree();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en[title]);
    expect(alert).toHaveTextContent(`${en["inviteAccept.alreadyAccepted"]} ${en["inviteAccept.signIn"]}`);
    expect(alert).toHaveTextContent(`${en["inviteAccept.noInvitation"]} ${en["requestInvite.link"]}`);
    expect(screen.getByRole("link", { name: en["inviteAccept.signIn"] })).toHaveAttribute("href", "/m");
    expect(screen.getByRole("link", { name: en["requestInvite.link"] })).toHaveAttribute("href", "/request-invite");
  });

  it("still opens the invitation in memory when the browser refuses session storage", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    const fetcher = openTab({ url: `/app/invite#invite=${TOKEN}`, fetcher: vi.fn().mockResolvedValue(response({ accepted: true })) });
    agree();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(en["inviteAccept.continuing"]));
    expect(JSON.parse(fetcher.mock.calls[0][1].body).token).toBe(TOKEN);
  });
});
