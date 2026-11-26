import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageDigestPanel } from "../src/features/analytics/ui/UsageDigestPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { createResponseQueue } from "./helpers/responseQueue.js";

afterEach(cleanup);

function payload(actors, { wording = false, monthly = false } = {}) {
  const digest = (period) => ({
    id: `${period}-digest`, period, hasData: true,
    buckets: [{ start: "2026-10-01", end: "2026-10-31", suppressed: false, minCohort: 25, actors, checkins: 25 }],
    ai: { status: wording ? "available" : "off" },
  });
  return { enabled: true, minCohort: 25, digests: [digest("weekly"), ...(monthly ? [digest("monthly")] : [])] };
}

function panel(props) {
  return <LanguageProvider lang="en"><UsageDigestPanel {...props} /></LanguageProvider>;
}

async function resolve(responses, label, value) {
  await act(async () => { responses.resolve(label, value); });
}

async function reject(responses, label) {
  await act(async () => { responses.reject(label, new Error("controlled failure")); });
}

describe("usage digest request generations", () => {
  it.each([false, true])("keeps the newer loader's figures after an older response (failure: %s)", async (failOld) => {
    const responses = createResponseQueue();
    const oldLoad = vi.fn(() => responses.request("old"));
    const newLoad = vi.fn(() => responses.request("new"));
    const view = render(panel({ load: oldLoad }));
    view.rerender(panel({ load: newLoad }));
    await resolve(responses, "new", payload(77));
    expect(screen.getByText("77")).toBeInTheDocument();
    if (failOld) await reject(responses, "old");
    else await resolve(responses, "old", payload(31));
    expect(screen.getByText("77")).toBeInTheDocument();
    expect(screen.queryByText("31")).toBeNull();
    expect(screen.queryByText("The usage digest could not be read right now.")).toBeNull();
  });

  it("does not revive an old A response when the loader returns from A to B to A", async () => {
    const responses = createResponseQueue();
    const loadA = vi.fn().mockImplementationOnce(() => responses.request("A-first")).mockImplementationOnce(() => responses.request("A-current"));
    const loadB = vi.fn(() => responses.request("B"));
    const view = render(panel({ load: loadA }));
    view.rerender(panel({ load: loadB }));
    view.rerender(panel({ load: loadA }));
    await resolve(responses, "A-current", payload(77));
    await resolve(responses, "B", payload(51));
    await resolve(responses, "A-first", payload(31));
    expect(screen.getByText("77")).toBeInTheDocument();
    expect(screen.queryByText("31")).toBeNull();
    expect(screen.queryByText("51")).toBeNull();
  });

  it("keeps a current load failure when an older load succeeds later", async () => {
    const responses = createResponseQueue();
    const view = render(panel({ load: () => responses.request("old") }));
    view.rerender(panel({ load: () => responses.request("new") }));
    await reject(responses, "new");
    expect(screen.getByText("The usage digest could not be read right now.")).toBeInTheDocument();
    await resolve(responses, "old", payload(31));
    expect(screen.getByText("The usage digest could not be read right now.")).toBeInTheDocument();
    expect(screen.queryByText("31")).toBeNull();
  });

  it.each([false, true])("drops old wording after a newer loader answers (failure: %s)", async (failOld) => {
    const responses = createResponseQueue();
    const oldLoad = vi.fn(async () => payload(31, { wording: true }));
    const word = vi.fn(() => responses.request("wording"));
    const view = render(panel({ load: oldLoad, onRequestWording: word }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask the Guide to word this digest" }));
    view.rerender(panel({ load: () => responses.request("new"), onRequestWording: word }));
    await resolve(responses, "new", payload(77, { wording: true }));
    if (failOld) await reject(responses, "wording");
    else await resolve(responses, "wording", payload(31));
    expect(screen.getByText("77")).toBeInTheDocument();
    expect(screen.queryByText("31")).toBeNull();
    expect(screen.getByRole("button", { name: "Ask the Guide to word this digest" })).toBeEnabled();
    expect(screen.queryByText("The Guide could not word this digest. Try again.")).toBeNull();
  });

  it.each([false, true])("retires a replaced wording callback without reloading (failure: %s)", async (failOld) => {
    const responses = createResponseQueue();
    const load = vi.fn(async () => payload(31, { wording: true }));
    const first = vi.fn(() => responses.request("first wording"));
    const second = vi.fn(() => responses.request("current wording"));
    const view = render(panel({ load, onRequestWording: first }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask the Guide to word this digest" }));
    view.rerender(panel({ load, onRequestWording: second }));
    const button = screen.getByRole("button", { name: "Ask the Guide to word this digest" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await resolve(responses, "current wording", payload(77, { wording: true }));
    if (failOld) await reject(responses, "first wording");
    else await resolve(responses, "first wording", payload(31));
    expect(screen.getByText("77")).toBeInTheDocument();
    expect(screen.queryByText("The Guide could not word this digest. Try again.")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(["older-first", "newer-first"])("keeps the latest wording and its busy state (%s)", async (order) => {
    const responses = createResponseQueue();
    const load = vi.fn(async () => payload(31, { wording: true, monthly: true }));
    const word = vi.fn(({ period }) => responses.request(period));
    const view = render(panel({ load, onRequestWording: word }));
    await screen.findByText("Weekly");
    const weekly = within(view.container.querySelector('[data-usage-digest-period="weekly"]'));
    const monthly = within(view.container.querySelector('[data-usage-digest-period="monthly"]'));
    fireEvent.click(weekly.getByRole("button"));
    fireEvent.click(monthly.getByRole("button"));
    const older = () => resolve(responses, "weekly", payload(51, { wording: true, monthly: true }));
    const newer = () => resolve(responses, "monthly", payload(77, { wording: true, monthly: true }));
    if (order === "older-first") {
      await older();
      expect(monthly.getByRole("button")).toHaveAttribute("aria-disabled", "true");
      await newer();
    } else {
      await newer();
      await older();
    }
    expect(weekly.getByText("77")).toBeInTheDocument();
    expect(monthly.getByText("77")).toBeInTheDocument();
    expect(monthly.getByRole("button")).toBeEnabled();
    expect(word.mock.calls.map(([input]) => input.period)).toEqual(["weekly", "monthly"]);
  });

  it("shows a current wording failure and allows another attempt", async () => {
    const responses = createResponseQueue();
    const load = vi.fn(async () => payload(31, { wording: true }));
    const word = vi.fn().mockImplementationOnce(() => responses.request("failed")).mockImplementationOnce(() => responses.request("retry"));
    render(panel({ load, onRequestWording: word }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask the Guide to word this digest" }));
    await reject(responses, "failed");
    expect(screen.getByText("The Guide could not word this digest. Try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ask the Guide to word this digest" }));
    await resolve(responses, "retry", payload(77));
    expect(screen.getByText("77")).toBeInTheDocument();
  });
});

// Record 8435, slice 7: the wording lock mirrors the busy digest exactly.
describe("usage digest wording while it runs (record 8435)", () => {
  async function digests(word) {
    const load = vi.fn(async () => payload(31, { wording: true, monthly: true }));
    const view = render(panel({ load, onRequestWording: word }));
    await screen.findByText("Weekly");
    const card = (period) => within(view.container.querySelector(`[data-usage-digest-period="${period}"]`));
    return { view, load, card };
  }

  it("requests one wording when a digest's button is activated twice in one tick", async () => {
    const responses = createResponseQueue();
    const word = vi.fn(({ period }) => responses.request(period));
    const { card } = await digests(word);
    const weekly = card("weekly").getByRole("button");
    await act(async () => { fireEvent.click(weekly); fireEvent.click(weekly); });
    expect(word).toHaveBeenCalledTimes(1);
    expect(weekly).toHaveAttribute("aria-disabled", "true");
    await resolve(responses, "weekly", payload(51, { wording: true, monthly: true }));
  });

  it("lets a digest whose request another digest superseded read ready and send again", async () => {
    const responses = createResponseQueue();
    const word = vi.fn(({ period }) => responses.request(period));
    const { card } = await digests(word);
    fireEvent.click(card("weekly").getByRole("button"));
    fireEvent.click(card("monthly").getByRole("button"));
    const weekly = card("weekly").getByRole("button");
    expect(weekly).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => { fireEvent.click(weekly); });
    expect(word.mock.calls.map(([input]) => input.period)).toEqual(["weekly", "monthly", "weekly"]);
  });

  it("ends a digest's lock with its busy state when the wording callback is replaced", async () => {
    const responses = createResponseQueue();
    const word = vi.fn(({ period }) => responses.request(period));
    const { view, load, card } = await digests(word);
    fireEvent.click(card("weekly").getByRole("button"));
    const next = vi.fn(({ period }) => responses.request(`next ${period}`));
    view.rerender(panel({ load, onRequestWording: next }));
    const weekly = card("weekly").getByRole("button");
    expect(weekly).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => { fireEvent.click(weekly); });
    expect(next).toHaveBeenCalledTimes(1);
    await resolve(responses, "weekly", payload(51, { wording: true, monthly: true }));
    expect(card("weekly").getByRole("button")).toHaveAttribute("aria-disabled", "true");
  });
});
