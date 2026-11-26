import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { t } from "../src/lib/i18n.js";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const RECEIPT_CODE = "ABC123";

const workload = {
  entries: [],
  stats: { enoughData: false },
  reminders: { available: true, enabled: false, cadence: "weekly", weekday: 1, localHour: 9 },
};

function renderView(onLogWork) {
  return render(
    <LanguageProvider lang="en">
      <WorkloadView data={{ workload }} onLogWork={onLogWork} onSaveReminder={vi.fn()} />
    </LanguageProvider>,
  );
}

function submitTab() {
  return screen.getByRole("button", { name: t("en", "workload.tab.submit") });
}

function leaveNoneChip() {
  return screen.getByRole("button", { name: t("en", "workload.leaveNone") });
}

function noIntakeRow() {
  return screen.getByRole("button", { name: new RegExp(`^${t("en", "workload.noIntake")}`) });
}

function halfDayRow() {
  return screen.getByRole("button", { name: t("en", "workload.halfDay") });
}

function submitCta() {
  return screen.getByRole("button", { name: t("en", "workload.submitCta") });
}

async function toggleStaffingFlagsAndSubmit(onLogWork) {
  fireEvent.click(submitTab());
  expect(leaveNoneChip()).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(noIntakeRow());
  fireEvent.click(halfDayRow());
  expect(noIntakeRow()).toHaveAttribute("aria-pressed", "true");
  expect(halfDayRow()).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(submitCta());
  await waitFor(() => expect(onLogWork).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  clearDeviceParityState();
});

describe("workload Submit tab onLogWork contract", () => {
  it("submits noIntake and halfDay as true while leave stays at none", async () => {
    const onLogWork = vi.fn().mockResolvedValue({});
    renderView(onLogWork);

    await toggleStaffingFlagsAndSubmit(onLogWork);

    expect(onLogWork).toHaveBeenCalledWith(expect.objectContaining({
      noIntake: true,
      halfDay: true,
      leaveType: null,
      leaveTiming: null,
    }));
  });

  it("renders the receipt text when onLogWork resolves with a receiptCode", async () => {
    const onLogWork = vi.fn().mockResolvedValue({
      receiptCode: RECEIPT_CODE,
      remainingToday: 2,
    });
    renderView(onLogWork);

    await toggleStaffingFlagsAndSubmit(onLogWork);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(t("en", "workload.receipt", { code: RECEIPT_CODE }));
    expect(status).toHaveTextContent(t("en", "workload.logAnother", { remaining: 2 }));
    expect(screen.queryByText(t("en", "toast.workLogged"))).toBeNull();
  });

  it("renders the demo notice and never the receipt text when the result has no receiptCode", async () => {
    const onLogWork = vi.fn().mockResolvedValue({});
    renderView(onLogWork);

    await toggleStaffingFlagsAndSubmit(onLogWork);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(t("en", "toast.workLogged"));
    expect(screen.queryByText(RECEIPT_CODE)).toBeNull();
    expect(screen.queryByText(t("en", "workload.receipt", { code: RECEIPT_CODE }))).toBeNull();
  });

  it("clears noIntake and halfDay after a successful submit", async () => {
    const onLogWork = vi.fn().mockResolvedValue({ receiptCode: RECEIPT_CODE, remainingToday: 2 });
    renderView(onLogWork);

    await toggleStaffingFlagsAndSubmit(onLogWork);
    await screen.findByRole("status");

    expect(noIntakeRow()).toHaveAttribute("aria-pressed", "false");
    expect(halfDayRow()).toHaveAttribute("aria-pressed", "false");
  });

  it("shows workload.submitFailed on rejection and leaves noIntake and halfDay checked", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("offline"));
    renderView(onLogWork);

    await toggleStaffingFlagsAndSubmit(onLogWork);

    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "workload.submitFailed"));
    expect(noIntakeRow()).toHaveAttribute("aria-pressed", "true");
    expect(halfDayRow()).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // BUG-UG-WEB-WORKLOAD-DAILY-LIMIT-GENERIC-ERROR-20261003: the fourth
  // log of the day was refused by the server but reported as a generic failure.
  it("names the daily limit when the server refuses a fourth log today", async () => {
    const onLogWork = vi.fn().mockRejectedValue({ code: "22023", message: "daily workload log limit reached (3 per day)", details: "workload_daily_limit" });
    renderView(onLogWork);

    await toggleStaffingFlagsAndSubmit(onLogWork);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("en", "rpcError.workload_daily_limit"));
    expect(alert).not.toHaveTextContent(t("en", "workload.submitFailed"));
    expect(t("en", "rpcError.workload_daily_limit")).toMatch(/added 3 workplace log entries today/);
    expect(t("es", "rpcError.workload_daily_limit")).toMatch(/3 entradas al registro del centro de trabajo hoy/);
  });

  it("keeps the generic message for any other refusal", async () => {
    const onLogWork = vi.fn().mockRejectedValue({ code: "22023", message: "note too long", details: null });
    renderView(onLogWork);

    await toggleStaffingFlagsAndSubmit(onLogWork);

    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "workload.submitFailed"));
  });
});

describe("workload submit keeps focus while the entry is saved (#8435)", () => {
  it("keeps Submit focused while the week is logged, and logs it once", async () => {
    const onLogWork = vi.fn(async () => ({ receiptCode: RECEIPT_CODE }));
    renderView(onLogWork);
    fireEvent.click(submitTab());
    await expectHeldWriteFocus(onLogWork, submitCta());
    await waitFor(() => expect(onLogWork).toHaveBeenCalledTimes(1));
  });
});
