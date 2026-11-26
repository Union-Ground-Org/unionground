import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { LearningPeriodBanner, LearningPeriodProvider, useLearningPeriodController } from "../src/features/learningPeriod/LearningPeriod.jsx";
import { createDemoLearningPeriodApi, demoLearningFixture, withoutOrganizationControls } from "../src/features/learningPeriod/api.js";

afterEach(cleanup);
function Shell({ api, scope }) {
  const controller = useLearningPeriodController({ api, scope });
  return <LanguageProvider lang="en"><LearningPeriodProvider value={controller}>
    <LearningPeriodBanner /><main>Member Home</main>
    <button onClick={controller.refresh}>Refresh</button>
  </LearningPeriodProvider></LanguageProvider>;
}

it("holds Home until the initial banner read settles, then keeps Home mounted during refresh", async () => {
  let resolve;
  const api = { period: vi.fn(() => new Promise((done) => { resolve = done; })) };
  render(<Shell api={api} />);
  expect(screen.queryByText("Member Home")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading Union Ground");
  await act(async () => resolve({ used: true, running: true, endAt: new Date(Date.now() + 86400000).toISOString() }));
  const home = screen.getByText("Member Home");
  expect(screen.getByRole("region", { name: "Learning period" }).compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => screen.getByText("Refresh").click());
  expect(screen.getByText("Member Home")).toBe(home);
  await act(async () => resolve(null));
  expect(screen.getByText("Member Home")).toBe(home);
});

it("releases Home when the optional period read fails", async () => {
  render(<Shell api={{ period: vi.fn().mockRejectedValue(new Error("unavailable")) }} />);
  expect(await screen.findByText("Member Home")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Learning period" })).toBeNull();
});

it("retains the shell while a new client rechecks the same session and organization", async () => {
  const first = { period: vi.fn().mockResolvedValue(null) };
  const view = render(<Shell api={first} scope="session-A:organization-A" />);
  const home = await screen.findByText("Member Home");
  let finish;
  const next = { period: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
  view.rerender(<Shell api={next} scope="session-A:organization-A" />);
  expect(next.period).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Member Home")).toBe(home);
  await act(async () => finish(null));
  expect(screen.getByText("Member Home")).toBe(home);
});

it("starts a new scope cold and ignores the previous scope's late period", async () => {
  let finishA;
  const first = { period: () => new Promise((resolve) => { finishA = resolve; }) };
  const view = render(<Shell api={first} scope="session-A:organization-A" />);
  let finishB;
  const next = { period: () => new Promise((resolve) => { finishB = resolve; }) };
  view.rerender(<Shell api={next} scope="session-B:organization-B" />);
  await act(async () => finishA({ running: true, used: true, endAt: new Date(Date.now() + 86400000).toISOString() }));
  expect(screen.queryByText("Member Home")).toBeNull();
  expect(screen.queryByRole("region", { name: "Learning period" })).toBeNull();
  await act(async () => finishB(null));
  expect(screen.getByText("Member Home")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Learning period" })).toBeNull();
});

it("paints the already-known fixture banner with Home and retains the shell across client recreation", () => {
  const makeApi = () => {
    const fixture = demoLearningFixture(Date.now(), { taskIds: ["tamarack-task"] });
    fixture.period.organizationId = "tamarack";
    const client = createDemoLearningPeriodApi(fixture);
    client.period = vi.fn(() => new Promise(() => {}));
    return withoutOrganizationControls(client);
  };
  const view = render(<Shell api={makeApi()} />);
  const home = screen.getByText("Member Home");
  const refresh = screen.getByRole("button", { name: "Refresh" });
  refresh.focus();
  expect(screen.getByRole("region", { name: "Learning period" })).toHaveTextContent("Learning period ends");
  expect(screen.queryByRole("button", { name: "End early" })).toBeNull();
  view.rerender(<Shell api={makeApi()} />);
  expect(screen.getByText("Member Home")).toBe(home);
  expect(screen.getByRole("button", { name: "Refresh" })).toBe(refresh);
  expect(refresh).toHaveFocus();
});

it("keeps boot snapshots current while preserving the restricted client's closed action surface", async () => {
  const client = createDemoLearningPeriodApi(demoLearningFixture());
  const restricted = withoutOrganizationControls(client);
  expect(Object.keys(restricted).sort()).toEqual(["endEarly", "history", "period", "start", "undo"]);
  expect(restricted.initialPeriod.isAdmin).toBe(false);
  await client.endEarly();
  expect(restricted.initialPeriod.running).toBe(false);
  expect(restricted.initialPeriod.endAt).toBeTruthy();
  const unknown = withoutOrganizationControls({});
  const empty = withoutOrganizationControls({ initialPeriod: null });
  expect(unknown.initialPeriod).toBeUndefined();
  expect(empty.initialPeriod).toBeNull();
});
