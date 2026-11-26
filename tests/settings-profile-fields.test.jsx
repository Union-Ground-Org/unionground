import { expectHeldWriteFocus, expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DirectoryCard } from "../src/components/AdminCommandCenter.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { getMyProfileDetails, setMyProfileDetails } from "../src/lib/memberApi.js";
import { SettingsView } from "../src/views/SettingsView.jsx";

// REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006: the
// profile page had no pronouns, job, worksite or phone. A member now keeps them
// there, decides who sees them (nothing is shared by default), and the admin
// member directory shows only what the member chose to share.

const TIMEOUT = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
const EMPTY = {
  pronouns: null, jobTitle: null, worksite: null, phone: null,
  detailsVisibility: "only_me", phoneVisibility: "only_me",
};

function clientWith(responses) {
  return { rpc: vi.fn((name) => Promise.resolve(responses[name])) };
}

describe("profile details API", () => {
  it("reads the member's own row and defaults visibility to only me", async () => {
    const client = clientWith({ get_my_profile_details: { data: { pronouns: "she/her", detailsVisibility: "bogus" }, error: null } });
    await expect(getMyProfileDetails(client)).resolves.toEqual({ ...EMPTY, pronouns: "she/her" });
    expect(client.rpc).toHaveBeenCalledWith("get_my_profile_details");
  });

  it("sends trimmed fields with no user id and returns what the server stored", async () => {
    const stored = { pronouns: "they/them", jobTitle: "Library Assistant II", worksite: "Copperline Main Branch", phone: "+1 555 010 0199", detailsVisibility: "admins", phoneVisibility: "only_me" };
    const client = clientWith({ set_my_profile_details: { data: stored, error: null } });
    await expect(setMyProfileDetails(client, { ...stored, pronouns: "  they/them ", jobTitle: "Library Assistant II  ", worksite: "", phone: " +1 555 010 0199 " }))
      .resolves.toEqual(stored);
    expect(client.rpc).toHaveBeenCalledWith("set_my_profile_details", {
      p_pronouns: "they/them",
      p_job_title: "Library Assistant II",
      p_worksite: null,
      p_phone: "+1 555 010 0199",
      p_details_visibility: "admins",
      p_phone_visibility: "only_me",
    });
  });

  it("rejects a refused or timed-out write instead of reporting it saved", async () => {
    await expect(setMyProfileDetails(clientWith({ set_my_profile_details: TIMEOUT }), EMPTY))
      .rejects.toMatchObject({ name: "MemberApiError", label: "Profile details", code: "57014" });
    await expect(getMyProfileDetails(clientWith({ get_my_profile_details: TIMEOUT })))
      .rejects.toMatchObject({ name: "MemberApiError", code: "57014" });
  });
});

describe("profile page work and contact details", () => {
  const member = { id: "member-callum", fullName: "Callum Reyes", initials: "CR" };

  function renderSettings(props) {
    return render(
      <LanguageProvider lang={props.lang ?? "en"}>
        <SettingsView
          data={{ member, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
          onNavigate={vi.fn()}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          lang="en"
          onLanguage={vi.fn()}
          {...props}
        />
      </LanguageProvider>,
    );
  }

  function apiOver(client) {
    return { load: () => getMyProfileDetails(client), save: (next) => setMyProfileDetails(client, next) };
  }

  it("edits pronouns, job, worksite and phone with visibility controls, private by default", async () => {
    const stored = { pronouns: "he/him", jobTitle: "Circulation Clerk", worksite: "Eastside Branch", phone: "555-0142", detailsVisibility: "admins", phoneVisibility: "only_me" };
    const client = clientWith({ get_my_profile_details: { data: EMPTY, error: null }, set_my_profile_details: { data: stored, error: null } });
    renderSettings({ profileDetailsApi: apiOver(client) });

    await screen.findByRole("heading", { name: "Work and contact details" });
    const pronounsVisibility = screen.getByRole("combobox", { name: "Who sees your pronouns, job and worksite" });
    const phoneVisibility = screen.getByRole("combobox", { name: "Who sees your phone number" });
    expect(pronounsVisibility).toHaveValue("only_me");
    expect(phoneVisibility).toHaveValue("only_me");
    expect(screen.getByText(/Nothing is shared until you choose administrators/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Pronouns"), { target: { value: "he/him" } });
    fireEvent.change(screen.getByLabelText("Job title"), { target: { value: "Circulation Clerk" } });
    fireEvent.change(screen.getByLabelText("Worksite"), { target: { value: "Eastside Branch" } });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "555-0142" } });
    fireEvent.change(pronounsVisibility, { target: { value: "admins" } });
    // The disclosure describes saved visibility, even while the draft changes.
    expect(screen.getByText(/Nothing is shared until you choose administrators/)).toBeInTheDocument();
    expect(screen.queryByText(/Administrators see the details you chose to share/)).toBeNull();
    expect(screen.getByText("Unsaved changes.")).toHaveAttribute("role", "status");
    await expectHeldWriteFocus(client.rpc, screen.getByRole("button", { name: "Save details" }));

    expect(await screen.findByText("Details saved.")).toHaveAttribute("role", "status");
    expect(client.rpc).toHaveBeenCalledWith("set_my_profile_details", {
      p_pronouns: "he/him", p_job_title: "Circulation Clerk", p_worksite: "Eastside Branch", p_phone: "555-0142",
      p_details_visibility: "admins", p_phone_visibility: "only_me",
    });
    expect(screen.getByLabelText("Phone number")).toHaveValue("555-0142");
    expect(screen.getByText(/Administrators see the details you chose to share/)).toBeInTheDocument();

    // Drafting private visibility must not imply the saved details are private.
    fireEvent.change(pronounsVisibility, { target: { value: "only_me" } });
    fireEvent.change(phoneVisibility, { target: { value: "admins" } });
    expect(screen.getByText(/Administrators see the details you chose to share/)).toBeInTheDocument();
    fireEvent.change(phoneVisibility, { target: { value: "only_me" } });
    expect(screen.queryByText("Details saved.")).toBeNull();
    expect(screen.getByText("Unsaved changes.")).toHaveAttribute("role", "status");
    expect(screen.queryByText(/Nothing is shared until you choose administrators/)).toBeNull();
    expect(screen.getByText(/Administrators see the details you chose to share/)).toBeInTheDocument();
  });

  it.each([
    ["Pronouns", "they/them"],
    ["Job title", "Librarian"],
    ["Worksite", "Main branch"],
    ["Phone number", "555-0199"],
    ["Who sees your pronouns, job and worksite", "admins"],
    ["Who sees your phone number", "admins"],
  ])("clears saved status when editing %s", async (label, nextValue) => {
    const api = { load: async () => EMPTY, save: async () => EMPTY };
    renderSettings({ profileDetailsApi: api });
    await screen.findByRole("heading", { name: "Work and contact details" });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByText("Details saved.");
    fireEvent.change(screen.getByLabelText(label), { target: { value: nextValue } });
    expect(screen.queryByText("Details saved.")).toBeNull();
    expect(screen.getByText("Unsaved changes.")).toHaveAttribute("role", "status");
  });

  it("locks every editable field until the save settles", async () => {
    let finishSave;
    const api = { load: async () => EMPTY, save: vi.fn(() => new Promise((resolve) => { finishSave = resolve; })) };
    renderSettings({ profileDetailsApi: api });
    const heading = await screen.findByRole("heading", { name: "Work and contact details" });
    const form = heading.closest("form");
    fireEvent.change(screen.getByLabelText("Pronouns"), { target: { value: "they/them" } });
    fireEvent.change(screen.getByLabelText("Who sees your phone number"), { target: { value: "admins" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(api.save).toHaveBeenCalledWith({ ...EMPTY, pronouns: "they/them", phoneVisibility: "admins" });
    expect(within(form).getAllByRole("textbox")).toHaveLength(3);
    // Worksite, shift and classification have suggestion lists, so their
    // accessible role is combobox alongside the two visibility selectors.
    expect(within(form).getAllByRole("combobox")).toHaveLength(5);
    for (const field of form.querySelectorAll("input, select, button")) expect((field).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(form.querySelector("input"));
    const pronouns = screen.getByLabelText("Pronouns");
    fireEvent.change(pronouns, { target: { value: "changed during save" } });
    expect(pronouns).toHaveValue("they/them");
    fireEvent.submit(form);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Nothing is shared until you choose administrators/)).toBeInTheDocument();
    await act(async () => finishSave({ ...EMPTY, pronouns: "they/them", phoneVisibility: "admins" }));
    expect(screen.getByLabelText("Pronouns")).toHaveValue("they/them");
    expect(screen.getByText("Details saved.")).toBeInTheDocument();
    expect(screen.getByText(/Administrators see the details you chose to share/)).toBeInTheDocument();
    for (const field of form.querySelectorAll("input, select, button")) expect(field).toBeEnabled();
  });

  it("shows the unsaved status in Spanish", async () => {
    const api = { load: async () => EMPTY, save: async () => EMPTY };
    renderSettings({ profileDetailsApi: api, lang: "es" });
    await screen.findByLabelText("Pronombres");
    fireEvent.change(screen.getByLabelText("Pronombres"), { target: { value: "ella" } });
    expect(screen.getByText("Cambios sin guardar.")).toHaveAttribute("role", "status");
  });

  it.each([
    ["the phone format", { message: "invalid phone number", code: "22023" }, true],
    ["another field", { message: "invalid profile detail", code: "22023" }, false],
    ["a timeout", { message: "canceling statement due to statement timeout", code: "57014" }, false],
    ["the session", { message: "authentication required", code: "42501" }, false],
  ])("keeps the typed values and names the phone only when the server refuses %s", async (_label, error, phone) => {
    const client = clientWith({
      get_my_profile_details: { data: EMPTY, error: null },
      set_my_profile_details: { data: null, error },
    });
    renderSettings({ profileDetailsApi: apiOver(client) });
    await screen.findByRole("heading", { name: "Work and contact details" });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "call me" } });
    fireEvent.change(screen.getByLabelText("Who sees your phone number"), { target: { value: "admins" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Your details were not saved\./);
    expect(/Check the phone number/.test(alert.textContent)).toBe(phone);
    if (!phone) expect(alert).toHaveTextContent("Try again in a moment.");
    expect(screen.getByLabelText("Phone number")).toHaveValue("call me");
    expect(screen.getByLabelText("Phone number")).toBeEnabled();
    expect(screen.queryByText("Details saved.")).toBeNull();
    expect(screen.getByText(/Nothing is shared until you choose administrators/)).toBeInTheDocument();
  });

  it("is not offered to a PIN-restricted session or without a backend", () => {
    const api = { load: vi.fn(async () => EMPTY), save: vi.fn() };
    const { unmount } = renderSettings({ profileDetailsApi: api, sessionRestricted: true });
    expect(screen.queryByRole("heading", { name: "Work and contact details" })).toBeNull();
    expect(api.load).not.toHaveBeenCalled();
    unmount();
    renderSettings({ profileDetailsApi: null });
    expect(screen.queryByRole("heading", { name: "Work and contact details" })).toBeNull();
  });

  // REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: how forms use these
  // details sits under them, with the member's ask/always/never answer.
  it("offers the form autofill choice beside the details, never to a PIN-restricted session", async () => {
    const api = { load: vi.fn(async () => EMPTY), save: vi.fn() };
    const formAutofillApi = { load: vi.fn(async () => ({ preference: "never", shared: false, values: {} })), savePreference: vi.fn() };
    const { unmount } = renderSettings({ profileDetailsApi: api, formAutofillApi });
    expect(await screen.findByRole("heading", { name: "Filling forms from your profile" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "When a form has workplace fields" })).toHaveValue("never");
    unmount();
    renderSettings({ profileDetailsApi: api, formAutofillApi, sessionRestricted: true });
    expect(screen.queryByRole("heading", { name: "Filling forms from your profile" })).toBeNull();
  });
});

describe("admin member directory shows only what the member shared", () => {
  it("lists shared details on the member's row and nothing for a member who shared none", async () => {
    const api = {
      loadMemberDirectory: vi.fn(async () => ({
        items: [
          { userId: "u-callum", fullName: "Callum Reyes", initials: "CR", roles: [], profileDetails: { pronouns: "he/him", jobTitle: "Circulation Clerk", phone: "555-0142" } },
          { userId: "u-nadia", fullName: "Nadia Farouk", initials: "NF", roles: [], profileDetails: {} },
        ],
        nextCursor: null,
      })),
    };
    const initial = await api.loadMemberDirectory("", null);
    render(<LanguageProvider lang="en"><DirectoryCard api={api} initial={initial} /></LanguageProvider>);
    const callum = screen.getByText("Callum Reyes").closest(".xus-row");
    expect(within(callum).getByText(/Shared by the worker/)).toHaveTextContent("Shared by the worker: he/him · Circulation Clerk · 555-0142");
    const nadia = screen.getByText("Nadia Farouk").closest(".xus-row");
    expect(within(nadia).queryByText(/Shared by the worker/)).toBeNull();
  });
});
