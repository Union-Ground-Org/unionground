-- #4993: repair activation prerequisites and publish the optional-feed notice.
-- No follows, publisher grants, tenants or hosted content are created.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- A revoked consent has a different concurrency token from its active state.
-- The physical generation remains unchanged for immutable delivery FK parents.
create or replace function public.get_platform_announcement_follow_settings()
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare org uuid:=private.platform_announcement_context(false,true,true); f private.platform_organization_follows;
begin
 select * into f from private.platform_organization_follows where organization_id=org order by generation desc limit 1;
 return jsonb_build_object('enabled',f.organization_id is not null and f.revoked_at is null,
  'generation',coalesce(f.generation*2-case when f.revoked_at is null then 1 else 0 end,0),'consentVersion','platform-updates-v1',
  'platformOrganizationId',case when f.revoked_at is null then f.platform_organization_id end);
end;
$function$;

create or replace function public.set_platform_announcement_follow(p_enabled boolean,p_expected_generation bigint,p_consent_version text)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; platform uuid; f private.platform_organization_follows;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 if p_enabled is null or p_expected_generation is null or p_expected_generation<0 then raise exception 'invalid platform update control' using errcode='22023'; end if;
 org:=private.platform_announcement_context(false,true,not p_enabled);
 select * into f from private.platform_organization_follows where organization_id=org order by generation desc limit 1 for update;
 if p_expected_generation<>coalesce(f.generation*2-case when f.revoked_at is null then 1 else 0 end,0) then raise exception 'platform update generation changed' using errcode='40001'; end if;
 if p_enabled then
  if p_consent_version is distinct from 'platform-updates-v1' then raise exception 'invalid platform update consent' using errcode='22023'; end if;
  platform:=private.platform_announcement_platform(false);
  if platform is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
  if f.organization_id is not null and f.revoked_at is null then return public.get_platform_announcement_follow_settings(); end if;
  insert into private.platform_organization_follows(organization_id,platform_organization_id,generation,consent_version)
   values(org,platform,coalesce(f.generation,0)+1,p_consent_version) returning * into f;
 else
  if f.organization_id is null or f.revoked_at is not null then return public.get_platform_announcement_follow_settings(); end if;
  update private.platform_organization_follows set revoked_at=clock_timestamp()
   where organization_id=org and generation=f.generation;
 end if;
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,generation)
  values(org,auth.uid(),case when p_enabled then 'follow' else 'revoke' end,f.generation);
 return public.get_platform_announcement_follow_settings();
end;
$function$;

create or replace function public.publish_platform_announcement(p_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; a private.platform_announcements; predecessor private.platform_announcements;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);org:=private.platform_announcement_context(true);
 select * into a from private.platform_announcements where id=p_id and organization_id=org for update;
 if a.id is null then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if a.revision is distinct from p_expected_revision or a.state<>'reviewed' or a.expires_at<=clock_timestamp() then raise exception 'platform update revision changed' using errcode='40001'; end if;
 -- Both the post and its predecessor are revalidated under the graph lock.
 if a.supersedes_id is not null then
  select * into predecessor from private.platform_announcements
   where id=a.supersedes_id and organization_id=org for update;
  if predecessor.id is null or predecessor.state<>'published' or predecessor.expires_at<=clock_timestamp() then
   raise exception 'platform update revision changed' using errcode='40001';
  end if;
 end if;
 update private.platform_announcements set state='published',published_at=clock_timestamp() where id=a.id;
 if a.supersedes_id is not null then
  update private.platform_announcements set state='withdrawn' where id=a.supersedes_id and organization_id=org and state='published';
  insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance)
   select org,auth.uid(),'withdraw',id,revision,'aal2' from private.platform_announcements where id=a.supersedes_id and organization_id=org;
 end if;
 insert into private.platform_announcement_delivery_jobs(organization_id,announcement_id,revision) values(org,a.id,a.revision);
 insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance) values(org,auth.uid(),'publish',a.id,a.revision,'aal2');
 return jsonb_build_object('id',a.id,'revision',a.revision,'state','published');
end;
$function$;

create or replace function public.dispatch_platform_announcements(p_batch_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare j private.platform_announcement_delivery_jobs; a private.platform_announcements; f private.platform_organization_follows; scanned integer; delivered integer; inserted integer;
begin
 perform private.lock_case_graph(array[]::uuid[],array[]::uuid[]);
 scanned:=0; delivered:=0;
 if coalesce(current_setting('role',true),'')<>'service_role' then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 if p_batch_limit is null or p_batch_limit not between 1 and 100 then raise exception 'invalid delivery bound' using errcode='22023'; end if;
 select * into j from private.platform_announcement_delivery_jobs where state='pending' order by announcement_id,revision limit 1 for update skip locked;
 if j.announcement_id is null then return jsonb_build_object('state','idle'); end if;
 select * into a from private.platform_announcements where id=j.announcement_id and revision=j.revision;
 if a.state<>'published' or a.expires_at<=now() or a.organization_id is distinct from private.platform_announcement_platform(false) then
  update private.platform_announcement_delivery_jobs set state='complete' where announcement_id=j.announcement_id and revision=j.revision;
  return jsonb_build_object('state','complete');
 end if;
 begin
  for f in select * from private.platform_organization_follows
   where platform_organization_id=a.organization_id and revoked_at is null and followed_at<=a.published_at
    and (j.cursor_organization_id is null or organization_id>j.cursor_organization_id)
   order by organization_id limit p_batch_limit for update loop
   scanned:=scanned+1;
   if private.organization_clears_signup_boundary(f.organization_id) and exists(select 1 from public.organizations where id=f.organization_id and kind='union' and status='active') then
    insert into private.organization_platform_announcements(organization_id,platform_organization_id,announcement_id,revision,generation,title_en,title_es,body_en,body_es,published_at,expires_at)
     values(f.organization_id,a.organization_id,a.id,a.revision,f.generation,a.title_en,a.title_es,a.body_en,a.body_es,a.published_at,a.expires_at)
     on conflict(organization_id,announcement_id,revision,generation) do nothing;
    get diagnostics inserted=row_count;
    delivered:=delivered+inserted;
   end if;
   j.cursor_organization_id:=f.organization_id;
  end loop;
  update private.platform_announcement_delivery_jobs set cursor_organization_id=j.cursor_organization_id,
   state=case when scanned<p_batch_limit then 'complete' else 'pending' end,failures=0
   where announcement_id=j.announcement_id and revision=j.revision;
 exception when others then
  update private.platform_announcement_delivery_jobs set failures=least(failures+1,5),
   state=case when failures>=4 then 'failed' else 'pending' end where announcement_id=j.announcement_id and revision=j.revision;
  return jsonb_build_object('state',case when j.failures>=4 then 'failed' else 'retry' end);
 end;
 return jsonb_build_object('state',case when scanned<p_batch_limit then 'complete' else 'pending' end,'scanned',scanned,'delivered',delivered);
end;
$function$;

alter table private.platform_announcements add constraint platform_announcements_raw_content_bounds
 check (char_length(title_en)<=120 and char_length(title_es)<=120
  and char_length(body_en)<=4000 and char_length(body_es)<=4000);

-- Refuse an unknown predecessor legal pack rather than overwrite newer terms.
do $previous_pack$
begin
 if not exists(select 1 from pg_catalog.pg_proc p
  where p.oid=pg_catalog.to_regprocedure('private.legal_acceptance_versions(jsonb)')
   and pg_catalog.md5(p.prosrc)='efb5820bffd329e70ea27f3de07b472e' and not p.prosecdef and p.provolatile='i') then
  raise exception 'privacy 1.3.0 requires the reviewed privacy 1.2.1 validator' using errcode='55000';
 end if;
end;
$previous_pack$;
create or replace function private.legal_acceptance_versions(p_versions jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  entry record;
begin
  if p_versions is null
    or pg_catalog.jsonb_typeof(p_versions) <> 'object'
    or p_versions = '{}'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_versions)) > 32
  then
    raise exception 'legal versions required' using errcode = '22023';
  end if;
  for entry in select key, value from pg_catalog.jsonb_each_text(p_versions) loop
    if entry.key !~ '^[a-z][a-z0-9-]{1,62}$'
      or entry.value !~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'
    then
      raise exception 'legal versions malformed' using errcode = '22023';
    end if;
  end loop;
  if p_versions ->> 'terms-of-use' is null then
    raise exception 'terms version required' using errcode = '22023';
  end if;
  -- published-legal-versions: generated from currentLegalVersions(); the
  -- regression test pins this database authority to the rendered pack.
  if p_versions <> '{"privacy-policy":"1.3.0","terms-of-use":"1.1.0","accessibility-statement":"1.0.0","ai-disclosure":"1.1.0","retention-schedule":"1.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;
revoke all on function private.legal_acceptance_versions(jsonb) from public,anon,authenticated,service_role;
-- Bind a delayed consumer request to the workspace it was created for. A
-- caller-supplied ID never selects authority; the live server context must match.
create function public.platform_announcement_request(p_organization_id uuid,p_action text,p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare org uuid; platform_action boolean; containment boolean; admin_action boolean;
begin
 perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
 if p_action is null or p_args is null or jsonb_typeof(p_args)<>'object' then
  raise exception 'platform updates unavailable' using errcode='42501';
 end if;
 platform_action:=p_action in ('get_platform_announcement_publisher_workspace','list_platform_follow_status',
  'save_platform_announcement_draft','review_platform_announcement','publish_platform_announcement','withdraw_platform_announcement');
 containment:=p_action in ('get_platform_announcement_follow_settings','get_platform_announcement_publisher_workspace','list_platform_follow_status','withdraw_platform_announcement','set_my_platform_announcement_preference','hide_organization_platform_announcement')
  or (p_action='set_platform_announcement_follow' and not coalesce((p_args->>'p_enabled')::boolean,true));
 admin_action:=p_action in ('get_platform_announcement_follow_settings','set_platform_announcement_follow','hide_organization_platform_announcement');
 org:=private.platform_announcement_context(platform_action,admin_action,containment);
 if org is distinct from p_organization_id then raise exception 'platform updates unavailable' using errcode='42501'; end if;
 case p_action
 when 'list_my_platform_announcements' then return public.list_my_platform_announcements(p_args->>'p_locale',(p_args->>'p_before')::timestamptz,(p_args->>'p_before_id')::uuid,coalesce((p_args->>'p_limit')::integer,20));
 when 'get_platform_announcement_follow_settings' then return public.get_platform_announcement_follow_settings();
 when 'set_platform_announcement_follow' then return public.set_platform_announcement_follow((p_args->>'p_enabled')::boolean,(p_args->>'p_expected_generation')::bigint,p_args->>'p_consent_version');
 when 'set_my_platform_announcement_preference' then return public.set_my_platform_announcement_preference((p_args->>'p_hidden')::boolean);
 when 'get_platform_announcement_publisher_workspace' then return public.get_platform_announcement_publisher_workspace(coalesce((p_args->>'p_limit')::integer,20),(p_args->>'p_after_id')::uuid,(p_args->>'p_audit_before')::bigint);
 when 'list_platform_follow_status' then return public.list_platform_follow_status((p_args->>'p_after')::uuid,coalesce((p_args->>'p_limit')::integer,20));
 when 'save_platform_announcement_draft' then return public.save_platform_announcement_draft((p_args->>'p_id')::uuid,(p_args->>'p_expected_revision')::integer,p_args->>'p_title_en',p_args->>'p_title_es',p_args->>'p_body_en',p_args->>'p_body_es',(p_args->>'p_expires_at')::timestamptz,(p_args->>'p_supersedes_id')::uuid);
 when 'review_platform_announcement' then return public.review_platform_announcement((p_args->>'p_id')::uuid,(p_args->>'p_expected_revision')::integer);
 when 'publish_platform_announcement' then return public.publish_platform_announcement((p_args->>'p_id')::uuid,(p_args->>'p_expected_revision')::integer);
 when 'withdraw_platform_announcement' then return public.withdraw_platform_announcement((p_args->>'p_id')::uuid,(p_args->>'p_expected_revision')::integer);
 when 'hide_organization_platform_announcement' then perform public.hide_organization_platform_announcement((p_args->>'p_id')::uuid);return '{}'::jsonb;
 else raise exception 'platform updates unavailable' using errcode='42501';
 end case;
end;
$function$;
revoke all on function public.platform_announcement_request(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.platform_announcement_request(uuid,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
