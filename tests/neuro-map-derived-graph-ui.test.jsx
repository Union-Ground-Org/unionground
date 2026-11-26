import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DerivedGraphPanel, normalizeDerivedGraph } from "../src/features/organizationIntelligence/DerivedGraphPanel.jsx";
import { catalogue, t } from "../src/lib/i18n.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const names = new Map([[A, "Sam Steward"], [B, "Ana Member"], [C, "Ben Member"]]);
const tr = (key, vars) => t("en", `orgIntel.${key}`, vars);
const PAYLOAD = {
  derivedEnabled: true,
  autoProgressEnabled: true,
  edges: [
    { id: "derived:represents:a:b", kind: "represents", sourceId: A, targetId: B, strength: 2 },
    { id: "derived:shares_issue:b:c", kind: "shares_issue", sourceId: B, targetId: C, strength: 1 },
    { id: "bad", kind: "reports_to", sourceId: A, targetId: C, strength: 9 },
  ],
  topicReadiness: [{ topicKey: "rights-abc", topicLabel: "Weingarten rights", members: 6, introduced: 2, developing: 2, ready: 2 }],
};

describe("Neuro Map derived graph", () => {
  it("keeps only derived kinds and readiness counts", () => {
    const result = normalizeDerivedGraph(PAYLOAD);
    expect(result.edges.map((edge) => edge.kind)).toEqual(["represents", "shares_issue"]);
    expect(result.topics).toEqual([{ topicKey: "rights-abc", topicLabel: "Weingarten rights", members: 6, introduced: 2, developing: 2, ready: 2 }]);
    expect(normalizeDerivedGraph(null)).toMatchObject({ derivedEnabled: false, edges: [] });
  });

  it("lists derived connections and readiness, and copies a connection into the manual form", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: PAYLOAD, error: null }) };
    const onKeep = vi.fn();
    render(<DerivedGraphPanel client={client} hat="admin" names={names} tr={tr} canKeep onKeep={onKeep} />);
    expect(await screen.findByText("Derived from issue work")).toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("get_organization_derived_graph", { p_selected_hat: "admin" });
    expect(screen.getByText("Represents · 2/5")).toBeInTheDocument();
    expect(screen.getByText("Shares an issue with · 1/5")).toBeInTheDocument();
    expect(screen.getByText("6 workers · 2 introduced · 2 developing · 2 ready")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Keep as relationship" })[0]);
    expect(onKeep).toHaveBeenCalledWith(expect.objectContaining({ source: A, target: B, kind: "represents", strength: 2 }));
  });

  it("is silent when both switches are off and offers retry on failure", async () => {
    const off = { rpc: vi.fn().mockResolvedValue({ data: { derivedEnabled: false, autoProgressEnabled: false, edges: [], topicReadiness: [] }, error: null }) };
    const first = render(<DerivedGraphPanel client={off} hat="admin" names={names} tr={tr} />);
    await waitFor(() => expect(off.rpc).toHaveBeenCalled());
    await Promise.resolve();
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const failing = { rpc: vi.fn().mockResolvedValueOnce({ data: null, error: { code: "42501" } }).mockResolvedValueOnce({ data: PAYLOAD, error: null }) };
    render(<DerivedGraphPanel client={failing} hat="admin" names={names} tr={tr} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Derived connections could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Derived from issue work")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep as relationship" })).not.toBeInTheDocument();
  });

  it("has Spanish copy and switch labels", () => {
    for (const key of ["derivedTitle", "derivedHelp", "derivedKeep", "derivedKind.represents", "derivedKind.shares_issue", "readinessTitle", "readinessCounts"]) {
      expect(catalogue.es[`orgIntel.${key}`], key).toBeTruthy();
    }
    for (const key of ["features.intelligence.neuro_map_derived_graph", "features.intelligence.neuro_map_auto_progress", "limits.intelligence.neuro_map_topic_min_members"]) {
      expect(catalogue.en[`settings.def.${key}.label`]).toBeTruthy();
      expect(catalogue.es[`settings.def.${key}.description`]).toBeTruthy();
    }
  });
});
