// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";

const chapterStaff = buildCoordinationActor({
  userId: "user-1",
  organizationId: "org-1",
  membershipStatus: "active",
  selectedHat: "coordinator",
  organizationRoles: ["coordinator"],
  mfaSatisfied: true,
  sessionScope: "resolved",
  chapterId: "wor",
});

const snapshot = {
  state: "ready",
  organizationId: "org-1",
  staff: true,
  records: [],
  leaderboards: [],
  messages: [],
  resources: [],
  exportRuns: [],
  outreach: [],
  directory: [],
  micrositeEditor: { state: "missing" },
};

function renderDesk(onCreate) {
  return render(
    <OrganizationCoordinationDesk
      actor={chapterStaff}
      model={snapshot}
      status="ready"
      onCreate={onCreate}
    />,
  );
}

function creator() {
  return within(screen.getByLabelText("Create coordination work"));
}

async function submitCoverageOverride(onCreate, starts, ends) {
  fireEvent.click(screen.getByRole("tab", { name: "Campaign" }));
  fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "coverage_override" } });
  fireEvent.change(creator().getByLabelText("Committee member ID"), { target: { value: "member-1" } });
  fireEvent.change(creator().getByLabelText("Starts"), { target: { value: starts } });
  fireEvent.change(creator().getByLabelText("Ends"), { target: { value: ends } });
  fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Coverage exception" } });
  fireEvent.click(creator().getByRole("button", { name: "Create" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalled());
}

async function submitExportFirstRun(onCreate, firstRun) {
  fireEvent.click(screen.getByRole("tab", { name: "Operations" }));
  fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "network_export_schedule" } });
  fireEvent.change(creator().getByLabelText("First run"), { target: { value: firstRun } });
  fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Monthly export" } });
  fireEvent.click(creator().getByRole("button", { name: "Create" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalled());
}

function withTimeZone(timeZone, run) {
  const prior = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

const ENTRY_ZONE_LABEL = "Timezone these times are entered in";

describe("coordination coverage and export times use the form's named zone", () => {
  it.each(["America/Los_Angeles", "America/New_York"])(
    "submits a coverage override as America/New_York instants when the process zone is %s",
    async (timeZone) => {
      await withTimeZone(timeZone, async () => {
        const onCreate = vi.fn(async () => true);
        renderDesk(onCreate);
        await submitCoverageOverride(onCreate, "2026-08-29T09:00", "2026-08-29T17:00");
        expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
          kind: "coverage_override",
          config: expect.objectContaining({
            startsAt: "2026-08-29T13:00:00.000Z",
            endsAt: "2026-08-29T21:00:00.000Z",
          }),
        }), expect.any(Function));
      });
    },
  );

  it("submits an export first run in the named zone from a Pacific process zone, both DST branches", async () => {
    await withTimeZone("America/Los_Angeles", async () => {
      const onCreate = vi.fn(async () => true);
      renderDesk(onCreate);
      await submitExportFirstRun(onCreate, "2026-08-29T09:00");
      expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: "network_export_schedule",
        config: expect.objectContaining({ nextRunAt: "2026-08-29T13:00:00.000Z" }),
      }), expect.any(Function));
      fireEvent.change(creator().getByLabelText("First run"), { target: { value: "2026-01-15T09:00" } });
      fireEvent.change(creator().getByLabelText("Title"), { target: { value: "January export" } });
      fireEvent.click(creator().getByRole("button", { name: "Create" }));
      await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
      expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        config: expect.objectContaining({ nextRunAt: "2026-01-15T14:00:00.000Z" }),
      }), expect.any(Function));
    });
  });

  it("uses the zone the steward names for an override, the same field the schedule uses", async () => {
    await withTimeZone("America/New_York", async () => {
      const onCreate = vi.fn(async () => true);
      renderDesk(onCreate);
      fireEvent.click(screen.getByRole("tab", { name: "Campaign" }));
      fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "coverage_override" } });
      expect(creator().getByLabelText(ENTRY_ZONE_LABEL)).toHaveValue("America/New_York");
      expect(screen.getByText(/wall-clock time in America\/New_York/)).toBeVisible();
      fireEvent.change(creator().getByLabelText(ENTRY_ZONE_LABEL), { target: { value: "America/Chicago" } });
      await submitCoverageOverride(onCreate, "2026-08-29T09:00", "2026-08-29T17:00");
      expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
        config: expect.objectContaining({
          startsAt: "2026-08-29T14:00:00.000Z",
          endsAt: "2026-08-29T22:00:00.000Z",
        }),
      }), expect.any(Function));
    });
  });

  it("refuses an override with an unknown zone instead of sending browser-local instants", async () => {
    const onCreate = vi.fn(async () => true);
    renderDesk(onCreate);
    fireEvent.click(screen.getByRole("tab", { name: "Campaign" }));
    fireEvent.change(creator().getByLabelText("Workflow"), { target: { value: "coverage_override" } });
    fireEvent.change(creator().getByLabelText(ENTRY_ZONE_LABEL), { target: { value: "Not/A_Zone" } });
    fireEvent.change(creator().getByLabelText("Committee member ID"), { target: { value: "member-1" } });
    fireEvent.change(creator().getByLabelText("Starts"), { target: { value: "2026-08-29T09:00" } });
    fireEvent.change(creator().getByLabelText("Ends"), { target: { value: "2026-08-29T17:00" } });
    fireEvent.change(creator().getByLabelText("Title"), { target: { value: "Coverage exception" } });
    fireEvent.click(creator().getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid IANA timezone");
    expect(onCreate).not.toHaveBeenCalled();
  });
});
