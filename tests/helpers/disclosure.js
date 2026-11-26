import { act } from "@testing-library/react";

// TEST-UG-DISCLOSURE-TESTS-FIRE-TOGGLE-TWICE-20261111: changing
// details.open makes jsdom fire one toggle event in a later task, as a browser
// does. Dispatching another one ran the panel's onToggle handler twice, so
// every open started a second load. Change the state and wait for that single
// event instead.
export async function setDisclosureOpen(details, open) {
  if (details.open === open) throw new Error(`disclosure is already ${open ? "open" : "closed"}`);
  await act(async () => {
    const toggled = new Promise((resolve) => details.addEventListener("toggle", resolve, { once: true }));
    details.open = open;
    await toggled;
  });
}

// Run every task already queued (timers, jsdom events, settled loads), so a
// test can assert that nothing more happens after an open.
export async function settleQueuedTasks(rounds = 5) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}
