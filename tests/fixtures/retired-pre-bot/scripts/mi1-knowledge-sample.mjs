import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
// Guarded SAMPLE activation for MI1 CR-071 through CR-075.
//
//   node scripts/mi1-knowledge-sample.mjs dry-run --lane both
//   node scripts/mi1-knowledge-sample.mjs apply --target local --lane presg --run-id <local-run-id>
//   node scripts/mi1-knowledge-sample.mjs status --target sample --lane both
//   node scripts/mi1-knowledge-sample.mjs remove --target sample --lane both

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { PRODUCTION_PROJECT_REF, SAMPLE_PROJECT_REF } from "../../../../scripts/demo-seed-contract.mjs";

const SAMPLE_URL = `https://${SAMPLE_PROJECT_REF}.supabase.co`;
const LOCAL_URL = "http://127.0.0.1:54421";
const BODY = "Union Ground fictional knowledge resource for protected SAMPLE verification.".padEnd(128, " ");
const BUCKET = "organization-knowledge";
const LANES = Object.freeze({
  presg: {
    runId: "2c1b3c47-f7f5-47d4-af68-eeca6ed8ad8a",
    confirmToken: "SEED_PRE_SOLID_GROUND_SAMPLE_DEMO",
    organizationSeed: "presg:organization",
  },
  uniondemo: {
    runId: "6eccdf88-7a52-41ae-a467-63c700ef4a79",
    confirmToken: "SEED_UNION_DEMO_ORG_SAMPLE_30K",
    organizationSeed: "ud:organization",
  },
});

function parseArgs(argv) {
  const parsed = { mode: argv[0] || "dry-run", lane: "both", target: "sample", runId: null };
  if (!new Set(["dry-run", "apply", "status", "remove"]).has(parsed.mode)) {
    throw new Error(`Unknown mode: ${parsed.mode}`);
  }
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--lane" && value) parsed.lane = value;
    else if (flag === "--target" && value) parsed.target = value;
    else if (flag === "--run-id" && value) parsed.runId = value;
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  if (!new Set(["both", "presg", "uniondemo"]).has(parsed.lane)) throw new Error(`Unknown lane: ${parsed.lane}`);
  if (!new Set(["local", "sample"]).has(parsed.target)) throw new Error(`Unknown target: ${parsed.target}`);
  if (parsed.runId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.runId)) {
    throw new Error("--run-id must be a UUID");
  }
  if (parsed.runId && (parsed.target !== "local" || parsed.lane === "both")) {
    throw new Error("--run-id is permitted only for one local lane");
  }
  return parsed;
}

function emit(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

function deterministicUuid(value) {
  const digest = createHash("md5").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function objectNames(config) {
  const organizationId = deterministicUuid(`${config.runId}:${config.organizationSeed}`);
  return Array.from({ length: 200 }, (_, index) => {
    const ordinal = index + 1;
    const fileId = deterministicUuid(`${config.runId}:knowledge:file:${ordinal}`);
    return `org/${organizationId}/${fileId}/knowledge-resource-${String(ordinal).padStart(3, "0")}.txt`;
  });
}

function selectedLanes(value) {
  return value === "both" ? ["presg", "uniondemo"] : [value];
}

function laneConfig(lane, args) {
  return { ...LANES[lane], runId: args.runId || LANES[lane].runId };
}

export function knowledgeSampleEnvironment(target) {
  const expectedUrl = target === "local" ? LOCAL_URL : SAMPLE_URL;
  const url = process.env.SAMPLE_SUPABASE_URL || expectedUrl;
  const parsed = new URL(url);
  if (parsed.origin !== expectedUrl || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new Error(`${target} URL must be exactly ${expectedUrl}`);
  }
  if (parsed.hostname.includes(PRODUCTION_PROJECT_REF)) throw new Error("Production Supabase project is forbidden");
  const serviceKey = target === "sample"
    ? process.env.SAMPLE_SUPABASE_SERVICE_ROLE_KEY
    : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || serviceKey === "[SENSITIVE]") throw new Error(`${target} service-role key is required`);
  return { url: parsed.origin, serviceKey };
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

async function mapConcurrent(values, concurrency, operation) {
  let cursor = 0;
  const failures = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        await operation(values[index], index);
      } catch (error) {
        failures.push({ index, message: error?.message || String(error) });
      }
    }
  }));
  if (failures.length) throw new Error(`Storage operation failed for ${failures.length} objects: ${failures[0].message}`);
}

async function activate(client, lane, config) {
  const result = await rpc(client, "activate_mi1_knowledge_sample", {
    p_lane: lane,
    p_run_id: config.runId,
    p_target_ref: SAMPLE_PROJECT_REF,
    p_confirm_token: config.confirmToken,
  });
  const expected = objectNames(config);
  const planned = Array.isArray(result?.objectNames) ? [...result.objectNames].sort() : [];
  if (JSON.stringify(planned) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${lane} activation returned an unexpected protected-object plan`);
  }
  await mapConcurrent(expected, 12, async (objectName) => {
    const { error } = await client.storage.from(BUCKET).upload(objectName, BODY, {
      contentType: "text/plain; charset=utf-8",
      upsert: true,
    });
    if (error) throw error;
  });
  emit("objects-uploaded", { lane, count: expected.length });
  await status(client, lane, config, true);
}

async function status(client, lane, config, requireOk = false, allowAbsent = false) {
  const result = await rpc(client, "mi1_knowledge_sample_status", {
    p_lane: lane,
    p_run_id: config.runId,
  });
  emit("status", { lane, ...result });
  const inspectableLegacyRun = allowAbsent
    && result?.activationState === "absent"
    && result?.driveUnset === true;
  if (requireOk && !result?.ok && !inspectableLegacyRun) {
    throw new Error(`${lane} knowledge SAMPLE verification did not pass`);
  }
  return result;
}

async function remove(client, lane, config) {
  const names = objectNames(config);
  for (let start = 0; start < names.length; start += 100) {
    const { error } = await client.storage.from(BUCKET).remove(names.slice(start, start + 100));
    if (error) throw new Error(`Storage cleanup failed: ${error.message}`);
  }
  const result = await rpc(client, "remove_mi1_knowledge_sample", {
    p_lane: lane,
    p_run_id: config.runId,
    p_target_ref: SAMPLE_PROJECT_REF,
    p_confirm_token: config.confirmToken,
  });
  emit("removed", result);
}

export function activateKnowledgeSampleLane(client, lane, runId = LANES[lane]?.runId) {
  if (!LANES[lane] || !runId) throw new Error(`Unknown knowledge SAMPLE lane: ${lane}`);
  return activate(client, lane, { ...LANES[lane], runId });
}

export function knowledgeSampleLaneStatus(
  client,
  lane,
  runId = LANES[lane]?.runId,
  requireOk = true,
  allowAbsent = false,
) {
  if (!LANES[lane] || !runId) throw new Error(`Unknown knowledge SAMPLE lane: ${lane}`);
  return status(client, lane, { ...LANES[lane], runId }, requireOk, allowAbsent);
}

export function removeKnowledgeSampleLane(client, lane, runId = LANES[lane]?.runId) {
  if (!LANES[lane] || !runId) throw new Error(`Unknown knowledge SAMPLE lane: ${lane}`);
  return remove(client, lane, { ...LANES[lane], runId });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lanes = selectedLanes(args.lane);
  emit("plan", { mode: args.mode, target: args.target, projectRef: SAMPLE_PROJECT_REF, lanes, filesPerLane: 200, bodyBytes: Buffer.byteLength(BODY) });
  if (args.mode === "dry-run") return;
  const env = knowledgeSampleEnvironment(args.target);
  const client = createClient(env.url, env.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  for (const lane of lanes) {
    const runId = laneConfig(lane, args).runId;
    if (args.mode === "apply") await activateKnowledgeSampleLane(client, lane, runId);
    else if (args.mode === "status") await knowledgeSampleLaneStatus(client, lane, runId);
    else await removeKnowledgeSampleLane(client, lane, runId);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error("Retired pre-bot test fixture: direct execution is forbidden");
  if (false) main().catch((error) => {
    emit("failed", { message: error?.message || String(error) });
    process.exitCode = 1;
  });
}
