import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdminDesk } from "../src/lib/memberApi.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

describe("Admin initial read batches", () => {
  it.each([false, true])("settles events before starting the desk fan-out, without repeating it (failed=%s)", async (failed) => {
    let finishEvents;
    const events = new Promise((resolve) => { finishEvents = resolve; });
    const rpc = vi.fn((name) => {
      if (name === "get_admin_events") return events;
      if (name === "get_staff_roster") return Promise.resolve({ data: [{ id: "staff-a", roles: ["admin"] }], error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const loading = loadAdminDesk({ rpc });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["get_admin_events"]);
    finishEvents(failed ? { data: null, error: { code: "57014" } } : { data: [{ id: "event-a", title: "Chapter meeting" }], error: null });
    const desk = await loading;
    expect(desk.roster).toEqual([{ id: "staff-a", roles: ["admin"] }]);
    if (failed) expect(desk.events).toBeNull();
    else expect(desk.events).toMatchObject([{ id: "event-a", title: "Chapter meeting" }]);
    const calls = rpc.mock.calls.map(([name]) => name);
    expect(calls).toContain("get_admin_audit");
    expect(new Set(calls).size).toBe(calls.length);
  });

});
