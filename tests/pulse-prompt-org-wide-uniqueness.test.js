// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("pulse_prompt_org_wide_uniqueness"));
const applySql = sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
const originalSql = stripComments(loadMigrationSql("20260828034122_member_engagement_completion"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const INDEX = "organization_pulse_prompts_org_wide_event_key_idx";

describe("pulse prompt org-wide uniqueness (static)", () => {
  it("adds a partial unique index for NULL chapter_id without dropping chapter-scoped uniqueness", () => {
    expect(findMigrationName("pulse_prompt_org_wide_uniqueness") > "20260920012000_public_site_chapter_parent_delete_guard.sql").toBe(true);
    expect(originalSql).toContain("unique (organization_id, chapter_id, event_key)");
    expect(originalSql.toLowerCase()).toContain("references public.organization_pulse_prompts(id) on delete cascade");
    expect(originalSql.toLowerCase()).toContain("unique (prompt_id, user_id, context_key)");
    expect(sql.toLowerCase()).toContain("create unique index organization_pulse_prompts_org_wide_event_key_idx");
    expect(sql.toLowerCase()).toContain("on public.organization_pulse_prompts (organization_id, event_key)");
    expect(sql.toLowerCase()).toContain("where chapter_id is null");
    expect(sql.toLowerCase()).not.toContain("drop constraint");
    expect(sql.toLowerCase()).not.toMatch(/drop index[\s\S]*organization_pulse_prompts/);
    expect(sql.toLowerCase()).toContain("order by updated_at desc, id desc");
    expect(sql.toLowerCase()).toMatch(/lock table public\.organization_pulse_events,\s*public\.organization_pulse_prompts[\s\S]*in share row exclusive mode[\s\S]*pulse_prompt_org_wide_dupes/);
    expect(sql.toLowerCase()).not.toMatch(/pg_catalog\.(least|greatest)\s*\(/);
    expect(sql.toLowerCase()).toMatch(/order by is_keeper desc/);
    expect(sql.toLowerCase()).toMatch(/order by\s+case state when 'responded' then 3 when 'dismissed' then 2 else 1 end desc,\s+updated_at desc/);
    expect(sql.toLowerCase()).toMatch(/pg_catalog\.max\(updated_at\) over \(\s*partition by keep_id, user_id, context_key\s*\) as latest_updated_at/);
    expect(sql.toLowerCase()).toContain("updated_at = plan.latest_updated_at");
    expect(sql.toLowerCase()).toMatch(/prompt_id = plan\.keep_id/);
    expect(sql.toLowerCase()).toMatch(/update public\.organization_pulse_events[\s\S]+delete from public\.organization_pulse_prompts/);
    const pin = contract.indexes.find((entry) => entry.name === INDEX);
    expect(pin?.table).toBe("organization_pulse_prompts");
    expect(pin.defContains).toEqual([
      "UNIQUE INDEX",
      "USING btree (organization_id, event_key)",
      "WHERE (chapter_id IS NULL)",
    ]);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("pulse prompt org-wide uniqueness (disposable database)", () => {
  let client;
  const ids = {
    member: "50916231-0000-4000-8000-000000000001",
    organization: "50916231-0000-4000-8000-000000000101",
    chapterA: "pulse-org-wide-a",
    chapterB: "pulse-org-wide-b",
    keepPrompt: "50916231-0000-4000-8000-000000000201",
    dropPromptA: "50916231-0000-4000-8000-000000000202",
    dropPromptB: "50916231-0000-4000-8000-000000000203",
    keepEventTs: "50916231-0000-4000-8000-000000000301",
    dropEventTsOld: "50916231-0000-4000-8000-000000000302",
    dropEventTsShown: "50916231-0000-4000-8000-000000000303",
    dropEventDupA: "50916231-0000-4000-8000-000000000304",
    dropEventDupB: "50916231-0000-4000-8000-000000000305",
  };
  const options = JSON.stringify(["Yes", "No"]);

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "pulse-org-wide-uniqueness-proof",
    });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it("applies the migration over colliding prompts and then rejects a second org-wide insert", async () => {
    await client.query("begin");
    try {
      await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, 'pulse-org-wide@example.invalid', '{}'::jsonb)", [ids.member]);
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, 'pulse-org-wide', 'Pulse org-wide proof', $2)", [ids.organization, ids.member]);
      await client.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, $1, $1, false, 9911, $2), ($3, $3, $3, false, 9912, $2)", [ids.chapterA, ids.organization, ids.chapterB]);

      await client.query(`drop index if exists public.${INDEX}`);
      await client.query(
        `insert into public.organization_pulse_prompts
           (id, organization_id, chapter_id, event_key, question, options, updated_at)
         values
           ($1, $4, null, 'contract.page', 'Keep me', $5::jsonb, '2026-09-21 18:00:00+00'),
           ($2, $4, null, 'contract.page', 'Drop A', $5::jsonb, '2026-09-21 17:00:00+00'),
           ($3, $4, null, 'contract.page', 'Drop B', $5::jsonb, '2026-09-21 16:00:00+00')`,
        [ids.keepPrompt, ids.dropPromptA, ids.dropPromptB, ids.organization, options],
      );
      await client.query(
        `insert into public.organization_pulse_events
           (id, organization_id, prompt_id, user_id, context_key, state, response_value, shown_at, responded_at, updated_at)
         values
           ($1, $6, $7, $8, 'ts-mix', 'responded', '"yes"'::jsonb, '2026-09-20 08:00:00+00', '2026-09-20 10:00:00+00', '2026-09-20 10:00:00+00'),
           ($2, $6, $9, $8, 'ts-mix', 'responded', '"no"'::jsonb, '2026-09-20 07:00:00+00', '2026-09-20 09:00:00+00', '2026-09-20 09:00:00+00'),
           ($3, $6, $10, $8, 'ts-mix', 'shown', null, '2026-09-20 11:00:00+00', null, '2026-09-20 11:00:00+00'),
           ($4, $6, $9, $8, 'dup-discard', 'responded', '"a"'::jsonb, '2026-09-20 04:00:00+00', '2026-09-20 05:00:00+00', '2026-09-20 05:00:00+00'),
           ($5, $6, $10, $8, 'dup-discard', 'shown', null, '2026-09-20 03:00:00+00', null, '2026-09-20 06:00:00+00')`,
        [
          ids.keepEventTs,
          ids.dropEventTsOld,
          ids.dropEventTsShown,
          ids.dropEventDupA,
          ids.dropEventDupB,
          ids.organization,
          ids.keepPrompt,
          ids.member,
          ids.dropPromptA,
          ids.dropPromptB,
        ],
      );

      await client.query(applySql);

      const prompts = await client.query(
        `select id, question from public.organization_pulse_prompts
         where organization_id = $1 and event_key = 'contract.page' and chapter_id is null`,
        [ids.organization],
      );
      expect(prompts.rows).toEqual([{ id: ids.keepPrompt, question: "Keep me" }]);

      const tsMix = await client.query(
        `select id, state, response_value, shown_at, responded_at, updated_at
         from public.organization_pulse_events
         where prompt_id = $1 and context_key = 'ts-mix'`,
        [ids.keepPrompt],
      );
      expect(tsMix.rows).toHaveLength(1);
      expect(tsMix.rows[0].id).toBe(ids.keepEventTs);
      expect(tsMix.rows[0].state).toBe("responded");
      expect(tsMix.rows[0].response_value).toBe("yes");
      expect(new Date(tsMix.rows[0].shown_at).toISOString()).toBe("2026-09-20T07:00:00.000Z");
      expect(new Date(tsMix.rows[0].responded_at).toISOString()).toBe("2026-09-20T10:00:00.000Z");
      expect(new Date(tsMix.rows[0].updated_at).toISOString()).toBe("2026-09-20T11:00:00.000Z");

      const dupDiscard = await client.query(
        `select id, state, response_value, shown_at, updated_at
         from public.organization_pulse_events
         where prompt_id = $1 and context_key = 'dup-discard'`,
        [ids.keepPrompt],
      );
      expect(dupDiscard.rows).toHaveLength(1);
      expect(dupDiscard.rows[0].id).toBe(ids.dropEventDupA);
      expect(dupDiscard.rows[0].state).toBe("responded");
      expect(dupDiscard.rows[0].response_value).toBe("a");
      expect(new Date(dupDiscard.rows[0].shown_at).toISOString()).toBe("2026-09-20T03:00:00.000Z");
      expect(new Date(dupDiscard.rows[0].updated_at).toISOString()).toBe("2026-09-20T06:00:00.000Z");

      const index = await client.query(
        "select indexdef from pg_indexes where schemaname = 'public' and indexname = $1",
        [INDEX],
      );
      expect(index.rows[0]?.indexdef.toLowerCase()).toContain("unique index");
      expect(index.rows[0]?.indexdef.toLowerCase()).toContain("where (chapter_id is null)");

      await client.query("savepoint expected_org_wide_collision");
      let collision;
      try {
        await client.query(
          `insert into public.organization_pulse_prompts (organization_id, chapter_id, event_key, question, options)
           values ($1, null, 'contract.page', 'Still need help?', $2::jsonb)`,
          [ids.organization, options],
        );
      } catch (error) {
        collision = error;
      }
      await client.query("rollback to savepoint expected_org_wide_collision");
      expect(collision?.code).toBe("23505");

      await client.query(
        `insert into public.organization_pulse_prompts (organization_id, chapter_id, event_key, question, options)
         values ($1, $2, 'contract.page', 'Chapter A?', $4::jsonb),
                ($1, $3, 'contract.page', 'Chapter B?', $4::jsonb)`,
        [ids.organization, ids.chapterA, ids.chapterB, options],
      );
      const chapterRows = await client.query(
        `select chapter_id from public.organization_pulse_prompts
         where organization_id = $1 and event_key = 'contract.page' and chapter_id is not null
         order by chapter_id`,
        [ids.organization],
      );
      expect(chapterRows.rows.map((row) => row.chapter_id)).toEqual([ids.chapterA, ids.chapterB]);
    } finally {
      await client.query("rollback");
    }
  });
});
