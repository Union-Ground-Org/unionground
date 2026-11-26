// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runLive = process.env.RUN_LOCAL_DB_TESTS === "1";
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const migrationWithinProofTransaction = (name) => migration(name)
  .replace(/^\s*begin;\s*/i, "")
  .replace(/\s*commit;\s*$/i, "");
const IDS = {
  orgA: "50905300-0000-4000-8000-000000000001",
  orgB: "50905300-0000-4000-8000-000000000002",
  staffA: "50905300-0000-4000-8000-000000000101",
  memberA: "50905300-0000-4000-8000-000000000102",
  staffB: "50905300-0000-4000-8000-000000000201",
  memberB: "50905300-0000-4000-8000-000000000202",
  sessionA: "50905300-0000-4000-8000-000000000301",
  sessionB: "50905300-0000-4000-8000-000000000302",
  memberSessionA: "50905300-0000-4000-8000-000000000303",
  memberSessionB: "50905300-0000-4000-8000-000000000304",
};

describe.skipIf(!runLive)("MI1 organization coordination live database behavior", () => {
  let client;
  const created = {};

  async function callAs(userId, sql, values = [], keep = true) {
    await client.query("savepoint coordination_probe");
    try {
      const sessionId = {
        [IDS.staffA]: IDS.sessionA,
        [IDS.memberA]: IDS.memberSessionA,
        [IDS.staffB]: IDS.sessionB,
        [IDS.memberB]: IDS.memberSessionB,
      }[userId];
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2" })]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      if (keep) await client.query("release savepoint coordination_probe");
      else await client.query("rollback to savepoint coordination_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint coordination_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "mi1-coordination-test" });
    await client.connect();
    await client.query("begin");
    const installed = await client.query(
      "select to_regprocedure('public.list_organization_coordination_records(timestamp with time zone,uuid,integer)') is not null installed",
    );
    if (!installed.rows[0].installed) {
      await client.query(migration("20260828231000_mi1_organization_coordination"));
      await client.query(migration("20260828232000_mi1_organization_coordination_workflows"));
      await client.query(migration("20260828233000_mi1_coordination_decisions_public_microsites"));
      await client.query(migration("20260828234000_mi1_coordination_pagination_demo_seed"));
    }
    const hardened = await client.query(
      "select to_regprocedure('public.get_organization_coordination_export_payload(uuid)') is not null installed",
    );
    if (!hardened.rows[0].installed) {
      await client.query(migration("20260828235000_mi1_organization_coordination_hardening"));
    }
    await client.query(migrationWithinProofTransaction(
      "20260921221000_organization_coordination_caller_completion_projection",
    ));
    const lifecycleReview = await client.query(
      "select to_regclass('private.account_lifecycle_trigger_review') is not null installed",
    );
    const microsite = await client.query(
      `select to_regprocedure('public.get_public_chapter_microsite(text,text)') is not null installed,
              case when to_regprocedure('public.get_public_chapter_microsite(text,text)') is not null
                then pg_get_functiondef(to_regprocedure('public.get_public_chapter_microsite(text,text)'))
                else '' end body`,
    );
    if (!lifecycleReview.rows[0].installed
      && !microsite.rows[0].body.includes("document.visibility = 'chapter'")) {
      throw new Error("MI1 microsite live proof requires the account-lifecycle manifest before applying 20260909170500");
    }
    if (lifecycleReview.rows[0].installed
      && !microsite.rows[0].body.includes("document.visibility = 'chapter'")) {
      await client.query(migrationWithinProofTransaction("20260909170500_public_microsite_document_visibility"));
    }
    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'coord-staff-a@example.test'), ($2, 'coord-member-a@example.test'),
       ($3, 'coord-staff-b@example.test'), ($4, 'coord-member-b@example.test')`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'coord-org-a', 'Coordination Org A', $3),
       ($2, 'coord-org-b', 'Coordination Org B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    // Transaction-only fixture disposition for quarantined legacy chapters.
    // Production setup uses the bootstrap/admin RPCs; this never commits.
    await client.query("set local session_replication_role = replica");
    await client.query("update public.chapters set organization_id = $1 where id = 'wor'", [IDS.orgA]);
    await client.query("update public.chapters set organization_id = $1 where id = 'bos'", [IDS.orgB]);
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id
       from (values ($1::uuid, 'wor'::text), ($2::uuid, 'wor'::text),
                    ($3::uuid, 'bos'::text), ($4::uuid, 'bos'::text)) fixture(id, chapter_id)
       where member_profiles.id = fixture.id`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1, 'wor', 'active', true, now()), ($2, 'wor', 'active', true, now()),
              ($3, 'bos', 'active', true, now()), ($4, 'bos', 'active', true, now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id)
       values ($1,$3),($1,$4),($2,$5),($2,$6)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.memberA, IDS.staffB, IDS.memberB],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$3,'admin',$3),($1,$3,'coordinator',$3),
              ($2,$4,'admin',$4),($2,$4,'coordinator',$4)`,
      [IDS.orgA, IDS.orgB, IDS.staffA, IDS.staffB],
    );
    // A partner must be one the caller can already see (#8365,
    // an owner decision): organization B is listed in the network directory.
    await client.query(
      "insert into public.organization_network_directory_profiles (organization_id, display_name, visibility, contact_mode) values ($1, 'MI1 partner', 'directory', 'disabled')",
      [IDS.orgB],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, aal, created_at, updated_at)
       values ($1, $2, 'aal2', now(), now()), ($3, $4, 'aal2', now(), now()),
              ($5, $6, 'aal2', now(), now()), ($7, $8, 'aal2', now(), now())`,
      [IDS.sessionA, IDS.staffA, IDS.sessionB, IDS.staffB, IDS.memberSessionA, IDS.memberA, IDS.memberSessionB, IDS.memberB],
    );
    await client.query(
      `insert into auth.mfa_factors
       (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'coord-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'coord-b-totp', 'totp', 'verified', now(), now())`,
      [IDS.staffA, IDS.staffB],
    );
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("coordinates missions and automatically awards anonymized badges", async () => {
    const mission = await callAs(IDS.staffA, "select public.create_organization_coordination_record('mission','Live mission','', 'members', null, null, null, '{\"targetPoints\":100}', $1) result", [crypto.randomUUID()]);
    expect(mission, mission.message).toMatchObject({ code: "" });
    created.mission = mission.rows[0].result.id;
    const objective = await callAs(IDS.staffA, "select public.create_organization_coordination_record('mission_objective','First objective','', 'members', null, $1, null, '{\"points\":30}', $2) result", [created.mission, crypto.randomUUID()]);
    expect(objective.code).toBe("");
    created.objective = objective.rows[0].result.id;
    expect((await callAs(IDS.staffA, "select public.transition_organization_coordination_record($1,'activate','{}',0,$2)", [created.objective, crypto.randomUUID()])).code).toBe("");
    expect((await callAs(IDS.memberA, "select public.join_organization_coordination_record($1,'participant','{}',$2)", [created.mission, crypto.randomUUID()])).code).toBe("");
    const completion = await callAs(IDS.memberA, "select public.transition_organization_coordination_record($1,'complete_objective','{}',999999,$2) result", [created.objective, crypto.randomUUID()]);
    expect(completion.rows[0].result).toMatchObject({ transitioned: true, pointsAwarded: 30 });
    const repeated = await callAs(IDS.memberA, "select public.transition_organization_coordination_record($1,'complete_objective','{}',999999,$2) result", [created.objective, crypto.randomUUID()]);
    expect(repeated.rows[0].result).toMatchObject({ transitioned: false, alreadyCompleted: true, pointsAwarded: 0 });
    const points = await client.query(
      "select points from public.organization_coordination_user_participants where record_id = $1 and user_id = $2",
      [created.mission, IDS.memberA],
    );
    expect(points.rows[0].points).toBe(30);
    const extension = await callAs(IDS.memberA, "select public.get_organization_coordination_extensions() result");
    expect(extension.rows[0].result.badges).toEqual(expect.arrayContaining([expect.objectContaining({ badge: "bronze" })]));
    expect(extension.rows[0].result.badges[0]).not.toHaveProperty("userId");
  });

  it("lets participating staff complete an objective without closing the shared objective", async () => {
    const mission = await callAs(IDS.staffA, "select public.create_organization_coordination_record('mission','Staff mission','', 'members', null, null, null, '{\"targetPoints\":100}', $1) result", [crypto.randomUUID()]);
    expect(mission, mission.message).toMatchObject({ code: "" });
    const objective = await callAs(IDS.staffA, "select public.create_organization_coordination_record('mission_objective','Staff objective','', 'members', null, $1, null, '{\"points\":45}', $2) result", [mission.rows[0].result.id, crypto.randomUUID()]);
    expect(objective, objective.message).toMatchObject({ code: "" });
    const objectiveId = objective.rows[0].result.id;
    expect((await callAs(IDS.staffA, "select public.transition_organization_coordination_record($1,'activate','{}',0,$2)", [objectiveId, crypto.randomUUID()])).code).toBe("");
    expect((await callAs(IDS.staffA, "select public.join_organization_coordination_record($1,'participant','{}',$2)", [mission.rows[0].result.id, crypto.randomUUID()])).code).toBe("");

    const completion = await callAs(IDS.staffA, "select public.transition_organization_coordination_record($1,'complete_objective','{}',999999,$2) result", [objectiveId, crypto.randomUUID()]);
    expect(completion.rows[0].result).toMatchObject({ transitioned: true, pointsAwarded: 45, status: "active" });
    const participant = await client.query(
      "select points from public.organization_coordination_user_participants where record_id = $1 and user_id = $2",
      [mission.rows[0].result.id, IDS.staffA],
    );
    expect(participant.rows[0].points).toBe(45);
    const storedObjective = await client.query(
      "select status from public.organization_coordination_records where id = $1",
      [objectiveId],
    );
    expect(storedObjective.rows[0].status).toBe("active");

    const snapshot = await callAs(
      IDS.staffA,
      "select public.get_organization_coordination_snapshot() result",
    );
    expect(snapshot.rows[0].result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: objectiveId, completedByCaller: true }),
    ]));

    const page = await callAs(
      IDS.staffA,
      "select public.list_organization_coordination_records(null,null,50) result",
    );
    expect(page.rows[0].result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: objectiveId, completedByCaller: true }),
    ]));

    const otherCallerSnapshot = await callAs(
      IDS.memberA,
      "select public.get_organization_coordination_snapshot() result",
    );
    expect(otherCallerSnapshot.rows[0].result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: objectiveId, completedByCaller: false }),
    ]));
  });

  it("requires an accepted link and an explicit permission for cross-organization conversation", async () => {
    const link = await callAs(IDS.staffA, "select public.create_organization_coordination_record('network_link','Partner link','', 'staff', $1, null, null, '{}', $2) result", [IDS.orgB, crypto.randomUUID()]);
    expect(link, link.message).toMatchObject({ code: "" });
    created.link = link.rows[0].result.id;
    const invitedRead = await callAs(IDS.staffB, "select id from public.organization_coordination_records where id = $1", [created.link]);
    expect(invitedRead.rows).toHaveLength(0);
    const invitedSnapshot = await callAs(IDS.staffB, "select public.get_organization_coordination_snapshot() result");
    expect(invitedSnapshot.rows[0].result.records.some((record) => record.id === created.link)).toBe(false);
    const before = await callAs(IDS.staffA, "select public.create_organization_coordination_record('network_conversation','Denied conversation','', 'participants', null, $1, null, '{}', $2)", [created.link, crypto.randomUUID()]);
    expect(before.code).toBe("23514");
    expect((await callAs(IDS.staffB, "select public.respond_organization_coordination_invitation($1,true,$2)", [created.link, crypto.randomUUID()])).code).toBe("");
    expect((await callAs(IDS.staffA, "select public.set_organization_network_permission($1,$2,'message',true)", [created.link, IDS.orgB])).code).toBe("");
    const broad = await callAs(IDS.staffA, "select public.create_organization_coordination_record('network_conversation','Broad conversation','', 'members', null, $1, null, '{}', $2)", [created.link, crypto.randomUUID()]);
    expect(broad.code).toBe("23514");
    const conversation = await callAs(IDS.staffA, "select public.create_organization_coordination_record('network_conversation','Allowed conversation','', 'participants', null, $1, null, '{}', $2) result", [created.link, crypto.randomUUID()]);
    expect(conversation.code).toBe("");
    created.conversation = conversation.rows[0].result.id;
    expect((await callAs(IDS.staffA, "select public.transition_organization_coordination_record($1,'activate','{}',0,$2)", [created.conversation, crypto.randomUUID()])).code).toBe("");
    const sent = await callAs(IDS.staffB, "select public.send_organization_coordination_message($1,'Partner update',$2) result", [created.conversation, crypto.randomUUID()]);
    expect(sent.code).toBe("");
    const history = await callAs(IDS.staffB, "select public.list_organization_coordination_messages(null,null,30) result");
    expect(history.rows[0].result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: created.conversation, body: "Partner update" }),
    ]));
    expect((await callAs(IDS.staffA, "select public.set_organization_network_permission($1,$2,'message',false)", [created.link, IDS.orgB])).code).toBe("");
    const revoked = await callAs(IDS.staffB, "select public.send_organization_coordination_message($1,'Blocked update',$2)", [created.conversation, crypto.randomUUID()]);
    expect(revoked.code).toBe("42501");
  });

  it("accepts directory parentage only after a live parent-issued oversight grant", async () => {
    const denied = await callAs(
      IDS.staffA,
      "select public.upsert_organization_network_profile('Org A network','','partners','coordinator_routed',$1)",
      [IDS.orgB],
    );
    expect(denied.code).toBe("42501");
    expect((await callAs(IDS.staffB, "select public.set_organization_network_permission($1,$2,'oversight',true)", [created.link, IDS.orgA])).code).toBe("");
    const accepted = await callAs(
      IDS.staffA,
      "select public.upsert_organization_network_profile('Org A network','','partners','coordinator_routed',$1) result",
      [IDS.orgB],
    );
    expect(accepted.rows[0].result).toMatchObject({ saved: true, parentOrganizationId: IDS.orgB });
    const events = await callAs(IDS.staffA, "select public.list_organization_network_access_events(50) result");
    expect(events.rows[0].result).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorOrganizationId: IDS.orgB, subjectOrganizationId: IDS.orgA }),
    ]));
  });

  it("executes only exact reviewed merger mappings and leaves both tenants intact", async () => {
    const plan = await callAs(IDS.staffA, "select public.create_organization_coordination_record('merger_plan','Mapping plan','', 'staff', $1, null, null, '{}', $2) result", [IDS.orgB, crypto.randomUUID()]);
    expect(plan, plan.message).toMatchObject({ code: "" });
    created.plan = plan.rows[0].result.id;
    expect((await callAs(IDS.staffB, "select public.respond_organization_coordination_invitation($1,true,$2)", [created.plan, crypto.randomUUID()])).code).toBe("");
    expect((await callAs(IDS.staffB, "select public.review_organization_merge_match($1,$2,$3,'approved')", [created.plan, IDS.memberA, IDS.memberB])).code).toBe("");
    const wrong = await callAs(IDS.staffB, "select public.execute_organization_merge_plan($1,$2,$3,$4)", [created.plan, IDS.orgB, IDS.orgA, crypto.randomUUID()]);
    expect(wrong.code).toBe("PT409");
    const exact = await callAs(IDS.staffB, "select public.execute_organization_merge_plan($1,$2,$3,$4) result", [created.plan, IDS.orgA, IDS.orgB, crypto.randomUUID()]);
    expect(exact.code).toBe("");
    expect(exact.rows[0].result).toMatchObject({ status: "completed", approvedMatchCount: 1 });
    const tenants = await client.query("select count(*)::integer count from public.organizations where id in ($1,$2)", [IDS.orgA, IDS.orgB]);
    expect(tenants.rows[0].count).toBe(2);
    const remaps = await client.query("select count(*)::integer count from public.organization_merge_remap_events where plan_id = $1", [created.plan]);
    expect(remaps.rows[0].count).toBe(1);
  });

  it("requires the configured coalition quorum before authorizing shared work", async () => {
    const coalition = await callAs(IDS.staffA, "select public.create_organization_coordination_record('coalition','Live coalition','', 'staff', $1, null, null, '{}', $2) result", [IDS.orgB, crypto.randomUUID()]);
    expect(coalition, coalition.message).toMatchObject({ code: "" });
    created.coalition = coalition.rows[0].result.id;
    expect((await callAs(IDS.staffB, "select public.respond_organization_coordination_participant($1,true,$2)", [created.coalition, crypto.randomUUID()])).code).toBe("");
    const campaign = await callAs(IDS.staffA, "select public.create_organization_coordination_record('coalition_campaign','Shared campaign','', 'participants', null, $1, null, '{}', $2) result", [created.coalition, crypto.randomUUID()]);
    expect(campaign, campaign.message).toMatchObject({ code: "" });
    created.coalitionCampaign = campaign.rows[0].result.id;
    expect((await callAs(IDS.staffA, "select public.transition_organization_coordination_record($1,'activate','{}',0,$2)", [created.coalitionCampaign, crypto.randomUUID()])).code).toBe("");
    const work = await callAs(IDS.staffA, "select public.create_organization_coordination_record('coalition_work_item','Joint field action','', 'participants', null, $1, null, '{}', $2) result", [created.coalitionCampaign, crypto.randomUUID()]);
    expect(work, work.message).toMatchObject({ code: "" });
    created.coalitionWork = work.rows[0].result.id;
    const bypass = await callAs(IDS.staffA, "select public.transition_organization_coordination_record($1,'activate','{}',0,$2)", [created.coalitionWork, crypto.randomUUID()]);
    expect(bypass.code).toBe("42501");
    const proposal = await callAs(IDS.staffA, "select public.propose_organization_coalition_decision($1,$2,'Authorize joint field action','Two organizations must approve','authorize_work',2,$3) result", [created.coalitionCampaign, created.coalitionWork, crypto.randomUUID()]);
    expect(proposal, proposal.message).toMatchObject({ code: "" });
    created.coalitionDecision = proposal.rows[0].result.decisionId;
    const firstVote = await callAs(IDS.staffA, "select public.vote_organization_coalition_decision($1,'approve','',$2) result", [created.coalitionDecision, crypto.randomUUID()]);
    expect(firstVote.rows[0].result).toMatchObject({ status: "open", approvals: 1, requiredApprovals: 2 });
    const stillDraft = await client.query("select status from public.organization_coordination_records where id = $1", [created.coalitionWork]);
    expect(stillDraft.rows[0].status).toBe("draft");
    const secondVote = await callAs(IDS.staffB, "select public.vote_organization_coalition_decision($1,'approve','',$2) result", [created.coalitionDecision, crypto.randomUUID()]);
    expect(secondVote.rows[0].result).toMatchObject({ status: "approved", approvals: 2, requiredApprovals: 2 });
    const authorized = await client.query("select status from public.organization_coordination_records where id = $1", [created.coalitionWork]);
    expect(authorized.rows[0].status).toBe("active");
  });

  it("publishes the real chapter hierarchy with bounded attachments and takeover audit", async () => {
    await client.query(
      `insert into public.public_site_records (
        id, kind, title_en, title_es, body_en, body_es, region_en, region_es,
        is_published, published_at, created_by, organization_id
      ) values ('wor','chapter','Worcester chapter','Capítulo Worcester',
        'Public chapter information.','Información pública del capítulo.',
        'Worcester','Worcester',true,now(),$1,$2)`,
      [IDS.staffA, IDS.orgA],
    );
    expect((await callAs(IDS.staffA, "select public.upsert_public_chapter_microsite_section('wor','member-help','Member help','Ayuda para miembros','Published help.','Ayuda publicada.',0,true)")).code).toBe("");
    expect((await callAs(IDS.staffA, "select public.upsert_public_chapter_microsite_page('wor','member-help','office-hours','Office hours','Horario de oficina','Weekly office hours.','Horario semanal.',0,true)")).code).toBe("");
    const document = await client.query(
      `insert into public.chapter_documents (
        chapter_id, title, document_type, summary, body, source_url,
        visibility, status, created_by, published_at
      ) values ('wor','Office-hours guide','other','Public scheduling guide','Internal body is not projected.',
        'https://example.test/office-hours.pdf','chapter','published',$1,now()) returning id`,
      [IDS.staffA],
    );
    const documentId = document.rows[0].id;
    const attachment = await callAs(IDS.staffA, "select public.attach_public_chapter_page_document('wor','member-help','office-hours',$1,'Download the office-hours guide') result", [documentId]);
    expect(attachment, attachment.message).toMatchObject({ code: "" });
    const publicPage = await client.query("select public.get_public_chapter_microsite('wor','en') result");
    const projected = publicPage.rows[0].result.sections[0].pages[0].attachments[0];
    expect(projected).toMatchObject({ label: "Download the office-hours guide", sourceUrl: "https://example.test/office-hours.pdf" });
    expect(projected).not.toHaveProperty("body");
    const takeover = await callAs(IDS.staffA, "select public.take_over_public_chapter_page('wor','member-help','office-hours','Operational ownership changed',$1) result", [crypto.randomUUID()]);
    expect(takeover.rows[0].result).toMatchObject({ takenOver: true, chapterCode: "wor", pageSlug: "office-hours" });
    const audit = await client.query("select count(*)::integer count from public.public_chapter_page_takeovers where chapter_code = 'wor' and page_slug = 'office-hours'");
    expect(audit.rows[0].count).toBe(1);
  });

  it("refuses a published staff-only document as a public attachment", async () => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: IDS.staffA, role: "authenticated", session_id: IDS.sessionA, aal: "aal2" })]);
    const document = await client.query(
      `insert into public.chapter_documents (
        chapter_id, title, document_type, summary, body, source_url,
        visibility, status, created_by, published_at
      ) values ('wor','Staff-only coordination memo','other','Staff-only summary','Staff-only body',
        'https://example.test/staff-only.pdf','staff','published',$1,now()) returning id`,
      [IDS.staffA],
    );
    const attachment = await callAs(
      IDS.staffA,
      "select public.attach_public_chapter_page_document('wor','member-help','office-hours',$1,'Do not publish') result",
      [document.rows[0].id],
      false,
    );
    expect(attachment.code).toBe("23514");
    expect(attachment.message).toContain("published same-chapter document required");
  });

  it("hides an attachment after its document becomes staff-only while keeping chapter-visible attachments", async () => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: IDS.staffA, role: "authenticated", session_id: IDS.sessionA, aal: "aal2" })]);
    const document = await client.query(
      `insert into public.chapter_documents (
        chapter_id, title, document_type, summary, body, source_url,
        visibility, status, created_by, published_at
      ) values ('wor','Visibility transition memo','other','Transition summary','Transition body',
        'https://example.test/transition.pdf','chapter','published',$1,now()) returning id`,
      [IDS.staffA],
    );
    const attached = await callAs(
      IDS.staffA,
      "select public.attach_public_chapter_page_document('wor','member-help','office-hours',$1,'Transition memo') result",
      [document.rows[0].id],
    );
    expect(attached.code).toBe("");
    await client.query("update public.chapter_documents set visibility = 'staff' where id = $1", [document.rows[0].id]);

    await client.query("select set_config('request.jwt.claims', null, true)");
    await client.query("set local role anon");
    const publicPage = await client.query("select public.get_public_chapter_microsite('wor','en') result");
    await client.query("reset role");

    const attachments = publicPage.rows[0].result.sections[0].pages[0].attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      label: "Download the office-hours guide",
      sourceUrl: "https://example.test/office-hours.pdf",
    });
    expect(attachments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Transition memo" }),
    ]));

    await client.query("reset role");
    await client.query("update public.chapter_documents set visibility = 'staff' where chapter_id = 'wor' and title = 'Office-hours guide'");
    await client.query("select set_config('request.jwt.claims', null, true)");
    await client.query("set local role anon");
    const emptyPage = await client.query("select public.get_public_chapter_microsite('wor','en') result");
    await client.query("reset role");

    expect(emptyPage.rows[0].result).toMatchObject({ sections: expect.any(Array) });
    expect(emptyPage.rows[0].result.sections[0].pages[0].attachments).toEqual([]);
  });

  it("pages coordination records with a stable, non-overlapping keyset cursor", async () => {
    await client.query(
      `insert into public.organization_coordination_records (
        id, organization_id, kind, title, summary, status, visibility,
        config, created_by, idempotency_key, created_at, updated_at
      ) select gen_random_uuid(), $1, 'mission', 'Paged mission ' || sequence,
        '', 'active', 'members', '{}', $2, gen_random_uuid(),
        now() - (sequence || ' minutes')::interval,
        now() - (sequence || ' minutes')::interval
      from generate_series(1, 55) sequence`,
      [IDS.orgA, IDS.staffA],
    );
    const first = await callAs(IDS.staffA, "select public.list_organization_coordination_records(null,null,50) result");
    expect(first.rows[0].result.records).toHaveLength(50);
    const last = first.rows[0].result.records.at(-1);
    const second = await callAs(
      IDS.staffA,
      "select public.list_organization_coordination_records($1,$2,50) result",
      [last.updatedAt, last.id],
    );
    const firstIds = new Set(first.rows[0].result.records.map((record) => record.id));
    expect(second.rows[0].result.records.length).toBeGreaterThan(0);
    expect(second.rows[0].result.records.some((record) => firstIds.has(record.id))).toBe(false);
  });

  it("pages partner messages stably and returns a bounded downloadable export", async () => {
    await client.query(
      `insert into public.organization_coordination_messages (
        conversation_id, sender_organization_id, sender_user_id, body,
        idempotency_key, created_at
      ) select $1, $2, $3, 'Paged partner message ' || sequence,
        gen_random_uuid(), now() - (sequence || ' minutes')::interval
      from generate_series(1, 35) sequence`,
      [created.conversation, IDS.orgA, IDS.staffA],
    );
    const first = await callAs(IDS.staffB, "select public.list_organization_coordination_messages(null,null,30) result");
    expect(first.rows[0].result.messages).toHaveLength(30);
    expect(first.rows[0].result.nextCursor).toBeTruthy();
    const second = await callAs(
      IDS.staffB,
      "select public.list_organization_coordination_messages($1,$2,30) result",
      [first.rows[0].result.nextCursor.createdAt, first.rows[0].result.nextCursor.id],
    );
    const firstIds = new Set(first.rows[0].result.messages.map((message) => message.id));
    expect(second.rows[0].result.messages.length).toBeGreaterThan(0);
    expect(second.rows[0].result.messages.some((message) => firstIds.has(message.id))).toBe(false);

    const formulaRecord = await callAs(
      IDS.staffA,
      "select public.create_organization_coordination_record('mission','=2+2','DO-NOT-EXPORT', 'members', null, null, null, '{}', $1) result",
      [crypto.randomUUID()],
    );
    expect(formulaRecord.code).toBe("");
    const schedule = await callAs(
      IDS.staffA,
      "select public.create_organization_coordination_record('network_export_schedule','Internal export','', 'staff', null, null, null, '{\"format\":\"csv\",\"deliveryMode\":\"internal_download\",\"cadence\":\"weekly\",\"nextRunAt\":\"2026-08-29T12:00:00Z\"}', $1) result",
      [crypto.randomUUID()],
    );
    expect(schedule.code).toBe("");
    created.exportSchedule = schedule.rows[0].result.id;
    expect((await callAs(IDS.staffA, "select public.transition_organization_coordination_record($1,'activate','{}',0,$2)", [created.exportSchedule, crypto.randomUUID()])).code).toBe("");
    const run = await callAs(IDS.staffA, "select public.run_organization_coordination_export($1,'csv',$2) result", [created.exportSchedule, crypto.randomUUID()]);
    expect(run.rows[0].result).toMatchObject({ status: "ready", deliveryMode: "internal_download" });
    const payload = await callAs(IDS.staffA, "select public.get_organization_coordination_export_payload($1) result", [run.rows[0].result.runId]);
    expect(payload.rows[0].result).toMatchObject({ mimeType: "text/csv" });
    expect(payload.rows[0].result.filename).toMatch(/^coordination-export-\d{14}\.csv$/);
    expect(payload.rows[0].result.content).toContain("\"'=2+2\"");
    expect(payload.rows[0].result.content).not.toContain("DO-NOT-EXPORT");
  });

  it("has retired the independent SAMPLE coordination generators", async () => {
    const result = await client.query("select to_regprocedure('private.demo_seed_apply_organization_coordination(text,uuid)') as apply, to_regprocedure('private.demo_seed_remove_organization_coordination(text,uuid)') as remove");
    expect(result.rows[0]).toEqual({ apply: null, remove: null });
  });

  it("withholds direct table writes from authenticated clients", async () => {
    const denied = await callAs(IDS.staffA, "insert into public.organization_network_directory_profiles (organization_id, display_name) values ($1,'Bypass')", [IDS.orgA], false);
    expect(denied.code).toBe("42501");
    const decisionDenied = await callAs(IDS.staffA, "insert into public.organization_coalition_decisions (campaign_id, subject_record_id, proposing_organization_id, title, action, required_approvals, proposed_by, idempotency_key) values ($1,$2,$3,'Bypass','authorize_work',1,$4,$5)", [created.coalitionCampaign, created.coalitionWork, IDS.orgA, IDS.staffA, crypto.randomUUID()], false);
    expect(decisionDenied.code).toBe("42501");
  });
});
