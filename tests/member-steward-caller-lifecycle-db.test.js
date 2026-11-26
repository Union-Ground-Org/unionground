// @vitest-environment node
// Real authenticated RPCs against an owned disposable full application replay.
// Apply the staged composition before invoking; assertions never install a repair.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
const live = process.env.RUN_MEMBER_STEWARD_COMPOSITION_DB_TESTS === '1' ? it : it.skip;
live('caller lifecycle protects roster, first message, and steward contact preferences', async () => {
 const c = new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL)});
 await c.connect();
 await c.query('begin');
 try {
    const org=randomUUID(), foreignOrg=randomUUID(), caller=randomUUID(), steward=randomUUID(), session=randomUUID();
    const chapter=`proof-${org}`, foreignChapter=`proof-${foreignOrg}`;
    await c.query("insert into public.organizations(id,slug,name) values ($1,$3,$3),($2,$4,$4)",[org,foreignOrg,chapter,foreignChapter]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900),($3,$3,$3,'proof',$4,9901)",[chapter,org,foreignChapter,foreignOrg]);
    await c.query('insert into auth.users(id,email) values ($1,$3),($2,$4)',[caller,steward,`${caller}@example.invalid`,`${steward}@example.invalid`]);
    await c.query('update public.member_profiles set chapter_id=$2 where id=$1',[caller,chapter]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active'),($3,$4,'active') on conflict do nothing",[org,caller,foreignOrg,steward]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$3,'active'),($2,$3,'active') on conflict(user_id,chapter_id) do update set status='active'",[caller,steward,chapter]);
    // Emulate a retained pre-guard legacy row; restore the write guard before RPCs.
    await c.query('alter table public.member_roles disable trigger member_roles_forbid_new_ownerless');
    await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',null) on conflict(user_id,role) do update set chapter_id=null",[steward]);
    await c.query('alter table public.member_roles enable trigger member_roles_forbid_new_ownerless');
    await c.query("insert into public.member_appointment_schedules(steward_id,timezone,min_notice_minutes) values ($1,'UTC',0)",[steward]);
    await c.query('insert into public.member_appointment_windows(steward_id,weekday,start_minute,end_minute) select $1,d,600,720 from generate_series(0,6) d',[steward]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",[randomUUID(),caller]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",[session,caller]);
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:caller,session_id:session,role:'authenticated',aal:'aal2'})]);
    const rpc=async(sql,args=[])=>{
      await c.query('savepoint rpc');
      try { await c.query('set local role authenticated'); const result=await c.query(sql,args); await c.query('reset role'); await c.query('release savepoint rpc'); return result.rows[0].r; }
      catch(e){await c.query('rollback to savepoint rpc'); await c.query('release savepoint rpc'); throw e;}
    };

    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[org,steward]);
    await c.query('update public.member_profiles set chapter_id=$2 where id=$1',[steward,chapter]);
    await c.query("insert into public.steward_contact_preferences(steward_user_id,share_email,contact_email) values ($1,true,'synthetic@example.invalid')",[steward]);
    const results=[];
    const observe=async(label)=>{
      const row={label};
      for(const [name,sql,args] of [
        ['organization','select private.current_member_organization() r',[]],
        ['roster','select public.get_member_chapter_stewards() r',[]],
        ['message','select public.start_member_steward_conversation($1,$2) r',[steward,'Synthetic rollback-only lifecycle proof']]
      ]) {
        await c.query('savepoint observe');
        try {const value=await rpc(sql,args);row[name]={allowed:true,...(name==='roster'?{count:value.length,contactShown:value.some(x=>x.contact?.email==='synthetic@example.invalid')}:name==='organization'?{hasOrganization:Boolean(value)}:{created:Boolean(value.created)})};}
        catch(error){row[name]={allowed:false,code:error.code,message:error.message};}
        await c.query('rollback to savepoint observe');await c.query('release savepoint observe');
      }
      row.profileUnchanged=(await c.query('select chapter_id=$2 intact from public.member_profiles where id=$1',[caller,chapter])).rows[0].intact;
      results.push(row);
    };
    await observe('active');
    await c.query("update public.organization_memberships set status='revoked',revoked_at=now() where organization_id=$1 and user_id=$2",[org,caller]);
    await observe('caller-membership-revoked');
    await c.query("update public.organization_memberships set status='active',revoked_at=null where organization_id=$1 and user_id=$2",[org,caller]);
    await c.query("update public.organizations set status='archived' where id=$1",[org]);await observe('organization-archived');
    await c.query("update public.organizations set status='suspended' where id=$1",[org]);await observe('organization-suspended');
    await c.query("update public.organizations set status='active' where id=$1",[org]);await observe('restored');
    const stewardSession=randomUUID();
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",[randomUUID(),steward]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",[stewardSession,steward]);
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:steward,session_id:stewardSession,role:'authenticated',aal:'aal2'})]);
    const contactResults=[];
    for(const state of ['active','revoked','archived','suspended','restored']) {
      await c.query("update public.organizations set status=$2 where id=$1",[org,['archived','suspended'].includes(state)?state:'active']);
      await c.query("update public.organization_memberships set status=$2,revoked_at=case when $2='revoked' then now() else null end where user_id=$1",[steward,state==='revoked'?'revoked':'active']);
      for(const [operation,sql] of [['write',"select public.set_my_steward_contact_visibility(true,false,'synthetic@example.invalid',null) r"],['read','select public.get_my_steward_contact_visibility() r'],['withdraw','select public.set_my_steward_contact_visibility(false,false,null,null) r']]) {
        try {await rpc(sql);contactResults.push({state,operation,allowed:true});}
        catch(error){contactResults.push({state,operation,allowed:false,code:error.code,message:error.message});}
      }
    }
    for (const row of results) {
      const allowed = ['active', 'restored'].includes(row.label);
      expect(row.profileUnchanged, row.label).toBe(true);
      expect(row.organization.hasOrganization, row.label).toBe(allowed);
      if (allowed) {
        expect(row.roster, row.label).toMatchObject({allowed:true,count:1,contactShown:true});
        expect(row.message, row.label).toMatchObject({allowed:true,created:true});
      } else {
        expect(row.roster, row.label).toMatchObject({allowed:false,code:'42501'});
        expect(row.message, row.label).toMatchObject({allowed:false,code:'42501'});
      }
    }
    // Publishing needs the steward's full lifecycle; reading one's own row and
    // withdrawing need only the MFA session, so ineligible stewards can take
    // down what they shared.
    for (const row of contactResults) {
      const allowed = row.operation !== 'write' || ['active', 'restored'].includes(row.state);
      expect(row.allowed, `${row.state}/${row.operation}`).toBe(allowed);
      if (!allowed) expect(row.code).toBe('42501');
    }
    expect((await c.query('select count(*)::int n from public.member_conversations where user_id=$1',[caller])).rows[0].n).toBe(0);
 } finally {await c.query('rollback'); await c.end();}
},60000);
