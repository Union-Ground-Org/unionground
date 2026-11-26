import { render, screen, waitFor } from "@testing-library/react";
import { afterAll, expect, it } from "vitest";
import { backend, coverage, flush, go, random } from "./helpers/member-boot-model-fixture.jsx";
import { App } from "../src/App.jsx";
import { memberMutationResources, memberResourcesForRoute } from "../src/lib/memberSessionLoader.js";

afterAll(() => {
  for (const count of Object.values(coverage.routes)) expect(count).toBeGreaterThan(10);
  for (const count of coverage.events) expect(count).toBeGreaterThan(100);
  process.stdout.write(`B06 resource model coverage: ${JSON.stringify({ routes: coverage.routes, events: coverage.events })}\n`);
});

// Oracle owns epochs, successful responses and live ordering independently of
// the loader. It never derives an expected snapshot from the implementation.
it.each(Array.from({ length: 64 }, (_, index) => index + 1))("resource/App event model, seed %i", async seed => {
  const choose = random(seed);
  const state = backend.state;
  render(<App />);
  await screen.findByRole("heading", { name: /Model/ });
  expect(state.operations.find(item => item.resource === "rpc:get_my_mfa_requirement")).toMatchObject({
    loader: null, data: { required: false, enrolled: false },
  });
  await flush(() => { void state.loader.loadRoute("voice"); });
  const models = new Map();
  const retired = new Set();
  const modelFor = (loader) => {
    if (!models.has(loader)) {
      const model = new Map();
      // Initial operations are successful and synchronous. Seed the oracle
      // from backend records, not registry snapshots.
      for (const operation of state.operations.filter(item => item.loader === loader)) {
        model.set(operation.resource, { epoch: 0, data: operation.immediate ? operation.data : undefined, live: [], sequence: 0 });
      }
      models.set(loader, model);
    }
    return models.get(loader);
  };
  modelFor(state.loader);
  let view = "today";
  let signedIn = true;
  const trace = [];
  const invalidate = (resources) => {
    const model = modelFor(state.loader);
    for (const resource of new Set(resources)) {
      const item = model.get(resource) ?? { epoch: 0, data: undefined, live: [], sequence: 0 };
      item.epoch += 1;
      model.set(resource, item);
    }
    state.loader.invalidateResources(resources);
  };
  const settle = (index, fail) => {
    const [request] = state.pending.splice(index, 1);
    if (!request) return;
    const model = modelFor(request.loader);
    // A bootstrap call settles every covered resource at once; a failed call
    // settles none and the loader may read each affected resource once more.
    for (const part of request.parts ?? [request]) {
      let item = model.get(part.resource);
      if (!item) { item = { epoch: 0, data: undefined, live: [], sequence: 0 }; model.set(part.resource, item); }
      if (fail) { if (request.parts) item.fallbacks = (item.fallbacks ?? 0) + 1; continue; }
      if (item.epoch === part.epoch) {
        item.data = structuredClone(part.data);
        // Request's concurrent inserts are retained, existing rows use the live
        // event's ordering. No pre-request live row overrides an authoritative read.
        for (const event of item.live.filter(event => event.sequence > (part.liveSequence ?? 0))) {
          item.data = [...item.data.filter(row => row.id !== event.row.id), event.row];
        }
      }
    }
    request.resolve({ data: fail ? null : request.parts ? request.payload() : request.data, error: fail ? { message: "model failure" } : null });
  };
  const assertModel = async () => {
    const loader = state.loader;
    for (const old of retired) expect(old.inspect().size, "retired identity registry stays empty").toBe(0);
    const registry = loader.inspect();
    // Auth policy is a direct App read, not a member-data resource. It remains
    // recorded for every identity/refresh instead of being silently dropped.
    for (const read of state.operations.filter(item => item.resource === "rpc:get_my_mfa_requirement")) {
      expect(read.loader, "MFA requirement has no member-cache owner").toBeNull();
      expect(read.data).toEqual({ required: false, enrolled: false });
    }
    expect(registry.has("rpc:get_my_mfa_requirement")).toBe(false);
    if (retired.has(loader)) return;
    const model = modelFor(loader);
    for (const [resource, expected] of model) {
      const actual = registry.get(resource);
      expect(actual, `${resource}: ${trace.join(" > ")}`).toBeDefined();
      expect(actual.epoch, trace.join(" > ")).toBe(expected.epoch);
      // Every controlled resource has one canonical query variant. Other RPCs
      // can legitimately have one variant per authorized ballot/record.
      if (["table:member_rights_progress", "table:member_notifications", "table:member_conversations", "table:member_guide_threads", "rpc:get_member_rewards_summary"].includes(resource)) {
        const count = state.operations.filter(item => item.loader === loader && item.resource === resource).length;
        expect(count, `${resource}: ${trace.join(" > ")}`).toBeLessThanOrEqual(expected.epoch + 1 + (expected.fallbacks ?? 0));
        const snapshot = [...actual.snapshot.values()][0];
        if (expected.data !== undefined) {
          expect(snapshot, `${resource}: expected successful snapshot`).toBeDefined();
          const canonical = rows => resource === "table:member_notifications"
            ? [...rows].sort((a, b) => a.id.localeCompare(b.id)) : rows;
          expect(canonical(snapshot.data), `${resource}: ${trace.join(" > ")}`).toEqual(canonical(expected.data));
        }
      }
    }
    if (signedIn && memberResourcesForRoute(view).every(resource => !["idle", "loading"].includes(registry.get(resource)?.status ?? "idle"))) {
      await waitFor(() => expect(document.querySelector(".view-loading"), trace.join(" > ")).toBeNull());
    }
    // An unrelated projection must retain the overlay in the real render data.
    const guide = registry.get("table:member_guide_threads");
    if (guide?.snapshot.size && signedIn) {
      expect([...guide.snapshot.values()][0].data.some(thread => thread.id === "guide")).toBe(true);
    }
  };
  state.hold = true;
  for (let step = 0; step < 60; step += 1) {
    const event = choose(11);
    // Bound outstanding controlled transports below the queue capacity before
    // another epoch advances. This keeps transport-start ownership observable
    // to the independent oracle; the four-slot production bound is covered by
    // the separate end-to-end boot budget. Older issued epochs still overlap.
    if ([1, 2, 3].includes(event)) {
      while (state.pending.length > 3) await flush(() => settle(choose(state.pending.length), false));
    }
    coverage.events[event] += 1;
    trace.push(`${step}:${event}`);
    await flush(() => {
      if (event === 0 && signedIn) {
        view = ["today", "rights", "messages", "events"][choose(4)]; coverage.routes[view] += 1; go(view);
      } else if (event === 1 && signedIn) {
        // Explicit forced refresh uses the same invalidation path as App Retry.
        invalidate(memberResourcesForRoute(view));
      } else if (event === 2 && signedIn) {
        state.rows["table:member_rights_progress"] = [{ lesson_id: "lesson", completed_steps: [step] }];
        invalidate(memberMutationResources("saveRightsProgress"));
      } else if (event === 3 && signedIn) {
        // SUBSCRIBED: exact narrow invalidation, then the real reconciler.
        const names = ["table:member_notifications", "table:chapter_task_messages"];
        const model = modelFor(state.loader);
        for (const resource of names) {
          const item = model.get(resource) ?? { epoch: 0, data: undefined, live: [], sequence: 0 };
          item.epoch += 1; model.set(resource, item);
        }
        state.subscribers.at(-1)?.("SUBSCRIBED");
      } else if ((event === 4 || event === 5) && signedIn) {
        const model = modelFor(state.loader);
        const item = model.get("table:member_notifications");
        const row = { id: event === 4 ? `live-${step}` : "notice", title: "Live model notice", read_at: event === 5 ? "2026-09-06T13:00:00Z" : null, created_at: "2026-09-06T12:00:00Z" };
        item.live.push({ row, sequence: ++item.sequence });
        state.liveSequences.set(state.loader, item.sequence);
        if (item.data) item.data = [...item.data.filter(previous => previous.id !== row.id), row];
        state.rows["table:member_notifications"] = [...state.rows["table:member_notifications"].filter(previous => previous.id !== row.id), row];
        state.feeds.findLast(feed => feed.filter.table === "member_notifications")?.callback({ new: row });
      } else if (event === 6 && state.pending.length) {
        settle(choose(state.pending.length), choose(4) === 0);
      } else if (event === 7 && signedIn) {
        state.session = { ...state.session, access_token: `refreshed-${step}` };
        state.auth("TOKEN_REFRESHED", state.session);
      } else if (event === 8 || event === 10) {
        if (signedIn) retired.add(state.loader);
        // A SAMPLE hat mint enters this same auth boundary with a new identity.
        signedIn = true;
        state.session = { user: backend.user(event === 10 ? `model-identity-${step}` : `model-hat-${step}`), access_token: "hat-token" };
        state.auth("SIGNED_IN", state.session);
      } else if (event === 9) {
        if (signedIn) retired.add(state.loader);
        signedIn = false; state.session = null; state.auth("SIGNED_OUT", null);
      }
    });
    // Newly booted identities have independent successful immediate responses.
    modelFor(state.loader);
    await assertModel();
  }
  // Drain in arbitrary order; no hanging route may survive settled resources.
  for (let attempt = 0; state.pending.length && attempt < 200; attempt += 1) {
    await flush(() => settle(choose(state.pending.length), false));
  }
  await flush();
  expect(state.pending).toHaveLength(0);
  await assertModel();
});
