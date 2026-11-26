import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationIntelligenceAdapter } from "../src/features/organizationIntelligence/adapter.js";
import { createWiredOrganizationIntelligenceAdapter } from "../src/lib/organizationIntelligenceWiring.js";
import { easternToday } from "../src/features/orgChart/model.js";
import { OrganizationIntelligenceView } from "../src/views/OrganizationIntelligenceView.jsx";

// REQ-UG-TENANT-ORG-CHART-BASELINE-20261030: administrator-controlled
// seat updates. Synthetic organization, no real chart content.

const actor = {
  userId: "staff-synthetic",
  organizationId: "org-synthetic",
  selectedHat: "admin",
  organizationRoles: ["admin"],
  membershipStatus: "active",
  organizationStatus: "active",
  mfaSatisfied: true,
};

const snapshot = () => ({
  organizationId: "org-synthetic",
  generatedAt: "2026-10-30T16:00:00Z",
  chartNodes: [{
    id: "seat-1", chartKind: "union", nodeKind: "role", label: "Synthetic seat",
    positionX: 50, positionY: 8, sortOrder: 0,
    seatStatus: "confirmed", seatStatusReviewedOn: easternToday(), vacant: false,
  }, {
    id: "seat-2", chartKind: "union", nodeKind: "role", parentId: "seat-1", label: "Synthetic open seat",
    positionX: 50, positionY: 40, sortOrder: 1, seatStatus: "unknown", vacant: true,
  }],
  relationshipNodes: [], relationships: [], topicProgress: [], timeline: [],
});

describe("seat status wiring", () => {
  it("writes the seat state only when the administrator set it, against the saved node", async () => {
    const rpc = vi.fn(async (name, args) => ({ data: name === "save_organization_chart_node" ? { id: "new-node" } : { seatStatus: args.p_seat_status }, error: null }));
    const adapter = createWiredOrganizationIntelligenceAdapter({ rpc });
    await adapter.saveChartNode({ actor, chartKind: "union", nodeKind: "role", label: "Untouched" });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["save_organization_chart_node"]);
    rpc.mockClear();
    const saved = await adapter.saveChartNode({ actor, chartKind: "union", nodeKind: "role", label: "Seat", seatStatus: "unknown", vacant: true, seatTouched: true });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["save_organization_chart_node", "set_organization_chart_seat_status"]);
    expect(rpc).toHaveBeenLastCalledWith("set_organization_chart_seat_status", {
      p_selected_hat: "admin", p_node_id: "new-node", p_seat_status: "unknown", p_vacant: true,
    });
    expect(saved).toMatchObject({ id: "new-node", seatStatus: "unknown" });
  });

  it("reports a partial save with the saved node when the seat status write fails", async () => {
    const rpc = vi.fn(async (name) => name === "save_organization_chart_node"
      ? { data: { id: "new-node" }, error: null }
      : { data: null, error: new Error("status refused") });
    const adapter = createWiredOrganizationIntelligenceAdapter({ rpc });
    const failure = await adapter.saveChartNode({ actor, chartKind: "union", nodeKind: "role", label: "Seat", seatStatus: "confirmed", seatTouched: true }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.chartNodeSaved).toMatchObject({ id: "new-node" });
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it("writes the seat state against the edited node when the content write returns no ID", async () => {
    const rpc = vi.fn(async (name, args) => ({ data: name === "save_organization_chart_node" ? null : { seatStatus: args.p_seat_status }, error: null }));
    const adapter = createWiredOrganizationIntelligenceAdapter({ rpc });
    await adapter.saveChartNode({ actor, id: "seat-1", chartKind: "union", nodeKind: "role", label: "Seat", seatStatus: "stale", seatTouched: true });
    expect(rpc).toHaveBeenLastCalledWith("set_organization_chart_seat_status", {
      p_selected_hat: "admin", p_node_id: "seat-1", p_seat_status: "stale", p_vacant: false,
    });
    rpc.mockImplementation(async (name) => name === "save_organization_chart_node"
      ? { data: null, error: null }
      : { data: null, error: new Error("status refused") });
    const failure = await adapter.saveChartNode({ actor, id: "seat-1", chartKind: "union", nodeKind: "role", label: "Seat", seatStatus: "stale", seatTouched: true }).catch((error) => error);
    expect(failure.chartNodeSaved).toMatchObject({ id: "seat-1" });
  });
});

describe("staff chart editor seat controls", () => {
  const open = async () => {
    const saveChartNode = vi.fn(async () => ({ id: "seat-1" }));
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence: async () => snapshot(), saveChartNode });
    render(<OrganizationIntelligenceView actor={actor} adapter={adapter} />);
    expect((await screen.findAllByText("Synthetic open seat")).length).toBeGreaterThan(0);
    return saveChartNode;
  };

  it("labels the seats in the editor outline", async () => {
    await open();
    const row = screen.getAllByText("Synthetic open seat").map((item) => item.closest(".oi-tree__node")).find(Boolean);
    expect(within(row).getByText("Vacant seat")).toBeInTheDocument();
    expect(within(row).getByText("Unknown")).toBeInTheDocument();
  });

  it("shows a content edit dropping the confirmation, and saves an explicit reconfirmation", async () => {
    const saveChartNode = await open();
    const row = screen.getAllByText("Synthetic seat").map((item) => item.closest(".oi-tree__node")).find(Boolean);
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("heading", { name: "Edit" }).closest("form");
    const status = within(form).getByLabelText("Seat status");
    expect(status).toHaveValue("confirmed");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Synthetic renamed seat" } });
    expect(status).toHaveValue("unconfirmed");
    fireEvent.submit(form);
    await waitFor(() => expect(saveChartNode).toHaveBeenCalledTimes(1));
    expect(saveChartNode.mock.calls[0][0]).toMatchObject({ id: "seat-1", label: "Synthetic renamed seat", seatTouched: false });

    const again = screen.getAllByText("Synthetic seat").map((item) => item.closest(".oi-tree__node")).find(Boolean);
    fireEvent.click(within(again).getByRole("button", { name: "Edit" }));
    const second = screen.getByRole("heading", { name: "Edit" }).closest("form");
    fireEvent.change(within(second).getByLabelText("Seat status"), { target: { value: "confirmed" } });
    fireEvent.click(within(second).getByLabelText("Vacant seat"));
    fireEvent.submit(second);
    await waitFor(() => expect(saveChartNode).toHaveBeenCalledTimes(2));
    expect(saveChartNode.mock.calls[1][0]).toMatchObject({ id: "seat-1", seatStatus: "confirmed", vacant: true, seatTouched: true });
  });

  it("never keeps an old confirmation through the vacancy box or a later content edit", async () => {
    const saveChartNode = await open();
    const row = screen.getAllByText("Synthetic seat").map((item) => item.closest(".oi-tree__node")).find(Boolean);
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("heading", { name: "Edit" }).closest("form");
    const status = within(form).getByLabelText("Seat status");
    expect(status).toHaveValue("confirmed");
    // Marking the seat vacant changes what was confirmed; the status drops.
    fireEvent.click(within(form).getByLabelText("Vacant seat"));
    expect(status).toHaveValue("unconfirmed");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Synthetic renamed seat" } });
    expect(status).toHaveValue("unconfirmed");
    fireEvent.submit(form);
    await waitFor(() => expect(saveChartNode).toHaveBeenCalledTimes(1));
    expect(saveChartNode.mock.calls[0][0]).toMatchObject({
      id: "seat-1", label: "Synthetic renamed seat", vacant: true, seatStatus: "unconfirmed", seatTouched: true, statusChosen: false,
    });
  });

  it("shows the ordinary save error and keeps the form when nothing was saved", async () => {
    const fetchIntelligence = vi.fn(async () => snapshot());
    const saveChartNode = vi.fn().mockRejectedValueOnce(new Error("content refused"));
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence, saveChartNode });
    render(<OrganizationIntelligenceView actor={actor} adapter={adapter} />);
    expect((await screen.findAllByText("Synthetic open seat")).length).toBeGreaterThan(0);
    const reads = fetchIntelligence.mock.calls.length;
    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Synthetic refused seat" } });
    fireEvent.submit(form);
    expect(await screen.findByText("The change could not be saved.")).toBeInTheDocument();
    expect(fetchIntelligence).toHaveBeenCalledTimes(reads);
    expect(screen.getByRole("heading", { name: "Add chart node" })).toBeInTheDocument();
    expect(within(form).getByLabelText("Label")).toHaveValue("Synthetic refused seat");
  });

  it("keeps the saved ID after a partial save so a retry completes the same node", async () => {
    const partial = Object.assign(new Error("chart content saved; seat status not saved"), { chartNodeSaved: { id: "node-9" } });
    const saveChartNode = vi.fn().mockRejectedValueOnce(partial).mockResolvedValueOnce({ id: "node-9", seatStatus: "confirmed" });
    const adapter = createOrganizationIntelligenceAdapter({ fetchIntelligence: async () => snapshot(), saveChartNode });
    render(<OrganizationIntelligenceView actor={actor} adapter={adapter} />);
    expect((await screen.findAllByText("Synthetic open seat")).length).toBeGreaterThan(0);
    const form = screen.getByRole("heading", { name: "Add chart node" }).closest("form");
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Synthetic new seat" } });
    fireEvent.change(within(form).getByLabelText("Seat status"), { target: { value: "confirmed" } });
    fireEvent.submit(form);
    expect(await screen.findByText(/seat status was not/i)).toBeInTheDocument();
    expect(saveChartNode.mock.calls[0][0]).toMatchObject({ id: "", seatTouched: true });

    const retry = screen.getByRole("heading", { name: "Edit" }).closest("form");
    fireEvent.submit(retry);
    await waitFor(() => expect(saveChartNode).toHaveBeenCalledTimes(2));
    expect(saveChartNode.mock.calls[1][0]).toMatchObject({ id: "node-9", label: "Synthetic new seat", seatStatus: "confirmed", seatTouched: true });
  });
});
