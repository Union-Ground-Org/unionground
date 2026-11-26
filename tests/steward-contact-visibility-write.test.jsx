import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import {
  getMemberChapterStewards,
  getMyStewardContactVisibility,
  setMyStewardContactVisibility,
} from "../src/lib/memberApi.js";
import { SettingsView } from "../src/views/SettingsView.jsx";

// BUG-UG-WRITE-TIMEOUT-SHOWN-AS-SAVED-20261003: the steward contact
// readers and writer did not await expectWrite, so a timed-out or refused write
// never rejected. The card said "Saved." and cleared the form while nothing was
// stored, and the read returned a Promise instead of the saved row.

const TIMEOUT = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
const SAVED_ROW = { shareEmail: true, sharePhone: false, contactEmail: "abby@example.org", contactPhone: null };

function clientWith(responses) {
  return { rpc: vi.fn((name) => Promise.resolve(responses[name])) };
}

describe("steward contact visibility API", () => {
  it("rejects a timed-out write instead of reporting it saved", async () => {
    const client = clientWith({ set_my_steward_contact_visibility: TIMEOUT });
    await expect(setMyStewardContactVisibility(client, { shareEmail: true, contactEmail: "abby@example.org" }))
      .rejects.toMatchObject({ name: "MemberApiError", label: "Contact visibility", code: "57014" });
  });

  it("returns the row the server stored", async () => {
    const client = clientWith({ set_my_steward_contact_visibility: { data: SAVED_ROW, error: null } });
    await expect(setMyStewardContactVisibility(client, { shareEmail: true, contactEmail: "abby@example.org" })).resolves.toEqual(SAVED_ROW);
  });

  it("reads the saved preference and rejects a failed read", async () => {
    await expect(getMyStewardContactVisibility(clientWith({ get_my_steward_contact_visibility: { data: SAVED_ROW, error: null } })))
      .resolves.toEqual(SAVED_ROW);
    await expect(getMyStewardContactVisibility(clientWith({ get_my_steward_contact_visibility: TIMEOUT })))
      .rejects.toMatchObject({ name: "MemberApiError", code: "57014" });
  });

  it("passes chapter stewards through and rejects a failed read", async () => {
    const steward = { id: "steward-abby", name: "Abby Kowalczyk", roleLabel: "steward", contact: { conversation: true, email: "abby@example.org" } };
    const list = await getMemberChapterStewards(clientWith({ get_member_chapter_stewards: { data: [steward], error: null } }));
    expect(list.map((row) => row.id)).toEqual(["steward-abby"]);
    expect(list[0].contact.email).toBe("abby@example.org");
    await expect(getMemberChapterStewards(clientWith({ get_member_chapter_stewards: TIMEOUT }))).rejects.toMatchObject({ code: "57014" });
  });
});

describe("steward contact card through the real API", () => {
  function renderCard(client) {
    const api = {
      load: () => getMyStewardContactVisibility(client),
      save: (next) => setMyStewardContactVisibility(client, next),
    };
    return render(
      <LanguageProvider lang="en">
        <SettingsView
          data={{ member: { id: "steward-abby", fullName: "Abby Kowalczyk", initials: "AK" }, roles: ["steward"], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
          onNavigate={vi.fn()}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          lang="en"
          onLanguage={vi.fn()}
          stewardContactApi={api}
        />
      </LanguageProvider>,
    );
  }

  async function shareEmail() {
    await screen.findByRole("heading", { name: "How workers can reach you" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show my email to workers" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "abby@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save contact visibility" }));
  }

  const NOTHING = { data: { shareEmail: false, sharePhone: false, contactEmail: null, contactPhone: null }, error: null };

  it("says not saved and keeps what the steward typed when the write times out", async () => {
    renderCard(clientWith({ get_my_steward_contact_visibility: NOTHING, set_my_steward_contact_visibility: TIMEOUT }));
    await shareEmail();
    expect(await screen.findByRole("alert")).toHaveTextContent("That could not be saved.");
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(screen.getByLabelText("Email address")).toHaveValue("abby@example.org");
  });

  it("says saved and shows the stored values when the write succeeds", async () => {
    renderCard(clientWith({ get_my_steward_contact_visibility: NOTHING, set_my_steward_contact_visibility: { data: SAVED_ROW, error: null } }));
    await shareEmail();
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show my email to workers" })).toBeChecked();
    expect(screen.getByLabelText("Email address")).toHaveValue("abby@example.org");
  });
});
