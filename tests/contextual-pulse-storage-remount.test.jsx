import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextualPulseSlot } from "../src/features/engagement/ContextualPulseSlot.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("does not ask again on another reading screen after showing a prompt with session storage blocked", async () => {
  vi.useFakeTimers();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
  const evaluate = vi.spyOn(engagementApi, "evaluatePulseInContext").mockResolvedValue({
    eligible: true, eventId: "proof-event", question: "Clear?", options: ["Yes", "No"],
  });
  const pulse = { client: {}, configuration: { switches: { "features.engagement_voice.contextual_pulses": true } } };
  const mount = contextKey => render(<LanguageProvider lang="en"><ContextualPulseSlot pulse={pulse} contextKey={contextKey} /></LanguageProvider>);

  const first = mount("contract.page");
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(evaluate).toHaveBeenCalledTimes(1);
  first.unmount();
  mount("rights.page");
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(evaluate).toHaveBeenCalledTimes(1);
});
