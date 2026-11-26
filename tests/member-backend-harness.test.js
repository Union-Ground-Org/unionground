import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createMemberBackendHarness } from "./helpers/memberBackendHarness.js";

const confirmedWrites = readFileSync("tests/member-confirmed-writes.test.jsx", "utf8");
const sessionContinuations = readFileSync("tests/member-session-continuations.test.jsx", "utf8");

function scenario(source, title) {
  const start = source.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const next = source.indexOf("\nit", start + title.length);
  return source.slice(start, next === -1 ? source.length : next);
}

it("persistTaskWrites stores a task created through create_chapter_task under the same two switches", async () => {
  const enabled = createMemberBackendHarness({ persistTaskWrites: true });
  enabled.state.persistTaskWrites = true;
  const saved = await enabled.client.rpc("create_chapter_task", { p_fields: { title: "Through the RPC" } });
  expect(saved).toMatchObject({ error: null, data: [{ id: "new-task", title: "Through the RPC", chapter_id: "chapter-model" }] });
  expect(enabled.state.rows["table:chapter_tasks"]).toEqual(saved.data);
  enabled.state.persistTaskWrites = false;
  const skipped = await enabled.client.rpc("create_chapter_task", { p_fields: { title: "Not persisted" } });
  expect(skipped.data).not.toEqual(saved.data);
  const disabled = createMemberBackendHarness({ persistTaskWrites: false });
  disabled.state.persistTaskWrites = true;
  await disabled.client.rpc("create_chapter_task", { p_fields: { title: "Ignored" } });
  expect(disabled.state.rows["table:chapter_tasks"]).toBeUndefined();
});

it("persistTaskWrites stores a chapter task insert only when the suite and the test both enable it", async () => {
  const enabled = createMemberBackendHarness({ persistTaskWrites: true, captureInserts: true });
  enabled.state.persistTaskWrites = true;
  const saved = await enabled.client.from("chapter_tasks").insert({ title: "Confirmed first task" });
  expect(saved.error).toBeNull();
  expect(saved.data).toMatchObject({
    id: "new-task",
    title: "Confirmed first task",
    created_by: "model-a",
    assignee_id: "model-a",
    chapter_id: "chapter-model",
  });
  expect(enabled.state.rows["table:chapter_tasks"]).toEqual([saved.data]);
  expect(enabled.state.operations).toEqual([]);

  enabled.state.persistTaskWrites = false;
  const skipped = await enabled.client.from("chapter_tasks").insert({ title: "Not persisted" });
  expect(skipped.data).toEqual([saved.data]);
  expect(enabled.state.rows["table:chapter_tasks"]).toEqual([saved.data]);

  const disabled = createMemberBackendHarness({ persistTaskWrites: false, captureInserts: true });
  disabled.state.persistTaskWrites = true;
  const ignored = await disabled.client.from("chapter_tasks").insert({ title: "Ignored by suite option" });
  expect(ignored.data).toEqual([]);
  expect(disabled.state.rows["table:chapter_tasks"]).toBeUndefined();
  expect(disabled.state.operations.map(operation => operation.resource)).toEqual(["table:chapter_tasks"]);
});

it("messageActions routes member message RPCs and otherwise records a plain execute", async () => {
  const routed = createMemberBackendHarness({ messageActions: true });
  routed.state.session = { user: { id: "model-a" } };
  routed.state.canEdit = true;
  routed.state.rows["rpc:list_member_message_reactions"] = [
    { actor_id: "model-a", private_message_id: "m1", reaction: "support" },
    { actor_id: "someone-else", private_message_id: "m1", reaction: "like" },
  ];
  const actions = await routed.client.rpc("get_member_message_actions", { p_message_id: "m1" });
  expect(actions).toEqual({
    data: { canEdit: true, saved: false, reminders: [], reactions: ["support"] },
    error: null,
  });
  expect(routed.state.operations).toEqual([]);

  routed.state.rows["rpc:toggle_member_message_reaction"] = { id: "server-reaction", reacted: true };
  const acted = await routed.client.rpc("act_on_member_message", {
    p_action: "react",
    p_source_kind: "private",
    p_message_id: "m1",
    p_value: "support",
  });
  expect(acted.error).toBeNull();
  expect(acted.data.result).toEqual({ id: "server-reaction", reacted: true });
  expect(acted.data.state.reactions).toEqual(["support"]);
  expect(routed.state.operations.map(operation => operation.resource)).toEqual(["rpc:toggle_member_message_reaction"]);

  const other = await routed.client.rpc("act_on_member_message", { p_action: "save", p_message_id: "m1" });
  expect(other).toEqual({ data: null, error: null });
  expect(routed.state.operations.map(operation => operation.resource)).toEqual([
    "rpc:toggle_member_message_reaction",
    "rpc:act_on_member_message",
  ]);

  const plain = createMemberBackendHarness({ messageActions: false });
  plain.state.rows["rpc:get_member_message_actions"] = { fromExecute: true };
  const executed = await plain.client.rpc("get_member_message_actions", { p_message_id: "m1" });
  expect(executed).toEqual({ data: { fromExecute: true }, error: null });
  expect(plain.state.operations.map(operation => operation.resource)).toEqual(["rpc:get_member_message_actions"]);
});

it("captureInserts records inserts and upserts; without it only an upsert feeds the rights-write failure", async () => {
  const write = { lesson_id: "lesson", completed_steps: [0] };
  const capturing = createMemberBackendHarness({ captureInserts: true });
  capturing.state.failAfterRightsWrite = true;
  const inserted = await capturing.client.from("member_rights_progress").insert(write);
  expect(inserted).toEqual({ data: null, error: null });
  expect(capturing.state.fail).toBe("table:member_rights_progress");
  expect(capturing.state.rows["table:member_rights_progress"]).toEqual([write]);

  const upsertOnly = createMemberBackendHarness({ captureInserts: false });
  upsertOnly.state.failAfterRightsWrite = true;
  const missed = await upsertOnly.client.from("member_rights_progress").insert(write);
  expect(missed.data).toEqual([]);
  expect(upsertOnly.state.fail).toBeUndefined();
  expect(upsertOnly.state.rows["table:member_rights_progress"]).toBeUndefined();

  const upserted = await upsertOnly.client.from("member_rights_progress").upsert(write);
  expect(upserted).toEqual({ data: null, error: null });
  expect(upsertOnly.state.rows["table:member_rights_progress"]).toEqual([write]);
  expect(upsertOnly.state.fail).toBe("table:member_rights_progress");
});

it("confirmed-writes keeps one race-covering scenario per duplicated failure mode and asserts rendered outcomes", () => {
  const message = scenario(confirmedWrites, "it('ordering: confirmed message survives failed read'");
  const reaction = scenario(confirmedWrites, 'it("ordering: confirmed reaction survives failed reads');
  const rights = scenario(confirmedWrites, 'it("ordering: confirmed Rights progress persists across navigation');

  expect(confirmedWrites).not.toContain("it('confirmed message survives failed read'");
  expect(confirmedWrites).not.toContain('it("confirmed reaction survives failed reads');
  expect(confirmedWrites).not.toContain('it("confirmed Rights progress persists across navigation');
  expect(confirmedWrites).not.toMatch(/member_messages['"]\]\.some\(row\s*=>\s*row\.id\s*===\s*['"]confirmed-message['"]\)/);
  expect(confirmedWrites).not.toContain('state.rows["rpc:list_member_message_reactions"]).toHaveLength(1)');

  expect(message).toContain("holdResource='table:member_messages'");
  expect(message.match(/(?<!not\.)toContain\('Confirmed private message'\)/g)).toHaveLength(3);
  expect(message).toContain("toHaveLength(1)");
  expect(message).toContain("not.toContain('Confirmed private message')");

  expect(reaction).toContain("holdResource='rpc:list_member_message_reactions'");
  expect(reaction.match(/name: "Care: 1"/g)).toHaveLength(3);
  expect(reaction.match(/toHaveAttribute\("aria-pressed", "true"\)/g)).toHaveLength(3);
  expect(reaction).toContain("toBeEmptyDOMElement()");

  expect(rights).toContain('holdResource="table:member_rights_progress"');
  expect(rights).toContain('aria-pressed", "true"');
  expect(rights).toContain('aria-pressed", "false"');
  expect(rights).toContain("Try again");
  expect(rights).toContain("state.operations.length).toBe(before)");

  // Task-title and Compass pairs are not strict subsets, so both stay.
  expect(confirmedWrites).toContain('it("confirmed task title survives a failed read and route return, then yields to authority"');
  expect(confirmedWrites).toContain('it("ordering: confirmed task title survives a failed read and route return, then yields to authority"');
  expect(confirmedWrites).toContain('it.each([false, true])("confirmed Compass exchange survives failed history (initial failure: %s) and authoritative replacement"');
  expect(confirmedWrites).toContain('it("ordering: confirmed Compass exchange survives failed history through unrelated projections and successful replacement"');
});

it("confirmed-writes and session-continuation suites share one harness and state their options", () => {
  for (const source of [confirmedWrites, sessionContinuations]) {
    expect(source).toContain('await import("./helpers/memberBackendHarness.js")');
    expect(source).not.toContain("const controlled = new Set(");
  }
  expect(confirmedWrites).toContain("persistTaskWrites: true");
  expect(confirmedWrites).toContain("messageActions: true");
  expect(confirmedWrites).toContain("captureInserts: true");
  expect(sessionContinuations).toContain("persistTaskWrites: false");
  expect(sessionContinuations).toContain("messageActions: false");
  expect(sessionContinuations).toContain("captureInserts: false");
});

// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
// (#8318): a fixture names its own people and the server's coded refusals.
it("answers a fixture person's own profile and a coded refusal, and keeps the model profile otherwise", async () => {
  const harness = createMemberBackendHarness();
  harness.state.session = { user: harness.user("model-a") };
  expect((await harness.client.from("member_profiles").select("*")).data).toMatchObject({ id: "model-a", first_name: "Model" });
  harness.state.profiles = { "model-a": { id: "model-a", first_name: "Odessa" } };
  expect((await harness.client.from("member_profiles").select("*")).data).toEqual({ id: "model-a", first_name: "Odessa" });
  harness.state.errors = { "rpc:get_staff_engagement_snapshot": { code: "42501", message: "not authorized" } };
  expect(await harness.client.rpc("get_staff_engagement_snapshot")).toEqual({ data: null, error: { code: "42501", message: "not authorized" } });
  expect((await harness.client.rpc("get_member_rewards_summary")).error).toBeNull();
});
