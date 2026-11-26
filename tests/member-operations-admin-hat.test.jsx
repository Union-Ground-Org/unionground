import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemberOperations } from "../src/features/memberOperations/MemberOperations.jsx";
import { buildMi1FeatureActor } from "../src/lib/mi1FeatureWiring.js";

const admin = buildMi1FeatureActor({
  userId: "admin-user",
  organizationId: "organization-one",
  membershipStatus: "active",
  selectedHat: "admin",
  organizationRoles: ["admin"],
  mfaSatisfied: true,
});
const workspace = { state: "ready", organizationId: "organization-one", directory: { items: [] } };
const denied = "Worker operations access could not be verified for this organization. Try again or contact an organization administrator.";

function open(actor = admin, result = { data: workspace }) {
  const client = { rpc: vi.fn().mockResolvedValue(result) };
  render(<MemberOperations actor={actor} client={client} />);
  return client;
}

describe("member operations under the explicit Admin hat", () => {
  it("loads the directory for the authorized App actor without sending URL or tenant authority", async () => {
    window.history.replaceState({}, "", "/m/admin/member-operations/directory?hat=vp&organization=other");
    const client = open();
    expect(await screen.findByRole("heading", { name: "Worker directory" })).toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("get_member_operations_workspace", undefined);
  });

  it("explains incomplete MFA without asking an Admin to select the same hat", async () => {
    const client = open({ ...admin, mfaSatisfied: false });
    expect(await screen.findByText("Complete two-step sign-in to open protected worker records.")).toBeInTheDocument();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["missing organization grant", { organizationRoles: [] }],
    ["chapter-only Admin", { organizationRoles: [], chapterRoles: ["admin"], roles: ["admin"] }],
    ["inactive membership", { membershipStatus: "inactive" }],
    ["missing organization", { selectedOrganizationId: null, organizationId: null }],
    ["missing user", { userId: null }],
  ])("fails closed with an access explanation for %s", async (_label, overrides) => {
    const client = open({ ...admin, ...overrides });
    expect(await screen.findByText(denied)).toBeInTheDocument();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Worker directory" })).not.toBeInTheDocument();
  });

  it.each(["member", "steward", "vp"])("does not grant Admin access to the %s hat", async (selectedHat) => {
    const client = open({ ...admin, selectedHat });
    expect(await screen.findByText("Select the authorized Admin role to use worker operations.")).toBeInTheDocument();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("keeps server refusal authoritative and allows a fresh authorized retry", async () => {
    const client = open(admin, { error: { code: "42501", message: "admin role required" } });
    expect(await screen.findByText(denied)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Worker directory" })).not.toBeInTheDocument();
    client.rpc.mockResolvedValue({ data: workspace });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Worker directory" })).toBeInTheDocument();
  });

  it("rejects a response for a different organization", async () => {
    open(admin, { data: { ...workspace, organizationId: "organization-two" } });
    expect(await screen.findByText(denied)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Worker directory" })).not.toBeInTheDocument();
  });
});
