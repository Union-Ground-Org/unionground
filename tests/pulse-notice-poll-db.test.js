// @vitest-environment node
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sourceTransactionProblem} from '../scripts/hosted-migration-apply-runner.mjs';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';

it('can rehearse the complete migration through the hosted transaction parser',()=>{
  expect(sourceTransactionProblem(readFileSync('supabase/migrations/20261121035100_pulse_notice_poll_reads.sql','utf8'))).toBeNull();
});

const live=process.env.SUPABASE_DB_URL?describe:describe.skip;
live('Pulse Notice reach and meeting poll on an owned rollback database',()=>{
  let db,org,foreignOrg,chapter,foreignChapter,admin,steward,coordinator,foreign,people,unitA,unitB,space,privateSpace,foreignSpace;
  const sessions=new Map();
  let noticeIndex=997800;
  async function fixture(sql,args=[]){
    await db.query('savepoint fixture_write');
    await db.query('set local session_replication_role=replica');
    try{return await db.query(sql,args);}
    catch(error){await db.query('rollback to savepoint fixture_write');throw error;}
    finally{await db.query('set local session_replication_role=origin');}
  }
  async function as(user,sql,args=[],aal='aal2'){
    await db.query('savepoint request');
    try{
      await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role:'authenticated',aal,session_id:sessions.get(user)})]);
      await db.query('set local role authenticated');
      const result=(await db.query(sql,args)).rows[0]?.v;
      await db.query('reset role');await db.query('release savepoint request');return result;
    }catch(error){await db.query('rollback to savepoint request');throw error;}
  }
  const reach=(user=admin)=>as(user,'select public.get_pulse_notice_reach() v');
  const tally=(poll=null,user=people[0])=>as(user,'select public.get_pulse_meeting_poll($1) v',[poll]);
  const options=(user)=>as(user,'select public.pulse_ready_chart_options() v');
  async function notice({author=admin,unit=unitA,readers=people.slice(0,25),published='2026-11-15T10:00:00-05:00',retracted=false}={}){
    const id=randomUUID();
    await fixture("insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,organization_id,chapter_id,audience_scope,created_by,access_unit_id,retracted_at) values($1,'Publisher','Fictional notice','Private authored text',$2,$8,$3,$4,'chapter',$5,$6,case when $7 then now() end)",[id,published,org,chapter,author,unit,retracted,++noticeIndex]);
    await receipts(id,readers);return id;
  }
  async function receipts(id,readers){
    await fixture('delete from public.member_broadcast_receipts where broadcast_id=$1',[id]);
    await fixture('insert into public.member_broadcast_receipts(broadcast_id,user_id) select $1,id from unnest($2::uuid[]) id',[id,readers]);
  }
  async function platform(){
    await fixture("update public.organizations set kind='union' where kind='platform'");
    await fixture("update public.organizations set kind='platform' where id=$1",[org]);
  }
  async function poll({target=space,voters=people.slice(0,50),split=25,closed=false,question='Meeting text is not a classifier',created='2026-11-15T12:00:00-05:00'}={}){
    const id=randomUUID(),a=randomUUID(),b=randomUUID();
    await fixture("insert into public.chapter_channel_polls(id,space_id,chapter_id,question,created_by,closes_at,created_at) values($1,$2,$3,$4,$5,case when $6 then now()-interval '1 day' else now()+interval '1 day' end,$7)",[id,target,target===foreignSpace?foreignChapter:chapter,question,admin,closed,created]);
    await fixture("insert into public.chapter_channel_poll_options(id,poll_id,label,position) values($1,$3,'First',0),($2,$3,'Second',1)",[a,b,id]);
    await fixture('insert into public.chapter_channel_poll_votes(poll_id,option_id,user_id) select $1,case when n<=$5 then $2::uuid else $3::uuid end,u from unnest($4::uuid[]) with ordinality x(u,n)',[id,a,b,voters,split]);
    return {id,a,b};
  }
  const withheld=(value)=>{
    expect(value.state).toBe('withheld');
    if(value.notices)for(const row of value.notices)expect(row).toMatchObject({state:'withheld',audience:null,read:null,unread:null,percentage:null});
    else{expect(value.total).toBeNull();for(const row of value.options)expect(row).toMatchObject({votes:null,percentage:null});}
    expect(value).not.toHaveProperty('winner');expect(value).not.toHaveProperty('rank');
  };
  beforeAll(async()=>{
    db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),application_name:'pulse-notice-poll-rollback-proof'});
    await db.connect();await db.query('begin');await db.query("set local statement_timeout='30s'");
    org=randomUUID();foreignOrg=randomUUID();chapter='pulse-two-'+org;foreignChapter='pulse-two-'+foreignOrg;
    [admin,steward,coordinator,foreign]=Array.from({length:4},()=>randomUUID());people=Array.from({length:100},()=>randomUUID());
    const users=[admin,steward,coordinator,foreign,...people];
    await db.query("insert into auth.users(id,email) select id,id::text||'@example.invalid' from unnest($1::uuid[]) id",[users]);
    await fixture("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Tamarack chart proof'),($2::uuid,$2::text,'Tamarack isolated chart proof')",[org,foreignOrg]);
    await fixture('insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,$2,997801),($3,$3,$3,$4,997802)',[chapter,org,foreignChapter,foreignOrg]);
    await fixture('update public.member_profiles set chapter_id=case when id=$2 then $4 else $3 end where id=any($1::uuid[])',[users,foreign,chapter,foreignChapter]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) select case when id=$2 then $4::uuid else $3::uuid end,id,'active' from unnest($1::uuid[]) id on conflict do nothing",[users,foreign,org,foreignOrg]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) select id,case when id=$2 then $4 else $3 end,'active',true,now() from unnest($1::uuid[]) id on conflict(user_id,chapter_id) do update set status='active',pinned=true,last_selected_at=now()",[users,foreign,chapter,foreignChapter]);
    await fixture("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2),($1,$3,'coordinator',$2)",[org,admin,coordinator]);
    unitA=randomUUID();unitB=randomUUID();
    await fixture("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'A'),($2,$3,$4,'B')",[unitA,unitB,org,chapter]);
    await fixture('insert into private.chapter_unit_members(unit_id,chapter_id,user_id) select case when n<=50 then $1::uuid else $2::uuid end,$3,u from unnest($4::uuid[]) with ordinality x(u,n)',[unitA,unitB,chapter,people]);
    for(const user of [admin,steward,coordinator,foreign,people[0]]){
      const session=randomUUID();sessions.set(user,session);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,user]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),user]);
    }
    await as(admin,"select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[steward,chapter,unitA]);
    space=randomUUID();privateSpace=randomUUID();foreignSpace=randomUUID();
    await fixture("insert into public.chapter_spaces(id,chapter_id,name,visibility,created_by) values($1,$4,'Open','chapter',$6),($2,$4,'Private','private',$6),($3,$5,'Foreign','chapter',$6)",[space,privateSpace,foreignSpace,chapter,foreignChapter,admin]);
  },60000);
  beforeEach(async()=>{await db.query('savepoint scenario');});
  afterEach(async()=>{await db.query('reset role');await db.query('rollback to savepoint scenario');});
  afterAll(async()=>{if(db){await db.query('rollback');await db.end();}});

  it('offers notices only to an actual publisher, and polls only to readable-channel roles',async()=>{
    for(const user of [admin,steward])expect((await options(user)).map(x=>x.key)).toContain('ready:notice-reach');
    for(const user of [people[0],coordinator])expect((await options(user)).map(x=>x.key)).not.toContain('ready:notice-reach');
    expect((await options(people[0])).map(x=>x.key)).toContain('ready:meeting-night-poll');
    expect(await reach(people[0])).toEqual({state:'unavailable',notices:[]});
    expect(await reach()).toEqual({state:'missing',notices:[]});
    expect(await tally()).toEqual({state:'missing'});
  });
  it('floors distinct current audience/read/unread groups at the floor and one below it',async()=>{
    const id=await notice({readers:people.slice(0,24)});withheld(await reach());
    await receipts(id,people.slice(0,25));
    const result=await reach();expect(result.state).toBe('ready');
    expect(result.notices[0]).toMatchObject({id,audience:50,read:25,unread:25,percentage:50});
    expect(JSON.stringify(result)).not.toContain(people[0]);
    expect(result.notices[0]).not.toHaveProperty('readers');
    expect(await reach()).toEqual(result);
  });
  it('refuses platform notice reach and its option before publishing figures or writing privacy state',async()=>{
    await notice();await platform();
    expect(await reach()).toEqual({state:'unavailable',notices:[]});
    const keys=(await options(admin)).map(x=>x.key);
    expect(keys).not.toContain('ready:notice-reach');
    expect(keys).toContain('ready:meeting-night-poll');
    // Even a future reader that bypasses the option gate cannot release
    // platform groups through the private helper. Its real session is admin's.
    const groups=[people.slice(0,25),people.slice(25,50)];
    expect((await db.query('select private.pulse_release_safe($1,$2::jsonb) v',[org,JSON.stringify(groups)])).rows[0].v).toBe(false);
    expect((await db.query('select count(*)::int n from private.pulse_release_partitions where organization_id=$1',[org])).rows[0].n).toBe(0);
  });
  it('withdraws published notice reach when its organization is reclassified as platform',async()=>{
    await notice();expect((await reach()).state).toBe('ready');
    const before=(await db.query('select atoms from private.pulse_release_partitions where organization_id=$1',[org])).rows[0];
    await platform();
    expect(await reach()).toEqual({state:'unavailable',notices:[]});
    expect((await options(admin)).map(x=>x.key)).not.toContain('ready:notice-reach');
    expect((await db.query('select private.pulse_release_safe($1,$2::jsonb) v',[org,JSON.stringify([people.slice(0,50)])])).rows[0].v).toBe(false);
    expect((await db.query('select atoms from private.pulse_release_partitions where organization_id=$1',[org])).rows[0]).toEqual(before);
  });
  it('counts a reader once across repeated receipts and excludes out-of-audience readers',async()=>{
    const id=await notice({readers:[...people.slice(0,25),...people.slice(50)]});
    expect((await reach()).notices[0]).toMatchObject({audience:50,read:25,unread:25});
    await db.query('savepoint duplicate_receipt');
    await expect(fixture('insert into public.member_broadcast_receipts(broadcast_id,user_id) values($1,$2)',[id,people[0]])).rejects.toMatchObject({code:'23505'});
    await db.query('rollback to savepoint duplicate_receipt');
    await notice({readers:people.slice(0,25),published:'2026-11-15T11:00:00-05:00'});
    expect((await reach()).notices.map(x=>x.read)).toEqual([25,25]);
  });
  it('chooses the latest three authored unretracted notices in publication order',async()=>{
    const ids=[];for(let n=0;n<4;n++)ids.push(await notice({published:`2026-11-15T0${n}:00:00-05:00`}));
    await notice({author:steward,published:'2026-11-15T15:00:00-05:00'});
    await notice({retracted:true,published:'2026-11-15T16:00:00-05:00'});
    expect((await reach()).notices.map(x=>x.id)).toEqual(ids.slice(1).reverse());
  });
  it('withholds a safe total with an unsafe complement and an overlapping notice intersection',async()=>{
    await notice({readers:people.slice(0,49)});withheld(await reach());
    await fixture('delete from public.member_broadcasts where organization_id=$1',[org]);
    await notice();await notice({readers:people.slice(1,26),published:'2026-11-15T11:00:00-05:00'});
    withheld(await reach());
  });
  it('does not disclose a single new read on refresh but releases a safe whole-group change',async()=>{
    const id=await notice();expect((await reach()).state).toBe('ready');
    await receipts(id,people.slice(0,26));withheld(await reach());
    await receipts(id,people.slice(0,50));expect((await reach()).notices[0]).toMatchObject({read:50,unread:0,percentage:100});
    await receipts(id,people.slice(1,50));withheld(await reach());
  });
  it('keeps a unit steward inside the currently granted notice unit and revokes stale authority',async()=>{
    const own=await notice({author:steward});await notice({author:steward,unit:unitB});
    expect((await reach(steward)).notices.map(x=>x.id)).toEqual([own]);
    await fixture("update private.chapter_role_settings set enabled=false where chapter_id=$1 and role='steward' and capability='notices'",[chapter]);
    // Settings are absent until the first explicit override.
    await fixture("insert into private.chapter_role_settings(chapter_id,role,capability,enabled) values($1,'steward','notices',false) on conflict(chapter_id,role,capability) do update set enabled=false",[chapter]);
    expect(await reach(steward)).toEqual({state:'unavailable',notices:[]});
  });
  it('distinguishes an empty current audience from missing and withheld without a zero-denominator rate',async()=>{
    await fixture('delete from private.chapter_unit_members where unit_id=$1',[unitA]);
    await notice({readers:[]});expect((await reach()).notices[0]).toMatchObject({state:'no_eligible_records',audience:0,read:0,unread:0,percentage:null});
  });
  it('protects every poll option while retaining configured order and only the caller answer',async()=>{
    const p=await poll({split:24});const hidden=await tally(p.id);withheld(hidden);
    expect(hidden.mine).toBe(p.a);expect(hidden.options.map(x=>x.id)).toEqual([p.a,p.b]);
    await fixture('update public.chapter_channel_poll_votes set option_id=$2 where poll_id=$1 and user_id=$3',[p.id,p.a,people[24]]);
    const result=await tally(p.id);expect(result.state).toBe('ready');expect(result.total).toBe(50);
    expect(result.options.map(x=>[x.votes,x.percentage])).toEqual([[25,50],[25,50]]);
    expect(JSON.stringify(result)).not.toContain(people[0]);
  });
  it('counts current one-vote rows, keeps unsafe vote changes hidden, and does not rank options',async()=>{
    const p=await poll();expect((await tally(p.id)).state).toBe('ready');
    await fixture('update public.chapter_channel_poll_votes set option_id=$2,updated_at=now() where poll_id=$1 and user_id=$3',[p.id,p.b,people[0]]);
    const result=await tally(p.id);withheld(result);expect(result.mine).toBe(p.b);
    await fixture('update public.chapter_channel_poll_votes set option_id=$2 where poll_id=$1',[p.id,p.b]);
    expect((await tally(p.id)).options.map(x=>x.votes)).toEqual([0,50]);
    await db.query('savepoint duplicate_vote');
    await expect(fixture('insert into public.chapter_channel_poll_votes(poll_id,option_id,user_id) values($1,$2,$3)',[p.id,p.a,people[0]])).rejects.toMatchObject({code:'23505'});
    await db.query('rollback to savepoint duplicate_vote');
  });
  it('selects the latest readable open poll without inferring a meeting from text',async()=>{
    await poll({closed:true,created:'2026-11-15T15:00:00-05:00'});
    await poll({target:privateSpace,created:'2026-11-15T16:00:00-05:00'});
    const selected=await poll({question:'Lunch choices',created:'2026-11-15T13:00:00-05:00'});
    const result=await tally();expect(result).toMatchObject({pollId:selected.id,label:'Live chapter poll',question:'Lunch choices'});
    expect((await tally(selected.id)).label).toBe('Meeting night poll');
  });
  it('refuses foreign, unreadable, revoked and anonymous access identically to missing IDs',async()=>{
    const p=await poll({target:privateSpace}),outside=await poll({target:foreignSpace});
    for(const user of [people[0],steward])for(const id of [p.id,outside.id,randomUUID()])expect(await tally(id,user)).toEqual({state:'unavailable'});
    const own=await poll();
    await fixture("update public.organization_memberships set status='revoked',revoked_at=now() where organization_id=$1 and user_id=$2",[org,people[0]]);
    expect(await tally(own.id)).toEqual({state:'unavailable'});
    expect(await as(null,'select public.get_pulse_meeting_poll($1) v',[own.id])).toEqual({state:'unavailable'});
    expect(await reach(foreign)).toEqual({state:'unavailable',notices:[]});
  });
  it('keeps missing, zero, platform-hidden and raised-floor tallies separate',async()=>{
    const empty=await poll({voters:[]});expect(await tally(empty.id)).toMatchObject({state:'no_eligible_records',total:0});
    const p=await poll();expect((await tally(p.id)).state).toBe('ready');
    await fixture("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,'limits.analytics.anonymity_floor','30'::jsonb,$2) on conflict(organization_id,setting_key) do update set value=excluded.value",[org,admin]);
    await fixture('update public.chapter_channel_poll_votes set option_id=$2 where poll_id=$1',[p.id,p.b]);
    withheld(await tally(p.id));
    await notice({readers:people.slice(0,50)});withheld(await reach());
  });
  it('keeps the platform aggregate hidden while retaining the caller selection',async()=>{
    const p=await poll();
    await platform();
    const result=await tally(p.id);withheld(result);expect(result.mine).toBe(p.a);
  });
  it('rechecks channel membership, session assurance and current audience before every release',async()=>{
    const p=await poll({target:privateSpace});
    await fixture('insert into public.chapter_space_members(space_id,user_id) values($1,$2)',[privateSpace,people[0]]);
    expect((await tally(p.id)).state).toBe('ready');
    await fixture('delete from public.chapter_space_members where space_id=$1 and user_id=$2',[privateSpace,people[0]]);
    expect(await tally(p.id)).toEqual({state:'unavailable'});
    expect(await as(people[0],'select public.get_pulse_meeting_poll($1) v',[p.id],'aal1')).toEqual({state:'unavailable'});
    const id=await notice();expect((await reach()).state).toBe('ready');
    await fixture('delete from private.chapter_unit_members where unit_id=$1 and user_id=$2',[unitA,people[0]]);
    withheld(await reach());
    await receipts(id,people.slice(0,25));withheld(await reach());
  });
  it('shares a persistent partition across poll/notice reads, retaining earlier histories and complements',async()=>{
    await notice();expect((await reach()).state).toBe('ready');
    const overlapping=await poll({voters:people.slice(0,50),split:25});
    expect((await tally(overlapping.id)).state).toBe('ready');
    await fixture('update public.chapter_channel_poll_votes set option_id=case when user_id=$2 then $3::uuid when user_id=$4 then $5::uuid else option_id end where poll_id=$1',[overlapping.id,people[0],overlapping.b,people[25],overlapping.a]);
    // Counts remain 25/25, but the two one-person intersections cannot publish.
    withheld(await tally(overlapping.id));
    await fixture('delete from public.member_broadcasts where organization_id=$1',[org]);
    withheld(await tally(overlapping.id));
  });
  it('keeps guard storage and its helper inaccessible through client and service roles',async()=>{
    const {rows}=await db.query("select r,has_table_privilege(r,'private.pulse_release_partitions','SELECT') t,has_function_privilege(r,'private.pulse_release_safe(uuid,jsonb)','EXECUTE') f from unnest(array['anon','authenticated','service_role']) r");
    expect(rows).toEqual(['anon','authenticated','service_role'].map(r=>({r,t:false,f:false})));
    await notice();expect((await reach()).state).toBe('ready');
    const stored=(await db.query('select atoms::text v from private.pulse_release_partitions where organization_id=$1',[org])).rows[0].v;
    for(const id of people)expect(stored).not.toContain(id);
    expect((await db.query("select relrowsecurity r,relforcerowsecurity f from pg_class where oid='private.pulse_release_partitions'::regclass")).rows[0]).toEqual({r:true,f:true});
  });
});
