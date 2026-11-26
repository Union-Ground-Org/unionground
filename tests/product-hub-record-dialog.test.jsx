import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";

// Assigning process.env.TZ does not move the local clock inside a
// --pool=threads worker (the CI pool), so the viewer's zone is supplied by a
// Date whose local getters read America/New_York and whose zone-less
// datetime-local strings parse as Eastern wall clock (EDT, -04:00, in August).
const RealDate = Date;
const easternParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
});
const easternPart = (date, type) => Number(easternParts.formatToParts(date).find((entry) => entry.type === type).value);
class EasternDate extends RealDate {
  constructor(...args) {
    if (args.length === 1 && typeof args[0] === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(args[0])) super(`${args[0]}:00-04:00`);
    else super(...args);
  }
  getFullYear() { return easternPart(this, "year"); }
  getMonth() { return easternPart(this, "month") - 1; }
  getDate() { return easternPart(this, "day"); }
  getHours() { return easternPart(this, "hour"); }
  getMinutes() { return easternPart(this, "minute"); }
}

const storedInstant = "2026-08-12T19:30:00.000Z";
const localWall = "2026-08-12T15:30";
const editedLocalWall = "2026-08-12T16:00";
const editedInstant = "2026-08-12T20:00:00.000Z";

const record = {
  id: "record-1",
  record_type: "minutes",
  title: "August chapter minutes",
  body: "Attendance and votes.",
  occurred_at: storedInstant,
};

const data = {
  member: { id: "user-1", initials: "MV", fullName: "Member Voice" },
  roles: ["steward"],
  conversations: [],
  broadcasts: [],
  product: {
    spaces: [],
    documents: [],
    records: [record],
    intake: [],
    handshakes: [],
    governance: [],
    partnerOrgs: [],
  },
};

function openRecordEditor(onUpdateRecord = vi.fn().mockResolvedValue({})) {
  render(<LanguageProvider lang="en"><ProductHubView data={data} onUpdateRecord={onUpdateRecord} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: "The record" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  return onUpdateRecord;
}

describe("legacy hub RecordDialog local datetime", () => {
  beforeEach(() => {
    vi.stubGlobal("Date", EasternDate);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a stored UTC instant as the viewer local wall clock", () => {
    openRecordEditor();
    expect(screen.getByLabelText("Date and time")).toHaveValue(localWall);
  });

  it("submits an unedited local value back as the original UTC instant", async () => {
    const onUpdateRecord = openRecordEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdateRecord).toHaveBeenCalledWith(
      "record-1",
      expect.objectContaining({
        recordType: "minutes",
        title: "August chapter minutes",
        body: "Attendance and votes.",
        occurredAt: storedInstant,
      }),
      false,
    ));
  });

  it("converts an edited local wall clock to a zone-qualified UTC instant", async () => {
    const onUpdateRecord = openRecordEditor();
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: editedLocalWall } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdateRecord).toHaveBeenCalledWith(
      "record-1",
      expect.objectContaining({ occurredAt: editedInstant }),
      false,
    ));
  });

  it("opens the create path with an empty datetime-local value", () => {
    render(<LanguageProvider lang="en"><ProductHubView data={data} onCreateRecord={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "The record" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to record" }));
    expect(screen.getByLabelText("Date and time")).toHaveValue("");
  });
});
