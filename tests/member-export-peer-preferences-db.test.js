// @vitest-environment node
// Ledger 511: the actual authenticated export includes only choices made by
// its caller. Inbound blocks must never reveal another person's choices.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withMemberExportOrderFixture } from "./helpers/memberExportOrderFixture.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const tied = "2026-11-01T12:00:00.000Z";

async function preferences(run) {
  await withMemberExportOrderFixture(async (fixture) => {
    const { db, ids, owner } = fixture;
    const peers = [randomUUID(), randomUUID(), randomUUID()].sort();
    await owner();
    for (const id of peers) await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
    // A distinct organization, alongside the steward in the caller's own
    // chapter, proves both tenant and same-chapter person boundaries.
    const otherOrg = randomUUID();
    const otherChapter = `export-preferences-${otherOrg}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional preference organization')", [otherOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9962)", [otherChapter, otherOrg]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [peers[0], otherChapter]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [otherOrg, peers[0]]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [peers[0], otherChapter]);
    const own = async () => {
      await owner();
      // Reverse insertion and equal timestamps force the documented unique
      // tie-breaker instead of accidentally accepting physical row order.
      for (const peer of [...peers].reverse()) await db.query(
        "insert into private.member_peer_blocks(blocker_id,blocked_id,created_at) values($1,$2,$3)", [ids.member, peer, tied]);
      await db.query("insert into private.cross_chapter_peer_mutes(user_id,muted_at) values($1,$2)", [ids.member, tied]);
    };
    const foreign = async () => {
      await owner();
      await db.query("insert into private.member_peer_blocks(blocker_id,blocked_id,created_at) values($1,$2,$3),($4,$5,$3)",
        [ids.steward, ids.member, tied, peers[0], peers[1]]);
      await db.query("insert into private.cross_chapter_peer_mutes(user_id,muted_at) values($1,$3),($2,$3)", [ids.steward, peers[0], tied]);
    };
    await run({ ...fixture, peers, own, foreign });
  });
}

live("member export peer preferences (ledger 511)", () => {
  it("exports every own block in stable time/key order and the caller's own mute", async () => {
    await preferences(async ({ own, foreign, exportOwn, peers, ids }) => {
      await own();
      await foreign();
      const value = await exportOwn();
      expect(value.peerContact.blocks).toEqual(peers.map(() => ({ createdAt: tied.replace(".000Z", "+00:00") })));
      expect(value.peerContact.crossChapterMutes).toEqual([{ mutedAt: tied.replace(".000Z", "+00:00") }]);
      const serialized = JSON.stringify(value);
      for (const peer of [...peers, ids.steward]) expect(serialized).not.toContain(peer);
      expect(serialized).not.toContain("blockedUserId");
    });
  });

  it("returns empty arrays when only other people's choices exist, including a block of the caller", async () => {
    await preferences(async ({ foreign, exportOwn }) => {
      await foreign();
      const value = await exportOwn();
      expect(value.peerContact.blocks).toEqual([]);
      expect(value.peerContact.crossChapterMutes).toEqual([]);
    });
  });

  it("keeps the complete export unchanged with foreign preferences present or absent", async () => {
    await preferences(async ({ db, owner, own, foreign, exportOwn }) => {
      await own();
      const before = await exportOwn();
      await owner();
      await db.query("savepoint foreign_preferences");
      await foreign();
      const present = await exportOwn();
      await owner();
      await db.query("rollback to savepoint foreign_preferences; release savepoint foreign_preferences");
      const absent = await exportOwn();
      expect(present).toEqual(before);
      expect(absent).toEqual(before);
      expect(await exportOwn()).toEqual(before);
    });
  });

  it("records owned projections while keeping the inbound-block lifecycle exclusion", async () => {
    await preferences(async ({ db, owner }) => {
      await owner();
      const rows = (await db.query(`select table_name,user_column,export_disposition,export_projection,export_domain
        from private.account_lifecycle_manifest where schema_name='private'
        and table_name in ('member_peer_blocks','cross_chapter_peer_mutes') order by table_name,user_column`)).rows;
      expect(rows).toEqual([
        { table_name: "cross_chapter_peer_mutes", user_column: "user_id", export_disposition: "included", export_projection: "canonical", export_domain: "peerContact.crossChapterMutes" },
        { table_name: "member_peer_blocks", user_column: "blocked_id", export_disposition: "excluded_with_reason", export_projection: null, export_domain: null },
        { table_name: "member_peer_blocks", user_column: "blocker_id", export_disposition: "included", export_projection: "canonical", export_domain: "peerContact.blocks" },
      ]);
      const notes = (await db.query(`select table_name,note from private.account_lifecycle_manifest
        where schema_name='private' and ((table_name='member_peer_blocks' and user_column='blocker_id')
          or (table_name='cross_chapter_peer_mutes' and user_column='user_id')) order by table_name`)).rows;
      expect(notes[0].note).toContain("Removed with the account.");
      expect(notes[1].note).toContain("Removed with either account.");
      for (const row of notes) expect(row.note).toContain("contact choices exported as timestamps only");
    });
  });
});
