-- Union Ground: rights lessons and Guide knowledge rows that hold before
-- recognition.
--
-- Earlier migrations seed public.member_rights_lessons (20260720191847,
-- 20260812120000_rights_lessons_locale and later) and the Guide's sample
-- public.member_kb_articles (20260722130441 and successors) for an existing
-- union: ask for union representation, wait for a steward, request union
-- assistance, file a grievance under contract articles, pay dues to a named
-- local. Before a union is recognized most private-sector workers have no
-- right to a union representative in an investigatory meeting (the NLRB's
-- 2004 IBM Corp. decision limits Weingarten rights to unionized workplaces;
-- public-sector rules vary by state), there is no steward, grievance procedure
-- or contract, and the sample rows named a union (the fictional Tamarack).
-- The historical files stay as shipped; this file corrects the seeded rows.
--
-- Rights lessons. Every lesson keeps its id, so member_rights_progress rows
-- and the array[0] signup default still point at the same lesson. Each keeps
-- its English and Spanish columns in step (member_rights_lessons_steps_es_
-- cardinality). There is no step-count bound in the database
-- (member_rights_progress only caps cardinality at 64).
--   * weingarten: the pre-recognition guidance the web uses, four steps. Its
--     label "Weingarten" named a right the worker may not have, so it reads
--     "Disciplinary meeting".
--   * loudermill: public-employee notice and a chance to respond is not a
--     union right, so the lesson stays; only "with union representation"
--     becomes asking for a coworker.
--   * harassment, pip, safety: "contact a steward", "union assistance" and
--     "my union representative" become a committee member, an organizer or a
--     coworker.
--
-- Guide knowledge rows. All nine are retired samples, never served (a sample
-- cannot be published: member_kb_articles_published_verified), but they named
-- a union and an existing contract. Each keeps its id and slug and now
-- carries organizing guidance with no union named; the six former contract
-- articles become 'rights' rows, because there is no contract to cite.

begin;
set local lock_timeout = '5s';

-- 1. Rights lessons ---------------------------------------------------------

update public.member_rights_lessons
set label = 'Disciplinary meeting',
    title = 'Surprise disciplinary meeting',
    description = 'Use this if management pulls you into a meeting that could lead to discipline.',
    steps = pg_catalog.jsonb_build_array(
      'Ask whether the meeting could lead to discipline.',
      'Ask for a coworker to be present. The employer may say no, but asking is still worth it.',
      'Stay calm. Don''t guess or speculate, don''t sign anything you disagree with, and ask for a copy of anything you are given or asked to sign.',
      'Right after, write down the time, place, people, and documents, and tell a committee member or organizer.'),
    script = 'Could this meeting lead to discipline? If it could, I would like a coworker to be present. I will not sign anything I disagree with, and I would like a copy of anything you give me or ask me to sign.',
    title_es = 'Reunión disciplinaria sorpresa',
    description_es = 'Úsalo si la gerencia te lleva a una reunión que podría terminar en una acción disciplinaria.',
    steps_es = pg_catalog.jsonb_build_array(
      'Pregunta si la reunión podría llevar a una medida disciplinaria.',
      'Pide que esté presente un compañero o compañera de trabajo. El empleador puede negarse, pero vale la pena pedirlo.',
      'Mantén la calma. No adivines ni especules, no firmes nada con lo que no estés de acuerdo y pide una copia de todo lo que te entreguen o te pidan firmar.',
      'Justo después, anota la hora, el lugar, las personas y los documentos, y cuéntaselo a un miembro del comité o a un organizador.'),
    script_es = '¿Esta reunión podría llevar a una medida disciplinaria? Si es así, quisiera que un compañero o compañera de trabajo esté presente. No voy a firmar nada con lo que no esté de acuerdo, y quisiera una copia de todo lo que me entreguen o me pidan firmar.'
where id = 'weingarten';

update public.member_rights_lessons
set steps = pg_catalog.jsonb_build_array(
      'Ask for the charges and evidence.',
      'Request a meaningful chance to respond before any decision.',
      'Ask for time to prepare and for a coworker to be present. The employer may say no, but asking is still worth it.'),
    script = 'I am requesting notice of the charges, the evidence being considered, and a meaningful opportunity to respond before any decision is made. I would like a coworker to be present.',
    steps_es = pg_catalog.jsonb_build_array(
      'Pide los cargos y las pruebas.',
      'Solicita una oportunidad real de responder antes de cualquier decisión.',
      'Pide tiempo para prepararte y que esté presente un compañero o compañera de trabajo. El empleador puede negarse, pero vale la pena pedirlo.'),
    script_es = 'Solicito que se me notifiquen los cargos, las pruebas que se están considerando y una oportunidad real de responder antes de que se tome cualquier decisión. Quisiera que un compañero o compañera de trabajo esté presente.'
where id = 'loudermill';

update public.member_rights_lessons
set description = 'Record what happened, preserve evidence, and reach a committee member or organizer without escalating risk.',
    steps = pg_catalog.jsonb_build_array(
      'Write down dates, locations, and exact words.',
      'Save messages and identify witnesses.',
      'Tell a committee member or organizer and follow the reporting plan.'),
    script = 'I am reporting conduct that may violate my workplace protections and ask that it be investigated. I would like a coworker present at any meeting about it.',
    description_es = 'Registra lo que ocurrió, conserva las pruebas y comunícate con un miembro del comité o un organizador sin aumentar el riesgo.',
    steps_es = pg_catalog.jsonb_build_array(
      'Anota fechas, lugares y las palabras exactas.',
      'Guarda los mensajes e identifica a los testigos.',
      'Cuéntaselo a un miembro del comité o a un organizador y sigue el plan de denuncia.'),
    script_es = 'Estoy reportando una conducta que puede violar mis protecciones laborales y pido que se investigue. Quisiera que un compañero o compañera de trabajo esté presente en cualquier reunión sobre este asunto.'
where id = 'harassment';

update public.member_rights_lessons
set steps = pg_catalog.jsonb_build_array(
      'Ask for a copy and time to review it.',
      'Write that receipt is not agreement.',
      'Talk with a committee member or organizer before you submit a response.'),
    script = 'My signature confirms receipt only, not agreement. I request time to review this before responding.',
    steps_es = pg_catalog.jsonb_build_array(
      'Pide una copia y tiempo para revisarla.',
      'Escribe que recibirla no significa estar de acuerdo.',
      'Habla con un miembro del comité o un organizador antes de enviar tu respuesta.'),
    script_es = 'Mi firma confirma únicamente la recepción, no mi conformidad. Solicito tiempo para revisar esto antes de responder.'
where id = 'pip';

update public.member_rights_lessons
set steps = pg_catalog.jsonb_build_array(
      'Move away from immediate danger if necessary.',
      'Report the hazard in writing.',
      'Tell a committee member or organizer and keep a copy of the response.'),
    script = 'I am reporting a workplace safety concern and requesting written instructions before proceeding.',
    steps_es = pg_catalog.jsonb_build_array(
      'Aléjate del peligro inmediato si es necesario.',
      'Reporta el riesgo por escrito.',
      'Cuéntaselo a un miembro del comité o a un organizador y guarda una copia de la respuesta.'),
    script_es = 'Estoy reportando un problema de seguridad en el trabajo y solicito instrucciones por escrito antes de continuar.'
where id = 'safety';

-- 2. Guide knowledge rows ---------------------------------------------------

update public.member_kb_articles as article
set kind = rewrite.kind,
    title = rewrite.title,
    article_ref = rewrite.article_ref,
    body = rewrite.body,
    keywords = rewrite.keywords
from (values
  ('faq-weingarten-rights', 'faq',
   'What is Weingarten and does it apply to me?', 'Knowledge base',
   'Weingarten rights let a worker have a union representative present at an investigatory meeting that could lead to discipline. They generally apply once a union represents the workplace. Before then, you can still ask for a coworker to be present as a witness (the employer may say no, but asking is still worth it), and you and your coworkers can act together about working conditions under Section 7 of the National Labor Relations Act. Public-sector rules vary by state. If you are called into a meeting, stay calm, do not sign anything you disagree with, write down what happened right after, and tell a committee member or organizer. This is general information, not legal advice.',
   array['weingarten', 'investigatory meeting', 'disciplinary meeting', 'discipline', 'coworker witness', 'section 7', 'concerted activity', 'act together']::text[]),
  ('faq-file-a-grievance', 'faq',
   'How do I raise a workplace issue?', 'Knowledge base',
   'Before a union is recognized there is no grievance procedure, but you and your coworkers can still raise an issue together. Write down what happened with dates, names and documents, talk with the coworkers it affects, and bring it to your organizing committee to decide whether to raise it as a group. Acting together about working conditions is generally protected under Section 7 of the National Labor Relations Act. This is general information, not legal advice.',
   array['workplace issue', 'raise an issue', 'organizing committee', 'coworkers', 'act together', 'section 7', 'documentation']::text[]),
  ('faq-dues-and-fair-share', 'faq',
   'Dues and fees', 'Knowledge base',
   'Union Ground does not collect or track dues. Whether and when any dues or fees would apply is a question for your campaign to discuss with the union you choose to work with. This is general information, not legal advice.',
   array['dues', 'fees', 'membership', 'cost']::text[]),
  ('contract-article-3-union-rights-and-representation', 'rights',
   'How a union comes to represent a workplace', 'Organizing guide',
   'Before a union is recognized there is no contract and no union representative at work. A union comes to represent a workplace through voluntary recognition by the employer or through a government-run election. Under Section 7 of the National Labor Relations Act, most private-sector workers can talk with coworkers about forming a union, sign authorization cards and act together. Public-sector rules vary by state. This is general information, not legal advice.',
   array['recognition', 'voluntary recognition', 'election', 'authorization cards', 'section 7', 'forming a union', 'organizing']::text[]),
  ('contract-article-5-grievance-procedure', 'rights',
   'Raising an issue together', 'Organizing guide',
   'Without a contract there is no grievance procedure. Workers can still raise an issue as a group: document what happened, talk with the coworkers it affects, agree on what you want, and decide together how to bring it to management. Acting together about working conditions is generally protected under Section 7 of the National Labor Relations Act. This is general information, not legal advice.',
   array['raise an issue', 'group issue', 'petition', 'coworkers', 'act together', 'section 7']::text[]),
  ('contract-article-7-hours-of-work', 'rights',
   'Hours and schedules', 'Organizing guide',
   'Hours, schedules, breaks and overtime are common topics for a first contract. Until there is one, keep your own records of posted schedules, changes and hours worked, and compare notes with coworkers. Your organizing committee can use that record to show a pattern and decide what to ask for. This is general information, not legal advice.',
   array['hours', 'schedule', 'overtime', 'breaks', 'scheduling', 'records', 'first contract']::text[]),
  ('contract-article-12-discipline', 'rights',
   'If you are disciplined', 'Organizing guide',
   'Before a union is recognized, most private-sector workers have no right to a union representative in a disciplinary meeting. You can still ask whether a meeting could lead to discipline, ask for a coworker to be present (the employer may say no), stay calm, and not sign anything you disagree with. Ask for a copy of anything you are given, write down what happened right after, and tell a committee member or organizer. This is general information, not legal advice.',
   array['discipline', 'disciplinary meeting', 'write-up', 'warning', 'suspension', 'termination', 'coworker witness']::text[]),
  ('contract-article-16-health-and-safety', 'rights',
   'Raising a safety concern', 'Organizing guide',
   'Report hazards in writing and keep a copy. Move away from immediate danger if necessary and document what you see. Raising safety concerns together with coworkers is generally protected under Section 7 of the National Labor Relations Act, and safety laws prohibit retaliation for reporting hazards. Tell a committee member or organizer. This is general information, not legal advice.',
   array['safety', 'hazard', 'unsafe conditions', 'report a hazard', 'retaliation', 'section 7']::text[]),
  ('contract-article-24-telework', 'rights',
   'Remote work', 'Organizing guide',
   'Who can work remotely, equipment and availability rules are possible topics for a first contract. Until then, follow your employer''s written policy, keep copies of requests and answers, and compare experiences with coworkers. If remote work is denied or changed unfairly for a group, your organizing committee can decide whether to raise it together. This is general information, not legal advice.',
   array['telework', 'remote work', 'work from home', 'hybrid', 'policy', 'first contract']::text[])
) as rewrite(slug, kind, title, article_ref, body, keywords)
where article.slug = rewrite.slug
  and article.is_sample;

-- Fail the migration rather than ship a seeded row that still promises an
-- existing union's protections or names one.
do $unionground_rights_guidance$
begin
  if exists (
    select 1 from public.member_rights_lessons lesson
    where pg_catalog.concat_ws(' ', lesson.label, lesson.title, lesson.description, lesson.steps::text, lesson.script,
      lesson.title_es, lesson.description_es, lesson.steps_es::text, lesson.script_es)
      ~* '(union representation|union representative|union assistance|steward|representaci[oó]n sindical|representante sindical|asistencia sindical|delegad[oa])'
  ) then
    raise exception 'a rights lesson still promises an existing union''s protections';
  end if;
  if exists (
    select 1 from public.member_kb_articles article
    where article.is_sample
      and pg_catalog.concat_ws(' ', article.title, article.article_ref, article.body, pg_catalog.array_to_string(article.keywords, ' '))
        ~* '(union representation|steward|file a grievance|grievable|step 1|step 2|tamarack|fair share|fair-share)'
  ) then
    raise exception 'a seeded Guide row still assumes an existing union, contract or grievance procedure';
  end if;
end;
$unionground_rights_guidance$;

notify pgrst, 'reload schema';
commit;
