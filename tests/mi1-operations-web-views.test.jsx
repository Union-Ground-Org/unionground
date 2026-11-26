import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildMi1FeatureActor } from "../src/lib/mi1FeatureWiring.js";
import { OperationsHealthView } from "../src/views/OperationsHealthView.jsx";

const ORG = "11111111-1111-4111-8111-111111111111";
const SELECTED_ADMIN_MEMBERSHIP = [{
  selected: true,
  organizationId: ORG,
  chapterId: "chapter-a",
  organizationRoles: ["admin"],
  chapterRoles: [],
}];

function wrap(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

function adminSession() {
  return buildMi1FeatureActor({
    userId: "admin-a",
    organizationId: ORG,
    roles: ["admin"],
    mfaSatisfied: true,
    selectedHat: "admin",
  });
}

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

describe("CR-106/CR-107 operations web surfaces", () => {
  it("keeps the audit ledger honest when persistence is missing", async () => {
    wrap(<OperationsHealthView
      session={buildMi1FeatureActor({
        userId: "admin-a",
        organizationId: ORG,
        roles: ["admin"],
        mfaSatisfied: true,
        selectedHat: "admin",
      })}
      client={null}
    />);
    expect(await screen.findByText(/audit ledger is unavailable in this environment/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Organization audit log" })).toBeInTheDocument();
    expect(screen.queryByText(/case\.status_changed|member\.viewed/i)).not.toBeInTheDocument();
  });

  it("reports unavailable job persistence honestly and does not execute retry in the browser", async () => {
    const rpc = vi.fn(async () => ({ error: { code: "PGRST202", message: "Could not find the function" } }));
    wrap(<OperationsHealthView
      session={buildMi1FeatureActor({
        userId: "admin-a",
        organizationId: ORG,
        roles: ["admin"],
        mfaSatisfied: true,
        selectedHat: "admin",
      })}
      client={{ rpc }}
    />);
    expect(await screen.findByRole("heading", { name: "Background job health" })).toBeInTheDocument();
    expect(await screen.findByText(/job health is unavailable in this environment/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request retry" })).not.toBeInTheDocument();
    expect(rpc.mock.calls.every(([name]) => name !== "record_organization_audit_event")).toBe(true);
  });

  it("filters audit domains from the mounted panel", async () => {
    wrap(<OperationsHealthView
      session={buildMi1FeatureActor({
        userId: "admin-a",
        organizationId: ORG,
        roles: ["admin"],
        mfaSatisfied: true,
        selectedHat: "admin",
      })}
      client={null}
    />);
    const domain = await screen.findByLabelText("Domain");
    fireEvent.change(domain, { target: { value: "data_access" } });
    expect(domain).toHaveValue("data_access");
  });

  it("appends older audit pages with the timestamp and id cursor", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      domain: "operations",
      eventType: `newer-${index}`,
      actorUserId: null,
      entityType: "job",
      occurredAt: `2026-08-24T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
    }));
    const rpc = vi.fn(async (name, args) => {
      if (name === "get_my_chapter_memberships") return { data: SELECTED_ADMIN_MEMBERSHIP };
      if (name === "list_organization_audit_ledger") {
        return args.p_before
          ? { data: [{
            id: "99999999-9999-4999-8999-999999999999",
            domain: "operations",
            eventType: "older-event",
            actorUserId: null,
            entityType: "job",
            occurredAt: "2026-08-23T00:00:00.000Z",
          }] }
          : { data: firstPage };
      }
      return { data: [] };
    });
    wrap(<OperationsHealthView
      session={buildMi1FeatureActor({
        userId: "admin-a",
        organizationId: ORG,
        roles: ["admin"],
        mfaSatisfied: true,
        selectedHat: "admin",
      })}
      client={{ rpc }}
    />);
    expect(await screen.findByText(/newer-0/i)).toBeInTheDocument();
    // Wait through the bootstrap, normalized-actor, and authoritative-scope
    // loads so the membership refresh cannot replace the appended page.
    await waitFor(() => {
      const initialPageCalls = rpc.mock.calls.filter(([name, args]) => (
        name === "list_organization_audit_ledger" && !args?.p_before
      ));
      expect(initialPageCalls).toHaveLength(3);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older entries" }));
    await waitFor(() => {
      expect(rpc).toHaveBeenCalledWith("list_organization_audit_ledger", expect.objectContaining({
        p_before: firstPage.at(-1).occurredAt,
        p_before_id: firstPage.at(-1).id,
      }));
    });
    expect(await screen.findByText(/older-event/i)).toBeInTheDocument();
    expect(screen.getByText(/newer-0/i)).toBeInTheDocument();
  });

  it("renders the embedded unauthorized state without exposing admin data", async () => {
    const { container } = wrap(<OperationsHealthView
      embedded
      session={buildMi1FeatureActor({ userId: "member-a", organizationId: ORG })}
      client={null}
    />);
    expect(container.firstChild).not.toHaveClass("screen");
    expect(await screen.findAllByText(/unavailable in this environment/i)).toHaveLength(2);
    expect(screen.queryByText(/run-42/i)).not.toBeInTheDocument();
  });

  it("surfaces failed acknowledgement and retry requests", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: SELECTED_ADMIN_MEMBERSHIP };
      if (name === "list_organization_audit_ledger") return { data: [] };
      if (name === "list_organization_job_health") return { data: [FAILING_JOB] };
      return { error: { message: "offline" } };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge Notification dispatch/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/acknowledgement could not be saved/i);
    fireEvent.click(screen.getByRole("button", { name: /Record retry request Notification dispatch/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/retry request could not be saved/i);
  });

  it("refreshes persisted health after successful remediations", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: SELECTED_ADMIN_MEMBERSHIP };
      if (name === "list_organization_audit_ledger") return { data: [] };
      if (name === "list_organization_job_health") return { data: [FAILING_JOB] };
      return { data: [FAILING_JOB] };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge Notification dispatch/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("acknowledge_organization_job_run", {
      p_job_name: FAILING_JOB.jobName,
      p_run_id: FAILING_JOB.lastRunId,
    }));
    fireEvent.click(screen.getByRole("button", { name: /Record retry request Notification dispatch/i }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("request_organization_job_retry", {
      p_job_name: FAILING_JOB.jobName,
      p_run_id: FAILING_JOB.lastRunId,
    }));
    expect(rpc.mock.calls.filter(([name]) => name === "list_organization_job_health").length).toBeGreaterThan(2);
  });

  it("reads a selected audit sink through its own reader instead of the ledger", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: SELECTED_ADMIN_MEMBERSHIP };
      if (name === "list_organization_audit_ledger") return { data: [] };
      if (name === "list_organization_job_health") return { data: [] };
      if (name === "list_member_invitation_audit") {
        return { data: [{
          id: 7,
          organizationId: ORG,
          kind: "invite_sent",
          entityId: "invitation-000007",
          actorUserId: null,
          createdAt: "2026-09-01T08:00:00.000Z",
        }] };
      }
      return { data: [] };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    const ledgerCalls = () => rpc.mock.calls.filter(([name]) => name === "list_organization_audit_ledger");
    // Wait through the bootstrap, normalized-actor and authoritative-scope
    // loads so a later scope refresh cannot be mistaken for a source read.
    await waitFor(() => expect(ledgerCalls()).toHaveLength(3));
    fireEvent.change(await screen.findByLabelText("Source"), {
      target: { value: "member_invitation_audit" },
    });
    expect(await screen.findByText(/invitation · sent/i)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledWith("list_member_invitation_audit", expect.objectContaining({
      p_kind: null,
      p_before: null,
    }));
    // The two readers are different RPCs with different cursors; selecting a
    // sink must not also re-ask the unified ledger for the same page.
    expect(ledgerCalls()).toHaveLength(3);
  });

  it("keeps the loaded page and flags a failed older-entries read", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      domain: "operations",
      eventType: `newer-${index}`,
      actorUserId: null,
      entityType: "job",
      occurredAt: `2026-08-24T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
    }));
    const rpc = vi.fn(async (name, args) => {
      if (name === "get_my_chapter_memberships") return { data: SELECTED_ADMIN_MEMBERSHIP };
      if (name === "list_organization_audit_ledger") {
        return args.p_before ? { error: { message: "offline" } } : { data: firstPage };
      }
      return { data: [] };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    expect(await screen.findByText(/newer-0/i)).toBeInTheDocument();
    await waitFor(() => {
      const initialPageCalls = rpc.mock.calls.filter(([name, args]) => (
        name === "list_organization_audit_ledger" && !args?.p_before
      ));
      expect(initialPageCalls).toHaveLength(3);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older entries" }));
    expect(await screen.findByText(/older audit entries could not be loaded/i)).toBeInTheDocument();
    // A failed continuation must not discard the page already on screen.
    expect(screen.getByText(/newer-0/i)).toBeInTheDocument();
  });

  it("reloads the audit ledger from the panel's retry control", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: SELECTED_ADMIN_MEMBERSHIP };
      if (name === "list_organization_audit_ledger") return { error: { message: "offline" } };
      return { data: [] };
    });
    wrap(<OperationsHealthView session={adminSession()} client={{ rpc }} />);
    expect(await screen.findByText(/the audit log could not be loaded/i)).toBeInTheDocument();
    const before = rpc.mock.calls.filter(([name]) => name === "list_organization_audit_ledger").length;
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    await waitFor(() => {
      const after = rpc.mock.calls.filter(([name]) => name === "list_organization_audit_ledger").length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it("reports a failed acknowledgement in the reader's own language", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_my_chapter_memberships") return { data: SELECTED_ADMIN_MEMBERSHIP };
      if (name === "list_organization_audit_ledger") return { data: [] };
      if (name === "list_organization_job_health") return { data: [FAILING_JOB] };
      return { error: { message: "offline" } };
    });
    render(
      <LanguageProvider lang="es">
        <OperationsHealthView session={adminSession()} client={{ rpc }} />
      </LanguageProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Reconocer /i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo guardar el reconocimiento/i);
  });
});
