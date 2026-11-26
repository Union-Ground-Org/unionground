// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { PostgrestClient } from "@supabase/postgrest-js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrganizationCoordinationView } from "../src/views/OrganizationCoordinationView.jsx";

const actor = {
  userId: "user-c17",
  organizationId: "org-c17",
  chapterId: "chapter-c17",
  membershipStatus: "active",
  selectedHat: "steward",
  organizationRoles: ["steward"],
  chapterRoles: [],
  mfaSatisfied: true,
};
const snapshot = {
  state: "ready",
  organizationId: actor.organizationId,
  records: [{ id: "mission-c17", kind: "mission", title: "503 recovery mission", status: "active", visibility: "members" }],
};

// Exercise the real PostgREST response parser, adapter, controller and desk.
// Only the HTTP boundary is replaced; no live backend or session is needed.
function backend(failingRpc, { hang = false } = {}) {
  let failing = true;
  const pending = [];
  const fetch = vi.fn(async (input, init) => {
    const name = new URL(input).pathname.split("/").at(-1);
    const data = name === "get_my_chapter_memberships"
      ? [{ ...actor, selected: true }]
      : name === "get_organization_coordination_snapshot" ? snapshot
        : name === "list_organization_coordination_messages" ? { messages: [] }
          : name === "get_member_organization_configuration" ? { switches: {} } : [];
    const healthy = (payload = data) => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    if (failing && name === failingRpc) {
      if (hang) return new Promise((resolve) => pending.push(() => resolve(healthy({
        ...snapshot,
        records: [{ ...snapshot.records[0], title: "Stale delayed mission" }],
      }))));
      return new Response(JSON.stringify({ message: "Service Unavailable" }), {
        status: 503, headers: { "Content-Type": "application/json" },
      });
    }
    expect(init.method).toBe("POST");
    return healthy();
  });
  const client = new PostgrestClient("https://coordination-recovery.invalid/rest/v1", { fetch });
  return {
    client,
    calls: () => fetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith(`/${failingRpc}`)).length,
    recover: () => { failing = false; },
    settleOld: () => pending.forEach((resolve) => resolve()),
  };
}

describe("Coordination HTTP failure recovery", () => {
  it.each(["get_organization_coordination_snapshot", "list_organization_coordination_messages"])(
    "announces a required %s 503 and retries successfully only on request",
    async (name) => {
      const service = backend(name);
      render(<OrganizationCoordinationView actor={actor} client={service.client} />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Coordination is unavailable");
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
      expect(screen.queryByText("Loading organization coordination")).not.toBeInTheDocument();
      expect(screen.queryByText("Service Unavailable")).not.toBeInTheDocument();
      // Scope resolution can replace the initial load once; a failed read must
      // not start a transport retry loop or call the writing directory RPC.
      await waitFor(() => expect(service.calls()).toBe(2));
      await act(async () => {});
      expect(service.calls()).toBe(2);
      service.recover();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("503 recovery mission")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(service.calls()).toBe(3);
    },
  );

  it("keeps the desk available when an optional staff projection answers 503", async () => {
    const service = backend("list_organization_network_access_events");
    render(<OrganizationCoordinationView actor={actor} client={service.client} />);
    expect(await screen.findByText("503 recovery mission")).toBeVisible();
    expect(screen.queryByText("Coordination is unavailable")).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Load the staff additions again" });
    service.recover();
    fireEvent.click(retry);
    await waitFor(() => expect(retry).not.toBeInTheDocument());
    expect(screen.getByText("503 recovery mission")).toBeVisible();
  });

  it("bounds a stalled required read and ignores its late answer after recovery", async () => {
    const service = backend("get_organization_coordination_snapshot", { hang: true });
    render(<OrganizationCoordinationView actor={actor} client={service.client} loadDeadlineMs={40} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Coordination is unavailable");
    expect(screen.queryByText("Loading organization coordination")).not.toBeInTheDocument();
    service.recover();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("503 recovery mission")).toBeVisible();
    await act(async () => { service.settleOld(); });
    expect(screen.getByText("503 recovery mission")).toBeVisible();
    expect(screen.queryByText("Stale delayed mission")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
