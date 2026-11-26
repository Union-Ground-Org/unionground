import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdminDesk } from "../src/lib/memberApi.js";

const governance = {
  enabled: false,
  gateway: "union-ground-mesh",
  model: "union-ground/compass-mesh:v1",
  requiredZeroDataRetention: true,
  requiredDisallowPromptTraining: true,
  attestationReady: false,
  latestAttestation: null,
  roleLimits: ["member", "steward", "coordinator", "advisor", "admin", "vp"].map((role) => ({ role, hourlyLimit: 20 })),
  attestations: [],
};
const operator = { data: { canManage: true }, error: null };
const ok = { data: governance, error: null };
const delayed = (value, ms, reject = false) => new Promise((resolve, fail) => setTimeout(() => (reject ? fail : resolve)(value), ms));

function clientFor(probe, read, roster = () => Promise.resolve({ data: [{ id: "staff" }], error: null })) {
  return {
    rpc: vi.fn((name) => {
      if (name === "get_compass_platform_ai") return probe();
      if (name === "get_compass_ai_governance") return read();
      if (name === "get_staff_roster") return roster();
      if (name === "get_admin_events") return Promise.resolve({ data: [{ id: "event" }], error: null });
      return Promise.resolve({ data: null, error: null });
    }),
  };
}

afterEach(() => vi.useRealTimers());

describe("admin desk optional Compass deadline", () => {
  it.each(["probe", "governance", "combined"])("loads other panels within four seconds when %s is slow", async (stage) => {
    vi.useFakeTimers();
    const client = clientFor(
      () => delayed(operator, stage === "probe" ? 8_000 : stage === "combined" ? 2_500 : 0),
      () => delayed(ok, stage === "governance" ? 8_000 : 2_500),
    );
    let desk;
    const loading = loadAdminDesk(client).then((result) => { desk = result; });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(desk).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(desk).toMatchObject({ roster: [{ id: "staff" }], events: [{ id: "event" }], compassAiGovernance: null });
    await loading;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(desk.compassAiGovernance).toBeNull();
  });

  it("keeps a governance read that finishes inside the combined deadline", async () => {
    vi.useFakeTimers();
    const loading = loadAdminDesk(clientFor(() => delayed(operator, 2_000), () => delayed(ok, 1_500)));
    await vi.advanceTimersByTimeAsync(3_500);
    expect((await loading).compassAiGovernance).toMatchObject({ gateway: governance.gateway });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a governance invocation that throws after the optional deadline", async () => {
    vi.useFakeTimers();
    const client = clientFor(
      () => delayed(operator, 5_000),
      () => { throw Object.assign(new Error("expired"), { status: 401 }); },
      () => delayed({ data: [{ id: "slow-staff" }], error: null }, 6_000),
    );
    const loading = loadAdminDesk(client).then((desk) => ({ desk }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await loading).error).toMatchObject({ name: "MemberApiError", label: "Admin desk" });
  });

  it.each([
    { data: null, error: { code: "PGRST301", message: "expired" } },
    { data: null, error: { code: "42501", message: "refused" }, status: 401 },
    { data: null, error: { status: 401, message: "expired" } },
    { data: null, error: null, status: 401 },
  ])("preserves session failure from either Compass call: %j", async (failure) => {
    for (const stage of ["probe", "governance"]) {
      const client = clientFor(
        () => Promise.resolve(stage === "probe" ? failure : operator),
        () => Promise.resolve(failure),
      );
      await expect(loadAdminDesk(client)).rejects.toMatchObject({ name: "MemberApiError" });
      if (stage === "probe") expect(client.rpc).not.toHaveBeenCalledWith("get_compass_ai_governance");
    }
  });

  for (const stage of ["probe", "governance"]) {
    it.each(["sibling-first", "compass-first"])(`observes same-turn ${stage} refusal (%s)`, async (order) => {
      vi.useFakeTimers();
      let resolveCompass;
      let resolveRoster;
      const compass = new Promise((resolve) => { resolveCompass = resolve; });
      const roster = new Promise((resolve) => { resolveRoster = resolve; });
      const client = clientFor(stage === "probe" ? () => compass : () => Promise.resolve(operator), () => compass, () => roster);
      const loading = loadAdminDesk(client).then((desk) => ({ desk }), (error) => ({ error }));
      await vi.advanceTimersByTimeAsync(4_000);
      const releaseCompass = () => resolveCompass({ data: null, error: { code: "PGRST301", message: "expired" }, status: 401 });
      const releaseRoster = () => resolveRoster({ data: [{ id: "staff" }], error: null });
      if (order === "sibling-first") { releaseRoster(); releaseCompass(); }
      else { releaseCompass(); releaseRoster(); }
      expect((await loading).error).toMatchObject({ name: "MemberApiError", label: "Admin desk" });
    });

    const failures = [
      { label: "JWT envelope", value: { data: null, error: { code: "PGRST301", message: "expired" } } },
      { label: "HTTP envelope", value: { data: null, error: null, status: 401 } },
      { label: "rejected JWT", value: { code: "PGRST301", message: "expired" }, reject: true },
      { label: "rejected HTTP", value: { status: 401, message: "expired" }, reject: true },
    ];

    it.each(failures)(`observes a late ${stage} $label while another panel is loading`, async ({ value, reject }) => {
      vi.useFakeTimers();
      const refusal = () => delayed(value, 5_000, reject);
      const client = clientFor(
        stage === "probe" ? refusal : () => Promise.resolve(operator),
        refusal,
        () => delayed({ data: [{ id: "slow-staff" }], error: null }, 6_000),
      );
      let outcome;
      const loading = loadAdminDesk(client).then(
        (desk) => { outcome = { desk }; },
        (error) => { outcome = { error }; },
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      await loading;
      expect(outcome.error).toMatchObject({ name: "MemberApiError", label: "Admin desk" });
      expect(outcome.desk).toBeUndefined();
      if (stage === "probe") expect(client.rpc).not.toHaveBeenCalledWith("get_compass_ai_governance");
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`does not wait for an indefinitely pending ${stage} after slower desk data arrives`, async () => {
      vi.useFakeTimers();
      const pending = () => new Promise(() => {});
      const client = clientFor(
        stage === "probe" ? pending : () => Promise.resolve(operator),
        pending,
        () => delayed({ data: [{ id: "slow-staff" }], error: null }, 6_000),
      );
      let desk;
      const loading = loadAdminDesk(client).then((value) => { desk = value; });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(desk).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      await loading;
      expect(desk).toMatchObject({ roster: [{ id: "slow-staff" }], compassAiGovernance: null });
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`keeps a late non-session ${stage} failure local to Compass`, async () => {
      vi.useFakeTimers();
      const failure = () => delayed({ data: null, error: { code: "42501", message: "not permitted" } }, 5_000);
      const client = clientFor(
        stage === "probe" ? failure : () => Promise.resolve(operator),
        failure,
        () => delayed({ data: [{ id: "slow-staff" }], error: null }, 6_000),
      );
      const loading = loadAdminDesk(client);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await loading).toMatchObject({ roster: [{ id: "slow-staff" }], compassAiGovernance: null });
    });

    it.each([false, true])(`ignores a ${stage} session failure after the desk returned (rejected=%s)`, async (reject) => {
      vi.useFakeTimers();
      const failure = () => delayed(reject ? { status: 401, message: "expired" } : { data: null, error: { code: "PGRST301", message: "expired" } }, 6_000, reject);
      const client = clientFor(stage === "probe" ? failure : () => Promise.resolve(operator), failure);
      const loading = loadAdminDesk(client);
      await vi.advanceTimersByTimeAsync(4_000);
      const desk = Object.freeze(await loading);
      const before = JSON.stringify(desk);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(JSON.stringify(desk)).toBe(before);
      expect(desk.compassAiGovernance).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});
