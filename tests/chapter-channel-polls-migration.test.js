import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260820150000_chapter_channel_polls_reads_realtime.sql"),
  "utf8",
).toLowerCase();

describe("chapter channel polls, reads, and realtime migration", () => {
  it("widens the reaction allow-list in the constraint and the RPC together", () => {
    expect(sql).toContain("check (reaction in ('like','support','celebrate','solidarity','strength'))");
    expect(sql).toContain("p_reaction not in ('like','support','celebrate','solidarity','strength')");
    expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
  });

  it("stamps author display identity server-side and keeps it immutable", () => {
    expect(sql).toContain("coalesce(new.author_id, (select auth.uid()))");
    expect(sql).toContain("new.author_name := old.author_name");
    expect(sql).toContain("coalesce(display_name, 'chapter member')");
    // The backfill must run before the trigger exists — the trigger's UPDATE
    // branch preserves old values, so a post-trigger backfill would no-op.
    const backfill = sql.indexOf("update public.chapter_thread_posts posts");
    const trigger = sql.indexOf("create trigger chapter_thread_posts_stamp_author");
    expect(backfill).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(backfill);
    // Author display columns stay out of the client insert grant.
    expect(sql).not.toContain("grant insert (author_name");
  });

  it("keeps channel polls linkable-by-design and clearly apart from ballots", () => {
    expect(sql).toContain("channel polls are not ballots");
    expect(sql).toContain("create table public.chapter_channel_polls");
    expect(sql).toContain("create table public.chapter_channel_poll_options");
    expect(sql).toContain("create table public.chapter_channel_poll_votes");
    // A vote can only point at an option of its own poll.
    expect(sql).toContain("foreign key (option_id, poll_id) references public.chapter_channel_poll_options(id, poll_id)");
    // No ballot table is touched — the mention in the design comment is the
    // only reference.
    expect(sql).not.toContain("table public.member_ballot");
    expect(sql).not.toContain("insert into public.member_ballot");
    expect(sql).not.toContain("alter table public.member_ballot");
  });

  it("restricts votes to owner-only reads and RPC-only writes", () => {
    expect(sql).toContain("create policy chapter_channel_poll_votes_select_own");
    expect(sql).toContain("grant select on public.chapter_channel_poll_votes to authenticated");
    expect(sql).not.toContain("grant insert (poll_id, option_id");
    expect(sql).not.toContain("grant insert on public.chapter_channel_poll_votes");
    expect(sql).not.toContain("grant update on public.chapter_channel_poll_votes");
  });

  it("guards the vote RPC: auth, visibility, close time, option ownership, serialization", () => {
    const start = sql.indexOf("create function public.cast_channel_poll_vote");
    const end = sql.indexOf("create function public.get_channel_poll_tally");
    const body = sql.slice(start, end);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body).toContain("private.can_read_chapter_space(s)");
    expect(body).toContain("poll.closes_at <= now()");
    expect(body).toContain("o.id = p_option_id and o.poll_id = p_poll_id");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("on conflict (poll_id, user_id) do update set option_id = excluded.option_id");
  });

  it("exposes tallies only in aggregate", () => {
    const start = sql.indexOf("create function public.get_channel_poll_tally");
    const end = sql.indexOf("revoke all on function public.cast_channel_poll_vote");
    const body = sql.slice(start, end);
    expect(body).toContain("security definer");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body).toContain("private.can_read_chapter_space(s)");
    expect(body).toContain("count(*)");
    const optionAggregate = body.slice(body.indexOf("select coalesce(pg_catalog.jsonb_agg"), body.indexOf("select pg_catalog.count(*)::integer into total"));
    expect(optionAggregate).not.toContain("user_id");
    const returnedShape = body.slice(body.lastIndexOf("return pg_catalog.jsonb_build_object"));
    expect(returnedShape).not.toContain("user_id");
    expect(returnedShape).not.toContain("caller");
  });

  it("keeps the unread cursor self-scoped behind the visibility gate", () => {
    expect(sql).toContain("create table public.chapter_space_reads");
    expect(sql).toContain("create policy chapter_space_reads_select_own");
    expect(sql).toContain("on conflict (space_id, user_id) do update set last_read_at = now()");
    expect(sql).not.toContain("grant insert on public.chapter_space_reads");
  });

  it("adds every new RLS table with the restrictive mfa_assurance policy", () => {
    for (const table of [
      "chapter_space_reads",
      "chapter_channel_polls",
      "chapter_channel_poll_options",
      "chapter_channel_poll_votes",
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`create policy mfa_assurance on public.${table} as restrictive`);
    }
  });

  it("publishes channel posts insert-only, with the guard refusing anything wider", () => {
    expect(sql).toContain("realtime privacy review");
    expect(sql).toContain("alter publication supabase_realtime add table public.chapter_thread_posts");
    expect(sql).toContain("pubdelete or pubupdate or pubtruncate");
    expect(sql).not.toContain("set (publish = 'insert, update");
  });
});
