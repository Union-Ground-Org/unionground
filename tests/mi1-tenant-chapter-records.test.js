// @vitest-environment node
//
// 20260822010000 installed the first tenant-scoped chapter_records policies.
// 20260826140000 replaced both read policies, and 20260830060000 dropped the
// staff write policies and replaced the read set again. The first describe
// pins that superseded snapshot on purpose. The second checks the claim
// against the migration that dropped or replaced every policy the snapshot
// names and against the live rows in scripts/db-contract.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMigrationName, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const SNAPSHOT = "20260822010000_mi1_organization_scope_foundation";
const INTERMEDIATE = "20260826140000_chapter_record_publication_and_broadcast_audience";
const CURRENT = "20260830060000_institutional_records_completion";

// Policies the snapshot creates or alters. read_chapter is replaced in place.
// The other three are dropped and never recreated.
const SUPERSEDED_POLICIES = [
  "chapter_records_read_chapter",
  "chapter_records_read_contacts",
  "chapter_records_staff_create",
  "chapter_records_staff_write",
];
const DROPPED_NOT_RECREATED = [
  "chapter_records_read_contacts",
  "chapter_records_staff_create",
  "chapter_records_staff_write",
];
const LIVE_POLICIES = [
  "chapter_records_read_chapter",
  "chapter_records_read_staff",
];

const snapshot = stripComments(loadMigrationSql(SNAPSHOT));
const current = stripComments(loadMigrationSql(CURRENT));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("superseded 20260822010000 chapter_records policy snapshot", () => {
  it("superseded snapshot let same-organization same-chapter members read minutes, decisions, and milestones", () => {
    expect(snapshot).toContain("drop policy if exists chapter_records_read on public.chapter_records");
    expect(snapshot).toContain("create policy chapter_records_read_chapter on public.chapter_records");
    expect(snapshot).toContain("record_type in ('minutes', 'decision', 'milestone')");
    expect(snapshot).toContain("chapter_id = private.current_member_chapter()");
    expect(snapshot).toContain("c.organization_id = private.current_member_organization()");
  });

  it("superseded snapshot restricted contact records to authorized same-organization staff after MFA", () => {
    expect(snapshot).toContain("create policy chapter_records_read_contacts on public.chapter_records");
    expect(snapshot).toContain("record_type in ('member_contact', 'management_contact')");
    expect(snapshot).toContain("private.has_organization_role(");
    expect(snapshot).toContain("private.member_has_chapter_role(");
  });

  it("superseded snapshot blocked staff writes against ownerless chapters", () => {
    expect(snapshot).toContain("alter policy chapter_records_staff_create on public.chapter_records");
    expect(snapshot).toContain("alter policy chapter_records_staff_write on public.chapter_records");
    expect(snapshot).toMatch(/chapter_records_staff_create[\s\S]*organization_id is not null/);
    expect(snapshot).toMatch(/chapter_records_staff_write[\s\S]*with check \([\s\S]*organization_id is not null/);
  });
});

describe("current chapter_records policy set checked against that superseded snapshot", () => {
  it("was already replaced once before the institutional-records migration dropped the rest", () => {
    expect(findMigrationName(INTERMEDIATE) > findMigrationName(SNAPSHOT)).toBe(true);
    expect(findMigrationName(CURRENT) > findMigrationName(INTERMEDIATE)).toBe(true);
    const intermediate = stripComments(loadMigrationSql(INTERMEDIATE));
    expect(intermediate).toContain("drop policy if exists chapter_records_read_chapter on public.chapter_records");
    expect(intermediate).toContain("drop policy if exists chapter_records_read_contacts on public.chapter_records");
    const rebuilt = intermediate.slice(intermediate.indexOf("create policy chapter_records_read_chapter"));
    expect(rebuilt).toContain("create policy chapter_records_read_contacts on public.chapter_records");
    expect(rebuilt).toContain("private.chapter_record_publication(record_type) = 'chapter_members'");
    expect(rebuilt).not.toContain("record_type in ('minutes', 'decision', 'milestone')");
  });

  it("drops every policy the snapshot names and recreates only the live read pair", () => {
    const drops = [...current.matchAll(/drop policy if exists (chapter_records_[a-z0-9_]+)/g)].map((match) => match[1]);
    expect([...drops].sort()).toEqual([
      "chapter_records_read_chapter",
      "chapter_records_read_contacts",
      "chapter_records_read_staff",
      "chapter_records_staff_create",
      "chapter_records_staff_write",
    ]);
    for (const name of SUPERSEDED_POLICIES) {
      expect(drops).toContain(name);
    }

    const creates = [...current.matchAll(/create policy (chapter_records_[a-z0-9_]+)/g)].map((match) => match[1]);
    expect(creates).toEqual(LIVE_POLICIES);
    for (const name of DROPPED_NOT_RECREATED) {
      expect(current).not.toContain(`create policy ${name}`);
      expect(current).not.toContain(`alter policy ${name}`);
    }

    const chapterPolicy = current.slice(
      current.indexOf("create policy chapter_records_read_chapter"),
      current.indexOf("create policy chapter_records_read_staff"),
    );
    expect(chapterPolicy).toContain("private.chapter_record_publication(record_type) = 'chapter_members'");
    expect(chapterPolicy).toContain("lifecycle_status = 'published'");
    expect(chapterPolicy).toContain("visibility = 'chapter'");
    expect(chapterPolicy).toContain("archived_at is null");
    expect(chapterPolicy).toContain("private.can_read_chapter_member_record(chapter_id)");
    expect(chapterPolicy).not.toContain("record_type in (");

    const staffPolicy = current.slice(
      current.indexOf("create policy chapter_records_read_staff"),
      current.indexOf("comment on policy chapter_records_read_chapter"),
    );
    expect(staffPolicy).toContain("archived_at is null");
    expect(staffPolicy).toContain("private.can_read_chapter_contact_record(chapter_id)");
    expect(staffPolicy).not.toContain("record_type in (");

    const currentName = findMigrationName(CURRENT);
    const watched = [...DROPPED_NOT_RECREATED, ...LIVE_POLICIES];
    for (const file of migrationFiles()) {
      if (file.name <= currentName) continue;
      if (!watched.some((name) => file.sql.includes(name))) continue;
      const code = stripComments(file.sql);
      for (const name of watched) {
        expect(
          code.includes(`create policy ${name}`) || code.includes(`alter policy ${name}`),
          file.name,
        ).toBe(false);
      }
    }
  });

  it("matches the chapter_records policy list in scripts/db-contract.json", () => {
    const live = contract.policies
      .filter((entry) => entry.table === "chapter_records")
      .map((entry) => entry.name)
      .sort();
    // 20261028210000 merged the two live read policies into one permissive
    // SELECT policy (PERF-UG-RLS-MULTIPLE-PERMISSIVE-POLICIES-MERGE-20261028).
    // #6682 (20261102005607) adds one restrictive unit/committee scope policy.
    expect(live).toEqual(["chapter_records_container_scope", "chapter_records_select"]);
    for (const name of [...DROPPED_NOT_RECREATED, ...LIVE_POLICIES]) {
      expect(contract.policies.some((entry) => entry.name === name)).toBe(false);
    }

    const byName = new Map(
      contract.policies
        .filter((entry) => entry.table === "chapter_records")
        .map((entry) => [entry.name, entry]),
    );
    const merged = byName.get("chapter_records_select");
    const [chapterBranch, staffBranch] = merged.qual.slice(1, -1).split(" OR ");
    const chapter = { cmd: merged.cmd, qual: chapterBranch };
    expect(chapter.cmd).toBe("r");
    expect(chapter.qual).toContain("chapter_record_publication(record_type) = 'chapter_members'::text");
    expect(chapter.qual).toContain("lifecycle_status = 'published'::text");
    expect(chapter.qual).toContain("visibility = 'chapter'::text");
    expect(chapter.qual).toContain("archived_at IS NULL");
    expect(chapter.qual).toContain("can_read_chapter_member_record(chapter_id)");
    expect(chapter.qual).not.toContain("record_type in");

    const staff = { cmd: merged.cmd, qual: staffBranch };
    expect(staff.cmd).toBe("r");
    expect(staff.qual).toContain("archived_at IS NULL");
    expect(staff.qual).toContain("can_read_chapter_contact_record(chapter_id)");

    expect(contract.policiesForbidden).toContainEqual(expect.objectContaining({
      table: "chapter_records",
      namePattern: "chapter_records_staff_(create|write)$",
    }));
  });
});
