-- Phase 4a: Compass — retrieval with citations.
create table if not exists public.member_kb_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  kind text not null check (kind in ('contract', 'rights', 'faq')),
  title text not null,
  article_ref text not null,
  body text not null,
  keywords text[] not null default '{}',
  order_index integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists member_kb_articles_order_idx
  on public.member_kb_articles (order_index);

alter table public.member_kb_articles enable row level security;

drop policy if exists member_kb_articles_read_authenticated on public.member_kb_articles;
create policy member_kb_articles_read_authenticated
  on public.member_kb_articles for select to authenticated using (true);

revoke insert, update, delete on public.member_kb_articles from authenticated, anon;
grant select on public.member_kb_articles to authenticated;

insert into public.member_kb_articles (slug, kind, title, article_ref, body, keywords, order_index)
values
  ('contract-article-3-union-rights-and-representation', 'contract', 'Article 3 — Union Rights and Representation', 'Contract · Article 3', 'Article 3 describes how the union represents members of the Fictional Public Service Chapter 3E024208 in dealings with the employer. It recognizes Tamarack, the fictional union in this sample, as the exclusive representative for covered employees, protects your right to join and take part, and gives elected stewards reasonable time to handle representation duties. Stewards may post notices, meet with members, and attend meetings on your behalf. This is a fictional summary and not legal advice; contact your chapter steward for how it applies to your situation.', array['union rights', 'representation', 'steward', 'tamarack', 'exclusive representative', 'right to join', 'recognition', 'stewards']::text[], 1),
  ('contract-article-5-grievance-procedure', 'contract', 'Article 5 — Grievance Procedure', 'Contract · Article 5', 'Article 5 sets out how disputes over the contract are resolved through a fair, step-by-step process. Most grievances start informally between your steward and your supervisor, then move to Step 1, a written grievance to management, and Step 2, review by higher management and union representatives, if they stay unresolved. Deadlines apply at each step, so act promptly. Your chapter steward files and tracks the grievance with you. This fictional summary is not legal advice; ask your Tamarack steward about the timelines for your case.', array['grievance procedure', 'grievance', 'step 1', 'step 2', 'steward', 'deadlines', 'dispute', 'filing a grievance']::text[], 2),
  ('contract-article-7-hours-of-work', 'contract', 'Article 7 — Hours of Work', 'Contract · Article 7', 'Article 7 covers scheduling, workweeks, breaks, and overtime for members of the Fictional Public Service Chapter 3E024208. It describes the standard workweek, how shifts and meal periods are set, advance notice for schedule changes, and how overtime is offered and paid. If your posted schedule seems inconsistent with the contract, keep your own records and raise it early with your steward. This is a fictional summary and not legal advice; your chapter steward can help you compare it to your actual assignment.', array['hours of work', 'schedule', 'overtime', 'breaks', 'workweek', 'shifts', 'meal period', 'scheduling']::text[], 3),
  ('contract-article-12-discipline', 'contract', 'Article 12 — Discipline', 'Contract · Article 12', 'Article 12 protects members from unfair discipline by requiring just cause and a progressive approach. Discipline should generally move in steps, from coaching and verbal reminders to written warnings, suspension, and, only as a last resort, termination. You have the right to know the reason, to union representation, and to grieve discipline you believe is unjust. If you are called to an investigatory meeting, contact your steward first. This fictional summary is not legal advice; talk with your Tamarack steward.', array['discipline', 'suspension', 'termination', 'just cause', 'progressive discipline', 'write-up', 'warning', 'investigatory meeting']::text[], 4),
  ('contract-article-16-health-and-safety', 'contract', 'Article 16 — Health and Safety', 'Contract · Article 16', 'Article 16 commits the employer and the union to safe working conditions for members of the chapter. It covers reporting hazards, access to safety equipment and training, and a joint labor-management safety committee that reviews concerns. You can report an unsafe condition without fear of retaliation, and serious hazards should be raised right away. Document what you see and notify your chapter steward. This is a fictional summary and not legal advice; your steward can help you decide on next steps.', array['health and safety', 'safety', 'hazard', 'unsafe conditions', 'safety committee', 'retaliation', 'training', 'report a hazard']::text[], 5),
  ('contract-article-24-telework', 'contract', 'Article 24 — Telework', 'Contract · Article 24', 'Article 24 describes when and how eligible members may work remotely. It covers who qualifies, how to request telework, employer-provided equipment, expectations for availability, and how remote and on-site duties are balanced. Telework arrangements are put in writing and can be reviewed if job needs change. If a request is denied or changed unfairly, you can raise it with your steward. This is a fictional summary of a demo contract and not legal advice; ask your Tamarack chapter steward about eligibility.', array['telework', 'remote work', 'work from home', 'eligibility', 'equipment', 'availability', 'request telework', 'hybrid']::text[], 6),
  ('faq-file-a-grievance', 'faq', 'How do I file a grievance?', 'Knowledge base', 'A grievance is the formal way to challenge a possible contract violation. Start by talking with your chapter steward, who can help you decide whether the issue is grievable and gather details like dates, names, and documents. Many concerns are resolved informally first. If not, your steward helps file a written Step 1 grievance with management, and a Step 2 grievance if it stays unresolved. Deadlines are short, so reach out quickly. This is fictional guidance and not legal advice; your Tamarack steward files it with you.', array['file a grievance', 'grievance', 'how to grieve', 'step 1', 'step 2', 'steward', 'contract violation', 'deadlines']::text[], 7),
  ('faq-weingarten-rights', 'faq', 'What is Weingarten and when do I use it?', 'Knowledge base', 'Weingarten rights mean you can have a union representative present during an investigatory meeting that could lead to discipline. If a manager is questioning you and you reasonably believe it might result in discipline, you may ask for your steward before you answer. A simple statement works: say you request union representation and want your steward present. The meeting should pause until representation is arranged. This is fictional educational guidance and not legal advice; contact your Tamarack chapter steward right away.', array['weingarten', 'weingarten rights', 'union representation', 'investigatory meeting', 'discipline', 'steward', 'right to representation']::text[], 8),
  ('faq-dues-and-fair-share', 'faq', 'Does Tamarack charge dues or a fair-share fee?', 'Knowledge base', 'No. Tamarack, the fictional union in this sample, charges no dues and no fair-share fee. Its volunteers bargain contracts, represent members in grievances, train stewards, and support the Fictional Public Service Chapter 3E024208. This describes a fictional arrangement and does not create any real obligation. For membership options, contact your chapter steward.', array['dues', 'union dues', 'fair share', 'fair-share', 'membership', 'tamarack', 'no dues', 'payments']::text[], 9)
on conflict (slug) do update set
  kind = excluded.kind,
  title = excluded.title,
  article_ref = excluded.article_ref,
  body = excluded.body,
  keywords = excluded.keywords,
  order_index = excluded.order_index;

create or replace function public.search_member_kb(p_query text, p_limit integer default 4)
returns table (source_id text, kind text, title text, ref text, snippet text)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select
      case
        when pg_catalog.length(pg_catalog.btrim(coalesce(p_query, ''))) = 0 then null
        else pg_catalog.websearch_to_tsquery('english', p_query)
      end as ts,
      least(greatest(coalesce(p_limit, 4), 1), 6) as lim
  ),
  scored as (
    select
      'kb:' || a.slug as source_id,
      a.kind as kind,
      a.title as title,
      a.article_ref as ref,
      pg_catalog.left(a.body, 320) as snippet,
      case
        when (select ts from q) is null
          then 0.001 * (100 - least(a.order_index, 99))::double precision
        else pg_catalog.ts_rank(
          pg_catalog.to_tsvector(
            'english',
            coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
            coalesce(a.body, '') || ' ' || array_to_string(a.keywords, ' ')
          ),
          (select ts from q)
        )
      end as score,
      a.order_index as ord
    from public.member_kb_articles a
    where (select ts from q) is null
       or pg_catalog.to_tsvector(
            'english',
            coalesce(a.title, '') || ' ' || coalesce(a.article_ref, '') || ' ' ||
            coalesce(a.body, '') || ' ' || array_to_string(a.keywords, ' ')
          ) @@ (select ts from q)

    union all

    select
      'rights:' || l.id::text,
      'rights',
      l.title,
      'Know your rights · ' || l.label,
      pg_catalog.left(l.description, 320),
      pg_catalog.ts_rank(
        pg_catalog.to_tsvector(
          'english',
          coalesce(l.label, '') || ' ' || coalesce(l.title, '') || ' ' ||
          coalesce(l.description, '') || ' ' || coalesce(l.script, '')
        ),
        (select ts from q)
      ),
      1000 + l.order_index
    from public.member_rights_lessons l
    where (select ts from q) is not null
      and pg_catalog.to_tsvector(
            'english',
            coalesce(l.label, '') || ' ' || coalesce(l.title, '') || ' ' ||
            coalesce(l.description, '') || ' ' || coalesce(l.script, '')
          ) @@ (select ts from q)

    union all

    select
      'case:' || c.id::text,
      'case',
      c.title,
      'Your case · ' || c.reference,
      pg_catalog.left(nullif(pg_catalog.btrim(c.articles), ''), 320),
      pg_catalog.ts_rank(
        pg_catalog.to_tsvector(
          'english',
          coalesce(c.title, '') || ' ' || coalesce(c.reference, '') || ' ' ||
          coalesce(c.articles, '') || ' ' || coalesce(c.case_type, '')
        ),
        (select ts from q)
      ),
      2000
    from public.member_cases c
    where (select ts from q) is not null
      and pg_catalog.to_tsvector(
            'english',
            coalesce(c.title, '') || ' ' || coalesce(c.reference, '') || ' ' ||
            coalesce(c.articles, '') || ' ' || coalesce(c.case_type, '')
          ) @@ (select ts from q)
  )
  select source_id, kind, title, ref, snippet
  from scored
  order by score desc, ord asc
  limit (select lim from q);
$$;

revoke all on function public.search_member_kb(text, integer) from public, anon;
grant execute on function public.search_member_kb(text, integer) to authenticated;

alter table public.member_guide_messages
  add column if not exists sources jsonb;

drop function if exists public.save_member_guide_exchange(uuid, text, text);

create or replace function public.save_member_guide_exchange(
  p_thread_id uuid,
  p_question text,
  p_answer text,
  p_sources jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  active_thread_id uuid := p_thread_id;
  clean_question text := pg_catalog.btrim(coalesce(p_question, ''));
  clean_answer text := pg_catalog.btrim(coalesce(p_answer, ''));
  clean_sources jsonb := null;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_question) not between 1 and 1200 then
    raise exception 'question must be between 1 and 1200 characters' using errcode = '22023';
  end if;

  if pg_catalog.char_length(clean_answer) not between 1 and 4000 then
    raise exception 'answer must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if p_sources is not null
     and pg_catalog.jsonb_typeof(p_sources) = 'array'
     and pg_catalog.length(p_sources::text) <= 4000 then
    clean_sources := p_sources;
  end if;

  if active_thread_id is null then
    insert into public.member_guide_threads (user_id, title)
    values (caller, pg_catalog.left(clean_question, 120))
    returning id into active_thread_id;
  else
    perform 1
    from public.member_guide_threads
    where id = active_thread_id
      and user_id = caller
    for update;

    if not found then
      raise exception 'guide conversation not found' using errcode = '22023';
    end if;
  end if;

  insert into public.member_guide_messages (thread_id, user_id, role, body, sources)
  values
    (active_thread_id, caller, 'user', clean_question, null),
    (active_thread_id, caller, 'assistant', clean_answer, clean_sources);

  update public.member_guide_threads
  set updated_at = now()
  where id = active_thread_id
    and user_id = caller;

  return active_thread_id;
end;
$$;

revoke all on function public.save_member_guide_exchange(uuid, text, text, jsonb) from public, anon;
grant execute on function public.save_member_guide_exchange(uuid, text, text, jsonb) to authenticated;
