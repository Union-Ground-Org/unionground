// @vitest-environment node
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {assertDisposableProofUrl} from '../scripts/run-required-db-proofs.mjs';

const migration=readFileSync(new URL('../supabase/migrations/20261109060229_unit_stewards_join_chapter_collaboration.sql',import.meta.url),'utf8');
const swapped=[...migration.matchAll(/^-- (?:policy )?([a-z0-9_.]+)(?: on [a-z0-9_.]+)? \(live definition /gm)].map((match)=>match[1]);

describe('unit stewards join chapter collaboration (static contract)',()=>{
  it('is one atomic migration that adds the staff-grant helper and leaves member_has_chapter_role alone',()=>{
    expect(migration.trimStart().startsWith('-- REQ-UG-CHAPTER-STEWARDS-COLLABORATE-ACROSS-UNITS-20261109')).toBe(true);
    expect(migration.trimEnd().endsWith('commit;')).toBe(true);
    expect(migration).toContain('create function private.member_has_chapter_staff_grant(p_chapter_id text, p_roles text[])');
    expect(migration).not.toMatch(/function private\.member_has_chapter_role\s*\(/i);
    // The only remaining call mirrors the restrictive document container policy.
    expect(migration.match(/private\.member_has_chapter_role\s*\(/gi)).toHaveLength(1);
    const container=migration.slice(migration.indexOf('create function private.chapter_document_container_allows('));
    expect(container.slice(0,container.indexOf('$function$;'))).toMatch(/private\.member_has_chapter_role\s*\(/);
  });

  it('keeps the document security definer RPCs inside the caller\'s document containers',()=>{
    for(const name of ['public.update_chapter_document_content','public.share_chapter_handshake_document']) {
      const start=migration.indexOf(`create or replace function ${name}(`);
      expect(start).toBeGreaterThan(0);
      const body=migration.slice(start,migration.indexOf('$function$;',start));
      expect(body).toContain('private.chapter_document_container_allows(');
    }
  });

  it('swaps only collaboration gates, never a member-data or member-audience gate',()=>{
    expect(swapped).toHaveLength(43);
    for(const name of ['public.casework_create_bargaining_workspace','public.update_chapter_document_content','public.list_learning_content','private.mi1_qa_is_officer','chapter_documents_read','chapter_handshakes_read_participant']) {
      expect(swapped).toContain(name);
    }
    for(const name of ['institutional_context','chapter_record_manageable','can_read_chapter_contact_record','get_institutional_records_workspace','staff_can_see_user','staff_visible_member_ids','chapter_documents_container_scope','publish_member_broadcast','seniority_staff_can_manage','record_member_access_event','get_appointment_notes','can_manage_vote_scope']) {
      expect(swapped.some((entry)=>entry.endsWith(name))).toBe(false);
    }
  });
});

const live=process.env.SUPABASE_DB_URL?describe:describe.skip;
live('unit stewards join chapter collaboration on an owned disposable database',()=>{
  it('admits unit and in-date committee stewards to collaboration gates while member data stays inside the unit',async()=>{
    const db=new pg.Client({connectionString:assertDisposableProofUrl(process.env.SUPABASE_DB_URL),application_name:'unit-steward-collaboration-rollback-proof'});
    await db.connect();await db.query('begin');
    try {
      const org=randomUUID(),foreignOrg=randomUUID();
      const chapter='g7665-'+org,foreign='g7665-'+foreignOrg;
      const people={};
      await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Workers'),($2::uuid,$2::text,'Ridge Transit')",[org,foreignOrg]);
      await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9950),($3,$3,$3,$4,9951)",[chapter,org,foreign,foreignOrg]);
      for(const [name,role,ownChapter,ownOrg] of [
        ['admin','admin',chapter,org],['unitSteward',null,chapter,org],['lapsedSteward',null,chapter,org],
        ['memberA',null,chapter,org],['memberB',null,chapter,org],['plainMember',null,chapter,org],['foreignSteward','steward',foreign,foreignOrg],
      ]) {
        const id=randomUUID(),session=randomUUID();people[name]={id,session};
        await db.query('insert into auth.users(id,email) values($1,$2)',[id,id+'@example.invalid']);
        await db.query('update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1',[id,ownChapter,'Fictional '+name]);
        await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",[session,id]);
        await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())",[randomUUID(),id]);
        await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",[ownOrg,id]);
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",[id,ownChapter]);
        if(role) {
          await db.query('insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)',[id,role,ownChapter]);
          await db.query('insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)',[id,role,ownChapter]);
        }
      }
      const owner=async()=>{await db.query('reset role');await db.query("select set_config('request.jwt.claims','',true)");};
      const as=async(name)=>{
        await owner();await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:people[name].id,role:'authenticated',session_id:people[name].session,aal:'aal2'})]);await db.query('set local role authenticated');
      };
      const one=async(sql,args=[])=> (await db.query(sql,args)).rows[0]?.v;
      const staffGrant=(who)=>as(who).then(()=>one("select private.member_has_chapter_staff_grant($1,array['steward']) v",[chapter]));

      const unitA=randomUUID(),unitB=randomUUID();
      await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Care North'),($2,$3,$4,'Rehab South')",[unitA,unitB,org,chapter]);
      await as('admin');
      await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.memberA.id,unitA]);
      await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.memberB.id,unitB]);
      await one('select public.set_chapter_access_member($1,$2,$3,null,true) v',[chapter,people.unitSteward.id,unitA]);
      await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v",[people.unitSteward.id,chapter,unitA]);
      await owner();
      const lapsed=randomUUID();
      await db.query("insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on) values($1,$2,'Past drive','Ended',current_date-30,current_date-1)",[lapsed,chapter]);
      await db.query('insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)',[people.lapsedSteward.id,'steward',chapter]);
      await db.query('insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)',[people.lapsedSteward.id,'steward',chapter]);
      // Committee-only stewards are refused;
      // retain the inactive-staff negative control as a revoked unit grant.
      await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,'steward',$3)",[people.lapsedSteward.id,chapter,unitB]);
      await db.query("delete from public.member_role_chapters where user_id=$1 and role='steward'",[people.lapsedSteward.id]);
      await db.query("delete from public.member_roles where user_id=$1 and role='steward'",[people.lapsedSteward.id]);

      // The unit steward is chapter staff for collaboration, and still not a chapter-wide steward.
      assert.equal(await staffGrant('unitSteward'),true);
      assert.equal(await one("select private.member_has_chapter_role($1,array['steward']) v",[chapter]),false);
      // Member personal details stay inside the unit.
      assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.memberA.id]),true);
      assert.equal(await one("select public.staff_can_see_user($1,'steward') v",[people.memberB.id]),false);
      // A revoked unit grant, a plain member and another organization's steward.
      assert.equal(await staffGrant('lapsedSteward'),false);
      assert.equal(await staffGrant('plainMember'),false);
      assert.equal(await staffGrant('foreignSteward'),false);

      // Staff documents: readable chapter-wide by the unit steward; a document kept in the other unit stays there.
      // The product-identity trigger stamps chapter_id from the session's member, so each insert runs with its author's claims.
      const claims=async(name)=>{await owner();await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:people[name].id,role:'authenticated',session_id:people[name].session,aal:'aal2'})]);};
      const staffDoc=randomUUID(),unitADraft=randomUUID(),unitBDoc=randomUUID(),unitBDraft=randomUUID(),foreignDoc=randomUUID();
      await claims('admin');
      await db.query("insert into public.chapter_documents(id,chapter_id,title,document_type,visibility,status,created_by,access_unit_id) values($1,$2,'Steward playbook','training','staff','published',$3,null),($4,$2,'Care North draft','training','staff','draft',$3,$5),($6,$2,'DDS-Det only','training','staff','published',$3,$7),($8,$2,'DDS-Det draft','training','staff','draft',$3,$7)",[staffDoc,chapter,people.admin.id,unitADraft,unitA,unitBDoc,unitB,unitBDraft]);
      await claims('foreignSteward');
      await db.query("insert into public.chapter_documents(id,chapter_id,title,document_type,visibility,status,created_by) values($1,$2,'Ridge steward notes','training','staff','published',$3)",[foreignDoc,foreign,people.foreignSteward.id]);
      await owner();
      assert.equal(Number(await one('select count(*) v from public.chapter_documents where chapter_id=$1 and id = any($2::uuid[])',[chapter,[staffDoc,unitADraft,unitBDoc,unitBDraft]])),4);
      await as('unitSteward');
      const visible=(await db.query('select id from public.chapter_documents where id = any($1::uuid[]) order by title',[[staffDoc,unitADraft,unitBDoc,unitBDraft,foreignDoc]])).rows.map((row)=>row.id);
      assert.deepEqual(visible,[unitADraft,staffDoc]);
      await as('plainMember');
      assert.equal(Number(await one('select count(*) v from public.chapter_documents where id=$1',[staffDoc])),0);

      // Editing through the security definer RPC honors the same container: own unit yes, the other unit no.
      const refusedCode=async(sql,args)=>{
        await db.query('savepoint negative');let failure;
        try{await db.query(sql,args);}catch(error){failure=error;}
        await db.query('rollback to savepoint negative');await db.query('release savepoint negative');
        return failure?.code;
      };
      const edit="select public.update_chapter_document_content($1,'Edited','training','','Body','staff','save') v";
      await as('unitSteward');
      assert.equal((await one(edit,[unitADraft])).title,'Edited');
      // #9277: another unit's document has the missing-document answer.
      assert.equal(await refusedCode(edit,[unitBDraft]),'22023');
      await as('lapsedSteward');
      assert.equal(await refusedCode(edit,[staffDoc]),'42501');

      // Bargaining workspace and the Q&A officer gate open to the unit steward.
      await as('unitSteward');
      const workspace=await one("select to_jsonb(public.casework_create_bargaining_workspace($1,'Successor contract',now())) v",[chapter]);
      assert.equal(workspace.chapter_id,chapter);
      // mi1_qa_is_officer is private (no authenticated EXECUTE): ask it as the owner with the caller's claims.
      await claims('unitSteward');
      assert.equal(await one('select private.mi1_qa_is_officer($1,$2) v',[org,chapter]),true);
      await claims('lapsedSteward');
      assert.equal(await one('select private.mi1_qa_is_officer($1,$2) v',[org,chapter]),false);
    } finally {await db.query('rollback');await db.end();}
  },120000);
});
