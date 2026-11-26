import pg from "pg";
import { createSensitiveStorage } from "../api/_lib/sensitiveStorage.js";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { productionProviderDecision } from "../api/_lib/providerBoundary.js";
import { maintainSensitiveFields } from "./sensitive-data-maintenance.mjs";
import { maintainSensitiveDocuments } from "./sensitive-document-maintenance.mjs";
import { runSealedFormMaintenance } from "./sensitive-form-maintenance.mjs";

const MIGRATION = new URL("../supabase/migrations/20260906190000_sensitive_content_envelopes.sql", import.meta.url);
export async function closeSensitiveWindow(client) {
  await client.query(`begin;
    create table if not exists private.sensitive_rollout_window(id boolean primary key default true check(id), grants jsonb not null);
    revoke all on private.sensitive_rollout_window from public,anon,authenticated,service_role;
    insert into private.sensitive_rollout_window(grants)
      select coalesce(jsonb_agg(jsonb_build_object('role',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'grantable',a.is_grantable)),'[]'::jsonb)
      from pg_namespace n, lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      where n.nspname='public' and a.privilege_type='USAGE' and (a.grantee=0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'))
      on conflict(id) do nothing;
    revoke usage on schema public from public,anon,authenticated;
    drop policy if exists sensitive_maintenance_window on storage.objects;
    create policy sensitive_maintenance_window on storage.objects as restrictive for all to anon,authenticated using(false) with check(false);
    commit;`);
}
export async function applySensitiveMigration(client) {
  await requireClosed(client);
  const present = await client.query("select 1 from supabase_migrations.schema_migrations where version='20260906190000'");
  if (present.rows.length) throw new Error("sensitive-migration-already-applied");
  const sql = readFileSync(MIGRATION,"utf8");
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('20260906190000','sensitive_content_envelopes',$1)",[ [sql] ]);
    await client.query("commit");
  } catch { await client.query("rollback"); throw new Error("sensitive-migration-rolled-back"); }
}
async function requireClosed(client) {
  const result = await client.query(`select exists(select 1 from private.sensitive_rollout_window) as closed,
    has_schema_privilege('authenticated','public','USAGE') as exposed`);
  if (!result.rows[0]?.closed || result.rows[0].exposed) throw new Error("sensitive-maintenance-window-required");
}
export async function runSensitiveMaintenance(client, storage, options) {
  await requireClosed(client);
  let batch, cursors = {}, processed = 0;
  do {
    batch = await maintainSensitiveFields(client,{ ...options,cursors });
    cursors = batch.cursors; processed += batch.processed;
  } while (!batch.exhausted);
  const documents = await maintainSensitiveDocuments(client,storage,options);
  await client.query("delete from public.sensitive_case_chunks where expires_at < clock_timestamp()");
  // The older rollout also serves deployments before the sealed-form schema.
  // Once installed, its answers, attachments and retirement ledger all gate reopening.
  const forms = await client.query(`select to_regclass('private.sensitive_retired_form_objects') is not null as installed,
    to_regprocedure('private.form_template_is_sealed(text)') is not null as form_schema`);
  let sealed = { forms: 0, files: 0, chunks: 0 };
  if (forms.rows[0]?.installed !== false || forms.rows[0]?.form_schema !== false) {
    if (!options.formStorage) throw new Error("sensitive-form-storage-target-required");
    sealed = await runSealedFormMaintenance(client, options.formStorage, options);
  }
  return { fields: processed, documents: documents.processed, forms: sealed.forms, formDocuments: sealed.files, formChunks: sealed.chunks };
}
export async function openSensitiveWindow(client, storage, options) {
  await runSensitiveMaintenance(client,storage,{ ...options, mode: "verify", oldRing: options.ring });
  const pending = await client.query("select count(*)::integer n from private.sensitive_retired_objects");
  if (pending.rows[0].n) throw new Error("sensitive-document-retirement-pending");
  await client.query(`begin;
    do $restore$ declare g jsonb; begin
      for g in select value from private.sensitive_rollout_window w, lateral jsonb_array_elements(w.grants) loop
        execute 'grant usage on schema public to ' || case when g->>'role'='PUBLIC' then 'PUBLIC' else quote_ident(g->>'role') end
          || case when (g->>'grantable')::boolean then ' with grant option' else '' end;
      end loop;
    end $restore$;
    drop policy sensitive_maintenance_window on storage.objects;
    delete from private.sensitive_rollout_window;
    commit;`);
}
// Explicit operator credentials only; no repository .env or hosted discovery.
// A local lab keeps both the database and Storage on loopback. Anything else is
// hosted: TLS everywhere, and the Storage origin that receives the service key
// must pass the API's one provider rule (api/_lib/providerBoundary.js) with
// UNIONGROUND_SUPABASE_PROJECT_REF, before any connection.
export function sensitiveMaintenanceTarget(env) {
  const connectionString = env.SENSITIVE_MAINTENANCE_DB_URL;
  const origin = env.SENSITIVE_MAINTENANCE_STORAGE_URL;
  const serviceKey = env.SENSITIVE_MAINTENANCE_SERVICE_KEY;
  const db = new URL(connectionString), api = new URL(origin);
  const local = ["localhost","127.0.0.1"].includes(db.hostname) && ["localhost","127.0.0.1"].includes(api.hostname);
  if (!local && (db.searchParams.get("sslmode") !== "verify-full" || api.protocol !== "https:")) throw new Error("sensitive-maintenance-transport-refused");
  if (!local && !productionProviderDecision({
    VITE_SUPABASE_URL: origin,
    UNIONGROUND_SUPABASE_PROJECT_REF: env.UNIONGROUND_SUPABASE_PROJECT_REF,
  }).ok) throw new Error("sensitive-maintenance-provider-refused");
  if (!serviceKey) throw new Error("sensitive-maintenance-credentials-required");
  return { connectionString, origin, serviceKey };
}
async function main() {
  if (process.env.SENSITIVE_MAINTENANCE_CONFIRM !== "fail-closed-window") throw new Error("sensitive-maintenance-confirmation-required");
  const action = process.argv[2];
  if (!["close","apply","backfill","rewrap","verify","open"].includes(action)) throw new Error("sensitive-maintenance-action-refused");
  const { connectionString, origin, serviceKey } = sensitiveMaintenanceTarget(process.env);
  const ring = sensitiveKeyring(process.env.SENSITIVE_MAINTENANCE_SURFACE === "demo" ? "demo" : "saas");
  const oldRing = action === "rewrap" ? sensitiveKeyring("saas", {
    SENSITIVE_DATA_KEYS: process.env.SENSITIVE_DATA_OLD_KEYS, SENSITIVE_DATA_ACTIVE_KEY: process.env.SENSITIVE_DATA_OLD_ACTIVE_KEY,
    SENSITIVE_DATA_REVOKED_ORGANIZATIONS: JSON.stringify([...ring.revoked]),
  }) : ring;
  const client = new pg.Client({ connectionString });
  const storage = createSensitiveStorage(origin,serviceKey);
  const formStorage = createSensitiveStorage(origin,serviceKey,{ bucket: "member-form-files" });
  await client.connect();
  try {
    if (action === "close") await closeSensitiveWindow(client);
    else if (action === "apply") await applySensitiveMigration(client);
    else if (action === "open") await openSensitiveWindow(client,storage,{ ring, formStorage });
    else await runSensitiveMaintenance(client,storage,{ ring,oldRing,mode:action,formStorage });
    console.log(JSON.stringify({ action,status:"complete" }));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("sensitive-maintenance-refused; window remains closed after a failure"); process.exitCode=1; });
}
