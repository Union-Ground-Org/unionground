// #8973 review P1-1 (record 8435): with the real steward desk, closing the
// publish confirmation while a broadcast is still publishing leaves the draft
// row reachable, and its Dismiss must still be refused until the publish ends.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StewardView } from "../src/views/StewardView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { expectPendingFocus } from "./helpers/busyWriteFocus.js";

it("refuses a draft's Dismiss after the confirmation closes while its broadcast is still publishing", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const draft = { id: "d1", title: "Contract town hall", body: "Town hall starts at noon." };
  const api = {
    loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.stewardDesk))),
    listDrafts: vi.fn().mockResolvedValue([draft]),
    resolveDraft: vi.fn().mockResolvedValue({}),
    publish: vi.fn(() => held),
  };
  render(<LanguageProvider lang="en"><StewardView data={{ member: { initials: "TM" } }} api={api} onNotice={vi.fn()} onProfile={vi.fn()} /></LanguageProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Use draft: Contract town hall" }));
  fireEvent.submit(screen.getByRole("button", { name: "Publish broadcast" }).closest("form"));
  const dialog = await screen.findByTestId("broadcast-publish-confirm");
  fireEvent.click(within(dialog).getByRole("radio", { name: "Publish in English now and write the Spanish version next" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish in English" }));
  await waitFor(() => expect(api.publish).toHaveBeenCalledTimes(1));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
  fireEvent.transitionEnd(screen.getByRole("dialog").parentElement, { propertyName: "opacity" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const dismiss = screen.getByRole("button", { name: "Dismiss draft: Contract town hall" });
  expect(dismiss.closest("[inert]")).toBeNull();
  try {
    fireEvent.click(dismiss);
    expect(api.resolveDraft).not.toHaveBeenCalled();
    // The composer's own Publish stays focusable as a pending
    // control while the broadcast publishes, and refuses another confirmation.
    const publish = screen.getByRole("button", { name: "Publishing…" });
    await expectPendingFocus(publish);
    fireEvent.click(publish);
    expect(screen.queryByTestId("broadcast-publish-confirm")).toBeNull();
    expect(api.publish).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => { release({}); });
  }
});
