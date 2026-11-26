// REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: the
// operations desk names the ledger's actors through
// list_organization_audit_actor_names, asks only for ids it has not settled,
// and drops a reply that lands after the desk closed. The same file holds the
// desk's other unmount and timer paths so the view's coverage stays whole.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildMi1FeatureActor } from "../src/lib/mi1FeatureWiring.js";
import { OperationsHealthView } from "../src/views/OperationsHealthView.jsx";

const ORG = "11111111-1111-4111-8111-111111111111";
const NAMED = "22222222-2222-4222-8222-222222222222";
const UNNAMED = "33333333-3333-4333-8333-333333333333";
const OLDER = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP = [{
  selected: true,
  organizationId: ORG,
  chapterId: "chapter-a",
  organizationRoles: ["admin"],
  chapterRoles: [],
}];
const FAILING_JOB = {
  jobName: "notifications-dispatch-tick",
  organizationId: ORG,
  lastRunId: "run-42",
  lastStatus: "failed",
  lastStartedAt: "2026-08-24T00:00:00.000Z",
  lastFinishedAt: "2026-08-24T00:01:00.000Z",
  failureCode: "timeout",
  acknowledged: false,
  remediation: null,
};

function adminSession() {
  return buildMi1FeatureActor({
    userId: "admin-a",
    organizationId: ORG,
    roles: ["admin"],
    mfaSatisfied: true,
    selectedHat: "admin",
  });
}

function wrap(node, lang = "en") {
  return render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
}

function row(index, actorUserId) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    domain: "operations",
    eventType: `event-${index}`,
    actorUserId,
    entityType: "job",
    occurredAt: `2026-08-24T00:${String(59 - (index % 60)).padStart(2, "0")}:00.000Z`,
  };
}

function invitation(id, kind, createdAt = "2026-08-24T00:01:00.000Z") {
  return { id, organizationId: ORG, kind, createdAt };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const nameCalls = (rpc) => rpc.mock.calls.filter(([name]) => name === "list_organization_audit_actor_names");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("operations desk actor names", () => {
  it("names known actors, settles unnamed ones, and asks again only for new ids on an older page", async () => {
    // A full first page (so older entries can load) with one named and one
    // unnamed actor; the older page brings a third actor.
    const firstPage = Array.from({ length: 50 }, (_, index) => row(index, index % 2 ? UNNAMED : NAMED));
    const rpc = vi.fn(async (name, args) => {
      if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
      if (name === "list_organization_audit_ledger") return { data: args.p_before ? [row(50, OLDER)] : firstPage };
      if (name === "list_organization_audit_actor_names") {
        return { data: Object.fromEntries(args.p_user_ids.filter((id) => id !== UNNAMED).map((id) => [id, id === NAMED ? "Ada Admin" : "Olu Older"])) };
      }
      return { data: [] };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);

    expect((await screen.findAllByText(/Ada Admin/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(nameCalls(rpc).length).toBeGreaterThan(0));
    const settled = nameCalls(rpc).length;
    // Every id the first page names was asked once; the unnamed one is
    // remembered, so re-renders of the same page ask nothing more.
    expect(nameCalls(rpc).flatMap(([, args]) => args.p_user_ids)).toEqual(expect.arrayContaining([NAMED, UNNAMED]));

    fireEvent.click(screen.getByRole("button", { name: "Load older entries" }));
    expect(await screen.findByText(/Olu Older/)).toBeInTheDocument();
    const later = nameCalls(rpc).slice(settled).map(([, args]) => args.p_user_ids);
    expect(later).toContainEqual([OLDER]);
    // The names already settled for this organization stay on screen.
    expect(screen.getAllByText(/Ada Admin/).length).toBeGreaterThan(0);
  });

  it("drops a names reply that lands after the desk closed", async () => {
    const reply = deferred();
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
      if (name === "list_organization_audit_ledger") return { data: [row(1, NAMED)] };
      if (name === "list_organization_audit_actor_names") return reply.promise;
      return { data: [] };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    await waitFor(() => expect(nameCalls(rpc).length).toBeGreaterThan(0));
    view.unmount();
    await act(async () => {
      reply.resolve({ data: { [NAMED]: "Ada Admin" } });
      await reply.promise;
    });
    expect(screen.queryByText(/Ada Admin/)).not.toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("operations desk lifecycle", () => {
  it.each([
    {
      lang: "en",
      source: "Source",
      empty: "No audit events for this organization yet.",
      message: "The audit log could not be loaded.",
      retry: "Try again",
      labels: ["New invitation requested", "New invitation accepted", "Role removed from invitation"],
    },
    {
      lang: "es",
      source: "Origen",
      empty: "Todavía no hay eventos de auditoría para esta organización.",
      message: "No se pudo cargar el registro de auditoría.",
      retry: "Intentar de nuevo",
      labels: ["Se solicitó una nueva invitación", "Se aceptó una nueva invitación", "Se quitó el rol de la invitación"],
    },
  ])("lets an administrator retry a rejected invitation projection in $lang", async ({ lang, source, empty, message, retry, labels }) => {
    const invitationRows = ["reinvite_requested", "reinvite_accepted", "invite_role_cleared"]
      .map((kind, index) => invitation(index + 1, kind));
    let reads = 0;
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
      if (name === "list_member_invitation_audit") {
        reads += 1;
        return { data: reads === 1 ? [invitation(1, "invite_sent", "invalid")] : invitationRows };
      }
      return { data: [] };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />, lang);
    await screen.findByText(empty);
    fireEvent.change(screen.getByLabelText(source), { target: { value: "member_invitation_audit" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    fireEvent.click(screen.getByRole("button", { name: retry }));
    for (const label of labels) {
      expect(await screen.findByText(label, { exact: false, selector: ".xus-atext" })).toBeInTheDocument();
    }
    expect(reads).toBe(2);
    expect(screen.getByLabelText(source)).toHaveValue("member_invitation_audit");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the first invitation page available when an older read rejects", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => invitation(index + 2, "invite_sent"));
    let olderReads = 0;
    const rpc = vi.fn(async (name, args) => {
      if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
      if (name !== "list_member_invitation_audit") return { data: [] };
      if (!args.p_before) return { data: firstPage };
      olderReads += 1;
      if (olderReads === 1) throw new Error("offline");
      return { data: [invitation(1, "invite_revoked", "2026-08-24T00:00:00.000Z")] };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    await screen.findByText("No audit events for this organization yet.");
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "member_invitation_audit" } });
    fireEvent.click(await screen.findByRole("button", { name: "Load older entries" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Older audit entries could not be loaded.");
    expect(screen.getAllByText(/invitation · sent/u)).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Load older entries" }));
    expect(await screen.findByText(/invitation · revoked/u)).toBeInTheDocument();
    expect(screen.getAllByText(/invitation · sent/u)).toHaveLength(50);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(olderReads).toBe(2);
  });

  it("refreshes job health on its timer and stops the timer when the desk closes", async () => {
    const timers = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    });
    const cleared = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
      if (name === "list_organization_job_health") return { data: [FAILING_JOB] };
      return { data: [] };
    });
    const view = wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    await screen.findByRole("button", { name: /Acknowledge Notification dispatch/i });
    const tick = timers.filter((timer) => timer.delay === 60_000).at(-1);
    expect(tick).toBeTruthy();
    const healthReads = () => rpc.mock.calls.filter(([name]) => name === "list_organization_job_health").length;
    const before = healthReads();
    await act(async () => { tick.callback(); });
    await waitFor(() => expect(healthReads()).toBeGreaterThan(before));
    view.unmount();
    expect(cleared).toHaveBeenCalled();
  });

  it.each([
    ["acknowledge_organization_job_run", /Acknowledge Notification dispatch/i],
    ["request_organization_job_retry", /Record retry request Notification dispatch/i],
  ])("leaves a closed desk alone when %s answers late", async (command, button) => {
    const reply = deferred();
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: MEMBERSHIP };
      if (name === "list_organization_job_health") return { data: [FAILING_JOB] };
      if (name === command) return reply.promise;
      return { data: [] };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    fireEvent.click(await screen.findByRole("button", { name: button }));
    await waitFor(() => expect(rpc.mock.calls.some(([name]) => name === command)).toBe(true));
    const healthReads = rpc.mock.calls.filter(([name]) => name === "list_organization_job_health").length;
    view.unmount();
    await act(async () => {
      reply.resolve({ data: [FAILING_JOB] });
      await reply.promise;
    });
    // A closed desk neither refreshes health nor touches its state.
    expect(rpc.mock.calls.filter(([name]) => name === "list_organization_job_health")).toHaveLength(healthReads);
    expect(errors).not.toHaveBeenCalled();
  });
});
