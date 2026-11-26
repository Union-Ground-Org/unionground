// @vitest-environment node
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const ids = Object.fromEntries(['a','b','outsider','orgA','orgB','sessionA','sessionB'].map(k=>[k,randomUUID()]));
const prefix = `ft${randomUUID().replaceAll('-','').slice(0,12)}`;
const fields = {steps:[{title:{en:'Question',es:'Pregunta'},fields:[{key:'answer',type:'text',label:{en:'Answer',es:'Respuesta'},required:true}]}]};
describe.skipIf(!process.env.SUPABASE_DB_URL)('form-template tenancy on the complete schema',()=>{
 let db;
 const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
 async function actor(name,aal='aal2') {
  await query('reset role');
  await query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub','',true)",[JSON.stringify({sub:ids[name],role:'authenticated',aal,session_id:ids[name==='a'?'sessionA':'sessionB']})]);
  await query('set local role authenticated');
 }
 async function upsert(name,key,label,points=0) {
  await actor(name);
  return (await query('select public.upsert_form_template($1,$2,$2,null,null,null,$3,1::smallint,true,$4) result',[key,label,points,fields]))[0].result;
 }
 async function refuses(sql,args=[],code='22023') {
  await query('savepoint refusal');
  try {await expect(db.query(sql,args)).rejects.toMatchObject({code});}
  finally {await query('rollback to savepoint refusal');}
 }
 beforeAll(async()=>{
  db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),application_name:'form-template-tenancy-proof'});
  await db.connect(); await query('begin');
  await query("set local statement_timeout='30s'");
  for(const name of ['a','b','outsider']) await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[ids[name],`${prefix}-${name}@example.invalid`,{full_name:`Form proof ${name}`}]);
  await query('insert into public.organizations(id,slug,name,created_by) values($1,$3,$3,$5),($2,$4,$4,$5)',[ids.orgA,ids.orgB,`${prefix}-a`,`${prefix}-b`,ids.a]);
  for(const name of ['a','b']) {
   const org=ids[name==='a'?'orgA':'orgB'],chapter=`${prefix}-${name}`;
   await query("insert into public.chapters(id,name,slug,region,is_default,order_index,organization_id) values($1,$1,$1,'proof',false,9980,$2)",[chapter,org]);
   await query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[org,ids[name]]);
   await query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[ids[name],chapter]);
   await query('update public.member_profiles set chapter_id=$2 where id=$1',[ids[name],chapter]);
   await query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')",[org,ids[name]]);
   await query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing",[ids[name],chapter]);
   await query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing",[ids[name],chapter]);
   await query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",[ids[name==='a'?'sessionA':'sessionB'],ids[name]]);
   await query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Form proof','totp','verified',now(),now())",[randomUUID(),ids[name]]);
  }
 },60000);
 afterAll(async()=>{if(db){await db.query('rollback');await db.end();}});
 beforeEach(async()=>{await query('savepoint test_case');});
 afterEach(async()=>{await query('rollback to savepoint test_case');});
 it('denies another organization reads and activation changes',async()=>{
  const key=`${prefix}_private`; await upsert('a',key,'A private'); await actor('b');
  expect(await query('select key from public.form_templates where key=$1',[key])).toEqual([]);
  expect(await query('select key from public.form_template_registry where key=$1',[key])).toEqual([]);
  await refuses('select public.deactivate_form_template($1)',[key]);
  await refuses('select public.reactivate_form_template($1)',[key]);
  await actor('a');expect((await query('select active from public.form_templates where key=$1',[key]))[0].active).toBe(true);
 });
 it('keeps independently authored identical keys and neutral points inside their organization',async()=>{
  const key=`${prefix}_shared`;await upsert('a',key,'A label',0);await upsert('b',key,'B label',0);
  for(const [name,label,points] of [['a','A label',0],['b','B label',0]]) {
   await actor(name);expect(await query('select label_en,points,active from public.form_templates where key=$1',[key])).toEqual([{label_en:label,points,active:true}]);
   const economy=(await query('select public.get_admin_reward_economy() result'))[0].result;
   expect(economy.formTemplatePoints.find(x=>x.key===key)).toMatchObject({labelEn:label,points:0});
  }
 });
 it('refuses forged new draft starts and preserves another tenant active version',async()=>{
  const key=`${prefix}_start`;await upsert('a',key,'A only');await actor('b');
  await refuses("select public.save_form_draft($1,'{}',0)",[key]);
  await actor('a');expect((await query("select public.save_form_draft($1,'{}',0) result",[key]))[0].result).toBeTruthy();
 });
 // Sealed FMLA drafts start only through prepare_sealed_form; the legacy
 // save_form_draft refuses sealed templates (#6329). It applies the same
 // template precedence and active check.
 it('forks an organization toggle without mutating the platform seed',async()=>{
  await query('reset role');const seed=await query("select to_jsonb(t) row from public.form_templates t where key='fmla_self' and version=1");
  await actor('a');await query("select public.deactivate_form_template('fmla_self')");
  await refuses("select public.prepare_sealed_form('fmla_self')");
  await actor('b');expect((await query("select public.prepare_sealed_form('fmla_self') result"))[0].result).toBeTruthy();
  await query('reset role');expect(await query("select to_jsonb(t) row from public.form_templates t where key='fmla_self' and version=1")).toEqual(seed);
 });
 it('treats an inactive editor save of a seed as that organization\'s own choice until it reactivates',async()=>{
  await actor('a');
  await query("select public.upsert_form_template('fmla_family','Local leave','Permiso local',null,null,null,0,1::smallint,false,$1)",[fields]);
  await refuses("select public.prepare_sealed_form('fmla_family')");
  await actor('b');expect((await query("select public.prepare_sealed_form('fmla_family') result"))[0].result).toBeTruthy();
  await actor('a');await query("select public.reactivate_form_template('fmla_family')");
  expect((await query("select public.prepare_sealed_form('fmla_family') result"))[0].result).toBeTruthy();
  await query('reset role');
  expect(await query("select active,is_platform_seed from public.form_templates where key='fmla_family' and version=1")).toEqual([{active:true,is_platform_seed:true}]);
 });
 it('stops the migration when a canonical key has an unmapped later version',async()=>{
  const migration=readFileSync(new URL('../supabase/migrations/20261007173502_form_templates_tenant_isolation.sql',import.meta.url),'utf8');
  const start=migration.indexOf('do $$');const guard=migration.slice(start,migration.indexOf('$$;',start+5)+3);
  expect(guard).toContain('canonical form template has a version above 1');
  // The guard ran before 20261022192718 added platform seed versions above 1 for the FMLA keys; replay it against that earlier state (this case's savepoint restores them).
  // No form could pin those versions then, so drop any committed shared-fixture form pinned to them first (the sealed FMLA proof commits one).
  await query('reset role');
  await query("delete from public.member_forms f using public.form_templates t where t.key=f.template_key and t.version=f.template_version and t.is_platform_seed and t.version>1 and t.key in ('fmla_self','fmla_family')");
  await query("delete from public.form_templates where is_platform_seed and version>1 and key in ('fmla_self','fmla_family')");await query(guard);
  await query("insert into public.form_templates(key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema) select key,2,label_en,label_es,blurb_en,blurb_es,icon,points,true,sort,field_schema from public.form_templates where key='alt_work' and version=1");
  await refuses(guard,[],'55000');
 });
 it('preserves existing draft version across a later local template revision',async()=>{
  const key=`${prefix}_version`;const first=await upsert('a',key,'First');
  await query("select public.save_form_draft($1,'{\"answer\":\"original\"}',0)",[key]);
  await upsert('a',key,'Second');await query("select public.save_form_draft($1,'{\"answer\":\"edited\"}',1)",[key]);
  expect((await query('select template_version,answers from public.member_forms where template_key=$1',[key]))[0]).toEqual({template_version:first.version,answers:{answer:'edited'}});
 });
 it('rejects a real low-assurance session and a caller without membership',async()=>{
  const key=`${prefix}_auth`;await upsert('a',key,'Protected');await actor('a','aal1');
  await refuses('select public.deactivate_form_template($1)',[key],'42501');
  await actor('outsider');await refuses('select public.deactivate_form_template($1)',[key],'42501');
  expect(await query('select key from public.form_template_registry where key=$1',[key])).toEqual([]);
 });
 it('limits an unowned historical schema to the already authorized form',async()=>{
  await query('reset role');const key=`${prefix}_legacy`;
  await query('insert into public.form_templates(key,version,label_en,label_es,field_schema,active,points) values($1,1,$2,$2,$3,false,0)',[key,'Historical form',fields]);
  await query("insert into public.member_forms(user_id,template_key,template_version,answers,step) values($1,$2,1,'{}',0)",[ids.a,key]);
  await actor('a');expect(await query('select key,available_to_start from public.form_template_registry where key=$1',[key])).toEqual([{key,available_to_start:false}]);
  await query("select public.save_form_draft($1,'{\"answer\":\"retained\"}',1)",[key]);
  expect((await query('select template_version from public.member_forms where template_key=$1',[key]))[0].template_version).toBe(1);
  await actor('b');expect(await query('select key from public.form_template_registry where key=$1',[key])).toEqual([]);
  await refuses("select public.save_form_draft($1,'{}',0)",[key]);
 });
 it('refuses nonzero points even on quarantined historical templates',async()=>{
  await query('reset role');const key=`${prefix}_award`;
  for(const points of [31,72]) await refuses('insert into public.form_templates(key,version,label_en,label_es,field_schema,active,points) values($1,1,$2,$2,$3,false,$4)',[key,'Historical award',fields,points],'23514');
  expect((await query('select private.form_points($1) points',[key]))[0].points).toBe(0);
 });
 it('lets a member with no selected organization start a platform seed but no tenant template',async()=>{
  const key=`${prefix}_tenant`;await upsert('a',key,'Organization only');
  await query('reset role');const loner=randomUUID(),session=randomUUID();
  await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[loner,`${prefix}-loner@example.invalid`,{full_name:'Form proof loner'}]);
  await query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",[session,loner]);
  await query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Form proof','totp','verified',now(),now())",[randomUUID(),loner]);
  await query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:loner,role:'authenticated',aal:'aal2',session_id:session})]);
  expect((await query('select private.current_member_organization() org'))[0].org).toBeNull();
  await query('set local role authenticated');
  expect((await query("select available_to_start from public.form_template_registry where key='grievance' and version=1"))[0].available_to_start).toBe(true);
  expect(await query('select key from public.form_template_registry where key=$1',[key])).toEqual([]);
  expect((await query("select public.save_form_draft('grievance','{}',0) result"))[0].result).toBeTruthy();
  await refuses("select public.save_form_draft($1,'{}',0)",[key]);
 });
 it('keeps the registry view invoker-secured and grants only authenticated reads',async()=>{
  await query('reset role');
  expect((await query("select reloptions from pg_class where oid='public.form_template_registry'::regclass"))[0].reloptions).toContain('security_invoker=true');
  const allowed=(await query("select has_table_privilege('anon','public.form_template_registry','SELECT') anon,has_table_privilege('authenticated','public.form_template_registry','SELECT') authenticated,has_table_privilege('authenticated','public.form_template_registry','INSERT') writer"))[0];
  expect(allowed).toEqual({anon:false,authenticated:true,writer:false});
 });
});
