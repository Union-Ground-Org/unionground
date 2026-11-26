// @vitest-environment node
// #9273: a later migration cannot silently overwrite any newer inviter body.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it} from 'vitest';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';
import {fnBody,loadMigrationSql} from './helpers/migration.js';

const sql=loadMigrationSql('invitation_expiry_system_maintenance');
const block=sql.match(/do \$invitation_expiry_sources\$[\s\S]*?\$invitation_expiry_sources\$;/)?.[0];
const units=loadMigrationSql('20261113115000_stewards_require_unit_with_carry_over');
const learning=loadMigrationSql('20261104111500_learning_period_messages_notices_invites_exports');
const definitions=[
 ['public.create_member_invitation(text,text,text,text,text,text,uuid)',fnBody(units,'public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text, p_unit_id uuid)')],
 ['public.create_member_invitation(text,text,text,text,text,text)',fnBody(units,'public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)')],
 ['public.create_roster_member_invitation(text,text,text,text,text)',fnBody(learning,'public.create_roster_member_invitation')],
 ['public.create_former_member_invitation(text,text,text,text)',fnBody(learning,'public.create_former_member_invitation')],
 ['public.create_member_sent_invitation(uuid,text,text,text,text)',fnBody(loadMigrationSql('20261121035000_member_invitations_own_chapter_allowance'),'public.create_member_sent_invitation')],
 ['public.create_organization_founder_invitation(text,text,text,text,text,uuid)',fnBody(loadMigrationSql('20261118200200_organization_name_phone_rule_dates_and_years'),'public.create_organization_founder_invitation')],
].map(([signature,definition])=>({signature,definition:definition.replace(/^create function/i,'create or replace function')}));
const md5=value=>createHash('md5').update(value).digest('hex');
const source=definition=>definition.slice(definition.indexOf('$function$')+10,definition.lastIndexOf('$function$'));

describe('invitation expiry predecessor guard source contract',()=>{
 it('checks every restated source after local timeouts and before any function change',()=>{
  assert(block,'source guard block required');
  assert(sql.indexOf("set local statement_timeout = '60s'")<sql.indexOf(block));
  assert(sql.indexOf(block)<sql.indexOf('create function private.expire_member_invitation_email'));
  assert.equal((block.match(/md5\(p.prosrc\)/g)||[]).length,6);
  for(const {signature,definition} of definitions) {
   assert(block.includes(`to_regprocedure('${signature}')`));
   assert(block.includes(`is distinct from '${md5(source(definition))}' then`));
   assert(block.includes(`raise exception 'unreviewed predecessor: ${signature}' using errcode = '55000'`));
  }
 });
 it('pins each extracted cleanup call and each time-only helper clause in the live contract',()=>{
  const contract=JSON.parse(readFileSync(new URL('../scripts/db-contract.json',import.meta.url)));
  for(const name of ['create_roster_member_invitation','create_former_member_invitation','create_member_sent_invitation','create_organization_founder_invitation']) {
   assert(contract.functions.find(fn=>fn.sig.startsWith(`public.${name}(`)).bodyContains.includes('perform private.expire_member_invitation_email(clean_email)'));
  }
  assert(contract.functions.find(fn=>fn.sig.startsWith('public.create_member_invitation(')&&fn.sig.includes('p_unit_id uuid')).bodyContains.includes('perform private.expire_member_invitation_email(clean_email)'));
  const helper=contract.functions.find(fn=>fn.sig.startsWith('private.expire_member_invitation_email('));
  for(const clause of ["and status = 'pending'",'expires_at <= pg_catalog.clock_timestamp()',"expired_row.id, expired_row.chapter_id, null, 'invite_expired'",'where normalized_email = p_normalized_email'])assert(helper.bodyContains.includes(clause));
 });
});

const live=process.env.SUPABASE_DB_URL?describe:describe.skip;
live('invitation expiry predecessor guards on a disposable database',()=>{
 let db;
 beforeAll(async()=>{
  db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),ssl:false});
  await db.connect();
 });
 afterAll(async()=>{await db?.end();});
 beforeEach(async()=>{
  await db.query('begin');
  await db.query("set local statement_timeout='30s'");
  for(const {definition} of definitions)await db.query(definition);
 });
 afterEach(async()=>{await db.query('rollback');});
 it('accepts all six exact Main bodies, including the legacy delegator',async()=>{
  for(const {signature,definition} of definitions) {
   const installed=(await db.query('select md5(prosrc) digest from pg_proc where oid=to_regprocedure($1)',[signature])).rows[0];
   assert.equal(installed.digest,md5(source(definition)));
  }
  await db.query(block);
 });
 for(const {signature,definition} of definitions)it(`refuses newer source for ${signature} with 55000`,async()=>{
  const drift=definition.replace(/(\$function\$\r?\n)/,'$1-- C304 later reviewed body\n');
  assert.notEqual(drift,definition);
  await db.query(drift);
  await db.query('savepoint guard_attempt');
  const error=await db.query(block).then(()=>null,error=>error);
  await db.query('rollback to savepoint guard_attempt');
  assert.equal(error?.code,'55000');
  assert.equal(error?.message,`unreviewed predecessor: ${signature}`);
  assert.equal((await db.query('select md5(prosrc) digest from pg_proc where oid=to_regprocedure($1)',[signature])).rows[0].digest,md5(source(drift)));
 });
 it('refuses a missing predecessor with 55000 before any replacement',async()=>{
  const {signature}=definitions[4];
  await db.query(`drop function ${signature}`);
  await db.query('savepoint guard_attempt');
  const error=await db.query(block).then(()=>null,error=>error);
  await db.query('rollback to savepoint guard_attempt');
  assert.equal(error?.code,'55000');
  assert.equal(error?.message,`unreviewed predecessor: ${signature}`);
 });
});
