-- Union Demo stores its chapter cardinality in the per-run chapter map, not
-- as a column on private.uniondemo_runs. Derive the modulo width from that
-- authoritative map so the shared function-parity helper works on hosted and
-- freshly migrated SAMPLE databases.

create or replace function private.demo_seed_chapter(
  p_lane text,
  p_run_id uuid,
  p_ordinal integer
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_chapter text;
  lane_count integer;
begin
  if p_lane = 'presg' then
    return 'presg';
  elsif p_lane = 'uniondemo' then
    select pg_catalog.count(*)::integer into lane_count
    from private.uniondemo_chapters
    where run_id = p_run_id;

    if lane_count = 0 then
      raise exception 'union demo run has no seeded chapters';
    end if;

    select chapter_id into found_chapter
    from private.uniondemo_chapters
    where run_id = p_run_id
      and chapter_index = 1 + (greatest(p_ordinal, 1) - 1) % lane_count;

    if found_chapter is null then
      raise exception 'union demo chapter map is not contiguous';
    end if;
    return found_chapter;
  end if;
  raise exception 'unknown demo lane';
end;
$function$;

revoke all on function private.demo_seed_chapter(text, uuid, integer)
  from public, anon, authenticated, service_role;
