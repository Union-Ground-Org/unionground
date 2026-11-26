-- UX-UG-A-NON-APPROVER-AUTHOR-CAN-NEVER-SAVE-A-DRAFT-V3-REQUIRES-THEM-20260921
--
-- The guided builder scopes every staff draft to a chapter or a single source
-- record. The scope picker behind it still opened with the operator
-- (admin/vp) gate, so a steward could answer the builder's chapter question
-- but never fill it. Open the same picker to the wider v3 authorship gate.
-- Chapters stay behind the caller's staff-role predicate. People keep the
-- original "this person is staff of their chapter" check and also require
-- the caller staffs that chapter, so a steward listing with p_chapter_id
-- null cannot receive IDs or names for staff of chapters they do not staff.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.mi1_get_automation_scope_options(p_source text,p_chapter_id text default null,p_search text default '',p_page integer default 1,p_page_size integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org uuid:=private.automation_v3_require_author(); chapters jsonb; people jsonb; chapter_total integer; people_total integer;
begin
 perform private.automation_v2_page_guard(p_page,p_page_size);
 if p_source is null or p_source not in ('task','case','appointment','event') or p_search is null or length(p_search)>80 then raise exception 'invalid scope filter' using errcode='22023'; end if;
 if p_chapter_id is not null and not exists(select 1 from public.chapters where id=p_chapter_id and organization_id=org and private.actor_has_chapter_staff_role(auth.uid(),id)) then raise exception 'chapter unavailable' using errcode='42501'; end if;
 select count(*) into chapter_total from public.chapters where organization_id=org and private.actor_has_chapter_staff_role(auth.uid(),id) and position(lower(p_search) in lower(name))>0;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'label',x.name) order by x.name,x.id),'[]'::jsonb) into chapters from (select id,name from public.chapters where organization_id=org and private.actor_has_chapter_staff_role(auth.uid(),id) and position(lower(p_search) in lower(name))>0 order by name,id limit p_page_size offset (p_page-1)*p_page_size) x;
 select count(*) into people_total from public.member_profiles p join public.chapters ch on ch.id=p.chapter_id
 join public.organization_memberships m on m.user_id=p.id and m.organization_id=ch.organization_id and m.status='active'
 where ch.organization_id=org and (p_chapter_id is null or ch.id=p_chapter_id) and private.actor_has_chapter_staff_role(auth.uid(),ch.id) and private.actor_has_chapter_staff_role(p.id,ch.id) and position(lower(p_search) in lower(p.full_name))>0;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'label',x.full_name) order by x.full_name,x.id),'[]'::jsonb) into people from (
 select p.id,p.full_name from public.member_profiles p join public.chapters ch on ch.id=p.chapter_id
 join public.organization_memberships m on m.user_id=p.id and m.organization_id=ch.organization_id and m.status='active'
 where ch.organization_id=org and (p_chapter_id is null or ch.id=p_chapter_id) and private.actor_has_chapter_staff_role(auth.uid(),ch.id) and private.actor_has_chapter_staff_role(p.id,ch.id) and position(lower(p_search) in lower(p.full_name))>0
 order by p.full_name,p.id limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('organizationId',org,'chapters',jsonb_build_object('rows',chapters,'total',chapter_total,'page',p_page,'pageSize',p_page_size),'assignees',jsonb_build_object('rows',people,'total',people_total,'page',p_page,'pageSize',p_page_size),'recipients',jsonb_build_object('rows',people,'total',people_total,'page',p_page,'pageSize',p_page_size)); end; $$;

commit;
