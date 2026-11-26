// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { assessCurrencyCanary } from "../api/private-upload-currency-canary.js";

const databaseIt = process.env.RUN_PRIVATE_FILE_AUTHORIZATION_DB_TESTS === "1" ? it : it.skip;

databaseIt("keeps currency monitoring service-only and refuses lost, expired or mismatched witnesses", async () => {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  try {
    await client.query("begin");
    // Isolate the read-only projection from earlier disposable proofs. All
    // fixture writes, including this removal, roll back; no person is created.
    await client.query("delete from private.private_upload_scans");
    for (const role of ["anon", "authenticated"]) {
      await client.query("savepoint denied");
      await client.query(`set local role ${role}`);
      await expect(client.query("select public.private_upload_currency_canary()"))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint denied");
    }
    await client.query("savepoint missing_claim");
    await client.query("select set_config('request.jwt.claims','{}',true)");
    await expect(client.query("select public.private_upload_currency_canary()"))
      .rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint missing_claim");
    await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
    const probe = async () => {
      await client.query("set local role service_role");
      const result = (await client.query("select public.private_upload_currency_canary() value")).rows[0].value;
      await client.query("reset role");
      expect(Object.keys(result)).not.toContain("objectName");
      return { result, assessment: assessCurrencyCanary(result, Date.parse(result.now)) };
    };
    expect((await probe()).assessment).toMatchObject({ status: 503, body: { error: "currency_canary_no_witness" } });
    const id = randomUUID(); const name = `synthetic-currency-proof/${id}.txt`;
    await client.query("insert into storage.objects (id,bucket_id,name) values ($1,'case-files',$2)", [id, name]);
    // Synthetic predicate fixture only. This is not an attestation of a scan;
    // the independent real-scanner pipeline proves verdict production.
    await client.query(`update private.private_upload_scans set status='clean', sha256=repeat('a',64),
      engine='ClamAV 1.5.4', signature_version=28117, signature_updated_at=now(),
      scanned_at=now()-interval '1 minute', clean_until=now()+interval '1 hour'
      where bucket_id='case-files' and object_name=$1`, [name]);
    expect((await probe()).assessment.status).toBe(200);
    await client.query("update private.private_upload_scans set object_version='mismatched' where object_id=$1", [id]);
    expect((await probe()).assessment).toMatchObject({ status: 500, body: { error: "private_upload_not_current" } });
    await client.query("update private.private_upload_scans set clean_until=now()-interval '1 second' where object_id=$1", [id]);
    // Every clean verdict expired: an idle ledger, renewed when a file is next opened.
    expect((await probe()).assessment).toMatchObject({ status: 200, body: { ok: true, checked: false, coverage: "idle", expiredCleanObjects: 1 } });
    await client.query("update private.private_upload_scans set status='deleted', deleted_at=now(), clean_until=null where object_id=$1", [id]);
    expect((await probe()).assessment).toMatchObject({ status: 503, body: { error: "currency_canary_no_witness" } });
  } finally {
    await client.query("rollback");
    await client.end();
  }
}, 30000);
