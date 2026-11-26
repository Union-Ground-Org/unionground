import { capturedAppClientFixture, capturedAppAccountFixture } from "./helpers/capturedAppClientFixture.js";
// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
// (#8318): web journeys through the real routes on a small new organization
// (tests/fixtures/small-new-organization/), loaded through the member backend
// stand-in, not demo mode. Each journey ends where the person's job ends: the
// page opened, the count changed, the item selected, the draft back on
// screen. The real App, session loader, views and API wrappers run; only
// Supabase is the stand-in.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { applyDeviceParityState } from "../src/lib/deviceParity.js";
import { otherPeople, people, studioSurvey } from "./fixtures/small-new-organization/organization.js";

const backend = await vi.hoisted(async () => {
  const { createSmallNewOrganizationBackend } = await import("./fixtures/small-new-organization/backend.js");
  return createSmallNewOrganizationBackend({ captureInserts: true });
});
vi.mock("../src/lib/supabase.js", async (original) => {
  const implementation = await original();
  return {
  ...implementation, appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
  createCapturedAppAccountClient: async () => capturedAppAccountFixture(backend.client),
  // Preserve the original unavailable cosmetics/dues readers; this seam
  // supplies only the batch's bounded dispatch client.
  createCapturedAppSessionRpcClient: (session, options) => options?.boundedTransport
    ? capturedAppClientFixture(backend.client) : implementation.createCapturedAppSessionRpcClient(session, options),
  };
});
vi.mock("../src/lib/memberSessionLoader.js", async (original) => {
  const implementation = await original();
  return { ...implementation, createMemberSessionLoader(client, user, options) {
    let loader;
    loader = implementation.createMemberSessionLoader(backend.scopedClient(user, () => loader), user, { ...options, concurrency: 8 });
    backend.state.loader = loader;
    return loader;
  } };
});

const BOOT = { timeout: 10000 };

async function signIn(key, path = "/m", options = {}) {
  const person = backend.signInAs(key, options);
  window.history.replaceState({}, "", path);
  render(<App />);
  await screen.findByRole("heading", { name: new RegExp(person.firstName) }, BOOT);
  return person;
}

// What a click on an in-app link does: a pushState and a popstate.
async function openAddress(path) {
  await act(async () => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

function expectNoOtherOrganizationPeople() {
  for (const person of Object.values(otherPeople)) expect(document.body).not.toHaveTextContent(person.fullName);
}

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert fixture backend")));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn();
  backend.resetOrganization();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("a small new organization boots without demo data", () => {
  it("greets the fixture member by name, with their chapter, and none of the other organization's people", async () => {
    await signIn("member");
    expect(screen.getAllByText("Fernbrook North Clinic").length).toBeGreaterThan(0);
    // The stand-in answered the reads; nothing came from the retired demo data.
    expect(backend.state.operations.some((operation) => operation.resource === "table:member_profiles")).toBe(true);
    expectNoOtherOrganizationPeople();
  });
});

// UX-UG-FORMS-SILENT-200-CHARACTER-CUT-AND-DOUBLE-EDITOR-20261111
// (#8212): a shared draft's editor stayed on screen beside the next one (the
// editor and the sharing panel shared a React key), and the 200-character cut
// on the issue summary was silent.
describe("a shared forms draft closes, reopens, and shows its length limit", () => {
  const editors = () => screen.queryAllByRole("button", { name: /Close form/ }).length;
  async function resumeSharedDraft() {
    await signIn("member");
    await openAddress("/m/forms");
    // Draft sharing is on: the draft is shared with the chapter officer. The
    // closed share control says so (#9555), and opened, the officer's own row
    // offers to stop sharing.
    const shared = await screen.findByText(`Shared with ${people.chapterOfficer.fullName}`);
    fireEvent.click(shared.closest("summary"));
    expect(await screen.findByRole("button", { name: `Stop sharing with ${people.chapterOfficer.fullName}` })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    await waitFor(() => expect(editors()).toBe(1));
  }

  it("closes the shared draft to no editor and reopens it to one, with the saved answer", async () => {
    await resumeSharedDraft();
    const answer = "Nights at the North Clinic run one aide short.";
    fireEvent.change(screen.getByRole("textbox", { name: "Issue summary" }), { target: { value: answer } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(backend.state.writes.at(-1)?.answers).toMatchObject({ summary: answer }));

    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(editors()).toBe(0));
    fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    await waitFor(() => expect(editors()).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Issue summary" })).toHaveValue(answer);
    // Still one draft, the one the member was sharing.
    expect(backend.state.rows["table:member_forms"]).toHaveLength(1);
  });

  it("shows the issue summary's 200-character limit as the member types", async () => {
    await resumeSharedDraft();
    const summary = screen.getByRole("textbox", { name: "Issue summary" });
    expect(summary).toHaveAttribute("maxlength", "200");
    expect(summary).toHaveAccessibleDescription(expect.stringContaining("0 of 200 characters"));
    fireEvent.change(summary, { target: { value: "Short-staffed nights at the clinic. ".repeat(6).slice(0, 200) } });
    expect(summary).toHaveAccessibleDescription(expect.stringContaining("Limit reached: 200 characters."));
  });
});

// BUG-UG-FORM-SIGNATURE-SIGNS-ANSWERS-THE-SIGNER-NEVER-SAW-20261113
// (#8702, gate round 1 on #8704): the editor's save names its form, and a form
// submitted in another tab refuses it as final. The refusal is not retried,
// Your forms is read again, and Close leaves without a second save.
describe("a draft submitted in another tab while this tab edits it", () => {
  it("stops saving, shows why, re-reads Your forms and closes without saving again", async () => {
    await signIn("member");
    await openAddress("/m/forms");
    fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    await screen.findByRole("button", { name: /Close form/ });
    const forms = backend.state.rows["table:member_forms"];
    expect(forms).toHaveLength(1);
    // Another tab signs and submits the same draft.
    Object.assign(forms[0], { status: "submitted", submitted_at: new Date().toISOString() });
    const writes = backend.state.writes.length;
    fireEvent.change(screen.getByRole("textbox", { name: "Issue summary" }), { target: { value: "Typed after the other tab submitted" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/already submitted somewhere else/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    // The list was read again: the form is no longer offered as a draft.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resume draft" })).toBeNull());
    expect(backend.state.writes.length).toBe(writes);
    expect(forms).toHaveLength(1);
    expect(forms[0].answers?.summary).not.toBe("Typed after the other tab submitted");
  });
});

// BUG-UG-ORDINARY-FORM-SAVE-OVERWRITES-A-NEWER-EDIT-FROM-ANOTHER-SESSION-20261114
// (#8719): a save names the write it was based on, by its revision (#9092). A draft another tab saved
// since is not overwritten: the save is refused, Your forms is read again,
// and the editor shows the stored answers.
describe("a draft another tab saved while this tab edits it", () => {
  it("is not overwritten, and this tab shows the stored answers", async () => {
    await signIn("member");
    await openAddress("/m/forms");
    fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    await screen.findByRole("button", { name: /Close form/ });
    const forms = backend.state.rows["table:member_forms"];
    // Another tab saves a newer summary, and the trigger moves the revision.
    forms[0].answers = { ...forms[0].answers, summary: "Saved in the other tab" };
    forms[0].revision += 1;
    const writes = backend.state.writes.length;
    fireEvent.change(screen.getByRole("textbox", { name: "Issue summary" }), { target: { value: "Typed in this tab" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/changed somewhere else, so your latest change here was not saved/)).toBeInTheDocument();
    expect(backend.state.writes.length).toBe(writes);
    expect(forms[0].answers.summary).toBe("Saved in the other tab");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Issue summary" })).toHaveValue("Saved in the other tab"));
  });
});

// BUG-UG-ENGAGEMENT-STUDIO-ADDRESSES-ALL-SHOW-WEEKLY-POOL-20261111
// (#8210): for a chapter-only officer every studio address silently showed
// the Weekly pool.
describe("each Engagement studio address for a chapter-only officer", () => {
  it.each([
    ["surveys", "Surveys is not open to your campaign role, so this page shows the Weekly pool."],
    ["polls", "Live polls is not open to your campaign role, so this page shows the Weekly pool."],
    ["pulse", "Contextual is not open to your campaign role, so this page shows the Weekly pool."],
    ["delivery", "Delivery is not open to your campaign role, so this page shows the Weekly pool."],
    ["channels", "Channels is not open to your campaign role, so this page shows the Weekly pool."],
    ["weekly", "Your campaign role opens only the Weekly pool here."],
  ])("names what /m/campaigns/engagement/%s cannot show and who can open it", async (page, said) => {
    await signIn("chapterOfficer");
    await act(async () => { screen.getByRole("button", { name: "Committee" }).click(); });
    await openAddress(`/m/campaigns/engagement/${page}`);
    const limited = await screen.findByTestId("engagement-role-limited", {}, BOOT);
    expect(limited).toHaveTextContent(said);
    expect(limited).toHaveTextContent("role for the whole organization. Ask your organization's administrator.");
    // The page the officer can use is there, on their own chapter's pool.
    expect(await screen.findByText("Should the North Clinic ask for a second break room?")).toBeInTheDocument();
  });
});

// BUG-UG-SECURITY-PAGE-LOOPS-RESTORING-STAFF-ROLES-20261111
// (#8222): a refreshed token for the same session hid the two-step panel
// until the new token was checked, which unmounted it and lost the recovery
// codes on screen.
describe("a refreshed session token while the Security page is open", () => {
  it("keeps the two-step panel and the recovery codes on screen while the new token is checked", async () => {
    // A verified two-step session: an aal2 token and the verified factor.
    backend.signInAs("organizationOfficer", { twoStep: true });
    expect(await backend.client.auth.mfa.getAuthenticatorAssuranceLevel()).toMatchObject({ data: { currentLevel: "aal2", nextLevel: "aal2" } });
    applyDeviceParityState("app.selectedStaffHat", "member");
    window.history.replaceState({}, "", "/m/settings/security");
    render(<App />);
    const generate = await screen.findByRole("button", { name: "Generate recovery codes" }, BOOT);
    expect(backend.state.factorReads).toBe(1);
    await act(async () => { fireEvent.click(generate); });
    await screen.findByText("fern-0001-aaaa");
    let answer;
    vi.spyOn(backend.client.auth.mfa, "getAuthenticatorAssuranceLevel")
      .mockImplementationOnce(() => new Promise((resolve) => {
        answer = () => resolve({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null });
      }));
    await act(async () => { await backend.refreshToken(); });
    // While the refreshed token is checked, the page stays as it was.
    expect(document.querySelector("#mfa-challenge-title")).toBeNull();
    expect(screen.getByText("fern-0001-aaaa")).toBeInTheDocument();
    await waitFor(() => expect(answer).toEqual(expect.any(Function)));
    await act(async () => { answer(); });
    expect(screen.getByText("fern-0001-aaaa")).toBeInTheDocument();
    // One read of the factor list: the two-step panel never remounted.
    expect(backend.state.factorReads).toBe(1);
  }, 20000);
});

// BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111
// (#8209, web half): Home counted only the retired member_surveys rows, so a
// member with an open studio survey read "0 open surveys".
describe("a survey the studio publishes is counted on the member's Home", () => {
  const surveyCount = () => screen.getAllByText(/organization surveys? in Be heard$/).map((node) => node.textContent);
  // The fixture holds no close date that can pass (#8389): the journey reads
  // the same on today's clock and on one moved past the end of 2026.
  it.each([
    ["today's clock", null],
    ["a clock moved to Jan 2, 2027", "2027-01-02T15:00:00.000Z"],
  ])("counts the studio survey, then the one the organization officer publishes, on %s", async (_clock, now) => {
    if (now) vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    await signIn("member");
    await waitFor(() => expect(surveyCount()).toContain("0 open votes · 0 open surveys · 1 organization survey in Be heard"));
    cleanup();

    await signIn("organizationOfficer");
    await act(async () => { screen.getByRole("button", { name: "Admin" }).click(); });
    await openAddress("/m/campaigns/engagement/surveys");
    expect(await screen.findByText(studioSurvey.title, {}, BOOT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New survey" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Should Riverside and North share one float pool?" } });
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "one_off" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Should Riverside and North share one float pool?" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish survey" }));
    await waitFor(() => expect(backend.published).toHaveLength(1));
    // The stand-in keeps the cadence the studio sent.
    expect(backend.published[0].cadence).toBe("one_off");
    expect(await screen.findByText("Should Riverside and North share one float pool?")).toBeInTheDocument();
    cleanup();

    await signIn("member");
    await waitFor(() => expect(surveyCount()).toContain("0 open votes · 0 open surveys · 2 organization surveys in Be heard"));
    // The member's snapshot passes each survey's cadence through, as the
    // server's does.
    expect(backend.state.rows["rpc:get_member_engagement_snapshot"].surveys.map((survey) => survey.cadence)).toEqual(["one_off", "one_off"]);
  }, 20000);
});
