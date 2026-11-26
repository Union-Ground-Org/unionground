import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertDisposableProofUrl } from '../../scripts/run-required-db-proofs.mjs';

export function retiredSeedFunctionDefinition(signature) {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/retired-pre-bot/installed-functions.json', import.meta.url), 'utf8'));
  const entry = fixture.functions.find(item => item.signature === signature);
  if (!entry) throw new Error(`Unknown historical fixture function: ${signature}`);
  return entry.definition;
}

// Historical UUID derivation for valid predecessor controls, never an operator
// seed entry point. Cross-checked against the captured SQL in each control.
export function legacySeedOrganization(run) {
  const digest = createHash('md5').update(`${run}:ud:organization`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

// Historical upgrade/security regressions run inside their own rollback.
// This is not an operator seed entry point and never installs on a hosted DB.
export async function installRetiredSeedUpgradeFixture(client) {
  const url = new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
  if (client.host !== url.hostname || Number(client.port) !== Number(url.port)) {
    throw new Error('retired seed fixture requires the asserted disposable connection');
  }
  // SAVEPOINT refuses if a caller omitted its rollback transaction.
  await client.query('savepoint retired_seed_upgrade_fixture');
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/retired-pre-bot/installed-functions.json', import.meta.url), 'utf8'));
  for (const entry of fixture.functions) {
    if (!Array.isArray(entry.executeRoles) || entry.executeRoles.some(role => !['PUBLIC', 'anon', 'authenticated', 'service_role'].includes(role))) {
      throw new Error('unexpected fixture roles');
    }
  }
  // Like pg_dump restores, captured SQL-language bodies can reference a
  // function later in the fixture. Restore definitions before validating
  // executable behavior; this setting is local and reset before the test.
  const previousBodyCheck = (await client.query("select current_setting('check_function_bodies') as value")).rows[0].value;
  await client.query("set local check_function_bodies = off");
  for (const entry of fixture.functions) {
    await client.query(entry.definition);
    await client.query(`revoke all on function ${entry.signature} from public, anon, authenticated, service_role`);
    for (const role of entry.executeRoles) {
      if (!['PUBLIC', 'anon', 'authenticated', 'service_role'].includes(role)) throw new Error('unexpected fixture role');
      await client.query(`grant execute on function ${entry.signature} to ${role}`);
    }
  }
  await client.query("select set_config('check_function_bodies',$1,true)", [previousBodyCheck]);
  for (const trigger of fixture.triggers) await client.query(trigger.definition);
  await client.query('release savepoint retired_seed_upgrade_fixture');
}
