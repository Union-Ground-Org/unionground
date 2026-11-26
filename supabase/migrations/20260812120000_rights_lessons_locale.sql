-- UB-RGT-04: rights-lesson content is English-only.
--
-- member_rights_lessons has carried one set of title/description/steps/script
-- since 20260720191847, all English. The product has spoken Spanish since
-- 20260722040157 (member_profiles.language), and src/data/rightsLabels.js has
-- carried a bilingual Weingarten script since the bilingual design pass — but
-- that copy is a MISSING-ROW fallback. memberApi only reaches it when the row
-- is absent, so with the five seeded rows present a Spanish-speaking member
-- read English titles, English steps and, worst of all, an English script:
-- the sentence they say out loud to a manager in a meeting that can end their
-- job. The Spanish translation existed and nobody ever received it.
--
-- Shape: per-locale COLUMNS, following public.form_templates (label_en/label_es
-- since 20260723110000), not per-locale rows. Per-locale rows would need a new
-- primary key: `label` and `order_index` are both `not null unique` here, and
-- `id` is the FK target for member_rights_progress and member_steward_requests
-- plus the `substr(action_key, 8)` lesson-id convention the points trigger
-- relies on. Columns need none of that rework.
--
-- `label` deliberately stays English. It is a join key, not prose: the client
-- resolves the selected lesson by label (src/views/RightsView.jsx), indexes it
-- for search (src/lib/searchIndex.js) and persists it across the desktop/phone
-- parity bridge. Two of the five are legal terms of art that are not
-- translated in Spanish either (Loudermill, Weingarten). Localizing the four
-- content fields is what UB-RGT-04 asks for; localizing the join key is a
-- different change with a different blast radius.

alter table public.member_rights_lessons
  add column if not exists title_es text,
  add column if not exists description_es text,
  add column if not exists steps_es jsonb,
  add column if not exists script_es text;

update public.member_rights_lessons as lesson
set title_es = translated.title_es,
    description_es = translated.description_es,
    steps_es = translated.steps_es::jsonb,
    script_es = translated.script_es
from (values
  ('loudermill',
   'Antes de que se imponga una sanción disciplinaria',
   'Úsalo cuando un empleador público pueda sancionarte sin darte primero la oportunidad de responder.',
   '["Pide los cargos y las pruebas.","Solicita una oportunidad real de responder.","Pide representación sindical antes de responder."]',
   'Solicito que se me notifiquen los cargos, las pruebas que se están considerando y una oportunidad real de responder con representación sindical.'),
  -- Weingarten is byte-identical to the es branch of src/data/rightsLabels.js
  -- on purpose: the row and the missing-row fallback must not disagree about
  -- the sentence a member reads aloud. tests/rights-lessons-locale.test.js
  -- pins the two together.
  ('weingarten',
   'Reunión disciplinaria sorpresa',
   'Úsalo si la gerencia te lleva a una reunión que podría terminar en una acción disciplinaria.',
   '["Pregunta si la reunión podría llevar a una acción disciplinaria.","Di que quieres representación sindical antes de responder.","No respondas preguntas de fondo hasta que llegue un delegado."]',
   'Si esta reunión pudiera de alguna manera llevar a que se me discipline o se me despida, solicito respetuosamente representación sindical antes de responder preguntas.'),
  ('harassment',
   'Documenta y reporta el acoso',
   'Registra lo que ocurrió, conserva las pruebas y comunícate con un delegado sin aumentar el riesgo.',
   '["Anota fechas, lugares y las palabras exactas.","Guarda los mensajes e identifica a los testigos.","Contacta a un delegado y sigue el plan de denuncia."]',
   'Estoy reportando una conducta que puede violar nuestras protecciones laborales y solicito asistencia sindical antes de cualquier reunión de investigación.'),
  ('pip',
   'Responde a un aviso de desempeño',
   'Úsalo antes de firmar o responder a un plan de desempeño o a un aviso de exactitud.',
   '["Pide una copia y tiempo para revisarla.","Escribe que recibirla no significa estar de acuerdo.","Contacta a un delegado antes de enviar tu respuesta."]',
   'Mi firma confirma únicamente la recepción, no mi conformidad. Solicito tiempo para revisar esto con mi representante sindical antes de responder.'),
  ('safety',
   'Reporta un riesgo de seguridad inmediato',
   'Documenta el peligro y solicita un plan de trabajo seguro sin renunciar a tus derechos protegidos.',
   '["Aléjate del peligro inmediato si es necesario.","Reporta el riesgo por escrito.","Contacta a un delegado y conserva la respuesta."]',
   'Estoy reportando un problema de seguridad en el trabajo y solicito instrucciones por escrito y asistencia sindical antes de continuar.')
) as translated(id, title_es, description_es, steps_es, script_es)
where lesson.id = translated.id;

-- Name the untranslated rows rather than letting `set not null` raise an
-- opaque violation. Same shape as the completed_steps bound in
-- 20260725160000: check first, report what blocks the constraint, then
-- enforce. A lesson added after this migration without Spanish copy is a
-- content gap someone has to fill, and the error should say which one.
do $$
declare
  v_missing text;
begin
  select pg_catalog.string_agg(id, ', ' order by order_index)
  into v_missing
  from public.member_rights_lessons
  where title_es is null or description_es is null or steps_es is null or script_es is null;

  if v_missing is not null then
    raise exception
      'member_rights_lessons has no Spanish copy for: %; add it before enforcing the locale columns',
      v_missing
      using errcode = 'not_null_violation';
  end if;
end
$$;

alter table public.member_rights_lessons
  alter column title_es set not null,
  alter column description_es set not null,
  alter column steps_es set not null,
  alter column script_es set not null;

alter table public.member_rights_lessons
  add constraint member_rights_lessons_steps_es_array
  check (jsonb_typeof(steps_es) = 'array');

-- The step COUNT has to agree across locales. member_rights_progress stores
-- completed_steps as integer indices into the steps array with no locale of
-- its own, so a Spanish row with a different number of steps would silently
-- re-point a member's saved progress at the wrong step — or past the end of
-- the list — the moment they switched language.
alter table public.member_rights_lessons
  add constraint member_rights_lessons_steps_es_cardinality
  check (jsonb_array_length(steps_es) = jsonb_array_length(steps));

-- No grant change: 20260720191847 granted `select` on the table without a
-- column list, so the four new columns are already readable by authenticated.
-- The read policy (member_rights_lessons_read_authenticated, `using (true)`)
-- is unchanged — lesson copy is the same public-to-members reference text it
-- always was, now in two languages.
