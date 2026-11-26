// @vitest-environment node
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live('governed learning content on an owned disposable database', () => {
  let db;
  const ids = Object.fromEntries(['org','foreignOrg','admin','member','otherAdmin','session','memberSession','otherSession','platformOnly','platformOnlySession'].map(k => [k, randomUUID()]));
  const chapter = `learning-${ids.org}`, sibling = `${chapter}-sibling`, foreign = `${chapter}-foreign`;
  let actor = 'admin';
  const item = (patch = {}) => ({ kind: 'quote', locale: 'en', title: 'Authored reflection', body: 'Take time to listen.', locale_state: 'reviewed', source: '', rights_note: 'Original test writing.', review_note: 'Reviewed for this test.', ...patch });
  async function call(name, params = []) {
    await db.query('savepoint learning_call');
    try {
      const sessionKey = actor === 'member' ? 'memberSession' : actor === 'otherAdmin' ? 'otherSession' : actor === 'platformOnly' ? 'platformOnlySession' : 'session';
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub: ids[actor], role:'authenticated', session_id:ids[sessionKey], aal:'aal2'})]);
      await db.query('set local role authenticated');
      const result = await db.query(`select public.${name}(${params.map((_,i)=>`$${i+1}`).join(',')}) data`, params);
      await db.query('reset role'); await db.query('release savepoint learning_call');
      return { code:'', data:result.rows[0]?.data };
    } catch (error) {
      await db.query('rollback to savepoint learning_call'); await db.query('release savepoint learning_call');
      return { code:error.code, message:error.message };
    }
  }
  const save = (patch={}, scope='chapter', target=chapter, revision=null) => call('save_learning_content',[target,scope,item(patch),revision]);
  const policy = async (scope='platform',quotes=true,lessons=true,selection=null,target=chapter) => { const workspace=await call('get_learning_workspace',[target,scope,0]); return call('save_learning_policy',[target,scope,quotes,lessons,selection,workspace.data?.policy?.revision ?? 0]); };
  const list = (locale='en',kind=null,target=chapter) => call('list_learning_content',[target,locale,kind,0,100]);
  const publish = (row,action='publish',start=null,end=null) => call('transition_learning_content',[chapter,row.id,action,row.revision,start,end]);
  async function published(patch={},scope='chapter') { const r=await save(patch,scope); expect(r,r.message).toMatchObject({code:''}); const p=await publish(r.data);expect(p,p.message).toMatchObject({code:''});return p.data; }
  beforeAll(async () => {
    db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),ssl:false});await db.connect();await db.query('begin');
    for (const [user,key,org] of [['admin','session','org'],['member','memberSession','org'],['otherAdmin','otherSession','foreignOrg']]) {
      await db.query('insert into auth.users(id,email) values($1,$2)',[ids[user],`${ids[user]}@example.invalid`]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",[ids[key],ids[user]]);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Learning proof','totp','verified',now(),now())",[randomUUID(),ids[user]]);
      if(user!=='member') await db.query('insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)',[ids[org],`learning-${ids[org]}`,ids[user]]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[ids[org],ids[user]]);
      if(user!=='member')await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",[ids[org],ids[user]]);
    }
    for (const [ch,org] of [[chapter,'org'],[sibling,'org'],[foreign,'foreignOrg']]) await db.query('insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9950)',[ch,ids[org]]);
    for(const [user,ch] of [['admin',chapter],['member',chapter],['otherAdmin',foreign]]) {
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[ids[user],ch]);
      await db.query('update public.member_profiles set chapter_id=$2 where id=$1',[ids[user],ch]);
    }
    await db.query('insert into private.learning_platform_editors(user_id) values($1)',[ids.admin]);
  },60000);
  beforeEach(async()=>{actor='admin';await db.query('savepoint learning_test');});
  afterEach(async()=>{await db.query('rollback to savepoint learning_test');});
  afterAll(async()=>{await db?.query('rollback').catch(()=>{});await db?.end();});

  it('imports all historical material as audited drafts that cannot be delivered or published before review',async()=>{
    const recovered=await db.query("select id,status,payload,provenance from private.learning_content where provenance->>'donor_sha256'=$1",['0cd6a184d0a3ad7a059e0f138277dbf2838a26fe79b3cabf3ad5502038fbc224']);
    expect(recovered.rows).toHaveLength(63);
    expect(recovered.rows.filter(r=>r.payload.kind==='quote')).toHaveLength(43);
    expect(recovered.rows.every(r=>r.status==='draft' && r.payload.locale_state==='draft' && !r.payload.is_default)).toBe(true);
    const history=await db.query("select count(*)::int n from private.learning_history where action='recover_draft'");expect(history.rows[0].n).toBe(63);
    await policy();expect((await list()).data.items).toEqual([]);
    expect((await publish({...recovered.rows[0],revision:1})).code).toBe('22023');
  });
  it('starts unavailable, then enforces independent platform and chapter module switches',async()=>{
    const quote=await published();await published({kind:'mini_lesson',source:'Test source'});
    expect((await list()).data.items).toEqual([]);
    expect((await policy('platform',true,false)).code).toBe('');expect((await list()).data.items.map(x=>x.id)).toEqual([quote.id]);
    await policy('platform',true,true);await policy('chapter',false,true);expect((await list()).data.items.map(x=>x.kind)).toEqual(['mini_lesson']);
    await policy('organization',false,false);await policy('chapter',true,true);expect((await list()).data.items).toEqual([]);
  });
  it('rejects stale policy settings instead of re-enabling content disabled by another editor',async()=>{
    const first=await call('get_learning_workspace',[chapter,'chapter',0]);
    expect(first.data.policy.revision).toBe(0);
    const disabled=await call('save_learning_policy',[chapter,'chapter',false,true,null,0]);expect(disabled.code).toBe('');
    const stale=await call('save_learning_policy',[chapter,'chapter',true,true,[],0]);expect(stale.code).toBe('PT409');
    expect((await call('save_learning_policy',[chapter,'chapter',true,true,null,null])).code).toBe('PT409');
    const current=await call('get_learning_workspace',[chapter,'chapter',0]);expect(current.data.policy.quotes_enabled).toBe(false);
    expect((await call('save_learning_policy',[chapter,'chapter',false,true,[],current.data.policy.revision])).code).toBe('');
    const audit=await db.query("select count(*)::int n from private.learning_history where scope_key=$1 and action='policy'",[`chapter:${chapter}`]);expect(audit.rows[0].n).toBe(2);
  });
  it('definitively rejects SQL null, JSON null and missing list fields',async()=>{
    expect((await db.query("select private.learning_strings_valid(null,5,200) valid")).rows[0].valid).toBe(false);
    for(const field of ['bullets','topics']) {
      expect((await save({[field]:null})).code).toBe('22023');
      const payload=(await save()).data;
      const pure=payload && Object.fromEntries(Object.entries(payload).filter(([key])=>!['id','scope','organization_id','chapter_id','status','starts_at','ends_at','revision','provenance'].includes(key)));
      delete pure[field];
      expect((await db.query('select private.learning_payload_valid($1::jsonb) valid',[pure])).rows[0].valid).toBe(false);
    }
  });
  it('refuses wrong-tenant writes and reads without revealing the content',async()=>{
    const row=await published();actor='otherAdmin';
    expect((await save({},'chapter',chapter)).code).toBe('42501');
    expect((await call('save_learning_content',[foreign,'chapter',item({id:row.id}),row.revision])).code).toBe('42501');
    expect((await call('transition_learning_content',[foreign,row.id,'withdraw',row.revision,null,null])).code).toBe('42501');
    expect((await call('get_learning_history',[foreign,row.id,0])).code).toBe('42501');
    expect((await list('en',null,chapter)).code).toBe('42501');
  });
  it('refuses member authoring, platform escalation and direct table writes',async()=>{
    actor='member';expect((await save()).code).toBe('42501');expect((await policy('platform')).code).toBe('42501');
    const grants=await db.query("select has_table_privilege('authenticated','private.learning_content','INSERT') allowed");expect(grants.rows[0].allowed).toBe(false);
    actor='otherAdmin';expect((await policy('platform',true,true,null,foreign)).code).toBe('42501');
  });
  it('does not let a member read a sibling chapter',async()=>{actor='member';expect((await list('en',null,sibling)).code).toBe('42501');});
  it('keeps chapter administrator writes inside the granted chapter',async()=>{
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)",[ids.member,chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing",[ids.member,chapter]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[ids.member,sibling]);
    actor='member';expect((await save()).code).toBe('');
    expect((await save({},'chapter',sibling)).code).toBe('42501');
    expect((await save({},'organization')).code).toBe('42501');
    expect((await policy('organization')).code).toBe('42501');
  });
  it('keeps drafts, future schedules, withdrawn and expired material out of delivery',async()=>{
    await policy(); const draft=await save();expect((await list()).data.items).toEqual([]);
    const scheduled=await publish(draft.data,'schedule',new Date(Date.now()+86400000).toISOString());expect(scheduled.code).toBe('');expect((await list()).data.items).toEqual([]);
    const row=await published();expect((await list()).data.items).toHaveLength(1);await publish(row,'withdraw');expect((await list()).data.items).toEqual([]);
    const expired=await published();await db.query("update private.learning_content set starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' where id=$1",[expired.id]);expect((await list()).data.items).toEqual([]);
  });
  it('requires attribution sources, factual sources, rights review and reviewed locales',async()=>{
    for(const patch of [{attribution:'Attributed author'},{kind:'mini_lesson'},{rights_note:''},{review_note:''},{locale_state:'draft'},{rights_note:'\t\n\u00a0\ufeff'},{review_note:'\t\n'},{attribution:'Author',source:'\u2000\n'}]){
      const r=await save(patch);expect(r.code).toBe('');expect((await publish(r.data)).code).toBe('22023');
    }
    expect((await publish((await save({attribution:'Author',source:'Documented source'})).data)).code).toBe('');
  });
  it('enforces all bounded editor limits and rejects ownership/status injection',async()=>{
    for(const patch of [{title:'x'.repeat(101)},{body:'x'.repeat(501)},{kind:'mini_lesson',body:'x'.repeat(2001)},{bullets:Array(6).fill('x')},{bullets:['x'.repeat(201)]},{direction:'x'.repeat(1001)},{topics:Array(6).fill('x')},{locale:'fr'},{status:'published'},{organization_id:ids.foreignOrg},{is_default:true},{title:null},{priority:0.5},{title:'\n\ufeff'},{bullets:['\t']},{topics:['\u00a0']},{bullets:[' '+ 'x'.repeat(200)+' ']}])expect((await save(patch)).code).toBe('22023');
    expect((await save({title:'x'.repeat(100),body:'😀'.repeat(500),bullets:Array(5).fill('x'.repeat(200)),direction:'x'.repeat(1000),topics:Array(5).fill('topic')})).code).toBe('');
    const unicode='😀';
    expect((await save({kind:'mini_lesson',title:unicode.repeat(100),body:unicode.repeat(2000),attribution:unicode.repeat(200),source:unicode.repeat(1000),rights_note:unicode.repeat(1000),review_note:unicode.repeat(1000),bullets:Array(5).fill(unicode.repeat(200)),direction:unicode.repeat(1000),topics:Array(5).fill(unicode.repeat(80)),tone:unicode.repeat(100),learning_outcome:unicode.repeat(500)})).code).toBe('');
  });
  it('keeps reviewed Spanish explicit and never uses English as Spanish',async()=>{
    await policy();await published();expect((await list('es')).data.items).toEqual([]);
    const spanish=await published({locale:'es',title:'Escuchar',body:'Escucha antes de responder.'});expect((await list('es')).data.items.map(x=>x.id)).toEqual([spanish.id]);expect((await list('en')).data.items).toHaveLength(1);
  });
  it('persists own hiding independently from chapter policy',async()=>{
    await policy();actor='member';expect((await call('set_learning_home_hidden',[chapter,true])).data).toEqual({homeHidden:true});
    expect((await call('get_learning_policy',[chapter])).data).toMatchObject({homeHidden:true,quotesEnabled:true});
    actor='admin';expect((await call('get_learning_policy',[chapter])).data.homeHidden).toBe(false);
    actor='member';await call('set_learning_home_hidden',[chapter,false]);expect((await call('get_learning_policy',[chapter])).data.homeHidden).toBe(false);
  });
  it('audits every edit and rejects stale revisions; editing withdraws the previous publication',async()=>{
    await policy();const row=await published();const edited=await save({id:row.id,title:'Updated'},'chapter',chapter,row.revision);expect(edited,edited.message).toMatchObject({code:'',data:{status:'draft',revision:3}});
    expect((await save({id:row.id},'chapter',chapter,row.revision)).code).toBe('PT409');expect((await list()).data.items).toEqual([]);
    const history=await call('get_learning_history',[chapter,row.id,0]);expect(history.data.items.map(h=>h.action)).toEqual(['save_draft','publish','save_draft']);expect(history.data.items[0].snapshot.title).toBe('Updated');expect(history.data.items[2].snapshot.title).toBe('Authored reflection');
  });
  it('makes only reviewed platform defaults available automatically and supports bounded selection',async()=>{
    await policy();const standard=await published({is_default:true},'platform');const optIn=await published({},'platform');const own=await published();
    expect((await list()).data.items.map(r=>r.id).sort()).toEqual([standard.id,own.id].sort());
    expect((await policy('chapter',true,true,[optIn.id])).code).toBe('');expect((await list()).data.items.map(r=>r.id)).toEqual([optIn.id]);
    await policy('chapter',true,true,[]);expect((await list()).data.items).toEqual([]);
    expect((await policy('chapter',true,true,[randomUUID()])).code).toBe('42501');
  });
  it('keeps tenant-only material isolated from public platform material',async()=>{
    await policy();await published();const shared=await published({is_default:true},'platform');actor='otherAdmin';expect((await list('en',null,foreign)).data.items.map(r=>r.id)).toEqual([shared.id]);
  });
  it('lets administrators choose reviewed public content while delivery is disabled',async()=>{
    const publicItem=await published({},'platform');await save({},'platform');
    actor='otherAdmin';
    const choices=await call('list_learning_choices',[foreign,'chapter',0]);
    expect(choices,choices.message).toMatchObject({code:''});
    expect(choices.data.items.map(r=>r.id)).toEqual([publicItem.id]);
    expect((await list('en',null,foreign)).data.items).toEqual([]);
    actor='member';expect((await call('list_learning_choices',[chapter,'chapter',0])).code).toBe('42501');
  });
  it('invalidates cached policy versions on publication, policy changes and hiding',async()=>{
    const first=(await call('get_learning_policy',[chapter])).data.version;await published();const second=(await call('get_learning_policy',[chapter])).data.version;expect(second).not.toBe(first);
    await policy('chapter',false,false);const third=(await call('get_learning_policy',[chapter])).data.version;expect(third).not.toBe(second);
    await call('set_learning_home_hidden',[chapter,true]);expect((await call('get_learning_policy',[chapter])).data.version).not.toBe(third);
  });
  it('checks actual staff audience and strips unpublished donor/editorial metadata',async()=>{
    await policy();const staffRow=await published({audience:'staff'});const memberRow=await published({audience:'members'});actor='member';const result=await list();expect(result.data.items.map(r=>r.id)).toEqual([memberRow.id]);expect(result.data.items[0]).not.toHaveProperty('provenance');expect(result.data.items[0]).not.toHaveProperty('review_note');
    const memberVersion=(await call('get_learning_policy',[chapter])).data.version;
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)",[ids.org,ids.member,ids.admin]);
    const staffVersion=(await call('get_learning_policy',[chapter])).data.version;expect(staffVersion).not.toBe(memberVersion);
    expect((await list()).data.items.map(r=>r.id)).toEqual([staffRow.id]);
    await db.query("delete from public.organization_role_grants where organization_id=$1 and user_id=$2",[ids.org,ids.member]);
    expect((await call('get_learning_policy',[chapter])).data.version).toBe(memberVersion);
    expect((await list()).data.items.map(r=>r.id)).toEqual([memberRow.id]);
  });
  it('permits platform administration without granting tenant roles or requiring a chapter',async()=>{
    expect((await call('get_learning_workspace',[null,'platform',0])).code).toBe('');
    expect((await call('save_learning_content',[null,'platform',item(),null])).code).toBe('');
    actor='member';expect((await call('get_learning_workspace',[null,'platform',0])).code).toBe('42501');
    const user=ids.platformOnly;
    await db.query('insert into auth.users(id,email) values($1,$2)',[user,`${user}@example.invalid`]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",[ids.platformOnlySession,user]);
    await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Platform proof','totp','verified',now(),now())",[randomUUID(),user]);
    await db.query('insert into private.learning_platform_editors(user_id) values($1)',[user]);
    actor='platformOnly';
    expect((await call('get_learning_policy',[null])).data).toMatchObject({organizationId:null,chapterId:null,isPlatformOwner:true});
    expect((await call('get_learning_workspace',[null,'platform',0])).code).toBe('');
    expect((await call('save_learning_content',[null,'platform',item(),null])).code).toBe('');
    expect((await call('save_learning_content',[null,'organization',item(),null])).code).toBe('42501');

  });
});
