// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStewardDesk, setAppointmentSchedule, setAppointmentWindows } from "../src/lib/memberApi.js";

function clientWith(overrides = {}) {
  const requests = [{ id: "request-1", user_id: "member-a", status: "requested", member_name: "Member A" }];
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "steward-a" } } } }) },
    rpc: vi.fn((name) => (typeof overrides[name] === "function" ? overrides[name]() : overrides[name])
      ?? Promise.resolve({ data: name === "list_steward_requests" ? requests : [], error: null })),
    from: vi.fn((name) => {
      const chain = new Proxy({}, { get: (_, key) => key === "then"
        ? (...args) => Promise.resolve((typeof overrides[name] === "function" ? overrides[name]() : overrides[name])
          ?? { data: [], error: null }).then(...args) : () => chain });
      return chain;
    }),
  };
  return client;
}

afterEach(() => vi.useRealTimers());

describe("bounded independent steward desk reads", () => {
  it("keeps requests usable when the forms queue fails, without claiming an empty forms inbox", async () => {
    const desk = await loadStewardDesk(clientWith({ list_steward_forms: { data: null, error: { code: "57014", message: "statement timeout" } } }));
    expect(desk.queue[0].id).toBe("request-1");
    expect(desk.formsUnavailable).toBe(true);
    expect(desk.formsTotal).toBeNull();
  });

  it("keeps requests usable when a lesson-label read rejects", async () => {
    const failed = Promise.reject(new Error("network unavailable"));
    const desk = await loadStewardDesk(clientWith({ member_rights_lessons: failed }));
    expect(desk.queue[0].id).toBe("request-1");
  });

  it("bounds a hung optional read before the shell deadline", async () => {
    vi.useFakeTimers();
    let desk;
    const pending = loadStewardDesk(clientWith({ get_steward_workload_intelligence: new Promise(() => {}) })).then((value) => { desk = value; });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(desk?.queue[0].id).toBe("request-1");
    expect(desk?.workloadIntelligence).toEqual({ available: false, reason: "read_error" });
    await pending;
  });

  it("shares the deadline with enrichment instead of starting another full wait", async () => {
    vi.useFakeTimers();
    let desk;
    const pending = loadStewardDesk(clientWith({
      get_steward_workload_intelligence: new Promise((resolve) => setTimeout(() => resolve({ data: {}, error: null }), 5_000)),
      list_steward_broadcasts: { data: [{ id: "broadcast-1", title: "Local notice" }], error: null },
      get_broadcast_read_counts_for: new Promise(() => {}),
    })).then((value) => { desk = value; });
    await vi.advanceTimersByTimeAsync(6_001);
    expect(desk?.broadcasts[0]).toMatchObject({ id: "broadcast-1", readCount: null });
    expect(desk?.queue[0].id).toBe("request-1");
    await pending;
  });

  it("enriches healthy forms while unrelated workload is slow", async () => {
    vi.useFakeTimers();
    const later = (ms, data) => new Promise((resolve) => setTimeout(() => resolve({ data, error: null }), ms));
    const cosigners = vi.fn(() => later(20, [{ id: "cosigner-1", form_id: "form-1", cosigner_user_id: "member-b" }]));
    const client = clientWith({
      list_steward_forms: { data: [{ id: "form-1", member_name: "Member A", total_count: 1 }], error: null },
      get_steward_workload_intelligence: () => later(6_100, {}),
      member_form_cosigners: cosigners,
      member_profiles: () => later(20, [{ id: "member-b", full_name: "Member B" }]),
    });
    let desk;
    const pending = loadStewardDesk(client).then((value) => { desk = value; });
    await vi.advanceTimersByTimeAsync(6_001);
    expect(desk?.formsUnavailable).toBe(false);
    expect(desk?.formsTotal).toBe(1);
    expect(desk?.formsInbox).toMatchObject([{ id: "form-1", cosigners: [{ id: "cosigner-1", name: "Member B" }] }]);
    expect(cosigners).toHaveBeenCalledTimes(1);
    expect(desk?.workloadIntelligence.available).toBe(false);
    await pending;
  });

  it("names caseload members and loads timelines while workload intelligence runs past the deadline", async () => {
    vi.useFakeTimers();
    const later = (ms, data) => new Promise((resolve) => setTimeout(() => resolve({ data, error: null }), ms));
    const client = clientWith({
      get_steward_workload_intelligence: () => later(7_000, {}),
      member_cases: () => later(20, [{ id: "case-1", user_id: "member-b", status: "active", updated_at: "2026-10-13T12:00:00Z" }]),
      member_profiles: () => later(20, [{ id: "member-b", full_name: "Member B", initials: "MB" }]),
      list_case_latest_updates: () => later(20, [{ id: "update-1", case_id: "case-1", body: "Filed step one", created_at: "2026-10-13T12:00:00Z", total_count: 1 }]),
    });
    let desk;
    const pending = loadStewardDesk(client).then((value) => { desk = value; });
    await vi.advanceTimersByTimeAsync(6_001);
    expect(desk?.workloadIntelligence).toEqual({ available: false, reason: "read_error" });
    expect(desk?.caseload[0]).toMatchObject({ id: "case-1", memberName: "Member B", memberInitials: "MB", memberNameUnavailable: false, updatesTotal: 1 });
    expect(desk?.caseload[0].updates).toHaveLength(1);
    expect(desk?.caseUpdatesUnavailable).toBe(false);
    await pending;
  });

  it("marks caseload names unavailable when the name lookup fails, instead of the generic Member", async () => {
    const client = clientWith({
      member_cases: { data: [{ id: "case-1", user_id: "member-b", status: "active", updated_at: "2026-10-13T12:00:00Z" }], error: null },
      member_profiles: { data: null, error: { code: "57014", message: "statement timeout" } },
    });
    const desk = await loadStewardDesk(client);
    expect(desk.caseload[0]).toMatchObject({ id: "case-1", memberName: "Name unavailable", memberInitials: "?", memberNameUnavailable: true });
  });

  it("keeps the generic Member for a profile the lookup returns without a name", async () => {
    const client = clientWith({
      member_cases: { data: [{ id: "case-1", user_id: "member-b", status: "active", updated_at: "2026-10-13T12:00:00Z" }], error: null },
      member_profiles: { data: [], error: null },
    });
    const desk = await loadStewardDesk(client);
    expect(desk.caseload[0]).toMatchObject({ id: "case-1", memberName: "Member", memberInitials: "M", memberNameUnavailable: false });
  });

  it("starts the legal-hold and read-count lookups from their own pages while workload intelligence is pending", async () => {
    vi.useFakeTimers();
    const client = clientWith({
      get_steward_workload_intelligence: () => new Promise(() => {}),
      list_steward_conversations: { data: [{ id: "thread-1", member_name: "Member A" }], error: null },
      list_steward_broadcasts: { data: [{ id: "broadcast-1", title: "Local notice" }], error: null },
    });
    loadStewardDesk(client).catch(() => {});
    await vi.advanceTimersByTimeAsync(50);
    const started = client.rpc.mock.calls.map(([name]) => name);
    expect(started).toContain("get_broadcast_read_counts_for");
    await vi.advanceTimersByTimeAsync(6_001);
  });

  it.each(["member_form_cosigners", "member_profiles"])("retains fetched forms when %s enrichment hangs", async (table) => {
    vi.useFakeTimers();
    const client = clientWith({
      list_steward_forms: { data: [{ id: "form-1", total_count: 1 }], error: null },
      member_form_cosigners: { data: [{ id: "cosigner-1", form_id: "form-1", cosigner_user_id: "member-b" }], error: null },
      [table]: () => new Promise(() => {}),
    });
    let desk;
    const pending = loadStewardDesk(client).then((value) => { desk = value; });
    await vi.advanceTimersByTimeAsync(6_001);
    expect(desk?.formsUnavailable).toBe(false);
    expect(desk?.formsInbox).toMatchObject([{ id: "form-1", cosigners: table === "member_profiles"
      ? [{ id: "cosigner-1", name: "A member" }] : [] }]);
    expect(desk?.formsTotal).toBe(1);
    await pending;
  });

  it.each([false, true])("fails closed on a session error even when the response also carries a user (overview=%s)", async (overviewOnly) => {
    const client = clientWith();
    client.auth.getSession = async () => ({ data: { session: { user: { id: "steward-a" } } }, error: { code: "42501", message: "denied" } });
    await expect(loadStewardDesk(client, { overviewOnly })).rejects.toMatchObject({ code: "42501" });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("bounds a pending session without reading any protected queues", async () => {
    vi.useFakeTimers();
    const client = clientWith();
    client.auth.getSession = () => new Promise(() => {});
    const result = loadStewardDesk(client).catch((error) => error);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(await result).toMatchObject({ code: "57014", label: "Steward session" });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  describe.each(["list_steward_requests", "list_steward_forms", "list_steward_conversations", "list_steward_broadcasts"])("%s authorization", (rpc) => {
    it.each(["42501", "PGRST301"])("does not turn refusal %s into a successful desk", async (code) => {
      await expect(loadStewardDesk(clientWith({ [rpc]: { data: null, error: { code, message: "denied" } } }))).rejects.toMatchObject({ code });
    });
  });
});

describe("availability writes retain server authority", () => {
  it("passes supported weekly hours through the self-scoped RPCs without a caller or tenant override", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { count: 2 }, error: null }) };
    const windows = [{ weekday: 1, startMinute: 390, endMinute: 420 }, { weekday: 1, startMinute: 690, endMinute: 720 }];
    await setAppointmentSchedule(client, { timezone: "America/New_York", accepting: true });
    await setAppointmentWindows(client, windows);
    expect(client.rpc.mock.calls).toEqual([
      ["set_appointment_schedule", { p_timezone: "America/New_York", p_min_notice_minutes: null, p_buffer_before_minutes: null, p_buffer_after_minutes: null, p_max_per_day: null, p_accepting: true }],
      ["set_appointment_windows", { p_windows: windows }],
    ]);
  });

  it.each([setAppointmentSchedule, setAppointmentWindows])("preserves a denied role/lifecycle result from the RPC", async (write) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } }) };
    await expect(write(client, [])).rejects.toMatchObject({ code: "42501" });
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
});
