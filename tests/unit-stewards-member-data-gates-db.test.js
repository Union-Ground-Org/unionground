// @vitest-environment node
// Explicit old organization-wide controls use actual carry-over.
import { legacyStewardFixtureWrite, migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import {randomUUID} from 'node:crypto';
import {beforeEach, afterEach, describe, expect, it} from 'vitest';
import pg from 'pg';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';
import {sourceTransactionProblem} from '../scripts/hosted-migration-apply-runner.mjs';
import {loadMigrationSql} from './helpers/migration.js';

const sql=loadMigrationSql('unit_stewards_member_data_per_member');
describe('unit steward member-data migration contract',()=>{
  it('is accepted by the real hosted transaction guard',()=>{
    expect(sourceTransactionProblem(sql)).toBeNull();
  });
  it('keeps the global chapter-wide and member-visibility oracles unchanged',()=>{
    expect(sql).not.toMatch(/create\s+(?:or\s+replace\s+)?function\s+(?:private\.member_has_chapter_role|public\.staff_can_see_user)\s*\(/i);
    expect(sql).toContain('unreviewed predecessor:');
    expect(sql).toContain('unreviewed predecessor policy:');
  });
  it('preserves canonical lifecycle gates and grants only boolean private helpers',()=>{
    expect(sql).toContain('perform private.lock_case_graph(');
    for(const signature of [
      'private.chapter_staff_member_allowed(text, uuid, text[])',
      'private.chapter_records_member_allowed(text, uuid)',
      'private.chapter_contact_entry_allowed(text, uuid, uuid)',
      'private.chapter_seniority_member_allowed(text, uuid)',
    ]) {
      expect(sql).toContain('revoke all on function '+signature);
      expect(sql).toContain('grant execute on function '+signature+' to authenticated;');
    }
    expect(sql).not.toMatch(/alter system|use_background_workers/i);
  });
});

const live=process.env.SUPABASE_DB_URL?describe:describe.skip;
live('unit steward access stays per member on an owned database',()=>{
  let db,f;
  const owner=async()=>{await db.query('reset role');await db.query("select set_config('request.jwt.claims','',true)");};
  const as=async(name,aal='aal2')=>{
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({
      sub:f.people[name].id,session_id:f.people[name].session,role:'authenticated',aal,
    })]);
    await db.query('set local role authenticated');
  };
  const one=async(query,args=[])=> (await db.query(query,args)).rows[0]?.v;
  const denied=async(query,args=[])=>{
    await db.query('savepoint denied_member_data');
    let error;
    try{await db.query(query,args);}catch(caught){error=caught;}
    await db.query('rollback to savepoint denied_member_data');
    await db.query('release savepoint denied_member_data');
    expect(error,'out-of-scope operation was allowed').toBeTruthy();
    expect(['42501','P0002','22023','PT409']).toContain(error.code);
    return {code:error.code,message:error.message,detail:error.detail??null};
  };
  const scope=async()=>{
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[f.people.steward.id,f.chapter,f.unitA]);
    await as('steward');
  };
  const historySave=(id,type,body,version,unit,committee=null,action='save')=>one(
    "select public.save_scoped_institutional_record($1,$2,'Fictional history record',$3,now(),'staff',$7,false,null,$4,'[]'::jsonb,$5,$6) v",
    [id,type,body,version,unit,committee,action],
  );
  const mixedHistory=async(type='minutes',unit=f.unitB,committee=null)=>{
    await as('admin');
    const record=await historySave(null,'member_contact','Fictional B contact before move',null,unit,committee);
    await historySave(record.id,type,'Fictional B ordinary record',1,unit,committee);
    await scope();
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'secretary',true,$3,$4) v",[f.people.steward.id,f.chapter,unit,committee]);
    await as('steward');
    return record;
  };
  beforeEach(async()=>{
    db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name:'unit-steward-member-data-rollback-proof'});
    await db.connect();await db.query('begin');
    f={org:randomUUID(),foreignOrg:randomUUID(),unitA:randomUUID(),unitB:randomUUID(),people:{}};
    f.chapter='member-data-'+f.org;f.foreign='member-data-'+f.foreignOrg;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Staff'),($2::uuid,$2::text,'Ridge Fictional Staff')",[f.org,f.foreignOrg]);
    await db.query('insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9970),($3,$3,$3,$4,9971)',[f.chapter,f.org,f.foreign,f.foreignOrg]);
    for(const name of ['admin','steward','coordinator','a','a2','a3','b','b2','b3','foreign','foreignSteward','foreignCoordinator']){
      const id=randomUUID(),session=randomUUID(),foreign=name.startsWith('foreign');
      f.people[name]={id,session};
      await db.query('insert into auth.users(id,email) values($1,$2)',[id,id+'@example.invalid']);
      await db.query('update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1',[id,foreign?f.foreign:f.chapter,'Fictional '+name]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[foreign?f.foreignOrg:f.org,id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[id,foreign?f.foreign:f.chapter]);
      if(['admin','steward','foreignSteward','coordinator','foreignCoordinator'].includes(name)){
        const role=name==='admin'?'admin':name.toLowerCase().includes('coordinator')?'coordinator':'steward';
        await db.query('insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)',[id,role,foreign?f.foreign:f.chapter]);
        await db.query('insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)',[id,role,foreign?f.foreign:f.chapter]);
      }
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')",[f.org,f.people.admin.id]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Garage A'),($2,$3,$4,'Garage B')",[f.unitA,f.unitB,f.org,f.chapter]);
    await as('admin');
    for(const name of ['a','a2','a3','steward','b','b2','b3']){
      await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[f.chapter,f.people[name].id,name.startsWith('b')?f.unitB:f.unitA]);
    }
    await owner();
  });
  afterEach(async()=>{
    if(db){await db.query('rollback');await db.end();}
  });

  it('keeps member-contact records and their versions inside a manageable unit container',async()=>{
    const ids={};
    const save="select public.save_scoped_institutional_record($1,'member_contact','Fictional unit contact','Fictional private body',now(),'staff','save',false,null,$2,'[]'::jsonb,$3,null) v";
    const seeded=async(name,unit,actor='admin')=>{
      await as(actor);
      const row=await one(save,[null,null,unit]);
      ids[name]=row.id;
      return row;
    };
    await seeded('a',f.unitA);
    await seeded('b',f.unitB);
    await seeded('unscoped',null);
    await seeded('foreign',null,'foreignCoordinator');
    const selected=()=>one('select public.get_institutional_records_workspace() v');
    await owner();
    await migrateLegacyStewardFixtures(db);
    await as('steward');
    expect((await selected()).records.map(row=>row.id).sort()).toEqual([ids.a,ids.b,ids.unscoped].sort());
    await db.query('savepoint broad_contact_control');
    expect((await one(save,[ids.unscoped,1,null])).version).toBe(2);
    await db.query('rollback to savepoint broad_contact_control');
    await scope();
    expect((await selected()).records.map(row=>row.id)).toEqual([ids.a]);
    expect((await selected()).records[0].versions).toEqual([expect.objectContaining({record_type:'member_contact',version:1})]);
    expect((await db.query('select id from public.chapter_records where id=any($1::uuid[])',[Object.values(ids)])).rows).toEqual([{id:ids.a}]);
    expect(await one("select has_table_privilege('authenticated','public.chapter_record_versions','select') v")).toBe(false);
    expect((await one(save,[ids.a,1,f.unitA])).version).toBe(2);
    const created=await one(save,[null,null,f.unitA]);
    expect(created.access_unit_id).toBe(f.unitA);
    expect((await selected()).records.find(row=>row.id===ids.a).versions.map(row=>row.version)).toEqual([2,1]);
    const missing=await denied(save,[randomUUID(),1,f.unitA]);
    expect(missing).toMatchObject({code:'P0002',message:'record not found'});
    for(const name of ['b','unscoped','foreign']){
      expect(await denied(save,[ids[name],1,f.unitA])).toEqual(missing);
    }
    for(const unit of [f.unitB,null]){
      const absent=await denied(save,[randomUUID(),1,unit]);
      expect(await denied(save,[ids.b,1,unit])).toEqual(absent);
      await denied(save,[null,null,unit]);
    }
    await as('a');
    expect((await selected()).records).toEqual([]);
    expect((await db.query('select id from public.chapter_records where id=any($1::uuid[])',[Object.values(ids)])).rows).toEqual([]);
    await denied(save,[null,null,f.unitA]);
    await as('steward','aal1');
    await denied('select public.get_institutional_records_workspace()');
    await denied(save,[ids.a,2,f.unitA]);
    await as('admin');
    expect((await selected()).records.map(row=>row.id)).toContain(ids.unscoped);
    expect((await one(save,[ids.unscoped,1,null])).version).toBe(2);
    await one("select public.set_chapter_role_capability($1,'steward','records',false) v",[f.chapter]);
    await as('steward');
    expect((await selected()).records).toEqual([]);
    await denied(save,[ids.a,2,f.unitA]);
  });

  it('keeps old member-contact versions private from a records-only officer after a type change',async()=>{
    await as('admin');
    const save="select public.save_scoped_institutional_record($1,$2,'Fictional converted record',case when $2='member_contact' then 'Fictional secret contact snapshot' else 'Fictional current minutes' end,now(),'staff','save',false,null,$3,'[]'::jsonb,$4,null) v";
    const record=await one(save,[null,'member_contact',null,f.unitA]);
    await one(save,[record.id,'minutes',1,f.unitA]);
    await one("select public.set_member_access_role($1,$2,'secretary',true,$3,null) v",[f.people.a.id,f.chapter,f.unitA]);
    await as('a');
    expect(await one('select private.chapter_record_manageable($1,$2,null) v',[f.chapter,f.unitA])).toBe(true);
    expect(await one('select private.can_read_chapter_contact_record($1) v',[f.chapter])).toBe(false);
    const office=await one('select public.get_institutional_records_workspace() v');
    expect(office.records.find(row=>row.id===record.id).versions.map(row=>row.version)).toEqual([2]);
    expect(JSON.stringify(office.records)).not.toContain('Fictional secret contact snapshot');
    await scope();
    const staff=await one('select public.get_institutional_records_workspace() v');
    expect(staff.records.find(row=>row.id===record.id).versions.map(row=>row.version)).toEqual([2,1]);
    expect(JSON.stringify(staff.records)).toContain('Fictional secret contact snapshot');
  });

  it.each(['workspace','direct rows','save','history'])('does not combine staff and records-only scopes for %s',async(boundary)=>{
    const save="select public.save_scoped_institutional_record($1,$2,'Fictional mixed-role record',$3,now(),'staff','save',false,null,$4,'[]'::jsonb,$5,null) v";
    await as('admin');
    const own=await one(save,[null,'member_contact','Fictional contact A',null,f.unitA]);
    const hidden=await one(save,[null,'member_contact','Fictional private contact B',null,f.unitB]);
    const history=await one(save,[null,'member_contact','Fictional secret history B',null,f.unitB]);
    await one(save,[history.id,'minutes','Fictional current minutes B',1,f.unitB]);
    const minutes=await one(save,[null,'minutes','Fictional ordinary minutes B',null,f.unitB]);
    await scope();
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'secretary',true,$3,null) v",[f.people.steward.id,f.chapter,f.unitB]);
    await as('steward');
    expect(await one('select private.can_read_chapter_contact_record($1) v',[f.chapter])).toBe(true);
    expect(await one('select private.chapter_record_manageable($1,$2,null) v',[f.chapter,f.unitB])).toBe(true);
    const workspace=await one('select public.get_institutional_records_workspace() v');
    expect(workspace.records.find(row=>row.id===own.id).versions).toEqual([expect.objectContaining({body:'Fictional contact A',version:1})]);
    expect(workspace.records.find(row=>row.id===minutes.id)).toMatchObject({canManage:true});
    expect((await one(save,[own.id,'member_contact','Fictional updated contact A',1,f.unitA])).version).toBe(2);
    expect((await one(save,[minutes.id,'minutes','Fictional updated minutes B',1,f.unitB])).version).toBe(2);
    if(boundary==='workspace'){
      expect(workspace.records.find(row=>row.id===hidden.id)).toBeUndefined();
    }else if(boundary==='direct rows'){
      expect((await db.query('select id from public.chapter_records where id=any($1::uuid[])',[[own.id,hidden.id]])).rows).toEqual([{id:own.id}]);
    }else if(boundary==='save'){
      const missing=await denied(save,[randomUUID(),'minutes','Fictional replacement',1,f.unitB]);
      expect(await denied(save,[hidden.id,'minutes','Fictional replacement',1,f.unitB])).toEqual(missing);
      await denied(save,[hidden.id,'member_contact','Fictional replacement',1,f.unitB]);
      await denied(save,[null,'member_contact','Fictional new contact B',null,f.unitB]);
      await denied(save,[own.id,'member_contact','Fictional moved contact A',2,f.unitB]);
      expect((await one(save,[null,'member_contact','Fictional new contact A',null,f.unitA])).access_unit_id).toBe(f.unitA);
    }else{
      const visible=workspace.records.find(row=>row.id===history.id);
      expect(visible).toBeTruthy();
      expect(visible.versions.map(row=>row.version)).toEqual([2]);
      expect(JSON.stringify(visible)).not.toContain('Fictional secret history B');
    }
  });

  it.each(['minutes','decision','milestone','management_contact'])('keeps foreign-unit contact history private after moving converted %s into the steward unit',async(type)=>{
    const record=await mixedHistory(type);
    const before=await one('select public.get_institutional_records_workspace() v');
    expect(before.records.find(row=>row.id===record.id).versions.map(row=>row.version)).toEqual([2]);
    const moved=await historySave(record.id,type,'Fictional A ordinary record',2,f.unitA);
    expect(moved).toMatchObject({access_unit_id:f.unitA,version:3});
    const after=await one('select public.get_institutional_records_workspace() v');
    const visible=after.records.find(row=>row.id===record.id);
    expect(visible.versions.map(row=>row.version)).toEqual([3,2]);
    expect(JSON.stringify(visible)).not.toContain('Fictional B contact before move');
    await as('admin');
    const broad=await one('select public.get_institutional_records_workspace() v');
    expect(broad.records.find(row=>row.id===record.id).versions.find(row=>row.version===1)).toMatchObject({
      body:'Fictional B contact before move',access_unit_id:f.unitB,access_committee_id:null,access_scope_captured:true,
    });
  });

  it('keeps committee contact provenance through a move and admits the covering staff assignment',async()=>{
    const committee=randomUUID();
    await owner();
    await db.query("insert into private.chapter_committees(id,chapter_id,name,purpose) values($1,$2,'Fictional B committee','History scope')",[committee,f.chapter]);
    const record=await mixedHistory('minutes',null,committee);
    await historySave(record.id,'minutes','Fictional A ordinary record',2,f.unitA);
    expect(JSON.stringify(await one('select public.get_institutional_records_workspace() v'))).not.toContain('Fictional B contact before move');
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'coordinator',true,null,$3) v",[f.people.steward.id,f.chapter,committee]);
    await as('steward');
    const allowed=await one('select public.get_institutional_records_workspace() v');
    expect(allowed.records.find(row=>row.id===record.id).versions.find(row=>row.version===1)).toMatchObject({
      body:'Fictional B contact before move',access_unit_id:null,access_committee_id:committee,access_scope_captured:true,
    });
  });

  it('keeps uncaptured contact history broad-staff-only and refuses direct snapshot reads or forgery',async()=>{
    const record=await mixedHistory();
    await historySave(record.id,'minutes','Fictional A ordinary record',2,f.unitA);
    await owner();
    // An old writer supplied no attested container. Even a guessed current
    // unit must not turn that unknown provenance into a captured scope.
    await db.query('update public.chapter_record_versions set access_scope_captured=false,access_unit_id=$2 where record_id=$1 and version=1',[record.id,f.unitA]);
    await as('steward');
    const hidden=await one('select public.get_institutional_records_workspace() v');
    expect(hidden.records.find(row=>row.id===record.id).versions.map(row=>row.version)).toEqual([3,2]);
    await denied('select body from public.chapter_record_versions where record_id=$1',[record.id]);
    await denied('update public.chapter_record_versions set access_scope_captured=true where record_id=$1',[record.id]);
    await as('admin');
    const broad=await one('select public.get_institutional_records_workspace() v');
    expect(broad.records.find(row=>row.id===record.id).versions.map(row=>row.version)).toEqual([3,2,1]);
  });

  it('keeps both legacy conversion wrappers behind the current contact source gate',async()=>{
    await mixedHistory();
    await as('admin');
    const hidden=await historySave(null,'member_contact','Fictional B current contact',null,f.unitB);
    await as('steward');
    const legacy="select public.save_institutional_record($1,'minutes','Fictional converted minutes','Fictional replacement',now(),'staff','save',false,null,1,'[]'::jsonb) v";
    const minutes="select public.save_chapter_minutes($1,'Fictional converted minutes','Fictional replacement',now(),'Fictional room','staff','save',false,null,1,'[]'::jsonb) v";
    for(const query of [legacy,minutes]) expect(await denied(query,[hidden.id])).toMatchObject({code:'P0002',message:'record not found'});
    expect(await denied("select public.update_chapter_record_content($1,'minutes','Fictional legacy bypass','Fictional replacement',now(),false)",[hidden.id])).toMatchObject({code:'42501'});
    const own=await historySave(null,'member_contact','Fictional A current contact',null,f.unitA);
    expect((await one(legacy,[own.id])).version).toBe(2);
    const workspace=await one('select public.get_institutional_records_workspace() v');
    expect(workspace.records.find(row=>row.id===own.id).versions.find(row=>row.version===2)).toMatchObject({access_unit_id:f.unitA,access_scope_captured:true});
  });

  it('keeps exports privileged and excludes current or historical member-contact bodies',async()=>{
    const record=await mixedHistory();
    await historySave(record.id,'minutes','Fictional A ordinary record',2,f.unitA);
    const query="select public.request_filtered_organization_export(array['minutes','timeline','contacts'],'json',null,null) v";
    expect(await denied(query)).toMatchObject({code:'42501',message:'organization export role required'});
    await as('admin');
    await historySave(null,'member_contact','Fictional current contact omitted from export',null,f.unitB);
    await historySave(null,'decision','Fictional ordinary exported decision',null,f.unitA);
    const exported=JSON.stringify(await one(query));
    expect(exported).toContain('Fictional ordinary exported decision');
    expect(exported).not.toContain('Fictional B contact before move');
    expect(exported).not.toContain('Fictional current contact omitted from export');
  });

  it('reopens moved archived minutes without restoring forbidden contact history',async()=>{
    const record=await mixedHistory();
    await as('admin');
    await historySave(record.id,'minutes','Fictional archived minutes',2,f.unitB,null,'archive');
    await as('steward');
    expect((await one('select public.get_institutional_records_workspace() v')).records.find(row=>row.id===record.id)).toBeUndefined();
    expect((await historySave(record.id,'minutes','Fictional reopened minutes',3,f.unitA)).version).toBe(4);
    const workspace=await one('select public.get_institutional_records_workspace() v');
    const visible=workspace.records.find(row=>row.id===record.id);
    expect(visible.versions.map(row=>row.version)).toEqual([4,3,2]);
    expect(JSON.stringify(visible)).not.toContain('Fictional B contact before move');
    expect(await denied("select public.save_scoped_institutional_record($1,'minutes','Fictional restore','Fictional body',now(),'staff','restore',false,null,4,'[]'::jsonb,$2,null)",[record.id,f.unitA])).toMatchObject({code:'22023',message:'invalid institutional record'});
  });

  it('admits the module but only exposes own-unit contacts, roster and attendance',async()=>{
    const minutes=randomUUID(),contactA=randomUUID(),contactB=randomUUID();
    await as('admin');await db.query('reset role');
    await db.query("insert into public.chapter_records(id,chapter_id,record_type,title,body,occurred_at,created_by,lifecycle_status,visibility) values($1,$2,'minutes','Fictional minutes','A chapter-wide draft',now(),$3,'draft','staff')",[minutes,f.chapter,f.people.admin.id]);
    await owner();
    await db.query("insert into public.meeting_attendance(record_id,chapter_id,user_id,attendance_status,recorded_by) values($1,$2,$3,'present',$5),($1,$2,$4,'present',$5)",[minutes,f.chapter,f.people.a.id,f.people.b.id,f.people.admin.id]);
    await db.query("insert into public.chapter_contact_log(id,organization_id,chapter_id,subject_user_id,contact_kind,channel,purpose,summary,occurred_at,created_by,updated_by) values($1,$3,$4,$5,'member','phone','Fictional A','A private contact',now(),$7,$7),($2,$3,$4,$6,'member','phone','Fictional B','B private contact',now(),$7,$7)",[contactA,contactB,f.org,f.chapter,f.people.a.id,f.people.b.id,f.people.admin.id]);
    await scope();
    expect(await one("select private.member_has_chapter_role($1,array['steward']) v",[f.chapter])).toBe(false);
    const workspace=await one('select public.get_institutional_records_workspace() v');
    expect(workspace.canManage).toBe(true);
    expect(workspace.canExport).toBe(false);
    expect(workspace.contacts.map(row=>row.id)).toEqual([contactA]);
    expect(workspace.roster.map(row=>row.userId)).toContain(f.people.a.id);
    expect(workspace.roster.map(row=>row.userId)).not.toContain(f.people.b.id);
    expect(workspace.roster.map(row=>row.userId)).not.toContain(f.people.foreign.id);
    expect(workspace.records.find(row=>row.id===minutes).attendance.map(row=>row.userId)).toEqual([f.people.a.id]);
    expect(await one("select private.chapter_staff_member_allowed($1,$2,array['steward']) v",[f.chapter,f.people.foreign.id])).toBe(false);
    await denied("select public.save_chapter_contact_log($1,'member','phone','Fictional','Edited',null,now(),null,$2,null,null,false)",[contactB,f.people.a.id]);
    const own=await one("select public.save_chapter_contact_log($1,'member','phone','Fictional','Edited',null,now(),null,$2,null,null,false) v",[contactA,f.people.a.id]);
    expect(own.subject_user_id).toBe(f.people.a.id);
  });

  it('preserves explicit organization-wide contact reads across sibling chapters while unit-only staff remain restricted',async()=>{
    const own=randomUUID(),foreign=randomUUID(),sibling='member-data-sibling-'+randomUUID();
    for(const [id,chapter,actor] of [[own,f.chapter,'admin'],[foreign,f.foreign,'foreignSteward']]){
      await as(actor);await db.query('reset role');
      await db.query("insert into public.chapter_records(id,chapter_id,record_type,title,body,occurred_at,created_by,lifecycle_status,visibility) values($1,$2,'member_contact','Fictional contact','Private legacy contact',now(),$3,'draft','staff')",[id,chapter,f.people[actor].id]);
    }
    await scope();
    expect((await db.query('select id from public.chapter_records where id=any($1::uuid[])',[[own,foreign]])).rows).toEqual([]);
    await owner();
    await db.query('insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9972)',[sibling,f.org]);
    await db.query('delete from public.member_role_chapters where user_id=$1',[f.people.steward.id]);
    await db.query('delete from public.member_roles where user_id=$1',[f.people.steward.id]);
    await db.query('delete from public.member_chapter_memberships where user_id=$1',[f.people.steward.id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[f.people.steward.id,sibling]);
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[f.people.steward.id,sibling]);
    // #8589 round 1: settle the removed chapter scope before the historical
    // organization grant exists; its own backfill then supplies the units.
    for(const {name} of (await db.query("select quote_ident(n.nspname)||'.'||quote_ident(c.conname) as name from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid=c.connamespace where c.conrelid='private.chapter_role_scopes'::regclass and c.condeferrable")).rows) await db.query('set constraints '+name+' immediate');
    await db.query('set constraints all deferred');
    await legacyStewardFixtureWrite(db,"insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')",[f.org,f.people.steward.id]);
    await as('steward');
    expect((await db.query('select id from public.chapter_records where id=any($1::uuid[])',[[own,foreign]])).rows.map(row=>row.id)).toEqual([own]);
    expect(await one("select private.member_has_chapter_role($1,array['steward']) v",[f.chapter])).toBe(false);
    expect(await one('select private.chapter_staff_member_allowed($1,$2,array[\'steward\']) v',[f.chapter,f.people.a.id])).toBe(true);
    expect(await one('select private.chapter_staff_member_allowed($1,$2,array[\'steward\']) v',[f.foreign,f.people.foreign.id])).toBe(false);
  });

  it('keeps another unit private record out of both the workspace and table even when the actor belongs to that unit',async()=>{
    const own=randomUUID(),hidden=randomUUID(),published=randomUUID();
    await as('admin');await db.query('reset role');
    await db.query("insert into public.chapter_records(id,chapter_id,record_type,title,body,occurred_at,created_by,lifecycle_status,visibility,access_unit_id,published_at) values($1,$4,'minutes','Fictional A minutes','A private draft',now(),$5,'draft','staff',$6,null),($2,$4,'minutes','Fictional B minutes','B private draft',now(),$5,'draft','staff',$7,null),($3,$4,'minutes','Fictional published B minutes','B published minutes',now(),$5,'published','chapter',$7,now())",[own,hidden,published,f.chapter,f.people.admin.id,f.unitA,f.unitB]);
    await scope();
    const recordIds=async()=>new Set((await one('select public.get_institutional_records_workspace() v')).records.map(row=>row.id));
    expect(await recordIds()).toEqual(new Set([own]));
    await as('admin');
    await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[f.chapter,f.people.steward.id,f.unitB]);
    await as('steward');
    expect(await one("select public.staff_can_see_user($1,'steward') v",[f.people.b.id])).toBe(false);
    expect(await recordIds()).toEqual(new Set([own,published]));
    const direct=(await db.query('select id from public.chapter_records where id=any($1::uuid[])',[[own,hidden,published]])).rows;
    expect(new Set(direct.map(row=>row.id))).toEqual(new Set([own,published]));
    await as('admin');
    expect(await recordIds()).toEqual(new Set([own,hidden,published]));
  });

  it('filters chapter-wide meeting check-ins and preserves hidden attendance on a save',async()=>{
    const event='unit-meeting-'+randomUUID(),minutes=randomUUID();
    await db.query("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id) values($1,'Fictional meeting',now()+interval '2 days','Hall','Meeting','SG-UNITTEST',(select coalesce(max(order_index),0)+1 from public.member_events),$2)",[event,f.chapter]);
    await as('admin');await db.query('reset role');
    await db.query("insert into public.chapter_records(id,chapter_id,record_type,title,body,occurred_at,created_by,lifecycle_status,visibility,event_id) values($1,$2,'minutes','Fictional minutes','Shared draft',now(),$3,'draft','staff',$4)",[minutes,f.chapter,f.people.admin.id,event]);
    await owner();
    await db.query('insert into public.member_event_checkins(event_id,user_id) values($1,$2),($1,$3)',[event,f.people.a.id,f.people.b.id]);
    await db.query("insert into public.meeting_attendance(record_id,chapter_id,user_id,attendance_status,recorded_by) values($1,$2,$3,'present',$4)",[minutes,f.chapter,f.people.b.id,f.people.admin.id]);
    await scope();
    expect((await one('select public.get_minutes_meeting_checkins($1) v',[minutes])).checkedIn).toEqual([f.people.a.id]);
    const query="select public.save_scoped_institutional_record($1,'minutes','Fictional minutes','Shared draft',now(),'staff','save',false,null,$2,$3::jsonb) v";
    await denied(query,[minutes,1,JSON.stringify([{userId:f.people.b.id,status:'absent'}])]);
    await denied(query,[minutes,1,JSON.stringify([{userId:f.people.foreign.id,status:'absent'}])]);
    const saved=await one(query,[minutes,1,JSON.stringify([{userId:f.people.a.id,status:'present'}])]);
    expect(saved.version).toBe(2);
    await owner();
    const attendance=(await db.query('select user_id,attendance_status from public.meeting_attendance where record_id=$1 order by user_id',[minutes])).rows;
    expect(attendance).toEqual(expect.arrayContaining([
      {user_id:f.people.a.id,attendance_status:'present'},
      {user_id:f.people.b.id,attendance_status:'present'},
    ]));
    expect(attendance).toHaveLength(2);
  });

  it('refuses organization exports for the scoped steward and keeps the admin export',async()=>{
    await scope();
    await denied("select public.request_filtered_organization_export(array['members'],'json')");
    await as('admin');
    expect(await one("select public.request_filtered_organization_export(array['members'],'json') v")).toBeTruthy();
  });

  it('limits seniority lists, questions, import matches and edits to own members',async()=>{
    await as('steward');
    const a=await one("select public.save_chapter_seniority_entry($1,$2,'2020-01-02','A',null) v",[f.chapter,f.people.a.id]);
    const b=await one("select public.save_chapter_seniority_entry($1,$2,'2020-01-01','B',null) v",[f.chapter,f.people.b.id]);
    await scope();
    const list=await one('select public.list_chapter_seniority($1) v',[f.chapter]);
    expect(list.items.map(row=>row.userId)).toEqual([f.people.a.id]);
    expect(list.items[0].position).toBe(2); // The member's official rank is unchanged.
    const found=await one("select public.search_chapter_seniority_members($1,'Fictional') v",[f.chapter]);
    expect(found.map(row=>row.userId)).toContain(f.people.a.id);
    expect(found.map(row=>row.userId)).not.toContain(f.people.b.id);
    await denied("select public.save_chapter_seniority_entry($1,$2,'2021-01-01','B',null)",[f.chapter,f.people.b.id]);
    await denied("select public.save_chapter_seniority_entry($1,$2,'2021-01-01','Foreign',null)",[f.chapter,f.people.foreign.id]);
    await denied('select public.delete_chapter_seniority_entry($1)',[b.id]);
    const imported=await one('select public.import_chapter_seniority($1,$2::jsonb,false) v',[f.chapter,JSON.stringify([
      {email:f.people.a.id+'@example.invalid',seniorityDate:'2020-01-01'},
      {email:f.people.b.id+'@example.invalid',seniorityDate:'2020-01-01'},
      {email:f.people.foreign.id+'@example.invalid',seniorityDate:'2020-01-01'},
    ])]);
    expect(imported.rows.map(row=>row.outcome)).toEqual(['ready','no_member','no_member']);
    expect((await one('select public.delete_chapter_seniority_entry($1) v',[a.id])).deleted).toBe(true);
  });

  it.each([
    ['steward',false],['steward',true],['coordinator',false],['coordinator',true],
  ])('preserves organization-wide %s seniority and bid authority with another chapter selected: %s',async(role,selected)=>{
    await as('steward');
    await one("select public.save_chapter_seniority_entry($1,$2,'2020-01-01','A',null) v",[f.chapter,f.people.a.id]);
    await one("select public.save_chapter_seniority_entry($1,$2,'2021-01-01','B',null) v",[f.chapter,f.people.b.id]);
    const window=await one("select public.save_chapter_bid_window(null,$1,'Fictional org shift',now()-interval '1 hour',now()+interval '2 days','open') v",[f.chapter]);
    await owner();
    const actor=f.people[role].id;
    await db.query('delete from public.member_role_chapters where user_id=$1',[actor]);
    await db.query('delete from public.member_roles where user_id=$1',[actor]);
    await db.query('delete from public.member_chapter_memberships where user_id=$1',[actor]);
    const sibling='member-data-sibling-'+randomUUID();
    if(selected){
      await db.query('insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9972)',[sibling,f.org]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[actor,sibling]);
    }
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[actor,selected?sibling:null]);
    await db.query('insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)',[f.org,actor,role]);
    // Retain the broad cleanup control, not a new grant.
    if(role==='steward') await migrateLegacyStewardFixtures(db);
    await as(role);
    expect((await one('select public.list_chapter_seniority($1) v',[f.chapter])).items).toHaveLength(2);
    expect((await one("select public.search_chapter_seniority_members($1,'Fictional b') v",[f.chapter])).map(row=>row.userId)).toContain(f.people.b.id);
    await one("select public.save_chapter_seniority_entry($1,$2,'2022-01-01','Updated B',null) v",[f.chapter,f.people.b.id]);
    const imported=await one('select public.import_chapter_seniority($1,$2::jsonb,false) v',[f.chapter,JSON.stringify([
      {email:f.people.b.id+'@example.invalid',seniorityDate:'2022-01-01'},
    ])]);
    expect(imported.rows[0].outcome).toBe('ready');
    const bid=await one("select public.record_chapter_bid($1,$2,'B') v",[window.id,f.people.b.id]);
    expect((await one('select public.list_chapter_bid_windows($1) v',[f.chapter])).windows[0].bidCount).toBe(1);
    expect((await one('select public.list_chapter_bid_window_bids($1) v',[window.id])).total).toBe(1);
    expect((await one("select public.award_chapter_bid($1,'Approved') v",[bid.id])).award).toBe('Approved');
    await denied('select public.list_chapter_seniority($1)',[f.foreign]);
    await denied("select public.save_chapter_seniority_entry($1,$2,'2022-01-01','Foreign',null)",[f.chapter,f.people.foreign.id]);
  });

  it('returns the same refusal for hidden, foreign and nonexistent seniority, bid and contact subjects',async()=>{
    await as('steward');
    const window=await one("select public.save_chapter_bid_window(null,$1,'Fictional private shift',now()-interval '1 hour',now()+interval '2 days','open') v",[f.chapter]);
    await scope();
    const subjects=[f.people.b.id,f.people.foreign.id,randomUUID()];
    for(const [query,args] of [
      ["select public.save_chapter_seniority_entry($1,$2,'2021-01-01','Hidden',null)",id=>[f.chapter,id]],
      ["select public.record_chapter_bid($1,$2,'Hidden')",id=>[window.id,id]],
      ["select public.save_chapter_contact_log(null,'member','phone','Fictional','Hidden',null,now(),null,$1,null,null,false)",id=>[id]],
    ]){
      const refusals=[];
      for(const id of subjects)refusals.push(await denied(query,args(id)));
      expect(refusals[0].code).toBe('42501');
      expect(refusals[1]).toEqual(refusals[0]);
      expect(refusals[2]).toEqual(refusals[0]);
    }
  });

  it('limits bid pages, counts, choice edits and awards to own members',async()=>{
    await as('steward');
    const window=await one("select public.save_chapter_bid_window(null,$1,'Fictional shift',now()-interval '1 hour',now()+interval '2 days','open') v",[f.chapter]);
    const a=await one("select public.record_chapter_bid($1,$2,'A') v",[window.id,f.people.a.id]);
    const b=await one("select public.record_chapter_bid($1,$2,'B') v",[window.id,f.people.b.id]);
    await scope();
    const windows=await one('select public.list_chapter_bid_windows($1) v',[f.chapter]);
    expect(windows.windows[0].bidCount).toBe(1);
    expect(windows.windows[0].bids.map(row=>row.userId)).toEqual([f.people.a.id]);
    const page=await one('select public.list_chapter_bid_window_bids($1) v',[window.id]);
    expect(page.total).toBe(1);
    expect(page.bids.map(row=>row.userId)).toEqual([f.people.a.id]);
    await denied("select public.record_chapter_bid($1,$2,'Other unit')",[window.id,f.people.b.id]);
    await denied("select public.record_chapter_bid($1,$2,'Other org')",[window.id,f.people.foreign.id]);
    await denied("select public.award_chapter_bid($1,'Not allowed')",[b.id]);
    expect((await one("select public.award_chapter_bid($1,'Allowed') v",[a.id])).award).toBe('Allowed');
  });

  const awardedBidFixture=async()=>{
    await as('steward');
    const window=await one("select public.save_chapter_bid_window(null,$1,'Fictional retained shift',now()-interval '1 hour',now()+interval '2 days','open') v",[f.chapter]);
    const bids={};
    for(const name of ['a','a2','b','b2']){
      bids[name]=await one("select public.record_chapter_bid($1,$2,'Original choice') v",[window.id,f.people[name].id]);
      await one("select public.award_chapter_bid($1,'Original award') v",[bids[name].id]);
    }
    return {window,bids};
  };
  const organizationBidActor=async(role,selected=false)=>{
    await owner();const actor=f.people[role].id;
    await db.query('delete from public.member_role_chapters where user_id=$1',[actor]);
    await db.query('delete from public.member_roles where user_id=$1',[actor]);
    await db.query('delete from public.member_chapter_memberships where user_id=$1',[actor]);
    const sibling=selected?'retained-bid-sibling-'+randomUUID():null;
    if(sibling){
      await db.query('insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9972)',[sibling,f.org]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[actor,sibling]);
    }
    await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[actor,sibling]);
    await db.query('insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)',[f.org,actor,role]);
    // Preserve the existing broad-grant control.
    if(role==='steward') await migrateLegacyStewardFixtures(db);
    await as(role);
    expect(await one('select private.member_has_chapter_role($1,array[$2]) v',[f.chapter,role])).toBe(false);
  };

  it('0810 retained bid: broad chapter and organization staff clear an inactive award without changing read scope',async()=>{
    const {window,bids}=await awardedBidFixture();
    await owner();
    await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where chapter_id=$1 and user_id=any($2::uuid[])",[f.chapter,['a','a2','b','b2'].map(name=>f.people[name].id)]);
    for(const [role,organization,subject,award] of [['steward',false,'a',null],['coordinator',false,'b',null],['steward',true,'a2',null],['coordinator',true,'b2','   ']]){
      if(organization)await organizationBidActor(role,role==='coordinator');else await as(role);
      expect(await one('select private.chapter_seniority_member_allowed($1,$2) v',[f.chapter,f.people[subject].id])).toBe(false);
      const before=await one('select public.list_chapter_bid_window_bids($1) v',[window.id]);
      expect(await one('select public.award_chapter_bid($1,$2) v',[bids[subject].id,award])).toEqual({id:bids[subject].id,award:null});
      const after=await one('select public.list_chapter_bid_window_bids($1) v',[window.id]);
      expect({ids:after.bids.map(row=>row.id),total:after.total}).toEqual({ids:before.bids.map(row=>row.id),total:before.total});
      expect(await one('select private.chapter_seniority_member_allowed($1,$2) v',[f.chapter,f.people[subject].id])).toBe(false);
      await owner();
      expect((await db.query('select award,awarded_at from private.chapter_bid_entries where id=$1',[bids[subject].id])).rows).toEqual([{award:null,awarded_at:null}]);
    }
  });

  it('0810 retained bid: unit staff cannot clear inactive subjects even in their former unit',async()=>{
    const {bids}=await awardedBidFixture();
    await owner();
    await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where chapter_id=$1 and user_id=any($2::uuid[])",[f.chapter,[f.people.a.id,f.people.b.id]]);
    await scope();
    expect(await one("select private.member_has_chapter_role($1,array['steward','coordinator']) v",[f.chapter])).toBe(false);
    for(const name of ['a','b'])expect((await denied('select public.award_chapter_bid($1,null)',[bids[name].id])).code).toBe('42501');
    await as('foreignSteward');
    expect((await denied('select public.award_chapter_bid($1,null)',[bids.a.id])).code).toBe('42501');
    await owner();
    const rows=(await db.query('select award,awarded_at is not null as dated from private.chapter_bid_entries where id=any($1::uuid[])',[[bids.a.id,bids.b.id]])).rows;
    expect(rows).toEqual([{award:'Original award',dated:true},{award:'Original award',dated:true}]);
  });

  it('0810 retained bid: inactive subjects cannot receive new or changed bids or awards',async()=>{
    const {window,bids}=await awardedBidFixture();
    await one('select public.award_chapter_bid($1,null) v',[bids.b2.id]);
    await owner();
    await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where chapter_id=$1 and user_id=any($2::uuid[])",[f.chapter,[f.people.a3.id,f.people.b.id,f.people.b2.id]]);
    for(const organization of [false,true]){
      if(organization)await organizationBidActor('steward');else await as('steward');
      for(const name of ['a3','b'])expect(await denied("select public.record_chapter_bid($1,$2,'Changed choice')",[window.id,f.people[name].id])).toMatchObject({code:'22023',detail:'seniority_member_required'});
      expect((await denied("select public.award_chapter_bid($1,'Changed award')",[bids.b.id])).code).toBe('42501');
      expect((await denied('select public.award_chapter_bid($1,null)',[bids.b2.id])).code).toBe('42501');
      expect((await denied('select public.award_chapter_bid($1,null)',[randomUUID()])).code).toBe('42501');
    }
    await owner();
    expect((await db.query('select choice,award from private.chapter_bid_entries where id=$1',[bids.b.id])).rows).toEqual([{choice:'Original choice',award:'Original award'}]);
    expect(await one('select count(*)::integer v from private.chapter_bid_entries where window_id=$1 and user_id=$2',[window.id,f.people.a3.id])).toBe(0);
  });

  it('0810 retained bid: active-subject awards still follow the existing member restriction',async()=>{
    const {bids}=await awardedBidFixture();
    expect((await one("select public.award_chapter_bid($1,'Broad update') v",[bids.b.id])).award).toBe('Broad update');
    await scope();
    expect((await one("select public.award_chapter_bid($1,'Unit update') v",[bids.a.id])).award).toBe('Unit update');
    expect((await one('select public.award_chapter_bid($1,null) v',[bids.a.id])).award).toBeNull();
    expect((await denied('select public.award_chapter_bid($1,null)',[bids.b.id])).code).toBe('42501');
    expect((await denied("select public.award_chapter_bid($1,'Other unit')",[bids.b.id])).code).toBe('42501');
  });

  it('records access only for a member admitted by the actual actor role',async()=>{
    await scope();
    const good=await one("select public.record_member_access_event($1,$2,'viewed_profile','member',null) v",[f.org,f.people.a.id]);
    expect(good.ok).toBe(true);
    await denied("select public.record_member_access_event($1,$2,'viewed_profile','member',null)",[f.org,f.people.b.id]);
    await denied("select public.record_member_access_event($1,$2,'viewed_profile','member',null)",[f.org,f.people.foreign.id]);
    await as('steward','aal1');
    await denied("select public.record_member_access_event($1,$2,'viewed_profile','member',null)",[f.org,f.people.a.id]);
  });

  it('filters actual appointment desk and pager rows, totals and statistics by current member authority',async()=>{
    const ids={};
    for(const [name,person,chapter,status,days] of [
      ['a','a',f.chapter,'confirmed',10],['b','b',f.chapter,'confirmed',11],
      ['foreign','foreign',f.foreign,'confirmed',12],
      ['doneA','a',f.chapter,'completed',-4],['doneB','b',f.chapter,'completed',-5],
      ['missA','a',f.chapter,'no_show',-6],['missB','b',f.chapter,'no_show',-7],
      ['doneForeign','foreign',f.foreign,'completed',-8],
    ]){
      ids[name]=randomUUID();
      await db.query("insert into public.member_appointments(id,user_id,steward_id,chapter_id,appointment_type,duration_minutes,starts_at,ends_at,status,routed_via,reason_category,place) values($1,$2,$3,$4,'office_hours',30,now()+$5*interval '1 day',now()+$5*interval '1 day'+interval '30 minutes',$6,'steward','general',$7)",[ids[name],f.people[person].id,f.people.steward.id,chapter,days,status,'Fictional '+name+' office']);
    }
    await scope();
    const desk=await one('select public.get_steward_appointments() v');
    expect(desk.upcoming.map(row=>row.id)).toEqual([ids.a]);
    expect(desk.upcoming[0].place).toBe('Fictional a office');
    expect(desk.upcomingTotal).toBe(1);
    expect(desk.recent.map(row=>row.id)).toEqual([ids.doneA,ids.missA]);
    expect(desk.recentTotal).toBe(2);
    expect(desk.stats).toEqual({noShows30d:1,completed30d:1});
    const upcoming=(await db.query("select * from public.list_steward_appointments('upcoming',null,null,1)")).rows;
    expect(upcoming.map(row=>row.id)).toEqual([ids.a]);
    expect(upcoming[0].total_count).toBe('1');
    const recent=(await db.query("select * from public.list_steward_appointments('recent',null,null,1)")).rows;
    expect(recent.map(row=>row.id)).toEqual([ids.doneA]);
    expect(recent[0].total_count).toBe('2');
    const next=(await db.query("select * from public.list_steward_appointments('recent',$1,$2,1)",[recent[0].starts_at,recent[0].id])).rows;
    expect(next.map(row=>row.id)).toEqual([ids.missA]);
    expect(next[0].total_count).toBe('2');
    await as('steward','aal1');
    await denied('select public.get_steward_appointments()');
    await denied('select * from public.list_steward_appointments()');
  });

  it('keeps stale appointment assignments from exposing another unit in any appointment gate',async()=>{
    const ids={};
    for(const [name,person,days,steward,chapter] of [
      ['a','a',12,'steward',f.chapter],['b','b',13,'steward',f.chapter],
      ['moveA','a',16,'steward',f.chapter],
      ['pastA','a',-12,'steward',f.chapter],['pastB','b',-13,'steward',f.chapter],
      ['foreign','foreign',14,'foreignSteward',f.foreign],
    ]){
      ids[name]=randomUUID();
      await db.query("insert into public.member_appointments(id,user_id,steward_id,chapter_id,appointment_type,duration_minutes,starts_at,ends_at,status,routed_via,reason_category) values($1,$2,$3,$4,'office_hours',30,now()+$5*interval '1 day',now()+$5*interval '1 day'+interval '30 minutes','confirmed','steward','general')",[ids[name],f.people[person].id,f.people[steward].id,chapter,days]);
      await db.query("insert into public.member_appointment_events(appointment_id,actor,action) values($1,$2,'booked')",[ids[name],f.people[person].id]);
    }
    await db.query("insert into public.member_appointment_schedules(steward_id,timezone,min_notice_minutes,buffer_before_minutes,buffer_after_minutes,max_per_day,accepting) values($1,'America/New_York',0,0,0,24,true)",[f.people.steward.id]);
    for(let weekday=0;weekday<7;weekday++){
      await db.query('insert into public.member_appointment_windows(steward_id,weekday,start_minute,end_minute) values($1,$2,0,1440)',[f.people.steward.id,weekday]);
    }
    const nextSlot=await one('select slot_start v from private.appointment_slots_for($1,30,current_date+15,current_date+15) order by slot_start limit 1',[f.people.steward.id]);
    expect(nextSlot).toBeTruthy();
    await as('steward');
    await one("select public.set_appointment_note($1,'Own note') v",[ids.a]);
    await one("select public.set_appointment_note($1,'Other unit note') v",[ids.b]);
    await scope();
    const rows=(await db.query('select id from public.member_appointments where id=any($1::uuid[])',[[ids.a,ids.b,ids.foreign]])).rows;
    expect(rows.map(row=>row.id)).toEqual([ids.a]);
    const history=await one('select public.get_appointment_history($1) v',[ids.a]);
    expect(history.appointment.id).toBe(ids.a);
    await denied('select public.get_appointment_history($1)',[ids.b]);
    await denied('select public.get_appointment_history($1)',[ids.foreign]);
    expect((await one('select public.reschedule_appointment($1,$2::timestamptz) v',[ids.moveA,nextSlot])).rescheduledFrom).toBe(ids.moveA);
    const notes=await one('select public.get_appointment_notes($1::uuid[]) v',[[ids.a,ids.b,ids.foreign]]);
    expect(notes.map(row=>row.appointmentId)).toEqual([ids.a]);
    await denied("select public.set_appointment_note($1,'Blocked')",[ids.b]);
    await denied("select public.set_appointment_note($1,'Blocked')",[ids.foreign]);
    await denied('select public.reschedule_appointment($1,now()+interval \'15 days\')',[ids.b]);
    await denied("select public.mark_appointment_outcome($1,'completed')",[ids.pastB]);
    expect((await one("select public.mark_appointment_outcome($1,'completed') v",[ids.pastA])).status).toBe('completed');
    await denied('select public.cancel_appointment($1)',[ids.b]);
    await denied('select public.cancel_appointment($1)',[ids.foreign]);
    expect((await one('select public.cancel_appointment($1) v',[ids.a])).status).toBe('cancelled');
  });

  it('keeps the case oracle on management entries, addenda and access-grant management',async()=>{
    const cases={},entries={};
    await db.query("insert into public.chapter_workstreams(chapter_id,name) values($1,'General') on conflict do nothing",[f.chapter]);
    for(const name of ['a','b','foreign']){
      const foreign=name==='foreign',chapter=foreign?f.foreign:f.chapter,org=foreign?f.foreignOrg:f.org;
      const staff=foreign?f.people.foreignSteward.id:f.people.steward.id;
      cases[name]=randomUUID();
      await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id) values($1::uuid,$2,$1::text,$3,'other',$4)",[cases[name],f.people[name].id,'Fictional '+name+' case',staff]);
      const person=(await db.query("insert into public.casework_management_people(organization_id,chapter_id,display_name,created_by) values($1,$2,'Fictional management contact',$3) returning id",[org,chapter,staff])).rows[0].id;
      entries[name]=(await db.query("insert into public.casework_management_entries(management_person_id,case_id,organization_id,chapter_id,occurred_at,category,summary,created_by) values($1,$2,$3,$4,now(),'other','Fictional management interaction',$5) returning id",[person,cases[name],org,chapter,staff])).rows[0].id;
    }
    const grants={};
    for(const name of ['a','b','foreign']){
      grants[name]=(await db.query("insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason) values($1,$2,$3,$4,$5,'Fictional review') returning id",[cases[name],name==='foreign'?f.foreignOrg:f.org,name==='foreign'?f.foreign:f.chapter,name==='foreign'?f.people.foreignCoordinator.id:f.people.coordinator.id,name==='foreign'?f.people.foreignSteward.id:f.people.admin.id])).rows[0].id;
    }
    await scope();
    expect((await one("select to_jsonb(public.casework_grant_access($1,$2,'Fictional authorized review')) v",[cases.a,f.people.coordinator.id])).case_id).toBe(cases.a);
    await denied("select public.casework_grant_access($1,$2,'Fictional unauthorized review')",[cases.b,f.people.coordinator.id]);
    await denied("select public.casework_grant_access($1,$2,'Fictional unauthorized review')",[cases.foreign,f.people.coordinator.id]);
    const rows=(await db.query('select id from public.casework_management_entries where id=any($1::uuid[])',[Object.values(entries)])).rows;
    expect(rows.map(row=>row.id)).toEqual([entries.a]);
    expect((await one("select to_jsonb(public.casework_add_management_addendum($1,'Own unit note')) v",[entries.a])).entry_id).toBe(entries.a);
    await denied("select public.casework_add_management_addendum($1,'Other unit note')",[entries.b]);
    await denied("select public.casework_add_management_addendum($1,'Other organization note')",[entries.foreign]);
    expect((await db.query('select * from public.casework_case_history($1,100,null)',[cases.a])).rows.length).toBeGreaterThan(0);
    for(const name of ['b','foreign']){
      expect((await db.query('select * from public.casework_case_history($1,100,null)',[cases[name]])).rows).toEqual([]);
      await denied('select public.casework_revoke_access($1)',[grants[name]]);
      await denied("select public.create_chapter_task_from_source('case',$1)",[cases[name]]);
    }
    expect((await one('select to_jsonb(public.casework_revoke_access($1)) v',[grants.a])).revoked_at).toBeTruthy();
    expect((await one("select public.create_chapter_task_from_source('case',$1) v",[cases.a])).attachment.source_id).toBe(cases.a);
    expect((await one('select to_jsonb(public.casework_save_intake_draft(null,$1,$2,$3,$4::jsonb,0)) v',[f.chapter,f.people.a.id,cases.a,JSON.stringify({note:'Own case'})])).case_id).toBe(cases.a);
    await denied('select public.casework_save_intake_draft(null,$1,$2,$3,$4::jsonb,0)',[f.chapter,f.people.a.id,cases.b,JSON.stringify({note:'Other unit case'})]);
  });

  it('counts civic residences only within the unit and preserves the minimum cohort',async()=>{
    const geoA='test-'+randomUUID(),geoB='test-'+randomUUID();
    await db.query("insert into public.civic_places(geoid,kind,name,state,source,retrieved_at) values($1,'place','Fictional A town','MA','fictional regression',now()),($2,'place','Fictional B town','MA','fictional regression',now())",[geoA,geoB]);
    for(const name of ['a','a2','a3','b','b2','b3','foreign']){
      await db.query('insert into public.civic_user_places(user_id,geoid,resolved_at) values($1,$2,now())',[f.people[name].id,name.startsWith('b')?geoB:geoA]);
    }
    await scope();
    expect(await one('select public.civic_is_org_officer($1) v',[f.chapter])).toBe(true);
    const rows=(await db.query('select * from public.civic_member_place_counts($1)',[f.chapter])).rows;
    expect(rows.map(row=>row.geoid)).toEqual([geoA]);
    expect(Number(rows[0].members)).toBe(3);
    await denied('select * from public.civic_member_place_counts($1)',[f.foreign]);
    await owner();
    await db.query('delete from public.civic_user_places where user_id=$1',[f.people.a3.id]);
    await as('steward');
    expect((await db.query('select * from public.civic_member_place_counts($1)',[f.chapter])).rows).toEqual([]);
  });

  it('counts civic campaign participation only for visible members',async()=>{
    const campaign=randomUUID();
    await db.query("insert into public.civic_campaigns(id,org_id,title,topic,status,created_by) values($1,$2,'Fictional campaign','Fictional issue','active',$3)",[campaign,f.chapter,f.people.steward.id]);
    for(const name of ['a','b','foreign']){
      await db.query("insert into public.civic_member_messages(campaign_id,user_id,official_key,official_name,office,channel,status) values($1,$2,$3,'Fictional official','Fictional office','letter','sent')",[campaign,f.people[name].id,'test-official-'+name]);
    }
    await scope();
    const rows=(await db.query('select * from public.civic_campaign_stats_for_org($1)',[f.chapter])).rows;
    expect(rows).toEqual([{campaign_id:campaign,messages_sent:'1',messages_drafted:'0',members_participating:'1',officials_contacted:'1'}]);
    await denied('select * from public.civic_campaign_stats_for_org($1)',[f.foreign]);
    await as('admin');
    expect((await db.query('select * from public.civic_campaign_stats_for_org($1)',[f.chapter])).rows[0].messages_sent).toBe('2');
  });

  it('keeps owner-only intake drafts inside their member and case scopes',async()=>{
    await scope();
    const own=await one('select to_jsonb(public.casework_save_intake_draft(null,$1,$2,null,$3::jsonb,0)) v',[f.chapter,f.people.a.id,JSON.stringify({note:'Own unit draft'})]);
    expect(own.member_user_id).toBe(f.people.a.id);
    await denied('select public.casework_save_intake_draft(null,$1,$2,null,$3::jsonb,0)',[f.chapter,f.people.b.id,JSON.stringify({note:'Other unit'})]);
    await denied('select public.casework_save_intake_draft(null,$1,$2,null,$3::jsonb,0)',[f.chapter,f.people.foreign.id,JSON.stringify({note:'Other organization'})]);
    const drafts=(await db.query('select id from public.casework_intake_drafts')).rows;
    expect(drafts.map(row=>row.id)).toEqual([own.id]);
  });

  it('G6-8054-1 keeps detached cases private through entry, addendum, insert and RPC paths',async()=>{
    const cases={},entries={},addenda={};
    for(const name of ['a','b','foreign']){
      const foreign=name==='foreign',chapter=foreign?f.foreign:f.chapter,org=foreign?f.foreignOrg:f.org;
      const staff=foreign?f.people.foreignSteward.id:f.people.steward.id;
      cases[name]=randomUUID();
      await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id) values($1::uuid,$2,$1::text,$3,'other',$4)",[cases[name],f.people[name].id,'Fictional retained '+name,staff]);
      const person=(await db.query("insert into public.casework_management_people(organization_id,chapter_id,display_name,created_by) values($1,$2,'Fictional retained manager',$3) returning id",[org,chapter,staff])).rows[0].id;
      entries[name]=(await db.query("insert into public.casework_management_entries(management_person_id,case_id,organization_id,chapter_id,occurred_at,category,summary,created_by) values($1,$2,$3,$4,now(),'other',$5,$6) returning id",[person,cases[name],org,chapter,'Fictional retained '+name,staff])).rows[0].id;
      addenda[name]=(await db.query("insert into public.casework_management_addenda(entry_id,organization_id,body,created_by) values($1,$2,'Fictional retained note',$3) returning id",[entries[name],org,staff])).rows[0].id;
    }
    await db.query('delete from public.member_cases where id=any($1::uuid[])',[Object.values(cases)]);
    expect((await db.query('select id from public.casework_management_entries where id=any($1::uuid[]) and case_id is null',[Object.values(entries)])).rows).toHaveLength(3);
    expect((await db.query("select record_id from private.account_lifecycle_history_scope where kind='management_entry' and record_id=any($1::text[])",[Object.values(entries)])).rows).toHaveLength(3);
    await scope();
    expect(await one("select private.account_lifecycle_retained_case_scope_allows('management_entry',$1,$2) v",[entries.a,f.chapter])).toBe(true);
    expect.soft(await one("select private.account_lifecycle_retained_case_scope_allows('management_entry',$1,$2) v",[entries.b,f.chapter])).toBe(false);
    expect(await one("select private.account_lifecycle_retained_case_scope_allows('management_entry',$1,$2) v",[randomUUID(),f.chapter])).toBeNull();
    expect.soft((await db.query('select id from public.casework_management_entries where id=any($1::uuid[])',[Object.values(entries)])).rows.map(row=>row.id)).toEqual([entries.a]);
    expect.soft((await db.query('select id from public.casework_management_addenda where id=any($1::uuid[])',[Object.values(addenda)])).rows.map(row=>row.id)).toEqual([addenda.a]);
    expect((await one("select to_jsonb(public.casework_add_management_addendum($1,'Fictional allowed retained note')) v",[entries.a])).entry_id).toBe(entries.a);
    for(const name of ['b','foreign']){
      await denied("select public.casework_add_management_addendum($1,'Fictional refused retained note')",[entries[name]]);
      await denied("insert into public.casework_management_addenda(entry_id,organization_id,body,created_by) values($1,$2,'Fictional refused direct note',auth.uid())",[entries[name],name==='foreign'?f.foreignOrg:f.org]);
    }
    expect(await one("select has_table_privilege('authenticated','public.casework_management_addenda','insert') v")).toBe(false);
    await denied("insert into public.casework_management_addenda(entry_id,organization_id,body,created_by) values($1,$2,'Direct writes stay disabled',auth.uid())",[entries.a,f.org]);
  });

  it.each(['member','case'])('G6-8054-2 excludes an old intake-draft %s snapshot after narrowing',async(kind)=>{
    const cases={};
    for(const name of ['a','b']){
      cases[name]=randomUUID();
      await db.query("insert into public.member_cases(id,user_id,reference,title,case_type,steward_user_id) values($1::uuid,$2,$1::text,$3,'other',$4)",[cases[name],f.people[name].id,'Fictional history '+name,f.people.steward.id]);
    }
    const hidden='Fictional hidden '+kind+' snapshot';
    await as('steward');
    const old=await one('select to_jsonb(public.casework_save_intake_draft(null,$1,$2,$3,$4::jsonb,0)) v',[f.chapter,kind==='member'?f.people.b.id:null,kind==='case'?cases.b:cases.a,JSON.stringify({note:hidden})]);
    await one('select to_jsonb(public.casework_save_intake_draft($1,$2,$3,$4,$5::jsonb,$6)) v',[old.id,f.chapter,f.people.a.id,cases.a,JSON.stringify({note:'Fictional visible new snapshot'}),old.revision]);
    await scope();
    const allowed=await one('select to_jsonb(public.casework_save_intake_draft(null,$1,$2,$3,$4::jsonb,0)) v',[f.chapter,f.people.a.id,cases.a,JSON.stringify({note:'Fictional allowed history control'})]);
    expect((await db.query('select payload from public.casework_intake_drafts where id=$1',[old.id])).rows).toEqual([{payload:{note:'Fictional visible new snapshot'}}]);
    const check=rows=>{
      const data=JSON.stringify(rows);
      expect(data).toContain('Fictional allowed history control');
      expect(data).not.toContain(hidden);
      expect(data).not.toContain(kind==='member'?f.people.b.id:cases.b);
    };
    check((await db.query('select * from public.casework_case_history($1,100,null)',[cases.a])).rows);
    // The same definer is also an independently callable history path.
    await db.query('reset role');
    check((await db.query('select * from private.casework_history_versions($1)',[cases.a])).rows);
    expect(allowed.id).toBeTruthy();
  });

  it('G6-8054-3 refuses new and existing minutes when the scoped records capability is disabled',async()=>{
    const record=randomUUID();
    await as('admin');await db.query('reset role');
    await db.query("insert into public.chapter_records(id,chapter_id,record_type,title,body,occurred_at,created_by,lifecycle_status,visibility,access_unit_id) values($1,$2,'minutes','Fictional restricted minutes','Fictional body',now(),$3,'draft','staff',$4)",[record,f.chapter,f.people.admin.id,f.unitA]);
    await scope();
    expect(await one('select private.chapter_record_manageable($1,$2,null) v',[f.chapter,f.unitA])).toBe(true);
    await as('admin');
    await one("select public.set_chapter_role_capability($1,'steward','records',false) v",[f.chapter]);
    await as('steward');
    expect.soft(await one('select private.chapter_record_manageable($1,$2,null) v',[f.chapter,f.unitA])).toBe(false);
    expect.soft(await one('select private.chapter_record_manageable($1,null,null) v',[f.chapter])).toBe(false);
    const save="select public.save_scoped_institutional_record($1,'minutes','Fictional restricted minutes','Fictional edit',now(),'staff','save',false,null,$2,'[]'::jsonb,$3,null) v";
    await denied(save,[null,null,f.unitA]);
    await denied(save,[record,1,f.unitA]);
    await denied('select public.get_minutes_meeting_checkins($1)',[record]);
    await as('admin');
    await one("select public.set_chapter_role_capability($1,'steward','records',true) v",[f.chapter]);
    await as('steward');
    expect((await one(save,[record,1,f.unitA])).version).toBe(2);
  });

  it('G6-8054-3 does not borrow an enabled role capability for a different disabled role scope',async()=>{
    await scope(); await as('admin');
    await one("select public.set_member_access_role($1,$2,'coordinator',true,$3,null) v",[f.people.steward.id,f.chapter,f.unitB]);
    await one("select public.set_chapter_role_capability($1,'coordinator','records',false) v",[f.chapter]);
    await as('steward');
    expect(await one('select private.chapter_record_manageable($1,$2,null) v',[f.chapter,f.unitA])).toBe(true);
    expect(await one('select private.chapter_record_manageable($1,$2,null) v',[f.chapter,f.unitB])).toBe(false);
  });

  it('G6-8054-4 preserves broad staff cleanup of retained seniority without opening scoped cleanup',async()=>{
    await as('steward');
    const gone=await one("select public.save_chapter_seniority_entry($1,$2,'2019-01-01','Fictional retained rank',null) v",[f.chapter,f.people.b.id]);
    await one("select public.save_chapter_seniority_entry($1,$2,'2020-01-01','Fictional current rank',null) v",[f.chapter,f.people.a.id]);
    await owner();
    await db.query("update public.member_chapter_memberships set status='revoked',revoked_at=now() where user_id=$1 and chapter_id=$2",[f.people.b.id,f.chapter]);
    await as('steward');
    const broad=await one('select public.list_chapter_seniority($1) v',[f.chapter]);
    expect.soft(broad.items.map(row=>row.id)).toContain(gone.id);
    // Preserve the broad-steward positive control before permanent unit choice.
    await db.query("savepoint broad_cleanup");
    expect((await one("select public.delete_chapter_seniority_entry($1) v",[gone.id])).deleted).toBe(true);
    await db.query("rollback to savepoint broad_cleanup");
    await db.query("release savepoint broad_cleanup");
    await scope();
    expect((await one('select public.list_chapter_seniority($1) v',[f.chapter])).items.map(row=>row.id)).not.toContain(gone.id);
    await denied('select public.delete_chapter_seniority_entry($1)',[gone.id]);
    // Unit choice is permanent; broad coordinator
    // cleanup remains supported without restoring the steward's carry-over.
    await as('coordinator');
    expect((await one('select public.delete_chapter_seniority_entry($1) v',[gone.id])).deleted).toBe(true);
    const after=await one('select public.list_chapter_seniority($1) v',[f.chapter]);
    expect(after.items.map(row=>row.userId)).toEqual([f.people.a.id]);
    expect(after.items[0].position).toBe(1);
  });

  it('does not turn the private member oracle into a PUBLIC executable function',async()=>{
    for(const signature of [
      'private.chapter_staff_member_allowed(text,uuid,text[])',
      'private.chapter_records_member_allowed(text,uuid)',
      'private.chapter_contact_entry_allowed(text,uuid,uuid)',
      'private.chapter_seniority_member_allowed(text,uuid)',
    ]){
      expect(await one("select has_function_privilege('anon',$1,'execute') v",[signature])).toBe(false);
      expect(await one("select has_function_privilege('service_role',$1,'execute') v",[signature])).toBe(false);
      expect(await one("select has_function_privilege('authenticated',$1,'execute') v",[signature])).toBe(true);
    }
  });
});
