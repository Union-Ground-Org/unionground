// Text for the default workload fields in English and Spanish, so the native
// entry form never reaches the web catalogue (src/lib/i18n.js). The wording is
// the web's (src/lib/i18n/locales/{en,es}/workload.js and the
// workloadConfiguration namespaces). Admin-written text shows as typed, as it
// does on the web: a plain label is translated only when it is the default
// label of that same field, and a choice only on an original field.
import type { NativeLanguage } from './nativeUiCopy';

// [English, Spanish]
type Text = readonly [string, string];

const DEFAULT_LABELS: Readonly<Record<string, Text>> = {
  'workload.cat.priority': ['Priority', 'Prioridad'],
  'workload.cat.pending': ['Pending', 'Pendientes'],
  'workload.cat.unread_docs': ['Unread docs', 'Docs sin leer'],
  'workload.cat.todos': ['To-dos', 'Tareas'],
  'workload.cat.referrals': ['Referrals', 'Referencias'],
  'workload.cat.ce_activities': ['CE activities', 'Actividades CE'],
  'workload.cat.assistance_requests': ['Assistance requests', 'Solicitudes de ayuda'],
  'workload.cat.aged_cases': ['Aged issues', 'Casos antiguos'],
  'workload.weeklyAssigned': ['New issues this week', 'Casos nuevos esta semana'],
  'workload.ptHours': ['Part-time hours', 'Horas de tiempo parcial'],
  'workload.onPlan': ['On an improvement plan', 'En un plan de mejora'],
  'workload.otWorked': ['Worked overtime', 'Trabajé horas extra'],
  'workload.otHours': ['Overtime hours', 'Horas extra'],
  'workload.noIntake': ['No intake this period', 'Sin admisiones este período'],
  'workload.halfDay': ['Half day', 'Medio día'],
  'workload.workedOn': ['Day worked', 'Día trabajado'],
  'workload.hoursWorked': ['Hours worked', 'Horas trabajadas'],
  'workload.leave': ['Leave', 'Licencia'],
};

// Plain-text defaults the server stores for these original fields.
const PLAIN_DEFAULTS: Readonly<Record<string, Text>> = {
  employment: ['Employment', 'Empleo'],
  leaveType: ['Leave', 'Licencia'],
  leaveTiming: ['Leave timing', 'Momento de la licencia'],
  note: ['Note', 'Nota'],
};

const ORIGINAL_KEYS: ReadonlySet<string> = new Set([
  'priority', 'pending', 'unread_docs', 'todos', 'referrals', 'ce_activities', 'assistance_requests', 'aged_cases',
  'weeklyAssigned', 'employment', 'ptHours', 'onPlan', 'otWorked', 'otHours', 'leaveType', 'leaveTiming',
  'noIntake', 'halfDay', 'workedOn', 'hoursWorked', 'note',
]);

const CHOICES: Readonly<Record<string, Text>> = {
  full_time: ['Full-time', 'Tiempo completo'],
  part_time: ['Part-time', 'Tiempo parcial'],
  sick_leave: ['Sick', 'Enfermedad'],
  annual_leave: ['Annual', 'Anual'],
  lwop: ['LWOP', 'Sin goce'],
  fmla: ['FMLA', 'FMLA'],
  admin_leave: ['Admin', 'Administrativa'],
  comp_time: ['Comp', 'Compensatoria'],
  planned: ['Planned', 'Planificada'],
  unplanned: ['Unplanned', 'No planificada'],
};

const DEFAULT_TITLE: Text = ['Workplace log', 'Registro de carga de trabajo'];
const DEFAULT_STATUS: Text = ['Logged', 'Registrado'];
const YES_NO: Readonly<Record<'yes' | 'no', Text>> = { yes: ['Yes', 'Sí'], no: ['No', 'No'] };

const pick = (text: Text, language: NativeLanguage): string => (language === 'es' ? text[1] : text[0]);

export const workloadFieldLabel = (field: { key?: string; label: string }, language: NativeLanguage = 'en'): string => {
  const known = DEFAULT_LABELS[field.label]
    ?? (field.key && PLAIN_DEFAULTS[field.key]?.[0] === field.label ? PLAIN_DEFAULTS[field.key] : undefined);
  return known ? pick(known, language) : field.label;
};
export const workloadTitleText = (definition: { title: string }, language: NativeLanguage = 'en'): string =>
  definition.title === DEFAULT_TITLE[0] ? pick(DEFAULT_TITLE, language) : definition.title;
export const workloadStatusText = (status: string, language: NativeLanguage = 'en'): string =>
  status === 'logged' ? pick(DEFAULT_STATUS, language) : status;
// Ledger 485: underscores read as spaces only when no other choice of the field
// then reads the same, so `day_shift` and `day shift` stay two buttons.
export const workloadChoiceText = (field: { key: string; options?: readonly string[] }, option: string, language: NativeLanguage = 'en'): string => {
  const known = ORIGINAL_KEYS.has(field.key) ? CHOICES[option] : undefined;
  if (known) return pick(known, language);
  const spaced = option.replaceAll('_', ' ');
  const collides = (field.options ?? []).some((other) => other !== option && other.replaceAll('_', ' ') === spaced);
  return collides ? option : spaced;
};
export const workloadYesNoText = (value: boolean, language: NativeLanguage = 'en'): string => pick(YES_NO[value ? 'yes' : 'no'], language);
