// FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022: the two
// FMLA forms show the GINA Title II safe-harbor notice (29 CFR
// 1635.8(b)(1)(i)(B), verbatim) and a no-diagnosis hint before any answer.
// These are the English and Spanish texts of the web's shared keys
// forms.notice.gina and forms.hint.noDiagnosis; a parity test keeps them
// identical. The live Forms screen shows them in the member's language
// (REQ-UG-NATIVE-FMLA-FORMS-SHOW-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261113, #8694).
export const HEALTH_NOTICE_TEMPLATE_KEYS: readonly string[] = ['fmla_self', 'fmla_family'];

export const GINA_NOTICE_TEXT =
  "The Genetic Information Nondiscrimination Act of 2008 (GINA) prohibits employers and other entities covered by GINA Title II from requesting or requiring genetic information of an individual or family member of the individual, except as specifically allowed by this law. To comply with this law, we are asking that you not provide any genetic information when responding to this request for medical information. 'Genetic information' as defined by GINA, includes an individual's family medical history, the results of an individual's or family member's genetic tests, the fact that an individual or an individual's family member sought or received genetic services, and genetic information of a fetus carried by an individual or an individual's family member or an embryo lawfully held by an individual or family member receiving assistive reproductive services.";

export const NO_DIAGNOSIS_HINT_TEXT =
  "Do not enter a diagnosis, a family member's condition or medical records. Only the leave you need, its pattern and the dates.";

export const GINA_NOTICE_TEXT_ES =
  "La Ley de No Discriminación por Información Genética de 2008 (GINA, por sus siglas en inglés) prohíbe a los empleadores y a otras entidades cubiertas por el Título II de GINA solicitar o exigir información genética de una persona o de un familiar de esa persona, salvo en los asuntos que esta ley permite expresamente. Para cumplir con esta ley, te pedimos que no proporciones ninguna información genética al responder a esta solicitud de información médica. La 'información genética', según la define GINA, incluye los antecedentes médicos familiares de una persona, los resultados de las pruebas genéticas de una persona o de un familiar, el hecho de que una persona o un familiar haya solicitado o recibido servicios genéticos, y la información genética de un feto que lleve una persona o una familiar, o de un embrión que tenga legalmente una persona o un familiar que reciba servicios de reproducción asistida.";

export const NO_DIAGNOSIS_HINT_TEXT_ES =
  'No escribas un diagnóstico, la condición de un familiar ni expedientes médicos. Solo la licencia que necesitas, su tipo y las fechas.';

export function healthNoticeFor(templateKey: string | null | undefined, language: 'en' | 'es' = 'en'): readonly string[] {
  if (!templateKey || !HEALTH_NOTICE_TEMPLATE_KEYS.includes(templateKey)) return [];
  return language === 'es' ? [GINA_NOTICE_TEXT_ES, NO_DIAGNOSIS_HINT_TEXT_ES] : [GINA_NOTICE_TEXT, NO_DIAGNOSIS_HINT_TEXT];
}
