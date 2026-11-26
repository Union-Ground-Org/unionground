-- REQ-UG-SPECIALIZED-TASK-TEMPLATES-20260812
--
-- Specialized templates remain ordinary chapter tasks. The private catalog
-- owns their fields, defaults, checklists, and subflows; the public detail row
-- inherits the task's chapter boundary and is writable only through the
-- validated RPCs below. Protected case/member/document content stays in the
-- existing authorized-link surfaces rather than this metadata.

set local lock_timeout = '5s';

-- A. Server-owned normalized catalog --------------------------------------

create table private.chapter_task_template_catalog (
  template_key text primary key,
  label_en text not null,
  label_es text not null,
  description_en text not null,
  description_es text not null,
  default_status text not null,
  default_priority text not null,
  notification_copy_key text not null,
  sort_order smallint not null unique,
  active boolean not null default true,
  constraint chapter_task_template_catalog_key_check check (template_key in (
    'meeting_event', 'review_approval', 'member_follow_up',
    'document_request', 'issue_incident'
  )),
  constraint chapter_task_template_catalog_status_check check (default_status in (
    'backlog', 'to_do', 'in_progress', 'needs_review', 'done'
  )),
  constraint chapter_task_template_catalog_priority_check check (default_priority in (
    'low', 'medium', 'high'
  )),
  constraint chapter_task_template_catalog_copy_key_check
    check (notification_copy_key = 'task.template.created'),
  constraint chapter_task_template_catalog_text_bounded check (
    char_length(label_en) between 1 and 80
    and char_length(label_es) between 1 and 80
    and char_length(description_en) between 1 and 240
    and char_length(description_es) between 1 and 240
  )
);

create table private.chapter_task_template_fields (
  template_key text not null references private.chapter_task_template_catalog(template_key) on delete cascade,
  field_key text not null,
  field_kind text not null,
  required boolean not null default false,
  label_en text not null,
  label_es text not null,
  help_en text not null default '',
  help_es text not null default '',
  option_keys text[] not null default '{}',
  position smallint not null,
  primary key (template_key, field_key),
  constraint chapter_task_template_fields_position_key unique (template_key, position),
  constraint chapter_task_template_fields_kind_check
    check (field_kind in ('date', 'time', 'enum', 'member')),
  constraint chapter_task_template_fields_options_check check (
    (field_kind = 'enum' and cardinality(option_keys) > 0)
    or (field_kind <> 'enum' and cardinality(option_keys) = 0)
  ),
  constraint chapter_task_template_fields_text_bounded check (
    field_key ~ '^[a-z][a-z0-9_]{0,39}$'
    and char_length(label_en) between 1 and 80
    and char_length(label_es) between 1 and 80
    and char_length(help_en) <= 240
    and char_length(help_es) <= 240
  )
);

create table private.chapter_task_template_flow_steps (
  template_key text not null references private.chapter_task_template_catalog(template_key) on delete cascade,
  step_key text not null,
  label_en text not null,
  label_es text not null,
  predecessor_keys text[] not null default '{}',
  recommended_status text not null,
  position smallint not null,
  terminal boolean not null default false,
  primary key (template_key, step_key),
  constraint chapter_task_template_flow_position_key unique (template_key, position),
  constraint chapter_task_template_flow_status_check check (recommended_status in (
    'backlog', 'to_do', 'in_progress', 'needs_review', 'done'
  )),
  constraint chapter_task_template_flow_text_bounded check (
    step_key ~ '^[a-z][a-z0-9_]{0,39}$'
    and char_length(label_en) between 1 and 80
    and char_length(label_es) between 1 and 80
  )
);

create table private.chapter_task_template_checklist_items (
  template_key text not null references private.chapter_task_template_catalog(template_key) on delete cascade,
  position smallint not null,
  label_en text not null,
  label_es text not null,
  constraint chapter_task_template_checklist_position_key primary key (template_key, position),
  constraint chapter_task_template_checklist_text_bounded check (
    char_length(label_en) between 1 and 160
    and char_length(label_es) between 1 and 160
  )
);

revoke all on table private.chapter_task_template_catalog from public, anon, authenticated;
revoke all on table private.chapter_task_template_fields from public, anon, authenticated;
revoke all on table private.chapter_task_template_flow_steps from public, anon, authenticated;
revoke all on table private.chapter_task_template_checklist_items from public, anon, authenticated;
revoke all on table private.chapter_task_template_catalog from service_role;
revoke all on table private.chapter_task_template_fields from service_role;
revoke all on table private.chapter_task_template_flow_steps from service_role;
revoke all on table private.chapter_task_template_checklist_items from service_role;

insert into private.chapter_task_template_catalog (
  template_key, label_en, label_es, description_en, description_es,
  default_status, default_priority, notification_copy_key, sort_order
) values
  ('meeting_event', 'Meeting or Event', 'Reunión o evento',
   'Plan a chapter meeting or event without storing venue or participant details.',
   'Planifica una reunión o evento del capítulo sin guardar detalles del lugar ni de participantes.',
   'to_do', 'medium', 'task.template.created', 10),
  ('review_approval', 'Review or Approval', 'Revisión o aprobación',
   'Route an authorized record for review and record only its operational stage.',
   'Envía un registro autorizado a revisión y guarda solo su etapa operativa.',
   'needs_review', 'medium', 'task.template.created', 20),
  ('member_follow_up', 'Member Follow-up', 'Seguimiento de miembro',
   'Schedule a follow-up while keeping member identity in its authorized source.',
   'Programa un seguimiento y conserva la identidad del miembro en su fuente autorizada.',
   'to_do', 'medium', 'task.template.created', 30),
  ('document_request', 'Document Request', 'Solicitud de documento',
   'Track a request while keeping document content in an authorized record.',
   'Da seguimiento a una solicitud y conserva el contenido en un registro autorizado.',
   'to_do', 'medium', 'task.template.created', 40),
  ('issue_incident', 'Issue or Incident', 'Problema o incidente',
   'Coordinate an operational response without copying an incident narrative.',
   'Coordina una respuesta operativa sin copiar la narración del incidente.',
   'to_do', 'high', 'task.template.created', 50);

insert into private.chapter_task_template_fields (
  template_key, field_key, field_kind, required, label_en, label_es,
  help_en, help_es, option_keys, position
) values
  ('meeting_event', 'scheduled_on', 'date', true, 'Scheduled date', 'Fecha programada', '', '', '{}', 10),
  ('meeting_event', 'starts_at', 'time', false, 'Start time', 'Hora de inicio', 'Use the chapter local time.', 'Usa la hora local del capítulo.', '{}', 20),
  ('meeting_event', 'ends_at', 'time', false, 'End time', 'Hora de finalización', 'Must be after the start time.', 'Debe ser posterior a la hora de inicio.', '{}', 30),
  ('meeting_event', 'venue_mode', 'enum', true, 'Venue mode', 'Modalidad', 'Keep exact venue and joining details in an authorized link.', 'Guarda el lugar exacto y los datos de acceso en un enlace autorizado.', array['in_person','phone','video','hybrid'], 40),
  ('review_approval', 'review_kind', 'enum', true, 'Review kind', 'Tipo de revisión', '', '', array['document','publication','decision','other'], 10),
  ('review_approval', 'reviewer_id', 'member', false, 'Reviewer', 'Persona revisora', 'Optional same-chapter staff reviewer.', 'Personal revisor opcional del mismo capítulo.', '{}', 20),
  ('member_follow_up', 'contact_method', 'enum', true, 'Contact method', 'Método de contacto', '', '', array['phone','email','in_person','message','other'], 10),
  ('member_follow_up', 'follow_up_on', 'date', true, 'Follow-up date', 'Fecha de seguimiento', '', '', '{}', 20),
  ('document_request', 'record_category', 'enum', true, 'Record category', 'Categoría del registro', '', '', array['workplace_record','policy','correspondence','other'], 10),
  ('document_request', 'record_source', 'enum', true, 'Record source', 'Fuente del registro', '', '', array['member','employer','union','third_party'], 20),
  ('issue_incident', 'occurred_on', 'date', true, 'Occurrence date', 'Fecha del incidente', '', '', '{}', 10),
  ('issue_incident', 'incident_severity', 'enum', true, 'Operational severity', 'Gravedad operativa', 'Do not enter an incident narrative here.', 'No escribas aquí una narración del incidente.', array['low','medium','high','urgent'], 20);

insert into private.chapter_task_template_flow_steps (
  template_key, step_key, label_en, label_es, predecessor_keys,
  recommended_status, position, terminal
) values
  ('meeting_event', 'planning', 'Planning', 'Planificación', '{}', 'to_do', 10, false),
  ('meeting_event', 'confirmed', 'Confirmed', 'Confirmado', array['planning'], 'to_do', 20, false),
  ('meeting_event', 'held', 'Held', 'Realizado', array['confirmed'], 'in_progress', 30, false),
  ('meeting_event', 'follow_up', 'Follow-up', 'Seguimiento', array['held'], 'needs_review', 40, false),
  ('meeting_event', 'complete', 'Complete', 'Completo', array['follow_up'], 'done', 50, true),
  ('review_approval', 'prepare', 'Prepare', 'Preparar', '{}', 'to_do', 10, false),
  ('review_approval', 'in_review', 'In review', 'En revisión', array['prepare','changes_requested'], 'needs_review', 20, false),
  ('review_approval', 'changes_requested', 'Changes requested', 'Cambios solicitados', array['in_review'], 'in_progress', 30, false),
  ('review_approval', 'approved', 'Approved', 'Aprobado', array['in_review','changes_requested'], 'done', 40, true),
  ('review_approval', 'declined', 'Declined', 'Rechazado', array['in_review','changes_requested'], 'done', 50, true),
  ('member_follow_up', 'prepare', 'Prepare', 'Preparar', '{}', 'to_do', 10, false),
  ('member_follow_up', 'contact', 'Contact', 'Contactar', array['prepare'], 'in_progress', 20, false),
  ('member_follow_up', 'await_response', 'Await response', 'Esperar respuesta', array['contact'], 'in_progress', 30, false),
  ('member_follow_up', 'resolve', 'Resolve', 'Resolver', array['await_response'], 'done', 40, true),
  ('document_request', 'prepare', 'Prepare', 'Preparar', '{}', 'to_do', 10, false),
  ('document_request', 'requested', 'Requested', 'Solicitado', array['prepare'], 'in_progress', 20, false),
  ('document_request', 'acknowledged', 'Acknowledged', 'Acusado', array['requested'], 'in_progress', 30, false),
  ('document_request', 'received', 'Received', 'Recibido', array['acknowledged'], 'needs_review', 40, false),
  ('document_request', 'unavailable', 'Unavailable', 'No disponible', array['acknowledged'], 'needs_review', 50, false),
  ('document_request', 'complete', 'Complete', 'Completo', array['received','unavailable'], 'done', 60, true),
  ('issue_incident', 'triage', 'Triage', 'Evaluar', '{}', 'to_do', 10, false),
  ('issue_incident', 'act', 'Act', 'Actuar', array['triage'], 'in_progress', 20, false),
  ('issue_incident', 'monitor', 'Monitor', 'Monitorear', array['act'], 'needs_review', 30, false),
  ('issue_incident', 'resolve', 'Resolve', 'Resolver', array['monitor'], 'done', 40, true);

insert into private.chapter_task_template_checklist_items (
  template_key, position, label_en, label_es
) values
  ('meeting_event', 10, 'Confirm time and mode', 'Confirmar hora y modalidad'),
  ('meeting_event', 20, 'Prepare the agenda', 'Preparar la agenda'),
  ('meeting_event', 30, 'Notify participants through an authorized channel', 'Notificar a participantes por un canal autorizado'),
  ('meeting_event', 40, 'Record follow-up work', 'Registrar el trabajo de seguimiento'),
  ('review_approval', 10, 'Gather authorized materials', 'Reunir materiales autorizados'),
  ('review_approval', 20, 'Route the review', 'Enviar a revisión'),
  ('review_approval', 30, 'Record the decision in the authorized source', 'Registrar la decisión en la fuente autorizada'),
  ('review_approval', 40, 'Communicate the outcome', 'Comunicar el resultado'),
  ('member_follow_up', 10, 'Contact the member through an authorized channel', 'Contactar al miembro por un canal autorizado'),
  ('member_follow_up', 20, 'Record the outcome in the authorized source', 'Registrar el resultado en la fuente autorizada'),
  ('member_follow_up', 30, 'Schedule the next step if needed', 'Programar el próximo paso si es necesario'),
  ('document_request', 10, 'Define the request in the authorized source', 'Definir la solicitud en la fuente autorizada'),
  ('document_request', 20, 'Send the request', 'Enviar la solicitud'),
  ('document_request', 30, 'Record the receipt or unavailable response', 'Registrar la recepción o respuesta no disponible'),
  ('document_request', 40, 'Link the authorized record', 'Enlazar el registro autorizado'),
  ('issue_incident', 10, 'Address immediate safety', 'Atender la seguridad inmediata'),
  ('issue_incident', 20, 'Document the issue in the authorized source', 'Documentar el problema en la fuente autorizada'),
  ('issue_incident', 30, 'Assign the response', 'Asignar la respuesta'),
  ('issue_incident', 40, 'Follow up and record resolution', 'Dar seguimiento y registrar la resolución');

-- B. Typed detail rows with inherited board access ------------------------

create table public.chapter_task_template_details (
  task_id uuid primary key references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  template_key text not null references private.chapter_task_template_catalog(template_key) on delete restrict,
  flow_step text not null,
  scheduled_on date,
  starts_at time,
  ends_at time,
  venue_mode text,
  review_kind text,
  reviewer_id uuid references auth.users(id) on delete set null,
  contact_method text,
  follow_up_on date,
  record_category text,
  record_source text,
  occurred_on date,
  incident_severity text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (template_key, flow_step)
    references private.chapter_task_template_flow_steps(template_key, step_key) on delete restrict,
  constraint chapter_task_template_details_time_order check (
    ends_at is null or (starts_at is not null and ends_at > starts_at)
  ),
  constraint chapter_task_template_details_type_shape check (
    (template_key = 'meeting_event'
      and scheduled_on is not null and venue_mode in ('in_person','phone','video','hybrid')
      and review_kind is null and reviewer_id is null and contact_method is null
      and follow_up_on is null and record_category is null and record_source is null
      and occurred_on is null and incident_severity is null)
    or
    (template_key = 'review_approval'
      and review_kind in ('document','publication','decision','other')
      and scheduled_on is null and starts_at is null and ends_at is null and venue_mode is null
      and contact_method is null and follow_up_on is null and record_category is null
      and record_source is null and occurred_on is null and incident_severity is null)
    or
    (template_key = 'member_follow_up'
      and contact_method in ('phone','email','in_person','message','other')
      and follow_up_on is not null and scheduled_on is null and starts_at is null
      and ends_at is null and venue_mode is null and review_kind is null and reviewer_id is null
      and record_category is null and record_source is null and occurred_on is null
      and incident_severity is null)
    or
    (template_key = 'document_request'
      and record_category in ('workplace_record','policy','correspondence','other')
      and record_source in ('member','employer','union','third_party')
      and scheduled_on is null and starts_at is null and ends_at is null and venue_mode is null
      and review_kind is null and reviewer_id is null and contact_method is null
      and follow_up_on is null and occurred_on is null and incident_severity is null)
    or
    (template_key = 'issue_incident'
      and occurred_on is not null and incident_severity in ('low','medium','high','urgent')
      and scheduled_on is null and starts_at is null and ends_at is null and venue_mode is null
      and review_kind is null and reviewer_id is null and contact_method is null
      and follow_up_on is null and record_category is null and record_source is null)
  )
);

create index chapter_task_template_details_chapter_idx
  on public.chapter_task_template_details (chapter_id, template_key, flow_step);
create index chapter_task_template_details_reviewer_idx
  on public.chapter_task_template_details (reviewer_id) where reviewer_id is not null;

alter table public.chapter_task_template_details enable row level security;

create policy chapter_task_template_details_select_board
  on public.chapter_task_template_details
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.chapter_tasks t
      join public.member_profiles p
        on p.id = (select auth.uid())
       and p.chapter_id = chapter_task_template_details.chapter_id
      where t.id = chapter_task_template_details.task_id
        and t.chapter_id = chapter_task_template_details.chapter_id
        and t.deleted_at is null
    )
  );

create policy mfa_assurance on public.chapter_task_template_details
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_template_details from public, anon, authenticated;
grant select on table public.chapter_task_template_details to authenticated;

-- Bare specialized values would create an invalid half-template. Permit the
-- validated creator to set one through a transaction-local guard, and forbid
-- type conversions until an explicit conversion product flow exists.
create or replace function private.guard_chapter_task_template_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     and new.task_type <> 'general'
     and pg_catalog.current_setting('sg.creating_template_task', true) is distinct from '1' then
    raise exception 'specialized tasks require template creation' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.task_type is distinct from old.task_type
     and (old.task_type <> 'general' or new.task_type <> 'general') then
    raise exception 'specialized task conversion unavailable' using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function private.guard_chapter_task_template_type()
  from public, anon, authenticated, service_role;

create trigger chapter_tasks_guard_template_type
before insert or update of task_type on public.chapter_tasks
for each row execute function private.guard_chapter_task_template_type();

-- C. Generic notification copy and audience helper ------------------------

insert into private.notification_copy (key, lang, title, body) values
  ('task.template.created', 'en', 'A specialized task was created', 'Open Tasks to review the new work.'),
  ('task.template.created', 'es', 'Se creó una tarea especializada', 'Abre Tareas para revisar el nuevo trabajo.'),
  ('task.template.flow_changed', 'en', 'A task workflow changed', 'Open Tasks to review the current step.'),
  ('task.template.flow_changed', 'es', 'Cambió el flujo de una tarea', 'Abre Tareas para revisar el paso actual.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

create or replace function private.notify_chapter_task_template_change(
  p_task_id uuid,
  p_actor uuid,
  p_copy_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  scoped_chapter text;
  recipient uuid;
begin
  select t.chapter_id into scoped_chapter
  from public.chapter_tasks t
  where t.id = p_task_id and t.deleted_at is null;

  if scoped_chapter is null or p_copy_key not in (
    'task.template.created', 'task.template.flow_changed'
  ) then
    return;
  end if;

  for recipient in
    select distinct audience.user_id
    from (
      select a.assignee_id as user_id
      from public.chapter_task_assignments a
      where a.task_id = p_task_id and a.chapter_id = scoped_chapter
      union all
      select w.user_id
      from public.chapter_task_watchers w
      where w.task_id = p_task_id and w.chapter_id = scoped_chapter
    ) audience
    join public.member_profiles p
      on p.id = audience.user_id and p.chapter_id = scoped_chapter
    where audience.user_id is not null and audience.user_id <> p_actor
  loop
    perform private.notify_member(recipient, p_copy_key, '{}'::jsonb, 'tasks');
  end loop;
end
$$;

revoke all on function private.notify_chapter_task_template_change(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- D. Safe catalog read -----------------------------------------------------

create or replace function public.list_chapter_task_templates()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  authorized_role text;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select caller_profile.chapter_id
    into caller_chapter
  from public.member_profiles caller_profile
  where caller_profile.id = caller;

  select staff_role.role
    into authorized_role
  from public.member_roles staff_role
  where staff_role.user_id = caller
    and staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and (staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter)
  order by (staff_role.chapter_id = caller_chapter) desc, staff_role.role
  limit 1;

  if caller_chapter is null or authorized_role is null then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'key', c.template_key,
      'label', pg_catalog.jsonb_build_object('en', c.label_en, 'es', c.label_es),
      'description', pg_catalog.jsonb_build_object('en', c.description_en, 'es', c.description_es),
      'defaultStatus', c.default_status,
      'defaultPriority', c.default_priority,
      'fields', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'key', f.field_key,
          'kind', f.field_kind,
          'required', f.required,
          'label', pg_catalog.jsonb_build_object('en', f.label_en, 'es', f.label_es),
          'help', pg_catalog.jsonb_build_object('en', f.help_en, 'es', f.help_es),
          'options', f.option_keys
        ) order by f.position)
        from private.chapter_task_template_fields f
        where f.template_key = c.template_key
      ), '[]'::jsonb),
      'flow', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'key', s.step_key,
          'label', pg_catalog.jsonb_build_object('en', s.label_en, 'es', s.label_es),
          'predecessorKeys', s.predecessor_keys,
          'recommendedStatus', s.recommended_status,
          'terminal', s.terminal
        ) order by s.position)
        from private.chapter_task_template_flow_steps s
        where s.template_key = c.template_key
      ), '[]'::jsonb),
      'checklist', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'label', pg_catalog.jsonb_build_object('en', item.label_en, 'es', item.label_es)
        ) order by item.position)
        from private.chapter_task_template_checklist_items item
        where item.template_key = c.template_key
      ), '[]'::jsonb)
    ) order by c.sort_order
  ), '[]'::jsonb) into payload
  from private.chapter_task_template_catalog c
  where c.active;

  return payload;
end
$$;

revoke all on function public.list_chapter_task_templates() from public, anon, authenticated;
grant execute on function public.list_chapter_task_templates() to authenticated;
grant execute on function public.list_chapter_task_templates() to service_role;

create or replace function public.list_chapter_task_template_reviewers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  authorized_role text;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select caller_profile.chapter_id
    into caller_chapter
  from public.member_profiles caller_profile
  where caller_profile.id = caller;

  select staff_role.role
    into authorized_role
  from public.member_roles staff_role
  where staff_role.user_id = caller
    and staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and (staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter)
  order by (staff_role.chapter_id = caller_chapter) desc, staff_role.role
  limit 1;

  if caller_chapter is null or authorized_role is null then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('id', eligible.id, 'fullName', eligible.full_name)
    order by pg_catalog.lower(eligible.full_name), eligible.id
  ), '[]'::jsonb)
    into payload
  from (
    select distinct reviewer_profile.id, reviewer_profile.full_name
    from public.member_profiles reviewer_profile
    join public.member_roles reviewer_role
      on reviewer_role.user_id = reviewer_profile.id
     and reviewer_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
     and (reviewer_role.chapter_id is null or reviewer_role.chapter_id = caller_chapter)
    where reviewer_profile.chapter_id = caller_chapter
  ) eligible;

  return payload;
end
$$;

revoke all on function public.list_chapter_task_template_reviewers() from public, anon, authenticated;
grant execute on function public.list_chapter_task_template_reviewers() to authenticated;
grant execute on function public.list_chapter_task_template_reviewers() to service_role;

-- E. Atomic validated creation --------------------------------------------

create or replace function public.create_chapter_task_from_template(
  p_template_key text,
  p_title text,
  p_workstream text,
  p_fields jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  locked_caller_role text;
  locked_reviewer_role text;
  selected_template private.chapter_task_template_catalog%rowtype;
  initial_step private.chapter_task_template_flow_steps%rowtype;
  clean_workstream text;
  checklist_body text := '';
  scheduled_value date;
  start_value time;
  end_value time;
  venue_value text;
  review_value text;
  reviewer_value uuid;
  contact_value text;
  follow_up_value date;
  category_value text;
  source_value text;
  occurred_value date;
  severity_value text;
  task_start date;
  task_due date;
  inserted_task public.chapter_tasks%rowtype;
  inserted_detail public.chapter_task_template_details%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Preserve the organization policy that requires an enrolled, verified
  -- second factor before any staff grant is effective. The scoped row lock
  -- below is still required to keep that effective grant stable through the
  -- write; member_has_role is the policy gate, not a substitute for the lock.
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 160 then
    raise exception 'task title invalid' using errcode = '22023';
  end if;

  -- Hold the exact profile and one deterministic eligible staff grant through
  -- the write. FOR SHARE conflicts with both revoke's DELETE and any scope
  -- change to chapter_id, closing the authorization-check/write race.
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller
  for share of p;
  select staff_role.role into locked_caller_role
  from public.member_roles staff_role
  where staff_role.user_id = caller
    and staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and (staff_role.chapter_id is null or staff_role.chapter_id = caller_chapter)
  order by (staff_role.chapter_id = caller_chapter) desc, staff_role.role
  limit 1
  for share of staff_role;
  if caller_chapter is null or locked_caller_role is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select c.* into selected_template
  from private.chapter_task_template_catalog c
  where c.template_key = p_template_key and c.active;
  if selected_template.template_key is null then
    raise exception 'template unavailable' using errcode = '22023';
  end if;

  select w.name into clean_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
    and lower(w.name) = lower(btrim(coalesce(p_workstream, '')))
  order by w.id
  limit 1
  for share of w;
  if clean_workstream is null then
    raise exception 'workstream unavailable' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_fields) submitted(field_key)
       where not exists (
         select 1 from private.chapter_task_template_fields f
         where f.template_key = selected_template.template_key
           and f.field_key = submitted.field_key
       )
     )
     or exists (
       select 1 from private.chapter_task_template_fields f
       where f.template_key = selected_template.template_key and f.required
         and (not p_fields ? f.field_key or nullif(btrim(p_fields ->> f.field_key), '') is null)
     ) then
    raise exception 'template fields invalid' using errcode = '22023';
  end if;

  begin
    if selected_template.template_key = 'meeting_event' then
      if pg_catalog.jsonb_typeof(p_fields->'scheduled_on') <> 'string'
         or (p_fields->>'scheduled_on') !~ '^\d{4}-\d{2}-\d{2}$'
         or pg_catalog.jsonb_typeof(p_fields->'venue_mode') <> 'string' then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      scheduled_value := (p_fields->>'scheduled_on')::date;
      venue_value := p_fields->>'venue_mode';
      if venue_value not in ('in_person','phone','video','hybrid') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      if nullif(p_fields->>'starts_at', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'starts_at') <> 'string'
           or (p_fields->>'starts_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        start_value := (p_fields->>'starts_at')::time;
      end if;
      if nullif(p_fields->>'ends_at', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'ends_at') <> 'string'
           or (p_fields->>'ends_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        end_value := (p_fields->>'ends_at')::time;
      end if;
      if end_value is not null and (start_value is null or end_value <= start_value) then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      task_start := scheduled_value;
      task_due := scheduled_value;
    elsif selected_template.template_key = 'review_approval' then
      review_value := p_fields->>'review_kind';
      if pg_catalog.jsonb_typeof(p_fields->'review_kind') <> 'string'
         or review_value not in ('document','publication','decision','other') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      if nullif(p_fields->>'reviewer_id', '') is not null then
        if pg_catalog.jsonb_typeof(p_fields->'reviewer_id') <> 'string' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        reviewer_value := (p_fields->>'reviewer_id')::uuid;
        locked_reviewer_role := null;
        select reviewer_role.role into locked_reviewer_role
          from public.member_profiles p
          join public.member_roles reviewer_role
            on reviewer_role.user_id = p.id
           and reviewer_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (reviewer_role.chapter_id is null or reviewer_role.chapter_id = caller_chapter)
          where p.id = reviewer_value and p.chapter_id = caller_chapter
          order by (reviewer_role.chapter_id = caller_chapter) desc, reviewer_role.role
          limit 1
          for share of p, reviewer_role;
        if locked_reviewer_role is null then
          raise exception 'reviewer must belong to this chapter' using errcode = '22023';
        end if;
      end if;
    elsif selected_template.template_key = 'member_follow_up' then
      contact_value := p_fields->>'contact_method';
      if pg_catalog.jsonb_typeof(p_fields->'contact_method') <> 'string'
         or contact_value not in ('phone','email','in_person','message','other')
         or pg_catalog.jsonb_typeof(p_fields->'follow_up_on') <> 'string'
         or (p_fields->>'follow_up_on') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      follow_up_value := (p_fields->>'follow_up_on')::date;
      task_due := follow_up_value;
    elsif selected_template.template_key = 'document_request' then
      category_value := p_fields->>'record_category';
      source_value := p_fields->>'record_source';
      if pg_catalog.jsonb_typeof(p_fields->'record_category') <> 'string'
         or category_value not in ('workplace_record','policy','correspondence','other')
         or pg_catalog.jsonb_typeof(p_fields->'record_source') <> 'string'
         or source_value not in ('member','employer','union','third_party') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
    elsif selected_template.template_key = 'issue_incident' then
      severity_value := p_fields->>'incident_severity';
      if pg_catalog.jsonb_typeof(p_fields->'occurred_on') <> 'string'
         or (p_fields->>'occurred_on') !~ '^\d{4}-\d{2}-\d{2}$'
         or pg_catalog.jsonb_typeof(p_fields->'incident_severity') <> 'string'
         or severity_value not in ('low','medium','high','urgent') then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
      occurred_value := (p_fields->>'occurred_on')::date;
      task_start := occurred_value;
    end if;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception 'template fields invalid' using errcode = '22023';
  end;

  select s.* into initial_step
  from private.chapter_task_template_flow_steps s
  where s.template_key = selected_template.template_key
  order by s.position
  limit 1;

  select coalesce(pg_catalog.string_agg('- [ ] ' || item.label_en, E'\n' order by item.position), '')
    into checklist_body
  from private.chapter_task_template_checklist_items item
  where item.template_key = selected_template.template_key;

  perform pg_catalog.set_config('sg.creating_template_task', '1', true);
  insert into public.chapter_tasks (
    chapter_id, title, description, status, priority, workstream,
    assignee_name, start_date, due_date, task_type, created_by, updated_by
  ) values (
    caller_chapter, btrim(p_title), checklist_body, selected_template.default_status,
    selected_template.default_priority, clean_workstream, '', task_start, task_due,
    selected_template.template_key, caller, caller
  ) returning * into inserted_task;

  insert into public.chapter_task_template_details (
    task_id, chapter_id, template_key, flow_step,
    scheduled_on, starts_at, ends_at, venue_mode,
    review_kind, reviewer_id, contact_method, follow_up_on,
    record_category, record_source, occurred_on, incident_severity,
    created_by, updated_by
  ) values (
    inserted_task.id, inserted_task.chapter_id, selected_template.template_key, initial_step.step_key,
    scheduled_value, start_value, end_value, venue_value,
    review_value, reviewer_value, contact_value, follow_up_value,
    category_value, source_value, occurred_value, severity_value,
    caller, caller
  ) returning * into inserted_detail;

  perform private.notify_chapter_task_template_change(
    inserted_task.id, caller, selected_template.notification_copy_key
  );

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(inserted_task),
    'details', pg_catalog.to_jsonb(inserted_detail)
  );
end
$$;

revoke all on function public.create_chapter_task_from_template(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_chapter_task_from_template(text, text, text, jsonb)
  to authenticated;
grant execute on function public.create_chapter_task_from_template(text, text, text, jsonb)
  to service_role;

-- F. Validated detail and subflow updates ----------------------------------

create or replace function public.update_chapter_task_template_details(
  p_task_id uuid,
  p_fields jsonb,
  p_next_flow_step text,
  p_apply_recommended_status boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  locked_caller_role text;
  locked_reviewer_role text;
  task_row public.chapter_tasks%rowtype;
  detail_row public.chapter_task_template_details%rowtype;
  target_step private.chapter_task_template_flow_steps%rowtype;
  scheduled_value date;
  start_value time;
  end_value time;
  venue_value text;
  review_value text;
  reviewer_value uuid;
  contact_value text;
  follow_up_value date;
  category_value text;
  source_value text;
  occurred_value date;
  severity_value text;
  changed_flow boolean := false;
  old_flow_step text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller
  for share of p;
  select t.* into task_row
  from public.chapter_tasks t
  join public.chapter_task_template_details d on d.task_id = t.id and d.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
    and t.chapter_id = caller_chapter
  for update of t, d;
  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;
  select staff_role.role into locked_caller_role
  from public.member_roles staff_role
  where staff_role.user_id = caller
    and staff_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and (staff_role.chapter_id is null or staff_role.chapter_id = task_row.chapter_id)
  order by (staff_role.chapter_id = task_row.chapter_id) desc, staff_role.role
  limit 1
  for share of staff_role;
  if locked_caller_role is null then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select d.* into detail_row
  from public.chapter_task_template_details d
  where d.task_id = task_row.id;
  old_flow_step := detail_row.flow_step;

  scheduled_value := detail_row.scheduled_on;
  start_value := detail_row.starts_at;
  end_value := detail_row.ends_at;
  venue_value := detail_row.venue_mode;
  review_value := detail_row.review_kind;
  reviewer_value := detail_row.reviewer_id;
  contact_value := detail_row.contact_method;
  follow_up_value := detail_row.follow_up_on;
  category_value := detail_row.record_category;
  source_value := detail_row.record_source;
  occurred_value := detail_row.occurred_on;
  severity_value := detail_row.incident_severity;

  if pg_catalog.jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_fields) submitted(field_key)
       where not exists (
         select 1 from private.chapter_task_template_fields f
         where f.template_key = detail_row.template_key and f.field_key = submitted.field_key
       )
     ) then
    raise exception 'template fields invalid' using errcode = '22023';
  end if;

  begin
    if detail_row.template_key = 'meeting_event' then
      if p_fields ? 'scheduled_on' then
        if pg_catalog.jsonb_typeof(p_fields->'scheduled_on') <> 'string'
           or (p_fields->>'scheduled_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        scheduled_value := (p_fields->>'scheduled_on')::date;
      end if;
      if p_fields ? 'venue_mode' then
        if pg_catalog.jsonb_typeof(p_fields->'venue_mode') <> 'string'
           or (p_fields->>'venue_mode') not in ('in_person','phone','video','hybrid') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        venue_value := p_fields->>'venue_mode';
      end if;
      if p_fields ? 'starts_at' then
        if p_fields->'starts_at' = 'null'::jsonb or nullif(p_fields->>'starts_at', '') is null then
          start_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'starts_at') <> 'string'
              or (p_fields->>'starts_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          start_value := (p_fields->>'starts_at')::time;
        end if;
      end if;
      if p_fields ? 'ends_at' then
        if p_fields->'ends_at' = 'null'::jsonb or nullif(p_fields->>'ends_at', '') is null then
          end_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'ends_at') <> 'string'
              or (p_fields->>'ends_at') !~ '^\d{2}:\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          end_value := (p_fields->>'ends_at')::time;
        end if;
      end if;
      if end_value is not null and (start_value is null or end_value <= start_value) then
        raise exception 'template fields invalid' using errcode = '22023';
      end if;
    elsif detail_row.template_key = 'review_approval' then
      if p_fields ? 'review_kind' then
        if pg_catalog.jsonb_typeof(p_fields->'review_kind') <> 'string'
           or (p_fields->>'review_kind') not in ('document','publication','decision','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        review_value := p_fields->>'review_kind';
      end if;
      if p_fields ? 'reviewer_id' then
        if p_fields->'reviewer_id' = 'null'::jsonb or nullif(p_fields->>'reviewer_id', '') is null then
          reviewer_value := null;
        elsif pg_catalog.jsonb_typeof(p_fields->'reviewer_id') <> 'string' then
          raise exception 'template fields invalid' using errcode = '22023';
        else
          reviewer_value := (p_fields->>'reviewer_id')::uuid;
        end if;
        locked_reviewer_role := null;
        if reviewer_value is not null then
          select reviewer_role.role into locked_reviewer_role
          from public.member_profiles p
          join public.member_roles reviewer_role
            on reviewer_role.user_id = p.id
           and reviewer_role.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (reviewer_role.chapter_id is null or reviewer_role.chapter_id = task_row.chapter_id)
          where p.id = reviewer_value and p.chapter_id = task_row.chapter_id
          order by (reviewer_role.chapter_id = task_row.chapter_id) desc, reviewer_role.role
          limit 1
          for share of p, reviewer_role;
        end if;
        if reviewer_value is not null and locked_reviewer_role is null then
          raise exception 'reviewer must belong to this chapter' using errcode = '22023';
        end if;
      end if;
    elsif detail_row.template_key = 'member_follow_up' then
      if p_fields ? 'contact_method' then
        if pg_catalog.jsonb_typeof(p_fields->'contact_method') <> 'string'
           or (p_fields->>'contact_method') not in ('phone','email','in_person','message','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        contact_value := p_fields->>'contact_method';
      end if;
      if p_fields ? 'follow_up_on' then
        if pg_catalog.jsonb_typeof(p_fields->'follow_up_on') <> 'string'
           or (p_fields->>'follow_up_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        follow_up_value := (p_fields->>'follow_up_on')::date;
      end if;
    elsif detail_row.template_key = 'document_request' then
      if p_fields ? 'record_category' then
        if pg_catalog.jsonb_typeof(p_fields->'record_category') <> 'string'
           or (p_fields->>'record_category') not in ('workplace_record','policy','correspondence','other') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        category_value := p_fields->>'record_category';
      end if;
      if p_fields ? 'record_source' then
        if pg_catalog.jsonb_typeof(p_fields->'record_source') <> 'string'
           or (p_fields->>'record_source') not in ('member','employer','union','third_party') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        source_value := p_fields->>'record_source';
      end if;
    elsif detail_row.template_key = 'issue_incident' then
      if p_fields ? 'occurred_on' then
        if pg_catalog.jsonb_typeof(p_fields->'occurred_on') <> 'string'
           or (p_fields->>'occurred_on') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        occurred_value := (p_fields->>'occurred_on')::date;
      end if;
      if p_fields ? 'incident_severity' then
        if pg_catalog.jsonb_typeof(p_fields->'incident_severity') <> 'string'
           or (p_fields->>'incident_severity') not in ('low','medium','high','urgent') then
          raise exception 'template fields invalid' using errcode = '22023';
        end if;
        severity_value := p_fields->>'incident_severity';
      end if;
    end if;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise exception 'template fields invalid' using errcode = '22023';
  end;

  if p_next_flow_step is not null and p_next_flow_step <> detail_row.flow_step then
    select s.* into target_step
    from private.chapter_task_template_flow_steps s
    where s.template_key = detail_row.template_key and s.step_key = p_next_flow_step;
    if target_step.step_key is null
       or not (target_step.predecessor_keys @> array[detail_row.flow_step]) then
      raise exception 'template flow transition invalid' using errcode = '22023';
    end if;
    changed_flow := true;
  end if;

  update public.chapter_task_template_details set
    flow_step = case when changed_flow then target_step.step_key else detail_row.flow_step end,
    scheduled_on = scheduled_value,
    starts_at = start_value,
    ends_at = end_value,
    venue_mode = venue_value,
    review_kind = review_value,
    reviewer_id = reviewer_value,
    contact_method = contact_value,
    follow_up_on = follow_up_value,
    record_category = category_value,
    record_source = source_value,
    occurred_on = occurred_value,
    incident_severity = severity_value,
    updated_by = caller,
    updated_at = now()
  where task_id = task_row.id
  returning * into detail_row;

  update public.chapter_tasks set
    start_date = case
      when detail_row.template_key = 'meeting_event' then scheduled_value
      when detail_row.template_key = 'issue_incident' then occurred_value
      else null
    end,
    due_date = case
      when detail_row.template_key = 'meeting_event' then scheduled_value
      when detail_row.template_key = 'member_follow_up' then follow_up_value
      else null
    end,
    updated_by = caller
  where id = task_row.id;

  if changed_flow then
    if coalesce(p_apply_recommended_status, false) then
      update public.chapter_tasks
      set status = target_step.recommended_status, updated_by = caller
      where id = task_row.id;
    end if;
  end if;

  if changed_flow then
    insert into public.chapter_task_activity (
      task_id, chapter_id, actor_id, action, from_value, to_value
    ) values (
      task_row.id, task_row.chapter_id, caller, 'template_flow_changed',
      old_flow_step, target_step.step_key
    );
    perform private.notify_chapter_task_template_change(
      task_row.id, caller, 'task.template.flow_changed'
    );
  end if;

  select t.* into task_row from public.chapter_tasks t where t.id = task_row.id;
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'details', pg_catalog.to_jsonb(detail_row)
  );
end
$$;

revoke all on function public.update_chapter_task_template_details(uuid, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.update_chapter_task_template_details(uuid, jsonb, text, boolean)
  to authenticated;
grant execute on function public.update_chapter_task_template_details(uuid, jsonb, text, boolean)
  to service_role;

-- G. Flow-only audit vocabulary -------------------------------------------

alter table public.chapter_task_activity drop constraint chapter_task_activity_action_check;
alter table public.chapter_task_activity add constraint chapter_task_activity_action_check
  check (action in (
    'created', 'status_changed', 'assignee_changed', 'type_changed',
    'blocked', 'unblocked', 'board_changed', 'deleted', 'restored',
    'attachment_added', 'attachment_removed', 'file_added', 'file_removed',
    'template_flow_changed'
  ));

comment on table public.chapter_task_template_details is
  'Typed metadata for specialized chapter tasks. Access inherits the live task board; writes use validated template RPCs and never introduce a task ACL.';

notify pgrst, 'reload schema';
