// @vitest-environment node
//
// BUG-UG-BALLOT-RESULTS-NEVER-PUBLISH-AT-CLOSE-20260920
// Executes the publication-gate lifecycle against a disposable catalog:
// draft / open-future / open-past-close / staff-closed tallies, plus the
// results-notice sweep (draft exclusion and elapsed published re-arm).
// Offline pins in tests/ballot-eligibility-results.test.js still guard the
// SQL text when this live half is skipped.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const gateSql = stripComments(loadMigrationSql("ballot_results_publication_gate")).replace(/\s+/g, " ");

describe("ballot results publication gate (offline pins)", () => {
  it("re-arms drafts and elapsed published open campaigns in one update", () => {
    expect(gateSql).toContain("set results_notice_sent_at = null");
    expect(gateSql).toContain("campaign_state = 'draft'");
    expect(gateSql).toContain("campaign_state = 'open'");
    expect(gateSql).toContain("published_at is not null");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("ballot results publication gate (disposable catalog)", () => {
  let client;
  const ids = {
    user: randomUUID(),
    session: randomUUID(),
    org: randomUUID(),
  };
  const chapter = `c21-pub-${ids.org.slice(0, 8)}`;
  const draftId = `c21-draft-${ids.org.slice(0, 8)}`;
  const futureId = `c21-future-${ids.org.slice(0, 8)}`;
  const elapsedId = `c21-elapsed-${ids.org.slice(0, 8)}`;
  const closedId = `c21-closed-${ids.org.slice(0, 8)}`;

  async function asMember() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
      sub: ids.user,
      role: "authenticated",
      aal: "aal2",
      session_id: ids.session,
    })]);
    await client.query("set local role authenticated");
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "ballot-results-publication-gate-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      ids.user,
      `${ids.user}@example.invalid`,
    ]);
    await client.query("insert into public.organizations (id, slug, name) values ($1, $2, $2)", [
      ids.org,
      chapter,
    ]);
    await client.query(
      "insert into public.chapters (id, name, slug, region, organization_id, order_index) values ($1, $1, $1, 'proof', $2, 97421)",
      [chapter, ids.org],
    );
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [
      ids.user,
      chapter,
    ]);
    await client.query(
      "insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active') on conflict do nothing",
      [ids.org, ids.user],
    );
    await client.query(
      "insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active') on conflict do nothing",
      [ids.user, chapter],
    );
    await client.query(
      "insert into auth.sessions (id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())",
      [ids.session, ids.user],
    );
    const orderBase = 97421;
    await client.query(`
      insert into public.member_ballots
        (id, title, body, closes_at, active, order_index, quorum_target, chapter_id,
         campaign_state, published_at, results_notice_sent_at)
      values
        ($1, 'Draft elapsed', '', now() - interval '1 hour', false, $5, 2, $9,
         'draft', null, now() - interval '30 minutes'),
        ($2, 'Open future', '', now() + interval '2 days', true, $6, 2, $9,
         'open', now() - interval '1 hour', null),
        ($3, 'Open elapsed', '', now() - interval '1 hour', true, $7, 2, $9,
         'open', now() - interval '2 hours', now() - interval '30 minutes'),
        ($4, 'Staff closed', '', now() + interval '2 days', false, $8, 2, $9,
         'closed', now() - interval '1 hour', now() - interval '30 minutes')
    `, [draftId, futureId, elapsedId, closedId, orderBase, orderBase + 1, orderBase + 2, orderBase + 3, chapter]);
    for (const [ballotId, suffix] of [[draftId, "d"], [futureId, "f"], [elapsedId, "e"], [closedId, "c"]]) {
      await client.query(`
        insert into public.member_ballot_options (id, ballot_id, label, label_es, order_index)
        values
          ($1, $3, 'Yes', 'Sí', 0),
          ($2, $3, 'No', 'No', 1)
      `, [`${ballotId}-yes`, `${ballotId}-no`, ballotId]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("clears stale stamps on drafts and elapsed published open campaigns, then the sweep notifies only readable tallies", async () => {
    await client.query("reset role");
    await client.query(`
      update public.member_ballots
      set results_notice_sent_at = null
      where results_notice_sent_at is not null
        and id = any($1::text[])
        and (
          campaign_state = 'draft'
          or (
            campaign_state = 'open'
            and published_at is not null
            and closes_at <= now()
          )
        )
    `, [[draftId, futureId, elapsedId, closedId]]);
    const stamps = (await client.query(
      "select id, results_notice_sent_at is null as cleared from public.member_ballots where id = any($1::text[])",
      [[draftId, futureId, elapsedId, closedId]],
    )).rows.reduce((acc, row) => { acc[row.id] = row.cleared; return acc; }, {});
    expect(stamps[draftId]).toBe(true);
    expect(stamps[elapsedId]).toBe(true);
    expect(stamps[futureId]).toBe(true);
    expect(stamps[closedId]).toBe(false);

    const before = (await client.query(
      "select count(*)::int as n from public.member_notifications where user_id = $1",
      [ids.user],
    )).rows[0].n;
    await client.query("select private.ballot_notice_sweep()");
    const notices = (await client.query(`
      select n.title
      from public.member_notifications n
      where n.user_id = $1
      order by n.created_at
    `, [ids.user])).rows.map((row) => row.title);
    expect(notices.length).toBeGreaterThan(before);
    expect(notices.some((title) => /results/i.test(title))).toBe(true);
    const afterStamps = (await client.query(
      "select id, results_notice_sent_at is not null as stamped from public.member_ballots where id = any($1::text[])",
      [[draftId, elapsedId, futureId, closedId]],
    )).rows.reduce((acc, row) => { acc[row.id] = row.stamped; return acc; }, {});
    expect(afterStamps[draftId]).toBe(false);
    expect(afterStamps[elapsedId]).toBe(true);
    expect(afterStamps[closedId]).toBe(true);
  });

  it("publishes option totals for elapsed open and staff-closed ballots, hides them while open, and refuses drafts", async () => {
    await asMember();
    const tally = async (id) => (await client.query("select public.get_ballot_tally($1) as value", [id])).rows[0].value;
    // beforeAll holds one transaction open for the whole suite, so the expected
    // 22023 would abort it and turn every later assertion into 25P02. The
    // refusal runs inside its own savepoint and the rollback restores the
    // member role and claims set just above.
    await client.query("savepoint draft_refusal");
    await expect(tally(draftId)).rejects.toMatchObject({ code: "22023" });
    await client.query("rollback to savepoint draft_refusal");
    await client.query("release savepoint draft_refusal");
    const future = await tally(futureId);
    expect(future.options).toBeNull();
    const elapsed = await tally(elapsedId);
    expect(Array.isArray(elapsed.options)).toBe(true);
    expect(elapsed.options).toHaveLength(2);
    const closed = await tally(closedId);
    expect(Array.isArray(closed.options)).toBe(true);
    expect(closed.options).toHaveLength(2);
  });
});
