// @vitest-environment node
// Rollback-only proof against an owned disposable full application database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
const live = process.env.RUN_APPOINTMENT_BOUNDARY_DB_TESTS === '1' ? it : it.skip;
live('chapter-null organization boundary holds through roster, slots, and booking', async () => {
  const c=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL)});
  await c.connect(); await c.query('begin');
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
    const roster=()=>rpc('select public.get_bookable_stewards() r');
    // Optional composed member draft proof; appointment-only runs remain valid.
    const home = process.env.RUN_MEMBER_STEWARD_COMPOSITION_DB_TESTS === '1'
      ? () => rpc('select public.get_member_chapter_stewards() r') : null;
    if (home) await c.query('update public.member_profiles set chapter_id=$2 where id=$1',[steward,chapter]);
    const slots=(id)=>rpc("select public.get_appointment_slots('office_hours',20,current_date+1,current_date+1,$1) r",[id]);
    const book=(id)=>rpc("select public.book_appointment('office_hours',20,(current_date+1+time '10:00') at time zone 'UTC','Synthetic local proof',$1) r",[id]);
    // Explicit reproduction mode runs untouched Main, so a passing denial suite
    // cannot be manufactured by applying the candidate inside the assertions.
    if(process.env.APPOINTMENT_BOUNDARY_APPLY_DRAFT==='1') await c.query(readFileSync(new URL('../supabase/migrations/20260924170100_appointment_organization_boundary.sql',import.meta.url),'utf8'));
    if(process.env.APPOINTMENT_BOUNDARY_EXPECT_LEGACY==='1') {
      expect(await roster()).toEqual([expect.objectContaining({id:steward})]);
      expect((await slots(steward)).slots.length).toBeGreaterThan(0);
      expect((await slots(null)).slots.length).toBeGreaterThan(0);
      for(const id of [steward,null]) {
        await c.query('savepoint legacy_book');
        expect(await book(id)).toEqual(expect.objectContaining({stewardId:steward}));
        await c.query('rollback to savepoint legacy_book');
        await c.query('release savepoint legacy_book');
      }
      return;
    }
    const denied=async(homeDenied=true)=>{
      if (home && homeDenied) expect(await home()).toEqual([]);
      expect(await roster()).toEqual([]);
      expect((await slots(null)).slots).toEqual([]);
      await expect(slots(steward)).rejects.toMatchObject({code:'22023'});
      await expect(book(steward)).rejects.toMatchObject({code:'22023'});
      await expect(book(null)).rejects.toMatchObject({code:'22023'});
      expect((await c.query('select count(*)::int n from public.member_appointments where user_id=$1',[caller])).rows[0].n).toBe(0);
    };
    await denied(); // active membership in foreign organization only
    await c.query('delete from public.organization_memberships where user_id=$1',[steward]);
    await denied(); // no membership
    await c.query("insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,'revoked',now())",[org,steward]);
    await denied(); // revoked/inactive (the only non-active vocabulary)
    await c.query("update public.organization_memberships set status='active',revoked_at=null where user_id=$1",[steward]);
    const allowed=async()=>{
      if (home) expect(await home()).toEqual([expect.objectContaining({id:steward, acceptsAppointments:true, contact:{conversation:true,email:null,phone:null}})]);
      expect(await roster()).toEqual([expect.objectContaining({id:steward})]);
      expect((await slots(steward)).slots.length).toBeGreaterThan(0);
      expect((await slots(null)).slots.length).toBeGreaterThan(0);
      for(const id of [steward,null]) {
        await c.query('savepoint booked');
        expect(await book(id)).toEqual(expect.objectContaining({stewardId:steward}));
        expect((await c.query('select count(*)::int n from public.member_appointments where user_id=$1 and steward_id=$2',[caller,steward])).rows[0].n).toBe(1);
        await c.query('rollback to savepoint booked'); await c.query('release savepoint booked');
      }
    };
    await allowed(); // chapter-null role + active same-org membership
    await c.query('update public.member_roles set chapter_id=$2 where user_id=$1',[steward,chapter]);
    await allowed(); // explicit chapter role
    await c.query('update public.member_roles set chapter_id=$2 where user_id=$1',[steward,foreignChapter]);
    await denied(); // membership alone never bypasses chapter role
    await c.query('alter table public.member_roles disable trigger member_roles_forbid_new_ownerless');
    await c.query('update public.member_roles set chapter_id=null where user_id=$1',[steward]);
    await c.query('alter table public.member_roles enable trigger member_roles_forbid_new_ownerless');
    await c.query('update public.member_appointment_schedules set accepting=false where steward_id=$1',[steward]);
    await denied(false);
    if (home) {
      expect(await home()).toEqual([expect.objectContaining({id:steward, acceptsAppointments:false, contact:{conversation:true,email:null,phone:null}})]);
      await c.query('update public.member_profiles set chapter_id=$2 where id=$1',[steward,foreignChapter]);
      expect(await home()).toEqual([]); // Home retains its extra profile/chapter boundary.
    }
  } finally {await c.query('rollback'); await c.end();}
},60000);
