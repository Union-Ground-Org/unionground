import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuditLogPanel, JobHealthPanel } from "../src/features/operations/index.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ORG_A = "11111111-1111-4111-8111-111111111111";

describe("operations panels", () => {
  it("renders empty, error, and ready audit states without protected payloads", () => {
    const { rerender } = render(<AuditLogPanel state="empty" events={[]} />);
    expect(screen.getByRole("heading", { name: "Organization audit log" })).toBeInTheDocument();
    expect(screen.getByText(/No audit events/)).toBeInTheDocument();

    const onRetry = vi.fn();
    rerender(<AuditLogPanel state="error" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<AuditLogPanel
      state="ready"
      events={[{
        id: "evt-1",
        organizationId: ORG_A,
        domain: "casework",
        eventType: "case.status_changed",
        actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        entityType: "case",
        entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        occurredAt: "2026-08-22T12:00:00.000Z",
        metadata: { fromStatus: "open", toStatus: "held" },
      }]}
    />);
    expect(screen.getByText(/casework · case · status changed/)).toBeInTheDocument();
    expect(screen.getByText(/Actor · AAAAAA/)).toBeInTheDocument();
    expect(screen.getByText(/case · CCCCCC/)).toBeInTheDocument();
    expect(screen.queryByText(/open/)).not.toBeInTheDocument();
  });

  // BUG-UG-LEDGER-SAYS-KNOWLEDGE-FILE-UPLOADED-BEFORE-ANY-BYTES-ARRIVE-20261112 (#8545):
  // the prepare row is written before any bytes or scan, so it reads as started.
  it("names a prepared knowledge upload as started, never as uploaded", () => {
    const prepared = {
      id: "evt-prepared",
      organizationId: ORG_A,
      domain: "knowledge",
      eventType: "knowledge_file_uploaded",
      actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entityType: "knowledge_file",
      entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      occurredAt: "2026-11-12T12:00:00.000Z",
      metadata: { reviewStatus: "pending_scan", action: "uploaded" },
    };
    const { unmount } = render(<AuditLogPanel state="ready" events={[prepared]} />);
    expect(screen.getByText(/knowledge · knowledge file upload started/)).toBeInTheDocument();
    expect(screen.queryByText(/knowledge file uploaded/)).not.toBeInTheDocument();
    unmount();

    render(<LanguageProvider lang="es"><AuditLogPanel state="ready" events={[prepared]} /></LanguageProvider>);
    expect(screen.getByText(/carga de archivo de conocimiento iniciada/)).toBeInTheDocument();
  });

  it("filters audit domains from the panel controls", () => {
    const onFilterChange = vi.fn();
    render(<AuditLogPanel state="ready" events={[]} filters={{}} onFilterChange={onFilterChange} />);
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "data_access" } });
    expect(onFilterChange).toHaveBeenCalledWith({ domain: "data_access" });
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "read" } });
    expect(onFilterChange).toHaveBeenCalledWith({ action: "read" });
    fireEvent.submit(screen.getByLabelText("Action").closest("form"));
  });

  it("renders system events without an entity id", () => {
    render(<AuditLogPanel
      state="ready"
      events={[{
        idempotencyKey: "system-event",
        domain: "operations",
        eventType: "job.checked",
        actorUserId: null,
        entityType: "job",
        entityId: null,
        occurredAt: "2026-08-22T12:00:00.000Z",
      }]}
    />);
    expect(screen.getByText(/System · job$/)).toBeInTheDocument();
  });

  // DEBT-UG-RETENTION-SCHEDULED-RUN-ACTOR-MISATTRIBUTED-20260921: a
  // scheduled retention run is the Scheduler's act; the policy's admin is only
  // the standing authorization, and a manual run keeps its authorizing admin.
  it("names the Scheduler as the actor of a scheduled run and its policy admin only as the standing authorization", () => {
    const retentionEvent = (id, mode, actorUserId, metadata = {}) => ({
      id,
      domain: "privacy",
      eventType: "retention.completed",
      actorUserId,
      entityType: "retention_run",
      entityId: `rrrrrrrr-rrrr-4rrr-8rrr-${id.padStart(12, "0")}`,
      occurredAt: "2026-09-25T07:47:00.000Z",
      metadata: { dataClass: "member_message_bodies", deletedCount: 3, mode, ...metadata },
    });
    const { rerender } = render(<AuditLogPanel
      state="ready"
      events={[
        retentionEvent("111111", "scheduled", null, { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
        retentionEvent("222222", "manual", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        retentionEvent("333333", "scheduled", null),
      ]}
    />);
    expect(screen.getByText(/— Scheduler \(standing authorization by actor AAAAAA\) · retention_run · 111111$/)).toBeInTheDocument();
    expect(screen.getByText(/— Actor · BBBBBB · retention_run · 222222$/)).toBeInTheDocument();
    expect(screen.getByText(/— Scheduler · retention_run · 333333$/)).toBeInTheDocument();
    expect(screen.queryByText(/Actor · AAAAAA/)).not.toBeInTheDocument();
    expect(screen.queryByText(/System/)).not.toBeInTheDocument();

    rerender(<LanguageProvider lang="es"><AuditLogPanel
      state="ready"
      events={[retentionEvent("111111", "scheduled", null, { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })]}
    /></LanguageProvider>);
    expect(screen.getByText(/— Planificador \(autorización permanente del responsable AAAAAA\) · retention_run · 111111$/)).toBeInTheDocument();
  });

  it("exposes acknowledge and retry without executing a job in the browser", () => {
    const onAcknowledge = vi.fn();
    const onRequestRetry = vi.fn();
    render(<JobHealthPanel
      state="ready"
      onAcknowledge={onAcknowledge}
      onRequestRetry={onRequestRetry}
      jobs={[{
        jobName: "deadline-notices-tick",
        title: "Case deadline notices",
        health: "failing",
        cadence: "5 13 * * *",
        lastRun: { runId: "deadline-a", completedAt: "2026-08-22T13:05:02.000Z", failureCode: "timeout" },
        remediations: ["acknowledge", "request_retry"],
      }]}
    />);
    expect(screen.getByText(/A retry request records operator intent; it does not execute the job or clear its failure/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge Case deadline notices" }));
    fireEvent.click(screen.getByRole("button", { name: "Record retry request Case deadline notices" }));
    expect(onAcknowledge).toHaveBeenCalledWith({ jobName: "deadline-notices-tick", runId: "deadline-a" });
    expect(onRequestRetry).toHaveBeenCalledWith({ jobName: "deadline-notices-tick", runId: "deadline-a" });
  });

  it("names a recorded remediation on the job's line", () => {
    render(<JobHealthPanel state="ready" onAcknowledge={vi.fn()} onRequestRetry={vi.fn()} jobs={[{
      jobName: "deadline-notices-tick", title: "Case deadline notices", health: "failing", cadence: "5 13 * * *",
      lastRun: { runId: "deadline-a", completedAt: "2026-08-22T13:05:02.000Z", failureCode: "timeout" },
      remediations: ["acknowledge", "request_retry"], acknowledgement: { remediation: "request_retry" },
    }]} />);
    expect(screen.getByText(/Case deadline notices/).textContent).toMatch(/ · .+: /);
  });

  it("explains an unset scheduler without inventing a healthy run", () => {
    render(<JobHealthPanel
      state="ready"
      jobs={[{
        jobName: "task-maintenance-daily",
        title: "Task maintenance",
        health: "never_run",
        cadence: "17 4 * * *",
        lastRun: null,
        remediations: [],
      }]}
    />);
    expect(screen.getByText(/No run recorded yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).not.toBeInTheDocument();
  });

  // UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122 (A-5): the
  // audit read "2026-11-22T22:00:00.124049+00:00" beside a run and the cron
  // string "17 4 * * *" beside a job that never ran.
  it("says when a job ran in the organization's zone, and never prints a schedule's cron text", () => {
    const { container } = render(<JobHealthPanel
      state="ready"
      timeZone="America/Chicago"
      jobs={[
        { jobName: "deadline-notices-tick", title: "Case deadline notices", health: "healthy", cadence: "5 13 * * *",
          lastRun: { runId: "deadline-a", completedAt: "2026-11-22T22:00:00.124049+00:00" }, remediations: [] },
        { jobName: "task-maintenance-daily", title: "Task maintenance", health: "never_run", cadence: "17 4 * * *",
          lastRun: null, remediations: [] },
      ]}
    />);
    const times = [...container.querySelectorAll(".xus-atime")].map((node) => node.textContent);
    expect(times).toEqual(["Nov 22, 2026, 4:00 PM CST"]);
    expect(container.textContent).not.toMatch(/\* \* \*|T22:00|\+00:00|scheduler|environment/);
  });

  it("writes the run time and the never-run line in Spanish", () => {
    const { container } = render(
      <LanguageProvider lang="es">
        <JobHealthPanel state="ready" timeZone="America/Chicago" jobs={[
          { jobName: "a", title: "Avisos", health: "healthy", lastRun: { runId: "r", completedAt: "2026-11-22T22:00:00Z" }, remediations: [] },
          { jobName: "b", title: "Mantenimiento", health: "never_run", cadence: "17 4 * * *", lastRun: null, remediations: [] },
        ]} />
      </LanguageProvider>,
    );
    expect(container.querySelector(".xus-atime").textContent).toBe("22 nov 2026, 4:00 p. m. CST");
    expect(container.textContent).toContain("Aún no hay ninguna ejecución registrada.");
    expect(container.textContent).not.toMatch(/programador|\* \* \*/);
  });
});
