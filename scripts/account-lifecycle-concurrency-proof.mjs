import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { assertDisposableProofUrl } from './run-required-db-proofs.mjs';

// Two real connections; wait on PostgreSQL's observed lock graph, never on an
// assumed sleep duration. Fixtures and test-only barriers are disposable only.
async function waitBlocked(observer, pid) {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await observer.query('select pg_backend_pid() = any(pg_blocking_pids($1)) as blocked', [pid]);
    if (rows[0].blocked) return;
    await delay(25);
  }
  throw new Error('concurrency proof never reached its database lock barrier');
}
async function reader(client, user, session) {
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2', session_id: session })]);
  await client.query('set local role authenticated');
}

// Every entry point below runs destructive account-lifecycle mutations, so each
// one applies the shared disposable-target guard itself instead of trusting its
// caller: exact loopback hostnames on an owned disposable port, no routing
// overrides, so a lookalike such as localhost.example.com or a tunnel to a
// hosted database is refused. The refusal names the hostname, never the
// credentials or the connection string.
function requireLoopbackTarget(databaseUrl) {
  try {
    assertDisposableProofUrl(databaseUrl);
  } catch {
    let hostname = '(unparseable)';
    try { ({ hostname } = new URL(databaseUrl)); } catch { /* keep the placeholder */ }
    throw new Error(`Refusing account-lifecycle concurrency proof against non-disposable host ${hostname}`);
  }
}

export async function proveConcurrentGrantRevocation(client, databaseUrl, { midGrant = false, overlapOrder = null, graphRace = null, deletionFirst = false } = {}) {
  requireLoopbackTarget(databaseUrl);
  const worker = new pg.Client({ connectionString: databaseUrl });
  const owner = '50900905-0000-4000-8000-000000000001';
  const staff = '50900905-0000-4000-8000-000000000002';
  const actor = '50900905-0000-4000-8000-000000000005';
  const session = '50900905-0000-4000-8000-000000000003';
  const org = '50900905-0000-4000-8000-000000000004';
  const chapter = 'lifecycle-r5-race';
  let caseId;
  let deletion;
  try {
    await worker.connect();
    const pid = (await worker.query('select pg_backend_pid() as pid')).rows[0].pid;
    await worker.query("set statement_timeout='15s'");
    await client.query('begin');
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,'Disposable concurrency proof')", [org,chapter]);
    await client.query("insert into public.chapters(id,name,region,order_index,organization_id,slug) values ($1,'Disposable concurrency proof','Proof',999,$2,$1)",[chapter,org]);
    await client.query("insert into auth.users(id,email) values ($1,'race-owner@example.invalid'),($2,'race-staff@example.invalid'),($3,'race-actor@example.invalid')",[owner,staff,actor]);
    await client.query('update public.member_profiles set chapter_id=$1 where id=any($2::uuid[])',[chapter,[owner,staff]]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at) values ($1,$2,'aal2',now())",[session,staff]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[org,staff]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')",[staff,chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'coordinator',$2)",[org,staff]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa,updated_by) values (true,$1,false,$2)",[org,staff]);
    caseId = (await client.query(`insert into public.member_cases(user_id,reference,title,case_type,is_restricted,restriction_reason,restricted_at,restricted_by)
      values ($1,'R5-RACE','Disposable race case','grievance',true,'Retention regression',now(),$1) returning id`,[owner])).rows[0].id;
    const person = (await client.query("insert into public.casework_management_people(organization_id,chapter_id,display_name,created_by) values ($1,$2,'Disposable proof',$3) returning id",[org,chapter,actor])).rows[0].id;
    const entry = (await client.query(`insert into public.casework_management_entries(management_person_id,case_id,organization_id,chapter_id,occurred_at,category,summary,created_by)
      values ($1,$2,$3,$4,now(),'retaliation','Disposable retained race proof',$5) returning id`,[person,caseId,org,chapter,actor])).rows[0].id;
    const grant = (await client.query(`insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason)
      values ($1,$2,$3,$4,$5,'Disposable concurrency proof') returning id`,[caseId,org,chapter,staff,actor])).rows[0].id;
    let report; let withdrawalTicket; let withdrawalArguments; let withdrawalEnvelopes;
    if (graphRace === 'withdrawal') {
      report = '50900905-0000-4000-8000-000000000006';
      const envelope = (field, dataVersion) => ({ organization: org, record: report, field,
        purpose: 'casework_retaliation_reports', schema: '1', payload: {}, wrappedKey: {}, keyVersion: 'proof', dataVersion });
      await client.query("select set_config('app.sensitive_maintenance','on',true), set_config('app.sensitive_envelopes',$1,true)", [JSON.stringify({
        management_person: envelope('management_person','50900905-0000-4000-8000-000000000007'),
        protected_activity: envelope('protected_activity','50900905-0000-4000-8000-000000000008'),
        adverse_action: envelope('adverse_action','50900905-0000-4000-8000-000000000009'),
      })]);
      await client.query(`insert into public.casework_retaliation_reports
        (id, case_id, organization_id, chapter_id, reporter_user_id, incident_at, management_person, protected_activity, adverse_action, idempotency_key)
        values ($1,$2,$3,$4,$5,now(),'[encrypted]','[encrypted]','[encrypted]',extensions.gen_random_uuid())`,
        [report,caseId,org,chapter,staff]);
      await client.query("select set_config('app.sensitive_maintenance','off',true), set_config('app.sensitive_envelopes','',true)");
      withdrawalArguments = { p_report_id: report, p_reason: '[encrypted]' };
      withdrawalEnvelopes = { withdrawal_reason: envelope('withdrawal_reason','50900905-0000-4000-8000-000000000010') };
      withdrawalTicket = (await client.query('select public.stage_sensitive_write($1,$2,$3,$4) id',
        [staff,'casework_withdraw_retaliation_report',withdrawalArguments,withdrawalEnvelopes])).rows[0].id;
    }
    let handoff; let survey;
    if (graphRace === 'handoff') handoff = (await client.query(`insert into public.member_handoffs
      (organization_id,chapter_id,member_user_id,to_steward_id,initiated_by,idempotency_key)
      values ($1,$2,$3,$4,$5,extensions.gen_random_uuid()) returning id`,[org,chapter,owner,staff,actor])).rows[0].id;
    if (graphRace === 'survey') {
      survey = (await client.query(`insert into public.organization_surveys(organization_id,chapter_id,title,status,created_by)
        values ($1,$2,'Disposable survey','open',$3) returning id`,[org,chapter,actor])).rows[0].id;
      await client.query(`insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id)
        values ($1,$2,$3)`,[org,survey,staff]);
    }
    if (overlapOrder) await client.query('update public.member_cases set coordinator_user_id=$1, steward_user_id=$1 where id=$2',[staff,caseId]);
    await reader(client,staff,session);
    assert.equal((await client.query('select exists(select 1 from public.casework_management_entries where id=$1) as visible',[entry])).rows[0].visible,true,'active grant admits the unassigned coordinator');
    await client.query('commit');

    if (graphRace) {
      const routines = {
        addendum: ['public.casework_add_management_addendum(uuid,text)', 'select public.casework_add_management_addendum($1,$2)', [entry,'Disposable consistency addendum']],
        withdrawal: ['public.write_sensitive_content(text,jsonb,jsonb,uuid)', 'select public.write_sensitive_content($1,$2,$3,$4)', ['casework_withdraw_retaliation_report',withdrawalArguments,withdrawalEnvelopes,withdrawalTicket]],
        handoff: ['private.mi1_w2_resolve_handoff(uuid,text)', 'select public.acknowledge_member_handoff($1)', [handoff]],
        survey: ['private.mi1_w2_upsert_survey_session(uuid,jsonb,boolean)', 'select public.save_organization_survey_session($1,$2::jsonb)', [survey,'{}']],
        revokingStaff: ['public.casework_revoke_access(uuid)', 'select public.casework_revoke_access($1)', [grant]],
      };
      const [signature, sql, args] = routines[graphRace];
      const deletingWriter = ['revokingStaff','handoff','survey'].includes(graphRace);
      const target = deletingWriter ? staff : owner;
      if (deletionFirst) {
        await client.query('begin');
        await client.query('delete from auth.users where id=$1',[target]);
        await worker.query('begin');
        await reader(worker,staff,session);
        deletion = worker.query(sql,args);
        deletion.catch(() => {});
        await waitBlocked(client,pid);
        await client.query('commit');
        if (deletingWriter) {
          await assert.rejects(deletion, error => ['P0002','42501'].includes(error.code), 'removed staff must fail fresh authorization');
          await worker.query('rollback');
        } else {
          await deletion;
          await worker.query('commit');
        }
      } else {
        // Pause at the installed writer's first acquisition, before its first
        // data read. The second client must wait before acquiring an Auth row.
        const source = (await client.query('select prosrc from pg_proc where oid=$1::regprocedure',[signature])).rows[0].prosrc;
        const acquisition = source.match(/begin\s+(perform private\.lock_case_graph\([^;]+;)/i);
        assert(acquisition, `${signature} must acquire the shared gate first`);
        await client.query('begin');
        await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:staff,role:'authenticated',aal:'aal2',session_id:session})]);
        if (graphRace === 'handoff' || graphRace === 'survey') {
          // Execute the installed nested body through its child SELECT FOR UPDATE.
          // Pause with that actual child tuple held, then resume via the real RPC.
          const marker = graphRace === 'handoff'
            ? 'select * into handoff from public.member_handoffs where id = p_handoff_id for update;'
            : '  for update;';
          const end = source.indexOf(marker);
          assert(end >= 0, `${signature} child acquisition must be present`);
          const parameters = graphRace === 'handoff'
            ? `p_handoff_id uuid := '${handoff}'; p_action text := 'acknowledged';`
            : `p_survey_id uuid := '${survey}'; p_answers jsonb := '{}'; p_submit boolean := false;`;
          await client.query('do $proof$ declare ' + parameters + ' begin ' + source.slice(0,end+marker.length) + ' end; end; end $proof$');
        } else {
          await client.query('do $proof$ begin ' + acquisition[1] + ' end $proof$');
        }
        await worker.query('begin');
        deletion = worker.query('delete from auth.users where id=$1',[target]);
        deletion.catch(() => {});
        await waitBlocked(client,pid);
        await reader(client,staff,session);
        await client.query(sql,args);
        await client.query('commit');
        await deletion;
        await worker.query('commit');
      }
      if (!deletingWriter) {
        assert.equal((await client.query('select case_id is null as detached from public.casework_management_entries where id=$1',[entry])).rows[0].detached,true);
      }
      if (graphRace === 'handoff') {
        assert.equal((await client.query('select count(*)::int n from public.member_handoffs where id=$1',[handoff])).rows[0].n,0);
        assert.equal((await client.query('select count(*)::int n from public.member_steward_relationships where steward_user_id=$1',[staff])).rows[0].n,0);
      }
      if (graphRace === 'survey') assert.equal((await client.query('select count(*)::int n from public.organization_survey_sessions where respondent_user_id=$1',[staff])).rows[0].n,0);
      if (graphRace === 'addendum') assert.equal((await client.query('select count(*)::int n from public.casework_management_addenda where entry_id=$1',[entry])).rows[0].n,1);
      if (graphRace === 'withdrawal') assert.equal((await client.query('select status from public.casework_retaliation_reports where id=$1',[report])).rows[0].status,'withdrawn');
      console.log(`PASS: case-graph ${graphRace} ${deletionFirst ? 'deletion-first' : 'writer-first'} serializes with fresh authorization`);
    } else if (overlapOrder) {
      // Both statements are in flight before either transaction commits.
      const first = overlapOrder === 'owner-first' ? owner : staff;
      const second = overlapOrder === 'owner-first' ? staff : owner;
      await client.query('begin');
      await client.query('delete from auth.users where id=$1',[first]);
      await worker.query('begin');
      deletion = worker.query('delete from auth.users where id=$1',[second]);
      deletion.catch(() => {});
      await waitBlocked(client,pid);
      await client.query('commit');
      await deletion;
      await worker.query('commit');
      const retained = (await client.query(`select owner_id,steward_user_id,coordinator_user_id,grants
        from private.account_lifecycle_case_scope where case_id=$1`,[caseId])).rows[0];
      assert.deepEqual(retained,{owner_id:null,steward_user_id:null,coordinator_user_id:null,grants:[]},
        `${overlapOrder}: completed deletions leave no retained identity inputs`);
      await client.query('begin');
      await client.query("insert into auth.users(id,email) values ($1,'race-staff-new@example.invalid')",[staff]);
      await client.query('update public.member_profiles set chapter_id=$1 where id=$2',[chapter,staff]);
      await client.query("insert into auth.sessions(id,user_id,aal,created_at) values ($1,$2,'aal2',now())",[session,staff]);
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[org,staff]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')",[staff,chapter]);
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'coordinator',$2)",[org,staff]);
      await reader(client,staff,session);
      assert.equal((await client.query('select exists(select 1 from public.casework_management_entries where id=$1) as visible',[entry])).rows[0].visible,false,
        `${overlapOrder}: real JWT must deny old history after UUID re-provisioning`);
      await client.query('rollback');
      console.log(`PASS: overlapping ${overlapOrder} deletion clears retained inputs and denies re-provisioned JWT`);
    } else {
      await client.query('begin');
      if (midGrant) {
        // Execute the installed RPC's exact acquisition prefix, ending just
        // after its grant SELECT FOR UPDATE. Keep that transaction open, start
        // deletion on client two, then continue through the real RPC. This
        // explicit two-client pause needs no timer or third barrier client.
        const definition = (await client.query("select pg_get_functiondef('public.casework_revoke_access(uuid)'::regprocedure) as body")).rows[0].body;
        const marker = '  if not private.casework_staff_can_access(v_row.case_id)';
        assert(definition.includes(marker), 'revocation acquisition boundary must exist');
        const prefix = definition.slice(0,definition.indexOf(marker))
          .replace('public.casework_revoke_access(', 'private.r6_revocation_acquisition(');
        await client.query(prefix + '  return v_row;\nend;\n$function$;');
        await client.query('grant execute on function private.r6_revocation_acquisition(uuid) to authenticated');
      }
      await reader(client,staff,session);
      await client.query(midGrant ? 'select private.r6_revocation_acquisition($1)' : 'select public.casework_revoke_access($1)',[grant]);
      await client.query('reset role');
      await worker.query('begin');
      deletion = worker.query('delete from auth.users where id=$1',[owner]);
      deletion.catch(() => {});
      await waitBlocked(client,pid);
      if (midGrant) {
        await reader(client,staff,session);
        await client.query('select public.casework_revoke_access($1)',[grant]);
        await client.query('reset role');
        await client.query('drop function private.r6_revocation_acquisition(uuid)');
      }
      await client.query('commit');
      await deletion;
      await reader(worker,staff,session);
      assert.equal((await worker.query('select exists(select 1 from public.casework_management_entries where id=$1) as visible',[entry])).rows[0].visible,false,'concurrent committed revocation must deny retained history');
      await worker.query('reset role');
      assert.equal((await worker.query('select case_id is null as detached from public.casework_management_entries where id=$1',[entry])).rows[0].detached,true);
      await worker.query('rollback');
      console.log(midGrant ? 'PASS: mid-grant revocation and deletion serialize without 40P01' : 'PASS: concurrent committed grant revocation denies retained history');
    }
  } finally {
    await client.query('rollback');
    if (deletion) await deletion.catch(() => {});
    await worker.query('rollback').catch(() => {});
    await worker.end();
    // Remove only this committed fixture, with immutability triggers suppressed
    // on the local proof connection. No application data shares its org/UUIDs.
    await client.query('begin');
    await client.query('set local session_replication_role=replica');
    if (caseId) {
      await client.query('delete from private.account_lifecycle_history_scope where case_id=$1',[caseId]);
      await client.query('delete from private.account_lifecycle_case_scope where case_id=$1',[caseId]);
    }
    const tables = (await client.query("select table_name from information_schema.columns where table_schema='public' and column_name='organization_id'")).rows;
    for (const { table_name: table } of tables) {
      // Names originate solely from the installed catalog, quote identifiers.
      await client.query(`delete from public."${table.replaceAll('"','""')}" where organization_id=$1`,[org]);
    }
    await client.query('delete from public.member_chapter_memberships where chapter_id=$1',[chapter]);
    await client.query('delete from public.member_profiles where id=any($1::uuid[])',[[owner,staff,actor]]);
    await client.query('delete from auth.sessions where user_id=any($1::uuid[])',[[owner,staff,actor]]);
    await client.query('delete from auth.users where id=any($1::uuid[])',[[owner,staff,actor]]);
    await client.query('delete from public.organizations where id=$1',[org]);
    await client.query('commit');
  }
}

export async function proveConcurrentActualKeyRotation(client, databaseUrl) {
  requireLoopbackTarget(databaseUrl);
  const worker = new pg.Client({ connectionString: databaseUrl });
  const living = '50900906-0000-4000-8000-000000000001';
  const liveRequest = '50900906-0000-4000-8000-000000000003';
  let originalKey;
  let requests = [];
  try {
    await worker.connect();
    const pid = (await worker.query('select pg_backend_pid() as pid')).rows[0].pid;
    await worker.query("set statement_timeout='15s'");
    // Keep raw key material in memory only; no SQL literals, files or logs.
    originalKey = (await client.query('select secret from private.member_account_lifecycle_secret where id')).rows[0].secret;
    await client.query('begin');
    await client.query("insert into auth.users(id,email) values ($1,'rotation-live@example.invalid')",[living]);
    await client.query('set local session_replication_role=replica');
    requests = (await client.query(`insert into private.member_account_deletions(id,subject_hash,subject_hash_key_fingerprint,token_hash,status,expires_at,claimed_at)
      select request_id,private.member_lifecycle_subject_hash(u),case when n=1 then encode(extensions.digest(secret.secret,'sha256'),'hex') else repeat('0',64) end,
      repeat('a',64),'processing',now()+interval '5 minutes',now()
      from private.member_account_lifecycle_secret secret cross join (values ($1::uuid,1,$2::uuid),('50900906-0000-4000-8000-000000000002'::uuid,2,'50900906-0000-4000-8000-000000000004'::uuid)) v(u,n,request_id) where secret.id returning id,subject_hash`,[living,liveRequest])).rows;
    await client.query('set local session_replication_role=origin');
    await client.query(`create function private.r5_rotation_barrier() returns trigger language plpgsql as $$begin
      if new.failure_code='subject-key-rotated' then perform pg_advisory_xact_lock(509905); end if;
      return new; end$$;
      create trigger r5_rotation_barrier before update on private.member_account_deletions for each row execute function private.r5_rotation_barrier()`);
    await client.query('commit');
    await client.query('select pg_advisory_lock(509905)');
    await worker.query('begin');
    await worker.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
    await worker.query('set local role service_role');
    const running = worker.query('select public.reconcile_pending_account_deletions(25)');
    running.catch(() => {});
    await waitBlocked(client,pid);
    // Actual key rotation commits after fingerprint capture and before the
    // candidate query. The live identity MUST remain processing and unaudited.
    await client.query('update private.member_account_lifecycle_secret set secret=extensions.gen_random_bytes(32) where id');
    await client.query('select pg_advisory_unlock(509905)');
    await running;
    await worker.query('commit');
    const state = (await client.query(`select r.status, r.auth_deleted_at, r.finalized_at,
      exists(select 1 from auth.users where id=$2) as alive,
      exists(select 1 from private.member_account_lifecycle_audit a where a.subject_hash=r.subject_hash and event_type='deletion_completed') as completed_audit
      from private.member_account_deletions r where r.id=$1`,[liveRequest,living])).rows[0];
    assert.deepEqual(state,{status:'processing',auth_deleted_at:null,finalized_at:null,alive:true,completed_audit:false},'actual concurrent key rotation must never complete a live identity');
    console.log('PASS: concurrent actual-key rotation never completes a live identity');
  } finally {
    await client.query('rollback');
    await client.query('select pg_advisory_unlock_all()');
    await worker.query('rollback').catch(() => {});
    await worker.end();
    await client.query('begin');
    await client.query('drop trigger if exists r5_rotation_barrier on private.member_account_deletions; drop function if exists private.r5_rotation_barrier()');
    if (originalKey) await client.query('update private.member_account_lifecycle_secret set secret=$1 where id',[originalKey]);
    await client.query('set local session_replication_role=replica');
    await client.query('delete from private.member_account_lifecycle_audit where subject_hash=any($1::text[])',[requests.map(r=>r.subject_hash)]);
    await client.query('delete from private.member_account_deletions where id=any($1::uuid[])',[requests.map(r=>r.id)]);
    await client.query('set local session_replication_role=origin');
    await client.query('delete from auth.users where id=$1',[living]);
    await client.query('commit');
  }
}

export async function proveMidGrantRevocation(client, databaseUrl) {
  requireLoopbackTarget(databaseUrl);
  await proveConcurrentGrantRevocation(client, databaseUrl, { midGrant: true });
}

export async function proveOverlappingIdentityDeletion(client, databaseUrl) {
  requireLoopbackTarget(databaseUrl);
  for (const overlapOrder of ['owner-first', 'staff-first']) {
    await proveConcurrentGrantRevocation(client, databaseUrl, { overlapOrder });
  }
}

// Catalogue-wide direct-entry coverage complements the RPC child-lock pauses.
// Each real UPDATE executes its statement triggers, even with an empty row set.
// The other client deletes an actual disposable identity; rollback restores it
// between cases so every table is checked against the same explicit interleaving.
export async function proveCatalogueWriterEntry(client, databaseUrl, tables) {
  requireLoopbackTarget(databaseUrl);
  const worker = new pg.Client({ connectionString: databaseUrl });
  const identity = '50900908-0000-4000-8000-000000000001';
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  let pending;
  try {
    await worker.connect();
    await worker.query("set statement_timeout='15s'");
    const pid = (await worker.query('select pg_backend_pid() pid')).rows[0].pid;
    await client.query("insert into auth.users(id,email) values ($1,'catalogue-lock-proof@example.invalid')",[identity]);
    // The parent DELETE can cascade into graph relations after taking a
    // provider/client tuple. Exercise that entry before and after deletion too,
    // even though neither parent is itself below auth.users in the FK graph.
    const entries = [...tables.map(table => ({ table })),
      ...['auth.oauth_clients', 'auth.sso_providers'].map(table => ({ table, parentDelete: true }))];
    for (const { table, parentDelete } of entries) {
      const column = (await client.query(`select attname from pg_attribute
        where attrelid=$1::regclass and attnum>0 and not attisdropped and attgenerated='' and attidentity <> 'a'
        order by attnum limit 1`,[table])).rows[0].attname;
      const name = table.split('.').map(quote).join('.');
      const update = parentDelete ? `delete from ${name} where false`
        : `update ${name} set ${quote(column)}=${quote(column)} where false`;
      for (const deletionFirst of [false,true]) {
        await client.query('begin');
        await client.query(deletionFirst ? 'delete from auth.users where id=$1' : update, deletionFirst ? [identity] : []);
        await worker.query('begin');
        pending = worker.query(deletionFirst ? update : 'delete from auth.users where id=$1', deletionFirst ? [] : [identity]);
        pending.catch(() => {});
        await waitBlocked(client,pid);
        await client.query('rollback');
        await pending;
        await worker.query('rollback');
        pending = null;
      }
    }
    console.log(`PASS: all ${tables.length} catalogue relation entries serialize with Auth deletion in both orders`);
  } finally {
    await client.query('rollback');
    if (pending) await pending.catch(() => {});
    await worker.query('rollback').catch(() => {});
    await worker.end();
    await client.query('delete from auth.users where id=$1',[identity]);
  }
}
