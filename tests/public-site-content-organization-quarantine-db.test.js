// @vitest-environment node
//
// SYS-UG-PUBLIC-LANDING-RPC-OMITS-ORGANIZATION-QUARANTINE-20260921.
//
// The static pins across all four anonymous read RPCs live in
// tests/mi1-public-read-rpc-organization-quarantine.test.js. This is the live
// half (disposable loopback only, one rolled-back transaction): an anonymous
// landing read lists an organization-owned published chapter, win and upcoming
// meeting, and never lists a quarantined ownerless card of any of the three
// kinds.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrationNames } from "./helpers/migration.js";

const NAME = "20260925620500_public_site_content_organization_quarantine.sql";

describe("public landing organization quarantine migration", () => {
  it("applies after the landing reader it re-emits and the MI1 organization column", () => {
    const names = migrationNames();
    expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf("20260812130000_public_site_content_and_interest.sql"));
    expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf("20260822020000_mi1_w1_feature_persistence.sql"));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the anonymous landing read excludes quarantined ownerless cards", () => {
  let client;
  const org = randomUUID();
  const creator = randomUUID();
  const tag = org.slice(0, 8);
  const owned = { chapter: `owned-chapter-${tag}`, win: `owned-win-${tag}`, meeting: `owned-meeting-${tag}` };
  const orphan = { chapter: `orphan-chapter-${tag}`, win: `orphan-win-${tag}`, meeting: `orphan-meeting-${tag}` };

  async function landing(locale) {
    await client.query("savepoint anon_read");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      await client.query("set local role anon");
      const result = await client.query("select public.get_public_site_content($1) content", [locale]);
      await client.query("release savepoint anon_read");
      return result.rows[0].content;
    } catch (error) {
      await client.query("rollback to savepoint anon_read");
      throw error;
    }
  }

  const ids = (content, key) => content[key].map((item) => item.id);

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "public-site-content-organization-quarantine-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into auth.users (id, email) values ($1, $2)", [creator, `${creator}@example.invalid`]);
    await client.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)",
      [org, `landing-quarantine-${tag}`, creator],
    );
    // Transaction-only fixture: the MI1 require-organization trigger refuses a
    // new ownerless card, so the pre-MI1 orphans are written with triggers off,
    // exactly the shape the quarantine exists for. The lowest sort order keeps
    // every fixture card inside the landing's limit of twelve.
    await client.query("set local session_replication_role = replica");
    for (const [cards, organizationId] of [[owned, org], [orphan, null]]) {
      await client.query(
        `insert into public.public_site_records
           (id, kind, title_en, title_es, body_en, body_es, region_en, region_es, occurred_on,
            starts_at, ends_at, location_en, location_es, sort_order, is_published, published_at, organization_id)
         values
           ($1, 'chapter', 'Chapter', 'Capítulo', 'Body', 'Cuerpo', 'Region', 'Región', null,
            null, null, null, null, -2000000000, true, now(), $4),
           ($2, 'win', 'Win', 'Logro', 'Body', 'Cuerpo', null, null, current_date,
            null, null, null, null, -2000000000, true, now(), $4),
           ($3, 'meeting', 'Meeting', 'Reunión', 'Body', 'Cuerpo', null, null, null,
            now() - interval '100 years', now() + interval '1 day', 'Hall', 'Sala', -2000000000, true, now(), $4)`,
        [cards.chapter, cards.win, cards.meeting, organizationId],
      );
    }
    await client.query("set local session_replication_role = origin");
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("lists the organization-owned chapter, win and upcoming meeting", async () => {
    const content = await landing("en");
    expect(ids(content, "chapters")).toContain(owned.chapter);
    expect(ids(content, "wins")).toContain(owned.win);
    expect(ids(content, "meetings")).toContain(owned.meeting);
  });

  it("never lists a quarantined ownerless card, in either locale", async () => {
    for (const locale of ["en", "es"]) {
      const content = await landing(locale);
      expect(ids(content, "chapters"), locale).not.toContain(orphan.chapter);
      expect(ids(content, "wins"), locale).not.toContain(orphan.win);
      expect(ids(content, "meetings"), locale).not.toContain(orphan.meeting);
    }
  });

  it("keeps the landing reader an anonymous definer with an empty search path", async () => {
    const acl = await client.query(
      `select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') anon
         from pg_proc p where p.oid = to_regprocedure('public.get_public_site_content(text)')`,
    );
    expect(acl.rows[0]).toMatchObject({ prosecdef: true, anon: true });
    expect(acl.rows[0].proconfig).toContain("search_path=\"\"");
  });
});
