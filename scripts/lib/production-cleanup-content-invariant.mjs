// Transaction-local, conservative row-content invariant for the offline
// rehearsal. A ledger proves Auth identity ownership, not ownership of rows
// merely sharing a chapter, creator or synthetic-looking identifier.
export function cleanupContentInvariant({ runId, operation, batchCount }) {
  const authDeletion = operation === 'remove-batch';
  const runTransition = authDeletion || operation === 'begin-remove';
  return {
    before: `
-- Content ownership is not inferred from a chapter or an id prefix. Refuse
-- known broad-delete candidates before invoking the existing batch remover.
create function pg_temp.cleanup_rehearsal_content_preflight() returns void
language plpgsql set search_path='' as $content_preflight$
declare target text; collision boolean;
begin
  if ${authDeletion} then
    foreach target in array array[
      'public.chapter_task_activity','public.chapter_task_comments',
      'public.chapter_task_assignments','public.chapter_task_subtasks',
      'public.chapter_task_attachments','public.chapter_task_files',
      'public.chapter_task_messages','public.chapter_task_watchers',
      'public.chapter_task_dependencies','public.chapter_task_template_details',
      'public.chapter_tasks','public.chapter_thread_posts','public.chapter_threads',
      'public.chapter_spaces','private.chapter_task_number_counters',
      'public.chapter_workstreams','public.chapters'
    ] loop
      execute format('select exists(select 1 from %s row_value join private.uniondemo_chapters map on map.chapter_id=row_value.%I where map.run_id=$1)',
        target::regclass,case when target='public.chapters' then 'id' else 'chapter_id' end)
        into collision using '${runId}'::uuid;
      if collision then
        raise exception 'unproven mapped-chapter content: %',target using errcode='55000';
      end if;
    end loop;
    foreach target in array array['public.member_events','public.member_ballots','public.member_surveys','public.member_broadcasts'] loop
      execute format('select exists(select 1 from %s where id like $1)',target::regclass)
        into collision using case target when 'public.member_events' then 'ud-evt-%'
          when 'public.member_ballots' then 'ud-ballot-%' when 'public.member_surveys' then 'ud-pulse-%' else 'ud-bc-%' end;
      if collision then
        raise exception 'unproven prefix-owned content: %',target using errcode='55000';
      end if;
    end loop;
  end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='f' and n.nspname !~ '^pg_' and n.nspname<>'information_schema') then
    raise exception 'foreign-table content cannot be proven locally' using errcode='55000';
  end if;
end;
$content_preflight$;
select pg_temp.cleanup_rehearsal_content_preflight();

-- Only this exact selected Auth batch and its profile rows may disappear.
-- Surviving rows must retain their complete PostgreSQL record representation.
create temporary table cleanup_rehearsal_deletable on commit drop as
  select u.id,sha256(convert_to(u::text,'UTF8')) as auth_hash,
    profile.id is not null as profile_present,
    sha256(convert_to(profile::text,'UTF8')) as profile_hash
  from auth.users u join private.uniondemo_ledger ledger on ledger.user_id=u.id
  left join public.member_profiles profile on profile.id=u.id
  where ${authDeletion} and ledger.run_id='${runId}'::uuid
    and lower(u.email)=ledger.email and u.raw_app_meta_data->>'uniondemo_run_id'='${runId}'
  order by ledger.ordinal limit ${batchCount};

-- auth.users owns auth.identities through an ON DELETE CASCADE. Snapshot the
-- exact selected users' identity rows separately: those rows may disappear
-- only when their owning Auth user disappears, while identities belonging to
-- every unselected user remain covered by the global content fingerprint.
create temporary table cleanup_rehearsal_deletable_identities on commit drop as
  select permitted.id as user_id,
    (select count(*) from auth.identities identity_row where identity_row.user_id=permitted.id) as row_count,
    (select sha256(coalesce(string_agg(row_hash,''::bytea order by row_hash),''::bytea))
      from (select sha256(convert_to(identity_row::text,'UTF8')) as row_hash
        from auth.identities identity_row where identity_row.user_id=permitted.id) identity_rows) as content_hash
  from cleanup_rehearsal_deletable permitted;

create temporary table cleanup_rehearsal_content(
  phase text,relation_oid oid,relation_name text,definition_hash bytea,row_count bigint,content_hash bytea,
  primary key(phase,relation_oid)
) on commit drop;

create function pg_temp.cleanup_rehearsal_capture(p_phase text) returns void
language plpgsql set search_path='' as $capture$
declare relation record; definition_value jsonb; row_expression text; row_filter text;
  content_count bigint; content_digest bytea;
begin
  for relation in
    select c.oid,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
      n.nspname,c.relname,format('%I.%I',n.nspname,c.relname) as qualified_name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relpersistence in ('p','u') and c.relkind in ('r','p','m')
      and n.nspname !~ '^pg_' and n.nspname<>'information_schema'
    order by n.nspname,c.relname
  loop
    select jsonb_build_object('relation',to_jsonb(relation),
      'columns',(select jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attgenerated,a.attidentity) order by a.attnum)
        from pg_attribute a where a.attrelid=relation.oid and a.attnum>0 and not a.attisdropped),
      'constraints',(select jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid)) order by c.conname)
        from pg_constraint c where c.conrelid=relation.oid),
      'triggers',(select jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid),encode(sha256(convert_to(pg_get_functiondef(t.tgfoid),'UTF8')),'hex')) order by t.tgname)
        from pg_trigger t where t.tgrelid=relation.oid)) into definition_value;
    row_expression := 'row_value'; row_filter := '';
    if relation.qualified_name in ('auth.users','public.member_profiles') then
      row_filter := ' where not exists(select 1 from pg_temp.cleanup_rehearsal_deletable permitted where permitted.id=row_value.id)';
    elsif relation.qualified_name='auth.identities' then
      row_filter := ' where not exists(select 1 from pg_temp.cleanup_rehearsal_deletable permitted where permitted.id=row_value.user_id)';
    elsif relation.qualified_name='private.uniondemo_runs' and ${runTransition} then
      row_expression := 'case when row_value.id=''${runId}''::uuid then to_jsonb(row_value)-array[''state'',''updated_at'',''removed_at''] else to_jsonb(row_value) end';
    end if;
    execute format('select count(*),sha256(coalesce(string_agg(row_hash,''''::bytea order by row_hash),''''::bytea)) from (select sha256(convert_to((%s)::text,''UTF8'')) as row_hash from %s row_value%s) rows_digest',
      row_expression,relation.qualified_name,row_filter) into content_count,content_digest;
    insert into pg_temp.cleanup_rehearsal_content values(p_phase,relation.oid,relation.qualified_name,
      sha256(convert_to(definition_value::text,'UTF8')),content_count,content_digest);
  end loop;
end;
$capture$;
select pg_temp.cleanup_rehearsal_capture('before');
`,
    after: `
-- Newly introduced foreign relations are excluded from local row-store scans.
-- Refuse them again after the RPC instead of silently omitting their content.
select pg_temp.cleanup_rehearsal_content_preflight();
select pg_temp.cleanup_rehearsal_capture('after');
do $content_assertion$
begin
  if exists(
    select 1 from (select * from pg_temp.cleanup_rehearsal_content where phase='before') prior
    full join (select * from pg_temp.cleanup_rehearsal_content where phase='after') subsequent using(relation_oid)
    where prior.relation_oid is null or subsequent.relation_oid is null
      or prior.relation_name is distinct from subsequent.relation_name
      or prior.definition_hash is distinct from subsequent.definition_hash
      or prior.row_count is distinct from subsequent.row_count
      or prior.content_hash is distinct from subsequent.content_hash
  ) or exists(
    select 1 from pg_temp.cleanup_rehearsal_deletable permitted
    left join auth.users u on u.id=permitted.id
    left join public.member_profiles profile on profile.id=permitted.id
    where (u.id is not null and sha256(convert_to(u::text,'UTF8')) is distinct from permitted.auth_hash)
      or (profile.id is not null and sha256(convert_to(profile::text,'UTF8')) is distinct from permitted.profile_hash)
      or (u.id is not null and permitted.profile_present and profile.id is null)
      or (u.id is null and profile.id is not null)
  ) or exists(
    select 1 from pg_temp.cleanup_rehearsal_deletable_identities permitted
    left join auth.users u on u.id=permitted.user_id
    where (u.id is null and exists(select 1 from auth.identities identity_row where identity_row.user_id=permitted.user_id))
      or (u.id is not null and (
        (select count(*) from auth.identities identity_row where identity_row.user_id=permitted.user_id) is distinct from permitted.row_count
        or (select sha256(coalesce(string_agg(row_hash,''::bytea order by row_hash),''::bytea))
          from (select sha256(convert_to(identity_row::text,'UTF8')) as row_hash
            from auth.identities identity_row where identity_row.user_id=permitted.user_id) identity_rows) is distinct from permitted.content_hash
      ))
  ) then
    raise exception 'unproven protected-content or catalog mutation; rehearsal refused' using errcode='55000';
  end if;
end;
$content_assertion$;
drop function pg_temp.cleanup_rehearsal_capture(text);
drop function pg_temp.cleanup_rehearsal_content_preflight();
`,
  };
}
