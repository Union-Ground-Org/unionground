// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runLive = process.env.RUN_LOCAL_DB_TESTS === "1";
const migrationUrl = new URL(
  "../supabase/migrations/20260812110000_chapter_compass_knowledge.sql",
  import.meta.url,
);

const IDS = {
  staff: "50900000-0000-4000-8000-000000000101",
  member: "50900000-0000-4000-8000-000000000102",
  outsider: "50900000-0000-4000-8000-000000000103",
};

describe.skipIf(!runLive)("chapter-scoped authoritative Compass knowledge", () => {
  let client;
  let rolledBack = false;

  const claims = (sub, aal = "aal2", role = "authenticated") => ({ sub, role, aal });

  async function callAs(sessionClaims, sql, values = [], role = "authenticated", keep = false) {
    await client.query("savepoint compass_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(sessionClaims)]);
      await client.query(`set local role ${role}`);
      const result = await client.query(sql, values);
      if (keep) {
        await client.query("release savepoint compass_probe");
        await client.query("reset role");
      } else {
        await client.query("rollback to savepoint compass_probe");
      }
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint compass_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  beforeAll(async () => {
    const connectionString = process.env.SUPABASE_DB_URL;
    if (!connectionString) throw new Error("SUPABASE_DB_URL is required when RUN_LOCAL_DB_TESTS=1");
    client = new pg.Client({ connectionString, ssl: false, application_name: "compass-authoritative-knowledge-test" });
    await client.connect();
    await client.query("begin");
    await client.query(readFileSync(migrationUrl, "utf8"));
    await client.query(
      `insert into auth.users (id, email)
       values ($1, 'compass-staff@example.test'),
              ($2, 'compass-member@example.test'),
              ($3, 'compass-outsider@example.test')`,
      [IDS.staff, IDS.member, IDS.outsider],
    );
    // handle_new_user creates each profile from the auth insert. Assign the
    // chapter and stable display fields after that trigger rather than racing
    // its primary-key insert.
    await client.query(
      `update public.member_profiles p
          set first_name = fixture.first_name,
              full_name = fixture.full_name,
              initials = fixture.initials,
              chapter_id = fixture.chapter_id
         from (values
           ($1::uuid, 'Staff', 'Compass Staff', 'CS', 'wor'),
           ($2::uuid, 'Member', 'Compass Member', 'CM', 'wor'),
           ($3::uuid, 'Outside', 'Outside Member', 'OM', 'bos')
         ) as fixture(id, first_name, full_name, initials, chapter_id)
        where p.id = fixture.id`,
      [IDS.staff, IDS.member, IDS.outsider],
    );
    await client.query(
      `insert into public.member_roles (user_id, role, chapter_id)
       values ($1, 'steward', 'wor')`,
      [IDS.staff],
    );
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    if (!rolledBack) await client.query("rollback");
    await client.end();
  });

  it("quarantines samples and enforces verified chapter publication with immutable revisions", async () => {
    const quarantine = await client.query(
      `select count(*)::int as total,
              count(*) filter (where is_sample and status = 'retired' and chapter_id is null)::int as quarantined
         from public.member_kb_articles
        where slug like 'contract-%' or slug like 'faq-%'`,
    );
    expect(quarantine.rows[0].total).toBeGreaterThan(0);
    expect(quarantine.rows[0].quarantined).toBe(quarantine.rows[0].total);

    const created = await callAs(
      claims(IDS.staff),
      `select to_jsonb(public.save_chapter_kb_article(
        null, 'contract', 'UB-RGT-01-PROBE agreement source', 'Agreement · Probe',
        'Current approved probe language for a uniquely searchable narwhal clause.',
        array['narwhal clause'], 'draft', false
      )) as result`,
      [],
      "authenticated",
      true,
    );
    expect(created.code).toBe("");
    expect(created.rows[0].result).toMatchObject({
      chapter_id: "wor",
      status: "draft",
      is_sample: false,
      version: 1,
      created_by: IDS.staff,
    });
    const articleId = created.rows[0].result.id;

    const memberDraftRead = await callAs(
      claims(IDS.member),
      "select id from public.member_kb_articles where id = $1",
      [articleId],
    );
    expect(memberDraftRead).toEqual({ code: "", rows: [] });

    const unconfirmed = await callAs(
      claims(IDS.staff),
      `select public.save_chapter_kb_article(
        $1, 'contract', 'UB-RGT-01-PROBE agreement source', 'Agreement · Probe',
        'Current approved probe language for a uniquely searchable narwhal clause.',
        array['narwhal clause'], 'published', false
      )`,
      [articleId],
    );
    expect(unconfirmed.code).toBe("22023");
    expect(unconfirmed.message).toContain("verification confirmation");

    await client.query(
      `insert into auth.mfa_factors
        (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'compass-probe-totp', 'totp', 'verified', now(), now())`,
      [IDS.staff],
    );
    const aal1Denied = await callAs(
      claims(IDS.staff, "aal1"),
      `select public.save_chapter_kb_article(
        $1, 'contract', 'UB-RGT-01-PROBE agreement source', 'Agreement · Probe',
        'Current approved probe language for a uniquely searchable narwhal clause.',
        array['narwhal clause'], 'published', true
      )`,
      [articleId],
    );
    expect(aal1Denied.code).toBe("42501");

    const published = await callAs(
      claims(IDS.staff),
      `select to_jsonb(public.save_chapter_kb_article(
        $1, 'contract', 'UB-RGT-01-PROBE agreement source', 'Agreement · Probe',
        'Current approved probe language for a uniquely searchable narwhal clause.',
        array['narwhal clause'], 'published', true
      )) as result`,
      [articleId],
      "authenticated",
      true,
    );
    expect(published.code).toBe("");
    expect(published.rows[0].result).toMatchObject({
      status: "published",
      version: 2,
      verified_by: IDS.staff,
    });
    expect(published.rows[0].result.verified_at).toBeTruthy();

    const memberPublishedRead = await callAs(
      claims(IDS.member),
      "select id from public.member_kb_articles where id = $1",
      [articleId],
    );
    expect(memberPublishedRead.rows).toEqual([{ id: articleId }]);
    const outsiderRead = await callAs(
      claims(IDS.outsider),
      "select id from public.member_kb_articles where id = $1",
      [articleId],
    );
    expect(outsiderRead.rows).toEqual([]);

    const memberSearch = await callAs(
      claims(IDS.member),
      "select source_id from public.search_member_kb('narwhal clause', 6)",
    );
    expect(memberSearch.rows.some((row) => row.source_id === `kb:${published.rows[0].result.slug}`)).toBe(true);
    const outsiderSearch = await callAs(
      claims(IDS.outsider),
      "select source_id from public.search_member_kb('narwhal clause', 6)",
    );
    expect(outsiderSearch.rows.some((row) => row.source_id.startsWith("kb:"))).toBe(false);

    const crossChapterWrite = await callAs(
      claims(IDS.outsider),
      `select public.save_chapter_kb_article(
        $1, 'contract', 'Cross chapter overwrite', 'Agreement · Probe',
        'This must never replace another chapter source.', array[]::text[], 'draft', false
      )`,
      [articleId],
    );
    expect(crossChapterWrite.code).toBe("42501");

    const directWrite = await callAs(
      claims(IDS.staff),
      `insert into public.member_kb_articles
        (slug, kind, title, article_ref, body, chapter_id, created_by, updated_by)
       values ('direct-write-probe', 'faq', 'Direct write', 'Probe', 'Denied', 'wor', $1, $1)`,
      [IDS.staff],
    );
    expect(directWrite.code).toBe("42501");
    const anonymousRead = await callAs(
      { role: "anon", aal: "aal1" },
      "select id from public.member_kb_articles limit 1",
      [],
      "anon",
    );
    expect(anonymousRead.code).toBe("42501");
    const revisionRead = await callAs(
      claims(IDS.staff),
      "select article_id from public.member_kb_article_revisions where article_id = $1",
      [articleId],
    );
    expect(revisionRead.code).toBe("42501");

    const edited = await callAs(
      claims(IDS.staff),
      `select to_jsonb(public.save_chapter_kb_article(
        $1, 'contract', 'UB-RGT-01-PROBE agreement source', 'Agreement · Probe',
        'Revised approved probe language for a uniquely searchable narwhal clause.',
        array['narwhal clause'], 'published', true
      )) as result`,
      [articleId],
      "authenticated",
      true,
    );
    expect(edited.rows[0].result.version).toBe(3);
    const retired = await callAs(
      claims(IDS.staff),
      "select to_jsonb(public.retire_chapter_kb_article($1)) as result",
      [articleId],
      "authenticated",
      true,
    );
    expect(retired.rows[0].result).toMatchObject({ status: "retired", version: 4 });

    const revisions = await client.query(
      `select version, status, body
         from public.member_kb_article_revisions
        where article_id = $1
        order by version`,
      [articleId],
    );
    expect(revisions.rows).toEqual([
      expect.objectContaining({ version: 1, status: "draft" }),
      expect.objectContaining({ version: 2, status: "published", body: expect.stringContaining("Current approved") }),
      expect.objectContaining({ version: 3, status: "published", body: expect.stringContaining("Revised approved") }),
      expect.objectContaining({ version: 4, status: "retired" }),
    ]);
    const memberRetiredRead = await callAs(
      claims(IDS.member),
      "select id from public.member_kb_articles where id = $1",
      [articleId],
    );
    expect(memberRetiredRead.rows).toEqual([]);

    await client.query("rollback");
    rolledBack = true;
    const residue = await client.query(
      `select
        (select count(*) from public.member_kb_articles where title like 'UB-RGT-01-PROBE%')
        + (select count(*) from auth.users where id = any($1::uuid[])) as leftovers`,
      [Object.values(IDS)],
    );
    expect(Number(residue.rows[0].leftovers)).toBe(0);
  }, 30_000);
});
