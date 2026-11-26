// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ events: [], failure: null, operationError: null }));

vi.mock("pg", () => ({
  default: {
    Client: class {
      async connect() { state.events.push("connect"); }
      async query(statement) {
        state.events.push(statement);
        if (state.failure === "setup" && statement === "begin read only") throw new Error("injected setup failure");
        if (state.failure === "rollback" && statement === "rollback") throw new Error("injected rollback failure");
        if (state.failure === "rpc+cleanup" && statement.startsWith("select * from public.list_steward_requests")) {
          throw state.operationError;
        }
        if (state.failure === "rpc+cleanup" && statement === "rollback") throw new Error("injected rollback failure");
        return { rowCount: 1, rows: [] };
      }
      async end() { state.events.push("end"); }
    },
  },
}));

import { parallelStewardDeskWave } from "../scripts/dev/steward-desk-scale-profile.mjs";

describe("steward desk parallel-wave cleanup", () => {
  beforeEach(() => {
    state.events = [];
    state.failure = null;
    state.operationError = null;
  });

  it("closes a peer whose setup fails after connect", async () => {
    state.failure = "setup";
    await expect(parallelStewardDeskWave("unused", { stewardId: "unused", sessionId: "unused" }, 1))
      .rejects.toThrow("injected setup failure");
    expect(state.events).toEqual(["connect", "begin read only", "rollback", "end"]);
  });

  it("ends every peer when rollback fails and retains the cleanup failure", async () => {
    state.failure = "rollback";
    await expect(parallelStewardDeskWave("unused", { stewardId: "unused", sessionId: "unused" }, 1))
      .rejects.toThrow("steward desk wave cleanup failed");
    expect(state.events.filter((event) => event === "connect")).toHaveLength(5);
    expect(state.events.filter((event) => event === "end")).toHaveLength(5);
  });

  it("keeps the original RPC error while retaining cleanup failures", async () => {
    state.failure = "rpc+cleanup";
    state.operationError = new Error("injected RPC failure");
    const error = await parallelStewardDeskWave("unused", { stewardId: "unused", sessionId: "unused" }, 1)
      .catch((caught) => caught);
    expect(error).toBe(state.operationError);
    expect(error.cleanupFailures).toHaveLength(5);
    expect(state.events.filter((event) => event === "end")).toHaveLength(5);
  });
});
