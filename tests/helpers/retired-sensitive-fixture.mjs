import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertDisposableProofUrl } from '../../scripts/run-required-db-proofs.mjs';
import { encryptSensitive, sensitiveKeyring } from '../../api/_lib/sensitiveDataCrypto.js';
import { revealRow, SENSITIVE_FIELDS } from '../../api/_lib/sensitiveContent.js';
import { legacySeedOrganization, retiredSeedFunctionDefinition } from './retired-seed-upgrade-fixture.mjs';

// Transaction-local rows use the real trigger and encryption code. Predecessor
// guard/UUID definitions live only inside rolled-back controls; no seed writer,
// shared identity, organization row or hosted resource is needed.
export async function proveRetiredSensitiveFixture(table) {
  assert(Object.hasOwn(SENSITIVE_FIELDS, table));
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
  const fields = Object.keys(SENSITIVE_FIELDS[table]);
  const id = randomUUID(), run = randomUUID(), organization = legacySeedOrganization(run);
  const ring = sensitiveKeyring('saas', {
    SENSITIVE_DATA_KEYS: JSON.stringify({ proof: randomBytes(32).toString('base64') }), SENSITIVE_DATA_ACTIVE_KEY: 'proof',
  });
  const values = Object.fromEntries(fields.map(field => [field, `Isolated ${field} proof text`]));
  const envelopes = Object.fromEntries(fields.map(field => [field, encryptSensitive(Buffer.from(values[field]), { organization, record: id, field, purpose: table }, ring)]));
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`create temporary table ${table} (id uuid, organization_id uuid, member_user_id uuid, reporter_user_id uuid, status text, encrypted_content jsonb, ${fields.map(f => `${f} text`).join(',')});
      create trigger real_sensitive_guard before insert or update on ${table}
      for each row execute function private.require_sensitive_envelopes()`);
    const insert = `insert into ${table}(id,organization_id,status,${fields.join(',')}) values ($1,$2,'open',${fields.map((_, i) => `$${i + 3}`).join(',')})`;
    const markerArgs = [id, organization, ...fields.map(() => '[encrypted]')];
    await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
    const ticket = (await client.query('select public.stage_sensitive_write($1,$2,$3,$4) as id', [organization, 'demo_seed', { lane: 'uniondemo', runId: run }, { [table]: { [id]: envelopes } }])).rows[0].id;
    await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true),set_config('app.sensitive_seed_ticket',$1,true),set_config('app.sensitive_maintenance','off',true)", [ticket]);
    await client.query('savepoint predecessor_sensitive_ticket');
    await client.query(retiredSeedFunctionDefinition('private.member_stress_uuid(p_value text)'));
    assert.equal((await client.query("select private.member_stress_uuid($1) organization", [`${run}:ud:organization`])).rows[0].organization, organization);
    await client.query(retiredSeedFunctionDefinition('private.require_sensitive_envelopes()'));
    await client.query(insert, markerArgs);
    const predecessor = (await client.query(`select * from ${table} where id=$1`, [id])).rows[0];
    for (const field of fields) assert.equal(revealRow(table, predecessor, ring)[field], values[field]);
    await client.query('rollback to savepoint predecessor_sensitive_ticket');
    await client.query('savepoint retired_ticket');
    await assert.rejects(client.query(insert, markerArgs), { code: '22023' });
    await client.query('rollback to savepoint retired_ticket');
    await client.query('savepoint plaintext');
    await assert.rejects(client.query(insert, [id, organization, ...Object.values(values)]), { code: '22023' });
    await client.query('rollback to savepoint plaintext');
    await client.query("select set_config('app.sensitive_maintenance','on',true),set_config('app.sensitive_envelopes',$1,true)", [JSON.stringify(envelopes)]);
    await client.query(insert, markerArgs);
    const row = (await client.query(`select * from ${table} where id=$1`, [id])).rows[0];
    const opened = revealRow(table, row, ring);
    for (const field of fields) {
      assert.equal(row[field], '[encrypted]');
      assert.equal(opened[field], values[field]);
    }
    await client.query('savepoint identity');
    await assert.rejects(client.query(`update ${table} set organization_id=$1 where id=$2`, [randomUUID(), id]), { code: '22023' });
    await client.query('rollback to savepoint identity');
    return { retiredTicketRefused: true, plaintextRefused: true, encryptedRoundtrip: true, identityBound: true };
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}
