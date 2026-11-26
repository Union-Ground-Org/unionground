-- Broadcasts carry the language they were written in, so the other locale's
-- readers get an honest "In English / En español" flag instead of a silent
-- language switch. Existing rows (seeds and everything published so far) are
-- English, so the backfill default is honest.

set local lock_timeout = '5s';

alter table public.member_broadcasts
  add column locale text not null default 'en'
  check (locale in ('en', 'es'));

-- Old two-arg signature is replaced, not overloaded: PostgREST would
-- otherwise see an ambiguous RPC name for calls that omit the new argument.
drop function if exists public.publish_member_broadcast(text, text);

create function public.publish_member_broadcast(p_title text, p_body text, p_locale text default 'en')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  clean_locale text := coalesce(nullif(pg_catalog.btrim(coalesce(p_locale, '')), ''), 'en');
  recent integer;
  new_id text;
  next_index integer;
  attempts integer := 0;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if clean_title = '' or pg_catalog.char_length(clean_title) > 120 then
    raise exception 'title must be between 1 and 120 characters' using errcode = '22023';
  end if;

  if clean_title ~ '[[:cntrl:]]' then
    raise exception 'title contains unsupported control characters' using errcode = '22023';
  end if;

  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'body must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'body contains unsupported control characters' using errcode = '22023';
  end if;

  if clean_locale not in ('en', 'es') then
    raise exception 'locale must be en or es' using errcode = '22023';
  end if;

  select count(*) into recent
  from public.member_broadcasts
  where created_by = caller
    and published_at >= now() - interval '24 hours';

  if recent >= 5 then
    raise exception 'broadcast limit reached: 5 per steward per day' using errcode = '54000';
  end if;

  loop
    begin
      new_id := 'bc-' || extensions.gen_random_uuid();
      select coalesce(min(order_index), 1) - 1 into next_index from public.member_broadcasts;
      insert into public.member_broadcasts (id, sender, title, body, published_at, order_index, created_by, locale)
      values (new_id, 'Chapter steward', clean_title, clean_body, now(), next_index, caller, clean_locale);
      exit;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;

  return pg_catalog.jsonb_build_object('broadcastId', new_id);
end;
$$;

revoke all on function public.publish_member_broadcast(text, text, text) from public, anon;
grant execute on function public.publish_member_broadcast(text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
