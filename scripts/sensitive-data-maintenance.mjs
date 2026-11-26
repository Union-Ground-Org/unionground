import pg from "pg";
import { pathToFileURL } from "node:url";
import { SENSITIVE_FIELDS } from "../api/_lib/sensitiveContent.js";
import { rotationReadKeyring, decryptSensitive, migrateSensitiveValue, rewrapSensitive, sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";

// One transaction per locked row. Reruns authenticate existing envelopes;
// failures roll back both ciphertext and source replacement. No payload logs.
export async function maintainSensitiveFields(client, { ring, mode = "backfill", oldRing = ring, limit = 100, cursors = {} }) {
  if (!["backfill", "rewrap", "verify"].includes(mode) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("sensitive-maintenance-invalid-options");
  const readRing = mode === "rewrap" ? rotationReadKeyring(oldRing, ring) : ring;
  let processed = 0;
  const nextCursors = { ...cursors };
  let exhausted = true;
  for (const [table, fields] of Object.entries(SENSITIVE_FIELDS)) {
    let after = cursors[table] || "00000000-0000-0000-0000-000000000000";
    for (let index = 0; index < limit; index += 1) {
      await client.query("begin");
      try {
        const result = await client.query(`select * from public.${table} where id > $1 order by id limit 1 for update`, [after]);
        const row = result.rows[0];
        if (!row) { await client.query("commit"); break; }
        after = row.id;
        const envelopes = {};
        const values = [];
        const assignments = [];
        for (const field of Object.keys(fields)) {
          const current = row.encrypted_content?.[field];
          if (!row[field] && !current) continue;
          const context = { organization: row.organization_id, record: row.id, field, purpose: table };
          if (mode === "verify") {
            const verified = decryptSensitive(current,context,ring); verified.fill(0);
            if (row[field] !== "[encrypted]") throw new Error("sensitive-data-backfill-required");
            continue;
          }
          if (mode === "rewrap" && current?.keyVersion === ring.active) {
            const verified = decryptSensitive(current, context, readRing); verified.fill(0);
            if (row[field] !== "[encrypted]") throw new Error("sensitive-data-backfill-required");
            continue;
          }
          envelopes[field] = mode === "rewrap"
            ? rewrapSensitive(current, context, readRing, ring)
            : migrateSensitiveValue(row[field], current, context, ring);
          values.push("[encrypted]");
          assignments.push(`${field} = $${values.length}`);
        }
        if (table === "casework_retaliation_patterns" && mode !== "verify" && assignments.length) {
          values.push(row.id); assignments.push(`fingerprint = $${values.length}`);
        }
        if (assignments.length) {
          await client.query("select set_config('app.sensitive_maintenance','on',true)");
          await client.query("select set_config('app.sensitive_envelopes',$1,true)", [JSON.stringify(envelopes)]);
          values.push(row.id);
          await client.query(`update public.${table} set ${assignments.join(",")} where id = $${values.length}`, values);
        }
        await client.query("commit"); processed += 1;
        nextCursors[table] = row.id;
        if (index === limit - 1) exhausted = false;
      } catch {
        await client.query("rollback");
        throw new Error("sensitive-maintenance-failed-transaction-rolled-back");
      }
    }
  }
  return { processed, cursors: nextCursors, exhausted };
}

async function main() {
  // This delivered runner is deliberately disposable-only. A hosted rollout
  // requires the separately reviewed maintenance window, not a flag override.
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const mode = process.argv[2];
  if (!["backfill", "rewrap", "verify"].includes(mode)) throw new Error("usage: sensitive-data-maintenance.mjs backfill|rewrap");
  const ring = sensitiveKeyring();
  const oldRing = mode === "rewrap" ? sensitiveKeyring("saas", {
    SENSITIVE_DATA_KEYS: process.env.SENSITIVE_DATA_OLD_KEYS,
    SENSITIVE_DATA_ACTIVE_KEY: process.env.SENSITIVE_DATA_OLD_ACTIVE_KEY,
    SENSITIVE_DATA_REVOKED_ORGANIZATIONS: process.env.SENSITIVE_DATA_REVOKED_ORGANIZATIONS,
  }) : ring;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    let batch, total = 0, cursors = {};
    do {
      batch = await maintainSensitiveFields(client, { ring, oldRing, mode, cursors });
      cursors = batch.cursors; total += batch.processed;
    } while (!batch.exhausted);
    console.log(JSON.stringify({ processed: total }));
  }
  finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("sensitive-maintenance-refused; inspect configuration and migration readiness without payload logging"); process.exitCode = 1; });
}
