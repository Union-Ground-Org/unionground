// @vitest-environment node
// REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. Synthetic fixtures,
// rolled back in a disposable local application database.
import pg from 'pg';
import { expect, it } from 'vitest';
import { assertDisposableProofUrl } from '../scripts/run-required-db-proofs.mjs';

const live = process.env.RUN_ORG_STRUCTURE_IMPORT_DB_TESTS === '1' ? it : it.skip;
const uuid = () => globalThis.crypto.randomUUID();

live('seat status: editor-only writes, tenant boundary, reset on content change, stale projection', async () => {
  const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await c.connect();
  await c.query('begin');
  try {
    const org = uuid(), foreignOrg = uuid();
    const admin = uuid(), member = uuid(), foreignAdmin = uuid();
    const adminSession = uuid(), memberSession = uuid();
    const chapter = `seat-${org}`, foreignChapter = `seat-${foreignOrg}`;
    await c.query("insert into public.organizations(id,slug,name) values ($1,$3,'Synthetic seat proof'),($2,$4,'Synthetic foreign seat proof')", [org, foreignOrg, chapter, foreignChapter]);
    await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900),($3,$3,$3,'proof',$4,9900)", [chapter, org, foreignChapter, foreignOrg]);
    await c.query('insert into auth.users(id,email) values ($1,$4),($2,$5),($3,$6)', [admin, member, foreignAdmin, `${admin}@example.invalid`, `${member}@example.invalid`, `${foreignAdmin}@example.invalid`]);
    await c.query('update public.member_profiles set chapter_id=$2 where id = any($1::uuid[])', [[admin, member], chapter]);
    await c.query('update public.member_profiles set chapter_id=$2 where id=$1', [foreignAdmin, foreignChapter]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active'),($1,$3,'active'),($4,$5,'active') on conflict do nothing", [org, admin, member, foreignOrg, foreignAdmin]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$3,'active'),($2,$3,'active'),($4,$5,'active') on conflict do nothing", [admin, member, chapter, foreignAdmin, foreignChapter]);
    await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin'),($3,$4,'admin')", [org, admin, foreignOrg, foreignAdmin]);
    for (const [user, session] of [[admin, adminSession], [member, memberSession]]) {
      await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [uuid(), user]);
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
    }

    // The organization's own chart: a union root, a seat in the caller's
    // chapter beneath it, and an employer node. The foreign organization holds
    // one node the caller must never reach.
    const unionRoot = uuid(), seat = uuid(), agencyNode = uuid(), foreignNode = uuid();
    await c.query(`insert into public.organization_chart_nodes
      (id, organization_id, chapter_id, chart_kind, node_kind, parent_id, label, collapsed_by_default, source_label, source_as_of, created_by, updated_by)
      values ($1,$5,null,'union','organization',null,'Synthetic council',false,'Synthetic roster','2026-10-01',$7,$7),
             ($2,$5,$6,'union','role',$1,'Synthetic steward seat',true,'Synthetic roster','2026-10-01',$7,$7),
             ($3,$5,null,'agency','organization',null,'Synthetic employer',false,null,null,$7,$7),
             ($4,$8,null,'union','role',null,'Foreign seat',false,null,null,$9,$9)`,
    [unionRoot, seat, agencyNode, foreignNode, org, chapter, admin, foreignOrg, foreignAdmin]);

    const as = async (user, session, sql, params) => {
      await c.query('savepoint rpc_call');
      try {
        await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, session_id: session, role: 'authenticated', aal: 'aal2' })]);
        await c.query('set local role authenticated');
        const result = (await c.query(sql, params)).rows[0]?.r;
        await c.query('reset role');
        await c.query('release savepoint rpc_call');
        return result;
      } catch (error) {
        await c.query('rollback to savepoint rpc_call');
        await c.query('release savepoint rpc_call');
        throw error;
      }
    };
    const setStatus = (user, session, hat, node, status, vacant) => as(user, session,
      'select public.set_organization_chart_seat_status($1,$2,$3,$4) as r', [hat, node, status, vacant]);
    const row = async (id) => (await c.query('select seat_status, seat_status_reviewed_on::text as reviewed, vacant from public.organization_chart_nodes where id=$1', [id])).rows[0];
    const today = (await c.query("select ((now() at time zone 'America/New_York')::date)::text as d")).rows[0].d;

    // Every existing and imported seat starts unconfirmed: nothing confirmed it.
    expect(await row(seat)).toEqual({ seat_status: 'unconfirmed', reviewed: null, vacant: false });

    // A member holds no editor hat and cannot claim one.
    await expect(setStatus(member, memberSession, 'admin', seat, 'confirmed', false)).rejects.toMatchObject({ code: '42501' });
    await expect(setStatus(member, memberSession, 'member', seat, 'confirmed', false)).rejects.toMatchObject({ code: '42501' });
    // Values outside the closed set are refused before any write.
    await expect(setStatus(admin, adminSession, 'admin', seat, 'verified', false)).rejects.toMatchObject({ code: '22023' });
    await expect(setStatus(admin, adminSession, 'admin', seat, 'confirmed', null)).rejects.toMatchObject({ code: '22023' });
    // Another organization's node is not found, and stays untouched.
    await expect(setStatus(admin, adminSession, 'admin', foreignNode, 'confirmed', false)).rejects.toMatchObject({ code: 'P0002' });
    expect(await row(foreignNode)).toEqual({ seat_status: 'unconfirmed', reviewed: null, vacant: false });
    expect(await row(seat)).toEqual({ seat_status: 'unconfirmed', reviewed: null, vacant: false });

    const auditsBefore = Number((await c.query('select count(*) from public.organization_intelligence_audit_events where organization_id=$1', [org])).rows[0].count);
    const saved = await setStatus(admin, adminSession, 'admin', seat, 'confirmed', true);
    expect(saved).toMatchObject({ id: seat, organizationId: org, seatStatus: 'confirmed', vacant: true, seatStatusReviewedOn: today });
    expect(await row(seat)).toEqual({ seat_status: 'confirmed', reviewed: today, vacant: true });
    const audits = (await c.query("select event_type, metadata from public.organization_intelligence_audit_events where organization_id=$1 and entity_id=$2 order by created_at desc", [org, seat])).rows;
    expect(Number((await c.query('select count(*) from public.organization_intelligence_audit_events where organization_id=$1', [org])).rows[0].count)).toBe(auditsBefore + 1);
    expect(audits[0]).toEqual({ event_type: 'chart_node_saved', metadata: { status: 'confirmed' } });
    await setStatus(admin, adminSession, 'admin', agencyNode, 'unknown', false);

    // The member's projection: own organization only, effective status and the
    // collapse hint carried through.
    const projection = await as(member, memberSession, 'select public.get_member_organization_structure() as r', []);
    const nodes = projection.charts.flatMap((chart) => chart.nodes.map((node) => ({ ...node, chartKind: chart.chartKind })));
    expect(nodes.map((node) => node.id).sort()).toEqual([unionRoot, seat, agencyNode].sort());
    expect(nodes.find((node) => node.id === seat)).toMatchObject({ seatStatus: 'confirmed', vacant: true, seatStatusReviewedOn: today, collapsedByDefault: true, chartKind: 'union' });
    expect(nodes.find((node) => node.id === unionRoot)).toMatchObject({ seatStatus: 'unconfirmed', seatStatusReviewedOn: null });
    expect(nodes.find((node) => node.id === agencyNode)).toMatchObject({ seatStatus: 'unknown', chartKind: 'agency' });
    expect(JSON.stringify(projection)).not.toContain(foreignNode);

    // The staff snapshot returns the stored state the editor changes.
    const snapshot = await as(admin, adminSession, "select public.get_organization_intelligence_snapshot('admin') as r", []);
    expect(snapshot.chartNodes.find((node) => node.id === seat)).toMatchObject({ seatStatus: 'confirmed', vacant: true, seatStatusReviewedOn: today, sourceLabel: 'Synthetic roster', sourceAsOf: '2026-10-01' });
    expect(JSON.stringify(snapshot)).not.toContain(foreignNode);

    // A confirmation older than a year reads stale everywhere a member looks.
    await c.query("select set_config('union_ground.chart_seat_review',$1,true)", [seat]);
    await c.query("update public.organization_chart_nodes set seat_status_reviewed_on = ((now() at time zone 'America/New_York')::date - 400) where id=$1", [seat]);
    await c.query("select set_config('union_ground.chart_seat_review','',true)");
    const aged = await as(member, memberSession, 'select public.get_member_organization_structure() as r', []);
    expect(aged.charts.find((chart) => chart.chartKind === 'union').nodes.find((node) => node.id === seat).seatStatus).toBe('stale');

    // Any other write that changes what the seat says drops the confirmation;
    // a layout-only change keeps it; and only the status writer sets a status.
    await setStatus(admin, adminSession, 'admin', seat, 'confirmed', true);
    await c.query('update public.organization_chart_nodes set position_x = 40 where id=$1', [seat]);
    expect(await row(seat)).toEqual({ seat_status: 'confirmed', reviewed: today, vacant: true });
    await c.query("update public.organization_chart_nodes set seat_status = 'unknown', seat_status_reviewed_on = null where id=$1", [seat]);
    expect(await row(seat)).toEqual({ seat_status: 'confirmed', reviewed: today, vacant: true });
    await c.query("update public.organization_chart_nodes set label = 'Synthetic renamed seat' where id=$1", [seat]);
    expect(await row(seat)).toEqual({ seat_status: 'unconfirmed', reviewed: null, vacant: true });
    await setStatus(admin, adminSession, 'admin', seat, 'stale', false);
    await c.query('update public.organization_chart_nodes set vacant = true where id=$1', [seat]);
    expect(await row(seat)).toEqual({ seat_status: 'unconfirmed', reviewed: null, vacant: true });
  } finally {
    await c.query('rollback');
    await c.end();
  }
});
