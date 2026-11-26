// @vitest-environment node
// Synthetic fixtures, rolled back in a disposable local application database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';
import { buildSetupPayload, newOwnRow } from '../src/features/orgSetup/setupPayload.js';
const live = process.env.RUN_ORG_STRUCTURE_IMPORT_DB_TESTS === '1' ? it : it.skip;
live('import authorization, dry run, source provenance, root preservation, idempotency and late rollback', async () => {
  const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await c.connect();
  await c.query('begin');
  try {
    const org=randomUUID(), user=randomUUID(), session=randomUUID(), foreignOrg=randomUUID(), foreignUser=randomUUID();
    const chapter=`proof-${org}`;
    await c.query("insert into public.organizations(id,slug,name) values ($1,$3,'Synthetic import proof'),($2,$4,'Synthetic foreign proof')",[org,foreignOrg,chapter,`proof-${foreignOrg}`]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)",[chapter,org]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)",[`proof-${foreignOrg}`,foreignOrg]);
    await c.query('insert into auth.users(id,email) values ($1,$3),($2,$4)',[user,foreignUser,`${user}@example.invalid`,`${foreignUser}@example.invalid`]);
    await c.query('update public.member_profiles set chapter_id=$2 where id=$1',[user,chapter]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active'),($3,$4,'active') on conflict do nothing",[org,user,foreignOrg,foreignUser]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",[user,chapter]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",[randomUUID(),user]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",[session,user]);
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,session_id:session,role:'authenticated',aal:'aal2'})]);
    const payload={schemaVersion:'org-structure/1',attestation:{suppliedBy:'Synthetic operator',suppliedOn:'2026-09-23',authority:'Disposable test',personalContactConsent:'not_obtained'},sources:[{sourceLabel:'Synthetic source',sourceAsOf:'2026-09-23'}],charts:{union:{nodes:[{nodeKey:'proof-person',nodeKind:'person',label:'Synthetic person',memberUserId:user}]}}};
    const run=async (p=payload,dry=false) => {
      await c.query('savepoint rpc_call');
      try {
        await c.query('set local role authenticated');
        const result=(await c.query("select public.import_organization_structure('admin',$1,$2) as r",[p,dry])).rows[0].r;
        await c.query('reset role'); await c.query('release savepoint rpc_call'); return result;
      } catch(error) {
        await c.query('rollback to savepoint rpc_call'); await c.query('release savepoint rpc_call'); throw error;
      }
    };
    await c.query('savepoint denied');
    await c.query('set local role authenticated');
    await expect(run()).rejects.toMatchObject({code:'42501'});
    await c.query('rollback to denied');
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')",[org,user]);
    const counts=async () => (await c.query(`select (select count(*) from public.organization_chart_nodes where organization_id=$1)::int nodes,(select count(*) from public.organization_structure_imports where organization_id=$1)::int imports,(select count(*) from public.organization_intelligence_audit_events where organization_id=$1)::int audits`,[org])).rows[0];
    const before=await counts();
    await c.query('savepoint no_mfa');
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,session_id:session,role:'authenticated',aal:'aal1'})]);
    await c.query('set local role authenticated');
    await expect(run()).rejects.toMatchObject({code:'42501'});
    await c.query('rollback to no_mfa');
    await c.query('set local role authenticated');
    const dry=await run(payload,true);
    expect(dry.errors).toEqual([]); expect(dry.committed).toBe(false); expect(dry.auditEvents).toBe(0);
    await c.query('reset role'); expect(await counts()).toEqual(before);
    const invalid=structuredClone(payload); invalid.charts.union.nodes[0].memberUserId=foreignUser;
    expect((await run(invalid)).errors).toEqual(expect.arrayContaining([expect.objectContaining({code:'unknown_member'})]));
    await c.query("insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,'revoked',now())",[org,foreignUser]);
    expect((await run(invalid)).errors).toEqual(expect.arrayContaining([expect.objectContaining({code:'unknown_member'})]));
    const wrongChapter=structuredClone(payload); wrongChapter.charts.union.nodes[0].chapterKey=`proof-${foreignOrg}`;
    expect((await run(wrongChapter)).errors).toEqual(expect.arrayContaining([expect.objectContaining({code:'unknown_chapter'})]));
    const unknownSource=structuredClone(payload); unknownSource.sources[0].extra='unmapped';
    expect((await run(unknownSource)).errors).toEqual(expect.arrayContaining([expect.objectContaining({code:'unknown_property'})]));
    await c.query('set local role authenticated');
    const committed=await run(); expect(committed.errors).toEqual([]); expect(committed.committed).toBe(true); expect(committed.auditEvents).toBe(1);
    await c.query('reset role');
    expect((await c.query('select sources from public.organization_structure_imports where id=$1',[committed.importId])).rows[0].sources).toEqual(payload.sources);
    const first=await counts(); expect(first.nodes).toBe(before.nodes+1); expect(first.audits).toBe(before.audits+1);
    const repeated=await run(); expect(repeated.committed).toBe(true); expect((await counts()).nodes).toBe(first.nodes);
    // A later setup adds units beneath the same anchor without replacing its
    // edited fields or any of the content attached to it.
    await c.query('savepoint setup_root');
    const setup = (name, row) => buildSetupPayload({
      organizationId: org, organizationName: name,
      rows: [newOwnRow(row, 'chapter', row)], attestation: payload.attestation,
    });
    const initialSetup = await setup('Initial chart', 'First unit');
    expect(await run(initialSetup)).toMatchObject({ committed: true, errors: [] });
    const rootId = (await c.query("select id from public.organization_chart_nodes where organization_id=$1 and import_key='cat.root'", [org])).rows[0].id;
    const initialChild = initialSetup.charts.union.nodes[1];
    expect((await c.query('select parent_id from public.organization_chart_nodes where organization_id=$1 and import_key=$2', [org, initialChild.nodeKey])).rows[0].parent_id).toBe(rootId);
    const parentId = (await c.query("update public.organization_chart_nodes set user_id=null where organization_id=$1 and import_key='proof-person' returning id", [org])).rows[0].id;
    await c.query("update public.organization_chart_nodes set label='Edited anchor', subtitle='Retain subtitle', parent_id=$2, chapter_id=$3, node_kind='person', user_id=$4, badge='Retain badge', position_x=75 where id=$1", [rootId, parentId, chapter, user]);
    await c.query("insert into public.organization_chart_node_contacts(organization_id,node_id,contact_kind,contact_value) values($1,$2,'email','synthetic@example.invalid')", [org, rootId]);
    await c.query("insert into public.organization_chart_node_notes(organization_id,node_id,body) values($1,$2,'Retain note')", [org, rootId]);
    await c.query("insert into public.organization_chart_node_metrics(organization_id,node_id,metric_key,metric_value) values($1,$2,'members',42)", [org, rootId]);
    const agencyTarget = randomUUID();
    await c.query("insert into public.organization_chart_nodes(id,organization_id,chart_kind,node_kind,label,created_by,updated_by) values($1,$2,'agency','organization','Linked agency',$3,$3)", [agencyTarget, org, user]);
    await c.query("insert into public.organization_chart_cross_references(organization_id,node_id,target_node_id,reference_kind,label,sort_order) values($1,$2,$3,'context_note','Retain agency link',7)", [org, rootId, agencyTarget]);
    const rootSnapshot = async () => (await c.query(`select to_jsonb(n) node,
      (select jsonb_agg(c order by c.id) from public.organization_chart_node_contacts c where c.node_id=n.id) contacts,
      (select jsonb_agg(t order by t.id) from public.organization_chart_node_notes t where t.node_id=n.id) notes,
      (select jsonb_agg(m order by m.id) from public.organization_chart_node_metrics m where m.node_id=n.id) metrics,
      (select jsonb_agg(r order by r.id) from public.organization_chart_cross_references r where r.node_id=n.id) cross_references
      from public.organization_chart_nodes n where n.id=$1`, [rootId])).rows[0];
    const savedRoot = await rootSnapshot();
    const laterSetup = await setup('Changed chart title', 'Second unit');
    const laterDryRun = await run(laterSetup, true);
    expect(laterDryRun).toMatchObject({ committed: false, errors: [] });
    expect(await rootSnapshot()).toEqual(savedRoot);
    const laterCommit = await run(laterSetup);
    expect(laterCommit).toMatchObject({ committed: true, errors: [] });
    expect(await rootSnapshot()).toEqual(savedRoot);
    expect(laterDryRun.counts.chart_node).toBe(1);
    expect(laterCommit.counts.chart_node).toBe(1);
    expect((await c.query('select parent_id from public.organization_chart_nodes where organization_id=$1 and import_key=$2', [org, laterSetup.charts.union.nodes[1].nodeKey])).rows[0].parent_id).toBe(rootId);
    const rootOnly = { ...laterSetup, chapters: [], charts: { union: { nodes: [{ ...laterSetup.charts.union.nodes[0], crossReferences: [{ referenceKind: 'context_note', label: 'Ignore replacement link' }] }] } } };
    expect(await run(rootOnly)).toMatchObject({ committed: true, errors: [], auditEvents: 0, counts: { chart_node: 0, chart_cross_reference: 0 } });
    expect(await rootSnapshot()).toEqual(savedRoot);
    // The reserved anchor belongs only to the union chart. Ordinary imports
    // (including the same key in the agency chart) keep their update semantics.
    const agencyRoot = { ...rootOnly, charts: { agency: { nodes: [{ nodeKey: 'cat.root', nodeKind: 'organization', label: 'Agency initial' }] } } };
    expect(await run(agencyRoot)).toMatchObject({ committed: true, errors: [] });
    agencyRoot.charts.agency.nodes[0].label = 'Agency edited';
    expect(await run(agencyRoot)).toMatchObject({ committed: true, errors: [], counts: { chart_node: 1 } });
    expect((await c.query("select label from public.organization_chart_nodes where organization_id=$1 and chart_kind='agency' and import_key='cat.root'", [org])).rows[0].label).toBe('Agency edited');
    expect(await rootSnapshot()).toEqual(savedRoot);
    await c.query('rollback to savepoint setup_root');
    // The kept anchor keeps its saved parent and member, so dry run and commit
    // must judge the chart the import leaves behind (gate round 3 on #4101).
    const chart = (nodes) => ({ ...payload, charts: { union: { nodes } } });
    const anchor = { nodeKey: 'cat.root', nodeKind: 'organization', label: 'Anchor' };
    const unit = (nodeKey, parentKey) => ({ nodeKey, nodeKind: 'division', label: nodeKey, ...(parentKey ? { parentKey } : {}) });
    const parentOf = async (key) => (await c.query('select p.import_key from public.organization_chart_nodes n left join public.organization_chart_nodes p on p.id=n.parent_id where n.organization_id=$1 and n.chart_kind=$2 and n.import_key=$3', [org, 'union', key])).rows[0].import_key;
    const refusedBoth = async (p, code, path) => {
      for (const dryRun of [true, false]) {
        const result = await run(p, dryRun);
        expect(result).toMatchObject({ committed: false, auditEvents: 0 });
        expect(result.errors).toEqual([expect.objectContaining({ code, path })]);
      }
    };
    await c.query('savepoint direct_cycle');
    expect(await run(chart([unit('division.west'), { ...anchor, parentKey: 'division.west' }]))).toMatchObject({ committed: true, errors: [] });
    await refusedBoth(chart([anchor, unit('division.west', 'cat.root')]), 'cycle', 'charts.union.nodes[1].parentKey');
    expect([await parentOf('cat.root'), await parentOf('division.west')]).toEqual(['division.west', null]);
    // The same units without the closing edge still import.
    expect(await run(chart([anchor, unit('division.west')]))).toMatchObject({ committed: true, errors: [] });
    await c.query('rollback to savepoint direct_cycle');
    await c.query('savepoint untouched_cycle');
    expect(await run(chart([unit('division.west'), unit('district.mid', 'division.west'), { ...anchor, parentKey: 'district.mid' }]))).toMatchObject({ committed: true, errors: [] });
    await refusedBoth(chart([anchor, unit('local.new', 'cat.root'), unit('division.west', 'local.new')]), 'cycle', 'charts.union.nodes[1].parentKey');
    expect([await parentOf('cat.root'), await parentOf('district.mid'), await parentOf('division.west')]).toEqual(['district.mid', 'division.west', null]);
    await c.query('rollback to savepoint untouched_cycle');
    await c.query('savepoint identity_conflict');
    await c.query("update public.organization_chart_nodes set user_id=null where organization_id=$1 and import_key='proof-person'", [org]);
    expect(await run(chart([{ ...anchor, nodeKind: 'person', memberUserId: user }]))).toMatchObject({ committed: true, errors: [] });
    await refusedBoth(chart([anchor, { nodeKey: 'new.person', nodeKind: 'person', label: 'Person', memberUserId: user }]), 'identity_in_use', 'charts.union.nodes[1].memberUserId');
    expect((await c.query("select user_id from public.organization_chart_nodes where organization_id=$1 and chart_kind='union' and import_key='cat.root'", [org])).rows[0].user_id).toBe(user);
    await c.query('rollback to savepoint identity_conflict');
    // A row the payload does not name keeps its member the same way.
    await refusedBoth(chart([{ nodeKey: 'other.person', nodeKind: 'person', label: 'Other', memberUserId: user }]), 'identity_in_use', 'charts.union.nodes[0].memberUserId');
    // Refuse at the ledger, after node writes, and prove the subtransaction restores all rows.
    await c.query("create function pg_temp.refuse_import() returns trigger language plpgsql as $$ begin raise exception 'synthetic late refusal'; end $$");
    await c.query('create trigger proof_refuse_import before insert on public.organization_structure_imports for each row execute function pg_temp.refuse_import()');
    const preFailure=await counts(); const late=structuredClone(payload); late.charts.union.nodes[0].nodeKey='late-person'; delete late.charts.union.nodes[0].memberUserId;
    const refused=await run(late); expect(refused.committed).toBe(false); expect(refused.auditEvents).toBe(0); expect(refused.errors).toEqual(expect.arrayContaining([expect.objectContaining({code:'write_refused'})]));
    expect(await counts()).toEqual(preFailure);
  } finally { await c.query('rollback'); await c.end(); }
});

// Lifecycle invariant 3: auth.users deletion cascades into organization_memberships,
// so the imported person-node link must detach, never restrict, and all three
// account-lifecycle inventories must stay empty with the import installed.
live('imported member account deletion detaches the chart node and keeps lifecycle inventories empty', async () => {
  const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await c.connect();
  await c.query('begin');
  try {
    for (const fn of ['account_lifecycle_unmanaged_restrictive_fks', 'account_lifecycle_unmanaged_export_fks', 'account_lifecycle_referential_action_trigger_issues']) {
      expect((await c.query(`select * from private.${fn}()`)).rows, fn).toEqual([]);
    }
    const fk=(await c.query("select confdeltype, (select array_agg(attname::text order by attname) from pg_attribute where attrelid=conrelid and attnum=any(confdelsetcols)) cols from pg_constraint where conname='organization_chart_nodes_user_membership_fkey'")).rows[0];
    expect(fk).toEqual({confdeltype:'n', cols:['user_id']});
    const org=randomUUID(), admin=randomUUID(), member=randomUUID(), session=randomUUID();
    const chapter=`proof-${org}`;
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,'Synthetic deletion proof')",[org,chapter]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)",[chapter,org]);
    await c.query('insert into auth.users(id,email) values ($1,$3),($2,$4)',[admin,member,`${admin}@example.invalid`,`${member}@example.invalid`]);
    await c.query('update public.member_profiles set chapter_id=$2 where id = any($1::uuid[])',[[admin,member],chapter]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active'),($1,$3,'active') on conflict do nothing",[org,admin,member]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$3,'active'),($2,$3,'active') on conflict do nothing",[admin,member,chapter]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')",[org,admin]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",[randomUUID(),admin]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",[session,admin]);
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:admin,session_id:session,role:'authenticated',aal:'aal2'})]);
    const payload={schemaVersion:'org-structure/1',attestation:{suppliedBy:'Synthetic operator',suppliedOn:'2026-09-23',authority:'Disposable test',personalContactConsent:'not_obtained'},sources:[{sourceLabel:'Synthetic source',sourceAsOf:'2026-09-23'}],charts:{union:{nodes:[{nodeKey:'proof-member',nodeKind:'person',label:'Synthetic member',memberUserId:member}]}}};
    await c.query('savepoint rpc'); await c.query('set local role authenticated');
    const committed=(await c.query("select public.import_organization_structure('admin',$1,false) r",[payload])).rows[0].r;
    await c.query('reset role'); await c.query('release savepoint rpc');
    expect(committed).toMatchObject({committed:true, errors:[]});
    const node=async()=> (await c.query("select id, user_id from public.organization_chart_nodes where organization_id=$1 and import_key='proof-member'",[org])).rows;
    const [placed]=await node(); expect(placed.user_id).toBe(member);
    await c.query("select set_config('request.jwt.claims','',true)");
    // The same statement self-service deletion finalizes with; RESTRICT raised 23503 here.
    await c.query('delete from auth.users where id=$1',[member]);
    expect(await node()).toEqual([{id:placed.id, user_id:null}]);
    expect((await c.query('select count(*)::int n from public.organization_memberships where user_id=$1',[member])).rows[0].n).toBe(0);
    // Deleting the importing operator detaches the ledger attribution and keeps the ledger.
    // A second admin keeps the organization's existing last-admin guard satisfied.
    const successor=randomUUID();
    await c.query('insert into auth.users(id,email) values ($1,$2)',[successor,`${successor}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",[org,successor]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')",[org,successor]);
    await c.query('delete from auth.users where id=$1',[admin]);
    expect((await c.query('select actor_user_id from public.organization_structure_imports where id=$1',[committed.importId])).rows).toEqual([{actor_user_id:null}]);
    for (const fn of ['account_lifecycle_unmanaged_restrictive_fks', 'account_lifecycle_unmanaged_export_fks', 'account_lifecycle_referential_action_trigger_issues']) {
      expect((await c.query(`select * from private.${fn}()`)).rows, fn).toEqual([]);
    }
  } finally { await c.query('rollback'); await c.end(); }
}, 300000); // two account deletions plus two lifecycle inventories; 60 s was too tight on the shared CI proof stack
