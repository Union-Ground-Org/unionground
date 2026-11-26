// @vitest-environment node
//
// SEC-UG-APPOINTMENT-HISTORY-REASON-PRIVACY-20260921 asks for a direct-RPC
// role matrix, not a source pin. The companion file
// tests/appointment-history-reason-privacy-migration.test.js proves the shipped
// SQL still says what it should; this one proves what the shipped SQL DOES. The
// distinction matters for exactly the failure the record names: a later edit
// that adds a supervisor disjunct to `reason_visible` keeps every text pin green
// while restoring the disclosure, and only executing the function as each role
// catches it.
//
// The fixture is deliberately minimal and self-owned: a disposable database
// created from template0 on an owned loopback target, holding only the columns
// public.get_appointment_history reads. The chapter/role/MFA predicates are
// table-driven stubs; their real arithmetic is proved elsewhere. Here they only
// have to answer for a caller, so the projection boundary itself can be proved.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const NAME = "20260925070000_appointment_history_reason_privacy";
const CHAPTER = "chapter-a";
const APPOINTMENT = "00000000-0000-4000-8000-0000000000a1";
const ids = {
  member: "00000000-0000-4000-8000-000000000001",
  steward: "00000000-0000-4000-8000-000000000002",
  formerSteward: "00000000-0000-4000-8000-000000000003",
  coordinator: "00000000-0000-4000-8000-000000000004",
  advisor: "00000000-0000-4000-8000-000000000005",
  admin: "00000000-0000-4000-8000-000000000006",
  outsider: "00000000-0000-4000-8000-000000000007",
};

describe.skipIf(process.env.RUN_APPOINTMENT_HISTORY_DB_TESTS !== "1")(
  "appointment history reason-category privacy, executed as each role",
  () => {
    let admin;
    let client;
    let database;

    async function history(caller) {
      await client.query("select set_config('proof.caller', $1, false)", [caller]);
      const { rows } = await client.query(
        "select public.get_appointment_history($1::uuid) as payload",
        [APPOINTMENT],
      );
      return rows[0].payload;
    }

    beforeAll(async () => {
      const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
      admin = new pg.Client({ connectionString });
      await admin.connect();
      database = `appointment_history_privacy_${process.pid}_${Date.now()}`;
      await admin.query(`create database ${database} template template0`);
      const url = new URL(connectionString);
      url.pathname = `/${database}`;
      client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      await client.query(`
        create schema private; create schema auth;
        -- The caller under test. Every predicate below reads it, so one setting
        -- switches the whole role matrix without re-standing the fixture.
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('proof.caller', true), '')::uuid $$;
        create function private.mfa_satisfied() returns boolean language sql stable as
          $$ select true $$;
        create function private.current_member_chapter() returns text language sql stable as
          $$ select '${CHAPTER}'::text $$;
        create table private.chapter_roles (user_id uuid, chapter_id text, role text);
        create function private.member_has_chapter_role(p_chapter_id text, p_roles text[])
          returns boolean language sql stable security definer as $$
            select exists (
              select 1 from private.chapter_roles r
              where r.user_id = (select auth.uid())
                and r.chapter_id = p_chapter_id
                and r.role = any(p_roles)
            )
          $$;
        create table public.member_appointments (
          id uuid primary key,
          user_id uuid not null,
          steward_id uuid not null,
          chapter_id text not null,
          appointment_type text not null,
          starts_at timestamptz not null,
          ends_at timestamptz not null,
          status text not null,
          reason_category text not null
        );
        create table public.member_appointment_events (
          id uuid primary key,
          appointment_id uuid not null,
          actor uuid,
          action text not null,
          detail jsonb not null default '{}'::jsonb,
          created_at timestamptz not null
        );
        insert into private.chapter_roles values
          ('${ids.steward}', '${CHAPTER}', 'steward'),
          ('${ids.coordinator}', '${CHAPTER}', 'coordinator'),
          ('${ids.advisor}', '${CHAPTER}', 'advisor'),
          ('${ids.admin}', '${CHAPTER}', 'admin');
        insert into public.member_appointments values (
          '${APPOINTMENT}', '${ids.member}', '${ids.steward}', '${CHAPTER}',
          'grievance_followup', timestamptz '2026-09-22 14:00+00', timestamptz '2026-09-22 14:30+00',
          'confirmed', 'discipline'
        );
        insert into public.member_appointment_events values
          ('00000000-0000-4000-8000-0000000000e1', '${APPOINTMENT}', '${ids.member}', 'booked',
           '{"calendarReason":"disciplinary meeting","busyReason":"discipline","routedVia":"steward"}'::jsonb,
           timestamptz '2026-09-20 10:00+00'),
          ('00000000-0000-4000-8000-0000000000e2', '${APPOINTMENT}', null, 'reminder_sent',
           '{"channel":"push"}'::jsonb, timestamptz '2026-09-21 10:00+00');
      `);
      await client.query(fnBody(loadMigrationSql(NAME), "public.get_appointment_history"));
    }, 30_000);

    afterAll(async () => {
      if (client) await client.end();
      if (admin) {
        if (database) await admin.query(`drop database if exists ${database} with (force)`);
        await admin.end();
      }
    }, 30_000);

    it("gives the booking member the reason category", async () => {
      const payload = await history(ids.member);
      expect(payload.appointment.reasonCategory).toBe("discipline");
      expect(payload.appointment.status).toBe("confirmed");
    });

    it("gives the assigned steward who still holds Steward the reason category", async () => {
      const payload = await history(ids.steward);
      expect(payload.appointment.reasonCategory).toBe("discipline");
    });

    it.each(["coordinator", "advisor", "admin"])(
      "admits a chapter %s to the history with no reason category at all",
      async (role) => {
        const payload = await history(ids[role]);
        // Admitted: the supervisor still reads the lifecycle trail.
        expect(payload.items).toHaveLength(2);
        expect(payload.appointment.id).toBe(APPOINTMENT);
        // The key is ABSENT, not null: a null would still tell a supervisor the
        // member recorded a category, and `undefined` is what an omitted jsonb
        // key deserializes to.
        expect(payload.appointment).not.toHaveProperty("reasonCategory");
        expect(Object.keys(payload.appointment)).not.toContain("reasonCategory");
        expect(JSON.stringify(payload)).not.toContain("discipline");
      },
    );

    it("keeps the event-detail scrub for every admitted caller", async () => {
      for (const caller of [ids.member, ids.steward, ids.coordinator]) {
        const payload = await history(caller);
        const detail = payload.items.find((item) => item.action === "booked").detail;
        expect(detail).not.toHaveProperty("calendarReason");
        expect(detail).not.toHaveProperty("busyReason");
        expect(detail.routedVia).toBe("steward");
      }
    });

    it("refuses the assigned steward who no longer holds Steward, and any outsider", async () => {
      await client.query("update public.member_appointments set steward_id = $1 where id = $2", [
        ids.formerSteward,
        APPOINTMENT,
      ]);
      // A stale assignment is not a participant grant: the reassigned account
      // holds no chapter role, so it is refused rather than quietly handed the
      // category on the strength of the steward_id column alone.
      await expect(history(ids.formerSteward)).rejects.toThrow(/history unavailable/);
      await expect(history(ids.outsider)).rejects.toThrow(/history unavailable/);
      await client.query("update public.member_appointments set steward_id = $1 where id = $2", [
        ids.steward,
        APPOINTMENT,
      ]);
    });
  },
);
