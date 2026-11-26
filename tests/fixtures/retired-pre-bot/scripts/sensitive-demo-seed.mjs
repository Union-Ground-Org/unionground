import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { encryptSensitive, sensitiveKeyring } from "../../../../api/_lib/sensitiveDataCrypto.js";

// Called only after the lane driver's exact SAMPLE/owned-loopback target guard.
// No key or fixture text is sent to SQL; only the sealed manifest is staged.
export async function stageSensitiveDemoSeed(client, lane, runId, ring = sensitiveKeyring("demo")) {
  const plan = await client.rpc("sensitive_demo_seed_plan", { p_lane: lane, p_run_id: runId });
  if (plan.error || !Array.isArray(plan.data) || !plan.data.length) throw new Error("sensitive-seed-plan-unavailable");
  const envelopes = {};
  const organization = plan.data[0].organization;
  for (const row of plan.data) {
    if (row.organization !== organization) throw new Error("sensitive-seed-scope-refused");
    envelopes[row.purpose] ??= {};
    const fields = {};
    for (const [field, value] of Object.entries(row.fields)) {
      const bytes = Buffer.from(value);
      try { fields[field] = encryptSensitive(bytes, { organization, record:row.record, purpose:row.purpose, field },ring); }
      finally { bytes.fill(0); }
    }
    envelopes[row.purpose][row.record] = fields;
  }
  const staged = await client.rpc("stage_sensitive_write", {
    p_actor:organization, p_operation:"demo_seed", p_arguments:{ lane,runId }, p_envelopes:envelopes,
  });
  if (staged.error || !staged.data) throw new Error("sensitive-seed-stage-unavailable");
}
