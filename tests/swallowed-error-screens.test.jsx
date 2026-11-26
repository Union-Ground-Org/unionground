import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BallotNominations } from "../src/features/elections/BallotNominations.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { READ_FAILURES, expectFailureShown, failingRead } from "./helpers/failingRead.js";

// SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113: two screens turned a
// failed read into "nothing here". Open nominations vanished from Voting, and
// a steward's thread showed no scheduled messages, inviting a second schedule.

const ballot = {
  ballotId: "ballot-officers", title: "Tamarack officers", nominationsCloseAt: "2026-11-20T22:00:00Z", nominations: [],
};

describe("open nominations on Voting", () => {
  it.each(READ_FAILURES)("says a %s failure out loud and reads again on Try again", async (kind) => {
    const fail = failingRead(kind);
    const client = { rpc: vi.fn(fail) };
    const view = render(<LanguageProvider lang="en"><BallotNominations client={client} /></LanguageProvider>);
    const alert = await screen.findByRole("alert");
    expectFailureShown(view.container.textContent, { failure: "Nominations could not be loaded.", empty: ["No nominations yet."], success: ["Nomination seconded."] });
    expect(alert).toHaveTextContent("Nominations could not be loaded.");
    client.rpc.mockResolvedValue({ data: [ballot], error: null });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No nominations yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fail.calls).toBe(1);
  });

  it("treats a refused read as a failure and no open ballot as nothing to show", async () => {
    const refused = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST000", message: "unavailable" } }) };
    const first = render(<LanguageProvider lang="es"><BallotNominations client={refused} /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar las nominaciones.");
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeInTheDocument();
    first.unmount();
    const none = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    const view = render(<LanguageProvider lang="en"><BallotNominations client={none} /></LanguageProvider>);
    await waitFor(() => expect(none.rpc).toHaveBeenCalled());
    expect(view.container.querySelector(".voting-nominations")).toBeNull();
  });
});

function stewardDesk() {
  return {
    queue: [],
    threads: [{
      id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "Shift question", updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
      messages: [{ id: "m-1", sender_kind: "member", sender_name: "Renata Cole", body: "Shift question", created_at: "2026-07-21T09:00:00Z" }],
    }],
    broadcasts: [],
    formsInbox: [],
    kpis: { openRequests: 0, membersCovered: 1, awaitingReply: 1, broadcasts30d: 0 },
  };
}

describe("a steward thread's scheduled messages", () => {
  beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => {
    delete Element.prototype.scrollIntoView;
    window.history.replaceState({}, "", "/m");
  });

  it.each(READ_FAILURES)("shows a %s failure instead of an empty schedule, and Try again reads it", async (kind) => {
    const fail = failingRead(kind);
    const listScheduled = vi.fn(fail);
    window.history.replaceState({}, "", "/m/steward?thread=conv-1");
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} onNotice={() => {}}
      api={{ loadDesk: vi.fn(async () => stewardDesk()), listScheduled }} />);
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    const alert = await within(dialog).findByText("Scheduled messages could not be loaded.");
    expect(alert.closest("[role=alert]")).not.toBeNull();
    expect(dialog.querySelector(".inbox-scheduled__row")).toBeNull();
    listScheduled.mockResolvedValue([{ id: "s-1", body: "Shift reminder", scheduled_for: "2026-07-22T13:00:00Z" }]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText(/Shift reminder/u)).toBeInTheDocument();
    expect(within(dialog).queryByText("Scheduled messages could not be loaded.")).toBeNull();
    expect(fail.calls).toBe(1);
  });
});
