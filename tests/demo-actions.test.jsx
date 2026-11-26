import { confirmEvidenceUpload } from "./helpers/confirm-evidence-upload.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
// Action assertions use the real views without timing their cold compilation.
// Lazy-view deadline behavior has its own regressions; keep it out of this test.
import "../src/views/VotingView.jsx";
import "../src/views/TasksView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { choosePage, findPageMenuTrigger } from "./helpers/workspacePageMenu.js";
import { PHONE_HOME_GREETING } from "./helpers/homeGreeting.js";

async function openPage(path) {
  // Hat changes load the next workspace asynchronously; use the same bounded
  // budget as the review inbox below rather than the default one-second query.
  choosePage(await findPageMenuTrigger({ timeout: 8_000 }), path);
}

// Demo actions must be honest end to end: what a toast claims must be visible
// somewhere a prospect can check, and nothing may claim — or look like — live
// persistence or verification. Companion suites: demo-messages, demo-compass.
beforeEach(() => {
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

describe("demo ballot receipt honesty", () => {
  it("labels the demo receipt a preview and never renders a /verify link", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/voting?demo=1");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Yes — approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Yes — approve" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit vote" }));
    // Toast says preview, the voted card labels the code a preview, and no
    // /verify affordance exists anywhere — a demo receipt verifies nowhere.
    expect(await screen.findByText(/Vote recorded — preview receipt/)).toBeInTheDocument();
    expect(screen.getAllByText("Preview — live votes verify for real").length).toBeGreaterThan(0);
    expect(document.querySelector('a[href="/verify"]')).toBeNull();
    // Shared fixture untouched.
    expect(fallbackData.planItems[0].receiptCode).toBe("");
  });
});

describe("demo contributions without points", () => {
  it("saves a demo RSVP without offering or announcing points", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/events?demo=1");
    render(<App />);
    // Union Ground has no points economy: the RSVP control and its toast
    // say what happened, never what it "earned".
    fireEvent.click((await screen.findAllByRole("button", { name: "RSVP" }))[0]);
    expect(await screen.findByText("RSVP saved")).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ (pts|points)/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bpts\b|\bpoints\b/i);
    // The shared fixture carries no points summary, tier ladder or ledger.
    for (const retired of ["rewardsCatalog", "pointsLedger", "rewardItems", "rewardGrants", "rewardEffects", "experimentalContent"]) {
      expect(fallbackData).not.toHaveProperty(retired);
    }
    expect(fallbackData.rewards?.totalPoints).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("demo settings state", () => {
  it("opens a refreshed member deep link as Member instead of replacing the route with Steward", async () => {
    window.history.replaceState({}, "", "/m/settings?demo=1");
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/settings");
    expect(screen.getByRole("combobox", { name: "Switch role" })).toHaveValue("member");
    expect(screen.queryByText(/cannot open that page/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/This link starts as/)).not.toBeInTheDocument();
  });

  it("updates focus and language locally while keeping unsupported preference writes honest", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/settings?demo=1");
    render(<App />);
    await openPage("/m/settings/notifications");

    const dnd = await screen.findByRole("switch", { name: /^Do not disturb/ });
    expect(dnd).toHaveAttribute("aria-checked", "false");
    fireEvent.click(dnd);
    await waitFor(() => expect(dnd).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText("Focus settings saved")).toBeInTheDocument();

    const topic = screen.getByRole("switch", { name: "Campaign work" });
    fireEvent.click(topic);
    expect(await screen.findByText("Preview — nothing was saved.")).toBeInTheDocument();

    await openPage("/m/settings/language");
    fireEvent.click(screen.getByRole("switch", { name: "Español" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    fireEvent.click(screen.getByRole("switch", { name: "Español" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("demo form drafts", () => {
  // REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111.
  it("discards a draft from the forms list after one confirmation", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/forms?demo=1");
    render(<App />);
    const before = (await screen.findAllByRole("button", { name: "Resume draft" })).length;
    fireEvent.click(screen.getAllByRole("button", { name: "Discard draft" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Draft discarded")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Resume draft" })).toHaveLength(before - 1));
  });

  it("persists a draft edit across close and reopen, then submits into the steward inbox", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/forms?demo=1");
    render(<App />);
    // form-demo-1 (grievance) resumes at its saved step 1 — the detail step.
    fireEvent.click((await screen.findAllByRole("button", { name: "Resume draft" }))[0]);
    const narrative = await screen.findByLabelText(/What happened/);
    fireEvent.change(narrative, { target: { value: "Second swap denial, again with no written reason." } });
    // Back → goToStep(0) persists the answers through the demo twin.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Draft saved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    // Reopen: the draft must still carry the edit (it was lost before the twin).
    fireEvent.click((await screen.findAllByRole("button", { name: "Resume draft" }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByLabelText(/What happened/)).toHaveValue("Second swap denial, again with no written reason.");
    // Complete and submit: remedy is the last required field.
    fireEvent.change(screen.getByLabelText(/Desired remedy/), { target: { value: "Honor the swap and answer in writing." } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("Attach supporting file"), {
      target: { files: [new File(["supporting evidence"], "support.txt", { type: "text/plain" })] },
    });
    await confirmEvidenceUpload();
    await waitFor(() => expect(screen.getByRole("button", { name: "Open support.txt" })).toBeEnabled());
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalOpen = window.open;
    const popup = { location: "", opener: window, close: vi.fn() };
    const open = vi.fn(() => popup);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:demo-support") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "open", { configurable: true, value: open });
    const timeout = vi.spyOn(window, "setTimeout");
    try {
      fireEvent.click(screen.getByRole("button", { name: "Open support.txt" }));
      // The tab is opened on the tap, before any await, so iOS keeps the
      // transient user activation; `noopener` would make Safari return null,
      // so the opener is severed by hand instead.
      await waitFor(() => expect(open).toHaveBeenCalledWith("", "_blank"));
      await waitFor(() => expect(popup.location).toBe("blob:demo-support"));
      expect(popup.opener).toBeNull();
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 60000);
    } finally {
      timeout.mockRestore();
      if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
      else delete URL.createObjectURL;
      if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
      else delete URL.revokeObjectURL;
      Object.defineProperty(window, "open", { configurable: true, value: originalOpen });
    }
    fireEvent.click(screen.getByRole("button", { name: "Remove support.txt" }));
    await waitFor(() => expect(screen.queryByText("support.txt")).toBeNull());
    fireEvent.change(screen.getByLabelText("Attach supporting file"), {
      target: { files: [new File(["supporting evidence"], "support.txt", { type: "text/plain" })] },
    });
    await confirmEvidenceUpload();
    await waitFor(() => expect(screen.getByRole("button", { name: "Open support.txt" })).toBeEnabled());
    const signature = await screen.findByLabelText("Draw your signature");
    vi.spyOn(signature, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(signature, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(signature, { clientX: 90, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(signature, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: /intend this drawing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
    expect(await screen.findByText("Signature saved for this form version")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Submit for committee review" }));
    // Filing earns nothing: Union Ground acknowledges it without points.
    expect(await screen.findByText("Form submitted — in review")).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ points/)).toBeNull();
    // The filing is visible in the demo Steward role's review inbox. The hat
    // select lives only on the Home card now (owner spec, 2026-08-07) — ride
    // the Home orb there first.
    fireEvent.click(document.querySelector(".home-orb"));
    fireEvent.change(await screen.findByLabelText("Switch role"), { target: { value: "steward" } });
    await openPage("/m/steward/forms");
    await screen.findByText("Committee review inbox", {}, { timeout: 8_000 });
    const member = await screen.findByText("Darnell Foster");
    fireEvent.click(member.closest("button"));
    expect(await screen.findByText("Filer signature saved")).toBeInTheDocument();
    expect(screen.getByText("support.txt")).toBeInTheDocument();
    expect(screen.getByText(/another committee member has to review it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector(".app-dialog")).toBeNull());
    const formsPanel = screen.getByText("Committee review inbox").closest("section");
    fireEvent.click(within(formsPanel).getByText("Jordan Mills").closest("button"));
    expect(await screen.findByText("Filer signature saved")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(await screen.findByText("Form approved — the worker has been notified")).toBeInTheDocument();
    // Shared fixtures untouched (the desk seeds three inbox rows).
    expect(fallbackData.forms[0].answers.narrative).toBeUndefined();
    expect(fallbackData.stewardDesk.formsInbox).toHaveLength(3);
  });

  it("keeps outgoing demo co-signer invitations in memory and deduplicated", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/forms?demo=1");
    render(<App />);
    const resumes = await screen.findAllByRole("button", { name: "Resume draft" });
    fireEvent.click(resumes[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit anyway" }));
    const email = await screen.findByLabelText("Member email");

    fireEvent.change(email, { target: { value: "new.cosigner@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByText("Co-sign invitation sent")).toBeInTheDocument();
    expect(screen.getAllByText("new.cosigner@example.test")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Member email"), { target: { value: "NEW.COSIGNER@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(screen.getAllByText("new.cosigner@example.test")).toHaveLength(1));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("demo incoming co-signatures", () => {
  it("accepts with an explicit drawing and then withdraws the demo co-signature", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/forms?demo=1");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const canvas = await screen.findByLabelText("Draw your co-signature");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: /signature on this version/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign and accept" }));
    expect(await screen.findByText("You co-signed — the filer was notified")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Co-signature withdrawn")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("declines a demo co-sign invitation without retaining its row", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/forms?demo=1");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    expect(await screen.findByText("Invitation declined")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("demo steward request dedup", () => {
  it("keeps repeated Request-a-steward clicks to one queue row", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/rights?demo=1");
    render(<App />);
    // The steward card lives inside the lesson walkthrough — open the hero one.
    fireEvent.click(await screen.findByRole("button", { name: /the walkthrough/ }));
    const request = (await screen.findAllByRole("button", { name: "Request" }))[0];
    fireEvent.click(request);
    expect(await screen.findByText("Committee request sent")).toBeInTheDocument();
    fireEvent.click(request);
    // Hat switching lives on the Home card's pill now (owner spec,
    // 2026-08-07).
    fireEvent.click(document.querySelector(".home-orb"));
    fireEvent.change(await screen.findByLabelText("Switch role"), { target: { value: "steward" } });
    await openPage("/m/steward/forms");
    await screen.findByText("Committee review inbox", {}, { timeout: 8_000 });
    // One new row for this member, not two. Awaited: the paged queue seeds
    // through an effect (UB-DESK-01), so rows land a commit after the desk.
    await openPage("/m/steward/requests");
    expect(await screen.findAllByText("Darnell Foster")).toHaveLength(1);
    expect(fallbackData.stewardDesk.queue).toHaveLength(3);
  });
});

describe("demo intake conversion", () => {
  async function expectConvertedTaskInBargaining() {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/organize?demo=1");
    render(<App />);
    // Intake triage belongs to the explicitly selected Coordinator/Steward
    // hat, never to Member merely because demo data authorizes every hat.
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "coordinator" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    // Union Ground's campaign hub lives under the Organize plane, beside
    // the organizing lifecycle at /m/organize.
    window.history.pushState({}, "", "/m/organize/organize?demo=1");
    fireEvent.popState(window);
    expect(await screen.findByRole("heading", { level: 1, name: "Organize" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: "Be heard" }));
    fireEvent.click(screen.getByRole("button", { name: "Triage report" }));
    fireEvent.click(screen.getByRole("button", { name: "Convert to task" }));
    expect(await screen.findByText("Intake converted to a task")).toBeInTheDocument();

    window.history.pushState({}, "", "/m/coordinator?demo=1");
    fireEvent.popState(window);
    expect(await screen.findByRole("heading", { level: 1, name: "Issue queue" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Campaign duty" }));
    const task = await screen.findByRole("button", { name: "Follow up on intake report" });
    expect(task.closest(".kan-col")).toHaveTextContent("Bargaining");
  }

  it("puts the converted task in the first existing chapter workstream", async () => {
    await expectConvertedTaskInBargaining();
  });

  it("keeps the Bargaining workstream when the fixture clock advances 90 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 90 * 86400000));
    try {
      const { fallbackData: futureFixtures } = await import("./fixtures/retired-pre-bot/src/data/fallback.js?future-window-regression");
      primeDemoData(futureFixtures);
      await expectConvertedTaskInBargaining();
    } finally {
      primeDemoData(fallbackData);
      vi.useRealTimers();
    }
  });
});

// A focused Admin page names itself in its h1 and its card no longer repeats
// that title (#9525), so a card is found by the page's h1 and the card's id.
async function pageCard(title, id) {
  await screen.findByRole("heading", { level: 1, name: title });
  return waitFor(() => {
    const card = document.getElementById(id);
    expect(card).not.toBeNull();
    return card;
  });
}

describe("demo member invitations", () => {
  it("creates and revokes an in-memory invitation without touching the backend or shared fixtures", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "admin" } });
    await openPage("/m/admin/invitations");
    const card = (await pageCard("Invite a worker", "admin-invitations"));
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Nadia Reyes" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "nadia@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    expect(await within(card).findByText("Nadia Reyes")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();

    const row = within(card).getByText("Nadia Reyes").closest(".xus-row");
    fireEvent.click(within(row).getByRole("button", { name: "Revoke invitation" }));
    fireEvent.click(within(row).getByRole("button", { name: "Yes, revoke" }));
    expect(await within(row).findByText("Revoked", { selector: ".xus-chip" })).toBeInTheDocument();
    expect(fallbackData.adminDesk.invitations.items).toHaveLength(2);
  });
});

describe("demo authentication operations proof", () => {
  it("renders and mutates non-secret settings, labels, and failed sign-ins entirely in memory", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    expect((await screen.findAllByText("Issue support")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "admin" } });

    await openPage("/m/admin/labels");
    const labels = (await pageCard("Labels and navigation", "admin-labels"));
    await waitFor(() => {
      expect(within(labels).getByRole("textbox", { name: /Issue support/ })).toHaveValue("Issue support");
      expect(within(labels).getByRole("textbox", { name: /Campaign duty/ })).toHaveValue("Campaign duty");
    });
    const caseLabel = within(labels).getByRole("textbox", { name: /Issue support/ });
    fireEvent.change(caseLabel, { target: { value: "Member cases" } });
    // One Save writes every changed label (REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030).
    fireEvent.click(within(labels).getByRole("button", { name: "Save labels" }));
    await waitFor(() => expect(caseLabel).toHaveValue("Member cases"));
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "member" } });
    expect((await screen.findAllByText("Member cases")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "admin" } });
    await openPage("/m/admin/labels");
    const refreshedLabels = (await pageCard("Labels and navigation", "admin-labels"));
    await waitFor(() => expect(within(refreshedLabels).getByRole("textbox", { name: /Campaign duty/ })).toHaveValue("Campaign duty"));

    await openPage("/m/admin/configuration");
    const settings = (await pageCard("Feature switches & limits", "admin-configuration"));
    expect(within(settings).getByText("Recovery code enrollment")).toBeInTheDocument();
    // Passkey sign-in is left out of Union Ground: no enrollment switch.
    expect(within(settings).queryByText("Member passkey enrollment")).not.toBeInTheDocument();
    const retention = within(settings).getByRole("spinbutton", { name: "Failed sign-in retention" });
    await waitFor(() => expect(retention).toHaveValue(90));
    fireEvent.change(retention, { target: { value: "120" } });
    fireEvent.click(within(retention.closest(".xus-config-row")).getByRole("button", { name: /^Save Failed sign-in retention/ }));
    // The toast and the saved row's own line (finding 88 of #6578) both say it.
    expect(await screen.findByTestId("admin-setting-confirmed")).toHaveTextContent("Organization setting saved.");
    const refreshedSettings = document.getElementById("admin-configuration");
    await waitFor(() => expect(within(refreshedSettings).getByRole("spinbutton", { name: "Failed sign-in retention" })).toHaveValue(120));

    const threshold = within(refreshedSettings).getByRole("spinbutton", { name: "Failed sign-in attention threshold" });
    await openPage("/m/admin/failed-logins");
    const inbox = document.getElementById("admin-failed-logins");
    expect(within(inbox).getByText("3 open in 24 hours")).toBeInTheDocument();
    await openPage("/m/admin/configuration");
    const currentThreshold = screen.getByRole("spinbutton", { name: "Failed sign-in attention threshold" });
    expect(currentThreshold).toHaveValue(Number(threshold.value));
    fireEvent.change(currentThreshold, { target: { value: "4" } });
    fireEvent.click(within(currentThreshold.closest(".xus-config-row")).getByRole("button", { name: /^Save Failed sign-in attention threshold/ }));
    await waitFor(() => expect(currentThreshold).toHaveValue(4));
    await openPage("/m/admin/failed-logins");
    await waitFor(() => {
      const currentInbox = document.getElementById("admin-failed-logins");
      expect(within(currentInbox).queryByText("3 open in 24 hours")).not.toBeInTheDocument();
    });

    const currentInbox = document.getElementById("admin-failed-logins");
    const attempt = within(currentInbox).getByText("Jordan Bell").closest(".xus-login-attempt");
    fireEvent.change(within(attempt).getByRole("textbox", { name: "Disposition note" }), {
      target: { value: "Confirmed a member typing error" },
    });
    fireEvent.click(within(attempt).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(within(attempt).getByText("Reviewed")).toBeInTheDocument());

    await openPage("/m/admin/configuration");
    const currentSettings = document.getElementById("admin-configuration");
    const retentionAfterDisposition = within(currentSettings).getByRole("spinbutton", { name: "Failed sign-in retention" });
    fireEvent.change(retentionAfterDisposition, { target: { value: "121" } });
    fireEvent.click(within(retentionAfterDisposition.closest(".xus-config-row")).getByRole("button", { name: /^Save Failed sign-in retention/ }));
    await waitFor(() => {
      const latestSettings = document.getElementById("admin-configuration");
      expect(within(latestSettings).getByRole("spinbutton", { name: "Failed sign-in retention" })).toHaveValue(121);
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(fallbackData.adminDesk.configuration.settings.find((item) => item.key === "security.failed_login_retention_days").value).toBe(90);
    expect(fallbackData.adminDesk.failedLoginInbox.items[0].status).toBe("open");
  });
});

describe("demo sign-in address recovery", () => {
  it("runs entirely in memory, clears the address, and audits without retaining it", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "admin" } });
    await openPage("/m/admin/signin-recovery");
    const card = (await pageCard("Sign-in help: new password or address", "admin-signin-recovery"));
    fireEvent.change(within(card).getByRole("searchbox", { name: "Search campaign workers by name" }), { target: { value: "Maria" } });
    fireEvent.click(within(card).getByRole("button", { name: "Search workers" }));
    fireEvent.click(await within(card).findByRole("button", { name: "Choose Maria Fonseca — With the campaign since 2024 — Worker ID ending MF" }));
    fireEvent.change(within(card).getByLabelText("New sign-in address"), { target: { value: "maria.recovered@example.org" } });
    fireEvent.click(within(card).getByLabelText("I verified this worker's identity outside Union Ground."));
    fireEvent.click(within(card).getByRole("button", { name: "Review address change for Maria Fonseca — With the campaign since 2024 — Worker ID ending MF" }));
    fireEvent.click(within(card).getByRole("button", { name: "Change the sign-in address for Maria Fonseca — With the campaign since 2024 — Worker ID ending MF and end sessions" }));

    expect(await within(card).findByRole("status")).toHaveTextContent("Reissue an emailed password if the worker also needs new credentials");
    expect(within(card).queryByDisplayValue("maria.recovered@example.org")).not.toBeInTheDocument();
    await openPage("/m/admin/audit");
    const auditCard = document.getElementById("admin-audit");
    expect(await within(auditCard).findByText("Alex Rivera changed the sign-in address for Maria Fonseca and ended prior sessions")).toBeInTheDocument();
    expect(within(auditCard).queryByText(/maria\.recovered|@example/)).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(fallbackData.adminDesk.audit.some((item) => item.action === "recover_signin_address")).toBe(false);
  });
});

describe("demo unified messaging parity", () => {
  it("reviews a sample signed email and exposes explicit message-to-event creation", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(<App />);
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "steward" } });
    await openPage("/m/steward/email-intake");

    expect(await screen.findByText("Overnight schedule question")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Claim review" }));
    expect(await screen.findByText("Email intake review updated")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reviewing" }));
    expect(await screen.findByText("Overnight schedule question")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByText("Overnight schedule question")).not.toBeInTheDocument());

    await openPage("/m/steward/messages");
    fireEvent.click(screen.getByText("They scheduled a meeting for Thursday and won't say what it's about."));
    const dialog = await screen.findByRole("dialog", { name: "Jordan Mills" });
    expect(within(dialog).getByRole("button", { name: "Create meeting" })).toBeInTheDocument();
  });
});

describe("demo companion phone context", () => {
  // ?embed=phone is honored only inside a real frame (the same
  // window.parent check the sg-embed-ready handshake uses), so the embed
  // tests shadow window.parent to make this top-level jsdom window read as
  // the companion iframe.
  const realParentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
  const pretendFramed = () => Object.defineProperty(window, "parent", { configurable: true, value: { postMessage: vi.fn() } });
  afterEach(() => {
    if (realParentDescriptor) Object.defineProperty(window, "parent", realParentDescriptor);
    else delete window.parent;
  });

  it("renders the embedded phone instance without any demo strip", async () => {
    pretendFramed();
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1&embed=phone");
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    // The bezel previews the product, so no demo strip — and no demo chip —
    // renders inside it: the outer shell's demo bar beside the bezel is what
    // marks the tab as a demo (owner call, 2026-07-31). The hat select is
    // product chrome a real phone carries — on the home space it rides the
    // floating chrome pill (2026-08-05 look-and-feel pass), so the preview
    // keeps it there.
    expect(document.querySelector(".demo-bar")).toBeNull();
    expect(document.querySelector(".demo-chip")).toBeNull();
    expect(within(document.querySelector(".card-nav__chrome")).getByRole("combobox", { name: "Switch role" })).toBeInTheDocument();
  });

  it("ignores the embed flag outside a frame, so a shared embed URL keeps demo chrome", async () => {
    // No pretendFramed(): this is the companion URL opened as its own tab
    // (frame opened-in-new-tab, pasted link). Stripping the demo chrome
    // there would show seeded member data with nothing marking it a demo.
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1&embed=phone");
    render(<App />);
    expect(await screen.findByRole("heading", { name: PHONE_HOME_GREETING })).toBeInTheDocument();
    // The ordinary PHONE shell boots instead (jsdom answers false to every
    // width query): the desktop bar is render-gated to the wide shell now
    // (UB-DEMO-02/03), so the demo chip is what keeps this tab marked as a
    // preview, with the hat picker riding the home chrome.
    expect(document.querySelector(".demo-bar")).toBeNull();
    expect(document.querySelector(".demo-chip")).not.toBeNull();
    expect(screen.getByLabelText("Switch role")).toBeInTheDocument();
  });
});
