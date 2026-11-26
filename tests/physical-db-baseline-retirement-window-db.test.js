// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { sensitiveKeyring } from "../api/_lib/sensitiveDataCrypto.js";
import { maintainSealedFormFiles } from "../scripts/sensitive-form-maintenance.mjs";
import { closeSensitiveWindow, openSensitiveWindow } from "../scripts/sensitive-data-rollout.mjs";

// The verifier scans every case/form document. Run in the pristine phase,
// before shared-fixture suites commit files backed by their own Storage.
const databaseIt = process.env.RUN_SENSITIVE_CONTENT_DB_TESTS === "1" ? it : it.skip;
databaseIt("keeps the maintenance window closed while retired form plaintext remains", async () => {
  const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const admin = new pg.Client({ connectionString: url });
  const ring = sensitiveKeyring("saas", { SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1" });
  await admin.connect();
  try {
    // The maintenance readers own transactions, so snapshot the actual grants
    // with the real close operation and explicitly restore this fixture.
    const windowExisted = (await admin.query("select to_regclass('private.sensitive_rollout_window') is not null as present")).rows[0].present;
    const retired = `synthetic-retired-${randomUUID()}`;
    await closeSensitiveWindow(admin);
    try {
      await admin.query("insert into private.sensitive_retired_form_objects(object_name) values($1)", [retired]);
      await expect(maintainSealedFormFiles(admin, {}, { ring, mode: "verify" })).rejects.toThrow("sensitive-document-retirement-pending");
      await expect(openSensitiveWindow(admin, {}, { ring, formStorage: {} })).rejects.toThrow("sensitive-document-retirement-pending");
      expect((await admin.query("select has_schema_privilege('authenticated','public','USAGE') as exposed")).rows[0].exposed).toBe(false);
    } finally {
      await admin.query("delete from private.sensitive_retired_form_objects where object_name=$1", [retired]);
      await admin.query(`begin;
        do $restore_fixture$ declare g jsonb; begin
          for g in select value from private.sensitive_rollout_window w, lateral jsonb_array_elements(w.grants) loop
            execute 'grant usage on schema public to ' || case when g->>'role'='PUBLIC' then 'PUBLIC' else quote_ident(g->>'role') end
              || case when (g->>'grantable')::boolean then ' with grant option' else '' end;
          end loop;
        end $restore_fixture$;
        drop policy sensitive_maintenance_window on storage.objects;
        delete from private.sensitive_rollout_window;
        commit;`);
      // closeSensitiveWindow creates its ledger on demand. A pristine proof
      // must not add that operator table to the physical baseline snapshot.
      if (!windowExisted) await admin.query("drop table private.sensitive_rollout_window");
    }
  } finally {
    await admin.query("rollback");
    await admin.end();
  }
}, 30000);
