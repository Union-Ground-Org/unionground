import pg from "pg";

const { Client } = pg;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// private.mfa_satisfied(), which every member role check calls, admits only a
// JWT whose session_id names a live auth.sessions row of that member
// (20260901153738_mfa_reset_session_boundary), so each signed-in persona gets
// its own session. Called as the connecting role, before it switches; the
// session goes with the transaction or with the fixture user.
const SESSION_INSERT = "insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), $1, now(), now()) returning id";

export async function memberClaims(client, userId, role, aal) {
  const { rows } = await client.query(SESSION_INSERT, [userId]);
  return { sub: userId, role, aal, session_id: rows[0].id };
}

// Race peers sign in with sessions written and committed before the race, as
// the auth server writes them at login. A peer that wrote its own session
// would hold the auth bookkeeping lock (509, 701) that writing auth.sessions
// takes (20260912002000), and a session written mid-race would queue behind
// the account deletion it races; either way the proof would measure the
// fixture, not the product.
const raceSessions = new Map();

export async function prepareRaceSessions(observer, userIds) {
  for (const userId of userIds) {
    const { rows } = await observer.query(SESSION_INSERT, [userId]);
    raceSessions.set(userId, rows[0].id);
  }
}

export function raceClaims(userId, aal) {
  const session = raceSessions.get(userId);
  if (!session) throw new Error(`no prepared race session for ${userId}`);
  return { sub: userId, role: "authenticated", aal, session_id: session };
}

// Before a disposable fixture organization is deleted: every row that still
// names it through a foreign key, such as the rows delivery and dues triggers
// queue for its members (engagement_delivery_outbox, dues_member_subjects),
// read from the catalog so a table added later cannot strand the cleanup.
// Passes repeat so rows that reference one another clear in order; anything
// left makes the organization delete fail with its own message.
export async function deleteOrganizationDependents(client, organizationIds) {
  const { rows } = await client.query(`
    select c.conrelid::regclass::text as table_name, a.attname as column_name
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.organizations'::regclass and cardinality(c.conkey) = 1
  `);
  let pending = rows;
  for (let pass = 0; pass < 6 && pending.length; pass += 1) {
    const left = [];
    for (const { table_name: table, column_name: column } of pending) {
      await client.query("savepoint mi1_dependents");
      try {
        await client.query(`delete from ${table} where "${column.replace(/"/g, '""')}" = any($1::uuid[])`, [organizationIds]);
        await client.query("release savepoint mi1_dependents");
      } catch {
        await client.query("rollback to savepoint mi1_dependents");
        left.push({ table_name: table, column_name: column });
      }
    }
    if (left.length === pending.length) break;
    pending = left;
  }
}

async function setRole(client, role, userId = null, aal = "aal2") {
  await client.query("reset role");
  const claims = userId ? await memberClaims(client, userId, role, aal) : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

async function expectState(client, label, statement, values, state) {
  const savepoint = `mi1_ext_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(statement, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected SQLSTATE ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

async function authenticateClient(client, userId, aal = "aal2") {
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(raceClaims(userId, aal)),
  ]);
  await client.query("set local role authenticated");
}

async function waitForAdvisoryWait(observer, applicationName) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const waiting = await observer.query(`
      select 1 from pg_catalog.pg_stat_activity
      where application_name = $1 and wait_event_type = 'Lock' and wait_event = 'advisory'
    `, [applicationName]);
    if (waiting.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${applicationName} did not reach the advisory-lock wait`);
}

async function waitForDatabaseLock(observer, applicationName) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const waiting = await observer.query(`
      select 1 from pg_catalog.pg_stat_activity
      where application_name = $1 and wait_event_type = 'Lock'
    `, [applicationName]);
    if (waiting.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${applicationName} did not reach the database-lock wait`);
}

export async function runMi1XdbSecurityExtensions(url, observer) {
  const ids = {
    sample: "50920000-0000-4000-8000-000000000001",
    sampleConflict: "50920000-0000-4000-8000-000000000002",
    nonSample: "50920000-0000-4000-8000-000000000003",
    orgAdminA: "50920000-0000-4000-8000-000000000004",
    orgAdminB: "50920000-0000-4000-8000-000000000005",
    chapterAdminA: "50920000-0000-4000-8000-000000000006",
    ordinaryA: "50920000-0000-4000-8000-000000000007",
    memberA2: "50920000-0000-4000-8000-000000000008",
    memberB: "50920000-0000-4000-8000-000000000009",
    multi: "50920000-0000-4000-8000-000000000010",
    deleteTarget: "50920000-0000-4000-8000-000000000011",
    deleteBackup: "50920000-0000-4000-8000-000000000012",
    revoker: "50920000-0000-4000-8000-000000000013",
    revokerBackup: "50920000-0000-4000-8000-000000000014",
    orgA: "50920000-0000-4000-8000-000000000101",
    orgB: "50920000-0000-4000-8000-000000000102",
    orgDeleteA: "50920000-0000-4000-8000-000000000103",
    orgDeleteB: "50920000-0000-4000-8000-000000000104",
    audit: "50920000-0000-4000-8000-000000000201",
    conversationB: "50920000-0000-4000-8000-000000000202",
  };

  let stage = "fixture setup";
  await observer.query("begin");
  try {
    await setRole(observer, "postgres");
    await observer.query(`
      insert into auth.users (id, email, raw_app_meta_data) values
        ($1, 'mi1-sample-owner@example.invalid', '{"sample":true,"surface":"sample"}'::jsonb),
        ($2, 'mi1-sample-conflict@example.invalid', '{"sample":true,"surface":"sample"}'::jsonb),
        ($3, 'mi1-nonsample@example.invalid', '{}'::jsonb),
        ($4, 'mi1-org-admin-a@example.invalid', '{}'::jsonb),
        ($5, 'mi1-org-admin-b@example.invalid', '{}'::jsonb),
        ($6, 'mi1-chapter-admin-a@example.invalid', '{}'::jsonb),
        ($7, 'mi1-ordinary-a@example.invalid', '{}'::jsonb),
        ($8, 'mi1-member-a2@example.invalid', '{}'::jsonb),
        ($9, 'mi1-member-b@example.invalid', '{}'::jsonb),
        ($10, 'mi1-multi@example.invalid', '{}'::jsonb),
        ($11, 'mi1-delete-target@example.invalid', '{}'::jsonb),
        ($12, 'mi1-delete-backup@example.invalid', '{}'::jsonb),
        ($13, 'mi1-revoker@example.invalid', '{}'::jsonb),
        ($14, 'mi1-revoker-backup@example.invalid', '{}'::jsonb)
    `, [
      ids.sample, ids.sampleConflict, ids.nonSample, ids.orgAdminA, ids.orgAdminB,
      ids.chapterAdminA, ids.ordinaryA, ids.memberA2, ids.memberB, ids.multi,
      ids.deleteTarget, ids.deleteBackup, ids.revoker, ids.revokerBackup,
    ]);

    await observer.query(`
      insert into public.organizations (id, slug, name, created_by) values
        ($1, 'mi1-ext-a', 'MI1 Extension A', $3),
        ($2, 'mi1-ext-b', 'MI1 Extension B', $4),
        ($5, 'mi1-delete-a', 'MI1 Delete A', $6),
        ($7, 'mi1-delete-b', 'MI1 Delete B', $6)
    `, [ids.orgA, ids.orgB, ids.orgAdminA, ids.orgAdminB, ids.orgDeleteA, ids.deleteTarget, ids.orgDeleteB]);
    await observer.query(`
      insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
        ('mi1-ext-a1', 'MI1 Extension A1', 'mi1-ext-a1', true, 1, $1),
        ('mi1-ext-a2', 'MI1 Extension A2', 'mi1-ext-a2', false, 2, $1),
        ('mi1-ext-b1', 'MI1 Extension B1', 'mi1-ext-b1', true, 1, $2),
        ('mi1-delete-a', 'MI1 Delete Chapter A', 'mi1-delete-a', true, 1, $3),
        ('mi1-delete-b', 'MI1 Delete Chapter B', 'mi1-delete-b', true, 1, $4)
    `, [ids.orgA, ids.orgB, ids.orgDeleteA, ids.orgDeleteB]);

    await observer.query(`
      insert into public.organization_memberships (organization_id, user_id, status) values
        ($1,$5,'active'),($1,$6,'active'),($1,$7,'active'),($1,$8,'active'),($1,$9,'active'),($1,$10,'active'),
        ($2,$11,'active'),($2,$12,'active'),($2,$9,'active'),($2,$10,'active'),
        ($3,$13,'active'),($3,$14,'active'),($4,$13,'active'),($4,$14,'active'),
        ($1,$15,'active')
    `, [
      ids.orgA, ids.orgB, ids.orgDeleteA, ids.orgDeleteB,
      ids.orgAdminA, ids.chapterAdminA, ids.ordinaryA, ids.memberA2, ids.multi,
      ids.revoker, ids.orgAdminB, ids.memberB, ids.deleteTarget, ids.deleteBackup,
      ids.revokerBackup,
    ]);
    await observer.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status) values
        ($1,'mi1-ext-a1','active'),($2,'mi1-ext-a1','active'),($3,'mi1-ext-a1','active'),
        ($4,'mi1-ext-a2','active'),($5,'mi1-ext-a1','active'),($5,'mi1-ext-a2','active'),($5,'mi1-ext-b1','active'),
        ($6,'mi1-ext-b1','active'),($7,'mi1-ext-b1','active'),
        ($8,'mi1-delete-a','active'),($9,'mi1-delete-a','active'),
        ($8,'mi1-delete-b','active'),($9,'mi1-delete-b','active'),
        ($10,'mi1-ext-a1','active'),($10,'mi1-ext-a2','active'),($10,'mi1-ext-b1','active'),
        ($11,'mi1-ext-a1','active')
    `, [
      ids.orgAdminA, ids.chapterAdminA, ids.ordinaryA, ids.memberA2, ids.multi,
      ids.orgAdminB, ids.memberB, ids.deleteTarget, ids.deleteBackup,
      ids.revoker, ids.revokerBackup,
    ]);
    await observer.query("set local session_replication_role = replica");
    await observer.query(`
      insert into public.chapters (id, name, slug, is_default, order_index, organization_id)
      values ('mi1-ext-orphan', 'MI1 Extension Orphan', 'mi1-ext-orphan', false, 509, null)
    `);
    await observer.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status)
      values ($1, 'mi1-ext-orphan', 'active'),
             ($2, 'mi1-delete-a', 'active')
    `, [ids.revoker, ids.multi]);
    await observer.query("set local session_replication_role = origin");
    await observer.query(`
      update public.member_profiles set chapter_id = case id
        when $1 then 'mi1-ext-a1' when $2 then 'mi1-ext-a1' when $3 then 'mi1-ext-a1'
        when $4 then 'mi1-ext-a2' when $5 then 'mi1-ext-a1'
        when $6 then 'mi1-ext-b1' when $7 then 'mi1-ext-b1'
        when $8 then 'mi1-delete-a' when $9 then 'mi1-delete-a'
        when $10 then 'mi1-ext-a1' when $11 then 'mi1-ext-a1' end
      where id = any($12::uuid[])
    `, [
      ids.orgAdminA, ids.chapterAdminA, ids.ordinaryA, ids.memberA2, ids.multi,
      ids.orgAdminB, ids.memberB, ids.deleteTarget, ids.deleteBackup,
      ids.revoker, ids.revokerBackup,
      [ids.orgAdminA, ids.chapterAdminA, ids.ordinaryA, ids.memberA2, ids.multi,
        ids.orgAdminB, ids.memberB, ids.deleteTarget, ids.deleteBackup, ids.revoker, ids.revokerBackup],
    ]);
    await observer.query(`
      update public.member_profiles set full_name = case id
        when $1 then 'MI1 Org Admin A' when $2 then 'MI1 Chapter Admin A'
        when $3 then 'MI1 Ordinary A' when $4 then 'MI1 Member A2'
        when $5 then 'MI1 Multi Tenant' when $6 then 'MI1 Org Admin B'
        when $7 then 'MI1 Member B' else full_name end
      where id = any($8::uuid[])
    `, [
      ids.orgAdminA, ids.chapterAdminA, ids.ordinaryA, ids.memberA2,
      ids.multi, ids.orgAdminB, ids.memberB,
      [ids.orgAdminA, ids.chapterAdminA, ids.ordinaryA, ids.memberA2,
        ids.multi, ids.orgAdminB, ids.memberB],
    ]);
    await observer.query(`
      insert into public.organization_role_grants (organization_id,user_id,role,granted_by) values
        ($1,$3,'admin',$3),($2,$4,'admin',$4),
        ($5,$7,'admin',$7),($6,$7,'admin',$7),
        ($1,$8,'admin',$8),($1,$9,'admin',$9),
        ($1,$10,'steward',$3),($2,$10,'steward',$4)
    `, [ids.orgA, ids.orgB, ids.orgAdminA, ids.orgAdminB, ids.orgDeleteA, ids.orgDeleteB,
      ids.deleteTarget, ids.revoker, ids.revokerBackup, ids.multi]);
    await observer.query(`
      insert into public.member_roles (user_id,role,chapter_id,granted_by) values
        ($1,'admin','mi1-ext-a1',$2),($3,'coordinator','mi1-ext-a1',$2),
        ($4,'advisor','mi1-ext-a2',$2),($5,'vp','mi1-ext-b1',$6)
    `, [ids.chapterAdminA, ids.orgAdminA, ids.ordinaryA, ids.memberA2, ids.memberB, ids.orgAdminB]);
    await observer.query(`
      insert into public.member_role_chapters (user_id,role,chapter_id,granted_by) values
        ($1,'admin','mi1-ext-a1',$2),($3,'coordinator','mi1-ext-a1',$2),
        ($4,'advisor','mi1-ext-a2',$2),($5,'vp','mi1-ext-b1',$6)
    `, [ids.chapterAdminA, ids.orgAdminA, ids.ordinaryA, ids.memberA2, ids.memberB, ids.orgAdminB]);
    await observer.query(`
      insert into public.org_security_policy (id, organization_id, require_staff_mfa) values
        (true,$1,false),(true,$2,false),(true,$3,false),(true,$4,false)
    `, [ids.orgA, ids.orgB, ids.orgDeleteA, ids.orgDeleteB]);
    await observer.query(`
      insert into public.member_conversations(id,user_id,title,initials)
      values ($1,$2,'MI1 cross-tenant visibility proof','XB')
    `, [ids.conversationB, ids.memberB]);

    stage = "selected-tenant explicit actor messaging";
    // A dual-hatted steward selected in Org A must not use an Org B grant to
    // read/write an Org B member conversation. The same explicit actor becomes
    // authorized when their active selected chapter is actually in Org B.
    await setRole(observer, "authenticated", ids.multi, "aal2");
    await expectState(
      observer,
      "cross_tenant_contact_note",
      "select public.create_member_contact_note($1,'must not cross tenant',null)",
      [ids.conversationB],
      "22023",
    );
    await setRole(observer, "postgres");
    let result = await observer.query(
      "select private.staff_actor_can_see_user($1,$2) allowed",
      [ids.multi, ids.memberB],
    );
    assert(!result.rows[0].allowed, "explicit actor visibility ignored the selected organization");
    result = await observer.query(
      "select count(*)::int count from public.member_contact_notes where conversation_id=$1",
      [ids.conversationB],
    );
    assert(result.rows[0].count === 0, "cross-tenant contact-note denial left a row behind");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-b1' where id=$1", [ids.multi]);
    result = await observer.query(
      "select private.staff_actor_can_see_user($1,$2) allowed",
      [ids.multi, ids.memberB],
    );
    assert(result.rows[0].allowed, "same-tenant explicit actor visibility positive control failed");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-a1' where id=$1", [ids.multi]);

    stage = "SAMPLE ownerless-role matrix";
    // SAMPLE compatibility: signed app metadata only, both fresh and conflict-update paths.
    await setRole(observer, "postgres");
    await observer.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role: "service_role" }),
    ]);
    await observer.query(
      "insert into public.member_roles (user_id, role, chapter_id) values ($1, 'admin', null)",
      [ids.sample],
    );
    await observer.query(
      "insert into public.member_roles (user_id, role, chapter_id) values ($1, 'vp', 'mi1-ext-a1')",
      [ids.sampleConflict],
    );
    await observer.query(
      "update public.member_roles set chapter_id = null where user_id = $1 and role = 'vp'",
      [ids.sampleConflict],
    );
    await expectState(observer, "sample_non_sample", "insert into public.member_roles (user_id,role,chapter_id) values ($1,'admin',null)", [ids.nonSample], "42501");
    await expectState(observer, "sample_wrong_role", "insert into public.member_roles (user_id,role,chapter_id) values ($1,'steward',null)", [ids.sampleConflict], "42501");
    await setRole(observer, "authenticated", ids.sample, "aal2");
    await expectState(observer, "sample_unsigned", "update public.member_roles set role='vp' where user_id=$1 and role='admin'", [ids.sample], "42501");

    stage = "chapter-membership revocation replacement";
    // Revocation selects only a same-tenant replacement and attributes audit before self-removal.
    await setRole(observer, "authenticated", ids.revoker, "aal2");
    await observer.query("select public.revoke_member_chapter_membership($1,'mi1-ext-a1')", [ids.revoker]);
    await setRole(observer, "postgres");
    result = await observer.query("select chapter_id from public.member_profiles where id=$1", [ids.revoker]);
    assert(result.rows[0].chapter_id === "mi1-ext-a2", "same-tenant replacement did not select A2");
    result = await observer.query("select organization_id from public.member_admin_audit where actor=$1 and action='revoke_chapter_membership' order by created_at desc limit 1", [ids.revoker]);
    assert(result.rows[0]?.organization_id === ids.orgA, "self-revoke audit lost tenant attribution");
    await setRole(observer, "authenticated", ids.revoker, "aal2");
    await observer.query("select public.revoke_member_chapter_membership($1,'mi1-ext-a2')", [ids.revoker]);
    await setRole(observer, "postgres");
    result = await observer.query("select chapter_id from public.member_profiles where id=$1", [ids.revoker]);
    assert(result.rows[0].chapter_id === null, "foreign membership became a same-tenant replacement");

    stage = "NULL-selected multi-organization recovery";
    // Losing the final selected-organization chapter must not strand an active
    // membership in another organization. A chapter row without its matching
    // organization membership remains undiscoverable and unusable.
    await setRole(observer, "postgres");
    await observer.query("savepoint mi1_multi_org_recovery");
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    await observer.query("select public.revoke_member_chapter_membership($1,'mi1-ext-a2')", [ids.multi]);
    await observer.query("select public.revoke_member_chapter_membership($1,'mi1-ext-a1')", [ids.multi]);
    await setRole(observer, "postgres");
    result = await observer.query("select chapter_id from public.member_profiles where id=$1", [ids.multi]);
    assert(result.rows[0].chapter_id === null, "last Org A revocation did not clear the multi-org selection");
    await setRole(observer, "authenticated", ids.multi, "aal2");
    result = await observer.query("select public.get_my_chapter_memberships() value");
    const recoveryMemberships = JSON.stringify(result.rows[0].value);
    assert(
      recoveryMemberships.includes("mi1-ext-b1")
        && !recoveryMemberships.includes("mi1-ext-a1")
        && !recoveryMemberships.includes("mi1-ext-a2")
        && !recoveryMemberships.includes("mi1-delete-a"),
      "NULL-selected membership discovery did not isolate the caller's active organizations",
    );
    await expectState(observer, "null_selected_foreign_switch", "select public.switch_my_chapter('mi1-delete-a')", [], "42501");
    result = await observer.query("select public.switch_my_chapter('mi1-ext-b1') value");
    assert(result.rows[0].value.chapterId === "mi1-ext-b1", "NULL-selected member could not recover through Org B");
    await setRole(observer, "postgres");
    result = await observer.query("select chapter_id from public.member_profiles where id=$1", [ids.multi]);
    assert(result.rows[0].chapter_id === "mi1-ext-b1", "Org B recovery did not persist the selected chapter");
    await observer.query("rollback to savepoint mi1_multi_org_recovery");
    await observer.query("release savepoint mi1_multi_org_recovery");
    await setRole(observer, "postgres");

    stage = "invitation lifecycle";
    // Bootstrap-style organization admins need no legacy member_roles shadow.
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    let invited = await observer.query(
      "select public.create_member_invitation('mi1-ext-invite@example.invalid','MI1 Invite','mi1-ext-a1',null,'en',repeat('a',64)) value",
    );
    assert(invited.rows[0].value.send === true, "organization admin could not create a chapter invitation");
    const firstInvitation = invited.rows[0].value.invitationId;
    await observer.query("select public.record_member_invitation_delivery($1,1,'sent')", [firstInvitation]);
    invited = await observer.query("select public.resend_member_invitation($1,repeat('b',64)) value", [firstInvitation]);
    const replacementInvitation = invited.rows[0].value.invitationId;
    await observer.query("select public.revoke_member_invitation($1)", [replacementInvitation]);
    result = await observer.query("select public.get_member_invitations(50) value");
    assert(result.rows[0].value.chapter.id === "mi1-ext-a1", "invitation list escaped selected chapter");
    await expectState(observer, "invite_sibling", "select public.create_member_invitation('mi1-sibling@example.invalid','Sibling','mi1-ext-a2',null,'en',repeat('c',64))", [], "42501");
    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    await expectState(observer, "invite_ordinary", "select public.get_member_invitations(10)", [], "42501");
    await setRole(observer, "authenticated", ids.orgAdminB, "aal2");
    await expectState(observer, "invite_foreign", "select public.create_member_invitation('mi1-foreign@example.invalid','Foreign','mi1-ext-a1',null,'en',repeat('d',64))", [], "42501");
    await setRole(observer, "postgres");
    await observer.query("update public.org_security_policy set require_staff_mfa=true where organization_id=$1", [ids.orgA]);
    await setRole(observer, "authenticated", ids.chapterAdminA, "aal2");
    await expectState(observer, "invite_missing_factor", "select public.get_member_invitations(10)", [], "42501");
    await setRole(observer, "postgres");
    await observer.query(`
      insert into auth.mfa_factors (id,user_id,friendly_name,factor_type,status,created_at,updated_at)
      values ('50920000-0000-4000-8000-000000000099',$1,'MI1 extension proof','totp','verified',now(),now())
    `, [ids.chapterAdminA]);
    await setRole(observer, "authenticated", ids.chapterAdminA, "aal1");
    await expectState(observer, "invite_low_assurance", "select public.get_member_invitations(10)", [], "42501");
    await setRole(observer, "authenticated", ids.chapterAdminA, "aal2");
    invited = await observer.query(
      "select public.create_member_invitation('mi1-chapter-admin@example.invalid','Chapter Admin','mi1-ext-a1',null,'en',repeat('e',64)) value",
    );
    assert(invited.rows[0].value.send === true, "chapter admin could not create an invitation in the selected chapter");
    await setRole(observer, "postgres");
    await observer.query(`
      update public.member_chapter_memberships
      set status='revoked', revoked_at=now()
      where user_id=$1 and chapter_id='mi1-ext-a1'
    `, [ids.chapterAdminA]);
    await setRole(observer, "authenticated", ids.chapterAdminA, "aal2");
    await expectState(observer, "invite_revoked_membership", "select public.get_member_invitations(10)", [], "42501");
    await setRole(observer, "postgres");
    await observer.query(`
      update public.member_chapter_memberships
      set status='active', revoked_at=null
      where user_id=$1 and chapter_id='mi1-ext-a1'
    `, [ids.chapterAdminA]);
    await observer.query("update public.org_security_policy set require_staff_mfa=false where organization_id=$1", [ids.orgA]);

    stage = "tenant-scoped staff readers";
    // Tenant-bound staff/admin readers never return Org B identities to Org A.
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    for (const [label, statement] of [
      ["roster", "select public.get_staff_roster() value"],
      ["directory", "select public.get_admin_member_directory(null,null,null,50) value"],
      ["search", "select public.admin_search_members('MI1') value"],
      ["structure", "select public.get_admin_org_structure() value"],
      ["mfa", "select public.get_admin_mfa_status() value"],
    ]) {
      result = await observer.query(statement);
      const payload = JSON.stringify(result.rows[0].value);
      assert(!payload.includes(ids.memberB) && !payload.includes("MI1 Extension B1"), `${label} exposed Org B`);
      assert(
        label === "structure" ? payload.includes("mi1-ext-a2") : payload.includes(ids.memberA2),
        `${label} did not provide organization-wide visibility to the Org A admin`,
      );
    }
    await setRole(observer, "authenticated", ids.chapterAdminA, "aal2");
    for (const [label, statement] of [
      ["roster", "select public.get_staff_roster() value"],
      ["directory", "select public.get_admin_member_directory(null,null,null,50) value"],
      ["search", "select public.admin_search_members('MI1') value"],
      ["structure", "select public.get_admin_org_structure() value"],
      ["mfa", "select public.get_admin_mfa_status() value"],
    ]) {
      result = await observer.query(statement);
      const payload = JSON.stringify(result.rows[0].value);
      assert(
        !payload.includes(ids.memberA2)
          && !payload.includes("mi1-ext-a2")
          && !payload.includes(ids.memberB)
          && !payload.includes("mi1-ext-b1"),
        `${label} escaped the chapter admin's selected chapter`,
      );
      if (label !== "structure") {
        assert(payload.includes(ids.ordinaryA), `${label} omitted a selected-chapter staff member`);
      }
    }

    stage = "tenant-owned rewards";
    // Reward ownership protects PII, mutations, RLS, and server-side effects.
    await setRole(observer, "postgres");
    stage = "tenant-owned rewards: item fixtures";
    await observer.query(`
      insert into public.member_reward_items
        (key,label_en,label_es,icon,bucket,min_tier,fulfillment,active,sort,effect_kind,effect_config)
      values
        ('mi1-owned-reward','MI1 owned reward','Recompensa MI1','', 'util',1,'ship',true,509200,'permission','{}'::jsonb),
        ('mi1-admin-reward','MI1 admin reward','Recompensa admin MI1','', 'util',1,'instant',true,509201,'permission','{}'::jsonb),
        ('mi1-chapter-reward','MI1 chapter reward','Recompensa capítulo MI1','', 'util',1,'instant',true,509202,'permission','{}'::jsonb)
    `);
    await setRole(observer, "authenticated", ids.multi, "aal2");
    stage = "tenant-owned rewards: Org A claim";
    let claimed = await observer.query("select public.claim_reward('mi1-owned-reward','Org A','123 Example Street') value");
    const grantA = claimed.rows[0].value.grantId;
    await setRole(observer, "postgres");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-b1' where id=$1", [ids.multi]);
    await setRole(observer, "authenticated", ids.multi, "aal2");
    stage = "tenant-owned rewards: Org B claim";
    claimed = await observer.query("select public.claim_reward('mi1-owned-reward','Org B','456 Example Avenue') value");
    const grantB = claimed.rows[0].value.grantId;
    assert(grantA !== grantB, "same reward item could not be owned independently by two tenants");
    await setRole(observer, "postgres");
    await observer.query("update public.member_reward_grants set status='granted' where id=$1", [grantA]);
    await observer.query("set local session_replication_role = replica");
    await observer.query("insert into public.member_reward_grants (user_id,item_key,status,source,note) values ($1,'mi1-admin-reward','claimed','member_claim','legacy-null')", [ids.nonSample]);
    await observer.query("set local session_replication_role = origin");
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    stage = "tenant-owned rewards: admin queue";
    result = await observer.query("select public.get_admin_reward_queue() value");
    let queue = JSON.stringify(result.rows[0].value);
    assert(queue.includes("123 Example Street") && !queue.includes("456 Example Avenue") && !queue.includes("legacy-null"), "reward queue crossed tenant or legacy quarantine");
    await expectState(observer, "reward_foreign_revoke", "select public.revoke_reward($1,'foreign')", [grantB], "22023");
    await expectState(observer, "reward_foreign_shipping", "select public.set_reward_shipping_address($1,'789 Foreign Street')", [grantB], "22023");
    await expectState(observer, "reward_foreign_fulfill", "select public.fulfill_reward($1,'Carrier','TRACK-FOREIGN')", [grantB], "22023");
    await expectState(observer, "reward_foreign_grant", "select public.grant_reward($1,'mi1-admin-reward','foreign')", [ids.memberB], "42501");
    let granted = await observer.query("select public.grant_reward($1,'mi1-admin-reward','same tenant') value", [ids.memberA2]);
    const adminGrant = granted.rows[0].value.grantId;
    await observer.query("select public.fulfill_reward($1,null,null)", [adminGrant]);
    await setRole(observer, "authenticated", ids.chapterAdminA, "aal2");
    await expectState(observer, "reward_sibling_grant", "select public.grant_reward($1,'mi1-chapter-reward','sibling')", [ids.memberA2], "42501");
    granted = await observer.query("select public.grant_reward($1,'mi1-chapter-reward','selected chapter') value", [ids.ordinaryA]);
    const chapterGrant = granted.rows[0].value.grantId;
    await observer.query("select public.fulfill_reward($1,null,null)", [chapterGrant]);
    await setRole(observer, "postgres");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-a1' where id=$1", [ids.multi]);
    await setRole(observer, "authenticated", ids.multi, "aal2");
    result = await observer.query("select private.member_reward_effect_enabled($1,'mi1-owned-reward') enabled, public.get_member_reward_effects() effects", [ids.multi]);
    assert(result.rows[0].enabled && JSON.stringify(result.rows[0].effects).includes("mi1-owned-reward"), "Org A reward effect positive control failed");
    await setRole(observer, "postgres");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-b1' where id=$1", [ids.multi]);
    await setRole(observer, "authenticated", ids.multi, "aal2");
    stage = "tenant-owned rewards: RLS and effect";
    result = await observer.query("select count(*)::int count from public.member_reward_grants");
    assert(result.rows[0].count === 1, "reward RLS exposed another tenant or legacy NULL row");
    result = await observer.query("select private.member_reward_effect_enabled($1,'mi1-owned-reward') enabled, public.get_member_reward_effects() effects", [ids.multi]);
    assert(!result.rows[0].enabled && !JSON.stringify(result.rows[0].effects).includes("mi1-owned-reward"), "Org B inherited Org A reward effect");
    await setRole(observer, "postgres");
    await expectState(observer, "reward_ownerless", "insert into public.member_reward_grants (user_id,item_key,status,source) values ($1,'mi1-admin-reward','claimed','member_claim')", [ids.ordinaryA], "42501");

    stage = "first-wave feature tenant and privacy boundaries";
    await setRole(observer, "postgres");
    await observer.query(`
      insert into public.public_site_records (
        id, kind, title_en, title_es, body_en, body_es, region_en, region_es,
        is_published, published_at, created_by, organization_id
      ) values
        ('mi1-ext-site-a', 'chapter', 'Site A', 'Sitio A', 'Org A chapter', 'Capítulo A',
         'East', 'Este', true, now(), $1, $2),
        ('mi1-ext-site-b', 'chapter', 'Site B', 'Sitio B', 'Org B chapter', 'Capítulo B',
         'West', 'Oeste', true, now(), $3, $4)
    `, [ids.orgAdminA, ids.orgA, ids.orgAdminB, ids.orgB]);
    await observer.query(`
      insert into public.public_site_records (
        id, kind, title_en, title_es, body_en, body_es, location_en, location_es,
        starts_at, is_published, published_at, created_by, organization_id, chapter_code
      ) values (
        'mi1-ext-valid-event', 'meeting', 'Valid event', 'Evento válido',
        'Valid RSVP proof event', 'Evento para prueba de RSVP', 'East', 'Este',
        now() + interval '1 day', true, now(), $1, $2, 'mi1-ext-site-a'
      )
    `, [ids.orgAdminA, ids.orgA]);

    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query("select id from public.public_site_records where id like 'mi1-ext-site-%' order by id");
    assert(
      result.rows.length === 1 && result.rows[0].id === "mi1-ext-site-a",
      "public-site staff RLS exposed a foreign tenant",
    );
    await expectState(
      observer,
      "public_site_direct_update",
      "update public.public_site_records set sort_order=509 where id='mi1-ext-site-b'",
      [],
      "42501",
    );
    result = await observer.query("delete from public.public_site_records where id='mi1-ext-site-b'");
    assert(result.rowCount === 0, "public-site staff RLS deleted a foreign tenant");
    await expectState(
      observer,
      "public_site_cross_tenant_insert",
      `insert into public.public_site_records
         (id,kind,title_en,title_es,body_en,body_es,region_en,region_es,created_by,organization_id)
       values ('mi1-ext-site-cross','chapter','Cross','Cruce','Cross tenant','Cruce de organización',
               'East','Este',$1,$2)`,
      [ids.orgAdminA, ids.orgB],
      "42501",
    );

    await setRole(observer, "postgres", ids.ordinaryA, "aal2");
    result = await observer.query(`
      insert into public.member_cases (user_id,reference,title,case_type,articles)
      values ($1,'MI1-IMMUTABLE','MI1 immutable tenant case','grievance','')
      returning id, organization_id, chapter_id
    `, [ids.ordinaryA]);
    const immutableCase = result.rows[0].id;
    assert(
      result.rows[0].organization_id === ids.orgA && result.rows[0].chapter_id === "mi1-ext-a1",
      "new case did not derive its immutable tenant owner",
    );
    await setRole(observer, "postgres");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-b1' where id=$1", [ids.ordinaryA]);
    result = await observer.query(`
      select organization_id, chapter_id, private.mi1_w2_case_organization(id) resolved_organization_id
      from public.member_cases where id=$1
    `, [immutableCase]);
    assert(
      result.rows[0].organization_id === ids.orgA
        && result.rows[0].chapter_id === "mi1-ext-a1"
        && result.rows[0].resolved_organization_id === ids.orgA,
      "profile movement re-homed a historical case or its visibility resolver",
    );
    await expectState(
      observer,
      "case_owner_immutable",
      "update public.member_cases set organization_id=$1 where id=$2",
      [ids.orgB, immutableCase],
      "42501",
    );
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-a1' where id=$1", [ids.ordinaryA]);

    await observer.query("update public.member_profiles set chapter_id='mi1-ext-orphan' where id=$1", [ids.revoker]);
    result = await observer.query(`
      insert into public.member_cases (user_id,reference,title,case_type,articles)
      values ($1,'MI1-LEGACY','MI1 legacy compatibility case','grievance','')
      returning id,organization_id,chapter_id
    `, [ids.revoker]);
    const legacyCase = result.rows[0].id;
    assert(
      result.rows[0].organization_id === null && result.rows[0].chapter_id === null,
      "legacy case insert escaped ownerless quarantine",
    );
    await observer.query("update public.member_cases set status='resolved' where id=$1", [legacyCase]);
    result = await observer.query("select status,organization_id,chapter_id from public.member_cases where id=$1", [legacyCase]);
    assert(
      result.rows[0].status === "resolved"
        && result.rows[0].organization_id === null
        && result.rows[0].chapter_id === null,
      "legacy case update was blocked or assigned fictional ownership",
    );
    await observer.query("update public.member_profiles set chapter_id=null where id=$1", [ids.revoker]);

    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    result = await observer.query(
      "select public.ask_member_qa_question('MI1 follow-up queue proof','This question still needs an official answer.',gen_random_uuid()) value",
    );
    const followUpQuestion = result.rows[0].value.id;
    await setRole(observer, "authenticated", ids.chapterAdminA, "aal2");
    await expectState(
      observer,
      "qa_non_author_follow_up",
      "select public.reply_member_qa_follow_up($1,'I have the same question and more context.',gen_random_uuid())",
      [followUpQuestion],
      "42501",
    );
    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    result = await observer.query(
      "select public.reply_member_qa_follow_up($1,'Additional context from the question author.',gen_random_uuid()) value",
      [followUpQuestion],
    );
    assert(result.rows[0].value.status === "open", "member follow-up incorrectly marked a question officially replied");
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query("select public.list_member_qa_officer_queue() value");
    assert(
      result.rows[0].value.questions.some((item) => item.id === followUpQuestion),
      "member follow-up removed an unanswered question from the officer queue",
    );

    // Exercise the accepted-answer follow-up path itself. The transition must
    // reopen the question and append both audit events without leaking a
    // metadata key outside organization_audit_ledger's allowlist.
    result = await observer.query(
      "select public.reply_member_qa_official($1,'MI1 accepted follow-up official answer',gen_random_uuid()) value",
      [followUpQuestion],
    );
    const followUpOfficialReply = result.rows[0].value.replies.find((reply) => reply.kind === "official").id;
    const followUpExpectedUpdatedAt = result.rows[0].value.updatedAt;
    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    result = await observer.query(
      "select public.accept_member_qa_answer($1,$2,true,$3::timestamptz) value",
      [followUpQuestion, followUpOfficialReply, followUpExpectedUpdatedAt],
    );
    assert(result.rows[0].value.status === "accepted", "follow-up proof question could not accept its official answer");
    result = await observer.query(
      "select public.reply_member_qa_follow_up($1,'Accepted answer needs this additional context.',gen_random_uuid()) value",
      [followUpQuestion],
    );
    assert(
      result.rows[0].value.status === "open"
        && result.rows[0].value.acceptedReplyId === null
        && result.rows[0].value.replies.some((reply) => reply.kind === "follow_up"),
      "accepted-answer follow-up did not reopen the question",
    );

    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    result = await observer.query(
      "select public.ask_member_qa_question('MI1 deleted reply proof','This question proves deleted reply redaction.',gen_random_uuid()) value",
    );
    const qaQuestion = result.rows[0].value.id;
    assert(
      result.rows[0].value.authoredByMe === true
        && !("authorId" in result.rows[0].value),
      "Q&A projection did not expose a privacy-safe ownership bit",
    );
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query(
      "select public.reply_member_qa_official($1,'MI1 deleted reply secret body',gen_random_uuid()) value",
      [qaQuestion],
    );
    const qaReply = result.rows[0].value.replies[0].id;
    let qaExpectedUpdatedAt = result.rows[0].value.updatedAt;
    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    result = await observer.query(
      "select public.accept_member_qa_answer($1,$2,true,$3::timestamptz) value",
      [qaQuestion, qaReply, qaExpectedUpdatedAt],
    );
    assert(
      result.rows[0].value.status === "accepted"
        && result.rows[0].value.acceptedReplyId === qaReply
        && result.rows[0].value.replies[0].accepted === true,
      "question author could not accept an official Q&A answer",
    );
    qaExpectedUpdatedAt = result.rows[0].value.updatedAt;
    await expectState(
      observer,
      "qa_stale_accept",
      "select public.accept_member_qa_answer($1,$2,true,$3::timestamptz)",
      [qaQuestion, qaReply, new Date(Date.parse(qaExpectedUpdatedAt) - 1_000).toISOString()],
      "PT409",
    );
    result = await observer.query(
      "select public.accept_member_qa_answer($1,$2,true,$3::timestamptz) value",
      [qaQuestion, qaReply, qaExpectedUpdatedAt],
    );
    assert(
      result.rows[0].value.status === "accepted"
        && result.rows[0].value.acceptedReplyId === qaReply
        && result.rows[0].value.replies[0].accepted === true,
      "repeated Q&A acceptance did not converge on the requested state",
    );
    qaExpectedUpdatedAt = result.rows[0].value.updatedAt;
    result = await observer.query(
      "select public.accept_member_qa_answer($1,$2,false,$3::timestamptz) value",
      [qaQuestion, qaReply, qaExpectedUpdatedAt],
    );
    assert(
      result.rows[0].value.status === "replied"
        && result.rows[0].value.acceptedReplyId === null
        && result.rows[0].value.replies[0].accepted === false,
      "Q&A answer could not be set back to unaccepted",
    );
    result = await observer.query(
      "select public.toggle_member_qa_vote('question',$1,true) value",
      [qaQuestion],
    );
    assert(
      result.rows[0].value.voted === true
        && result.rows[0].value.upvoteCount === 1,
      "Q&A vote did not persist",
    );
    result = await observer.query(
      "select public.toggle_member_qa_vote('question',$1,true) value",
      [qaQuestion],
    );
    assert(
      result.rows[0].value.voted === true
        && result.rows[0].value.upvoteCount === 1,
      "repeated Q&A vote did not converge without double-counting",
    );
    result = await observer.query(
      "select public.search_member_qa_history('deleted reply proof','replied','votes') value",
    );
    assert(
      result.rows[0].value.length === 1
        && result.rows[0].value[0].id === qaQuestion,
      "Q&A searchable history did not return the persisted question",
    );
    await setRole(observer, "authenticated", ids.orgAdminB, "aal2");
    await expectState(
      observer,
      "qa_cross_tenant_detail",
      "select public.get_member_qa_question($1)",
      [qaQuestion],
      "P0002",
    );
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query("select public.delete_member_qa_reply($1) value", [qaReply]);
    assert(
      !JSON.stringify(result.rows[0].value).includes("MI1 deleted reply secret body")
        && result.rows[0].value.replyCount === 0,
      "deleted Q&A reply remained in the projection",
    );
    const deletedQuestionKey = "50920000-0000-4000-8000-000000000302";
    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    result = await observer.query(
      "select public.ask_member_qa_question('MI1 deleted question secret title','MI1 deleted question secret body',$1) value",
      [deletedQuestionKey],
    );
    const deletedQuestionId = result.rows[0].value.id;
    await observer.query("select public.delete_member_qa_question($1)", [deletedQuestionId]);
    result = await observer.query(
      "select public.ask_member_qa_question('replacement title','replacement body',$1) value",
      [deletedQuestionKey],
    );
    const deletedReplay = result.rows[0].value;
    assert(
      deletedReplay.id === deletedQuestionId
        && deletedReplay.deleted === true
        && !JSON.stringify(deletedReplay).includes("secret"),
      "deleted Q&A question replay exposed content instead of a tombstone",
    );

    await setRole(observer, "postgres");
    await observer.query(`
      insert into public.organization_engagement_events
        (organization_id,user_id,chapter_id,event_type,source_id)
      values
        ($1,$2,'mi1-ext-a1','qa_contribution','mi1-privacy-1'),
        ($1,$3,'mi1-ext-a1','qa_contribution','mi1-privacy-2'),
        ($1,$4,'mi1-ext-a1','qa_contribution','mi1-privacy-3'),
        ($1,$5,'mi1-ext-a1','qa_contribution','mi1-privacy-4')
    `, [ids.orgA, ids.orgAdminA, ids.chapterAdminA, ids.ordinaryA, ids.memberA2]);
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query("select public.get_organization_analytics_snapshot() value");
    assert(
      result.rows[0].value.usageWindows.mau === null
        && result.rows[0].value.usageWindows.suppressed.mau === true,
      "low-N analytics did not suppress four users",
    );
    await setRole(observer, "postgres");
    await observer.query(`
      insert into public.organization_engagement_events
        (organization_id,user_id,chapter_id,event_type,source_id)
      values ($1,$2,'mi1-ext-a1','qa_contribution','mi1-privacy-5')
    `, [ids.orgA, ids.multi]);
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query("select public.get_organization_analytics_snapshot() value");
    assert(
      result.rows[0].value.usageWindows.mau === null
        && result.rows[0].value.usageWindows.suppressed.mau === true,
      "analytics revealed five users below the 25-person disclosure floor",
    );
    await setRole(observer, "postgres");
    await observer.query(`
      insert into auth.users (id, email)
      select ('50920000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid,
             'mi1-analytics-' || n::text || '@example.invalid'
      from pg_catalog.generate_series(100, 119) n
    `);
    await observer.query(`
      insert into public.organization_engagement_events
        (organization_id,user_id,chapter_id,event_type,source_id)
      select $1,
             ('50920000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid,
             'mi1-ext-a1', 'qa_contribution', 'mi1-privacy-' || n::text
      from pg_catalog.generate_series(100, 119) n
    `, [ids.orgA]);
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query("select public.get_organization_analytics_snapshot() value");
    // All 25 users acted within the day, so the daily window is revealed at
    // the floor. The weekly and monthly windows add no one beyond it, and a
    // larger window is shown only when it differs from the smaller revealed
    // one by the floor (20260925991000), so both stay suppressed and no
    // subtraction can expose fewer than 25 people.
    assert(
      result.rows[0].value.usageWindows.dau === 25
        && result.rows[0].value.usageWindows.wau === null
        && result.rows[0].value.usageWindows.mau === null
        && result.rows[0].value.usageWindows.suppressed.dau === false
        && result.rows[0].value.usageWindows.suppressed.wau === true
        && result.rows[0].value.usageWindows.suppressed.mau === true,
      "analytics threshold positive control did not reveal 25 users",
    );
    await setRole(observer, "postgres");
    result = await observer.query(`
      select count(*)::int count from public.organization_audit_events
      where organization_id=$1 and actor_user_id=$2 and event_type='analytics_snapshot_read'
    `, [ids.orgA, ids.orgAdminA]);
    assert(result.rows[0].count === 3, "analytics reads were not audit-attributed");

    stage = "analytics two-organization scope and export authorization";
    await setRole(observer, "postgres");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-a1' where id=$1", [ids.multi]);
    await setRole(observer, "authenticated", ids.multi, "aal2");
    result = await observer.query("select public.get_organization_analytics_snapshot() value");
    assert(
      result.rows[0].value.organizationId === ids.orgA
        && !JSON.stringify(result.rows[0].value).includes(ids.orgB),
      "Org A analytics snapshot exposed or selected the foreign tenant",
    );
    const orgASnapshotId = result.rows[0].value.snapshotId;
    await expectState(
      observer,
      "analytics_steward_export_denied",
      `select public.request_organization_analytics_export('csv', '${orgASnapshotId}'::uuid)`,
      [],
      "42501",
    );

    await setRole(observer, "postgres");
    await observer.query(`
      insert into public.organization_role_grants (organization_id,user_id,role,granted_by)
      values ($1,$3,'coordinator',$4),($2,$3,'coordinator',$5)
    `, [ids.orgA, ids.orgB, ids.multi, ids.orgAdminA, ids.orgAdminB]);
    await setRole(observer, "authenticated", ids.multi, "aal2");
    result = await observer.query("select public.request_organization_analytics_export('csv', $1::uuid) value", [orgASnapshotId]);
    const orgAExport = result.rows[0].value;
    assert(
      orgAExport.organizationId === ids.orgA
        && orgAExport.format === "csv"
        && new Date(orgAExport.expiresAt).getTime() > Date.now() + (23 * 60 * 60 * 1000),
      "Org A analytics export receipt lost tenant, format, or 24-hour expiry",
    );

    await setRole(observer, "postgres");
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-b1' where id=$1", [ids.multi]);
    await setRole(observer, "authenticated", ids.multi, "aal2");
    result = await observer.query("select public.get_organization_analytics_snapshot() value");
    assert(
      result.rows[0].value.organizationId === ids.orgB
        && !JSON.stringify(result.rows[0].value).includes(ids.orgA),
      "Org B analytics snapshot exposed or retained the former tenant",
    );
    result = await observer.query(
      "select public.request_organization_analytics_export('json', $1::uuid) value",
      [result.rows[0].value.snapshotId],
    );
    const orgBExport = result.rows[0].value;
    assert(
      orgBExport.organizationId === ids.orgB
        && orgBExport.format === "json"
        && orgBExport.id !== orgAExport.id,
      "Org B analytics export reused or mis-scoped the Org A receipt",
    );
    await expectState(
      observer,
      "analytics_export_direct_read_denied",
      "select id,organization_id from public.organization_analytics_exports",
      [],
      "42501",
    );

    await setRole(observer, "postgres");
    result = await observer.query(`
      select id,organization_id,export_format,created_by
      from public.organization_analytics_exports
      where id = any($1::uuid[])
      order by organization_id
    `, [[orgAExport.id, orgBExport.id]]);
    assert(
      result.rows.length === 2
        && result.rows.every((row) => row.created_by === ids.multi)
        && new Set(result.rows.map((row) => row.organization_id)).size === 2,
      "analytics export persistence did not retain two isolated tenant receipts",
    );
    await observer.query("update public.member_profiles set chapter_id='mi1-ext-a1' where id=$1", [ids.multi]);

    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query(
      "select public.list_organization_audit_ledger(50,null,null,'knowledge','delete') value",
    );
    assert(
      result.rows[0].value.some((item) => item.eventType === "qa_deleted" && item.action === "delete"),
      "Q&A delete audit was not classified as knowledge/delete",
    );
    result = await observer.query(
      "select public.list_organization_audit_ledger(50,null,null,'membership','revoke') value",
    );
    assert(
      result.rows[0].value.some((item) => item.source === "member_admin_audit" && item.actorUserId === ids.revoker),
      "member-admin revocation audit was not classified as membership/revoke",
    );

    const auditKey = "50920000-0000-4000-8000-000000000301";
    // The generic writer deliberately has no client-role EXECUTE grant; use
    // the owner with an authenticated claim to exercise actor binding.
    await setRole(observer, "postgres", ids.orgAdminA, "aal2");
    result = await observer.query(
      "select public.record_organization_audit_event(null,'data_access','mi1.proof','read','audit_event','mi1-proof',$1,'{}'::jsonb) value",
      [auditKey],
    );
    const auditId = result.rows[0].value.id;
    result = await observer.query(
      "select public.record_organization_audit_event(null,'data_access','mi1.proof','read','audit_event','mi1-proof',$1,'{}'::jsonb) value",
      [auditKey],
    );
    assert(result.rows[0].value.id === auditId, "identical audit replay did not return the original row");
    await expectState(
      observer,
      "audit_idempotency_mismatch",
      "select public.record_organization_audit_event(null,'data_access','mi1.changed','read','audit_event','mi1-proof',$1,'{}'::jsonb)",
      [auditKey],
      "23505",
    );
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query(
      "select public.list_organization_audit_ledger(20,null,null,'data_access','read') value",
    );
    const auditProjection = result.rows[0].value.find((item) => item.id === auditId);
    assert(
      auditProjection?.actorUserId === ids.orgAdminA
        && auditProjection.domain === "data_access"
        && auditProjection.action === "read",
      "audit ledger filters or actor projection were incomplete",
    );
    await setRole(observer, "postgres");
    await observer.query(`
      insert into public.organization_audit_ledger (
        id,organization_id,domain,event_type,action,actor_user_id,entity_type,
        entity_id,occurred_at,idempotency_key,metadata
      ) values
        ('50920000-0000-4000-8000-000000000310',$1,'security','mi1.cursor','read',$2,
         'audit_event','cursor-a','2026-08-23T12:00:00Z','50920000-0000-4000-8000-000000000312','{}'),
        ('50920000-0000-4000-8000-000000000311',$1,'security','mi1.cursor','read',$2,
         'audit_event','cursor-b','2026-08-23T12:00:00Z','50920000-0000-4000-8000-000000000313','{}')
    `, [ids.orgA, ids.orgAdminA]);
    await expectState(
      observer,
      "audit_ledger_append_only_update",
      "update public.organization_audit_ledger set metadata='{}'::jsonb where id='50920000-0000-4000-8000-000000000310'",
      [],
      "55000",
    );
    await expectState(
      observer,
      "audit_ledger_append_only_delete",
      "delete from public.organization_audit_ledger where id='50920000-0000-4000-8000-000000000310'",
      [],
      "55000",
    );
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    result = await observer.query(
      "select public.list_organization_audit_ledger(1,null,null,'security','read') value",
    );
    const cursorHead = result.rows[0].value[0];
    assert(cursorHead.id === "50920000-0000-4000-8000-000000000311", "audit cursor order was not deterministic");
    result = await observer.query(
      "select public.list_organization_audit_ledger(1,$1::timestamptz,$2::uuid,'security','read') value",
      [cursorHead.occurredAt, cursorHead.id],
    );
    assert(
      result.rows[0].value[0]?.id === "50920000-0000-4000-8000-000000000310",
      "audit tuple cursor skipped a tied-timestamp row",
    );
    const serviceAuditKey = "50920000-0000-4000-8000-000000000314";
    await setRole(observer, "service_role");
    result = await observer.query(
      "select public.record_organization_audit_event($1,'operations','mi1.service','create','audit_event','service-proof',$2,'{}'::jsonb) value",
      [ids.orgA, serviceAuditKey],
    );
    const serviceAuditId = result.rows[0].value.id;
    await setRole(observer, "postgres");
    result = await observer.query(
      "select organization_id,actor_user_id from public.organization_audit_ledger where id=$1",
      [serviceAuditId],
    );
    assert(
      result.rows[0].organization_id === ids.orgA && result.rows[0].actor_user_id === null,
      "service-role audit append did not bind the supplied tenant or null platform actor",
    );

    await setRole(observer, "postgres");
    await observer.query(`
      insert into public.organization_job_runs (job_name,run_id,status)
      values ('notifications-dispatch-tick','mi1-null-run','completed')
    `);
    await observer.query(`
      insert into public.organization_job_runs (job_name,run_id,status)
      values ('integration-webhooks-dispatch-tick','mi1-integration-run','completed')
    `);
    await expectState(
      observer,
      "platform_job_null_idempotency",
      `insert into public.organization_job_runs (job_name,run_id,status)
       values ('notifications-dispatch-tick','mi1-null-run','completed')`,
      [],
      "23505",
    );

    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    await observer.query("select public.upsert_pay_scale_grade($1,'MI1','MI1 grade',null,2,null)", [ids.orgA]);
    await observer.query("select public.upsert_pay_scale_step($1,'MI1',current_date,2,5000)", [ids.orgA]);
    result = await observer.query("select public.list_pay_scale_grades() grades, public.list_pay_scale_steps(null,null,null,null) steps");
    assert(
      result.rows[0].grades.length === 1
        && result.rows[0].grades[0].organizationId === ids.orgA
        && result.rows[0].steps.length === 1
        && result.rows[0].steps[0].organizationId === ids.orgA,
      "pay catalog list did not stay inside the selected organization",
    );
    await setRole(observer, "authenticated", ids.orgAdminB, "aal2");
    await expectState(
      observer,
      "pay_grade_expected_organization_mismatch",
      "select public.upsert_pay_scale_grade($1,'SCOPE-GUARD','Scope guard',null,1,null)",
      [ids.orgA],
      "42501",
    );
    await expectState(
      observer,
      "pay_step_expected_organization_mismatch",
      "select public.upsert_pay_scale_step($1,'SCOPE-GUARD',current_date,1,5000)",
      [ids.orgA],
      "42501",
    );
    await setRole(observer, "postgres");
    result = await observer.query(`
      select
        (select count(*)::int from public.pay_scale_grades
          where organization_id=$1 and grade='SCOPE-GUARD') grade_count,
        (select count(*)::int from public.pay_scale_steps
          where organization_id=$1 and grade='SCOPE-GUARD') step_count,
        (select count(*)::int from public.organization_audit_events
          where organization_id=$1
            and event_type in ('pay_scale_grade_upserted','pay_scale_step_upserted')
            and metadata->>'grade'='SCOPE-GUARD') audit_count
    `, [ids.orgB]);
    assert(
      result.rows[0].grade_count === 0
        && result.rows[0].step_count === 0
        && result.rows[0].audit_count === 0,
      "mismatched expected organization wrote a Pay row or audit event in the selected tenant",
    );
    await setRole(observer, "authenticated", ids.memberB, "aal2");
    result = await observer.query("select public.list_pay_scale_grades() grades, public.list_pay_scale_steps(null,null,null,null) steps");
    assert(result.rows[0].grades.length === 0 && result.rows[0].steps.length === 0, "pay catalog leaked across organizations");
    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    result = await observer.query("select public.list_pay_scale_grades() grades, public.list_pay_scale_steps(null,null,null,null) steps");
    assert(result.rows[0].grades.length === 1 && result.rows[0].steps.length === 1, "active member could not read the selected organization pay catalog");
    await expectState(
      observer,
      "pay_member_write_denied",
      "select public.upsert_pay_scale_grade($1,'DENIED','Denied grade',null,1,null)",
      [ids.orgA],
      "42501",
    );
    await setRole(observer, "postgres");
    await observer.query(`
      insert into auth.mfa_factors (id,user_id,friendly_name,factor_type,status,created_at,updated_at)
      values ('50920000-0000-4000-8000-000000000098',$1,'MI1 pay proof','totp','verified',now(),now())
    `, [ids.orgAdminA]);
    await setRole(observer, "authenticated", ids.orgAdminA, "aal1");
    await expectState(
      observer,
      "pay_aal1_write_denied",
      "select public.upsert_pay_scale_grade($1,'DENIED','Denied grade',null,1,null)",
      [ids.orgA],
      "42501",
    );
    await setRole(observer, "authenticated", ids.orgAdminA, "aal2");
    await expectState(
      observer,
      "pay_step_count_lowering",
      "select public.upsert_pay_scale_grade($1,'MI1','MI1 grade',null,1,null)",
      [ids.orgA],
      "22023",
    );
    await expectState(
      observer,
      "pay_step_count_bound",
      "select public.upsert_pay_scale_step($1,'MI1',current_date,3,5000)",
      [ids.orgA],
      "P0002",
    );

    await setRole(observer, "postgres");
    await observer.query("set local session_replication_role = replica");
    await observer.query(`
      insert into public.public_site_records (
        id,kind,title_en,title_es,body_en,body_es,location_en,location_es,starts_at,
        is_published,published_at,created_by,organization_id,chapter_code
      ) values (
        'mi1-ext-cross-event','meeting','Cross event','Evento cruzado','Foreign event','Evento extranjero',
        'West','Oeste',now()+interval '1 day',true,now(),$1,$2,'mi1-ext-site-a'
      )
    `, [ids.orgAdminB, ids.orgB]);
    await observer.query("set local session_replication_role = origin");
    await setRole(observer, "anon");
    result = await observer.query("select public.get_public_chapter_microsite('mi1-ext-site-a','en') value");
    assert(
      !JSON.stringify(result.rows[0].value).includes("mi1-ext-cross-event"),
      "chapter microsite paired a foreign-tenant event",
    );

    await setRole(observer, "anon");
    await expectState(
      observer,
      "anon_rsvp_execute_denied",
      "select public.submit_public_event_rsvp('mi1-ext-valid-event','anon@example.invalid','Anon','en','public-event-rsvp','',$1,$2)",
      ["4".repeat(64), "5".repeat(64)],
      "42501",
    );
    await expectState(
      observer,
      "anon_audit_execute_denied",
      "select public.record_organization_audit_event($1,'operations','mi1.anon','create','audit_event','anon',$2,'{}'::jsonb)",
      [ids.orgA, "50920000-0000-4000-8000-000000000315"],
      "42501",
    );
    await setRole(observer, "authenticated", ids.ordinaryA, "aal2");
    await expectState(
      observer,
      "authenticated_rsvp_execute_denied",
      "select public.submit_public_event_rsvp('mi1-ext-valid-event','member@example.invalid','Member','en','public-event-rsvp','',$1,$2)",
      ["6".repeat(64), "7".repeat(64)],
      "42501",
    );
    await expectState(
      observer,
      "authenticated_audit_execute_denied",
      "select public.record_organization_audit_event(null,'operations','mi1.member','create','audit_event','member',$1,'{}'::jsonb)",
      ["50920000-0000-4000-8000-000000000316"],
      "42501",
    );

    const invalidScope = "a".repeat(64);
    await setRole(observer, "service_role");
    result = await observer.query(
      "select public.submit_public_event_rsvp(repeat('x',129),'valid@example.invalid','Valid Name','en','public-event-rsvp','',$1,repeat('b',64)) value",
      [invalidScope],
    );
    assert(result.rows[0].value.accepted === true, "invalid RSVP lost its uniform response");
    await setRole(observer, "postgres");
    result = await observer.query(
      "select count(*)::int count from private.public_event_rsvp_limits where scope_hash=$1",
      [invalidScope],
    );
    assert(result.rows[0].count === 0, "invalid RSVP consumed a rate-limit bucket");
    const invalidEmailScope = "c".repeat(64);
    await setRole(observer, "service_role");
    result = await observer.query(
      "select public.submit_public_event_rsvp('mi1-ext-cross-event','not-an-email','Valid Name','en','public-event-rsvp','',$1,repeat('d',64)) value",
      [invalidEmailScope],
    );
    assert(result.rows[0].value.accepted === true, "malformed email lost the uniform RSVP response");
    await setRole(observer, "postgres");
    result = await observer.query(
      "select count(*)::int count from private.public_event_rsvp_limits where scope_hash=$1",
      [invalidEmailScope],
    );
    assert(result.rows[0].count === 0, "malformed email consumed a rate-limit bucket");

    const validNetworkScope = "e".repeat(64);
    const validEmailScope = "f".repeat(64);
    await setRole(observer, "service_role");
    result = await observer.query(
      "select public.submit_public_event_rsvp('mi1-ext-valid-event','valid-rsvp@example.invalid','Valid RSVP','en','public-event-rsvp','',$1,$2) value",
      [validNetworkScope, validEmailScope],
    );
    assert(result.rows[0].value.accepted === true, "valid RSVP lost its uniform response");
    await setRole(observer, "postgres");
    result = await observer.query(
      "select organization_id from public.public_event_rsvps where event_id='mi1-ext-valid-event' and email='valid-rsvp@example.invalid'",
    );
    assert(result.rows[0]?.organization_id === ids.orgA, "valid RSVP did not persist under the event tenant");

    const saturatedNetworkScope = "1".repeat(64);
    const saturatedEmailScope = "2".repeat(64);
    await setRole(observer, "service_role");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await observer.query(
        "select public.submit_public_event_rsvp('mi1-ext-valid-event','saturated@example.invalid','Saturated','en','public-event-rsvp','',$1,$2)",
        [saturatedNetworkScope, saturatedEmailScope],
      );
    }
    result = await observer.query(
      "select public.submit_public_event_rsvp('mi1-ext-valid-event','blocked-rsvp@example.invalid','Blocked','en','public-event-rsvp','',$1,$2) value",
      [saturatedNetworkScope, "3".repeat(64)],
    );
    assert(result.rows[0].value.accepted === true, "rate-limited RSVP lost its uniform response");
    await setRole(observer, "postgres");
    result = await observer.query(
      `select
         (select request_count from private.public_event_rsvp_limits where scope_hash=$1 and operation='network-15m') network_count,
         (select count(*)::int from private.public_event_rsvp_limits where scope_hash=$2) blocked_email_buckets,
         (select count(*)::int from public.public_event_rsvps where event_id='mi1-ext-valid-event' and email='blocked-rsvp@example.invalid') blocked_rows`,
      [saturatedNetworkScope, "3".repeat(64)],
    );
    assert(
      result.rows[0].network_count === 20
        && result.rows[0].blocked_email_buckets === 0
        && result.rows[0].blocked_rows === 0,
      "network limiter rejection consumed an email bucket or inserted an RSVP",
    );

    stage = "final-admin account deletion";
    // Final-admin deletion spans every active tenant and preserves immutable audit attribution.
    await observer.query(`
      insert into public.organization_audit_events
        (id,organization_id,event_type,actor_user_id,idempotency_key,metadata)
      values ($1,$2,'organization_role_granted',$3,gen_random_uuid(),jsonb_build_object('organizationId',$2::uuid::text,'userId',$3::uuid::text,'role','admin'))
    `, [ids.audit, ids.orgDeleteA, ids.deleteTarget]);
    await setRole(observer, "postgres");
    await observer.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: ids.deleteTarget, role: "authenticated", aal: "aal2" }),
    ]);
    await expectState(
      observer,
      "delete_request_multi_org_sole",
      `insert into private.member_account_deletions(subject_hash,token_hash,status,expires_at)
       values (repeat('a',64),repeat('b',64),'authorized',now()+interval '5 minutes')`,
      [],
      "22023",
    );
    stage = "final-admin account deletion: sole-admin denial";
    await expectState(observer, "delete_multi_org_sole", "delete from auth.users where id=$1", [ids.deleteTarget], "22023");
    stage = "final-admin account deletion: backup grants";
    await observer.query(`
      insert into public.organization_role_grants (organization_id,user_id,role,granted_by) values
        ($1,$4,'admin',$3),($2,$4,'admin',$3)
    `, [ids.orgDeleteA, ids.orgDeleteB, ids.deleteTarget, ids.deleteBackup]);
    stage = "final-admin account deletion: permitted delete";
    await observer.query("delete from auth.users where id=$1", [ids.deleteTarget]);
    result = await observer.query("select actor_user_id from public.organization_audit_events where id=$1", [ids.audit]);
    assert(result.rows[0]?.actor_user_id === ids.deleteTarget, "account deletion erased immutable audit actor UUID");
    await expectState(observer, "audit_append_only", "update public.organization_audit_events set metadata='{}'::jsonb where id=$1", [ids.audit], "55000");

    await observer.query("rollback");
  } catch (error) {
    await observer.query("rollback").catch(() => {});
    error.message = `${stage}: ${error.message}`;
    throw error;
  }

  await runDeletionAndInvitationRaces(url, observer);
}

async function runDeletionAndInvitationRaces(url, observer) {
  const race = {
    target: "50921000-0000-4000-8000-000000000001",
    backup: "50921000-0000-4000-8000-000000000002",
    grantTarget: "50921000-0000-4000-8000-000000000003",
    grantBackup: "50921000-0000-4000-8000-000000000004",
    org: "50921000-0000-4000-8000-000000000101",
    grantOrg: "50921000-0000-4000-8000-000000000102",
    chapter: "mi1-ext-race",
    grantChapter: "mi1-ext-grant-delete",
  };
  const peers = {
    locker: new Client({ connectionString: url, application_name: "mi1-ext-locker" }),
    deletion: new Client({ connectionString: url, application_name: "mi1-ext-account-delete" }),
    revocation: new Client({ connectionString: url, application_name: "mi1-ext-backup-revoke" }),
    grant: new Client({ connectionString: url, application_name: "mi1-ext-target-grant" }),
    invitation: new Client({ connectionString: url, application_name: "mi1-ext-invitation" }),
  };
  for (const peer of Object.values(peers)) await peer.connect();
  let raceFailure;
  try {
    await observer.query("reset role");
    await observer.query("begin");
    await observer.query(`
      insert into auth.users(id,email) values
        ($1,'mi1-ext-race-target@example.invalid'),
        ($2,'mi1-ext-race-backup@example.invalid'),
        ($3,'mi1-ext-grant-target@example.invalid'),
        ($4,'mi1-ext-grant-backup@example.invalid')
    `, [race.target, race.backup, race.grantTarget, race.grantBackup]);
    await observer.query(`
      insert into public.organizations(id,slug,name,created_by) values
        ($1,'mi1-ext-race','MI1 Extension Race',$2),
        ($3,'mi1-ext-grant-delete','MI1 Grant Delete Race',$4)
    `, [race.org, race.target, race.grantOrg, race.grantBackup]);
    await observer.query(`
      insert into public.chapters(id,name,slug,is_default,order_index,organization_id) values
        ($1,'MI1 Extension Race','mi1-ext-race',true,1,$2),
        ($3,'MI1 Grant Delete Race','mi1-ext-grant-delete',true,1,$4)
    `, [race.chapter, race.org, race.grantChapter, race.grantOrg]);
    await observer.query(`
      insert into public.organization_memberships(organization_id,user_id,status) values
        ($1,$2,'active'),($1,$3,'active'),($4,$5,'active'),($4,$6,'active')
    `, [race.org, race.target, race.backup, race.grantOrg, race.grantTarget, race.grantBackup]);
    await observer.query(`
      insert into public.member_chapter_memberships(user_id,chapter_id,status) values
        ($1,$3,'active'),($2,$3,'active'),($4,$6,'active'),($5,$6,'active')
    `, [race.target, race.backup, race.chapter, race.grantTarget, race.grantBackup, race.grantChapter]);
    await observer.query(`
      update public.member_profiles set chapter_id = case id
        when $1 then $5 when $2 then $5 when $3 then $6 when $4 then $6 end
      where id in ($1,$2,$3,$4)
    `, [race.target, race.backup, race.grantTarget, race.grantBackup, race.chapter, race.grantChapter]);
    await observer.query(`
      insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values
        ($1,$2,'admin',$2),($1,$3,'admin',$2),($4,$5,'admin',$5)
    `, [race.org, race.target, race.backup, race.grantOrg, race.grantBackup]);
    await observer.query(`
      insert into public.org_security_policy(id,organization_id,require_staff_mfa) values
        (true,$1,false),(true,$2,false)
    `, [race.org, race.grantOrg]);
    await prepareRaceSessions(observer, [race.target, race.backup, race.grantTarget, race.grantBackup]);
    await observer.query("commit");

    // The target begins as an ordinary active member. Keep its promotion
    // uncommitted while deletion and the backup's self-revocation queue. The
    // deletion helper must discover the target's membership, wait on the
    // organization lock, then serialize the new grant into its final check.
    await peers.grant.query("begin");
    await authenticateClient(peers.grant, race.grantBackup);
    await peers.grant.query("select public.set_member_organization_role($1,'admin',true)", [race.grantTarget]);
    await peers.deletion.query("begin");
    const grantRaceDeletion = peers.deletion.query("delete from auth.users where id=$1", [race.grantTarget])
      .then(() => "success").catch((error) => error.code || error.message);
    await waitForAdvisoryWait(observer, "mi1-ext-account-delete");
    await peers.revocation.query("begin");
    await authenticateClient(peers.revocation, race.grantBackup);
    const grantRaceRevocation = peers.revocation
      .query("select public.set_member_organization_role($1,'admin',false)", [race.grantBackup])
      .then(() => "success").catch((error) => error.code || error.message);
    await waitForAdvisoryWait(observer, "mi1-ext-backup-revoke");
    await peers.grant.query("commit");
    const grantRaceDeletionOutcome = await grantRaceDeletion;
    await peers.deletion.query(grantRaceDeletionOutcome === "success" ? "commit" : "rollback");
    const grantRaceRevocationOutcome = await grantRaceRevocation;
    await peers.revocation.query(grantRaceRevocationOutcome === "success" ? "commit" : "rollback");
    assert(grantRaceDeletionOutcome === "success", `grant/delete race returned ${grantRaceDeletionOutcome}`);
    assert(grantRaceRevocationOutcome === "22023", `post-delete backup revocation returned ${grantRaceRevocationOutcome}`);
    let result = await observer.query(`
      select
        (select count(*)::int from auth.users where id=$2) target_count,
        (select count(*)::int from public.organization_role_grants where organization_id=$1 and user_id=$2) orphan_grants,
        (select count(*)::int
         from public.organization_role_grants g
         join public.organization_memberships m
           on m.organization_id=g.organization_id and m.user_id=g.user_id and m.status='active'
         where g.organization_id=$1 and g.role='admin') admin_count
    `, [race.grantOrg, race.grantTarget]);
    assert(
      result.rows[0].target_count === 0
        && result.rows[0].orphan_grants === 0
        && result.rows[0].admin_count === 1,
      "grant/delete race left an orphaned grant or adminless tenant",
    );

    // Competing target deletion and backup revocation serialize on one tenant
    // lock. Exactly one may succeed and neither may deadlock.
    await peers.locker.query("begin");
    await peers.locker.query("select pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || $1::text,509))", [race.org]);
    await peers.deletion.query("begin");
    const deletion = peers.deletion.query("delete from auth.users where id=$1", [race.target])
      .then(() => "success").catch((error) => error.code || error.message);
    await waitForAdvisoryWait(observer, "mi1-ext-account-delete");
    await peers.revocation.query("begin");
    await authenticateClient(peers.revocation, race.target);
    const revocation = peers.revocation.query("select public.set_member_organization_role($1,'admin',false)", [race.backup])
      .then(() => "success").catch((error) => error.code || error.message);
    await waitForAdvisoryWait(observer, "mi1-ext-backup-revoke");
    await peers.locker.query("commit");
    const deletionOutcome = await deletion;
    await peers.deletion.query(deletionOutcome === "success" ? "commit" : "rollback");
    const revocationOutcome = await revocation;
    await peers.revocation.query(revocationOutcome === "success" ? "commit" : "rollback");
    assert(![deletionOutcome, revocationOutcome].includes("40P01"), "delete/revoke race deadlocked");
    assert(
      [deletionOutcome, revocationOutcome].filter((value) => value === "success").length === 1,
      `delete/revoke race expected one success, got ${deletionOutcome}/${revocationOutcome}`,
    );
    result = await observer.query(`
      select count(*)::int count
      from public.organization_role_grants g
      join public.organization_memberships m on m.organization_id=g.organization_id and m.user_id=g.user_id and m.status='active'
      where g.organization_id=$1 and g.role='admin'
    `, [race.org]);
    assert(result.rows[0].count === 1, "delete/revoke race did not preserve exactly one active admin");

    // Grade lowering and step insertion serialize on the same grade row in
    // either order, so neither check can commit against a stale step_count.
    const surviving = deletionOutcome === "success" ? race.backup : race.target;
    await observer.query(`
      insert into public.pay_scale_grades (organization_id,grade,title,step_count)
      values ($1,'MI1-RACE','MI1 concurrency grade',4)
    `, [race.org]);
    await peers.grant.query("begin");
    await authenticateClient(peers.grant, surviving);
    await peers.grant.query("select public.upsert_pay_scale_grade($1,'MI1-RACE','MI1 concurrency grade',null,2,null)", [race.org]);
    await peers.deletion.query("begin");
    await authenticateClient(peers.deletion, surviving);
    const stepAfterLower = peers.deletion
      .query("select public.upsert_pay_scale_step($1,'MI1-RACE',current_date,3,5000)", [race.org])
      .then(() => "success").catch((error) => error.code || error.message);
    await waitForDatabaseLock(observer, "mi1-ext-account-delete");
    await peers.grant.query("commit");
    const stepAfterLowerOutcome = await stepAfterLower;
    await peers.deletion.query("rollback");
    assert(stepAfterLowerOutcome === "P0002", `step-after-lower race returned ${stepAfterLowerOutcome}`);

    await observer.query("update public.pay_scale_grades set step_count=4 where organization_id=$1 and grade='MI1-RACE'", [race.org]);
    await peers.grant.query("begin");
    await authenticateClient(peers.grant, surviving);
    await peers.grant.query("select public.upsert_pay_scale_step($1,'MI1-RACE',current_date,3,5000)", [race.org]);
    await peers.deletion.query("begin");
    await authenticateClient(peers.deletion, surviving);
    const lowerAfterStep = peers.deletion
      .query("select public.upsert_pay_scale_grade($1,'MI1-RACE','MI1 concurrency grade',null,2,null)", [race.org])
      .then(() => "success").catch((error) => error.code || error.message);
    await waitForDatabaseLock(observer, "mi1-ext-account-delete");
    await peers.grant.query("commit");
    const lowerAfterStepOutcome = await lowerAfterStep;
    await peers.deletion.query("rollback");
    assert(lowerAfterStepOutcome === "22023", `lower-after-step race returned ${lowerAfterStepOutcome}`);

    // A queued invitation cannot reuse an admin grant revoked ahead of it. The
    // revoker enters through the case graph first, as every writer has since
    // 20260907150000; holding only the tenant lock would deadlock the
    // revocation against the queued call's entry gate.
    await peers.locker.query("begin");
    await peers.locker.query("select private.lock_case_graph(array[$1]::uuid[], array[]::uuid[])", [surviving]);
    await peers.locker.query("select pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-role:' || $1::text,509))", [race.org]);
    await peers.invitation.query("begin");
    await authenticateClient(peers.invitation, surviving);
    const invitation = peers.invitation.query("select public.get_member_invitations(10)")
      .then(() => "success").catch((error) => error.code || error.message);
    await waitForAdvisoryWait(observer, "mi1-ext-invitation");
    await peers.locker.query("delete from public.organization_role_grants where organization_id=$1 and user_id=$2 and role='admin'", [race.org, surviving]);
    await peers.locker.query("commit");
    const invitationOutcome = await invitation;
    await peers.invitation.query("rollback");
    assert(invitationOutcome === "42501", `queued invitation returned ${invitationOutcome} after admin revocation`);
  } catch (error) {
    raceFailure = error;
  } finally {
    for (const peer of Object.values(peers)) {
      await peer.query("rollback").catch(() => {});
      await peer.end().catch(() => {});
    }
  }

  let cleanupFailure;
  try {
    await observer.query("reset role");
    await observer.query("begin");
    await observer.query("delete from public.member_invitations where chapter_id=$1", [race.chapter]);
    await observer.query("delete from public.pay_scale_steps where organization_id=$1", [race.org]);
    await observer.query("delete from public.pay_scale_grades where organization_id=$1", [race.org]);
    // The production final-admin guard is exactly what the race proves. The
    // disposable cleanup must not re-enter it after the proof has committed.
    await observer.query("set local session_replication_role = replica");
    await observer.query("delete from public.organization_role_grants where organization_id in ($1,$2)", [race.org, race.grantOrg]);
    await observer.query("delete from public.organization_audit_events where organization_id in ($1,$2)", [race.org, race.grantOrg]);
    await observer.query("set local session_replication_role = origin");
    await observer.query("delete from public.organization_memberships where organization_id in ($1,$2)", [race.org, race.grantOrg]);
    await observer.query("update public.member_profiles set chapter_id=null where id in ($1,$2,$3,$4)", [race.target, race.backup, race.grantTarget, race.grantBackup]);
    await observer.query("delete from public.member_chapter_memberships where user_id in ($1,$2,$3,$4)", [race.target, race.backup, race.grantTarget, race.grantBackup]);
    await observer.query("delete from public.org_security_policy where organization_id in ($1,$2)", [race.org, race.grantOrg]);
    await observer.query("delete from public.chapters where id in ($1,$2)", [race.chapter, race.grantChapter]);
    await deleteOrganizationDependents(observer, [race.org, race.grantOrg]);
    await observer.query("delete from public.organizations where id in ($1,$2)", [race.org, race.grantOrg]);
    await observer.query("delete from auth.users where id in ($1,$2,$3,$4)", [race.target, race.backup, race.grantTarget, race.grantBackup]);
    await observer.query("commit");
  } catch (error) {
    cleanupFailure = error;
    await observer.query("rollback").catch(() => {});
  }

  if (raceFailure) {
    if (cleanupFailure) raceFailure.message += `; cleanup also failed: ${cleanupFailure.message}`;
    throw raceFailure;
  }
  if (cleanupFailure) {
    throw new Error(`MI1 extension cleanup failed: ${cleanupFailure.message}`, { cause: cleanupFailure });
  }
}
