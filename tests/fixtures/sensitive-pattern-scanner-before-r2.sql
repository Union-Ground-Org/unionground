-- Exact scanner from pre-repair HEAD 327acf03e730f45a86bcbc6b23b186e6aaafadc9.
create or replace function public.casework_scan_retaliation_patterns(p_chapter_id text)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  perform private.casework_require_mfa();
  if not private.member_has_chapter_role(p_chapter_id, array['coordinator','advisor','admin','vp']) then
    raise exception 'chapter not found' using errcode = '42501';
  end if;
  raise exception 'sensitive-data-encrypted-pattern-index-unavailable' using errcode = '55000';
end
$$;
