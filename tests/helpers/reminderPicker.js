import { fireEvent, within } from "@testing-library/react";
import { localDateTimeInputValue } from "../../src/lib/localDateTime.js";

// A `datetime-local` value two days ahead of the real clock, in the runner's
// zone (vitest pins TZ to UTC). Tests that never fake the clock use this so the
// chosen time is always inside the server's bounds.
export function futureReminderValue(offsetMs = 2 * 24 * 60 * 60 * 1000) {
  return localDateTimeInputValue(Date.now() + offsetMs);
}

// Opens the "Remind me…" chooser inside `scope`, enters `value` and presses
// Set reminder. Returns the ISO instant the confirmed request must carry, so a
// test asserts the exact time the member chose instead of expect.any(String).
export function chooseReminder(scope, value = futureReminderValue(), triggerName = "Remind me…") {
  const view = within(scope);
  fireEvent.click(view.getByRole("button", { name: triggerName }));
  fireEvent.change(view.getByLabelText("Reminder date and time"), { target: { value } });
  fireEvent.click(view.getByRole("button", { name: "Set reminder" }));
  return new Date(value).toISOString();
}
