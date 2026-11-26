// @vitest-environment node
import {randomUUID, createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {loadMigrationSql} from './helpers/migration.js';
import {sourceTransactionProblem} from '../scripts/hosted-migration-apply-runner.mjs';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';

const sql=loadMigrationSql('unit_steward_notice_audiences');
describe('unit notice migration contract',()=>{
  it('passes the real hosted transaction guard',()=>{
    expect(sourceTransactionProblem(sql)).toBeNull();
  });
  it('pins every canonical replacement and preserves its lifecycle entry lock',()=>{
    const contract=JSON.parse(readFileSync(new URL('../scripts/db-contract.json',import.meta.url),'utf8'));
    const definitions=[...sql.matchAll(/(CREATE OR REPLACE FUNCTION [\s\S]*?\$function\$);/g)].map(match=>match[1]+'\n');
    expect(definitions).toHaveLength(10);
    for(const definition of definitions){
      const name=definition.match(/^CREATE OR REPLACE FUNCTION ([a-z_.]+)/)[1];
      const entry=contract.functions.find(row=>row.sig.split('(')[0]===name);
      // #7667 (per_unit_settings) redefines one of these later, behind a check
      // that the body it replaces is exactly this one.
      const body=definition.slice(definition.indexOf('$function$')+'$function$'.length,definition.lastIndexOf('$function$'));
      const bodyMd5=createHash('md5').update(body).digest('hex');
      const later=loadMigrationSql('per_unit_settings').includes(`is distinct from '${bodyMd5}' then\n    raise exception 'unreviewed ${name} predecessor'`);
      // #8568 (committee_window_eastern_day) redefines the read-count readers
      // and the office access reader to read the Eastern day, behind the same
      // kind of check.
      const eastern=loadMigrationSql('committee_window_eastern_day').includes(`is distinct from '${bodyMd5}' then\n    raise exception 'unreviewed predecessor: ${name}'`);
      // #9220 (notice_publish_idempotency_key) replaces both publishers with a
      // version that takes the client's operation key, behind a check that the
      // whole installed definition is exactly this one.
      const definitionMd5=createHash('md5').update(definition).digest('hex');
      const keyed=loadMigrationSql('notice_publish_idempotency_key').includes(`is distinct from '${definitionMd5}' then\n    raise exception 'unreviewed predecessor: ${name}'`);
      if(!later&&!eastern&&!keyed)expect(entry?.bodyMd5,name).toBe(definitionMd5);
      if(['public.publish_member_broadcast','public.publish_chapter_office_notice','public.retract_member_broadcast'].includes(name)){
        const lock=definition.indexOf('perform private.lock_case_graph(');
        expect(lock,name).toBeGreaterThanOrEqual(0);
        expect(lock,name).toBeLessThan(definition.indexOf('declare'));
      }
    }
  });
  it('keeps the new authorization helper private and preserves recipient filtering',()=>{
    expect(sql).toContain('revoke all on function private.chapter_notice_scope_allowed(text,uuid,uuid) from public,anon,authenticated,service_role;');
    expect(sql).not.toMatch(/grant execute on function private\.chapter_notice_scope_allowed/i);
    expect(sql).not.toMatch(/(?:create|replace) function private\.(?:member_scoped_notice_in_audience|member_notice_read_count|visible_member_broadcast_ids)/i);
  });
  it('caches publisher authority by distinct scope before admitting an author outside the member audience',()=>{
    for(const name of ['public.get_broadcast_read_counts','public.get_broadcast_read_counts_for']){
      const start=sql.indexOf('CREATE OR REPLACE FUNCTION '+name+'(');
      const definition=sql.slice(start,sql.indexOf('$function$;',start));
      expect(definition.indexOf('publisher_scope as materialized')).toBeLessThan(definition.indexOf('readable as materialized'));
      // One publisher check in the body; the entry gate admits an organization
      // steward's assigned unit through the same predicate (#7664 on #7663).
      expect(definition.slice(definition.indexOf('with candidate')).match(/private\.chapter_notice_scope_allowed\(/g)).toHaveLength(1);
      expect(definition).toContain('b.created_by is not null and b.created_by=(select auth.uid())');
      expect(definition).toContain('from candidate');
    }
  });
});

const live=process.env.SUPABASE_DB_URL?describe:describe.skip;
live('unit-steward notices on an owned rollback database',()=>{
  let db,f;
  const owner=async()=>{await db.query('reset role');await db.query("select set_config('request.jwt.claims','',true)");};
  const as=async(name,aal='aal2')=>{
    await owner();const p=f.people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:p.id,session_id:p.session,role:'authenticated',aal})]);
    await db.query('set local role authenticated');
  };
  const one=async(query,args=[])=> (await db.query(query,args)).rows[0]?.v;
  const denied=async(query,args=[])=>{
    await db.query('savepoint refused_notice');let error;
    try{await db.query(query,args);}catch(caught){error=caught;}
    await db.query('rollback to savepoint refused_notice');await db.query('release savepoint refused_notice');
    expect(error,'out-of-scope notice operation was allowed').toBeTruthy();
    expect(['42501','22023']).toContain(error.code);
  };
  const publish=(unit,chapter=f.chapter)=>one("select public.publish_chapter_office_notice($1,'Fictional notice','A bounded unit notice','en',$2,null) v",[chapter,unit]);
  beforeEach(async()=>{
    db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),application_name:'unit-notice-rollback-proof'});
    await db.connect();await db.query('begin');
    f={org:randomUUID(),foreignOrg:randomUUID(),unitA:randomUUID(),unitB:randomUUID(),people:{}};
    f.chapter='unit-notice-'+f.org;f.foreign='unit-notice-'+f.foreignOrg;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Notices'),($2::uuid,$2::text,'Ridge Fictional Notices')",[f.org,f.foreignOrg]);
    await db.query('insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9975),($3,$3,$3,$4,9976)',[f.chapter,f.org,f.foreign,f.foreignOrg]);
    for(const name of ['admin','lead','steward','a','a2','b','foreign','legacy','orgSteward','secretary']){
      const id=randomUUID(),session=randomUUID(),foreign=name==='foreign';f.people[name]={id,session};
      await db.query('insert into auth.users(id,email) values($1,$2)',[id,id+'@example.invalid']);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3,notification_prefs=jsonb_set(coalesce(notification_prefs,'{}'::jsonb),'{announcements}','true'::jsonb,true) where id=$1",[id,foreign?f.foreign:f.chapter,'Fictional '+name]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[foreign?f.foreignOrg:f.org,id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[id,foreign?f.foreign:f.chapter]);
      if(['admin','lead'].includes(name)){
        const role=name==='lead'?'vp':'admin';
        await db.query('insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)',[id,role,f.chapter]);
        await db.query('insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)',[id,role,f.chapter]);
      }
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin'),($1,$3,'steward')",[f.org,f.people.admin.id,f.people.steward.id]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Garage A'),($2,$3,$4,'Garage B')",[f.unitA,f.unitB,f.org,f.chapter]);
    await as('admin');
    for(const [name,unit] of [['a',f.unitA],['a2',f.unitA],['b',f.unitB],['steward',f.unitB]]){
      await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[f.chapter,f.people[name].id,unit]);
    }
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[f.people.steward.id,f.chapter,f.unitA]);
    await as('steward');
  });
  afterEach(async()=>{if(db){await db.query('rollback');await db.end();}});

  it('refuses broad and other-unit publication even with an organization steward grant',async()=>{
    await denied("select public.publish_member_broadcast('Fictional','Body','en','chapter')");
    await denied("select public.publish_member_broadcast('Fictional','Body','en','organization')");
    await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',null,null)",[f.chapter]);
    await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',$2,null)",[f.chapter,f.unitB]);
    await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',null,null)",[f.foreign]);
    const office=await one('select public.get_chapter_office_access() v');
    expect(office.notices).toBe(true);expect(office.unscopedNotices).toBe(false);
    expect((await publish(f.unitA)).broadcastId).toBeTruthy();
  });

  it('keeps delivery, receipt identities and all counts inside the grant unit, not the publisher membership unit',async()=>{
    const id=(await publish(f.unitA)).broadcastId;
    await as('a');
    expect((await db.query('select id from public.member_broadcasts where id=$1',[id])).rows).toEqual([{id}]);
    await db.query('insert into public.member_broadcast_receipts(broadcast_id,user_id) values($1,$2)',[id,f.people.a.id]);
    for(const name of ['b','foreign']){
      await as(name);
      expect((await db.query('select id from public.member_broadcasts where id=$1',[id])).rows).toEqual([]);
      await denied('insert into public.member_broadcast_receipts(broadcast_id,user_id) values($1,$2)',[id,f.people[name].id]);
    }
    await as('steward');
    const receipt=await one('select public.get_member_notice_receipts($1) v',[id]);
    expect(receipt.audienceCount).toBe(2);expect(receipt.readCount).toBe(1);
    expect(receipt.readers.map(row=>row.name)).toEqual(['Fictional a']);
    expect((await one('select public.get_broadcast_read_counts_for($1) v',[[id]]))).toEqual([{broadcastId:id,readCount:1}]);
    expect((await one('select public.get_broadcast_read_counts() v')).find(row=>row.broadcastId===id).readCount).toBe(1);
    const mine=await one('select public.list_my_member_notices() v');
    expect(mine.notices.find(row=>row.id===id)).toMatchObject({readCount:1,audienceCount:2});
    await owner();
    const queued=(await db.query("select recipient_user_id from public.engagement_delivery_outbox where source_kind='broadcast' and source_id=$1",[id])).rows;
    expect(queued.map(row=>row.recipient_user_id).sort()).toEqual([f.people.a.id,f.people.a2.id].sort());
  });

  it('keeps chapter lead and organization admin chapter-wide publication',async()=>{
    for(const name of ['lead','admin']){
      await as(name);
      const id=(await one("select public.publish_member_broadcast('Fictional chapter notice','Body','en','chapter') v")).broadcastId;
      await owner();
      const row=(await db.query('select audience_scope,access_unit_id,access_committee_id from public.member_broadcasts where id=$1',[id])).rows[0];
      expect(row).toEqual({audience_scope:'chapter',access_unit_id:null,access_committee_id:null});
    }
  });

  it('revokes former-unit receipt access, but the author can still retract a former-unit notice',async()=>{
    const id=(await publish(f.unitA)).broadcastId;
    expect((await one('select public.retract_member_broadcast($1) v',[id])).retracted).toBe(true);
    const retained=(await publish(f.unitA)).broadcastId;
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[f.people.steward.id,f.chapter,f.unitB]);
    await as('steward');
    await denied('select public.get_member_notice_receipts($1)',[retained]);
    expect(await one('select public.get_broadcast_read_counts_for($1) v',[[retained]])).toEqual([]);
    // ruling on (#8713): retraction follows authorship.
    expect((await one('select public.retract_member_broadcast($1) v',[retained])).retracted).toBe(true);
  });

  // ruling on (#8713): a broad notice sent before this
  // migration (the shape a steward could publish then) is never stranded.
  // Its author can always retract it, and chapter leadership can retract
  // any notice in its own chapter; nobody else can.
  it('lets the author and chapter leadership retract a pre-migration broad notice, and nobody else',async()=>{
    let order=-976400;
    const broad=async(author,scope)=>{
      await owner();
      const id='pre-7664-'+randomUUID();order-=1;
      await db.query("insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,created_by,locale,organization_id,chapter_id,audience_scope) values($1,'Chapter steward','Fictional earlier notice','Sent before #7664',now()-interval '2 days',$6,$2,'en',$3,$4,$5)",[id,f.people[author].id,f.org,f.chapter,scope,order]);
      return id;
    };
    const retracted=async(id)=>{await owner();return (await db.query('select retracted_at is not null v from public.member_broadcasts where id=$1',[id])).rows[0].v;};
    // The author, now limited to Garage A, retracts chapter- and organization-wide notices it sent before.
    for(const scope of ['chapter','organization']){
      const id=await broad('steward',scope);
      await as('steward');
      expect((await one('select public.retract_member_broadcast($1) v',[id])).retracted).toBe(true);
      expect(await retracted(id)).toBe(true);
    }
    // Chapter leadership (a chapter VP, an organization admin) retracts another author's chapter notice.
    for(const name of ['lead','admin']){
      const id=await broad('steward','chapter');
      await as(name);
      expect((await one('select public.retract_member_broadcast($1) v',[id])).retracted).toBe(true);
      expect(await retracted(id)).toBe(true);
    }
    // Another steward, an organization steward, a member and a foreign member cannot; nor can anyone without a verified session.
    await organizationSteward(false);
    const kept=await broad('steward','chapter');
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[f.people.legacy.id,f.chapter,f.unitB]);
    for(const name of ['legacy','orgSteward','b','foreign']){
      await as(name);
      await denied('select public.retract_member_broadcast($1)',[kept]);
    }
    await as('steward','aal1');
    await denied('select public.retract_member_broadcast($1)',[kept]);
    await as('lead','aal1');
    await denied('select public.retract_member_broadcast($1)',[kept]);
    expect(await retracted(kept)).toBe(false);
  });

  // ruling on (#8713): the desk list always shows a
  // publisher its own notices, and only its own beyond its member audience.
  it('lists an author its own notice sent outside its unit, and no one else\'s out-of-unit notice',async()=>{
    const id=(await publish(f.unitA)).broadcastId;
    const page=async()=>(await db.query("select id,total_count from public.list_steward_broadcasts('all',null,null,null,100)")).rows;
    // The steward belongs to Garage B and sends to Garage A.
    expect((await page()).map(row=>row.id)).toContain(id);
    expect((await db.query("select id from public.list_steward_broadcasts('active',null,null,null,100)")).rows.map(row=>row.id)).toContain(id);
    expect((await one('select public.retract_member_broadcast($1) v',[id])).retracted).toBe(true);
    expect((await db.query("select id from public.list_steward_broadcasts('retracted',null,null,null,100)")).rows.map(row=>row.id)).toContain(id);
    const other=(await publish(f.unitA)).broadcastId;
    // A steward of Garage B with no Garage A membership does not see it, and its count does not include it.
    await as('admin');
    await one("select public.set_chapter_access_member($1,$2,$3,null,true) v",[f.chapter,f.people.legacy.id,f.unitB]);
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[f.people.legacy.id,f.chapter,f.unitB]);
    await as('legacy');
    const rows=await page();
    expect(rows.map(row=>row.id)).not.toContain(other);
    expect(rows.map(row=>row.id)).not.toContain(id);
    for(const row of rows) expect(Number(row.total_count)).toBe(rows.length);
    // A Garage A member still sees it as a member.
    await as('a');
    expect((await db.query('select id from public.member_broadcasts where id=$1',[other])).rows).toEqual([{id:other}]);
  });

  // #7664 on #7663 (20261113115000): a carry-over steward keeps chapter-wide
  // reads, but every steward
  // sends notices to its unit; the carry-over unit is the chapter default.
  const carryOver=async()=>{
    await owner();
    f.defaultUnit=(await db.query('select id from private.chapter_units where chapter_id=$1 and is_default',[f.chapter])).rows[0].id;
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[f.people.legacy.id,f.chapter,f.defaultUnit]);
    // Fixture preparation in a URL-guarded rolled-back transaction: only the
    // #7663 backfill may set the mark, so its write guard is lifted here.
    await owner();
    await db.query('set constraints all immediate');
    await db.query('alter table private.chapter_role_scopes disable trigger a01_reject_carry_over_update');
    await db.query("update private.chapter_role_scopes set legacy_chapter_coverage=true where user_id=$1 and chapter_id=$2 and role='steward'",[f.people.legacy.id,f.chapter]);
    await db.query('alter table private.chapter_role_scopes enable trigger a01_reject_carry_over_update');
    await db.query('set constraints all deferred');
  };
  // An organization steward grant reaches a chapter only through the
  // assignment #7663's backfill writes (carried over, or narrowed to a unit).
  const organizationSteward=async(carried)=>{
    await owner();
    await db.query('set constraints all immediate');
    await db.query('alter table private.organization_steward_unit_assignments disable trigger a01_reject_organization_assignment_insert');
    await db.query('set constraints all deferred');
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')",[f.org,f.people.orgSteward.id]);
    await db.query('insert into private.organization_steward_unit_assignments(organization_id,user_id,chapter_id,unit_id,legacy_chapter_coverage) values($1,$2,$3,$4,$5)',[f.org,f.people.orgSteward.id,f.chapter,f.unitB,carried]);
    await db.query('set constraints all immediate');
    await db.query('alter table private.organization_steward_unit_assignments enable trigger a01_reject_organization_assignment_insert');
    await db.query('set constraints all deferred');
  };
  const queuedFor=async(id)=>{
    await owner();
    return (await db.query("select recipient_user_id v from public.engagement_delivery_outbox where source_kind='broadcast' and source_id=$1",[id])).rows.map(row=>row.v);
  };

  it('refuses chapter-wide notices from a carry-over steward and keeps its default-unit notice',async()=>{
    await carryOver();
    await as('legacy');
    await denied("select public.publish_member_broadcast('Fictional','Body','en','chapter')");
    await denied("select public.publish_member_broadcast('Fictional','Body','en','organization')");
    await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',null,null)",[f.chapter]);
    await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',$2,null)",[f.chapter,f.unitA]);
    const office=await one('select public.get_chapter_office_access() v');
    expect(office).toMatchObject({notices:true,unscopedNotices:false});
    expect(office.scopes.filter(scope=>scope.notices).map(scope=>scope.unitId)).toEqual([f.defaultUnit]);
    const id=(await publish(f.defaultUnit)).broadcastId;
    const queued=await queuedFor(id);
    for(const name of ['a','a2','b','steward']) expect(queued,name).not.toContain(f.people[name].id);
    expect(queued).toContain(f.people.secretary.id);
    await as('legacy');
    const receipt=await one('select public.get_member_notice_receipts($1) v',[id]);
    expect(receipt.audienceCount).toBe(5);
  });

  for(const carried of [false,true]){
    it(`keeps an organization steward grant (${carried?'carried over':'narrowed'}) to its assigned unit`,async()=>{
      await organizationSteward(carried);
      await as('orgSteward');
      await denied("select public.publish_member_broadcast('Fictional','Body','en','organization')");
      await denied("select public.publish_member_broadcast('Fictional','Body','en','chapter')");
      await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',null,null)",[f.chapter]);
      await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',$2,null)",[f.chapter,f.unitA]);
      const office=await one('select public.get_chapter_office_access() v');
      expect(office).toMatchObject({notices:true,unscopedNotices:false});
      expect(office.scopes).toContainEqual({role:'steward',unitId:f.unitB,committeeId:null,name:'Garage B',records:false,notices:true,documents:false});
      const id=(await publish(f.unitB)).broadcastId;
      await owner();
      expect((await db.query('select sender,audience_scope,access_unit_id from public.member_broadcasts where id=$1',[id])).rows[0]).toEqual({sender:'Chapter steward',audience_scope:'chapter',access_unit_id:f.unitB});
      expect((await queuedFor(id)).sort()).toEqual([f.people.b.id,f.people.steward.id].sort());
      await as('orgSteward');
      expect(await one('select public.get_broadcast_read_counts_for($1) v',[[id]])).toEqual([{broadcastId:id,readCount:0}]);
      expect((await one('select public.retract_member_broadcast($1) v',[id])).retracted).toBe(true);
      // The chapter's steward notices setting covers this grant too.
      await as('admin');
      await one("select public.set_chapter_role_capability($1,'steward','notices',false) v",[f.chapter]);
      await as('orgSteward');
      await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',$2,null)",[f.chapter,f.unitB]);
    });
  }

  it('keeps chapter notices for an enabled office that is not a steward',async()=>{
    await as('admin');
    await one("select public.set_member_access_role($1,$2,'secretary',true,null,null) v",[f.people.secretary.id,f.chapter]);
    await as('secretary');
    expect((await one("select public.get_chapter_office_access() v")).unscopedNotices).toBe(true);
    const id=(await one("select public.publish_chapter_office_notice($1,'Fictional chapter notice','Body','en',null,null) v",[f.chapter])).broadcastId;
    await owner();
    expect((await db.query('select audience_scope,access_unit_id from public.member_broadcasts where id=$1',[id])).rows[0]).toEqual({audience_scope:'chapter',access_unit_id:null});
  });

  it('keeps the current MFA requirement',async()=>{
    await as('steward','aal1');
    await denied("select public.publish_chapter_office_notice($1,'Fictional','Body','en',$2,null)",[f.chapter,f.unitA]);
  });
});
