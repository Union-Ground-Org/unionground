import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildQaActor, useQaScopedActor } from "../src/lib/mi1QaWiring.js";
import { OfficerQaView } from "../src/views/OfficerQaView.jsx";

afterEach(cleanup);

const STEWARD = buildQaActor({
  userId: "steward-a",
  organizationId: "11111111-1111-4111-8111-111111111111",
  chapterId: "22222222-2222-4222-8222-222222222222",
  roles: ["steward"],
  organizationRoles: ["steward"],
  mfaSatisfied: true,
  selectedHat: "steward",
});

// A client whose membership RPC has not answered yet. The hook may not treat
// "no answer" as "no membership".
function pendingClient() {
  const settle = [];
  return {
    settle,
    rpc() {
      return new Promise((resolve) => settle.push(resolve));
    },
  };
}

describe("QA session scope bootstrap", () => {
  it("keeps the bootstrap officer grant while the membership RPC is in flight", () => {
    const client = pendingClient();
    const { result } = renderHook(() => useQaScopedActor(client, STEWARD));

    expect(result.current.organizationRoles).toEqual(["steward"]);
    expect(result.current.organizationId).toBe(STEWARD.organizationId);
    expect(result.current.chapterId).toBe(STEWARD.chapterId);
    expect(result.current.membershipStatus).toBe("active");
  });

  it("adopts the membership RPC answer once it resolves", async () => {
    const client = pendingClient();
    const { result } = renderHook(() => useQaScopedActor(client, STEWARD));

    await act(async () => {
      client.settle[0]({
        data: [{
          selected: true,
          organizationId: "33333333-3333-4333-8333-333333333333",
          chapterId: "44444444-4444-4444-8444-444444444444",
          organizationRoles: [],
          chapterRoles: ["steward"],
        }],
        error: null,
      });
    });

    expect(result.current.organizationId).toBe("33333333-3333-4333-8333-333333333333");
    expect(result.current.organizationRoles).toEqual([]);
    expect(result.current.chapterRoles).toEqual(["steward"]);
  });

  it("does not refuse the officer queue before the membership RPC answers", async () => {
    render(
      <LanguageProvider lang="en">
        <OfficerQaView lang="en" actor={STEWARD} client={pendingClient()} />
      </LanguageProvider>,
    );

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Loading questions…"));
    expect(screen.queryByText("You cannot do that in this role.")).not.toBeInTheDocument();
  });
});
