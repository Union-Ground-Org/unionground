// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// SEC-UG-ORGANIZATION-WIDE-BALLOT-NOTICE-SWEEP-SELECTS-RECIPIENTS-WITHOUT-A-TENANT-BOUNDARY-20260921
const migration = readFileSync(
  new URL("../supabase/migrations/20260924020100_ballot_notice_sweep_organization_bound.sql", import.meta.url),
  "utf8",
);
const code = migration.replace(/--[^\n]*/g, "");
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

describe("ballot notice sweep organization bound (static)", () => {
  it("routes all three notices through one tenant-bound recipient set and keeps the case-graph preamble", () => {
    const sweep = code.slice(code.indexOf("create or replace function private.ballot_notice_sweep()"));
    expect(sweep.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"))
      .toBeLessThan(sweep.indexOf("for b in"));
    expect(sweep.match(/private\.ballot_notice_recipients\(b\.chapter_id, b\.created_by\)/g)).toHaveLength(3);
    expect(sweep).not.toMatch(/from public\.member_profiles/);
    expect(sweep).toContain("member_ballot_receipts");
    for (const key of ["vote.opened", "vote.closing", "vote.results"]) expect(sweep).toContain(`'${key}'`);

    const helper = code.slice(
      code.indexOf("create or replace function private.ballot_notice_recipients"),
      code.indexOf("create or replace function private.ballot_notice_sweep()"),
    );
    expect(helper).toContain("recipient_membership.status = 'active'");
    expect(helper).toContain("recipient_chapter.organization_id = bo.organization_id");
    expect(helper).toContain("creator_membership.status = 'active'");
    expect(helper).toContain("(p_chapter_id is null or recipient.chapter_id = p_chapter_id)");
    expect(code).toContain(
      "revoke all on function private.ballot_notice_recipients(text, uuid)\n  from public, anon, authenticated, service_role;",
    );
  });
});

async function seed(client) {
  const ids = Object.fromEntries(
    ["orgA", "orgB", "admin", "memberA1", "memberA2", "revokedA1", "memberB"].map((key) => [key, randomUUID()]),
  );
  const tag = ids.orgA.slice(0, 8);
  ids.chapterA1 = `ballotsweep-a1-${tag}`;
  ids.chapterA2 = `ballotsweep-a2-${tag}`;
  ids.chapterB = `ballotsweep-b1-${tag}`;
  const people = [
    [ids.admin, ids.chapterA1, ids.orgA, "active"],
    [ids.memberA1, ids.chapterA1, ids.orgA, "active"],
    [ids.memberA2, ids.chapterA2, ids.orgA, "active"],
    [ids.revokedA1, ids.chapterA1, ids.orgA, "revoked"],
    [ids.memberB, ids.chapterB, ids.orgB, "active"],
  ];
  for (const [user] of people) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [
      user,
      `${user}@example.invalid`,
    ]);
  }
  await client.query(
    "insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3),($4,$5,$5,$6)",
    [ids.orgA, `ballotsweep-a-${ids.orgA}`, ids.admin, ids.orgB, `ballotsweep-b-${ids.orgB}`, ids.memberB],
  );
  await client.query(
    `insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values
      ($1,$1,$1,$4,false,9921),
      ($2,$2,$2,$4,false,9922),
      ($3,$3,$3,$5,false,9923)`,
    [ids.chapterA1, ids.chapterA2, ids.chapterB, ids.orgA, ids.orgB],
  );
  for (const [user, chapter, org, status] of people) {
    await client.query(
      "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
      [org, user],
    );
    await client.query(
      "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
      [user, chapter],
    );
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
  }
  // Revoke after seeding: the leftover profile chapter_id must not re-admit.
  for (const [user, , org, status] of people) {
    if (status !== "revoked") continue;
    await client.query(
      "update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2",
      [org, user],
    );
  }
  return ids;
}

async function withSweepDb(run) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
  });
  await client.connect();
  await client.query("begin");
  try {
    const ids = await seed(client);
    await run(client, ids);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

let orderIndex = 990000 + Math.floor(Math.random() * 9000);

// Every other notice stamp is pre-set so each insert exercises exactly one loop.
async function insertBallot(client, { id, chapterId, createdBy, notice }) {
  const open = notice !== "results";
  const closesAt = notice === "closing" ? "now() + interval '2 hours'" : open ? "now() + interval '3 days'" : "now() - interval '1 minute'";
  orderIndex += 1;
  await client.query(
    `insert into public.member_ballots
       (id, title, closes_at, active, order_index, chapter_id, campaign_state, created_by, published_at,
        opened_notice_sent_at, closing_notice_sent_at, results_notice_sent_at)
     values ($1, $1, ${closesAt}, $2, $3, $4, $5, $6, now() - interval '1 day',
        case when $7 = 'opened' then null else now() end,
        case when $7 = 'closing' then null else now() end,
        case when $7 = 'results' then null else now() end)`,
    [id, open, orderIndex, chapterId, open ? "open" : "closed", createdBy, notice],
  );
}

async function sweepRecipients(client, ids, seen) {
  await client.query("select private.ballot_notice_sweep()");
  const audience = [ids.admin, ids.memberA1, ids.memberA2, ids.revokedA1, ids.memberB];
  const { rows } = await client.query(
    `select n.id, n.user_id from public.member_notifications n
      where n.user_id = any($1::uuid[]) and n.kind = 'votes' and not (n.id = any($2::uuid[]))`,
    [audience, seen],
  );
  const deliveries = await client.query(
    "select distinct d.user_id from public.member_notification_deliveries d where d.notification_id = any($1::uuid[])",
    [rows.map((row) => row.id)],
  );
  seen.push(...rows.map((row) => row.id));
  return { users: new Set(rows.map((row) => row.user_id)), deliveryUsers: deliveries.rows.map((row) => row.user_id) };
}

function expectOnly(result, expected) {
  expect(result.users).toEqual(new Set(expected));
  for (const user of result.deliveryUsers) expect(expected).toContain(user);
}

live("ballot notice sweep on a disposable database", () => {
  it("keeps organization-wide opened, closing and results notices inside the ballot organization", async () => {
    await withSweepDb(async (client, ids) => {
      const tag = ids.orgA.slice(0, 8);
      const seen = [];
      const orgWide = [ids.admin, ids.memberA1, ids.memberA2];
      for (const notice of ["opened", "closing", "results"]) {
        await insertBallot(client, { id: `ballotsweep-org-${notice}-${tag}`, chapterId: null, createdBy: ids.admin, notice });
        const result = await sweepRecipients(client, ids, seen);
        expectOnly(result, orgWide);
        expect(result.users.has(ids.memberB)).toBe(false);
        expect(result.users.has(ids.revokedA1)).toBe(false);
      }
    });
  });

  it("limits a chapter ballot to that chapter and an underivable organization to nobody", async () => {
    await withSweepDb(async (client, ids) => {
      const tag = ids.orgA.slice(0, 8);
      const seen = [];
      await insertBallot(client, { id: `ballotsweep-chapter-${tag}`, chapterId: ids.chapterA2, createdBy: ids.admin, notice: "opened" });
      expectOnly(await sweepRecipients(client, ids, seen), [ids.memberA2]);

      // SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920: an organization-wide
      // ballot with no derivable owner can no longer be written at all.
      await client.query("savepoint orphan_ballot");
      await expect(
        insertBallot(client, { id: `ballotsweep-orphan-${tag}`, chapterId: null, createdBy: null, notice: "results" }),
      ).rejects.toThrow("organization-wide campaigns require an owning organization");
      await client.query("rollback to savepoint orphan_ballot");
      expectOnly(await sweepRecipients(client, ids, seen), []);
    });
  });
});
