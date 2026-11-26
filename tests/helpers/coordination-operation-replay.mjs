import {randomUUID as uuid} from 'node:crypto';

export const coordinationReplayNames = ['record_organization_coordination_outreach', 'run_organization_coordination_export', 'send_organization_coordination_message', 'propose_organization_coalition_decision', 'share_organization_coordination_resource', 'take_over_public_chapter_page'];

export async function coordinationReplayFixture(db) {
  const O = [uuid(), uuid()], C = O.map(id => 'c305-' + id), U = [uuid(), uuid(), uuid(), uuid(), uuid()];
  const [A, member, B] = U, sessions = {};
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  async function seed(table, data) {
    const cols = Object.keys(data);
    await q('savepoint c305_seed');
    await q('set local session_replication_role=replica');
    try {
      const row = (await q(`insert into ${table}(${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, Object.values(data)))[0];
      await q('set local session_replication_role=origin');
      await q('release savepoint c305_seed');
      return row;
    } catch (error) { await q('rollback to savepoint c305_seed'); throw error; }
  }
  for (let i = 0; i < 2; i++) {
    await q('insert into public.organizations(id,slug,name) values($1,$2,$3)', [O[i], `c305-${O[i]}`, `Fictional C305 ${i}`]);
    await q('insert into public.chapters(id,slug,name,region,organization_id,order_index) values($1,$1,$2,$3,$4,$5)', [C[i], `Fictional C305 Chapter ${i}`, 'proof', O[i], 9990+i]);
  }
  for (let i = 0; i < U.length; i++) {
    const org = i === 2 || i === 3 ? O[1] : O[0], chap = org === O[0] ? C[0] : C[1];
    await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [U[i], `c305-${U[i]}@example.invalid`]);
    await q('update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1', [U[i], chap, `Fictional C305 Person ${i}`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active') on conflict do nothing", [org,U[i]]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now()) on conflict do nothing", [U[i],chap]);
    sessions[U[i]] = uuid();
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions[U[i]],U[i]]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [uuid(),U[i]]);
    if ([0,2,4].includes(i)) {
      await q("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [U[i],chap]);
      await q("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [U[i],chap]);
      for (const role of ['admin','coordinator','vp','advisor']) await q('insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,$3)', [U[i],org,role]);
    }
  }
  const rec = (org,user,kind,extra={}) => seed('public.organization_coordination_records', {id:uuid(),organization_id:org,created_by:user,kind,title:'Fictional C305 record',status:'active',idempotency_key:uuid(),...extra});
  async function prepare(name, key=uuid()) {
    let sql, args, table, foreign, field;
    if (name === 'record_organization_coordination_outreach') {
      const own = await rec(O[0], A, 'mobilization_campaign'); const other = await rec(O[1], B, 'mobilization_campaign');
      sql = 'public.record_organization_coordination_outreach($1,$2,\'reached\',\'Fictional note\',$3)'; args = [own.id, member, key];
      table = 'public.organization_coordination_outreach_events'; field = 'eventId';
      foreign = { campaign_id: other.id, organization_id: O[1], target_user_id: U[3], actor_user_id: B, disposition: 'reached', idempotency_key: key };
    } else if (name === 'run_organization_coordination_export') {
      const own = await rec(O[0], A, 'network_export_schedule'); const other = await rec(O[1], B, 'network_export_schedule');
      sql = 'public.run_organization_coordination_export($1,\'json\',$2)'; args = [own.id, key];
      table = 'public.organization_coordination_export_runs'; field = 'runId';
      foreign = { schedule_id: other.id, organization_id: O[1], requested_by: B, format: 'json', idempotency_key: key };
    } else if (name === 'send_organization_coordination_message') {
      const own = await rec(O[0], A, 'coalition_campaign'); const other = await rec(O[1], B, 'coalition_campaign');
      sql = 'public.send_organization_coordination_message($1,\'Fictional own message\',$2)'; args = [own.id, key];
      table = 'public.organization_coordination_messages'; field = 'messageId';
      foreign = { conversation_id: other.id, sender_organization_id: O[1], sender_user_id: B, body: 'Fictional foreign message', idempotency_key: key };
    } else if (name === 'propose_organization_coalition_decision') {
      const own = await rec(O[0], A, 'coalition_campaign'); const work = await rec(O[0], A, 'coalition_work_item', { parent_id: own.id });
      const other = await rec(O[1], B, 'coalition_campaign'); const otherWork = await rec(O[1], B, 'coalition_work_item', { parent_id: other.id });
      await seed('public.organization_coordination_organization_participants', { record_id: own.id, organization_id: O[0], role: 'owner', status: 'active' });
      sql = 'public.propose_organization_coalition_decision($1,$2,\'Fictional decision\',\'\',\'authorize_work\',1,$3)'; args = [own.id, work.id, key];
      table = 'public.organization_coalition_decisions'; field = 'decisionId';
      foreign = { campaign_id: other.id, subject_record_id: otherWork.id, proposing_organization_id: O[1], title: 'Fictional foreign decision', action: 'authorize_work', required_approvals: 1, proposed_by: B, idempotency_key: key };
    } else if (name === 'share_organization_coordination_resource') {
      const own = await rec(O[0], A, 'network_conversation', { partner_organization_id: O[1] });
      const third = uuid(); O.push(third);
      await seed('public.organizations', { id: third, slug: `c305-third-${third}`, name: 'Fictional C300 third partner' });
      const other = await rec(O[1], B, 'network_conversation', { partner_organization_id: third });
      const foreignNetwork = await rec(O[1], B, 'network_link', { partner_organization_id: third });
      await seed('public.organization_network_permission_grants', { network_record_id: foreignNetwork.id, grantor_organization_id: O[1], grantee_organization_id: third, capability: 'resource_request', status: 'active', granted_by: B });
      const network = await rec(O[0], A, 'network_link', { partner_organization_id: O[1] });
      await seed('public.organization_network_permission_grants', { network_record_id: network.id, grantor_organization_id: O[0], grantee_organization_id: O[1], capability: 'resource_request', status: 'active', granted_by: A });
      // Requests are a supported branch of this API and need no document; isolate key replay from document permissions.
      sql = 'public.share_organization_coordination_resource($1,\'request\',\'Fictional request\',null,$2)'; args = [own.id, key];
      table = 'public.organization_coordination_resources'; field = 'resourceId';
      foreign = { record_id: other.id, from_organization_id: O[1], to_organization_id: third, resource_kind: 'request', title: 'Fictional foreign request', idempotency_key: key, created_by: B };
    } else {
      for (const [org, user, code, slug] of [[O[0], A, `c305-own-${O[0]}`, 'own-page'], [O[1], B, `c305-foreign-${O[1]}`, 'foreign-page']]) {
        const copy = { title_en: 'Fictional page', title_es: 'Pagina ficticia', body_en: 'Fictional content', body_es: 'Contenido ficticio', created_by: user };
        await seed('public.public_site_records', { id: code, organization_id: org, kind: 'chapter', region_en: 'Proof', region_es: 'Prueba', ...copy });
        await seed('public.public_chapter_sections', { organization_id: org, chapter_code: code, slug: 'news', ...copy });
        await seed('public.public_chapter_pages', { organization_id: org, chapter_code: code, section_slug: 'news', slug, ...copy });
      }
      sql = 'public.take_over_public_chapter_page($1,\'news\',\'own-page\',\'Fictional reason\',$2)'; args = [`c305-own-${O[0]}`, key];
      table = 'public.public_chapter_page_takeovers'; field = 'takeoverId';
      foreign = { organization_id: O[1], chapter_code: `c305-foreign-${O[1]}`, section_slug: 'news', page_slug: 'foreign-page', previous_owner_id: B, new_owner_id: B, reason: 'Fictional foreign takeover', idempotency_key: key };
    }
    const orgColumn = {send_organization_coordination_message:'sender_organization_id',propose_organization_coalition_decision:'proposing_organization_id',share_organization_coordination_resource:'from_organization_id'}[name] ?? 'organization_id';
    const actorColumn = {record_organization_coordination_outreach:'actor_user_id',run_organization_coordination_export:'requested_by',send_organization_coordination_message:'sender_user_id',propose_organization_coalition_decision:'proposed_by',share_organization_coordination_resource:'created_by',take_over_public_chapter_page:'new_owner_id'}[name];
    const expected = id => ({
      record_organization_coordination_outreach:{recorded:true,eventId:id},
      run_organization_coordination_export:{runId:id,status:'ready',dataset:'coordination_records',rowCount:1,deliveryMode:'internal_download'},
      send_organization_coordination_message:{sent:true,messageId:id},
      propose_organization_coalition_decision:{decisionId:id,status:'open',requiredApprovals:1,eligibleOrganizations:1},
      share_organization_coordination_resource:{created:true,resourceId:id},
      take_over_public_chapter_page:{takenOver:true,takeoverId:id,chapterCode:`c305-own-${O[0]}`,pageSlug:'own-page',ownerId:A},
    }[name]);
    const changed = {
      record_organization_coordination_outreach:sql.replace("'Fictional note'", "'Changed note'"),
      run_organization_coordination_export:sql.replace("'json'", "'csv'"),
      send_organization_coordination_message:sql.replace("'Fictional own message'", "'Changed message'"),
      propose_organization_coalition_decision:sql.replace("'Fictional decision'", "'Changed decision'"),
      share_organization_coordination_resource:sql.replace("'Fictional request'", "'Changed request'"),
      take_over_public_chapter_page:sql.replace("'Fictional reason'", "'Changed reason'"),
    }[name];
    return {name,key,sql,args,table,foreign,field,orgColumn,actorColumn,expected,changed};
  }
  const claims = user => JSON.stringify({sub:user,role:'authenticated',aal:'aal2',session_id:sessions[user]});
  return {O,C,U,A,B,member,seed,rec,prepare,claims,q};
}
