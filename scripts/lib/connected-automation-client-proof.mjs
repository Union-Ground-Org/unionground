import assert from "node:assert/strict";
import { createAutomationApi } from "../../src/lib/mi1AutomationWiring.js";
import { AUTOMATION_RPCS } from "../../src/features/automation/controlPlane.js";
import { AUTOMATION_RECIPES, createAutomationRecipeDraft } from "../../src/features/automation/recipes.js";

// Invoke only inside the owning disposable proof's authenticated transaction.
// There is no connection, credential discovery, fixture creation or commit here.
export async function verifyConnectedAutomationClient(client, { session, runIds = [], sourceReferences = [] }) {
  let calls = 0;
  const api = createAutomationApi({ rpc: async (name, args = {}) => {
    assert.ok(Object.values(AUTOMATION_RPCS).includes(name), "client RPC must be allowlisted");
    const keys = Object.keys(args);
    assert.ok(keys.every((key) => /^p_[a-z0-9_]+$/.test(key)), "RPC arguments must be fixed named parameters");
    calls += 1;
    // A savepoint keeps a refused request from poisoning the enclosing proof.
    await client.query("savepoint connected_client_request");
    try {
      const result = await client.query(`select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(",")}) as value`, Object.values(args));
      await client.query("release savepoint connected_client_request");
      return { data: result.rows[0].value, error: null };
    } catch (error) {
      await client.query("rollback to savepoint connected_client_request");
      await client.query("release savepoint connected_client_request");
      return { data: null, error: { code: error.code, message: error.message } };
    }
  } });
  const loaded = await api.load(session);
  assert.equal(loaded.state, "ready", "real control-room payload must normalize");
  assert.equal(loaded.control.capabilities.schemaVersion, 2);
  assert.equal(loaded.control.capabilities.triggers.length, 15);
  assert.equal(loaded.control.capabilities.actions.length, 4);

  for (const recipe of AUTOMATION_RECIPES) {
    const draft = createAutomationRecipeDraft(recipe.id, { locale: "en", capabilities: loaded.control.capabilities });
    assert.ok(draft, `installed recipe ${recipe.id} must produce a draft`);
    draft.name = `Client proof ${draft.name}`.slice(0, 80);
    if (draft.actionKind === "assign_task") draft.actionConfig = { assigneeId: session.userId };
    if (draft.actionKind === "notify_in_app") draft.actionConfig = { recipientId: session.userId };
    const saved = await api.saveDefinition(session, draft);
    assert.equal(saved.ok, true, `real recipe save failed: ${recipe.id} (${saved.reason || "unknown"})`);
    const detail = await api.getDefinition(session, saved.data.id);
    assert.equal(detail.ok, true, `saved definition must normalize: ${recipe.id}`);
    assert.equal(detail.data.definition.status, "draft", "saving must not activate a definition");
    assert.equal(detail.data.definition.triggerKind, draft.triggerKind);
    assert.equal(detail.data.definition.actionKind, draft.actionKind);
    assert.deepEqual(detail.data.definition.conditions, draft.conditions);
  }
  for (const source of sourceReferences) {
    const context = await api.getSourceContext(session, source.sourceKind, source.sourceId);
    assert.equal(context.ok, true, "authorized source context must survive real client normalization");
    assert.equal(context.data.sourceId, source.sourceId);
  }
  for (const status of [undefined, "draft", "archived"]) {
    const list = await api.getDefinitions(session, { page: 1, pageSize: 6, status });
    assert.equal(list.ok, true, "definition page must normalize");
    assert.ok(list.data.rows.length <= 6);
  }
  assert.equal((await api.getRuns(session, { pageSize: 6 })).ok, true, "run history must normalize");
  assert.equal((await api.getScopeOptions(session, { source: "task", pageSize: 6 })).ok, true, "scope options must normalize");
  for (const runId of runIds) {
    const detail = await api.getRun(session, runId, { pageSize: 6 });
    if (!detail.ok) {
      const raw = (await client.query("select public.mi1_get_automation_run($1,1,6) value", [runId])).rows[0].value;
      assert.fail(`run snapshot/effects must normalize through the shipped client: ${JSON.stringify(raw)}`);
    }
    assert.equal(detail.data.run.id, runId);
    assert.equal(detail.data.run.definitionSnapshotAvailable, true, "v2 run must retain its evaluated snapshot");
    assert.equal(detail.data.run.definition.id, detail.data.run.definitionId);
  }
  const beforeDenials = calls;
  for (const denied of [{ ...session, authenticated: false }, { ...session, mfaSatisfied: false }, { ...session, role: "member" }]) {
    assert.notEqual((await api.load(denied)).state, "ready");
  }
  assert.equal(calls, beforeDenials, "client denied identities must not reach transport");
  return { recipes: AUTOMATION_RECIPES.length, calls, runs: runIds.length, sourceReferences: sourceReferences.length };
}
