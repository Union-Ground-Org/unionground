// @vitest-environment node
// #9263: strict sequence comparisons, including tied timestamps. No mask or
// content-only comparison can excuse a neighbour-dependent order change.
import { describe, expect, it } from "vitest";
import { withMemberExportOrderFixture } from "./helpers/memberExportOrderFixture.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("member export arrays have deterministic order", () => {
  it("breaks timestamp ties with unique keys for appointments, notices and engagement rows", async () => {
    await withMemberExportOrderFixture(async ({ exportOwn, appointments, notices, engagement }) => {
      const value = await exportOwn();
      expect(value.support.appointments.map((row) => row.id)).toEqual(appointments);
      expect(value.notifications.filter((row) => notices.includes(row.id)).map((row) => row.id)).toEqual(notices);
      expect(value.additionalDomains.organization_engagement_events.map((row) => row.source_id)).toEqual(engagement);
    });
  });

  it("keeps exact sequences and content with foreign organization/chapter rows present and absent", async () => {
    await withMemberExportOrderFixture(async ({ db, owner, exportOwn, foreign }) => {
      const before = await exportOwn();
      await owner();
      await db.query("savepoint foreign_export_world");
      await foreign();
      const present = await exportOwn();
      await owner();
      await db.query("rollback to savepoint foreign_export_world; release savepoint foreign_export_world");
      const absent = await exportOwn();
      const control = await exportOwn();
      expect(present).toEqual(absent);
      expect(absent).toEqual(control);
      expect(control).toEqual(before);
    });
  });

  it("retains every appointment and engagement field and row", async () => {
    await withMemberExportOrderFixture(async ({ db, ids, owner, exportOwn, appointments, engagement }) => {
      const value = await exportOwn();
      expect(value.support.appointments).toHaveLength(appointments.length);
      for (const row of value.support.appointments) {
        expect(Object.keys(row).sort()).toEqual(["id","chapterId","appointmentType","durationMinutes","startsAt","endsAt","status","routedVia","reasonCategory","createdAt","updatedAt"].sort());
        expect(row).toMatchObject({ chapterId: ids.chapter, appointmentType: "office_hours", durationMinutes: 30, status: "confirmed", routedVia: "steward", reasonCategory: "general" });
      }
      await owner();
      const expected = (await db.query(`select jsonb_agg(to_jsonb(row) order by occurred_at,organization_id,event_type,source_id) value
        from (select organization_id,user_id,chapter_id,event_type,source_id,occurred_at
          from public.organization_engagement_events where user_id=$1) row`, [ids.member])).rows[0].value;
      expect(value.additionalDomains.organization_engagement_events).toEqual(expected);
      expect(expected).toHaveLength(engagement.length);
    });
  });
});
